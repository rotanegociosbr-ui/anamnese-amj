-- Prontuario clinico: produtos utilizados, fotografias privadas e ciclo de
-- vida auditado. Esta migration e aditiva e preserva as tabelas legadas.
--
-- Modelo de acesso: o navegador nunca recebe permissao direta nestas tabelas
-- nem no bucket clinic-media. Somente a Edge Function, usando service_role,
-- pode executar os RPCs abaixo. Cada RPC valida novamente clinica, usuario,
-- papel e metodo de autenticacao antes de tocar em dados clinicos.

begin;

-- ---------------------------------------------------------------------------
-- Evolucao do protocolo e vinculo opcional com a agenda
-- ---------------------------------------------------------------------------

alter table public.protocols
  add column if not exists appointment_id uuid,
  add column if not exists version integer not null default 1,
  add column if not exists archived_at timestamptz,
  add column if not exists archive_reason text,
  add column if not exists archived_by uuid,
  add column if not exists updated_by uuid,
  add column if not exists idempotency_key uuid;

do $migration$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.protocols'::regclass
      and conname = 'protocols_appointment_id_fkey'
  ) then
    alter table public.protocols
      add constraint protocols_appointment_id_fkey
      foreign key (appointment_id)
      references public.agendamentos_clinica(id)
      on delete restrict;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.protocols'::regclass
      and conname = 'protocols_archived_by_fkey'
  ) then
    alter table public.protocols
      add constraint protocols_archived_by_fkey
      foreign key (archived_by)
      references auth.users(id)
      on delete restrict;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.protocols'::regclass
      and conname = 'protocols_updated_by_fkey'
  ) then
    alter table public.protocols
      add constraint protocols_updated_by_fkey
      foreign key (updated_by)
      references auth.users(id)
      on delete restrict;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.protocols'::regclass
      and conname = 'protocols_version_check'
  ) then
    alter table public.protocols
      add constraint protocols_version_check check (version > 0);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.protocols'::regclass
      and conname = 'protocols_archive_reason_check'
  ) then
    alter table public.protocols
      add constraint protocols_archive_reason_check check (
        archive_reason is null
        or char_length(btrim(archive_reason)) between 3 and 500
      );
  end if;
end;
$migration$;

create unique index if not exists protocols_clinic_idempotency_key
  on public.protocols (clinic_id, idempotency_key)
  where idempotency_key is not null;

create index if not exists protocols_clinic_patient_date_idx
  on public.protocols (clinic_id, patient_id, procedure_date desc, created_at desc);

create index if not exists protocols_clinic_archived_idx
  on public.protocols (clinic_id, archived_at, updated_at desc);

-- ---------------------------------------------------------------------------
-- Varios produtos/lotes por procedimento, com snapshot historico
-- ---------------------------------------------------------------------------

create table if not exists public.protocol_products (
  id uuid primary key default gen_random_uuid(),
  protocol_id uuid not null,
  product_id uuid not null,
  brand_id uuid,
  product_name_snapshot text not null,
  brand_name_snapshot text,
  anvisa_registration_snapshot text,
  lot text not null,
  expiry date not null,
  amount numeric(14,4) not null,
  unit text not null,
  cost_snapshot numeric(14,4),
  position smallint not null,
  created_at timestamptz not null default now(),
  constraint protocol_products_protocol_id_fkey
    foreign key (protocol_id) references public.protocols(id) on delete restrict,
  constraint protocol_products_product_id_fkey
    foreign key (product_id) references public.financeiro_produtos(id) on delete restrict,
  constraint protocol_products_brand_id_fkey
    foreign key (brand_id) references public.financeiro_marcas(id) on delete restrict,
  constraint protocol_products_product_name_snapshot_check
    check (char_length(btrim(product_name_snapshot)) between 2 and 180),
  constraint protocol_products_brand_name_snapshot_check
    check (
      brand_name_snapshot is null
      or char_length(btrim(brand_name_snapshot)) between 1 and 120
    ),
  constraint protocol_products_anvisa_snapshot_check
    check (
      anvisa_registration_snapshot is null
      or char_length(btrim(anvisa_registration_snapshot)) between 2 and 80
    ),
  constraint protocol_products_lot_check
    check (char_length(btrim(lot)) between 1 and 100),
  constraint protocol_products_amount_check
    check (amount > 0 and amount <= 1000000),
  constraint protocol_products_unit_check
    check (
      unit in (
        'U', 'mL', 'mg', 'g', 'un.', 'un', 'cx', 'frasco', 'ampola',
        'seringa', 'canula', 'kit', 'dose'
      )
    ),
  constraint protocol_products_cost_snapshot_check
    check (cost_snapshot is null or cost_snapshot >= 0),
  constraint protocol_products_position_check
    check (position between 1 and 100),
  constraint protocol_products_protocol_position_key unique (protocol_id, position)
);

create index if not exists protocol_products_protocol_idx
  on public.protocol_products (protocol_id, position);

create index if not exists protocol_products_product_idx
  on public.protocol_products (product_id, protocol_id);

-- ---------------------------------------------------------------------------
-- Metadados verificaveis das fotografias clinicas privadas
-- ---------------------------------------------------------------------------

alter table public.protocol_photos
  add column if not exists mime_type text,
  add column if not exists size_bytes bigint,
  add column if not exists sha256 text,
  add column if not exists original_name text,
  add column if not exists thumbnail_storage_path text,
  add column if not exists thumbnail_mime_type text,
  add column if not exists thumbnail_size_bytes bigint,
  add column if not exists thumbnail_sha256 text,
  add column if not exists product_id uuid,
  add column if not exists lot_snapshot text,
  -- As tabelas operacionais surgem em 35000. As FKs e a validacao cruzada sao
  -- adicionadas la; as colunas nascem aqui para o contrato da foto ser estavel.
  add column if not exists attendance_id uuid,
  add column if not exists procedure_item_id uuid,
  add column if not exists duplicate_of_photo_id uuid,
  add column if not exists duplicate_reason text,
  add column if not exists duplicate_confirmed_by uuid,
  add column if not exists duplicate_confirmed_at timestamptz,
  add column if not exists duplicate_operation_id uuid,
  add column if not exists archived_at timestamptz,
  add column if not exists idempotency_key uuid;

-- Preserva eventuais linhas antigas sem inventar hash ou tamanho. Novas linhas
-- passam obrigatoriamente pelo RPC, que exige todos os metadados.
update public.protocol_photos
set original_name = nullif(regexp_replace(storage_path, '^.*/', ''), '')
where original_name is null;

update public.protocol_photos
set original_name = 'legacy-image'
where original_name is null or btrim(original_name) = '';

do $migration$
begin
  -- Preserva a categoria legada "during", mas novas telas trabalham com as
  -- categorias Antes, Depois e Produtos utilizados. Nao existe unicidade por
  -- categoria: um procedimento pode ter quantas fotos forem necessarias.
  alter table public.protocol_photos
    drop constraint if exists protocol_photos_phase_check;
  alter table public.protocol_photos
    add constraint protocol_photos_phase_check check (
      phase in ('before', 'during', 'after', 'products_used')
    );

  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.protocol_photos'::regclass
      and conname = 'protocol_photos_protocol_id_fkey'
      and pg_get_constraintdef(oid) ilike '%on delete cascade%'
  ) then
    alter table public.protocol_photos
      drop constraint protocol_photos_protocol_id_fkey;
    alter table public.protocol_photos
      add constraint protocol_photos_protocol_id_fkey
      foreign key (protocol_id) references public.protocols(id) on delete restrict;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.protocol_photos'::regclass
      and conname = 'protocol_photos_mime_type_check'
  ) then
    alter table public.protocol_photos
      add constraint protocol_photos_mime_type_check check (
        mime_type is null
        or mime_type in ('image/jpeg', 'image/png', 'image/webp')
      );
  end if;

  alter table public.protocol_photos
    drop constraint if exists protocol_photos_size_bytes_check;
  alter table public.protocol_photos
    add constraint protocol_photos_size_bytes_check check (
      size_bytes is null or size_bytes between 1 and 26214400
    );

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.protocol_photos'::regclass
      and conname = 'protocol_photos_thumbnail_metadata_check'
  ) then
    alter table public.protocol_photos
      add constraint protocol_photos_thumbnail_metadata_check check (
        (
          thumbnail_storage_path is null
          and thumbnail_mime_type is null
          and thumbnail_size_bytes is null
          and thumbnail_sha256 is null
        )
        or (
          thumbnail_storage_path is not null
          and thumbnail_mime_type in ('image/jpeg', 'image/png', 'image/webp')
          and thumbnail_size_bytes between 1 and 1048576
          and thumbnail_sha256 ~ '^[0-9a-f]{64}$'
        )
      );
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.protocol_photos'::regclass
      and conname = 'protocol_photos_sha256_check'
  ) then
    alter table public.protocol_photos
      add constraint protocol_photos_sha256_check check (
        sha256 is null or sha256 ~ '^[0-9a-f]{64}$'
      );
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.protocol_photos'::regclass
      and conname = 'protocol_photos_original_name_check'
  ) then
    alter table public.protocol_photos
      add constraint protocol_photos_original_name_check check (
        original_name is null
        or (
          char_length(btrim(original_name)) between 1 and 180
          and original_name !~ '[[:cntrl:]/\\]'
        )
      );
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.protocol_photos'::regclass
      and conname = 'protocol_photos_product_id_fkey'
  ) then
    alter table public.protocol_photos
      add constraint protocol_photos_product_id_fkey
      foreign key (product_id)
      references public.financeiro_produtos(id)
      on delete restrict;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.protocol_photos'::regclass
      and conname = 'protocol_photos_lot_snapshot_check'
  ) then
    alter table public.protocol_photos
      add constraint protocol_photos_lot_snapshot_check check (
        lot_snapshot is null
        or (
          char_length(btrim(lot_snapshot)) between 1 and 100
          and lot_snapshot !~ '[[:cntrl:]]'
        )
      );
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.protocol_photos'::regclass
      and conname = 'protocol_photos_product_context_check'
  ) then
    alter table public.protocol_photos
      add constraint protocol_photos_product_context_check check (
        phase = 'products_used'
        or (product_id is null and lot_snapshot is null)
      );
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.protocol_photos'::regclass
      and conname = 'protocol_photos_duplicate_of_fkey'
  ) then
    alter table public.protocol_photos
      add constraint protocol_photos_duplicate_of_fkey
      foreign key (duplicate_of_photo_id)
      references public.protocol_photos(id)
      on delete restrict;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.protocol_photos'::regclass
      and conname = 'protocol_photos_duplicate_confirmed_by_fkey'
  ) then
    alter table public.protocol_photos
      add constraint protocol_photos_duplicate_confirmed_by_fkey
      foreign key (duplicate_confirmed_by)
      references auth.users(id)
      on delete restrict;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.protocol_photos'::regclass
      and conname = 'protocol_photos_duplicate_confirmation_check'
  ) then
    alter table public.protocol_photos
      add constraint protocol_photos_duplicate_confirmation_check check (
        (
          duplicate_of_photo_id is null
          and duplicate_reason is null
          and duplicate_confirmed_by is null
          and duplicate_confirmed_at is null
          and duplicate_operation_id is null
        )
        or (
          duplicate_of_photo_id is not null
          and duplicate_of_photo_id <> id
          and char_length(btrim(duplicate_reason)) between 3 and 500
          and duplicate_reason !~ '[[:cntrl:]]'
          and duplicate_confirmed_by is not null
          and duplicate_confirmed_at is not null
          and duplicate_operation_id is not null
        )
      );
  end if;
end;
$migration$;

create unique index if not exists protocol_photos_storage_path_key
  on public.protocol_photos (storage_path);

create unique index if not exists protocol_photos_thumbnail_storage_path_key
  on public.protocol_photos (thumbnail_storage_path)
  where thumbnail_storage_path is not null;

create unique index if not exists protocol_photos_protocol_idempotency_key
  on public.protocol_photos (protocol_id, idempotency_key)
  where idempotency_key is not null;

create unique index if not exists protocol_photos_duplicate_operation_key
  on public.protocol_photos (duplicate_operation_id)
  where duplicate_operation_id is not null;

create index if not exists protocol_photos_protocol_sha256_idx
  on public.protocol_photos (protocol_id, sha256, attendance_id, taken_at desc)
  where sha256 is not null;

create index if not exists protocol_photos_protocol_phase_idx
  on public.protocol_photos (protocol_id, phase, archived_at, taken_at);

create index if not exists protocol_photos_product_idx
  on public.protocol_photos (product_id, protocol_id, taken_at desc)
  where product_id is not null;

create or replace view public.protocol_photo_counts
with (security_invoker = true)
as
select
  photo.protocol_id,
  pg_catalog.count(*)::integer as total_count,
  pg_catalog.count(*) filter (where photo.archived_at is null)::integer as active_count,
  pg_catalog.count(*) filter (where photo.archived_at is not null)::integer as archived_count,
  pg_catalog.count(*) filter (
    where photo.phase = 'products_used' and photo.archived_at is null
  )::integer as active_product_count
from public.protocol_photos photo
group by photo.protocol_id;

-- ---------------------------------------------------------------------------
-- Consentimento clinico de fotografia != autorizacao de marketing
-- ---------------------------------------------------------------------------

alter table public.protocol_consents
  add column if not exists recorded_at timestamptz,
  add column if not exists recorded_by uuid,
  add column if not exists term_version_snapshot text,
  add column if not exists term_sha256_snapshot text,
  add column if not exists supersedes_id uuid;

-- Linhas legadas permanecem intactas; o novo horario e apenas derivado da
-- evidencia temporal ja existente. Novos eventos recebem now() no servidor.
update public.protocol_consents
set recorded_at = coalesce(accepted_at, revoked_at, now())
where recorded_at is null;

update public.protocol_consents consent
set term_version_snapshot = term.version,
    term_sha256_snapshot = lower(term.content_sha256)
from public.consent_terms term
where consent.term_id = term.id
  and (
    consent.term_version_snapshot is null
    or consent.term_sha256_snapshot is null
  );

alter table public.protocol_consents
  alter column recorded_at set default now(),
  alter column recorded_at set not null;

do $migration$
begin
  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.protocol_consents'::regclass
      and conname = 'protocol_consents_kind_check'
  ) then
    alter table public.protocol_consents
      drop constraint protocol_consents_kind_check;
  end if;

  alter table public.protocol_consents
    add constraint protocol_consents_kind_check check (
      kind in (
        'term_read',
        'data_processing',
        'clinical_photography',
        'marketing_use',
        'image_use'
      )
    );

  -- Um consentimento e um evento, nao um estado mutavel. A constraint antiga
  -- impedia registrar reaceite/revogacao sem apagar a cronologia.
  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.protocol_consents'::regclass
      and conname = 'protocol_consents_protocol_id_kind_key'
  ) then
    alter table public.protocol_consents
      drop constraint protocol_consents_protocol_id_kind_key;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.protocol_consents'::regclass
      and conname = 'protocol_consents_recorded_by_fkey'
  ) then
    alter table public.protocol_consents
      add constraint protocol_consents_recorded_by_fkey
      foreign key (recorded_by) references auth.users(id) on delete restrict;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.protocol_consents'::regclass
      and conname = 'protocol_consents_supersedes_id_fkey'
  ) then
    alter table public.protocol_consents
      add constraint protocol_consents_supersedes_id_fkey
      foreign key (supersedes_id) references public.protocol_consents(id)
      on delete restrict;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.protocol_consents'::regclass
      and conname = 'protocol_consents_term_snapshot_check'
  ) then
    alter table public.protocol_consents
      add constraint protocol_consents_term_snapshot_check check (
        (
          term_id is null
          and term_version_snapshot is null
          and term_sha256_snapshot is null
        )
        or (
          term_id is not null
          and term_version_snapshot is not null
          and term_sha256_snapshot ~ '^[0-9a-f]{64}$'
        )
      );
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.protocol_consents'::regclass
      and conname = 'protocol_consents_legal_signed_check'
  ) then
    alter table public.protocol_consents
      add constraint protocol_consents_legal_signed_check check (
        kind not in (
          'term_read', 'data_processing', 'marketing_use', 'image_use'
        )
        or accepted = false
        or (
          term_id is not null
          and term_version_snapshot is not null
          and term_sha256_snapshot is not null
          and coalesce(evidence ->> 'source', '') = 'patient_signed_term'
          and coalesce(evidence ->> 'signature_sha256', '')
            ~ '^[0-9a-f]{64}$'
        )
      );
  end if;

  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.protocol_consents'::regclass
      and conname = 'protocol_consents_protocol_id_fkey'
      and pg_get_constraintdef(oid) ilike '%on delete cascade%'
  ) then
    alter table public.protocol_consents
      drop constraint protocol_consents_protocol_id_fkey;
    alter table public.protocol_consents
      add constraint protocol_consents_protocol_id_fkey
      foreign key (protocol_id) references public.protocols(id) on delete restrict;
  end if;
end;
$migration$;

create index if not exists protocol_consents_event_history_idx
  on public.protocol_consents (
    protocol_id, kind, recorded_at desc, id desc
  );

create or replace view public.protocol_consent_current
with (security_invoker = true)
as
select distinct on (event.protocol_id, event.kind)
  event.id as event_id,
  event.protocol_id,
  event.kind,
  event.term_id,
  event.accepted,
  event.accepted_at,
  event.revoked_at,
  event.recorded_at,
  event.recorded_by,
  event.term_version_snapshot,
  event.term_sha256_snapshot,
  event.supersedes_id
from public.protocol_consents event
order by event.protocol_id, event.kind, event.recorded_at desc, event.id desc;

comment on column public.protocol_consents.kind is
  'clinical_photography autoriza captura/armazenamento clinico; marketing_use e uma autorizacao separada. image_use permanece apenas para compatibilidade legada.';
comment on table public.protocol_consents is
  'Historico append-only de decisoes/atestacoes. Marketing aceito exige termo separado assinado pelo paciente e snapshot verificavel.';
comment on view public.protocol_consent_current is
  'Estado efetivo por tipo, calculado exclusivamente a partir do evento append-only mais recente.';

-- ---------------------------------------------------------------------------
-- Bucket privado com limites server-side
-- ---------------------------------------------------------------------------

insert into storage.buckets (
  id, name, public, file_size_limit, allowed_mime_types
) values (
  'clinic-media',
  'clinic-media',
  false,
  26214400,
  array['image/jpeg', 'image/png', 'image/webp']::text[]
)
on conflict (id) do update
set name = excluded.name,
    public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

-- ---------------------------------------------------------------------------
-- Guardas de imutabilidade: o service_role tambem passa pelos triggers
-- ---------------------------------------------------------------------------

create or replace function private.prontuario_guard_protocol_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if tg_op = 'DELETE' then
    raise exception 'protocol_delete_forbidden' using errcode = '42501';
  end if;

  if new.version <> old.version + 1 then
    raise exception 'protocol_version_must_increment' using errcode = '40001';
  end if;
  if new.updated_by is null then
    raise exception 'protocol_updated_by_required' using errcode = '23502';
  end if;

  if old.status = 'draft' and old.archived_at is null then
    if new.status <> 'draft' then
      raise exception 'protocol_signature_requires_dedicated_workflow'
        using errcode = '42501';
    end if;
    return new;
  end if;

  -- Assinados e arquivados sao imutaveis. Somente os metadados de
  -- arquivamento/restauracao e controle de versao podem mudar.
  if (
    to_jsonb(new) - array[
      'archived_at', 'archive_reason', 'archived_by', 'updated_by',
      'updated_at', 'version'
    ]::text[]
  ) is distinct from (
    to_jsonb(old) - array[
      'archived_at', 'archive_reason', 'archived_by', 'updated_by',
      'updated_at', 'version'
    ]::text[]
  ) then
    raise exception 'signed_protocol_is_immutable' using errcode = '42501';
  end if;

  return new;
end;
$function$;

revoke all on function private.prontuario_guard_protocol_mutation()
  from public, anon, authenticated, service_role;

drop trigger if exists protocols_guard_mutation on public.protocols;
create trigger protocols_guard_mutation
before update or delete on public.protocols
for each row execute function private.prontuario_guard_protocol_mutation();

create or replace function private.prontuario_guard_product_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_protocol_id uuid := case when tg_op = 'DELETE' then old.protocol_id else new.protocol_id end;
  v_status text;
  v_archived_at timestamptz;
begin
  if tg_op = 'UPDATE' and new.protocol_id <> old.protocol_id then
    raise exception 'protocol_product_parent_is_immutable' using errcode = '42501';
  end if;

  select status, archived_at
  into v_status, v_archived_at
  from public.protocols
  where id = v_protocol_id;

  if not found or v_status <> 'draft' or v_archived_at is not null then
    raise exception 'protocol_products_locked' using errcode = '42501';
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$function$;

revoke all on function private.prontuario_guard_product_mutation()
  from public, anon, authenticated, service_role;

drop trigger if exists protocol_products_guard_mutation on public.protocol_products;
create trigger protocol_products_guard_mutation
before insert or update or delete on public.protocol_products
for each row execute function private.prontuario_guard_product_mutation();

create or replace function private.prontuario_guard_photo_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_protocol_id uuid := case when tg_op = 'DELETE' then old.protocol_id else new.protocol_id end;
  v_status text;
  v_archived_at timestamptz;
begin
  if tg_op = 'UPDATE' and new.protocol_id <> old.protocol_id then
    raise exception 'protocol_photo_parent_is_immutable' using errcode = '42501';
  end if;

  select status, archived_at
  into v_status, v_archived_at
  from public.protocols
  where id = v_protocol_id;

  if not found or v_archived_at is not null then
    raise exception 'protocol_photo_parent_unavailable' using errcode = '42501';
  end if;

  if tg_op = 'INSERT' then
    if v_status not in ('draft', 'signed') then
      raise exception 'protocol_photo_parent_locked' using errcode = '42501';
    end if;
    return new;
  end if;

  if tg_op = 'DELETE' then
    raise exception 'protocol_photo_delete_forbidden' using errcode = '42501';
  end if;

  if v_status = 'draft' then
    return new;
  end if;

  if (
    to_jsonb(new) - array['archived_at', 'attendance_id', 'procedure_item_id']
  ) is distinct from (
    to_jsonb(old) - array['archived_at', 'attendance_id', 'procedure_item_id']
  ) then
    raise exception 'signed_protocol_photo_is_immutable' using errcode = '42501';
  end if;

  return new;
end;
$function$;

revoke all on function private.prontuario_guard_photo_mutation()
  from public, anon, authenticated, service_role;

drop trigger if exists protocol_photos_guard_mutation on public.protocol_photos;
create trigger protocol_photos_guard_mutation
before insert or update or delete on public.protocol_photos
for each row execute function private.prontuario_guard_photo_mutation();

create or replace function private.prontuario_guard_consent_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_protocol_id uuid := case when tg_op = 'DELETE' then old.protocol_id else new.protocol_id end;
  v_status text;
  v_archived_at timestamptz;
  v_clinic_id uuid;
  v_procedure_kind text;
  v_term_version text;
  v_term_sha256 text;
  v_superseded_protocol_id uuid;
  v_superseded_kind text;
begin
  if tg_op in ('UPDATE', 'DELETE') then
    raise exception 'protocol_consent_event_is_immutable' using errcode = '42501';
  end if;

  select status, archived_at, clinic_id, procedure_kind
  into v_status, v_archived_at, v_clinic_id, v_procedure_kind
  from public.protocols
  where id = v_protocol_id;

  if not found or v_archived_at is not null
     or v_status not in ('draft', 'signed') then
    raise exception 'protocol_consent_parent_unavailable' using errcode = '42501';
  end if;

  if new.recorded_by is null or not exists (
    select 1
    from public.clinic_members
    where clinic_id = v_clinic_id
      and user_id = new.recorded_by
      and status = 'active'
      and role in ('owner', 'professional')
  ) then
    raise exception 'protocol_consent_actor_invalid' using errcode = '42501';
  end if;

  if jsonb_typeof(new.evidence) <> 'object'
     or pg_column_size(new.evidence) > 4096 then
    raise exception 'protocol_consent_evidence_invalid' using errcode = '22023';
  end if;

  new.recorded_at := now();
  new.accepted_at := case when new.accepted then new.recorded_at else null end;
  new.revoked_at := case when new.accepted then null else new.recorded_at end;

  if new.supersedes_id is not null then
    select protocol_id, kind
    into v_superseded_protocol_id, v_superseded_kind
    from public.protocol_consents
    where id = new.supersedes_id;

    if not found
       or v_superseded_protocol_id is distinct from new.protocol_id
       or v_superseded_kind is distinct from new.kind then
      raise exception 'protocol_consent_supersedes_invalid' using errcode = '22023';
    end if;
  end if;

  if new.term_id is not null then
    select version, lower(content_sha256)
    into v_term_version, v_term_sha256
    from public.consent_terms
    where id = new.term_id
      and clinic_id = v_clinic_id
      and (
        procedure_kind = v_procedure_kind
        or (new.kind = 'marketing_use' and procedure_kind = 'marketing_image')
      );

    if not found or v_term_sha256 !~ '^[0-9a-f]{64}$' then
      raise exception 'protocol_consent_term_invalid' using errcode = '22023';
    end if;

    new.term_version_snapshot := v_term_version;
    new.term_sha256_snapshot := v_term_sha256;
  else
    new.term_version_snapshot := null;
    new.term_sha256_snapshot := null;
  end if;

  if new.kind = 'clinical_photography'
     and new.accepted = true
     and coalesce(new.evidence ->> 'source', '') <> 'professional_attestation' then
    raise exception 'clinical_photography_attestation_required'
      using errcode = '42501';
  end if;

  if new.kind in (
    'term_read', 'data_processing', 'marketing_use', 'image_use'
  ) and new.accepted = true and (
    new.term_id is null
    or coalesce(new.evidence ->> 'source', '') <> 'patient_signed_term'
    or coalesce(new.evidence ->> 'signature_sha256', '') !~ '^[0-9a-f]{64}$'
  ) then
    raise exception 'patient_consent_requires_signed_term'
      using errcode = '42501';
  end if;

  return new;
end;
$function$;

revoke all on function private.prontuario_guard_consent_mutation()
  from public, anon, authenticated, service_role;

drop trigger if exists protocol_consents_guard_mutation on public.protocol_consents;
create trigger protocol_consents_guard_mutation
before insert or update or delete on public.protocol_consents
for each row execute function private.prontuario_guard_consent_mutation();

-- ---------------------------------------------------------------------------
-- Helpers privados usados exclusivamente pelos RPCs server-side
-- ---------------------------------------------------------------------------

create or replace function private.prontuario_assert_actor(
  p_clinic_id uuid,
  p_user_id uuid,
  p_actor_role text,
  p_auth_method text,
  p_allowed_roles text[]
)
returns text
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_role text;
begin
  if p_clinic_id is null or p_user_id is null then
    raise exception 'tenant_or_actor_missing' using errcode = '22023';
  end if;
  if p_auth_method <> 'supabase_auth' then
    raise exception 'individual_auth_required' using errcode = '42501';
  end if;

  select role
  into v_role
  from public.clinic_members
  where clinic_id = p_clinic_id
    and user_id = p_user_id
    and status = 'active';

  if not found or v_role is distinct from p_actor_role
     or not (v_role = any(p_allowed_roles)) then
    raise exception 'role_forbidden' using errcode = '42501';
  end if;

  return v_role;
end;
$function$;

revoke all on function private.prontuario_assert_actor(uuid,uuid,text,text,text[])
  from public, anon, authenticated, service_role;

create or replace function private.prontuario_log_event(
  p_clinic_id uuid,
  p_user_id uuid,
  p_actor_role text,
  p_auth_method text,
  p_entity text,
  p_entity_id uuid,
  p_action text,
  p_details jsonb,
  p_request_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if p_request_id is null then
    raise exception 'request_id_required' using errcode = '22023';
  end if;

  insert into public.clinic_audit_log (
    clinic_id, actor, entity, entity_id, action, details,
    actor_role, auth_method, outcome, request_id
  ) values (
    p_clinic_id, p_user_id, p_entity, p_entity_id, p_action,
    coalesce(p_details, '{}'::jsonb), p_actor_role, p_auth_method,
    'success', p_request_id
  );
end;
$function$;

revoke all on function private.prontuario_log_event(uuid,uuid,text,text,text,uuid,text,jsonb,uuid)
  from public, anon, authenticated, service_role;

create or replace function private.prontuario_replace_products(
  p_protocol_id uuid,
  p_clinic_id uuid,
  p_products jsonb
)
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_status text;
  v_archived_at timestamptz;
  v_procedure_date date;
  v_item jsonb;
  v_ordinality bigint;
  v_product_id uuid;
  v_lot text;
  v_expiry date;
  v_amount numeric(14,4);
  v_unit text;
  v_position smallint;
  v_product public.financeiro_produtos%rowtype;
  v_brand_name text;
  v_count integer := 0;
begin
  if jsonb_typeof(p_products) <> 'array'
     or jsonb_array_length(p_products) > 50 then
    raise exception 'products_invalid' using errcode = '22023';
  end if;

  select status, archived_at, procedure_date
  into v_status, v_archived_at, v_procedure_date
  from public.protocols
  where id = p_protocol_id and clinic_id = p_clinic_id
  for update;

  if not found then
    raise exception 'protocol_not_found' using errcode = 'P0002';
  end if;
  if v_status <> 'draft' or v_archived_at is not null then
    raise exception 'protocol_products_locked' using errcode = '42501';
  end if;

  delete from public.protocol_products where protocol_id = p_protocol_id;

  for v_item, v_ordinality in
    select value, ordinality
    from jsonb_array_elements(p_products) with ordinality
  loop
    begin
      v_product_id := (v_item ->> 'product_id')::uuid;
      v_lot := nullif(btrim(v_item ->> 'lot'), '');
      v_expiry := (v_item ->> 'expiry')::date;
      v_amount := (v_item ->> 'amount')::numeric(14,4);
      v_unit := nullif(btrim(v_item ->> 'unit'), '');
      v_position := coalesce(
        nullif(v_item ->> 'position', '')::smallint,
        v_ordinality::smallint
      );
    exception when others then
      raise exception 'product_item_invalid' using errcode = '22023';
    end;

    if v_product_id is null or v_lot is null
       or char_length(v_lot) > 100
       or v_expiry is null
       or (v_procedure_date is not null and v_expiry < v_procedure_date)
       or v_amount is null or v_amount <= 0 or v_amount > 1000000
       or v_unit not in (
         'U', 'mL', 'mg', 'g', 'un.', 'un', 'cx', 'frasco', 'ampola',
         'seringa', 'canula', 'kit', 'dose'
       )
       or v_position not between 1 and 100 then
      raise exception 'product_item_invalid' using errcode = '22023';
    end if;

    select *
    into v_product
    from public.financeiro_produtos
    where id = v_product_id
      and clinic_id = p_clinic_id
      and active = true
      and archived_at is null;

    if not found then
      raise exception 'catalog_product_not_found' using errcode = 'P0002';
    end if;

    v_brand_name := null;
    if v_product.brand_id is not null then
      select name
      into v_brand_name
      from public.financeiro_marcas
      where id = v_product.brand_id
        and clinic_id = p_clinic_id
        and active = true
        and archived_at is null;

      if not found then
        raise exception 'catalog_brand_not_found' using errcode = 'P0002';
      end if;
    end if;

    insert into public.protocol_products (
      protocol_id, product_id, brand_id,
      product_name_snapshot, brand_name_snapshot,
      anvisa_registration_snapshot, lot, expiry, amount, unit,
      cost_snapshot, position
    ) values (
      p_protocol_id, v_product.id, v_product.brand_id,
      v_product.name, v_brand_name, v_product.anvisa_registration,
      v_lot, v_expiry, v_amount, v_unit,
      v_product.reference_cost, v_position
    );

    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$function$;

revoke all on function private.prontuario_replace_products(uuid,uuid,jsonb)
  from public, anon, authenticated, service_role;

create or replace function private.prontuario_append_consents(
  p_protocol_id uuid,
  p_user_id uuid,
  p_consents jsonb
)
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_kind text;
  v_value jsonb;
  v_accepted boolean;
  v_previous_id uuid;
  v_previous_accepted boolean;
  v_has_previous boolean;
  v_count integer := 0;
begin
  if p_consents is null then
    return 0;
  end if;
  if jsonb_typeof(p_consents) <> 'object' then
    raise exception 'consents_invalid' using errcode = '22023';
  end if;

  for v_kind, v_value in select key, value from jsonb_each(p_consents)
  loop
    if v_kind not in (
      'term_read', 'data_processing',
      'clinical_photography', 'marketing_use'
    ) or jsonb_typeof(v_value) <> 'boolean' then
      raise exception 'consent_item_invalid' using errcode = '22023';
    end if;

    v_accepted := (v_value #>> '{}')::boolean;

    -- Consentimentos legais nunca sao autorizados/revogados pelo checkbox
    -- administrativo. Um fluxo separado devera anexar o termo assinado e sua
    -- assinatura hash. Aqui so cabe a atestacao clinica interna de fotografia.
    if v_kind <> 'clinical_photography' then
      if v_accepted then
        raise exception 'patient_consent_requires_signed_term'
          using errcode = '42501';
      end if;
      continue;
    end if;

    v_previous_id := null;
    v_previous_accepted := null;
    select id, accepted
    into v_previous_id, v_previous_accepted
    from public.protocol_consents
    where protocol_id = p_protocol_id
      and kind = v_kind
    order by recorded_at desc, id desc
    limit 1;
    v_has_previous := found;

    -- Ausencia/false inicial nao gera um evento artificial; e repetir a mesma
    -- decisao e idempotente e nao apaga nem duplica a cronologia.
    if (not v_has_previous and not v_accepted)
       or (v_has_previous and v_previous_accepted = v_accepted) then
      continue;
    end if;

    insert into public.protocol_consents (
      protocol_id, kind, term_id, accepted, evidence,
      recorded_by, supersedes_id
    ) values (
      p_protocol_id, v_kind, null, v_accepted,
      jsonb_build_object(
        'source', 'professional_attestation',
        'operation', case
          when v_accepted then 'consent_recorded'
          else 'consent_revoked'
        end
      ),
      p_user_id, v_previous_id
    );

    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$function$;

revoke all on function private.prontuario_append_consents(uuid,uuid,jsonb)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- RPC: cria ou atualiza um rascunho e substitui seus itens atomicamente
-- ---------------------------------------------------------------------------

create or replace function public.prontuario_salvar_rascunho(
  p_clinic_id uuid,
  p_user_id uuid,
  p_actor_role text,
  p_auth_method text,
  p_protocol_id uuid,
  p_expected_version integer,
  p_idempotency_key uuid,
  p_patient_id uuid,
  p_appointment_id uuid,
  p_procedure_kind text,
  p_complaint text,
  p_anamnesis jsonb,
  p_technique_notes text,
  p_procedure_date date,
  p_return_date date,
  p_care_notes text,
  p_products jsonb,
  p_consents jsonb,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_protocol public.protocols%rowtype;
  v_created boolean := false;
  v_product_count integer := 0;
  v_consent_count integer := 0;
  v_previous_id uuid;
  v_previous_version integer;
  v_previous_action text;
  v_complaint text := nullif(btrim(p_complaint), '');
  v_technique_notes text := nullif(btrim(p_technique_notes), '');
  v_care_notes text := nullif(btrim(p_care_notes), '');
begin
  perform private.prontuario_assert_actor(
    p_clinic_id, p_user_id, p_actor_role, p_auth_method,
    array['owner', 'professional']::text[]
  );

  if p_request_id is null or p_patient_id is null
     or p_idempotency_key is null then
    raise exception 'required_parameter_missing' using errcode = '22023';
  end if;

  select entity_id, action, nullif(details ->> 'version', '')::integer
  into v_previous_id, v_previous_action, v_previous_version
  from public.clinic_audit_log
  where clinic_id = p_clinic_id and request_id = p_request_id;

  if found then
    if p_protocol_id is not null
       and v_previous_id = p_protocol_id
       and v_previous_action = 'draft.update' then
      return jsonb_build_object(
        'id', v_previous_id,
        'version', v_previous_version,
        'created', false,
        'idempotent', true,
        'product_count', 0,
        'consent_count', 0
      );
    end if;
    if p_protocol_id is not null then
      raise exception 'operation_id_reused' using errcode = '22023';
    end if;
  end if;
  if p_procedure_kind not in (
    'toxina_botulinica', 'preenchimento', 'bioestimulador', 'skinbooster',
    'microagulhamento', 'intradermoterapia', 'fios_pdo', 'avaliacao_facial'
  ) then
    raise exception 'procedure_kind_invalid' using errcode = '22023';
  end if;
  if p_anamnesis is null or jsonb_typeof(p_anamnesis) <> 'object'
     or pg_column_size(p_anamnesis) > 131072 then
    raise exception 'anamnesis_invalid' using errcode = '22023';
  end if;
  if v_complaint is not null and char_length(v_complaint) > 2000 then
    raise exception 'complaint_too_long' using errcode = '22023';
  end if;
  if v_technique_notes is not null and char_length(v_technique_notes) > 5000 then
    raise exception 'technique_notes_too_long' using errcode = '22023';
  end if;
  if v_care_notes is not null and char_length(v_care_notes) > 5000 then
    raise exception 'care_notes_too_long' using errcode = '22023';
  end if;
  if p_return_date is not null and p_procedure_date is not null
     and p_return_date < p_procedure_date then
    raise exception 'return_date_invalid' using errcode = '22023';
  end if;

  if not exists (
    select 1 from public.patients
    where id = p_patient_id
      and clinic_id = p_clinic_id
      and status = 'active'
      and archived_at is null
  ) then
    raise exception 'patient_not_found' using errcode = 'P0002';
  end if;

  if p_appointment_id is not null and not exists (
    select 1 from public.agendamentos_clinica where id = p_appointment_id
  ) then
    raise exception 'appointment_not_found' using errcode = 'P0002';
  end if;

  if p_protocol_id is null then
    perform pg_advisory_xact_lock(
      hashtextextended(
        p_clinic_id::text || ':protocol:' || p_idempotency_key::text,
        0
      )
    );

    select *
    into v_protocol
    from public.protocols
    where clinic_id = p_clinic_id
      and idempotency_key = p_idempotency_key
    for update;

    if found then
      if v_protocol.patient_id is distinct from p_patient_id
         or v_protocol.procedure_kind is distinct from p_procedure_kind
         or v_protocol.professional_id is distinct from p_user_id then
        raise exception 'idempotency_key_reused' using errcode = '22023';
      end if;

      return jsonb_build_object(
        'id', v_protocol.id,
        'version', v_protocol.version,
        'created', false,
        'idempotent', true
      );
    end if;

    insert into public.protocols (
      clinic_id, patient_id, professional_id, appointment_id,
      procedure_kind, complaint, anamnesis, technique_notes,
      procedure_date, return_date, care_notes, status,
      version, updated_by, idempotency_key
    ) values (
      p_clinic_id, p_patient_id, p_user_id, p_appointment_id,
      p_procedure_kind, v_complaint, p_anamnesis, v_technique_notes,
      p_procedure_date, p_return_date, v_care_notes, 'draft',
      1, p_user_id, p_idempotency_key
    ) returning * into v_protocol;
    v_created := true;
  else
    select *
    into v_protocol
    from public.protocols
    where id = p_protocol_id and clinic_id = p_clinic_id
    for update;

    if not found then
      raise exception 'protocol_not_found' using errcode = 'P0002';
    end if;
    if v_protocol.status <> 'draft' or v_protocol.archived_at is not null then
      raise exception 'protocol_locked' using errcode = '42501';
    end if;
    if p_expected_version is null or v_protocol.version <> p_expected_version then
      raise exception 'version_conflict' using errcode = '40001';
    end if;

    update public.protocols
    set patient_id = p_patient_id,
        appointment_id = p_appointment_id,
        procedure_kind = p_procedure_kind,
        complaint = v_complaint,
        anamnesis = p_anamnesis,
        technique_notes = v_technique_notes,
        procedure_date = p_procedure_date,
        return_date = p_return_date,
        care_notes = v_care_notes,
        updated_by = p_user_id,
        updated_at = now(),
        version = version + 1
    where id = p_protocol_id and clinic_id = p_clinic_id
    returning * into v_protocol;
  end if;

  if p_products is not null then
    v_product_count := private.prontuario_replace_products(
      v_protocol.id, p_clinic_id, p_products
    );
  end if;
  v_consent_count := private.prontuario_append_consents(
    v_protocol.id, p_user_id, p_consents
  );

  perform private.prontuario_log_event(
    p_clinic_id, p_user_id, p_actor_role, p_auth_method,
    'protocol', v_protocol.id,
    case when v_created then 'draft.create' else 'draft.update' end,
    jsonb_build_object(
      'endpoint', 'prontuario-fichas',
      'operation', case
        when v_consent_count > 0 then 'consent.append'
        else 'draft.save'
      end,
      'version', v_protocol.version,
      'item_count', v_product_count,
      'result_count', v_consent_count,
      'idempotent', false
    ),
    p_request_id
  );

  return jsonb_build_object(
    'id', v_protocol.id,
    'version', v_protocol.version,
    'created', v_created,
    'idempotent', false,
    'product_count', v_product_count,
    'consent_count', v_consent_count
  );
end;
$function$;

create or replace function public.prontuario_substituir_produtos(
  p_clinic_id uuid,
  p_user_id uuid,
  p_actor_role text,
  p_auth_method text,
  p_protocol_id uuid,
  p_expected_version integer,
  p_products jsonb,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_version integer;
  v_count integer;
  v_previous_id uuid;
  v_previous_version integer;
  v_previous_count integer;
  v_previous_action text;
begin
  perform private.prontuario_assert_actor(
    p_clinic_id, p_user_id, p_actor_role, p_auth_method,
    array['owner', 'professional']::text[]
  );

  select entity_id, action,
         nullif(details ->> 'version', '')::integer,
         nullif(details ->> 'item_count', '')::integer
  into v_previous_id, v_previous_action, v_previous_version, v_previous_count
  from public.clinic_audit_log
  where clinic_id = p_clinic_id and request_id = p_request_id;

  if found then
    if v_previous_id = p_protocol_id
       and v_previous_action = 'products.replace' then
      return jsonb_build_object(
        'id', v_previous_id,
        'version', v_previous_version,
        'product_count', coalesce(v_previous_count, 0),
        'idempotent', true
      );
    end if;
    raise exception 'operation_id_reused' using errcode = '22023';
  end if;

  select version
  into v_version
  from public.protocols
  where id = p_protocol_id
    and clinic_id = p_clinic_id
    and status = 'draft'
    and archived_at is null
  for update;

  if not found then
    raise exception 'protocol_not_found_or_locked' using errcode = 'P0002';
  end if;
  if p_expected_version is null or v_version <> p_expected_version then
    raise exception 'version_conflict' using errcode = '40001';
  end if;

  v_count := private.prontuario_replace_products(
    p_protocol_id, p_clinic_id, p_products
  );

  update public.protocols
  set updated_by = p_user_id,
      updated_at = now(),
      version = version + 1
  where id = p_protocol_id and clinic_id = p_clinic_id
  returning version into v_version;

  perform private.prontuario_log_event(
    p_clinic_id, p_user_id, p_actor_role, p_auth_method,
    'protocol', p_protocol_id, 'products.replace',
    jsonb_build_object(
      'endpoint', 'prontuario-fichas',
      'version', v_version,
      'item_count', v_count
    ),
    p_request_id
  );

  return jsonb_build_object(
    'id', p_protocol_id,
    'version', v_version,
    'product_count', v_count
  );
end;
$function$;

create or replace function public.prontuario_arquivar(
  p_clinic_id uuid,
  p_user_id uuid,
  p_actor_role text,
  p_auth_method text,
  p_protocol_id uuid,
  p_expected_version integer,
  p_reason text,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_protocol public.protocols%rowtype;
  v_reason text := nullif(btrim(p_reason), '');
  v_previous_id uuid;
  v_previous_version integer;
  v_previous_action text;
begin
  perform private.prontuario_assert_actor(
    p_clinic_id, p_user_id, p_actor_role, p_auth_method,
    array['owner']::text[]
  );
  if v_reason is null or char_length(v_reason) not between 3 and 500 then
    raise exception 'archive_reason_invalid' using errcode = '22023';
  end if;

  select entity_id, action, nullif(details ->> 'version', '')::integer
  into v_previous_id, v_previous_action, v_previous_version
  from public.clinic_audit_log
  where clinic_id = p_clinic_id and request_id = p_request_id;

  if found then
    if v_previous_id = p_protocol_id and v_previous_action = 'archive' then
      return jsonb_build_object(
        'id', v_previous_id,
        'version', v_previous_version,
        'archived', true,
        'idempotent', true
      );
    end if;
    raise exception 'operation_id_reused' using errcode = '22023';
  end if;

  select * into v_protocol
  from public.protocols
  where id = p_protocol_id and clinic_id = p_clinic_id
  for update;

  if not found then
    raise exception 'protocol_not_found' using errcode = 'P0002';
  end if;
  if v_protocol.archived_at is not null then
    perform private.prontuario_log_event(
      p_clinic_id, p_user_id, p_actor_role, p_auth_method,
      'protocol', p_protocol_id, 'archive',
      jsonb_build_object(
        'endpoint', 'prontuario-fichas',
        'version', v_protocol.version,
        'reason_code', 'owner_request',
        'idempotent', true
      ),
      p_request_id
    );
    return jsonb_build_object(
      'id', v_protocol.id,
      'version', v_protocol.version,
      'archived', true,
      'idempotent', true
    );
  end if;
  if p_expected_version is null or v_protocol.version <> p_expected_version then
    raise exception 'version_conflict' using errcode = '40001';
  end if;

  update public.protocols
  set archived_at = now(),
      archive_reason = v_reason,
      archived_by = p_user_id,
      updated_by = p_user_id,
      updated_at = now(),
      version = version + 1
  where id = p_protocol_id and clinic_id = p_clinic_id
  returning * into v_protocol;

  perform private.prontuario_log_event(
    p_clinic_id, p_user_id, p_actor_role, p_auth_method,
    'protocol', p_protocol_id, 'archive',
    jsonb_build_object(
      'endpoint', 'prontuario-fichas',
      'version', v_protocol.version,
      'reason_code', 'owner_request'
    ),
    p_request_id
  );

  return jsonb_build_object(
    'id', v_protocol.id,
    'version', v_protocol.version,
    'archived', true,
    'idempotent', false
  );
end;
$function$;

create or replace function public.prontuario_restaurar(
  p_clinic_id uuid,
  p_user_id uuid,
  p_actor_role text,
  p_auth_method text,
  p_protocol_id uuid,
  p_expected_version integer,
  p_reason text,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_protocol public.protocols%rowtype;
  v_reason text := nullif(btrim(p_reason), '');
  v_previous_id uuid;
  v_previous_version integer;
  v_previous_action text;
begin
  perform private.prontuario_assert_actor(
    p_clinic_id, p_user_id, p_actor_role, p_auth_method,
    array['owner']::text[]
  );
  if v_reason is null or char_length(v_reason) not between 3 and 500 then
    raise exception 'restore_reason_invalid' using errcode = '22023';
  end if;

  select entity_id, action, nullif(details ->> 'version', '')::integer
  into v_previous_id, v_previous_action, v_previous_version
  from public.clinic_audit_log
  where clinic_id = p_clinic_id and request_id = p_request_id;

  if found then
    if v_previous_id = p_protocol_id and v_previous_action = 'restore' then
      return jsonb_build_object(
        'id', v_previous_id,
        'version', v_previous_version,
        'archived', false,
        'idempotent', true
      );
    end if;
    raise exception 'operation_id_reused' using errcode = '22023';
  end if;

  select * into v_protocol
  from public.protocols
  where id = p_protocol_id and clinic_id = p_clinic_id
  for update;

  if not found then
    raise exception 'protocol_not_found' using errcode = 'P0002';
  end if;
  if v_protocol.archived_at is null then
    perform private.prontuario_log_event(
      p_clinic_id, p_user_id, p_actor_role, p_auth_method,
      'protocol', p_protocol_id, 'restore',
      jsonb_build_object(
        'endpoint', 'prontuario-fichas',
        'version', v_protocol.version,
        'reason_code', 'owner_request',
        'idempotent', true
      ),
      p_request_id
    );
    return jsonb_build_object(
      'id', v_protocol.id,
      'version', v_protocol.version,
      'archived', false,
      'idempotent', true
    );
  end if;
  if p_expected_version is null or v_protocol.version <> p_expected_version then
    raise exception 'version_conflict' using errcode = '40001';
  end if;

  update public.protocols
  set archived_at = null,
      archived_by = null,
      updated_by = p_user_id,
      updated_at = now(),
      version = version + 1
  where id = p_protocol_id and clinic_id = p_clinic_id
  returning * into v_protocol;

  perform private.prontuario_log_event(
    p_clinic_id, p_user_id, p_actor_role, p_auth_method,
    'protocol', p_protocol_id, 'restore',
    jsonb_build_object(
      'endpoint', 'prontuario-fichas',
      'version', v_protocol.version,
      'reason_code', 'owner_request'
    ),
    p_request_id
  );

  return jsonb_build_object(
    'id', v_protocol.id,
    'version', v_protocol.version,
    'archived', false,
    'idempotent', false
  );
end;
$function$;

-- ---------------------------------------------------------------------------
-- RPCs de fotografia. O arquivo e enviado/removido pela Edge Function; o RPC
-- valida o objeto privado e grava somente metadados verificaveis.
-- ---------------------------------------------------------------------------

drop function if exists public.prontuario_registrar_foto(
  uuid,uuid,text,text,uuid,uuid,text,text,timestamptz,text,bigint,text,text,uuid,uuid
);
drop function if exists public.prontuario_registrar_foto(
  uuid,uuid,text,text,uuid,uuid,text,text,timestamptz,text,bigint,text,text,
  text,text,bigint,text,uuid,text,uuid,uuid
);

create or replace function public.prontuario_registrar_foto(
  p_clinic_id uuid,
  p_user_id uuid,
  p_actor_role text,
  p_auth_method text,
  p_photo_id uuid,
  p_protocol_id uuid,
  p_phase text,
  p_storage_path text,
  p_taken_at timestamptz,
  p_mime_type text,
  p_size_bytes bigint,
  p_sha256 text,
  p_original_name text,
  p_thumbnail_storage_path text,
  p_thumbnail_mime_type text,
  p_thumbnail_size_bytes bigint,
  p_thumbnail_sha256 text,
  p_product_id uuid,
  p_lot_snapshot text,
  p_attendance_id uuid,
  p_procedure_item_id uuid,
  p_confirm_distinct boolean,
  p_duplicate_reason text,
  p_duplicate_operation_id uuid,
  p_idempotency_key uuid,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_protocol_status text;
  v_protocol_archived_at timestamptz;
  v_existing public.protocol_photos%rowtype;
  v_duplicate public.protocol_photos%rowtype;
  v_original_name text := nullif(btrim(p_original_name), '');
  v_lot_snapshot text := nullif(btrim(p_lot_snapshot), '');
  v_duplicate_reason text := nullif(btrim(p_duplicate_reason), '');
  v_storage_metadata jsonb;
  v_thumbnail_metadata jsonb;
begin
  perform private.prontuario_assert_actor(
    p_clinic_id, p_user_id, p_actor_role, p_auth_method,
    array['owner', 'professional']::text[]
  );

  if p_photo_id is null or p_protocol_id is null
     or p_idempotency_key is null or p_request_id is null
     or p_phase not in ('before', 'during', 'after', 'products_used')
     or p_mime_type not in ('image/jpeg', 'image/png', 'image/webp')
     or p_size_bytes not between 1 and 26214400
     or lower(p_sha256) !~ '^[0-9a-f]{64}$'
     or v_original_name is null
     or char_length(v_original_name) > 180
     or v_original_name ~ '[[:cntrl:]/\\]'
     or p_storage_path is null
     or p_storage_path !~ '^[A-Za-z0-9_.:/-]+$'
     or p_storage_path not like p_clinic_id::text || '/' || p_protocol_id::text || '/%'
     or (p_procedure_item_id is not null and p_attendance_id is null)
     or (
       p_phase <> 'products_used'
       and (p_product_id is not null or v_lot_snapshot is not null)
     )
     or (v_lot_snapshot is not null and (
       char_length(v_lot_snapshot) > 100 or v_lot_snapshot ~ '[[:cntrl:]]'
     ))
     or (
       (p_thumbnail_storage_path is null) <> (p_thumbnail_mime_type is null)
       or (p_thumbnail_storage_path is null) <> (p_thumbnail_size_bytes is null)
       or (p_thumbnail_storage_path is null) <> (p_thumbnail_sha256 is null)
     )
     or (
       p_thumbnail_storage_path is not null
       and (
         p_thumbnail_storage_path = p_storage_path
         or p_thumbnail_storage_path !~ '^[A-Za-z0-9_.:/-]+$'
         or p_thumbnail_storage_path not like
           p_clinic_id::text || '/' || p_protocol_id::text || '/%'
         or p_thumbnail_mime_type not in ('image/jpeg', 'image/png', 'image/webp')
         or p_thumbnail_size_bytes not between 1 and 1048576
         or lower(p_thumbnail_sha256) !~ '^[0-9a-f]{64}$'
       )
     )
     or coalesce(p_taken_at, now()) > now() + interval '1 day'
     or (
       coalesce(p_confirm_distinct, false) is false
       and (v_duplicate_reason is not null or p_duplicate_operation_id is not null)
     )
     or (
       coalesce(p_confirm_distinct, false) is true
       and (
         v_duplicate_reason is null
         or char_length(v_duplicate_reason) > 500
         or v_duplicate_reason ~ '[[:cntrl:]]'
         or p_duplicate_operation_id is null
       )
     )
  then
    raise exception 'photo_metadata_invalid' using errcode = '22023';
  end if;

  select status, archived_at
  into v_protocol_status, v_protocol_archived_at
  from public.protocols
  where id = p_protocol_id and clinic_id = p_clinic_id
  for share;

  if not found or v_protocol_archived_at is not null
     or v_protocol_status not in ('draft', 'signed') then
    raise exception 'protocol_not_found_or_locked' using errcode = 'P0002';
  end if;

  -- Quando produto/lote forem informados na categoria Produtos utilizados,
  -- eles precisam pertencer ao mesmo protocolo/paciente. Ambos continuam
  -- opcionais para permitir uma foto geral da bandeja do procedimento.
  if p_phase = 'products_used'
     and (p_product_id is not null or v_lot_snapshot is not null)
     and not exists (
       select 1
       from public.protocol_products item
       where item.protocol_id = p_protocol_id
         and (p_product_id is null or item.product_id = p_product_id)
         and (v_lot_snapshot is null or item.lot = v_lot_snapshot)
     ) then
    raise exception 'photo_product_context_invalid' using errcode = '23503';
  end if;

  if coalesce((
    select accepted
    from public.protocol_consents
    where protocol_id = p_protocol_id
      and kind = 'clinical_photography'
    order by recorded_at desc, id desc
    limit 1
  ), false) is not true then
    raise exception 'clinical_photography_consent_required'
      using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      p_protocol_id::text || ':photo:' || p_idempotency_key::text,
      0
    )
  );

  select * into v_existing
  from public.protocol_photos
  where protocol_id = p_protocol_id
    and idempotency_key = p_idempotency_key;

  if found then
    if v_existing.phase is distinct from p_phase
       or v_existing.storage_path is distinct from p_storage_path
       or v_existing.mime_type is distinct from p_mime_type
       or v_existing.size_bytes is distinct from p_size_bytes
       or v_existing.sha256 is distinct from lower(p_sha256)
       or v_existing.thumbnail_storage_path is distinct from p_thumbnail_storage_path
       or v_existing.thumbnail_mime_type is distinct from p_thumbnail_mime_type
       or v_existing.thumbnail_size_bytes is distinct from p_thumbnail_size_bytes
       or v_existing.thumbnail_sha256 is distinct from lower(p_thumbnail_sha256)
       or v_existing.product_id is distinct from p_product_id
       or v_existing.lot_snapshot is distinct from v_lot_snapshot
       or v_existing.attendance_id is distinct from p_attendance_id
       or v_existing.procedure_item_id is distinct from p_procedure_item_id
       or v_existing.duplicate_reason is distinct from v_duplicate_reason
       or v_existing.duplicate_operation_id is distinct from p_duplicate_operation_id then
      raise exception 'idempotency_key_reused' using errcode = '22023';
    end if;
    return jsonb_build_object(
      'id', v_existing.id,
      'storage_path', v_existing.storage_path,
      'idempotent', true
    );
  end if;

  -- SHA-256 e a fonte exata do arquivo. Por padrao a repeticao dentro do
  -- mesmo prontuario e bloqueada e o identificador existente volta no DETAIL.
  -- Uma foto realmente distinta (por exemplo, mesmo arquivo usado em outro
  -- enquadramento documental) exige confirmacao protegida e motivo auditavel.
  perform pg_advisory_xact_lock(
    hashtextextended(p_protocol_id::text || ':photo-sha256:' || lower(p_sha256), 0)
  );

  select photo.* into v_duplicate
  from public.protocol_photos photo
  where photo.protocol_id = p_protocol_id
    and photo.sha256 = lower(p_sha256)
    and photo.id <> p_photo_id
  order by photo.taken_at, photo.id
  limit 1;

  if found and coalesce(p_confirm_distinct, false) is false then
    raise exception using
      errcode = '23505',
      message = 'photo_exact_duplicate',
      detail = v_duplicate.id::text;
  end if;

  if not found and coalesce(p_confirm_distinct, false) is true then
    raise exception 'photo_duplicate_confirmation_stale' using errcode = '40001';
  end if;

  select metadata
  into v_storage_metadata
  from storage.objects
  where bucket_id = 'clinic-media' and name = p_storage_path;

  if not found then
    raise exception 'photo_object_not_found' using errcode = 'P0002';
  end if;
  if coalesce(v_storage_metadata ->> 'mimetype', '') <> p_mime_type
     or coalesce(v_storage_metadata ->> 'size', '') !~ '^[0-9]+$'
     or (v_storage_metadata ->> 'size')::bigint <> p_size_bytes then
    raise exception 'photo_object_metadata_mismatch' using errcode = '22023';
  end if;

  if p_thumbnail_storage_path is not null then
    select metadata
    into v_thumbnail_metadata
    from storage.objects
    where bucket_id = 'clinic-media' and name = p_thumbnail_storage_path;

    if not found then
      raise exception 'photo_thumbnail_object_not_found' using errcode = 'P0002';
    end if;
    if coalesce(v_thumbnail_metadata ->> 'mimetype', '') <> p_thumbnail_mime_type
       or coalesce(v_thumbnail_metadata ->> 'size', '') !~ '^[0-9]+$'
       or (v_thumbnail_metadata ->> 'size')::bigint <> p_thumbnail_size_bytes then
      raise exception 'photo_thumbnail_metadata_mismatch' using errcode = '22023';
    end if;
  end if;

  insert into public.protocol_photos (
    id, protocol_id, phase, storage_path, taken_at,
    mime_type, size_bytes, sha256, original_name,
    thumbnail_storage_path, thumbnail_mime_type, thumbnail_size_bytes,
    thumbnail_sha256, product_id, lot_snapshot, attendance_id,
    procedure_item_id, duplicate_of_photo_id, duplicate_reason,
    duplicate_confirmed_by, duplicate_confirmed_at,
    duplicate_operation_id, idempotency_key
  ) values (
    p_photo_id, p_protocol_id, p_phase, p_storage_path,
    coalesce(p_taken_at, now()), p_mime_type, p_size_bytes,
    lower(p_sha256), v_original_name,
    p_thumbnail_storage_path, p_thumbnail_mime_type, p_thumbnail_size_bytes,
    lower(p_thumbnail_sha256), p_product_id, v_lot_snapshot,
    p_attendance_id, p_procedure_item_id,
    case when coalesce(p_confirm_distinct, false) then v_duplicate.id else null end,
    case when coalesce(p_confirm_distinct, false) then v_duplicate_reason else null end,
    case when coalesce(p_confirm_distinct, false) then p_user_id else null end,
    case when coalesce(p_confirm_distinct, false) then now() else null end,
    case when coalesce(p_confirm_distinct, false) then p_duplicate_operation_id else null end,
    p_idempotency_key
  );

  perform private.prontuario_log_event(
    p_clinic_id, p_user_id, p_actor_role, p_auth_method,
    'protocol_photo', p_photo_id, 'photo.add',
    jsonb_build_object(
      'endpoint', 'prontuario-fichas',
      'target_kind', p_phase,
      'item_count', 1,
      'reason_code', case
        when coalesce(p_confirm_distinct, false) then 'duplicate_confirmed_distinct'
        else 'standard_upload'
      end,
      'idempotent', false
    ),
    p_request_id
  );

  return jsonb_build_object(
    'id', p_photo_id,
    'storage_path', p_storage_path,
    'thumbnail_storage_path', p_thumbnail_storage_path,
    'idempotent', false
  );
end;
$function$;

create or replace function public.prontuario_remover_foto(
  p_clinic_id uuid,
  p_user_id uuid,
  p_actor_role text,
  p_auth_method text,
  p_photo_id uuid,
  p_reason text,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_photo public.protocol_photos%rowtype;
  v_protocol_status text;
  v_protocol_archived_at timestamptz;
  v_reason text := nullif(btrim(p_reason), '');
  v_previous_id uuid;
  v_previous_action text;
  v_previous_path text;
begin
  perform private.prontuario_assert_actor(
    p_clinic_id, p_user_id, p_actor_role, p_auth_method,
    array['owner']::text[]
  );
  if v_reason is null or char_length(v_reason) not between 3 and 500 then
    raise exception 'photo_removal_reason_invalid' using errcode = '22023';
  end if;

  select entity_id, action, details ->> 'route'
  into v_previous_id, v_previous_action, v_previous_path
  from public.clinic_audit_log
  where clinic_id = p_clinic_id and request_id = p_request_id;

  if found then
    if v_previous_id = p_photo_id and v_previous_action = 'photo.archive' then
      return jsonb_build_object(
        'id', v_previous_id,
        'storage_path', v_previous_path,
        'hard_delete', false,
        'archived', true,
        'idempotent', true
      );
    end if;
    raise exception 'operation_id_reused' using errcode = '22023';
  end if;

  select photo.*
  into v_photo
  from public.protocol_photos photo
  join public.protocols protocol on protocol.id = photo.protocol_id
  where photo.id = p_photo_id and protocol.clinic_id = p_clinic_id
  for update of photo;

  if not found then
    raise exception 'photo_not_found' using errcode = 'P0002';
  end if;

  select status, archived_at
  into v_protocol_status, v_protocol_archived_at
  from public.protocols
  where id = v_photo.protocol_id;

  if v_protocol_archived_at is not null then
    raise exception 'protocol_archived' using errcode = '42501';
  end if;

  if v_photo.archived_at is not null then
    perform private.prontuario_log_event(
      p_clinic_id, p_user_id, p_actor_role, p_auth_method,
      'protocol_photo', p_photo_id, 'photo.archive',
      jsonb_build_object(
        'endpoint', 'prontuario-fichas',
        'reason_code', 'owner_request',
        'target_kind', v_protocol_status,
        'route', v_photo.storage_path,
        'idempotent', true
      ),
      p_request_id
    );
    return jsonb_build_object(
      'id', v_photo.id,
      'storage_path', v_photo.storage_path,
      'hard_delete', false,
      'archived', true,
      'idempotent', true
    );
  end if;

  -- Mesmo em rascunho a foto e o objeto privado sao preservados. A operacao
  -- visivel de "Apagar/Arquivar" apenas retira a foto do prontuario ativo e
  -- permite restauracao posterior com nova prova de senha.
  update public.protocol_photos
  set archived_at = now()
  where id = p_photo_id;

  perform private.prontuario_log_event(
    p_clinic_id, p_user_id, p_actor_role, p_auth_method,
    'protocol_photo', p_photo_id, 'photo.archive',
    jsonb_build_object(
      'endpoint', 'prontuario-fichas',
      'reason_code', 'owner_request',
      'target_kind', v_protocol_status,
      'route', v_photo.storage_path
    ),
    p_request_id
  );

  return jsonb_build_object(
    'id', v_photo.id,
    'storage_path', v_photo.storage_path,
    'hard_delete', false,
    'archived', true,
    'idempotent', false
  );
end;
$function$;

create or replace function public.prontuario_restaurar_foto(
  p_clinic_id uuid,
  p_user_id uuid,
  p_actor_role text,
  p_auth_method text,
  p_photo_id uuid,
  p_reason text,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_photo public.protocol_photos%rowtype;
  v_protocol_status text;
  v_protocol_archived_at timestamptz;
  v_reason text := nullif(pg_catalog.btrim(p_reason), '');
  v_previous_id uuid;
  v_previous_action text;
begin
  perform private.prontuario_assert_actor(
    p_clinic_id, p_user_id, p_actor_role, p_auth_method,
    array['owner']::text[]
  );
  if p_request_id is null or v_reason is null
     or pg_catalog.char_length(v_reason) not between 3 and 500 then
    raise exception 'photo_restore_reason_invalid' using errcode = '22023';
  end if;

  select entity_id, action
  into v_previous_id, v_previous_action
  from public.clinic_audit_log
  where clinic_id = p_clinic_id and request_id = p_request_id;
  if found then
    if v_previous_id = p_photo_id and v_previous_action = 'photo.restore' then
      return pg_catalog.jsonb_build_object(
        'id', p_photo_id, 'restored', true, 'idempotent', true
      );
    end if;
    raise exception 'operation_id_reused' using errcode = '22023';
  end if;

  -- PL/pgSQL não permite uma variável %ROWTYPE ao lado de outros alvos no
  -- mesmo INTO. Bloqueamos a foto primeiro e lemos o estado do protocolo em
  -- seguida; o SELECT original já bloqueava somente a linha de `photo`.
  select photo.*
  into v_photo
  from public.protocol_photos photo
  join public.protocols protocol on protocol.id = photo.protocol_id
  where photo.id = p_photo_id and protocol.clinic_id = p_clinic_id
  for update of photo;
  if not found then
    raise exception 'photo_not_found' using errcode = 'P0002';
  end if;

  select status, archived_at
  into v_protocol_status, v_protocol_archived_at
  from public.protocols
  where id = v_photo.protocol_id;
  if v_protocol_archived_at is not null
     or v_protocol_status not in ('draft', 'signed') then
    raise exception 'protocol_archived' using errcode = '42501';
  end if;

  if v_photo.archived_at is null then
    perform private.prontuario_log_event(
      p_clinic_id, p_user_id, p_actor_role, p_auth_method,
      'protocol_photo', p_photo_id, 'photo.restore',
      pg_catalog.jsonb_build_object(
        'endpoint', 'prontuario-fichas', 'reason_code', 'owner_request',
        'target_kind', v_protocol_status, 'idempotent', true
      ),
      p_request_id
    );
    return pg_catalog.jsonb_build_object(
      'id', p_photo_id, 'storage_path', v_photo.storage_path,
      'restored', true, 'idempotent', true
    );
  end if;

  if coalesce((
    select accepted
    from public.protocol_consents
    where protocol_id = v_photo.protocol_id
      and kind = 'clinical_photography'
    order by recorded_at desc, id desc
    limit 1
  ), false) is not true then
    raise exception 'clinical_photography_consent_required'
      using errcode = '42501';
  end if;

  if not exists (
    select 1 from storage.objects
    where bucket_id = 'clinic-media' and name = v_photo.storage_path
  ) then
    raise exception 'photo_object_not_found' using errcode = 'P0002';
  end if;

  update public.protocol_photos
  set archived_at = null
  where id = p_photo_id;

  perform private.prontuario_log_event(
    p_clinic_id, p_user_id, p_actor_role, p_auth_method,
    'protocol_photo', p_photo_id, 'photo.restore',
    pg_catalog.jsonb_build_object(
      'endpoint', 'prontuario-fichas', 'reason_code', 'owner_request',
      'target_kind', v_protocol_status, 'route', v_photo.storage_path,
      'idempotent', false
    ),
    p_request_id
  );

  return pg_catalog.jsonb_build_object(
    'id', p_photo_id, 'storage_path', v_photo.storage_path,
    'restored', true, 'idempotent', false
  );
end;
$function$;

-- ---------------------------------------------------------------------------
-- RLS/grants: Edge-only. Nao se revogam grants globais de storage.objects,
-- pois outros buckets podem depender deles; sem policy clinic-media, anon e
-- authenticated nao conseguem acessar objetos desse bucket privado.
-- ---------------------------------------------------------------------------

alter table public.protocols enable row level security;
alter table public.protocol_products enable row level security;
alter table public.protocol_photos enable row level security;
alter table public.protocol_consents enable row level security;
alter table public.consent_terms enable row level security;

do $migration$
declare
  old_policy record;
begin
  for old_policy in
    select schemaname, tablename, policyname
    from pg_policies
    where schemaname = 'public'
      and tablename in (
        'protocols', 'protocol_products', 'protocol_photos',
        'protocol_consents', 'consent_terms'
      )
  loop
    execute format(
      'drop policy if exists %I on %I.%I',
      old_policy.policyname, old_policy.schemaname, old_policy.tablename
    );
  end loop;

  for old_policy in
    select schemaname, tablename, policyname
    from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and (
        coalesce(qual, '') ilike '%clinic-media%'
        or coalesce(with_check, '') ilike '%clinic-media%'
      )
  loop
    execute format(
      'drop policy if exists %I on %I.%I',
      old_policy.policyname, old_policy.schemaname, old_policy.tablename
    );
  end loop;
end;
$migration$;

-- Guardrail restritivo: mesmo que uma policy permissiva ampla seja criada no
-- futuro para outro bucket, ela nao libera clinic-media ao navegador.
create policy clinic_media_edge_only_guard
on storage.objects
as restrictive
for all
to anon, authenticated
using (bucket_id <> 'clinic-media')
with check (bucket_id <> 'clinic-media');

revoke all on public.protocols
  from public, anon, authenticated, service_role;
revoke all on public.protocol_products
  from public, anon, authenticated, service_role;
revoke all on public.protocol_photos
  from public, anon, authenticated, service_role;
revoke all on public.protocol_consents
  from public, anon, authenticated, service_role;
revoke all on public.consent_terms
  from public, anon, authenticated, service_role;
revoke all on public.protocol_consent_current
  from public, anon, authenticated, service_role;
revoke all on public.protocol_photo_counts
  from public, anon, authenticated, service_role;

-- O service_role le para compor o painel, mas toda mutacao passa pelos RPCs
-- SECURITY DEFINER validados e auditados abaixo.
grant select on public.protocols to service_role;
grant select on public.protocol_products to service_role;
grant select on public.protocol_photos to service_role;
grant select on public.protocol_consents to service_role;
grant select on public.consent_terms to service_role;
grant select on public.protocol_consent_current to service_role;
grant select on public.protocol_photo_counts to service_role;

revoke all on function public.prontuario_salvar_rascunho(uuid,uuid,text,text,uuid,integer,uuid,uuid,uuid,text,text,jsonb,text,date,date,text,jsonb,jsonb,uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.prontuario_substituir_produtos(uuid,uuid,text,text,uuid,integer,jsonb,uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.prontuario_arquivar(uuid,uuid,text,text,uuid,integer,text,uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.prontuario_restaurar(uuid,uuid,text,text,uuid,integer,text,uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.prontuario_registrar_foto(uuid,uuid,text,text,uuid,uuid,text,text,timestamptz,text,bigint,text,text,text,text,bigint,text,uuid,text,uuid,uuid,boolean,text,uuid,uuid,uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.prontuario_remover_foto(uuid,uuid,text,text,uuid,text,uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.prontuario_restaurar_foto(uuid,uuid,text,text,uuid,text,uuid)
  from public, anon, authenticated, service_role;

grant execute on function public.prontuario_salvar_rascunho(uuid,uuid,text,text,uuid,integer,uuid,uuid,uuid,text,text,jsonb,text,date,date,text,jsonb,jsonb,uuid)
  to service_role;
grant execute on function public.prontuario_substituir_produtos(uuid,uuid,text,text,uuid,integer,jsonb,uuid)
  to service_role;
grant execute on function public.prontuario_arquivar(uuid,uuid,text,text,uuid,integer,text,uuid)
  to service_role;
grant execute on function public.prontuario_restaurar(uuid,uuid,text,text,uuid,integer,text,uuid)
  to service_role;
grant execute on function public.prontuario_registrar_foto(uuid,uuid,text,text,uuid,uuid,text,text,timestamptz,text,bigint,text,text,text,text,bigint,text,uuid,text,uuid,uuid,boolean,text,uuid,uuid,uuid)
  to service_role;
grant execute on function public.prontuario_remover_foto(uuid,uuid,text,text,uuid,text,uuid)
  to service_role;
grant execute on function public.prontuario_restaurar_foto(uuid,uuid,text,text,uuid,text,uuid)
  to service_role;

comment on table public.protocol_products is
  'Produtos e lotes usados no procedimento; snapshots preservam o historico mesmo se o catalogo mudar.';
comment on table public.protocol_photos is
  'Metadados de imagens clinicas privadas. O original em alta qualidade e a miniatura derivada ficam separados no bucket clinic-media; marketing exige consentimento separado.';
comment on view public.protocol_photo_counts is
  'Contagens por prontuario para listagem leve; imagens e URLs assinadas sao carregadas somente sob demanda e com paginacao.';
comment on column public.protocols.archive_reason is
  'Motivo operacional privado. Nao copiar para a trilha tecnica clinic_audit_log.';
comment on function public.prontuario_salvar_rascunho(uuid,uuid,text,text,uuid,integer,uuid,uuid,uuid,text,text,jsonb,text,date,date,text,jsonb,jsonb,uuid) is
  'Cria/atualiza rascunho, produtos e consentimentos em uma unica transacao; somente service_role.';

commit;

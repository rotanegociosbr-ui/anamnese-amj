-- Operacao clinica: atendimentos realizados, retornos e margem de contribuicao.
-- Depende de 20260824030000_estoque_integrado_lotes_frete.sql.
-- Nenhuma mensagem e enviada por esta camada; tentativas sao apenas registros manuais.

begin;

-- ---------------------------------------------------------------------------
-- Espinha administrativa do atendimento (sem texto clinico livre)
-- ---------------------------------------------------------------------------

create table public.atendimentos_realizados (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete restrict,
  patient_id uuid not null,
  appointment_id uuid references public.agendamentos_clinica(id) on delete restrict,
  protocol_id uuid references public.protocols(id) on delete restrict,
  financial_entry_id uuid,
  procedure_kind text not null,
  attended_at timestamptz not null,
  duration_minutes smallint,
  status text not null default 'realizado',
  responsible_user_id uuid,
  idempotency_key uuid not null,
  payload_fingerprint text not null check (pg_catalog.char_length(payload_fingerprint) = 32),
  version integer not null default 1,
  archived_at timestamptz,
  archive_reason text,
  archived_by uuid references auth.users(id) on delete restrict,
  created_by uuid not null references auth.users(id) on delete restrict,
  updated_by uuid references auth.users(id) on delete restrict,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint atendimentos_realizados_clinic_id_id_key unique (clinic_id, id),
  constraint atendimentos_realizados_idempotency_key unique (clinic_id, idempotency_key),
  constraint atendimentos_realizados_patient_fk foreign key (clinic_id, patient_id)
    references public.patients(clinic_id, id) on delete restrict,
  constraint atendimentos_realizados_financial_fk foreign key (clinic_id, financial_entry_id)
    references public.financeiro_lancamentos(clinic_id, id) on delete restrict,
  constraint atendimentos_realizados_responsible_fk foreign key (clinic_id, responsible_user_id)
    references public.clinic_members(clinic_id, user_id) on delete restrict,
  constraint atendimentos_realizados_procedure_kind_check check (
    pg_catalog.char_length(pg_catalog.btrim(procedure_kind)) between 2 and 120
    and procedure_kind !~ '[[:cntrl:]]'
  ),
  constraint atendimentos_realizados_duration_check check (
    duration_minutes is null or duration_minutes between 1 and 720
  ),
  constraint atendimentos_realizados_status_check check (
    status in ('realizado', 'concluido', 'interrompido')
  ),
  constraint atendimentos_realizados_version_check check (version > 0),
  constraint atendimentos_realizados_archive_check check (
    (archived_at is null and archive_reason is null and archived_by is null)
    or (
      archived_at is not null and archived_by is not null
      and pg_catalog.char_length(pg_catalog.btrim(archive_reason)) between 3 and 500
    )
  )
);

create unique index atendimentos_realizados_appointment_unique
  on public.atendimentos_realizados (appointment_id)
  where appointment_id is not null and archived_at is null;
create unique index atendimentos_realizados_protocol_unique
  on public.atendimentos_realizados (protocol_id)
  where protocol_id is not null and archived_at is null;
create unique index atendimentos_realizados_financial_unique
  on public.atendimentos_realizados (clinic_id, financial_entry_id)
  where financial_entry_id is not null and archived_at is null;
create unique index atendimentos_realizados_patient_day_unique
  on public.atendimentos_realizados (
    clinic_id, patient_id,
    ((attended_at at time zone 'America/Sao_Paulo')::date)
  ) where archived_at is null;
create index atendimentos_realizados_patient_date_idx
  on public.atendimentos_realizados (clinic_id, patient_id, attended_at desc);
create index atendimentos_realizados_period_idx
  on public.atendimentos_realizados (clinic_id, attended_at desc, procedure_kind)
  where archived_at is null;

-- Um atendimento representa a visita da paciente em uma data. Os procedimentos
-- dessa visita ficam em itens administrativos separados, sem notas clinicas.
create table public.atendimento_procedimentos (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete restrict,
  attendance_id uuid not null,
  financial_entry_id uuid,
  procedure_kind text not null,
  procedure_region text,
  performed_at timestamptz not null,
  is_primary boolean not null default false,
  version integer not null default 1,
  archived_at timestamptz,
  archive_reason text,
  archived_by uuid references auth.users(id) on delete restrict,
  created_by uuid not null references auth.users(id) on delete restrict,
  updated_by uuid references auth.users(id) on delete restrict,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  idempotency_key uuid not null,
  payload_fingerprint text not null check (pg_catalog.char_length(payload_fingerprint) = 32),
  material_fingerprint text generated always as (
    pg_catalog.md5(
      attendance_id::text || '|' || pg_catalog.lower(pg_catalog.btrim(procedure_kind)) || '|' ||
      pg_catalog.lower(pg_catalog.btrim(coalesce(procedure_region, ''))) || '|' ||
      -- `timestamp::text` é STABLE por depender de DateStyle e não pode ser
      -- usado em coluna gerada. O envio binário do timestamptz é IMMUTABLE e
      -- mantém uma identidade exata, independente de timezone da sessão.
      pg_catalog.encode(pg_catalog.timestamptz_send(performed_at), 'hex')
    )
  ) stored,
  duplicate_of_id uuid,
  distinct_duplicate_reason text,
  duplicate_review_required boolean not null default false,
  constraint atendimento_procedimentos_clinic_id_id_key unique (clinic_id, id),
  constraint atendimento_procedimentos_attendance_fk foreign key (clinic_id, attendance_id)
    references public.atendimentos_realizados(clinic_id, id) on delete restrict,
  constraint atendimento_procedimentos_financial_fk foreign key (clinic_id, financial_entry_id)
    references public.financeiro_lancamentos(clinic_id, id) on delete restrict,
  constraint atendimento_procedimentos_idempotency_unique unique (clinic_id, idempotency_key),
  constraint atendimento_procedimentos_duplicate_of_fk foreign key (clinic_id, duplicate_of_id)
    references public.atendimento_procedimentos(clinic_id, id) on delete restrict,
  constraint atendimento_procedimentos_kind_check check (
    pg_catalog.char_length(pg_catalog.btrim(procedure_kind)) between 2 and 120
    and procedure_kind !~ '[[:cntrl:]]'
  ),
  constraint atendimento_procedimentos_region_check check (
    procedure_region is null or (
      pg_catalog.char_length(pg_catalog.btrim(procedure_region)) between 2 and 120
      and procedure_region !~ '[[:cntrl:]]'
    )
  ),
  constraint atendimento_procedimentos_version_check check (version > 0),
  constraint atendimento_procedimentos_duplicate_state_check check (
    (
      duplicate_review_required and duplicate_of_id is null
      and distinct_duplicate_reason is null
    ) or (
      not duplicate_review_required and duplicate_of_id is null
      and distinct_duplicate_reason is null
    ) or (
      not duplicate_review_required and duplicate_of_id is not null
      and duplicate_of_id <> id
      and pg_catalog.char_length(pg_catalog.btrim(distinct_duplicate_reason)) between 3 and 500
    )
  ),
  constraint atendimento_procedimentos_archive_check check (
    (archived_at is null and archive_reason is null and archived_by is null)
    or (
      archived_at is not null and archived_by is not null and not is_primary
      and pg_catalog.char_length(pg_catalog.btrim(archive_reason)) between 3 and 500
    )
  )
);

create unique index atendimento_procedimentos_primary_unique
  on public.atendimento_procedimentos (clinic_id, attendance_id)
  where is_primary and archived_at is null;
create index atendimento_procedimentos_attendance_idx
  on public.atendimento_procedimentos (clinic_id, attendance_id, created_at, id);
create unique index atendimento_procedimentos_financial_unique
  on public.atendimento_procedimentos (clinic_id, financial_entry_id)
  where financial_entry_id is not null and archived_at is null;

with legacy as (
  select
    pg_catalog.gen_random_uuid() as item_id,
    attendance.clinic_id,
    attendance.id as attendance_id,
    attendance.financial_entry_id,
    attendance.procedure_kind,
    attendance.attended_at as performed_at,
    attendance.created_by,
    attendance.created_at,
    attendance.updated_at
  from public.atendimentos_realizados attendance
)
insert into public.atendimento_procedimentos (
  id, clinic_id, attendance_id, financial_entry_id, procedure_kind, performed_at, is_primary,
  created_by, created_at, updated_at, idempotency_key, payload_fingerprint
)
select
  item_id, clinic_id, attendance_id, financial_entry_id, procedure_kind, performed_at, true,
  created_by, created_at, updated_at, item_id,
  pg_catalog.md5(pg_catalog.jsonb_build_array(attendance_id, pg_catalog.btrim(procedure_kind))::text)
from legacy;

-- Organiza automaticamente cobrancas de atendimento ja existentes. A descricao
-- e preservada como procedimento informado; entradas do mesmo paciente/data
-- viram itens e vinculos separados, sem somar ou mesclar valores silenciosamente.
with ranked_entries as (
  select
    entry.*,
    member.user_id as responsible_user_id_import,
    pg_catalog.row_number() over (
      partition by entry.clinic_id, entry.patient_id, entry.competence_date
      order by entry.created_at, entry.id
    ) as day_position
  from public.financeiro_lancamentos entry
  left join public.clinic_members member
    on member.clinic_id = entry.clinic_id and member.user_id = entry.created_by
  where entry.entry_type = 'receita'
    and entry.origin = 'atendimento'
    and entry.patient_id is not null
), missing_days as (
  select distinct on (entry.clinic_id, entry.patient_id, entry.competence_date)
    entry.*
  from ranked_entries entry
  where not exists (
    select 1
    from public.atendimentos_realizados attendance
    where attendance.clinic_id = entry.clinic_id
      and attendance.patient_id = entry.patient_id
      and (attendance.attended_at at time zone 'America/Sao_Paulo')::date = entry.competence_date
  )
  order by entry.clinic_id, entry.patient_id, entry.competence_date, entry.day_position
)
insert into public.atendimentos_realizados (
  clinic_id, patient_id, financial_entry_id, procedure_kind, attended_at,
  status, responsible_user_id, idempotency_key, payload_fingerprint, created_by,
  created_at, updated_at
)
select
  entry.clinic_id, entry.patient_id, entry.id,
  pg_catalog.left(pg_catalog.btrim(entry.description), 120),
  entry.competence_date::timestamp at time zone 'America/Sao_Paulo',
  'realizado', entry.responsible_user_id_import, entry.id,
  pg_catalog.md5(pg_catalog.jsonb_build_array(
    entry.patient_id, null, null, entry.id,
    pg_catalog.left(pg_catalog.btrim(entry.description), 120),
    entry.competence_date::timestamp at time zone 'America/Sao_Paulo',
    null, 'realizado', entry.responsible_user_id_import
  )::text),
  entry.created_by, entry.created_at, entry.created_at
from missing_days entry;

with entry_targets as (
  select
    entry.*,
    attendance.id as attendance_id,
    attendance.attended_at,
    not exists (
      select 1 from public.atendimento_procedimentos existing_primary
      where existing_primary.clinic_id = attendance.clinic_id
        and existing_primary.attendance_id = attendance.id
        and existing_primary.is_primary and existing_primary.archived_at is null
    ) as needs_primary
  from public.financeiro_lancamentos entry
  join lateral (
    select visit.id, visit.clinic_id, visit.attended_at
    from public.atendimentos_realizados visit
    where visit.clinic_id = entry.clinic_id
      and visit.patient_id = entry.patient_id
      and (visit.attended_at at time zone 'America/Sao_Paulo')::date = entry.competence_date
      and visit.archived_at is null
    order by visit.attended_at, visit.created_at, visit.id
    limit 1
  ) attendance on true
  where entry.entry_type = 'receita'
    and entry.origin = 'atendimento'
    and entry.patient_id is not null
    and not exists (
      select 1 from public.atendimento_procedimentos linked
      where linked.clinic_id = entry.clinic_id and linked.financial_entry_id = entry.id
    )
), numbered as (
  select
    target.*,
    pg_catalog.row_number() over (
      partition by target.clinic_id, target.attendance_id
      order by target.created_at, target.id
    ) as item_position
  from entry_targets target
), prepared as (
  select pg_catalog.gen_random_uuid() as item_id, numbered.* from numbered
)
insert into public.atendimento_procedimentos (
  id, clinic_id, attendance_id, financial_entry_id, procedure_kind, performed_at, is_primary,
  created_by, created_at, updated_at, idempotency_key, payload_fingerprint
)
select
  item_id, clinic_id, attendance_id, id,
  pg_catalog.left(pg_catalog.btrim(description), 120),
  attended_at, needs_primary and item_position = 1,
  created_by, created_at, created_at, id,
  pg_catalog.md5(pg_catalog.jsonb_build_array(
    attendance_id, id, pg_catalog.left(pg_catalog.btrim(description), 120)
  )::text)
from prepared;

-- Duplicidades preexistentes nao sao apagadas nem mescladas. A primeira linha
-- permanece canonica e as demais ficam explicitamente pendentes de revisao.
with ranked as (
  select item.id,
         pg_catalog.row_number() over (
           partition by item.clinic_id, item.material_fingerprint
           order by item.created_at, item.id
         ) as duplicate_position
  from public.atendimento_procedimentos item
  where item.archived_at is null
)
update public.atendimento_procedimentos item
set duplicate_review_required = true
from ranked
where ranked.id = item.id and ranked.duplicate_position > 1;

create unique index atendimento_procedimentos_material_canonical_unique
  on public.atendimento_procedimentos (clinic_id, material_fingerprint)
  where archived_at is null
    and not duplicate_review_required;

create view public.operacao_procedimentos_duplicados_revisao
with (security_invoker = true)
as
select
  duplicate.clinic_id,
  duplicate.id as procedure_item_id,
  duplicate.attendance_id,
  duplicate.procedure_kind,
  duplicate.procedure_region,
  duplicate.performed_at,
  duplicate.financial_entry_id,
  duplicate.material_fingerprint,
  canonical.id as canonical_procedure_item_id,
  duplicate.created_at
from public.atendimento_procedimentos duplicate
join lateral (
  select candidate.id
  from public.atendimento_procedimentos candidate
  where candidate.clinic_id = duplicate.clinic_id
    and candidate.material_fingerprint = duplicate.material_fingerprint
    and candidate.id <> duplicate.id
  order by candidate.created_at, candidate.id
  limit 1
) canonical on true
where duplicate.duplicate_review_required and duplicate.archived_at is null;

-- ---------------------------------------------------------------------------
-- Fotos clinicas ligadas ao atendimento (item de procedimento opcional)
-- ---------------------------------------------------------------------------

alter table public.protocol_photos
  add constraint protocol_photos_attendance_id_fkey
    foreign key (attendance_id)
    references public.atendimentos_realizados(id)
    on delete restrict,
  add constraint protocol_photos_procedure_item_id_fkey
    foreign key (procedure_item_id)
    references public.atendimento_procedimentos(id)
    on delete restrict;

create index protocol_photos_attendance_idx
  on public.protocol_photos (attendance_id, phase, taken_at desc)
  where attendance_id is not null;
create index protocol_photos_procedure_item_idx
  on public.protocol_photos (procedure_item_id, taken_at desc)
  where procedure_item_id is not null;

create or replace function private.prontuario_sync_photo_operation_links()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_clinic_id uuid;
  v_derived_attendance_id uuid;
begin
  select protocol.clinic_id into v_clinic_id
  from public.protocols protocol
  where protocol.id = new.protocol_id;
  if not found then
    raise exception 'protocol_photo_parent_unavailable' using errcode = '42501';
  end if;

  select attendance.id into v_derived_attendance_id
  from public.atendimentos_realizados attendance
  where attendance.clinic_id = v_clinic_id
    and attendance.protocol_id = new.protocol_id
  order by (attendance.archived_at is null) desc,
           attendance.created_at desc,
           attendance.id desc
  limit 1;

  if new.attendance_id is null then
    new.attendance_id := v_derived_attendance_id;
  elsif new.attendance_id is distinct from v_derived_attendance_id then
    raise exception 'photo_attendance_context_invalid' using errcode = '23503';
  end if;

  if new.procedure_item_id is not null and not exists (
    select 1
    from public.atendimento_procedimentos item
    where item.clinic_id = v_clinic_id
      and item.id = new.procedure_item_id
      and item.attendance_id = new.attendance_id
      and item.archived_at is null
  ) then
    raise exception 'photo_procedure_item_context_invalid' using errcode = '23503';
  end if;

  return new;
end;
$function$;

revoke all on function private.prontuario_sync_photo_operation_links()
  from public, anon, authenticated, service_role;

create trigger protocol_photos_00_sync_operation_links
before insert or update of protocol_id, attendance_id, procedure_item_id
on public.protocol_photos
for each row execute function private.prontuario_sync_photo_operation_links();

create or replace function private.operacao_link_existing_protocol_photos()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if new.protocol_id is not null and new.archived_at is null then
    update public.protocol_photos
    set attendance_id = new.id
    where protocol_id = new.protocol_id
      and attendance_id is null;
  end if;
  return new;
end;
$function$;

revoke all on function private.operacao_link_existing_protocol_photos()
  from public, anon, authenticated, service_role;

create trigger atendimentos_realizados_link_protocol_photos
after insert or update of protocol_id on public.atendimentos_realizados
for each row execute function private.operacao_link_existing_protocol_photos();

with photo_attendance as (
  select distinct on (attendance.protocol_id)
    attendance.protocol_id,
    attendance.id as attendance_id
  from public.atendimentos_realizados attendance
  where attendance.protocol_id is not null
  order by attendance.protocol_id,
           (attendance.archived_at is null) desc,
           attendance.created_at desc,
           attendance.id desc
)
update public.protocol_photos photo
set attendance_id = link.attendance_id
from photo_attendance link
where photo.protocol_id = link.protocol_id
  and photo.attendance_id is null;

create or replace function public.prontuario_vincular_foto_operacao(
  p_clinic_id uuid,
  p_user_id uuid,
  p_actor_role text,
  p_auth_method text,
  p_photo_id uuid,
  p_attendance_id uuid,
  p_procedure_item_id uuid,
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
  v_protocol public.protocols%rowtype;
  v_previous_id uuid;
  v_previous_action text;
  v_previous_details jsonb;
  v_reason text := nullif(pg_catalog.btrim(p_reason), '');
  v_fingerprint text;
begin
  perform private.prontuario_assert_actor(
    p_clinic_id, p_user_id, p_actor_role, p_auth_method,
    array['owner']::text[]
  );
  if p_photo_id is null or p_attendance_id is null or p_request_id is null
     or v_reason is null
     or pg_catalog.char_length(v_reason) not between 3 and 500 then
    raise exception 'photo_operation_link_invalid' using errcode = '22023';
  end if;
  v_fingerprint := pg_catalog.md5(pg_catalog.jsonb_build_array(
    p_photo_id, p_attendance_id, p_procedure_item_id, v_reason
  )::text);
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      p_clinic_id::text || ':photo-operation-request:' || p_request_id::text, 0
    )
  );

  select entity_id, action, details
  into v_previous_id, v_previous_action, v_previous_details
  from public.clinic_audit_log
  where clinic_id = p_clinic_id and request_id = p_request_id;
  if found then
    if v_previous_id = p_photo_id and v_previous_action = 'photo.operation_link'
       and v_previous_details ->> 'route' = v_fingerprint then
      return pg_catalog.jsonb_build_object(
        'id', p_photo_id, 'attendance_id', p_attendance_id,
        'procedure_item_id', p_procedure_item_id, 'idempotent', true
      );
    end if;
    raise exception 'operation_id_reused' using errcode = '22023';
  end if;

  select photo.* into v_photo
  from public.protocol_photos photo
  join public.protocols protocol on protocol.id = photo.protocol_id
  where photo.id = p_photo_id and protocol.clinic_id = p_clinic_id
  for update of photo;
  if not found or v_photo.archived_at is not null then
    raise exception 'photo_not_found' using errcode = 'P0002';
  end if;

  select * into v_protocol
  from public.protocols
  where id = v_photo.protocol_id and clinic_id = p_clinic_id;
  if not found or v_protocol.archived_at is not null then
    raise exception 'protocol_archived' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.atendimentos_realizados attendance
    where attendance.clinic_id = p_clinic_id
      and attendance.id = p_attendance_id
      and attendance.protocol_id = v_photo.protocol_id
      and attendance.archived_at is null
  ) then
    raise exception 'photo_attendance_context_invalid' using errcode = '23503';
  end if;
  if p_procedure_item_id is not null and not exists (
    select 1 from public.atendimento_procedimentos item
    where item.clinic_id = p_clinic_id
      and item.id = p_procedure_item_id
      and item.attendance_id = p_attendance_id
      and item.archived_at is null
  ) then
    raise exception 'photo_procedure_item_context_invalid' using errcode = '23503';
  end if;

  update public.protocol_photos
  set attendance_id = p_attendance_id,
      procedure_item_id = p_procedure_item_id
  where id = p_photo_id;

  perform private.prontuario_log_event(
    p_clinic_id, p_user_id, p_actor_role, p_auth_method,
    'protocol_photo', p_photo_id, 'photo.operation_link',
    pg_catalog.jsonb_build_object(
      'endpoint', 'prontuario-fichas',
      'route', v_fingerprint,
      'reason_code', 'owner_request',
      'target_kind', case when p_procedure_item_id is null
        then 'attendance' else 'procedure_item' end,
      'idempotent', false
    ),
    p_request_id
  );

  return pg_catalog.jsonb_build_object(
    'id', p_photo_id, 'attendance_id', p_attendance_id,
    'procedure_item_id', p_procedure_item_id, 'idempotent', false
  );
end;
$function$;

revoke all on function public.prontuario_vincular_foto_operacao(
  uuid,uuid,text,text,uuid,uuid,uuid,text,uuid
) from public, anon, authenticated, service_role;
grant execute on function public.prontuario_vincular_foto_operacao(
  uuid,uuid,text,text,uuid,uuid,uuid,text,uuid
) to service_role;

-- ---------------------------------------------------------------------------
-- Perfil administrativo e preferencias por finalidade/canal, append-only
-- ---------------------------------------------------------------------------

create table public.patient_operational_profile_events (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete restrict,
  patient_id uuid not null,
  preferred_name text,
  accessibility_note text,
  privacy_notice_version text,
  version integer not null,
  reason text not null,
  recorded_by uuid not null references auth.users(id) on delete restrict,
  recorded_at timestamptz not null default pg_catalog.now(),
  idempotency_key uuid not null,
  payload_fingerprint text not null check (pg_catalog.char_length(payload_fingerprint) = 32),
  constraint patient_operational_profile_events_patient_fk foreign key (clinic_id, patient_id)
    references public.patients(clinic_id, id) on delete restrict,
  constraint patient_operational_profile_events_version_unique unique (clinic_id, patient_id, version),
  constraint patient_operational_profile_events_idempotency_unique unique (clinic_id, idempotency_key),
  constraint patient_operational_profile_events_name_check check (
    preferred_name is null or pg_catalog.char_length(pg_catalog.btrim(preferred_name)) between 2 and 80
  ),
  constraint patient_operational_profile_events_accessibility_check check (
    accessibility_note is null or pg_catalog.char_length(pg_catalog.btrim(accessibility_note)) between 3 and 500
  ),
  constraint patient_operational_profile_events_privacy_ref_check check (
    privacy_notice_version is null
    or pg_catalog.char_length(pg_catalog.btrim(privacy_notice_version)) between 1 and 80
  ),
  constraint patient_operational_profile_events_reason_check check (
    pg_catalog.char_length(pg_catalog.btrim(reason)) between 3 and 500
  ),
  constraint patient_operational_profile_events_version_check check (version > 0)
);

create table public.patient_contact_preference_events (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete restrict,
  patient_id uuid not null,
  purpose text not null,
  channel text not null,
  allowed boolean not null,
  evidence_kind text not null,
  evidence_reference text,
  privacy_notice_version text,
  version integer not null,
  effective_at timestamptz not null default pg_catalog.now(),
  recorded_by uuid not null references auth.users(id) on delete restrict,
  recorded_at timestamptz not null default pg_catalog.now(),
  idempotency_key uuid not null,
  payload_fingerprint text not null check (pg_catalog.char_length(payload_fingerprint) = 32),
  constraint patient_contact_preference_events_patient_fk foreign key (clinic_id, patient_id)
    references public.patients(clinic_id, id) on delete restrict,
  constraint patient_contact_preference_events_version_unique
    unique (clinic_id, patient_id, purpose, channel, version),
  constraint patient_contact_preference_events_idempotency_unique unique (clinic_id, idempotency_key),
  constraint patient_contact_preference_events_purpose_check check (
    purpose in ('retorno', 'agenda')
  ),
  constraint patient_contact_preference_events_channel_check check (
    channel in ('whatsapp', 'sms', 'email', 'telefone')
  ),
  constraint patient_contact_preference_events_evidence_kind_check check (
    evidence_kind in ('solicitacao_paciente', 'termo_assinado', 'revogacao_paciente', 'importacao_documentada')
  ),
  constraint patient_contact_preference_events_evidence_check check (
    evidence_reference is null
    or pg_catalog.char_length(pg_catalog.btrim(evidence_reference)) between 3 and 180
  ),
  constraint patient_contact_preference_events_privacy_ref_check check (
    privacy_notice_version is null
    or pg_catalog.char_length(pg_catalog.btrim(privacy_notice_version)) between 1 and 80
  ),
  constraint patient_contact_preference_events_version_check check (version > 0)
);

create index patient_operational_profile_events_patient_idx
  on public.patient_operational_profile_events (clinic_id, patient_id, version desc);
create index patient_contact_preference_events_patient_idx
  on public.patient_contact_preference_events (clinic_id, patient_id, purpose, channel, version desc);

create view public.patient_operational_profile_current
with (security_invoker = true)
as
select distinct on (clinic_id, patient_id)
  clinic_id, patient_id, preferred_name, accessibility_note,
  privacy_notice_version, version, recorded_at
from public.patient_operational_profile_events
order by clinic_id, patient_id, version desc, recorded_at desc, id desc;

create view public.patient_contact_preference_current
with (security_invoker = true)
as
select distinct on (clinic_id, patient_id, purpose, channel)
  clinic_id, patient_id, purpose, channel, allowed, evidence_kind,
  evidence_reference, privacy_notice_version, effective_at, version, recorded_at
from public.patient_contact_preference_events
where effective_at <= pg_catalog.now()
order by clinic_id, patient_id, purpose, channel, version desc, recorded_at desc, id desc;

-- ---------------------------------------------------------------------------
-- Recomendacao validada e fila operacional de retorno
-- ---------------------------------------------------------------------------

create table public.retorno_recomendacoes (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete restrict,
  attendance_id uuid not null,
  patient_id uuid not null,
  protocol_id uuid references public.protocols(id) on delete restrict,
  recommendation_kind text not null,
  exact_date date,
  window_start date,
  window_end date,
  instruction text,
  status text not null default 'ativa',
  validated_by uuid not null,
  validated_at timestamptz not null default pg_catalog.now(),
  cancelled_by uuid references auth.users(id) on delete restrict,
  cancelled_at timestamptz,
  cancellation_reason text,
  version integer not null default 1,
  idempotency_key uuid not null,
  payload_fingerprint text not null check (pg_catalog.char_length(payload_fingerprint) = 32),
  material_fingerprint text generated always as (
    pg_catalog.md5(
      attendance_id::text || '|' || pg_catalog.lower(pg_catalog.btrim(recommendation_kind)) || '|' ||
      coalesce(pg_catalog.encode(pg_catalog.date_send(exact_date), 'hex'), '') || '|' ||
      coalesce(pg_catalog.encode(pg_catalog.date_send(window_start), 'hex'), '') || '|' ||
      coalesce(pg_catalog.encode(pg_catalog.date_send(window_end), 'hex'), '')
    )
  ) stored,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint retorno_recomendacoes_clinic_id_id_key unique (clinic_id, id),
  constraint retorno_recomendacoes_attendance_fk foreign key (clinic_id, attendance_id)
    references public.atendimentos_realizados(clinic_id, id) on delete restrict,
  constraint retorno_recomendacoes_patient_fk foreign key (clinic_id, patient_id)
    references public.patients(clinic_id, id) on delete restrict,
  constraint retorno_recomendacoes_validator_fk foreign key (clinic_id, validated_by)
    references public.clinic_members(clinic_id, user_id) on delete restrict,
  constraint retorno_recomendacoes_idempotency_unique unique (clinic_id, idempotency_key),
  constraint retorno_recomendacoes_kind_check check (
    pg_catalog.char_length(pg_catalog.btrim(recommendation_kind)) between 2 and 120
  ),
  constraint retorno_recomendacoes_date_check check (
    (exact_date is not null and window_start is null and window_end is null)
    or (
      exact_date is null and window_start is not null and window_end is not null
      and window_end >= window_start and window_end <= window_start + 180
    )
  ),
  constraint retorno_recomendacoes_instruction_check check (
    instruction is null or pg_catalog.char_length(pg_catalog.btrim(instruction)) between 3 and 500
  ),
  constraint retorno_recomendacoes_status_check check (status in ('ativa', 'cancelada', 'convertida')),
  constraint retorno_recomendacoes_cancel_check check (
    (status <> 'cancelada' and cancelled_by is null and cancelled_at is null and cancellation_reason is null)
    or (
      status = 'cancelada' and cancelled_by is not null and cancelled_at is not null
      and pg_catalog.char_length(pg_catalog.btrim(cancellation_reason)) between 3 and 500
    )
  ),
  constraint retorno_recomendacoes_version_check check (version > 0)
);

create unique index retorno_recomendacoes_material_active_unique
  on public.retorno_recomendacoes (clinic_id, material_fingerprint)
  where status in ('ativa', 'convertida');

create table public.retorno_fila (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete restrict,
  recommendation_id uuid not null,
  patient_id uuid not null,
  responsible_user_id uuid not null,
  status text not null default 'pendente',
  next_action text not null default 'contatar',
  next_action_at timestamptz,
  linked_appointment_id uuid references public.agendamentos_clinica(id) on delete restrict,
  attempt_count integer not null default 0,
  last_attempt_at timestamptz,
  closure_reason text,
  version integer not null default 1,
  created_by uuid not null references auth.users(id) on delete restrict,
  updated_by uuid references auth.users(id) on delete restrict,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint retorno_fila_clinic_id_id_key unique (clinic_id, id),
  constraint retorno_fila_recommendation_unique unique (clinic_id, recommendation_id),
  constraint retorno_fila_recommendation_fk foreign key (clinic_id, recommendation_id)
    references public.retorno_recomendacoes(clinic_id, id) on delete restrict,
  constraint retorno_fila_patient_fk foreign key (clinic_id, patient_id)
    references public.patients(clinic_id, id) on delete restrict,
  constraint retorno_fila_responsible_fk foreign key (clinic_id, responsible_user_id)
    references public.clinic_members(clinic_id, user_id) on delete restrict,
  constraint retorno_fila_status_check check (
    status in ('pendente', 'em_contato', 'aguardando_paciente', 'agendado', 'concluido', 'cancelado', 'bloqueado')
  ),
  constraint retorno_fila_next_action_check check (
    next_action in ('contatar', 'aguardar_resposta', 'recontatar', 'confirmar_agenda', 'nenhuma')
  ),
  constraint retorno_fila_next_action_date_check check (
    (next_action = 'nenhuma' and next_action_at is null)
    or (next_action <> 'nenhuma' and next_action_at is not null)
  ),
  constraint retorno_fila_attempt_count_check check (attempt_count >= 0),
  constraint retorno_fila_closure_check check (
    (status not in ('concluido', 'cancelado', 'bloqueado') and closure_reason is null)
    or (
      status in ('concluido', 'cancelado', 'bloqueado')
      and pg_catalog.char_length(pg_catalog.btrim(closure_reason)) between 3 and 500
    )
  ),
  constraint retorno_fila_agenda_check check (
    (status = 'agendado' and linked_appointment_id is not null)
    or status <> 'agendado'
  ),
  constraint retorno_fila_version_check check (version > 0)
);

create table public.retorno_tentativas (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete restrict,
  queue_id uuid not null,
  patient_id uuid not null,
  channel text not null,
  purpose text not null default 'retorno',
  preference_event_id uuid not null references public.patient_contact_preference_events(id) on delete restrict,
  result text not null,
  template_reference text,
  next_action text not null,
  next_action_at timestamptz,
  attempted_by uuid not null,
  attempted_at timestamptz not null default pg_catalog.now(),
  idempotency_key uuid not null,
  payload_fingerprint text not null check (pg_catalog.char_length(payload_fingerprint) = 32),
  constraint retorno_tentativas_queue_fk foreign key (clinic_id, queue_id)
    references public.retorno_fila(clinic_id, id) on delete restrict,
  constraint retorno_tentativas_patient_fk foreign key (clinic_id, patient_id)
    references public.patients(clinic_id, id) on delete restrict,
  constraint retorno_tentativas_actor_fk foreign key (clinic_id, attempted_by)
    references public.clinic_members(clinic_id, user_id) on delete restrict,
  constraint retorno_tentativas_idempotency_unique unique (clinic_id, idempotency_key),
  constraint retorno_tentativas_channel_check check (channel in ('whatsapp', 'sms', 'email', 'telefone')),
  constraint retorno_tentativas_purpose_check check (purpose in ('retorno', 'agenda')),
  constraint retorno_tentativas_result_check check (
    result in ('sem_resposta', 'respondeu', 'agendou', 'recusou', 'numero_invalido', 'canal_indisponivel')
  ),
  constraint retorno_tentativas_template_check check (
    template_reference is null
    or pg_catalog.char_length(pg_catalog.btrim(template_reference)) between 2 and 120
  ),
  constraint retorno_tentativas_next_action_check check (
    next_action in ('contatar', 'aguardar_resposta', 'recontatar', 'confirmar_agenda', 'nenhuma')
  ),
  constraint retorno_tentativas_next_action_date_check check (
    (next_action = 'nenhuma' and next_action_at is null)
    or (next_action <> 'nenhuma' and next_action_at is not null)
  )
);

create index retorno_recomendacoes_due_idx
  on public.retorno_recomendacoes (clinic_id, exact_date, window_start, status);
create index retorno_fila_next_action_idx
  on public.retorno_fila (clinic_id, status, next_action_at)
  where status not in ('concluido', 'cancelado');
create index retorno_tentativas_queue_idx
  on public.retorno_tentativas (clinic_id, queue_id, attempted_at desc);

-- ---------------------------------------------------------------------------
-- Ficha de custo prevista (versoes imutaveis; quantidades sempre informadas)
-- ---------------------------------------------------------------------------

create table public.operacao_fichas_custo (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete restrict,
  procedure_kind text not null,
  version integer not null,
  status text not null,
  valid_from date not null,
  reason text not null,
  validated_by uuid,
  validated_at timestamptz,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default pg_catalog.now(),
  idempotency_key uuid not null,
  payload_fingerprint text not null check (pg_catalog.char_length(payload_fingerprint) = 32),
  constraint operacao_fichas_custo_clinic_id_id_key unique (clinic_id, id),
  constraint operacao_fichas_custo_version_unique unique (clinic_id, procedure_kind, version),
  constraint operacao_fichas_custo_idempotency_unique unique (clinic_id, idempotency_key),
  constraint operacao_fichas_custo_procedure_check check (
    pg_catalog.char_length(pg_catalog.btrim(procedure_kind)) between 2 and 120
  ),
  constraint operacao_fichas_custo_version_check check (version > 0),
  constraint operacao_fichas_custo_status_check check (status in ('rascunho', 'validada', 'retirada')),
  constraint operacao_fichas_custo_reason_check check (
    pg_catalog.char_length(pg_catalog.btrim(reason)) between 3 and 500
  ),
  constraint operacao_fichas_custo_validation_check check (
    (status = 'rascunho' and validated_by is null and validated_at is null)
    or (status in ('validada', 'retirada') and validated_by is not null and validated_at is not null)
  )
);

create table public.operacao_ficha_custo_itens (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete restrict,
  cost_sheet_id uuid not null,
  product_id uuid not null,
  amount numeric(14,4) not null,
  unit text not null,
  position smallint not null,
  created_at timestamptz not null default pg_catalog.now(),
  constraint operacao_ficha_custo_itens_sheet_fk foreign key (clinic_id, cost_sheet_id)
    references public.operacao_fichas_custo(clinic_id, id) on delete restrict,
  constraint operacao_ficha_custo_itens_product_fk foreign key (clinic_id, product_id)
    references public.financeiro_produtos(clinic_id, id) on delete restrict,
  constraint operacao_ficha_custo_itens_position_unique unique (clinic_id, cost_sheet_id, position),
  constraint operacao_ficha_custo_itens_product_unique unique (clinic_id, cost_sheet_id, product_id),
  constraint operacao_ficha_custo_itens_amount_check check (amount > 0 and amount <= 1000000),
  constraint operacao_ficha_custo_itens_unit_check check (
    unit in ('un', 'u', 'cx', 'frasco', 'seringa', 'ampola', 'aplicacao', 'canula', 'dose', 'ml', 'mg', 'g', 'kit')
  ),
  constraint operacao_ficha_custo_itens_position_check check (position between 1 and 100)
);

create index operacao_fichas_custo_current_idx
  on public.operacao_fichas_custo (clinic_id, procedure_kind, version desc);

create view public.operacao_ficha_custo_atual
with (security_invoker = true)
as
select clinic_id, id, procedure_kind, version, valid_from, validated_at
from (
  select distinct on (clinic_id, procedure_kind)
    clinic_id, id, procedure_kind, version, status, valid_from, validated_at
  from public.operacao_fichas_custo
  where status in ('validada', 'retirada')
    and valid_from <= (pg_catalog.now() at time zone 'America/Sao_Paulo')::date
  order by clinic_id, procedure_kind, valid_from desc, version desc, validated_at desc, id desc
) effective
where status = 'validada';

-- ---------------------------------------------------------------------------
-- Ajustes de consumo e taxas: historicos append-only
-- ---------------------------------------------------------------------------

alter table public.financeiro_estoque_movimentos
  drop constraint if exists financeiro_estoque_movimentos_movement_kind_check,
  drop constraint if exists financeiro_estoque_movimentos_sign_check,
  drop constraint if exists financeiro_estoque_movimentos_source_check;

alter table public.financeiro_estoque_movimentos
  add constraint financeiro_estoque_movimentos_movement_kind_check check (
    movement_kind in (
      'entrada_compra', 'estorno_compra', 'saida_procedimento', 'estorno_procedimento',
      'perda_tecnica', 'desperdicio', 'devolucao_atendimento'
    )
  ),
  add constraint financeiro_estoque_movimentos_sign_check check (
    (movement_kind in ('entrada_compra', 'estorno_procedimento', 'devolucao_atendimento') and quantity_delta > 0)
    or (movement_kind in ('saida_procedimento', 'estorno_compra', 'perda_tecnica', 'desperdicio') and quantity_delta < 0)
  ),
  add constraint financeiro_estoque_movimentos_source_check check (
    (
      movement_kind in ('entrada_compra', 'estorno_compra')
      and purchase_item_id is not null and protocol_id is null
    ) or (
      movement_kind in (
        'saida_procedimento', 'estorno_procedimento',
        'perda_tecnica', 'desperdicio', 'devolucao_atendimento'
      )
      and protocol_id is not null and purchase_item_id is null
    )
  );

create table public.operacao_consumo_eventos (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete restrict,
  attendance_id uuid not null,
  protocol_id uuid not null references public.protocols(id) on delete restrict,
  product_id uuid not null,
  lot_id uuid not null,
  event_kind text not null,
  amount numeric(14,4) not null,
  unit text not null,
  unit_cost_snapshot numeric(14,6) not null,
  stock_movement_id uuid not null,
  reason text not null,
  evidence_reference text,
  occurred_at timestamptz not null,
  recorded_by uuid not null references auth.users(id) on delete restrict,
  recorded_at timestamptz not null default pg_catalog.now(),
  idempotency_key uuid not null,
  payload_fingerprint text not null check (pg_catalog.char_length(payload_fingerprint) = 32),
  constraint operacao_consumo_eventos_clinic_id_id_key unique (clinic_id, id),
  constraint operacao_consumo_eventos_attendance_fk foreign key (clinic_id, attendance_id)
    references public.atendimentos_realizados(clinic_id, id) on delete restrict,
  constraint operacao_consumo_eventos_product_fk foreign key (clinic_id, product_id)
    references public.financeiro_produtos(clinic_id, id) on delete restrict,
  constraint operacao_consumo_eventos_lot_fk foreign key (clinic_id, lot_id)
    references public.financeiro_estoque_lotes(clinic_id, id) on delete restrict,
  constraint operacao_consumo_eventos_movement_fk foreign key (clinic_id, stock_movement_id)
    references public.financeiro_estoque_movimentos(clinic_id, id) on delete restrict,
  constraint operacao_consumo_eventos_movement_unique unique (clinic_id, stock_movement_id),
  constraint operacao_consumo_eventos_idempotency_unique unique (clinic_id, idempotency_key),
  constraint operacao_consumo_eventos_kind_check check (
    event_kind in ('perda_tecnica', 'desperdicio', 'devolucao_atendimento')
  ),
  constraint operacao_consumo_eventos_amount_check check (amount > 0 and amount <= 1000000),
  constraint operacao_consumo_eventos_unit_check check (
    unit in ('un', 'u', 'cx', 'frasco', 'seringa', 'ampola', 'aplicacao', 'canula', 'dose', 'ml', 'mg', 'g', 'kit')
  ),
  constraint operacao_consumo_eventos_cost_check check (unit_cost_snapshot >= 0),
  constraint operacao_consumo_eventos_reason_check check (
    pg_catalog.char_length(pg_catalog.btrim(reason)) between 3 and 500
  ),
  constraint operacao_consumo_eventos_evidence_check check (
    evidence_reference is null
    or pg_catalog.char_length(pg_catalog.btrim(evidence_reference)) between 3 and 180
  )
);

create table public.atendimento_pagamento_taxas (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete restrict,
  attendance_id uuid not null,
  payment_id uuid not null,
  event_kind text not null,
  amount numeric(14,2) not null,
  source_kind text not null,
  source_reference text,
  reversal_of_id uuid,
  recorded_by uuid not null references auth.users(id) on delete restrict,
  recorded_at timestamptz not null default pg_catalog.now(),
  idempotency_key uuid not null,
  payload_fingerprint text not null check (pg_catalog.char_length(payload_fingerprint) = 32),
  constraint atendimento_pagamento_taxas_attendance_fk foreign key (clinic_id, attendance_id)
    references public.atendimentos_realizados(clinic_id, id) on delete restrict,
  constraint atendimento_pagamento_taxas_payment_fk foreign key (clinic_id, payment_id)
    references public.financeiro_pagamentos(clinic_id, id) on delete restrict,
  constraint atendimento_pagamento_taxas_reversal_fk foreign key (clinic_id, reversal_of_id)
    references public.atendimento_pagamento_taxas(clinic_id, id) on delete restrict,
  constraint atendimento_pagamento_taxas_clinic_id_id_key unique (clinic_id, id),
  constraint atendimento_pagamento_taxas_idempotency_unique unique (clinic_id, idempotency_key),
  constraint atendimento_pagamento_taxas_event_check check (event_kind in ('declaracao', 'estorno')),
  constraint atendimento_pagamento_taxas_amount_check check (amount >= 0),
  constraint atendimento_pagamento_taxas_source_check check (source_kind in ('informada', 'comprovante', 'operadora')),
  constraint atendimento_pagamento_taxas_source_reference_check check (
    source_reference is null or pg_catalog.char_length(pg_catalog.btrim(source_reference)) between 3 and 180
  ),
  constraint atendimento_pagamento_taxas_reversal_check check (
    (event_kind = 'declaracao' and reversal_of_id is null)
    or (event_kind = 'estorno' and reversal_of_id is not null)
  )
);

-- protocol_photos continua sendo a unica fonte das fotos clinicas. Estes
-- campos acrescentam somente a organizacao operacional da mesma linha, sem
-- copiar caminho, hash, paciente ou binario para outra tabela.
alter table public.protocol_photos
  add column if not exists operation_caption text,
  add column if not exists operation_display_order integer,
  add column if not exists consumption_event_id uuid,
  add column if not exists operation_version integer not null default 1,
  add column if not exists operation_updated_by uuid references auth.users(id) on delete restrict,
  add column if not exists operation_updated_at timestamptz;

alter table public.protocol_photos
  add constraint protocol_photos_consumption_event_fk
    foreign key (consumption_event_id)
    references public.operacao_consumo_eventos(id) on delete restrict,
  add constraint protocol_photos_operation_caption_check check (
    operation_caption is null or (
      pg_catalog.char_length(pg_catalog.btrim(operation_caption)) between 2 and 300
      and operation_caption !~ '[[:cntrl:]]'
    )
  ),
  add constraint protocol_photos_operation_order_check check (
    operation_display_order is null
    or operation_display_order between 1 and 2147483647
  ),
  add constraint protocol_photos_operation_version_check check (operation_version > 0),
  add constraint protocol_photos_consumption_context_check check (
    consumption_event_id is null or phase = 'products_used'
  );

with ordered as (
  select photo.id,
         pg_catalog.row_number() over (
           partition by photo.protocol_id, photo.phase
           order by photo.taken_at, photo.id
         )::integer as display_order
  from public.protocol_photos photo
)
update public.protocol_photos photo
set operation_display_order = ordered.display_order
from ordered
where ordered.id = photo.id and photo.operation_display_order is null;

create index protocol_photos_operation_gallery_idx
  on public.protocol_photos (
    attendance_id, phase, operation_display_order, taken_at, id
  ) where attendance_id is not null;

create view public.operacao_atendimento_fotos
with (security_invoker = true)
as
select
  photo.id,
  protocol.clinic_id,
  protocol.patient_id,
  photo.attendance_id,
  photo.procedure_item_id,
  photo.id as photo_id,
  case photo.phase
    when 'before' then 'antes'
    when 'after' then 'depois'
    when 'products_used' then 'produtos_utilizados'
    else 'durante_legado'
  end as category,
  photo.taken_at as captured_at,
  photo.operation_display_order as display_order,
  photo.operation_caption as caption,
  photo.storage_path,
  photo.mime_type,
  photo.size_bytes,
  photo.sha256,
  photo.thumbnail_storage_path,
  photo.thumbnail_mime_type,
  photo.thumbnail_size_bytes,
  photo.thumbnail_sha256,
  uploader.actor as uploader_id,
  photo.archived_at,
  photo.operation_version as version,
  photo.product_id,
  photo.lot_snapshot,
  photo.consumption_event_id,
  photo.protocol_id
from public.protocol_photos photo
join public.protocols protocol on protocol.id = photo.protocol_id
left join lateral (
  select audit.actor
  from public.clinic_audit_log audit
  where audit.clinic_id = protocol.clinic_id
    and audit.entity = 'protocol_photo'
    and audit.entity_id = photo.id
    and audit.action = 'photo.add'
  order by audit.created_at, audit.id
  limit 1
) uploader on true
where photo.attendance_id is not null;

-- Em prontuario assinado, o original e os metadados clinicos permanecem
-- imutaveis. Apenas a organizacao administrativa abaixo pode ser corrigida,
-- e somente pelo RPC protegido que ativa a marcacao transacional privada.
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
  v_operation_changed boolean;
begin
  if tg_op = 'UPDATE' and new.protocol_id <> old.protocol_id then
    raise exception 'protocol_photo_parent_is_immutable' using errcode = '42501';
  end if;

  select status, archived_at into v_status, v_archived_at
  from public.protocols where id = v_protocol_id;
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

  v_operation_changed :=
    new.operation_caption is distinct from old.operation_caption
    or new.operation_display_order is distinct from old.operation_display_order
    or new.consumption_event_id is distinct from old.consumption_event_id
    or new.operation_version is distinct from old.operation_version
    or new.operation_updated_by is distinct from old.operation_updated_by
    or new.operation_updated_at is distinct from old.operation_updated_at;

  if v_operation_changed
     and pg_catalog.current_setting('amj.photo_operation_update', true) is distinct from 'on' then
    raise exception 'protocol_photo_operation_update_forbidden' using errcode = '42501';
  end if;

  if v_status = 'signed' and (
    pg_catalog.to_jsonb(new) - array[
      'archived_at', 'attendance_id', 'procedure_item_id',
      'operation_caption', 'operation_display_order', 'consumption_event_id',
      'operation_version', 'operation_updated_by', 'operation_updated_at'
    ]
  ) is distinct from (
    pg_catalog.to_jsonb(old) - array[
      'archived_at', 'attendance_id', 'procedure_item_id',
      'operation_caption', 'operation_display_order', 'consumption_event_id',
      'operation_version', 'operation_updated_by', 'operation_updated_at'
    ]
  ) then
    raise exception 'signed_protocol_photo_is_immutable' using errcode = '42501';
  end if;
  return new;
end;
$function$;

revoke all on function private.prontuario_guard_photo_mutation()
  from public, anon, authenticated, service_role;

create unique index atendimento_pagamento_taxas_declaration_unique
  on public.atendimento_pagamento_taxas (clinic_id, attendance_id, payment_id)
  where event_kind = 'declaracao';
create unique index atendimento_pagamento_taxas_reversal_unique
  on public.atendimento_pagamento_taxas (clinic_id, reversal_of_id)
  where reversal_of_id is not null;
create index operacao_consumo_eventos_attendance_idx
  on public.operacao_consumo_eventos (clinic_id, attendance_id, occurred_at desc);

-- Declaracoes de taxa sao eventos: uma correcao estorna a anterior e cria outra.
drop index if exists public.atendimento_pagamento_taxas_declaration_unique;

-- ---------------------------------------------------------------------------
-- Guardrails e helpers privados dos RPCs Edge-only
-- ---------------------------------------------------------------------------

create or replace function private.operacao_append_only()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  raise exception 'append_only_record' using errcode = '42501';
end;
$function$;

create trigger patient_operational_profile_events_append_only
before update or delete on public.patient_operational_profile_events
for each row execute function private.operacao_append_only();
create trigger patient_contact_preference_events_append_only
before update or delete on public.patient_contact_preference_events
for each row execute function private.operacao_append_only();
create trigger retorno_tentativas_append_only
before update or delete on public.retorno_tentativas
for each row execute function private.operacao_append_only();
create trigger operacao_fichas_custo_append_only
before update or delete on public.operacao_fichas_custo
for each row execute function private.operacao_append_only();
create trigger operacao_ficha_custo_itens_append_only
before update or delete on public.operacao_ficha_custo_itens
for each row execute function private.operacao_append_only();
create trigger operacao_consumo_eventos_append_only
before update or delete on public.operacao_consumo_eventos
for each row execute function private.operacao_append_only();
create trigger atendimento_pagamento_taxas_append_only
before update or delete on public.atendimento_pagamento_taxas
for each row execute function private.operacao_append_only();

-- A migration 30000 substitui os itens do prontuario estornando as saidas
-- normais. Depois de uma perda, desperdicio ou devolucao, essa substituicao
-- deixaria o ajuste sem a mesma base historica; por isso os itens ficam
-- congelados e a correcao deve ocorrer em um novo prontuario auditado.
create or replace function private.operacao_guard_protocol_products_with_adjustments()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  v_protocol_id uuid;
begin
  v_protocol_id := case when tg_op = 'DELETE' then old.protocol_id else new.protocol_id end;
  if exists (
    select 1 from public.operacao_consumo_eventos
    where protocol_id = v_protocol_id
  ) then
    raise exception 'protocol_products_locked_by_adjustment' using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$function$;

create trigger protocol_products_guard_operational_adjustments
before update or delete on public.protocol_products
for each row execute function private.operacao_guard_protocol_products_with_adjustments();

create or replace function private.operacao_assert_owner(
  p_clinic_id uuid,
  p_user_id uuid,
  p_actor_role text,
  p_auth_method text,
  p_aal text
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.prontuario_assert_actor(
    p_clinic_id, p_user_id, p_actor_role, p_auth_method, array['owner']::text[]
  );
  if p_aal <> 'aal2' then
    raise exception 'aal2_required' using errcode = '42501';
  end if;
end;
$function$;

create or replace function private.operacao_log(
  p_clinic_id uuid,
  p_user_id uuid,
  p_actor_role text,
  p_auth_method text,
  p_entity text,
  p_entity_id uuid,
  p_action text,
  p_request_id uuid,
  p_result_count integer default 1,
  p_payload_fingerprint text default null
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
  if p_payload_fingerprint is not null and (
    pg_catalog.char_length(p_payload_fingerprint) <> 32
    or p_payload_fingerprint !~ '^[0-9a-f]{32}$'
  ) then
    raise exception 'payload_fingerprint_invalid' using errcode = '22023';
  end if;
  perform private.prontuario_log_event(
    p_clinic_id, p_user_id, p_actor_role, p_auth_method,
    p_entity, p_entity_id, p_action,
    pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'endpoint', 'operacao-clinica-fichas',
      'result_count', greatest(p_result_count, 0),
      'route', p_payload_fingerprint
    )),
    p_request_id
  );
end;
$function$;

-- Atualizacoes protegidas usam o mesmo operation_id como chave transacional.
-- Uma repeticao so e aceita quando entidade, acao e payload material coincidem.
create or replace function private.operacao_replay_guard(
  p_clinic_id uuid,
  p_request_id uuid,
  p_entity text,
  p_entity_id uuid,
  p_action text,
  p_payload_fingerprint text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_previous record;
begin
  if p_request_id is null or p_entity_id is null
     or pg_catalog.char_length(coalesce(p_payload_fingerprint, '')) <> 32
     or p_payload_fingerprint !~ '^[0-9a-f]{32}$' then
    raise exception 'request_id_required' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      p_clinic_id::text || ':operacao-request:' || p_request_id::text, 0
    )
  );
  select audit.entity, audit.entity_id, audit.action, audit.details
  into v_previous
  from public.clinic_audit_log audit
  where audit.clinic_id = p_clinic_id and audit.request_id = p_request_id;
  if not found then return false; end if;
  if v_previous.entity = p_entity
     and v_previous.entity_id = p_entity_id
     and v_previous.action = p_action
     and v_previous.details ->> 'route' = p_payload_fingerprint then
    return true;
  end if;
  raise exception 'operation_id_reused' using errcode = '22023';
end;
$function$;

revoke all on function private.operacao_append_only()
  from public, anon, authenticated, service_role;
revoke all on function private.operacao_guard_protocol_products_with_adjustments()
  from public, anon, authenticated, service_role;
revoke all on function private.operacao_assert_owner(uuid,uuid,text,text,text)
  from public, anon, authenticated, service_role;
revoke all on function private.operacao_log(uuid,uuid,text,text,text,uuid,text,uuid,integer,text)
  from public, anon, authenticated, service_role;
revoke all on function private.operacao_replay_guard(uuid,uuid,text,uuid,text,text)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Margem de contribuicao gerencial: somente fontes vinculadas e reais
-- ---------------------------------------------------------------------------

create view public.operacao_rentabilidade_atendimentos
with (security_invoker = true)
as
with procedure_rollup as (
  select
    item.clinic_id,
    item.attendance_id,
    pg_catalog.string_agg(
      item.procedure_kind, ' + '
      order by item.is_primary desc, item.created_at, item.id
    ) as procedure_kind,
    pg_catalog.count(*)::integer as procedure_count
  from public.atendimento_procedimentos item
  where item.archived_at is null
  group by item.clinic_id, item.attendance_id
), attendance_entry_ids as (
  select item.clinic_id, item.attendance_id, item.financial_entry_id as entry_id
  from public.atendimento_procedimentos item
  where item.archived_at is null and item.financial_entry_id is not null
  union
  select attendance.clinic_id, attendance.id, attendance.financial_entry_id
  from public.atendimentos_realizados attendance
  where attendance.financial_entry_id is not null
), entry_rollup as (
  select
    link.clinic_id,
    link.attendance_id,
    pg_catalog.count(entry.id)::integer as entry_count,
    pg_catalog.count(entry.id) filter (
      where entry.entry_type = 'receita' and entry.origin = 'atendimento' and entry.state = 'ativo'
    )::integer as valid_entry_count,
    pg_catalog.sum(entry.total_amount) filter (
      where entry.entry_type = 'receita' and entry.origin = 'atendimento' and entry.state = 'ativo'
    )::numeric(14,2) as linked_revenue
  from attendance_entry_ids link
  left join public.financeiro_lancamentos entry
    on entry.clinic_id = link.clinic_id and entry.id = link.entry_id
  group by link.clinic_id, link.attendance_id
), payment_base as (
  select
    payment.clinic_id,
    payment.entry_id,
    payment.id as payment_id,
    (payment.amount - coalesce(pg_catalog.sum(refund.amount), 0))::numeric(14,2) as net_amount
  from public.financeiro_pagamentos payment
  left join public.financeiro_pagamentos refund
    on refund.clinic_id = payment.clinic_id
   and refund.reversed_payment_id = payment.id
   and refund.movement_type = 'estorno'
  where payment.movement_type = 'pagamento'
  group by payment.clinic_id, payment.entry_id, payment.id, payment.amount
), fee_current as (
  select
    declaration.clinic_id,
    declaration.attendance_id,
    declaration.payment_id,
    coalesce(pg_catalog.sum(declaration.amount), 0)::numeric(14,2) as declared_amount,
    coalesce(pg_catalog.sum(reversal.amount), 0)::numeric(14,2) as reversed_amount,
    pg_catalog.count(*) filter (where reversal.id is null)::integer as active_declarations
  from public.atendimento_pagamento_taxas declaration
  left join public.atendimento_pagamento_taxas reversal
    on reversal.clinic_id = declaration.clinic_id
   and reversal.reversal_of_id = declaration.id
   and reversal.event_kind = 'estorno'
  where declaration.event_kind = 'declaracao'
  group by declaration.clinic_id, declaration.attendance_id, declaration.payment_id
), payment_rollup as (
  select
    attendance.clinic_id,
    attendance.id as attendance_id,
    coalesce(pg_catalog.sum(payment.net_amount), 0)::numeric(14,2) as received_amount,
    coalesce(
      pg_catalog.sum(fee.declared_amount - fee.reversed_amount), 0
    )::numeric(14,2) as fee_amount,
    pg_catalog.count(*) filter (where payment.net_amount > 0)::integer as active_payment_count,
    pg_catalog.count(*) filter (
      where payment.net_amount > 0 and fee.active_declarations > 0
    )::integer as payment_with_fee_count
  from public.atendimentos_realizados attendance
  left join attendance_entry_ids attendance_entry
    on attendance_entry.clinic_id = attendance.clinic_id
   and attendance_entry.attendance_id = attendance.id
  left join payment_base payment
    on payment.clinic_id = attendance.clinic_id
   and payment.entry_id = attendance_entry.entry_id
  left join fee_current fee
    on fee.clinic_id = attendance.clinic_id
   and fee.attendance_id = attendance.id
   and fee.payment_id = payment.payment_id
  group by attendance.clinic_id, attendance.id
), stock_rollup as (
  select
    attendance.clinic_id,
    attendance.id as attendance_id,
    (-coalesce(pg_catalog.sum(
      movement.quantity_delta * movement.unit_cost_effective
    ), 0))::numeric(18,6) as material_cost,
    pg_catalog.count(movement.id)::integer as movement_count
  from public.atendimentos_realizados attendance
  left join public.financeiro_estoque_movimentos movement
    on movement.clinic_id = attendance.clinic_id
   and movement.protocol_id = attendance.protocol_id
   and movement.movement_kind in (
     'saida_procedimento', 'estorno_procedimento',
     'perda_tecnica', 'desperdicio', 'devolucao_atendimento'
   )
  group by attendance.clinic_id, attendance.id
), protocol_rollup as (
  select protocol.id as protocol_id, pg_catalog.count(product.id)::integer as product_count
  from public.protocols protocol
  left join public.protocol_products product on product.protocol_id = protocol.id
  group by protocol.id
), base as (
  select
    attendance.clinic_id,
    attendance.id as attendance_id,
    coalesce(procedure.procedure_kind, attendance.procedure_kind) as procedure_kind,
    (attendance.attended_at at time zone 'America/Sao_Paulo')::date as attendance_date,
    pg_catalog.date_trunc('month', attendance.attended_at at time zone 'America/Sao_Paulo')::date as competence_month,
    attendance.protocol_id,
    attendance.financial_entry_id,
    case when entry.entry_count > 0 and entry.entry_count = entry.valid_entry_count
      then entry.linked_revenue else null end::numeric(14,2) as linked_revenue,
    payment.received_amount,
    payment.fee_amount,
    stock.material_cost,
    stock.movement_count,
    coalesce(protocol.product_count, 0) as product_count,
    payment.active_payment_count,
    payment.payment_with_fee_count,
    attendance.archived_at,
    array_remove(array[
      case when coalesce(procedure.procedure_count, 0) = 0 then 'sem_procedimento' end,
      case when attendance.protocol_id is null then 'sem_protocolo' end,
      case when attendance.protocol_id is not null and coalesce(protocol.product_count, 0) = 0
        then 'protocolo_sem_produtos' end,
      case when attendance.protocol_id is not null and coalesce(protocol.product_count, 0) > 0
             and stock.movement_count = 0 then 'consumo_real_ausente' end,
      case when coalesce(entry.entry_count, 0) = 0 then 'sem_vinculo_financeiro' end,
      case when coalesce(entry.entry_count, 0) <> coalesce(entry.valid_entry_count, 0)
        then 'vinculo_financeiro_invalido' end,
      case when payment.active_payment_count > payment.payment_with_fee_count
        then 'taxa_de_pagamento_nao_declarada' end
    ], null)::text[] as incomplete_reasons
  from public.atendimentos_realizados attendance
  left join procedure_rollup procedure
    on procedure.clinic_id = attendance.clinic_id and procedure.attendance_id = attendance.id
  left join entry_rollup entry
    on entry.clinic_id = attendance.clinic_id and entry.attendance_id = attendance.id
  left join payment_rollup payment
    on payment.clinic_id = attendance.clinic_id and payment.attendance_id = attendance.id
  left join stock_rollup stock
    on stock.clinic_id = attendance.clinic_id and stock.attendance_id = attendance.id
  left join protocol_rollup protocol on protocol.protocol_id = attendance.protocol_id
)
select
  clinic_id, attendance_id, procedure_kind, attendance_date, competence_month,
  protocol_id, financial_entry_id, linked_revenue, received_amount,
  material_cost, fee_amount,
  case when pg_catalog.cardinality(incomplete_reasons) = 0
    then (linked_revenue - material_cost - fee_amount)::numeric(18,6)
    else null end as managerial_contribution_margin,
  (pg_catalog.cardinality(incomplete_reasons) > 0) as is_incomplete,
  incomplete_reasons
from base
where archived_at is null;

create view public.operacao_rentabilidade_mensal
with (security_invoker = true)
as
select
  clinic_id,
  competence_month,
  procedure_kind,
  pg_catalog.count(*)::integer as attendance_count,
  pg_catalog.count(*) filter (where not is_incomplete)::integer as complete_count,
  pg_catalog.count(*) filter (where is_incomplete)::integer as incomplete_count,
  pg_catalog.sum(linked_revenue) filter (where not is_incomplete)::numeric(18,2) as linked_revenue,
  pg_catalog.sum(received_amount) filter (where not is_incomplete)::numeric(18,2) as received_amount,
  pg_catalog.sum(material_cost) filter (where not is_incomplete)::numeric(18,6) as material_cost,
  pg_catalog.sum(fee_amount) filter (where not is_incomplete)::numeric(18,2) as payment_fees,
  pg_catalog.sum(managerial_contribution_margin) filter (where not is_incomplete)::numeric(18,6)
    as managerial_contribution_margin
from public.operacao_rentabilidade_atendimentos
group by clinic_id, competence_month, procedure_kind;

create view public.operacao_retorno_resumo_diario
with (security_invoker = true)
as
select
  queue.clinic_id,
  (queue.next_action_at at time zone 'America/Sao_Paulo')::date as action_date,
  queue.status,
  queue.next_action,
  pg_catalog.count(*)::integer as queue_count,
  pg_catalog.sum(queue.attempt_count)::integer as attempt_count
from public.retorno_fila queue
group by queue.clinic_id,
  (queue.next_action_at at time zone 'America/Sao_Paulo')::date,
  queue.status, queue.next_action;

-- ---------------------------------------------------------------------------
-- RPCs transacionais: atendimento e preferencias administrativas
-- ---------------------------------------------------------------------------

create function public.operacao_salvar_atendimento(
  p_clinic_id uuid,
  p_user_id uuid,
  p_actor_role text,
  p_auth_method text,
  p_aal text,
  p_attendance_id uuid,
  p_expected_version integer,
  p_patient_id uuid,
  p_appointment_id uuid,
  p_protocol_id uuid,
  p_financial_entry_id uuid,
  p_procedure_kind text,
  p_attended_at timestamptz,
  p_duration_minutes smallint,
  p_status text,
  p_responsible_user_id uuid,
  p_idempotency_key uuid,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_record public.atendimentos_realizados%rowtype;
  v_protocol record;
  v_entry record;
  v_is_create boolean := p_attendance_id is null;
  v_fingerprint text;
  v_request_fingerprint text;
  v_procedure_item_id uuid;
  v_existing_id uuid;
begin
  perform private.operacao_assert_owner(
    p_clinic_id, p_user_id, p_actor_role, p_auth_method, p_aal
  );
  if p_patient_id is null or p_responsible_user_id is null
     or p_idempotency_key is null or p_request_id is null
     or p_attended_at is null then
    raise exception 'required_parameter_missing' using errcode = '22023';
  end if;
  if p_attended_at > pg_catalog.now() + interval '5 minutes' then
    raise exception 'attendance_date_invalid' using errcode = '23514';
  end if;
  v_fingerprint := pg_catalog.md5(pg_catalog.jsonb_build_array(
    p_patient_id, p_appointment_id, p_protocol_id, p_financial_entry_id,
    pg_catalog.btrim(p_procedure_kind), p_attended_at, p_duration_minutes,
    coalesce(p_status, 'realizado'), p_responsible_user_id
  )::text);
  v_request_fingerprint := pg_catalog.md5(pg_catalog.jsonb_build_array(
    p_attendance_id, p_expected_version, v_fingerprint
  )::text);
  if not v_is_create and private.operacao_replay_guard(
    p_clinic_id, p_request_id, 'attendance', p_attendance_id,
    'attendance.update', v_request_fingerprint
  ) then
    select * into v_record from public.atendimentos_realizados
    where clinic_id = p_clinic_id and id = p_attendance_id;
    if not found then raise exception 'attendance_not_found' using errcode = 'P0002'; end if;
    return pg_catalog.jsonb_build_object(
      'id', v_record.id, 'version', v_record.version, 'idempotent', true
    );
  end if;

  if not exists (
    select 1 from public.patients
    where clinic_id = p_clinic_id and id = p_patient_id and archived_at is null
  ) then
    raise exception 'patient_not_found' using errcode = 'P0002';
  end if;
  if not exists (
    select 1 from public.clinic_members
    where clinic_id = p_clinic_id and user_id = p_responsible_user_id and status = 'active'
  ) then
    raise exception 'responsible_not_found' using errcode = 'P0002';
  end if;

  if p_appointment_id is not null then
    if not exists (select 1 from public.agendamentos_clinica where id = p_appointment_id) then
      raise exception 'appointment_not_found' using errcode = 'P0002';
    end if;
    if not exists (
      select 1 from public.patient_source_links
      where clinic_id = p_clinic_id and patient_id = p_patient_id
        and source_kind = 'agendamento' and source_id = p_appointment_id
        and status = 'confirmado'
    ) then
      raise exception 'appointment_patient_link_required' using errcode = '23514';
    end if;
  end if;

  if p_protocol_id is not null then
    select clinic_id, patient_id, archived_at into v_protocol
    from public.protocols where id = p_protocol_id;
    if not found or v_protocol.clinic_id <> p_clinic_id
       or v_protocol.patient_id <> p_patient_id or v_protocol.archived_at is not null then
      raise exception 'protocol_patient_mismatch' using errcode = '23514';
    end if;
  end if;

  if p_financial_entry_id is not null then
    select clinic_id, patient_id, entry_type, state into v_entry
    from public.financeiro_lancamentos
    where clinic_id = p_clinic_id and id = p_financial_entry_id;
    if not found or v_entry.patient_id is distinct from p_patient_id
       or v_entry.entry_type <> 'receita' or v_entry.state <> 'ativo' then
      raise exception 'financial_entry_patient_mismatch' using errcode = '23514';
    end if;
  end if;

  if v_is_create then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        p_clinic_id::text || ':attendance-idempotency:' || p_idempotency_key::text, 0
      )
    );
    select * into v_record from public.atendimentos_realizados
    where clinic_id = p_clinic_id and idempotency_key = p_idempotency_key;
    if found then
      if v_record.payload_fingerprint <> v_fingerprint then
        raise exception 'idempotency_key_reused' using errcode = '23505';
      end if;
      return pg_catalog.jsonb_build_object(
        'id', v_record.id, 'version', v_record.version, 'idempotent', true
      );
    end if;
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        p_clinic_id::text || ':attendance-day:' || p_patient_id::text || ':' ||
        (p_attended_at at time zone 'America/Sao_Paulo')::date::text, 0
      )
    );
    if p_appointment_id is not null then
      perform pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(
          p_clinic_id::text || ':attendance-appointment:' || p_appointment_id::text, 0
        )
      );
    end if;
    if p_protocol_id is not null then
      perform pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(
          p_clinic_id::text || ':attendance-protocol:' || p_protocol_id::text, 0
        )
      );
    end if;
    if p_financial_entry_id is not null then
      perform pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(
          p_clinic_id::text || ':attendance-finance:' || p_financial_entry_id::text, 0
        )
      );
    end if;
    select attendance.id into v_existing_id
    from public.atendimentos_realizados attendance
    where attendance.clinic_id = p_clinic_id and attendance.archived_at is null
      and (
        (p_appointment_id is not null and attendance.appointment_id = p_appointment_id)
        or (p_protocol_id is not null and attendance.protocol_id = p_protocol_id)
        or (p_financial_entry_id is not null and attendance.financial_entry_id = p_financial_entry_id)
      )
    order by attendance.created_at, attendance.id
    limit 1;
    if v_existing_id is null and p_financial_entry_id is not null then
      select item.attendance_id into v_existing_id
      from public.atendimento_procedimentos item
      where item.clinic_id = p_clinic_id
        and item.financial_entry_id = p_financial_entry_id
        and item.archived_at is null
      order by item.created_at, item.id
      limit 1;
    end if;
    if v_existing_id is not null then
      raise exception 'attendance_link_exists'
        using errcode = '23505', detail = v_existing_id::text;
    end if;
    select attendance.id into v_existing_id
      from public.atendimentos_realizados attendance
      where attendance.clinic_id = p_clinic_id and attendance.patient_id = p_patient_id
        and attendance.archived_at is null
        and (attendance.attended_at at time zone 'America/Sao_Paulo')::date =
          (p_attended_at at time zone 'America/Sao_Paulo')::date
      order by attendance.created_at, attendance.id
      limit 1;
    if v_existing_id is not null then
      raise exception 'attendance_day_exists'
        using errcode = '23505', detail = v_existing_id::text;
    end if;

    insert into public.atendimentos_realizados (
      clinic_id, patient_id, appointment_id, protocol_id, financial_entry_id,
      procedure_kind, attended_at, duration_minutes, status,
      responsible_user_id, idempotency_key, payload_fingerprint, created_by
    ) values (
      p_clinic_id, p_patient_id, p_appointment_id, p_protocol_id, p_financial_entry_id,
      pg_catalog.btrim(p_procedure_kind), p_attended_at, p_duration_minutes,
      coalesce(p_status, 'realizado'), p_responsible_user_id,
      p_idempotency_key, v_fingerprint, p_user_id
    ) returning * into v_record;
    v_procedure_item_id := pg_catalog.gen_random_uuid();
    insert into public.atendimento_procedimentos (
      id, clinic_id, attendance_id, financial_entry_id, procedure_kind, performed_at, is_primary,
      created_by, idempotency_key, payload_fingerprint
    ) values (
      v_procedure_item_id, p_clinic_id, v_record.id, p_financial_entry_id,
      pg_catalog.btrim(p_procedure_kind), v_record.attended_at, true, p_user_id, v_record.id,
      pg_catalog.md5(pg_catalog.jsonb_build_array(
        v_record.id, pg_catalog.btrim(p_procedure_kind)
      )::text)
    );
  else
    select * into v_record from public.atendimentos_realizados
    where clinic_id = p_clinic_id and id = p_attendance_id
    for update;
    if not found then
      raise exception 'attendance_not_found' using errcode = 'P0002';
    end if;
    if v_record.archived_at is not null then
      raise exception 'attendance_archived' using errcode = '42501';
    end if;
    if p_expected_version is null or v_record.version <> p_expected_version then
      raise exception 'version_conflict' using errcode = '40001';
    end if;
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        p_clinic_id::text || ':attendance-day:' || p_patient_id::text || ':' ||
        (p_attended_at at time zone 'America/Sao_Paulo')::date::text, 0
      )
    );
    if p_appointment_id is not null then
      perform pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(
          p_clinic_id::text || ':attendance-appointment:' || p_appointment_id::text, 0
        )
      );
    end if;
    if p_protocol_id is not null then
      perform pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(
          p_clinic_id::text || ':attendance-protocol:' || p_protocol_id::text, 0
        )
      );
    end if;
    if p_financial_entry_id is not null then
      perform pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(
          p_clinic_id::text || ':attendance-finance:' || p_financial_entry_id::text, 0
        )
      );
    end if;
    select attendance.id into v_existing_id
    from public.atendimentos_realizados attendance
    where attendance.clinic_id = p_clinic_id
      and attendance.id <> p_attendance_id and attendance.archived_at is null
      and (
        (p_appointment_id is not null and attendance.appointment_id = p_appointment_id)
        or (p_protocol_id is not null and attendance.protocol_id = p_protocol_id)
        or (p_financial_entry_id is not null and attendance.financial_entry_id = p_financial_entry_id)
      )
    order by attendance.created_at, attendance.id
    limit 1;
    if v_existing_id is null and p_financial_entry_id is not null then
      select item.attendance_id into v_existing_id
      from public.atendimento_procedimentos item
      where item.clinic_id = p_clinic_id
        and item.attendance_id <> p_attendance_id
        and item.financial_entry_id = p_financial_entry_id
        and item.archived_at is null
      order by item.created_at, item.id
      limit 1;
    end if;
    if v_existing_id is not null then
      raise exception 'attendance_link_exists'
        using errcode = '23505', detail = v_existing_id::text;
    end if;
    select attendance.id into v_existing_id
      from public.atendimentos_realizados attendance
      where attendance.clinic_id = p_clinic_id and attendance.patient_id = p_patient_id
        and attendance.id <> p_attendance_id and attendance.archived_at is null
        and (attendance.attended_at at time zone 'America/Sao_Paulo')::date =
          (p_attended_at at time zone 'America/Sao_Paulo')::date
      order by attendance.created_at, attendance.id
      limit 1;
    if v_existing_id is not null then
      raise exception 'attendance_day_exists'
        using errcode = '23505', detail = v_existing_id::text;
    end if;
    if v_record.procedure_kind <> pg_catalog.btrim(p_procedure_kind) then
      raise exception 'attendance_procedure_items_required' using errcode = '42501';
    end if;
    if (
      v_record.patient_id <> p_patient_id
      or v_record.protocol_id is distinct from p_protocol_id
    ) and exists (
      select 1 from public.retorno_recomendacoes
      where clinic_id = p_clinic_id and attendance_id = p_attendance_id
    ) then
      raise exception 'attendance_links_locked_by_return' using errcode = '42501';
    end if;
    if v_record.protocol_id is distinct from p_protocol_id and (
      exists (
        select 1 from public.operacao_consumo_eventos
        where clinic_id = p_clinic_id and attendance_id = p_attendance_id
      )
      or (
        v_record.protocol_id is not null and exists (
          select 1 from public.financeiro_estoque_movimentos
          where clinic_id = p_clinic_id and protocol_id = v_record.protocol_id
        )
      )
    ) then
      raise exception 'attendance_protocol_locked_by_stock' using errcode = '42501';
    end if;
    if v_record.financial_entry_id is distinct from p_financial_entry_id and exists (
      select 1 from public.atendimento_pagamento_taxas
      where clinic_id = p_clinic_id and attendance_id = p_attendance_id
    ) then
      raise exception 'attendance_financial_locked_by_fee' using errcode = '42501';
    end if;
    update public.atendimentos_realizados set
      patient_id = p_patient_id,
      appointment_id = p_appointment_id,
      protocol_id = p_protocol_id,
      financial_entry_id = p_financial_entry_id,
      procedure_kind = pg_catalog.btrim(p_procedure_kind),
      attended_at = p_attended_at,
      duration_minutes = p_duration_minutes,
      status = coalesce(p_status, status),
      responsible_user_id = p_responsible_user_id,
      version = version + 1,
      updated_by = p_user_id,
      updated_at = pg_catalog.now()
    where clinic_id = p_clinic_id and id = p_attendance_id
    returning * into v_record;
    update public.atendimento_procedimentos set
      financial_entry_id = p_financial_entry_id,
      updated_by = p_user_id,
      updated_at = pg_catalog.now(),
      version = version + 1
    where clinic_id = p_clinic_id and attendance_id = p_attendance_id
      and is_primary and archived_at is null
      and financial_entry_id is distinct from p_financial_entry_id;
  end if;

  perform private.operacao_log(
    p_clinic_id, p_user_id, p_actor_role, p_auth_method,
    'attendance', v_record.id,
    case when v_is_create then 'attendance.create' else 'attendance.update' end,
    p_request_id, 1,
    case when v_is_create then v_fingerprint else v_request_fingerprint end
  );
  return pg_catalog.jsonb_build_object(
    'id', v_record.id, 'version', v_record.version, 'idempotent', false
  );
end;
$function$;

create function public.operacao_definir_arquivamento_atendimento(
  p_clinic_id uuid,
  p_user_id uuid,
  p_actor_role text,
  p_auth_method text,
  p_aal text,
  p_attendance_id uuid,
  p_expected_version integer,
  p_archive boolean,
  p_reason text,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_record public.atendimentos_realizados%rowtype;
  v_fingerprint text;
  v_existing_id uuid;
begin
  perform private.operacao_assert_owner(
    p_clinic_id, p_user_id, p_actor_role, p_auth_method, p_aal
  );
  if p_attendance_id is null or p_expected_version is null or p_archive is null
     or pg_catalog.char_length(pg_catalog.btrim(coalesce(p_reason, ''))) not between 3 and 500 then
    raise exception 'archive_reason_invalid' using errcode = '22023';
  end if;
  v_fingerprint := pg_catalog.md5(pg_catalog.jsonb_build_array(
    p_attendance_id, p_expected_version, p_archive, pg_catalog.btrim(p_reason)
  )::text);
  if private.operacao_replay_guard(
    p_clinic_id, p_request_id, 'attendance', p_attendance_id,
    case when p_archive then 'attendance.archive' else 'attendance.restore' end,
    v_fingerprint
  ) then
    select * into v_record from public.atendimentos_realizados
    where clinic_id = p_clinic_id and id = p_attendance_id;
    if not found then raise exception 'attendance_not_found' using errcode = 'P0002'; end if;
    return pg_catalog.jsonb_build_object(
      'id', v_record.id, 'version', v_record.version, 'idempotent', true
    );
  end if;
  select * into v_record from public.atendimentos_realizados
  where clinic_id = p_clinic_id and id = p_attendance_id
  for update;
  if not found then raise exception 'attendance_not_found' using errcode = 'P0002'; end if;
  if v_record.version <> p_expected_version then
    raise exception 'version_conflict' using errcode = '40001';
  end if;
  if p_archive and v_record.archived_at is not null then
    return pg_catalog.jsonb_build_object('id', v_record.id, 'version', v_record.version, 'idempotent', true);
  elsif not p_archive and v_record.archived_at is null then
    return pg_catalog.jsonb_build_object('id', v_record.id, 'version', v_record.version, 'idempotent', true);
  end if;

  if not p_archive then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        p_clinic_id::text || ':attendance-day:' || v_record.patient_id::text || ':' ||
        (v_record.attended_at at time zone 'America/Sao_Paulo')::date::text, 0
      )
    );
    if v_record.appointment_id is not null then
      perform pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(
          p_clinic_id::text || ':attendance-appointment:' || v_record.appointment_id::text, 0
        )
      );
    end if;
    if v_record.protocol_id is not null then
      perform pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(
          p_clinic_id::text || ':attendance-protocol:' || v_record.protocol_id::text, 0
        )
      );
    end if;
    if v_record.financial_entry_id is not null then
      perform pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(
          p_clinic_id::text || ':attendance-finance:' || v_record.financial_entry_id::text, 0
        )
      );
    end if;
    select attendance.id into v_existing_id
    from public.atendimentos_realizados attendance
    where attendance.clinic_id = p_clinic_id
      and attendance.patient_id = v_record.patient_id
      and attendance.id <> v_record.id
      and attendance.archived_at is null
      and (attendance.attended_at at time zone 'America/Sao_Paulo')::date =
          (v_record.attended_at at time zone 'America/Sao_Paulo')::date
    order by attendance.created_at, attendance.id
    limit 1;
    if v_existing_id is not null then
      raise exception 'attendance_day_exists'
        using errcode = '23505', detail = v_existing_id::text;
    end if;
    select attendance.id into v_existing_id
    from public.atendimentos_realizados attendance
    where attendance.clinic_id = p_clinic_id
      and attendance.id <> v_record.id
      and attendance.archived_at is null
      and (
        (v_record.appointment_id is not null and attendance.appointment_id = v_record.appointment_id)
        or (v_record.protocol_id is not null and attendance.protocol_id = v_record.protocol_id)
        or (
          v_record.financial_entry_id is not null
          and attendance.financial_entry_id = v_record.financial_entry_id
        )
      )
    order by attendance.created_at, attendance.id
    limit 1;
    if v_existing_id is not null then
      raise exception 'attendance_link_exists'
        using errcode = '23505', detail = v_existing_id::text;
    end if;
    if v_record.financial_entry_id is not null then
      select item.attendance_id into v_existing_id
      from public.atendimento_procedimentos item
      where item.clinic_id = p_clinic_id
        and item.attendance_id <> v_record.id
        and item.financial_entry_id = v_record.financial_entry_id
        and item.archived_at is null
      order by item.created_at, item.id
      limit 1;
      if v_existing_id is not null then
        raise exception 'attendance_link_exists'
          using errcode = '23505', detail = v_existing_id::text;
      end if;
    end if;
  end if;

  update public.atendimentos_realizados set
    archived_at = case when p_archive then pg_catalog.now() else null end,
    archive_reason = case when p_archive then pg_catalog.btrim(p_reason) else null end,
    archived_by = case when p_archive then p_user_id else null end,
    version = version + 1,
    updated_by = p_user_id,
    updated_at = pg_catalog.now()
  where clinic_id = p_clinic_id and id = p_attendance_id
  returning * into v_record;

  perform private.operacao_log(
    p_clinic_id, p_user_id, p_actor_role, p_auth_method,
    'attendance', v_record.id,
    case when p_archive then 'attendance.archive' else 'attendance.restore' end,
    p_request_id, 1, v_fingerprint
  );
  return pg_catalog.jsonb_build_object('id', v_record.id, 'version', v_record.version, 'idempotent', false);
end;
$function$;

create function public.operacao_salvar_procedimento_atendimento(
  p_clinic_id uuid,
  p_user_id uuid,
  p_actor_role text,
  p_auth_method text,
  p_aal text,
  p_procedure_item_id uuid,
  p_expected_version integer,
  p_attendance_id uuid,
  p_financial_entry_id uuid,
  p_procedure_kind text,
  p_procedure_region text,
  p_performed_at timestamptz,
  p_confirm_distinct boolean,
  p_distinct_reason text,
  p_idempotency_key uuid,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_attendance public.atendimentos_realizados%rowtype;
  v_item public.atendimento_procedimentos%rowtype;
  v_entry public.financeiro_lancamentos%rowtype;
  v_is_create boolean := p_procedure_item_id is null;
  v_fingerprint text;
  v_request_fingerprint text;
  v_material_fingerprint text;
  v_exact_duplicate_id uuid;
  v_duplicate_id uuid;
  v_region text := nullif(pg_catalog.btrim(p_procedure_region), '');
  v_performed_at timestamptz;
  v_distinct_reason text := nullif(pg_catalog.btrim(p_distinct_reason), '');
begin
  perform private.operacao_assert_owner(
    p_clinic_id, p_user_id, p_actor_role, p_auth_method, p_aal
  );
  if p_attendance_id is null or p_idempotency_key is null or p_request_id is null then
    raise exception 'required_parameter_missing' using errcode = '22023';
  end if;
  select * into v_attendance
  from public.atendimentos_realizados
  where clinic_id = p_clinic_id and id = p_attendance_id and archived_at is null
  for update;
  if not found then raise exception 'attendance_not_found' using errcode = 'P0002'; end if;
  v_performed_at := coalesce(p_performed_at, v_attendance.attended_at);
  if (v_performed_at at time zone 'America/Sao_Paulo')::date <>
       (v_attendance.attended_at at time zone 'America/Sao_Paulo')::date
     or v_performed_at > pg_catalog.now() + interval '5 minutes' then
    raise exception 'procedure_date_invalid' using errcode = '23514';
  end if;
  v_material_fingerprint := pg_catalog.md5(
    p_attendance_id::text || '|' || pg_catalog.lower(pg_catalog.btrim(p_procedure_kind)) || '|' ||
    pg_catalog.lower(pg_catalog.btrim(coalesce(v_region, ''))) || '|' ||
    (v_performed_at at time zone 'UTC')::text
  );
  v_fingerprint := pg_catalog.md5(pg_catalog.jsonb_build_array(
    p_attendance_id, p_financial_entry_id, pg_catalog.btrim(p_procedure_kind),
    v_region, v_performed_at, coalesce(p_confirm_distinct, false), v_distinct_reason
  )::text);
  v_request_fingerprint := pg_catalog.md5(pg_catalog.jsonb_build_array(
    p_procedure_item_id, p_expected_version, v_fingerprint
  )::text);
  if not v_is_create and private.operacao_replay_guard(
    p_clinic_id, p_request_id, 'attendance_procedure', p_procedure_item_id,
    'attendance_procedure.update', v_request_fingerprint
  ) then
    select * into v_item from public.atendimento_procedimentos
    where clinic_id = p_clinic_id and id = p_procedure_item_id;
    if not found then raise exception 'attendance_procedure_not_found' using errcode = 'P0002'; end if;
    return pg_catalog.jsonb_build_object(
      'id', v_item.id, 'version', v_item.version,
      'attendance_version', v_attendance.version, 'idempotent', true
    );
  end if;

  if p_financial_entry_id is not null then
    select * into v_entry
    from public.financeiro_lancamentos
    where clinic_id = p_clinic_id and id = p_financial_entry_id;
    if not found or v_entry.patient_id is distinct from v_attendance.patient_id
       or v_entry.entry_type <> 'receita' or v_entry.origin <> 'atendimento'
       or v_entry.state <> 'ativo' then
      raise exception 'procedure_financial_link_invalid' using errcode = '23514';
    end if;
  end if;

  if v_is_create then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        p_clinic_id::text || ':attendance-procedure-idempotency:' || p_idempotency_key::text, 0
      )
    );
    select * into v_item
    from public.atendimento_procedimentos
    where clinic_id = p_clinic_id and idempotency_key = p_idempotency_key;
    if found then
      if v_item.payload_fingerprint <> v_fingerprint then
        raise exception 'idempotency_key_reused' using errcode = '23505';
      end if;
      return pg_catalog.jsonb_build_object(
        'id', v_item.id, 'version', v_item.version,
        'attendance_version', v_attendance.version, 'idempotent', true
      );
    end if;
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        p_clinic_id::text || ':attendance-procedure-material:' || v_material_fingerprint, 0
      )
    );
    select item.id into v_exact_duplicate_id
    from public.atendimento_procedimentos item
    where item.clinic_id = p_clinic_id
      and item.material_fingerprint = v_material_fingerprint
      and item.archived_at is null
    order by item.created_at, item.id
    limit 1;
    if v_exact_duplicate_id is not null then
      raise exception 'procedure_duplicate_exists'
        using errcode = '23505', detail = v_exact_duplicate_id::text;
    end if;
    select item.id into v_duplicate_id
    from public.atendimento_procedimentos item
    where item.clinic_id = p_clinic_id
      and item.attendance_id = p_attendance_id
      and pg_catalog.lower(pg_catalog.btrim(item.procedure_kind)) =
          pg_catalog.lower(pg_catalog.btrim(p_procedure_kind))
      and item.material_fingerprint <> v_material_fingerprint
      and item.archived_at is null
    order by item.created_at, item.id
    limit 1;
    if v_duplicate_id is not null and (
      coalesce(p_confirm_distinct, false) is not true
      or v_distinct_reason is null
      or pg_catalog.char_length(v_distinct_reason) not between 3 and 500
    ) then
      raise exception 'procedure_possible_duplicate_requires_review'
        using errcode = '23505', detail = v_duplicate_id::text;
    end if;
    if (
      select pg_catalog.count(*) >= 50
      from public.atendimento_procedimentos
      where clinic_id = p_clinic_id and attendance_id = p_attendance_id
        and archived_at is null
    ) then
      raise exception 'attendance_procedure_limit' using errcode = '23514';
    end if;
    insert into public.atendimento_procedimentos (
      clinic_id, attendance_id, financial_entry_id, procedure_kind,
      procedure_region, performed_at, is_primary,
      duplicate_of_id, distinct_duplicate_reason, duplicate_review_required,
      created_by, idempotency_key, payload_fingerprint
    ) values (
      p_clinic_id, p_attendance_id, p_financial_entry_id,
      pg_catalog.btrim(p_procedure_kind), v_region, v_performed_at, false,
      v_duplicate_id,
      case when v_duplicate_id is null then null else v_distinct_reason end,
      false,
      p_user_id, p_idempotency_key, v_fingerprint
    ) returning * into v_item;
  else
    select * into v_item
    from public.atendimento_procedimentos
    where clinic_id = p_clinic_id and id = p_procedure_item_id
      and attendance_id = p_attendance_id
    for update;
    if not found then raise exception 'attendance_procedure_not_found' using errcode = 'P0002'; end if;
    if v_item.archived_at is not null then
      raise exception 'attendance_procedure_archived' using errcode = '42501';
    end if;
    if p_expected_version is null or v_item.version <> p_expected_version then
      raise exception 'version_conflict' using errcode = '40001';
    end if;
    if v_item.financial_entry_id is distinct from p_financial_entry_id and exists (
      select 1
      from public.atendimento_pagamento_taxas fee
      join public.financeiro_pagamentos payment
        on payment.clinic_id = fee.clinic_id and payment.id = fee.payment_id
      where fee.clinic_id = p_clinic_id and fee.attendance_id = p_attendance_id
        and payment.entry_id = v_item.financial_entry_id
    ) then
      raise exception 'procedure_financial_locked_by_fee' using errcode = '42501';
    end if;
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        p_clinic_id::text || ':attendance-procedure-material:' || v_material_fingerprint, 0
      )
    );
    select item.id into v_exact_duplicate_id
    from public.atendimento_procedimentos item
    where item.clinic_id = p_clinic_id
      and item.material_fingerprint = v_material_fingerprint
      and item.id <> p_procedure_item_id
      and item.archived_at is null
    order by item.created_at, item.id
    limit 1;
    if v_exact_duplicate_id is not null then
      raise exception 'procedure_duplicate_exists'
        using errcode = '23505', detail = v_exact_duplicate_id::text;
    end if;
    select item.id into v_duplicate_id
    from public.atendimento_procedimentos item
    where item.clinic_id = p_clinic_id
      and item.attendance_id = p_attendance_id
      and item.id <> p_procedure_item_id
      and pg_catalog.lower(pg_catalog.btrim(item.procedure_kind)) =
          pg_catalog.lower(pg_catalog.btrim(p_procedure_kind))
      and item.material_fingerprint <> v_material_fingerprint
      and item.archived_at is null
    order by item.created_at, item.id
    limit 1;
    if v_duplicate_id is not null and (
      coalesce(p_confirm_distinct, false) is not true
      or v_distinct_reason is null
      or pg_catalog.char_length(v_distinct_reason) not between 3 and 500
    ) then
      raise exception 'procedure_possible_duplicate_requires_review'
        using errcode = '23505', detail = v_duplicate_id::text;
    end if;
    update public.atendimento_procedimentos set
      financial_entry_id = p_financial_entry_id,
      procedure_kind = pg_catalog.btrim(p_procedure_kind),
      procedure_region = v_region,
      performed_at = v_performed_at,
      duplicate_of_id = v_duplicate_id,
      distinct_duplicate_reason = case when v_duplicate_id is null then null else v_distinct_reason end,
      duplicate_review_required = false,
      version = version + 1,
      updated_by = p_user_id,
      updated_at = pg_catalog.now()
    where clinic_id = p_clinic_id and id = p_procedure_item_id
    returning * into v_item;
    if v_item.is_primary then
      update public.atendimentos_realizados set
        financial_entry_id = p_financial_entry_id,
        procedure_kind = v_item.procedure_kind
      where clinic_id = p_clinic_id and id = p_attendance_id;
    end if;
  end if;

  update public.atendimentos_realizados set
    version = version + 1,
    updated_by = p_user_id,
    updated_at = pg_catalog.now()
  where clinic_id = p_clinic_id and id = p_attendance_id
  returning * into v_attendance;
  perform private.operacao_log(
    p_clinic_id, p_user_id, p_actor_role, p_auth_method,
    'attendance_procedure', v_item.id,
    case when v_is_create then 'attendance_procedure.create' else 'attendance_procedure.update' end,
    p_request_id, 1,
    case when v_is_create then v_fingerprint else v_request_fingerprint end
  );
  return pg_catalog.jsonb_build_object(
    'id', v_item.id, 'version', v_item.version,
    'attendance_version', v_attendance.version, 'idempotent', false
  );
end;
$function$;

create function public.operacao_definir_arquivamento_procedimento(
  p_clinic_id uuid,
  p_user_id uuid,
  p_actor_role text,
  p_auth_method text,
  p_aal text,
  p_procedure_item_id uuid,
  p_expected_version integer,
  p_archive boolean,
  p_confirm_distinct boolean,
  p_distinct_reason text,
  p_reason text,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_attendance public.atendimentos_realizados%rowtype;
  v_item public.atendimento_procedimentos%rowtype;
  v_promoted public.atendimento_procedimentos%rowtype;
  v_active_count integer;
  v_exact_duplicate_id uuid;
  v_duplicate_id uuid;
  v_distinct_reason text := nullif(pg_catalog.btrim(p_distinct_reason), '');
  v_fingerprint text;
begin
  perform private.operacao_assert_owner(
    p_clinic_id, p_user_id, p_actor_role, p_auth_method, p_aal
  );
  if p_procedure_item_id is null or p_expected_version is null or p_archive is null
     or pg_catalog.char_length(pg_catalog.btrim(coalesce(p_reason, ''))) not between 3 and 500 then
    raise exception 'archive_reason_invalid' using errcode = '22023';
  end if;
  v_fingerprint := pg_catalog.md5(pg_catalog.jsonb_build_array(
    p_procedure_item_id, p_expected_version, p_archive,
    coalesce(p_confirm_distinct, false), v_distinct_reason, pg_catalog.btrim(p_reason)
  )::text);
  if private.operacao_replay_guard(
    p_clinic_id, p_request_id, 'attendance_procedure', p_procedure_item_id,
    case when p_archive then 'attendance_procedure.archive' else 'attendance_procedure.restore' end,
    v_fingerprint
  ) then
    select * into v_item from public.atendimento_procedimentos
    where clinic_id = p_clinic_id and id = p_procedure_item_id;
    if not found then raise exception 'attendance_procedure_not_found' using errcode = 'P0002'; end if;
    select * into v_attendance from public.atendimentos_realizados
    where clinic_id = p_clinic_id and id = v_item.attendance_id;
    return pg_catalog.jsonb_build_object(
      'id', v_item.id, 'version', v_item.version,
      'attendance_version', v_attendance.version,
      'archived', p_archive, 'hard_delete', false, 'idempotent', true
    );
  end if;
  select * into v_item
  from public.atendimento_procedimentos
  where clinic_id = p_clinic_id and id = p_procedure_item_id;
  if not found then raise exception 'attendance_procedure_not_found' using errcode = 'P0002'; end if;
  select * into v_attendance
  from public.atendimentos_realizados
  where clinic_id = p_clinic_id and id = v_item.attendance_id and archived_at is null
  for update;
  if not found then raise exception 'attendance_not_found' using errcode = 'P0002'; end if;
  select * into v_item
  from public.atendimento_procedimentos
  where clinic_id = p_clinic_id and id = p_procedure_item_id
    and attendance_id = v_attendance.id
  for update;
  if not found then raise exception 'attendance_procedure_not_found' using errcode = 'P0002'; end if;
  if v_item.version <> p_expected_version then
    raise exception 'version_conflict' using errcode = '40001';
  end if;
  if p_archive and v_item.archived_at is not null then
    return pg_catalog.jsonb_build_object('id', v_item.id, 'version', v_item.version, 'idempotent', true);
  elsif not p_archive and v_item.archived_at is null then
    return pg_catalog.jsonb_build_object('id', v_item.id, 'version', v_item.version, 'idempotent', true);
  end if;

  if p_archive then
    select pg_catalog.count(*)::integer into v_active_count
    from public.atendimento_procedimentos
    where clinic_id = p_clinic_id and attendance_id = v_item.attendance_id
      and archived_at is null;
    if v_active_count <= 1 then
      raise exception 'attendance_last_procedure_required' using errcode = '23514';
    end if;
    if v_item.is_primary then
      select * into v_promoted
      from public.atendimento_procedimentos
      where clinic_id = p_clinic_id and attendance_id = v_item.attendance_id
        and id <> v_item.id and archived_at is null
      order by created_at, id
      limit 1
      for update;
      update public.atendimento_procedimentos set
        is_primary = true, version = version + 1,
        updated_by = p_user_id, updated_at = pg_catalog.now()
      where clinic_id = p_clinic_id and id = v_promoted.id
      returning * into v_promoted;
      update public.atendimentos_realizados set
        procedure_kind = v_promoted.procedure_kind,
        financial_entry_id = v_promoted.financial_entry_id
      where clinic_id = p_clinic_id and id = v_item.attendance_id;
    end if;
    update public.atendimento_procedimentos set
      is_primary = false,
      archived_at = pg_catalog.now(), archive_reason = pg_catalog.btrim(p_reason),
      archived_by = p_user_id, version = version + 1,
      updated_by = p_user_id, updated_at = pg_catalog.now()
    where clinic_id = p_clinic_id and id = v_item.id
    returning * into v_item;
  else
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        p_clinic_id::text || ':attendance-procedure-material:' || v_item.material_fingerprint, 0
      )
    );
    select candidate.id into v_exact_duplicate_id
    from public.atendimento_procedimentos candidate
    where candidate.clinic_id = p_clinic_id
      and candidate.material_fingerprint = v_item.material_fingerprint
      and candidate.id <> v_item.id
      and candidate.archived_at is null
    order by candidate.created_at, candidate.id
    limit 1;
    if v_exact_duplicate_id is not null then
      raise exception 'procedure_duplicate_exists'
        using errcode = '23505', detail = v_exact_duplicate_id::text;
    end if;
    select candidate.id into v_duplicate_id
    from public.atendimento_procedimentos candidate
    where candidate.clinic_id = p_clinic_id
      and candidate.attendance_id = v_item.attendance_id
      and candidate.id <> v_item.id
      and pg_catalog.lower(pg_catalog.btrim(candidate.procedure_kind)) =
          pg_catalog.lower(pg_catalog.btrim(v_item.procedure_kind))
      and candidate.material_fingerprint <> v_item.material_fingerprint
      and candidate.archived_at is null
    order by candidate.created_at, candidate.id
    limit 1;
    if v_duplicate_id is not null and (
      coalesce(p_confirm_distinct, false) is not true
      or v_distinct_reason is null
      or pg_catalog.char_length(v_distinct_reason) not between 3 and 500
    ) then
      raise exception 'procedure_possible_duplicate_requires_review'
        using errcode = '23505', detail = v_duplicate_id::text;
    end if;
    update public.atendimento_procedimentos set
      archived_at = null, archive_reason = null, archived_by = null,
      duplicate_of_id = v_duplicate_id,
      distinct_duplicate_reason = case when v_duplicate_id is null then null else v_distinct_reason end,
      duplicate_review_required = false,
      version = version + 1, updated_by = p_user_id, updated_at = pg_catalog.now()
    where clinic_id = p_clinic_id and id = v_item.id
    returning * into v_item;
  end if;

  update public.atendimentos_realizados set
    version = version + 1, updated_by = p_user_id, updated_at = pg_catalog.now()
  where clinic_id = p_clinic_id and id = v_item.attendance_id
  returning * into v_attendance;
  perform private.operacao_log(
    p_clinic_id, p_user_id, p_actor_role, p_auth_method,
    'attendance_procedure', v_item.id,
    case when p_archive then 'attendance_procedure.archive' else 'attendance_procedure.restore' end,
    p_request_id, case when v_promoted.id is null then 1 else 2 end,
    v_fingerprint
  );
  return pg_catalog.jsonb_build_object(
    'id', v_item.id, 'version', v_item.version,
    'attendance_version', v_attendance.version,
    'archived', p_archive, 'hard_delete', false, 'idempotent', false
  );
end;
$function$;

create function public.operacao_registrar_perfil_paciente(
  p_clinic_id uuid,
  p_user_id uuid,
  p_actor_role text,
  p_auth_method text,
  p_aal text,
  p_patient_id uuid,
  p_preferred_name text,
  p_accessibility_note text,
  p_privacy_notice_version text,
  p_reason text,
  p_idempotency_key uuid,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_record public.patient_operational_profile_events%rowtype;
  v_version integer;
  v_fingerprint text;
begin
  perform private.operacao_assert_owner(p_clinic_id, p_user_id, p_actor_role, p_auth_method, p_aal);
  if p_patient_id is null or p_idempotency_key is null or p_request_id is null then
    raise exception 'required_parameter_missing' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.patients
    where clinic_id = p_clinic_id and id = p_patient_id and archived_at is null
  ) then
    raise exception 'patient_not_found' using errcode = 'P0002';
  end if;
  v_fingerprint := pg_catalog.md5(pg_catalog.jsonb_build_array(
    p_patient_id, nullif(pg_catalog.btrim(p_preferred_name), ''),
    nullif(pg_catalog.btrim(p_accessibility_note), ''),
    nullif(pg_catalog.btrim(p_privacy_notice_version), ''),
    pg_catalog.btrim(p_reason)
  )::text);
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      p_clinic_id::text || ':patient-profile-idempotency:' || p_idempotency_key::text, 0
    )
  );
  select * into v_record
  from public.patient_operational_profile_events
  where clinic_id = p_clinic_id and idempotency_key = p_idempotency_key;
  if found then
    if v_record.payload_fingerprint <> v_fingerprint then
      raise exception 'idempotency_key_reused' using errcode = '23505';
    end if;
    return pg_catalog.jsonb_build_object(
      'id', v_record.id, 'version', v_record.version, 'idempotent', true
    );
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_clinic_id::text || ':patient-profile:' || p_patient_id::text, 0)
  );
  select coalesce(pg_catalog.max(version), 0) + 1 into v_version
  from public.patient_operational_profile_events
  where clinic_id = p_clinic_id and patient_id = p_patient_id;
  insert into public.patient_operational_profile_events (
    clinic_id, patient_id, preferred_name, accessibility_note,
    privacy_notice_version, version, reason, recorded_by, idempotency_key,
    payload_fingerprint
  ) values (
    p_clinic_id, p_patient_id, nullif(pg_catalog.btrim(p_preferred_name), ''),
    nullif(pg_catalog.btrim(p_accessibility_note), ''),
    nullif(pg_catalog.btrim(p_privacy_notice_version), ''),
    v_version, pg_catalog.btrim(p_reason), p_user_id, p_idempotency_key,
    v_fingerprint
  ) returning * into v_record;
  perform private.operacao_log(
    p_clinic_id, p_user_id, p_actor_role, p_auth_method,
    'patient_operational_profile', v_record.id, 'patient_profile.record', p_request_id, 1
  );
  return pg_catalog.jsonb_build_object(
    'id', v_record.id, 'version', v_version, 'idempotent', false
  );
end;
$function$;

create function public.operacao_registrar_preferencia_contato(
  p_clinic_id uuid,
  p_user_id uuid,
  p_actor_role text,
  p_auth_method text,
  p_aal text,
  p_patient_id uuid,
  p_purpose text,
  p_channel text,
  p_allowed boolean,
  p_evidence_kind text,
  p_evidence_reference text,
  p_privacy_notice_version text,
  p_effective_at timestamptz,
  p_idempotency_key uuid,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_record public.patient_contact_preference_events%rowtype;
  v_version integer;
  v_fingerprint text;
begin
  perform private.operacao_assert_owner(p_clinic_id, p_user_id, p_actor_role, p_auth_method, p_aal);
  if p_patient_id is null or p_allowed is null or p_idempotency_key is null or p_request_id is null then
    raise exception 'required_parameter_missing' using errcode = '22023';
  end if;
  if p_purpose not in ('retorno', 'agenda') then
    raise exception 'operational_preference_purpose_invalid' using errcode = '23514';
  end if;
  if not exists (
    select 1 from public.patients
    where clinic_id = p_clinic_id and id = p_patient_id and archived_at is null
  ) then
    raise exception 'patient_not_found' using errcode = 'P0002';
  end if;
  v_fingerprint := pg_catalog.md5(pg_catalog.jsonb_build_array(
    p_patient_id, p_purpose, p_channel, p_allowed, p_evidence_kind,
    nullif(pg_catalog.btrim(p_evidence_reference), ''),
    nullif(pg_catalog.btrim(p_privacy_notice_version), ''),
    p_effective_at is null, p_effective_at
  )::text);
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      p_clinic_id::text || ':contact-preference-idempotency:' || p_idempotency_key::text, 0
    )
  );
  select * into v_record
  from public.patient_contact_preference_events
  where clinic_id = p_clinic_id and idempotency_key = p_idempotency_key;
  if found then
    if v_record.payload_fingerprint <> v_fingerprint then
      raise exception 'idempotency_key_reused' using errcode = '23505';
    end if;
    return pg_catalog.jsonb_build_object(
      'id', v_record.id, 'version', v_record.version, 'idempotent', true
    );
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      p_clinic_id::text || ':contact-preference:' || p_patient_id::text || ':' || p_purpose || ':' || p_channel, 0
    )
  );
  select coalesce(pg_catalog.max(version), 0) + 1 into v_version
  from public.patient_contact_preference_events
  where clinic_id = p_clinic_id and patient_id = p_patient_id
    and purpose = p_purpose and channel = p_channel;
  insert into public.patient_contact_preference_events (
    clinic_id, patient_id, purpose, channel, allowed, evidence_kind,
    evidence_reference, privacy_notice_version, version, effective_at,
    recorded_by, idempotency_key, payload_fingerprint
  ) values (
    p_clinic_id, p_patient_id, p_purpose, p_channel, p_allowed, p_evidence_kind,
    nullif(pg_catalog.btrim(p_evidence_reference), ''),
    nullif(pg_catalog.btrim(p_privacy_notice_version), ''),
    v_version, coalesce(p_effective_at, pg_catalog.now()),
    p_user_id, p_idempotency_key, v_fingerprint
  ) returning * into v_record;
  perform private.operacao_log(
    p_clinic_id, p_user_id, p_actor_role, p_auth_method,
    'patient_contact_preference', v_record.id, 'contact_preference.record', p_request_id, 1
  );
  return pg_catalog.jsonb_build_object(
    'id', v_record.id, 'version', v_version, 'idempotent', false
  );
end;
$function$;

-- ---------------------------------------------------------------------------
-- RPCs transacionais: retornos (nenhum deles envia mensagem)
-- ---------------------------------------------------------------------------

create function public.operacao_criar_retorno(
  p_clinic_id uuid,
  p_user_id uuid,
  p_actor_role text,
  p_auth_method text,
  p_aal text,
  p_attendance_id uuid,
  p_recommendation_kind text,
  p_exact_date date,
  p_window_start date,
  p_window_end date,
  p_instruction text,
  p_responsible_user_id uuid,
  p_next_action_at timestamptz,
  p_idempotency_key uuid,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_attendance public.atendimentos_realizados%rowtype;
  v_recommendation public.retorno_recomendacoes%rowtype;
  v_queue_id uuid;
  v_fingerprint text;
  v_material_fingerprint text;
  v_existing_id uuid;
begin
  perform private.operacao_assert_owner(p_clinic_id, p_user_id, p_actor_role, p_auth_method, p_aal);
  if p_attendance_id is null or p_responsible_user_id is null
     or p_next_action_at is null or p_idempotency_key is null or p_request_id is null then
    raise exception 'required_parameter_missing' using errcode = '22023';
  end if;
  v_fingerprint := pg_catalog.md5(pg_catalog.jsonb_build_array(
    p_attendance_id, pg_catalog.btrim(p_recommendation_kind), p_exact_date,
    p_window_start, p_window_end, nullif(pg_catalog.btrim(p_instruction), ''),
    p_responsible_user_id, p_next_action_at
  )::text);
  v_material_fingerprint := pg_catalog.md5(
    p_attendance_id::text || '|' || pg_catalog.lower(pg_catalog.btrim(p_recommendation_kind)) || '|' ||
    coalesce(p_exact_date::text, '') || '|' ||
    coalesce(p_window_start::text, '') || '|' ||
    coalesce(p_window_end::text, '')
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      p_clinic_id::text || ':return-idempotency:' || p_idempotency_key::text, 0
    )
  );
  select * into v_attendance from public.atendimentos_realizados
  where clinic_id = p_clinic_id and id = p_attendance_id and archived_at is null
  for update;
  if not found then raise exception 'attendance_not_found' using errcode = 'P0002'; end if;
  if (
    p_exact_date is not null
    and p_exact_date < (v_attendance.attended_at at time zone 'America/Sao_Paulo')::date
  ) or (
    p_window_start is not null
    and p_window_start < (v_attendance.attended_at at time zone 'America/Sao_Paulo')::date
  ) then
    raise exception 'return_date_invalid' using errcode = '23514';
  end if;
  if not exists (
    select 1 from public.clinic_members
    where clinic_id = p_clinic_id and user_id = p_responsible_user_id and status = 'active'
  ) then
    raise exception 'responsible_not_found' using errcode = 'P0002';
  end if;

  select * into v_recommendation from public.retorno_recomendacoes
  where clinic_id = p_clinic_id and idempotency_key = p_idempotency_key;
  if found then
    if v_recommendation.payload_fingerprint <> v_fingerprint then
      raise exception 'idempotency_key_reused' using errcode = '23505';
    end if;
    select id into v_queue_id from public.retorno_fila
    where clinic_id = p_clinic_id and recommendation_id = v_recommendation.id;
    return pg_catalog.jsonb_build_object(
      'recomendacao_id', v_recommendation.id, 'fila_id', v_queue_id, 'idempotent', true
    );
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      p_clinic_id::text || ':return-material:' || v_material_fingerprint, 0
    )
  );
  select recommendation.id into v_existing_id
    from public.retorno_recomendacoes recommendation
    where recommendation.clinic_id = p_clinic_id
      and recommendation.material_fingerprint = v_material_fingerprint
      and recommendation.status in ('ativa', 'convertida')
    order by recommendation.created_at, recommendation.id
    limit 1;
  if v_existing_id is not null then
    raise exception 'return_duplicate_exists'
      using errcode = '23505', detail = v_existing_id::text;
  end if;

  insert into public.retorno_recomendacoes (
    clinic_id, attendance_id, patient_id, protocol_id, recommendation_kind,
    exact_date, window_start, window_end, instruction, validated_by,
    idempotency_key, payload_fingerprint
  ) values (
    p_clinic_id, v_attendance.id, v_attendance.patient_id, v_attendance.protocol_id,
    pg_catalog.btrim(p_recommendation_kind), p_exact_date, p_window_start, p_window_end,
    nullif(pg_catalog.btrim(p_instruction), ''), p_user_id, p_idempotency_key,
    v_fingerprint
  ) returning * into v_recommendation;

  insert into public.retorno_fila (
    clinic_id, recommendation_id, patient_id, responsible_user_id,
    status, next_action, next_action_at, created_by
  ) values (
    p_clinic_id, v_recommendation.id, v_attendance.patient_id,
    p_responsible_user_id, 'pendente', 'contatar', p_next_action_at, p_user_id
  ) returning id into v_queue_id;

  perform private.operacao_log(
    p_clinic_id, p_user_id, p_actor_role, p_auth_method,
    'return_recommendation', v_recommendation.id, 'return.create', p_request_id, 1
  );
  return pg_catalog.jsonb_build_object(
    'recomendacao_id', v_recommendation.id, 'fila_id', v_queue_id, 'idempotent', false
  );
end;
$function$;

create function public.operacao_atualizar_retorno(
  p_clinic_id uuid,
  p_user_id uuid,
  p_actor_role text,
  p_auth_method text,
  p_aal text,
  p_queue_id uuid,
  p_expected_version integer,
  p_status text,
  p_next_action text,
  p_next_action_at timestamptz,
  p_responsible_user_id uuid,
  p_reason text,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_queue public.retorno_fila%rowtype;
  v_fingerprint text;
begin
  perform private.operacao_assert_owner(p_clinic_id, p_user_id, p_actor_role, p_auth_method, p_aal);
  v_fingerprint := pg_catalog.md5(pg_catalog.jsonb_build_array(
    p_queue_id, p_expected_version, p_status, p_next_action, p_next_action_at,
    p_responsible_user_id, nullif(pg_catalog.btrim(p_reason), '')
  )::text);
  if private.operacao_replay_guard(
    p_clinic_id, p_request_id, 'return_queue', p_queue_id,
    'return.update', v_fingerprint
  ) then
    select * into v_queue from public.retorno_fila
    where clinic_id = p_clinic_id and id = p_queue_id;
    if not found then raise exception 'return_queue_not_found' using errcode = 'P0002'; end if;
    return pg_catalog.jsonb_build_object(
      'id', p_queue_id, 'version', v_queue.version, 'idempotent', true
    );
  end if;
  select * into v_queue from public.retorno_fila
  where clinic_id = p_clinic_id and id = p_queue_id
  for update;
  if not found then raise exception 'return_queue_not_found' using errcode = 'P0002'; end if;
  if p_expected_version is null or v_queue.version <> p_expected_version then
    raise exception 'version_conflict' using errcode = '40001';
  end if;
  if v_queue.status in ('concluido', 'cancelado', 'bloqueado') then
    raise exception 'return_queue_closed' using errcode = '42501';
  end if;
  if p_status = 'agendado' and v_queue.linked_appointment_id is null then
    raise exception 'return_appointment_required' using errcode = '23514';
  end if;
  if p_status in ('concluido', 'cancelado', 'bloqueado')
     and pg_catalog.char_length(pg_catalog.btrim(coalesce(p_reason, ''))) not between 3 and 500 then
    raise exception 'return_closure_reason_required' using errcode = '22023';
  end if;
  if p_status in ('concluido', 'cancelado', 'bloqueado')
     and (p_next_action <> 'nenhuma' or p_next_action_at is not null) then
    raise exception 'return_next_action_invalid' using errcode = '23514';
  end if;
  if p_next_action = 'nenhuma' and p_next_action_at is not null then
    raise exception 'return_next_action_invalid' using errcode = '23514';
  elsif p_next_action <> 'nenhuma' and p_next_action_at is null then
    raise exception 'return_next_action_invalid' using errcode = '23514';
  end if;
  if not exists (
    select 1 from public.clinic_members
    where clinic_id = p_clinic_id and user_id = p_responsible_user_id and status = 'active'
  ) then
    raise exception 'responsible_not_found' using errcode = 'P0002';
  end if;

  update public.retorno_fila set
    status = p_status,
    next_action = p_next_action,
    next_action_at = p_next_action_at,
    responsible_user_id = p_responsible_user_id,
    closure_reason = case when p_status in ('concluido', 'cancelado', 'bloqueado')
      then pg_catalog.btrim(p_reason) else null end,
    version = version + 1,
    updated_by = p_user_id,
    updated_at = pg_catalog.now()
  where clinic_id = p_clinic_id and id = p_queue_id
  returning * into v_queue;

  if p_status in ('cancelado', 'bloqueado') then
    update public.retorno_recomendacoes set
      status = 'cancelada', cancelled_by = p_user_id, cancelled_at = pg_catalog.now(),
      cancellation_reason = pg_catalog.btrim(p_reason), version = version + 1,
      updated_at = pg_catalog.now()
    where clinic_id = p_clinic_id and id = v_queue.recommendation_id and status = 'ativa';
  elsif p_status = 'concluido' then
    update public.retorno_recomendacoes set
      status = 'convertida', version = version + 1, updated_at = pg_catalog.now()
    where clinic_id = p_clinic_id and id = v_queue.recommendation_id and status = 'ativa';
  end if;

  perform private.operacao_log(
    p_clinic_id, p_user_id, p_actor_role, p_auth_method,
    'return_queue', p_queue_id, 'return.update', p_request_id, 1, v_fingerprint
  );
  return pg_catalog.jsonb_build_object(
    'id', p_queue_id, 'version', v_queue.version, 'idempotent', false
  );
end;
$function$;

create function public.operacao_registrar_tentativa_retorno(
  p_clinic_id uuid,
  p_user_id uuid,
  p_actor_role text,
  p_auth_method text,
  p_aal text,
  p_queue_id uuid,
  p_expected_version integer,
  p_channel text,
  p_purpose text,
  p_result text,
  p_template_reference text,
  p_next_action text,
  p_next_action_at timestamptz,
  p_attempted_at timestamptz,
  p_idempotency_key uuid,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_queue public.retorno_fila%rowtype;
  v_preference record;
  v_attempt public.retorno_tentativas%rowtype;
  v_new_status text;
  v_fingerprint text;
begin
  perform private.operacao_assert_owner(p_clinic_id, p_user_id, p_actor_role, p_auth_method, p_aal);
  if p_idempotency_key is null or p_request_id is null then
    raise exception 'required_parameter_missing' using errcode = '22023';
  end if;
  v_fingerprint := pg_catalog.md5(pg_catalog.jsonb_build_array(
    p_queue_id, p_channel, p_purpose, p_result,
    nullif(pg_catalog.btrim(p_template_reference), ''),
    p_next_action, p_next_action_at, p_attempted_at is null, p_attempted_at
  )::text);
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      p_clinic_id::text || ':return-attempt-idempotency:' || p_idempotency_key::text, 0
    )
  );
  select * into v_attempt from public.retorno_tentativas
  where clinic_id = p_clinic_id and idempotency_key = p_idempotency_key;
  if found then
    if v_attempt.payload_fingerprint <> v_fingerprint then
      raise exception 'idempotency_key_reused' using errcode = '23505';
    end if;
    return pg_catalog.jsonb_build_object('id', v_attempt.id, 'idempotent', true);
  end if;
  select * into v_queue from public.retorno_fila
  where clinic_id = p_clinic_id and id = p_queue_id
  for update;
  if not found then raise exception 'return_queue_not_found' using errcode = 'P0002'; end if;
  if p_expected_version is null or v_queue.version <> p_expected_version then
    raise exception 'version_conflict' using errcode = '40001';
  end if;
  if v_queue.status in ('concluido', 'cancelado', 'bloqueado') then
    raise exception 'return_queue_closed' using errcode = '42501';
  end if;
  if coalesce(p_attempted_at, pg_catalog.now()) > pg_catalog.now() + interval '5 minutes'
     or coalesce(p_attempted_at, pg_catalog.now()) < v_queue.created_at - interval '5 minutes' then
    raise exception 'return_attempt_date_invalid' using errcode = '23514';
  end if;
  select event.id, event.allowed into v_preference
  from public.patient_contact_preference_events event
  where event.clinic_id = p_clinic_id and event.patient_id = v_queue.patient_id
    and event.purpose = p_purpose and event.channel = p_channel
    and event.effective_at <= coalesce(p_attempted_at, pg_catalog.now())
  order by event.version desc, event.recorded_at desc, event.id desc
  limit 1;
  if not found or not v_preference.allowed then
    raise exception 'operational_contact_not_allowed' using errcode = '42501';
  end if;
  if p_next_action = 'nenhuma' and p_next_action_at is not null then
    raise exception 'return_next_action_invalid' using errcode = '23514';
  elsif p_next_action <> 'nenhuma' and p_next_action_at is null then
    raise exception 'return_next_action_invalid' using errcode = '23514';
  end if;

  insert into public.retorno_tentativas (
    clinic_id, queue_id, patient_id, channel, purpose, preference_event_id,
    result, template_reference, next_action, next_action_at,
    attempted_by, attempted_at, idempotency_key, payload_fingerprint
  ) values (
    p_clinic_id, p_queue_id, v_queue.patient_id, p_channel, p_purpose,
    v_preference.id, p_result, nullif(pg_catalog.btrim(p_template_reference), ''),
    p_next_action, p_next_action_at, p_user_id,
    coalesce(p_attempted_at, pg_catalog.now()), p_idempotency_key,
    v_fingerprint
  ) returning * into v_attempt;

  v_new_status := case
    when p_result = 'recusou' then 'cancelado'
    when p_result = 'agendou' then 'em_contato'
    when p_result = 'respondeu' then 'aguardando_paciente'
    else 'em_contato'
  end;
  update public.retorno_fila set
    status = v_new_status,
    next_action = case when p_result = 'recusou' then 'nenhuma' else p_next_action end,
    next_action_at = case when p_result = 'recusou' then null else p_next_action_at end,
    attempt_count = attempt_count + 1,
    last_attempt_at = coalesce(p_attempted_at, pg_catalog.now()),
    closure_reason = case when p_result = 'recusou' then 'Paciente recusou o retorno' else null end,
    version = version + 1,
    updated_by = p_user_id,
    updated_at = pg_catalog.now()
  where clinic_id = p_clinic_id and id = p_queue_id
  returning * into v_queue;

  if p_result = 'recusou' then
    update public.retorno_recomendacoes set
      status = 'cancelada', cancelled_by = p_user_id, cancelled_at = pg_catalog.now(),
      cancellation_reason = 'Paciente recusou o retorno', version = version + 1,
      updated_at = pg_catalog.now()
    where clinic_id = p_clinic_id and id = v_queue.recommendation_id and status = 'ativa';
  end if;

  perform private.operacao_log(
    p_clinic_id, p_user_id, p_actor_role, p_auth_method,
    'return_attempt', v_attempt.id, 'return_attempt.record', p_request_id, 1
  );
  return pg_catalog.jsonb_build_object(
    'id', v_attempt.id, 'fila_id', p_queue_id, 'fila_versao', v_queue.version,
    'idempotent', false, 'mensagem_enviada', false
  );
end;
$function$;

create function public.operacao_vincular_retorno_agendamento(
  p_clinic_id uuid,
  p_user_id uuid,
  p_actor_role text,
  p_auth_method text,
  p_aal text,
  p_queue_id uuid,
  p_expected_version integer,
  p_appointment_id uuid,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_queue public.retorno_fila%rowtype;
  v_appointment public.agendamentos_clinica%rowtype;
  v_fingerprint text;
begin
  perform private.operacao_assert_owner(p_clinic_id, p_user_id, p_actor_role, p_auth_method, p_aal);
  v_fingerprint := pg_catalog.md5(pg_catalog.jsonb_build_array(
    p_queue_id, p_expected_version, p_appointment_id
  )::text);
  if private.operacao_replay_guard(
    p_clinic_id, p_request_id, 'return_queue', p_queue_id,
    'return.link_appointment', v_fingerprint
  ) then
    select * into v_queue from public.retorno_fila
    where clinic_id = p_clinic_id and id = p_queue_id;
    if not found then raise exception 'return_queue_not_found' using errcode = 'P0002'; end if;
    return pg_catalog.jsonb_build_object(
      'id', p_queue_id, 'version', v_queue.version,
      'agendamento_id', v_queue.linked_appointment_id,
      'mensagem_enviada', false, 'idempotent', true
    );
  end if;
  select * into v_queue from public.retorno_fila
  where clinic_id = p_clinic_id and id = p_queue_id for update;
  if not found then raise exception 'return_queue_not_found' using errcode = 'P0002'; end if;
  if p_expected_version is null or v_queue.version <> p_expected_version then
    raise exception 'version_conflict' using errcode = '40001';
  end if;
  if v_queue.status in ('concluido', 'cancelado', 'bloqueado') then
    raise exception 'return_queue_closed' using errcode = '42501';
  end if;
  select * into v_appointment from public.agendamentos_clinica where id = p_appointment_id;
  if not found or v_appointment.categoria not in ('retorno', 'acompanhamento')
     or v_appointment.status = 'cancelado' then
    raise exception 'return_appointment_invalid' using errcode = '23514';
  end if;
  if not exists (
    select 1 from public.patient_source_links
    where clinic_id = p_clinic_id and patient_id = v_queue.patient_id
      and source_kind = 'agendamento' and source_id = p_appointment_id
      and status = 'confirmado'
  ) then
    raise exception 'appointment_patient_link_required' using errcode = '23514';
  end if;

  update public.retorno_fila set
    linked_appointment_id = p_appointment_id,
    status = 'agendado', next_action = 'confirmar_agenda',
    next_action_at = v_appointment.inicio_em,
    closure_reason = null, version = version + 1,
    updated_by = p_user_id, updated_at = pg_catalog.now()
  where clinic_id = p_clinic_id and id = p_queue_id
  returning * into v_queue;
  update public.retorno_recomendacoes set
    status = 'convertida', version = version + 1, updated_at = pg_catalog.now()
  where clinic_id = p_clinic_id and id = v_queue.recommendation_id and status = 'ativa';

  perform private.operacao_log(
    p_clinic_id, p_user_id, p_actor_role, p_auth_method,
    'return_queue', p_queue_id, 'return.link_appointment', p_request_id, 1,
    v_fingerprint
  );
  return pg_catalog.jsonb_build_object(
    'id', p_queue_id, 'version', v_queue.version,
    'agendamento_id', p_appointment_id, 'mensagem_enviada', false,
    'idempotent', false
  );
end;
$function$;

-- ---------------------------------------------------------------------------
-- RPCs transacionais: custo previsto, consumo real e taxas vinculadas
-- ---------------------------------------------------------------------------

create function public.operacao_registrar_ficha_custo(
  p_clinic_id uuid,
  p_user_id uuid,
  p_actor_role text,
  p_auth_method text,
  p_aal text,
  p_procedure_kind text,
  p_status text,
  p_valid_from date,
  p_reason text,
  p_items jsonb,
  p_idempotency_key uuid,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_sheet_id uuid;
  v_version integer;
  v_existing_sheet public.operacao_fichas_custo%rowtype;
  v_item jsonb;
  v_position integer;
  v_product record;
  v_product_id uuid;
  v_amount numeric(14,4);
  v_unit text;
  v_fingerprint text;
begin
  perform private.operacao_assert_owner(p_clinic_id, p_user_id, p_actor_role, p_auth_method, p_aal);
  if p_idempotency_key is null or p_request_id is null or p_valid_from is null
     or p_items is null
     or pg_catalog.jsonb_typeof(p_items) <> 'array'
     or pg_catalog.jsonb_array_length(p_items) > 100
     or (p_status in ('rascunho', 'validada') and pg_catalog.jsonb_array_length(p_items) < 1)
     or (p_status = 'retirada' and pg_catalog.jsonb_array_length(p_items) <> 0) then
    raise exception 'cost_sheet_items_invalid' using errcode = '22023';
  end if;
  v_fingerprint := pg_catalog.md5(pg_catalog.jsonb_build_array(
    pg_catalog.btrim(p_procedure_kind), p_status, p_valid_from,
    pg_catalog.btrim(p_reason), p_items
  )::text);
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      p_clinic_id::text || ':cost-sheet-idempotency:' || p_idempotency_key::text, 0
    )
  );
  select * into v_existing_sheet
  from public.operacao_fichas_custo
  where clinic_id = p_clinic_id and idempotency_key = p_idempotency_key;
  if found then
    if v_existing_sheet.payload_fingerprint <> v_fingerprint then
      raise exception 'idempotency_key_reused' using errcode = '23505';
    end if;
    return pg_catalog.jsonb_build_object(
      'id', v_existing_sheet.id, 'version', v_existing_sheet.version, 'idempotent', true
    );
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_clinic_id::text || ':cost-sheet:' || pg_catalog.btrim(p_procedure_kind), 0)
  );
  select coalesce(pg_catalog.max(version), 0) + 1 into v_version
  from public.operacao_fichas_custo
  where clinic_id = p_clinic_id and procedure_kind = pg_catalog.btrim(p_procedure_kind);

  insert into public.operacao_fichas_custo (
    clinic_id, procedure_kind, version, status, valid_from, reason,
    validated_by, validated_at, created_by, idempotency_key,
    payload_fingerprint
  ) values (
    p_clinic_id, pg_catalog.btrim(p_procedure_kind), v_version, p_status,
    p_valid_from, pg_catalog.btrim(p_reason),
    case when p_status in ('validada', 'retirada') then p_user_id else null end,
    case when p_status in ('validada', 'retirada') then pg_catalog.now() else null end,
    p_user_id, p_idempotency_key, v_fingerprint
  ) returning id into v_sheet_id;

  v_position := 0;
  for v_item in select value from pg_catalog.jsonb_array_elements(p_items)
  loop
    v_position := v_position + 1;
    begin
      v_product_id := (v_item->>'product_id')::uuid;
      v_amount := (v_item->>'amount')::numeric(14,4);
      v_unit := private.financeiro_unidade_canonica(v_item->>'unit');
    exception when others then
      raise exception 'cost_sheet_item_invalid' using errcode = '22023';
    end;
    select id, unit, active into v_product
    from public.financeiro_produtos
    where clinic_id = p_clinic_id and id = v_product_id;
    if not found or not v_product.active or v_product.unit <> v_unit
       or v_amount <= 0 or v_amount > 1000000 then
      raise exception 'cost_sheet_item_invalid' using errcode = '23514';
    end if;
    insert into public.operacao_ficha_custo_itens (
      clinic_id, cost_sheet_id, product_id, amount, unit, position
    ) values (
      p_clinic_id, v_sheet_id, v_product_id, v_amount, v_unit, v_position
    );
  end loop;

  perform private.operacao_log(
    p_clinic_id, p_user_id, p_actor_role, p_auth_method,
    'expected_cost_sheet', v_sheet_id, 'cost_sheet.version.create',
    p_request_id, v_position
  );
  return pg_catalog.jsonb_build_object(
    'id', v_sheet_id, 'version', v_version, 'item_count', v_position, 'idempotent', false
  );
end;
$function$;

create function public.operacao_registrar_evento_consumo(
  p_clinic_id uuid,
  p_user_id uuid,
  p_actor_role text,
  p_auth_method text,
  p_aal text,
  p_attendance_id uuid,
  p_product_id uuid,
  p_lot_id uuid,
  p_event_kind text,
  p_amount numeric,
  p_unit text,
  p_reason text,
  p_evidence_reference text,
  p_occurred_at timestamptz,
  p_idempotency_key uuid,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_attendance public.atendimentos_realizados%rowtype;
  v_lot public.financeiro_estoque_lotes%rowtype;
  v_balance numeric(14,4);
  v_effective_value numeric(18,6);
  v_unit_cost numeric(14,6);
  v_withdrawn numeric(14,4);
  v_returned numeric(14,4);
  v_event_id uuid := pg_catalog.gen_random_uuid();
  v_movement_id uuid := pg_catalog.gen_random_uuid();
  v_existing public.operacao_consumo_eventos%rowtype;
  v_delta numeric(14,4);
  v_canonical_unit text;
  v_fingerprint text;
begin
  perform private.operacao_assert_owner(p_clinic_id, p_user_id, p_actor_role, p_auth_method, p_aal);
  if p_idempotency_key is null or p_request_id is null or p_amount is null or p_amount <= 0
     or p_amount <> pg_catalog.round(p_amount, 4) then
    raise exception 'required_parameter_missing' using errcode = '22023';
  end if;
  v_canonical_unit := private.financeiro_unidade_canonica(p_unit);
  v_fingerprint := pg_catalog.md5(pg_catalog.jsonb_build_array(
    p_attendance_id, p_product_id, p_lot_id, p_event_kind, p_amount,
    v_canonical_unit, pg_catalog.btrim(p_reason),
    nullif(pg_catalog.btrim(p_evidence_reference), ''), p_occurred_at
  )::text);
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      p_clinic_id::text || ':consumption-idempotency:' || p_idempotency_key::text, 0
    )
  );
  select * into v_existing from public.operacao_consumo_eventos
  where clinic_id = p_clinic_id and idempotency_key = p_idempotency_key;
  if found then
    if v_existing.payload_fingerprint <> v_fingerprint then
      raise exception 'idempotency_key_reused' using errcode = '23505';
    end if;
    return pg_catalog.jsonb_build_object('id', v_existing.id, 'idempotent', true);
  end if;
  select * into v_attendance from public.atendimentos_realizados
  where clinic_id = p_clinic_id and id = p_attendance_id and archived_at is null
  for update;
  if not found then raise exception 'attendance_not_found' using errcode = 'P0002'; end if;
  if v_attendance.protocol_id is null then
    raise exception 'attendance_protocol_required' using errcode = '23514';
  end if;
  if p_occurred_at is null
     or p_occurred_at < v_attendance.attended_at - interval '12 hours'
     or p_occurred_at > pg_catalog.now() + interval '5 minutes' then
    raise exception 'consumption_event_date_invalid' using errcode = '23514';
  end if;
  select * into v_lot from public.financeiro_estoque_lotes
  where clinic_id = p_clinic_id and id = p_lot_id and product_id = p_product_id;
  if not found then raise exception 'stock_lot_not_found' using errcode = 'P0002'; end if;
  if v_canonical_unit <> v_lot.unit then
    raise exception 'stock_unit_mismatch' using errcode = '23514';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      p_clinic_id::text || ':stock:' || p_product_id::text || ':' || p_lot_id::text, 0
    )
  );

  if p_event_kind in ('perda_tecnica', 'desperdicio') then
    select quantity_balance, effective_value into v_balance, v_effective_value
    from public.financeiro_estoque_saldos
    where clinic_id = p_clinic_id and product_id = p_product_id and lot_id = p_lot_id;
    if not found or v_balance < p_amount or v_balance <= 0 then
      raise exception 'stock_insufficient' using errcode = '23514';
    end if;
    v_unit_cost := (v_effective_value / v_balance)::numeric(14,6);
    v_delta := -p_amount;
  elsif p_event_kind = 'devolucao_atendimento' then
    select
      coalesce(pg_catalog.sum(-movement.quantity_delta), 0)::numeric(14,4),
      case when pg_catalog.sum(-movement.quantity_delta) > 0 then
        (pg_catalog.sum((-movement.quantity_delta) * movement.unit_cost_effective)
          / pg_catalog.sum(-movement.quantity_delta))::numeric(14,6)
      else null end
    into v_withdrawn, v_unit_cost
    from public.financeiro_estoque_movimentos movement
    where movement.clinic_id = p_clinic_id
      and movement.protocol_id = v_attendance.protocol_id
      and movement.product_id = p_product_id and movement.lot_id = p_lot_id
      and movement.movement_kind = 'saida_procedimento'
      and not exists (
        select 1 from public.financeiro_estoque_movimentos reversal
        where reversal.clinic_id = movement.clinic_id and reversal.reversal_of_id = movement.id
      );
    select coalesce(pg_catalog.sum(quantity_delta), 0)::numeric(14,4)
    into v_returned
    from public.financeiro_estoque_movimentos
    where clinic_id = p_clinic_id and protocol_id = v_attendance.protocol_id
      and product_id = p_product_id and lot_id = p_lot_id
      and movement_kind = 'devolucao_atendimento';
    if v_unit_cost is null or p_amount > v_withdrawn - v_returned then
      raise exception 'return_quantity_exceeds_withdrawal' using errcode = '23514';
    end if;
    v_delta := p_amount;
  else
    raise exception 'consumption_event_kind_invalid' using errcode = '22023';
  end if;

  insert into public.financeiro_estoque_movimentos (
    id, clinic_id, product_id, lot_id, movement_kind, quantity_delta,
    unit, unit_cost_effective, protocol_id, source_line_id,
    actor_id, request_id, occurred_at
  ) values (
    v_movement_id, p_clinic_id, p_product_id, p_lot_id, p_event_kind,
    v_delta, v_lot.unit, v_unit_cost, v_attendance.protocol_id,
    v_event_id, p_user_id, p_request_id, p_occurred_at
  );

  insert into public.operacao_consumo_eventos (
    id, clinic_id, attendance_id, protocol_id, product_id, lot_id,
    event_kind, amount, unit, unit_cost_snapshot, stock_movement_id,
    reason, evidence_reference, occurred_at, recorded_by, idempotency_key,
    payload_fingerprint
  ) values (
    v_event_id, p_clinic_id, p_attendance_id, v_attendance.protocol_id,
    p_product_id, p_lot_id, p_event_kind, p_amount, v_lot.unit,
    v_unit_cost, v_movement_id, pg_catalog.btrim(p_reason),
    nullif(pg_catalog.btrim(p_evidence_reference), ''), p_occurred_at,
    p_user_id, p_idempotency_key, v_fingerprint
  );

  perform private.operacao_log(
    p_clinic_id, p_user_id, p_actor_role, p_auth_method,
    'consumption_event', v_event_id, 'consumption_adjustment.record', p_request_id, 1
  );
  return pg_catalog.jsonb_build_object(
    'id', v_event_id, 'movimento_estoque_id', v_movement_id,
    'custo_unitario_efetivo', v_unit_cost, 'idempotent', false
  );
end;
$function$;

create function public.operacao_registrar_taxa_pagamento(
  p_clinic_id uuid,
  p_user_id uuid,
  p_actor_role text,
  p_auth_method text,
  p_aal text,
  p_attendance_id uuid,
  p_payment_id uuid,
  p_event_kind text,
  p_amount numeric,
  p_source_kind text,
  p_source_reference text,
  p_reversal_of_id uuid,
  p_idempotency_key uuid,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_attendance public.atendimentos_realizados%rowtype;
  v_payment public.financeiro_pagamentos%rowtype;
  v_original public.atendimento_pagamento_taxas%rowtype;
  v_existing public.atendimento_pagamento_taxas%rowtype;
  v_id uuid;
  v_fingerprint text;
begin
  perform private.operacao_assert_owner(p_clinic_id, p_user_id, p_actor_role, p_auth_method, p_aal);
  if p_idempotency_key is null or p_request_id is null or p_amount is null or p_amount < 0
     or p_amount <> pg_catalog.round(p_amount, 2) then
    raise exception 'required_parameter_missing' using errcode = '22023';
  end if;
  v_fingerprint := pg_catalog.md5(pg_catalog.jsonb_build_array(
    p_attendance_id, p_payment_id, p_event_kind, p_amount, p_source_kind,
    nullif(pg_catalog.btrim(p_source_reference), ''), p_reversal_of_id
  )::text);
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      p_clinic_id::text || ':payment-fee-idempotency:' || p_idempotency_key::text, 0
    )
  );
  select * into v_existing from public.atendimento_pagamento_taxas
  where clinic_id = p_clinic_id and idempotency_key = p_idempotency_key;
  if found then
    if v_existing.payload_fingerprint <> v_fingerprint then
      raise exception 'idempotency_key_reused' using errcode = '23505';
    end if;
    return pg_catalog.jsonb_build_object('id', v_existing.id, 'idempotent', true);
  end if;
  select * into v_attendance from public.atendimentos_realizados
  where clinic_id = p_clinic_id and id = p_attendance_id and archived_at is null;
  if not found then
    raise exception 'attendance_financial_entry_required' using errcode = '23514';
  end if;
  select * into v_payment from public.financeiro_pagamentos
  where clinic_id = p_clinic_id and id = p_payment_id and movement_type = 'pagamento';
  if not found or not coalesce((
    v_payment.entry_id = v_attendance.financial_entry_id
    or exists (
      select 1 from public.atendimento_procedimentos item
      where item.clinic_id = p_clinic_id and item.attendance_id = p_attendance_id
        and item.financial_entry_id = v_payment.entry_id and item.archived_at is null
    )
  ), false) then
    raise exception 'payment_attendance_mismatch' using errcode = '23514';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      p_clinic_id::text || ':attendance-payment-fee:' || p_payment_id::text, 0
    )
  );
  if p_event_kind = 'declaracao' then
    if p_reversal_of_id is not null or p_amount > v_payment.amount then
      raise exception 'payment_fee_invalid' using errcode = '23514';
    end if;
    if exists (
      select 1
      from public.atendimento_pagamento_taxas declaration
      where declaration.clinic_id = p_clinic_id
        and declaration.attendance_id = p_attendance_id
        and declaration.payment_id = p_payment_id
        and declaration.event_kind = 'declaracao'
        and not exists (
          select 1 from public.atendimento_pagamento_taxas reversal
          where reversal.clinic_id = declaration.clinic_id
            and reversal.reversal_of_id = declaration.id
        )
    ) then
      raise exception 'payment_fee_active_exists' using errcode = '23505';
    end if;
  elsif p_event_kind = 'estorno' then
    select * into v_original from public.atendimento_pagamento_taxas
    where clinic_id = p_clinic_id and id = p_reversal_of_id
      and attendance_id = p_attendance_id and payment_id = p_payment_id
      and event_kind = 'declaracao'
    for update;
    if not found or p_amount <> v_original.amount or exists (
      select 1 from public.atendimento_pagamento_taxas
      where clinic_id = p_clinic_id and reversal_of_id = v_original.id
    ) then
      raise exception 'payment_fee_reversal_invalid' using errcode = '23514';
    end if;
  else
    raise exception 'payment_fee_event_invalid' using errcode = '22023';
  end if;

  insert into public.atendimento_pagamento_taxas (
    clinic_id, attendance_id, payment_id, event_kind, amount,
    source_kind, source_reference, reversal_of_id, recorded_by, idempotency_key,
    payload_fingerprint
  ) values (
    p_clinic_id, p_attendance_id, p_payment_id, p_event_kind, p_amount,
    p_source_kind, nullif(pg_catalog.btrim(p_source_reference), ''),
    p_reversal_of_id, p_user_id, p_idempotency_key, v_fingerprint
  ) returning id into v_id;
  perform private.operacao_log(
    p_clinic_id, p_user_id, p_actor_role, p_auth_method,
    'payment_fee', v_id, 'payment_fee.record', p_request_id, 1
  );
  return pg_catalog.jsonb_build_object('id', v_id, 'idempotent', false);
end;
$function$;


create function public.operacao_atualizar_foto_atendimento(
  p_clinic_id uuid,
  p_user_id uuid,
  p_actor_role text,
  p_auth_method text,
  p_aal text,
  p_photo_id uuid,
  p_expected_version integer,
  p_attendance_id uuid,
  p_procedure_item_id uuid,
  p_display_order integer,
  p_caption text,
  p_consumption_event_id uuid,
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
  v_attendance public.atendimentos_realizados%rowtype;
  v_consumption public.operacao_consumo_eventos%rowtype;
  v_lot public.financeiro_estoque_lotes%rowtype;
  v_previous record;
  v_caption text := nullif(pg_catalog.btrim(p_caption), '');
  v_reason text := nullif(pg_catalog.btrim(p_reason), '');
  v_order integer;
  v_fingerprint text;
begin
  perform private.operacao_assert_owner(
    p_clinic_id, p_user_id, p_actor_role, p_auth_method, p_aal
  );
  if p_photo_id is null or p_attendance_id is null or p_request_id is null
     or p_expected_version is null or p_expected_version < 1
     or v_reason is null or pg_catalog.char_length(v_reason) not between 3 and 500
     or (v_caption is not null and pg_catalog.char_length(v_caption) not between 2 and 300)
     or (p_display_order is not null and p_display_order < 1) then
    raise exception 'attendance_photo_metadata_invalid' using errcode = '22023';
  end if;
  v_fingerprint := pg_catalog.md5(pg_catalog.jsonb_build_array(
    p_photo_id, p_expected_version, p_attendance_id, p_procedure_item_id,
    p_display_order, v_caption, p_consumption_event_id
  )::text);
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      p_clinic_id::text || ':attendance-photo-operation:' || p_request_id::text, 0
    )
  );
  select audit.entity, audit.entity_id, audit.action, audit.details
  into v_previous
  from public.clinic_audit_log audit
  where audit.clinic_id = p_clinic_id and audit.request_id = p_request_id;
  if found then
    if v_previous.entity = 'protocol_photo'
       and v_previous.entity_id = p_photo_id
       and v_previous.action = 'photo.operation_update'
       and v_previous.details ->> 'route' = v_fingerprint then
      select * into v_photo from public.protocol_photos where id = p_photo_id;
      return pg_catalog.jsonb_build_object(
        'id', p_photo_id, 'version', v_photo.operation_version, 'idempotent', true
      );
    end if;
    raise exception 'operation_id_reused' using errcode = '22023';
  end if;

  select * into v_attendance
  from public.atendimentos_realizados
  where clinic_id = p_clinic_id and id = p_attendance_id and archived_at is null
  for share;
  if not found or v_attendance.protocol_id is null then
    raise exception 'attendance_protocol_required' using errcode = '23514';
  end if;
  select photo.* into v_photo
  from public.protocol_photos photo
  join public.protocols protocol on protocol.id = photo.protocol_id
  where photo.id = p_photo_id
    and protocol.clinic_id = p_clinic_id
    and photo.protocol_id = v_attendance.protocol_id
    and photo.archived_at is null
  for update of photo;
  if not found then
    raise exception 'attendance_photo_invalid' using errcode = '23514';
  end if;
  if v_photo.operation_version <> p_expected_version then
    raise exception 'version_conflict' using errcode = '40001';
  end if;
  if p_procedure_item_id is not null and not exists (
    select 1 from public.atendimento_procedimentos item
    where item.clinic_id = p_clinic_id and item.id = p_procedure_item_id
      and item.attendance_id = p_attendance_id and item.archived_at is null
  ) then
    raise exception 'attendance_procedure_not_found' using errcode = 'P0002';
  end if;
  if p_consumption_event_id is not null then
    if v_photo.phase <> 'products_used' or v_photo.product_id is null then
      raise exception 'attendance_photo_consumption_invalid' using errcode = '23514';
    end if;
    select * into v_consumption from public.operacao_consumo_eventos
    where clinic_id = p_clinic_id and id = p_consumption_event_id;
    if not found or v_consumption.attendance_id <> p_attendance_id
       or v_consumption.product_id <> v_photo.product_id then
      raise exception 'attendance_photo_consumption_invalid' using errcode = '23514';
    end if;
    if v_photo.lot_snapshot is not null then
      select * into v_lot from public.financeiro_estoque_lotes
      where clinic_id = p_clinic_id and id = v_consumption.lot_id;
      if not found or v_lot.lot <> v_photo.lot_snapshot then
        raise exception 'attendance_photo_consumption_invalid' using errcode = '23514';
      end if;
    end if;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      p_clinic_id::text || ':attendance-photo-order:' || p_attendance_id::text || ':' || v_photo.phase, 0
    )
  );
  v_order := p_display_order;
  if v_order is null then
    if v_photo.operation_updated_at is null then
      select coalesce(pg_catalog.max(photo.operation_display_order), 0) + 1
      into v_order
      from public.protocol_photos photo
      where photo.attendance_id = p_attendance_id and photo.phase = v_photo.phase
        and photo.id <> p_photo_id;
    else
      v_order := v_photo.operation_display_order;
    end if;
  end if;
  perform pg_catalog.set_config('amj.photo_operation_update', 'on', true);
  update public.protocol_photos set
    attendance_id = p_attendance_id,
    procedure_item_id = p_procedure_item_id,
    operation_display_order = v_order,
    operation_caption = v_caption,
    consumption_event_id = p_consumption_event_id,
    operation_version = operation_version + 1,
    operation_updated_by = p_user_id,
    operation_updated_at = pg_catalog.now()
  where id = p_photo_id
  returning * into v_photo;

  perform private.prontuario_log_event(
    p_clinic_id, p_user_id, p_actor_role, p_auth_method,
    'protocol_photo', p_photo_id, 'photo.operation_update',
    pg_catalog.jsonb_build_object(
      'endpoint', 'operacao-clinica-fichas',
      'route', v_fingerprint,
      'target_kind', case when p_procedure_item_id is null
        then 'attendance' else 'procedure_item' end,
      'version', v_photo.operation_version,
      'idempotent', false
    ),
    p_request_id
  );
  return pg_catalog.jsonb_build_object(
    'id', p_photo_id, 'version', v_photo.operation_version, 'idempotent', false
  );
end;
$function$;

-- ---------------------------------------------------------------------------
-- RLS e menor privilegio. O navegador nunca acessa estas relacoes diretamente.
-- ---------------------------------------------------------------------------

alter table public.atendimentos_realizados enable row level security;
alter table public.atendimento_procedimentos enable row level security;
alter table public.patient_operational_profile_events enable row level security;
alter table public.patient_contact_preference_events enable row level security;
alter table public.retorno_recomendacoes enable row level security;
alter table public.retorno_fila enable row level security;
alter table public.retorno_tentativas enable row level security;
alter table public.operacao_fichas_custo enable row level security;
alter table public.operacao_ficha_custo_itens enable row level security;
alter table public.operacao_consumo_eventos enable row level security;
alter table public.atendimento_pagamento_taxas enable row level security;

revoke all on public.atendimentos_realizados from public, anon, authenticated, service_role;
revoke all on public.atendimento_procedimentos from public, anon, authenticated, service_role;
revoke all on public.patient_operational_profile_events from public, anon, authenticated, service_role;
revoke all on public.patient_contact_preference_events from public, anon, authenticated, service_role;
revoke all on public.retorno_recomendacoes from public, anon, authenticated, service_role;
revoke all on public.retorno_fila from public, anon, authenticated, service_role;
revoke all on public.retorno_tentativas from public, anon, authenticated, service_role;
revoke all on public.operacao_fichas_custo from public, anon, authenticated, service_role;
revoke all on public.operacao_ficha_custo_itens from public, anon, authenticated, service_role;
revoke all on public.operacao_consumo_eventos from public, anon, authenticated, service_role;
revoke all on public.atendimento_pagamento_taxas from public, anon, authenticated, service_role;

revoke all on public.patient_operational_profile_current from public, anon, authenticated, service_role;
revoke all on public.patient_contact_preference_current from public, anon, authenticated, service_role;
revoke all on public.operacao_ficha_custo_atual from public, anon, authenticated, service_role;
revoke all on public.operacao_rentabilidade_atendimentos from public, anon, authenticated, service_role;
revoke all on public.operacao_rentabilidade_mensal from public, anon, authenticated, service_role;
revoke all on public.operacao_retorno_resumo_diario from public, anon, authenticated, service_role;
revoke all on public.operacao_atendimento_fotos from public, anon, authenticated, service_role;
revoke all on public.operacao_procedimentos_duplicados_revisao from public, anon, authenticated, service_role;

grant select on public.atendimentos_realizados to service_role;
grant select on public.atendimento_procedimentos to service_role;
grant select on public.patient_operational_profile_events to service_role;
grant select on public.patient_contact_preference_events to service_role;
grant select on public.retorno_recomendacoes to service_role;
grant select on public.retorno_fila to service_role;
grant select on public.retorno_tentativas to service_role;
grant select on public.operacao_fichas_custo to service_role;
grant select on public.operacao_ficha_custo_itens to service_role;
grant select on public.operacao_consumo_eventos to service_role;
grant select on public.atendimento_pagamento_taxas to service_role;
grant select on public.patient_operational_profile_current to service_role;
grant select on public.patient_contact_preference_current to service_role;
grant select on public.operacao_ficha_custo_atual to service_role;
grant select on public.operacao_rentabilidade_atendimentos to service_role;
grant select on public.operacao_rentabilidade_mensal to service_role;
grant select on public.operacao_retorno_resumo_diario to service_role;
grant select on public.operacao_atendimento_fotos to service_role;
grant select on public.operacao_procedimentos_duplicados_revisao to service_role;

revoke all on function public.operacao_salvar_atendimento(
  uuid,uuid,text,text,text,uuid,integer,uuid,uuid,uuid,uuid,text,timestamptz,smallint,text,uuid,uuid,uuid
) from public, anon, authenticated, service_role;
revoke all on function public.operacao_definir_arquivamento_atendimento(
  uuid,uuid,text,text,text,uuid,integer,boolean,text,uuid
) from public, anon, authenticated, service_role;
revoke all on function public.operacao_salvar_procedimento_atendimento(
  uuid,uuid,text,text,text,uuid,integer,uuid,uuid,text,text,timestamptz,boolean,text,uuid,uuid
) from public, anon, authenticated, service_role;
revoke all on function public.operacao_definir_arquivamento_procedimento(
  uuid,uuid,text,text,text,uuid,integer,boolean,boolean,text,text,uuid
) from public, anon, authenticated, service_role;
revoke all on function public.operacao_registrar_perfil_paciente(
  uuid,uuid,text,text,text,uuid,text,text,text,text,uuid,uuid
) from public, anon, authenticated, service_role;
revoke all on function public.operacao_registrar_preferencia_contato(
  uuid,uuid,text,text,text,uuid,text,text,boolean,text,text,text,timestamptz,uuid,uuid
) from public, anon, authenticated, service_role;
revoke all on function public.operacao_criar_retorno(
  uuid,uuid,text,text,text,uuid,text,date,date,date,text,uuid,timestamptz,uuid,uuid
) from public, anon, authenticated, service_role;
revoke all on function public.operacao_atualizar_retorno(
  uuid,uuid,text,text,text,uuid,integer,text,text,timestamptz,uuid,text,uuid
) from public, anon, authenticated, service_role;
revoke all on function public.operacao_registrar_tentativa_retorno(
  uuid,uuid,text,text,text,uuid,integer,text,text,text,text,text,timestamptz,timestamptz,uuid,uuid
) from public, anon, authenticated, service_role;
revoke all on function public.operacao_vincular_retorno_agendamento(
  uuid,uuid,text,text,text,uuid,integer,uuid,uuid
) from public, anon, authenticated, service_role;
revoke all on function public.operacao_registrar_ficha_custo(
  uuid,uuid,text,text,text,text,text,date,text,jsonb,uuid,uuid
) from public, anon, authenticated, service_role;
revoke all on function public.operacao_registrar_evento_consumo(
  uuid,uuid,text,text,text,uuid,uuid,uuid,text,numeric,text,text,text,timestamptz,uuid,uuid
) from public, anon, authenticated, service_role;
revoke all on function public.operacao_registrar_taxa_pagamento(
  uuid,uuid,text,text,text,uuid,uuid,text,numeric,text,text,uuid,uuid,uuid
) from public, anon, authenticated, service_role;
revoke all on function public.operacao_atualizar_foto_atendimento(
  uuid,uuid,text,text,text,uuid,integer,uuid,uuid,integer,text,uuid,text,uuid
) from public, anon, authenticated, service_role;

grant execute on function public.operacao_salvar_atendimento(
  uuid,uuid,text,text,text,uuid,integer,uuid,uuid,uuid,uuid,text,timestamptz,smallint,text,uuid,uuid,uuid
) to service_role;
grant execute on function public.operacao_definir_arquivamento_atendimento(
  uuid,uuid,text,text,text,uuid,integer,boolean,text,uuid
) to service_role;
grant execute on function public.operacao_salvar_procedimento_atendimento(
  uuid,uuid,text,text,text,uuid,integer,uuid,uuid,text,text,timestamptz,boolean,text,uuid,uuid
) to service_role;
grant execute on function public.operacao_definir_arquivamento_procedimento(
  uuid,uuid,text,text,text,uuid,integer,boolean,boolean,text,text,uuid
) to service_role;
grant execute on function public.operacao_registrar_perfil_paciente(
  uuid,uuid,text,text,text,uuid,text,text,text,text,uuid,uuid
) to service_role;
grant execute on function public.operacao_registrar_preferencia_contato(
  uuid,uuid,text,text,text,uuid,text,text,boolean,text,text,text,timestamptz,uuid,uuid
) to service_role;
grant execute on function public.operacao_criar_retorno(
  uuid,uuid,text,text,text,uuid,text,date,date,date,text,uuid,timestamptz,uuid,uuid
) to service_role;
grant execute on function public.operacao_atualizar_retorno(
  uuid,uuid,text,text,text,uuid,integer,text,text,timestamptz,uuid,text,uuid
) to service_role;
grant execute on function public.operacao_registrar_tentativa_retorno(
  uuid,uuid,text,text,text,uuid,integer,text,text,text,text,text,timestamptz,timestamptz,uuid,uuid
) to service_role;
grant execute on function public.operacao_vincular_retorno_agendamento(
  uuid,uuid,text,text,text,uuid,integer,uuid,uuid
) to service_role;
grant execute on function public.operacao_registrar_ficha_custo(
  uuid,uuid,text,text,text,text,text,date,text,jsonb,uuid,uuid
) to service_role;
grant execute on function public.operacao_registrar_evento_consumo(
  uuid,uuid,text,text,text,uuid,uuid,uuid,text,numeric,text,text,text,timestamptz,uuid,uuid
) to service_role;
grant execute on function public.operacao_registrar_taxa_pagamento(
  uuid,uuid,text,text,text,uuid,uuid,text,numeric,text,text,uuid,uuid,uuid
) to service_role;
grant execute on function public.operacao_atualizar_foto_atendimento(
  uuid,uuid,text,text,text,uuid,integer,uuid,uuid,integer,text,uuid,text,uuid
) to service_role;

comment on view public.operacao_rentabilidade_atendimentos is
  'Margem de contribuicao gerencial por atendimento; NULL quando qualquer fonte vinculada estiver incompleta.';
comment on view public.operacao_rentabilidade_mensal is
  'Agregado sem PII, usando somente atendimentos com receita, consumo real e taxas explicitamente vinculados.';
comment on table public.retorno_tentativas is
  'Registro append-only de contatos realizados fora do sistema; esta tabela nao dispara mensagens.';
comment on table public.patient_contact_preference_events is
  'Preferencias operacionais versionadas por finalidade e canal; marketing pertence a fluxo separado.';

commit;

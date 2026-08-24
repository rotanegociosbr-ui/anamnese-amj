begin;

-- Fonte unica para cadastros e eventos financeiros. Registros legados nunca
-- sao unidos ou apagados: repeticoes preexistentes ficam marcadas para revisao;
-- novas repeticoes exatas sao bloqueadas sob advisory lock + indice unico.

create or replace function private.financeiro_normalize_identity(p_value text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $function$
  select pg_catalog.regexp_replace(
    pg_catalog.translate(
      pg_catalog.lower(pg_catalog.btrim(coalesce(p_value, ''))),
      'áàâãäéèêëíìîïóòôõöúùûüçñ',
      'aaaaaeeeeiiiiooooouuuucn'
    ),
    '[^a-z0-9]+', '', 'g'
  );
$function$;

revoke all on function private.financeiro_normalize_identity(text)
  from public, anon, authenticated, service_role;

create or replace function private.financeiro_normalize_br_phone(p_value text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $function$
  with normalized as (
    select pg_catalog.regexp_replace(coalesce(p_value, ''), '[^0-9]+', '', 'g') as digits
  )
  select case
    when char_length(digits) in (12, 13) and pg_catalog.left(digits, 2) = '55'
      then pg_catalog.substr(digits, 3)
    else digits
  end
  from normalized;
$function$;

revoke all on function private.financeiro_normalize_br_phone(text)
  from public, anon, authenticated, service_role;

create table public.clinic_duplicate_reviews (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete restrict,
  entity_kind text not null check (entity_kind in (
    'cliente', 'fornecedor', 'marca', 'produto', 'compra',
    'lancamento', 'pagamento', 'custo_produto', 'foto_clinica'
  )),
  primary_id uuid not null,
  candidate_id uuid not null,
  match_kind text not null check (match_kind in (
    'legacy_exact', 'exact', 'possible', 'sha256_exact'
  )),
  match_key_hash text not null check (
    char_length(match_key_hash) between 16 and 128
    and match_key_hash ~ '^[a-z0-9:_-]+$'
  ),
  reason_code text not null check (reason_code ~ '^[a-z0-9_.:-]{3,100}$'),
  status text not null default 'pendente' check (status in (
    'pendente', 'confirmado_distinto', 'resolvido_existente', 'descartado'
  )),
  detected_by uuid references auth.users(id) on delete restrict,
  detected_at timestamptz not null default pg_catalog.now(),
  reviewed_by uuid references auth.users(id) on delete restrict,
  reviewed_at timestamptz,
  review_reason text check (
    review_reason is null or (
      char_length(pg_catalog.btrim(review_reason)) between 3 and 500
      and review_reason !~ '[[:cntrl:]]'
    )
  ),
  operation_id uuid,
  constraint clinic_duplicate_reviews_pair_check check (primary_id <> candidate_id),
  constraint clinic_duplicate_reviews_review_check check (
    (status = 'pendente' and reviewed_by is null and reviewed_at is null and review_reason is null)
    or
    (status <> 'pendente' and reviewed_by is not null and reviewed_at is not null and review_reason is not null)
  ),
  constraint clinic_duplicate_reviews_pair_unique unique (
    clinic_id, entity_kind, primary_id, candidate_id, match_key_hash
  ),
  constraint clinic_duplicate_reviews_operation_unique unique (clinic_id, operation_id)
);

create index clinic_duplicate_reviews_pending_idx
  on public.clinic_duplicate_reviews (clinic_id, entity_kind, detected_at desc)
  where status = 'pendente';

create or replace function private.financeiro_guard_duplicate_review()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if tg_op = 'DELETE' then
    raise exception 'duplicate_review_delete_forbidden' using errcode = '55000';
  end if;
  if pg_catalog.to_jsonb(new) - array[
       'status', 'reviewed_by', 'reviewed_at', 'review_reason', 'operation_id'
     ] is distinct from pg_catalog.to_jsonb(old) - array[
       'status', 'reviewed_by', 'reviewed_at', 'review_reason', 'operation_id'
     ] then
    raise exception 'duplicate_review_identity_immutable' using errcode = '55000';
  end if;
  if old.status <> 'pendente' then
    raise exception 'duplicate_review_already_resolved' using errcode = '55000';
  end if;
  return new;
end;
$function$;

revoke all on function private.financeiro_guard_duplicate_review()
  from public, anon, authenticated, service_role;

create trigger clinic_duplicate_reviews_guard
before update or delete on public.clinic_duplicate_reviews
for each row execute function private.financeiro_guard_duplicate_review();

alter table public.clinic_duplicate_reviews enable row level security;
revoke all on public.clinic_duplicate_reviews
  from public, anon, authenticated, service_role;
grant select, insert on public.clinic_duplicate_reviews to service_role;

-- ---------------------------------------------------------------------------
-- Chaves exatas: clientes, fornecedores, marcas e produtos/SKU.
-- ---------------------------------------------------------------------------

alter table public.patients
  add column if not exists dedup_exact_key text,
  add column if not exists dedup_possible_key text,
  add column if not exists dedup_enforced boolean not null default true;
alter table public.financeiro_fornecedores
  add column if not exists dedup_exact_key text,
  add column if not exists dedup_possible_key text,
  add column if not exists dedup_enforced boolean not null default true;
alter table public.financeiro_marcas
  add column if not exists dedup_exact_key text,
  add column if not exists dedup_enforced boolean not null default true;
alter table public.financeiro_produtos
  add column if not exists presentation text,
  add column if not exists ean text,
  add column if not exists dedup_exact_key text,
  add column if not exists dedup_possible_key text,
  add column if not exists dedup_enforced boolean not null default true;

alter table public.financeiro_produtos
  add constraint financeiro_produtos_presentation_check check (
    presentation is null or (
      char_length(pg_catalog.btrim(presentation)) between 1 and 160
      and presentation !~ '[[:cntrl:]]'
    )
  ),
  add constraint financeiro_produtos_ean_check check (
    ean is null or ean ~ '^[0-9]{8,14}$'
  );

create or replace function private.financeiro_patient_exact_key(
  p_id uuid, p_name text, p_birth_date date, p_cpf text, p_phone text, p_email text
)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $function$
  select case
    when char_length(pg_catalog.regexp_replace(coalesce(p_cpf, ''), '[^0-9]+', '', 'g')) = 11
      then 'cpf:' || pg_catalog.regexp_replace(p_cpf, '[^0-9]+', '', 'g')
    when p_birth_date is not null
      and private.financeiro_normalize_identity(p_name) <> ''
      and char_length(private.financeiro_normalize_br_phone(p_phone)) between 10 and 11
      then 'strong-phone:' || pg_catalog.md5(pg_catalog.jsonb_build_array(
        private.financeiro_normalize_identity(p_name), p_birth_date,
        private.financeiro_normalize_br_phone(p_phone)
      )::text)
    when p_birth_date is not null
      and private.financeiro_normalize_identity(p_name) <> ''
      and private.financeiro_normalize_identity(p_email) <> ''
      then 'strong-email:' || pg_catalog.md5(pg_catalog.jsonb_build_array(
        private.financeiro_normalize_identity(p_name), p_birth_date,
        private.financeiro_normalize_identity(p_email)
      )::text)
    else 'record:' || p_id::text
  end;
$function$;

create or replace function private.financeiro_supplier_exact_key(
  p_id uuid, p_name text, p_document text, p_phone text, p_email text
)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $function$
  select case
    when char_length(pg_catalog.regexp_replace(coalesce(p_document, ''), '[^0-9]+', '', 'g')) in (11, 14)
      then 'document:' || pg_catalog.regexp_replace(p_document, '[^0-9]+', '', 'g')
    when private.financeiro_normalize_identity(p_name) <> ''
      and char_length(private.financeiro_normalize_br_phone(p_phone)) between 10 and 11
      then 'strong-phone:' || pg_catalog.md5(pg_catalog.jsonb_build_array(
        private.financeiro_normalize_identity(p_name),
        private.financeiro_normalize_br_phone(p_phone)
      )::text)
    when private.financeiro_normalize_identity(p_name) <> ''
      and private.financeiro_normalize_identity(p_email) <> ''
      then 'strong-email:' || pg_catalog.md5(pg_catalog.jsonb_build_array(
        private.financeiro_normalize_identity(p_name),
        private.financeiro_normalize_identity(p_email)
      )::text)
    else 'record:' || p_id::text
  end;
$function$;

create or replace function private.financeiro_product_exact_key(
  p_id uuid, p_brand_id uuid, p_name text, p_presentation text, p_unit text,
  p_ean text, p_anvisa text
)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $function$
  select case
    when char_length(pg_catalog.regexp_replace(coalesce(p_ean, ''), '[^0-9]+', '', 'g')) between 8 and 14
      then 'ean:' || pg_catalog.regexp_replace(p_ean, '[^0-9]+', '', 'g')
    when p_brand_id is not null
      and private.financeiro_normalize_identity(p_name) <> ''
      and private.financeiro_normalize_identity(p_presentation) <> ''
      and private.financeiro_normalize_identity(p_unit) <> ''
      then 'sku:' || pg_catalog.md5(pg_catalog.jsonb_build_array(
        p_brand_id,
        private.financeiro_normalize_identity(p_name),
        private.financeiro_normalize_identity(p_presentation),
        private.financeiro_normalize_identity(p_unit),
        private.financeiro_normalize_identity(p_anvisa)
      )::text)
    else 'record:' || p_id::text
  end;
$function$;

revoke all on function private.financeiro_patient_exact_key(uuid,text,date,text,text,text)
  from public, anon, authenticated, service_role;
revoke all on function private.financeiro_supplier_exact_key(uuid,text,text,text,text)
  from public, anon, authenticated, service_role;
revoke all on function private.financeiro_product_exact_key(uuid,uuid,text,text,text,text,text)
  from public, anon, authenticated, service_role;

update public.patients
set dedup_exact_key = private.financeiro_patient_exact_key(
  id, full_name, birth_date, cpf, phone, email
), dedup_possible_key = case
  when private.financeiro_normalize_identity(full_name) = '' then null
  else 'person:' || pg_catalog.md5(pg_catalog.jsonb_build_array(
    private.financeiro_normalize_identity(full_name), birth_date
  )::text)
end;
update public.financeiro_fornecedores
set dedup_exact_key = private.financeiro_supplier_exact_key(id, name, document, phone, email),
    dedup_possible_key = case
      when private.financeiro_normalize_identity(name) = '' then null
      else 'supplier:' || pg_catalog.md5(private.financeiro_normalize_identity(name))
    end;
update public.financeiro_marcas
set dedup_exact_key = 'brand:' || private.financeiro_normalize_identity(name);
update public.financeiro_produtos
set dedup_exact_key = private.financeiro_product_exact_key(
  id, brand_id, name, presentation, unit, ean, anvisa_registration
), dedup_possible_key = case
  when brand_id is null or private.financeiro_normalize_identity(name) = '' then null
  else 'product:' || pg_catalog.md5(pg_catalog.jsonb_build_array(
    brand_id, private.financeiro_normalize_identity(name),
    private.financeiro_normalize_identity(unit)
  )::text)
end;

with ranked as (
  select id, row_number() over (
    partition by clinic_id, dedup_exact_key order by created_at, id
  ) as position
  from public.patients
)
update public.patients row
set dedup_enforced = ranked.position = 1
from ranked where ranked.id = row.id;
with ranked as (
  select id, row_number() over (
    partition by clinic_id, dedup_exact_key order by created_at, id
  ) as position
  from public.financeiro_fornecedores
)
update public.financeiro_fornecedores row
set dedup_enforced = ranked.position = 1
from ranked where ranked.id = row.id;
with ranked as (
  select id, row_number() over (
    partition by clinic_id, dedup_exact_key order by created_at, id
  ) as position
  from public.financeiro_marcas
)
update public.financeiro_marcas row
set dedup_enforced = ranked.position = 1
from ranked where ranked.id = row.id;
with ranked as (
  select id, row_number() over (
    partition by clinic_id, dedup_exact_key order by created_at, id
  ) as position
  from public.financeiro_produtos
)
update public.financeiro_produtos row
set dedup_enforced = ranked.position = 1
from ranked where ranked.id = row.id;

with ranked as (
  select clinic_id, id, dedup_exact_key,
         first_value(id) over (
           partition by clinic_id, dedup_exact_key order by created_at, id
         ) as primary_id,
         row_number() over (
           partition by clinic_id, dedup_exact_key order by created_at, id
         ) as position
  from public.patients
)
insert into public.clinic_duplicate_reviews (
  clinic_id, entity_kind, primary_id, candidate_id,
  match_kind, match_key_hash, reason_code
)
select clinic_id, 'cliente', primary_id, id, 'legacy_exact',
       'md5:' || pg_catalog.md5(dedup_exact_key), 'legacy_exact_key'
from ranked where position > 1
on conflict do nothing;
with ranked as (
  select clinic_id, id, dedup_exact_key,
         first_value(id) over (
           partition by clinic_id, dedup_exact_key order by created_at, id
         ) as primary_id,
         row_number() over (
           partition by clinic_id, dedup_exact_key order by created_at, id
         ) as position
  from public.financeiro_fornecedores
)
insert into public.clinic_duplicate_reviews (
  clinic_id, entity_kind, primary_id, candidate_id,
  match_kind, match_key_hash, reason_code
)
select clinic_id, 'fornecedor', primary_id, id, 'legacy_exact',
       'md5:' || pg_catalog.md5(dedup_exact_key), 'legacy_exact_key'
from ranked where position > 1
on conflict do nothing;
with ranked as (
  select clinic_id, id, dedup_exact_key,
         first_value(id) over (
           partition by clinic_id, dedup_exact_key order by created_at, id
         ) as primary_id,
         row_number() over (
           partition by clinic_id, dedup_exact_key order by created_at, id
         ) as position
  from public.financeiro_marcas
)
insert into public.clinic_duplicate_reviews (
  clinic_id, entity_kind, primary_id, candidate_id,
  match_kind, match_key_hash, reason_code
)
select clinic_id, 'marca', primary_id, id, 'legacy_exact',
       'md5:' || pg_catalog.md5(dedup_exact_key), 'legacy_exact_key'
from ranked where position > 1
on conflict do nothing;
with ranked as (
  select clinic_id, id, dedup_exact_key,
         first_value(id) over (
           partition by clinic_id, dedup_exact_key order by created_at, id
         ) as primary_id,
         row_number() over (
           partition by clinic_id, dedup_exact_key order by created_at, id
         ) as position
  from public.financeiro_produtos
)
insert into public.clinic_duplicate_reviews (
  clinic_id, entity_kind, primary_id, candidate_id,
  match_kind, match_key_hash, reason_code
)
select clinic_id, 'produto', primary_id, id, 'legacy_exact',
       'md5:' || pg_catalog.md5(dedup_exact_key), 'legacy_exact_key'
from ranked where position > 1
on conflict do nothing;

-- Coincidencias fracas nunca sao bloqueadas ou mescladas. Entram somente na
-- fila de revisao, preservando cada pessoa, fornecedor e SKU como registro
-- independente ate decisao humana.
with ranked as (
  select clinic_id, id, dedup_possible_key,
         first_value(id) over (
           partition by clinic_id, dedup_possible_key order by created_at, id
         ) as primary_id,
         row_number() over (
           partition by clinic_id, dedup_possible_key order by created_at, id
         ) as position
  from public.patients where dedup_possible_key is not null
)
insert into public.clinic_duplicate_reviews (
  clinic_id, entity_kind, primary_id, candidate_id,
  match_kind, match_key_hash, reason_code
)
select clinic_id, 'cliente', primary_id, id, 'possible',
       'md5:' || pg_catalog.md5(dedup_possible_key), 'possible_name_birth'
from ranked where position > 1
on conflict do nothing;

with ranked as (
  select clinic_id, id, dedup_possible_key,
         first_value(id) over (
           partition by clinic_id, dedup_possible_key order by created_at, id
         ) as primary_id,
         row_number() over (
           partition by clinic_id, dedup_possible_key order by created_at, id
         ) as position
  from public.financeiro_fornecedores where dedup_possible_key is not null
)
insert into public.clinic_duplicate_reviews (
  clinic_id, entity_kind, primary_id, candidate_id,
  match_kind, match_key_hash, reason_code
)
select clinic_id, 'fornecedor', primary_id, id, 'possible',
       'md5:' || pg_catalog.md5(dedup_possible_key), 'possible_normalized_name'
from ranked where position > 1
on conflict do nothing;

with ranked as (
  select clinic_id, id, dedup_possible_key,
         first_value(id) over (
           partition by clinic_id, dedup_possible_key order by created_at, id
         ) as primary_id,
         row_number() over (
           partition by clinic_id, dedup_possible_key order by created_at, id
         ) as position
  from public.financeiro_produtos where dedup_possible_key is not null
)
insert into public.clinic_duplicate_reviews (
  clinic_id, entity_kind, primary_id, candidate_id,
  match_kind, match_key_hash, reason_code
)
select clinic_id, 'produto', primary_id, id, 'possible',
       'md5:' || pg_catalog.md5(dedup_possible_key), 'possible_brand_name_unit'
from ranked where position > 1
on conflict do nothing;

alter table public.patients alter column dedup_exact_key set not null;
alter table public.financeiro_fornecedores alter column dedup_exact_key set not null;
alter table public.financeiro_marcas alter column dedup_exact_key set not null;
alter table public.financeiro_produtos alter column dedup_exact_key set not null;

drop index if exists public.patients_clinic_cpf_unique;
drop index if exists public.patients_clinic_phone_unique;
drop index if exists public.financeiro_fornecedores_name_unique;
drop index if exists public.financeiro_marcas_name_unique;
drop index if exists public.financeiro_produtos_name_unique;

create unique index patients_exact_source_unique
  on public.patients (clinic_id, dedup_exact_key) where dedup_enforced;
create unique index financeiro_fornecedores_exact_source_unique
  on public.financeiro_fornecedores (clinic_id, dedup_exact_key) where dedup_enforced;
create unique index financeiro_marcas_exact_source_unique
  on public.financeiro_marcas (clinic_id, dedup_exact_key) where dedup_enforced;
create unique index financeiro_produtos_exact_source_unique
  on public.financeiro_produtos (clinic_id, dedup_exact_key) where dedup_enforced;

create or replace function private.financeiro_sync_patient_dedup()
returns trigger language plpgsql set search_path = '' as $function$
declare v_key text; v_possible text; v_existing uuid;
begin
  v_key := private.financeiro_patient_exact_key(
    new.id, new.full_name, new.birth_date, new.cpf, new.phone, new.email
  );
  v_possible := case
    when private.financeiro_normalize_identity(new.full_name) = '' then null
    else 'person:' || pg_catalog.md5(pg_catalog.jsonb_build_array(
      private.financeiro_normalize_identity(new.full_name), new.birth_date
    )::text)
  end;
  if tg_op = 'INSERT' or v_key is distinct from old.dedup_exact_key then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      new.clinic_id::text || ':cliente:' || v_key, 0
    ));
    select id into v_existing from public.patients
    where clinic_id = new.clinic_id and dedup_exact_key = v_key
      and id is distinct from new.id order by created_at, id limit 1;
    if found then
      raise exception using errcode = '23505', message = 'exact_duplicate',
        detail = v_existing::text;
    end if;
    new.dedup_enforced := true;
  end if;
  if v_possible is not null then
    select id into v_existing from public.patients
    where clinic_id = new.clinic_id and dedup_possible_key = v_possible
      and id is distinct from new.id order by created_at, id limit 1;
    if found then
      insert into public.clinic_duplicate_reviews (
        clinic_id, entity_kind, primary_id, candidate_id,
        match_kind, match_key_hash, reason_code
      ) values (
        new.clinic_id, 'cliente', v_existing, new.id, 'possible',
        'md5:' || pg_catalog.md5(v_possible), 'possible_name_birth'
      ) on conflict do nothing;
    end if;
  end if;
  new.dedup_exact_key := v_key;
  new.dedup_possible_key := v_possible;
  return new;
end;
$function$;

create or replace function private.financeiro_sync_supplier_dedup()
returns trigger language plpgsql set search_path = '' as $function$
declare v_key text; v_possible text; v_existing uuid;
begin
  v_key := private.financeiro_supplier_exact_key(
    new.id, new.name, new.document, new.phone, new.email
  );
  v_possible := case
    when private.financeiro_normalize_identity(new.name) = '' then null
    else 'supplier:' || pg_catalog.md5(private.financeiro_normalize_identity(new.name))
  end;
  if tg_op = 'INSERT' or v_key is distinct from old.dedup_exact_key then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      new.clinic_id::text || ':fornecedor:' || v_key, 0
    ));
    select id into v_existing from public.financeiro_fornecedores
    where clinic_id = new.clinic_id and dedup_exact_key = v_key
      and id is distinct from new.id order by created_at, id limit 1;
    if found then
      raise exception using errcode = '23505', message = 'exact_duplicate',
        detail = v_existing::text;
    end if;
    new.dedup_enforced := true;
  end if;
  if v_possible is not null then
    select id into v_existing from public.financeiro_fornecedores
    where clinic_id = new.clinic_id and dedup_possible_key = v_possible
      and id is distinct from new.id order by created_at, id limit 1;
    if found then
      insert into public.clinic_duplicate_reviews (
        clinic_id, entity_kind, primary_id, candidate_id,
        match_kind, match_key_hash, reason_code
      ) values (
        new.clinic_id, 'fornecedor', v_existing, new.id, 'possible',
        'md5:' || pg_catalog.md5(v_possible), 'possible_normalized_name'
      ) on conflict do nothing;
    end if;
  end if;
  new.dedup_exact_key := v_key;
  new.dedup_possible_key := v_possible;
  return new;
end;
$function$;

create or replace function private.financeiro_sync_brand_dedup()
returns trigger language plpgsql set search_path = '' as $function$
declare v_key text; v_existing uuid;
begin
  v_key := 'brand:' || private.financeiro_normalize_identity(new.name);
  if tg_op = 'INSERT' or v_key is distinct from old.dedup_exact_key then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      new.clinic_id::text || ':marca:' || v_key, 0
    ));
    select id into v_existing from public.financeiro_marcas
    where clinic_id = new.clinic_id and dedup_exact_key = v_key
      and id is distinct from new.id order by created_at, id limit 1;
    if found then
      raise exception using errcode = '23505', message = 'exact_duplicate',
        detail = v_existing::text;
    end if;
    new.dedup_enforced := true;
  end if;
  new.dedup_exact_key := v_key;
  return new;
end;
$function$;

create or replace function private.financeiro_sync_product_dedup()
returns trigger language plpgsql set search_path = '' as $function$
declare v_key text; v_possible text; v_existing uuid;
begin
  if tg_op = 'INSERT'
     and nullif(pg_catalog.btrim(coalesce(new.presentation, '')), '') is null
     and nullif(pg_catalog.btrim(coalesce(new.ean, '')), '') is null then
    raise exception 'product_presentation_required' using errcode = '22023';
  end if;
  v_key := private.financeiro_product_exact_key(
    new.id, new.brand_id, new.name, new.presentation, new.unit, new.ean,
    new.anvisa_registration
  );
  v_possible := case
    when new.brand_id is null or private.financeiro_normalize_identity(new.name) = '' then null
    else 'product:' || pg_catalog.md5(pg_catalog.jsonb_build_array(
      new.brand_id, private.financeiro_normalize_identity(new.name),
      private.financeiro_normalize_identity(new.unit)
    )::text)
  end;
  if tg_op = 'INSERT' or v_key is distinct from old.dedup_exact_key then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      new.clinic_id::text || ':produto:' || v_key, 0
    ));
    select id into v_existing from public.financeiro_produtos
    where clinic_id = new.clinic_id and dedup_exact_key = v_key
      and id is distinct from new.id order by created_at, id limit 1;
    if found then
      raise exception using errcode = '23505', message = 'exact_duplicate',
        detail = v_existing::text;
    end if;
    new.dedup_enforced := true;
  end if;
  if v_possible is not null then
    select id into v_existing from public.financeiro_produtos
    where clinic_id = new.clinic_id and dedup_possible_key = v_possible
      and id is distinct from new.id order by created_at, id limit 1;
    if found then
      insert into public.clinic_duplicate_reviews (
        clinic_id, entity_kind, primary_id, candidate_id,
        match_kind, match_key_hash, reason_code
      ) values (
        new.clinic_id, 'produto', v_existing, new.id, 'possible',
        'md5:' || pg_catalog.md5(v_possible), 'possible_brand_name_unit'
      ) on conflict do nothing;
    end if;
  end if;
  new.dedup_exact_key := v_key;
  new.dedup_possible_key := v_possible;
  return new;
end;
$function$;

revoke all on function private.financeiro_sync_patient_dedup()
  from public, anon, authenticated, service_role;
revoke all on function private.financeiro_sync_supplier_dedup()
  from public, anon, authenticated, service_role;
revoke all on function private.financeiro_sync_brand_dedup()
  from public, anon, authenticated, service_role;
revoke all on function private.financeiro_sync_product_dedup()
  from public, anon, authenticated, service_role;

create trigger patients_00_dedup
before insert or update of full_name, birth_date, cpf, phone, email on public.patients
for each row execute function private.financeiro_sync_patient_dedup();
create trigger financeiro_fornecedores_00_dedup
before insert or update of name, document, phone, email on public.financeiro_fornecedores
for each row execute function private.financeiro_sync_supplier_dedup();
create trigger financeiro_marcas_00_dedup
before insert or update of name on public.financeiro_marcas
for each row execute function private.financeiro_sync_brand_dedup();
create trigger financeiro_produtos_00_dedup
before insert or update of brand_id, name, presentation, unit, ean, anvisa_registration
on public.financeiro_produtos
for each row execute function private.financeiro_sync_product_dedup();

-- A apresentacao/EAN fazem parte do SKU e, portanto, precisam participar
-- tambem da edicao protegida do produto. Substitui a assinatura anterior.
drop function if exists public.financeiro_editar_produto(
  uuid,uuid,uuid,integer,uuid,text,text,text,numeric,numeric,text,boolean,text,uuid
);

create function public.financeiro_editar_produto(
  p_clinic_id uuid, p_user_id uuid, p_product_id uuid, p_expected_version integer,
  p_brand_id uuid, p_name text, p_product_type text, p_unit text,
  p_presentation text, p_ean text, p_reference_cost numeric,
  p_sale_price numeric, p_anvisa_registration text,
  p_stock_control boolean, p_reason text, p_request_id uuid
)
returns jsonb language plpgsql set search_path = '' as $function$
declare
  v_row public.financeiro_produtos%rowtype;
  v_reason text := private.financeiro_operation_reason(p_reason);
  v_presentation text := nullif(pg_catalog.btrim(p_presentation), '');
  v_ean text := nullif(pg_catalog.regexp_replace(
    coalesce(p_ean, ''), '[^0-9]+', '', 'g'
  ), '');
begin
  if v_presentation is null
     or char_length(v_presentation) > 160
     or (v_ean is not null and char_length(v_ean) not between 8 and 14) then
    raise exception 'product_presentation_invalid' using errcode = '22023';
  end if;
  select * into v_row from public.financeiro_produtos
  where clinic_id = p_clinic_id and id = p_product_id for update;
  if not found then raise exception 'produto_nao_encontrado' using errcode = 'P0002'; end if;
  if v_row.version <> p_expected_version then raise exception 'version_conflict' using errcode = '40001'; end if;
  if v_row.archived_at is not null then raise exception 'registro_arquivado' using errcode = '55000'; end if;
  if p_brand_id is not null and not exists (
    select 1 from public.financeiro_marcas
    where clinic_id = p_clinic_id and id = p_brand_id and active and archived_at is null
  ) then raise exception 'marca_invalida' using errcode = '23503'; end if;
  update public.financeiro_produtos
  set brand_id = p_brand_id, name = pg_catalog.btrim(p_name),
      product_type = p_product_type, unit = p_unit,
      presentation = v_presentation, ean = v_ean,
      reference_cost = p_reference_cost, sale_price = p_sale_price,
      anvisa_registration = nullif(pg_catalog.btrim(p_anvisa_registration), ''),
      stock_control = p_stock_control, updated_by = p_user_id
  where clinic_id = p_clinic_id and id = p_product_id returning * into v_row;
  insert into public.financeiro_auditoria (
    clinic_id, actor_id, entity, entity_id, action, details, request_id
  ) values (
    p_clinic_id, p_user_id, 'produto', p_product_id, 'editado',
    pg_catalog.jsonb_build_object(
      'operation', 'edit', 'version', v_row.version, 'reason', v_reason,
      'mode', 'sku_presentation_changed'
    ), p_request_id
  );
  return pg_catalog.to_jsonb(v_row);
end;
$function$;

revoke all on function public.financeiro_editar_produto(
  uuid,uuid,uuid,integer,uuid,text,text,text,text,text,numeric,numeric,text,boolean,text,uuid
) from public, anon, authenticated, service_role;
grant execute on function public.financeiro_editar_produto(
  uuid,uuid,uuid,integer,uuid,text,text,text,text,text,numeric,numeric,text,boolean,text,uuid
) to service_role;

-- ---------------------------------------------------------------------------
-- Pagamentos e custos: retry continua pela idempotencia; referencias externas
-- e linhas de fonte recebem uma segunda chave exata sem colapsar parcelas.
-- ---------------------------------------------------------------------------

alter table public.financeiro_pagamentos
  add column if not exists provider text,
  add column if not exists provider_reference text,
  add column if not exists dedup_exact_key text,
  add column if not exists dedup_enforced boolean not null default true;

-- A tabela é imutável em operação normal. A migration precisa preencher
-- somente as novas chaves técnicas nas linhas legadas; a desativação fica
-- contida nesta mesma transação e o trigger é religado antes de criar o novo
-- guard de duplicidade.
alter table public.financeiro_pagamentos
  disable trigger financeiro_pagamentos_immutable;

update public.financeiro_pagamentos
set dedup_exact_key = case
    when nullif(pg_catalog.btrim(provider_reference), '') is null then null
    else movement_type || ':' ||
      private.financeiro_normalize_identity(provider) || ':' ||
      private.financeiro_normalize_identity(provider_reference)
    end;

with ranked as (
  select id, row_number() over (
    partition by clinic_id, dedup_exact_key order by created_at, id
  ) as position
  from public.financeiro_pagamentos where dedup_exact_key is not null
)
update public.financeiro_pagamentos row
set dedup_enforced = ranked.position = 1
from ranked where ranked.id = row.id;

alter table public.financeiro_pagamentos
  enable trigger financeiro_pagamentos_immutable;

with ranked as (
  select clinic_id, id, dedup_exact_key,
         first_value(id) over (
           partition by clinic_id, dedup_exact_key order by created_at, id
         ) as primary_id,
         row_number() over (
           partition by clinic_id, dedup_exact_key order by created_at, id
         ) as position
  from public.financeiro_pagamentos where dedup_exact_key is not null
)
insert into public.clinic_duplicate_reviews (
  clinic_id, entity_kind, primary_id, candidate_id,
  match_kind, match_key_hash, reason_code
)
select clinic_id, 'pagamento', primary_id, id, 'legacy_exact',
       'md5:' || pg_catalog.md5(dedup_exact_key), 'legacy_provider_reference'
from ranked where position > 1
on conflict do nothing;

create unique index financeiro_pagamentos_external_reference_unique
  on public.financeiro_pagamentos (clinic_id, dedup_exact_key)
  where dedup_exact_key is not null and dedup_enforced;

create or replace function private.financeiro_sync_payment_dedup()
returns trigger language plpgsql set search_path = '' as $function$
declare v_key text; v_existing uuid;
begin
  v_key := case
    when nullif(pg_catalog.btrim(new.provider_reference), '') is null
      then null
    else new.movement_type || ':' ||
      private.financeiro_normalize_identity(new.provider) || ':' ||
      private.financeiro_normalize_identity(new.provider_reference)
  end;
  if v_key is not null and private.financeiro_normalize_identity(new.provider) = '' then
    raise exception 'payment_provider_required' using errcode = '22023';
  end if;
  if v_key is not null and (tg_op = 'INSERT' or v_key is distinct from old.dedup_exact_key) then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      new.clinic_id::text || ':pagamento:' || v_key, 0
    ));
    select id into v_existing from public.financeiro_pagamentos
    where clinic_id = new.clinic_id and dedup_exact_key = v_key
      and id is distinct from new.id order by created_at, id limit 1;
    if found then
      raise exception using errcode = '23505', message = 'exact_duplicate',
        detail = v_existing::text;
    end if;
    new.dedup_enforced := true;
  end if;
  new.dedup_exact_key := v_key;
  return new;
end;
$function$;

revoke all on function private.financeiro_sync_payment_dedup()
  from public, anon, authenticated, service_role;
create trigger financeiro_pagamentos_00_dedup
before insert or update of movement_type, entry_id, provider,
  provider_reference, reversed_payment_id
on public.financeiro_pagamentos
for each row execute function private.financeiro_sync_payment_dedup();

-- Lancamentos manuais recorrentes podem ser legitimamente iguais; portanto o
-- fingerprint semantico nunca e UNIQUE. Retry exato continua protegido pela
-- idempotency_key e pelo lock do RPC, enquanto repeticoes semanticas vao para
-- revisao humana sem bloquear ou apagar o livro financeiro.
alter table public.financeiro_lancamentos
  add column if not exists dedup_fingerprint text;

create or replace function private.financeiro_entry_fingerprint(
  p_patient_id uuid, p_supplier_id uuid, p_entry_type text, p_origin text,
  p_description text, p_category text, p_competence_date date, p_due_date date,
  p_total numeric, p_payment_condition text, p_installments integer
)
returns text language sql immutable parallel safe set search_path = '' as $function$
  select 'entry:' || pg_catalog.md5(pg_catalog.jsonb_build_array(
    p_patient_id, p_supplier_id, p_entry_type, p_origin,
    private.financeiro_normalize_identity(p_description),
    private.financeiro_normalize_identity(p_category),
    p_competence_date, p_due_date, pg_catalog.round(p_total, 2),
    p_payment_condition, p_installments
  )::text);
$function$;

revoke all on function private.financeiro_entry_fingerprint(
  uuid,uuid,text,text,text,text,date,date,numeric,text,integer
) from public, anon, authenticated, service_role;

update public.financeiro_lancamentos
set dedup_fingerprint = private.financeiro_entry_fingerprint(
  patient_id, supplier_id, entry_type, origin, description, category,
  competence_date, due_date, total_amount, payment_condition, installments
);

with ranked as (
  select clinic_id, id, dedup_fingerprint,
         first_value(id) over (
           partition by clinic_id, dedup_fingerprint order by created_at, id
         ) as primary_id,
         row_number() over (
           partition by clinic_id, dedup_fingerprint order by created_at, id
         ) as position
  from public.financeiro_lancamentos
)
insert into public.clinic_duplicate_reviews (
  clinic_id, entity_kind, primary_id, candidate_id,
  match_kind, match_key_hash, reason_code
)
select clinic_id, 'lancamento', primary_id, id, 'possible',
       'md5:' || pg_catalog.md5(dedup_fingerprint), 'possible_semantic_entry'
from ranked where position > 1
on conflict do nothing;

create or replace function private.financeiro_sync_entry_fingerprint()
returns trigger language plpgsql set search_path = '' as $function$
declare v_existing uuid;
begin
  new.dedup_fingerprint := private.financeiro_entry_fingerprint(
    new.patient_id, new.supplier_id, new.entry_type, new.origin,
    new.description, new.category, new.competence_date, new.due_date,
    new.total_amount, new.payment_condition, new.installments
  );
  select id into v_existing
  from public.financeiro_lancamentos
  where clinic_id = new.clinic_id
    and dedup_fingerprint = new.dedup_fingerprint
    and id is distinct from new.id
  order by created_at, id limit 1;
  if found then
    insert into public.clinic_duplicate_reviews (
      clinic_id, entity_kind, primary_id, candidate_id,
      match_kind, match_key_hash, reason_code
    ) values (
      new.clinic_id, 'lancamento', v_existing, new.id, 'possible',
      'md5:' || pg_catalog.md5(new.dedup_fingerprint),
      'possible_semantic_entry'
    ) on conflict do nothing;
  end if;
  return new;
end;
$function$;

revoke all on function private.financeiro_sync_entry_fingerprint()
  from public, anon, authenticated, service_role;
create trigger financeiro_lancamentos_00_dedup
before insert on public.financeiro_lancamentos
for each row execute function private.financeiro_sync_entry_fingerprint();

alter table public.financeiro_produto_custos
  add column if not exists source_hash text,
  add column if not exists source_row_key text,
  add column if not exists dedup_exact_key text,
  add column if not exists dedup_enforced boolean not null default true;

-- Mesmo princípio do livro de pagamentos: liberar apenas o backfill técnico
-- da migration e restaurar a imutabilidade antes de concluir o esquema.
alter table public.financeiro_produto_custos
  disable trigger financeiro_produto_custos_guard;

update public.financeiro_produto_custos
set source_hash = pg_catalog.md5(private.financeiro_normalize_identity(source)),
    source_row_key = id::text;

-- Linhas legadas não possuem hash documental/linha de origem comprovável.
-- O ID vira identidade provisória para não chamar observações legítimas
-- repetidas de duplicata exata. Importadores futuros fornecem hash+linha reais.
update public.financeiro_produto_custos
set dedup_exact_key = 'cost:' || pg_catalog.md5(pg_catalog.jsonb_build_array(
  product_id, supplier_id, source_hash, source_row_key,
  cost_date, private.financeiro_normalize_identity(payment_condition),
  package_quantity, private.financeiro_normalize_identity(package_unit), total_cost
)::text);

with ranked as (
  select id, row_number() over (
    partition by clinic_id, dedup_exact_key order by created_at, id
  ) as position
  from public.financeiro_produto_custos
)
update public.financeiro_produto_custos row
set dedup_enforced = ranked.position = 1
from ranked where ranked.id = row.id;

alter table public.financeiro_produto_custos
  enable trigger financeiro_produto_custos_guard;

with ranked as (
  select clinic_id, id, dedup_exact_key,
         first_value(id) over (
           partition by clinic_id, dedup_exact_key order by created_at, id
         ) as primary_id,
         row_number() over (
           partition by clinic_id, dedup_exact_key order by created_at, id
         ) as position
  from public.financeiro_produto_custos
)
insert into public.clinic_duplicate_reviews (
  clinic_id, entity_kind, primary_id, candidate_id,
  match_kind, match_key_hash, reason_code
)
select clinic_id, 'custo_produto', primary_id, id, 'legacy_exact',
       'md5:' || pg_catalog.md5(dedup_exact_key), 'legacy_source_row'
from ranked where position > 1
on conflict do nothing;

alter table public.financeiro_produto_custos
  alter column source_hash set not null,
  alter column source_row_key set not null,
  alter column dedup_exact_key set not null;

create unique index financeiro_produto_custos_exact_source_unique
  on public.financeiro_produto_custos (clinic_id, dedup_exact_key)
  where dedup_enforced;

create or replace function private.financeiro_sync_cost_dedup()
returns trigger language plpgsql set search_path = '' as $function$
declare v_key text; v_existing uuid;
begin
  new.source_hash := coalesce(
    nullif(pg_catalog.btrim(new.source_hash), ''),
    pg_catalog.md5(private.financeiro_normalize_identity(new.source))
  );
  new.source_row_key := coalesce(
    nullif(pg_catalog.btrim(new.source_row_key), ''), new.id::text
  );
  v_key := 'cost:' || pg_catalog.md5(pg_catalog.jsonb_build_array(
    new.product_id, new.supplier_id, new.source_hash, new.source_row_key,
    new.cost_date, private.financeiro_normalize_identity(new.payment_condition),
    new.package_quantity, private.financeiro_normalize_identity(new.package_unit),
    new.total_cost
  )::text);
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    new.clinic_id::text || ':custo_produto:' || v_key, 0
  ));
  select id into v_existing from public.financeiro_produto_custos
  where clinic_id = new.clinic_id and dedup_exact_key = v_key
    and id is distinct from new.id order by created_at, id limit 1;
  if found then
    raise exception using errcode = '23505', message = 'exact_duplicate',
      detail = v_existing::text;
  end if;
  new.dedup_exact_key := v_key;
  new.dedup_enforced := true;
  return new;
end;
$function$;

revoke all on function private.financeiro_sync_cost_dedup()
  from public, anon, authenticated, service_role;
create trigger financeiro_produto_custos_00_dedup
before insert on public.financeiro_produto_custos
for each row execute function private.financeiro_sync_cost_dedup();

-- ---------------------------------------------------------------------------
-- Fotografias: SHA-256 e a identidade exata do arquivo. O RPC canonico de
-- prontuario bloqueia por padrao; uma excecao confirmada cria outra linha na
-- mesma fonte e este trigger registra a decisao, sem copiar o objeto nem unir.
-- ---------------------------------------------------------------------------

with ranked as (
  select protocol.clinic_id, photo.id, photo.sha256,
         first_value(photo.id) over (
           partition by protocol.clinic_id, photo.protocol_id, photo.sha256
           order by photo.taken_at, photo.id
         ) as primary_id,
         row_number() over (
           partition by protocol.clinic_id, photo.protocol_id, photo.sha256
           order by photo.taken_at, photo.id
         ) as position
  from public.protocol_photos photo
  join public.protocols protocol on protocol.id = photo.protocol_id
  where photo.sha256 is not null
)
insert into public.clinic_duplicate_reviews (
  clinic_id, entity_kind, primary_id, candidate_id,
  match_kind, match_key_hash, reason_code
)
select clinic_id, 'foto_clinica', primary_id, id, 'sha256_exact',
       'sha256:' || sha256, 'legacy_same_protocol_sha256'
from ranked where position > 1
on conflict do nothing;

create or replace function private.prontuario_queue_confirmed_duplicate_photo()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  v_clinic_id uuid;
begin
  if new.duplicate_of_photo_id is null then
    return new;
  end if;
  select protocol.clinic_id into v_clinic_id
  from public.protocols protocol
  where protocol.id = new.protocol_id;
  if not found then
    raise exception 'protocol_not_found' using errcode = 'P0002';
  end if;
  insert into public.clinic_duplicate_reviews (
    clinic_id, entity_kind, primary_id, candidate_id,
    match_kind, match_key_hash, reason_code, status,
    detected_by, reviewed_by, reviewed_at, review_reason, operation_id
  ) values (
    v_clinic_id, 'foto_clinica', new.duplicate_of_photo_id, new.id,
    'sha256_exact', 'sha256:' || new.sha256, 'confirmed_distinct_same_sha256',
    'confirmado_distinto', new.duplicate_confirmed_by,
    new.duplicate_confirmed_by, new.duplicate_confirmed_at,
    new.duplicate_reason, new.duplicate_operation_id
  ) on conflict do nothing;
  return new;
end;
$function$;

revoke all on function private.prontuario_queue_confirmed_duplicate_photo()
  from public, anon, authenticated, service_role;
create trigger protocol_photos_90_queue_confirmed_duplicate
after insert on public.protocol_photos
for each row execute function private.prontuario_queue_confirmed_duplicate_photo();

-- As funcoes privadas continuam inacessiveis ao navegador. O backend com
-- service_role precisa executa-las indiretamente ao manter indices/triggers e
-- ao chamar as RPCs publicas; sem estes grants a primeira gravacao falharia.
grant execute on function private.financeiro_normalize_identity(text)
  to service_role;
grant execute on function private.financeiro_normalize_br_phone(text)
  to service_role;
grant execute on function private.financeiro_patient_exact_key(uuid,text,date,text,text,text)
  to service_role;
grant execute on function private.financeiro_supplier_exact_key(uuid,text,text,text,text)
  to service_role;
grant execute on function private.financeiro_product_exact_key(uuid,uuid,text,text,text,text,text)
  to service_role;
grant execute on function private.financeiro_entry_fingerprint(
  uuid,uuid,text,text,text,text,date,date,numeric,text,integer
) to service_role;

comment on table public.clinic_duplicate_reviews is
  'Fila auditavel de repeticoes legadas/provaveis; nunca substitui a fonte canonica e nunca autoriza merge ou delete automatico.';
comment on column public.financeiro_produtos.presentation is
  'Apresentacao comercial usada na chave SKU, por exemplo 100 U, 1 mL ou caixa com 10.';
comment on column public.financeiro_produtos.ean is
  'EAN/GTIN opcional normalizado; participa da chave exata do SKU.';

commit;

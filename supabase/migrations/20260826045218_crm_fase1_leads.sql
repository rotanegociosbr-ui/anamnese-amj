begin;

-- CRM administrativo, sem dados de saude. Toda leitura chega pela Edge Function
-- crm-fichas e toda mutacao passa pelas RPCs abaixo com owner, AAL2 na borda,
-- versao otimista, idempotencia e trilha append-only.

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
-- Gestão Administrativa e outros módulos Edge-only já publicados executam
-- helpers private.* diretamente; preserve o USAGE técnico do service_role.
grant usage on schema private to service_role;

create or replace function private.crm_lock_patient_identity(p_clinic_id uuid)
returns void
language sql
set search_path = ''
as $function$
  select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'clinic:patient-identity:' || p_clinic_id::text, 0
  ));
$function$;

revoke all on function private.crm_lock_patient_identity(uuid)
  from public, anon, authenticated, service_role;

-- Um lock de identidade por clínica serializa qualquer criação/alteração de
-- paciente sem transformar correspondências prováveis em unicidade. O trigger
-- existente permanece ligado a esta função substituída e cobre todos módulos.
create or replace function private.financeiro_sync_patient_dedup()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  v_key text;
  v_possible text;
  v_existing uuid;
begin
  v_key := private.financeiro_patient_exact_key(
    new.id, new.full_name, new.birth_date, new.cpf, new.phone, new.email
  );
  v_possible := case
    when new.birth_date is null
      or private.financeiro_normalize_identity(new.full_name) = '' then null
    else 'person:' || pg_catalog.md5(pg_catalog.jsonb_build_array(
      private.financeiro_normalize_identity(new.full_name), new.birth_date
    )::text)
  end;

  if tg_op = 'INSERT' then
    perform private.crm_lock_patient_identity(new.clinic_id);
  end if;

  if tg_op = 'INSERT' or v_key is distinct from old.dedup_exact_key then
    select patient.id into v_existing
    from public.patients patient
    where patient.clinic_id = new.clinic_id
      and patient.dedup_exact_key = v_key
      and patient.id is distinct from new.id
    order by patient.created_at, patient.id
    limit 1;
    if found then
      raise exception using errcode = '23505', message = 'exact_duplicate',
        detail = v_existing::text;
    end if;
    new.dedup_enforced := true;
  end if;

  if v_possible is not null then
    select patient.id into v_existing
    from public.patients patient
    where patient.clinic_id = new.clinic_id
      and patient.dedup_possible_key = v_possible
      and patient.id is distinct from new.id
    order by patient.created_at, patient.id
    limit 1;
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

revoke all on function private.financeiro_sync_patient_dedup()
  from public, anon, authenticated, service_role;

-- O vinculo do lead convertido reutiliza o cadastro canonico de pacientes.
alter table public.patient_source_links
  drop constraint if exists patient_source_links_source_kind_check;
alter table public.patient_source_links
  add constraint patient_source_links_source_kind_check check (
    source_kind in ('anamnese', 'documento_clinico', 'agendamento', 'crm_lead')
  );

-- A fila existente tambem registra revisoes provaveis originadas no CRM.
alter table public.clinic_duplicate_reviews
  drop constraint if exists clinic_duplicate_reviews_entity_kind_check;
alter table public.clinic_duplicate_reviews
  add constraint clinic_duplicate_reviews_entity_kind_check check (entity_kind in (
    'cliente', 'fornecedor', 'marca', 'produto', 'compra',
    'lancamento', 'pagamento', 'custo_produto', 'foto_clinica', 'lead'
  ));

create table public.crm_pipeline_stages (
  code text primary key check (code ~ '^[a-z][a-z0-9_]{2,39}$'),
  label text not null check (
    char_length(pg_catalog.btrim(label)) between 2 and 80
    and label !~ '[[:cntrl:]]'
  ),
  sort_order smallint not null unique check (sort_order between 1 and 100),
  is_terminal boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default pg_catalog.now()
);

insert into public.crm_pipeline_stages (code, label, sort_order, is_terminal)
values
  ('novo', 'Novo', 1, false),
  ('primeiro_atendimento', 'Primeiro atendimento', 2, false),
  ('interessada', 'Interessada', 3, false),
  ('avaliacao_sugerida', 'Avaliação sugerida', 4, false),
  ('avaliacao_agendada', 'Avaliação agendada', 5, false),
  ('avaliacao_realizada', 'Avaliação realizada', 6, false),
  ('plano_apresentado', 'Plano apresentado', 7, false),
  ('proposta_enviada', 'Proposta enviada', 8, false),
  ('aguardando_decisao', 'Aguardando decisão', 9, false),
  ('procedimento_agendado', 'Procedimento agendado', 10, false),
  ('convertida', 'Convertida', 11, true),
  ('nao_convertida', 'Não convertida', 12, true),
  ('reativacao_futura', 'Reativação futura', 13, false);

create table public.crm_leads (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete restrict,
  full_name text not null check (
    char_length(pg_catalog.btrim(full_name)) between 2 and 160
    and full_name !~ '[[:cntrl:]]'
  ),
  birth_date date,
  cpf text check (cpf is null or cpf ~ '^[0-9]{11}$'),
  phone text check (phone is null or phone ~ '^\+55[1-9][0-9]{9,10}$'),
  email text check (
    email is null or (
      char_length(email) <= 254
      and email = pg_catalog.lower(email)
      and email ~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    )
  ),
  stage_code text not null default 'novo'
    references public.crm_pipeline_stages(code) on delete restrict,
  source text not null check (
    char_length(pg_catalog.btrim(source)) between 2 and 80
    and source !~ '[[:cntrl:]]'
  ),
  subsource text check (
    subsource is null or (
      char_length(pg_catalog.btrim(subsource)) between 1 and 120
      and subsource !~ '[[:cntrl:]]'
    )
  ),
  campaign text check (
    campaign is null or (
      char_length(pg_catalog.btrim(campaign)) between 1 and 160
      and campaign !~ '[[:cntrl:]]'
    )
  ),
  interest text not null check (
    char_length(pg_catalog.btrim(interest)) between 1 and 160
    and interest !~ '[[:cntrl:]]'
  ),
  responsible_user_id uuid not null,
  first_response_at timestamptz,
  next_action_type text check (
    next_action_type is null or next_action_type ~ '^[a-z][a-z0-9_]{1,39}$'
  ),
  next_action_at timestamptz,
  loss_reason text check (
    loss_reason is null or (
      char_length(pg_catalog.btrim(loss_reason)) between 3 and 500
      and loss_reason !~ '[[:cntrl:]]'
    )
  ),
  commercial_notes text check (
    commercial_notes is null or (
      char_length(pg_catalog.btrim(commercial_notes)) between 1 and 2000
      and commercial_notes !~ '[[:cntrl:]]'
    )
  ),
  record_status text not null default 'active' check (
    record_status in ('active', 'converted', 'lost', 'cancelled', 'archived')
  ),
  patient_id uuid,
  converted_at timestamptz,
  converted_by uuid references auth.users(id) on delete restrict,
  cancelled_at timestamptz,
  cancelled_by uuid references auth.users(id) on delete restrict,
  cancellation_reason text check (
    cancellation_reason is null or (
      char_length(pg_catalog.btrim(cancellation_reason)) between 3 and 500
      and cancellation_reason !~ '[[:cntrl:]]'
    )
  ),
  archived_at timestamptz,
  archived_by uuid references auth.users(id) on delete restrict,
  archive_reason text check (
    archive_reason is null or (
      char_length(pg_catalog.btrim(archive_reason)) between 3 and 500
      and archive_reason !~ '[[:cntrl:]]'
    )
  ),
  version integer not null default 1 check (version > 0),
  dedup_exact_key text not null,
  dedup_possible_key text,
  dedup_enforced boolean not null default true,
  idempotency_key uuid not null,
  payload_fingerprint text not null check (payload_fingerprint ~ '^[a-f0-9]{32}$'),
  created_by uuid not null references auth.users(id) on delete restrict,
  updated_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint crm_leads_clinic_id_id_key unique (clinic_id, id),
  constraint crm_leads_idempotency_unique unique (clinic_id, idempotency_key),
  constraint crm_leads_responsible_fk foreign key (clinic_id, responsible_user_id)
    references public.clinic_members(clinic_id, user_id) on delete restrict,
  constraint crm_leads_patient_fk foreign key (clinic_id, patient_id)
    references public.patients(clinic_id, id) on delete restrict,
  constraint crm_leads_contact_required check (phone is not null or email is not null),
  constraint crm_leads_stage_state_check check (
    (record_status = 'converted' and stage_code = 'convertida'
      and patient_id is not null and converted_at is not null and converted_by is not null)
    or (record_status = 'lost' and stage_code = 'nao_convertida'
      and loss_reason is not null and patient_id is null)
    or (record_status = 'active' and stage_code not in ('convertida', 'nao_convertida')
      and patient_id is null and loss_reason is null)
    or (
      record_status in ('cancelled', 'archived')
      and (
        patient_id is null
        or (
          stage_code = 'convertida' and patient_id is not null
          and converted_at is not null and converted_by is not null
        )
      )
    )
  ),
  constraint crm_leads_next_action_check check (
    (record_status = 'active' and next_action_type is not null and next_action_at is not null)
    or (record_status <> 'active' and next_action_type is null and next_action_at is null)
  ),
  constraint crm_leads_cancellation_check check (
    (record_status = 'cancelled' and cancelled_at is not null
      and cancelled_by is not null and cancellation_reason is not null)
    or (record_status <> 'cancelled' and cancelled_at is null
      and cancelled_by is null and cancellation_reason is null)
  ),
  constraint crm_leads_archive_check check (
    (record_status = 'archived' and archived_at is not null
      and archived_by is not null and archive_reason is not null)
    or (record_status <> 'archived' and archived_at is null
      and archived_by is null and archive_reason is null)
  )
);

create unique index crm_leads_exact_active_unique
  on public.crm_leads (clinic_id, dedup_exact_key)
  where dedup_enforced and record_status not in ('cancelled', 'archived');
create index crm_leads_pipeline_idx
  on public.crm_leads (clinic_id, record_status, stage_code, updated_at desc, id);
create index crm_leads_next_action_idx
  on public.crm_leads (clinic_id, next_action_at, id)
  where record_status = 'active';
create index crm_leads_responsible_idx
  on public.crm_leads (clinic_id, responsible_user_id, record_status, next_action_at);
create index crm_leads_source_idx
  on public.crm_leads (clinic_id, source, campaign, interest);
create index crm_leads_patient_idx
  on public.crm_leads (clinic_id, patient_id)
  where patient_id is not null;

create table public.crm_lead_stage_history (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete restrict,
  lead_id uuid not null,
  from_stage_code text references public.crm_pipeline_stages(code) on delete restrict,
  to_stage_code text not null references public.crm_pipeline_stages(code) on delete restrict,
  reason text check (
    reason is null or (
      char_length(pg_catalog.btrim(reason)) between 3 and 500
      and reason !~ '[[:cntrl:]]'
    )
  ),
  resulting_version integer not null check (resulting_version > 0),
  changed_by uuid not null references auth.users(id) on delete restrict,
  changed_at timestamptz not null default pg_catalog.now(),
  idempotency_key uuid not null,
  payload_fingerprint text not null check (payload_fingerprint ~ '^[a-f0-9]{32}$'),
  constraint crm_lead_stage_history_lead_fk foreign key (clinic_id, lead_id)
    references public.crm_leads(clinic_id, id) on delete restrict,
  constraint crm_lead_stage_history_operation_unique unique (clinic_id, idempotency_key),
  constraint crm_lead_stage_history_change_check check (
    from_stage_code is null or from_stage_code <> to_stage_code
  )
);

create index crm_lead_stage_history_timeline_idx
  on public.crm_lead_stage_history (clinic_id, lead_id, changed_at desc, id desc);

create table public.crm_interactions (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete restrict,
  lead_id uuid not null,
  interaction_type text not null check (
    interaction_type in ('telefone', 'whatsapp', 'email', 'presencial', 'nota_interna', 'outro')
  ),
  direction text not null check (direction in ('inbound', 'outbound', 'internal')),
  outcome text check (
    outcome is null or (
      char_length(pg_catalog.btrim(outcome)) between 2 and 120
      and outcome !~ '[[:cntrl:]]'
    )
  ),
  commercial_summary text not null check (
    char_length(pg_catalog.btrim(commercial_summary)) between 2 and 1000
    and commercial_summary !~ '[[:cntrl:]]'
  ),
  occurred_at timestamptz not null,
  resulting_version integer not null check (resulting_version > 0),
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default pg_catalog.now(),
  idempotency_key uuid not null,
  payload_fingerprint text not null check (payload_fingerprint ~ '^[a-f0-9]{32}$'),
  constraint crm_interactions_lead_fk foreign key (clinic_id, lead_id)
    references public.crm_leads(clinic_id, id) on delete restrict,
  constraint crm_interactions_operation_unique unique (clinic_id, idempotency_key)
);

create index crm_interactions_timeline_idx
  on public.crm_interactions (clinic_id, lead_id, occurred_at desc, id desc);

create table public.crm_operations (
  clinic_id uuid not null references public.clinics(id) on delete restrict,
  idempotency_key uuid not null,
  action text not null check (action ~ '^[a-z][a-z0-9_]{2,79}$'),
  entity_id uuid,
  request_fingerprint text not null check (request_fingerprint ~ '^[a-f0-9]{32}$'),
  response jsonb not null check (
    pg_catalog.jsonb_typeof(response) = 'object'
    and pg_catalog.pg_column_size(response) <= 8192
  ),
  actor_id uuid not null references auth.users(id) on delete restrict,
  request_id uuid not null,
  created_at timestamptz not null default pg_catalog.now(),
  primary key (clinic_id, idempotency_key),
  constraint crm_operations_request_unique unique (clinic_id, request_id)
);

create or replace function private.crm_audit_details_are_safe(p_details jsonb)
returns boolean
language sql
immutable
strict
parallel safe
set search_path = ''
as $function$
  select pg_catalog.jsonb_typeof(p_details) = 'object'
    and pg_catalog.pg_column_size(p_details) <= 4096
    and not exists (
      select 1
      from pg_catalog.jsonb_each(p_details) item(key, value)
      where item.key not in (
        'mode', 'reason_code', 'result_count', 'idempotent', 'version',
        'previous_status', 'new_status', 'previous_stage', 'new_stage'
      )
      or pg_catalog.jsonb_typeof(item.value) not in ('string', 'number', 'boolean', 'null')
      or (
        pg_catalog.jsonb_typeof(item.value) = 'string'
        and (
          pg_catalog.length(item.value #>> '{}') > 160
          or (item.value #>> '{}') !~ '^[A-Za-z0-9_.:/-]*$'
        )
      )
    );
$function$;

create table public.crm_audit_log (
  id bigint generated by default as identity primary key,
  clinic_id uuid not null references public.clinics(id) on delete restrict,
  actor_id uuid not null references auth.users(id) on delete restrict,
  entity text not null check (entity in ('lead', 'interaction', 'conversion')),
  entity_id uuid not null,
  action text not null check (action ~ '^[a-z][a-z0-9_]{2,79}$'),
  before_version integer check (before_version is null or before_version > 0),
  after_version integer check (after_version is null or after_version > 0),
  details jsonb not null default '{}'::jsonb check (
    pg_catalog.jsonb_typeof(details) = 'object'
    and pg_catalog.pg_column_size(details) <= 4096
    and private.crm_audit_details_are_safe(details)
  ),
  request_id uuid not null,
  idempotency_key uuid not null,
  created_at timestamptz not null default pg_catalog.now(),
  constraint crm_audit_log_operation_unique unique (clinic_id, idempotency_key)
);

revoke all on sequence public.crm_audit_log_id_seq
  from public, anon, authenticated, service_role;

create index crm_audit_log_timeline_idx
  on public.crm_audit_log (clinic_id, entity_id, created_at desc, id desc);

create or replace function private.crm_normalize_identity(p_value text)
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

create or replace function private.crm_normalize_phone(p_value text)
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
    when digits = '' then ''
    when pg_catalog.char_length(digits) in (10, 11) then '+55' || digits
    when pg_catalog.char_length(digits) in (12, 13) and pg_catalog.left(digits, 2) = '55'
      then '+' || digits
    else digits
  end
  from normalized;
$function$;

create or replace function private.crm_lead_exact_key(
  p_id uuid, p_cpf text, p_phone text, p_email text
)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $function$
  select case
    when pg_catalog.char_length(pg_catalog.regexp_replace(coalesce(p_cpf, ''), '[^0-9]+', '', 'g')) = 11
      then 'cpf:' || pg_catalog.regexp_replace(p_cpf, '[^0-9]+', '', 'g')
    when private.crm_normalize_phone(p_phone) like '+55%'
      and nullif(pg_catalog.lower(pg_catalog.btrim(coalesce(p_email, ''))), '') is not null
      then 'contact-pair:' || pg_catalog.md5(pg_catalog.jsonb_build_array(
        private.crm_normalize_phone(p_phone),
        pg_catalog.lower(pg_catalog.btrim(p_email))
      )::text)
    else 'record:' || p_id::text
  end;
$function$;

create or replace function private.crm_lead_possible_key(
  p_name text, p_birth_date date
)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $function$
  select case
    when private.crm_normalize_identity(p_name) <> '' and p_birth_date is not null
      then 'person:' || pg_catalog.md5(pg_catalog.jsonb_build_array(
        private.crm_normalize_identity(p_name), p_birth_date
      )::text)
    else null
  end;
$function$;

create or replace function private.crm_assert_owner(p_clinic_id uuid, p_actor_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if p_clinic_id is null or p_actor_id is null or not exists (
    select 1 from public.clinic_members member
    where member.clinic_id = p_clinic_id
      and member.user_id = p_actor_id
      and member.role = 'owner'
      and member.status = 'active'
  ) then
    raise exception 'crm_owner_required' using errcode = '42501';
  end if;
end;
$function$;

create or replace function private.crm_assert_responsible(
  p_clinic_id uuid, p_responsible_user_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if p_responsible_user_id is not null and not exists (
    select 1 from public.clinic_members member
    where member.clinic_id = p_clinic_id
      and member.user_id = p_responsible_user_id
      and member.status = 'active'
  ) then
    raise exception 'crm_responsible_invalid' using errcode = '23503';
  end if;
end;
$function$;

create or replace function private.crm_sync_lead_dedup()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  v_exact text;
  v_possible text;
  v_existing uuid;
begin
  v_exact := private.crm_lead_exact_key(new.id, new.cpf, new.phone, new.email);
  v_possible := private.crm_lead_possible_key(new.full_name, new.birth_date);

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'clinic:crm-lead-identity:' || new.clinic_id::text, 0
  ));

  if tg_op = 'INSERT' or v_exact is distinct from old.dedup_exact_key then
    select lead.id into v_existing
    from public.crm_leads lead
    where lead.clinic_id = new.clinic_id
      and lead.dedup_exact_key = v_exact
      and lead.dedup_enforced
      and lead.record_status not in ('cancelled', 'archived')
      and lead.id is distinct from new.id
    order by lead.created_at, lead.id
    limit 1;
    if found then
      raise exception using errcode = '23505', message = 'crm_exact_duplicate_lead',
        detail = v_existing::text;
    end if;
  end if;

  if v_possible is not null then
    select lead.id into v_existing
    from public.crm_leads lead
    where lead.clinic_id = new.clinic_id
      and lead.dedup_possible_key = v_possible
      and lead.record_status not in ('cancelled', 'archived')
      and lead.id is distinct from new.id
    order by lead.created_at, lead.id
    limit 1;
    if found then
      insert into public.clinic_duplicate_reviews (
        clinic_id, entity_kind, primary_id, candidate_id,
        match_kind, match_key_hash, reason_code, detected_by
      ) values (
        new.clinic_id, 'lead', v_existing, new.id, 'possible',
        'md5:' || pg_catalog.md5(v_possible), 'possible_name_birth', new.updated_by
      ) on conflict do nothing;
    end if;
  end if;

  new.dedup_exact_key := v_exact;
  new.dedup_possible_key := v_possible;
  return new;
end;
$function$;

create trigger crm_leads_00_dedup
before insert or update of full_name, birth_date, cpf, phone, email on public.crm_leads
for each row execute function private.crm_sync_lead_dedup();

create or replace function private.crm_forbid_delete()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  raise exception 'crm_hard_delete_forbidden' using errcode = '55000';
end;
$function$;

create or replace function private.crm_append_only()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  raise exception 'crm_append_only' using errcode = '55000';
end;
$function$;

create trigger crm_leads_no_delete
before delete on public.crm_leads
for each row execute function private.crm_forbid_delete();
create trigger crm_pipeline_stages_immutable
before update or delete on public.crm_pipeline_stages
for each row execute function private.crm_append_only();
create trigger crm_lead_stage_history_append_only
before update or delete on public.crm_lead_stage_history
for each row execute function private.crm_append_only();
create trigger crm_interactions_append_only
before update or delete on public.crm_interactions
for each row execute function private.crm_append_only();
create trigger crm_operations_append_only
before update or delete on public.crm_operations
for each row execute function private.crm_append_only();
create trigger crm_audit_log_append_only
before update or delete on public.crm_audit_log
for each row execute function private.crm_append_only();

create or replace function private.crm_replay(
  p_clinic_id uuid,
  p_idempotency_key uuid,
  p_action text,
  p_fingerprint text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_operation public.crm_operations%rowtype;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_clinic_id::text || ':crm-operation:' || p_idempotency_key::text, 0
  ));
  select * into v_operation
  from public.crm_operations operation
  where operation.clinic_id = p_clinic_id
    and operation.idempotency_key = p_idempotency_key;
  if not found then return null; end if;
  if v_operation.action is distinct from p_action
     or v_operation.request_fingerprint is distinct from p_fingerprint then
    raise exception 'crm_idempotency_key_reused' using errcode = '22023';
  end if;
  return v_operation.response || pg_catalog.jsonb_build_object('idempotent', true);
end;
$function$;

create or replace function private.crm_store_operation(
  p_clinic_id uuid, p_idempotency_key uuid, p_action text, p_entity_id uuid,
  p_fingerprint text, p_response jsonb, p_actor_id uuid, p_request_id uuid
)
returns void
language sql
security definer
set search_path = ''
as $function$
  insert into public.crm_operations (
    clinic_id, idempotency_key, action, entity_id, request_fingerprint,
    response, actor_id, request_id
  ) values (
    p_clinic_id, p_idempotency_key, p_action, p_entity_id, p_fingerprint,
    p_response, p_actor_id, p_request_id
  );
$function$;

create or replace function private.crm_audit(
  p_clinic_id uuid, p_actor_id uuid, p_entity text, p_entity_id uuid,
  p_action text, p_before_version integer, p_after_version integer,
  p_details jsonb, p_request_id uuid, p_idempotency_key uuid
)
returns void
language sql
security definer
set search_path = ''
as $function$
  insert into public.crm_audit_log (
    clinic_id, actor_id, entity, entity_id, action, before_version,
    after_version, details, request_id, idempotency_key
  ) values (
    p_clinic_id, p_actor_id, p_entity, p_entity_id, p_action, p_before_version,
    p_after_version, coalesce(p_details, '{}'::jsonb), p_request_id, p_idempotency_key
  );
$function$;

-- Uma RPC concentra as mutacoes usuais para que versao, replay, historico e
-- auditoria sejam confirmados na mesma transacao.
create or replace function public.crm_salvar_lead(
  p_action text,
  p_clinic_id uuid,
  p_actor_id uuid,
  p_lead_id uuid,
  p_expected_version integer,
  p_idempotency_key uuid,
  p_request_id uuid,
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_action text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_action, '')));
  v_payload jsonb := coalesce(p_payload, '{}'::jsonb);
  v_fingerprint text;
  v_replay jsonb;
  v_response jsonb;
  v_lead public.crm_leads%rowtype;
  v_before_version integer;
  v_id uuid;
  v_history_id uuid;
  v_interaction_id uuid;
  v_stage text;
  v_reason text;
  v_phone text;
  v_email text;
  v_cpf text;
  v_responsible uuid;
  v_next_type text;
  v_next_at timestamptz;
  v_occurred_at timestamptz;
  v_first_response_at timestamptz;
  v_previous_stage text;
  v_previous_status text;
begin
  perform private.crm_assert_owner(p_clinic_id, p_actor_id);
  if p_idempotency_key is null or p_request_id is null
     or p_expected_version is null
     or pg_catalog.jsonb_typeof(v_payload) <> 'object'
     or pg_catalog.pg_column_size(v_payload) > 16384
     or v_action not in ('create', 'update', 'change_stage', 'add_interaction', 'archive', 'cancel') then
    raise exception 'crm_invalid_parameters' using errcode = '22023';
  end if;
  if (v_action = 'create' and (p_lead_id is not null or p_expected_version <> 0))
     or (v_action <> 'create' and (p_lead_id is null or p_expected_version <= 0)) then
    raise exception 'crm_invalid_version_scope' using errcode = '22023';
  end if;

  v_fingerprint := pg_catalog.md5(pg_catalog.jsonb_build_array(
    v_action, p_lead_id, p_expected_version, v_payload
  )::text);
  v_replay := private.crm_replay(
    p_clinic_id, p_idempotency_key, v_action, v_fingerprint
  );
  if v_replay is not null then return v_replay; end if;

  if v_action = 'create' then
    v_id := pg_catalog.gen_random_uuid();
    v_stage := coalesce(nullif(v_payload ->> 'stage_code', ''), 'novo');
    if v_stage = 'convertida' then
      raise exception 'crm_initial_stage_invalid' using errcode = '22023';
    end if;
    v_phone := nullif(private.crm_normalize_phone(v_payload ->> 'phone'), '');
    v_email := nullif(pg_catalog.lower(pg_catalog.btrim(v_payload ->> 'email')), '');
    v_cpf := nullif(pg_catalog.regexp_replace(coalesce(v_payload ->> 'cpf', ''), '[^0-9]+', '', 'g'), '');
    v_responsible := coalesce(
      nullif(v_payload ->> 'responsible_user_id', '')::uuid,
      p_actor_id
    );
    v_reason := nullif(pg_catalog.btrim(v_payload ->> 'loss_reason'), '');
    v_next_type := nullif(pg_catalog.lower(pg_catalog.btrim(v_payload ->> 'next_action_type')), '');
    v_next_at := nullif(v_payload ->> 'next_action_at', '')::timestamptz;
    v_first_response_at := nullif(v_payload ->> 'first_response_at', '')::timestamptz;
    perform private.crm_assert_responsible(p_clinic_id, v_responsible);
    if nullif(pg_catalog.btrim(v_payload ->> 'full_name'), '') is null
       or nullif(pg_catalog.btrim(v_payload ->> 'source'), '') is null
       or nullif(pg_catalog.btrim(v_payload ->> 'interest'), '') is null
       or (v_phone is null and v_email is null)
       or (
         v_stage <> 'nao_convertida'
         and (v_next_type is null or v_next_at is null)
       )
       or (
         v_stage = 'nao_convertida'
         and (v_reason is null or v_next_type is not null or v_next_at is not null)
       )
       or (v_cpf is not null and pg_catalog.char_length(v_cpf) <> 11)
       or v_first_response_at > pg_catalog.clock_timestamp() + interval '5 minutes'
       or (nullif(v_payload ->> 'birth_date', '')::date
           > (pg_catalog.now() at time zone 'America/Sao_Paulo')::date) then
      raise exception 'crm_invalid_lead' using errcode = '22023';
    end if;
    insert into public.crm_leads (
      id, clinic_id, full_name, birth_date, cpf, phone, email, stage_code,
      source, subsource, campaign, interest, responsible_user_id,
      first_response_at, next_action_type, next_action_at, loss_reason,
      commercial_notes, record_status,
      dedup_exact_key, idempotency_key, payload_fingerprint, created_by, updated_by
    ) values (
      v_id, p_clinic_id, pg_catalog.btrim(v_payload ->> 'full_name'),
      nullif(v_payload ->> 'birth_date', '')::date, v_cpf, v_phone, v_email, v_stage,
      pg_catalog.btrim(v_payload ->> 'source'),
      nullif(pg_catalog.btrim(v_payload ->> 'subsource'), ''),
      nullif(pg_catalog.btrim(v_payload ->> 'campaign'), ''),
      nullif(pg_catalog.btrim(v_payload ->> 'interest'), ''), v_responsible,
      v_first_response_at,
      v_next_type, v_next_at, v_reason,
      nullif(pg_catalog.btrim(v_payload ->> 'commercial_notes'), ''),
      case when v_stage = 'nao_convertida' then 'lost' else 'active' end,
      'record:' || v_id::text, p_idempotency_key, v_fingerprint, p_actor_id, p_actor_id
    ) returning * into v_lead;

    insert into public.crm_lead_stage_history (
      clinic_id, lead_id, from_stage_code, to_stage_code, reason,
      resulting_version, changed_by, idempotency_key, payload_fingerprint
    ) values (
      p_clinic_id, v_lead.id, null, v_lead.stage_code, 'Cadastro inicial do lead.',
      v_lead.version, p_actor_id, p_idempotency_key, v_fingerprint
    ) returning id into v_history_id;
    v_response := pg_catalog.jsonb_build_object(
      'lead_id', v_lead.id, 'stage_history_id', v_history_id,
      'stage_code', v_lead.stage_code, 'status', v_lead.record_status,
      'version', v_lead.version, 'idempotent', false
    );
    perform private.crm_audit(
      p_clinic_id, p_actor_id, 'lead', v_lead.id, 'create', null, v_lead.version,
      pg_catalog.jsonb_build_object('new_status', v_lead.record_status, 'new_stage', v_lead.stage_code),
      p_request_id, p_idempotency_key
    );
  else
    select * into v_lead
    from public.crm_leads lead
    where lead.clinic_id = p_clinic_id and lead.id = p_lead_id
    for update;
    if not found then raise exception 'crm_lead_not_found' using errcode = 'P0002'; end if;
    if v_lead.version <> p_expected_version then
      raise exception 'crm_version_conflict' using errcode = '40001';
    end if;
    if v_lead.record_status in ('cancelled', 'archived')
       or (v_lead.record_status = 'converted' and v_action <> 'archive') then
      raise exception 'crm_lead_immutable' using errcode = '55000';
    end if;
    v_before_version := v_lead.version;
    v_previous_stage := v_lead.stage_code;
    v_previous_status := v_lead.record_status;

    if v_action = 'update' then
      v_phone := nullif(private.crm_normalize_phone(v_payload ->> 'phone'), '');
      v_email := nullif(pg_catalog.lower(pg_catalog.btrim(v_payload ->> 'email')), '');
      v_cpf := nullif(pg_catalog.regexp_replace(coalesce(v_payload ->> 'cpf', ''), '[^0-9]+', '', 'g'), '');
      v_responsible := coalesce(
        nullif(v_payload ->> 'responsible_user_id', '')::uuid,
        p_actor_id
      );
      v_stage := coalesce(
        nullif(pg_catalog.lower(pg_catalog.btrim(v_payload ->> 'stage_code')), ''),
        v_lead.stage_code
      );
      v_reason := nullif(pg_catalog.btrim(v_payload ->> 'loss_reason'), '');
      v_next_type := nullif(pg_catalog.lower(pg_catalog.btrim(v_payload ->> 'next_action_type')), '');
      v_next_at := nullif(v_payload ->> 'next_action_at', '')::timestamptz;
      v_first_response_at := nullif(v_payload ->> 'first_response_at', '')::timestamptz;
      perform private.crm_assert_responsible(p_clinic_id, v_responsible);
      if v_first_response_at > pg_catalog.clock_timestamp() + interval '5 minutes' then
        raise exception 'crm_first_response_in_future' using errcode = '22023';
      end if;
      if nullif(pg_catalog.btrim(v_payload ->> 'full_name'), '') is null
         or nullif(pg_catalog.btrim(v_payload ->> 'source'), '') is null
         or nullif(pg_catalog.btrim(v_payload ->> 'interest'), '') is null
         or (v_phone is null and v_email is null)
         or v_stage = 'convertida'
         or not exists (
           select 1 from public.crm_pipeline_stages stage
           where stage.code = v_stage and stage.active
         )
         or (
           v_stage <> 'nao_convertida'
           and (v_next_type is null or v_next_at is null)
         )
         or (
           v_stage = 'nao_convertida'
           and (v_next_type is not null or v_next_at is not null)
         )
         or (v_stage = 'nao_convertida' and v_reason is null)
         or (v_cpf is not null and pg_catalog.char_length(v_cpf) <> 11)
         or (nullif(v_payload ->> 'birth_date', '')::date
             > (pg_catalog.now() at time zone 'America/Sao_Paulo')::date) then
        raise exception 'crm_invalid_lead' using errcode = '22023';
      end if;
      update public.crm_leads
      set full_name = pg_catalog.btrim(v_payload ->> 'full_name'),
          birth_date = nullif(v_payload ->> 'birth_date', '')::date,
          cpf = v_cpf, phone = v_phone, email = v_email,
          source = pg_catalog.btrim(v_payload ->> 'source'),
          subsource = nullif(pg_catalog.btrim(v_payload ->> 'subsource'), ''),
          campaign = nullif(pg_catalog.btrim(v_payload ->> 'campaign'), ''),
          interest = nullif(pg_catalog.btrim(v_payload ->> 'interest'), ''),
          responsible_user_id = v_responsible,
          stage_code = v_stage,
          record_status = case when v_stage = 'nao_convertida' then 'lost' else 'active' end,
          loss_reason = case when v_stage = 'nao_convertida' then v_reason else null end,
          first_response_at = coalesce(first_response_at, v_first_response_at),
          next_action_type = v_next_type, next_action_at = v_next_at,
          commercial_notes = nullif(pg_catalog.btrim(v_payload ->> 'commercial_notes'), ''),
          version = version + 1, updated_by = p_actor_id, updated_at = pg_catalog.now()
      where clinic_id = p_clinic_id and id = p_lead_id
      returning * into v_lead;
      if v_previous_stage <> v_lead.stage_code then
        insert into public.crm_lead_stage_history (
          clinic_id, lead_id, from_stage_code, to_stage_code, reason,
          resulting_version, changed_by, idempotency_key, payload_fingerprint
        ) values (
          p_clinic_id, v_lead.id, v_previous_stage, v_lead.stage_code,
          v_reason, v_lead.version, p_actor_id, p_idempotency_key, v_fingerprint
        ) returning id into v_history_id;
      end if;
      v_response := pg_catalog.jsonb_build_object(
        'lead_id', v_lead.id, 'stage_history_id', v_history_id,
        'stage_code', v_lead.stage_code,
        'status', v_lead.record_status, 'version', v_lead.version, 'idempotent', false
      );
    elsif v_action = 'change_stage' then
      v_stage := nullif(pg_catalog.lower(pg_catalog.btrim(v_payload ->> 'stage_code')), '');
      v_reason := nullif(pg_catalog.btrim(v_payload ->> 'reason'), '');
      if v_stage is null or v_stage = 'convertida' or v_stage = v_lead.stage_code
         or not exists (
           select 1 from public.crm_pipeline_stages stage
           where stage.code = v_stage and stage.active
         ) then
        raise exception 'crm_stage_invalid' using errcode = '22023';
      end if;
      if v_stage = 'nao_convertida' then
        if v_reason is null then
          raise exception 'crm_loss_reason_required' using errcode = '22023';
        end if;
        v_next_type := null;
        v_next_at := null;
      else
        v_next_type := nullif(pg_catalog.lower(pg_catalog.btrim(v_payload ->> 'next_action_type')), '');
        v_next_at := nullif(v_payload ->> 'next_action_at', '')::timestamptz;
        if v_next_type is null or v_next_at is null then
          raise exception 'crm_next_action_required' using errcode = '22023';
        end if;
      end if;
      update public.crm_leads
      set stage_code = v_stage,
          record_status = case when v_stage = 'nao_convertida' then 'lost' else 'active' end,
          loss_reason = case when v_stage = 'nao_convertida' then v_reason else null end,
          next_action_type = v_next_type, next_action_at = v_next_at,
          version = version + 1, updated_by = p_actor_id, updated_at = pg_catalog.now()
      where clinic_id = p_clinic_id and id = p_lead_id
      returning * into v_lead;
      insert into public.crm_lead_stage_history (
        clinic_id, lead_id, from_stage_code, to_stage_code, reason,
        resulting_version, changed_by, idempotency_key, payload_fingerprint
      ) values (
        p_clinic_id, v_lead.id, v_previous_stage, v_stage, v_reason,
        v_lead.version, p_actor_id, p_idempotency_key, v_fingerprint
      ) returning id into v_history_id;
      v_response := pg_catalog.jsonb_build_object(
        'lead_id', v_lead.id, 'stage_history_id', v_history_id,
        'stage_code', v_lead.stage_code, 'status', v_lead.record_status,
        'version', v_lead.version, 'idempotent', false
      );
    elsif v_action = 'add_interaction' then
      v_occurred_at := nullif(v_payload ->> 'occurred_at', '')::timestamptz;
      if (v_payload ->> 'interaction_type') not in (
           'telefone', 'whatsapp', 'email', 'presencial', 'nota_interna', 'outro'
         ) or (v_payload ->> 'direction') not in ('inbound', 'outbound', 'internal')
         or nullif(pg_catalog.btrim(v_payload ->> 'commercial_summary'), '') is null
         or v_occurred_at is null
         or v_occurred_at > pg_catalog.clock_timestamp() + interval '5 minutes' then
        raise exception 'crm_interaction_invalid' using errcode = '22023';
      end if;
      v_next_type := nullif(pg_catalog.lower(pg_catalog.btrim(v_payload ->> 'next_action_type')), '');
      v_next_at := nullif(v_payload ->> 'next_action_at', '')::timestamptz;
      if (v_next_type is null) <> (v_next_at is null) then
        raise exception 'crm_next_action_pair_invalid' using errcode = '22023';
      end if;
      if v_lead.record_status = 'lost' and v_next_type is not null then
        raise exception 'crm_reactivation_stage_required' using errcode = '22023';
      end if;
      update public.crm_leads
      set first_response_at = case
            when (v_payload ->> 'direction') = 'outbound'
              then least(coalesce(first_response_at, v_occurred_at), v_occurred_at)
            else first_response_at
          end,
          next_action_type = coalesce(v_next_type, next_action_type),
          next_action_at = coalesce(v_next_at, next_action_at),
          version = version + 1, updated_by = p_actor_id, updated_at = pg_catalog.now()
      where clinic_id = p_clinic_id and id = p_lead_id
      returning * into v_lead;
      insert into public.crm_interactions (
        clinic_id, lead_id, interaction_type, direction, outcome,
        commercial_summary, occurred_at, resulting_version, created_by,
        idempotency_key, payload_fingerprint
      ) values (
        p_clinic_id, v_lead.id, v_payload ->> 'interaction_type',
        v_payload ->> 'direction', nullif(pg_catalog.btrim(v_payload ->> 'outcome'), ''),
        pg_catalog.btrim(v_payload ->> 'commercial_summary'), v_occurred_at,
        v_lead.version, p_actor_id, p_idempotency_key, v_fingerprint
      ) returning id into v_interaction_id;
      v_response := pg_catalog.jsonb_build_object(
        'lead_id', v_lead.id, 'interaction_id', v_interaction_id,
        'stage_code', v_lead.stage_code, 'status', v_lead.record_status,
        'version', v_lead.version, 'idempotent', false
      );
    else
      v_reason := nullif(pg_catalog.btrim(v_payload ->> 'reason'), '');
      if v_reason is null then
        raise exception 'crm_reason_required' using errcode = '22023';
      end if;
      update public.crm_leads
      set record_status = case when v_action = 'archive' then 'archived' else 'cancelled' end,
          archived_at = case when v_action = 'archive' then pg_catalog.now() else null end,
          archived_by = case when v_action = 'archive' then p_actor_id else null end,
          archive_reason = case when v_action = 'archive' then v_reason else null end,
          cancelled_at = case when v_action = 'cancel' then pg_catalog.now() else null end,
          cancelled_by = case when v_action = 'cancel' then p_actor_id else null end,
          cancellation_reason = case when v_action = 'cancel' then v_reason else null end,
          next_action_type = null, next_action_at = null,
          version = version + 1, updated_by = p_actor_id, updated_at = pg_catalog.now()
      where clinic_id = p_clinic_id and id = p_lead_id
      returning * into v_lead;
      v_response := pg_catalog.jsonb_build_object(
        'lead_id', v_lead.id, 'stage_code', v_lead.stage_code,
        'status', v_lead.record_status, 'version', v_lead.version, 'idempotent', false
      );
    end if;

    perform private.crm_audit(
      p_clinic_id, p_actor_id,
      case when v_action = 'add_interaction' then 'interaction' else 'lead' end,
      coalesce(v_interaction_id, v_lead.id), v_action,
      v_before_version, v_lead.version,
      pg_catalog.jsonb_build_object(
        'previous_status', v_previous_status,
        'new_status', v_lead.record_status, 'new_stage', v_lead.stage_code
      ), p_request_id, p_idempotency_key
    );
  end if;

  perform private.crm_store_operation(
    p_clinic_id, p_idempotency_key, v_action, v_lead.id,
    v_fingerprint, v_response, p_actor_id, p_request_id
  );
  return v_response;
end;
$function$;

create or replace function public.crm_analisar_conversao(
  p_clinic_id uuid, p_actor_id uuid, p_lead_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_lead public.crm_leads%rowtype;
  v_exact_key text;
  v_exact_id uuid;
  v_exact_label text;
  v_exact_alias text;
  v_possible jsonb := '[]'::jsonb;
  v_possible_all jsonb := '[]'::jsonb;
  v_possible_count integer := 0;
  v_candidate_fingerprint text;
begin
  perform private.crm_lock_patient_identity(p_clinic_id);
  perform private.crm_assert_owner(p_clinic_id, p_actor_id);
  select * into v_lead from public.crm_leads lead
  where lead.clinic_id = p_clinic_id and lead.id = p_lead_id;
  if not found then raise exception 'crm_lead_not_found' using errcode = 'P0002'; end if;

  v_exact_key := private.financeiro_patient_exact_key(
    v_lead.id, v_lead.full_name, v_lead.birth_date,
    v_lead.cpf, v_lead.phone, v_lead.email
  );
  select patient.id,
    'Paciente ' || pg_catalog.upper(pg_catalog.left(pg_catalog.btrim(patient.full_name), 1))
      || '*** · ' || case
        when patient.phone is not null then 'telefone final ' || pg_catalog.right(patient.phone, 4)
        when patient.email is not null then 'e-mail '
          || pg_catalog.left(patient.email, 1) || '***@'
          || pg_catalog.split_part(patient.email, '@', 2)
        when patient.birth_date is not null then 'nascimento **/'
          || pg_catalog.to_char(patient.birth_date, 'YYYY')
        else 'cadastro existente'
      end,
    'P-' || pg_catalog.upper(pg_catalog.left(pg_catalog.md5(patient.id::text), 6))
  into v_exact_id, v_exact_label, v_exact_alias
  from public.patients patient
  where patient.clinic_id = p_clinic_id and patient.archived_at is null
    and (
      (v_lead.cpf is not null and patient.cpf = v_lead.cpf)
      or (v_exact_key not like 'record:%' and patient.dedup_exact_key = v_exact_key)
    )
  order by patient.created_at, patient.id limit 1;

  select coalesce(pg_catalog.jsonb_agg(candidate order by candidate ->> 'patient_id'), '[]'::jsonb)
  into v_possible_all
  from (
    select pg_catalog.jsonb_build_object(
      'patient_id', patient.id,
      'match_kind', case
        when v_lead.phone is not null and patient.phone = v_lead.phone then 'phone'
        when v_lead.email is not null and patient.email = v_lead.email then 'email'
        else 'name_birth'
      end,
      'safe_alias', 'P-'
        || pg_catalog.upper(pg_catalog.left(pg_catalog.md5(patient.id::text), 6)),
      'safe_label', 'Paciente '
        || pg_catalog.upper(pg_catalog.left(pg_catalog.btrim(patient.full_name), 1))
        || '*** · ' || case
          when v_lead.phone is not null and patient.phone = v_lead.phone
            then 'telefone final ' || pg_catalog.right(patient.phone, 4)
          when v_lead.email is not null and patient.email = v_lead.email
            then 'e-mail ' || pg_catalog.left(patient.email, 1) || '***@'
              || pg_catalog.split_part(patient.email, '@', 2)
          when patient.birth_date is not null
            then 'nascimento **/' || pg_catalog.to_char(patient.birth_date, 'YYYY')
          else 'cadastro provável'
        end
    ) as candidate
    from public.patients patient
    where patient.clinic_id = p_clinic_id and patient.archived_at is null
      and patient.id is distinct from v_exact_id
      and (
        (v_lead.phone is not null and patient.phone = v_lead.phone)
        or (v_lead.email is not null and patient.email = v_lead.email)
        or (
          v_lead.dedup_possible_key is not null
          and patient.dedup_possible_key = v_lead.dedup_possible_key
        )
      )
    order by patient.created_at, patient.id
  ) candidates;

  v_possible_count := pg_catalog.jsonb_array_length(v_possible_all);
  select coalesce(pg_catalog.jsonb_agg(candidate.value order by candidate.ordinality), '[]'::jsonb)
  into v_possible
  from pg_catalog.jsonb_array_elements(v_possible_all) with ordinality candidate(value, ordinality)
  where candidate.ordinality <= 20;

  select pg_catalog.md5(pg_catalog.jsonb_build_array(
    v_exact_id,
    coalesce(pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_array(candidate.value ->> 'patient_id', candidate.value ->> 'match_kind')
      order by candidate.value ->> 'patient_id', candidate.value ->> 'match_kind'
    ), '[]'::jsonb)
  )::text)
  into v_candidate_fingerprint
  from pg_catalog.jsonb_array_elements(v_possible_all) candidate(value);

  return pg_catalog.jsonb_build_object(
    'lead_id', v_lead.id,
    'lead_version', v_lead.version,
    'exact_patient_id', v_exact_id,
    'exact_safe_label', v_exact_label,
    'exact_safe_alias', v_exact_alias,
    'possible_candidates', v_possible,
    'possible_count', v_possible_count,
    'has_more', v_possible_count > 20,
    'can_create_patient', v_exact_id is null and v_possible_count = 0,
    'candidate_fingerprint', v_candidate_fingerprint
  );
end;
$function$;

create or replace function public.crm_converter_lead(
  p_clinic_id uuid,
  p_actor_id uuid,
  p_lead_id uuid,
  p_expected_version integer,
  p_idempotency_key uuid,
  p_request_id uuid,
  p_patient_id uuid default null,
  p_confirm_possible_distinct boolean default false,
  p_possible_distinct_reason text default null,
  p_candidate_fingerprint text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_lead public.crm_leads%rowtype;
  v_patient public.patients%rowtype;
  v_exact_key text;
  v_exact_id uuid;
  v_possible jsonb := '[]'::jsonb;
  v_possible_count integer := 0;
  v_candidate_fingerprint text;
  v_fingerprint text;
  v_replay jsonb;
  v_response jsonb;
  v_link public.patient_source_links%rowtype;
  v_history_id uuid;
  v_patient_created boolean := false;
  v_target_is_candidate boolean := false;
  v_previous_stage text;
  v_review_count integer := 0;
  v_distinct_reason text := nullif(pg_catalog.btrim(p_possible_distinct_reason), '');
begin
  perform private.crm_lock_patient_identity(p_clinic_id);
  perform private.crm_assert_owner(p_clinic_id, p_actor_id);
  if p_lead_id is null or p_expected_version is null or p_expected_version <= 0
     or p_idempotency_key is null or p_request_id is null
     or p_candidate_fingerprint !~ '^[a-f0-9]{32}$' then
    raise exception 'crm_invalid_parameters' using errcode = '22023';
  end if;
  if coalesce(p_confirm_possible_distinct, false) and (
       v_distinct_reason is null
       or pg_catalog.char_length(v_distinct_reason) not between 3 and 500
       or v_distinct_reason ~ '[[:cntrl:]]'
     ) then
    raise exception 'crm_possible_distinct_reason_required' using errcode = '22023';
  end if;
  if not coalesce(p_confirm_possible_distinct, false) and v_distinct_reason is not null then
    raise exception 'crm_possible_distinct_reason_without_confirmation' using errcode = '22023';
  end if;
  v_fingerprint := pg_catalog.md5(pg_catalog.jsonb_build_array(
    'convert', p_lead_id, p_expected_version, p_patient_id,
    coalesce(p_confirm_possible_distinct, false),
    pg_catalog.md5(coalesce(v_distinct_reason, '')), p_candidate_fingerprint
  )::text);
  v_replay := private.crm_replay(
    p_clinic_id, p_idempotency_key, 'convert', v_fingerprint
  );
  if v_replay is not null then return v_replay; end if;

  select * into v_lead from public.crm_leads lead
  where lead.clinic_id = p_clinic_id and lead.id = p_lead_id for update;
  if not found then raise exception 'crm_lead_not_found' using errcode = 'P0002'; end if;
  if v_lead.version <> p_expected_version then
    raise exception 'crm_version_conflict' using errcode = '40001';
  end if;
  if v_lead.record_status = 'converted' then
    return pg_catalog.jsonb_build_object(
      'lead_id', v_lead.id, 'patient_id', v_lead.patient_id,
      'status', v_lead.record_status, 'stage_code', v_lead.stage_code,
      'version', v_lead.version, 'idempotent', true
    );
  end if;
  if v_lead.record_status in ('cancelled', 'archived') then
    raise exception 'crm_lead_immutable' using errcode = '55000';
  end if;
  v_previous_stage := v_lead.stage_code;

  v_exact_key := private.financeiro_patient_exact_key(
    v_lead.id, v_lead.full_name, v_lead.birth_date,
    v_lead.cpf, v_lead.phone, v_lead.email
  );
  select patient.id into v_exact_id
  from public.patients patient
  where patient.clinic_id = p_clinic_id and patient.archived_at is null
    and (
      (v_lead.cpf is not null and patient.cpf = v_lead.cpf)
      or (v_exact_key not like 'record:%' and patient.dedup_exact_key = v_exact_key)
    )
  order by patient.created_at, patient.id limit 1
  for update;

  select coalesce(pg_catalog.jsonb_agg(candidate order by candidate ->> 'patient_id'), '[]'::jsonb)
  into v_possible
  from (
    select pg_catalog.jsonb_build_object(
      'patient_id', patient.id,
      'match_kind', case
        when v_lead.phone is not null and patient.phone = v_lead.phone then 'phone'
        when v_lead.email is not null and patient.email = v_lead.email then 'email'
        else 'name_birth'
      end
    ) as candidate
    from public.patients patient
    where patient.clinic_id = p_clinic_id and patient.archived_at is null
      and patient.id is distinct from v_exact_id
      and (
        (v_lead.phone is not null and patient.phone = v_lead.phone)
        or (v_lead.email is not null and patient.email = v_lead.email)
        or (
          v_lead.dedup_possible_key is not null
          and patient.dedup_possible_key = v_lead.dedup_possible_key
        )
      )
    order by patient.created_at, patient.id
  ) candidates;
  v_possible_count := pg_catalog.jsonb_array_length(v_possible);

  select pg_catalog.md5(pg_catalog.jsonb_build_array(
    v_exact_id,
    coalesce(pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_array(candidate.value ->> 'patient_id', candidate.value ->> 'match_kind')
      order by candidate.value ->> 'patient_id', candidate.value ->> 'match_kind'
    ), '[]'::jsonb)
  )::text)
  into v_candidate_fingerprint
  from pg_catalog.jsonb_array_elements(v_possible) candidate(value);
  if v_candidate_fingerprint is distinct from p_candidate_fingerprint then
    raise exception 'crm_reanalysis_required' using errcode = '40001';
  end if;
  if coalesce(p_confirm_possible_distinct, false) and (
       p_patient_id is not null or v_exact_id is not null or v_possible_count = 0
     ) then
    raise exception 'crm_possible_distinct_confirmation_invalid' using errcode = '22023';
  end if;
  if v_possible_count > 20 and (
       p_patient_id is not null or coalesce(p_confirm_possible_distinct, false)
     ) then
    raise exception 'crm_candidate_set_too_large' using errcode = '54000';
  end if;

  if p_patient_id is not null then
    select * into v_patient from public.patients patient
    where patient.clinic_id = p_clinic_id and patient.id = p_patient_id
      and patient.archived_at is null for update;
    if not found then raise exception 'crm_patient_not_found' using errcode = 'P0002'; end if;
    v_target_is_candidate := p_patient_id = v_exact_id or exists (
      select 1 from pg_catalog.jsonb_array_elements(v_possible) candidate
      where candidate ->> 'patient_id' = p_patient_id::text
    );
    if not v_target_is_candidate then
      raise exception 'crm_patient_not_candidate' using errcode = '22023';
    end if;
    if v_exact_id is not null and p_patient_id <> v_exact_id then
      raise exception 'crm_exact_patient_conflict' using errcode = '23505';
    end if;
  elsif v_exact_id is not null then
    select * into v_patient from public.patients patient
    where patient.clinic_id = p_clinic_id and patient.id = v_exact_id for update;
  elsif v_possible_count > 0 and not coalesce(p_confirm_possible_distinct, false) then
    v_response := pg_catalog.jsonb_build_object(
      'lead_id', v_lead.id, 'match_status', 'possible_duplicate',
      'possible_candidates', v_possible, 'possible_count', v_possible_count,
      'version', v_lead.version, 'idempotent', false
    );
    perform private.crm_audit(
      p_clinic_id, p_actor_id, 'conversion', v_lead.id, 'possible_duplicate',
      v_lead.version, v_lead.version,
      pg_catalog.jsonb_build_object('result_count', v_possible_count, 'mode', 'review_required'),
      p_request_id, p_idempotency_key
    );
    perform private.crm_store_operation(
      p_clinic_id, p_idempotency_key, 'convert', v_lead.id,
      v_fingerprint, v_response, p_actor_id, p_request_id
    );
    return v_response;
  else
    insert into public.patients (
      clinic_id, full_name, search_name, birth_date, cpf, phone, email,
      status, idempotency_key, created_by, updated_by
    ) values (
      p_clinic_id, v_lead.full_name,
      nullif(pg_catalog.regexp_replace(
        pg_catalog.translate(pg_catalog.lower(pg_catalog.btrim(v_lead.full_name)),
          'áàâãäéèêëíìîïóòôõöúùûüçñ', 'aaaaaeeeeiiiiooooouuuucn'),
        '[^a-z0-9 ]+', ' ', 'g'
      ), ''),
      v_lead.birth_date, v_lead.cpf, v_lead.phone, v_lead.email,
      'active', p_idempotency_key, p_actor_id, p_actor_id
    ) returning * into v_patient;
    v_patient_created := true;
  end if;

  if v_patient_created and v_possible_count > 0
     and coalesce(p_confirm_possible_distinct, false) then
    -- O trigger canônico materializa nome+nascimento. Telefone e e-mail também
    -- precisam de uma decisão persistida; crie uma revisão por candidato/kind.
    insert into public.clinic_duplicate_reviews (
      clinic_id, entity_kind, primary_id, candidate_id,
      match_kind, match_key_hash, reason_code, detected_by
    )
    select
      p_clinic_id, 'cliente', (candidate.value ->> 'patient_id')::uuid,
      v_patient.id, 'possible',
      case candidate.value ->> 'match_kind'
        when 'name_birth' then 'md5:' || pg_catalog.md5(v_lead.dedup_possible_key)
        else 'md5:' || pg_catalog.md5(pg_catalog.jsonb_build_array(
          v_lead.id, candidate.value ->> 'patient_id', candidate.value ->> 'match_kind'
        )::text)
      end,
      case candidate.value ->> 'match_kind'
        when 'phone' then 'possible_phone'
        when 'email' then 'possible_email'
        when 'name_birth' then 'possible_name_birth'
        else 'possible_candidate'
      end,
      p_actor_id
    from pg_catalog.jsonb_array_elements(v_possible) candidate(value)
    where not exists (
      select 1
      from public.clinic_duplicate_reviews existing
      where existing.clinic_id = p_clinic_id
        and existing.entity_kind = 'cliente'
        and existing.primary_id = (candidate.value ->> 'patient_id')::uuid
        and existing.candidate_id = v_patient.id
    )
    on conflict do nothing;

    update public.clinic_duplicate_reviews review
    set status = 'confirmado_distinto',
        reviewed_by = p_actor_id,
        reviewed_at = pg_catalog.now(),
        review_reason = v_distinct_reason,
        operation_id = pg_catalog.md5(
          p_idempotency_key::text || ':duplicate-review:' || review.id::text
        )::uuid,
        version = review.version + 1
    where review.clinic_id = p_clinic_id
      and review.entity_kind = 'cliente'
      and review.candidate_id = v_patient.id
      and review.status = 'pendente'
      and exists (
        select 1
        from pg_catalog.jsonb_array_elements(v_possible) candidate(value)
        where candidate.value ->> 'patient_id' = review.primary_id::text
      );
    get diagnostics v_review_count = row_count;

    if v_review_count <> v_possible_count or exists (
      select 1
      from pg_catalog.jsonb_array_elements(v_possible) candidate(value)
      where (
        select pg_catalog.count(*)
        from public.clinic_duplicate_reviews review
        where review.clinic_id = p_clinic_id
          and review.entity_kind = 'cliente'
          and review.primary_id = (candidate.value ->> 'patient_id')::uuid
          and review.candidate_id = v_patient.id
          and review.status = 'confirmado_distinto'
          and review.reviewed_by = p_actor_id
          and review.review_reason = v_distinct_reason
          and review.operation_id is not null
      ) <> 1
    ) then
      raise exception 'crm_possible_distinct_decision_not_persisted' using errcode = '55000';
    end if;
  end if;

  select * into v_link from public.patient_source_links link
  where link.clinic_id = p_clinic_id
    and link.source_kind = 'crm_lead' and link.source_id = v_lead.id
  for update;
  if found and v_link.patient_id <> v_patient.id then
    raise exception 'crm_lead_already_linked' using errcode = '23505';
  elsif not found then
    insert into public.patient_source_links (
      clinic_id, patient_id, source_kind, source_id, match_method, status,
      confirmed_by, confirmed_at, reason, idempotency_key
    ) values (
      p_clinic_id, v_patient.id, 'crm_lead', v_lead.id,
      case when v_lead.cpf is not null and v_patient.cpf = v_lead.cpf
        then 'cpf_confirmado' else 'manual' end,
      'confirmado', p_actor_id, pg_catalog.now(),
      'Vínculo confirmado na conversão administrativa do CRM.', p_idempotency_key
    ) returning * into v_link;
  end if;

  update public.crm_leads
  set stage_code = 'convertida', record_status = 'converted',
      patient_id = v_patient.id, converted_at = pg_catalog.now(), converted_by = p_actor_id,
      loss_reason = null, next_action_type = null, next_action_at = null,
      version = version + 1, updated_by = p_actor_id, updated_at = pg_catalog.now()
  where clinic_id = p_clinic_id and id = v_lead.id
  returning * into v_lead;

  insert into public.crm_lead_stage_history (
    clinic_id, lead_id, from_stage_code, to_stage_code, reason,
    resulting_version, changed_by, idempotency_key, payload_fingerprint
  ) values (
    p_clinic_id, v_lead.id, v_previous_stage, 'convertida',
    'Conversão administrativa confirmada.', v_lead.version, p_actor_id,
    p_idempotency_key, v_fingerprint
  ) returning id into v_history_id;

  v_response := pg_catalog.jsonb_build_object(
    'lead_id', v_lead.id, 'patient_id', v_patient.id,
    'patient_created', v_patient_created, 'source_link_id', v_link.id,
    'stage_history_id', v_history_id, 'match_status',
    case
      when v_patient_created and v_possible_count > 0 then 'created_distinct_confirmed'
      when v_patient_created then 'created'
      when v_exact_id is not null then 'exact_reused'
      else 'manual_link'
    end,
    'duplicate_reviews_resolved', v_review_count,
    'stage_code', v_lead.stage_code, 'status', v_lead.record_status,
    'version', v_lead.version, 'idempotent', false
  );
  perform private.crm_audit(
    p_clinic_id, p_actor_id, 'conversion', v_lead.id, 'convert',
    p_expected_version, v_lead.version,
    pg_catalog.jsonb_build_object(
      'mode', case
        when v_patient_created and v_possible_count > 0 then 'patient_created_distinct'
        when v_patient_created then 'patient_created'
        else 'patient_reused'
      end,
      'new_status', v_lead.record_status, 'new_stage', v_lead.stage_code,
      'result_count', v_review_count
    ), p_request_id, p_idempotency_key
  );
  perform private.crm_store_operation(
    p_clinic_id, p_idempotency_key, 'convert', v_lead.id,
    v_fingerprint, v_response, p_actor_id, p_request_id
  );
  return v_response;
end;
$function$;

-- Ordem global para writers de patients: advisory clínico antes de consultas/DML.
-- A implementação legada de criação é encapsulada sem reescrever sua lógica.
alter function public.financeiro_criar_cliente_com_vinculo(
  uuid,uuid,text,date,text,text,text,text,text,uuid,uuid,uuid
) set schema private;
alter function private.financeiro_criar_cliente_com_vinculo(
  uuid,uuid,text,date,text,text,text,text,text,uuid,uuid,uuid
) rename to financeiro_criar_cliente_com_vinculo_locked_impl;
revoke all on function private.financeiro_criar_cliente_com_vinculo_locked_impl(
  uuid,uuid,text,date,text,text,text,text,text,uuid,uuid,uuid
) from public, anon, authenticated, service_role;

create function public.financeiro_criar_cliente_com_vinculo(
  p_clinic_id uuid,
  p_user_id uuid,
  p_full_name text,
  p_birth_date date,
  p_cpf text,
  p_phone text,
  p_email text,
  p_emergency_phone text,
  p_source_kind text,
  p_source_id uuid,
  p_idempotency_key uuid,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.crm_lock_patient_identity(p_clinic_id);
  return private.financeiro_criar_cliente_com_vinculo_locked_impl(
    p_clinic_id, p_user_id, p_full_name, p_birth_date, p_cpf, p_phone,
    p_email, p_emergency_phone, p_source_kind, p_source_id,
    p_idempotency_key, p_request_id
  );
end;
$function$;

revoke all on function public.financeiro_criar_cliente_com_vinculo(
  uuid,uuid,text,date,text,text,text,text,text,uuid,uuid,uuid
) from public, anon, authenticated, service_role;
grant execute on function public.financeiro_criar_cliente_com_vinculo(
  uuid,uuid,text,date,text,text,text,text,text,uuid,uuid,uuid
) to service_role;

-- Os três UPDATEs canônicos também adquirem advisory antes de FOR UPDATE.
create or replace function public.financeiro_editar_cliente(
  p_clinic_id uuid,
  p_user_id uuid,
  p_patient_id uuid,
  p_expected_version integer,
  p_full_name text,
  p_birth_date date,
  p_cpf text,
  p_phone text,
  p_email text,
  p_emergency_phone text,
  p_status text,
  p_search_name text,
  p_reason text,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_patient public.patients%rowtype;
  v_reason text := private.financeiro_operation_reason(p_reason);
begin
  perform private.crm_lock_patient_identity(p_clinic_id);
  select * into v_patient
  from public.patients
  where clinic_id = p_clinic_id and id = p_patient_id
  for update;
  if not found then raise exception 'cliente_nao_encontrado' using errcode = 'P0002'; end if;
  if v_patient.version <> p_expected_version then
    raise exception 'version_conflict' using errcode = '40001';
  end if;
  if v_patient.archived_at is not null then
    raise exception 'registro_arquivado' using errcode = '55000';
  end if;

  update public.patients
  set full_name = pg_catalog.btrim(p_full_name),
      birth_date = p_birth_date,
      cpf = nullif(pg_catalog.btrim(p_cpf), ''),
      phone = nullif(pg_catalog.btrim(p_phone), ''),
      email = nullif(pg_catalog.lower(pg_catalog.btrim(p_email)), ''),
      emergency_phone = nullif(pg_catalog.btrim(p_emergency_phone), ''),
      status = p_status,
      search_name = pg_catalog.btrim(p_search_name),
      updated_by = p_user_id,
      updated_at = pg_catalog.now(),
      version = version + 1
  where clinic_id = p_clinic_id and id = p_patient_id
  returning * into v_patient;

  insert into public.financeiro_auditoria (
    clinic_id, actor_id, entity, entity_id, action, details, request_id
  ) values (
    p_clinic_id, p_user_id, 'cliente', p_patient_id, 'editado',
    pg_catalog.jsonb_build_object('operation', 'edit', 'version', v_patient.version, 'reason', v_reason),
    p_request_id
  );
  return pg_catalog.to_jsonb(v_patient);
end;
$function$;

create or replace function public.financeiro_arquivar_cliente(
  p_clinic_id uuid, p_user_id uuid, p_patient_id uuid,
  p_expected_version integer, p_reason text, p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_patient public.patients%rowtype;
  v_reason text := private.financeiro_operation_reason(p_reason);
begin
  perform private.crm_lock_patient_identity(p_clinic_id);
  select * into v_patient from public.patients
  where clinic_id = p_clinic_id and id = p_patient_id for update;
  if not found then raise exception 'cliente_nao_encontrado' using errcode = 'P0002'; end if;
  if v_patient.version <> p_expected_version then raise exception 'version_conflict' using errcode = '40001'; end if;
  if v_patient.archived_at is not null then return pg_catalog.to_jsonb(v_patient); end if;
  update public.patients
  set archived_at = pg_catalog.now(), updated_by = p_user_id,
      updated_at = pg_catalog.now(), version = version + 1
  where clinic_id = p_clinic_id and id = p_patient_id returning * into v_patient;
  insert into public.financeiro_auditoria (
    clinic_id, actor_id, entity, entity_id, action, details, request_id
  ) values (
    p_clinic_id, p_user_id, 'cliente', p_patient_id, 'arquivado',
    pg_catalog.jsonb_build_object('operation', 'archive', 'version', v_patient.version, 'reason', v_reason),
    p_request_id
  );
  return pg_catalog.to_jsonb(v_patient);
end;
$function$;

create or replace function public.financeiro_restaurar_cliente(
  p_clinic_id uuid, p_user_id uuid, p_patient_id uuid,
  p_expected_version integer, p_reason text, p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_patient public.patients%rowtype;
  v_reason text := private.financeiro_operation_reason(p_reason);
begin
  perform private.crm_lock_patient_identity(p_clinic_id);
  select * into v_patient from public.patients
  where clinic_id = p_clinic_id and id = p_patient_id for update;
  if not found then raise exception 'cliente_nao_encontrado' using errcode = 'P0002'; end if;
  if v_patient.version <> p_expected_version then raise exception 'version_conflict' using errcode = '40001'; end if;
  if v_patient.archived_at is null then return pg_catalog.to_jsonb(v_patient); end if;
  update public.patients
  set archived_at = null, updated_by = p_user_id,
      updated_at = pg_catalog.now(), version = version + 1
  where clinic_id = p_clinic_id and id = p_patient_id returning * into v_patient;
  insert into public.financeiro_auditoria (
    clinic_id, actor_id, entity, entity_id, action, details, request_id
  ) values (
    p_clinic_id, p_user_id, 'cliente', p_patient_id, 'restaurado',
    pg_catalog.jsonb_build_object('operation', 'restore', 'version', v_patient.version, 'reason', v_reason),
    p_request_id
  );
  return pg_catalog.to_jsonb(v_patient);
end;
$function$;

-- Defesa em profundidade: tabelas no schema exposto têm RLS e nenhum acesso
-- de navegador. O service_role lê apenas os conjuntos necessários à Edge;
-- toda escrita fica encapsulada nas RPCs explicitamente concedidas.
alter table public.crm_pipeline_stages enable row level security;
alter table public.crm_leads enable row level security;
alter table public.crm_lead_stage_history enable row level security;
alter table public.crm_interactions enable row level security;
alter table public.crm_operations enable row level security;
alter table public.crm_audit_log enable row level security;

revoke all on public.crm_pipeline_stages from public, anon, authenticated, service_role;
revoke all on public.crm_leads from public, anon, authenticated, service_role;
revoke all on public.crm_lead_stage_history from public, anon, authenticated, service_role;
revoke all on public.crm_interactions from public, anon, authenticated, service_role;
revoke all on public.crm_operations from public, anon, authenticated, service_role;
revoke all on public.crm_audit_log from public, anon, authenticated, service_role;

grant select on public.crm_pipeline_stages to service_role;
grant select on public.crm_leads to service_role;
grant select on public.crm_lead_stage_history to service_role;
grant select on public.crm_interactions to service_role;
grant select on public.crm_audit_log to service_role;

revoke all on function private.crm_normalize_identity(text)
  from public, anon, authenticated, service_role;
revoke all on function private.crm_normalize_phone(text)
  from public, anon, authenticated, service_role;
revoke all on function private.crm_lead_exact_key(uuid,text,text,text)
  from public, anon, authenticated, service_role;
revoke all on function private.crm_lead_possible_key(text,date)
  from public, anon, authenticated, service_role;
revoke all on function private.crm_assert_owner(uuid,uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.crm_assert_responsible(uuid,uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.crm_sync_lead_dedup()
  from public, anon, authenticated, service_role;
revoke all on function private.crm_forbid_delete()
  from public, anon, authenticated, service_role;
revoke all on function private.crm_append_only()
  from public, anon, authenticated, service_role;
revoke all on function private.crm_replay(uuid,uuid,text,text)
  from public, anon, authenticated, service_role;
revoke all on function private.crm_audit_details_are_safe(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function private.crm_store_operation(uuid,uuid,text,uuid,text,jsonb,uuid,uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.crm_audit(uuid,uuid,text,uuid,text,integer,integer,jsonb,uuid,uuid)
  from public, anon, authenticated, service_role;

revoke all on function public.crm_salvar_lead(text,uuid,uuid,uuid,integer,uuid,uuid,jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.crm_analisar_conversao(uuid,uuid,uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.crm_converter_lead(uuid,uuid,uuid,integer,uuid,uuid,uuid,boolean,text,text)
  from public, anon, authenticated, service_role;

grant execute on function public.crm_salvar_lead(text,uuid,uuid,uuid,integer,uuid,uuid,jsonb)
  to service_role;
grant execute on function public.crm_analisar_conversao(uuid,uuid,uuid)
  to service_role;
grant execute on function public.crm_converter_lead(uuid,uuid,uuid,integer,uuid,uuid,uuid,boolean,text,text)
  to service_role;

comment on table public.crm_leads is
  'Leads estritamente administrativos/comerciais; dados clínicos e de saúde são proibidos.';
comment on column public.crm_leads.commercial_notes is
  'Notas comerciais. Não registrar diagnóstico, anamnese, procedimento clínico ou condição de saúde.';
comment on table public.crm_interactions is
  'Histórico comercial append-only; não é prontuário e não admite conteúdo clínico.';
comment on table public.crm_operations is
  'Ledger técnico de idempotência; respostas não devem conter PII.';
comment on table public.crm_audit_log is
  'Auditoria CRM append-only, somente metadados técnicos e sem PII/PHI.';

commit;

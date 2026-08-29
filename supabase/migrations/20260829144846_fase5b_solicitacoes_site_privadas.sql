begin;

-- Fase 5B: o formulário público grava somente nesta caixa privada. A entrada
-- no CRM ocorre depois, por decisão explícita de um owner autenticado com AAL2
-- na Edge Function crm-fichas.

create table private.crm_site_booking_requests (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete restrict,
  full_name text not null check (
    pg_catalog.char_length(pg_catalog.btrim(full_name)) between 2 and 160
    and full_name !~ '[[:cntrl:]]'
  ),
  normalized_name text not null check (
    pg_catalog.char_length(normalized_name) between 2 and 160
    and normalized_name = private.crm_normalize_identity(full_name)
  ),
  phone text not null check (phone ~ '^\+55[1-9][0-9]{9,10}$'),
  visit_kind text not null check (
    visit_kind in ('primeira_avaliacao', 'paciente_atual')
  ),
  interest text not null check (interest in (
    'avaliacao_sem_procedimento', 'preenchimento_facial', 'skinbooster',
    'toxina_botulinica', 'fios_pdo', 'intradermoterapia_facial',
    'intradermoterapia_capilar', 'peeling', 'microagulhamento_facial',
    'microagulhamento_capilar', 'harmonizacao_facial',
    'aplicacao_intramuscular', 'retorno_acompanhamento'
  )),
  preferred_date date not null,
  preferred_period text not null check (
    preferred_period in ('manha', 'tarde', 'noite', 'a_combinar')
  ),
  contact_consent boolean not null check (contact_consent),
  consent_version text not null check (
    consent_version = 'agendamento-site-v1'
  ),
  consented_at timestamptz not null,
  form_started_at timestamptz not null,
  first_idempotency_key uuid not null,
  payload_sha256 text not null check (payload_sha256 ~ '^[a-f0-9]{64}$'),
  dedup_sha256 text not null check (dedup_sha256 ~ '^[a-f0-9]{64}$'),
  status text not null default 'pending' check (
    status in ('pending', 'accepted', 'archived')
  ),
  lead_id uuid,
  decision_kind text check (
    decision_kind is null or decision_kind in ('created', 'interaction', 'archived')
  ),
  handled_by uuid references auth.users(id) on delete restrict,
  handled_at timestamptz,
  archive_reason text check (
    archive_reason is null or (
      pg_catalog.char_length(pg_catalog.btrim(archive_reason)) between 3 and 500
      and archive_reason !~ '[[:cntrl:]]'
    )
  ),
  version integer not null default 1 check (version > 0),
  retention_review_at timestamptz not null default (pg_catalog.now() + interval '90 days'),
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint crm_site_booking_requests_clinic_id_id_key unique (clinic_id, id),
  constraint crm_site_booking_requests_first_idempotency_key unique (
    clinic_id, first_idempotency_key
  ),
  constraint crm_site_booking_requests_lead_fk foreign key (clinic_id, lead_id)
    references public.crm_leads(clinic_id, id) on delete restrict,
  constraint crm_site_booking_requests_state_check check (
    (
      status = 'pending' and lead_id is null and decision_kind is null
      and handled_by is null and handled_at is null and archive_reason is null
    ) or (
      status = 'accepted' and lead_id is not null
      and decision_kind in ('created', 'interaction')
      and handled_by is not null and handled_at is not null
      and archive_reason is null
    ) or (
      status = 'archived' and lead_id is null and decision_kind = 'archived'
      and handled_by is not null and handled_at is not null
      and archive_reason is not null
    )
  )
);

create unique index crm_site_booking_requests_pending_exact_unique
  on private.crm_site_booking_requests (clinic_id, dedup_sha256)
  where status = 'pending';

create index crm_site_booking_requests_inbox_idx
  on private.crm_site_booking_requests (clinic_id, status, created_at, id);

create index crm_site_booking_requests_lead_idx
  on private.crm_site_booking_requests (clinic_id, lead_id)
  where lead_id is not null;

-- Cada UUID recebido fica ligado ao pedido original. Assim, um replay após o
-- aceite/arquivamento nunca recria uma solicitação e uma deduplicação pendente
-- também preserva o UUID alternativo recebido.
create table private.crm_site_booking_replays (
  clinic_id uuid not null references public.clinics(id) on delete restrict,
  idempotency_key uuid not null,
  request_id uuid not null,
  payload_sha256 text not null check (payload_sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default pg_catalog.now(),
  primary key (clinic_id, idempotency_key),
  constraint crm_site_booking_replays_request_fk foreign key (clinic_id, request_id)
    references private.crm_site_booking_requests(clinic_id, id) on delete restrict
);

create index crm_site_booking_replays_request_idx
  on private.crm_site_booking_replays (clinic_id, request_id, created_at);

-- Ledger privado das decisões administrativas. O fingerprint impede que um
-- UUID seja reaproveitado com parâmetros diferentes.
create table private.crm_site_booking_operations (
  clinic_id uuid not null references public.clinics(id) on delete restrict,
  idempotency_key uuid not null,
  action text not null check (action in ('accept', 'archive')),
  request_id uuid not null,
  actor_id uuid not null references auth.users(id) on delete restrict,
  request_fingerprint text not null check (request_fingerprint ~ '^[a-f0-9]{32}$'),
  trace_request_id uuid not null,
  response jsonb not null check (
    pg_catalog.jsonb_typeof(response) = 'object'
    and pg_catalog.pg_column_size(response) <= 8192
  ),
  created_at timestamptz not null default pg_catalog.now(),
  primary key (clinic_id, idempotency_key),
  constraint crm_site_booking_operations_request_fk foreign key (clinic_id, request_id)
    references private.crm_site_booking_requests(clinic_id, id) on delete restrict,
  constraint crm_site_booking_operations_trace_unique unique (clinic_id, trace_request_id)
);

create index crm_site_booking_operations_request_idx
  on private.crm_site_booking_operations (clinic_id, request_id, created_at);

create or replace function private.crm_site_booking_append_only()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  raise exception 'crm_site_booking_append_only' using errcode = '42501';
end;
$function$;

create trigger crm_site_booking_replays_append_only
  before update or delete on private.crm_site_booking_replays
  for each row execute function private.crm_site_booking_append_only();

create trigger crm_site_booking_operations_append_only
  before update or delete on private.crm_site_booking_operations
  for each row execute function private.crm_site_booking_append_only();

-- Entrada pública indireta: EXECUTE pertence somente ao service_role usado
-- pela Edge. A função não recebe nem persiste texto livre de objetivo.
create or replace function public.crm_site_booking_receive(
  p_clinic_id uuid,
  p_full_name text,
  p_phone text,
  p_visit_kind text,
  p_interest text,
  p_preferred_date date,
  p_preferred_period text,
  p_contact_consent boolean,
  p_consent_version text,
  p_started_at timestamptz,
  p_idempotency_key uuid,
  p_payload_sha256 text,
  p_dedup_sha256 text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_today date := (pg_catalog.clock_timestamp() at time zone 'America/Sao_Paulo')::date;
  v_request private.crm_site_booking_requests%rowtype;
  v_replay private.crm_site_booking_replays%rowtype;
  v_deduplicated boolean := false;
begin
  if p_clinic_id is null
     or not exists (select 1 from public.clinics c where c.id = p_clinic_id)
     or p_idempotency_key is null
     or p_payload_sha256 is null or p_payload_sha256 !~ '^[a-f0-9]{64}$'
     or p_dedup_sha256 is null or p_dedup_sha256 !~ '^[a-f0-9]{64}$'
     or nullif(pg_catalog.btrim(p_full_name), '') is null
     or pg_catalog.char_length(pg_catalog.btrim(p_full_name)) not between 2 and 160
     or p_full_name ~ '[[:cntrl:]]'
     or private.crm_normalize_identity(p_full_name) = ''
     or private.crm_normalize_phone(p_phone) !~ '^\+55[1-9][0-9]{9,10}$'
     or p_visit_kind is null
     or p_visit_kind not in ('primeira_avaliacao', 'paciente_atual')
     or p_interest is null or p_interest not in (
       'avaliacao_sem_procedimento', 'preenchimento_facial', 'skinbooster',
       'toxina_botulinica', 'fios_pdo', 'intradermoterapia_facial',
       'intradermoterapia_capilar', 'peeling', 'microagulhamento_facial',
       'microagulhamento_capilar', 'harmonizacao_facial',
       'aplicacao_intramuscular', 'retorno_acompanhamento'
     )
     or p_preferred_period is null
     or p_preferred_period not in ('manha', 'tarde', 'noite', 'a_combinar')
     or p_preferred_date is null or p_preferred_date < v_today
     or p_preferred_date > v_today + 180
     or p_contact_consent is distinct from true
     or p_consent_version is null or p_consent_version <> 'agendamento-site-v1'
     or p_started_at is null
     or p_started_at > v_now - interval '3 seconds'
     or p_started_at < v_now - interval '12 hours' then
    raise exception 'site_booking_invalid_request' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'site-booking:idempotency:' || p_clinic_id::text || ':' || p_idempotency_key::text, 0
  ));

  select replay.* into v_replay
  from private.crm_site_booking_replays replay
  where replay.clinic_id = p_clinic_id
    and replay.idempotency_key = p_idempotency_key;

  if found then
    if v_replay.payload_sha256 <> p_payload_sha256 then
      raise exception 'site_booking_idempotency_conflict' using errcode = '23505';
    end if;
    select request.* into strict v_request
    from private.crm_site_booking_requests request
    where request.clinic_id = p_clinic_id and request.id = v_replay.request_id;
    return pg_catalog.jsonb_build_object(
      'request_id', v_request.id,
      'status', v_request.status,
      'idempotent', true,
      'deduplicated', false
    );
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'site-booking:dedup:' || p_clinic_id::text || ':' || p_dedup_sha256, 0
  ));

  select request.* into v_request
  from private.crm_site_booking_requests request
  where request.clinic_id = p_clinic_id
    and request.dedup_sha256 = p_dedup_sha256
    and request.status = 'pending'
  order by request.created_at, request.id
  limit 1;

  if not found then
    insert into private.crm_site_booking_requests (
      clinic_id, full_name, normalized_name, phone, visit_kind, interest,
      preferred_date, preferred_period, contact_consent, consent_version,
      consented_at, form_started_at, first_idempotency_key,
      payload_sha256, dedup_sha256
    ) values (
      p_clinic_id, pg_catalog.btrim(p_full_name),
      private.crm_normalize_identity(p_full_name), private.crm_normalize_phone(p_phone),
      p_visit_kind, p_interest, p_preferred_date, p_preferred_period,
      true, p_consent_version, v_now, p_started_at, p_idempotency_key,
      p_payload_sha256, p_dedup_sha256
    ) returning * into v_request;
  else
    v_deduplicated := true;
  end if;

  insert into private.crm_site_booking_replays (
    clinic_id, idempotency_key, request_id, payload_sha256
  ) values (
    p_clinic_id, p_idempotency_key, v_request.id, p_payload_sha256
  );

  return pg_catalog.jsonb_build_object(
    'request_id', v_request.id,
    'status', v_request.status,
    'idempotent', false,
    'deduplicated', v_deduplicated
  );
end;
$function$;

create or replace function public.crm_site_booking_list(
  p_clinic_id uuid,
  p_actor_id uuid,
  p_status text default 'pending',
  p_limit integer default 100,
  p_offset integer default 0
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_status text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_status, 'pending')));
  v_total integer;
  v_pending integer;
  v_items jsonb;
begin
  perform private.crm_assert_owner(p_clinic_id, p_actor_id);
  if v_status not in ('pending', 'accepted', 'archived', 'all')
     or p_limit is null or p_limit not between 1 and 200
     or p_offset is null or p_offset not between 0 and 100000 then
    raise exception 'site_booking_invalid_list' using errcode = '22023';
  end if;

  select pg_catalog.count(*)::integer into v_pending
  from private.crm_site_booking_requests request
  where request.clinic_id = p_clinic_id and request.status = 'pending';

  select pg_catalog.count(*)::integer into v_total
  from private.crm_site_booking_requests request
  where request.clinic_id = p_clinic_id
    and (v_status = 'all' or request.status = v_status);

  select coalesce(pg_catalog.jsonb_agg(item.row_json order by item.created_at, item.id), '[]'::jsonb)
  into v_items
  from (
    select
      request.id,
      request.created_at,
      pg_catalog.jsonb_build_object(
        'id', request.id,
        'nome', request.full_name,
        'telefone', request.phone,
        'primeira_visita', request.visit_kind,
        'interesse', request.interest,
        'data_preferida', request.preferred_date,
        'periodo', request.preferred_period,
        'consentimento_contato', request.contact_consent,
        'consentimento_versao', request.consent_version,
        'status', request.status,
        'lead_id', request.lead_id,
        'decisao', request.decision_kind,
        'versao', request.version,
        'version', request.version,
        'recebido_em', request.created_at,
        'created_at', request.created_at,
        'criado_em', request.created_at,
        'atualizado_em', request.updated_at,
        'tratado_em', request.handled_at
      ) as row_json
    from private.crm_site_booking_requests request
    where request.clinic_id = p_clinic_id
      and (v_status = 'all' or request.status = v_status)
    order by request.created_at, request.id
    limit p_limit offset p_offset
  ) item;

  return pg_catalog.jsonb_build_object(
    'solicitacoes_site', v_items,
    'total', v_total,
    'pendentes', v_pending,
    'limit', p_limit,
    'offset', p_offset,
    'has_more', p_offset + pg_catalog.jsonb_array_length(v_items) < v_total
  );
end;
$function$;

create or replace function public.crm_site_booking_accept(
  p_clinic_id uuid,
  p_actor_id uuid,
  p_site_request_id uuid,
  p_expected_version integer,
  p_responsible_user_id uuid,
  p_next_action_at timestamptz,
  p_idempotency_key uuid,
  p_operation_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_request private.crm_site_booking_requests%rowtype;
  v_operation private.crm_site_booking_operations%rowtype;
  v_lead public.crm_leads%rowtype;
  v_phone_count integer;
  v_exact_count integer;
  v_decision text;
  v_summary text;
  v_result jsonb;
  v_response jsonb;
  v_fingerprint text := pg_catalog.md5(pg_catalog.jsonb_build_array(
    'accept', p_site_request_id, p_expected_version,
    p_responsible_user_id, p_next_action_at
  )::text);
begin
  perform private.crm_assert_owner(p_clinic_id, p_actor_id);
  perform private.crm_assert_responsible(p_clinic_id, p_responsible_user_id);
  if p_site_request_id is null or p_expected_version is null or p_expected_version < 1
     or p_responsible_user_id is null or p_next_action_at is null
     or p_next_action_at < pg_catalog.clock_timestamp() - interval '5 minutes'
     or p_next_action_at > pg_catalog.clock_timestamp() + interval '366 days'
     or p_idempotency_key is null or p_operation_request_id is null then
    raise exception 'site_booking_invalid_accept' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'site-booking:operation:' || p_clinic_id::text || ':' || p_idempotency_key::text, 0
  ));

  select operation.* into v_operation
  from private.crm_site_booking_operations operation
  where operation.clinic_id = p_clinic_id
    and operation.idempotency_key = p_idempotency_key;
  if found then
    if v_operation.action <> 'accept'
       or v_operation.request_id <> p_site_request_id
       or v_operation.actor_id <> p_actor_id
       or v_operation.request_fingerprint <> v_fingerprint then
      raise exception 'site_booking_idempotency_conflict' using errcode = '23505';
    end if;
    return v_operation.response || pg_catalog.jsonb_build_object('idempotent', true);
  end if;

  select request.* into v_request
  from private.crm_site_booking_requests request
  where request.clinic_id = p_clinic_id and request.id = p_site_request_id
  for update;
  if not found then
    raise exception 'site_booking_not_found' using errcode = 'P0002';
  end if;
  if v_request.version <> p_expected_version then
    raise exception 'site_booking_version_conflict' using errcode = '40001';
  end if;
  if v_request.status <> 'pending' then
    raise exception 'site_booking_already_handled' using errcode = '55000';
  end if;

  -- Serializa dois aceites simultâneos da mesma identidade pública antes da
  -- contagem e da eventual criação no CRM.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'site-booking:lead-identity:' || p_clinic_id::text || ':' || v_request.phone, 0
  ));

  select
    pg_catalog.count(*)::integer,
    pg_catalog.count(*) filter (
      where private.crm_normalize_identity(lead.full_name) = v_request.normalized_name
    )::integer
  into v_phone_count, v_exact_count
  from public.crm_leads lead
  where lead.clinic_id = p_clinic_id
    and lead.record_status = 'active'
    and lead.phone = v_request.phone;

  v_summary := pg_catalog.format(
    'Solicitação do site: interesse %s; preferência %s (%s); perfil %s.',
    v_request.interest, v_request.preferred_date, v_request.preferred_period,
    v_request.visit_kind
  );

  if v_phone_count = 0 then
    v_result := public.marketing_crm_salvar_lead(
      'create', p_clinic_id, p_actor_id, null, 0,
      p_idempotency_key, p_operation_request_id,
      pg_catalog.jsonb_build_object(
        'full_name', v_request.full_name,
        'phone', v_request.phone,
        'email', null,
        'source', 'site',
        'subsource', 'agendar',
        'campaign_id', null,
        'interest', v_request.interest,
        'responsible_user_id', p_responsible_user_id,
        'stage_code', 'novo',
        'next_action_type', 'agendar_avaliacao',
        'next_action_at', p_next_action_at,
        'commercial_notes', v_summary
      )
    );
    v_decision := 'created';
  elsif v_phone_count = 1 and v_exact_count = 1 then
    select lead.* into strict v_lead
    from public.crm_leads lead
    where lead.clinic_id = p_clinic_id
      and lead.record_status = 'active'
      and lead.phone = v_request.phone
      and private.crm_normalize_identity(lead.full_name) = v_request.normalized_name
    for update;
    v_result := public.marketing_crm_salvar_lead(
      'add_interaction', p_clinic_id, p_actor_id, v_lead.id, v_lead.version,
      p_idempotency_key, p_operation_request_id,
      pg_catalog.jsonb_build_object(
        'interaction_type', 'outro',
        'direction', 'inbound',
        'outcome', 'solicitacao_site',
        'commercial_summary', v_summary,
        'occurred_at', v_request.created_at,
        'next_action_type', 'agendar_avaliacao',
        'next_action_at', p_next_action_at
      )
    );
    v_decision := 'interaction';
  else
    raise exception 'site_booking_review_required' using errcode = '55000';
  end if;

  update private.crm_site_booking_requests
  set status = 'accepted', lead_id = (v_result ->> 'lead_id')::uuid,
      decision_kind = v_decision, handled_by = p_actor_id,
      handled_at = pg_catalog.now(), version = version + 1,
      updated_at = pg_catalog.now()
  where clinic_id = p_clinic_id and id = p_site_request_id
  returning * into v_request;

  v_response := pg_catalog.jsonb_build_object(
    'solicitacao_id', v_request.id,
    'status', v_request.status,
    'lead_id', v_request.lead_id,
    'lead_version', (v_result ->> 'version')::integer,
    'decisao', v_decision,
    'versao', v_request.version
  );
  insert into private.crm_site_booking_operations (
    clinic_id, idempotency_key, action, request_id, actor_id,
    request_fingerprint, trace_request_id, response
  ) values (
    p_clinic_id, p_idempotency_key, 'accept', p_site_request_id, p_actor_id,
    v_fingerprint, p_operation_request_id, v_response
  );
  return v_response || pg_catalog.jsonb_build_object('idempotent', false);
end;
$function$;

create or replace function public.crm_site_booking_archive(
  p_clinic_id uuid,
  p_actor_id uuid,
  p_site_request_id uuid,
  p_expected_version integer,
  p_reason text,
  p_idempotency_key uuid,
  p_operation_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_request private.crm_site_booking_requests%rowtype;
  v_operation private.crm_site_booking_operations%rowtype;
  v_response jsonb;
  v_reason text := pg_catalog.btrim(coalesce(p_reason, ''));
  v_fingerprint text := pg_catalog.md5(pg_catalog.jsonb_build_array(
    'archive', p_site_request_id, p_expected_version, v_reason
  )::text);
begin
  perform private.crm_assert_owner(p_clinic_id, p_actor_id);
  if p_site_request_id is null or p_expected_version is null or p_expected_version < 1
     or pg_catalog.char_length(v_reason) not between 3 and 500
     or v_reason ~ '[[:cntrl:]]'
     or p_idempotency_key is null or p_operation_request_id is null then
    raise exception 'site_booking_invalid_archive' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'site-booking:operation:' || p_clinic_id::text || ':' || p_idempotency_key::text, 0
  ));
  select operation.* into v_operation
  from private.crm_site_booking_operations operation
  where operation.clinic_id = p_clinic_id
    and operation.idempotency_key = p_idempotency_key;
  if found then
    if v_operation.action <> 'archive'
       or v_operation.request_id <> p_site_request_id
       or v_operation.actor_id <> p_actor_id
       or v_operation.request_fingerprint <> v_fingerprint then
      raise exception 'site_booking_idempotency_conflict' using errcode = '23505';
    end if;
    return v_operation.response || pg_catalog.jsonb_build_object('idempotent', true);
  end if;

  select request.* into v_request
  from private.crm_site_booking_requests request
  where request.clinic_id = p_clinic_id and request.id = p_site_request_id
  for update;
  if not found then
    raise exception 'site_booking_not_found' using errcode = 'P0002';
  end if;
  if v_request.version <> p_expected_version then
    raise exception 'site_booking_version_conflict' using errcode = '40001';
  end if;
  if v_request.status <> 'pending' then
    raise exception 'site_booking_already_handled' using errcode = '55000';
  end if;

  update private.crm_site_booking_requests
  set status = 'archived', decision_kind = 'archived', handled_by = p_actor_id,
      handled_at = pg_catalog.now(), archive_reason = v_reason,
      version = version + 1, updated_at = pg_catalog.now()
  where clinic_id = p_clinic_id and id = p_site_request_id
  returning * into v_request;

  v_response := pg_catalog.jsonb_build_object(
    'solicitacao_id', v_request.id,
    'status', v_request.status,
    'decisao', v_request.decision_kind,
    'versao', v_request.version
  );
  insert into private.crm_site_booking_operations (
    clinic_id, idempotency_key, action, request_id, actor_id,
    request_fingerprint, trace_request_id, response
  ) values (
    p_clinic_id, p_idempotency_key, 'archive', p_site_request_id, p_actor_id,
    v_fingerprint, p_operation_request_id, v_response
  );
  return v_response || pg_catalog.jsonb_build_object('idempotent', false);
end;
$function$;

alter table private.crm_site_booking_requests enable row level security;
alter table private.crm_site_booking_replays enable row level security;
alter table private.crm_site_booking_operations enable row level security;

revoke all on table private.crm_site_booking_requests,
  private.crm_site_booking_replays,
  private.crm_site_booking_operations
  from public, anon, authenticated, service_role;

revoke all on function private.crm_site_booking_append_only()
  from public, anon, authenticated, service_role;

revoke all on function public.crm_site_booking_receive(
  uuid, text, text, text, text, date, text, boolean, text,
  timestamptz, uuid, text, text
) from public, anon, authenticated, service_role;
revoke all on function public.crm_site_booking_list(uuid, uuid, text, integer, integer)
  from public, anon, authenticated, service_role;
revoke all on function public.crm_site_booking_accept(
  uuid, uuid, uuid, integer, uuid, timestamptz, uuid, uuid
) from public, anon, authenticated, service_role;
revoke all on function public.crm_site_booking_archive(
  uuid, uuid, uuid, integer, text, uuid, uuid
) from public, anon, authenticated, service_role;

grant execute on function public.crm_site_booking_receive(
  uuid, text, text, text, text, date, text, boolean, text,
  timestamptz, uuid, text, text
) to service_role;
grant execute on function public.crm_site_booking_list(uuid, uuid, text, integer, integer)
  to service_role;
grant execute on function public.crm_site_booking_accept(
  uuid, uuid, uuid, integer, uuid, timestamptz, uuid, uuid
) to service_role;
grant execute on function public.crm_site_booking_archive(
  uuid, uuid, uuid, integer, text, uuid, uuid
) to service_role;

comment on table private.crm_site_booking_requests is
  'Caixa privada de solicitações públicas de agendamento; sem texto livre e sem escrita pública direta no CRM.';
comment on function public.crm_site_booking_receive(
  uuid, text, text, text, text, date, text, boolean, text,
  timestamptz, uuid, text, text
) is 'Recebe solicitação validada pela Edge pública e a mantém fora do CRM até revisão owner+AAL2.';

commit;

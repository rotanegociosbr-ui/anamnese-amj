-- Fase 2: acompanhamentos pos-procedimento e reativacao consentida.
-- Reutiliza retorno_recomendacoes/retorno_fila como fonte operacional unica.
-- Nenhuma funcao desta migration envia mensagens ou toma decisao clinica.

begin;

-- ---------------------------------------------------------------------------
-- Autoridade clinica explicita, separada do RBAC administrativo.
-- ---------------------------------------------------------------------------

create table public.clinic_professional_credentials (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete restrict,
  user_id uuid not null,
  council_code text not null,
  council_state text not null,
  registration_number text not null,
  scope text not null default 'post_procedure_followup',
  valid_until date,
  status text not null default 'pending',
  version integer not null,
  supersedes_id uuid,
  idempotency_key uuid not null,
  payload_fingerprint text not null check (pg_catalog.char_length(payload_fingerprint) = 32),
  configured_by uuid not null references auth.users(id) on delete restrict,
  verification_evidence_id uuid,
  verified_by uuid references auth.users(id) on delete restrict,
  verified_at timestamptz,
  revoked_by uuid references auth.users(id) on delete restrict,
  revoked_at timestamptz,
  revocation_reason text,
  created_at timestamptz not null default pg_catalog.now(),
  constraint clinic_professional_credentials_clinic_id_id_key unique (clinic_id, id),
  constraint clinic_professional_credentials_member_fk foreign key (clinic_id, user_id)
    references public.clinic_members(clinic_id, user_id) on delete restrict,
  constraint clinic_professional_credentials_idempotency_key
    unique (clinic_id, idempotency_key),
  constraint clinic_professional_credentials_evidence_once
    unique (clinic_id, verification_evidence_id),
  constraint clinic_professional_credentials_version_unique
    unique (clinic_id, user_id, scope, version),
  constraint clinic_professional_credentials_supersedes_fk
    foreign key (clinic_id, supersedes_id)
    references public.clinic_professional_credentials(clinic_id, id) on delete restrict,
  constraint clinic_professional_credentials_council_check check (
    council_code ~ '^[A-Z0-9.-]{2,20}$'
    and council_state ~ '^[A-Z]{2}$'
    and pg_catalog.char_length(pg_catalog.btrim(registration_number)) between 2 and 40
    and registration_number !~ '[[:cntrl:]]'
  ),
  constraint clinic_professional_credentials_scope_check check (
    scope = 'post_procedure_followup'
  ),
  constraint clinic_professional_credentials_status_check check (
    status in ('pending', 'verified', 'revoked')
  ),
  constraint clinic_professional_credentials_version_check check (version > 0),
  constraint clinic_professional_credentials_revocation_check check (
    (status = 'pending' and verified_by is null and verified_at is null
      and revoked_by is null and revoked_at is null and revocation_reason is null)
    or (status = 'verified' and verified_by is not null and verified_at is not null
      and verification_evidence_id is not null
      and revoked_by is null and revoked_at is null and revocation_reason is null)
    or (
      status = 'revoked' and revoked_by is not null and revoked_at is not null
      and pg_catalog.char_length(pg_catalog.btrim(revocation_reason)) between 3 and 500
    )
  )
);

create table public.clinic_professional_verification_evidence (
  id uuid primary key,
  clinic_id uuid not null references public.clinics(id) on delete restrict,
  professional_user_id uuid not null,
  evidence_sha256 text not null,
  evidence_kind text not null,
  captured_at timestamptz not null,
  recorded_by uuid not null references auth.users(id) on delete restrict,
  recorded_at timestamptz not null default pg_catalog.now(),
  constraint clinic_professional_verification_evidence_clinic_id_id_key
    unique (clinic_id, id),
  constraint clinic_professional_verification_evidence_member_fk
    foreign key (clinic_id, professional_user_id)
    references public.clinic_members(clinic_id, user_id) on delete restrict,
  constraint clinic_professional_verification_evidence_hash_check
    check (evidence_sha256 ~ '^[0-9a-f]{64}$'),
  constraint clinic_professional_verification_evidence_kind_check
    check (evidence_kind in ('document_review', 'council_registry_check', 'revocation_record')),
  constraint clinic_professional_verification_evidence_time_check
    check (captured_at <= recorded_at + interval '5 minutes')
);

alter table public.clinic_professional_credentials
  add constraint clinic_professional_credentials_verification_evidence_fk
  foreign key (clinic_id, verification_evidence_id)
  references public.clinic_professional_verification_evidence(clinic_id, id)
  on delete restrict;

create index clinic_professional_credentials_lookup_idx
  on public.clinic_professional_credentials (clinic_id, user_id, scope, version desc);

create view public.clinic_professional_credential_current
with (security_invoker = true)
as
select distinct on (credential.clinic_id, credential.user_id, credential.scope)
  credential.*
from public.clinic_professional_credentials credential
order by credential.clinic_id, credential.user_id, credential.scope,
  credential.version desc, credential.created_at desc, credential.id desc;

-- ---------------------------------------------------------------------------
-- Consentimento de marketing patient-level, append-only e versionado.
-- Nao reutiliza a preferencia operacional de contato.
-- ---------------------------------------------------------------------------

create table public.patient_marketing_signature_evidence (
  id uuid primary key,
  clinic_id uuid not null references public.clinics(id) on delete restrict,
  patient_id uuid not null,
  channel text not null,
  term_id uuid not null references public.consent_terms(id) on delete restrict,
  signature_sha256 text not null,
  signed_at timestamptz not null,
  recorded_by uuid not null references auth.users(id) on delete restrict,
  recorded_at timestamptz not null default pg_catalog.now(),
  constraint patient_marketing_signature_evidence_clinic_id_id_key unique (clinic_id,id),
  constraint patient_marketing_signature_evidence_patient_fk foreign key (clinic_id,patient_id)
    references public.patients(clinic_id,id) on delete restrict,
  constraint patient_marketing_signature_evidence_channel_check check (
    channel in ('whatsapp','sms','email','telefone')
  ),
  constraint patient_marketing_signature_evidence_hash_check check (
    signature_sha256 ~ '^[0-9a-f]{64}$'
  ),
  constraint patient_marketing_signature_evidence_time_check check (
    signed_at <= recorded_at + interval '5 minutes'
  )
);

create table public.patient_marketing_consent_events (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete restrict,
  patient_id uuid not null,
  purpose text not null default 'reactivation',
  channel text not null,
  accepted boolean not null,
  effective_at timestamptz not null,
  signature_evidence_id uuid,
  term_id uuid,
  term_version_snapshot text,
  term_sha256_snapshot text,
  supersedes_id uuid,
  version integer not null,
  idempotency_key uuid not null,
  payload_fingerprint text not null check (pg_catalog.char_length(payload_fingerprint) = 32),
  recorded_by uuid not null references auth.users(id) on delete restrict,
  recorded_at timestamptz not null default pg_catalog.now(),
  constraint patient_marketing_consent_events_clinic_id_id_key unique (clinic_id, id),
  constraint patient_marketing_consent_events_patient_fk foreign key (clinic_id, patient_id)
    references public.patients(clinic_id, id) on delete restrict,
  constraint patient_marketing_consent_events_evidence_fk
    foreign key (clinic_id, signature_evidence_id)
    references public.patient_marketing_signature_evidence(clinic_id, id) on delete restrict,
  constraint patient_marketing_consent_events_term_fk
    foreign key (term_id) references public.consent_terms(id) on delete restrict,
  constraint patient_marketing_consent_events_supersedes_fk
    foreign key (clinic_id, supersedes_id)
    references public.patient_marketing_consent_events(clinic_id, id) on delete restrict,
  constraint patient_marketing_consent_events_version_unique
    unique (clinic_id, patient_id, purpose, channel, version),
  constraint patient_marketing_consent_events_idempotency_unique
    unique (clinic_id, idempotency_key),
  constraint patient_marketing_consent_events_evidence_once
    unique (clinic_id, signature_evidence_id),
  constraint patient_marketing_consent_events_purpose_check check (purpose = 'reactivation'),
  constraint patient_marketing_consent_events_channel_check check (
    channel in ('whatsapp', 'sms', 'email', 'telefone')
  ),
  constraint patient_marketing_consent_events_evidence_check check (
    (accepted and signature_evidence_id is not null and term_id is not null
      and pg_catalog.char_length(pg_catalog.btrim(term_version_snapshot)) between 1 and 40
      and term_sha256_snapshot ~ '^[0-9a-f]{64}$')
    or (not accepted and signature_evidence_id is null and term_id is null
      and term_version_snapshot is null and term_sha256_snapshot is null)
  ),
  constraint patient_marketing_consent_events_time_check check (
    effective_at <= recorded_at + interval '5 minutes'
  ),
  constraint patient_marketing_consent_events_version_check check (version > 0),
  constraint patient_marketing_consent_events_supersedes_check check (
    (version = 1 and supersedes_id is null) or (version > 1 and supersedes_id is not null)
  )
);

create index patient_marketing_consent_events_current_idx
  on public.patient_marketing_consent_events
  (clinic_id, patient_id, purpose, channel, version desc, recorded_at desc, id desc);

create view public.patient_marketing_consent_current
with (security_invoker = true)
as
select distinct on (event.clinic_id, event.patient_id, event.purpose, event.channel)
  event.id as event_id,
  event.clinic_id,
  event.patient_id,
  event.purpose,
  event.channel,
  event.accepted,
  event.effective_at,
  event.term_version_snapshot as term_version,
  event.version,
  event.recorded_at
from public.patient_marketing_consent_events event
where event.effective_at <= pg_catalog.now()
order by event.clinic_id, event.patient_id, event.purpose, event.channel,
  event.version desc, event.recorded_at desc, event.id desc;

create or replace function private.fase2_guard_append_only()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  raise exception 'append_only_record' using errcode = '55000';
end;
$function$;

create trigger patient_marketing_consent_events_append_only
before update or delete on public.patient_marketing_consent_events
for each row execute function private.fase2_guard_append_only();

create trigger clinic_professional_credentials_append_only
before update or delete on public.clinic_professional_credentials
for each row execute function private.fase2_guard_append_only();

create trigger clinic_professional_verification_evidence_append_only
before update or delete on public.clinic_professional_verification_evidence
for each row execute function private.fase2_guard_append_only();

create trigger patient_marketing_signature_evidence_append_only
before update or delete on public.patient_marketing_signature_evidence
for each row execute function private.fase2_guard_append_only();

-- ---------------------------------------------------------------------------
-- Planos agrupam etapas; cada etapa continua sendo uma recomendacao/fila.
-- ---------------------------------------------------------------------------

create table public.acompanhamento_planos (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete restrict,
  patient_id uuid not null,
  attendance_id uuid not null,
  protocol_id uuid,
  plan_kind text not null,
  anchor_date date not null,
  interval_days integer,
  marketing_channel text,
  marketing_consent_event_id uuid,
  validated_by uuid,
  validated_at timestamptz,
  status text not null default 'active',
  version integer not null default 1,
  activation_id uuid not null,
  idempotency_key uuid not null,
  payload_fingerprint text not null check (pg_catalog.char_length(payload_fingerprint) = 32),
  invalidated_by_attendance_id uuid,
  invalidated_at timestamptz,
  invalidation_reason text,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint acompanhamento_planos_clinic_id_id_key unique (clinic_id, id),
  constraint acompanhamento_planos_patient_fk foreign key (clinic_id, patient_id)
    references public.patients(clinic_id, id) on delete restrict,
  constraint acompanhamento_planos_attendance_fk foreign key (clinic_id, attendance_id)
    references public.atendimentos_realizados(clinic_id, id) on delete restrict,
  constraint acompanhamento_planos_invalidating_attendance_fk
    foreign key (clinic_id, invalidated_by_attendance_id)
    references public.atendimentos_realizados(clinic_id, id) on delete restrict,
  constraint acompanhamento_planos_validator_fk foreign key (clinic_id, validated_by)
    references public.clinic_members(clinic_id, user_id) on delete restrict,
  constraint acompanhamento_planos_consent_fk
    foreign key (clinic_id, marketing_consent_event_id)
    references public.patient_marketing_consent_events(clinic_id, id) on delete restrict,
  constraint acompanhamento_planos_activation_unique unique (clinic_id, activation_id),
  constraint acompanhamento_planos_idempotency_unique unique (clinic_id, idempotency_key),
  constraint acompanhamento_planos_kind_check check (
    plan_kind in ('post_procedure', 'reactivation')
  ),
  constraint acompanhamento_planos_status_check check (
    status in ('active', 'completed', 'cancelled', 'invalidated')
  ),
  constraint acompanhamento_planos_version_check check (version > 0),
  constraint acompanhamento_planos_kind_fields_check check (
    (
      plan_kind = 'post_procedure'
      and interval_days is null and marketing_channel is null
      and marketing_consent_event_id is null
      and validated_by is not null and validated_at is not null
    ) or (
      plan_kind = 'reactivation'
      and interval_days in (60, 90, 120, 180, 365)
      and marketing_channel is not null and marketing_consent_event_id is not null
      and validated_by is null and validated_at is null
    )
  ),
  constraint acompanhamento_planos_invalidation_check check (
    (status <> 'invalidated' and invalidated_by_attendance_id is null
      and invalidated_at is null and invalidation_reason is null)
    or (
      status = 'invalidated' and invalidated_by_attendance_id is not null
      and invalidated_at is not null
      and pg_catalog.char_length(pg_catalog.btrim(invalidation_reason)) between 3 and 200
    )
  )
);

create unique index acompanhamento_planos_reactivation_active_unique
  on public.acompanhamento_planos (clinic_id, patient_id)
  where plan_kind = 'reactivation' and status = 'active';

create unique index acompanhamento_planos_followup_active_unique
  on public.acompanhamento_planos (clinic_id, attendance_id)
  where plan_kind = 'post_procedure' and status = 'active';

create index acompanhamento_planos_operational_idx
  on public.acompanhamento_planos (clinic_id, plan_kind, status, anchor_date desc);

alter table public.retorno_recomendacoes
  add column plan_id uuid,
  add column plan_step smallint,
  add column offset_days integer;

alter table public.retorno_recomendacoes
  add constraint retorno_recomendacoes_plan_fk foreign key (clinic_id, plan_id)
    references public.acompanhamento_planos(clinic_id, id) on delete restrict,
  add constraint retorno_recomendacoes_plan_step_check check (
    (plan_id is null and plan_step is null and offset_days is null)
    or (
      plan_id is not null and plan_step between 1 and 24
      and offset_days between 1 and 3650
    )
  );

create unique index retorno_recomendacoes_plan_step_unique
  on public.retorno_recomendacoes (clinic_id, plan_id, plan_step)
  where plan_id is not null;

create table public.reactivation_contact_attempts (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete restrict,
  plan_id uuid not null,
  queue_id uuid not null,
  patient_id uuid not null,
  consent_event_id uuid not null,
  channel text not null,
  result text not null,
  next_action text not null,
  next_action_at timestamptz,
  attempted_by uuid not null,
  attempted_at timestamptz not null,
  idempotency_key uuid not null,
  payload_fingerprint text not null check (pg_catalog.char_length(payload_fingerprint)=32),
  response_snapshot jsonb not null,
  created_at timestamptz not null default pg_catalog.now(),
  constraint reactivation_contact_attempts_clinic_id_id_key unique (clinic_id,id),
  constraint reactivation_contact_attempts_plan_fk foreign key (clinic_id,plan_id)
    references public.acompanhamento_planos(clinic_id,id) on delete restrict,
  constraint reactivation_contact_attempts_queue_fk foreign key (clinic_id,queue_id)
    references public.retorno_fila(clinic_id,id) on delete restrict,
  constraint reactivation_contact_attempts_patient_fk foreign key (clinic_id,patient_id)
    references public.patients(clinic_id,id) on delete restrict,
  constraint reactivation_contact_attempts_consent_fk foreign key (clinic_id,consent_event_id)
    references public.patient_marketing_consent_events(clinic_id,id) on delete restrict,
  constraint reactivation_contact_attempts_actor_fk foreign key (clinic_id,attempted_by)
    references public.clinic_members(clinic_id,user_id) on delete restrict,
  constraint reactivation_contact_attempts_idempotency_unique unique (clinic_id,idempotency_key),
  constraint reactivation_contact_attempts_channel_check check (
    channel in ('whatsapp','sms','email','telefone')
  ),
  constraint reactivation_contact_attempts_result_check check (
    result in ('sem_resposta','respondeu','agendou','recusou','canal_indisponivel')
  ),
  constraint reactivation_contact_attempts_next_action_check check (
    next_action in ('contatar','aguardar_resposta','recontatar','confirmar_agenda','nenhuma')
    and ((next_action='nenhuma' and next_action_at is null)
      or (next_action<>'nenhuma' and next_action_at is not null))
  ),
  constraint reactivation_contact_attempts_time_check check (
    attempted_at<=created_at+interval '5 minutes'
  )
);

create index reactivation_contact_attempts_plan_idx
  on public.reactivation_contact_attempts (clinic_id,plan_id,attempted_at desc,id desc);

create trigger reactivation_contact_attempts_append_only
before update or delete on public.reactivation_contact_attempts
for each row execute function private.fase2_guard_append_only();

-- ---------------------------------------------------------------------------
-- Timeline do paciente: a mesma chave protege a leitura da ancora e novos
-- atendimentos. O AFTER invalida reativacoes antigas, sem enviar mensagem.
-- ---------------------------------------------------------------------------

create or replace function private.fase2_lock_patient_timeline()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('fase2:attendance-timeline-global',0)
  );
  return null;
end;
$function$;

create trigger atendimentos_realizados_patient_timeline_lock
before insert or update of patient_id, attended_at, status, archived_at
on public.atendimentos_realizados
for each statement execute function private.fase2_lock_patient_timeline();

create or replace function private.fase2_invalidate_reactivation()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if new.archived_at is null and new.status in ('realizado','concluido') then
    update public.acompanhamento_planos plan
    set status = 'invalidated', version = version + 1,
        invalidated_by_attendance_id = new.id,
        invalidated_at = pg_catalog.now(),
        invalidation_reason = 'Novo atendimento concluido apos a ancora.',
        updated_at = pg_catalog.now()
    where plan.clinic_id = new.clinic_id
      and plan.patient_id = new.patient_id
      and plan.plan_kind = 'reactivation'
      and plan.status = 'active'
      and plan.attendance_id <> new.id
      and plan.anchor_date < (new.attended_at at time zone 'America/Sao_Paulo')::date;

    update public.retorno_fila queue
    set status = 'cancelado', next_action = 'nenhuma', next_action_at = null,
        closure_reason = 'Reativacao invalidada por novo atendimento.',
        version = version + 1, updated_by = new.updated_by,
        updated_at = pg_catalog.now()
    from public.retorno_recomendacoes recommendation
    join public.acompanhamento_planos plan
      on plan.clinic_id = recommendation.clinic_id and plan.id = recommendation.plan_id
    where queue.clinic_id = new.clinic_id
      and queue.recommendation_id = recommendation.id
      and plan.invalidated_by_attendance_id = new.id
      and queue.status not in ('concluido', 'cancelado', 'bloqueado');

    update public.retorno_recomendacoes recommendation
    set status = 'cancelada', cancelled_by = coalesce(new.updated_by, new.created_by),
        cancelled_at = pg_catalog.now(),
        cancellation_reason = 'Reativacao invalidada por novo atendimento.',
        version = version + 1, updated_at = pg_catalog.now()
    from public.acompanhamento_planos plan
    where recommendation.clinic_id = new.clinic_id
      and recommendation.plan_id = plan.id
      and plan.invalidated_by_attendance_id = new.id
      and recommendation.status = 'ativa';
  end if;
  return new;
end;
$function$;

create trigger atendimentos_realizados_invalidate_reactivation
after insert or update of patient_id, attended_at, status, archived_at
on public.atendimentos_realizados
for each row execute function private.fase2_invalidate_reactivation();

create or replace function private.fase2_cancel_followups_for_archived_patient()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if old.archived_at is null and new.archived_at is not null then
    update public.acompanhamento_planos plan
    set status='cancelled',version=version+1,updated_at=pg_catalog.now()
    where plan.clinic_id=new.clinic_id and plan.patient_id=new.id and plan.status='active';
    update public.retorno_fila queue
    set status='cancelado',next_action='nenhuma',next_action_at=null,
        closure_reason='Paciente arquivada.',version=version+1,
        updated_by=coalesce(new.updated_by,new.created_by),updated_at=pg_catalog.now()
    from public.retorno_recomendacoes recommendation
    join public.acompanhamento_planos plan
      on plan.clinic_id=recommendation.clinic_id and plan.id=recommendation.plan_id
    where queue.clinic_id=new.clinic_id and queue.recommendation_id=recommendation.id
      and plan.patient_id=new.id and plan.status='cancelled'
      and queue.status not in ('concluido','cancelado','bloqueado');
    update public.retorno_recomendacoes recommendation
    set status='cancelada',cancelled_by=coalesce(new.updated_by,new.created_by),
        cancelled_at=pg_catalog.now(),cancellation_reason='Paciente arquivada.',
        version=version+1,updated_at=pg_catalog.now()
    from public.acompanhamento_planos plan
    where recommendation.clinic_id=new.clinic_id and recommendation.plan_id=plan.id
      and plan.patient_id=new.id and plan.status='cancelled'
      and recommendation.status='ativa';
  end if;
  return new;
end;
$function$;

create trigger patients_cancel_phase2_followups_after_archive
after update of archived_at on public.patients
for each row execute function private.fase2_cancel_followups_for_archived_patient();

-- ---------------------------------------------------------------------------
-- Configuracao de credencial e consentimento append-only.
-- ---------------------------------------------------------------------------

create function public.operacao_configurar_credencial_profissional(
  p_clinic_id uuid, p_user_id uuid, p_actor_role text, p_auth_method text, p_aal text,
  p_professional_user_id uuid, p_council_code text, p_council_state text,
  p_registration_number text, p_valid_until date, p_reason text,
  p_idempotency_key uuid, p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_record public.clinic_professional_credentials%rowtype;
  v_previous public.clinic_professional_credentials%rowtype;
  v_fingerprint text;
begin
  perform private.operacao_assert_owner(p_clinic_id, p_user_id, p_actor_role, p_auth_method, p_aal);
  if p_professional_user_id is null or p_idempotency_key is null or p_request_id is null
     or pg_catalog.char_length(pg_catalog.btrim(coalesce(p_reason, ''))) not between 3 and 500 then
    raise exception 'required_parameter_missing' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.clinic_members member
    where member.clinic_id = p_clinic_id and member.user_id = p_professional_user_id
      and member.status = 'active'
  ) then raise exception 'professional_member_not_found' using errcode = 'P0002'; end if;
  v_fingerprint := pg_catalog.md5(pg_catalog.jsonb_build_array(
    p_professional_user_id,
    pg_catalog.upper(pg_catalog.btrim(p_council_code)),
    pg_catalog.upper(pg_catalog.btrim(p_council_state)),
    pg_catalog.btrim(p_registration_number), p_valid_until,
    pg_catalog.btrim(p_reason)
  )::text);
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_clinic_id::text || ':professional-credential', 0
  ));
  select * into v_record from public.clinic_professional_credentials
  where clinic_id = p_clinic_id and idempotency_key = p_idempotency_key;
  if found then
    if v_record.payload_fingerprint <> v_fingerprint then
      raise exception 'idempotency_key_reused' using errcode = '23505';
    end if;
    return pg_catalog.jsonb_build_object('id', v_record.id, 'version', v_record.version,
      'status', v_record.status, 'idempotent', true);
  end if;
  select * into v_previous from public.clinic_professional_credential_current
  where clinic_id=p_clinic_id and user_id=p_professional_user_id
    and scope='post_procedure_followup';
  if found and v_previous.status in ('pending','verified') then
    raise exception 'credential_current_exists' using errcode='23505';
  end if;
  insert into public.clinic_professional_credentials (
    clinic_id,user_id,council_code,council_state,registration_number,valid_until,
    status,version,supersedes_id,idempotency_key,payload_fingerprint,configured_by
  ) values (
    p_clinic_id,p_professional_user_id,pg_catalog.upper(pg_catalog.btrim(p_council_code)),
    pg_catalog.upper(pg_catalog.btrim(p_council_state)),pg_catalog.btrim(p_registration_number),
    p_valid_until,'pending',coalesce(v_previous.version,0)+1,v_previous.id,
    p_idempotency_key,v_fingerprint,p_user_id
  ) returning * into v_record;
  perform private.operacao_log(p_clinic_id,p_user_id,p_actor_role,p_auth_method,
    'professional_credential',v_record.id,'professional_credential.configure',p_request_id,1,
    pg_catalog.md5(pg_catalog.jsonb_build_array(v_record.id,v_record.version,v_record.status)::text));
  return pg_catalog.jsonb_build_object('id',v_record.id,'version',v_record.version,
    'status',v_record.status,'idempotent',false);
end;
$function$;

-- Caminho tecnico: nao e exposto pela Edge Function. O verificador precisa
-- ser membro ativo diferente da profissional e de quem cadastrou o pending.
create function public.fase2_revisar_credencial_profissional_tecnica(
  p_clinic_id uuid, p_credential_id uuid, p_action text,
  p_evidence_id uuid, p_evidence_sha256 text, p_evidence_kind text,
  p_evidence_captured_at timestamptz, p_verified_by uuid, p_reason text,
  p_idempotency_key uuid, p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_previous public.clinic_professional_credentials%rowtype;
  v_record public.clinic_professional_credentials%rowtype;
  v_evidence public.clinic_professional_verification_evidence%rowtype;
  v_verifier_role text;
  v_fingerprint text;
begin
  if p_clinic_id is null or p_credential_id is null or p_evidence_id is null
     or p_verified_by is null or p_idempotency_key is null or p_request_id is null
     or p_action not in ('verify','revoke')
     or p_evidence_sha256 !~ '^[0-9a-f]{64}$'
     or p_evidence_kind not in ('document_review','council_registry_check','revocation_record')
     or p_evidence_captured_at is null
     or p_evidence_captured_at > pg_catalog.now() + interval '5 minutes'
     or pg_catalog.char_length(pg_catalog.btrim(coalesce(p_reason,''))) not between 3 and 500 then
    raise exception 'required_parameter_missing' using errcode='22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_clinic_id::text || ':professional-credential',0));
  v_fingerprint:=pg_catalog.md5(pg_catalog.jsonb_build_array(
    p_credential_id,p_action,p_evidence_id,p_evidence_sha256,p_evidence_kind,
    p_evidence_captured_at,p_verified_by,pg_catalog.btrim(p_reason))::text);
  select * into v_record from public.clinic_professional_credentials
  where clinic_id=p_clinic_id and idempotency_key=p_idempotency_key;
  if found then
    if v_record.payload_fingerprint<>v_fingerprint then
      raise exception 'idempotency_key_reused' using errcode='23505';
    end if;
    return pg_catalog.jsonb_build_object('id',v_record.id,'version',v_record.version,
      'status',v_record.status,'idempotent',true);
  end if;
  select credential.* into v_previous
  from public.clinic_professional_credential_current credential
  where credential.clinic_id=p_clinic_id
    and credential.user_id=(select source.user_id from public.clinic_professional_credentials source
      where source.clinic_id=p_clinic_id and source.id=p_credential_id)
    and credential.scope='post_procedure_followup';
  if not found or v_previous.id<>p_credential_id then
    raise exception 'credential_not_current' using errcode='40001';
  end if;
  select member.role into v_verifier_role from public.clinic_members member
  where member.clinic_id=p_clinic_id and member.user_id=p_verified_by and member.status='active';
  if not found or p_verified_by in (v_previous.user_id,v_previous.configured_by) then
    raise exception 'independent_credential_verifier_required' using errcode='42501';
  end if;
  select * into v_evidence from public.clinic_professional_verification_evidence
  where clinic_id=p_clinic_id and id=p_evidence_id;
  if found then
    if v_evidence.professional_user_id<>v_previous.user_id
       or v_evidence.evidence_sha256<>p_evidence_sha256
       or v_evidence.evidence_kind<>p_evidence_kind
       or v_evidence.captured_at<>p_evidence_captured_at
       or v_evidence.recorded_by<>p_verified_by then
      raise exception 'immutable_evidence_conflict' using errcode='23505';
    end if;
  else
    insert into public.clinic_professional_verification_evidence(
      id,clinic_id,professional_user_id,evidence_sha256,evidence_kind,captured_at,recorded_by
    ) values (
      p_evidence_id,p_clinic_id,v_previous.user_id,p_evidence_sha256,p_evidence_kind,
      p_evidence_captured_at,p_verified_by
    );
  end if;
  if p_action='verify' then
    if v_previous.status<>'pending' then
      raise exception 'credential_pending_required' using errcode='23514';
    end if;
    insert into public.clinic_professional_credentials(
      clinic_id,user_id,council_code,council_state,registration_number,scope,valid_until,
      status,version,supersedes_id,idempotency_key,payload_fingerprint,configured_by,
      verification_evidence_id,verified_by,verified_at
    ) values (
      p_clinic_id,v_previous.user_id,v_previous.council_code,v_previous.council_state,
      v_previous.registration_number,v_previous.scope,v_previous.valid_until,'verified',
      v_previous.version+1,v_previous.id,p_idempotency_key,v_fingerprint,
      v_previous.configured_by,p_evidence_id,p_verified_by,pg_catalog.now()
    ) returning * into v_record;
  else
    if v_previous.status='revoked' then
      raise exception 'credential_already_revoked' using errcode='23514';
    end if;
    insert into public.clinic_professional_credentials(
      clinic_id,user_id,council_code,council_state,registration_number,scope,valid_until,
      status,version,supersedes_id,idempotency_key,payload_fingerprint,configured_by,
      verification_evidence_id,verified_by,verified_at,revoked_by,revoked_at,revocation_reason
    ) values (
      p_clinic_id,v_previous.user_id,v_previous.council_code,v_previous.council_state,
      v_previous.registration_number,v_previous.scope,v_previous.valid_until,'revoked',
      v_previous.version+1,v_previous.id,p_idempotency_key,v_fingerprint,
      v_previous.configured_by,p_evidence_id,v_previous.verified_by,v_previous.verified_at,
      p_verified_by,pg_catalog.now(),pg_catalog.btrim(p_reason)
    ) returning * into v_record;
  end if;
  perform private.operacao_log(p_clinic_id,p_verified_by,v_verifier_role,'service_role',
    'professional_credential',v_record.id,'professional_credential.'||p_action,
    p_request_id,1,v_fingerprint);
  return pg_catalog.jsonb_build_object('id',v_record.id,'version',v_record.version,
    'status',v_record.status,'idempotent',false);
end;
$function$;

create function public.fase2_registrar_evidencia_marketing_assinada_tecnica(
  p_clinic_id uuid,p_patient_id uuid,p_channel text,p_term_id uuid,
  p_evidence_id uuid,p_signature_sha256 text,p_signed_at timestamptz,
  p_recorded_by uuid,p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_record public.patient_marketing_signature_evidence%rowtype;
  v_role text;
begin
  if p_clinic_id is null or p_patient_id is null or p_term_id is null
     or p_evidence_id is null or p_recorded_by is null or p_request_id is null
     or p_channel not in ('whatsapp','sms','email','telefone')
     or p_signature_sha256 !~ '^[0-9a-f]{64}$'
     or p_signed_at is null or p_signed_at>pg_catalog.now()+interval '5 minutes' then
    raise exception 'required_parameter_missing' using errcode='22023';
  end if;
  select member.role into v_role from public.clinic_members member
  where member.clinic_id=p_clinic_id and member.user_id=p_recorded_by and member.status='active';
  if not found then raise exception 'active_member_required' using errcode='42501'; end if;
  if not exists (select 1 from public.patients patient where patient.clinic_id=p_clinic_id
    and patient.id=p_patient_id) then raise exception 'patient_not_found' using errcode='P0002'; end if;
  if not exists (select 1 from public.consent_terms term where term.clinic_id=p_clinic_id
    and term.id=p_term_id and term.procedure_kind='marketing_reactivation' and term.active) then
    raise exception 'published_marketing_term_required' using errcode='42501';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_clinic_id::text||':marketing-evidence:'||p_evidence_id::text,0));
  select * into v_record from public.patient_marketing_signature_evidence
  where clinic_id=p_clinic_id and id=p_evidence_id;
  if found then
    if v_record.patient_id<>p_patient_id or v_record.channel<>p_channel
       or v_record.term_id<>p_term_id or v_record.signature_sha256<>p_signature_sha256
       or v_record.signed_at<>p_signed_at or v_record.recorded_by<>p_recorded_by then
      raise exception 'immutable_evidence_conflict' using errcode='23505';
    end if;
    return pg_catalog.jsonb_build_object('evidence_id',v_record.id,'idempotent',true);
  end if;
  insert into public.patient_marketing_signature_evidence(
    id,clinic_id,patient_id,channel,term_id,signature_sha256,signed_at,recorded_by
  ) values (
    p_evidence_id,p_clinic_id,p_patient_id,p_channel,p_term_id,p_signature_sha256,
    p_signed_at,p_recorded_by
  ) returning * into v_record;
  perform private.operacao_log(p_clinic_id,p_recorded_by,v_role,'service_role',
    'marketing_signature_evidence',v_record.id,'marketing_signature_evidence.record',
    p_request_id,1,pg_catalog.md5(pg_catalog.jsonb_build_array(
      v_record.id,v_record.term_id,v_record.signed_at)::text));
  return pg_catalog.jsonb_build_object('evidence_id',v_record.id,'idempotent',false);
end;
$function$;

create function public.operacao_registrar_consentimento_marketing(
  p_clinic_id uuid, p_user_id uuid, p_actor_role text, p_auth_method text, p_aal text,
  p_patient_id uuid, p_channel text, p_accepted boolean, p_signature_evidence_id uuid,
  p_idempotency_key uuid, p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_record public.patient_marketing_consent_events%rowtype;
  v_previous public.patient_marketing_consent_events%rowtype;
  v_evidence public.patient_marketing_signature_evidence%rowtype;
  v_term public.consent_terms%rowtype;
  v_fingerprint text;
begin
  perform private.operacao_assert_owner(p_clinic_id,p_user_id,p_actor_role,p_auth_method,p_aal);
  if p_patient_id is null or p_channel is null or p_accepted is null
     or p_idempotency_key is null or p_request_id is null
     or p_channel not in ('whatsapp','sms','email','telefone')
     or (p_accepted and p_signature_evidence_id is null)
     or (not p_accepted and p_signature_evidence_id is not null) then
    raise exception 'required_parameter_missing' using errcode = '22023';
  end if;
  v_fingerprint := pg_catalog.md5(pg_catalog.jsonb_build_array(
    p_patient_id,p_channel,p_accepted,p_signature_evidence_id
  )::text);
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'clinic:patient-timeline:'||p_clinic_id::text||':'||p_patient_id::text,0));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_clinic_id::text || ':marketing-consent:' || p_patient_id::text || ':' || p_channel,0));
  if not exists (select 1 from public.patients patient where patient.clinic_id=p_clinic_id
    and patient.id=p_patient_id for share) then
    raise exception 'patient_not_found' using errcode = 'P0002';
  end if;
  select * into v_record from public.patient_marketing_consent_events
  where clinic_id=p_clinic_id and idempotency_key=p_idempotency_key;
  if found then
    if v_record.payload_fingerprint <> v_fingerprint then
      raise exception 'idempotency_key_reused' using errcode='23505';
    end if;
    return pg_catalog.jsonb_build_object('id',v_record.id,'version',v_record.version,
      'accepted',v_record.accepted,'idempotent',true);
  end if;
  if p_accepted then
    select evidence.* into v_evidence from public.patient_marketing_signature_evidence evidence
    where evidence.clinic_id=p_clinic_id and evidence.id=p_signature_evidence_id
      and evidence.patient_id=p_patient_id and evidence.channel=p_channel;
    if not found then raise exception 'signed_marketing_evidence_required' using errcode='42501'; end if;
    select term.* into v_term from public.consent_terms term
    where term.clinic_id=p_clinic_id and term.id=v_evidence.term_id
      and term.procedure_kind='marketing_reactivation' and term.active;
    if not found then raise exception 'published_marketing_term_required' using errcode='42501'; end if;
    if exists (select 1 from public.patients patient where patient.clinic_id=p_clinic_id
      and patient.id=p_patient_id and patient.archived_at is not null) then
      raise exception 'patient_archived' using errcode='42501';
    end if;
  end if;
  select * into v_previous from public.patient_marketing_consent_events
  where clinic_id=p_clinic_id and patient_id=p_patient_id
    and purpose='reactivation' and channel=p_channel
  order by version desc,recorded_at desc,id desc limit 1;
  insert into public.patient_marketing_consent_events (
    clinic_id,patient_id,purpose,channel,accepted,effective_at,signature_evidence_id,
    term_id,term_version_snapshot,term_sha256_snapshot,supersedes_id,version,idempotency_key,
    payload_fingerprint,recorded_by
  ) values (
    p_clinic_id,p_patient_id,'reactivation',p_channel,p_accepted,
    case when p_accepted then v_evidence.signed_at else pg_catalog.now() end,
    case when p_accepted then v_evidence.id else null end,
    case when p_accepted then v_term.id else null end,
    case when p_accepted then v_term.version else null end,
    case when p_accepted then pg_catalog.lower(v_term.content_sha256) else null end,
    v_previous.id,coalesce(v_previous.version,0)+1,p_idempotency_key,v_fingerprint,p_user_id
  ) returning * into v_record;
  update public.acompanhamento_planos plan
  set status='cancelled',version=version+1,updated_at=pg_catalog.now()
  where plan.clinic_id=p_clinic_id and plan.patient_id=p_patient_id
    and plan.plan_kind='reactivation' and plan.marketing_channel=p_channel
    and plan.status='active';
  update public.retorno_fila queue
  set status='cancelado',next_action='nenhuma',next_action_at=null,
      closure_reason='Consentimento de marketing alterado.',version=version+1,
      updated_by=p_user_id,updated_at=pg_catalog.now()
  from public.retorno_recomendacoes recommendation
  join public.acompanhamento_planos plan
    on plan.clinic_id=recommendation.clinic_id and plan.id=recommendation.plan_id
  where queue.clinic_id=p_clinic_id and queue.recommendation_id=recommendation.id
    and plan.patient_id=p_patient_id and plan.plan_kind='reactivation'
    and plan.marketing_channel=p_channel and plan.status='cancelled'
    and queue.status not in ('concluido','cancelado','bloqueado');
  update public.retorno_recomendacoes recommendation
  set status='cancelada',cancelled_by=p_user_id,cancelled_at=pg_catalog.now(),
      cancellation_reason='Consentimento de marketing alterado.',version=version+1,
      updated_at=pg_catalog.now()
  from public.acompanhamento_planos plan
  where recommendation.clinic_id=p_clinic_id and recommendation.plan_id=plan.id
    and plan.patient_id=p_patient_id and plan.plan_kind='reactivation'
    and plan.marketing_channel=p_channel and plan.status='cancelled'
    and recommendation.status='ativa';
  perform private.operacao_log(p_clinic_id,p_user_id,p_actor_role,p_auth_method,
    'marketing_consent',v_record.id,'marketing_consent.record',p_request_id,1,
    pg_catalog.md5(pg_catalog.jsonb_build_array(v_record.id,v_record.version,v_record.accepted)::text));
  return pg_catalog.jsonb_build_object('id',v_record.id,'version',v_record.version,
    'accepted',v_record.accepted,'idempotent',false);
end;
$function$;

-- ---------------------------------------------------------------------------
-- Ativacoes atomicas: criam plano + recomendacoes + filas, nunca Agenda/CRM.
-- ---------------------------------------------------------------------------

create function public.operacao_listar_acompanhamentos_fase2(
  p_clinic_id uuid,p_user_id uuid,p_actor_role text,p_auth_method text,p_aal text,
  p_limit integer default 50,p_cursor_at timestamptz default null,
  p_cursor_kind text default null,p_cursor_id uuid default null
)
returns jsonb
language plpgsql
security definer
stable
set search_path = ''
as $function$
declare
  v_result jsonb;
begin
  perform private.operacao_assert_owner(p_clinic_id,p_user_id,p_actor_role,p_auth_method,p_aal);
  if p_limit not between 1 and 100
     or ((p_cursor_at is null)<>(p_cursor_kind is null))
     or ((p_cursor_at is null)<>(p_cursor_id is null))
     or (p_cursor_kind is not null and p_cursor_kind not in ('plan','post','reactivation')) then
    raise exception 'pagination_invalid' using errcode='22023';
  end if;
  with latest_attendance as materialized (
    select distinct on (attendance.patient_id)
      attendance.id,attendance.patient_id,attendance.protocol_id,attendance.procedure_kind,
      attendance.attended_at,attendance.version,attendance.status
    from public.atendimentos_realizados attendance
    where attendance.clinic_id=p_clinic_id and attendance.archived_at is null
      and attendance.status in ('realizado','concluido')
    order by attendance.patient_id,attendance.attended_at desc,attendance.id desc
  ), sources as materialized (
    select plan.created_at as sort_at,'plan'::text as source_kind,plan.id as source_id
    from public.acompanhamento_planos plan where plan.clinic_id=p_clinic_id
    union all
    select attendance.attended_at,'post',attendance.id
    from public.atendimentos_realizados attendance
    where attendance.clinic_id=p_clinic_id and attendance.archived_at is null
      and attendance.status='concluido'
      and not exists (select 1 from public.acompanhamento_planos plan
        where plan.clinic_id=p_clinic_id and plan.attendance_id=attendance.id
          and plan.plan_kind='post_procedure' and plan.status='active')
    union all
    select attendance.attended_at,'reactivation',attendance.id
    from latest_attendance attendance
    where (pg_catalog.now() at time zone 'America/Sao_Paulo')::date
        -(attendance.attended_at at time zone 'America/Sao_Paulo')::date>=60
      and not exists (select 1 from public.acompanhamento_planos plan
        where plan.clinic_id=p_clinic_id and plan.patient_id=attendance.patient_id
          and plan.plan_kind='reactivation' and plan.status='active')
  ), page_plus_one as materialized (
    select source.* from sources source
    where p_cursor_at is null
       or (source.sort_at,source.source_kind,source.source_id)<
          (p_cursor_at,p_cursor_kind,p_cursor_id)
    order by source.sort_at desc,source.source_kind desc,source.source_id desc
    limit p_limit+1
  ), selected_sources as materialized (
    select source.* from page_plus_one source
    order by source.sort_at desc,source.source_kind desc,source.source_id desc limit p_limit
  ), actor_credential as materialized (
    select exists (
      select 1 from public.clinic_professional_credential_current credential
      join public.clinic_members member on member.clinic_id=credential.clinic_id
        and member.user_id=credential.user_id and member.status='active'
      where credential.clinic_id=p_clinic_id and credential.user_id=p_user_id
        and credential.scope='post_procedure_followup' and credential.status='verified'
        and (credential.valid_until is null or credential.valid_until>=
          (pg_catalog.now() at time zone 'America/Sao_Paulo')::date)
    ) as active
  ), plan_rows as (
    select source.sort_at,source.source_kind,source.source_id,
      recommendation.plan_step as row_order,
      pg_catalog.jsonb_build_object(
        'id',recommendation.id,'plano_id',plan.id,'versao_plano',plan.version,
        'versao_fila',queue.version,'tipo',plan.plan_kind,'patient_id',plan.patient_id,
        'patient_name',patient.full_name,'attendance_id',plan.attendance_id,
        'procedure_kind',attendance.procedure_kind,'reference_at',plan.anchor_date,
        'due_at',recommendation.exact_date,'status',plan.status,
        'stage',coalesce(queue.next_action,'nenhuma'),'version',queue.version,
        'elegivel',(plan.status='active' and patient.archived_at is null
          and queue.status not in ('concluido','cancelado','bloqueado')),
        'bloqueio_codigo',case when patient.archived_at is not null then 'patient_archived'
          when plan.status<>'active' then 'plan_'||plan.status
          when queue.status in ('concluido','cancelado','bloqueado') then 'queue_'||queue.status
          else null end,
        'bloqueio_motivo',case when patient.archived_at is not null then 'Paciente arquivada.'
          when plan.status<>'active' then 'Acompanhamento encerrado ou invalidado.'
          when queue.status in ('concluido','cancelado','bloqueado') then 'Fila encerrada.' else null end,
        'responsavel_nome',member.display_name,'recomendacao_id',recommendation.id,
        'fila_id',queue.id,'activation_id',plan.activation_id,
        'activation_step',recommendation.plan_step,'offset_days',recommendation.offset_days,
        'recommendation_status',recommendation.status,'queue_status',queue.status,
        'next_action',queue.next_action,'next_action_at',queue.next_action_at,
        'responsible_user_id',queue.responsible_user_id,
        'canal',case when plan.plan_kind='reactivation' then plan.marketing_channel else null end
      ) as row_json
    from selected_sources source
    join public.acompanhamento_planos plan on source.source_kind='plan' and plan.id=source.source_id
      and plan.clinic_id=p_clinic_id
    join public.patients patient on patient.clinic_id=plan.clinic_id and patient.id=plan.patient_id
    join public.atendimentos_realizados attendance on attendance.clinic_id=plan.clinic_id
      and attendance.id=plan.attendance_id
    join public.retorno_recomendacoes recommendation on recommendation.clinic_id=plan.clinic_id
      and recommendation.plan_id=plan.id
    left join public.retorno_fila queue on queue.clinic_id=recommendation.clinic_id
      and queue.recommendation_id=recommendation.id
    left join public.clinic_members member on member.clinic_id=queue.clinic_id
      and member.user_id=queue.responsible_user_id
  ), post_rows as (
    select source.sort_at,source.source_kind,source.source_id,0::smallint as row_order,
      pg_catalog.jsonb_build_object(
        'id','post:'||attendance.id::text,'plano_id',null,'versao_plano',null,
        'versao_fila',null,'tipo','post_procedure','patient_id',attendance.patient_id,
        'patient_name',patient.full_name,'attendance_id',attendance.id,
        'procedure_kind',attendance.procedure_kind,'reference_at',attendance.attended_at,
        'due_at',null,'status','candidate','stage','pendente_ativacao',
        'version',attendance.version,'versao_atendimento',attendance.version,
        'elegivel',(credential.active and patient.archived_at is null),
        'bloqueio_codigo',case when patient.archived_at is not null then 'patient_archived'
          when not credential.active then 'active_professional_credential_required' else null end,
        'bloqueio_motivo',case when patient.archived_at is not null then 'Paciente arquivada.'
          when not credential.active then 'Credencial clinica verificada e vigente obrigatoria.' else null end,
        'responsavel_nome',null,'recomendacao_id',null,'fila_id',null,
        'activation_id',null,'canal',null
      ) as row_json
    from selected_sources source
    join public.atendimentos_realizados attendance on source.source_kind='post'
      and attendance.clinic_id=p_clinic_id and attendance.id=source.source_id
    join public.patients patient on patient.clinic_id=attendance.clinic_id
      and patient.id=attendance.patient_id
    cross join actor_credential credential
  ), reactivation_rows as (
    select source.sort_at,source.source_kind,source.source_id,0::smallint as row_order,
      pg_catalog.jsonb_build_object(
        'id','reactivation:'||attendance.patient_id::text,'plano_id',null,
        'versao_plano',null,'versao_fila',null,'tipo','reactivation',
        'patient_id',attendance.patient_id,'patient_name',patient.full_name,
        'attendance_id',attendance.id,'procedure_kind',attendance.procedure_kind,
        'reference_at',attendance.attended_at,'due_at',
          ((attendance.attended_at at time zone 'America/Sao_Paulo')::date+bucket.days),
        'status','candidate','stage','pendente_ativacao','version',attendance.version,
        'versao_atendimento',attendance.version,
        'elegivel',(patient.archived_at is null and consent.event_id is not null
          and not block.active_return and not block.future_appointment),
        'bloqueio_codigo',case when patient.archived_at is not null then 'patient_archived'
          when consent.event_id is null then 'marketing_consent_required'
          when block.active_return then 'active_return_exists'
          when block.future_appointment then 'future_appointment_exists' else null end,
        'bloqueio_motivo',case when patient.archived_at is not null then 'Paciente arquivada.'
          when consent.event_id is null then 'Consentimento de marketing assinado e vigente obrigatorio.'
          when block.active_return then 'Ja existe retorno ativo.'
          when block.future_appointment then 'Ja existe agendamento futuro.' else null end,
        'responsavel_nome',null,'recomendacao_id',null,'fila_id',null,
        'activation_id',null,'canal',consent.channel,'offset_days',bucket.days
      ) as row_json
    from selected_sources source
    join latest_attendance attendance on source.source_kind='reactivation'
      and attendance.id=source.source_id
    join public.patients patient on patient.clinic_id=p_clinic_id and patient.id=attendance.patient_id
    cross join lateral (select case
      when (pg_catalog.now() at time zone 'America/Sao_Paulo')::date-
        (attendance.attended_at at time zone 'America/Sao_Paulo')::date>=365 then 365
      when (pg_catalog.now() at time zone 'America/Sao_Paulo')::date-
        (attendance.attended_at at time zone 'America/Sao_Paulo')::date>=180 then 180
      when (pg_catalog.now() at time zone 'America/Sao_Paulo')::date-
        (attendance.attended_at at time zone 'America/Sao_Paulo')::date>=120 then 120
      when (pg_catalog.now() at time zone 'America/Sao_Paulo')::date-
        (attendance.attended_at at time zone 'America/Sao_Paulo')::date>=90 then 90
      else 60 end as days) bucket
    left join lateral (
      select consent_current.event_id,consent_current.channel
      from public.patient_marketing_consent_current consent_current
      where consent_current.clinic_id=p_clinic_id
        and consent_current.patient_id=attendance.patient_id
        and consent_current.purpose='reactivation' and consent_current.accepted
      order by pg_catalog.array_position(array['whatsapp','sms','email','telefone'],consent_current.channel),
        consent_current.recorded_at desc,consent_current.event_id desc limit 1
    ) consent on true
    cross join lateral (select
      exists (select 1 from public.retorno_fila queue where queue.clinic_id=p_clinic_id
        and queue.patient_id=attendance.patient_id
        and queue.status not in ('concluido','cancelado','bloqueado')) as active_return,
      exists (select 1 from public.patient_source_links link
        join public.agendamentos_clinica appointment on appointment.id=link.source_id
        where link.clinic_id=p_clinic_id and link.patient_id=attendance.patient_id
          and link.source_kind='agendamento' and link.status='confirmado'
          and appointment.arquivado_em is null and appointment.inicio_em>pg_catalog.now()
          and appointment.status in ('solicitado','aguardando_confirmacao','confirmado'))
        as future_appointment) block
  ), all_rows as materialized (
    select * from plan_rows union all select * from post_rows union all select * from reactivation_rows
  ), selected_patients as materialized (
    select distinct (row_json->>'patient_id')::uuid as patient_id from all_rows
  )
  select pg_catalog.jsonb_build_object(
    'acompanhamentos',coalesce((select pg_catalog.jsonb_agg(row_json order by sort_at desc,
      source_kind desc,source_id desc,row_order) from all_rows),'[]'::jsonb),
    'credenciais_profissionais',coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id',credential.id,'user_id',credential.user_id,'status',credential.status,
      'valid_until',credential.valid_until,'version',credential.version) order by credential.user_id)
      from public.clinic_professional_credential_current credential
      join public.clinic_members member on member.clinic_id=credential.clinic_id
        and member.user_id=credential.user_id and member.status='active'
      where credential.clinic_id=p_clinic_id),'[]'::jsonb),
    'consentimentos_marketing_atuais',coalesce((select pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object('event_id',consent_current.event_id,
        'patient_id',consent_current.patient_id,'channel',consent_current.channel,
        'accepted',consent_current.accepted,'effective_at',consent_current.effective_at,
        'version',consent_current.version) order by consent_current.patient_id,consent_current.channel)
      from public.patient_marketing_consent_current consent_current
      join selected_patients selected on selected.patient_id=consent_current.patient_id
      where consent_current.clinic_id=p_clinic_id
        and consent_current.purpose='reactivation'),'[]'::jsonb),
    'responsaveis',coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'user_id',member.user_id,'nome',member.display_name,'papel',member.role)
      order by member.display_name,member.user_id) from public.clinic_members member
      where member.clinic_id=p_clinic_id and member.status='active'),'[]'::jsonb),
    'automacao_mensagens',false,'decisao_clinica_automatica',false,
    'paginacao',pg_catalog.jsonb_build_object(
      'limite',p_limit,'has_more',(select pg_catalog.count(*)>p_limit from page_plus_one),
      'proximo_cursor',(select pg_catalog.jsonb_build_object('sort_at',sort_at,
        'kind',source_kind,'id',source_id) from selected_sources
        order by sort_at,source_kind,source_id limit 1))
  ) into v_result;
  return v_result;
end;
$function$;

create function public.operacao_ativar_sequencia_pos_procedimento(
  p_clinic_id uuid,p_user_id uuid,p_actor_role text,p_auth_method text,p_aal text,
  p_attendance_id uuid,p_expected_version integer,p_responsible_user_id uuid,
  p_offsets_days jsonb,p_activation_id uuid,
  p_idempotency_key uuid,p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_attendance public.atendimentos_realizados%rowtype;
  v_plan public.acompanhamento_planos%rowtype;
  v_offset record;
  v_recommendation_id uuid;
  v_queue_id uuid;
  v_fingerprint text;
  v_items jsonb := '[]'::jsonb;
  v_due_date date;
  v_patient_id uuid;
begin
  perform private.operacao_assert_owner(p_clinic_id,p_user_id,p_actor_role,p_auth_method,p_aal);
  if p_attendance_id is null or p_responsible_user_id is null
     or p_activation_id is null or p_idempotency_key is null or p_request_id is null
     or pg_catalog.jsonb_typeof(p_offsets_days) <> 'array'
     or pg_catalog.jsonb_array_length(p_offsets_days) not between 1 and 12 then
    raise exception 'required_parameter_missing' using errcode='22023';
  end if;
  if exists (
    select 1 from pg_catalog.jsonb_array_elements_text(p_offsets_days) value
    where value !~ '^[0-9]+$' or value::integer not between 1 and 3650
  ) or (select pg_catalog.count(*) from pg_catalog.jsonb_array_elements_text(p_offsets_days)) <>
       (select pg_catalog.count(distinct value::integer)
        from pg_catalog.jsonb_array_elements_text(p_offsets_days) value) then
    raise exception 'followup_steps_invalid' using errcode='23514';
  end if;
  v_fingerprint := pg_catalog.md5(pg_catalog.jsonb_build_array(
    p_attendance_id,p_expected_version,p_user_id,p_responsible_user_id,
    (select pg_catalog.jsonb_agg(value::integer order by value::integer)
      from pg_catalog.jsonb_array_elements_text(p_offsets_days) value),p_activation_id
  )::text);
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_clinic_id::text||':followup-activation:'||p_idempotency_key::text,0));
  select * into v_plan from public.acompanhamento_planos
  where clinic_id=p_clinic_id and idempotency_key=p_idempotency_key;
  if found then
    if v_plan.payload_fingerprint<>v_fingerprint then raise exception 'idempotency_key_reused' using errcode='23505'; end if;
    select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'recomendacao_id',recommendation.id,'fila_id',queue.id,'activation_step',recommendation.plan_step,
      'offset_days',recommendation.offset_days,'due_date',recommendation.exact_date
    ) order by recommendation.plan_step),'[]'::jsonb) into v_items
    from public.retorno_recomendacoes recommendation
    join public.retorno_fila queue on queue.clinic_id=recommendation.clinic_id
      and queue.recommendation_id=recommendation.id
    where recommendation.clinic_id=p_clinic_id and recommendation.plan_id=v_plan.id;
    return pg_catalog.jsonb_build_object('activation_id',v_plan.activation_id,'version',v_plan.version,
      'itens',v_items,'idempotent',true);
  end if;
  select attendance.patient_id into v_patient_id from public.atendimentos_realizados attendance
  where attendance.clinic_id=p_clinic_id and attendance.id=p_attendance_id;
  if not found then raise exception 'attendance_not_found' using errcode='P0002'; end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('fase2:attendance-timeline-global',0));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'clinic:patient-timeline:'||p_clinic_id::text||':'||v_patient_id::text,0));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_clinic_id::text||':followup-attendance:'||p_attendance_id::text,0));
  select * into v_attendance from public.atendimentos_realizados
  where clinic_id=p_clinic_id and id=p_attendance_id and archived_at is null for update;
  if not found then raise exception 'attendance_not_found' using errcode='P0002'; end if;
  if v_attendance.status<>'concluido' then raise exception 'attendance_not_completed' using errcode='23514'; end if;
  if v_attendance.patient_id<>v_patient_id or not exists (
    select 1 from public.patients patient where patient.clinic_id=p_clinic_id
      and patient.id=v_attendance.patient_id and patient.archived_at is null for share
  ) then raise exception 'patient_not_found' using errcode='P0002'; end if;
  if v_attendance.version<>p_expected_version then raise exception 'version_conflict' using errcode='40001'; end if;
  if exists (select 1 from public.acompanhamento_planos where clinic_id=p_clinic_id
    and attendance_id=p_attendance_id and plan_kind='post_procedure' and status='active') then
    raise exception 'active_followup_plan_exists' using errcode='23505';
  end if;
  if not exists (
    select 1 from public.clinic_professional_credential_current credential
    join public.clinic_members member on member.clinic_id=credential.clinic_id
      and member.user_id=credential.user_id
    where credential.clinic_id=p_clinic_id and credential.user_id=p_user_id
      and credential.scope='post_procedure_followup' and credential.status='verified'
      and (credential.valid_until is null or credential.valid_until>=
        (pg_catalog.now() at time zone 'America/Sao_Paulo')::date)
      and member.status='active'
  ) then raise exception 'active_professional_credential_required' using errcode='42501'; end if;
  if not exists (select 1 from public.clinic_members where clinic_id=p_clinic_id
    and user_id=p_responsible_user_id and status='active') then
    raise exception 'responsible_not_found' using errcode='P0002';
  end if;
  if exists (
    select 1
    from pg_catalog.jsonb_array_elements_text(p_offsets_days) value
    join public.retorno_recomendacoes recommendation
      on recommendation.clinic_id=p_clinic_id
     and recommendation.attendance_id=p_attendance_id
     and recommendation.status in ('ativa','convertida')
     and recommendation.exact_date=
       (v_attendance.attended_at at time zone 'America/Sao_Paulo')::date+value::integer
  ) then raise exception 'followup_step_conflict' using errcode='23505'; end if;
  insert into public.acompanhamento_planos (
    clinic_id,patient_id,attendance_id,protocol_id,plan_kind,anchor_date,
    validated_by,validated_at,activation_id,idempotency_key,payload_fingerprint,created_by
  ) values (
    p_clinic_id,v_attendance.patient_id,v_attendance.id,v_attendance.protocol_id,'post_procedure',
    (v_attendance.attended_at at time zone 'America/Sao_Paulo')::date,
    p_user_id,pg_catalog.now(),p_activation_id,p_idempotency_key,v_fingerprint,p_user_id
  ) returning * into v_plan;
  for v_offset in
    select value::integer as days,pg_catalog.row_number() over(order by value::integer)::smallint as step
    from pg_catalog.jsonb_array_elements_text(p_offsets_days) value order by value::integer
  loop
    v_due_date:=v_plan.anchor_date+v_offset.days;
    insert into public.retorno_recomendacoes (
      clinic_id,attendance_id,patient_id,protocol_id,recommendation_kind,exact_date,
      instruction,validated_by,idempotency_key,payload_fingerprint,plan_id,plan_step,offset_days
    ) values (
      p_clinic_id,v_attendance.id,v_attendance.patient_id,v_attendance.protocol_id,
      'acompanhamento_pos_procedimento',v_due_date,null,p_user_id,
      pg_catalog.gen_random_uuid(),pg_catalog.md5(pg_catalog.jsonb_build_array(v_plan.id,v_offset.step,v_offset.days)::text),
      v_plan.id,v_offset.step,v_offset.days
    ) returning id into v_recommendation_id;
    insert into public.retorno_fila (
      clinic_id,recommendation_id,patient_id,responsible_user_id,status,next_action,next_action_at,created_by
    ) values (
      p_clinic_id,v_recommendation_id,v_attendance.patient_id,p_responsible_user_id,
      'pendente','contatar',(v_due_date+time '09:00') at time zone 'America/Sao_Paulo',p_user_id
    ) returning id into v_queue_id;
    v_items:=v_items||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'recomendacao_id',v_recommendation_id,'fila_id',v_queue_id,'activation_step',v_offset.step,
      'offset_days',v_offset.days,'due_date',v_due_date));
  end loop;
  perform private.operacao_log(p_clinic_id,p_user_id,p_actor_role,p_auth_method,
    'followup_plan',v_plan.id,'followup_plan.activate',p_request_id,pg_catalog.jsonb_array_length(v_items),v_fingerprint);
  return pg_catalog.jsonb_build_object('activation_id',v_plan.activation_id,'version',v_plan.version,
    'itens',v_items,'idempotent',false);
end;
$function$;

create function public.operacao_ativar_reativacao(
  p_clinic_id uuid,p_user_id uuid,p_actor_role text,p_auth_method text,p_aal text,
  p_patient_id uuid,p_last_attendance_id uuid,p_expected_attendance_version integer,
  p_channel text,p_responsible_user_id uuid,
  p_activation_id uuid,p_idempotency_key uuid,p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_patient public.patients%rowtype;
  v_attendance public.atendimentos_realizados%rowtype;
  v_plan public.acompanhamento_planos%rowtype;
  v_consent public.patient_marketing_consent_events%rowtype;
  v_recommendation_id uuid;
  v_queue_id uuid;
  v_due_date date;
  v_interval_days integer;
  v_fingerprint text;
begin
  perform private.operacao_assert_owner(p_clinic_id,p_user_id,p_actor_role,p_auth_method,p_aal);
  if p_patient_id is null or p_last_attendance_id is null
     or p_channel is null
     or p_responsible_user_id is null or p_activation_id is null
     or p_idempotency_key is null or p_request_id is null then
    raise exception 'required_parameter_missing' using errcode='22023';
  end if;
  v_fingerprint:=pg_catalog.md5(pg_catalog.jsonb_build_array(
    p_patient_id,p_last_attendance_id,p_expected_attendance_version,
    p_channel,p_responsible_user_id,p_activation_id
  )::text);
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_clinic_id::text||':reactivation-idempotency:'||p_idempotency_key::text,0));
  select * into v_plan from public.acompanhamento_planos
  where clinic_id=p_clinic_id and idempotency_key=p_idempotency_key;
  if found then
    if v_plan.payload_fingerprint<>v_fingerprint then raise exception 'idempotency_key_reused' using errcode='23505'; end if;
    select recommendation.id,queue.id into v_recommendation_id,v_queue_id
    from public.retorno_recomendacoes recommendation
    join public.retorno_fila queue on queue.clinic_id=recommendation.clinic_id
      and queue.recommendation_id=recommendation.id
    where recommendation.clinic_id=p_clinic_id and recommendation.plan_id=v_plan.id;
    return pg_catalog.jsonb_build_object('activation_id',v_plan.activation_id,'version',v_plan.version,
      'itens',pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'recomendacao_id',v_recommendation_id,'fila_id',v_queue_id,'activation_step',1,
        'offset_days',v_plan.interval_days,'due_date',v_plan.anchor_date+v_plan.interval_days)),
      'idempotent',true);
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('fase2:attendance-timeline-global',0));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'clinic:patient-timeline:'||p_clinic_id::text||':'||p_patient_id::text,0));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_clinic_id::text||':marketing-consent:'||p_patient_id::text||':'||p_channel,0));
  select * into v_patient from public.patients
  where clinic_id=p_clinic_id and id=p_patient_id for share;
  if not found or v_patient.archived_at is not null then raise exception 'patient_not_found' using errcode='P0002'; end if;
  select * into v_attendance from public.atendimentos_realizados
  where clinic_id=p_clinic_id and patient_id=p_patient_id and archived_at is null
    and status in ('realizado','concluido')
  order by (attended_at at time zone 'America/Sao_Paulo')::date desc,attended_at desc,id desc
  limit 1 for share;
  if not found then raise exception 'completed_attendance_required' using errcode='P0002'; end if;
  if v_attendance.id<>p_last_attendance_id then raise exception 'reactivation_anchor_changed' using errcode='40001'; end if;
  if v_attendance.version<>p_expected_attendance_version then raise exception 'version_conflict' using errcode='40001'; end if;
  v_interval_days := case
    when (pg_catalog.now() at time zone 'America/Sao_Paulo')::date - (v_attendance.attended_at at time zone 'America/Sao_Paulo')::date >= 365 then 365
    when (pg_catalog.now() at time zone 'America/Sao_Paulo')::date - (v_attendance.attended_at at time zone 'America/Sao_Paulo')::date >= 180 then 180
    when (pg_catalog.now() at time zone 'America/Sao_Paulo')::date - (v_attendance.attended_at at time zone 'America/Sao_Paulo')::date >= 120 then 120
    when (pg_catalog.now() at time zone 'America/Sao_Paulo')::date - (v_attendance.attended_at at time zone 'America/Sao_Paulo')::date >= 90 then 90
    when (pg_catalog.now() at time zone 'America/Sao_Paulo')::date - (v_attendance.attended_at at time zone 'America/Sao_Paulo')::date >= 60 then 60
    else null
  end;
  if v_interval_days is null then raise exception 'reactivation_not_due' using errcode='23514'; end if;
  if exists (select 1 from public.acompanhamento_planos where clinic_id=p_clinic_id
    and patient_id=p_patient_id and plan_kind='reactivation' and status='active') then
    raise exception 'active_reactivation_exists' using errcode='23505';
  end if;
  select event.* into v_consent from public.patient_marketing_consent_events event
  where event.clinic_id=p_clinic_id and event.patient_id=p_patient_id
    and event.purpose='reactivation' and event.channel=p_channel
    and event.effective_at<=pg_catalog.now()
  order by event.version desc,event.recorded_at desc,event.id desc limit 1;
  if not found or not v_consent.accepted then raise exception 'marketing_consent_required' using errcode='42501'; end if;
  if exists (select 1 from public.retorno_fila queue
    where queue.clinic_id=p_clinic_id and queue.patient_id=p_patient_id
      and queue.status not in ('concluido','cancelado','bloqueado')) then
    raise exception 'active_return_exists' using errcode='23505';
  end if;
  if exists (
    select 1 from public.patient_source_links link
    join public.agendamentos_clinica appointment on appointment.id=link.source_id
    where link.clinic_id=p_clinic_id and link.patient_id=p_patient_id
      and link.source_kind='agendamento' and link.status='confirmado'
      and appointment.arquivado_em is null and appointment.inicio_em>pg_catalog.now()
      and appointment.status in ('solicitado','aguardando_confirmacao','confirmado')
  ) then raise exception 'future_appointment_exists' using errcode='23505'; end if;
  if not exists (select 1 from public.clinic_members where clinic_id=p_clinic_id
    and user_id=p_responsible_user_id and status='active') then
    raise exception 'responsible_not_found' using errcode='P0002';
  end if;
  v_due_date:=(v_attendance.attended_at at time zone 'America/Sao_Paulo')::date+v_interval_days;
  insert into public.acompanhamento_planos (
    clinic_id,patient_id,attendance_id,protocol_id,plan_kind,anchor_date,interval_days,
    marketing_channel,marketing_consent_event_id,activation_id,idempotency_key,payload_fingerprint,created_by
  ) values (
    p_clinic_id,p_patient_id,v_attendance.id,v_attendance.protocol_id,'reactivation',
    (v_attendance.attended_at at time zone 'America/Sao_Paulo')::date,v_interval_days,
    p_channel,v_consent.id,p_activation_id,p_idempotency_key,v_fingerprint,p_user_id
  ) returning * into v_plan;
  insert into public.retorno_recomendacoes (
    clinic_id,attendance_id,patient_id,protocol_id,recommendation_kind,exact_date,
    instruction,validated_by,idempotency_key,payload_fingerprint,plan_id,plan_step,offset_days
  ) values (
    p_clinic_id,v_attendance.id,p_patient_id,v_attendance.protocol_id,'reativacao_programada',
    v_due_date,null,p_user_id,pg_catalog.gen_random_uuid(),
    pg_catalog.md5(pg_catalog.jsonb_build_array(v_plan.id,1,v_interval_days)::text),v_plan.id,1,v_interval_days
  ) returning id into v_recommendation_id;
  insert into public.retorno_fila (
    clinic_id,recommendation_id,patient_id,responsible_user_id,status,next_action,next_action_at,created_by
  ) values (
    p_clinic_id,v_recommendation_id,p_patient_id,p_responsible_user_id,'pendente','contatar',
    (v_due_date+time '09:00') at time zone 'America/Sao_Paulo',p_user_id
  ) returning id into v_queue_id;
  perform private.operacao_log(p_clinic_id,p_user_id,p_actor_role,p_auth_method,
    'reactivation_plan',v_plan.id,'reactivation_plan.activate',p_request_id,1,v_fingerprint);
  return pg_catalog.jsonb_build_object('activation_id',v_plan.activation_id,'version',v_plan.version,
    'itens',pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'recomendacao_id',v_recommendation_id,'fila_id',v_queue_id,'activation_step',1,
      'offset_days',v_interval_days,'due_date',v_due_date)),'idempotent',false);
end;
$function$;

create function public.operacao_registrar_tentativa_reativacao(
  p_clinic_id uuid,p_user_id uuid,p_actor_role text,p_auth_method text,p_aal text,
  p_plan_id uuid,p_expected_plan_version integer,p_queue_id uuid,p_expected_queue_version integer,
  p_result text,p_next_action text,p_next_action_at timestamptz,p_attempted_at timestamptz,
  p_idempotency_key uuid,p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_plan public.acompanhamento_planos%rowtype;
  v_queue public.retorno_fila%rowtype;
  v_consent public.patient_marketing_consent_events%rowtype;
  v_attempt public.reactivation_contact_attempts%rowtype;
  v_fingerprint text;
  v_attempt_id uuid := pg_catalog.gen_random_uuid();
  v_attempted_at timestamptz;
begin
  perform private.operacao_assert_owner(p_clinic_id,p_user_id,p_actor_role,p_auth_method,p_aal);
  if p_plan_id is null or p_queue_id is null or p_result is null or p_next_action is null
     or p_idempotency_key is null or p_request_id is null
     or coalesce(p_attempted_at,pg_catalog.now())>pg_catalog.now()+interval '5 minutes' then
    raise exception 'required_parameter_missing' using errcode='22023';
  end if;
  v_attempted_at:=coalesce(p_attempted_at,pg_catalog.now());
  if v_attempted_at<pg_catalog.now()-interval '15 minutes' then
    raise exception 'historical_attempt_import_required' using errcode='42501';
  end if;
  if (p_result='recusou' and (p_next_action<>'nenhuma' or p_next_action_at is not null))
     or (p_result='sem_resposta' and (p_next_action<>'recontatar' or p_next_action_at is null))
     or (p_result='canal_indisponivel' and (p_next_action<>'recontatar' or p_next_action_at is null))
     or (p_result='respondeu' and (p_next_action<>'aguardar_resposta' or p_next_action_at is null))
     or (p_result='agendou' and (p_next_action<>'confirmar_agenda' or p_next_action_at is null))
     or (p_result<>'recusou' and p_next_action_at<=v_attempted_at) then
    raise exception 'reactivation_attempt_transition_invalid' using errcode='23514';
  end if;
  v_fingerprint:=pg_catalog.md5(pg_catalog.jsonb_build_array(
    p_plan_id,p_expected_plan_version,p_queue_id,p_expected_queue_version,p_result,
    p_next_action,p_next_action_at,p_attempted_at
  )::text);
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_clinic_id::text||':reactivation-attempt:'||p_idempotency_key::text,0));
  select * into v_attempt from public.reactivation_contact_attempts
  where clinic_id=p_clinic_id and idempotency_key=p_idempotency_key;
  if found then
    if v_attempt.payload_fingerprint<>v_fingerprint then raise exception 'idempotency_key_reused' using errcode='23505'; end if;
    return v_attempt.response_snapshot || pg_catalog.jsonb_build_object('idempotent',true);
  end if;
  select * into v_plan from public.acompanhamento_planos
  where clinic_id=p_clinic_id and id=p_plan_id;
  if not found or v_plan.plan_kind<>'reactivation' then raise exception 'reactivation_plan_not_found' using errcode='P0002'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'clinic:patient-timeline:'||p_clinic_id::text||':'||v_plan.patient_id::text,0));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_clinic_id::text||':marketing-consent:'||v_plan.patient_id::text||':'||v_plan.marketing_channel,0));
  if not exists (select 1 from public.patients patient where patient.clinic_id=p_clinic_id
    and patient.id=v_plan.patient_id and patient.archived_at is null for share) then
    raise exception 'patient_archived' using errcode='42501';
  end if;
  select * into v_plan from public.acompanhamento_planos
  where clinic_id=p_clinic_id and id=p_plan_id for update;
  if not found or v_plan.plan_kind<>'reactivation' then raise exception 'reactivation_plan_not_found' using errcode='P0002'; end if;
  if v_plan.status<>'active' then raise exception 'reactivation_plan_closed' using errcode='42501'; end if;
  if v_plan.version<>p_expected_plan_version then raise exception 'version_conflict' using errcode='40001'; end if;
  select queue.* into v_queue from public.retorno_fila queue
  join public.retorno_recomendacoes recommendation
    on recommendation.clinic_id=queue.clinic_id and recommendation.id=queue.recommendation_id
  where queue.clinic_id=p_clinic_id and queue.id=p_queue_id and recommendation.plan_id=p_plan_id
  for update of queue;
  if not found then raise exception 'return_queue_not_found' using errcode='P0002'; end if;
  if v_queue.status in ('concluido','cancelado','bloqueado') then raise exception 'return_queue_closed' using errcode='42501'; end if;
  if v_queue.version<>p_expected_queue_version then raise exception 'version_conflict' using errcode='40001'; end if;
  select * into v_consent from public.patient_marketing_consent_events
  where clinic_id=p_clinic_id and patient_id=v_plan.patient_id
    and purpose='reactivation' and channel=v_plan.marketing_channel
    and effective_at<=v_attempted_at and recorded_at<=v_attempted_at
  order by version desc,recorded_at desc,id desc limit 1;
  if not found or not v_consent.accepted then raise exception 'marketing_consent_required' using errcode='42501'; end if;
  if v_consent.id<>v_plan.marketing_consent_event_id then raise exception 'marketing_consent_changed' using errcode='40001'; end if;
  insert into public.reactivation_contact_attempts (
    id,clinic_id,plan_id,queue_id,patient_id,consent_event_id,channel,result,
    next_action,next_action_at,attempted_by,attempted_at,idempotency_key,payload_fingerprint,
    response_snapshot
  ) values (
    v_attempt_id,p_clinic_id,v_plan.id,v_queue.id,v_plan.patient_id,v_consent.id,v_plan.marketing_channel,p_result,
    p_next_action,p_next_action_at,p_user_id,v_attempted_at,
    p_idempotency_key,v_fingerprint,pg_catalog.jsonb_build_object(
      'id',v_attempt_id,'fila_id',v_queue.id,'fila_versao',v_queue.version+1,
      'fila_status',case when p_result='agendou' then 'aguardando_paciente'
        when p_result='recusou' then 'bloqueado' else 'em_contato' end,
      'plano_status',case when p_result='recusou' then 'cancelled' else 'active' end,
      'mensagem_enviada',false
    )
  ) returning * into v_attempt;
  update public.retorno_fila set
    status=case when p_result='agendou' then 'aguardando_paciente'
      when p_result='recusou' then 'bloqueado' else 'em_contato' end,
    next_action=case when p_result='recusou' then 'nenhuma' else p_next_action end,
    next_action_at=case when p_result='recusou' then null else p_next_action_at end,
    closure_reason=case when p_result='recusou' then 'Paciente recusou a reativacao.' else null end,
    attempt_count=attempt_count+1,last_attempt_at=v_attempt.attempted_at,
    version=version+1,updated_by=p_user_id,updated_at=pg_catalog.now()
  where clinic_id=p_clinic_id and id=v_queue.id returning * into v_queue;
  if p_result='recusou' then
    update public.acompanhamento_planos set status='cancelled',version=version+1,
      updated_at=pg_catalog.now() where clinic_id=p_clinic_id and id=v_plan.id;
    update public.retorno_recomendacoes set status='cancelada',cancelled_by=p_user_id,
      cancelled_at=pg_catalog.now(),cancellation_reason='Paciente recusou a reativacao.',
      version=version+1,updated_at=pg_catalog.now()
    where clinic_id=p_clinic_id and plan_id=v_plan.id and status='ativa';
  end if;
  perform private.operacao_log(p_clinic_id,p_user_id,p_actor_role,p_auth_method,
    'reactivation_attempt',v_attempt.id,'reactivation_attempt.record',p_request_id,1,v_fingerprint);
  return v_attempt.response_snapshot || pg_catalog.jsonb_build_object('idempotent',false);
end;
$function$;

-- ---------------------------------------------------------------------------
-- RLS e grants Edge-only.
-- ---------------------------------------------------------------------------

alter table public.clinic_professional_credentials enable row level security;
alter table public.clinic_professional_verification_evidence enable row level security;
alter table public.patient_marketing_signature_evidence enable row level security;
alter table public.patient_marketing_consent_events enable row level security;
alter table public.acompanhamento_planos enable row level security;
alter table public.reactivation_contact_attempts enable row level security;

revoke all on public.clinic_professional_credentials from public,anon,authenticated,service_role;
revoke all on public.clinic_professional_verification_evidence from public,anon,authenticated,service_role;
revoke all on public.clinic_professional_credential_current from public,anon,authenticated,service_role;
revoke all on public.patient_marketing_signature_evidence from public,anon,authenticated,service_role;
revoke all on public.patient_marketing_consent_events from public,anon,authenticated,service_role;
revoke all on public.patient_marketing_consent_current from public,anon,authenticated,service_role;
revoke all on public.acompanhamento_planos from public,anon,authenticated,service_role;
revoke all on public.reactivation_contact_attempts from public,anon,authenticated,service_role;
grant select on public.clinic_professional_credentials to service_role;
grant select on public.clinic_professional_verification_evidence to service_role;
grant select on public.clinic_professional_credential_current to service_role;
grant select on public.patient_marketing_signature_evidence to service_role;
grant select on public.patient_marketing_consent_events to service_role;
grant select on public.patient_marketing_consent_current to service_role;
grant select on public.acompanhamento_planos to service_role;
grant select on public.reactivation_contact_attempts to service_role;

revoke all on function private.fase2_guard_append_only() from public,anon,authenticated,service_role;
revoke all on function private.fase2_lock_patient_timeline() from public,anon,authenticated,service_role;
revoke all on function private.fase2_invalidate_reactivation() from public,anon,authenticated,service_role;
revoke all on function private.fase2_cancel_followups_for_archived_patient() from public,anon,authenticated,service_role;

revoke all on function public.operacao_configurar_credencial_profissional(uuid,uuid,text,text,text,uuid,text,text,text,date,text,uuid,uuid) from public,anon,authenticated,service_role;
revoke all on function public.fase2_revisar_credencial_profissional_tecnica(uuid,uuid,text,uuid,text,text,timestamptz,uuid,text,uuid,uuid) from public,anon,authenticated,service_role;
revoke all on function public.fase2_registrar_evidencia_marketing_assinada_tecnica(uuid,uuid,text,uuid,uuid,text,timestamptz,uuid,uuid) from public,anon,authenticated,service_role;
revoke all on function public.operacao_registrar_consentimento_marketing(uuid,uuid,text,text,text,uuid,text,boolean,uuid,uuid,uuid) from public,anon,authenticated,service_role;
revoke all on function public.operacao_listar_acompanhamentos_fase2(uuid,uuid,text,text,text,integer,timestamptz,text,uuid) from public,anon,authenticated,service_role;
revoke all on function public.operacao_ativar_sequencia_pos_procedimento(uuid,uuid,text,text,text,uuid,integer,uuid,jsonb,uuid,uuid,uuid) from public,anon,authenticated,service_role;
revoke all on function public.operacao_ativar_reativacao(uuid,uuid,text,text,text,uuid,uuid,integer,text,uuid,uuid,uuid,uuid) from public,anon,authenticated,service_role;
revoke all on function public.operacao_registrar_tentativa_reativacao(uuid,uuid,text,text,text,uuid,integer,uuid,integer,text,text,timestamptz,timestamptz,uuid,uuid) from public,anon,authenticated,service_role;

grant execute on function public.operacao_configurar_credencial_profissional(uuid,uuid,text,text,text,uuid,text,text,text,date,text,uuid,uuid) to service_role;
grant execute on function public.fase2_revisar_credencial_profissional_tecnica(uuid,uuid,text,uuid,text,text,timestamptz,uuid,text,uuid,uuid) to service_role;
grant execute on function public.fase2_registrar_evidencia_marketing_assinada_tecnica(uuid,uuid,text,uuid,uuid,text,timestamptz,uuid,uuid) to service_role;
grant execute on function public.operacao_registrar_consentimento_marketing(uuid,uuid,text,text,text,uuid,text,boolean,uuid,uuid,uuid) to service_role;
grant execute on function public.operacao_listar_acompanhamentos_fase2(uuid,uuid,text,text,text,integer,timestamptz,text,uuid) to service_role;
grant execute on function public.operacao_ativar_sequencia_pos_procedimento(uuid,uuid,text,text,text,uuid,integer,uuid,jsonb,uuid,uuid,uuid) to service_role;
grant execute on function public.operacao_ativar_reativacao(uuid,uuid,text,text,text,uuid,uuid,integer,text,uuid,uuid,uuid,uuid) to service_role;
grant execute on function public.operacao_registrar_tentativa_reativacao(uuid,uuid,text,text,text,uuid,integer,uuid,integer,text,text,timestamptz,timestamptz,uuid,uuid) to service_role;

comment on table public.acompanhamento_planos is
  'Agrupa etapas atomicas em retorno_recomendacoes/retorno_fila; nao envia mensagens e nao cria CRM/Agenda.';
comment on table public.patient_marketing_consent_events is
  'Consentimento marketing patient-level append-only; independente de preferencia operacional e de fotografia clinica.';

commit;

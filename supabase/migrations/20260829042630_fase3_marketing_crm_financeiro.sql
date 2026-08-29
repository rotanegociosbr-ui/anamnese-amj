-- Fase 3: marketing editorial, campanhas, indicacoes e atribuicao financeira manual.
-- Nenhuma rotina envia mensagem, publica conteudo ou cria registros clinicos.
begin;

create table public.marketing_campaigns (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete restrict,
  code text not null check (code ~ '^[a-z0-9][a-z0-9_-]{1,39}$'),
  name text not null check (char_length(pg_catalog.btrim(name)) between 2 and 160),
  channel text not null check (channel in ('instagram_organico','instagram_ads','facebook','google','google_maps','indicacao','paciente_atual','influenciadora','site','whatsapp','evento','parceria','outro')),
  objective text not null check (char_length(pg_catalog.btrim(objective)) between 2 and 300),
  planned_budget numeric(14,2) check (planned_budget is null or planned_budget >= 0),
  starts_on date not null,
  ends_on date,
  attribution_window_days integer not null default 30 check (attribution_window_days between 1 and 365),
  status text not null default 'ativa' check (status in ('rascunho','ativa','pausada','encerrada','arquivada')),
  version integer not null default 1 check (version > 0),
  created_by uuid not null references auth.users(id) on delete restrict,
  updated_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint marketing_campaigns_tenant_id unique (clinic_id,id),
  constraint marketing_campaigns_code_unique unique (clinic_id,code),
  constraint marketing_campaigns_dates check (ends_on is null or ends_on >= starts_on)
);
create index marketing_campaigns_status_idx on public.marketing_campaigns(clinic_id,status,starts_on desc);
create index marketing_campaigns_created_by_idx on public.marketing_campaigns(created_by);
create index marketing_campaigns_updated_by_idx on public.marketing_campaigns(updated_by);

alter table public.crm_leads add column campaign_id uuid;
alter table public.crm_leads add constraint crm_leads_campaign_fk foreign key (clinic_id,campaign_id)
  references public.marketing_campaigns(clinic_id,id) on delete restrict;
create index crm_leads_campaign_idx on public.crm_leads(clinic_id,campaign_id,created_at desc) where campaign_id is not null;
-- `source` legado e preservado integralmente. `campaign_id` e a atribuicao canonica.

create table public.marketing_lead_attribution_events (
  id bigint generated always as identity primary key,
  clinic_id uuid not null references public.clinics(id) on delete restrict,
  lead_id uuid not null,
  previous_campaign_id uuid,
  campaign_id uuid,
  reason text not null check (char_length(pg_catalog.btrim(reason)) between 3 and 300),
  idempotency_key uuid not null,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default pg_catalog.now(),
  foreign key (clinic_id,lead_id) references public.crm_leads(clinic_id,id) on delete restrict,
  foreign key (clinic_id,previous_campaign_id) references public.marketing_campaigns(clinic_id,id) on delete restrict,
  foreign key (clinic_id,campaign_id) references public.marketing_campaigns(clinic_id,id) on delete restrict,
  unique(clinic_id,idempotency_key)
);
create index marketing_lead_attr_timeline_idx on public.marketing_lead_attribution_events(clinic_id,lead_id,created_at desc);
create index marketing_lead_attr_campaign_idx on public.marketing_lead_attribution_events(clinic_id,campaign_id,created_at desc) where campaign_id is not null;
create index marketing_lead_attr_previous_campaign_idx on public.marketing_lead_attribution_events(clinic_id,previous_campaign_id) where previous_campaign_id is not null;
create index marketing_lead_attr_created_by_idx on public.marketing_lead_attribution_events(created_by);

create table public.marketing_campaign_financial_links (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete restrict,
  campaign_id uuid not null,
  entry_id uuid not null,
  link_kind text not null check (link_kind in ('investimento','receita')),
  lead_id uuid,
  patient_id uuid,
  state text not null default 'ativo' check (state in ('ativo','cancelado')),
  version integer not null default 1 check (version > 0),
  cancellation_reason text,
  cancelled_by uuid references auth.users(id) on delete restrict,
  cancelled_at timestamptz,
  idempotency_key uuid not null,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default pg_catalog.now(),
  constraint marketing_fin_link_tenant_id unique(clinic_id,id),
  foreign key (clinic_id,campaign_id) references public.marketing_campaigns(clinic_id,id) on delete restrict,
  foreign key (clinic_id,entry_id) references public.financeiro_lancamentos(clinic_id,id) on delete restrict,
  foreign key (clinic_id,lead_id) references public.crm_leads(clinic_id,id) on delete restrict,
  foreign key (clinic_id,patient_id) references public.patients(clinic_id,id) on delete restrict,
  unique(clinic_id,idempotency_key),
  check ((link_kind='investimento' and lead_id is null and patient_id is null) or
         (link_kind='receita' and lead_id is not null and patient_id is not null)),
  check ((state='ativo' and cancelled_at is null and cancelled_by is null and cancellation_reason is null) or
         (state='cancelado' and cancelled_at is not null and cancelled_by is not null and char_length(pg_catalog.btrim(cancellation_reason)) between 3 and 500))
);
create unique index marketing_fin_link_one_active_entry on public.marketing_campaign_financial_links(clinic_id,entry_id) where state='ativo';
create index marketing_fin_link_campaign_idx on public.marketing_campaign_financial_links(clinic_id,campaign_id,link_kind,created_at desc) where state='ativo';
create index marketing_fin_link_lead_idx on public.marketing_campaign_financial_links(clinic_id,lead_id) where lead_id is not null;
create index marketing_fin_link_patient_idx on public.marketing_campaign_financial_links(clinic_id,patient_id) where patient_id is not null;
create index marketing_fin_link_created_by_idx on public.marketing_campaign_financial_links(created_by);
create index marketing_fin_link_cancelled_by_idx on public.marketing_campaign_financial_links(cancelled_by) where cancelled_by is not null;

create table public.marketing_referrals (
  id uuid primary key default pg_catalog.gen_random_uuid(), clinic_id uuid not null references public.clinics(id) on delete restrict,
  referrer_patient_id uuid not null, referred_lead_id uuid not null, source text,
  status text not null default 'ativa' check(status in ('ativa','cancelada')), version integer not null default 1 check(version>0),
  cancellation_reason text, cancelled_by uuid references auth.users(id), cancelled_at timestamptz,
  idempotency_key uuid not null, created_by uuid not null references auth.users(id), updated_by uuid not null references auth.users(id),
  created_at timestamptz not null default pg_catalog.now(), updated_at timestamptz not null default pg_catalog.now(),
  unique(clinic_id,id), unique(clinic_id,idempotency_key), unique(clinic_id,referred_lead_id),
  foreign key(clinic_id,referrer_patient_id) references public.patients(clinic_id,id) on delete restrict,
  foreign key(clinic_id,referred_lead_id) references public.crm_leads(clinic_id,id) on delete restrict,
  check(source is null or (char_length(pg_catalog.btrim(source)) between 2 and 120 and source !~ '[[:cntrl:]]')),
  check((status='ativa' and cancellation_reason is null and cancelled_by is null and cancelled_at is null) or
        (status='cancelada' and char_length(pg_catalog.btrim(cancellation_reason)) between 3 and 500 and cancelled_by is not null and cancelled_at is not null))
);
create index marketing_referrals_status_idx on public.marketing_referrals(clinic_id,status,created_at desc);
create index marketing_referrals_referrer_idx on public.marketing_referrals(clinic_id,referrer_patient_id,created_at desc);
create index marketing_referrals_created_by_idx on public.marketing_referrals(created_by);
create index marketing_referrals_updated_by_idx on public.marketing_referrals(updated_by);
create index marketing_referrals_cancelled_by_idx on public.marketing_referrals(cancelled_by) where cancelled_by is not null;

create table public.marketing_content_items (
  id uuid primary key default pg_catalog.gen_random_uuid(), clinic_id uuid not null references public.clinics(id) on delete restrict,
  campaign_id uuid, title text not null check(char_length(pg_catalog.btrim(title)) between 2 and 200),
  pillar text not null, format text not null, channel text not null,
  status text not null default 'ideia' check(status in ('ideia','roteiro','gravacao','edicao','agendado','publicado','arquivado')),
  scheduled_at timestamptz, published_at timestamptz, cta text, script text, public_url text,
  version integer not null default 1 check(version>0), idempotency_key uuid not null,
  created_by uuid not null references auth.users(id), updated_by uuid not null references auth.users(id),
  created_at timestamptz not null default pg_catalog.now(), updated_at timestamptz not null default pg_catalog.now(),
  unique(clinic_id,id), unique(clinic_id,idempotency_key),
  foreign key(clinic_id,campaign_id) references public.marketing_campaigns(clinic_id,id) on delete restrict,
  check(char_length(pillar) between 2 and 80 and char_length(format) between 2 and 80 and char_length(channel) between 2 and 80),
  check(cta is null or char_length(cta)<=500), check(script is null or char_length(script)<=20000),
  check(public_url is null or (char_length(public_url)<=1000 and public_url ~ '^https://')),
  check(status<>'agendado' or scheduled_at is not null),
  check(status<>'publicado' or (published_at is not null and public_url is not null))
);
create index marketing_content_calendar_idx on public.marketing_content_items(clinic_id,scheduled_at,status) where status<>'arquivado';
create index marketing_content_campaign_idx on public.marketing_content_items(clinic_id,campaign_id) where campaign_id is not null;
create index marketing_content_created_by_idx on public.marketing_content_items(created_by);
create index marketing_content_updated_by_idx on public.marketing_content_items(updated_by);

create table public.marketing_operations (
 clinic_id uuid not null references public.clinics(id), idempotency_key uuid not null, action text not null,
 fingerprint text not null check (fingerprint ~ '^[a-f0-9]{32}$'), response jsonb not null,
 request_id uuid not null, actor_id uuid not null references auth.users(id), created_at timestamptz not null default pg_catalog.now(),
 primary key(clinic_id,idempotency_key), unique(clinic_id,request_id,action),
 check (char_length(action) between 2 and 80 and pg_catalog.pg_column_size(response) <= 32768)
);
create index marketing_operations_actor_idx on public.marketing_operations(actor_id);
create table public.marketing_audit_log (
 id bigint generated always as identity primary key, clinic_id uuid not null references public.clinics(id), actor_id uuid not null references auth.users(id),
 action text not null, entity_type text not null, entity_id uuid, before_version integer, after_version integer,
 reason text, request_id uuid not null, idempotency_key uuid not null, created_at timestamptz not null default pg_catalog.now(),
 unique(clinic_id,idempotency_key,action), unique(clinic_id,request_id,action),
 check (reason is null or reason in ('cadastro','edicao','atribuicao_manual','cancelamento_manual','arquivamento_manual'))
);
create index marketing_audit_timeline_idx on public.marketing_audit_log(clinic_id,created_at desc,id desc);
create index marketing_audit_actor_idx on public.marketing_audit_log(actor_id);

create table public.marketing_financial_link_cancellation_events (
  id bigint generated always as identity primary key,
  clinic_id uuid not null references public.clinics(id) on delete restrict,
  link_id uuid not null,
  previous_version integer not null check (previous_version > 0),
  resulting_version integer not null check (resulting_version = previous_version + 1),
  reason text not null check (char_length(pg_catalog.btrim(reason)) between 3 and 500),
  request_id uuid not null,
  idempotency_key uuid not null,
  cancelled_by uuid not null references auth.users(id) on delete restrict,
  cancelled_at timestamptz not null default pg_catalog.now(),
  foreign key (clinic_id,link_id) references public.marketing_campaign_financial_links(clinic_id,id) on delete restrict,
  unique(clinic_id,idempotency_key), unique(clinic_id,request_id)
);
create index marketing_fin_cancel_link_idx on public.marketing_financial_link_cancellation_events(clinic_id,link_id,cancelled_at desc);
create index marketing_fin_cancel_actor_idx on public.marketing_financial_link_cancellation_events(cancelled_by);

create table public.marketing_content_workflow_events (
  id bigint generated always as identity primary key,
  clinic_id uuid not null references public.clinics(id) on delete restrict,
  content_id uuid not null,
  from_status text,
  to_status text not null check(to_status in ('ideia','roteiro','gravacao','edicao','agendado','publicado','arquivado')),
  resulting_version integer not null check(resulting_version > 0),
  request_id uuid not null,
  idempotency_key uuid not null,
  changed_by uuid not null references auth.users(id) on delete restrict,
  changed_at timestamptz not null default pg_catalog.now(),
  foreign key(clinic_id,content_id) references public.marketing_content_items(clinic_id,id) on delete restrict,
  unique(clinic_id,idempotency_key), unique(clinic_id,request_id)
);
create index marketing_content_workflow_idx on public.marketing_content_workflow_events(clinic_id,content_id,changed_at desc);
create index marketing_content_workflow_actor_idx on public.marketing_content_workflow_events(changed_by);

create table public.marketing_manual_reason_events (
  id bigint generated always as identity primary key,
  clinic_id uuid not null references public.clinics(id) on delete restrict,
  entity_type text not null check(entity_type in ('campaign','content')),
  entity_id uuid not null,
  action text not null check(action in ('arquivar_campanha','arquivar_conteudo')),
  reason_text text not null check(
    char_length(pg_catalog.btrim(reason_text)) between 3 and 500
    and reason_text !~ '[[:cntrl:]]'
    and reason_text !~* '[^[:space:]@]+@[^[:space:]@]+'
    and reason_text !~ '(^|[^0-9])[0-9]{7,}([^0-9]|$)'
  ),
  request_id uuid not null,
  idempotency_key uuid not null,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default pg_catalog.now(),
  unique(clinic_id,idempotency_key),unique(clinic_id,request_id,action)
);
create index marketing_manual_reason_entity_idx on public.marketing_manual_reason_events(clinic_id,entity_type,entity_id,created_at desc);
create index marketing_manual_reason_created_by_idx on public.marketing_manual_reason_events(created_by);

create or replace function private.marketing_assert_owner(p_clinic_id uuid,p_actor_id uuid) returns void language plpgsql security definer set search_path='' as $$
begin
 if not exists(select 1 from public.clinic_members m where m.clinic_id=p_clinic_id and m.user_id=p_actor_id and m.role='owner' and m.status='active') then
  raise exception 'marketing_owner_required' using errcode='42501'; end if;
end $$;
create or replace function private.marketing_replay(
  p_clinic_id uuid,p_actor_id uuid,p_action text,p_idempotency_key uuid,p_request_id uuid,p_fingerprint text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v public.marketing_operations%rowtype;
begin
  perform private.marketing_assert_owner(p_clinic_id,p_actor_id);
  if p_idempotency_key is null or p_request_id is null or p_action is null
     or p_fingerprint !~ '^[a-f0-9]{32}$' then
    raise exception 'marketing_invalid_operation' using errcode='22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_clinic_id::text||':marketing:'||p_idempotency_key::text,0));
  select * into v from public.marketing_operations
   where clinic_id=p_clinic_id and idempotency_key=p_idempotency_key;
  if not found then return null; end if;
  if v.action<>p_action or v.fingerprint<>p_fingerprint then
    raise exception 'marketing_idempotency_key_reused' using errcode='23505';
  end if;
  return v.response||pg_catalog.jsonb_build_object('idempotent',true);
end $$;
create or replace function private.marketing_complete(
  p_clinic_id uuid,p_actor_id uuid,p_action text,p_idempotency_key uuid,p_request_id uuid,
  p_fingerprint text,p_response jsonb
) returns jsonb language plpgsql security definer set search_path='' as $$
begin
  if pg_catalog.pg_column_size(p_response)>32768 then
    raise exception 'marketing_response_too_large' using errcode='22023';
  end if;
  insert into public.marketing_operations(
    clinic_id,idempotency_key,action,fingerprint,response,request_id,actor_id
  ) values(
    p_clinic_id,p_idempotency_key,p_action,p_fingerprint,p_response,p_request_id,p_actor_id
  );
  return p_response||pg_catalog.jsonb_build_object('idempotent',false);
end $$;
create or replace function private.marketing_audit(
  p_clinic_id uuid,p_actor_id uuid,p_action text,p_entity_type text,p_entity_id uuid,
  p_before integer,p_after integer,p_reason text,p_request_id uuid,p_idempotency_key uuid
) returns void language plpgsql security definer set search_path='' as $$
begin
  insert into public.marketing_audit_log(
    clinic_id,actor_id,action,entity_type,entity_id,before_version,after_version,
    reason,request_id,idempotency_key
  ) values(
    p_clinic_id,p_actor_id,p_action,p_entity_type,p_entity_id,p_before,p_after,
    p_reason,p_request_id,p_idempotency_key
  );
end $$;
create or replace function private.marketing_append_only() returns trigger language plpgsql set search_path='' as $$ begin raise exception 'marketing_append_only' using errcode='42501'; end $$;
create trigger marketing_attr_append_only before update or delete on public.marketing_lead_attribution_events for each row execute function private.marketing_append_only();
create trigger marketing_ops_append_only before update or delete on public.marketing_operations for each row execute function private.marketing_append_only();
create trigger marketing_audit_append_only before update or delete on public.marketing_audit_log for each row execute function private.marketing_append_only();
create trigger marketing_cancel_events_append_only before update or delete on public.marketing_financial_link_cancellation_events for each row execute function private.marketing_append_only();
create trigger marketing_content_events_append_only before update or delete on public.marketing_content_workflow_events for each row execute function private.marketing_append_only();
create trigger marketing_manual_reason_append_only before update or delete on public.marketing_manual_reason_events for each row execute function private.marketing_append_only();

create or replace function private.marketing_fin_link_guard() returns trigger language plpgsql set search_path='' as $$
begin
 if tg_op='DELETE' then raise exception 'marketing_link_delete_forbidden' using errcode='42501'; end if;
 if new.clinic_id<>old.clinic_id or new.campaign_id<>old.campaign_id or new.entry_id<>old.entry_id or new.link_kind<>old.link_kind
    or new.lead_id is distinct from old.lead_id or new.patient_id is distinct from old.patient_id or new.created_by<>old.created_by then
   raise exception 'marketing_link_snapshot_immutable' using errcode='23514'; end if;
 if old.state='cancelado' then raise exception 'marketing_link_cancelled_immutable' using errcode='23514'; end if;
 return new;
end $$;
create trigger marketing_fin_link_guard before update or delete on public.marketing_campaign_financial_links for each row execute function private.marketing_fin_link_guard();

create or replace function private.marketing_lead_campaign_guard() returns trigger language plpgsql set search_path='' as $$
begin
 if tg_op='UPDATE' and new.campaign_id is distinct from old.campaign_id and (old.record_status='converted' or exists(select 1 from public.marketing_campaign_financial_links x where x.clinic_id=old.clinic_id and x.lead_id=old.id and x.state='ativo')) then
   raise exception 'marketing_campaign_attribution_immutable' using errcode='23514'; end if;
 if new.campaign_id is not null then select c.name into new.campaign from public.marketing_campaigns c where c.clinic_id=new.clinic_id and c.id=new.campaign_id; else new.campaign:=null; end if;
 return new;
end $$;
create trigger marketing_lead_campaign_guard before insert or update of campaign_id,campaign on public.crm_leads for each row execute function private.marketing_lead_campaign_guard();
-- Implementacoes finais: todas as mutacoes usam o mesmo contrato de replay,
-- fingerprint, request_id, lock e auditoria atomica.
create or replace function public.marketing_salvar_campanha(
  p_clinic_id uuid,p_actor_id uuid,p_id uuid,p_expected_version integer,
  p_idempotency_key uuid,p_request_id uuid,p_payload jsonb
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v public.marketing_campaigns%rowtype; v_cached jsonb; v_response jsonb;
  v_fp text:=pg_catalog.md5(pg_catalog.jsonb_build_array('salvar_campanha',p_id,p_expected_version,p_payload)::text);
  v_before integer;
begin
  v_cached:=private.marketing_replay(p_clinic_id,p_actor_id,'salvar_campanha',p_idempotency_key,p_request_id,v_fp);
  if v_cached is not null then return v_cached; end if;
  if pg_catalog.jsonb_typeof(p_payload)<>'object' or pg_catalog.pg_column_size(p_payload)>8192
     or p_expected_version is null or (p_id is null and p_expected_version<>0)
     or (p_id is not null and p_expected_version<=0) then
    raise exception 'marketing_invalid_campaign' using errcode='22023';
  end if;
  if coalesce(p_payload->>'status','rascunho')='arquivada' then
    raise exception 'marketing_archive_requires_protected_route' using errcode='42501';
  end if;
  if p_id is null then
    insert into public.marketing_campaigns(
      clinic_id,code,name,channel,objective,planned_budget,starts_on,ends_on,attribution_window_days,status,created_by,updated_by
    ) values(
      p_clinic_id,pg_catalog.lower(pg_catalog.btrim(p_payload->>'codigo')),
      pg_catalog.btrim(p_payload->>'nome'),p_payload->>'canal',pg_catalog.btrim(p_payload->>'objetivo'),
      nullif(p_payload->>'orcamento_planejado','')::numeric,
      (p_payload->>'inicio')::date,nullif(p_payload->>'fim','')::date,
      coalesce((p_payload->>'janela_atribuicao_dias')::integer,30),coalesce(p_payload->>'status','rascunho'),
      p_actor_id,p_actor_id
    ) returning * into v;
  else
    select * into v from public.marketing_campaigns where clinic_id=p_clinic_id and id=p_id for update;
    if not found then raise exception 'marketing_campaign_not_found' using errcode='P0002'; end if;
    if v.version<>p_expected_version then raise exception 'marketing_version_conflict' using errcode='40001'; end if;
    if v.status='arquivada' then raise exception 'marketing_campaign_immutable' using errcode='55000'; end if;
    v_before:=v.version;
    update public.marketing_campaigns set
      code=pg_catalog.lower(pg_catalog.btrim(p_payload->>'codigo')),
      name=pg_catalog.btrim(p_payload->>'nome'),channel=p_payload->>'canal',
      objective=pg_catalog.btrim(p_payload->>'objetivo'),planned_budget=nullif(p_payload->>'orcamento_planejado','')::numeric,
      starts_on=(p_payload->>'inicio')::date,
      ends_on=nullif(p_payload->>'fim','')::date,
      attribution_window_days=coalesce((p_payload->>'janela_atribuicao_dias')::integer,30),
      status=p_payload->>'status',version=version+1,updated_by=p_actor_id,updated_at=pg_catalog.now()
    where clinic_id=p_clinic_id and id=p_id returning * into v;
  end if;
  v_response:=pg_catalog.jsonb_build_object('id',v.id,'version',v.version,'status',v.status);
  perform private.marketing_audit(p_clinic_id,p_actor_id,'salvar_campanha','campaign',v.id,v_before,v.version,case when p_id is null then 'cadastro' else 'edicao' end,p_request_id,p_idempotency_key);
  return private.marketing_complete(p_clinic_id,p_actor_id,'salvar_campanha',p_idempotency_key,p_request_id,v_fp,v_response);
end $$;

create or replace function public.marketing_arquivar_campanha(
  p_clinic_id uuid,p_actor_id uuid,p_id uuid,p_expected_version integer,
  p_idempotency_key uuid,p_request_id uuid,p_reason text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v public.marketing_campaigns%rowtype; v_cached jsonb; v_response jsonb;
 v_fp text:=pg_catalog.md5(pg_catalog.jsonb_build_array('arquivar_campanha',p_id,p_expected_version,p_reason)::text);
begin
  v_cached:=private.marketing_replay(p_clinic_id,p_actor_id,'arquivar_campanha',p_idempotency_key,p_request_id,v_fp);
  if v_cached is not null then return v_cached; end if;
  select * into v from public.marketing_campaigns where clinic_id=p_clinic_id and id=p_id for update;
  if not found then raise exception 'marketing_campaign_not_found' using errcode='P0002'; end if;
  if v.version<>p_expected_version then raise exception 'marketing_version_conflict' using errcode='40001'; end if;
  if v.status='arquivada' then raise exception 'marketing_campaign_immutable' using errcode='55000'; end if;
  update public.marketing_campaigns set status='arquivada',version=version+1,updated_by=p_actor_id,updated_at=pg_catalog.now()
   where clinic_id=p_clinic_id and id=p_id returning * into v;
  insert into public.marketing_manual_reason_events(
    clinic_id,entity_type,entity_id,action,reason_text,request_id,idempotency_key,created_by
  ) values(p_clinic_id,'campaign',v.id,'arquivar_campanha',pg_catalog.btrim(p_reason),p_request_id,p_idempotency_key,p_actor_id);
  v_response:=pg_catalog.jsonb_build_object('id',v.id,'version',v.version,'status',v.status);
  perform private.marketing_audit(p_clinic_id,p_actor_id,'arquivar_campanha','campaign',v.id,p_expected_version,v.version,'arquivamento_manual',p_request_id,p_idempotency_key);
  return private.marketing_complete(p_clinic_id,p_actor_id,'arquivar_campanha',p_idempotency_key,p_request_id,v_fp,v_response);
end $$;

create or replace function public.marketing_vincular_lancamento(
  p_clinic_id uuid,p_actor_id uuid,p_campaign_id uuid,p_entry_id uuid,p_link_kind text,p_lead_id uuid,
  p_idempotency_key uuid,p_request_id uuid,p_reason text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_entry public.financeiro_lancamentos%rowtype; v_lead public.crm_leads%rowtype;
  v_campaign public.marketing_campaigns%rowtype; v_link public.marketing_campaign_financial_links%rowtype;
  v_cached jsonb; v_response jsonb; v_attributed_at timestamptz;
  v_fp text:=pg_catalog.md5(pg_catalog.jsonb_build_array('vincular_lancamento',p_campaign_id,p_entry_id,p_link_kind,p_lead_id,p_reason)::text);
begin
  v_cached:=private.marketing_replay(p_clinic_id,p_actor_id,'vincular_lancamento',p_idempotency_key,p_request_id,v_fp);
  if v_cached is not null then return v_cached; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_clinic_id::text||':entry:'||p_entry_id::text,0));
  select * into v_campaign from public.marketing_campaigns
   where clinic_id=p_clinic_id and id=p_campaign_id for update;
  if not found or v_campaign.status<>'ativa' then
    raise exception 'marketing_active_campaign_required' using errcode='55000';
  end if;
  select * into v_entry from public.financeiro_lancamentos
   where clinic_id=p_clinic_id and id=p_entry_id for share;
  if not found or v_entry.state<>'ativo' then raise exception 'marketing_entry_not_available' using errcode='55000'; end if;
  if exists(select 1 from public.marketing_campaign_financial_links x
            where x.clinic_id=p_clinic_id and x.entry_id=p_entry_id and x.state='ativo') then
    raise exception 'marketing_entry_already_linked' using errcode='23505';
  end if;
  if p_link_kind='investimento' then
    if v_entry.entry_type<>'despesa' or p_lead_id is not null then
      raise exception 'marketing_investment_requires_expense' using errcode='22023';
    end if;
  elsif p_link_kind='receita' then
    if v_entry.entry_type<>'receita' or v_entry.patient_id is null or p_lead_id is null then
      raise exception 'marketing_revenue_requires_patient_lead' using errcode='22023';
    end if;
    select * into v_lead from public.crm_leads where clinic_id=p_clinic_id and id=p_lead_id for share;
    if not found or v_lead.record_status<>'converted' or v_lead.campaign_id<>p_campaign_id
       or v_lead.patient_id is distinct from v_entry.patient_id then
      raise exception 'marketing_revenue_lead_mismatch' using errcode='23514';
    end if;
    select a.created_at into v_attributed_at from public.marketing_lead_attribution_events a
      where a.clinic_id=p_clinic_id and a.lead_id=p_lead_id and a.campaign_id=p_campaign_id
      order by a.created_at desc,a.id desc limit 1;
    if v_attributed_at is null or v_lead.converted_at<v_attributed_at
       or v_lead.converted_at>v_attributed_at+pg_catalog.make_interval(days=>v_campaign.attribution_window_days) then
      raise exception 'marketing_revenue_outside_attribution_window' using errcode='23514';
    end if;
  else
    raise exception 'marketing_link_kind_invalid' using errcode='22023';
  end if;
  insert into public.marketing_campaign_financial_links(
    clinic_id,campaign_id,entry_id,link_kind,lead_id,patient_id,idempotency_key,created_by
  ) values(
    p_clinic_id,p_campaign_id,p_entry_id,p_link_kind,
    case when p_link_kind='receita' then p_lead_id end,
    case when p_link_kind='receita' then v_entry.patient_id end,p_idempotency_key,p_actor_id
  ) returning * into v_link;
  v_response:=pg_catalog.jsonb_build_object('id',v_link.id,'version',v_link.version,'status',v_link.state);
  perform private.marketing_audit(p_clinic_id,p_actor_id,'vincular_lancamento','financial_link',v_link.id,null,v_link.version,'atribuicao_manual',p_request_id,p_idempotency_key);
  return private.marketing_complete(p_clinic_id,p_actor_id,'vincular_lancamento',p_idempotency_key,p_request_id,v_fp,v_response);
end $$;

create or replace function public.marketing_cancelar_vinculo(
  p_clinic_id uuid,p_actor_id uuid,p_id uuid,p_expected_version integer,
  p_idempotency_key uuid,p_request_id uuid,p_reason text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v public.marketing_campaign_financial_links%rowtype; v_cached jsonb; v_response jsonb;
 v_fp text:=pg_catalog.md5(pg_catalog.jsonb_build_array('cancelar_vinculo',p_id,p_expected_version,p_reason)::text);
begin
  v_cached:=private.marketing_replay(p_clinic_id,p_actor_id,'cancelar_vinculo',p_idempotency_key,p_request_id,v_fp);
  if v_cached is not null then return v_cached; end if;
  select * into v from public.marketing_campaign_financial_links where clinic_id=p_clinic_id and id=p_id for update;
  if not found then raise exception 'marketing_link_not_found' using errcode='P0002'; end if;
  if v.version<>p_expected_version then raise exception 'marketing_version_conflict' using errcode='40001'; end if;
  if v.state<>'ativo' then raise exception 'marketing_link_immutable' using errcode='55000'; end if;
  update public.marketing_campaign_financial_links set state='cancelado',version=version+1,
    cancellation_reason=p_reason,cancelled_by=p_actor_id,cancelled_at=pg_catalog.now()
   where clinic_id=p_clinic_id and id=p_id returning * into v;
  insert into public.marketing_financial_link_cancellation_events(
    clinic_id,link_id,previous_version,resulting_version,reason,request_id,idempotency_key,cancelled_by
  ) values(p_clinic_id,v.id,p_expected_version,v.version,p_reason,p_request_id,p_idempotency_key,p_actor_id);
  v_response:=pg_catalog.jsonb_build_object('id',v.id,'version',v.version,'status',v.state);
  perform private.marketing_audit(p_clinic_id,p_actor_id,'cancelar_vinculo','financial_link',v.id,p_expected_version,v.version,'cancelamento_manual',p_request_id,p_idempotency_key);
  return private.marketing_complete(p_clinic_id,p_actor_id,'cancelar_vinculo',p_idempotency_key,p_request_id,v_fp,v_response);
end $$;

create or replace function public.marketing_salvar_indicacao(
  p_clinic_id uuid,p_actor_id uuid,p_id uuid,p_expected_version integer,
  p_idempotency_key uuid,p_request_id uuid,p_payload jsonb
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v public.marketing_referrals%rowtype; v_cached jsonb; v_response jsonb; v_before integer;
 v_fp text:=pg_catalog.md5(pg_catalog.jsonb_build_array('salvar_indicacao',p_id,p_expected_version,p_payload)::text);
 v_referrer uuid:=nullif(p_payload->>'indicadora_paciente_id','')::uuid;
 v_lead uuid:=nullif(p_payload->>'lead_indicado_id','')::uuid;
begin
  v_cached:=private.marketing_replay(p_clinic_id,p_actor_id,'salvar_indicacao',p_idempotency_key,p_request_id,v_fp);
  if v_cached is not null then return v_cached; end if;
  if pg_catalog.jsonb_typeof(p_payload)<>'object' or pg_catalog.pg_column_size(p_payload)>4096
     or v_referrer is null or v_lead is null
     or (p_id is null and p_expected_version<>0) or (p_id is not null and p_expected_version<=0) then
    raise exception 'marketing_invalid_referral' using errcode='22023';
  end if;
  if not exists(select 1 from public.patients p where p.clinic_id=p_clinic_id and p.id=v_referrer and p.archived_at is null)
     or not exists(select 1 from public.crm_leads l where l.clinic_id=p_clinic_id and l.id=v_lead and l.record_status not in ('cancelled','archived')) then
    raise exception 'marketing_referral_party_unavailable' using errcode='23514';
  end if;
  if exists(select 1 from public.crm_leads l where l.clinic_id=p_clinic_id and l.id=v_lead and l.patient_id=v_referrer) then
    raise exception 'marketing_self_referral_forbidden' using errcode='23514';
  end if;
  if p_id is null then
    if exists(select 1 from public.marketing_referrals r where r.clinic_id=p_clinic_id and r.referred_lead_id=v_lead) then
      raise exception 'marketing_referral_already_registered' using errcode='23505';
    end if;
    insert into public.marketing_referrals(
      clinic_id,referrer_patient_id,referred_lead_id,source,idempotency_key,created_by,updated_by
    ) values(
      p_clinic_id,v_referrer,v_lead,nullif(pg_catalog.btrim(p_payload->>'origem'),''),p_idempotency_key,p_actor_id,p_actor_id
    ) returning * into v;
  else
    select * into v from public.marketing_referrals where clinic_id=p_clinic_id and id=p_id for update;
    if not found then raise exception 'marketing_referral_not_found' using errcode='P0002'; end if;
    if v.version<>p_expected_version then raise exception 'marketing_version_conflict' using errcode='40001'; end if;
    if v.status<>'ativa' then raise exception 'marketing_referral_immutable' using errcode='55000'; end if;
    v_before:=v.version;
    if v.referred_lead_id<>v_lead then raise exception 'marketing_referral_lead_immutable' using errcode='23514'; end if;
    update public.marketing_referrals set referrer_patient_id=v_referrer,
      source=nullif(pg_catalog.btrim(p_payload->>'origem'),''),version=version+1,
      updated_by=p_actor_id,updated_at=pg_catalog.now()
     where clinic_id=p_clinic_id and id=p_id returning * into v;
  end if;
  v_response:=pg_catalog.jsonb_build_object('id',v.id,'version',v.version,'status',v.status);
  perform private.marketing_audit(p_clinic_id,p_actor_id,'salvar_indicacao','referral',v.id,v_before,v.version,case when p_id is null then 'cadastro' else 'edicao' end,p_request_id,p_idempotency_key);
  return private.marketing_complete(p_clinic_id,p_actor_id,'salvar_indicacao',p_idempotency_key,p_request_id,v_fp,v_response);
end $$;

create or replace function public.marketing_cancelar_indicacao(
  p_clinic_id uuid,p_actor_id uuid,p_id uuid,p_expected_version integer,
  p_idempotency_key uuid,p_request_id uuid,p_reason text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v public.marketing_referrals%rowtype; v_cached jsonb; v_response jsonb;
 v_fp text:=pg_catalog.md5(pg_catalog.jsonb_build_array('cancelar_indicacao',p_id,p_expected_version,p_reason)::text);
begin
  v_cached:=private.marketing_replay(p_clinic_id,p_actor_id,'cancelar_indicacao',p_idempotency_key,p_request_id,v_fp);
  if v_cached is not null then return v_cached; end if;
  select * into v from public.marketing_referrals where clinic_id=p_clinic_id and id=p_id for update;
  if not found then raise exception 'marketing_referral_not_found' using errcode='P0002'; end if;
  if v.version<>p_expected_version then raise exception 'marketing_version_conflict' using errcode='40001'; end if;
  if v.status<>'ativa' then raise exception 'marketing_referral_immutable' using errcode='55000'; end if;
  update public.marketing_referrals set status='cancelada',version=version+1,cancellation_reason=p_reason,
    cancelled_by=p_actor_id,cancelled_at=pg_catalog.now(),updated_by=p_actor_id,updated_at=pg_catalog.now()
   where clinic_id=p_clinic_id and id=p_id returning * into v;
  v_response:=pg_catalog.jsonb_build_object('id',v.id,'version',v.version,'status',v.status);
  perform private.marketing_audit(p_clinic_id,p_actor_id,'cancelar_indicacao','referral',v.id,p_expected_version,v.version,'cancelamento_manual',p_request_id,p_idempotency_key);
  return private.marketing_complete(p_clinic_id,p_actor_id,'cancelar_indicacao',p_idempotency_key,p_request_id,v_fp,v_response);
end $$;

create or replace function private.marketing_content_transition_allowed(p_from text,p_to text) returns boolean
language sql immutable set search_path='' as $$
 select p_from=p_to or (p_from,p_to) in (
   ('ideia','roteiro'),('roteiro','gravacao'),('gravacao','edicao'),('edicao','agendado'),
   ('agendado','publicado'),('agendado','edicao'),('publicado','publicado')
 );
$$;

create or replace function public.marketing_salvar_conteudo(
  p_clinic_id uuid,p_actor_id uuid,p_id uuid,p_expected_version integer,
  p_idempotency_key uuid,p_request_id uuid,p_payload jsonb
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v public.marketing_content_items%rowtype; v_cached jsonb; v_response jsonb; v_before integer; v_from text;
 v_fp text:=pg_catalog.md5(pg_catalog.jsonb_build_array('salvar_conteudo',p_id,p_expected_version,p_payload)::text);
 v_status text:=coalesce(nullif(p_payload->>'status',''),'ideia');
begin
  v_cached:=private.marketing_replay(p_clinic_id,p_actor_id,'salvar_conteudo',p_idempotency_key,p_request_id,v_fp);
  if v_cached is not null then return v_cached; end if;
  if pg_catalog.jsonb_typeof(p_payload)<>'object' or pg_catalog.pg_column_size(p_payload)>24576
     or p_payload ?| array['patient_id','paciente_id','prontuario','diagnostico','anamnese','cpf','telefone','email']
     or (p_id is null and p_expected_version<>0) or (p_id is not null and p_expected_version<=0) then
    raise exception 'marketing_invalid_content' using errcode='22023';
  end if;
  if v_status='arquivado' then raise exception 'marketing_archive_route_required' using errcode='22023'; end if;
  if v_status='agendado' and nullif(p_payload->>'agendado_em','') is null then
    raise exception 'marketing_schedule_required' using errcode='22023';
  end if;
  if v_status='publicado' and (nullif(p_payload->>'publicado_em','') is null or nullif(p_payload->>'url_publica','') is null) then
    raise exception 'marketing_publication_evidence_required' using errcode='22023';
  end if;
  if nullif(p_payload->>'campanha_id','') is not null and not exists(
    select 1 from public.marketing_campaigns c where c.clinic_id=p_clinic_id
      and c.id=(p_payload->>'campanha_id')::uuid and c.status<>'arquivada'
  ) then raise exception 'marketing_campaign_not_available' using errcode='23514'; end if;
  if p_id is null then
    insert into public.marketing_content_items(
      clinic_id,campaign_id,title,pillar,format,channel,status,scheduled_at,published_at,cta,script,public_url,
      idempotency_key,created_by,updated_by
    ) values(
      p_clinic_id,nullif(p_payload->>'campanha_id','')::uuid,pg_catalog.btrim(p_payload->>'titulo'),
      pg_catalog.btrim(p_payload->>'pilar'),pg_catalog.btrim(p_payload->>'formato'),pg_catalog.btrim(p_payload->>'canal'),
      v_status,nullif(p_payload->>'agendado_em','')::timestamptz,nullif(p_payload->>'publicado_em','')::timestamptz,
      nullif(pg_catalog.btrim(p_payload->>'cta'),''),nullif(pg_catalog.btrim(p_payload->>'roteiro'),''),
      nullif(pg_catalog.btrim(p_payload->>'url_publica'),''),p_idempotency_key,p_actor_id,p_actor_id
    ) returning * into v;
  else
    select * into v from public.marketing_content_items where clinic_id=p_clinic_id and id=p_id for update;
    if not found then raise exception 'marketing_content_not_found' using errcode='P0002'; end if;
    if v.version<>p_expected_version then raise exception 'marketing_version_conflict' using errcode='40001'; end if;
    if v.status='arquivado' then raise exception 'marketing_content_immutable' using errcode='55000'; end if;
    if not private.marketing_content_transition_allowed(v.status,v_status) then
      raise exception 'marketing_content_transition_invalid' using errcode='23514';
    end if;
    v_before:=v.version; v_from:=v.status;
    update public.marketing_content_items set campaign_id=nullif(p_payload->>'campanha_id','')::uuid,
      title=pg_catalog.btrim(p_payload->>'titulo'),pillar=pg_catalog.btrim(p_payload->>'pilar'),
      format=pg_catalog.btrim(p_payload->>'formato'),channel=pg_catalog.btrim(p_payload->>'canal'),status=v_status,
      scheduled_at=nullif(p_payload->>'agendado_em','')::timestamptz,published_at=nullif(p_payload->>'publicado_em','')::timestamptz,
      cta=nullif(pg_catalog.btrim(p_payload->>'cta'),''),script=nullif(pg_catalog.btrim(p_payload->>'roteiro'),''),
      public_url=nullif(pg_catalog.btrim(p_payload->>'url_publica'),''),version=version+1,updated_by=p_actor_id,updated_at=pg_catalog.now()
     where clinic_id=p_clinic_id and id=p_id returning * into v;
  end if;
  insert into public.marketing_content_workflow_events(
    clinic_id,content_id,from_status,to_status,resulting_version,request_id,idempotency_key,changed_by
  ) values(p_clinic_id,v.id,v_from,v.status,v.version,p_request_id,p_idempotency_key,p_actor_id);
  v_response:=pg_catalog.jsonb_build_object('id',v.id,'version',v.version,'status',v.status);
  perform private.marketing_audit(p_clinic_id,p_actor_id,'salvar_conteudo','content',v.id,v_before,v.version,case when p_id is null then 'cadastro' else 'edicao' end,p_request_id,p_idempotency_key);
  return private.marketing_complete(p_clinic_id,p_actor_id,'salvar_conteudo',p_idempotency_key,p_request_id,v_fp,v_response);
end $$;

create or replace function public.marketing_arquivar_conteudo(
  p_clinic_id uuid,p_actor_id uuid,p_id uuid,p_expected_version integer,
  p_idempotency_key uuid,p_request_id uuid,p_reason text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v public.marketing_content_items%rowtype; v_cached jsonb; v_response jsonb; v_from text;
 v_fp text:=pg_catalog.md5(pg_catalog.jsonb_build_array('arquivar_conteudo',p_id,p_expected_version,p_reason)::text);
begin
  v_cached:=private.marketing_replay(p_clinic_id,p_actor_id,'arquivar_conteudo',p_idempotency_key,p_request_id,v_fp);
  if v_cached is not null then return v_cached; end if;
  select * into v from public.marketing_content_items where clinic_id=p_clinic_id and id=p_id for update;
  if not found then raise exception 'marketing_content_not_found' using errcode='P0002'; end if;
  if v.version<>p_expected_version then raise exception 'marketing_version_conflict' using errcode='40001'; end if;
  if v.status='arquivado' then raise exception 'marketing_content_immutable' using errcode='55000'; end if;
  v_from:=v.status;
  update public.marketing_content_items set status='arquivado',version=version+1,updated_by=p_actor_id,updated_at=pg_catalog.now()
   where clinic_id=p_clinic_id and id=p_id returning * into v;
  insert into public.marketing_manual_reason_events(
    clinic_id,entity_type,entity_id,action,reason_text,request_id,idempotency_key,created_by
  ) values(p_clinic_id,'content',v.id,'arquivar_conteudo',pg_catalog.btrim(p_reason),p_request_id,p_idempotency_key,p_actor_id);
  insert into public.marketing_content_workflow_events(
    clinic_id,content_id,from_status,to_status,resulting_version,request_id,idempotency_key,changed_by
  ) values(p_clinic_id,v.id,v_from,v.status,v.version,p_request_id,p_idempotency_key,p_actor_id);
  v_response:=pg_catalog.jsonb_build_object('id',v.id,'version',v.version,'status',v.status);
  perform private.marketing_audit(p_clinic_id,p_actor_id,'arquivar_conteudo','content',v.id,p_expected_version,v.version,'arquivamento_manual',p_request_id,p_idempotency_key);
  return private.marketing_complete(p_clinic_id,p_actor_id,'arquivar_conteudo',p_idempotency_key,p_request_id,v_fp,v_response);
end $$;

create or replace function public.marketing_listar_lancamentos_disponiveis(
  p_clinic_id uuid,p_actor_id uuid,p_kind text,p_query text default '',p_limit integer default 50,p_offset integer default 0
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_items jsonb; v_leads jsonb:='[]'::jsonb; v_total integer; v_limit integer; v_offset integer; v_query text;
begin
  perform private.marketing_assert_owner(p_clinic_id,p_actor_id);
  if p_kind not in ('investimento','receita') then raise exception 'marketing_link_kind_invalid' using errcode='22023'; end if;
  v_limit:=least(greatest(coalesce(p_limit,50),1),100);
  v_offset:=least(greatest(coalesce(p_offset,0),0),100000);
  v_query:=pg_catalog.left(pg_catalog.btrim(coalesce(p_query,'')),120);
  with paid as (
    select p.entry_id,pg_catalog.sum(case when p.movement_type='pagamento' then p.amount else -p.amount end) as net
    from public.financeiro_pagamentos p where p.clinic_id=p_clinic_id group by p.entry_id
  ), eligible as (
    select e.id,e.description,e.entry_type,e.competence_date,e.total_amount,e.patient_id,coalesce(p.net,0) net
    from public.financeiro_lancamentos e left join paid p on p.entry_id=e.id
    where e.clinic_id=p_clinic_id and e.state='ativo'
      and e.entry_type=case when p_kind='investimento' then 'despesa' else 'receita' end
      and not exists(select 1 from public.marketing_campaign_financial_links x
                     where x.clinic_id=e.clinic_id and x.entry_id=e.id and x.state='ativo')
      and (v_query='' or e.description ilike '%'||v_query||'%')
  ), counted as (select count(*)::integer n from eligible), page as (
    select * from eligible order by competence_date desc,id desc limit v_limit offset v_offset
  )
  select coalesce((select n from counted),0),coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'id',id,'descricao',description,'tipo',entry_type,'data_competencia',competence_date,
    'valor_total',total_amount,'valor_comprometido',total_amount,'liquido_pago',net,'patient_id',patient_id,
    'paciente_rotulo',case when patient_id is null then null else 'Paciente '||pg_catalog.left(patient_id::text,8) end
  ) order by competence_date desc,id desc),'[]'::jsonb) into v_total,v_items from page;
  if p_kind='receita' then
    select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id',l.id,'lead_id',l.id,'campaign_id',l.campaign_id,'patient_id',l.patient_id,
      'rotulo_seguro',l.full_name||' · '||coalesce(c.name,'Campanha')
    ) order by l.full_name,l.id),'[]'::jsonb) into v_leads
    from public.crm_leads l join public.marketing_campaigns c
      on c.clinic_id=l.clinic_id and c.id=l.campaign_id and c.status='ativa'
    join lateral(select a.created_at attributed_at from public.marketing_lead_attribution_events a
      where a.clinic_id=l.clinic_id and a.lead_id=l.id and a.campaign_id=l.campaign_id
      order by a.created_at desc,a.id desc limit 1) attribution on true
    where l.clinic_id=p_clinic_id and l.record_status='converted' and l.patient_id is not null
      and l.converted_at>=attribution.attributed_at
      and l.converted_at<=attribution.attributed_at+pg_catalog.make_interval(days=>c.attribution_window_days);
  end if;
  return pg_catalog.jsonb_build_object(
    'itens',v_items,'lancamentos',v_items,'leads_elegiveis',v_leads,
    'paginacao',pg_catalog.jsonb_build_object('query',v_query,'limit',v_limit,'offset',v_offset,
      'total',v_total,'has_more',v_offset+v_limit<v_total)
  );
end $$;

create or replace function public.marketing_crm_campaign_options(
  p_clinic_id uuid,p_actor_id uuid,p_current_ids uuid[] default '{}'::uuid[]
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_items jsonb;
begin
  perform private.marketing_assert_owner(p_clinic_id,p_actor_id);
  if coalesce(pg_catalog.cardinality(p_current_ids),0)>200 then
    raise exception 'marketing_campaign_options_too_many' using errcode='22023';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',c.id,'nome',c.name,'codigo',c.code,'canal',c.channel,'status',c.status,
    'selecionavel',(c.status='ativa'),'historica',(c.status<>'ativa')
  ) order by (c.status='ativa') desc,c.name,c.id),'[]'::jsonb) into v_items
  from public.marketing_campaigns c
  where c.clinic_id=p_clinic_id and (c.status='ativa' or c.id=any(coalesce(p_current_ids,'{}'::uuid[])));
  return jsonb_build_object('campanhas_ativas',v_items);
end $$;

create or replace function public.marketing_listar(
  p_clinic_id uuid,p_actor_id uuid,p_kind text,p_limit integer default 100,p_offset integer default 0
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_items jsonb:='[]'::jsonb; v_patients jsonb:='[]'::jsonb; v_leads jsonb:='[]'::jsonb; v_total integer;
 v_limit integer:=least(greatest(coalesce(p_limit,100),1),200); v_offset integer:=least(greatest(coalesce(p_offset,0),0),100000);
begin
  perform private.marketing_assert_owner(p_clinic_id,p_actor_id);
  if p_kind='campanhas' then
    select coalesce(jsonb_agg(to_jsonb(x) order by x.inicio desc,x.id),'[]'::jsonb) into v_items from (
      select id,code codigo,name nome,channel canal,objective objetivo,starts_on inicio,ends_on fim,
       planned_budget orcamento_planejado,attribution_window_days janela_atribuicao_dias,status,version,created_at criado_em,updated_at atualizado_em,
       case when status='arquivada' then updated_at end arquivado_em,
       (select e.reason_text from public.marketing_manual_reason_events e where e.clinic_id=marketing_campaigns.clinic_id
         and e.entity_type='campaign' and e.entity_id=marketing_campaigns.id order by e.created_at desc,e.id desc limit 1) motivo_arquivamento
      from public.marketing_campaigns where clinic_id=p_clinic_id order by starts_on desc,id limit v_limit offset v_offset
    ) x;
    select count(*)::integer into v_total from public.marketing_campaigns where clinic_id=p_clinic_id;
    return jsonb_build_object('itens',v_items,'campanhas',v_items,'paginacao',jsonb_build_object('limit',v_limit,'offset',v_offset,'total',v_total,'has_more',v_offset+v_limit<v_total));
  elsif p_kind='vinculos' then
    select coalesce(jsonb_agg(to_jsonb(x) order by x.criado_em desc,x.id),'[]'::jsonb) into v_items from (
      select l.id,l.campaign_id,c.name campanha_nome,l.entry_id lancamento_id,e.description descricao,
       l.link_kind tipo,l.lead_id,l.patient_id,l.state status,l.version,l.created_at criado_em,
       (l.state='cancelado') cancelado,l.cancelled_at cancelado_em,l.cancellation_reason motivo_cancelamento,
       e.total_amount valor_comprometido,coalesce(pay.net,0) liquido_pago
      from public.marketing_campaign_financial_links l
      join public.marketing_campaigns c on c.clinic_id=l.clinic_id and c.id=l.campaign_id
      join public.financeiro_lancamentos e on e.clinic_id=l.clinic_id and e.id=l.entry_id
      left join lateral(select sum(case when p.movement_type='pagamento' then p.amount else -p.amount end) net
                        from public.financeiro_pagamentos p where p.clinic_id=l.clinic_id and p.entry_id=l.entry_id) pay on true
      where l.clinic_id=p_clinic_id order by l.created_at desc,l.id limit v_limit offset v_offset
    ) x;
    select count(*)::integer into v_total from public.marketing_campaign_financial_links where clinic_id=p_clinic_id;
    return jsonb_build_object('itens',v_items,'vinculos',v_items,'paginacao',jsonb_build_object('limit',v_limit,'offset',v_offset,'total',v_total,'has_more',v_offset+v_limit<v_total));
  elsif p_kind='indicacoes' then
    select coalesce(jsonb_agg(to_jsonb(x) order by x.criado_em desc,x.id),'[]'::jsonb) into v_items from (
      select r.id,r.referrer_patient_id indicadora_paciente_id,p.full_name indicadora_nome,
       r.referred_lead_id lead_indicado_id,l.full_name lead_indicado_nome,r.source origem,r.status,r.version,
       r.created_at criado_em,r.updated_at atualizado_em,(r.status='cancelada') cancelado,
       r.cancelled_at cancelado_em,r.cancellation_reason motivo_cancelamento
      from public.marketing_referrals r join public.patients p on p.clinic_id=r.clinic_id and p.id=r.referrer_patient_id
      join public.crm_leads l on l.clinic_id=r.clinic_id and l.id=r.referred_lead_id
      where r.clinic_id=p_clinic_id order by r.created_at desc,r.id limit v_limit offset v_offset
    ) x;
    select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'rotulo_seguro',p.full_name) order by p.full_name,p.id),'[]'::jsonb)
      into v_patients from public.patients p where p.clinic_id=p_clinic_id and p.archived_at is null;
    select coalesce(jsonb_agg(jsonb_build_object('id',l.id,'rotulo_seguro',l.full_name) order by l.full_name,l.id),'[]'::jsonb)
      into v_leads from public.crm_leads l where l.clinic_id=p_clinic_id and l.record_status not in ('cancelled','archived')
       and not exists(select 1 from public.marketing_referrals r where r.clinic_id=l.clinic_id and r.referred_lead_id=l.id);
    select count(*)::integer into v_total from public.marketing_referrals where clinic_id=p_clinic_id;
    return jsonb_build_object('itens',v_items,'indicacoes',v_items,'pacientes_elegiveis',v_patients,'leads_elegiveis',v_leads,
      'paginacao',jsonb_build_object('limit',v_limit,'offset',v_offset,'total',v_total,'has_more',v_offset+v_limit<v_total));
  elsif p_kind='conteudos' then
    select coalesce(jsonb_agg(to_jsonb(x) order by x.agendado_em nulls last,x.criado_em desc,x.id),'[]'::jsonb) into v_items from (
      select i.id,i.campaign_id campanha_id,c.name campanha_nome,i.title titulo,i.pillar pilar,i.format formato,
       i.channel canal,i.status,i.scheduled_at agendado_em,i.published_at publicado_em,i.cta,i.script roteiro,
       i.public_url url_publica,i.version,i.created_at criado_em,i.updated_at atualizado_em,
       case when i.status='arquivado' then i.updated_at end arquivado_em,
       (select e.reason_text from public.marketing_manual_reason_events e where e.clinic_id=i.clinic_id
         and e.entity_type='content' and e.entity_id=i.id order by e.created_at desc,e.id desc limit 1) motivo_arquivamento
      from public.marketing_content_items i left join public.marketing_campaigns c on c.clinic_id=i.clinic_id and c.id=i.campaign_id
      where i.clinic_id=p_clinic_id order by i.scheduled_at nulls last,i.created_at desc,i.id limit v_limit offset v_offset
    ) x;
    select count(*)::integer into v_total from public.marketing_content_items where clinic_id=p_clinic_id;
    return jsonb_build_object('itens',v_items,'conteudos',v_items,'paginacao',jsonb_build_object('limit',v_limit,'offset',v_offset,'total',v_total,'has_more',v_offset+v_limit<v_total));
  end if;
  raise exception 'marketing_list_kind_invalid' using errcode='22023';
end $$;

create or replace function public.marketing_painel(
  p_clinic_id uuid,p_actor_id uuid,p_start date,p_end date
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_result jsonb; v_from timestamptz; v_until timestamptz;
begin
  perform private.marketing_assert_owner(p_clinic_id,p_actor_id);
  if p_start is null or p_end is null or p_end<p_start or p_end-p_start>366
     or p_end>(pg_catalog.now() at time zone 'America/Sao_Paulo')::date then
    raise exception 'marketing_period_invalid' using errcode='22023';
  end if;
  v_from:=p_start::timestamp at time zone 'America/Sao_Paulo';
  v_until:=(p_end+1)::timestamp at time zone 'America/Sao_Paulo';
  with paid as (
    select p.entry_id,sum(case when p.movement_type='pagamento' then p.amount else -p.amount end)::numeric(14,2) net
    from public.financeiro_pagamentos p
    where p.clinic_id=p_clinic_id and p.paid_at>=v_from and p.paid_at<v_until group by p.entry_id
  ), active_entries as (
    select e.id,e.entry_type,e.patient_id,p.net
    from public.financeiro_lancamentos e join paid p on p.entry_id=e.id
    where e.clinic_id=p_clinic_id and e.state='ativo' and p.net<>0
  ), active_links as (
    select x.campaign_id,x.entry_id,x.link_kind,x.lead_id,x.patient_id
    from public.marketing_campaign_financial_links x
    join active_entries e on e.id=x.entry_id
    where x.clinic_id=p_clinic_id and x.state='ativo'
  ), money_by_campaign as (
    select x.campaign_id,
      sum(e.net) filter(where x.link_kind='investimento')::numeric(14,2) investment,
      sum(e.net) filter(where x.link_kind='receita')::numeric(14,2) revenue
    from active_links x join active_entries e on e.id=x.entry_id group by x.campaign_id
  ), current_attribution as (
    select distinct on (a.lead_id) a.lead_id,a.campaign_id,a.created_at attributed_at
    from public.marketing_lead_attribution_events a
    where a.clinic_id=p_clinic_id order by a.lead_id,a.created_at desc,a.id desc
  ), eligible_attribution as (
    select l.id,l.patient_id,l.converted_at,a.campaign_id,a.attributed_at,c.attribution_window_days
    from current_attribution a join public.crm_leads l on l.clinic_id=p_clinic_id and l.id=a.lead_id and l.campaign_id=a.campaign_id
    join public.marketing_campaigns c on c.clinic_id=p_clinic_id and c.id=a.campaign_id
    where a.campaign_id is not null
  ), leads_by_campaign as (
    select campaign_id,count(*)::integer leads from eligible_attribution
    where attributed_at>=v_from and attributed_at<v_until group by campaign_id
  ), conversions_by_campaign as (
    select campaign_id,count(distinct patient_id)::integer conversions from eligible_attribution
    where patient_id is not null and converted_at>=v_from and converted_at<v_until
      and converted_at>=attributed_at
      and converted_at<=attributed_at+pg_catalog.make_interval(days=>attribution_window_days)
    group by campaign_id
  ), campaign_rows as (
    select c.id,c.code codigo,c.name nome,c.channel canal,c.objective objetivo,c.planned_budget orcamento_planejado,c.status,c.starts_on inicio,c.ends_on fim,
      c.attribution_window_days janela_atribuicao_dias,c.version,
      coalesce(lb.leads,0) leads,coalesce(cb.conversions,0) conversoes_pacientes,
      coalesce(m.investment,0)::numeric(14,2) investimento_pago,coalesce(m.revenue,0)::numeric(14,2) receita_recebida,
      case when coalesce(cb.conversions,0)=0 then null else round(coalesce(m.investment,0)/cb.conversions,2) end cac,
      case when coalesce(m.investment,0)=0 then null
           else round(((coalesce(m.revenue,0)-m.investment)/m.investment)*100,1) end roi
    from public.marketing_campaigns c
    left join money_by_campaign m on m.campaign_id=c.id
    left join leads_by_campaign lb on lb.campaign_id=c.id
    left join conversions_by_campaign cb on cb.campaign_id=c.id
    where c.clinic_id=p_clinic_id
  ), global_values as (
    select
      coalesce((select sum(investimento_pago) from campaign_rows),0)::numeric(14,2) investment,
      coalesce((select sum(receita_recebida) from campaign_rows),0)::numeric(14,2) revenue,
      coalesce((select count(*) from eligible_attribution where attributed_at>=v_from and attributed_at<v_until),0)::integer leads,
      coalesce((select count(distinct patient_id) from eligible_attribution where patient_id is not null
                and converted_at>=v_from and converted_at<v_until and converted_at>=attributed_at
                and converted_at<=attributed_at+pg_catalog.make_interval(days=>attribution_window_days)),0)::integer conversions
  ), unassigned as (
    select
      count(*) filter(where e.entry_type='receita')::integer revenue_count,
      coalesce(sum(e.net) filter(where e.entry_type='receita'),0)::numeric(14,2) revenue,
      count(*) filter(where e.entry_type='despesa')::integer expense_count,
      coalesce(sum(e.net) filter(where e.entry_type='despesa'),0)::numeric(14,2) expense
    from active_entries e where not exists(select 1 from active_links x where x.entry_id=e.id)
  )
  select jsonb_build_object(
    'periodo',jsonb_build_object('inicio',p_start,'fim',p_end,'fuso','America/Sao_Paulo'),
    'totais',jsonb_build_object(
      'investimento_pago',g.investment,'receita_recebida',g.revenue,'leads',g.leads,
      'conversoes_pacientes',g.conversions,
      'cac',case when g.conversions=0 then null else round(g.investment/g.conversions,2) end,
      'roi',case when g.investment=0 then null else round(((g.revenue-g.investment)/g.investment)*100,1) end
    ),
    'campanhas',coalesce((select jsonb_agg(to_jsonb(c) order by c.nome,c.id) from campaign_rows c),'[]'::jsonb),
    'nao_atribuido',jsonb_build_object('receitas_quantidade',u.revenue_count,'receita_recebida',u.revenue,
      'despesas_quantidade',u.expense_count,'despesa_paga',u.expense),
    'limitacoes',jsonb_build_array(
      'Somente pagamentos e estornos efetivos dentro da janela.',
      'Parcelas não pagas não entram.',
      'Atribuição financeira manual; cada lançamento possui no máximo uma campanha ativa.'
    )
  ) into v_result from global_values g cross join unassigned u;
  return v_result;
end $$;

create or replace function public.marketing_crm_salvar_lead(
  p_action text,p_clinic_id uuid,p_actor_id uuid,p_lead_id uuid,p_expected_version integer,
  p_idempotency_key uuid,p_request_id uuid,p_payload jsonb
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_action text:=pg_catalog.lower(pg_catalog.btrim(coalesce(p_action,'')));
  v_payload jsonb:=coalesce(p_payload,'{}'::jsonb); v_sanitized jsonb;
  v_campaign_id uuid; v_previous_campaign_id uuid; v_campaign_name text; v_campaign_status text; v_previous_source text;
  v_result jsonb; v_cached jsonb; v_response jsonb; v_result_lead_id uuid;
  v_fp text:=pg_catalog.md5(pg_catalog.jsonb_build_array('marketing_crm_salvar_lead',p_action,p_lead_id,p_expected_version,p_payload)::text);
begin
  v_cached:=private.marketing_replay(p_clinic_id,p_actor_id,'marketing_crm_salvar_lead',p_idempotency_key,p_request_id,v_fp);
  if v_cached is not null then return v_cached; end if;
  if v_action not in ('create','update','change_stage','add_interaction','archive','cancel')
     or pg_catalog.jsonb_typeof(v_payload)<>'object' or pg_catalog.pg_column_size(v_payload)>16384 then
    raise exception 'marketing_crm_invalid_parameters' using errcode='22023';
  end if;
  if v_action in ('create','update') then
    if not (v_payload ? 'campaign_id') then raise exception 'marketing_campaign_id_required' using errcode='22023'; end if;
    v_campaign_id:=nullif(v_payload->>'campaign_id','')::uuid;
    if p_lead_id is not null then
      select campaign_id,source into v_previous_campaign_id,v_previous_source from public.crm_leads
       where clinic_id=p_clinic_id and id=p_lead_id for update;
      if not found then raise exception 'crm_lead_not_found' using errcode='P0002'; end if;
    end if;
    if v_action='create' and (v_payload->>'source') not in (
      'instagram_organico','instagram_ads','facebook','google','google_maps','indicacao','paciente_atual',
      'influenciadora','site','whatsapp','evento','parceria','outro'
    ) then raise exception 'marketing_crm_source_invalid' using errcode='22023'; end if;
    if v_action='update' and (v_payload->>'source') not in (
      'instagram_organico','instagram_ads','facebook','google','google_maps','indicacao','paciente_atual',
      'influenciadora','site','whatsapp','evento','parceria','outro'
    ) and (v_payload->>'source') is distinct from v_previous_source then
      raise exception 'marketing_crm_legacy_source_immutable' using errcode='23514';
    end if;
    if v_campaign_id is not null then
      select name,status into v_campaign_name,v_campaign_status from public.marketing_campaigns
       where clinic_id=p_clinic_id and id=v_campaign_id for share;
      if not found or (v_campaign_status<>'ativa' and (v_action='create' or v_campaign_id is distinct from v_previous_campaign_id)) then
        raise exception 'marketing_active_campaign_required' using errcode='55000';
      end if;
    end if;
    v_sanitized:=(v_payload-'campaign_id'-'campaign')||jsonb_build_object('campaign',v_campaign_name);
  else
    v_sanitized:=v_payload-'campaign_id'-'campaign';
  end if;
  v_result:=public.crm_salvar_lead(v_action,p_clinic_id,p_actor_id,p_lead_id,p_expected_version,
                                  p_idempotency_key,p_request_id,v_sanitized);
  v_result_lead_id:=(v_result->>'lead_id')::uuid;
  if v_action in ('create','update') then
    update public.crm_leads set campaign_id=v_campaign_id
     where clinic_id=p_clinic_id and id=v_result_lead_id;
    if v_previous_campaign_id is distinct from v_campaign_id then
      insert into public.marketing_lead_attribution_events(
        clinic_id,lead_id,previous_campaign_id,campaign_id,reason,idempotency_key,created_by
      ) values(
        p_clinic_id,v_result_lead_id,v_previous_campaign_id,v_campaign_id,
        case when v_campaign_id is null then 'Atribuição removida no CRM.' else 'Campanha selecionada no CRM.' end,
        p_idempotency_key,p_actor_id
      );
    end if;
  end if;
  select campaign_id,campaign into v_campaign_id,v_campaign_name from public.crm_leads
   where clinic_id=p_clinic_id and id=v_result_lead_id;
  v_response:=v_result||jsonb_build_object('campaign_id',v_campaign_id,'campanha',v_campaign_name);
  perform private.marketing_audit(p_clinic_id,p_actor_id,'marketing_crm_salvar_lead','lead',v_result_lead_id,
    p_expected_version,(v_result->>'version')::integer,case when v_action='create' then 'cadastro' else 'edicao' end,p_request_id,p_idempotency_key);
  return private.marketing_complete(p_clinic_id,p_actor_id,'marketing_crm_salvar_lead',p_idempotency_key,p_request_id,v_fp,v_response);
end $$;

do $$ declare t text; s text; begin
 foreach t in array array['marketing_campaigns','marketing_lead_attribution_events','marketing_campaign_financial_links','marketing_referrals','marketing_content_items','marketing_operations','marketing_audit_log','marketing_financial_link_cancellation_events','marketing_content_workflow_events','marketing_manual_reason_events'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from public,anon,authenticated,service_role',t);
  if exists(select 1 from information_schema.columns c where c.table_schema='public' and c.table_name=t and c.column_name='id') then
    s:=pg_catalog.pg_get_serial_sequence('public.'||t,'id');
    if s is not null then execute format('revoke all on sequence %s from public,anon,authenticated,service_role',s); end if;
  end if;
 end loop;
end $$;
revoke all on function private.marketing_assert_owner(uuid,uuid),private.marketing_replay(uuid,uuid,text,uuid,uuid,text),private.marketing_complete(uuid,uuid,text,uuid,uuid,text,jsonb),private.marketing_audit(uuid,uuid,text,text,uuid,integer,integer,text,uuid,uuid),private.marketing_append_only(),private.marketing_fin_link_guard(),private.marketing_lead_campaign_guard(),private.marketing_content_transition_allowed(text,text) from public,anon,authenticated,service_role;
revoke all on function public.marketing_salvar_campanha(uuid,uuid,uuid,integer,uuid,uuid,jsonb),public.marketing_arquivar_campanha(uuid,uuid,uuid,integer,uuid,uuid,text),public.marketing_vincular_lancamento(uuid,uuid,uuid,uuid,text,uuid,uuid,uuid,text),public.marketing_cancelar_vinculo(uuid,uuid,uuid,integer,uuid,uuid,text),public.marketing_salvar_indicacao(uuid,uuid,uuid,integer,uuid,uuid,jsonb),public.marketing_cancelar_indicacao(uuid,uuid,uuid,integer,uuid,uuid,text),public.marketing_salvar_conteudo(uuid,uuid,uuid,integer,uuid,uuid,jsonb),public.marketing_arquivar_conteudo(uuid,uuid,uuid,integer,uuid,uuid,text),public.marketing_painel(uuid,uuid,date,date),public.marketing_listar(uuid,uuid,text,integer,integer) from public,anon,authenticated;
grant execute on function public.marketing_salvar_campanha(uuid,uuid,uuid,integer,uuid,uuid,jsonb),public.marketing_arquivar_campanha(uuid,uuid,uuid,integer,uuid,uuid,text),public.marketing_vincular_lancamento(uuid,uuid,uuid,uuid,text,uuid,uuid,uuid,text),public.marketing_cancelar_vinculo(uuid,uuid,uuid,integer,uuid,uuid,text),public.marketing_salvar_indicacao(uuid,uuid,uuid,integer,uuid,uuid,jsonb),public.marketing_cancelar_indicacao(uuid,uuid,uuid,integer,uuid,uuid,text),public.marketing_salvar_conteudo(uuid,uuid,uuid,integer,uuid,uuid,jsonb),public.marketing_arquivar_conteudo(uuid,uuid,uuid,integer,uuid,uuid,text),public.marketing_painel(uuid,uuid,date,date),public.marketing_listar(uuid,uuid,text,integer,integer) to service_role;
revoke all on function public.marketing_listar_lancamentos_disponiveis(uuid,uuid,text,text,integer,integer),public.marketing_crm_campaign_options(uuid,uuid,uuid[]),public.marketing_crm_salvar_lead(text,uuid,uuid,uuid,integer,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.marketing_listar_lancamentos_disponiveis(uuid,uuid,text,text,integer,integer),public.marketing_crm_campaign_options(uuid,uuid,uuid[]),public.marketing_crm_salvar_lead(text,uuid,uuid,uuid,integer,uuid,uuid,jsonb) to service_role;
comment on table public.marketing_campaign_financial_links is 'Atribuicao manual; dinheiro permanece exclusivamente no financeiro canonico.';
commit;

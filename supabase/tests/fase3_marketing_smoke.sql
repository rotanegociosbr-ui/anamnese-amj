-- Auditoria funcional F3: executar apos a migration e sempre descartar.
begin;

create temporary table audit_f3_ctx (
 clinic_id uuid not null, actor_id uuid not null, campaign_id uuid,
 campaign_version integer, window_campaign_id uuid, lead_id uuid,
 patient_id uuid, attributed_at timestamptz
) on commit drop;

insert into audit_f3_ctx(clinic_id,actor_id,patient_id)
select m.clinic_id,m.user_id,
 (select p.id from public.patients p where p.clinic_id=m.clinic_id and p.archived_at is null order by p.created_at,p.id limit 1)
from public.clinic_members m where m.role='owner' and m.status='active'
order by m.clinic_id,m.user_id limit 1;

do $$ begin
 if not exists(select 1 from audit_f3_ctx) then raise exception 'AUDIT_F3: owner ativo ausente'; end if;
end $$;

do $$ declare idx text; begin
 foreach idx in array array[
  'marketing_campaigns_created_by_idx','marketing_campaigns_updated_by_idx',
  'marketing_operations_actor_idx','marketing_audit_actor_idx',
  'marketing_fin_cancel_actor_idx','marketing_content_workflow_actor_idx'
 ] loop
  if pg_catalog.to_regclass('public.'||idx) is null then
   raise exception 'AUDIT_F3: indice FK ausente %',idx;
  end if;
 end loop;
end $$;

-- RLS, grants e superficie RPC-only.
do $$ declare t text; begin
 foreach t in array array[
  'marketing_campaigns','marketing_lead_attribution_events','marketing_campaign_financial_links',
  'marketing_referrals','marketing_content_items','marketing_operations','marketing_audit_log',
  'marketing_financial_link_cancellation_events','marketing_content_workflow_events','marketing_manual_reason_events'
 ] loop
  if pg_catalog.to_regclass('public.'||t) is null then raise exception 'AUDIT_F3: tabela ausente %',t; end if;
  if not (select c.relrowsecurity from pg_catalog.pg_class c where c.oid=pg_catalog.to_regclass('public.'||t)) then
   raise exception 'AUDIT_F3: RLS ausente %',t;
  end if;
  if pg_catalog.has_table_privilege('anon','public.'||t,'SELECT')
   or pg_catalog.has_table_privilege('authenticated','public.'||t,'SELECT')
   or pg_catalog.has_table_privilege('service_role','public.'||t,'SELECT') then
   raise exception 'AUDIT_F3: SELECT direto indevido %',t;
  end if;
 end loop;
 if pg_catalog.has_function_privilege('authenticated',
  'public.marketing_salvar_campanha(uuid,uuid,uuid,integer,uuid,uuid,jsonb)','EXECUTE') then
  raise exception 'AUDIT_F3: authenticated executa RPC privilegiado';
 end if;
 if not pg_catalog.has_function_privilege('service_role',
  'public.marketing_salvar_campanha(uuid,uuid,uuid,integer,uuid,uuid,jsonb)','EXECUTE') then
  raise exception 'AUDIT_F3: service_role sem RPC esperado';
 end if;
end $$;

-- Salvar, replay, conflito de fingerprint/versao e arquivamento dedicado.
do $$
declare c audit_f3_ctx%rowtype; k uuid:=pg_catalog.gen_random_uuid(); r1 jsonb; r2 jsonb; payload jsonb;
begin
 select * into c from audit_f3_ctx;
 payload:=pg_catalog.jsonb_build_object(
  'codigo','audit_'||pg_catalog.substr(pg_catalog.replace(k::text,'-',''),1,12),
  'nome','Campanha Auditoria Funcional','canal','site','objetivo','Validar Fase 3',
  'orcamento_planejado',100,'inicio',current_date,'fim',null,
  'janela_atribuicao_dias',30,'status','ativa');
 r1:=public.marketing_salvar_campanha(c.clinic_id,c.actor_id,null,0,k,pg_catalog.gen_random_uuid(),payload);
 r2:=public.marketing_salvar_campanha(c.clinic_id,c.actor_id,null,0,k,pg_catalog.gen_random_uuid(),payload);
 if (r1->>'id') is distinct from (r2->>'id') or coalesce((r2->>'idempotent')::boolean,false) is not true then
  raise exception 'AUDIT_F3: replay divergente';
 end if;
 update audit_f3_ctx set campaign_id=(r1->>'id')::uuid,campaign_version=(r1->>'version')::integer;
 begin
  perform public.marketing_salvar_campanha(c.clinic_id,c.actor_id,null,0,k,pg_catalog.gen_random_uuid(),
   payload||'{"objetivo":"Payload alterado"}'::jsonb);
  raise exception 'AUDIT_F3: chave reutilizada aceita';
 exception when unique_violation then null; end;
 begin
  perform public.marketing_salvar_campanha(c.clinic_id,c.actor_id,(r1->>'id')::uuid,999999,
   pg_catalog.gen_random_uuid(),pg_catalog.gen_random_uuid(),payload);
  raise exception 'AUDIT_F3: version conflict ausente';
 exception when serialization_failure then null; end;
 begin
  perform public.marketing_salvar_campanha(c.clinic_id,c.actor_id,(r1->>'id')::uuid,(r1->>'version')::integer,
   pg_catalog.gen_random_uuid(),pg_catalog.gen_random_uuid(),payload||'{"status":"arquivada"}'::jsonb);
  raise exception 'AUDIT_F3: archive via salvar aceito';
 exception when insufficient_privilege then null; end;
 r2:=public.marketing_arquivar_campanha(c.clinic_id,c.actor_id,(r1->>'id')::uuid,(r1->>'version')::integer,
  pg_catalog.gen_random_uuid(),pg_catalog.gen_random_uuid(),'Auditoria funcional sem dados pessoais');
 if r2->>'status'<>'arquivada' then raise exception 'AUDIT_F3: archive dedicado falhou'; end if;
 if not exists(select 1 from public.marketing_manual_reason_events e
  where e.clinic_id=c.clinic_id and e.entity_id=(r1->>'id')::uuid and e.action='arquivar_campanha') then
  raise exception 'AUDIT_F3: motivo manual ausente';
 end if;
end $$;

-- Paginacao/has_more e opcoes CRM via RPC, inclusive atual inativa.
do $$
declare c audit_f3_ctx%rowtype; i integer; k uuid; r jsonb;
begin
 select * into c from audit_f3_ctx;
 for i in 1..3 loop
  k:=pg_catalog.gen_random_uuid();
  r:=public.marketing_salvar_campanha(c.clinic_id,c.actor_id,null,0,k,pg_catalog.gen_random_uuid(),
   pg_catalog.jsonb_build_object('codigo','pg_'||i||'_'||pg_catalog.substr(pg_catalog.replace(k::text,'-',''),1,8),
    'nome','Pagina Auditoria '||i,'canal','site','objetivo','Validar paginacao',
    'inicio',current_date,'janela_atribuicao_dias',1,'status','ativa'));
  if i=1 then update audit_f3_ctx set window_campaign_id=(r->>'id')::uuid; end if;
 end loop;
 select * into c from audit_f3_ctx;
 r:=public.marketing_listar(c.clinic_id,c.actor_id,'campanhas',2,0);
 if pg_catalog.jsonb_array_length(r->'itens')<>2
  or coalesce((r#>>'{paginacao,has_more}')::boolean,false) is not true then
  raise exception 'AUDIT_F3: paginacao incorreta %',r;
 end if;
 r:=public.marketing_crm_campaign_options(c.clinic_id,c.actor_id,array[c.window_campaign_id,c.campaign_id]);
 if not exists(select 1 from pg_catalog.jsonb_array_elements(r->'campanhas_ativas') x
  where (x->>'id')::uuid=c.window_campaign_id and (x->>'selecionavel')::boolean) then
  raise exception 'AUDIT_F3: ativa ausente das opcoes';
 end if;
 if not exists(select 1 from pg_catalog.jsonb_array_elements(r->'campanhas_ativas') x
  where (x->>'id')::uuid=c.campaign_id and not (x->>'selecionavel')::boolean) then
  raise exception 'AUDIT_F3: atual arquivada nao preservada';
 end if;
end $$;

-- Janela: limite incluso e +1 segundo excluido. Fixture sempre volta no rollback.
do $$
declare c audit_f3_ctx%rowtype; k uuid:=pg_catalog.gen_random_uuid(); r jsonb; panel jsonb;
 attr timestamptz:=pg_catalog.clock_timestamp()-interval '1 day'; conversions integer;
begin
 select * into c from audit_f3_ctx;
 if c.patient_id is null then raise notice 'AUDIT_F3: janela pulada, sem paciente ativo'; return; end if;
 r:=public.marketing_crm_salvar_lead('create',c.clinic_id,c.actor_id,null,0,k,pg_catalog.gen_random_uuid(),
  pg_catalog.jsonb_build_object('full_name','Lead Auditoria Funcional','birth_date',null,'cpf',null,'phone',null,
   'email','audit-'||pg_catalog.replace(k::text,'-','')||'@invalid.example','source','site',
   'subsource','auditoria','campaign_id',null,'interest','Teste Fase 3','responsible_user_id',c.actor_id,
   'stage_code','novo','first_response_at',null,'next_action_type','contato',
   'next_action_at',pg_catalog.clock_timestamp()+interval '2 days','loss_reason',null,
   'commercial_notes','Fixture transacional'));
 update audit_f3_ctx set lead_id=(r->>'lead_id')::uuid,attributed_at=attr;
 update public.crm_leads set campaign_id=c.window_campaign_id where clinic_id=c.clinic_id and id=(r->>'lead_id')::uuid;
 insert into public.marketing_lead_attribution_events(
  clinic_id,lead_id,previous_campaign_id,campaign_id,reason,idempotency_key,created_by,created_at)
 values(c.clinic_id,(r->>'lead_id')::uuid,null,c.window_campaign_id,'Atribuicao fixture auditoria',
  pg_catalog.gen_random_uuid(),c.actor_id,attr);
 update public.crm_leads set stage_code='convertida',record_status='converted',patient_id=c.patient_id,
  converted_at=attr+interval '1 day',converted_by=c.actor_id,next_action_type=null,next_action_at=null,version=version+1
 where clinic_id=c.clinic_id and id=(r->>'lead_id')::uuid;
 panel:=public.marketing_painel(c.clinic_id,c.actor_id,current_date,current_date);
 select coalesce((x->>'conversoes_pacientes')::integer,0) into conversions
 from pg_catalog.jsonb_array_elements(panel->'campanhas') x where (x->>'id')::uuid=c.window_campaign_id;
 if conversions<>1 then raise exception 'AUDIT_F3: limite deveria contar %',panel; end if;
 update public.crm_leads set converted_at=attr+interval '1 day 1 second'
 where clinic_id=c.clinic_id and id=(r->>'lead_id')::uuid;
 panel:=public.marketing_painel(c.clinic_id,c.actor_id,current_date,current_date);
 select coalesce((x->>'conversoes_pacientes')::integer,0) into conversions
 from pg_catalog.jsonb_array_elements(panel->'campanhas') x where (x->>'id')::uuid=c.window_campaign_id;
 if conversions<>0 then raise exception 'AUDIT_F3: +1 segundo foi contado %',panel; end if;
end $$;

select 'AUDIT_F3_OK' as resultado;
rollback;

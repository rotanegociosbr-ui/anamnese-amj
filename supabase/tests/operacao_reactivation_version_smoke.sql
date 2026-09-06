-- Synthetic RPC smoke, intended only for an explicitly authorized transaction.
-- Never remove ROLLBACK. No photos, consent, payments, messages or real patient writes.
begin;
create temporary table attendance_version_context(clinic_id uuid,actor_id uuid,patient_id uuid)
on commit drop;
grant select on attendance_version_context to service_role;
do $fixture$
declare c uuid; u uuid; p uuid := gen_random_uuid();
begin
  select clinic_id,user_id into c,u from public.clinic_members
  where role='owner' and status='active' order by clinic_id,user_id limit 1;
  if c is null then raise exception 'no_owner_fixture_context'; end if;
  insert into public.patients(id,clinic_id,full_name,created_by,dedup_exact_key)
  values(p,c,'TESTE TRANSACIONAL 42702 '||p::text,u,p::text);
  insert into attendance_version_context values(c,u,p);
end;$fixture$;
set local role service_role;
do $test$
declare f record; a jsonb; b jsonb; k uuid:=gen_random_uuid(); r uuid:=gen_random_uuid();
  at_time timestamptz:=now()-interval '1 hour'; update_request uuid:=gen_random_uuid();
begin
  select * into f from attendance_version_context;
  if has_function_privilege('authenticated',
    'public.operacao_salvar_atendimento(uuid,uuid,text,text,text,uuid,integer,uuid,uuid,uuid,uuid,text,timestamptz,smallint,text,uuid,uuid,uuid)', 'EXECUTE') then
    raise exception 'browser_rpc_privilege_expanded';
  end if;
  if exists(select 1 from pg_proc where oid='private.fase2_invalidate_reactivation()'::regprocedure and prosecdef) then
    raise exception 'trigger_invoker_policy_changed';
  end if;
  a:=public.operacao_salvar_atendimento(f.clinic_id,f.actor_id,'owner','supabase_auth','aal2',
    null,null,f.patient_id,null,null,null,'Teste transacional',at_time,30::smallint,'realizado',f.actor_id,k,r);
  b:=public.operacao_salvar_atendimento(f.clinic_id,f.actor_id,'owner','supabase_auth','aal2',
    null,null,f.patient_id,null,null,null,'Teste transacional',at_time,30::smallint,'realizado',f.actor_id,k,r);
  if a->>'id'<>b->>'id' or (b->>'idempotent')::boolean is not true then raise exception 'create_retry_not_idempotent';end if;
  b:=public.operacao_salvar_atendimento(f.clinic_id,f.actor_id,'owner','supabase_auth','aal2',
    (a->>'id')::uuid,1,f.patient_id,null,null,null,'Teste transacional',at_time,45::smallint,'concluido',f.actor_id,k,update_request);
  if b->>'id'<>a->>'id' or (b->>'version')::integer<>2 then raise exception 'update_did_not_preserve_identity';end if;
  b:=public.operacao_salvar_atendimento(f.clinic_id,f.actor_id,'owner','supabase_auth','aal2',
    (a->>'id')::uuid,1,f.patient_id,null,null,null,'Teste transacional',at_time,45::smallint,'concluido',f.actor_id,k,update_request);
  if (b->>'version')::integer<>2 or (b->>'idempotent')::boolean is not true then raise exception 'update_retry_not_idempotent';end if;
  begin
    perform public.operacao_salvar_atendimento(f.clinic_id,f.actor_id,'owner','supabase_auth','aal2',
      (a->>'id')::uuid,1,f.patient_id,null,null,null,'Teste transacional',at_time,45::smallint,'concluido',f.actor_id,k,gen_random_uuid());
    raise exception 'stale_version_accepted';
  exception when serialization_failure then if sqlerrm<>'version_conflict' then raise;end if;end;
  begin
    perform public.operacao_salvar_atendimento(f.clinic_id,f.actor_id,'owner','supabase_auth','aal1',
      (a->>'id')::uuid,2,f.patient_id,null,null,null,'Teste transacional',at_time,45::smallint,'concluido',f.actor_id,k,gen_random_uuid());
    raise exception 'aal1_accepted';
  exception when insufficient_privilege then if sqlerrm<>'aal2_required' then raise;end if;end;
  if (select count(*) from public.atendimentos_realizados where patient_id=f.patient_id)<>1
    or (select count(*) from public.atendimento_procedimentos where attendance_id=(a->>'id')::uuid)<>1
    or exists(select 1 from public.atendimentos_realizados where patient_id=f.patient_id
      and (patient_id<>f.patient_id or protocol_id is not null or appointment_id is not null or financial_entry_id is not null)) then
    raise exception 'unexpected_operational_records_or_links';
  end if;
end;$test$;
reset role;
rollback;
select jsonb_build_object('result','PASS','synthetic_patients_remaining',count(*)) as smoke_result
from public.patients where full_name like 'TESTE TRANSACIONAL 42702 %';

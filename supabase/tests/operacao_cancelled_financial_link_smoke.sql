-- Synthetic only. Execute only with explicit authorization. Always ROLLBACK.
begin;
create temporary table cancelled_link_context(clinic_id uuid,actor_id uuid,patient_id uuid,other_patient_id uuid,entry_id uuid,other_entry_id uuid,expense_id uuid,attendance_id uuid,request_id uuid,key uuid)
on commit drop;
grant select,update on cancelled_link_context to service_role;
do $fixture$
declare c uuid;u uuid;p uuid:=gen_random_uuid();p2 uuid:=gen_random_uuid();e uuid:=gen_random_uuid();e2 uuid:=gen_random_uuid();e3 uuid:=gen_random_uuid();
begin
  select clinic_id,user_id into c,u from public.clinic_members where role='owner' and status='active' order by clinic_id,user_id limit 1;
  if c is null then raise exception 'no_owner_fixture_context';end if;
  insert into public.patients(id,clinic_id,full_name,created_by,dedup_exact_key)
  values(p,c,'TESTE TRANSACIONAL COBRANCA HISTORICA '||p::text,u,p::text),
        (p2,c,'TESTE TRANSACIONAL COBRANCA HISTORICA '||p2::text,u,p2::text);
  insert into public.financeiro_lancamentos(id,clinic_id,patient_id,entry_type,origin,description,category,competence_date,due_date,total_amount,payment_condition,state,idempotency_key,created_by)
  values(e,c,p,'receita','atendimento','TESTE TRANSACIONAL COBRANCA HISTORICA '||e::text,'Teste',current_date,current_date,1,'avista','ativo',gen_random_uuid(),u);
  insert into public.financeiro_lancamentos(id,clinic_id,patient_id,entry_type,origin,description,category,competence_date,due_date,total_amount,payment_condition,state,idempotency_key,created_by,cancelled_by,cancelled_at,cancellation_reason)
  values(e2,c,p,'receita','atendimento','TESTE TRANSACIONAL COBRANCA HISTORICA '||e2::text,'Teste',current_date,current_date,1,'avista','cancelado',gen_random_uuid(),u,u,now(),'Teste transacional'),
        (e3,c,p,'despesa','operacional','TESTE TRANSACIONAL COBRANCA HISTORICA '||e3::text,'Teste',current_date,current_date,1,'avista','cancelado',gen_random_uuid(),u,u,now(),'Teste transacional');
  insert into cancelled_link_context values(c,u,p,p2,e,e2,e3,null,gen_random_uuid(),gen_random_uuid());
end;$fixture$;
set local role service_role;
do $create$
declare f record;r jsonb;
begin
  select * into f from cancelled_link_context;
  r:=public.operacao_salvar_atendimento(f.clinic_id,f.actor_id,'owner','supabase_auth','aal2',
    null,null,f.patient_id,null,null,f.entry_id,'Teste transacional',now()-interval '1 hour',30::smallint,'realizado',f.actor_id,f.key,gen_random_uuid());
  update cancelled_link_context set attendance_id=(r->>'id')::uuid;
end;$create$;
reset role;
-- Only the fixture revenue is cancelled; no payment is created or cancelled.
update public.financeiro_lancamentos e set state='cancelado',cancelled_at=now(),cancelled_by=f.actor_id,
  cancellation_reason='Teste transacional de vínculo histórico',updated_by=f.actor_id,version=e.version+1
from cancelled_link_context f where e.id=f.entry_id;
set local role service_role;
do $test$
declare f record;a jsonb;b jsonb;t timestamptz;before_entry jsonb;after_entry jsonb;candidate uuid;oid regprocedure;
begin
  select * into f from cancelled_link_context;
  select attended_at into t from public.atendimentos_realizados where id=f.attendance_id;
  select to_jsonb(e) into before_entry from public.financeiro_lancamentos e where id=f.entry_id;
  a:=public.operacao_salvar_atendimento(f.clinic_id,f.actor_id,'owner','supabase_auth','aal2',
    f.attendance_id,1,f.patient_id,null,null,f.entry_id,'Teste transacional',t,45::smallint,'realizado',f.actor_id,f.key,f.request_id);
  b:=public.operacao_salvar_atendimento(f.clinic_id,f.actor_id,'owner','supabase_auth','aal2',
    f.attendance_id,1,f.patient_id,null,null,f.entry_id,'Teste transacional',t,45::smallint,'realizado',f.actor_id,f.key,f.request_id);
  if a->>'id'<>f.attendance_id::text or (a->>'version')::integer<>2 or (b->>'idempotent')::boolean is not true then raise exception 'historical_financial_update_or_retry_failed';end if;
  begin
    perform public.operacao_salvar_atendimento(f.clinic_id,f.actor_id,'owner','supabase_auth','aal2',
      null,null,f.patient_id,null,null,f.entry_id,'Teste transacional',t-interval '1 day',30::smallint,'realizado',f.actor_id,gen_random_uuid(),gen_random_uuid());
    raise exception 'new_cancelled_link_accepted';
  exception when check_violation then if sqlerrm<>'financial_entry_patient_mismatch' then raise;end if;end;
  foreach candidate in array array[f.other_entry_id,f.expense_id] loop
    begin
      perform public.operacao_salvar_atendimento(f.clinic_id,f.actor_id,'owner','supabase_auth','aal2',
        f.attendance_id,2,f.patient_id,null,null,candidate,'Teste transacional',t,30::smallint,'realizado',f.actor_id,f.key,gen_random_uuid());
      raise exception 'changed_cancelled_or_expense_link_accepted';
    exception when check_violation then if sqlerrm<>'financial_entry_patient_mismatch' then raise;end if;end;
  end loop;
  begin
    perform public.operacao_salvar_atendimento(f.clinic_id,f.actor_id,'owner','supabase_auth','aal2',
      f.attendance_id,2,f.other_patient_id,null,null,f.entry_id,'Teste transacional',t,30::smallint,'realizado',f.actor_id,f.key,gen_random_uuid());
    raise exception 'cross_patient_link_accepted';
  exception when check_violation then if sqlerrm<>'financial_entry_patient_mismatch' then raise;end if;end;
  begin
    perform public.operacao_salvar_atendimento(f.clinic_id,f.actor_id,'owner','supabase_auth','aal2',
      f.attendance_id,1,f.patient_id,null,null,f.entry_id,'Teste transacional',t,30::smallint,'realizado',f.actor_id,f.key,gen_random_uuid());
    raise exception 'stale_version_accepted';
  exception when serialization_failure then if sqlerrm<>'version_conflict' then raise;end if;end;
  select to_jsonb(e) into after_entry from public.financeiro_lancamentos e where id=f.entry_id;
  if before_entry is distinct from after_entry then raise exception 'financial_record_mutated';end if;
  if not exists(select 1 from public.atendimentos_realizados where id=f.attendance_id and clinic_id=f.clinic_id and patient_id=f.patient_id and financial_entry_id=f.entry_id and version=2 and duration_minutes=45 and archived_at is null) then raise exception 'historical_financial_link_not_preserved';end if;
  if not exists(select 1 from public.atendimento_procedimentos where attendance_id=f.attendance_id and financial_entry_id=f.entry_id and is_primary and archived_at is null) then raise exception 'primary_item_financial_link_not_preserved';end if;
  oid:='public.operacao_salvar_atendimento(uuid,uuid,text,text,text,uuid,integer,uuid,uuid,uuid,uuid,text,timestamptz,smallint,text,uuid,uuid,uuid)'::regprocedure;
  if has_function_privilege('anon',oid,'EXECUTE') or has_function_privilege('authenticated',oid,'EXECUTE') or not has_function_privilege('service_role',oid,'EXECUTE') then raise exception 'rpc_acl_changed';end if;
end;$test$;
reset role;
rollback;
select jsonb_build_object('result','PASS',
  'synthetic_patients_remaining',(select count(*) from public.patients where full_name like 'TESTE TRANSACIONAL COBRANCA HISTORICA %'),
  'synthetic_entries_remaining',(select count(*) from public.financeiro_lancamentos where description like 'TESTE TRANSACIONAL COBRANCA HISTORICA %')) as smoke_result;

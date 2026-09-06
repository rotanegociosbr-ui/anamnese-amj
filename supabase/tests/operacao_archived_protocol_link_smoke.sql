-- Synthetic only. Execute only with explicit authorization. Always ROLLBACK.
begin;
create temporary table archived_link_context(clinic_id uuid,actor_id uuid,patient_id uuid,other_patient_id uuid,protocol_id uuid,other_protocol_id uuid,attendance_id uuid,request_id uuid,key uuid)
on commit drop;
grant select,update on archived_link_context to service_role;
do $fixture$
declare c uuid;u uuid;p uuid:=gen_random_uuid();p2 uuid:=gen_random_uuid();q uuid:=gen_random_uuid();q2 uuid:=gen_random_uuid();
begin
  select clinic_id,user_id into c,u from public.clinic_members where role='owner' and status='active' order by clinic_id,user_id limit 1;
  if c is null then raise exception 'no_owner_fixture_context';end if;
  insert into public.patients(id,clinic_id,full_name,created_by,dedup_exact_key)
  values(p,c,'TESTE TRANSACIONAL VINCULO ARQUIVADO '||p::text,u,p::text),
        (p2,c,'TESTE TRANSACIONAL VINCULO ARQUIVADO '||p2::text,u,p2::text);
  insert into public.protocols(id,clinic_id,patient_id,professional_id,procedure_kind,procedure_date,status)
  values(q,c,p,u,'avaliacao_facial',current_date,'draft'),(q2,c,p,u,'avaliacao_facial',current_date,'draft');
  insert into archived_link_context values(c,u,p,p2,q,q2,null,gen_random_uuid(),gen_random_uuid());
end;$fixture$;
set local role service_role;
do $create$
declare f record;r jsonb;
begin
  select * into f from archived_link_context;
  r:=public.operacao_salvar_atendimento(f.clinic_id,f.actor_id,'owner','supabase_auth','aal2',
    null,null,f.patient_id,null,f.protocol_id,null,'Teste transacional',now()-interval '1 hour',30::smallint,'realizado',f.actor_id,f.key,gen_random_uuid());
  update archived_link_context set attendance_id=(r->>'id')::uuid;
end;$create$;
reset role;
-- Fixture-only archive state, never a real protocol. Does not change the linked attendance.
update public.protocols p set archived_at=now(),archived_by=f.actor_id,archive_reason='Teste transacional de vínculo histórico',
  version=p.version+1,updated_by=f.actor_id,updated_at=now()
from archived_link_context f where p.id in (f.protocol_id,f.other_protocol_id);
set local role service_role;
do $test$
declare f record;a jsonb;b jsonb;t timestamptz;oid regprocedure;
begin
  select * into f from archived_link_context;
  select attended_at into t from public.atendimentos_realizados where id=f.attendance_id;
  a:=public.operacao_salvar_atendimento(f.clinic_id,f.actor_id,'owner','supabase_auth','aal2',
    f.attendance_id,1,f.patient_id,null,f.protocol_id,null,'Teste transacional',t,45::smallint,'realizado',f.actor_id,f.key,f.request_id);
  b:=public.operacao_salvar_atendimento(f.clinic_id,f.actor_id,'owner','supabase_auth','aal2',
    f.attendance_id,1,f.patient_id,null,f.protocol_id,null,'Teste transacional',t,45::smallint,'realizado',f.actor_id,f.key,f.request_id);
  if a->>'id'<>f.attendance_id::text or (a->>'version')::integer<>2 or (b->>'idempotent')::boolean is not true then raise exception 'historical_link_update_or_retry_failed';end if;
  begin
    perform public.operacao_salvar_atendimento(f.clinic_id,f.actor_id,'owner','supabase_auth','aal2',
      null,null,f.patient_id,null,f.protocol_id,null,'Teste transacional',t-interval '1 day',30::smallint,'realizado',f.actor_id,gen_random_uuid(),gen_random_uuid());
    raise exception 'new_archived_link_accepted';
  exception when check_violation then if sqlerrm<>'protocol_patient_mismatch' then raise;end if;end;
  begin
    perform public.operacao_salvar_atendimento(f.clinic_id,f.actor_id,'owner','supabase_auth','aal2',
      f.attendance_id,2,f.patient_id,null,f.other_protocol_id,null,'Teste transacional',t,30::smallint,'realizado',f.actor_id,f.key,gen_random_uuid());
    raise exception 'changed_archived_link_accepted';
  exception when check_violation then if sqlerrm<>'protocol_patient_mismatch' then raise;end if;end;
  begin
    perform public.operacao_salvar_atendimento(f.clinic_id,f.actor_id,'owner','supabase_auth','aal2',
      f.attendance_id,2,f.other_patient_id,null,f.protocol_id,null,'Teste transacional',t,30::smallint,'realizado',f.actor_id,f.key,gen_random_uuid());
    raise exception 'cross_patient_archived_link_accepted';
  exception when check_violation then if sqlerrm<>'protocol_patient_mismatch' then raise;end if;end;
  begin
    perform public.operacao_salvar_atendimento(f.clinic_id,f.actor_id,'owner','supabase_auth','aal2',
      f.attendance_id,1,f.patient_id,null,f.protocol_id,null,'Teste transacional',t,45::smallint,'realizado',f.actor_id,f.key,gen_random_uuid());
    raise exception 'stale_version_accepted';
  exception when serialization_failure then if sqlerrm<>'version_conflict' then raise;end if;end;
  if not exists(select 1 from public.atendimentos_realizados where id=f.attendance_id and patient_id=f.patient_id and protocol_id=f.protocol_id and version=2 and duration_minutes=45)
    or (select count(*) from public.protocols where id in (f.protocol_id,f.other_protocol_id) and archived_at is not null)<>2 then raise exception 'historical_record_changed_or_restored';end if;
  oid:='public.operacao_salvar_atendimento(uuid,uuid,text,text,text,uuid,integer,uuid,uuid,uuid,uuid,text,timestamptz,smallint,text,uuid,uuid,uuid)'::regprocedure;
  if has_function_privilege('anon',oid,'EXECUTE') or has_function_privilege('authenticated',oid,'EXECUTE') or not has_function_privilege('service_role',oid,'EXECUTE') then raise exception 'rpc_acl_changed';end if;
end;$test$;
reset role;
rollback;
select jsonb_build_object('result','PASS','synthetic_patients_remaining',count(*)) as smoke_result
from public.patients where full_name like 'TESTE TRANSACIONAL VINCULO ARQUIVADO %';

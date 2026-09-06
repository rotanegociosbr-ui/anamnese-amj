-- Run only as an explicit synthetic transaction. Never remove ROLLBACK.
-- For pre-deployment validation, insert the new CREATE OR REPLACE function
-- immediately after BEGIN; both the function and fixtures then roll back.
begin;
create temporary table appointment_scope_context(
 clinic_id uuid, actor_id uuid, patient_id uuid, other_patient_id uuid,
 product_id uuid, linked_appointment uuid, other_appointment uuid,
 candidate_appointment uuid, unlinked_appointment uuid
) on commit drop;
grant select on appointment_scope_context to service_role;
do $fixture$
declare c uuid;u uuid;p uuid:=gen_random_uuid();p2 uuid:=gen_random_uuid();
 product uuid:=gen_random_uuid();a uuid:=gen_random_uuid();a2 uuid:=gen_random_uuid();
 candidate uuid:=gen_random_uuid();unlinked uuid:=gen_random_uuid();
begin
 select clinic_id,user_id into c,u from public.clinic_members
 where role='owner' and status='active' order by clinic_id,user_id limit 1;
 if c is null then raise exception 'no_owner_fixture_context';end if;
 insert into public.patients(id,clinic_id,full_name,created_by,dedup_exact_key)
 values(p,c,'TESTE APPOINTMENT SCOPE '||p::text,u,p::text),
       (p2,c,'TESTE APPOINTMENT SCOPE '||p2::text,u,p2::text);
 insert into public.financeiro_produtos(id,clinic_id,name,product_type,unit,presentation,created_by,updated_by,stock_control)
 values(product,c,'TESTE APPOINTMENT SCOPE '||product::text,'descartavel','un','Unidade sintética',u,u,false);
 -- Completed synthetic appointments do not reserve slots or schedule reminders.
 insert into public.agendamentos_clinica(id,idempotency_key,nome,telefone,categoria,procedimento,inicio_em,fim_em,status)
 select x,gen_random_uuid(),'TESTE APPOINTMENT SCOPE '||x::text,'+5511999999999',
 'avaliacao','Teste transacional',now(),now()+interval '30 minutes','concluido'
 from unnest(array[a,a2,candidate,unlinked]) x;
 insert into public.patient_source_links(clinic_id,patient_id,source_kind,source_id,match_method,status,confirmed_by,confirmed_at)
 values(c,p,'agendamento',a,'manual','confirmado',u,now()),
 (c,p2,'agendamento',a2,'manual','confirmado',u,now()),
 (c,p,'agendamento',candidate,'manual','candidato',null,null);
 insert into appointment_scope_context values(c,u,p,p2,product,a,a2,candidate,unlinked);
end;$fixture$;

create function pg_temp.appointment_scope_save(p_protocol uuid,p_version integer,p_appointment uuid,p_request uuid)
returns jsonb language plpgsql security invoker set search_path='' as $helper$
declare f record;
begin
 select * into f from pg_temp.appointment_scope_context;
 return public.prontuario_salvar_rascunho_com_estoque(f.clinic_id,f.actor_id,'owner','supabase_auth',
 p_protocol,p_version,p_request,f.patient_id,p_appointment,null,'Teste de vínculo sintético','{}',null,null,null,null,
 jsonb_build_array(jsonb_build_object('product_id',f.product_id,'lot','LOTE TESTE SEM CONSUMO')),'{}',p_request);
end;$helper$;
grant execute on function pg_temp.appointment_scope_save(uuid,integer,uuid,uuid) to service_role;

set local role service_role;
do $test$
declare f record;a jsonb;b jsonb;key uuid:=gen_random_uuid();bad uuid;
begin
 select * into f from appointment_scope_context;
 if has_table_privilege('service_role','public.protocols','UPDATE') then
  raise exception 'protocol_update_privilege_expanded';end if;
 if has_function_privilege('authenticated','public.prontuario_salvar_rascunho(uuid,uuid,text,text,uuid,integer,uuid,uuid,uuid,text,text,jsonb,text,date,date,text,jsonb,jsonb,uuid)','EXECUTE') then
  raise exception 'browser_draft_rpc_exposed';end if;
 -- Regression: even a NULL appointment failed with the previous undefined column.
 a:=pg_temp.appointment_scope_save(null,null,null,key);
 b:=pg_temp.appointment_scope_save((a->>'id')::uuid,(a->>'version')::integer,null,gen_random_uuid());
 if a->>'id'<>b->>'id' or (b->>'version')::integer<>(a->>'version')::integer+1 then
  raise exception 'save_without_appointment_failed';end if;
 if not exists(select 1 from public.protocols where id=(a->>'id')::uuid and
  draft_products->0->>'product_id'=f.product_id::text and draft_products->0->>'lot'='LOTE TESTE SEM CONSUMO') then
  raise exception 'product_not_preserved';end if;
 if exists(select 1 from public.financeiro_estoque_movimentos where protocol_id=(a->>'id')::uuid) then
  raise exception 'draft_consumed_stock';end if;
 begin
  perform pg_temp.appointment_scope_save(null,null,gen_random_uuid(),gen_random_uuid());
  raise exception 'missing_appointment_accepted';
 exception when no_data_found then if sqlerrm<>'appointment_not_found' then raise;end if;end;
 foreach bad in array array[f.other_appointment,f.candidate_appointment,f.unlinked_appointment] loop
  begin
   perform pg_temp.appointment_scope_save(null,null,bad,gen_random_uuid());
   raise exception 'unconfirmed_or_other_patient_accepted';
  exception when check_violation then
   if sqlerrm<>'appointment_patient_link_required' then raise;end if;
  end;
 end loop;
 key:=gen_random_uuid();
 a:=pg_temp.appointment_scope_save(null,null,f.linked_appointment,key);
 b:=pg_temp.appointment_scope_save(null,null,f.linked_appointment,key);
 if a->>'id'<>b->>'id' or (b->>'idempotent')::boolean is not true then
  raise exception 'linked_appointment_retry_failed';end if;
 b:=pg_temp.appointment_scope_save((a->>'id')::uuid,(a->>'version')::integer,f.linked_appointment,gen_random_uuid());
 begin
  perform pg_temp.appointment_scope_save((a->>'id')::uuid,(a->>'version')::integer,f.linked_appointment,gen_random_uuid());
  raise exception 'stale_version_accepted';
 exception when serialization_failure then if sqlerrm<>'version_conflict' then raise;end if;end;
end;$test$;
set constraints all immediate;
reset role;
rollback;
select jsonb_build_object('result','PASS',
 'synthetic_patients_remaining',(select count(*) from public.patients where full_name like 'TESTE APPOINTMENT SCOPE %'),
 'synthetic_products_remaining',(select count(*) from public.financeiro_produtos where name like 'TESTE APPOINTMENT SCOPE %'),
 'synthetic_appointments_remaining',(select count(*) from public.agendamentos_clinica where nome like 'TESTE APPOINTMENT SCOPE %')) as smoke_result;

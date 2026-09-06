-- Synthetic fixture, fully rolled back. Do not run outside an explicit DB test.
begin;
create temporary table facial_test_context(clinic_id uuid,actor_id uuid,patient_id uuid,other_patient_id uuid,protocol_id uuid) on commit drop;
grant select on facial_test_context to service_role;
do $fixture$
declare c uuid; u uuid; p uuid:=gen_random_uuid(); p2 uuid:=gen_random_uuid(); q uuid:=gen_random_uuid();
begin
 select clinic_id,user_id into c,u from public.clinic_members where role='owner' and status='active' limit 1;
 if c is null then raise exception 'no_owner_fixture_context';end if;
 insert into public.patients(id,clinic_id,full_name,created_by,dedup_exact_key)
 values(p,c,'TESTE TRANSACIONAL ROSTO 3D '||p::text,u,p::text),(p2,c,'TESTE TRANSACIONAL ROSTO 3D '||p2::text,u,p2::text);
 insert into public.protocols(id,clinic_id,patient_id,professional_id,procedure_kind,procedure_date)
 values(q,c,p,u,'avaliacao_facial',current_date);
 insert into facial_test_context values(c,u,p,p2,q);
end;$fixture$;

-- Exercise the caller privileges used by PostgREST, not postgres.
set local role service_role;
do $test$
declare f record; op uuid:=gen_random_uuid(); a jsonb; b jsonb;
 d jsonb:='{"schemaVersion":1,"modelVersion":"amj-facial-20260906-v2","points":[],"notes":"Teste técnico temporário"}';
 sig text:='public.facial_study_save(uuid,uuid,uuid,uuid,integer,jsonb,text,uuid,integer)';
begin
 select * into f from facial_test_context;
 if not (select relrowsecurity from pg_class where oid='public.facial_studies'::regclass) then raise exception 'rls_missing';end if;
 if has_table_privilege('anon','public.facial_studies','SELECT') or has_table_privilege('authenticated','public.facial_studies','SELECT') or has_table_privilege('authenticated','public.facial_studies','INSERT') then raise exception 'clinical_public_privilege';end if;
 if has_table_privilege('service_role','public.protocols','UPDATE') then raise exception 'protocol_update_grant_expanded';end if;
 if has_table_privilege('service_role','public.facial_studies','UPDATE') or has_table_privilege('service_role','public.facial_studies','DELETE') then raise exception 'history_write_privilege';end if;
 if has_function_privilege('anon',sig,'EXECUTE') or has_function_privilege('authenticated',sig,'EXECUTE') then raise exception 'public_rpc_privilege';end if;
 if (select prosecdef from pg_proc where oid=sig::regprocedure) then raise exception 'unexpected_definer';end if;
 if to_regprocedure('public.facial_study_save(uuid,uuid,uuid,uuid,integer,jsonb,text)') is not null then raise exception 'unbound_rpc_still_exists';end if;
 a:=public.facial_study_save(f.clinic_id,f.actor_id,f.protocol_id,op,0,d,'Teste transacional',f.patient_id,1);
 if (a->>'version')::int<>1 then raise exception 'first_version';end if;
 b:=public.facial_study_save(f.clinic_id,f.actor_id,f.protocol_id,op,0,d,'Teste transacional',f.patient_id,1);
 if a->>'id'<>b->>'id' then raise exception 'duplicate_retry';end if;
 begin perform public.facial_study_save(f.clinic_id,f.actor_id,f.protocol_id,gen_random_uuid(),0,d,'Teste conflito',f.patient_id,1);raise exception 'conflict_not_rejected';exception when serialization_failure then if sqlerrm<>'facial_version_conflict' then raise;end if;end;
 begin perform public.facial_study_save(f.clinic_id,gen_random_uuid(),f.protocol_id,gen_random_uuid(),1,d,'Teste acesso',f.patient_id,1);raise exception 'unauthorized_not_rejected';exception when insufficient_privilege then null;end;
 begin perform public.facial_study_save(f.clinic_id,f.actor_id,f.protocol_id,op,0,d,'Teste paciente',f.other_patient_id,1);raise exception 'patient_context_not_rejected';exception when serialization_failure then if sqlerrm<>'facial_protocol_context_conflict' then raise;end if;end;
 begin perform public.facial_study_save(f.clinic_id,f.actor_id,f.protocol_id,op,0,d,'Teste consulta',f.patient_id,99);raise exception 'protocol_context_not_rejected';exception when serialization_failure then if sqlerrm<>'facial_protocol_context_conflict' then raise;end if;end;
 begin perform public.facial_study_save(f.clinic_id,f.actor_id,f.protocol_id,op,0,jsonb_set(d,'{notes}','"Diferente"'),'Teste operação',f.patient_id,1);raise exception 'operation_change_not_rejected';exception when unique_violation then null;end;
 b:=public.facial_study_save(f.clinic_id,f.actor_id,f.protocol_id,gen_random_uuid(),1,jsonb_set(d,'{notes}','"Anotação editada"'),'Teste versão 2',f.patient_id,1);
 if (b->>'version')::int<>2 or (select count(*) from public.facial_studies where protocol_id=f.protocol_id)<>2 then raise exception 'history_missing';end if;
 if (select document->>'notes' from public.facial_studies where protocol_id=f.protocol_id and version=1)<>'Teste técnico temporário' then raise exception 'history_overwritten';end if;
end;$test$;
reset role;

do $protocol$
declare f record;
begin
 select * into f from facial_test_context;
 begin update public.protocols set patient_id=f.other_patient_id,version=version+1,updated_by=f.actor_id where id=f.protocol_id;
  raise exception 'patient_history_move_allowed';
 exception when check_violation then if sqlerrm<>'facial_protocol_patient_locked' then raise;end if;end;
 update public.protocols set archived_at=now(),archive_reason='Teste transacional',archived_by=f.actor_id,version=version+1,updated_by=f.actor_id where id=f.protocol_id;
 if (select count(*) from public.facial_studies where protocol_id=f.protocol_id)<>2 then raise exception 'archive_lost_history';end if;
end;$protocol$;
set local role service_role;
do $archived$
declare f record;
begin
 select * into f from facial_test_context;
 begin perform public.facial_study_save(f.clinic_id,f.actor_id,f.protocol_id,gen_random_uuid(),2,
  '{"schemaVersion":1,"modelVersion":"amj-facial-20260906-v2","points":[],"notes":""}',
  'Teste arquivamento',f.patient_id,2);
  raise exception 'archived_save_allowed';
 exception when raise_exception then if sqlerrm<>'facial_protocol_unavailable' then raise;end if;end;
end;$archived$;
reset role;
rollback;

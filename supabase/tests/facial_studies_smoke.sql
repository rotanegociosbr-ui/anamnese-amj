-- Synthetic fixture, fully rolled back. No real patient is read or altered.
begin;
do $test$
declare c uuid; u uuid; p uuid:=gen_random_uuid(); q uuid:=gen_random_uuid(); op uuid:=gen_random_uuid(); a jsonb; b jsonb; d jsonb:='{"schemaVersion":1,"modelVersion":"amj-facial-20260906-v2","points":[],"notes":"Teste técnico temporário"}';
begin
 if not (select relrowsecurity from pg_class where oid='public.facial_studies'::regclass) then raise exception 'rls_missing';end if;
 if has_table_privilege('anon','public.facial_studies','SELECT') or has_table_privilege('authenticated','public.facial_studies','SELECT') or has_table_privilege('authenticated','public.facial_studies','INSERT') then raise exception 'clinical_public_privilege';end if;
 if has_function_privilege('anon','public.facial_study_save(uuid,uuid,uuid,uuid,integer,jsonb,text)','EXECUTE') or has_function_privilege('authenticated','public.facial_study_save(uuid,uuid,uuid,uuid,integer,jsonb,text)','EXECUTE') then raise exception 'public_rpc_privilege';end if;
 if (select prosecdef from pg_proc where oid='public.facial_study_save(uuid,uuid,uuid,uuid,integer,jsonb,text)'::regprocedure) then raise exception 'unexpected_definer';end if;
 select clinic_id,user_id into c,u from public.clinic_members where role='owner' and status='active' limit 1;
 if c is null then raise exception 'no_owner_fixture_context';end if;
 insert into public.patients(id,clinic_id,full_name,created_by,dedup_exact_key) values(p,c,'TESTE TRANSACIONAL ROSTO 3D '||p::text,u,p::text);
 insert into public.protocols(id,clinic_id,patient_id,professional_id,procedure_kind,procedure_date) values(q,c,p,u,'avaliacao_facial',current_date);
 a:=public.facial_study_save(c,u,q,op,0,d,'Teste transacional');
 if (a->>'version')::int<>1 then raise exception 'first_version';end if;
 b:=public.facial_study_save(c,u,q,op,0,d,'Teste transacional');
 if a->>'id'<>b->>'id' then raise exception 'duplicate_retry';end if;
 begin perform public.facial_study_save(c,u,q,gen_random_uuid(),0,d,'Teste conflito');raise exception 'conflict_not_rejected';exception when serialization_failure then null;end;
 begin perform public.facial_study_save(c,gen_random_uuid(),q,gen_random_uuid(),1,d,'Teste acesso');raise exception 'unauthorized_not_rejected';exception when insufficient_privilege then null;end;
 b:=public.facial_study_save(c,u,q,gen_random_uuid(),1,jsonb_set(d,'{notes}','"Anotação editada"'),'Teste versão 2');
 if (b->>'version')::int<>2 or (select count(*) from public.facial_studies where protocol_id=q)<>2 then raise exception 'history_missing';end if;
 if (select document->>'notes' from public.facial_studies where protocol_id=q and version=1)<>'Teste técnico temporário' then raise exception 'history_overwritten';end if;
 if (select document->>'notes' from public.facial_studies where protocol_id=q order by version desc limit 1)<>'Anotação editada' then raise exception 'reload_failed';end if;
end;$test$;
rollback;

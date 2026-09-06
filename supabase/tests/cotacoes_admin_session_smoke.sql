-- Explicit synthetic validation only. No real quote, patient, JWT or refresh token.
-- For pre-deployment testing, insert migration statements after BEGIN, omitting
-- the migration BEGIN/COMMIT. Never remove this final ROLLBACK.
begin;
create temporary table cotacao_admin_fixture(c uuid,u uuid,s uuid,s1 uuid,expired uuid,source uuid,item uuid,op uuid) on commit drop;
grant select on cotacao_admin_fixture to service_role;
do $fixture$
declare c uuid;u uuid;s uuid:=gen_random_uuid();s1 uuid:=gen_random_uuid();expired uuid:=gen_random_uuid();
 src uuid:=gen_random_uuid();item uuid:=gen_random_uuid();
begin
 select clinic_id,user_id into c,u from public.clinic_members where role='owner' and status='active' limit 1;
 if c is null then raise exception 'no_owner_fixture_context';end if;
 insert into auth.sessions(id,user_id,aal,created_at,updated_at,not_after)
 values(s,u,'aal2',now(),now(),null),(s1,u,'aal1',now(),now(),null),
 (expired,u,'aal2',now(),now(),now()-interval '1 minute');
 insert into public.cotacao_fontes(id,clinic_id,source_name,source_type,file_name,file_sha256,source_date)
 values(src,c,'TESTE ADMIN SESSION '||src::text,'texto_fornecido','synthetic-only.txt',private.cotacoes_sha256(src::text),current_date);
 insert into public.cotacao_itens(id,clinic_id,source_id,item_name,canonical_item_key)
 values(item,c,src,'TESTE ADMIN SESSION '||item::text,private.cotacoes_sha256(item::text));
 insert into cotacao_admin_fixture values(c,u,s,s1,expired,src,item,gen_random_uuid());
end;$fixture$;
set local role service_role;
do $test$
declare f record;r jsonb;a jsonb;bad uuid;
begin
 select * into f from cotacao_admin_fixture;
 if has_function_privilege('anon','public.cotacoes_revisar_sku_exato_admin_session(uuid,uuid,text,text,integer,uuid,uuid,uuid,uuid)','EXECUTE')
 or has_function_privilege('authenticated','public.cotacoes_revisar_sku_exato_admin_session(uuid,uuid,text,text,integer,uuid,uuid,uuid,uuid)','EXECUTE')
 or has_table_privilege('service_role','public.cotacao_sku_revisoes','INSERT,UPDATE,DELETE') then raise exception 'cotacao_auth_privilege_expanded';end if;
 foreach bad in array array[f.s1,f.expired,gen_random_uuid()] loop
  r:=public.cotacoes_revisar_sku_exato_admin_session(f.c,f.item,'rejeitar','Motivo sintético',1,gen_random_uuid(),f.u,bad,gen_random_uuid());
  if r->>'code'<>'admin_session_invalid' then raise exception 'invalid_session_allowed';end if;
 end loop;
 r:=public.cotacoes_revisar_sku_exato_admin_session(f.c,f.item,null,'Motivo sintético',1,gen_random_uuid(),f.u,f.s,gen_random_uuid());
 if r->>'code'<>'invalid_request' then raise exception 'null_decision_allowed';end if;
 r:=public.cotacoes_revisar_sku_exato_admin_session(f.c,f.item,'rejeitar','Motivo sintético',1,gen_random_uuid(),gen_random_uuid(),f.s,gen_random_uuid());
 if r->>'code'<>'owner_required' then raise exception 'wrong_actor_allowed';end if;
 r:=public.cotacoes_revisar_sku_exato_admin_session(gen_random_uuid(),f.item,'rejeitar','Motivo sintético',1,gen_random_uuid(),f.u,f.s,gen_random_uuid());
 if r->>'code'<>'owner_required' then raise exception 'wrong_clinic_allowed';end if;
 r:=public.cotacoes_revisar_sku_exato_admin_session(f.c,f.item,'aprovar','Motivo sintético',1,gen_random_uuid(),f.u,f.s,gen_random_uuid());
 if r->>'code'<>'exact_identity_incomplete' then raise exception 'incomplete_identity_approved';end if;
 a:=public.cotacoes_revisar_sku_exato_admin_session(f.c,f.item,'rejeitar','Motivo sintético',1,f.op,f.u,f.s,gen_random_uuid());
 if a->>'ok'<>'true' or a->>'review_version'<>'2' then raise exception 'admin_session_review_failed';end if;
 if not exists(select 1 from public.cotacao_sku_revisoes where clinic_id=f.c and operation_id=f.op
  and authorization_mode='admin_session' and proof_id is null and octet_length(main_session_hmac)=32) then raise exception 'fake_or_missing_session_evidence';end if;
 r:=public.cotacoes_revisar_sku_exato_admin_session(f.c,f.item,'rejeitar','Motivo sintético',1,f.op,f.u,f.s,gen_random_uuid());
 if r->>'idempotent'<>'true' or r->>'review_version'<>a->>'review_version' then raise exception 'retry_changed_review';end if;
 if (select count(*) from public.cotacao_sku_revisoes where clinic_id=f.c and operation_id=f.op)<>1 then raise exception 'duplicate_review';end if;
 r:=public.cotacoes_revisar_sku_exato_admin_session(f.c,f.item,'rejeitar','Outro motivo',1,f.op,f.u,f.s,gen_random_uuid());
 if r->>'code'<>'operation_conflict' then raise exception 'operation_reused_for_other_payload';end if;
 r:=public.cotacoes_revisar_sku_exato_admin_session(f.c,f.item,'aprovar','Motivo sintético',1,gen_random_uuid(),f.u,f.s,gen_random_uuid());
 if r->>'code'<>'version_conflict' then raise exception 'stale_version_allowed';end if;
end;$test$;
reset role;
-- Revoke only the synthetic session. No existing login is touched.
delete from auth.sessions where id=(select s from cotacao_admin_fixture);
set local role service_role;
do $revoked$
declare f record;r jsonb;
begin
 select * into f from cotacao_admin_fixture;
 r:=public.cotacoes_revisar_sku_exato_admin_session(f.c,f.item,'rejeitar','Motivo sintético',1,f.op,f.u,f.s,gen_random_uuid());
 if r->>'code'<>'admin_session_invalid' then raise exception 'revoked_session_replayed_review';end if;
end;$revoked$;
reset role;
rollback;
select jsonb_build_object('result','PASS',
 'synthetic_sources_remaining',(select count(*) from public.cotacao_fontes where source_name like 'TESTE ADMIN SESSION %'),
 'synthetic_items_remaining',(select count(*) from public.cotacao_itens where item_name like 'TESTE ADMIN SESSION %')) as smoke_result;

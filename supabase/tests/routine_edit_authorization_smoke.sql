-- Synthetic, rollback-only regression. Creates no password/token or patient.
-- Requires an administrator for fixtures; real checks run as service_role.
begin;
create temporary table routine_edit_fixture(c uuid,u uuid,s uuid[],proof uuid,expiry timestamptz) on commit drop;
grant select,update on routine_edit_fixture to service_role;
do $fixture$
declare c uuid;u uuid;s uuid[]:=array[gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid()];
begin
 select clinic_id,user_id into c,u from public.clinic_members where role='owner' and status='active' limit 1;
 if c is null then raise exception 'no_owner_fixture_context';end if;
 -- These isolated session IDs have no JWT or refresh token and never log in.
 insert into auth.sessions(id,user_id,created_at,updated_at) select unnest(s),u,now(),now();
 insert into routine_edit_fixture values(c,u,s,null,null);
end;$fixture$;
create function pg_temp.routine_test_proof(c uuid,u uuid,s uuid,secondary uuid)
returns uuid language plpgsql security invoker set search_path='' as $$
declare op uuid:=gen_random_uuid(); r jsonb; consumed jsonb;
begin
 r:=public.clinic_register_password_proof(c,u,s,secondary,op,'routine_edit.grant',c,clock_timestamp(),gen_random_uuid());
 if not coalesce((r->>'ok')::boolean,false) then raise exception 'synthetic_proof_register_failed';end if;
 consumed:=public.clinic_consume_password_proof(c,u,s,secondary,op,'routine_edit.grant',c,gen_random_uuid());
 if not coalesce((consumed->>'ok')::boolean,false) or consumed->>'proof_id'<>r->>'proof_id' then raise exception 'synthetic_proof_consume_failed';end if;
 return (r->>'proof_id')::uuid;
end;$$;
grant execute on function pg_temp.routine_test_proof(uuid,uuid,uuid,uuid) to service_role;
set local role service_role;
do $test$
declare f record;r jsonb;a text;v_proof uuid;v_grants_oid oid;v_revocations_oid oid;sig text:='public.clinic_routine_edit_authorization(uuid,uuid,uuid,text,uuid,text)';
begin
 select * into f from routine_edit_fixture;
 select c.oid into v_grants_oid from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='private' and c.relname='clinic_routine_edit_grants';
 select c.oid into v_revocations_oid from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='private' and c.relname='clinic_routine_edit_revocations';
 if not (select relrowsecurity from pg_class where oid=v_grants_oid)
  or not (select relrowsecurity from pg_class where oid=v_revocations_oid) then raise exception 'routine_rls_missing';end if;
 if has_table_privilege('anon',v_grants_oid,'SELECT')
  or has_table_privilege('authenticated',v_grants_oid,'SELECT,INSERT,UPDATE,DELETE')
  or has_table_privilege('service_role',v_grants_oid,'SELECT,INSERT,UPDATE,DELETE')
  or has_table_privilege('service_role',v_revocations_oid,'SELECT,INSERT,UPDATE,DELETE') then raise exception 'routine_direct_grant';end if;
 if has_function_privilege('anon',sig,'EXECUTE') or has_function_privilege('authenticated',sig,'EXECUTE') then raise exception 'routine_public_rpc';end if;
 r:=public.clinic_routine_edit_authorization(f.c,f.u,f.s[1],'status');
 if (r->>'active')::boolean then raise exception 'routine_initially_active';end if;
 begin perform public.clinic_routine_edit_authorization(f.c,f.u,f.s[1],'grant');raise exception 'routine_missing_proof_allowed';
 exception when insufficient_privilege then if sqlerrm<>'routine_edit_proof_invalid' then raise;end if;end;
 v_proof:=pg_temp.routine_test_proof(f.c,f.u,f.s[1],f.s[2]);
 r:=public.clinic_routine_edit_authorization(f.c,f.u,f.s[1],'grant',v_proof);
 if not (r->>'active')::boolean or (r->>'expires_at')::timestamptz<clock_timestamp()+interval '29 minutes'
  or (r->>'expires_at')::timestamptz>clock_timestamp()+interval '30 minutes' then raise exception 'routine_wrong_duration';end if;
 update routine_edit_fixture set proof=v_proof,expiry=(r->>'expires_at')::timestamptz;
 -- All calls, including an explicit new grant, retain the original deadline.
 f.expiry:=(r->>'expires_at')::timestamptz;
 r:=public.clinic_routine_edit_authorization(f.c,f.u,f.s[1],'grant',gen_random_uuid());
 if (r->>'expires_at')::timestamptz<>f.expiry then raise exception 'routine_window_extended';end if;
 foreach a in array array['financeiro.editar_cliente','financeiro.editar_fornecedor','financeiro.editar_marca','financeiro.editar_produto','prontuario.update','rosto3d.study.save'] loop
  r:=public.clinic_routine_edit_authorization(f.c,f.u,f.s[1],'status',null,a);
  if not (r->>'active')::boolean or (r->>'expires_at')::timestamptz<>f.expiry then raise exception 'routine_allowlist_failed';end if;
 end loop;
 foreach a in array array['prontuario.finalize','prontuario.archive','prontuario.consent','financeiro.estornar_pagamento','financeiro.cancelar_lancamento','painel.anamnese.excluir_definitivamente'] loop
  begin perform public.clinic_routine_edit_authorization(f.c,f.u,f.s[1],'status',null,a);raise exception 'critical_action_allowed';
  exception when insufficient_privilege then if sqlerrm<>'routine_edit_action_not_allowed' then raise;end if;end;
 end loop;
 r:=public.clinic_routine_edit_authorization(f.c,f.u,f.s[3],'status');
 if (r->>'active')::boolean then raise exception 'routine_leaked_to_other_session';end if;
 begin perform public.clinic_routine_edit_authorization(f.c,gen_random_uuid(),f.s[1],'status');raise exception 'routine_other_actor_allowed';exception when insufficient_privilege then null;end;
 begin perform public.clinic_routine_edit_authorization(gen_random_uuid(),f.u,f.s[1],'status');raise exception 'routine_other_clinic_allowed';exception when insufficient_privilege then null;end;
end;$test$;
reset role;
-- Simulate time passing in this synthetic fixture without waiting 30 minutes.
update private.clinic_routine_edit_grants set granted_at=granted_at-interval '31 minutes',expires_at=expires_at-interval '31 minutes'
 where proof_id=(select proof from routine_edit_fixture);
set local role service_role;
do $expiry$
declare f record;r jsonb;proof2 uuid;pending uuid;
begin
 select * into f from routine_edit_fixture;
 r:=public.clinic_routine_edit_authorization(f.c,f.u,f.s[1],'status');
 if (r->>'active')::boolean then raise exception 'routine_expiry_failed';end if;
 begin perform public.clinic_routine_edit_authorization(f.c,f.u,f.s[1],'grant',f.proof);raise exception 'routine_expired_proof_replayed';
 exception when insufficient_privilege then if sqlerrm<>'routine_edit_proof_reused' then raise;end if;end;
 proof2:=pg_temp.routine_test_proof(f.c,f.u,f.s[1],f.s[4]);
 r:=public.clinic_routine_edit_authorization(f.c,f.u,f.s[1],'grant',proof2);
 if not (r->>'active')::boolean then raise exception 'routine_new_password_not_granted';end if;
 r:=public.clinic_routine_edit_authorization(f.c,f.u,f.s[1],'revoke');
 if (r->>'active')::boolean then raise exception 'routine_revoke_failed';end if;
 r:=public.clinic_routine_edit_authorization(f.c,f.u,f.s[1],'status');
 if (r->>'active')::boolean then raise exception 'routine_revoked_still_active';end if;
 begin perform public.clinic_routine_edit_authorization(f.c,f.u,f.s[1],'grant',proof2);raise exception 'routine_revoked_proof_replayed';
 exception when insufficient_privilege then if sqlerrm<>'routine_edit_proof_reused' then raise;end if;end;
 -- Revoke must also beat a confirmation which has not created a grant yet.
 pending:=pg_temp.routine_test_proof(f.c,f.u,f.s[3],f.s[5]);
 perform public.clinic_routine_edit_authorization(f.c,f.u,f.s[3],'revoke');
 begin perform public.clinic_routine_edit_authorization(f.c,f.u,f.s[3],'grant',pending);raise exception 'routine_pending_confirmation_survived_revoke';
 exception when insufficient_privilege then if sqlerrm<>'routine_edit_proof_invalid' then raise;end if;end;
 perform pg_sleep(0.01); -- Distinct issuance time, including millisecond test clocks.
 pending:=pg_temp.routine_test_proof(f.c,f.u,f.s[3],f.s[6]);
 r:=public.clinic_routine_edit_authorization(f.c,f.u,f.s[3],'grant',pending);
 if not (r->>'active')::boolean then raise exception 'routine_fresh_confirmation_after_revoke_failed';end if;
end;$expiry$;
reset role;
delete from auth.sessions where id=(select s[3] from routine_edit_fixture);
set local role service_role;
do $logout$
declare f record;
begin
 select * into f from routine_edit_fixture;
 begin perform public.clinic_routine_edit_authorization(f.c,f.u,f.s[3],'status');raise exception 'routine_logout_not_checked';
 exception when insufficient_privilege then if sqlerrm<>'routine_edit_session_denied' then raise;end if;end;
end;$logout$;
reset role;
rollback;

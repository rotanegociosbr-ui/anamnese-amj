-- A short, absolute authorization window for an explicit routine-edit allowlist.
-- Existing 120-second one-time password proofs and all clinical ACLs are unchanged.
create table private.clinic_routine_edit_grants (
 id uuid primary key default gen_random_uuid(),
 clinic_id uuid not null references public.clinics(id) on delete cascade,
 actor_user_id uuid not null references auth.users(id) on delete cascade,
 main_session_hmac bytea not null check(octet_length(main_session_hmac)=32),
 proof_id uuid not null unique references private.clinic_password_proofs(id) on delete cascade,
 granted_at timestamptz not null,
 expires_at timestamptz not null,
 revoked_at timestamptz,
 check(expires_at=granted_at+interval '30 minutes'),
 check(revoked_at is null or revoked_at>=granted_at)
);
create index clinic_routine_edit_grants_session_idx on private.clinic_routine_edit_grants
 (clinic_id,actor_user_id,main_session_hmac,expires_at desc) where revoked_at is null;
create index clinic_routine_edit_grants_actor_idx on private.clinic_routine_edit_grants(actor_user_id);
alter table private.clinic_routine_edit_grants enable row level security;
revoke all on private.clinic_routine_edit_grants from public,anon,authenticated,service_role;
comment on table private.clinic_routine_edit_grants is
 'Absolute 30-minute routine-edit authorization per clinic/owner/main-session HMAC. No raw password, JWT, refresh token or session UUID. Not valid for destructive or financial actions.';
-- A revoke also cancels a password confirmation still in flight, even when no
-- grant has reached the database yet. Only a newer confirmation can grant again.
create table private.clinic_routine_edit_revocations (
 clinic_id uuid not null references public.clinics(id) on delete cascade,
 actor_user_id uuid not null references auth.users(id) on delete cascade,
 main_session_hmac bytea not null check(octet_length(main_session_hmac)=32),
 revoked_at timestamptz not null,
 primary key(clinic_id,actor_user_id,main_session_hmac)
);
create index clinic_routine_edit_revocations_actor_idx on private.clinic_routine_edit_revocations(actor_user_id);
alter table private.clinic_routine_edit_revocations enable row level security;
revoke all on private.clinic_routine_edit_revocations from public,anon,authenticated,service_role;

-- This narrowly scoped service-only RPC intentionally follows the existing
-- private password-proof boundary. It needs private HMAC/proof and auth.sessions
-- access; no caller receives direct access to these tables or the HMAC secret.
create function public.clinic_routine_edit_authorization(
 p_clinic_id uuid,p_actor_user_id uuid,p_main_session_id uuid,p_mode text,
 p_proof_id uuid default null,p_action text default null
)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_now timestamptz:=clock_timestamp(); v_hmac bytea;
 v_grant private.clinic_routine_edit_grants%rowtype;
 v_proof private.clinic_password_proofs%rowtype;
begin
 if p_clinic_id is null or p_actor_user_id is null or p_main_session_id is null
    or p_mode is null or p_mode not in ('status','grant','revoke') then
  raise exception 'routine_edit_invalid_scope' using errcode='22023';
 end if;
 if p_action is not null and p_action not in (
  'financeiro.editar_cliente','financeiro.editar_fornecedor',
  'financeiro.editar_marca','financeiro.editar_produto',
  'prontuario.update','rosto3d.study.save'
 ) then raise exception 'routine_edit_action_not_allowed' using errcode='42501';end if;
 if not exists(select 1 from public.clinic_members where clinic_id=p_clinic_id
     and user_id=p_actor_user_id and role='owner' and status='active')
    or not exists(select 1 from auth.sessions where id=p_main_session_id and user_id=p_actor_user_id) then
  raise exception 'routine_edit_session_denied' using errcode='42501';
 end if;
 v_hmac:=private.clinic_password_session_hmac(p_main_session_id);
 if v_hmac is null then raise exception 'routine_edit_unavailable' using errcode='P0001';end if;
 -- Serialize grant/revoke on this session only. Status never renews anything.
 if p_mode<>'status' then
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
   'routine-edit:'||p_clinic_id::text||':'||p_actor_user_id::text||':'||encode(v_hmac,'hex'),0));
  v_now:=clock_timestamp();
 end if;
 if p_mode='revoke' then
  insert into private.clinic_routine_edit_revocations(clinic_id,actor_user_id,main_session_hmac,revoked_at)
   values(p_clinic_id,p_actor_user_id,v_hmac,v_now)
   on conflict(clinic_id,actor_user_id,main_session_hmac) do update set revoked_at=excluded.revoked_at;
  update private.clinic_routine_edit_grants set revoked_at=v_now
   where clinic_id=p_clinic_id and actor_user_id=p_actor_user_id and main_session_hmac=v_hmac and revoked_at is null;
  return jsonb_build_object('ok',true,'active',false,'expires_at',null);
 end if;
 select * into v_grant from private.clinic_routine_edit_grants
  where clinic_id=p_clinic_id and actor_user_id=p_actor_user_id and main_session_hmac=v_hmac
    and revoked_at is null and expires_at>v_now order by expires_at desc limit 1;
 if found then
  -- Even an explicit grant request cannot extend an already active window.
  return jsonb_build_object('ok',true,'active',true,'expires_at',v_grant.expires_at);
 end if;
 if p_mode='status' then return jsonb_build_object('ok',true,'active',false,'expires_at',null);end if;
 -- A consumed proof authorizes exactly one grant. Revoking/expiring it cannot
 -- be undone by replaying that proof, even while its original 120 s remain.
 if exists(select 1 from private.clinic_routine_edit_grants where proof_id=p_proof_id) then
  raise exception 'routine_edit_proof_reused' using errcode='42501';
 end if;
 select * into v_proof from private.clinic_password_proofs where id=p_proof_id;
 if not found or v_proof.clinic_id<>p_clinic_id or v_proof.actor_user_id<>p_actor_user_id
    or v_proof.main_session_hmac<>v_hmac or v_proof.action<>'routine_edit.grant'
    or v_proof.target_id<>p_clinic_id or v_proof.used_at is null or v_proof.used_at>v_now
    or v_proof.expires_at<=v_now or v_proof.password_authenticated_at<v_now-interval '120 seconds'
    or v_proof.password_authenticated_at>v_now+interval '30 seconds'
    or exists(select 1 from private.clinic_routine_edit_revocations where clinic_id=p_clinic_id
      and actor_user_id=p_actor_user_id and main_session_hmac=v_hmac
      and revoked_at>=v_proof.password_authenticated_at) then
  raise exception 'routine_edit_proof_invalid' using errcode='42501';
 end if;
 insert into private.clinic_routine_edit_grants(clinic_id,actor_user_id,main_session_hmac,proof_id,granted_at,expires_at)
 values(p_clinic_id,p_actor_user_id,v_hmac,p_proof_id,v_now,v_now+interval '30 minutes') returning * into v_grant;
 return jsonb_build_object('ok',true,'active',true,'expires_at',v_grant.expires_at);
end;$$;
revoke all on function public.clinic_routine_edit_authorization(uuid,uuid,uuid,text,uuid,text) from public,anon,authenticated;
grant execute on function public.clinic_routine_edit_authorization(uuid,uuid,uuid,text,uuid,text) to service_role;

-- Provas de senha recentes para operacoes destrutivas.
--
-- A Edge Function valida os dois JWTs no Supabase Auth antes de chamar estas
-- RPCs. O banco confirma owner ativo + sessoes ativas, guarda apenas HMAC dos
-- session_id e vincula cada prova a uma unica operacao/alvo por ate 120 s.
-- Nenhuma senha, JWT, refresh token, email, IP ou dado de paciente e gravado.

create schema if not exists private;

revoke all on schema private from public, anon, authenticated, service_role;

-- Chave aleatoria gerada dentro do banco. Ela nao aparece no historico Git e
-- nunca e devolvida por RPC. Rotaciona-la invalida todas as provas pendentes.
create table if not exists private.clinic_password_proof_secrets (
  singleton smallint primary key default 1,
  secret bytea not null,
  created_at timestamptz not null default now(),
  constraint clinic_password_proof_secrets_singleton_check
    check (singleton = 1),
  constraint clinic_password_proof_secrets_length_check
    check (octet_length(secret) = 32)
);

insert into private.clinic_password_proof_secrets (singleton, secret)
values (1, extensions.gen_random_bytes(32))
on conflict (singleton) do nothing;

create table if not exists private.clinic_password_proofs (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null
    references public.clinics(id) on delete cascade,
  actor_user_id uuid not null
    references auth.users(id) on delete cascade,
  main_session_hmac bytea not null,
  secondary_session_hmac bytea not null,
  operation_id uuid not null,
  action text not null,
  target_id uuid not null,
  password_authenticated_at timestamptz not null,
  expires_at timestamptz not null,
  registered_at timestamptz not null default now(),
  register_request_id uuid not null,
  used_at timestamptz,
  consume_request_id uuid,
  constraint clinic_password_proofs_operation_key
    unique (clinic_id, operation_id),
  constraint clinic_password_proofs_secondary_session_key
    unique (secondary_session_hmac),
  constraint clinic_password_proofs_main_hmac_length_check
    check (octet_length(main_session_hmac) = 32),
  constraint clinic_password_proofs_secondary_hmac_length_check
    check (octet_length(secondary_session_hmac) = 32),
  constraint clinic_password_proofs_sessions_distinct_check
    check (main_session_hmac <> secondary_session_hmac),
  constraint clinic_password_proofs_action_check
    check (
      char_length(action) between 2 and 80
      and action ~ '^[a-z][a-z0-9_.:-]+$'
    ),
  constraint clinic_password_proofs_expiry_check
    check (
      expires_at > password_authenticated_at
      and expires_at <= password_authenticated_at + interval '120 seconds'
    ),
  constraint clinic_password_proofs_used_check
    check (
      (used_at is null and consume_request_id is null)
      or (
        used_at is not null
        and consume_request_id is not null
        and used_at >= registered_at
      )
    )
);

create table if not exists private.clinic_password_proof_rate_limits (
  clinic_id uuid not null
    references public.clinics(id) on delete cascade,
  actor_user_id uuid not null
    references auth.users(id) on delete cascade,
  window_started_at timestamptz not null default now(),
  attempt_count integer not null default 0,
  blocked_until timestamptz,
  updated_at timestamptz not null default now(),
  primary key (clinic_id, actor_user_id),
  constraint clinic_password_proof_rate_attempt_check
    check (attempt_count between 0 and 10000),
  constraint clinic_password_proof_rate_block_check
    check (blocked_until is null or blocked_until >= window_started_at)
);

create index if not exists clinic_password_proofs_expiry_idx
  on private.clinic_password_proofs (expires_at)
  where used_at is null;

create index if not exists clinic_password_proofs_actor_registered_idx
  on private.clinic_password_proofs (
    clinic_id,
    actor_user_id,
    registered_at desc
  );

-- PostgreSQL nao cria indice automaticamente para o lado referenciante da FK.
-- Estes dois evitam varredura integral ao remover/revogar um usuario do Auth.
create index if not exists clinic_password_proofs_actor_user_idx
  on private.clinic_password_proofs (actor_user_id);

create index if not exists clinic_password_proof_rate_limits_actor_user_idx
  on private.clinic_password_proof_rate_limits (actor_user_id);

comment on table private.clinic_password_proofs is
  'Provas de senha efemeras e one-time; session_id somente em HMAC-SHA256.';
comment on table private.clinic_password_proof_rate_limits is
  'Limitador persistente por clinica e owner para registrar provas destrutivas.';
comment on column private.clinic_password_proofs.operation_id is
  'Idempotency key criada para uma unica tentativa de operacao.';
comment on column private.clinic_password_proofs.target_id is
  'UUID tecnico do registro; a tabela/entidade e codificada em action server-side.';

alter table private.clinic_password_proof_secrets enable row level security;
alter table private.clinic_password_proofs enable row level security;
alter table private.clinic_password_proof_rate_limits enable row level security;

-- Nem service_role recebe acesso direto: somente as RPCs SECURITY DEFINER
-- abaixo podem ler/gravar as tabelas privadas.
revoke all on table private.clinic_password_proof_secrets
  from public, anon, authenticated, service_role;
revoke all on table private.clinic_password_proofs
  from public, anon, authenticated, service_role;
revoke all on table private.clinic_password_proof_rate_limits
  from public, anon, authenticated, service_role;

create or replace function private.clinic_password_session_hmac(
  p_session_id uuid
)
returns bytea
language sql
stable
security definer
set search_path = ''
as $function$
  select extensions.hmac(
    pg_catalog.convert_to(p_session_id::text, 'UTF8'),
    secret.secret,
    'sha256'
  )
  from private.clinic_password_proof_secrets as secret
  where secret.singleton = 1;
$function$;

revoke execute on function private.clinic_password_session_hmac(uuid)
  from public, anon, authenticated, service_role;

-- Separa a chave da trilha tecnica da prova da chave idempotente da mutacao.
-- Assim, consumir a prova nunca ocupa (clinic_id, request_id) do evento de
-- dominio que sera escrito logo depois pela mesma requisicao Edge.
create or replace function private.clinic_password_proof_audit_request_id(
  p_request_id uuid,
  p_event_action text,
  p_entity_id uuid
)
returns uuid
language sql
immutable
parallel safe
set search_path = ''
as $function$
  with digest as (
    select pg_catalog.md5(pg_catalog.concat_ws(
      ':',
      'amj-password-proof-audit-v1',
      p_request_id::text,
      p_event_action,
      p_entity_id::text
    )) as value
  )
  select (
    pg_catalog.substr(value, 1, 8) || '-' ||
    pg_catalog.substr(value, 9, 4) || '-' ||
    pg_catalog.substr(value, 13, 4) || '-' ||
    pg_catalog.substr(value, 17, 4) || '-' ||
    pg_catalog.substr(value, 21, 12)
  )::uuid
  from digest;
$function$;

revoke all on function private.clinic_password_proof_audit_request_id(
  uuid, text, uuid
) from public, anon, authenticated, service_role;

-- Auditoria exclusivamente tecnica. O helper existente da migration RBAC
-- continua impondo o allowlist de chaves/valores e a tabela e append-only.
create or replace function private.clinic_password_proof_audit(
  p_clinic_id uuid,
  p_actor_user_id uuid,
  p_entity_id uuid,
  p_event_action text,
  p_operation text,
  p_outcome text,
  p_reason_code text,
  p_request_id uuid
)
returns void
language sql
volatile
security definer
set search_path = ''
as $function$
  insert into public.clinic_audit_log (
    clinic_id,
    actor,
    entity,
    entity_id,
    action,
    details,
    actor_role,
    auth_method,
    outcome,
    request_id
  )
  values (
    p_clinic_id,
    p_actor_user_id,
    'password_proof',
    p_entity_id,
    p_event_action,
    jsonb_build_object(
      'operation', p_operation,
      'target_kind', 'record',
      'reason_code', p_reason_code
    ),
    'owner',
    'supabase_auth',
    p_outcome,
    private.clinic_password_proof_audit_request_id(
      p_request_id, p_event_action, p_entity_id
    )
  )
  on conflict (clinic_id, request_id) do nothing;
$function$;

revoke execute on function private.clinic_password_proof_audit(
  uuid,
  uuid,
  uuid,
  text,
  text,
  text,
  text,
  uuid
)
  from public, anon, authenticated, service_role;

-- Registra uma prova validada pela Edge. Respostas de negocio sao JSON para
-- que bloqueio/reuso sejam persistidos e auditados sem RAISE (um exception
-- faria rollback do limitador e da auditoria).
create or replace function public.clinic_register_password_proof(
  p_clinic_id uuid,
  p_actor_user_id uuid,
  p_main_session_id uuid,
  p_secondary_session_id uuid,
  p_operation_id uuid,
  p_action text,
  p_target_id uuid,
  p_password_authenticated_at timestamptz,
  p_request_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_now timestamptz := clock_timestamp();
  v_main_hmac bytea;
  v_secondary_hmac bytea;
  v_existing private.clinic_password_proofs%rowtype;
  v_limiter private.clinic_password_proof_rate_limits%rowtype;
  v_proof_id uuid := gen_random_uuid();
  v_expires_at timestamptz;
begin
  if p_clinic_id is null
     or p_actor_user_id is null
     or p_main_session_id is null
     or p_secondary_session_id is null
     or p_operation_id is null
     or p_target_id is null
     or p_password_authenticated_at is null
     or p_request_id is null
     or p_action is null
     or char_length(p_action) not between 2 and 80
     or p_action !~ '^[a-z][a-z0-9_.:-]+$' then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;

  if p_main_session_id = p_secondary_session_id then
    return jsonb_build_object('ok', false, 'code', 'sessions_must_differ');
  end if;

  if not exists (
    select 1
    from public.clinic_members as member
    where member.clinic_id = p_clinic_id
      and member.user_id = p_actor_user_id
      and member.role = 'owner'
      and member.status = 'active'
  ) then
    return jsonb_build_object('ok', false, 'code', 'owner_required');
  end if;

  insert into private.clinic_password_proof_rate_limits (
    clinic_id,
    actor_user_id,
    window_started_at,
    attempt_count,
    updated_at
  )
  values (p_clinic_id, p_actor_user_id, v_now, 0, v_now)
  on conflict (clinic_id, actor_user_id) do nothing;

  select limiter.*
  into v_limiter
  from private.clinic_password_proof_rate_limits as limiter
  where limiter.clinic_id = p_clinic_id
    and limiter.actor_user_id = p_actor_user_id
  for update;

  if v_limiter.window_started_at <= v_now - interval '15 minutes' then
    update private.clinic_password_proof_rate_limits
    set window_started_at = v_now,
        attempt_count = 0,
        blocked_until = null,
        updated_at = v_now
    where clinic_id = p_clinic_id
      and actor_user_id = p_actor_user_id
    returning * into v_limiter;
  end if;

  if v_limiter.blocked_until is not null
     and v_limiter.blocked_until > v_now then
    perform private.clinic_password_proof_audit(
      p_clinic_id,
      p_actor_user_id,
      p_operation_id,
      'password_proof.register',
      p_action,
      'denied',
      'rate_limited',
      p_request_id
    );
    return jsonb_build_object(
      'ok', false,
      'code', 'rate_limited',
      'retry_after_seconds', greatest(
        1,
        ceil(extract(epoch from (v_limiter.blocked_until - v_now)))::integer
      )
    );
  end if;

  if p_password_authenticated_at < v_now - interval '120 seconds'
     or p_password_authenticated_at > v_now + interval '30 seconds' then
    update private.clinic_password_proof_rate_limits
    set attempt_count = least(attempt_count + 1, 10000),
        blocked_until = case
          when attempt_count + 1 >= 5 then v_now + interval '15 minutes'
          else blocked_until
        end,
        updated_at = v_now
    where clinic_id = p_clinic_id
      and actor_user_id = p_actor_user_id
    returning * into v_limiter;
    perform private.clinic_password_proof_audit(
      p_clinic_id,
      p_actor_user_id,
      p_operation_id,
      'password_proof.register',
      p_action,
      'denied',
      'password_not_recent',
      p_request_id
    );
    return jsonb_build_object(
      'ok', false,
      'code', case
        when v_limiter.blocked_until > v_now then 'rate_limited'
        else 'password_not_recent'
      end
    );
  end if;

  if not exists (
    select 1
    from auth.sessions as session
    where session.id = p_main_session_id
      and session.user_id = p_actor_user_id
  ) or not exists (
    select 1
    from auth.sessions as session
    where session.id = p_secondary_session_id
      and session.user_id = p_actor_user_id
  ) then
    update private.clinic_password_proof_rate_limits
    set attempt_count = least(attempt_count + 1, 10000),
        blocked_until = case
          when attempt_count + 1 >= 5 then v_now + interval '15 minutes'
          else blocked_until
        end,
        updated_at = v_now
    where clinic_id = p_clinic_id
      and actor_user_id = p_actor_user_id
    returning * into v_limiter;
    perform private.clinic_password_proof_audit(
      p_clinic_id,
      p_actor_user_id,
      p_operation_id,
      'password_proof.register',
      p_action,
      'denied',
      'session_inactive',
      p_request_id
    );
    return jsonb_build_object(
      'ok', false,
      'code', case
        when v_limiter.blocked_until > v_now then 'rate_limited'
        else 'session_inactive'
      end
    );
  end if;

  v_main_hmac := private.clinic_password_session_hmac(p_main_session_id);
  v_secondary_hmac := private.clinic_password_session_hmac(
    p_secondary_session_id
  );
  if v_main_hmac is null or v_secondary_hmac is null then
    return jsonb_build_object('ok', false, 'code', 'proof_backend_unavailable');
  end if;

  select proof.*
  into v_existing
  from private.clinic_password_proofs as proof
  where proof.secondary_session_hmac = v_secondary_hmac
     or (
       proof.clinic_id = p_clinic_id
       and proof.operation_id = p_operation_id
     )
  order by
    case when proof.secondary_session_hmac = v_secondary_hmac then 0 else 1 end
  limit 1;

  if found then
    if v_existing.clinic_id = p_clinic_id
       and v_existing.actor_user_id = p_actor_user_id
       and v_existing.main_session_hmac = v_main_hmac
       and v_existing.secondary_session_hmac = v_secondary_hmac
       and v_existing.operation_id = p_operation_id
       and v_existing.action = p_action
       and v_existing.target_id = p_target_id
       and v_existing.used_at is null
       and v_existing.expires_at > v_now then
      update private.clinic_password_proof_rate_limits
      set attempt_count = greatest(attempt_count - 1, 0),
          blocked_until = null,
          updated_at = v_now
      where clinic_id = p_clinic_id
        and actor_user_id = p_actor_user_id;
      return jsonb_build_object(
        'ok', true,
        'status', 'already_registered',
        'proof_id', v_existing.id,
        'expires_at', v_existing.expires_at,
        'idempotent', true
      );
    end if;

    update private.clinic_password_proof_rate_limits
    set attempt_count = least(attempt_count + 1, 10000),
        blocked_until = case
          when attempt_count + 1 >= 5 then v_now + interval '15 minutes'
          else blocked_until
        end,
        updated_at = v_now
    where clinic_id = p_clinic_id
      and actor_user_id = p_actor_user_id
    returning * into v_limiter;
    perform private.clinic_password_proof_audit(
      p_clinic_id,
      p_actor_user_id,
      p_operation_id,
      'password_proof.register',
      p_action,
      'denied',
      'proof_reused',
      p_request_id
    );
    return jsonb_build_object(
      'ok', false,
      'code', case
        when v_limiter.blocked_until > v_now then 'rate_limited'
        else 'proof_reused'
      end
    );
  end if;

  v_expires_at := p_password_authenticated_at + interval '120 seconds';

  begin
    insert into private.clinic_password_proofs (
      id,
      clinic_id,
      actor_user_id,
      main_session_hmac,
      secondary_session_hmac,
      operation_id,
      action,
      target_id,
      password_authenticated_at,
      expires_at,
      registered_at,
      register_request_id
    )
    values (
      v_proof_id,
      p_clinic_id,
      p_actor_user_id,
      v_main_hmac,
      v_secondary_hmac,
      p_operation_id,
      p_action,
      p_target_id,
      p_password_authenticated_at,
      v_expires_at,
      v_now,
      p_request_id
    );
  exception
    when unique_violation then
      update private.clinic_password_proof_rate_limits
      set attempt_count = least(attempt_count + 1, 10000),
          blocked_until = case
            when attempt_count + 1 >= 5 then v_now + interval '15 minutes'
            else blocked_until
          end,
          updated_at = v_now
      where clinic_id = p_clinic_id
        and actor_user_id = p_actor_user_id;
      perform private.clinic_password_proof_audit(
        p_clinic_id,
        p_actor_user_id,
        p_operation_id,
        'password_proof.register',
        p_action,
        'denied',
        'proof_conflict',
        p_request_id
      );
      return jsonb_build_object('ok', false, 'code', 'proof_conflict');
  end;

  -- Uma prova valida nao consome a cota. Ela reduz gradualmente falhas antigas.
  update private.clinic_password_proof_rate_limits
  set attempt_count = greatest(attempt_count - 1, 0),
      blocked_until = null,
      updated_at = v_now
  where clinic_id = p_clinic_id
    and actor_user_id = p_actor_user_id;

  -- Em caso de sucesso, o evento de auditoria unico desta requisicao e escrito
  -- pelo consumo atomico abaixo. Falhas de registro continuam auditadas aqui.
  return jsonb_build_object(
    'ok', true,
    'status', 'registered',
    'proof_id', v_proof_id,
    'expires_at', v_expires_at,
    'idempotent', false
  );
end;
$function$;

comment on function public.clinic_register_password_proof(
  uuid,
  uuid,
  uuid,
  uuid,
  uuid,
  text,
  uuid,
  timestamptz,
  uuid
) is
  'Server-only: registra prova de senha one-time apos validacao dos dois JWTs pela Edge.';

revoke all on function public.clinic_register_password_proof(
  uuid,
  uuid,
  uuid,
  uuid,
  uuid,
  text,
  uuid,
  timestamptz,
  uuid
)
  from public, anon, authenticated, service_role;
grant execute on function public.clinic_register_password_proof(
  uuid,
  uuid,
  uuid,
  uuid,
  uuid,
  text,
  uuid,
  timestamptz,
  uuid
)
  to service_role;

-- Consome exatamente a prova ligada aos mesmos usuario, sessoes, operacao,
-- action e alvo. Qualquer retry exige nova senha; a mutacao de dominio deve ser
-- idempotente e, no cutover final, consumir a prova na mesma transacao da
-- alteracao/arquivamento/cancelamento.
create or replace function public.clinic_consume_password_proof(
  p_clinic_id uuid,
  p_actor_user_id uuid,
  p_main_session_id uuid,
  p_secondary_session_id uuid,
  p_operation_id uuid,
  p_action text,
  p_target_id uuid,
  p_request_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_now timestamptz := clock_timestamp();
  v_main_hmac bytea;
  v_secondary_hmac bytea;
  v_proof private.clinic_password_proofs%rowtype;
begin
  if p_clinic_id is null
     or p_actor_user_id is null
     or p_main_session_id is null
     or p_secondary_session_id is null
     or p_operation_id is null
     or p_target_id is null
     or p_request_id is null
     or p_action is null
     or char_length(p_action) not between 2 and 80
     or p_action !~ '^[a-z][a-z0-9_.:-]+$'
     or p_main_session_id = p_secondary_session_id then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;

  if not exists (
    select 1
    from public.clinic_members as member
    where member.clinic_id = p_clinic_id
      and member.user_id = p_actor_user_id
      and member.role = 'owner'
      and member.status = 'active'
  ) then
    return jsonb_build_object('ok', false, 'code', 'owner_required');
  end if;

  if not exists (
    select 1
    from auth.sessions as session
    where session.id = p_main_session_id
      and session.user_id = p_actor_user_id
  ) or not exists (
    select 1
    from auth.sessions as session
    where session.id = p_secondary_session_id
      and session.user_id = p_actor_user_id
  ) then
    perform private.clinic_password_proof_audit(
      p_clinic_id,
      p_actor_user_id,
      p_operation_id,
      'password_proof.consume',
      p_action,
      'denied',
      'session_inactive',
      p_request_id
    );
    return jsonb_build_object('ok', false, 'code', 'session_inactive');
  end if;

  v_main_hmac := private.clinic_password_session_hmac(p_main_session_id);
  v_secondary_hmac := private.clinic_password_session_hmac(
    p_secondary_session_id
  );

  select proof.*
  into v_proof
  from private.clinic_password_proofs as proof
  where proof.clinic_id = p_clinic_id
    and proof.operation_id = p_operation_id
  for update;

  if not found then
    perform private.clinic_password_proof_audit(
      p_clinic_id,
      p_actor_user_id,
      p_operation_id,
      'password_proof.consume',
      p_action,
      'denied',
      'proof_missing',
      p_request_id
    );
    return jsonb_build_object('ok', false, 'code', 'proof_missing');
  end if;

  if v_proof.actor_user_id <> p_actor_user_id
     or v_proof.main_session_hmac <> v_main_hmac
     or v_proof.secondary_session_hmac <> v_secondary_hmac
     or v_proof.action <> p_action
     or v_proof.target_id <> p_target_id then
    perform private.clinic_password_proof_audit(
      p_clinic_id,
      p_actor_user_id,
      v_proof.id,
      'password_proof.consume',
      p_action,
      'denied',
      'proof_scope_mismatch',
      p_request_id
    );
    return jsonb_build_object('ok', false, 'code', 'proof_scope_mismatch');
  end if;

  if v_proof.used_at is not null then
    perform private.clinic_password_proof_audit(
      p_clinic_id,
      p_actor_user_id,
      v_proof.id,
      'password_proof.consume',
      p_action,
      'denied',
      'proof_already_used',
      p_request_id
    );
    return jsonb_build_object('ok', false, 'code', 'proof_already_used');
  end if;

  if v_proof.expires_at <= v_now then
    perform private.clinic_password_proof_audit(
      p_clinic_id,
      p_actor_user_id,
      v_proof.id,
      'password_proof.consume',
      p_action,
      'denied',
      'proof_expired',
      p_request_id
    );
    return jsonb_build_object('ok', false, 'code', 'proof_expired');
  end if;

  update private.clinic_password_proofs
  set used_at = v_now,
      consume_request_id = p_request_id
  where id = v_proof.id;

  perform private.clinic_password_proof_audit(
    p_clinic_id,
    p_actor_user_id,
    v_proof.id,
    'password_proof.consume',
    p_action,
    'success',
    'consumed',
    p_request_id
  );

  return jsonb_build_object(
    'ok', true,
    'status', 'consumed',
    'proof_id', v_proof.id,
    'idempotent', false
  );
end;
$function$;

comment on function public.clinic_consume_password_proof(
  uuid,
  uuid,
  uuid,
  uuid,
  uuid,
  text,
  uuid,
  uuid
) is
  'Server-only: consome uma unica vez a prova vinculada a operacao/action/alvo.';

revoke all on function public.clinic_consume_password_proof(
  uuid,
  uuid,
  uuid,
  uuid,
  uuid,
  text,
  uuid,
  uuid
)
  from public, anon, authenticated, service_role;
grant execute on function public.clinic_consume_password_proof(
  uuid,
  uuid,
  uuid,
  uuid,
  uuid,
  text,
  uuid,
  uuid
)
  to service_role;

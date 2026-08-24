-- Limite atômico para endpoints públicos que geram documentos clínicos.
-- O endereço de rede nunca é persistido: as Edge Functions enviam apenas HMAC-SHA256.

create schema if not exists private;

create table if not exists private.public_form_rate_limits (
  scope text not null,
  origin_hash text not null,
  window_started_at timestamptz not null,
  request_count integer not null,
  updated_at timestamptz not null,
  primary key (scope, origin_hash),
  constraint public_form_rate_limits_scope_check
    check (scope ~ '^[a-z0-9][a-z0-9_-]{1,63}$'),
  constraint public_form_rate_limits_origin_hash_check
    check (origin_hash ~ '^[0-9a-f]{64}$'),
  constraint public_form_rate_limits_request_count_check
    check (request_count between 1 and 101)
);

create index if not exists public_form_rate_limits_updated_at_idx
  on private.public_form_rate_limits (updated_at);

alter table private.public_form_rate_limits enable row level security;

revoke all on table private.public_form_rate_limits
  from public, anon, authenticated, service_role;

create or replace function public.public_form_rate_limit_consume(
  p_scope text,
  p_origin_hash text,
  p_limit integer,
  p_window_seconds integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_count integer;
  v_started_at timestamptz;
  v_retry_after integer := 0;
begin
  if p_scope is null
    or p_scope !~ '^[a-z0-9][a-z0-9_-]{1,63}$'
    or p_origin_hash is null
    or p_origin_hash !~ '^[0-9a-f]{64}$'
    or p_limit is null
    or p_limit < 1
    or p_limit > 100
    or p_window_seconds is null
    or p_window_seconds < 60
    or p_window_seconds > 86400
  then
    raise exception using
      errcode = '22023',
      message = 'invalid public form rate limit parameters';
  end if;

  insert into private.public_form_rate_limits as current_limit (
    scope,
    origin_hash,
    window_started_at,
    request_count,
    updated_at
  )
  values (p_scope, p_origin_hash, v_now, 1, v_now)
  on conflict (scope, origin_hash) do update
  set
    request_count = case
      when current_limit.window_started_at <=
        v_now - pg_catalog.make_interval(secs => p_window_seconds)
        then 1
      else least(current_limit.request_count + 1, p_limit + 1)
    end,
    window_started_at = case
      when current_limit.window_started_at <=
        v_now - pg_catalog.make_interval(secs => p_window_seconds)
        then v_now
      else current_limit.window_started_at
    end,
    updated_at = v_now
  returning request_count, window_started_at
  into v_count, v_started_at;

  if v_count > p_limit then
    v_retry_after := greatest(
      1,
      pg_catalog.ceil(
        extract(epoch from (
          v_started_at + pg_catalog.make_interval(secs => p_window_seconds) -
          v_now
        ))
      )::integer
    );
  end if;

  -- TTL oportunista: um lote pequeno por chamada evita crescimento indefinido.
  -- SKIP LOCKED impede que a limpeza espere por contadores concorrentes.
  with expired as materialized (
    select stale.scope, stale.origin_hash
    from private.public_form_rate_limits as stale
    where stale.updated_at <
      v_now - pg_catalog.make_interval(hours => 24)
    order by stale.updated_at
    limit 25
    for update skip locked
  )
  delete from private.public_form_rate_limits as stale
  using expired
  where stale.scope = expired.scope
    and stale.origin_hash = expired.origin_hash;

  return pg_catalog.jsonb_build_object(
    'allowed', v_count <= p_limit,
    'remaining', greatest(p_limit - v_count, 0),
    'retry_after_seconds', v_retry_after
  );
end;
$$;

comment on table private.public_form_rate_limits is
  'Contadores de janela fixa para proteger documentos clínicos; entradas inativas expiram em 24 horas.';
comment on function public.public_form_rate_limit_consume(text, text, integer, integer) is
  'Consome atomicamente uma tentativa de formulário público; uso exclusivo das Edge Functions service_role.';

revoke all on function public.public_form_rate_limit_consume(
  text,
  text,
  integer,
  integer
) from public, anon, authenticated, service_role;

grant execute on function public.public_form_rate_limit_consume(
  text,
  text,
  integer,
  integer
) to service_role;

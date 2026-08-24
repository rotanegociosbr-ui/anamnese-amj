begin;

-- A fila de provaveis duplicidades e uma fila de decisao humana. Esta migration
-- nao une, apaga ou altera nenhuma entidade apontada pelos pares.

alter table public.clinic_duplicate_reviews
  add column if not exists version integer not null default 1;

do $migration$
begin
  if not exists (
    select 1
    from pg_catalog.pg_constraint
    where conrelid = 'public.clinic_duplicate_reviews'::pg_catalog.regclass
      and conname = 'clinic_duplicate_reviews_version_check'
  ) then
    alter table public.clinic_duplicate_reviews
      add constraint clinic_duplicate_reviews_version_check
      check (version >= 1);
  end if;
end
$migration$;

create or replace function private.financeiro_guard_duplicate_review()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if tg_op = 'DELETE' then
    raise exception 'duplicate_review_delete_forbidden' using errcode = '55000';
  end if;
  if pg_catalog.to_jsonb(new) - array[
       'status', 'reviewed_by', 'reviewed_at', 'review_reason', 'operation_id',
       'version'
     ] is distinct from pg_catalog.to_jsonb(old) - array[
       'status', 'reviewed_by', 'reviewed_at', 'review_reason', 'operation_id',
       'version'
     ] then
    raise exception 'duplicate_review_identity_immutable' using errcode = '55000';
  end if;
  if old.status <> 'pendente' then
    raise exception 'duplicate_review_already_resolved' using errcode = '55000';
  end if;
  if new.status not in (
    'confirmado_distinto', 'resolvido_existente', 'descartado'
  ) then
    raise exception 'duplicate_review_resolution_invalid' using errcode = '22023';
  end if;
  if new.version <> old.version + 1 then
    raise exception 'duplicate_review_version_invalid' using errcode = '40001';
  end if;
  return new;
end;
$function$;

revoke all on function private.financeiro_guard_duplicate_review()
  from public, anon, authenticated, service_role;

create or replace function public.financeiro_resolver_revisao_duplicidade(
  p_clinic_id uuid,
  p_actor_id uuid,
  p_review_id uuid,
  p_expected_version integer,
  p_resolution text,
  p_reason text,
  p_operation_id uuid,
  p_request_id uuid
)
returns table (
  review_id uuid,
  status text,
  version integer,
  reviewed_at timestamptz,
  idempotent boolean
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_review public.clinic_duplicate_reviews%rowtype;
  v_reason text := pg_catalog.btrim(p_reason);
begin
  if p_clinic_id is null or p_actor_id is null or p_review_id is null
     or p_operation_id is null or p_request_id is null
     or p_expected_version is null or p_expected_version < 1 then
    raise exception 'duplicate_review_invalid_arguments' using errcode = '22023';
  end if;
  if p_resolution not in (
    'confirmado_distinto', 'resolvido_existente', 'descartado'
  ) then
    raise exception 'duplicate_review_resolution_invalid' using errcode = '22023';
  end if;
  if pg_catalog.char_length(v_reason) < 10
     or pg_catalog.char_length(v_reason) > 500
     or v_reason ~ '[[:cntrl:]]' then
    raise exception 'duplicate_review_reason_invalid' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext(p_clinic_id::text),
    pg_catalog.hashtext(p_operation_id::text)
  );

  select review.*
    into v_review
  from public.clinic_duplicate_reviews as review
  where review.clinic_id = p_clinic_id
    and review.operation_id = p_operation_id;

  if found then
    if v_review.id is distinct from p_review_id
       or v_review.status is distinct from p_resolution
       or v_review.reviewed_by is distinct from p_actor_id
       or v_review.review_reason is distinct from v_reason then
      raise exception 'duplicate_review_operation_reused' using errcode = '22023';
    end if;
    return query select
      v_review.id, v_review.status, v_review.version, v_review.reviewed_at, true;
    return;
  end if;

  select review.*
    into v_review
  from public.clinic_duplicate_reviews as review
  where review.clinic_id = p_clinic_id
    and review.id = p_review_id
  for update;

  if not found then
    raise exception 'duplicate_review_not_found' using errcode = 'P0002';
  end if;
  if v_review.status <> 'pendente' then
    raise exception 'duplicate_review_already_resolved' using errcode = '55000';
  end if;
  if v_review.version <> p_expected_version then
    raise exception 'duplicate_review_version_conflict' using errcode = '40001';
  end if;

  update public.clinic_duplicate_reviews as review
  set status = p_resolution,
      reviewed_by = p_actor_id,
      reviewed_at = pg_catalog.now(),
      review_reason = v_reason,
      operation_id = p_operation_id,
      version = review.version + 1
  where review.id = p_review_id
    and review.clinic_id = p_clinic_id
  returning review.* into v_review;

  insert into public.clinic_audit_log (
    clinic_id, actor, entity, entity_id, action, details,
    actor_role, auth_method, outcome, request_id
  ) values (
    p_clinic_id, p_actor_id, 'duplicate_review', p_review_id, 'resolve',
    pg_catalog.jsonb_build_object(
      'target_kind', v_review.entity_kind,
      'status_code', v_review.status,
      'version', v_review.version,
      'idempotent', false
    ),
    'owner', 'supabase_auth', 'success', p_request_id
  );

  return query select
    v_review.id, v_review.status, v_review.version, v_review.reviewed_at, false;
end;
$function$;

revoke all on function public.financeiro_resolver_revisao_duplicidade(
  uuid, uuid, uuid, integer, text, text, uuid, uuid
) from public, anon, authenticated, service_role;
grant execute on function public.financeiro_resolver_revisao_duplicidade(
  uuid, uuid, uuid, integer, text, text, uuid, uuid
) to service_role;

comment on column public.clinic_duplicate_reviews.version is
  'Versao otimista da decisao humana; incrementa uma vez ao encerrar a pendencia.';
comment on function public.financeiro_resolver_revisao_duplicidade(
  uuid, uuid, uuid, integer, text, text, uuid, uuid
) is
  'Encerra uma suspeita de duplicidade sem merge/delete; chamada apenas pelo Edge owner+AAL2 apos prova one-time.';

commit;

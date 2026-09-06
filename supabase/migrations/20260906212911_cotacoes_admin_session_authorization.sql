-- Current owner login + MFA authorizes SKU review without a second password.
-- Old audit rows keep their real password-proof provenance; no fake proofs.
begin;
alter table public.cotacao_sku_revisoes
  alter column proof_id drop not null,
  add column authorization_mode text not null default 'password_proof',
  add column main_session_hmac bytea,
  add constraint cotacao_sku_revisoes_authorization_check check (
    (authorization_mode='password_proof' and proof_id is not null and main_session_hmac is null)
    or (authorization_mode='admin_session' and proof_id is null and octet_length(main_session_hmac)=32 and main_session_hmac is not null)
  );

create or replace function private.cotacoes_revisar_sku_exato_admin_impl(
  p_clinic_id uuid,
  p_item_id uuid,
  p_decision text,
  p_reason text,
  p_expected_version integer,
  p_operation_id uuid,
  p_actor_id uuid,
  p_main_session_id uuid,
  p_request_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_item public.cotacao_itens%rowtype;
  v_existing public.cotacao_sku_revisoes%rowtype;
  v_reason text := pg_catalog.btrim(p_reason);
  v_new_status text;
  v_session_hmac bytea;
  v_new_version integer;
  v_identity_key text;
begin
  if p_clinic_id is null
     or p_item_id is null
     or p_operation_id is null
     or p_actor_id is null
     or p_main_session_id is null
     or p_request_id is null
     or p_expected_version is null
     or p_expected_version < 1
     or p_decision is null
     or p_decision not in ('aprovar', 'rejeitar') then
    return pg_catalog.jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;

  if v_reason is null
     or pg_catalog.char_length(v_reason) not between 3 and 500
     or v_reason ~ '[[:cntrl:]]' then
    return pg_catalog.jsonb_build_object('ok', false, 'code', 'invalid_reason');
  end if;

  if not exists (
    select 1
    from public.clinic_members member
    where member.clinic_id = p_clinic_id
      and member.user_id = p_actor_id
      and member.role = 'owner'
      and member.status = 'active'
  ) then
    return pg_catalog.jsonb_build_object('ok', false, 'code', 'owner_required');
  end if;

  -- The Edge validates the current Bearer. The service-only RPC additionally
  -- requires the exact live AAL2 session and owner membership before retries.
  if not exists (
    select 1 from auth.sessions session
    where session.id = p_main_session_id and session.user_id = p_actor_id
      and session.aal = 'aal2'
      and (session.not_after is null or session.not_after > clock_timestamp())
  ) then
    return pg_catalog.jsonb_build_object('ok', false, 'code', 'admin_session_invalid');
  end if;
  v_session_hmac := private.clinic_password_session_hmac(p_main_session_id);

  v_new_status := case p_decision
    when 'aprovar' then 'aprovado_exato'
    else 'rejeitado'
  end;

  -- Idempotencia antes e depois do lock cobre retry normal e concorrente.
  select review.*
  into v_existing
  from public.cotacao_sku_revisoes review
  where review.clinic_id = p_clinic_id
    and review.operation_id = p_operation_id;

  if found then
    if v_existing.item_id = p_item_id
       and v_existing.decision = p_decision
       and v_existing.reason = v_reason
       and v_existing.reviewed_by = p_actor_id then
      return pg_catalog.jsonb_build_object(
        'ok', true,
        'idempotent', true,
        'item_id', v_existing.item_id,
        'review_status', v_existing.new_status,
        'review_version', v_existing.new_version,
        'reviewed_at', v_existing.reviewed_at,
        'cost_changed', false,
        'stock_changed', false,
        'sale_price_changed', false,
        'product_linked', false
      );
    end if;
    return pg_catalog.jsonb_build_object('ok', false, 'code', 'operation_conflict');
  end if;



  select item.*
  into v_item
  from public.cotacao_itens item
  where item.clinic_id = p_clinic_id
    and item.id = p_item_id
  for update;

  if not found then
    return pg_catalog.jsonb_build_object('ok', false, 'code', 'item_not_found');
  end if;

  select review.*
  into v_existing
  from public.cotacao_sku_revisoes review
  where review.clinic_id = p_clinic_id
    and review.operation_id = p_operation_id;

  if found then
    if v_existing.item_id = p_item_id
       and v_existing.decision = p_decision
       and v_existing.reason = v_reason
       and v_existing.reviewed_by = p_actor_id then
      return pg_catalog.jsonb_build_object(
        'ok', true,
        'idempotent', true,
        'item_id', v_existing.item_id,
        'review_status', v_existing.new_status,
        'review_version', v_existing.new_version,
        'reviewed_at', v_existing.reviewed_at,
        'cost_changed', false,
        'stock_changed', false,
        'sale_price_changed', false,
        'product_linked', false
      );
    end if;
    return pg_catalog.jsonb_build_object('ok', false, 'code', 'operation_conflict');
  end if;

  if v_item.review_version <> p_expected_version then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'code', 'version_conflict',
      'current_version', v_item.review_version,
      'current_status', v_item.review_status
    );
  end if;

  if v_item.review_status = v_new_status then
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'idempotent', true,
      'no_change', true,
      'item_id', v_item.id,
      'review_status', v_item.review_status,
      'review_version', v_item.review_version,
      'reviewed_at', v_item.reviewed_at,
      'cost_changed', false,
      'stock_changed', false,
      'sale_price_changed', false,
      'product_linked', false
    );
  end if;

  if p_decision = 'aprovar' then
    if v_item.review_status = 'conflito' then
      return pg_catalog.jsonb_build_object('ok', false, 'code', 'item_has_conflict');
    end if;

    if not v_item.exact_match_eligible
       or v_item.exact_sku_key is null
       or v_item.brand is null
       or pg_catalog.btrim(v_item.brand) = ''
       or pg_catalog.btrim(v_item.item_name) = ''
       or v_item.composition is null
       or pg_catalog.btrim(v_item.composition) = ''
       or v_item.concentration is null
       or pg_catalog.btrim(v_item.concentration) = ''
       or v_item.presentation is null
       or pg_catalog.btrim(v_item.presentation) = ''
       or v_item.package_quantity is null
       or v_item.package_quantity <= 0
       or v_item.package_unit is null
       or pg_catalog.btrim(v_item.package_unit) = '' then
      return pg_catalog.jsonb_build_object('ok', false, 'code', 'exact_identity_incomplete');
    end if;

    v_identity_key := private.cotacoes_sha256(
      private.cotacoes_normalizar_identidade(v_item.brand) || '|'
      || private.cotacoes_normalizar_identidade(v_item.item_name) || '|'
      || private.cotacoes_normalizar_identidade(v_item.composition) || '|'
      || private.cotacoes_normalizar_identidade(v_item.concentration) || '|'
      || private.cotacoes_normalizar_identidade(v_item.presentation) || '|'
      || private.cotacoes_normalizar_identidade(
        v_item.package_quantity::numeric(14,4)::text
      ) || '|'
      || private.cotacoes_normalizar_identidade(v_item.package_unit)
    );
    if v_identity_key <> v_item.exact_sku_key then
      return pg_catalog.jsonb_build_object('ok', false, 'code', 'exact_identity_invalid');
    end if;

    if not exists (
      select 1
      from public.cotacao_precos evidence
      where evidence.clinic_id = p_clinic_id
        and evidence.item_id = p_item_id
    ) or exists (
      select 1
      from public.cotacao_precos evidence
      where evidence.clinic_id = p_clinic_id
        and evidence.item_id = p_item_id
        and evidence.extraction_status <> 'verificado_fonte'
    ) then
      return pg_catalog.jsonb_build_object('ok', false, 'code', 'evidence_not_verified');
    end if;

    if exists (
      select 1
      from public.cotacao_precos left_evidence
      join public.cotacao_precos right_evidence
        on right_evidence.clinic_id = left_evidence.clinic_id
        and right_evidence.source_id = left_evidence.source_id
        and right_evidence.item_id = left_evidence.item_id
        and right_evidence.commercial_condition = left_evidence.commercial_condition
        and right_evidence.quote_date = left_evidence.quote_date
        and right_evidence.id <> left_evidence.id
        and right_evidence.price is distinct from left_evidence.price
      where left_evidence.clinic_id = p_clinic_id
        and left_evidence.item_id = p_item_id
        and left_evidence.extraction_status = 'verificado_fonte'
        and right_evidence.extraction_status = 'verificado_fonte'
    ) then
      return pg_catalog.jsonb_build_object('ok', false, 'code', 'evidence_price_conflict');
    end if;
  end if;

  v_new_version := v_item.review_version + 1;

  update public.cotacao_itens
  set review_status = v_new_status,
      review_reason = v_reason,
      reviewed_by = p_actor_id,
      reviewed_at = clock_timestamp(),
      review_operation_id = p_operation_id,
      review_version = v_new_version
  where clinic_id = p_clinic_id
    and id = p_item_id
    and review_version = p_expected_version;

  if not found then
    return pg_catalog.jsonb_build_object('ok', false, 'code', 'version_conflict');
  end if;

  insert into public.cotacao_sku_revisoes (
    clinic_id,
    item_id,
    operation_id,
    proof_id,
    authorization_mode,
    main_session_hmac,
    decision,
    previous_status,
    new_status,
    reason,
    previous_version,
    new_version,
    identity_snapshot,
    reviewed_by,
    reviewed_at,
    request_id
  ) values (
    p_clinic_id,
    p_item_id,
    p_operation_id,
    null,
    'admin_session',
    v_session_hmac,
    p_decision,
    v_item.review_status,
    v_new_status,
    v_reason,
    v_item.review_version,
    v_new_version,
    pg_catalog.jsonb_build_object(
      'source_id', v_item.source_id,
      'source_code', v_item.source_code,
      'brand', v_item.brand,
      'item_name', v_item.item_name,
      'composition', v_item.composition,
      'concentration', v_item.concentration,
      'presentation', v_item.presentation,
      'package_quantity', v_item.package_quantity,
      'package_unit', v_item.package_unit,
      'exact_sku_key', v_item.exact_sku_key
    ),
    p_actor_id,
    clock_timestamp(),
    p_request_id
  );

  insert into public.financeiro_auditoria (
    clinic_id,
    actor_id,
    entity,
    entity_id,
    action,
    details,
    request_id
  ) values (
    p_clinic_id,
    p_actor_id,
    'cotacao_item',
    p_item_id,
    case p_decision
      when 'aprovar' then 'sku_exato_aprovado'
      else 'sku_rejeitado'
    end,
    pg_catalog.jsonb_build_object(
      'source', 'cotacoes_review',
      'mode', 'admin_session_exact_identity',
      'operation', case p_decision
        when 'aprovar' then 'approve_exact_sku'
        else 'reject_exact_sku'
      end,
      'target_kind', 'quote_sku',
      'idempotent', false,
      'version', v_new_version,
      'previous_status', v_item.review_status,
      'new_status', v_new_status,
      'reason_code', case p_decision
        when 'aprovar' then 'manual_approval'
        else 'manual_rejection'
      end
    ),
    p_request_id
  );

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'idempotent', false,
    'item_id', p_item_id,
    'review_status', v_new_status,
    'review_version', v_new_version,
    'reviewed_at', clock_timestamp(),
    'cost_changed', false,
    'stock_changed', false,
    'sale_price_changed', false,
    'product_linked', false
  );
end;
$$;

create or replace function public.cotacoes_revisar_sku_exato_admin_session(
  p_clinic_id uuid,
  p_item_id uuid,
  p_decision text,
  p_reason text,
  p_expected_version integer,
  p_operation_id uuid,
  p_actor_id uuid,
  p_main_session_id uuid,
  p_request_id uuid
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.cotacoes_revisar_sku_exato_admin_impl(
    p_clinic_id,
    p_item_id,
    p_decision,
    p_reason,
    p_expected_version,
    p_operation_id,
    p_actor_id,
    p_main_session_id,
    p_request_id
  );
$$;

revoke all on function private.cotacoes_revisar_sku_exato_admin_impl(uuid,uuid,text,text,integer,uuid,uuid,uuid,uuid) from public,anon,authenticated,service_role;
revoke all on function public.cotacoes_revisar_sku_exato_admin_session(uuid,uuid,text,text,integer,uuid,uuid,uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function private.cotacoes_revisar_sku_exato_admin_impl(uuid,uuid,text,text,integer,uuid,uuid,uuid,uuid) to service_role;
grant execute on function public.cotacoes_revisar_sku_exato_admin_session(uuid,uuid,text,text,integer,uuid,uuid,uuid,uuid) to service_role;
comment on function public.cotacoes_revisar_sku_exato_admin_session(uuid,uuid,text,text,integer,uuid,uuid,uuid,uuid) is 'Server-only owner review: active AAL2 session, scoped operation, version and explicit admin_session audit.';
commit;

-- Revisao humana e estatisticas conservadoras de cotacoes.
--
-- Somente itens cuja identidade exata foi aprovada por um proprietario com
-- AAL2 + prova de senha one-time entram nos calculos. A revisao nunca cria ou
-- vincula produto e nunca altera custo real, preco de venda, estoque ou frete.

begin;

alter table public.cotacao_itens
  add column review_version integer not null default 1
    check (review_version > 0),
  add column reviewed_by uuid references auth.users(id) on delete restrict,
  add column reviewed_at timestamptz,
  add column review_operation_id uuid,
  add constraint cotacao_itens_review_metadata_check check (
    review_status not in ('aprovado_exato', 'rejeitado')
    or (
      reviewed_by is not null
      and reviewed_at is not null
      and review_operation_id is not null
    )
  );

create table public.cotacao_sku_revisoes (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete restrict,
  item_id uuid not null,
  operation_id uuid not null,
  proof_id uuid not null,
  decision text not null check (decision in ('aprovar', 'rejeitar')),
  previous_status text not null check (
    previous_status in ('pendente_revisao', 'aprovado_exato', 'conflito', 'rejeitado')
  ),
  new_status text not null check (new_status in ('aprovado_exato', 'rejeitado')),
  reason text not null check (
    pg_catalog.char_length(pg_catalog.btrim(reason)) between 3 and 500
    and reason !~ '[[:cntrl:]]'
  ),
  previous_version integer not null check (previous_version > 0),
  new_version integer not null check (new_version = previous_version + 1),
  identity_snapshot jsonb not null check (
    pg_catalog.jsonb_typeof(identity_snapshot) = 'object'
    and pg_catalog.pg_column_size(identity_snapshot) <= 16384
  ),
  reviewed_by uuid not null references auth.users(id) on delete restrict,
  reviewed_at timestamptz not null default clock_timestamp(),
  request_id uuid not null,
  constraint cotacao_sku_revisoes_item_fk
    foreign key (clinic_id, item_id)
    references public.cotacao_itens (clinic_id, id) on delete restrict,
  constraint cotacao_sku_revisoes_operation_unique unique (clinic_id, operation_id),
  constraint cotacao_sku_revisoes_proof_unique unique (proof_id)
);

create index cotacao_sku_revisoes_item_time_idx
  on public.cotacao_sku_revisoes (clinic_id, item_id, reviewed_at desc);
create index cotacao_sku_revisoes_reviewed_by_idx
  on public.cotacao_sku_revisoes (reviewed_by, reviewed_at desc);
create index cotacao_itens_reviewed_by_idx
  on public.cotacao_itens (reviewed_by)
  where reviewed_by is not null;

alter table public.cotacao_sku_revisoes enable row level security;
revoke all on public.cotacao_sku_revisoes
  from public, anon, authenticated, service_role;
grant select on public.cotacao_sku_revisoes to service_role;

create or replace function private.cotacoes_guard_item_identity()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_review_changed boolean;
begin
  if row(
    new.clinic_id,
    new.source_id,
    new.source_code,
    new.brand,
    new.item_name,
    new.composition,
    new.concentration,
    new.presentation,
    new.package_quantity,
    new.package_unit,
    new.canonical_item_key,
    new.exact_sku_key,
    new.exact_match_eligible,
    new.first_seen_at
  ) is distinct from row(
    old.clinic_id,
    old.source_id,
    old.source_code,
    old.brand,
    old.item_name,
    old.composition,
    old.concentration,
    old.presentation,
    old.package_quantity,
    old.package_unit,
    old.canonical_item_key,
    old.exact_sku_key,
    old.exact_match_eligible,
    old.first_seen_at
  ) then
    raise exception 'cotacao_item_identity_immutable' using errcode = '55000';
  end if;

  v_review_changed := row(
    new.review_status,
    new.review_reason,
    new.reviewed_by,
    new.reviewed_at,
    new.review_operation_id
  ) is distinct from row(
    old.review_status,
    old.review_reason,
    old.reviewed_by,
    old.reviewed_at,
    old.review_operation_id
  );

  if v_review_changed and new.review_version = old.review_version then
    new.review_version := old.review_version + 1;
  elsif v_review_changed and new.review_version <> old.review_version + 1 then
    raise exception 'cotacao_review_version_invalid' using errcode = '40001';
  elsif not v_review_changed and new.review_version <> old.review_version then
    raise exception 'cotacao_review_version_without_change' using errcode = '40001';
  end if;

  return new;
end;
$$;

revoke all on function private.cotacoes_guard_item_identity()
  from public, anon, authenticated, service_role;

create trigger cotacao_itens_identity_guard
before update on public.cotacao_itens
for each row execute function private.cotacoes_guard_item_identity();

create or replace function private.cotacoes_guard_source_identity()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if row(
    new.clinic_id,
    new.source_name,
    new.supplier_name,
    new.source_type,
    new.file_name,
    new.file_sha256,
    new.source_date,
    new.revision,
    new.page_count,
    new.project_relative_path,
    new.created_at
  ) is distinct from row(
    old.clinic_id,
    old.source_name,
    old.supplier_name,
    old.source_type,
    old.file_name,
    old.file_sha256,
    old.source_date,
    old.revision,
    old.page_count,
    old.project_relative_path,
    old.created_at
  ) then
    raise exception 'cotacao_source_identity_immutable' using errcode = '55000';
  end if;
  return new;
end;
$$;

revoke all on function private.cotacoes_guard_source_identity()
  from public, anon, authenticated, service_role;

create trigger cotacao_fontes_identity_guard
before update on public.cotacao_fontes
for each row execute function private.cotacoes_guard_source_identity();

create or replace function private.cotacoes_guard_evidence_identity()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if pg_catalog.to_jsonb(new) - 'extraction_status'
       is distinct from pg_catalog.to_jsonb(old) - 'extraction_status' then
    raise exception 'cotacao_evidence_identity_immutable' using errcode = '55000';
  end if;
  return new;
end;
$$;

revoke all on function private.cotacoes_guard_evidence_identity()
  from public, anon, authenticated, service_role;

create trigger cotacao_precos_identity_guard
before update on public.cotacao_precos
for each row execute function private.cotacoes_guard_evidence_identity();

create or replace function private.cotacoes_block_review_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'cotacao_sku_review_history_immutable' using errcode = '55000';
end;
$$;

revoke all on function private.cotacoes_block_review_mutation()
  from public, anon, authenticated, service_role;

create trigger cotacao_sku_revisoes_immutable
before update or delete on public.cotacao_sku_revisoes
for each row execute function private.cotacoes_block_review_mutation();

-- O mesmo contrato de colunas da view anterior e preservado. O predicado agora
-- exige aprovacao humana explicita e evidencias integralmente verificadas.
create or replace view public.cotacoes_referencia_estatisticas
with (security_invoker = true)
as
with valid_quotes as (
  select
    item.clinic_id,
    item.exact_sku_key,
    item.brand,
    item.item_name,
    item.composition,
    item.concentration,
    item.presentation,
    item.package_quantity,
    item.package_unit,
    consolidated.source_id,
    consolidated.commercial_condition,
    consolidated.quote_date,
    consolidated.reference_price
  from public.cotacao_itens item
  join public.cotacoes_referencia_consolidadas consolidated
    on consolidated.clinic_id = item.clinic_id
    and consolidated.item_id = item.id
  where item.exact_match_eligible
    and item.exact_sku_key is not null
    and item.review_status = 'aprovado_exato'
    and not consolidated.has_conflict
    and not exists (
      select 1
      from public.cotacao_precos evidence
      where evidence.clinic_id = consolidated.clinic_id
        and evidence.source_id = consolidated.source_id
        and evidence.item_id = consolidated.item_id
        and evidence.commercial_condition = consolidated.commercial_condition
        and evidence.quote_date = consolidated.quote_date
        and evidence.extraction_status <> 'verificado_fonte'
    )
), latest_values as (
  select distinct on (clinic_id, exact_sku_key, commercial_condition)
    clinic_id,
    exact_sku_key,
    commercial_condition,
    reference_price as latest_price,
    quote_date as latest_date
  from valid_quotes
  order by
    clinic_id,
    exact_sku_key,
    commercial_condition,
    quote_date desc,
    source_id desc
), aggregate_values as (
  select
    quote.clinic_id,
    quote.exact_sku_key,
    pg_catalog.min(quote.brand) as brand,
    pg_catalog.min(quote.item_name) as item_name,
    pg_catalog.min(quote.composition) as composition,
    pg_catalog.min(quote.concentration) as concentration,
    pg_catalog.min(quote.presentation) as presentation,
    pg_catalog.min(quote.package_quantity) as package_quantity,
    pg_catalog.min(quote.package_unit) as package_unit,
    quote.commercial_condition,
    pg_catalog.count(*)::integer as quote_count,
    pg_catalog.count(distinct quote.source_id)::integer as source_count,
    pg_catalog.min(quote.reference_price) as minimum_price,
    pg_catalog.max(quote.reference_price) as maximum_price,
    pg_catalog.round(pg_catalog.avg(quote.reference_price), 2) as average_price,
    pg_catalog.percentile_cont(0.5) within group (
      order by quote.reference_price
    )::numeric(14,2) as median_price,
    pg_catalog.min(quote.quote_date) as period_start,
    pg_catalog.max(quote.quote_date) as period_end
  from valid_quotes quote
  group by quote.clinic_id, quote.exact_sku_key, quote.commercial_condition
)
select
  aggregate_values.*,
  latest_values.latest_price,
  latest_values.latest_date,
  link.product_id,
  actual.unit_cost as authoritative_unit_cost,
  actual.cost_date as authoritative_cost_date,
  actual.package_unit as authoritative_cost_package_unit,
  pg_catalog.round(
    aggregate_values.average_price / aggregate_values.package_quantity,
    4
  ) as reference_average_unit_price,
  (
    actual.unit_cost is not null
    and private.cotacoes_normalizar_identidade(actual.package_unit)
      = private.cotacoes_normalizar_identidade(aggregate_values.package_unit)
  ) as unit_comparison_compatible,
  case
    when link.product_id is null then 'sku_nao_vinculado'
    when actual.unit_cost is null then 'sem_custo_real_corrente'
    when private.cotacoes_normalizar_identidade(actual.package_unit)
           <> private.cotacoes_normalizar_identidade(aggregate_values.package_unit)
      then 'unidade_incompativel'
    else 'comparavel'
  end as comparison_status,
  case
    when actual.unit_cost is not null
      and private.cotacoes_normalizar_identidade(actual.package_unit)
        = private.cotacoes_normalizar_identidade(aggregate_values.package_unit)
    then pg_catalog.round(
      (aggregate_values.average_price / aggregate_values.package_quantity)
        - actual.unit_cost,
      4
    )
  end as average_minus_authoritative_cost,
  case
    when actual.unit_cost is not null
      and actual.unit_cost <> 0
      and private.cotacoes_normalizar_identidade(actual.package_unit)
        = private.cotacoes_normalizar_identidade(aggregate_values.package_unit)
    then pg_catalog.round(
      (
        (
          (aggregate_values.average_price / aggregate_values.package_quantity)
            - actual.unit_cost
        ) / actual.unit_cost
      ) * 100,
      2
    )
  end as difference_percent
from aggregate_values
join latest_values
  using (clinic_id, exact_sku_key, commercial_condition)
left join public.cotacao_sku_vinculos link
  on link.clinic_id = aggregate_values.clinic_id
  and link.exact_sku_key = aggregate_values.exact_sku_key
left join public.financeiro_produto_custos actual
  on actual.clinic_id = link.clinic_id
  and actual.product_id = link.product_id
  and actual.is_current
  and not exists (
    select 1
    from public.financeiro_produto_custo_cancelamentos cancelled
    where cancelled.clinic_id = actual.clinic_id
      and cancelled.cost_id = actual.id
  );

-- As linhas continuam todas pesquisaveis. Os campos de revisao sao anexados ao
-- fim para preservar o contrato anterior da view e permitir concorrencia otimista.
create or replace view public.cotacoes_painel_evidencias
with (security_invoker = true)
as
select
  quote.id as evidence_id,
  quote.clinic_id,
  quote.source_id,
  source.source_name,
  source.supplier_name,
  source.file_name,
  source.file_sha256,
  source.source_date,
  source.revision,
  quote.item_id,
  item.source_code,
  item.brand,
  item.item_name,
  item.composition,
  item.concentration,
  item.presentation,
  item.package_quantity,
  item.package_unit,
  item.exact_sku_key,
  item.exact_match_eligible,
  item.review_status,
  item.review_reason,
  quote.page_number,
  quote.line_reference,
  quote.quote_date,
  quote.commercial_condition,
  quote.price,
  quote.currency,
  quote.extraction_status,
  pg_catalog.count(*) over (
    partition by
      quote.clinic_id,
      quote.source_id,
      quote.item_id,
      quote.commercial_condition,
      quote.quote_date,
      quote.price
  )::integer as same_price_evidence_count,
  pg_catalog.row_number() over (
    partition by
      quote.clinic_id,
      quote.source_id,
      quote.item_id,
      quote.commercial_condition,
      quote.quote_date,
      quote.price
    order by quote.page_number nulls last, quote.line_reference, quote.id
  )::integer as same_price_evidence_ordinal,
  exists (
    select 1
    from public.cotacao_precos peer
    where peer.clinic_id = quote.clinic_id
      and peer.source_id = quote.source_id
      and peer.item_id = quote.item_id
      and peer.commercial_condition = quote.commercial_condition
      and peer.quote_date = quote.quote_date
      and peer.price is distinct from quote.price
      and peer.extraction_status <> 'rejeitado'
  ) as has_source_conflict,
  (
    item.exact_match_eligible
    and item.review_status = 'aprovado_exato'
    and quote.extraction_status = 'verificado_fonte'
    and not exists (
      select 1
      from public.cotacao_precos peer
      where peer.clinic_id = quote.clinic_id
        and peer.source_id = quote.source_id
        and peer.item_id = quote.item_id
        and peer.commercial_condition = quote.commercial_condition
        and peer.quote_date = quote.quote_date
        and peer.extraction_status <> 'verificado_fonte'
    )
    and not exists (
      select 1
      from public.cotacao_precos peer
      where peer.clinic_id = quote.clinic_id
        and peer.source_id = quote.source_id
        and peer.item_id = quote.item_id
        and peer.commercial_condition = quote.commercial_condition
        and peer.quote_date = quote.quote_date
        and peer.price is distinct from quote.price
        and peer.extraction_status <> 'rejeitado'
    )
    and pg_catalog.row_number() over (
      partition by
        quote.clinic_id,
        quote.source_id,
        quote.item_id,
        quote.commercial_condition,
        quote.quote_date,
        quote.price
      order by quote.page_number nulls last, quote.line_reference, quote.id
    ) = 1
  ) as counts_in_statistics,
  item.review_version,
  item.reviewed_at,
  item.review_operation_id
from public.cotacao_precos quote
join public.cotacao_fontes source
  on source.clinic_id = quote.clinic_id
  and source.id = quote.source_id
join public.cotacao_itens item
  on item.clinic_id = quote.clinic_id
  and item.id = quote.item_id;

revoke all on public.cotacoes_referencia_estatisticas
  from public, anon, authenticated, service_role;
revoke all on public.cotacoes_painel_evidencias
  from public, anon, authenticated, service_role;
grant select on public.cotacoes_referencia_estatisticas to service_role;
grant select on public.cotacoes_painel_evidencias to service_role;

create or replace function private.cotacoes_revisar_sku_exato_impl(
  p_clinic_id uuid,
  p_item_id uuid,
  p_decision text,
  p_reason text,
  p_expected_version integer,
  p_operation_id uuid,
  p_actor_id uuid,
  p_proof_id uuid,
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
  v_proof_action text;
  v_new_version integer;
  v_identity_key text;
begin
  if p_clinic_id is null
     or p_item_id is null
     or p_operation_id is null
     or p_actor_id is null
     or p_proof_id is null
     or p_request_id is null
     or p_expected_version is null
     or p_expected_version < 1
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

  v_new_status := case p_decision
    when 'aprovar' then 'aprovado_exato'
    else 'rejeitado'
  end;
  v_proof_action := case p_decision
    when 'aprovar' then 'cotacoes.aprovar_sku_exato'
    else 'cotacoes.rejeitar_sku_exato'
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

  if not exists (
    select 1
    from private.clinic_password_proofs proof
    where proof.id = p_proof_id
      and proof.clinic_id = p_clinic_id
      and proof.actor_user_id = p_actor_id
      and proof.operation_id = p_operation_id
      and proof.action = v_proof_action
      and proof.target_id = p_item_id
      and proof.used_at is not null
      and proof.consume_request_id = p_request_id
  ) then
    return pg_catalog.jsonb_build_object('ok', false, 'code', 'proof_invalid');
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
    p_proof_id,
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
      'mode', 'manual_exact_identity',
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

comment on function private.cotacoes_revisar_sku_exato_impl(
  uuid,
  uuid,
  text,
  text,
  integer,
  uuid,
  uuid,
  uuid,
  uuid
) is
  'Server-only: revisa identidade exata com owner, AAL2, prova one-time, versao e auditoria.';

revoke all on function private.cotacoes_revisar_sku_exato_impl(
  uuid,
  uuid,
  text,
  text,
  integer,
  uuid,
  uuid,
  uuid,
  uuid
)
  from public, anon, authenticated, service_role;
grant execute on function private.cotacoes_revisar_sku_exato_impl(
  uuid,
  uuid,
  text,
  text,
  integer,
  uuid,
  uuid,
  uuid,
  uuid
)
  to service_role;

create or replace function public.cotacoes_revisar_sku_exato(
  p_clinic_id uuid,
  p_item_id uuid,
  p_decision text,
  p_reason text,
  p_expected_version integer,
  p_operation_id uuid,
  p_actor_id uuid,
  p_proof_id uuid,
  p_request_id uuid
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.cotacoes_revisar_sku_exato_impl(
    p_clinic_id,
    p_item_id,
    p_decision,
    p_reason,
    p_expected_version,
    p_operation_id,
    p_actor_id,
    p_proof_id,
    p_request_id
  );
$$;

comment on function public.cotacoes_revisar_sku_exato(
  uuid,
  uuid,
  text,
  text,
  integer,
  uuid,
  uuid,
  uuid,
  uuid
) is
  'RPC service-role que delega a revisao atomica privada; nunca altera custos ou estoque.';

revoke all on function public.cotacoes_revisar_sku_exato(
  uuid,
  uuid,
  text,
  text,
  integer,
  uuid,
  uuid,
  uuid,
  uuid
)
  from public, anon, authenticated, service_role;
grant execute on function public.cotacoes_revisar_sku_exato(
  uuid,
  uuid,
  text,
  text,
  integer,
  uuid,
  uuid,
  uuid,
  uuid
)
  to service_role;

comment on table public.cotacao_sku_revisoes is
  'Historico append-only das decisoes humanas; nao vincula produto e nao altera custos.';
comment on view public.cotacoes_referencia_estatisticas is
  'Estatisticas somente para identidade exata aprovada e evidencias verificadas, sem conflito.';
comment on view public.cotacoes_painel_evidencias is
  'Cada linha pesquisavel; counts_in_statistics exige aprovacao exata e evidencia verificada.';

commit;

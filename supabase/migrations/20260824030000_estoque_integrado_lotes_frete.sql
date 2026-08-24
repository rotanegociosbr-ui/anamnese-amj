-- Estoque integrado, lotes e frete vinculado a compra.
-- O saldo e sempre derivado do livro append-only de movimentos.

begin;

-- ---------------------------------------------------------------------------
-- Compra: subtotal de itens, frete e custo efetivo por item
-- ---------------------------------------------------------------------------

alter table public.financeiro_compras
  add column if not exists items_subtotal numeric(14,2),
  add column if not exists freight_amount numeric(14,2) not null default 0,
  add column if not exists dedup_fingerprint text,
  add column if not exists dedup_enforced boolean not null default true,
  add column if not exists duplicate_of_purchase_id uuid,
  add column if not exists duplicate_reason text,
  add column if not exists duplicate_confirmed_by uuid,
  add column if not exists duplicate_confirmed_at timestamptz,
  add column if not exists duplicate_operation_id uuid;

update public.financeiro_compras
set items_subtotal = total_amount
where items_subtotal is null;

alter table public.financeiro_compras
  alter column items_subtotal set not null;

do $migration$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.financeiro_compras'::pg_catalog.regclass
      and conname = 'financeiro_compras_items_subtotal_check'
  ) then
    alter table public.financeiro_compras
      add constraint financeiro_compras_items_subtotal_check
      check (items_subtotal > 0 and items_subtotal <= 999999999999.99);
  end if;
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.financeiro_compras'::pg_catalog.regclass
      and conname = 'financeiro_compras_freight_amount_check'
  ) then
    alter table public.financeiro_compras
      add constraint financeiro_compras_freight_amount_check
      check (freight_amount >= 0 and freight_amount <= 999999999999.99);
  end if;
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.financeiro_compras'::pg_catalog.regclass
      and conname = 'financeiro_compras_total_with_freight_check'
  ) then
    alter table public.financeiro_compras
      add constraint financeiro_compras_total_with_freight_check
      check (total_amount = round(items_subtotal + freight_amount, 2));
  end if;
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.financeiro_compras'::pg_catalog.regclass
      and conname = 'financeiro_compras_duplicate_of_fkey'
  ) then
    alter table public.financeiro_compras
      add constraint financeiro_compras_duplicate_of_fkey
      foreign key (clinic_id, duplicate_of_purchase_id)
      references public.financeiro_compras(clinic_id, id)
      on delete restrict;
  end if;
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.financeiro_compras'::pg_catalog.regclass
      and conname = 'financeiro_compras_duplicate_confirmed_by_fkey'
  ) then
    alter table public.financeiro_compras
      add constraint financeiro_compras_duplicate_confirmed_by_fkey
      foreign key (duplicate_confirmed_by) references auth.users(id)
      on delete restrict;
  end if;
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.financeiro_compras'::pg_catalog.regclass
      and conname = 'financeiro_compras_duplicate_confirmation_check'
  ) then
    alter table public.financeiro_compras
      add constraint financeiro_compras_duplicate_confirmation_check check (
        (
          duplicate_of_purchase_id is null and duplicate_reason is null
          and duplicate_confirmed_by is null and duplicate_confirmed_at is null
          and duplicate_operation_id is null
        ) or (
          duplicate_of_purchase_id is not null
          and duplicate_of_purchase_id <> id
          and char_length(pg_catalog.btrim(duplicate_reason)) between 3 and 500
          and duplicate_reason !~ '[[:cntrl:]]'
          and duplicate_confirmed_by is not null
          and duplicate_confirmed_at is not null
          and duplicate_operation_id is not null
        )
      );
  end if;
end;
$migration$;

alter table public.financeiro_compra_itens
  add column if not exists position smallint,
  add column if not exists lot text,
  add column if not exists expiry date,
  add column if not exists allocated_freight numeric(14,2) not null default 0,
  add column if not exists landed_unit_cost numeric(14,6);

-- Itens de compra são append-only em operação normal. A migration libera
-- somente o preenchimento das novas colunas técnicas nas linhas existentes e
-- restaura a proteção ainda dentro da mesma transação.
alter table public.financeiro_compra_itens
  disable trigger financeiro_compra_itens_immutable;

with ordered as (
  select id,
         row_number() over (
           partition by clinic_id, purchase_id
           order by created_at, id
         )::smallint as position
  from public.financeiro_compra_itens
)
update public.financeiro_compra_itens item
set position = ordered.position
from ordered
where ordered.id = item.id and item.position is null;

update public.financeiro_compra_itens
set landed_unit_cost = unit_cost
where landed_unit_cost is null;

alter table public.financeiro_compra_itens
  enable trigger financeiro_compra_itens_immutable;

alter table public.financeiro_compra_itens
  alter column position set not null,
  alter column landed_unit_cost set not null;

do $migration$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.financeiro_compra_itens'::pg_catalog.regclass
      and conname = 'financeiro_compra_itens_position_check'
  ) then
    alter table public.financeiro_compra_itens
      add constraint financeiro_compra_itens_position_check
      check (position between 1 and 100);
  end if;
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.financeiro_compra_itens'::pg_catalog.regclass
      and conname = 'financeiro_compra_itens_lot_check'
  ) then
    alter table public.financeiro_compra_itens
      add constraint financeiro_compra_itens_lot_check check (
        lot is null or (
          pg_catalog.char_length(pg_catalog.btrim(lot)) between 1 and 100
          and lot !~ '[[:cntrl:]]'
        )
      );
  end if;
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.financeiro_compra_itens'::pg_catalog.regclass
      and conname = 'financeiro_compra_itens_lot_expiry_pair_check'
  ) then
    alter table public.financeiro_compra_itens
      add constraint financeiro_compra_itens_lot_expiry_pair_check
      check ((lot is null) = (expiry is null));
  end if;
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.financeiro_compra_itens'::pg_catalog.regclass
      and conname = 'financeiro_compra_itens_allocated_freight_check'
  ) then
    alter table public.financeiro_compra_itens
      add constraint financeiro_compra_itens_allocated_freight_check
      check (allocated_freight >= 0);
  end if;
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.financeiro_compra_itens'::pg_catalog.regclass
      and conname = 'financeiro_compra_itens_landed_unit_cost_check'
  ) then
    alter table public.financeiro_compra_itens
      add constraint financeiro_compra_itens_landed_unit_cost_check
      check (landed_unit_cost >= 0 and landed_unit_cost <= 9999999999.999999);
  end if;
end;
$migration$;

create unique index if not exists financeiro_compra_itens_purchase_position_unique
  on public.financeiro_compra_itens (clinic_id, purchase_id, position);

create or replace function private.financeiro_purchase_fingerprint(
  p_supplier_id uuid, p_purchase_date date, p_invoice_number text,
  p_payment_condition text, p_installments integer,
  p_items_subtotal numeric, p_freight numeric, p_total numeric,
  p_canonical_items jsonb
)
returns text language sql immutable parallel safe set search_path = '' as $function$
  select 'purchase:' || pg_catalog.md5(pg_catalog.jsonb_build_array(
    p_supplier_id, p_purchase_date,
    private.financeiro_normalize_identity(p_invoice_number),
    p_payment_condition, p_installments,
    pg_catalog.round(p_items_subtotal, 2), pg_catalog.round(p_freight, 2),
    pg_catalog.round(p_total, 2), p_canonical_items
  )::text);
$function$;

revoke all on function private.financeiro_purchase_fingerprint(
  uuid,date,text,text,integer,numeric,numeric,numeric,jsonb
) from public, anon, authenticated, service_role;

with item_keys as (
  select item.clinic_id, item.purchase_id,
         pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(
           item.product_id, item.quantity, item.unit_cost,
           item.lot, item.expiry, item.position
         ) order by item.position) as canonical_items
  from public.financeiro_compra_itens item
  group by item.clinic_id, item.purchase_id
)
update public.financeiro_compras purchase
set dedup_fingerprint = private.financeiro_purchase_fingerprint(
  purchase.supplier_id, purchase.purchase_date, purchase.invoice_number,
  purchase.payment_condition, purchase.installments,
  purchase.items_subtotal, purchase.freight_amount, purchase.total_amount,
  item_keys.canonical_items
)
from item_keys
where item_keys.clinic_id = purchase.clinic_id
  and item_keys.purchase_id = purchase.id;

-- Eventuais compras legadas sem item ficam identificadas pelo proprio ID e
-- nunca sao colapsadas automaticamente.
update public.financeiro_compras
set dedup_fingerprint = 'record:' || id::text
where dedup_fingerprint is null;

with ranked as (
  select id, row_number() over (
    partition by clinic_id, supplier_id,
      private.financeiro_normalize_identity(invoice_number)
    order by created_at, id
  ) as position
  from public.financeiro_compras
  where invoice_number is not null
)
update public.financeiro_compras purchase
set dedup_enforced = ranked.position = 1
from ranked where ranked.id = purchase.id;

with ranked as (
  select clinic_id, id, invoice_number,
         first_value(id) over (
           partition by clinic_id, supplier_id,
             private.financeiro_normalize_identity(invoice_number)
           order by created_at, id
         ) as primary_id,
         row_number() over (
           partition by clinic_id, supplier_id,
             private.financeiro_normalize_identity(invoice_number)
           order by created_at, id
         ) as position
  from public.financeiro_compras where invoice_number is not null
)
insert into public.clinic_duplicate_reviews (
  clinic_id, entity_kind, primary_id, candidate_id,
  match_kind, match_key_hash, reason_code
)
select clinic_id, 'compra', primary_id, id, 'legacy_exact',
       'md5:' || pg_catalog.md5(private.financeiro_normalize_identity(invoice_number)),
       'legacy_supplier_invoice'
from ranked where position > 1
on conflict do nothing;

with ranked as (
  select clinic_id, id, dedup_fingerprint,
         first_value(id) over (
           partition by clinic_id, dedup_fingerprint order by created_at, id
         ) as primary_id,
         row_number() over (
           partition by clinic_id, dedup_fingerprint order by created_at, id
         ) as position
  from public.financeiro_compras where invoice_number is null
)
insert into public.clinic_duplicate_reviews (
  clinic_id, entity_kind, primary_id, candidate_id,
  match_kind, match_key_hash, reason_code
)
select clinic_id, 'compra', primary_id, id, 'possible',
       'md5:' || pg_catalog.md5(dedup_fingerprint),
       'possible_purchase_without_document'
from ranked where position > 1
on conflict do nothing;

alter table public.financeiro_compras
  alter column dedup_fingerprint set not null;

drop index if exists public.financeiro_compras_invoice_unique;
create unique index financeiro_compras_invoice_exact_unique
  on public.financeiro_compras (
    clinic_id, supplier_id,
    private.financeiro_normalize_identity(invoice_number)
  ) where invoice_number is not null and dedup_enforced;
create index financeiro_compras_fingerprint_idx
  on public.financeiro_compras (clinic_id, dedup_fingerprint, created_at);
create unique index financeiro_compras_duplicate_operation_unique
  on public.financeiro_compras (clinic_id, duplicate_operation_id)
  where duplicate_operation_id is not null;

-- Compras promocionais podem ter item de custo zero. Ainda assim o historico
-- precisa registrar o custo real (inclusive zero) e o frete rateado.
alter table public.financeiro_produto_custos
  alter column unit_cost type numeric(20,6) using unit_cost::numeric(20,6),
  drop constraint if exists financeiro_produto_custos_total_cost_check,
  drop constraint if exists financeiro_produto_custos_unit_cost_check;

alter table public.financeiro_produto_custos
  add constraint financeiro_produto_custos_total_cost_check check (
    total_cost >= 0 and total_cost <= 999999999999.99
  ),
  add constraint financeiro_produto_custos_unit_cost_check check (
    unit_cost >= 0 and unit_cost <= 9999999999.999999
  );

-- ---------------------------------------------------------------------------
-- Lotes e livro imutavel de entradas/saidas
-- ---------------------------------------------------------------------------

create or replace function private.financeiro_unidade_canonica(p_unit text)
returns text
language sql
immutable
strict
parallel safe
set search_path = ''
as $function$
  select case pg_catalog.lower(pg_catalog.btrim(p_unit))
    when 'un.' then 'un'
    when 'unidade' then 'un'
    when 'unidades' then 'un'
    when 'ml' then 'ml'
    when 'u' then 'u'
    when 'cânula' then 'canula'
    when 'aplicação' then 'aplicacao'
    else pg_catalog.lower(pg_catalog.btrim(p_unit))
  end;
$function$;

create table public.financeiro_estoque_lotes (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete restrict,
  product_id uuid not null,
  lot text not null,
  expiry date not null,
  unit text not null,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default pg_catalog.now(),
  constraint financeiro_estoque_lotes_clinic_id_id_key unique (clinic_id, id),
  constraint financeiro_estoque_lotes_product_fk
    foreign key (clinic_id, product_id)
    references public.financeiro_produtos (clinic_id, id) on delete restrict,
  constraint financeiro_estoque_lotes_lot_check check (
    pg_catalog.char_length(pg_catalog.btrim(lot)) between 1 and 100
    and lot !~ '[[:cntrl:]]'
  ),
  constraint financeiro_estoque_lotes_unit_check check (
    unit in (
      'un', 'u', 'cx', 'frasco', 'seringa', 'ampola', 'aplicacao',
      'canula', 'dose', 'ml', 'mg', 'g', 'kit'
    )
  )
);

create unique index financeiro_estoque_lotes_identity_unique
  on public.financeiro_estoque_lotes (
    clinic_id, product_id, pg_catalog.lower(pg_catalog.btrim(lot)), expiry
  );
create index financeiro_estoque_lotes_expiry_idx
  on public.financeiro_estoque_lotes (clinic_id, expiry, product_id);

create table public.financeiro_estoque_movimentos (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete restrict,
  product_id uuid not null,
  lot_id uuid not null,
  movement_kind text not null check (
    movement_kind in (
      'entrada_compra', 'estorno_compra',
      'saida_procedimento', 'estorno_procedimento'
    )
  ),
  quantity_delta numeric(14,4) not null check (
    quantity_delta <> 0 and pg_catalog.abs(quantity_delta) <= 9999999999.9999
  ),
  unit text not null,
  unit_cost_effective numeric(14,6) not null check (
    unit_cost_effective >= 0 and unit_cost_effective <= 9999999999.999999
  ),
  purchase_item_id uuid,
  protocol_id uuid,
  source_line_id uuid,
  reversal_of_id uuid,
  actor_id uuid not null references auth.users(id) on delete restrict,
  request_id uuid not null,
  occurred_at timestamptz not null default pg_catalog.now(),
  created_at timestamptz not null default pg_catalog.now(),
  constraint financeiro_estoque_movimentos_clinic_id_id_key unique (clinic_id, id),
  constraint financeiro_estoque_movimentos_product_fk
    foreign key (clinic_id, product_id)
    references public.financeiro_produtos (clinic_id, id) on delete restrict,
  constraint financeiro_estoque_movimentos_lot_fk
    foreign key (clinic_id, lot_id)
    references public.financeiro_estoque_lotes (clinic_id, id) on delete restrict,
  constraint financeiro_estoque_movimentos_purchase_item_fk
    foreign key (purchase_item_id)
    references public.financeiro_compra_itens(id) on delete restrict,
  constraint financeiro_estoque_movimentos_protocol_fk
    foreign key (protocol_id)
    references public.protocols(id) on delete restrict,
  constraint financeiro_estoque_movimentos_reversal_fk
    foreign key (clinic_id, reversal_of_id)
    references public.financeiro_estoque_movimentos (clinic_id, id) on delete restrict,
  constraint financeiro_estoque_movimentos_unit_check check (
    unit in (
      'un', 'u', 'cx', 'frasco', 'seringa', 'ampola', 'aplicacao',
      'canula', 'dose', 'ml', 'mg', 'g', 'kit'
    )
  ),
  constraint financeiro_estoque_movimentos_sign_check check (
    (movement_kind in ('entrada_compra', 'estorno_procedimento') and quantity_delta > 0)
    or (movement_kind in ('saida_procedimento', 'estorno_compra') and quantity_delta < 0)
  ),
  constraint financeiro_estoque_movimentos_source_check check (
    (
      movement_kind in ('entrada_compra', 'estorno_compra')
      and purchase_item_id is not null and protocol_id is null
    ) or (
      movement_kind in ('saida_procedimento', 'estorno_procedimento')
      and protocol_id is not null and purchase_item_id is null
    )
  )
);

create unique index financeiro_estoque_movimentos_reversal_unique
  on public.financeiro_estoque_movimentos (clinic_id, reversal_of_id)
  where reversal_of_id is not null;
create unique index financeiro_estoque_movimentos_purchase_entry_unique
  on public.financeiro_estoque_movimentos (clinic_id, purchase_item_id)
  where movement_kind = 'entrada_compra';
create index financeiro_estoque_movimentos_balance_idx
  on public.financeiro_estoque_movimentos (clinic_id, product_id, lot_id, created_at, id);
create index financeiro_estoque_movimentos_protocol_idx
  on public.financeiro_estoque_movimentos (clinic_id, protocol_id, created_at, id)
  where protocol_id is not null;
create index financeiro_estoque_movimentos_purchase_idx
  on public.financeiro_estoque_movimentos (clinic_id, purchase_item_id, created_at, id)
  where purchase_item_id is not null;
create index financeiro_estoque_movimentos_actor_idx
  on public.financeiro_estoque_movimentos (actor_id, created_at desc);
create index financeiro_estoque_movimentos_request_idx
  on public.financeiro_estoque_movimentos (clinic_id, request_id);

create or replace function private.financeiro_estoque_validar_movimento()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  v_product public.financeiro_produtos%rowtype;
  v_lot public.financeiro_estoque_lotes%rowtype;
  v_original public.financeiro_estoque_movimentos%rowtype;
  v_balance numeric(14,4);
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      new.clinic_id::text || ':stock:' || new.product_id::text || ':' || new.lot_id::text,
      0
    )
  );

  select * into v_product
  from public.financeiro_produtos
  where clinic_id = new.clinic_id and id = new.product_id;
  if not found or not v_product.stock_control then
    raise exception 'stock_control_disabled' using errcode = '23514';
  end if;

  select * into v_lot
  from public.financeiro_estoque_lotes
  where clinic_id = new.clinic_id and id = new.lot_id;
  if not found or v_lot.product_id <> new.product_id then
    raise exception 'stock_lot_mismatch' using errcode = '23514';
  end if;
  if private.financeiro_unidade_canonica(new.unit) <> v_product.unit
     or v_lot.unit <> v_product.unit then
    raise exception 'stock_unit_mismatch' using errcode = '23514';
  end if;

  if new.reversal_of_id is not null then
    select * into v_original
    from public.financeiro_estoque_movimentos
    where clinic_id = new.clinic_id and id = new.reversal_of_id
    for update;
    if not found
       or v_original.product_id <> new.product_id
       or v_original.lot_id <> new.lot_id
       or v_original.unit <> new.unit
       or v_original.quantity_delta <> -new.quantity_delta
       or v_original.unit_cost_effective <> new.unit_cost_effective
       or (v_original.movement_kind = 'entrada_compra' and new.movement_kind <> 'estorno_compra')
       or (v_original.movement_kind = 'saida_procedimento' and new.movement_kind <> 'estorno_procedimento')
       or v_original.movement_kind in ('estorno_compra', 'estorno_procedimento') then
      raise exception 'stock_reversal_mismatch' using errcode = '23514';
    end if;
  elsif new.movement_kind in ('estorno_compra', 'estorno_procedimento') then
    raise exception 'stock_reversal_origin_required' using errcode = '23514';
  end if;

  select coalesce(pg_catalog.sum(quantity_delta), 0)::numeric(14,4)
  into v_balance
  from public.financeiro_estoque_movimentos
  where clinic_id = new.clinic_id
    and product_id = new.product_id
    and lot_id = new.lot_id;

  if v_balance + new.quantity_delta < 0 then
    raise exception 'stock_insufficient' using errcode = '23514';
  end if;
  return new;
end;
$function$;

-- UUID tecnico deterministico para suboperacoes do mesmo request.
create or replace function private.financeiro_estoque_request_id(
  p_request_id uuid,
  p_suffix text
)
returns uuid
language sql
immutable
strict
parallel safe
set search_path = ''
as $function$
  select pg_catalog.md5(p_request_id::text || ':' || p_suffix)::uuid;
$function$;

-- ---------------------------------------------------------------------------
-- Prontuario: substituicao de itens com movimentos compensatorios
-- ---------------------------------------------------------------------------

create or replace function public.prontuario_substituir_produtos(
  p_clinic_id uuid,
  p_user_id uuid,
  p_actor_role text,
  p_auth_method text,
  p_protocol_id uuid,
  p_expected_version integer,
  p_products jsonb,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_version integer;
  v_count integer;
  v_previous_id uuid;
  v_previous_version integer;
  v_previous_count integer;
  v_previous_action text;
  v_movement record;
  v_item record;
  v_lot public.financeiro_estoque_lotes%rowtype;
  v_balance numeric(14,4);
  v_value numeric(18,6);
  v_unit_cost numeric(14,6);
  v_stock_reversals integer := 0;
  v_stock_outputs integer := 0;
begin
  perform private.prontuario_assert_actor(
    p_clinic_id, p_user_id, p_actor_role, p_auth_method,
    array['owner', 'professional']::text[]
  );

  select entity_id, action,
         nullif(details ->> 'version', '')::integer,
         nullif(details ->> 'item_count', '')::integer
  into v_previous_id, v_previous_action, v_previous_version, v_previous_count
  from public.clinic_audit_log
  where clinic_id = p_clinic_id and request_id = p_request_id;

  if found then
    if v_previous_id = p_protocol_id
       and v_previous_action = 'products.replace' then
      return pg_catalog.jsonb_build_object(
        'id', v_previous_id,
        'version', v_previous_version,
        'product_count', coalesce(v_previous_count, 0),
        'idempotent', true
      );
    end if;
    raise exception 'operation_id_reused' using errcode = '22023';
  end if;

  select version into v_version
  from public.protocols
  where id = p_protocol_id
    and clinic_id = p_clinic_id
    and status = 'draft'
    and archived_at is null
  for update;

  if not found then
    raise exception 'protocol_not_found_or_locked' using errcode = 'P0002';
  end if;
  if p_expected_version is null or v_version <> p_expected_version then
    raise exception 'version_conflict' using errcode = '40001';
  end if;

  -- Primeiro devolve ao saldo todo consumo ativo da versao anterior. Nada e
  -- apagado do ledger; cada devolucao referencia exatamente sua saida.
  for v_movement in
    select movement.*
    from public.financeiro_estoque_movimentos movement
    where movement.clinic_id = p_clinic_id
      and movement.protocol_id = p_protocol_id
      and movement.movement_kind = 'saida_procedimento'
      and not exists (
        select 1
        from public.financeiro_estoque_movimentos reversal
        where reversal.clinic_id = movement.clinic_id
          and reversal.reversal_of_id = movement.id
      )
    order by movement.created_at, movement.id
    for update of movement
  loop
    insert into public.financeiro_estoque_movimentos (
      clinic_id, product_id, lot_id, movement_kind, quantity_delta,
      unit, unit_cost_effective, protocol_id, source_line_id,
      reversal_of_id, actor_id, request_id
    ) values (
      v_movement.clinic_id, v_movement.product_id, v_movement.lot_id,
      'estorno_procedimento', -v_movement.quantity_delta,
      v_movement.unit, v_movement.unit_cost_effective,
      p_protocol_id, v_movement.source_line_id,
      v_movement.id, p_user_id, p_request_id
    );
    v_stock_reversals := v_stock_reversals + 1;
  end loop;

  v_count := private.prontuario_replace_products(
    p_protocol_id, p_clinic_id, p_products
  );

  for v_item in
    select protocol_product.*, product.unit as catalog_unit,
           product.stock_control
    from public.protocol_products protocol_product
    join public.financeiro_produtos product
      on product.id = protocol_product.product_id
     and product.clinic_id = p_clinic_id
    where protocol_product.protocol_id = p_protocol_id
    order by protocol_product.position
  loop
    if v_item.stock_control then
      if private.financeiro_unidade_canonica(v_item.unit) <> v_item.catalog_unit then
        raise exception 'stock_unit_mismatch' using errcode = '23514';
      end if;

      select * into v_lot
      from public.financeiro_estoque_lotes
      where clinic_id = p_clinic_id
        and product_id = v_item.product_id
        and pg_catalog.lower(pg_catalog.btrim(lot)) =
            pg_catalog.lower(pg_catalog.btrim(v_item.lot))
        and expiry = v_item.expiry;
      if not found then
        raise exception 'stock_lot_not_found' using errcode = 'P0002';
      end if;

      perform pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(
          p_clinic_id::text || ':stock:' || v_item.product_id::text || ':' || v_lot.id::text,
          0
        )
      );

      select
        coalesce(pg_catalog.sum(quantity_delta), 0)::numeric(14,4),
        coalesce(
          pg_catalog.sum(quantity_delta * unit_cost_effective), 0
        )::numeric(18,6)
      into v_balance, v_value
      from public.financeiro_estoque_movimentos
      where clinic_id = p_clinic_id
        and product_id = v_item.product_id
        and lot_id = v_lot.id;

      if v_balance < v_item.amount then
        raise exception 'stock_insufficient' using errcode = '23514';
      end if;
      v_unit_cost := case when v_balance > 0 then
        pg_catalog.round(v_value / v_balance, 6)
      else 0 end;
      if v_unit_cost < 0 then
        raise exception 'stock_cost_inconsistent' using errcode = '23514';
      end if;

      update public.protocol_products
      set cost_snapshot = v_unit_cost
      where id = v_item.id;

      insert into public.financeiro_estoque_movimentos (
        clinic_id, product_id, lot_id, movement_kind, quantity_delta,
        unit, unit_cost_effective, protocol_id, source_line_id,
        actor_id, request_id
      ) values (
        p_clinic_id, v_item.product_id, v_lot.id,
        'saida_procedimento', -v_item.amount,
        v_lot.unit, v_unit_cost, p_protocol_id, v_item.id,
        p_user_id, p_request_id
      );
      v_stock_outputs := v_stock_outputs + 1;
    end if;
  end loop;

  update public.protocols
  set updated_by = p_user_id,
      updated_at = pg_catalog.now(),
      version = version + 1
  where id = p_protocol_id and clinic_id = p_clinic_id
  returning version into v_version;

  perform private.prontuario_log_event(
    p_clinic_id, p_user_id, p_actor_role, p_auth_method,
    'protocol', p_protocol_id, 'products.replace',
    pg_catalog.jsonb_build_object(
      'endpoint', 'prontuario-fichas',
      'operation', 'stock.replace',
      'version', v_version,
      'item_count', v_count,
      'result_count', v_stock_reversals + v_stock_outputs
    ),
    p_request_id
  );

  return pg_catalog.jsonb_build_object(
    'id', p_protocol_id,
    'version', v_version,
    'product_count', v_count,
    'stock_outputs', v_stock_outputs,
    'stock_reversals', v_stock_reversals,
    'idempotent', false
  );
end;
$function$;

-- Wrapper atomico para criar/editar o rascunho e, na mesma transacao,
-- substituir produtos pelo fluxo que controla estoque.
create function public.prontuario_salvar_rascunho_com_estoque(
  p_clinic_id uuid,
  p_user_id uuid,
  p_actor_role text,
  p_auth_method text,
  p_protocol_id uuid,
  p_expected_version integer,
  p_idempotency_key uuid,
  p_patient_id uuid,
  p_appointment_id uuid,
  p_procedure_kind text,
  p_complaint text,
  p_anamnesis jsonb,
  p_technique_notes text,
  p_procedure_date date,
  p_return_date date,
  p_care_notes text,
  p_products jsonb,
  p_consents jsonb,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_saved jsonb;
  v_products_saved jsonb;
  v_protocol_id uuid;
  v_version integer;
begin
  v_saved := public.prontuario_salvar_rascunho(
    p_clinic_id, p_user_id, p_actor_role, p_auth_method,
    p_protocol_id, p_expected_version, p_idempotency_key,
    p_patient_id, p_appointment_id, p_procedure_kind,
    p_complaint, p_anamnesis, p_technique_notes,
    p_procedure_date, p_return_date, p_care_notes,
    null, p_consents, p_request_id
  );

  v_protocol_id := (v_saved ->> 'id')::uuid;
  v_version := (v_saved ->> 'version')::integer;

  if p_products is not null then
    v_products_saved := public.prontuario_substituir_produtos(
      p_clinic_id, p_user_id, p_actor_role, p_auth_method,
      v_protocol_id, v_version, p_products,
      private.financeiro_estoque_request_id(p_request_id, 'stock-products')
    );
    v_saved := v_saved
      || pg_catalog.jsonb_build_object(
        'version', (v_products_saved ->> 'version')::integer,
        'product_count', coalesce(
          (v_products_saved ->> 'product_count')::integer, 0
        ),
        'stock_outputs', coalesce(
          (v_products_saved ->> 'stock_outputs')::integer, 0
        ),
        'stock_reversals', coalesce(
          (v_products_saved ->> 'stock_reversals')::integer, 0
        )
      );
  end if;

  return v_saved;
end;
$function$;


-- Cancelamento nao apaga a compra: cria movimentos inversos do estoque e
-- somente prossegue se o saldo de cada lote permanecer nao negativo.
create or replace function public.financeiro_cancelar_compra(
  p_clinic_id uuid, p_user_id uuid, p_purchase_id uuid, p_expected_version integer,
  p_reason text, p_operation_id uuid, p_request_id uuid
)
returns jsonb
language plpgsql
set search_path = ''
as $function$
declare
  v_purchase public.financeiro_compras%rowtype;
  v_entry public.financeiro_lancamentos%rowtype;
  v_payment record;
  v_stock record;
  v_product_id uuid;
  v_previous_cost public.financeiro_produto_custos%rowtype;
  v_cost_operation_id uuid;
  v_refund_id uuid;
  v_reversal_count integer := 0;
  v_stock_reversal_count integer := 0;
  v_cancelled_installments integer := 0;
  v_reason text := private.financeiro_operation_reason(p_reason);
begin
  select * into v_purchase
  from public.financeiro_compras
  where clinic_id = p_clinic_id and id = p_purchase_id
  for update;
  if not found then
    raise exception 'compra_nao_encontrada' using errcode = 'P0002';
  end if;

  if v_purchase.state = 'cancelada' then
    if v_purchase.cancellation_operation_id = p_operation_id then
      return pg_catalog.jsonb_build_object(
        'compra_id', v_purchase.id,
        'lancamento_id', v_purchase.expense_entry_id,
        'versao', v_purchase.version,
        'estornos', 0,
        'estornos_estoque', 0,
        'parcelas_canceladas', 0,
        'idempotente', true
      );
    end if;
    raise exception 'compra_ja_cancelada' using errcode = '55000';
  end if;
  if v_purchase.version <> p_expected_version then
    raise exception 'version_conflict' using errcode = '40001';
  end if;

  select * into v_entry
  from public.financeiro_lancamentos
  where clinic_id = p_clinic_id and id = v_purchase.expense_entry_id
  for update;
  if not found or v_entry.origin <> 'compra' or v_entry.state <> 'ativo' then
    raise exception 'compra_lancamento_inconsistente' using errcode = '55000';
  end if;

  for v_stock in
    select movement.*
    from public.financeiro_estoque_movimentos movement
    join public.financeiro_compra_itens item
      on item.id = movement.purchase_item_id
     and item.clinic_id = movement.clinic_id
    where movement.clinic_id = p_clinic_id
      and item.purchase_id = p_purchase_id
      and movement.movement_kind = 'entrada_compra'
      and not exists (
        select 1
        from public.financeiro_estoque_movimentos reversal
        where reversal.clinic_id = movement.clinic_id
          and reversal.reversal_of_id = movement.id
      )
    order by item.position, movement.id
    for update of movement
  loop
    -- A entrada so pode ser desfeita pelo custo original enquanto nenhuma
    -- saida ativa posterior tiver consumido o mesmo lote. Sem camadas por
    -- compra, permitir esse estorno depois de um consumo a custo medio poderia
    -- deixar valor de estoque negativo apesar de o saldo fisico chegar a zero.
    -- O mesmo advisory lock usado pelo trigger fecha a corrida entre esta
    -- verificacao e uma baixa concorrente de prontuario.
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        v_stock.clinic_id::text || ':stock:' ||
        v_stock.product_id::text || ':' || v_stock.lot_id::text,
        0
      )
    );

    if exists (
      select 1
      from public.financeiro_estoque_movimentos consumption
      where consumption.clinic_id = v_stock.clinic_id
        and consumption.product_id = v_stock.product_id
        and consumption.lot_id = v_stock.lot_id
        and consumption.movement_kind = 'saida_procedimento'
        and consumption.created_at >= v_stock.created_at
        and not exists (
          select 1
          from public.financeiro_estoque_movimentos reversal
          where reversal.clinic_id = consumption.clinic_id
            and reversal.reversal_of_id = consumption.id
        )
    ) then
      raise exception 'stock_purchase_consumed'
        using errcode = '55000';
    end if;

    insert into public.financeiro_estoque_movimentos (
      clinic_id, product_id, lot_id, movement_kind, quantity_delta,
      unit, unit_cost_effective, purchase_item_id, source_line_id,
      reversal_of_id, actor_id, request_id
    ) values (
      v_stock.clinic_id, v_stock.product_id, v_stock.lot_id,
      'estorno_compra', -v_stock.quantity_delta,
      v_stock.unit, v_stock.unit_cost_effective,
      v_stock.purchase_item_id, v_stock.source_line_id,
      v_stock.id, p_user_id, p_request_id
    );
    v_stock_reversal_count := v_stock_reversal_count + 1;
  end loop;

  for v_payment in
    select
      payment.*,
      (payment.amount - coalesce(pg_catalog.sum(refund.amount), 0))::numeric(14,2)
        as reversible_amount
    from public.financeiro_pagamentos payment
    left join public.financeiro_pagamentos refund
      on refund.clinic_id = payment.clinic_id
     and refund.reversed_payment_id = payment.id
     and refund.movement_type = 'estorno'
    where payment.clinic_id = p_clinic_id
      and payment.entry_id = v_purchase.expense_entry_id
      and payment.movement_type = 'pagamento'
    group by payment.id
    having payment.amount - coalesce(pg_catalog.sum(refund.amount), 0) > 0
    order by payment.created_at, payment.id
  loop
    v_refund_id := public.financeiro_registrar_pagamento(
      p_clinic_id,
      p_user_id,
      v_purchase.expense_entry_id,
      'estorno',
      v_payment.payment_method,
      v_payment.reversible_amount,
      pg_catalog.now(),
      v_payment.installments,
      null,
      v_payment.id,
      pg_catalog.gen_random_uuid(),
      p_request_id
    );

    insert into public.financeiro_parcela_pagamentos (
      clinic_id, installment_id, payment_id, created_by
    )
    select link.clinic_id, link.installment_id, v_refund_id, p_user_id
    from public.financeiro_parcela_pagamentos link
    where link.clinic_id = p_clinic_id and link.payment_id = v_payment.id;

    v_reversal_count := v_reversal_count + 1;
  end loop;

  update public.financeiro_parcelas
  set state = 'cancelada',
      cancelled_by = p_user_id,
      cancelled_at = pg_catalog.now(),
      updated_by = p_user_id
  where clinic_id = p_clinic_id
    and entry_id = v_purchase.expense_entry_id
    and state = 'ativa';
  get diagnostics v_cancelled_installments = row_count;

  update public.financeiro_compras
  set state = 'cancelada',
      cancelled_by = p_user_id,
      cancelled_at = pg_catalog.now(),
      cancellation_reason = v_reason,
      cancellation_operation_id = p_operation_id,
      updated_by = p_user_id
  where clinic_id = p_clinic_id and id = p_purchase_id
  returning * into v_purchase;

  -- Se esta compra definia o custo corrente, desativa o marcador e cria um
  -- novo evento restaurando o ultimo custo valido anterior. O historico da
  -- compra cancelada permanece intacto.
  for v_product_id in
    select distinct item.product_id
    from public.financeiro_compra_itens item
    join public.financeiro_produto_custos cost
      on cost.clinic_id = item.clinic_id
     and cost.operation_id = item.id
     and cost.is_current
    where item.clinic_id = p_clinic_id
      and item.purchase_id = p_purchase_id
  loop
    update public.financeiro_produto_custos cost
    set is_current = false
    where cost.clinic_id = p_clinic_id
      and cost.product_id = v_product_id
      and cost.is_current;

    select cost.* into v_previous_cost
    from public.financeiro_produto_custos cost
    left join public.financeiro_compra_itens item
      on item.clinic_id = cost.clinic_id
     and item.id = cost.operation_id
    left join public.financeiro_compras purchase
      on purchase.clinic_id = item.clinic_id
     and purchase.id = item.purchase_id
    where cost.clinic_id = p_clinic_id
      and cost.product_id = v_product_id
      and (item.id is null or purchase.state = 'registrada')
      and (item.purchase_id is null or item.purchase_id <> p_purchase_id)
      and not exists (
        select 1
        from public.financeiro_produto_custo_cancelamentos cancellation
        where cancellation.clinic_id = cost.clinic_id
          and cancellation.cost_id = cost.id
      )
    order by cost.cost_date desc, cost.created_at desc, cost.id desc
    limit 1;

    if found then
      v_cost_operation_id := private.financeiro_estoque_request_id(
        p_operation_id, 'restore-cost-' || v_product_id::text
      );
      insert into public.financeiro_produto_custos (
        clinic_id, product_id, supplier_id, source, cost_date,
        payment_condition, package_quantity, package_unit,
        total_cost, unit_cost, notes, sets_current, is_current,
        operation_id, created_by
      ) values (
        p_clinic_id, v_product_id, v_previous_cost.supplier_id,
        'Custo anterior restaurado apos cancelamento',
        (pg_catalog.now() at time zone 'America/Sao_Paulo')::date,
        v_previous_cost.payment_condition,
        v_previous_cost.package_quantity,
        v_previous_cost.package_unit,
        v_previous_cost.total_cost,
        v_previous_cost.unit_cost,
        'Evento compensatorio; o historico cancelado foi preservado.',
        true, true, v_cost_operation_id, p_user_id
      );

      update public.financeiro_produtos
      set reference_cost = pg_catalog.round(v_previous_cost.unit_cost, 2),
          updated_by = p_user_id
      where clinic_id = p_clinic_id and id = v_product_id;
    else
      update public.financeiro_produtos
      set reference_cost = null,
          updated_by = p_user_id
      where clinic_id = p_clinic_id and id = v_product_id;
    end if;
  end loop;

  -- Cada custo originado pela compra cancelada recebe seu proprio evento
  -- imutavel. Assim o historico de custos mostra o cancelamento sem depender
  -- apenas do estado da compra e nunca reaproveita esse valor como vigente.
  insert into public.financeiro_produto_custo_cancelamentos (
    clinic_id, cost_id, replacement_cost_id, reason, result_status,
    operation_id, cancelled_by
  )
  select
    p_clinic_id, cost.id, null, v_reason, 'purchase_cancelled',
    private.financeiro_estoque_request_id(
      p_operation_id, 'cancel-purchase-cost-' || cost.id::text
    ),
    p_user_id
  from public.financeiro_compra_itens item
  join public.financeiro_produto_custos cost
    on cost.clinic_id = item.clinic_id
   and cost.operation_id = item.id
  where item.clinic_id = p_clinic_id
    and item.purchase_id = p_purchase_id
  -- O custo pode ter sido cancelado individualmente antes da compra. Nesse
  -- caso o evento compensatorio existente continua sendo a fonte de verdade e
  -- nao deve impedir o cancelamento integral da compra.
  on conflict (clinic_id, cost_id) do nothing;

  update public.financeiro_lancamentos
  set state = 'cancelado',
      cancelled_by = p_user_id,
      cancelled_at = pg_catalog.now(),
      cancellation_reason = v_reason,
      updated_by = p_user_id
  where clinic_id = p_clinic_id and id = v_purchase.expense_entry_id;

  insert into public.financeiro_auditoria (
    clinic_id, actor_id, entity, entity_id, action, details, request_id
  ) values (
    p_clinic_id, p_user_id, 'financeiro_compra', p_purchase_id, 'cancelada',
    pg_catalog.jsonb_build_object(
      'operation', 'cancel_with_stock_reversals',
      'item_count', v_stock_reversal_count,
      'result_count', v_reversal_count + v_cancelled_installments,
      'version', v_purchase.version,
      'reason', v_reason
    ),
    p_request_id
  );

  return pg_catalog.jsonb_build_object(
    'compra_id', v_purchase.id,
    'lancamento_id', v_purchase.expense_entry_id,
    'versao', v_purchase.version,
    'estornos', v_reversal_count,
    'estornos_estoque', v_stock_reversal_count,
    'parcelas_canceladas', v_cancelled_installments,
    'idempotente', false
  );
end;
$function$;


create or replace function private.financeiro_estoque_imutavel()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  raise exception 'stock_ledger_is_append_only' using errcode = '55000';
end;
$function$;

create trigger financeiro_estoque_movimentos_validate
before insert on public.financeiro_estoque_movimentos
for each row execute function private.financeiro_estoque_validar_movimento();

create trigger financeiro_estoque_movimentos_immutable
before update or delete on public.financeiro_estoque_movimentos
for each row execute function private.financeiro_estoque_imutavel();

create trigger financeiro_estoque_lotes_immutable
before update or delete on public.financeiro_estoque_lotes
for each row execute function private.financeiro_estoque_imutavel();

create or replace view public.financeiro_estoque_saldos
with (security_invoker = true)
as
select
  lot.clinic_id,
  lot.product_id,
  lot.id as lot_id,
  lot.lot,
  lot.expiry,
  lot.unit,
  coalesce(pg_catalog.sum(movement.quantity_delta), 0)::numeric(14,4) as quantity_balance,
  coalesce(
    pg_catalog.sum(movement.quantity_delta * movement.unit_cost_effective), 0
  )::numeric(18,6) as effective_value
from public.financeiro_estoque_lotes lot
left join public.financeiro_estoque_movimentos movement
  on movement.clinic_id = lot.clinic_id
 and movement.product_id = lot.product_id
 and movement.lot_id = lot.id
group by lot.clinic_id, lot.product_id, lot.id, lot.lot, lot.expiry, lot.unit;

create or replace view public.financeiro_estoque_produto_saldos
with (security_invoker = true)
as
select
  clinic_id,
  product_id,
  unit,
  pg_catalog.sum(quantity_balance)::numeric(14,4) as quantity_balance,
  pg_catalog.sum(effective_value)::numeric(18,6) as effective_value,
  pg_catalog.count(*) filter (where quantity_balance > 0)::integer as active_lots
from public.financeiro_estoque_saldos
group by clinic_id, product_id, unit;

-- Depois do primeiro movimento, unidade e modo de controle passam a integrar
-- o contrato imutavel do ledger. Nome, marca, precos e demais metadados
-- continuam editaveis pela RPC protegida original.
drop function if exists public.financeiro_editar_produto(
  uuid,uuid,uuid,integer,uuid,text,text,text,numeric,numeric,text,boolean,text,uuid
);

create or replace function public.financeiro_editar_produto(
  p_clinic_id uuid, p_user_id uuid, p_product_id uuid, p_expected_version integer,
  p_brand_id uuid, p_name text, p_product_type text, p_unit text,
  p_presentation text, p_ean text, p_reference_cost numeric,
  p_sale_price numeric, p_anvisa_registration text,
  p_stock_control boolean, p_reason text, p_request_id uuid
)
returns jsonb
language plpgsql
set search_path = ''
as $function$
declare
  v_row public.financeiro_produtos%rowtype;
  v_reason text := private.financeiro_operation_reason(p_reason);
  v_presentation text := nullif(pg_catalog.btrim(p_presentation), '');
  v_ean text := nullif(pg_catalog.regexp_replace(
    coalesce(p_ean, ''), '[^0-9]+', '', 'g'
  ), '');
begin
  if v_presentation is null
     or char_length(v_presentation) > 160
     or (v_ean is not null and char_length(v_ean) not between 8 and 14) then
    raise exception 'product_presentation_invalid' using errcode = '22023';
  end if;
  select * into v_row
  from public.financeiro_produtos
  where clinic_id = p_clinic_id and id = p_product_id
  for update;
  if not found then
    raise exception 'produto_nao_encontrado' using errcode = 'P0002';
  end if;
  if v_row.version <> p_expected_version then
    raise exception 'version_conflict' using errcode = '40001';
  end if;
  if v_row.archived_at is not null then
    raise exception 'registro_arquivado' using errcode = '55000';
  end if;
  if p_brand_id is not null and not exists (
    select 1 from public.financeiro_marcas
    where clinic_id = p_clinic_id and id = p_brand_id
      and active and archived_at is null
  ) then
    raise exception 'marca_invalida' using errcode = '23503';
  end if;

  if exists (
    select 1
    from public.financeiro_estoque_movimentos movement
    where movement.clinic_id = p_clinic_id
      and movement.product_id = p_product_id
  ) and (
    p_unit is distinct from v_row.unit
    or p_stock_control is distinct from v_row.stock_control
  ) then
    raise exception 'stock_product_configuration_locked'
      using errcode = '55000';
  end if;

  update public.financeiro_produtos
  set brand_id = p_brand_id,
      name = pg_catalog.btrim(p_name),
      product_type = p_product_type,
      unit = p_unit,
      presentation = v_presentation,
      ean = v_ean,
      reference_cost = p_reference_cost,
      sale_price = p_sale_price,
      anvisa_registration = nullif(pg_catalog.btrim(p_anvisa_registration), ''),
      stock_control = p_stock_control,
      updated_by = p_user_id
  where clinic_id = p_clinic_id and id = p_product_id
  returning * into v_row;

  insert into public.financeiro_auditoria (
    clinic_id, actor_id, entity, entity_id, action, details, request_id
  ) values (
    p_clinic_id, p_user_id, 'produto', p_product_id, 'editado',
    pg_catalog.jsonb_build_object(
      'operation', 'edit', 'version', v_row.version, 'reason', v_reason
    ),
    p_request_id
  );
  return pg_catalog.to_jsonb(v_row);
end;
$function$;

-- Arquivar esconderia o produto dos seletores operacionais. Isso so e seguro
-- quando nenhum lote ainda possui saldo fisico positivo.
create or replace function public.financeiro_arquivar_produto(
  p_clinic_id uuid, p_user_id uuid, p_product_id uuid,
  p_expected_version integer, p_reason text, p_request_id uuid
)
returns jsonb
language plpgsql
set search_path = ''
as $function$
declare
  v_row public.financeiro_produtos%rowtype;
  v_reason text := private.financeiro_operation_reason(p_reason);
begin
  select * into v_row
  from public.financeiro_produtos
  where clinic_id = p_clinic_id and id = p_product_id
  for update;
  if not found then
    raise exception 'produto_nao_encontrado' using errcode = 'P0002';
  end if;
  if v_row.version <> p_expected_version then
    raise exception 'version_conflict' using errcode = '40001';
  end if;
  if v_row.archived_at is not null then
    return pg_catalog.to_jsonb(v_row);
  end if;

  if exists (
    select 1
    from public.financeiro_estoque_saldos balance
    where balance.clinic_id = p_clinic_id
      and balance.product_id = p_product_id
      and balance.quantity_balance > 0
  ) then
    raise exception 'stock_product_has_balance'
      using errcode = '55000';
  end if;

  update public.financeiro_produtos
  set active = false,
      archived_at = pg_catalog.now(),
      updated_by = p_user_id
  where clinic_id = p_clinic_id and id = p_product_id
  returning * into v_row;

  insert into public.financeiro_auditoria (
    clinic_id, actor_id, entity, entity_id, action, details, request_id
  ) values (
    p_clinic_id, p_user_id, 'produto', p_product_id, 'arquivado',
    pg_catalog.jsonb_build_object(
      'operation', 'archive', 'version', v_row.version, 'reason', v_reason
    ),
    p_request_id
  );
  return pg_catalog.to_jsonb(v_row);
end;
$function$;

-- Compras anteriores a esta migration nao possuem lote/validade confiaveis.
-- Elas entram numa fila explicita; nenhum lote e inventado ou importado sozinho.
create or replace view public.financeiro_compras_itens_pendentes_estoque
with (security_invoker = true)
as
select
  item.clinic_id,
  item.id as purchase_item_id,
  item.purchase_id,
  purchase.supplier_id,
  supplier.name as supplier_name,
  purchase.purchase_date,
  purchase.invoice_number,
  item.product_id,
  product.name as product_name,
  product.unit,
  item.quantity,
  item.unit_cost,
  item.total_amount
from public.financeiro_compra_itens item
join public.financeiro_compras purchase
  on purchase.clinic_id = item.clinic_id
 and purchase.id = item.purchase_id
join public.financeiro_produtos product
  on product.clinic_id = item.clinic_id
 and product.id = item.product_id
join public.financeiro_fornecedores supplier
  on supplier.clinic_id = purchase.clinic_id
 and supplier.id = purchase.supplier_id
where purchase.state = 'registrada'
  and product.stock_control
  and not exists (
    select 1
    from public.financeiro_estoque_movimentos movement
    where movement.clinic_id = item.clinic_id
      and movement.purchase_item_id = item.id
      and movement.movement_kind = 'entrada_compra'
  );

-- Regulariza somente o estoque de uma linha legada. A compra e seu custo
-- original permanecem imutaveis; lote/validade vivem no ledger auditavel.
create function public.financeiro_regularizar_item_compra_estoque(
  p_clinic_id uuid,
  p_user_id uuid,
  p_purchase_item_id uuid,
  p_lot text,
  p_expiry date,
  p_use_as_current_cost boolean,
  p_operation_id uuid,
  p_reason text,
  p_request_id uuid
)
returns jsonb
language plpgsql
set search_path = ''
as $function$
declare
  v_reason text := private.financeiro_operation_reason(p_reason);
  v_lot text := pg_catalog.btrim(p_lot);
  v_item record;
  v_product public.financeiro_produtos%rowtype;
  v_lot_row public.financeiro_estoque_lotes%rowtype;
  v_existing_movement public.financeiro_estoque_movimentos%rowtype;
  v_existing_lot public.financeiro_estoque_lotes%rowtype;
  v_existing_cost public.financeiro_produto_custos%rowtype;
  v_cost public.financeiro_produto_custos%rowtype;
  v_movement public.financeiro_estoque_movimentos%rowtype;
  v_use_current boolean := coalesce(p_use_as_current_cost, false);
begin
  if p_clinic_id is null or p_user_id is null or p_purchase_item_id is null
     or p_operation_id is null or p_request_id is null or p_expiry is null
     or v_lot is null or pg_catalog.char_length(v_lot) not between 1 and 100
     or v_lot ~ '[[:cntrl:]]' then
    raise exception 'regularizacao_parametros_invalidos' using errcode = '22023';
  end if;

  select
    item.id, item.purchase_id, item.product_id, item.quantity,
    item.unit_cost, item.total_amount, item.landed_unit_cost,
    purchase.supplier_id, purchase.purchase_date, purchase.payment_condition,
    purchase.state as purchase_state
  into v_item
  from public.financeiro_compra_itens item
  join public.financeiro_compras purchase
    on purchase.clinic_id = item.clinic_id and purchase.id = item.purchase_id
  where item.clinic_id = p_clinic_id and item.id = p_purchase_item_id
  for update of item, purchase;
  if not found then
    raise exception 'item_compra_nao_encontrado' using errcode = 'P0002';
  end if;
  if v_item.purchase_state <> 'registrada' then
    raise exception 'compra_cancelada' using errcode = '55000';
  end if;
  if p_expiry < v_item.purchase_date then
    raise exception 'validade_anterior_compra' using errcode = '22023';
  end if;

  select * into v_product
  from public.financeiro_produtos
  where clinic_id = p_clinic_id and id = v_item.product_id
  for update;
  if not found or not v_product.stock_control then
    raise exception 'stock_control_disabled' using errcode = '23514';
  end if;

  select movement.* into v_existing_movement
  from public.financeiro_estoque_movimentos movement
  where movement.clinic_id = p_clinic_id
    and movement.purchase_item_id = p_purchase_item_id
    and movement.movement_kind = 'entrada_compra';
  if found then
    select * into v_existing_lot
    from public.financeiro_estoque_lotes
    where clinic_id = p_clinic_id and id = v_existing_movement.lot_id;
    select * into v_existing_cost
    from public.financeiro_produto_custos
    where clinic_id = p_clinic_id and operation_id = p_purchase_item_id;
    if pg_catalog.lower(pg_catalog.btrim(v_existing_lot.lot))
         is distinct from pg_catalog.lower(v_lot)
       or v_existing_lot.expiry is distinct from p_expiry
       or v_existing_movement.quantity_delta is distinct from v_item.quantity
       or v_existing_movement.unit_cost_effective is distinct from v_item.landed_unit_cost
       or v_existing_cost.id is null
       or v_existing_cost.sets_current is distinct from v_use_current then
      raise exception 'regularizacao_item_conflitante' using errcode = '22023';
    end if;
    return pg_catalog.jsonb_build_object(
      'purchase_item_id', p_purchase_item_id,
      'lot_id', v_existing_lot.id,
      'movement_id', v_existing_movement.id,
      'cost_id', v_existing_cost.id,
      'used_as_current_cost', v_existing_cost.sets_current,
      'idempotent', true
    );
  end if;

  if exists (
    select 1 from public.financeiro_produto_custos
    where clinic_id = p_clinic_id and operation_id = p_purchase_item_id
  ) then
    raise exception 'regularizacao_item_conflitante' using errcode = '22023';
  end if;

  insert into public.financeiro_estoque_lotes (
    clinic_id, product_id, lot, expiry, unit, created_by
  ) values (
    p_clinic_id, v_item.product_id, v_lot, p_expiry, v_product.unit, p_user_id
  ) on conflict do nothing;

  select * into v_lot_row
  from public.financeiro_estoque_lotes
  where clinic_id = p_clinic_id
    and product_id = v_item.product_id
    and pg_catalog.lower(pg_catalog.btrim(lot)) = pg_catalog.lower(v_lot)
    and expiry = p_expiry;
  if not found then
    raise exception 'stock_lot_not_found' using errcode = 'P0002';
  end if;

  if v_use_current then
    update public.financeiro_produto_custos
    set is_current = false
    where clinic_id = p_clinic_id
      and product_id = v_item.product_id
      and is_current;
  end if;

  insert into public.financeiro_produto_custos (
    clinic_id, product_id, supplier_id, source, cost_date,
    payment_condition, package_quantity, package_unit,
    total_cost, unit_cost, notes, sets_current, is_current,
    operation_id, created_by
  ) values (
    p_clinic_id, v_item.product_id, v_item.supplier_id,
    'Compra legada regularizada', v_item.purchase_date,
    v_item.payment_condition, v_item.quantity, v_product.unit,
    v_item.total_amount, v_item.landed_unit_cost,
    'Custo original preservado durante regularizacao manual de lote e validade.',
    v_use_current, v_use_current, p_purchase_item_id, p_user_id
  ) returning * into v_cost;

  if v_use_current then
    update public.financeiro_produtos
    set reference_cost = pg_catalog.round(v_item.landed_unit_cost, 2),
        updated_by = p_user_id
    where clinic_id = p_clinic_id and id = v_item.product_id;
  end if;

  insert into public.financeiro_estoque_movimentos (
    clinic_id, product_id, lot_id, movement_kind, quantity_delta,
    unit, unit_cost_effective, purchase_item_id, source_line_id,
    actor_id, request_id, occurred_at
  ) values (
    p_clinic_id, v_item.product_id, v_lot_row.id, 'entrada_compra',
    v_item.quantity, v_product.unit, v_item.landed_unit_cost,
    p_purchase_item_id, p_purchase_item_id, p_user_id, p_request_id,
    v_item.purchase_date::timestamptz
  ) returning * into v_movement;

  insert into public.financeiro_auditoria (
    clinic_id, actor_id, entity, entity_id, action, details, request_id
  ) values (
    p_clinic_id, p_user_id, 'financeiro_compra_item',
    p_purchase_item_id, 'estoque_regularizado',
    pg_catalog.jsonb_build_object(
      'operation', 'legacy_stock_regularization',
      'item_count', 1,
      'mode', case when v_use_current then 'set_current' else 'history_only' end,
      'reason', v_reason
    ),
    p_request_id
  );

  return pg_catalog.jsonb_build_object(
    'purchase_item_id', p_purchase_item_id,
    'lot_id', v_lot_row.id,
    'movement_id', v_movement.id,
    'cost_id', v_cost.id,
    'used_as_current_cost', v_use_current,
    'idempotent', false
  );
end;
$function$;

-- ---------------------------------------------------------------------------
-- Compra atomica: um fornecedor, varios itens/lotes, frete e entradas
-- ---------------------------------------------------------------------------

revoke all on function public.financeiro_criar_compra(
  uuid,uuid,uuid,date,text,text,smallint,text,text,jsonb,uuid,uuid
) from public, anon, authenticated, service_role;

drop function public.financeiro_criar_compra(
  uuid,uuid,uuid,date,text,text,smallint,text,text,jsonb,uuid,uuid
);

create function public.financeiro_criar_compra(
  p_clinic_id uuid,
  p_user_id uuid,
  p_supplier_id uuid,
  p_purchase_date date,
  p_invoice_number text,
  p_payment_condition text,
  p_installments smallint,
  p_category text,
  p_notes text,
  p_items jsonb,
  p_idempotency_key uuid,
  p_request_id uuid,
  p_freight_amount numeric default 0,
  p_confirm_distinct boolean default false,
  p_duplicate_reason text default null,
  p_duplicate_operation_id uuid default null
)
returns jsonb
language plpgsql
set search_path = ''
as $function$
declare
  v_purchase_id uuid;
  v_entry_id uuid;
  v_subtotal numeric(14,2);
  v_freight numeric(14,2) := coalesce(p_freight_amount, 0)::numeric(14,2);
  v_total numeric(14,2);
  v_items_subtotal numeric(14,2);
  v_items_freight numeric(14,2);
  v_purchase public.financeiro_compras%rowtype;
  v_existing_entry public.financeiro_lancamentos%rowtype;
  v_requested_items jsonb;
  v_stored_items jsonb;
  v_invalid_items boolean;
  v_invoice_number text := nullif(pg_catalog.btrim(p_invoice_number), '');
  v_category text := pg_catalog.btrim(p_category);
  v_notes text := nullif(pg_catalog.btrim(p_notes), '');
  v_duplicate_reason text := nullif(pg_catalog.btrim(p_duplicate_reason), '');
  v_fingerprint text;
  v_duplicate public.financeiro_compras%rowtype;
  v_item record;
  v_lot_id uuid;
begin
  if p_idempotency_key is null or p_request_id is null
     or v_freight < 0 or v_freight > 999999999999.99
     or (
       coalesce(p_confirm_distinct, false) is false
       and (v_duplicate_reason is not null or p_duplicate_operation_id is not null)
     )
     or (
       coalesce(p_confirm_distinct, false) is true and (
         v_duplicate_reason is null
         or char_length(v_duplicate_reason) > 500
         or v_duplicate_reason ~ '[[:cntrl:]]'
         or p_duplicate_operation_id is null
       )
     ) then
    raise exception 'compra_parametros_invalidos' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      p_clinic_id::text || ':financeiro_lancamentos:' || p_idempotency_key::text,
      0
    )
  );
  if pg_catalog.jsonb_typeof(p_items) <> 'array'
     or pg_catalog.jsonb_array_length(p_items) < 1
     or pg_catalog.jsonb_array_length(p_items) > 50 then
    raise exception 'itens_invalidos' using errcode = '22023';
  end if;

  with parsed as (
    select
      (item ->> 'produto_id')::uuid as product_id,
      (item ->> 'quantidade')::numeric(14,4) as quantity,
      (item ->> 'valor_unitario')::numeric(14,4) as unit_cost,
      nullif(pg_catalog.btrim(item ->> 'lote'), '') as lot,
      nullif(item ->> 'validade', '')::date as expiry,
      coalesce(
        nullif(item ->> 'posicao', '')::smallint,
        ordinality::smallint
      ) as position
    from pg_catalog.jsonb_array_elements(p_items) with ordinality as source(item, ordinality)
  )
  select coalesce(pg_catalog.bool_or(
    product_id is null or quantity is null or unit_cost is null
    or quantity <= 0 or quantity > 9999999999.9999
    or unit_cost < 0 or unit_cost > 9999999999.9999
    or position not between 1 and 100
    or (lot is null) <> (expiry is null)
    or (lot is not null and (
      pg_catalog.char_length(lot) > 100 or lot ~ '[[:cntrl:]]'
    ))
  ), false)
  into v_invalid_items
  from parsed;
  if v_invalid_items then
    raise exception 'itens_invalidos' using errcode = '22023';
  end if;

  if exists (
    with parsed as (
      select coalesce(
        nullif(item ->> 'posicao', '')::smallint,
        ordinality::smallint
      ) as position
      from pg_catalog.jsonb_array_elements(p_items) with ordinality as source(item, ordinality)
    )
    select 1 from parsed group by position having pg_catalog.count(*) > 1
  ) then
    raise exception 'posicao_item_duplicada' using errcode = '23505';
  end if;

  with parsed as (
    select
      (item ->> 'produto_id')::uuid as product_id,
      (item ->> 'quantidade')::numeric(14,4) as quantity,
      (item ->> 'valor_unitario')::numeric(14,4) as unit_cost,
      nullif(pg_catalog.btrim(item ->> 'lote'), '') as lot,
      nullif(item ->> 'validade', '')::date as expiry,
      coalesce(
        nullif(item ->> 'posicao', '')::smallint,
        ordinality::smallint
      ) as position
    from pg_catalog.jsonb_array_elements(p_items) with ordinality as source(item, ordinality)
  )
  select
    pg_catalog.sum(pg_catalog.round(quantity * unit_cost, 2))::numeric(14,2),
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_array(
        product_id, quantity, unit_cost, lot, expiry, position
      ) order by position
    )
  into v_subtotal, v_requested_items
  from parsed;

  if v_subtotal is null or v_subtotal <= 0 then
    raise exception 'total_invalido' using errcode = '22003';
  end if;
  v_total := pg_catalog.round(v_subtotal + v_freight, 2);
  if v_total <= 0 or v_total > 999999999999.99 then
    raise exception 'total_invalido' using errcode = '22003';
  end if;
  v_fingerprint := private.financeiro_purchase_fingerprint(
    p_supplier_id, p_purchase_date, v_invoice_number,
    p_payment_condition, p_installments,
    v_subtotal, v_freight, v_total, v_requested_items
  );

  select * into v_purchase
  from public.financeiro_compras
  where clinic_id = p_clinic_id and idempotency_key = p_idempotency_key;
  if found then
    select * into v_existing_entry
    from public.financeiro_lancamentos
    where clinic_id = p_clinic_id and id = v_purchase.expense_entry_id;

    select coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_array(
          product_id, quantity, unit_cost, lot, expiry, position
        ) order by position
      ), '[]'::jsonb
    )
    into v_stored_items
    from public.financeiro_compra_itens
    where clinic_id = p_clinic_id and purchase_id = v_purchase.id;

    if v_purchase.supplier_id is distinct from p_supplier_id
       or v_purchase.purchase_date is distinct from p_purchase_date
       or pg_catalog.lower(v_purchase.invoice_number)
          is distinct from pg_catalog.lower(v_invoice_number)
       or v_purchase.payment_condition is distinct from p_payment_condition
       or v_purchase.installments is distinct from p_installments
       or v_purchase.items_subtotal is distinct from v_subtotal
       or v_purchase.freight_amount is distinct from v_freight
       or v_purchase.total_amount is distinct from v_total
       or v_purchase.notes is distinct from v_notes
       or v_purchase.created_by is distinct from p_user_id
       or v_existing_entry.supplier_id is distinct from p_supplier_id
       or v_existing_entry.category is distinct from v_category
       or v_existing_entry.total_amount is distinct from v_total
       or v_existing_entry.notes is distinct from v_notes
       or v_existing_entry.created_by is distinct from p_user_id
       or v_requested_items is distinct from v_stored_items then
      raise exception 'idempotency_key_reused' using errcode = '22023';
    end if;

    return pg_catalog.jsonb_build_object(
      'compra_id', v_purchase.id,
      'lancamento_id', v_purchase.expense_entry_id,
      'subtotal_itens', v_purchase.items_subtotal,
      'frete', v_purchase.freight_amount,
      'total', v_purchase.total_amount,
      'idempotente', true
    );
  end if;

  if not exists (
    select 1 from public.financeiro_fornecedores
    where clinic_id = p_clinic_id and id = p_supplier_id
      and active and archived_at is null
  ) then
    raise exception 'fornecedor_invalido' using errcode = '23503';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_clinic_id::text || ':purchase-dedup:' || case
      when v_invoice_number is not null then
        p_supplier_id::text || ':' || private.financeiro_normalize_identity(v_invoice_number)
      else v_fingerprint
    end, 0
  ));

  if v_invoice_number is not null then
    select purchase.* into v_duplicate
    from public.financeiro_compras purchase
    where purchase.clinic_id = p_clinic_id
      and purchase.supplier_id = p_supplier_id
      and private.financeiro_normalize_identity(purchase.invoice_number) =
          private.financeiro_normalize_identity(v_invoice_number)
    order by purchase.created_at, purchase.id limit 1;
    if found then
      raise exception using errcode = '23505', message = 'purchase_exact_duplicate',
        detail = v_duplicate.id::text;
    end if;
  else
    select purchase.* into v_duplicate
    from public.financeiro_compras purchase
    where purchase.clinic_id = p_clinic_id
      and purchase.invoice_number is null
      and purchase.dedup_fingerprint = v_fingerprint
    order by purchase.created_at, purchase.id limit 1;
    if found and coalesce(p_confirm_distinct, false) is false then
      raise exception using errcode = '23505', message = 'purchase_possible_duplicate',
        detail = v_duplicate.id::text;
    end if;
    if not found and coalesce(p_confirm_distinct, false) is true then
      raise exception 'purchase_duplicate_confirmation_stale' using errcode = '40001';
    end if;
  end if;

  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_items) item
    left join public.financeiro_produtos product
      on product.clinic_id = p_clinic_id
     and product.id = (item ->> 'produto_id')::uuid
     and product.active
     and product.archived_at is null
    where product.id is null
  ) then
    raise exception 'produto_invalido' using errcode = '23503';
  end if;

  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_items) item
    join public.financeiro_produtos product
      on product.clinic_id = p_clinic_id
     and product.id = (item ->> 'produto_id')::uuid
    where product.stock_control
      and (
        nullif(pg_catalog.btrim(item ->> 'lote'), '') is null
        or nullif(item ->> 'validade', '')::date is null
        or nullif(item ->> 'validade', '')::date < p_purchase_date
      )
  ) then
    raise exception 'lote_validade_obrigatorios' using errcode = '22023';
  end if;

  insert into public.financeiro_lancamentos (
    clinic_id, supplier_id, entry_type, origin, description, category,
    competence_date, due_date, total_amount, payment_condition, installments,
    notes, idempotency_key, created_by, updated_by
  ) values (
    p_clinic_id, p_supplier_id, 'despesa', 'compra', 'Compra de produtos',
    v_category, p_purchase_date, p_purchase_date, v_total,
    p_payment_condition, p_installments, v_notes,
    p_idempotency_key, p_user_id, p_user_id
  ) returning id into v_entry_id;

  insert into public.financeiro_compras (
    clinic_id, supplier_id, expense_entry_id, purchase_date, invoice_number,
    payment_condition, installments, items_subtotal, freight_amount,
    total_amount, notes, dedup_fingerprint, duplicate_of_purchase_id,
    duplicate_reason, duplicate_confirmed_by, duplicate_confirmed_at,
    duplicate_operation_id, idempotency_key, created_by
  ) values (
    p_clinic_id, p_supplier_id, v_entry_id, p_purchase_date,
    v_invoice_number, p_payment_condition, p_installments,
    v_subtotal, v_freight, v_total, v_notes, v_fingerprint,
    case when coalesce(p_confirm_distinct, false) then v_duplicate.id else null end,
    case when coalesce(p_confirm_distinct, false) then v_duplicate_reason else null end,
    case when coalesce(p_confirm_distinct, false) then p_user_id else null end,
    case when coalesce(p_confirm_distinct, false) then pg_catalog.now() else null end,
    case when coalesce(p_confirm_distinct, false) then p_duplicate_operation_id else null end,
    p_idempotency_key, p_user_id
  ) returning id into v_purchase_id;

  if coalesce(p_confirm_distinct, false) then
    insert into public.clinic_duplicate_reviews (
      clinic_id, entity_kind, primary_id, candidate_id,
      match_kind, match_key_hash, reason_code, status,
      detected_by, reviewed_by, reviewed_at, review_reason, operation_id
    ) values (
      p_clinic_id, 'compra', v_duplicate.id, v_purchase_id, 'possible',
      'md5:' || pg_catalog.md5(v_fingerprint),
      'confirmed_distinct_purchase_without_document', 'confirmado_distinto',
      p_user_id, p_user_id, pg_catalog.now(), v_duplicate_reason,
      p_duplicate_operation_id
    ) on conflict do nothing;
  end if;

  with parsed as (
    select
      (item ->> 'produto_id')::uuid as product_id,
      (item ->> 'quantidade')::numeric(14,4) as quantity,
      (item ->> 'valor_unitario')::numeric(14,4) as unit_cost,
      nullif(pg_catalog.btrim(item ->> 'lote'), '') as lot,
      nullif(item ->> 'validade', '')::date as expiry,
      coalesce(
        nullif(item ->> 'posicao', '')::smallint,
        ordinality::smallint
      ) as position,
      pg_catalog.round(
        (item ->> 'quantidade')::numeric(14,4)
        * (item ->> 'valor_unitario')::numeric(14,4), 2
      ) as line_total
    from pg_catalog.jsonb_array_elements(p_items) with ordinality as source(item, ordinality)
  ), proportional as (
    select parsed.*,
      (v_freight * 100 * line_total) / v_subtotal as exact_freight_cents
    from parsed
  ), floored as (
    select proportional.*,
      pg_catalog.floor(exact_freight_cents)::bigint as base_freight_cents,
      exact_freight_cents - pg_catalog.floor(exact_freight_cents)
        as freight_remainder_fraction
    from proportional
  ), ranked as (
    select floored.*,
      pg_catalog.row_number() over (
        order by
          case when line_total > 0 then freight_remainder_fraction else -1 end desc,
          position
      ) as freight_remainder_rank,
      (
        (v_freight * 100)::bigint
        - pg_catalog.sum(base_freight_cents) over ()
      )::bigint as freight_remaining_cents
    from floored
  ), allocated as (
    select ranked.*,
      (
        base_freight_cents
        + case
            when line_total > 0
             and freight_remainder_rank <= freight_remaining_cents then 1
            else 0
          end
      )::numeric / 100 as item_freight
    from ranked
  )
  insert into public.financeiro_compra_itens (
    clinic_id, purchase_id, product_id, quantity, unit_cost,
    position, lot, expiry, allocated_freight, landed_unit_cost
  )
  select
    p_clinic_id, v_purchase_id, product_id, quantity, unit_cost,
    position, lot, expiry, item_freight,
    pg_catalog.round((line_total + item_freight) / quantity, 6)
  from allocated
  order by position;

  select
    pg_catalog.sum(total_amount)::numeric(14,2),
    pg_catalog.sum(allocated_freight)::numeric(14,2)
  into v_items_subtotal, v_items_freight
  from public.financeiro_compra_itens
  where clinic_id = p_clinic_id and purchase_id = v_purchase_id;
  if v_items_subtotal is distinct from v_subtotal
     or v_items_freight is distinct from v_freight then
    raise exception 'compra_total_inconsistente' using errcode = '23514';
  end if;

  -- Cada item vira evidencia de custo. Para produto repetido na mesma compra,
  -- apenas a maior posicao assume o marcador corrente.
  update public.financeiro_produto_custos cost
  set is_current = false
  where cost.clinic_id = p_clinic_id
    and cost.is_current
    and cost.product_id in (
      select item.product_id
      from public.financeiro_compra_itens item
      where item.clinic_id = p_clinic_id
        and item.purchase_id = v_purchase_id
    );

  for v_item in
    select item.*, product.unit, product.stock_control,
           pg_catalog.max(item.position) over (
             partition by item.product_id
           ) as latest_product_position
    from public.financeiro_compra_itens item
    join public.financeiro_produtos product
      on product.clinic_id = item.clinic_id and product.id = item.product_id
    where item.clinic_id = p_clinic_id
      and item.purchase_id = v_purchase_id
    order by item.position
  loop
    insert into public.financeiro_produto_custos (
      clinic_id, product_id, supplier_id, source, cost_date,
      payment_condition, package_quantity, package_unit,
      total_cost, unit_cost, notes, sets_current, is_current,
      operation_id, created_by
    ) values (
      p_clinic_id, v_item.product_id, p_supplier_id,
      'Compra registrada no app', p_purchase_date,
      p_payment_condition, v_item.quantity, v_item.unit,
      pg_catalog.round(v_item.total_amount + v_item.allocated_freight, 2),
      v_item.landed_unit_cost,
      'Custo efetivo com frete rateado proporcionalmente.',
      v_item.position = v_item.latest_product_position,
      v_item.position = v_item.latest_product_position,
      v_item.id, p_user_id
    );

    if v_item.position = v_item.latest_product_position then
      update public.financeiro_produtos
      set reference_cost = pg_catalog.round(v_item.landed_unit_cost, 2),
          updated_by = p_user_id
      where clinic_id = p_clinic_id and id = v_item.product_id;
    end if;

    if v_item.stock_control then
      insert into public.financeiro_estoque_lotes (
        clinic_id, product_id, lot, expiry, unit, created_by
      ) values (
        p_clinic_id, v_item.product_id, v_item.lot, v_item.expiry,
        v_item.unit, p_user_id
      ) on conflict do nothing;

      select id into v_lot_id
      from public.financeiro_estoque_lotes
      where clinic_id = p_clinic_id
        and product_id = v_item.product_id
        and pg_catalog.lower(pg_catalog.btrim(lot)) =
            pg_catalog.lower(pg_catalog.btrim(v_item.lot))
        and expiry = v_item.expiry;

      insert into public.financeiro_estoque_movimentos (
        clinic_id, product_id, lot_id, movement_kind, quantity_delta,
        unit, unit_cost_effective, purchase_item_id, source_line_id,
        actor_id, request_id, occurred_at
      ) values (
        p_clinic_id, v_item.product_id, v_lot_id, 'entrada_compra',
        v_item.quantity, v_item.unit, v_item.landed_unit_cost,
        v_item.id, v_item.id, p_user_id, p_request_id,
        p_purchase_date::timestamptz
      );
    end if;
  end loop;

  insert into public.financeiro_auditoria (
    clinic_id, actor_id, entity, entity_id, action, details, request_id
  ) values (
    p_clinic_id, p_user_id, 'financeiro_compra', v_purchase_id, 'criada',
    pg_catalog.jsonb_build_object(
      'operation', 'purchase_with_stock',
      'item_count', pg_catalog.jsonb_array_length(p_items),
      'mode', case
        when coalesce(p_confirm_distinct, false) then 'confirmed_distinct'
        when v_freight > 0 then 'with_freight'
        else 'standard'
      end,
      'idempotent', false
    ),
    p_request_id
  );

  return pg_catalog.jsonb_build_object(
    'compra_id', v_purchase_id,
    'lancamento_id', v_entry_id,
    'subtotal_itens', v_subtotal,
    'frete', v_freight,
    'total', v_total,
    'idempotente', false
  );
end;
$function$;

-- ---------------------------------------------------------------------------
-- Menor privilegio, RLS e contratos publicos do backend
-- ---------------------------------------------------------------------------

alter table public.financeiro_estoque_lotes enable row level security;
alter table public.financeiro_estoque_movimentos enable row level security;

revoke all on public.financeiro_estoque_lotes
  from public, anon, authenticated, service_role;
revoke all on public.financeiro_estoque_movimentos
  from public, anon, authenticated, service_role;
revoke all on public.financeiro_estoque_saldos
  from public, anon, authenticated, service_role;
revoke all on public.financeiro_estoque_produto_saldos
  from public, anon, authenticated, service_role;
revoke all on public.financeiro_compras_itens_pendentes_estoque
  from public, anon, authenticated, service_role;

grant select, insert on public.financeiro_estoque_lotes to service_role;
grant select, insert on public.financeiro_estoque_movimentos to service_role;
grant select on public.financeiro_estoque_saldos to service_role;
grant select on public.financeiro_estoque_produto_saldos to service_role;
grant select on public.financeiro_compras_itens_pendentes_estoque to service_role;

revoke all on function private.financeiro_unidade_canonica(text)
  from public, anon, authenticated, service_role;
revoke all on function private.financeiro_estoque_validar_movimento()
  from public, anon, authenticated, service_role;
revoke all on function private.financeiro_estoque_imutavel()
  from public, anon, authenticated, service_role;
revoke all on function private.financeiro_estoque_request_id(uuid,text)
  from public, anon, authenticated, service_role;

grant execute on function private.financeiro_unidade_canonica(text)
  to service_role;
grant execute on function private.financeiro_estoque_validar_movimento()
  to service_role;
grant execute on function private.financeiro_estoque_imutavel()
  to service_role;
grant execute on function private.financeiro_estoque_request_id(uuid,text)
  to service_role;
grant execute on function private.financeiro_purchase_fingerprint(
  uuid,date,text,text,integer,numeric,numeric,numeric,jsonb
) to service_role;

revoke all on function public.financeiro_criar_compra(
  uuid,uuid,uuid,date,text,text,smallint,text,text,jsonb,uuid,uuid,numeric,boolean,text,uuid
) from public, anon, authenticated, service_role;
revoke all on function public.financeiro_cancelar_compra(
  uuid,uuid,uuid,integer,text,uuid,uuid
) from public, anon, authenticated, service_role;
revoke all on function public.prontuario_substituir_produtos(
  uuid,uuid,text,text,uuid,integer,jsonb,uuid
) from public, anon, authenticated, service_role;
revoke all on function public.prontuario_salvar_rascunho_com_estoque(
  uuid,uuid,text,text,uuid,integer,uuid,uuid,uuid,text,text,jsonb,text,date,date,text,jsonb,jsonb,uuid
) from public, anon, authenticated, service_role;
revoke all on function public.financeiro_regularizar_item_compra_estoque(
  uuid,uuid,uuid,text,date,boolean,uuid,text,uuid
) from public, anon, authenticated, service_role;
revoke all on function public.financeiro_editar_produto(
  uuid,uuid,uuid,integer,uuid,text,text,text,text,text,numeric,numeric,text,boolean,text,uuid
) from public, anon, authenticated, service_role;
revoke all on function public.financeiro_arquivar_produto(
  uuid,uuid,uuid,integer,text,uuid
) from public, anon, authenticated, service_role;

grant execute on function public.financeiro_criar_compra(
  uuid,uuid,uuid,date,text,text,smallint,text,text,jsonb,uuid,uuid,numeric,boolean,text,uuid
) to service_role;
grant execute on function public.financeiro_cancelar_compra(
  uuid,uuid,uuid,integer,text,uuid,uuid
) to service_role;
grant execute on function public.prontuario_substituir_produtos(
  uuid,uuid,text,text,uuid,integer,jsonb,uuid
) to service_role;
grant execute on function public.prontuario_salvar_rascunho_com_estoque(
  uuid,uuid,text,text,uuid,integer,uuid,uuid,uuid,text,text,jsonb,text,date,date,text,jsonb,jsonb,uuid
) to service_role;
grant execute on function public.financeiro_regularizar_item_compra_estoque(
  uuid,uuid,uuid,text,date,boolean,uuid,text,uuid
) to service_role;
grant execute on function public.financeiro_editar_produto(
  uuid,uuid,uuid,integer,uuid,text,text,text,text,text,numeric,numeric,text,boolean,text,uuid
) to service_role;
grant execute on function public.financeiro_arquivar_produto(
  uuid,uuid,uuid,integer,text,uuid
) to service_role;

comment on table public.financeiro_estoque_movimentos is
  'Livro append-only de entradas, consumos e estornos. O saldo nunca e gravado diretamente.';
comment on view public.financeiro_estoque_saldos is
  'Saldo derivado por produto e lote, incluindo custo efetivo com frete proporcional.';
comment on column public.financeiro_compras.freight_amount is
  'Frete opcional vinculado ao fornecedor principal da compra; nao cria transportadora separada.';
comment on column public.financeiro_compra_itens.landed_unit_cost is
  'Custo unitario efetivo do item apos rateio deterministico do frete.';
comment on view public.financeiro_compras_itens_pendentes_estoque is
  'Fila explicita de itens legados controlados sem entrada; exige lote e validade informados manualmente.';

commit;

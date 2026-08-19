begin;

-- Gestão Financeira MVP — Ana Maria Jacob Estética
-- Dados financeiros são privados, multi-tenant por clinic_id e acessíveis
-- somente pela Edge Function autenticada com MFA. Nenhuma tabela abaixo é
-- exposta diretamente a anon/authenticated.

create schema if not exists private;

create or replace function private.financeiro_audit_details_are_safe(p_details jsonb)
returns boolean
language sql
immutable
strict
parallel safe
set search_path = ''
as $$
  select pg_catalog.jsonb_typeof(p_details) = 'object'
    and pg_catalog.pg_column_size(p_details) <= 4096
    and not exists (
      select 1
      from pg_catalog.jsonb_each(p_details) as item(key, value)
      where item.key not in (
        'source', 'mode', 'operation', 'target_kind', 'reason_code',
        'error_code', 'status_code', 'item_count', 'result_count',
        'idempotent', 'version', 'previous_status', 'new_status'
      )
      or pg_catalog.jsonb_typeof(item.value) not in ('string', 'number', 'boolean', 'null')
      or (
        pg_catalog.jsonb_typeof(item.value) = 'string'
        and (
          pg_catalog.length(item.value #>> '{}') > 160
          or (item.value #>> '{}') !~ '^[A-Za-z0-9_.:/-]*$'
        )
      )
    );
$$;

revoke all on function private.financeiro_audit_details_are_safe(jsonb)
  from public, anon, authenticated, service_role;
grant execute on function private.financeiro_audit_details_are_safe(jsonb)
  to service_role;

-- ---------------------------------------------------------------------------
-- Cadastro canônico de clientes
-- ---------------------------------------------------------------------------

alter table public.patients
  add column if not exists cpf text,
  add column if not exists search_name text,
  add column if not exists archived_at timestamptz,
  add column if not exists version integer not null default 1,
  add column if not exists updated_by uuid references auth.users(id),
  add column if not exists idempotency_key uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.patients'::regclass
      and conname = 'patients_cpf_format_check'
  ) then
    alter table public.patients
      add constraint patients_cpf_format_check
      check (cpf is null or cpf ~ '^[0-9]{11}$');
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.patients'::regclass
      and conname = 'patients_search_name_check'
  ) then
    alter table public.patients
      add constraint patients_search_name_check
      check (search_name is null or char_length(search_name) between 2 and 160);
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.patients'::regclass
      and conname = 'patients_version_check'
  ) then
    alter table public.patients
      add constraint patients_version_check check (version > 0);
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.patients'::regclass
      and conname = 'patients_clinic_id_id_key'
  ) then
    alter table public.patients
      add constraint patients_clinic_id_id_key unique (clinic_id, id);
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.patients'::regclass
      and conname = 'patients_clinic_id_idempotency_key_key'
  ) then
    alter table public.patients
      add constraint patients_clinic_id_idempotency_key_key
      unique (clinic_id, idempotency_key);
  end if;
end
$$;

create unique index if not exists patients_clinic_cpf_unique
  on public.patients (clinic_id, cpf)
  where cpf is not null and archived_at is null;
create index if not exists patients_clinic_search_name_idx
  on public.patients (clinic_id, search_name)
  where archived_at is null;
create unique index if not exists patients_clinic_phone_unique
  on public.patients (clinic_id, phone)
  where phone is not null and archived_at is null;
create index if not exists patients_created_by_idx
  on public.patients (created_by);
create index if not exists patients_updated_by_idx
  on public.patients (updated_by)
  where updated_by is not null;

drop policy if exists patients_select on public.patients;
drop policy if exists patients_write on public.patients;
drop policy if exists patients_update on public.patients;
alter table public.patients enable row level security;
revoke all on public.patients from public, anon, authenticated;
revoke all on public.patients from service_role;
grant select on public.patients to service_role;

create table public.patient_source_links (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete restrict,
  patient_id uuid not null,
  source_kind text not null check (
    source_kind in ('anamnese', 'documento_clinico', 'agendamento')
  ),
  source_id uuid not null,
  match_method text not null check (
    match_method in ('cpf_confirmado', 'telefone_confirmado', 'manual')
  ),
  status text not null default 'confirmado' check (
    status in ('candidato', 'confirmado', 'rejeitado', 'desfeito')
  ),
  confirmed_by uuid references auth.users(id),
  confirmed_at timestamptz,
  reason text check (reason is null or char_length(btrim(reason)) between 3 and 500),
  idempotency_key uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint patient_source_links_patient_fk
    foreign key (clinic_id, patient_id)
    references public.patients (clinic_id, id) on delete restrict,
  constraint patient_source_links_source_unique
    unique (clinic_id, source_kind, source_id),
  constraint patient_source_links_idempotency_unique
    unique (clinic_id, idempotency_key)
);

create index patient_source_links_patient_idx
  on public.patient_source_links (clinic_id, patient_id, status);
create index patient_source_links_confirmed_by_idx
  on public.patient_source_links (confirmed_by)
  where confirmed_by is not null;

-- ---------------------------------------------------------------------------
-- Catálogos empresariais
-- ---------------------------------------------------------------------------

create table public.financeiro_formas_pagamento (
  code text primary key check (code ~ '^[a-z0-9_]{2,40}$'),
  label text not null check (char_length(btrim(label)) between 2 and 80),
  sort_order smallint not null check (sort_order > 0),
  active boolean not null default true
);

insert into public.financeiro_formas_pagamento (code, label, sort_order)
values
  ('pix', 'PIX', 1),
  ('dinheiro', 'Dinheiro', 2),
  ('cartao_debito', 'Cartão de débito', 3),
  ('cartao_credito', 'Cartão de crédito', 4),
  ('boleto', 'Boleto', 5),
  ('transferencia', 'Transferência', 6),
  ('outro', 'Outro', 7)
on conflict (code) do update
set label = excluded.label,
    sort_order = excluded.sort_order;

create table public.financeiro_fornecedores (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete restrict,
  name text not null check (char_length(btrim(name)) between 2 and 160),
  document text check (document is null or document ~ '^[0-9]{11,14}$'),
  phone text check (phone is null or phone ~ '^\+55[1-9][0-9]{9,10}$'),
  email text check (
    email is null or (
      char_length(email) <= 254 and
      email ~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    )
  ),
  active boolean not null default true,
  archived_at timestamptz,
  created_by uuid not null references auth.users(id),
  updated_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1 check (version > 0),
  constraint financeiro_fornecedores_clinic_id_id_key unique (clinic_id, id)
);

create unique index financeiro_fornecedores_name_unique
  on public.financeiro_fornecedores (clinic_id, lower(btrim(name)))
  where archived_at is null;
create index financeiro_fornecedores_created_by_idx
  on public.financeiro_fornecedores (created_by);
create index financeiro_fornecedores_updated_by_idx
  on public.financeiro_fornecedores (updated_by)
  where updated_by is not null;

create table public.financeiro_marcas (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete restrict,
  name text not null check (char_length(btrim(name)) between 2 and 120),
  active boolean not null default true,
  archived_at timestamptz,
  created_by uuid not null references auth.users(id),
  updated_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1 check (version > 0),
  constraint financeiro_marcas_clinic_id_id_key unique (clinic_id, id)
);

create unique index financeiro_marcas_name_unique
  on public.financeiro_marcas (clinic_id, lower(btrim(name)))
  where archived_at is null;
create index financeiro_marcas_created_by_idx
  on public.financeiro_marcas (created_by);
create index financeiro_marcas_updated_by_idx
  on public.financeiro_marcas (updated_by)
  where updated_by is not null;

create table public.financeiro_produtos (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete restrict,
  brand_id uuid,
  name text not null check (char_length(btrim(name)) between 2 and 160),
  product_type text not null check (
    product_type in (
      'injetavel', 'medicamento', 'dermocosmetico', 'descartavel',
      'epi', 'limpeza', 'revenda', 'outro'
    )
  ),
  unit text not null check (unit in ('un', 'cx', 'frasco', 'seringa', 'ml', 'mg', 'g', 'kit')),
  reference_cost numeric(14,2) check (reference_cost is null or reference_cost >= 0),
  sale_price numeric(14,2) check (sale_price is null or sale_price >= 0),
  anvisa_registration text check (
    anvisa_registration is null or char_length(btrim(anvisa_registration)) <= 80
  ),
  stock_control boolean not null default false,
  active boolean not null default true,
  archived_at timestamptz,
  created_by uuid not null references auth.users(id),
  updated_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1 check (version > 0),
  constraint financeiro_produtos_clinic_id_id_key unique (clinic_id, id),
  constraint financeiro_produtos_brand_fk
    foreign key (clinic_id, brand_id)
    references public.financeiro_marcas (clinic_id, id) on delete restrict
);

create unique index financeiro_produtos_name_unique
  on public.financeiro_produtos (clinic_id, lower(btrim(name)), coalesce(brand_id, '00000000-0000-0000-0000-000000000000'::uuid))
  where archived_at is null;
create index financeiro_produtos_brand_idx
  on public.financeiro_produtos (clinic_id, brand_id)
  where brand_id is not null;
create index financeiro_produtos_created_by_idx
  on public.financeiro_produtos (created_by);
create index financeiro_produtos_updated_by_idx
  on public.financeiro_produtos (updated_by)
  where updated_by is not null;

-- ---------------------------------------------------------------------------
-- Receitas, despesas, pagamentos e compras
-- ---------------------------------------------------------------------------

create table public.financeiro_lancamentos (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete restrict,
  patient_id uuid,
  supplier_id uuid,
  entry_type text not null check (entry_type in ('receita', 'despesa')),
  origin text not null check (
    origin in ('atendimento', 'produto', 'compra', 'operacional', 'ajuste')
  ),
  description text not null check (char_length(btrim(description)) between 2 and 200),
  category text not null check (char_length(btrim(category)) between 2 and 100),
  competence_date date not null,
  due_date date not null,
  total_amount numeric(14,2) not null check (total_amount > 0 and total_amount <= 999999999999.99),
  payment_condition text not null check (
    payment_condition in ('avista', 'parcelado', 'entrada_saldo')
  ),
  installments smallint not null default 1 check (installments between 1 and 120),
  state text not null default 'ativo' check (state in ('ativo', 'cancelado')),
  notes text check (notes is null or char_length(notes) <= 1000),
  idempotency_key uuid not null,
  created_by uuid not null references auth.users(id),
  updated_by uuid references auth.users(id),
  cancelled_by uuid references auth.users(id),
  cancelled_at timestamptz,
  cancellation_reason text check (
    cancellation_reason is null or char_length(btrim(cancellation_reason)) between 3 and 500
  ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1 check (version > 0),
  constraint financeiro_lancamentos_clinic_id_id_key unique (clinic_id, id),
  constraint financeiro_lancamentos_idempotency_unique unique (clinic_id, idempotency_key),
  constraint financeiro_lancamentos_patient_fk
    foreign key (clinic_id, patient_id)
    references public.patients (clinic_id, id) on delete restrict,
  constraint financeiro_lancamentos_supplier_fk
    foreign key (clinic_id, supplier_id)
    references public.financeiro_fornecedores (clinic_id, id) on delete restrict,
  constraint financeiro_lancamentos_party_check check (
    (entry_type = 'receita' and (patient_id is not null or origin = 'ajuste')) or
    (entry_type = 'despesa')
  ),
  constraint financeiro_lancamentos_cancel_check check (
    (state = 'ativo' and cancelled_at is null and cancelled_by is null and cancellation_reason is null) or
    (state = 'cancelado' and cancelled_at is not null and cancelled_by is not null and cancellation_reason is not null)
  )
);

create index financeiro_lancamentos_period_idx
  on public.financeiro_lancamentos (clinic_id, competence_date desc, entry_type)
  where state = 'ativo';
create index financeiro_lancamentos_due_idx
  on public.financeiro_lancamentos (clinic_id, due_date, entry_type)
  where state = 'ativo';
create index financeiro_lancamentos_patient_idx
  on public.financeiro_lancamentos (clinic_id, patient_id, competence_date desc)
  where patient_id is not null;
create index financeiro_lancamentos_supplier_idx
  on public.financeiro_lancamentos (clinic_id, supplier_id, competence_date desc)
  where supplier_id is not null;
create index financeiro_lancamentos_created_by_idx
  on public.financeiro_lancamentos (created_by);
create index financeiro_lancamentos_updated_by_idx
  on public.financeiro_lancamentos (updated_by)
  where updated_by is not null;
create index financeiro_lancamentos_cancelled_by_idx
  on public.financeiro_lancamentos (cancelled_by)
  where cancelled_by is not null;

create table public.financeiro_pagamentos (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete restrict,
  entry_id uuid not null,
  movement_type text not null check (movement_type in ('pagamento', 'estorno')),
  payment_method text not null references public.financeiro_formas_pagamento(code) on delete restrict,
  amount numeric(14,2) not null check (amount > 0 and amount <= 999999999999.99),
  paid_at timestamptz not null,
  installments smallint not null default 1 check (installments between 1 and 120),
  reference text check (reference is null or char_length(reference) <= 120),
  reversed_payment_id uuid,
  idempotency_key uuid not null,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  constraint financeiro_pagamentos_clinic_id_id_key unique (clinic_id, id),
  constraint financeiro_pagamentos_idempotency_unique unique (clinic_id, idempotency_key),
  constraint financeiro_pagamentos_entry_fk
    foreign key (clinic_id, entry_id)
    references public.financeiro_lancamentos (clinic_id, id) on delete restrict,
  constraint financeiro_pagamentos_reversed_fk
    foreign key (clinic_id, reversed_payment_id)
    references public.financeiro_pagamentos (clinic_id, id) on delete restrict,
  constraint financeiro_pagamentos_reversal_check check (
    (movement_type = 'pagamento' and reversed_payment_id is null) or
    (movement_type = 'estorno' and reversed_payment_id is not null)
  )
);

create index financeiro_pagamentos_entry_idx
  on public.financeiro_pagamentos (clinic_id, entry_id, paid_at);
create index financeiro_pagamentos_paid_at_idx
  on public.financeiro_pagamentos (clinic_id, paid_at desc);
create index financeiro_pagamentos_reversal_idx
  on public.financeiro_pagamentos (clinic_id, reversed_payment_id)
  where reversed_payment_id is not null;
create index financeiro_pagamentos_method_idx
  on public.financeiro_pagamentos (payment_method);
create index financeiro_pagamentos_created_by_idx
  on public.financeiro_pagamentos (created_by);

create table public.financeiro_compras (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete restrict,
  supplier_id uuid not null,
  expense_entry_id uuid not null,
  purchase_date date not null,
  invoice_number text check (invoice_number is null or char_length(btrim(invoice_number)) <= 80),
  payment_condition text not null check (
    payment_condition in ('avista', 'parcelado', 'entrada_saldo')
  ),
  installments smallint not null default 1 check (installments between 1 and 120),
  total_amount numeric(14,2) not null check (total_amount > 0),
  state text not null default 'registrada' check (state in ('registrada', 'cancelada')),
  notes text check (notes is null or char_length(notes) <= 1000),
  idempotency_key uuid not null,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  constraint financeiro_compras_clinic_id_id_key unique (clinic_id, id),
  constraint financeiro_compras_idempotency_unique unique (clinic_id, idempotency_key),
  constraint financeiro_compras_entry_unique unique (clinic_id, expense_entry_id),
  constraint financeiro_compras_supplier_fk
    foreign key (clinic_id, supplier_id)
    references public.financeiro_fornecedores (clinic_id, id) on delete restrict,
  constraint financeiro_compras_entry_fk
    foreign key (clinic_id, expense_entry_id)
    references public.financeiro_lancamentos (clinic_id, id) on delete restrict
);

create unique index financeiro_compras_invoice_unique
  on public.financeiro_compras (clinic_id, supplier_id, lower(btrim(invoice_number)))
  where invoice_number is not null and state = 'registrada';
create index financeiro_compras_period_idx
  on public.financeiro_compras (clinic_id, purchase_date desc);
create index financeiro_compras_supplier_idx
  on public.financeiro_compras (clinic_id, supplier_id);
create index financeiro_compras_created_by_idx
  on public.financeiro_compras (created_by);

create table public.financeiro_compra_itens (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete restrict,
  purchase_id uuid not null,
  product_id uuid not null,
  quantity numeric(14,4) not null check (quantity > 0 and quantity <= 9999999999.9999),
  unit_cost numeric(14,4) not null check (unit_cost >= 0 and unit_cost <= 9999999999.9999),
  total_amount numeric(14,2) generated always as (round(quantity * unit_cost, 2)) stored,
  created_at timestamptz not null default now(),
  constraint financeiro_compra_itens_purchase_fk
    foreign key (clinic_id, purchase_id)
    references public.financeiro_compras (clinic_id, id) on delete restrict,
  constraint financeiro_compra_itens_product_fk
    foreign key (clinic_id, product_id)
    references public.financeiro_produtos (clinic_id, id) on delete restrict
);

create index financeiro_compra_itens_purchase_idx
  on public.financeiro_compra_itens (clinic_id, purchase_id);
create index financeiro_compra_itens_product_idx
  on public.financeiro_compra_itens (clinic_id, product_id);

create table public.financeiro_auditoria (
  id bigint generated always as identity primary key,
  clinic_id uuid not null references public.clinics(id) on delete restrict,
  actor_id uuid not null references auth.users(id),
  entity text not null check (entity ~ '^[a-z0-9_.:-]{2,80}$'),
  entity_id uuid,
  action text not null check (action ~ '^[a-z0-9_.:-]{2,100}$'),
  details jsonb not null default '{}'::jsonb check (
    private.financeiro_audit_details_are_safe(details)
  ),
  request_id uuid not null,
  created_at timestamptz not null default now()
);

create index financeiro_auditoria_clinic_time_idx
  on public.financeiro_auditoria (clinic_id, created_at desc);
create index financeiro_auditoria_entity_idx
  on public.financeiro_auditoria (clinic_id, entity, entity_id, created_at desc);
create index financeiro_auditoria_actor_idx
  on public.financeiro_auditoria (actor_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Triggers de integridade e imutabilidade
-- ---------------------------------------------------------------------------

create or replace function private.financeiro_touch_row()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  new.version := old.version + 1;
  return new;
end;
$$;

revoke all on function private.financeiro_touch_row() from public, anon, authenticated;

create trigger financeiro_fornecedores_touch
before update on public.financeiro_fornecedores
for each row execute function private.financeiro_touch_row();

create trigger financeiro_marcas_touch
before update on public.financeiro_marcas
for each row execute function private.financeiro_touch_row();

create trigger financeiro_produtos_touch
before update on public.financeiro_produtos
for each row execute function private.financeiro_touch_row();

create trigger financeiro_lancamentos_touch
before update on public.financeiro_lancamentos
for each row execute function private.financeiro_touch_row();

create or replace function private.financeiro_guard_purchase_entry()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.origin = 'compra' and (
    new.origin is distinct from old.origin
    or (old.state <> 'cancelado' and new.state = 'cancelado')
  ) then
    raise exception 'purchase_cancel_requires_full_workflow'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

revoke all on function private.financeiro_guard_purchase_entry()
  from public, anon, authenticated, service_role;

create trigger financeiro_lancamentos_purchase_guard
before update on public.financeiro_lancamentos
for each row execute function private.financeiro_guard_purchase_entry();

create or replace function private.financeiro_block_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'registro financeiro imutavel; use evento compensatorio'
    using errcode = '55000';
end;
$$;

revoke all on function private.financeiro_block_mutation() from public, anon, authenticated;

create trigger financeiro_pagamentos_immutable
before update or delete on public.financeiro_pagamentos
for each row execute function private.financeiro_block_mutation();

create trigger financeiro_compra_itens_immutable
before update or delete on public.financeiro_compra_itens
for each row execute function private.financeiro_block_mutation();

create trigger financeiro_auditoria_immutable
before update or delete on public.financeiro_auditoria
for each row execute function private.financeiro_block_mutation();

-- ---------------------------------------------------------------------------
-- Views de reconciliação e dashboard
-- ---------------------------------------------------------------------------

create or replace view public.financeiro_lancamentos_resumo
with (security_invoker = true)
as
with payment_totals as (
  select
    clinic_id,
    entry_id,
    coalesce(sum(case when movement_type = 'pagamento' then amount else -amount end), 0)::numeric(14,2) as paid_amount
  from public.financeiro_pagamentos
  group by clinic_id, entry_id
)
select
  e.id,
  e.clinic_id,
  e.patient_id,
  e.supplier_id,
  e.entry_type,
  e.origin,
  e.description,
  e.category,
  e.competence_date,
  e.due_date,
  e.total_amount,
  greatest(coalesce(p.paid_amount, 0), 0)::numeric(14,2) as paid_amount,
  greatest(e.total_amount - coalesce(p.paid_amount, 0), 0)::numeric(14,2) as balance,
  e.payment_condition,
  e.installments,
  case
    when e.state = 'cancelado' then 'cancelado'
    when coalesce(p.paid_amount, 0) >= e.total_amount then 'pago'
    when coalesce(p.paid_amount, 0) > 0 then 'parcial'
    when e.due_date < (now() at time zone 'America/Sao_Paulo')::date then 'vencido'
    else 'pendente'
  end as calculated_status,
  e.state,
  e.notes,
  e.created_by,
  e.created_at,
  e.updated_at,
  e.version
from public.financeiro_lancamentos e
left join payment_totals p
  on p.clinic_id = e.clinic_id and p.entry_id = e.id;

create or replace view public.financeiro_fluxo_mensal
with (security_invoker = true)
as
with competence as (
  select
    clinic_id,
    date_trunc('month', competence_date)::date as month,
    sum(total_amount) filter (where entry_type = 'receita' and state = 'ativo')::numeric(14,2) as billed_revenue,
    sum(total_amount) filter (where entry_type = 'despesa' and state = 'ativo')::numeric(14,2) as incurred_expense
  from public.financeiro_lancamentos
  group by clinic_id, date_trunc('month', competence_date)::date
), cash as (
  select
    e.clinic_id,
    date_trunc('month', p.paid_at at time zone 'America/Sao_Paulo')::date as month,
    sum(case when p.movement_type = 'pagamento' then p.amount else -p.amount end)
      filter (where e.entry_type = 'receita')::numeric(14,2) as received_revenue,
    sum(case when p.movement_type = 'pagamento' then p.amount else -p.amount end)
      filter (where e.entry_type = 'despesa')::numeric(14,2) as paid_expense
  from public.financeiro_pagamentos p
  join public.financeiro_lancamentos e
    on e.clinic_id = p.clinic_id and e.id = p.entry_id
  group by e.clinic_id,
    date_trunc('month', p.paid_at at time zone 'America/Sao_Paulo')::date
), months as (
  select clinic_id, month from competence
  union
  select clinic_id, month from cash
)
select
  m.clinic_id,
  m.month,
  coalesce(c.billed_revenue, 0)::numeric(14,2) as billed_revenue,
  coalesce(x.received_revenue, 0)::numeric(14,2) as received_revenue,
  coalesce(c.incurred_expense, 0)::numeric(14,2) as incurred_expense,
  coalesce(x.paid_expense, 0)::numeric(14,2) as paid_expense,
  (coalesce(x.received_revenue, 0) - coalesce(x.paid_expense, 0))::numeric(14,2) as net_cash_flow
from months m
left join competence c on c.clinic_id = m.clinic_id and c.month = m.month
left join cash x on x.clinic_id = m.clinic_id and x.month = m.month;

-- ---------------------------------------------------------------------------
-- RPCs transacionais, exclusivas do backend
-- ---------------------------------------------------------------------------

create or replace function public.financeiro_criar_cliente_com_vinculo(
  p_clinic_id uuid,
  p_user_id uuid,
  p_full_name text,
  p_birth_date date,
  p_cpf text,
  p_phone text,
  p_email text,
  p_emergency_phone text,
  p_source_kind text,
  p_source_id uuid,
  p_idempotency_key uuid,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_patient public.patients%rowtype;
  v_link public.patient_source_links%rowtype;
  v_patient_id uuid;
  v_source_link_id uuid;
  v_full_name text := nullif(pg_catalog.btrim(p_full_name), '');
  v_search_name text;
  v_cpf text := nullif(pg_catalog.btrim(p_cpf), '');
  v_phone text := nullif(pg_catalog.btrim(p_phone), '');
  v_email text := nullif(pg_catalog.lower(pg_catalog.btrim(p_email)), '');
  v_emergency_phone text := nullif(pg_catalog.btrim(p_emergency_phone), '');
  v_source_kind text := nullif(pg_catalog.btrim(p_source_kind), '');
begin
  if p_clinic_id is null or p_user_id is null
     or p_idempotency_key is null or p_request_id is null then
    raise exception 'parametros_obrigatorios_invalidos' using errcode = '22023';
  end if;
  if v_full_name is null or pg_catalog.char_length(v_full_name) not between 2 and 160 then
    raise exception 'nome_invalido' using errcode = '22023';
  end if;
  if p_birth_date is not null
     and p_birth_date > (now() at time zone 'America/Sao_Paulo')::date then
    raise exception 'data_nascimento_invalida' using errcode = '22023';
  end if;
  if v_cpf is not null and v_cpf !~ '^[0-9]{11}$' then
    raise exception 'cpf_invalido' using errcode = '22023';
  end if;
  if v_phone is not null and v_phone !~ '^\+55[1-9][0-9]{9,10}$' then
    raise exception 'telefone_invalido' using errcode = '22023';
  end if;
  if v_emergency_phone is not null
     and v_emergency_phone !~ '^\+55[1-9][0-9]{9,10}$' then
    raise exception 'telefone_emergencia_invalido' using errcode = '22023';
  end if;
  if v_email is not null and (
    pg_catalog.char_length(v_email) > 254
    or v_email !~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
  ) then
    raise exception 'email_invalido' using errcode = '22023';
  end if;
  if (v_source_kind is null) <> (p_source_id is null) then
    raise exception 'source_pair_invalid' using errcode = '22023';
  end if;
  if v_source_kind is not null
     and v_source_kind not in ('anamnese', 'documento_clinico', 'agendamento') then
    raise exception 'source_pair_invalid' using errcode = '22023';
  end if;

  v_search_name := nullif(
    pg_catalog.btrim(
      pg_catalog.regexp_replace(
        pg_catalog.regexp_replace(
          pg_catalog.translate(
            pg_catalog.lower(v_full_name),
            'áàâãäéèêëíìîïóòôõöúùûüçñ',
            'aaaaaeeeeiiiiooooouuuucn'
          ),
          '[^a-z0-9 ]', ' ', 'g'
        ),
        '[[:space:]]+', ' ', 'g'
      )
    ),
    ''
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      p_clinic_id::text || ':patients:idempotency:' || p_idempotency_key::text,
      0
    )
  );
  if v_cpf is not null then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(p_clinic_id::text || ':patients:cpf:' || v_cpf, 0)
    );
  end if;
  if v_phone is not null then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(p_clinic_id::text || ':patients:phone:' || v_phone, 0)
    );
  end if;
  if v_source_kind is not null then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        p_clinic_id::text || ':patient_source:' || v_source_kind || ':' || p_source_id::text,
        0
      )
    );
  end if;

  select * into v_patient
  from public.patients
  where clinic_id = p_clinic_id and idempotency_key = p_idempotency_key;

  if found then
    select * into v_link
    from public.patient_source_links
    where clinic_id = p_clinic_id and idempotency_key = p_idempotency_key;

    if v_patient.archived_at is not null
       or v_patient.full_name is distinct from v_full_name
       or v_patient.birth_date is distinct from p_birth_date
       or v_patient.cpf is distinct from v_cpf
       or v_patient.phone is distinct from v_phone
       or v_patient.email is distinct from v_email
       or v_patient.emergency_phone is distinct from v_emergency_phone
       or v_patient.created_by is distinct from p_user_id
       or (
         v_source_kind is null
         and v_link.id is not null
       )
       or (
         v_source_kind is not null
         and (
           v_link.id is null
           or v_link.patient_id is distinct from v_patient.id
           or v_link.source_kind is distinct from v_source_kind
           or v_link.source_id is distinct from p_source_id
           or v_link.confirmed_by is distinct from p_user_id
         )
       ) then
      raise exception 'idempotency_key_reused' using errcode = '22023';
    end if;

    return pg_catalog.jsonb_build_object(
      'patient_id', v_patient.id,
      'source_link_id', v_link.id,
      'idempotent', true
    );
  end if;

  if v_cpf is not null or v_phone is not null then
    perform 1
    from public.patients
    where clinic_id = p_clinic_id
      and archived_at is null
      and (
        (v_cpf is not null and cpf = v_cpf)
        or (v_phone is not null and phone = v_phone)
      );
    if found then
      raise exception 'possible_duplicate' using errcode = '23505';
    end if;
  end if;

  if v_source_kind is not null then
    perform 1
    from public.patient_source_links
    where clinic_id = p_clinic_id
      and source_kind = v_source_kind
      and source_id = p_source_id
    for update;
    if found then
      raise exception 'source_already_linked' using errcode = '23505';
    end if;
  end if;

  insert into public.patients (
    clinic_id, full_name, search_name, birth_date, cpf, phone, email,
    emergency_phone, status, idempotency_key, created_by, updated_by
  ) values (
    p_clinic_id, v_full_name, v_search_name, p_birth_date, v_cpf, v_phone,
    v_email, v_emergency_phone, 'active', p_idempotency_key, p_user_id, p_user_id
  )
  returning id into v_patient_id;

  if v_source_kind is not null then
    insert into public.patient_source_links (
      clinic_id, patient_id, source_kind, source_id, match_method, status,
      confirmed_by, confirmed_at, reason, idempotency_key
    ) values (
      p_clinic_id, v_patient_id, v_source_kind, p_source_id, 'manual',
      'confirmado', p_user_id, now(),
      'Vínculo confirmado manualmente no módulo financeiro.',
      p_idempotency_key
    )
    returning id into v_source_link_id;
  end if;

  insert into public.financeiro_auditoria (
    clinic_id, actor_id, entity, entity_id, action, details, request_id
  ) values (
    p_clinic_id, p_user_id, 'paciente', v_patient_id, 'criado',
    pg_catalog.jsonb_build_object(
      'source', coalesce(v_source_kind, 'cadastro_manual')
    ),
    p_request_id
  );

  if v_source_link_id is not null then
    insert into public.financeiro_auditoria (
      clinic_id, actor_id, entity, entity_id, action, details, request_id
    ) values (
      p_clinic_id, p_user_id, 'paciente_vinculo', v_source_link_id,
      'confirmado', pg_catalog.jsonb_build_object('source', v_source_kind),
      p_request_id
    );
  end if;

  return pg_catalog.jsonb_build_object(
    'patient_id', v_patient_id,
    'source_link_id', v_source_link_id,
    'idempotent', false
  );
end;
$$;

create or replace function public.financeiro_resumo(
  p_clinic_id uuid,
  p_from date,
  p_through date
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_received numeric;
  v_paid numeric;
  v_receivable numeric;
  v_payable numeric;
  v_billed numeric;
  v_incurred numeric;
begin
  if p_clinic_id is null then
    raise exception 'parametros_obrigatorios_invalidos' using errcode = '22023';
  end if;
  if p_from is not null and p_through is not null and p_from > p_through then
    raise exception 'invalid_period' using errcode = '22023';
  end if;

  select
    coalesce(sum(paid_amount) filter (where entry_type = 'receita'), 0),
    coalesce(sum(paid_amount) filter (where entry_type = 'despesa'), 0),
    coalesce(sum(balance) filter (where entry_type = 'receita'), 0),
    coalesce(sum(balance) filter (where entry_type = 'despesa'), 0),
    coalesce(sum(total_amount) filter (where entry_type = 'receita'), 0),
    coalesce(sum(total_amount) filter (where entry_type = 'despesa'), 0)
  into v_received, v_paid, v_receivable, v_payable, v_billed, v_incurred
  from public.financeiro_lancamentos_resumo
  where clinic_id = p_clinic_id
    and state = 'ativo'
    and (p_from is null or competence_date >= p_from)
    and (p_through is null or competence_date <= p_through);

  return pg_catalog.jsonb_build_object(
    'receita_recebida', v_received,
    'despesa_paga', v_paid,
    'fluxo_liquido', v_received - v_paid,
    'contas_receber', v_receivable,
    'contas_pagar', v_payable,
    'receita_faturada', v_billed,
    'despesa_incorrida', v_incurred
  );
end;
$$;

create or replace function public.financeiro_criar_lancamento(
  p_clinic_id uuid,
  p_user_id uuid,
  p_patient_id uuid,
  p_supplier_id uuid,
  p_entry_type text,
  p_origin text,
  p_description text,
  p_category text,
  p_competence_date date,
  p_due_date date,
  p_total_amount numeric,
  p_payment_condition text,
  p_installments smallint,
  p_notes text,
  p_idempotency_key uuid,
  p_request_id uuid
)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_id uuid;
  v_existing public.financeiro_lancamentos%rowtype;
  v_description text := pg_catalog.btrim(p_description);
  v_category text := pg_catalog.btrim(p_category);
  v_notes text := nullif(pg_catalog.btrim(p_notes), '');
  v_total numeric(14,2) := round(p_total_amount, 2);
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      p_clinic_id::text || ':financeiro_lancamentos:' || p_idempotency_key::text,
      0
    )
  );

  select * into v_existing
  from public.financeiro_lancamentos
  where clinic_id = p_clinic_id and idempotency_key = p_idempotency_key;
  if found then
    if v_existing.patient_id is distinct from p_patient_id
       or v_existing.supplier_id is distinct from p_supplier_id
       or v_existing.entry_type is distinct from p_entry_type
       or v_existing.origin is distinct from p_origin
       or v_existing.description is distinct from v_description
       or v_existing.category is distinct from v_category
       or v_existing.competence_date is distinct from p_competence_date
       or v_existing.due_date is distinct from p_due_date
       or v_existing.total_amount is distinct from v_total
       or v_existing.payment_condition is distinct from p_payment_condition
       or v_existing.installments is distinct from p_installments
       or v_existing.notes is distinct from v_notes
       or v_existing.created_by is distinct from p_user_id then
      raise exception 'idempotency_key_reused' using errcode = '22023';
    end if;
    return v_existing.id;
  end if;

  insert into public.financeiro_lancamentos (
    clinic_id, patient_id, supplier_id, entry_type, origin, description,
    category, competence_date, due_date, total_amount, payment_condition,
    installments, notes, idempotency_key, created_by, updated_by
  ) values (
    p_clinic_id, p_patient_id, p_supplier_id, p_entry_type, p_origin,
    v_description, v_category, p_competence_date, p_due_date,
    v_total, p_payment_condition, p_installments,
    v_notes, p_idempotency_key, p_user_id, p_user_id
  ) returning id into v_id;

  insert into public.financeiro_auditoria (
    clinic_id, actor_id, entity, entity_id, action, details, request_id
  ) values (
    p_clinic_id, p_user_id, 'financeiro_lancamento', v_id, 'criado',
    jsonb_build_object('target_kind', p_entry_type, 'source', p_origin), p_request_id
  );
  return v_id;
end;
$$;

create or replace function public.financeiro_registrar_pagamento(
  p_clinic_id uuid,
  p_user_id uuid,
  p_entry_id uuid,
  p_movement_type text,
  p_payment_method text,
  p_amount numeric,
  p_paid_at timestamptz,
  p_installments smallint,
  p_reference text,
  p_reversed_payment_id uuid,
  p_idempotency_key uuid,
  p_request_id uuid
)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_id uuid;
  v_entry public.financeiro_lancamentos%rowtype;
  v_paid numeric(14,2);
  v_existing public.financeiro_pagamentos%rowtype;
  v_original public.financeiro_pagamentos%rowtype;
  v_reversed numeric(14,2);
  v_amount numeric(14,2) := round(p_amount, 2);
  v_reference text := nullif(pg_catalog.btrim(p_reference), '');
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      p_clinic_id::text || ':financeiro_pagamentos:' || p_idempotency_key::text,
      0
    )
  );

  select * into v_existing
  from public.financeiro_pagamentos
  where clinic_id = p_clinic_id and idempotency_key = p_idempotency_key;
  if found then
    if v_existing.entry_id is distinct from p_entry_id
       or v_existing.movement_type is distinct from p_movement_type
       or v_existing.payment_method is distinct from p_payment_method
       or v_existing.amount is distinct from v_amount
       or v_existing.paid_at is distinct from p_paid_at
       or v_existing.installments is distinct from p_installments
       or v_existing.reference is distinct from v_reference
       or v_existing.reversed_payment_id is distinct from p_reversed_payment_id
       or v_existing.created_by is distinct from p_user_id then
      raise exception 'idempotency_key_reused' using errcode = '22023';
    end if;
    return v_existing.id;
  end if;

  select * into v_entry
  from public.financeiro_lancamentos
  where clinic_id = p_clinic_id and id = p_entry_id
  for update;
  if not found then raise exception 'lancamento_nao_encontrado' using errcode = 'P0002'; end if;
  if v_entry.state <> 'ativo' then raise exception 'lancamento_inativo' using errcode = '55000'; end if;

  select coalesce(sum(case when movement_type = 'pagamento' then amount else -amount end), 0)
    into v_paid
  from public.financeiro_pagamentos
  where clinic_id = p_clinic_id and entry_id = p_entry_id;

  if p_movement_type = 'pagamento' then
    if p_reversed_payment_id is not null then raise exception 'estorno_invalido' using errcode = '22023'; end if;
    if v_amount > round(v_entry.total_amount - v_paid, 2) then
      raise exception 'valor_excede_saldo' using errcode = '22003';
    end if;
  elsif p_movement_type = 'estorno' then
    select * into v_original
    from public.financeiro_pagamentos
    where clinic_id = p_clinic_id and id = p_reversed_payment_id
      and entry_id = p_entry_id and movement_type = 'pagamento'
    for share;
    if not found then raise exception 'pagamento_original_nao_encontrado' using errcode = 'P0002'; end if;
    select coalesce(sum(amount), 0) into v_reversed
    from public.financeiro_pagamentos
    where clinic_id = p_clinic_id and reversed_payment_id = p_reversed_payment_id
      and movement_type = 'estorno';
    if v_amount > round(v_original.amount - v_reversed, 2) then
      raise exception 'valor_excede_estornavel' using errcode = '22003';
    end if;
  else
    raise exception 'tipo_movimento_invalido' using errcode = '22023';
  end if;

  insert into public.financeiro_pagamentos (
    clinic_id, entry_id, movement_type, payment_method, amount, paid_at,
    installments, reference, reversed_payment_id, idempotency_key, created_by
  ) values (
    p_clinic_id, p_entry_id, p_movement_type, p_payment_method,
    v_amount, p_paid_at, p_installments,
    v_reference, p_reversed_payment_id,
    p_idempotency_key, p_user_id
  ) returning id into v_id;

  update public.financeiro_lancamentos
  set updated_by = p_user_id
  where clinic_id = p_clinic_id and id = p_entry_id;

  insert into public.financeiro_auditoria (
    clinic_id, actor_id, entity, entity_id, action, details, request_id
  ) values (
    p_clinic_id, p_user_id, 'financeiro_pagamento', v_id, p_movement_type,
    jsonb_build_object('mode', p_payment_method), p_request_id
  );
  return v_id;
end;
$$;

create or replace function public.financeiro_cancelar_lancamento(
  p_clinic_id uuid,
  p_user_id uuid,
  p_entry_id uuid,
  p_reason text,
  p_request_id uuid
)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v_paid numeric(14,2);
  v_origin text;
begin
  select origin into v_origin from public.financeiro_lancamentos
  where clinic_id = p_clinic_id and id = p_entry_id and state = 'ativo'
  for update;
  if not found then raise exception 'lancamento_nao_encontrado' using errcode = 'P0002'; end if;
  if v_origin = 'compra' then
    raise exception 'purchase_cancel_requires_full_workflow' using errcode = '55000';
  end if;

  select coalesce(sum(case when movement_type = 'pagamento' then amount else -amount end), 0)
  into v_paid from public.financeiro_pagamentos
  where clinic_id = p_clinic_id and entry_id = p_entry_id;
  if v_paid <> 0 then raise exception 'lancamento_com_pagamento' using errcode = '55000'; end if;

  update public.financeiro_lancamentos
  set state = 'cancelado', cancelled_by = p_user_id, cancelled_at = now(),
      cancellation_reason = btrim(p_reason), updated_by = p_user_id
  where clinic_id = p_clinic_id and id = p_entry_id;

  insert into public.financeiro_auditoria (
    clinic_id, actor_id, entity, entity_id, action, details, request_id
  ) values (
    p_clinic_id, p_user_id, 'financeiro_lancamento', p_entry_id, 'cancelado',
    '{}'::jsonb, p_request_id
  );
  return true;
end;
$$;

create or replace function public.financeiro_criar_compra(
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
  p_request_id uuid
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_purchase_id uuid;
  v_entry_id uuid;
  v_total numeric(14,2);
  v_items_total numeric(14,2);
  v_purchase public.financeiro_compras%rowtype;
  v_existing_entry public.financeiro_lancamentos%rowtype;
  v_requested_items jsonb;
  v_stored_items jsonb;
  v_invalid_items boolean;
  v_invoice_number text := nullif(pg_catalog.btrim(p_invoice_number), '');
  v_category text := pg_catalog.btrim(p_category);
  v_notes text := nullif(pg_catalog.btrim(p_notes), '');
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      p_clinic_id::text || ':financeiro_lancamentos:' || p_idempotency_key::text,
      0
    )
  );

  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) < 1 or jsonb_array_length(p_items) > 50 then
    raise exception 'itens_invalidos' using errcode = '22023';
  end if;

  with items as (
    select
      (item->>'produto_id')::uuid as product_id,
      (item->>'quantidade')::numeric(14,4) as quantity,
      (item->>'valor_unitario')::numeric(14,4) as unit_cost
    from jsonb_array_elements(p_items) item
  )
  select coalesce(bool_or(
    product_id is null or quantity is null or unit_cost is null
    or quantity <= 0 or unit_cost < 0
  ), false)
  into v_invalid_items
  from items;
  if v_invalid_items then
    raise exception 'itens_invalidos' using errcode = '22023';
  end if;

  with items as (
    select
      (item->>'produto_id')::uuid as product_id,
      (item->>'quantidade')::numeric(14,4) as quantity,
      (item->>'valor_unitario')::numeric(14,4) as unit_cost
    from jsonb_array_elements(p_items) item
  ), grouped as (
    select product_id, quantity, unit_cost, count(*) as item_count
    from items
    group by product_id, quantity, unit_cost
  )
  select
    sum(round(quantity * unit_cost, 2) * item_count)::numeric(14,2),
    coalesce(
      jsonb_agg(
        jsonb_build_array(product_id, quantity, unit_cost, item_count)
        order by product_id, quantity, unit_cost
      ),
      '[]'::jsonb
    )
  into v_total, v_requested_items
  from grouped;
  if v_total is null or v_total <= 0 then raise exception 'total_invalido' using errcode = '22003'; end if;

  select * into v_purchase
  from public.financeiro_compras
  where clinic_id = p_clinic_id and idempotency_key = p_idempotency_key;
  if found then
    select * into v_existing_entry
    from public.financeiro_lancamentos
    where clinic_id = p_clinic_id and id = v_purchase.expense_entry_id;

    with grouped as (
      select product_id, quantity, unit_cost, count(*) as item_count
      from public.financeiro_compra_itens
      where clinic_id = p_clinic_id and purchase_id = v_purchase.id
      group by product_id, quantity, unit_cost
    )
    select coalesce(
      jsonb_agg(
        jsonb_build_array(product_id, quantity, unit_cost, item_count)
        order by product_id, quantity, unit_cost
      ),
      '[]'::jsonb
    )
    into v_stored_items
    from grouped;

    if v_purchase.supplier_id is distinct from p_supplier_id
       or v_purchase.purchase_date is distinct from p_purchase_date
       or pg_catalog.lower(v_purchase.invoice_number)
          is distinct from pg_catalog.lower(v_invoice_number)
       or v_purchase.payment_condition is distinct from p_payment_condition
       or v_purchase.installments is distinct from p_installments
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

    return jsonb_build_object(
      'compra_id', v_purchase.id,
      'lancamento_id', v_purchase.expense_entry_id,
      'total', v_purchase.total_amount,
      'idempotente', true
    );
  end if;

  if not exists (
    select 1 from public.financeiro_fornecedores
    where clinic_id = p_clinic_id and id = p_supplier_id
      and active and archived_at is null
  ) then raise exception 'fornecedor_invalido' using errcode = '23503'; end if;

  if exists (
    select 1
    from jsonb_array_elements(p_items) item
    left join public.financeiro_produtos p
      on p.clinic_id = p_clinic_id
     and p.id = (item->>'produto_id')::uuid
     and p.active
     and p.archived_at is null
    where p.id is null
  ) then raise exception 'produto_invalido' using errcode = '23503'; end if;

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
    payment_condition, installments, total_amount, notes, idempotency_key,
    created_by
  ) values (
    p_clinic_id, p_supplier_id, v_entry_id, p_purchase_date,
    v_invoice_number, p_payment_condition, p_installments,
    v_total, v_notes, p_idempotency_key, p_user_id
  ) returning id into v_purchase_id;

  insert into public.financeiro_compra_itens (
    clinic_id, purchase_id, product_id, quantity, unit_cost
  )
  select
    p_clinic_id,
    v_purchase_id,
    (item->>'produto_id')::uuid,
    (item->>'quantidade')::numeric(14,4),
    (item->>'valor_unitario')::numeric(14,4)
  from jsonb_array_elements(p_items) item;

  select sum(total_amount)::numeric(14,2) into v_items_total
  from public.financeiro_compra_itens
  where clinic_id = p_clinic_id and purchase_id = v_purchase_id;
  if v_items_total is distinct from v_total then
    raise exception 'compra_total_inconsistente' using errcode = '23514';
  end if;

  insert into public.financeiro_auditoria (
    clinic_id, actor_id, entity, entity_id, action, details, request_id
  ) values (
    p_clinic_id, p_user_id, 'financeiro_compra', v_purchase_id, 'criada',
    jsonb_build_object('item_count', jsonb_array_length(p_items)), p_request_id
  );

  return jsonb_build_object('compra_id', v_purchase_id, 'lancamento_id', v_entry_id, 'total', v_total, 'idempotente', false);
end;
$$;

-- ---------------------------------------------------------------------------
-- Menor privilégio e RLS
-- ---------------------------------------------------------------------------

alter table public.patient_source_links enable row level security;
alter table public.financeiro_formas_pagamento enable row level security;
alter table public.financeiro_fornecedores enable row level security;
alter table public.financeiro_marcas enable row level security;
alter table public.financeiro_produtos enable row level security;
alter table public.financeiro_lancamentos enable row level security;
alter table public.financeiro_pagamentos enable row level security;
alter table public.financeiro_compras enable row level security;
alter table public.financeiro_compra_itens enable row level security;
alter table public.financeiro_auditoria enable row level security;

revoke all on public.patient_source_links from public, anon, authenticated, service_role;
revoke all on public.financeiro_formas_pagamento from public, anon, authenticated, service_role;
revoke all on public.financeiro_fornecedores from public, anon, authenticated, service_role;
revoke all on public.financeiro_marcas from public, anon, authenticated, service_role;
revoke all on public.financeiro_produtos from public, anon, authenticated, service_role;
revoke all on public.financeiro_lancamentos from public, anon, authenticated, service_role;
revoke all on public.financeiro_pagamentos from public, anon, authenticated, service_role;
revoke all on public.financeiro_compras from public, anon, authenticated, service_role;
revoke all on public.financeiro_compra_itens from public, anon, authenticated, service_role;
revoke all on public.financeiro_auditoria from public, anon, authenticated, service_role;
revoke all on public.financeiro_lancamentos_resumo from public, anon, authenticated, service_role;
revoke all on public.financeiro_fluxo_mensal from public, anon, authenticated, service_role;
revoke all on sequence public.financeiro_auditoria_id_seq
  from public, anon, authenticated, service_role;

grant select on public.patient_source_links to service_role;
grant select on public.financeiro_formas_pagamento to service_role;
grant select, insert, update on public.financeiro_fornecedores to service_role;
grant select, insert, update on public.financeiro_marcas to service_role;
grant select, insert, update on public.financeiro_produtos to service_role;
grant select, insert, update on public.financeiro_lancamentos to service_role;
grant select, insert on public.financeiro_pagamentos to service_role;
grant select, insert, update on public.financeiro_compras to service_role;
grant select, insert on public.financeiro_compra_itens to service_role;
grant select, insert on public.financeiro_auditoria to service_role;
grant select on public.financeiro_lancamentos_resumo to service_role;
grant select on public.financeiro_fluxo_mensal to service_role;
grant usage, select on sequence public.financeiro_auditoria_id_seq to service_role;

revoke all on function public.financeiro_criar_cliente_com_vinculo(uuid,uuid,text,date,text,text,text,text,text,uuid,uuid,uuid) from public, anon, authenticated, service_role;
revoke all on function public.financeiro_resumo(uuid,date,date) from public, anon, authenticated, service_role;
revoke all on function public.financeiro_criar_lancamento(uuid,uuid,uuid,uuid,text,text,text,text,date,date,numeric,text,smallint,text,uuid,uuid) from public, anon, authenticated;
revoke all on function public.financeiro_registrar_pagamento(uuid,uuid,uuid,text,text,numeric,timestamptz,smallint,text,uuid,uuid,uuid) from public, anon, authenticated;
revoke all on function public.financeiro_cancelar_lancamento(uuid,uuid,uuid,text,uuid) from public, anon, authenticated;
revoke all on function public.financeiro_criar_compra(uuid,uuid,uuid,date,text,text,smallint,text,text,jsonb,uuid,uuid) from public, anon, authenticated;

grant execute on function public.financeiro_criar_cliente_com_vinculo(uuid,uuid,text,date,text,text,text,text,text,uuid,uuid,uuid) to service_role;
grant execute on function public.financeiro_resumo(uuid,date,date) to service_role;
grant execute on function public.financeiro_criar_lancamento(uuid,uuid,uuid,uuid,text,text,text,text,date,date,numeric,text,smallint,text,uuid,uuid) to service_role;
grant execute on function public.financeiro_registrar_pagamento(uuid,uuid,uuid,text,text,numeric,timestamptz,smallint,text,uuid,uuid,uuid) to service_role;
grant execute on function public.financeiro_cancelar_lancamento(uuid,uuid,uuid,text,uuid) to service_role;
grant execute on function public.financeiro_criar_compra(uuid,uuid,uuid,date,text,text,smallint,text,text,jsonb,uuid,uuid) to service_role;

comment on table public.financeiro_lancamentos is
  'Contas a receber e a pagar. O estado financeiro é calculado por pagamentos imutáveis.';
comment on table public.financeiro_pagamentos is
  'Livro imutável de pagamentos e estornos. Nunca armazena número completo de cartão ou CVV.';
comment on table public.financeiro_auditoria is
  'Trilha financeira append-only, privada e nominal; detalhes não devem conter dados clínicos.';
comment on view public.financeiro_fluxo_mensal is
  'Indicadores mensais: faturado/recebido e incorrido/pago permanecem separados.';

commit;

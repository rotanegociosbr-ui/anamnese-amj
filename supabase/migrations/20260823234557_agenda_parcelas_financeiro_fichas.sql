begin;

create table public.financeiro_parcelas (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete restrict,
  entry_id uuid not null,
  installment_number smallint not null check (installment_number between 1 and 120),
  due_date date not null,
  amount numeric(14,2) not null check (amount > 0),
  planned_payment_method text not null
    references public.financeiro_formas_pagamento(code) on delete restrict,
  state text not null default 'ativa' check (state in ('ativa', 'cancelada')),
  plan_key uuid not null,
  created_by uuid not null references auth.users(id),
  updated_by uuid references auth.users(id),
  cancelled_by uuid references auth.users(id),
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  constraint financeiro_parcelas_clinic_id_id_key unique (clinic_id, id),
  constraint financeiro_parcelas_entry_fk
    foreign key (clinic_id, entry_id)
    references public.financeiro_lancamentos (clinic_id, id) on delete restrict,
  constraint financeiro_parcelas_cancel_check check (
    (state = 'ativa' and cancelled_by is null and cancelled_at is null)
    or
    (state = 'cancelada' and cancelled_by is not null and cancelled_at is not null)
  )
);

create unique index financeiro_parcelas_ativas_numero_unique
  on public.financeiro_parcelas (clinic_id, entry_id, installment_number)
  where state = 'ativa';
create index financeiro_parcelas_entry_idx
  on public.financeiro_parcelas (clinic_id, entry_id, state, installment_number);
create index financeiro_parcelas_due_idx
  on public.financeiro_parcelas (clinic_id, due_date, state);
create index financeiro_parcelas_plan_key_idx
  on public.financeiro_parcelas (clinic_id, entry_id, plan_key);
create index financeiro_parcelas_created_by_idx
  on public.financeiro_parcelas (created_by);
create index financeiro_parcelas_updated_by_idx
  on public.financeiro_parcelas (updated_by)
  where updated_by is not null;
create index financeiro_parcelas_cancelled_by_idx
  on public.financeiro_parcelas (cancelled_by)
  where cancelled_by is not null;

create trigger financeiro_parcelas_touch
before update on public.financeiro_parcelas
for each row execute function private.financeiro_touch_row();

create table public.financeiro_parcela_pagamentos (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete restrict,
  installment_id uuid not null,
  payment_id uuid not null,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  constraint financeiro_parcela_pagamentos_installment_fk
    foreign key (clinic_id, installment_id)
    references public.financeiro_parcelas (clinic_id, id) on delete restrict,
  constraint financeiro_parcela_pagamentos_payment_fk
    foreign key (clinic_id, payment_id)
    references public.financeiro_pagamentos (clinic_id, id) on delete restrict,
  constraint financeiro_parcela_pagamentos_payment_unique unique (clinic_id, payment_id)
);

create index financeiro_parcela_pagamentos_installment_idx
  on public.financeiro_parcela_pagamentos (clinic_id, installment_id);
create index financeiro_parcela_pagamentos_created_by_idx
  on public.financeiro_parcela_pagamentos (created_by);

create trigger financeiro_parcela_pagamentos_immutable
before update or delete on public.financeiro_parcela_pagamentos
for each row execute function private.financeiro_block_mutation();

create or replace view public.financeiro_parcelas_resumo
with (security_invoker = true)
as
with linked_totals as (
  select
    link.clinic_id,
    link.installment_id,
    coalesce(
      sum(case when pay.movement_type = 'pagamento' then pay.amount else -pay.amount end),
      0
    )::numeric(14,2) as paid_amount
  from public.financeiro_parcela_pagamentos link
  join public.financeiro_pagamentos pay
    on pay.clinic_id = link.clinic_id
   and pay.id = link.payment_id
  group by link.clinic_id, link.installment_id
)
select
  installment.id,
  installment.clinic_id,
  installment.entry_id,
  installment.installment_number,
  installment.due_date,
  installment.amount,
  installment.planned_payment_method,
  greatest(coalesce(linked.paid_amount, 0), 0)::numeric(14,2) as paid_amount,
  greatest(installment.amount - coalesce(linked.paid_amount, 0), 0)::numeric(14,2) as balance,
  case
    when installment.state = 'cancelada' then 'cancelada'
    when coalesce(linked.paid_amount, 0) >= installment.amount then 'paga'
    when installment.due_date < (now() at time zone 'America/Sao_Paulo')::date then 'vencida'
    when coalesce(linked.paid_amount, 0) > 0 then 'parcial'
    else 'aberta'
  end as calculated_status,
  installment.state,
  installment.plan_key,
  installment.created_by,
  installment.created_at,
  installment.updated_at,
  installment.version
from public.financeiro_parcelas installment
left join linked_totals linked
  on linked.clinic_id = installment.clinic_id
 and linked.installment_id = installment.id;

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
),
installment_status as (
  select
    clinic_id,
    entry_id,
    min(due_date) filter (
      where state = 'ativa' and calculated_status in ('aberta', 'parcial', 'vencida')
    ) as next_due_date,
    bool_or(state = 'ativa' and calculated_status = 'vencida') as has_overdue,
    count(*) filter (where state = 'ativa')::integer as active_count
  from public.financeiro_parcelas_resumo
  group by clinic_id, entry_id
)
select
  entry.id,
  entry.clinic_id,
  entry.patient_id,
  entry.supplier_id,
  entry.entry_type,
  entry.origin,
  entry.description,
  entry.category,
  entry.competence_date,
  coalesce(installments.next_due_date, entry.due_date) as due_date,
  entry.total_amount,
  greatest(coalesce(payments.paid_amount, 0), 0)::numeric(14,2) as paid_amount,
  greatest(entry.total_amount - coalesce(payments.paid_amount, 0), 0)::numeric(14,2) as balance,
  entry.payment_condition,
  case
    when coalesce(installments.active_count, 0) > 0 then installments.active_count::smallint
    else entry.installments
  end as installments,
  case
    when entry.state = 'cancelado' then 'cancelado'
    when coalesce(payments.paid_amount, 0) >= entry.total_amount then 'pago'
    when coalesce(installments.has_overdue, false) then 'vencido'
    when coalesce(payments.paid_amount, 0) > 0 then 'parcial'
    when entry.due_date < (now() at time zone 'America/Sao_Paulo')::date then 'vencido'
    else 'pendente'
  end as calculated_status,
  entry.state,
  entry.notes,
  entry.created_by,
  entry.created_at,
  entry.updated_at,
  entry.version
from public.financeiro_lancamentos entry
left join payment_totals payments
  on payments.clinic_id = entry.clinic_id
 and payments.entry_id = entry.id
left join installment_status installments
  on installments.clinic_id = entry.clinic_id
 and installments.entry_id = entry.id;

create or replace function public.financeiro_programar_parcelas(
  p_clinic_id uuid,
  p_user_id uuid,
  p_entry_id uuid,
  p_installments jsonb,
  p_idempotency_key uuid,
  p_request_id uuid
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_entry public.financeiro_lancamentos%rowtype;
  v_paid numeric(14,2);
  v_balance numeric(14,2);
  v_count integer;
  v_distinct_count integer;
  v_min_number integer;
  v_max_number integer;
  v_total numeric(14,2);
  v_first_due date;
  v_requested jsonb;
  v_existing jsonb;
  v_existing_count integer;
  v_had_schedule boolean := false;
begin
  if p_idempotency_key is null or p_request_id is null then
    raise exception 'identificador_invalido' using errcode = '22023';
  end if;
  if pg_catalog.jsonb_typeof(p_installments) <> 'array'
     or pg_catalog.jsonb_array_length(p_installments) < 1
     or pg_catalog.jsonb_array_length(p_installments) > 120 then
    raise exception 'parcelas_invalidas' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      p_clinic_id::text || ':financeiro_parcelas:' || p_entry_id::text,
      0
    )
  );

  select * into v_entry
  from public.financeiro_lancamentos
  where clinic_id = p_clinic_id and id = p_entry_id
  for update;
  if not found then
    raise exception 'lancamento_nao_encontrado' using errcode = 'P0002';
  end if;
  if v_entry.state <> 'ativo' then
    raise exception 'lancamento_inativo' using errcode = '55000';
  end if;

  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_installments) item
    where pg_catalog.jsonb_typeof(item) <> 'object'
       or coalesce(item->>'numero', '') !~ '^[1-9][0-9]{0,2}$'
       or coalesce(item->>'vencimento', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
       or coalesce(item->>'valor', '') !~ '^[0-9]{1,12}([.][0-9]{1,2})?$'
       or coalesce(item->>'forma_pagamento', '') !~ '^[a-z0-9_]{2,40}$'
  ) then
    raise exception 'parcelas_invalidas' using errcode = '22023';
  end if;

  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_installments) item
    where (item->>'vencimento')::date < v_entry.competence_date
       or not exists (
         select 1
         from public.financeiro_formas_pagamento method
         where method.code = item->>'forma_pagamento'
           and method.active
       )
  ) then
    raise exception 'parcela_data_ou_forma_invalida' using errcode = '22023';
  end if;

  select
    count(*)::integer,
    count(distinct (item->>'numero')::integer)::integer,
    min((item->>'numero')::integer),
    max((item->>'numero')::integer),
    round(sum(round((item->>'valor')::numeric, 2)), 2)::numeric(14,2),
    min((item->>'vencimento')::date),
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'numero', (item->>'numero')::integer,
        'vencimento', (item->>'vencimento')::date,
        'valor', round((item->>'valor')::numeric, 2),
        'forma_pagamento', item->>'forma_pagamento'
      )
      order by (item->>'numero')::integer
    )
  into
    v_count, v_distinct_count, v_min_number, v_max_number,
    v_total, v_first_due, v_requested
  from pg_catalog.jsonb_array_elements(p_installments) item;

  if v_count <> v_distinct_count or v_min_number <> 1 or v_max_number <> v_count then
    raise exception 'parcelas_nao_sequenciais' using errcode = '22023';
  end if;

  select coalesce(sum(case when movement_type = 'pagamento' then amount else -amount end), 0)
  into v_paid
  from public.financeiro_pagamentos
  where clinic_id = p_clinic_id and entry_id = p_entry_id;

  v_balance := round(v_entry.total_amount - v_paid, 2);
  if v_balance <= 0 then
    raise exception 'lancamento_sem_saldo' using errcode = '22003';
  end if;
  if v_total is distinct from v_balance then
    raise exception 'parcelas_soma_diverge_saldo' using errcode = '22003';
  end if;

  select
    count(*)::integer,
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'numero', installment_number,
        'vencimento', due_date,
        'valor', amount,
        'forma_pagamento', planned_payment_method
      )
      order by installment_number
    )
  into v_existing_count, v_existing
  from public.financeiro_parcelas
  where clinic_id = p_clinic_id
    and entry_id = p_entry_id
    and state = 'ativa';

  if coalesce(v_existing_count, 0) > 0 then
    v_had_schedule := true;
    if v_existing = v_requested then
      return pg_catalog.jsonb_build_object(
        'lancamento_id', p_entry_id,
        'quantidade', v_count,
        'idempotente', true
      );
    end if;

    if exists (
      select 1
      from public.financeiro_parcela_pagamentos link
      join public.financeiro_parcelas installment
        on installment.clinic_id = link.clinic_id
       and installment.id = link.installment_id
      where installment.clinic_id = p_clinic_id
        and installment.entry_id = p_entry_id
        and installment.state = 'ativa'
    ) then
      raise exception 'parcelas_com_pagamentos' using errcode = '55000';
    end if;

    update public.financeiro_parcelas
    set state = 'cancelada',
        cancelled_by = p_user_id,
        cancelled_at = now(),
        updated_by = p_user_id
    where clinic_id = p_clinic_id
      and entry_id = p_entry_id
      and state = 'ativa';
  end if;

  insert into public.financeiro_parcelas (
    clinic_id, entry_id, installment_number, due_date, amount,
    planned_payment_method, state, plan_key, created_by, updated_by
  )
  select
    p_clinic_id,
    p_entry_id,
    (item->>'numero')::smallint,
    (item->>'vencimento')::date,
    round((item->>'valor')::numeric, 2),
    item->>'forma_pagamento',
    'ativa',
    p_idempotency_key,
    p_user_id,
    p_user_id
  from pg_catalog.jsonb_array_elements(v_requested) item;

  update public.financeiro_lancamentos
  set due_date = v_first_due,
      installments = v_count::smallint,
      payment_condition = case
        when v_paid > 0 then 'entrada_saldo'
        when v_count > 1 then 'parcelado'
        else 'avista'
      end,
      updated_by = p_user_id
  where clinic_id = p_clinic_id and id = p_entry_id;

  insert into public.financeiro_auditoria (
    clinic_id, actor_id, entity, entity_id, action, details, request_id
  ) values (
    p_clinic_id,
    p_user_id,
    'financeiro_parcelas',
    p_entry_id,
    case when v_had_schedule then 'reprogramadas' else 'programadas' end,
    pg_catalog.jsonb_build_object(
      'item_count', v_count,
      'operation', case when v_had_schedule then 'reprogram' else 'create' end
    ),
    p_request_id
  );

  return pg_catalog.jsonb_build_object(
    'lancamento_id', p_entry_id,
    'quantidade', v_count,
    'idempotente', false
  );
end;
$$;

create or replace function public.financeiro_registrar_pagamento_parcela(
  p_clinic_id uuid,
  p_user_id uuid,
  p_entry_id uuid,
  p_installment_id uuid,
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
  v_entry public.financeiro_lancamentos%rowtype;
  v_installment public.financeiro_parcelas%rowtype;
  v_payment_id uuid;
  v_existing_installment_id uuid;
  v_original_installment_id uuid;
  v_installment_paid numeric(14,2);
  v_amount numeric(14,2) := round(p_amount, 2);
begin
  select * into v_entry
  from public.financeiro_lancamentos
  where clinic_id = p_clinic_id and id = p_entry_id
  for update;
  if not found then
    raise exception 'lancamento_nao_encontrado' using errcode = 'P0002';
  end if;

  select * into v_installment
  from public.financeiro_parcelas
  where clinic_id = p_clinic_id
    and id = p_installment_id
    and entry_id = p_entry_id
  for update;
  if not found then
    raise exception 'parcela_nao_encontrada' using errcode = 'P0002';
  end if;
  if v_installment.state <> 'ativa' then
    raise exception 'parcela_inativa' using errcode = '55000';
  end if;

  if p_movement_type = 'estorno' then
    select installment_id into v_original_installment_id
    from public.financeiro_parcela_pagamentos
    where clinic_id = p_clinic_id and payment_id = p_reversed_payment_id;
    if not found or v_original_installment_id is distinct from p_installment_id then
      raise exception 'pagamento_nao_pertence_parcela' using errcode = '22023';
    end if;
  end if;

  v_payment_id := public.financeiro_registrar_pagamento(
    p_clinic_id,
    p_user_id,
    p_entry_id,
    p_movement_type,
    p_payment_method,
    p_amount,
    p_paid_at,
    p_installments,
    p_reference,
    p_reversed_payment_id,
    p_idempotency_key,
    p_request_id
  );

  select installment_id into v_existing_installment_id
  from public.financeiro_parcela_pagamentos
  where clinic_id = p_clinic_id and payment_id = v_payment_id;
  if found then
    if v_existing_installment_id is distinct from p_installment_id then
      raise exception 'pagamento_vinculado_outra_parcela' using errcode = '22023';
    end if;
    return v_payment_id;
  end if;

  select coalesce(sum(case when pay.movement_type = 'pagamento' then pay.amount else -pay.amount end), 0)
  into v_installment_paid
  from public.financeiro_parcela_pagamentos link
  join public.financeiro_pagamentos pay
    on pay.clinic_id = link.clinic_id
   and pay.id = link.payment_id
  where link.clinic_id = p_clinic_id
    and link.installment_id = p_installment_id;

  if p_movement_type = 'pagamento'
     and v_amount > round(v_installment.amount - v_installment_paid, 2) then
    raise exception 'valor_excede_saldo_parcela' using errcode = '22003';
  end if;

  insert into public.financeiro_parcela_pagamentos (
    clinic_id, installment_id, payment_id, created_by
  ) values (
    p_clinic_id, p_installment_id, v_payment_id, p_user_id
  );

  insert into public.financeiro_auditoria (
    clinic_id, actor_id, entity, entity_id, action, details, request_id
  ) values (
    p_clinic_id, p_user_id, 'financeiro_parcela', p_installment_id,
    'pagamento_vinculado',
    pg_catalog.jsonb_build_object('operation', p_movement_type),
    p_request_id
  );

  return v_payment_id;
end;
$$;

alter table public.financeiro_parcelas enable row level security;
alter table public.financeiro_parcela_pagamentos enable row level security;

revoke all on public.financeiro_parcelas
  from public, anon, authenticated, service_role;
revoke all on public.financeiro_parcela_pagamentos
  from public, anon, authenticated, service_role;
revoke all on public.financeiro_parcelas_resumo
  from public, anon, authenticated, service_role;
revoke all on public.financeiro_lancamentos_resumo
  from public, anon, authenticated, service_role;

grant select, insert, update on public.financeiro_parcelas to service_role;
grant select, insert on public.financeiro_parcela_pagamentos to service_role;
grant select on public.financeiro_parcelas_resumo to service_role;
grant select on public.financeiro_lancamentos_resumo to service_role;

revoke all on function public.financeiro_programar_parcelas(uuid,uuid,uuid,jsonb,uuid,uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.financeiro_registrar_pagamento_parcela(uuid,uuid,uuid,uuid,text,text,numeric,timestamptz,smallint,text,uuid,uuid,uuid)
  from public, anon, authenticated, service_role;

grant execute on function public.financeiro_programar_parcelas(uuid,uuid,uuid,jsonb,uuid,uuid)
  to service_role;
grant execute on function public.financeiro_registrar_pagamento_parcela(uuid,uuid,uuid,uuid,text,text,numeric,timestamptz,smallint,text,uuid,uuid,uuid)
  to service_role;

comment on table public.financeiro_parcelas is
  'Agenda privada de parcelas futuras, com vencimento, valor e forma prevista individualizados.';
comment on table public.financeiro_parcela_pagamentos is
  'Vínculo append-only entre parcelas previstas e o livro imutável de pagamentos/estornos.';
comment on view public.financeiro_parcelas_resumo is
  'Situação calculada de cada parcela; pagamentos e estornos determinam o saldo sem status manual.';

commit;

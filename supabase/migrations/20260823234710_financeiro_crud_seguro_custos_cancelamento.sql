begin;

-- CRUD seguro e auditado do Financeiro.
-- Nenhum registro empresarial ou financeiro e removido fisicamente.

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
        'idempotent', 'version', 'previous_status', 'new_status', 'reason'
      )
      or pg_catalog.jsonb_typeof(item.value) not in ('string', 'number', 'boolean', 'null')
      or (
        pg_catalog.jsonb_typeof(item.value) = 'string'
        and case
          when item.key = 'reason' then
            pg_catalog.length(item.value #>> '{}') not between 3 and 500
            or (item.value #>> '{}') ~ '[[:cntrl:]]'
          else
            pg_catalog.length(item.value #>> '{}') > 160
            or (item.value #>> '{}') !~ '^[A-Za-z0-9_.:/-]*$'
        end
      )
    );
$$;

revoke all on function private.financeiro_audit_details_are_safe(jsonb)
  from public, anon, authenticated, service_role;
grant execute on function private.financeiro_audit_details_are_safe(jsonb)
  to service_role;

create or replace function private.financeiro_operation_reason(p_reason text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_reason text := pg_catalog.btrim(p_reason);
begin
  if v_reason is null
     or pg_catalog.char_length(v_reason) not between 3 and 500
     or v_reason ~ '[[:cntrl:]]' then
    raise exception 'motivo_invalido' using errcode = '22023';
  end if;
  return v_reason;
end;
$$;

revoke all on function private.financeiro_operation_reason(text)
  from public, anon, authenticated, service_role;
grant execute on function private.financeiro_operation_reason(text)
  to service_role;

-- ---------------------------------------------------------------------------
-- Historico append-only de custos de produtos
-- ---------------------------------------------------------------------------

create table public.financeiro_produto_custos (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete restrict,
  product_id uuid not null,
  supplier_id uuid,
  source text not null check (
    char_length(btrim(source)) between 2 and 160 and source !~ '[[:cntrl:]]'
  ),
  cost_date date not null,
  payment_condition text check (
    payment_condition is null or (
      char_length(btrim(payment_condition)) between 2 and 80
      and payment_condition !~ '[[:cntrl:]]'
    )
  ),
  package_quantity numeric(14,4) not null check (
    package_quantity > 0 and package_quantity <= 9999999999.9999
  ),
  package_unit text not null check (
    char_length(btrim(package_unit)) between 1 and 40
    and package_unit !~ '[[:cntrl:]]'
  ),
  total_cost numeric(14,2) not null check (
    total_cost > 0 and total_cost <= 999999999999.99
  ),
  unit_cost numeric(14,4) not null check (
    unit_cost > 0 and unit_cost <= 9999999999.9999
  ),
  notes text check (
    notes is null or (char_length(notes) <= 1000 and notes !~ '[[:cntrl:]]')
  ),
  sets_current boolean not null default false,
  is_current boolean not null default false,
  operation_id uuid not null,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  constraint financeiro_produto_custos_clinic_id_id_key unique (clinic_id, id),
  constraint financeiro_produto_custos_product_fk
    foreign key (clinic_id, product_id)
    references public.financeiro_produtos (clinic_id, id) on delete restrict,
  constraint financeiro_produto_custos_supplier_fk
    foreign key (clinic_id, supplier_id)
    references public.financeiro_fornecedores (clinic_id, id) on delete restrict,
  constraint financeiro_produto_custos_operation_unique unique (clinic_id, operation_id),
  constraint financeiro_produto_custos_total_check check (
    abs(round(package_quantity * unit_cost, 2) - total_cost) <= 0.01
  )
);

create unique index financeiro_produto_custos_current_unique
  on public.financeiro_produto_custos (clinic_id, product_id)
  where is_current;
create index financeiro_produto_custos_product_date_idx
  on public.financeiro_produto_custos (clinic_id, product_id, cost_date desc, created_at desc);
create index financeiro_produto_custos_supplier_idx
  on public.financeiro_produto_custos (clinic_id, supplier_id, cost_date desc)
  where supplier_id is not null;
create index financeiro_produto_custos_created_by_idx
  on public.financeiro_produto_custos (created_by, created_at desc);

-- Um custo financeiro nunca e apagado nem reescrito. Quando um lancamento foi
-- feito por engano, este livro registra o cancelamento compensatorio e, quando
-- necessario, o novo custo corrente criado a partir do ultimo historico valido.
create table public.financeiro_produto_custo_cancelamentos (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete restrict,
  cost_id uuid not null,
  replacement_cost_id uuid,
  reason text not null check (
    char_length(btrim(reason)) between 3 and 500
    and reason !~ '[[:cntrl:]]'
  ),
  result_status text not null check (
    result_status in (
      'historical_cancelled', 'current_replaced', 'current_pending',
      'purchase_cancelled'
    )
  ),
  operation_id uuid not null,
  cancelled_by uuid not null references auth.users(id) on delete restrict,
  cancelled_at timestamptz not null default now(),
  constraint financeiro_produto_custo_cancelamentos_clinic_id_id_key
    unique (clinic_id, id),
  constraint financeiro_produto_custo_cancelamentos_cost_fk
    foreign key (clinic_id, cost_id)
    references public.financeiro_produto_custos (clinic_id, id) on delete restrict,
  constraint financeiro_produto_custo_cancelamentos_replacement_fk
    foreign key (clinic_id, replacement_cost_id)
    references public.financeiro_produto_custos (clinic_id, id) on delete restrict,
  constraint financeiro_produto_custo_cancelamentos_cost_unique
    unique (clinic_id, cost_id),
  constraint financeiro_produto_custo_cancelamentos_operation_unique
    unique (clinic_id, operation_id),
  constraint financeiro_produto_custo_cancelamentos_replacement_check
    check (replacement_cost_id is null or replacement_cost_id <> cost_id)
);

create index financeiro_produto_custo_cancelamentos_product_lookup_idx
  on public.financeiro_produto_custo_cancelamentos (clinic_id, cancelled_at desc, cost_id);

create or replace function private.financeiro_guard_cost_history()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'historico_custo_imutavel' using errcode = '55000';
  end if;
  if pg_catalog.to_jsonb(new) - 'is_current'
       is distinct from pg_catalog.to_jsonb(old) - 'is_current'
     or old.is_current is not true
     or new.is_current is not false then
    raise exception 'historico_custo_imutavel' using errcode = '55000';
  end if;
  return new;
end;
$$;

revoke all on function private.financeiro_guard_cost_history()
  from public, anon, authenticated, service_role;

create trigger financeiro_produto_custos_guard
before update or delete on public.financeiro_produto_custos
for each row execute function private.financeiro_guard_cost_history();

create or replace function private.financeiro_guard_cost_cancellation_history()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'historico_cancelamento_custo_imutavel' using errcode = '55000';
end;
$$;

revoke all on function private.financeiro_guard_cost_cancellation_history()
  from public, anon, authenticated, service_role;

create trigger financeiro_produto_custo_cancelamentos_guard
before update or delete on public.financeiro_produto_custo_cancelamentos
for each row execute function private.financeiro_guard_cost_cancellation_history();

alter table public.financeiro_produto_custos enable row level security;
alter table public.financeiro_produto_custo_cancelamentos enable row level security;
revoke all on public.financeiro_produto_custos
  from public, anon, authenticated, service_role;
revoke all on public.financeiro_produto_custo_cancelamentos
  from public, anon, authenticated, service_role;
grant select, insert, update on public.financeiro_produto_custos to service_role;
grant select, insert on public.financeiro_produto_custo_cancelamentos to service_role;

-- ---------------------------------------------------------------------------
-- Metadados seguros para cancelamento integral de compras
-- ---------------------------------------------------------------------------

alter table public.financeiro_compras
  add column if not exists updated_by uuid references auth.users(id),
  add column if not exists cancelled_by uuid references auth.users(id),
  add column if not exists cancelled_at timestamptz,
  add column if not exists cancellation_reason text,
  add column if not exists cancellation_operation_id uuid,
  add column if not exists updated_at timestamptz not null default now(),
  add column if not exists version integer not null default 1;

update public.financeiro_compras
set updated_by = coalesce(updated_by, created_by),
    cancelled_by = coalesce(cancelled_by, created_by),
    cancelled_at = coalesce(cancelled_at, created_at),
    cancellation_reason = coalesce(cancellation_reason, 'Cancelamento legado'),
    cancellation_operation_id = coalesce(cancellation_operation_id, gen_random_uuid())
where state = 'cancelada';

do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.financeiro_compras'::pg_catalog.regclass
      and conname = 'financeiro_compras_version_check'
  ) then
    alter table public.financeiro_compras
      add constraint financeiro_compras_version_check check (version > 0);
  end if;
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.financeiro_compras'::pg_catalog.regclass
      and conname = 'financeiro_compras_cancellation_reason_check'
  ) then
    alter table public.financeiro_compras
      add constraint financeiro_compras_cancellation_reason_check check (
        cancellation_reason is null or (
          char_length(btrim(cancellation_reason)) between 3 and 500
          and cancellation_reason !~ '[[:cntrl:]]'
        )
      );
  end if;
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.financeiro_compras'::pg_catalog.regclass
      and conname = 'financeiro_compras_cancel_metadata_check'
  ) then
    alter table public.financeiro_compras
      add constraint financeiro_compras_cancel_metadata_check check (
        (
          state = 'registrada'
          and cancelled_by is null
          and cancelled_at is null
          and cancellation_reason is null
          and cancellation_operation_id is null
        ) or (
          state = 'cancelada'
          and cancelled_by is not null
          and cancelled_at is not null
          and cancellation_reason is not null
          and cancellation_operation_id is not null
        )
      );
  end if;
end
$$;

create unique index if not exists financeiro_compras_cancel_operation_unique
  on public.financeiro_compras (clinic_id, cancellation_operation_id)
  where cancellation_operation_id is not null;
create index if not exists financeiro_compras_updated_by_idx
  on public.financeiro_compras (updated_by)
  where updated_by is not null;
create index if not exists financeiro_compras_cancelled_by_idx
  on public.financeiro_compras (cancelled_by)
  where cancelled_by is not null;

drop trigger if exists financeiro_compras_touch on public.financeiro_compras;
create trigger financeiro_compras_touch
before update on public.financeiro_compras
for each row execute function private.financeiro_touch_row();

create or replace function private.financeiro_guard_purchase_entry()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.origin = 'compra' and new.origin is distinct from old.origin then
    raise exception 'purchase_cancel_requires_full_workflow'
      using errcode = '55000';
  end if;
  if old.origin = 'compra' and old.state <> 'cancelado' and new.state = 'cancelado'
     and not exists (
       select 1
       from public.financeiro_compras purchase
       where purchase.clinic_id = old.clinic_id
         and purchase.expense_entry_id = old.id
         and purchase.state = 'cancelada'
     ) then
    raise exception 'purchase_cancel_requires_full_workflow'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

revoke all on function private.financeiro_guard_purchase_entry()
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Cliente: editar, arquivar e restaurar. IDs e relacionamentos sao preservados.
-- ---------------------------------------------------------------------------

create or replace function public.financeiro_editar_cliente(
  p_clinic_id uuid,
  p_user_id uuid,
  p_patient_id uuid,
  p_expected_version integer,
  p_full_name text,
  p_birth_date date,
  p_cpf text,
  p_phone text,
  p_email text,
  p_emergency_phone text,
  p_status text,
  p_search_name text,
  p_reason text,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_patient public.patients%rowtype;
  v_reason text := private.financeiro_operation_reason(p_reason);
begin
  select * into v_patient
  from public.patients
  where clinic_id = p_clinic_id and id = p_patient_id
  for update;
  if not found then raise exception 'cliente_nao_encontrado' using errcode = 'P0002'; end if;
  if v_patient.version <> p_expected_version then
    raise exception 'version_conflict' using errcode = '40001';
  end if;
  if v_patient.archived_at is not null then
    raise exception 'registro_arquivado' using errcode = '55000';
  end if;

  update public.patients
  set full_name = pg_catalog.btrim(p_full_name),
      birth_date = p_birth_date,
      cpf = nullif(pg_catalog.btrim(p_cpf), ''),
      phone = nullif(pg_catalog.btrim(p_phone), ''),
      email = nullif(pg_catalog.lower(pg_catalog.btrim(p_email)), ''),
      emergency_phone = nullif(pg_catalog.btrim(p_emergency_phone), ''),
      status = p_status,
      search_name = pg_catalog.btrim(p_search_name),
      updated_by = p_user_id,
      updated_at = now(),
      version = version + 1
  where clinic_id = p_clinic_id and id = p_patient_id
  returning * into v_patient;

  insert into public.financeiro_auditoria (
    clinic_id, actor_id, entity, entity_id, action, details, request_id
  ) values (
    p_clinic_id, p_user_id, 'cliente', p_patient_id, 'editado',
    pg_catalog.jsonb_build_object('operation', 'edit', 'version', v_patient.version, 'reason', v_reason),
    p_request_id
  );
  return pg_catalog.to_jsonb(v_patient);
end;
$$;

create or replace function public.financeiro_arquivar_cliente(
  p_clinic_id uuid, p_user_id uuid, p_patient_id uuid,
  p_expected_version integer, p_reason text, p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_patient public.patients%rowtype;
  v_reason text := private.financeiro_operation_reason(p_reason);
begin
  select * into v_patient from public.patients
  where clinic_id = p_clinic_id and id = p_patient_id for update;
  if not found then raise exception 'cliente_nao_encontrado' using errcode = 'P0002'; end if;
  if v_patient.version <> p_expected_version then raise exception 'version_conflict' using errcode = '40001'; end if;
  if v_patient.archived_at is not null then return pg_catalog.to_jsonb(v_patient); end if;
  update public.patients
  set archived_at = now(), updated_by = p_user_id, updated_at = now(), version = version + 1
  where clinic_id = p_clinic_id and id = p_patient_id returning * into v_patient;
  insert into public.financeiro_auditoria (
    clinic_id, actor_id, entity, entity_id, action, details, request_id
  ) values (
    p_clinic_id, p_user_id, 'cliente', p_patient_id, 'arquivado',
    pg_catalog.jsonb_build_object('operation', 'archive', 'version', v_patient.version, 'reason', v_reason),
    p_request_id
  );
  return pg_catalog.to_jsonb(v_patient);
end;
$$;

create or replace function public.financeiro_restaurar_cliente(
  p_clinic_id uuid, p_user_id uuid, p_patient_id uuid,
  p_expected_version integer, p_reason text, p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_patient public.patients%rowtype;
  v_reason text := private.financeiro_operation_reason(p_reason);
begin
  select * into v_patient from public.patients
  where clinic_id = p_clinic_id and id = p_patient_id for update;
  if not found then raise exception 'cliente_nao_encontrado' using errcode = 'P0002'; end if;
  if v_patient.version <> p_expected_version then raise exception 'version_conflict' using errcode = '40001'; end if;
  if v_patient.archived_at is null then return pg_catalog.to_jsonb(v_patient); end if;
  update public.patients
  set archived_at = null, updated_by = p_user_id, updated_at = now(), version = version + 1
  where clinic_id = p_clinic_id and id = p_patient_id returning * into v_patient;
  insert into public.financeiro_auditoria (
    clinic_id, actor_id, entity, entity_id, action, details, request_id
  ) values (
    p_clinic_id, p_user_id, 'cliente', p_patient_id, 'restaurado',
    pg_catalog.jsonb_build_object('operation', 'restore', 'version', v_patient.version, 'reason', v_reason),
    p_request_id
  );
  return pg_catalog.to_jsonb(v_patient);
end;
$$;

-- ---------------------------------------------------------------------------
-- Fornecedor, marca e produto: RPCs fechadas, sem nome de tabela dinamico.
-- ---------------------------------------------------------------------------

create or replace function public.financeiro_editar_fornecedor(
  p_clinic_id uuid, p_user_id uuid, p_supplier_id uuid, p_expected_version integer,
  p_name text, p_document text, p_phone text, p_email text,
  p_reason text, p_request_id uuid
)
returns jsonb language plpgsql set search_path = '' as $$
declare
  v_row public.financeiro_fornecedores%rowtype;
  v_reason text := private.financeiro_operation_reason(p_reason);
begin
  select * into v_row from public.financeiro_fornecedores
  where clinic_id = p_clinic_id and id = p_supplier_id for update;
  if not found then raise exception 'fornecedor_nao_encontrado' using errcode = 'P0002'; end if;
  if v_row.version <> p_expected_version then raise exception 'version_conflict' using errcode = '40001'; end if;
  if v_row.archived_at is not null then raise exception 'registro_arquivado' using errcode = '55000'; end if;
  update public.financeiro_fornecedores
  set name = pg_catalog.btrim(p_name), document = nullif(pg_catalog.btrim(p_document), ''),
      phone = nullif(pg_catalog.btrim(p_phone), ''),
      email = nullif(pg_catalog.lower(pg_catalog.btrim(p_email)), ''), updated_by = p_user_id
  where clinic_id = p_clinic_id and id = p_supplier_id returning * into v_row;
  insert into public.financeiro_auditoria (
    clinic_id, actor_id, entity, entity_id, action, details, request_id
  ) values (
    p_clinic_id, p_user_id, 'fornecedor', p_supplier_id, 'editado',
    pg_catalog.jsonb_build_object('operation', 'edit', 'version', v_row.version, 'reason', v_reason),
    p_request_id
  );
  return pg_catalog.to_jsonb(v_row);
end;
$$;

create or replace function public.financeiro_arquivar_fornecedor(
  p_clinic_id uuid, p_user_id uuid, p_supplier_id uuid,
  p_expected_version integer, p_reason text, p_request_id uuid
)
returns jsonb language plpgsql set search_path = '' as $$
declare
  v_row public.financeiro_fornecedores%rowtype;
  v_reason text := private.financeiro_operation_reason(p_reason);
begin
  select * into v_row from public.financeiro_fornecedores
  where clinic_id = p_clinic_id and id = p_supplier_id for update;
  if not found then raise exception 'fornecedor_nao_encontrado' using errcode = 'P0002'; end if;
  if v_row.version <> p_expected_version then raise exception 'version_conflict' using errcode = '40001'; end if;
  if v_row.archived_at is not null then return pg_catalog.to_jsonb(v_row); end if;
  update public.financeiro_fornecedores
  set active = false, archived_at = now(), updated_by = p_user_id
  where clinic_id = p_clinic_id and id = p_supplier_id returning * into v_row;
  insert into public.financeiro_auditoria (
    clinic_id, actor_id, entity, entity_id, action, details, request_id
  ) values (
    p_clinic_id, p_user_id, 'fornecedor', p_supplier_id, 'arquivado',
    pg_catalog.jsonb_build_object('operation', 'archive', 'version', v_row.version, 'reason', v_reason),
    p_request_id
  );
  return pg_catalog.to_jsonb(v_row);
end;
$$;

create or replace function public.financeiro_restaurar_fornecedor(
  p_clinic_id uuid, p_user_id uuid, p_supplier_id uuid,
  p_expected_version integer, p_reason text, p_request_id uuid
)
returns jsonb language plpgsql set search_path = '' as $$
declare
  v_row public.financeiro_fornecedores%rowtype;
  v_reason text := private.financeiro_operation_reason(p_reason);
begin
  select * into v_row from public.financeiro_fornecedores
  where clinic_id = p_clinic_id and id = p_supplier_id for update;
  if not found then raise exception 'fornecedor_nao_encontrado' using errcode = 'P0002'; end if;
  if v_row.version <> p_expected_version then raise exception 'version_conflict' using errcode = '40001'; end if;
  if v_row.archived_at is null then return pg_catalog.to_jsonb(v_row); end if;
  update public.financeiro_fornecedores
  set active = true, archived_at = null, updated_by = p_user_id
  where clinic_id = p_clinic_id and id = p_supplier_id returning * into v_row;
  insert into public.financeiro_auditoria (
    clinic_id, actor_id, entity, entity_id, action, details, request_id
  ) values (
    p_clinic_id, p_user_id, 'fornecedor', p_supplier_id, 'restaurado',
    pg_catalog.jsonb_build_object('operation', 'restore', 'version', v_row.version, 'reason', v_reason),
    p_request_id
  );
  return pg_catalog.to_jsonb(v_row);
end;
$$;

create or replace function public.financeiro_editar_marca(
  p_clinic_id uuid, p_user_id uuid, p_brand_id uuid, p_expected_version integer,
  p_name text, p_reason text, p_request_id uuid
)
returns jsonb language plpgsql set search_path = '' as $$
declare
  v_row public.financeiro_marcas%rowtype;
  v_reason text := private.financeiro_operation_reason(p_reason);
begin
  select * into v_row from public.financeiro_marcas
  where clinic_id = p_clinic_id and id = p_brand_id for update;
  if not found then raise exception 'marca_nao_encontrada' using errcode = 'P0002'; end if;
  if v_row.version <> p_expected_version then raise exception 'version_conflict' using errcode = '40001'; end if;
  if v_row.archived_at is not null then raise exception 'registro_arquivado' using errcode = '55000'; end if;
  update public.financeiro_marcas set name = pg_catalog.btrim(p_name), updated_by = p_user_id
  where clinic_id = p_clinic_id and id = p_brand_id returning * into v_row;
  insert into public.financeiro_auditoria (
    clinic_id, actor_id, entity, entity_id, action, details, request_id
  ) values (
    p_clinic_id, p_user_id, 'marca', p_brand_id, 'editada',
    pg_catalog.jsonb_build_object('operation', 'edit', 'version', v_row.version, 'reason', v_reason),
    p_request_id
  );
  return pg_catalog.to_jsonb(v_row);
end;
$$;

create or replace function public.financeiro_arquivar_marca(
  p_clinic_id uuid, p_user_id uuid, p_brand_id uuid,
  p_expected_version integer, p_reason text, p_request_id uuid
)
returns jsonb language plpgsql set search_path = '' as $$
declare
  v_row public.financeiro_marcas%rowtype;
  v_reason text := private.financeiro_operation_reason(p_reason);
begin
  select * into v_row from public.financeiro_marcas
  where clinic_id = p_clinic_id and id = p_brand_id for update;
  if not found then raise exception 'marca_nao_encontrada' using errcode = 'P0002'; end if;
  if v_row.version <> p_expected_version then raise exception 'version_conflict' using errcode = '40001'; end if;
  if v_row.archived_at is not null then return pg_catalog.to_jsonb(v_row); end if;
  update public.financeiro_marcas set active = false, archived_at = now(), updated_by = p_user_id
  where clinic_id = p_clinic_id and id = p_brand_id returning * into v_row;
  insert into public.financeiro_auditoria (
    clinic_id, actor_id, entity, entity_id, action, details, request_id
  ) values (
    p_clinic_id, p_user_id, 'marca', p_brand_id, 'arquivada',
    pg_catalog.jsonb_build_object('operation', 'archive', 'version', v_row.version, 'reason', v_reason),
    p_request_id
  );
  return pg_catalog.to_jsonb(v_row);
end;
$$;

create or replace function public.financeiro_restaurar_marca(
  p_clinic_id uuid, p_user_id uuid, p_brand_id uuid,
  p_expected_version integer, p_reason text, p_request_id uuid
)
returns jsonb language plpgsql set search_path = '' as $$
declare
  v_row public.financeiro_marcas%rowtype;
  v_reason text := private.financeiro_operation_reason(p_reason);
begin
  select * into v_row from public.financeiro_marcas
  where clinic_id = p_clinic_id and id = p_brand_id for update;
  if not found then raise exception 'marca_nao_encontrada' using errcode = 'P0002'; end if;
  if v_row.version <> p_expected_version then raise exception 'version_conflict' using errcode = '40001'; end if;
  if v_row.archived_at is null then return pg_catalog.to_jsonb(v_row); end if;
  update public.financeiro_marcas set active = true, archived_at = null, updated_by = p_user_id
  where clinic_id = p_clinic_id and id = p_brand_id returning * into v_row;
  insert into public.financeiro_auditoria (
    clinic_id, actor_id, entity, entity_id, action, details, request_id
  ) values (
    p_clinic_id, p_user_id, 'marca', p_brand_id, 'restaurada',
    pg_catalog.jsonb_build_object('operation', 'restore', 'version', v_row.version, 'reason', v_reason),
    p_request_id
  );
  return pg_catalog.to_jsonb(v_row);
end;
$$;

create or replace function public.financeiro_editar_produto(
  p_clinic_id uuid, p_user_id uuid, p_product_id uuid, p_expected_version integer,
  p_brand_id uuid, p_name text, p_product_type text, p_unit text,
  p_reference_cost numeric, p_sale_price numeric, p_anvisa_registration text,
  p_stock_control boolean, p_reason text, p_request_id uuid
)
returns jsonb language plpgsql set search_path = '' as $$
declare
  v_row public.financeiro_produtos%rowtype;
  v_reason text := private.financeiro_operation_reason(p_reason);
begin
  select * into v_row from public.financeiro_produtos
  where clinic_id = p_clinic_id and id = p_product_id for update;
  if not found then raise exception 'produto_nao_encontrado' using errcode = 'P0002'; end if;
  if v_row.version <> p_expected_version then raise exception 'version_conflict' using errcode = '40001'; end if;
  if v_row.archived_at is not null then raise exception 'registro_arquivado' using errcode = '55000'; end if;
  if p_brand_id is not null and not exists (
    select 1 from public.financeiro_marcas
    where clinic_id = p_clinic_id and id = p_brand_id and active and archived_at is null
  ) then raise exception 'marca_invalida' using errcode = '23503'; end if;
  update public.financeiro_produtos
  set brand_id = p_brand_id, name = pg_catalog.btrim(p_name), product_type = p_product_type,
      unit = p_unit, reference_cost = p_reference_cost, sale_price = p_sale_price,
      anvisa_registration = nullif(pg_catalog.btrim(p_anvisa_registration), ''),
      stock_control = p_stock_control, updated_by = p_user_id
  where clinic_id = p_clinic_id and id = p_product_id returning * into v_row;
  insert into public.financeiro_auditoria (
    clinic_id, actor_id, entity, entity_id, action, details, request_id
  ) values (
    p_clinic_id, p_user_id, 'produto', p_product_id, 'editado',
    pg_catalog.jsonb_build_object('operation', 'edit', 'version', v_row.version, 'reason', v_reason),
    p_request_id
  );
  return pg_catalog.to_jsonb(v_row);
end;
$$;

create or replace function public.financeiro_arquivar_produto(
  p_clinic_id uuid, p_user_id uuid, p_product_id uuid,
  p_expected_version integer, p_reason text, p_request_id uuid
)
returns jsonb language plpgsql set search_path = '' as $$
declare
  v_row public.financeiro_produtos%rowtype;
  v_reason text := private.financeiro_operation_reason(p_reason);
begin
  select * into v_row from public.financeiro_produtos
  where clinic_id = p_clinic_id and id = p_product_id for update;
  if not found then raise exception 'produto_nao_encontrado' using errcode = 'P0002'; end if;
  if v_row.version <> p_expected_version then raise exception 'version_conflict' using errcode = '40001'; end if;
  if v_row.archived_at is not null then return pg_catalog.to_jsonb(v_row); end if;
  update public.financeiro_produtos set active = false, archived_at = now(), updated_by = p_user_id
  where clinic_id = p_clinic_id and id = p_product_id returning * into v_row;
  insert into public.financeiro_auditoria (
    clinic_id, actor_id, entity, entity_id, action, details, request_id
  ) values (
    p_clinic_id, p_user_id, 'produto', p_product_id, 'arquivado',
    pg_catalog.jsonb_build_object('operation', 'archive', 'version', v_row.version, 'reason', v_reason),
    p_request_id
  );
  return pg_catalog.to_jsonb(v_row);
end;
$$;

create or replace function public.financeiro_restaurar_produto(
  p_clinic_id uuid, p_user_id uuid, p_product_id uuid,
  p_expected_version integer, p_reason text, p_request_id uuid
)
returns jsonb language plpgsql set search_path = '' as $$
declare
  v_row public.financeiro_produtos%rowtype;
  v_reason text := private.financeiro_operation_reason(p_reason);
begin
  select * into v_row from public.financeiro_produtos
  where clinic_id = p_clinic_id and id = p_product_id for update;
  if not found then raise exception 'produto_nao_encontrado' using errcode = 'P0002'; end if;
  if v_row.version <> p_expected_version then raise exception 'version_conflict' using errcode = '40001'; end if;
  if v_row.archived_at is null then return pg_catalog.to_jsonb(v_row); end if;
  update public.financeiro_produtos set active = true, archived_at = null, updated_by = p_user_id
  where clinic_id = p_clinic_id and id = p_product_id returning * into v_row;
  insert into public.financeiro_auditoria (
    clinic_id, actor_id, entity, entity_id, action, details, request_id
  ) values (
    p_clinic_id, p_user_id, 'produto', p_product_id, 'restaurado',
    pg_catalog.jsonb_build_object('operation', 'restore', 'version', v_row.version, 'reason', v_reason),
    p_request_id
  );
  return pg_catalog.to_jsonb(v_row);
end;
$$;

-- ---------------------------------------------------------------------------
-- Registro de custo e atualizacao atomica do custo corrente do produto
-- ---------------------------------------------------------------------------

create or replace function public.financeiro_salvar_custo_produto(
  p_clinic_id uuid, p_user_id uuid, p_product_id uuid, p_expected_product_version integer,
  p_supplier_id uuid, p_source text, p_cost_date date, p_payment_condition text,
  p_package_quantity numeric, p_package_unit text, p_total_cost numeric, p_unit_cost numeric,
  p_notes text, p_is_current boolean, p_operation_id uuid, p_reason text, p_request_id uuid
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_product public.financeiro_produtos%rowtype;
  v_cost public.financeiro_produto_custos%rowtype;
  v_existing public.financeiro_produto_custos%rowtype;
  v_reason text := private.financeiro_operation_reason(p_reason);
  v_source text := pg_catalog.btrim(p_source);
  v_condition text := nullif(pg_catalog.btrim(p_payment_condition), '');
  v_package_unit text := pg_catalog.btrim(p_package_unit);
  v_notes text := nullif(pg_catalog.btrim(p_notes), '');
begin
  if p_operation_id is null then
    raise exception 'operation_id_obrigatorio' using errcode = '22023';
  end if;

  -- Serializa repeticoes concorrentes da mesma operacao antes da consulta.
  -- Sem este lock, duas requisicoes iguais poderiam passar pelo NOT FOUND e a
  -- segunda terminaria em violacao de unicidade, em vez de resposta idempotente.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      p_clinic_id::text || ':produto_custo:' || p_operation_id::text,
      0
    )
  );

  select * into v_existing
  from public.financeiro_produto_custos
  where clinic_id = p_clinic_id and operation_id = p_operation_id;
  if found then
    if v_existing.product_id is distinct from p_product_id
       or v_existing.supplier_id is distinct from p_supplier_id
       or v_existing.source is distinct from v_source
       or v_existing.cost_date is distinct from p_cost_date
       or v_existing.payment_condition is distinct from v_condition
       or v_existing.package_quantity is distinct from round(p_package_quantity, 4)
       or v_existing.package_unit is distinct from v_package_unit
       or v_existing.total_cost is distinct from round(p_total_cost, 2)
       or v_existing.unit_cost is distinct from round(p_unit_cost, 4)
       or v_existing.notes is distinct from v_notes
       or v_existing.sets_current is distinct from p_is_current then
      raise exception 'idempotency_key_reused' using errcode = '22023';
    end if;
    select * into v_product from public.financeiro_produtos
    where clinic_id = p_clinic_id and id = p_product_id;
    return pg_catalog.jsonb_build_object(
      'custo', pg_catalog.to_jsonb(v_existing),
      'produto', pg_catalog.to_jsonb(v_product),
      'idempotente', true
    );
  end if;

  select * into v_product from public.financeiro_produtos
  where clinic_id = p_clinic_id and id = p_product_id for update;
  if not found then raise exception 'produto_nao_encontrado' using errcode = 'P0002'; end if;
  if v_product.version <> p_expected_product_version then
    raise exception 'version_conflict' using errcode = '40001';
  end if;
  if v_product.archived_at is not null or not v_product.active then
    raise exception 'registro_arquivado' using errcode = '55000';
  end if;
  if p_supplier_id is not null and not exists (
    select 1 from public.financeiro_fornecedores
    where clinic_id = p_clinic_id and id = p_supplier_id and active and archived_at is null
  ) then raise exception 'fornecedor_invalido' using errcode = '23503'; end if;
  if p_package_quantity <= 0 or p_total_cost <= 0 or p_unit_cost <= 0
     or abs(round(p_package_quantity * p_unit_cost, 2) - round(p_total_cost, 2)) > 0.01 then
    raise exception 'custo_total_diverge' using errcode = '22003';
  end if;

  if p_is_current then
    update public.financeiro_produto_custos
    set is_current = false
    where clinic_id = p_clinic_id and product_id = p_product_id and is_current;
  end if;

  insert into public.financeiro_produto_custos (
    clinic_id, product_id, supplier_id, source, cost_date, payment_condition,
    package_quantity, package_unit, total_cost, unit_cost, notes, sets_current, is_current,
    operation_id, created_by
  ) values (
    p_clinic_id, p_product_id, p_supplier_id, v_source, p_cost_date, v_condition,
    round(p_package_quantity, 4), v_package_unit, round(p_total_cost, 2),
    round(p_unit_cost, 4), v_notes, p_is_current, p_is_current, p_operation_id, p_user_id
  ) returning * into v_cost;

  if p_is_current then
    update public.financeiro_produtos
    set reference_cost = round(p_unit_cost, 2), updated_by = p_user_id
    where clinic_id = p_clinic_id and id = p_product_id
    returning * into v_product;
  end if;

  insert into public.financeiro_auditoria (
    clinic_id, actor_id, entity, entity_id, action, details, request_id
  ) values (
    p_clinic_id, p_user_id, 'produto_custo', v_cost.id, 'registrado',
    pg_catalog.jsonb_build_object(
      'operation', case when p_is_current then 'set_current' else 'append_history' end,
      'version', v_product.version,
      'reason', v_reason
    ),
    p_request_id
  );
  return pg_catalog.jsonb_build_object(
    'custo', pg_catalog.to_jsonb(v_cost),
    'produto', pg_catalog.to_jsonb(v_product),
    'idempotente', false
  );
end;
$$;

-- Cancela um custo incorreto por evento compensatorio. O evento original fica
-- imutavel. Se ele era o custo corrente, o ultimo custo valido que ja havia
-- sido corrente e copiado para um novo evento; sem historico valido, o produto
-- fica explicitamente com custo pendente (reference_cost = null).
create or replace function public.financeiro_cancelar_custo_produto(
  p_clinic_id uuid,
  p_user_id uuid,
  p_cost_id uuid,
  p_expected_product_version integer,
  p_reason text,
  p_operation_id uuid,
  p_request_id uuid
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_cost public.financeiro_produto_custos%rowtype;
  v_previous public.financeiro_produto_custos%rowtype;
  v_replacement public.financeiro_produto_custos%rowtype;
  v_product public.financeiro_produtos%rowtype;
  v_cancellation public.financeiro_produto_custo_cancelamentos%rowtype;
  v_existing public.financeiro_produto_custo_cancelamentos%rowtype;
  v_reason text := private.financeiro_operation_reason(p_reason);
  v_replacement_operation_id uuid;
  v_result_status text := 'historical_cancelled';
begin
  if p_cost_id is null or p_operation_id is null or p_request_id is null then
    raise exception 'cancelamento_custo_parametros_invalidos' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      p_clinic_id::text || ':cancelamento_custo:' || p_operation_id::text,
      0
    )
  );

  select * into v_existing
  from public.financeiro_produto_custo_cancelamentos
  where clinic_id = p_clinic_id and operation_id = p_operation_id;
  if found then
    if v_existing.cost_id is distinct from p_cost_id then
      raise exception 'idempotency_key_reused' using errcode = '22023';
    end if;
    select * into v_cost
    from public.financeiro_produto_custos
    where clinic_id = p_clinic_id and id = v_existing.cost_id;
    select * into v_product
    from public.financeiro_produtos
    where clinic_id = p_clinic_id and id = v_cost.product_id;
    if v_existing.replacement_cost_id is not null then
      select * into v_replacement
      from public.financeiro_produto_custos
      where clinic_id = p_clinic_id and id = v_existing.replacement_cost_id;
    end if;
    return pg_catalog.jsonb_build_object(
      'cancelamento', pg_catalog.to_jsonb(v_existing),
      'custo', pg_catalog.to_jsonb(v_cost),
      'custo_substituto', case when v_replacement.id is null then null
        else pg_catalog.to_jsonb(v_replacement) end,
      'produto', pg_catalog.to_jsonb(v_product),
      'idempotente', true
    );
  end if;

  -- Descobre o produto sem reter o custo antes dele. Todas as rotas que
  -- alteram o custo corrente travam primeiro o produto, evitando deadlocks.
  select * into v_cost
  from public.financeiro_produto_custos
  where clinic_id = p_clinic_id and id = p_cost_id;
  if not found then
    raise exception 'custo_nao_encontrado' using errcode = 'P0002';
  end if;

  select * into v_product
  from public.financeiro_produtos
  where clinic_id = p_clinic_id and id = v_cost.product_id
  for update;
  if not found then
    raise exception 'produto_nao_encontrado' using errcode = 'P0002';
  end if;
  if p_expected_product_version is null
     or v_product.version <> p_expected_product_version then
    raise exception 'version_conflict' using errcode = '40001';
  end if;

  select * into v_cost
  from public.financeiro_produto_custos
  where clinic_id = p_clinic_id and id = p_cost_id
  for update;

  select * into v_existing
  from public.financeiro_produto_custo_cancelamentos
  where clinic_id = p_clinic_id and cost_id = p_cost_id;
  if found then
    raise exception 'custo_ja_cancelado' using errcode = '55000';
  end if;

  if v_cost.is_current then
    update public.financeiro_produto_custos
    set is_current = false
    where clinic_id = p_clinic_id and id = p_cost_id and is_current;

    select candidate.* into v_previous
    from public.financeiro_produto_custos as candidate
    where candidate.clinic_id = p_clinic_id
      and candidate.product_id = v_cost.product_id
      and candidate.id <> p_cost_id
      and candidate.sets_current
      and not exists (
        select 1
        from public.financeiro_produto_custo_cancelamentos as cancellation
        where cancellation.clinic_id = candidate.clinic_id
          and cancellation.cost_id = candidate.id
      )
    order by candidate.cost_date desc, candidate.created_at desc, candidate.id desc
    limit 1;

    if found then
      v_replacement_operation_id := pg_catalog.md5(
        p_operation_id::text || ':replacement-cost'
      )::uuid;
      insert into public.financeiro_produto_custos (
        clinic_id, product_id, supplier_id, source, cost_date,
        payment_condition, package_quantity, package_unit,
        total_cost, unit_cost, notes, sets_current, is_current,
        operation_id, created_by
      ) values (
        p_clinic_id, v_cost.product_id, v_previous.supplier_id,
        'Custo anterior reposto por cancelamento',
        (pg_catalog.now() at time zone 'America/Sao_Paulo')::date,
        v_previous.payment_condition, v_previous.package_quantity,
        v_previous.package_unit, v_previous.total_cost,
        v_previous.unit_cost,
        'Evento compensatorio; custo incorreto preservado como cancelado.',
        true, true, v_replacement_operation_id, p_user_id
      ) returning * into v_replacement;

      update public.financeiro_produtos
      set reference_cost = pg_catalog.round(v_previous.unit_cost, 2),
          updated_by = p_user_id
      where clinic_id = p_clinic_id and id = v_cost.product_id
      returning * into v_product;
      v_result_status := 'current_replaced';
    else
      update public.financeiro_produtos
      set reference_cost = null,
          updated_by = p_user_id
      where clinic_id = p_clinic_id and id = v_cost.product_id
      returning * into v_product;
      v_result_status := 'current_pending';
    end if;
  end if;

  insert into public.financeiro_produto_custo_cancelamentos (
    clinic_id, cost_id, replacement_cost_id, reason, result_status,
    operation_id, cancelled_by
  ) values (
    p_clinic_id, p_cost_id, v_replacement.id, v_reason, v_result_status,
    p_operation_id, p_user_id
  ) returning * into v_cancellation;

  insert into public.financeiro_auditoria (
    clinic_id, actor_id, entity, entity_id, action, details, request_id
  ) values (
    p_clinic_id, p_user_id, 'produto_custo', p_cost_id, 'cancelado',
    pg_catalog.jsonb_build_object(
      'operation', 'cancel_cost',
      'version', v_product.version,
      'new_status', v_result_status,
      'reason', v_reason
    ),
    p_request_id
  );

  return pg_catalog.jsonb_build_object(
    'cancelamento', pg_catalog.to_jsonb(v_cancellation),
    'custo', pg_catalog.to_jsonb(v_cost),
    'custo_substituto', case when v_replacement.id is null then null
      else pg_catalog.to_jsonb(v_replacement) end,
    'produto', pg_catalog.to_jsonb(v_product),
    'idempotente', false
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Cancelamento integral de compra com estornos compensatorios
-- ---------------------------------------------------------------------------

create or replace function public.financeiro_cancelar_compra(
  p_clinic_id uuid, p_user_id uuid, p_purchase_id uuid, p_expected_version integer,
  p_reason text, p_operation_id uuid, p_request_id uuid
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_purchase public.financeiro_compras%rowtype;
  v_entry public.financeiro_lancamentos%rowtype;
  v_payment record;
  v_refund_id uuid;
  v_reversal_count integer := 0;
  v_cancelled_installments integer := 0;
  v_reason text := private.financeiro_operation_reason(p_reason);
begin
  select * into v_purchase from public.financeiro_compras
  where clinic_id = p_clinic_id and id = p_purchase_id for update;
  if not found then raise exception 'compra_nao_encontrada' using errcode = 'P0002'; end if;

  if v_purchase.state = 'cancelada' then
    if v_purchase.cancellation_operation_id = p_operation_id then
      return pg_catalog.jsonb_build_object(
        'compra_id', v_purchase.id,
        'lancamento_id', v_purchase.expense_entry_id,
        'versao', v_purchase.version,
        'estornos', 0,
        'parcelas_canceladas', 0,
        'idempotente', true
      );
    end if;
    raise exception 'compra_ja_cancelada' using errcode = '55000';
  end if;
  if v_purchase.version <> p_expected_version then
    raise exception 'version_conflict' using errcode = '40001';
  end if;

  select * into v_entry from public.financeiro_lancamentos
  where clinic_id = p_clinic_id and id = v_purchase.expense_entry_id for update;
  if not found or v_entry.origin <> 'compra' or v_entry.state <> 'ativo' then
    raise exception 'compra_lancamento_inconsistente' using errcode = '55000';
  end if;

  for v_payment in
    select
      payment.*,
      (payment.amount - coalesce(sum(refund.amount), 0))::numeric(14,2) as reversible_amount
    from public.financeiro_pagamentos payment
    left join public.financeiro_pagamentos refund
      on refund.clinic_id = payment.clinic_id
     and refund.reversed_payment_id = payment.id
     and refund.movement_type = 'estorno'
    where payment.clinic_id = p_clinic_id
      and payment.entry_id = v_purchase.expense_entry_id
      and payment.movement_type = 'pagamento'
    group by payment.id
    having payment.amount - coalesce(sum(refund.amount), 0) > 0
    order by payment.created_at, payment.id
  loop
    v_refund_id := public.financeiro_registrar_pagamento(
      p_clinic_id,
      p_user_id,
      v_purchase.expense_entry_id,
      'estorno',
      v_payment.payment_method,
      v_payment.reversible_amount,
      now(),
      v_payment.installments,
      null,
      v_payment.id,
      gen_random_uuid(),
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
  set state = 'cancelada', cancelled_by = p_user_id, cancelled_at = now(), updated_by = p_user_id
  where clinic_id = p_clinic_id
    and entry_id = v_purchase.expense_entry_id
    and state = 'ativa';
  get diagnostics v_cancelled_installments = row_count;

  update public.financeiro_compras
  set state = 'cancelada',
      cancelled_by = p_user_id,
      cancelled_at = now(),
      cancellation_reason = v_reason,
      cancellation_operation_id = p_operation_id,
      updated_by = p_user_id
  where clinic_id = p_clinic_id and id = p_purchase_id
  returning * into v_purchase;

  update public.financeiro_lancamentos
  set state = 'cancelado',
      cancelled_by = p_user_id,
      cancelled_at = now(),
      cancellation_reason = v_reason,
      updated_by = p_user_id
  where clinic_id = p_clinic_id and id = v_purchase.expense_entry_id;

  insert into public.financeiro_auditoria (
    clinic_id, actor_id, entity, entity_id, action, details, request_id
  ) values (
    p_clinic_id, p_user_id, 'financeiro_compra', p_purchase_id, 'cancelada',
    pg_catalog.jsonb_build_object(
      'operation', 'cancel_with_reversals',
      'item_count', v_reversal_count,
      'result_count', v_cancelled_installments,
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
    'parcelas_canceladas', v_cancelled_installments,
    'idempotente', false
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Menor privilegio: somente o backend service_role pode executar as RPCs.
-- ---------------------------------------------------------------------------

revoke all on function public.financeiro_editar_cliente(uuid,uuid,uuid,integer,text,date,text,text,text,text,text,text,text,uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.financeiro_arquivar_cliente(uuid,uuid,uuid,integer,text,uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.financeiro_restaurar_cliente(uuid,uuid,uuid,integer,text,uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.financeiro_editar_fornecedor(uuid,uuid,uuid,integer,text,text,text,text,text,uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.financeiro_arquivar_fornecedor(uuid,uuid,uuid,integer,text,uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.financeiro_restaurar_fornecedor(uuid,uuid,uuid,integer,text,uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.financeiro_editar_marca(uuid,uuid,uuid,integer,text,text,uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.financeiro_arquivar_marca(uuid,uuid,uuid,integer,text,uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.financeiro_restaurar_marca(uuid,uuid,uuid,integer,text,uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.financeiro_editar_produto(uuid,uuid,uuid,integer,uuid,text,text,text,numeric,numeric,text,boolean,text,uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.financeiro_arquivar_produto(uuid,uuid,uuid,integer,text,uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.financeiro_restaurar_produto(uuid,uuid,uuid,integer,text,uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.financeiro_salvar_custo_produto(uuid,uuid,uuid,integer,uuid,text,date,text,numeric,text,numeric,numeric,text,boolean,uuid,text,uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.financeiro_cancelar_custo_produto(uuid,uuid,uuid,integer,text,uuid,uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.financeiro_cancelar_compra(uuid,uuid,uuid,integer,text,uuid,uuid)
  from public, anon, authenticated, service_role;

grant execute on function public.financeiro_editar_cliente(uuid,uuid,uuid,integer,text,date,text,text,text,text,text,text,text,uuid)
  to service_role;
grant execute on function public.financeiro_arquivar_cliente(uuid,uuid,uuid,integer,text,uuid)
  to service_role;
grant execute on function public.financeiro_restaurar_cliente(uuid,uuid,uuid,integer,text,uuid)
  to service_role;
grant execute on function public.financeiro_editar_fornecedor(uuid,uuid,uuid,integer,text,text,text,text,text,uuid)
  to service_role;
grant execute on function public.financeiro_arquivar_fornecedor(uuid,uuid,uuid,integer,text,uuid)
  to service_role;
grant execute on function public.financeiro_restaurar_fornecedor(uuid,uuid,uuid,integer,text,uuid)
  to service_role;
grant execute on function public.financeiro_editar_marca(uuid,uuid,uuid,integer,text,text,uuid)
  to service_role;
grant execute on function public.financeiro_arquivar_marca(uuid,uuid,uuid,integer,text,uuid)
  to service_role;
grant execute on function public.financeiro_restaurar_marca(uuid,uuid,uuid,integer,text,uuid)
  to service_role;
grant execute on function public.financeiro_editar_produto(uuid,uuid,uuid,integer,uuid,text,text,text,numeric,numeric,text,boolean,text,uuid)
  to service_role;
grant execute on function public.financeiro_arquivar_produto(uuid,uuid,uuid,integer,text,uuid)
  to service_role;
grant execute on function public.financeiro_restaurar_produto(uuid,uuid,uuid,integer,text,uuid)
  to service_role;
grant execute on function public.financeiro_salvar_custo_produto(uuid,uuid,uuid,integer,uuid,text,date,text,numeric,text,numeric,numeric,text,boolean,uuid,text,uuid)
  to service_role;
grant execute on function public.financeiro_cancelar_custo_produto(uuid,uuid,uuid,integer,text,uuid,uuid)
  to service_role;
grant execute on function public.financeiro_cancelar_compra(uuid,uuid,uuid,integer,text,uuid,uuid)
  to service_role;

comment on table public.financeiro_produto_custos is
  'Historico privado e auditavel de custos. Registros nao sao apagados; somente o marcador corrente pode ser desativado.';
comment on table public.financeiro_produto_custo_cancelamentos is
  'Livro imutavel de cancelamentos compensatorios de custos lancados incorretamente.';
comment on function public.financeiro_cancelar_custo_produto(uuid,uuid,uuid,integer,text,uuid,uuid) is
  'Cancela um custo por evento imutavel e recompoe explicitamente o custo corrente quando houver historico valido.';
comment on function public.financeiro_cancelar_compra(uuid,uuid,uuid,integer,text,uuid,uuid) is
  'Cancela uma compra sem apagar dados: estorna pagamentos, cancela parcelas e o lancamento relacionado na mesma transacao.';

commit;

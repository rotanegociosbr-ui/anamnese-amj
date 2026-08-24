begin;

-- Gestão administrativa isolada: fluxo derivado, fechamentos versionados,
-- equipamentos/manutenções e métricas agregadas. O navegador não acessa
-- diretamente nenhuma tabela; somente a Edge autenticada (owner + AAL2) usa
-- service_role. Não há hard delete neste domínio.

create schema if not exists private;
revoke all on schema private from public, anon, authenticated, service_role;
grant usage on schema private to service_role;

create or replace function private.gestao_assert_owner(
  p_clinic_id uuid,
  p_actor_id uuid
)
returns void
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  if p_clinic_id is null or p_actor_id is null or not exists (
    select 1
    from public.clinic_members member
    where member.clinic_id = p_clinic_id
      and member.user_id = p_actor_id
      and member.role = 'owner'
      and member.status = 'active'
  ) then
    raise exception 'gestao_owner_required' using errcode = '42501';
  end if;
end;
$function$;

create or replace function private.gestao_audit_details_are_safe(p_details jsonb)
returns boolean
language sql
immutable
strict
parallel safe
set search_path = ''
as $function$
  select pg_catalog.jsonb_typeof(p_details) = 'object'
    and pg_catalog.pg_column_size(p_details) <= 2048
    and not exists (
      select 1
      from pg_catalog.jsonb_each(p_details) item(key, value)
      where item.key not in (
        'source', 'previous_status', 'new_status', 'previous_version',
        'new_version', 'period_month', 'closure_version', 'maintenance_kind',
        'reason_present', 'result_count', 'idempotent'
      )
      or pg_catalog.jsonb_typeof(item.value) not in ('string', 'number', 'boolean', 'null')
      or (
        pg_catalog.jsonb_typeof(item.value) = 'string'
        and (
          pg_catalog.length(item.value #>> '{}') > 100
          or (item.value #>> '{}') !~ '^[A-Za-z0-9_.:/-]*$'
        )
      )
    );
$function$;

revoke all on function private.gestao_assert_owner(uuid,uuid)
  from public, anon, authenticated, service_role;
grant execute on function private.gestao_assert_owner(uuid,uuid) to service_role;
revoke all on function private.gestao_audit_details_are_safe(jsonb)
  from public, anon, authenticated, service_role;
grant execute on function private.gestao_audit_details_are_safe(jsonb) to service_role;

create table public.gestao_fechamentos_mensais (
  id uuid primary key,
  clinic_id uuid not null references public.clinics(id) on delete restrict,
  period_start date not null,
  version integer not null check (version > 0),
  competence_revenue numeric(14,2) not null default 0,
  competence_expense numeric(14,2) not null default 0,
  cash_in numeric(14,2) not null default 0,
  cash_out numeric(14,2) not null default 0,
  net_cash_flow numeric(14,2) not null default 0,
  receivable_open numeric(14,2) not null default 0,
  payable_open numeric(14,2) not null default 0,
  overdue_receivable numeric(14,2) not null default 0,
  overdue_payable numeric(14,2) not null default 0,
  inventory_value numeric(18,2) not null default 0,
  inventory_negative_count integer not null default 0 check (inventory_negative_count >= 0),
  returns_due_count integer not null default 0 check (returns_due_count >= 0),
  equipment_count integer not null default 0 check (equipment_count >= 0),
  equipment_unavailable_count integer not null default 0 check (equipment_unavailable_count >= 0),
  maintenance_overdue_count integer not null default 0 check (maintenance_overdue_count >= 0),
  definition_version text not null default 'gestao-v1'
    check (definition_version ~ '^[a-z0-9_.-]{3,40}$'),
  source_cutoff_at timestamptz not null default pg_catalog.now(),
  close_reason text not null check (
    pg_catalog.char_length(pg_catalog.btrim(close_reason)) between 3 and 300
    and close_reason !~ '[[:cntrl:]]'
  ),
  operation_id uuid not null,
  request_id uuid not null,
  closed_by uuid not null references auth.users(id) on delete restrict,
  closed_at timestamptz not null default pg_catalog.now(),
  constraint gestao_fechamentos_period_first_day check (
    period_start = pg_catalog.date_trunc('month', period_start)::date
  ),
  constraint gestao_fechamentos_clinic_id_id_key unique (clinic_id, id),
  constraint gestao_fechamentos_version_unique unique (clinic_id, period_start, version),
  constraint gestao_fechamentos_operation_unique unique (clinic_id, operation_id)
);

create table public.gestao_fechamento_reaberturas (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete restrict,
  closure_id uuid not null,
  reopen_reason text not null check (
    pg_catalog.char_length(pg_catalog.btrim(reopen_reason)) between 3 and 300
    and reopen_reason !~ '[[:cntrl:]]'
  ),
  operation_id uuid not null,
  request_id uuid not null,
  reopened_by uuid not null references auth.users(id) on delete restrict,
  reopened_at timestamptz not null default pg_catalog.now(),
  constraint gestao_reabertura_closure_fk
    foreign key (clinic_id, closure_id)
    references public.gestao_fechamentos_mensais(clinic_id, id) on delete restrict,
  constraint gestao_reabertura_closure_unique unique (clinic_id, closure_id),
  constraint gestao_reabertura_operation_unique unique (clinic_id, operation_id)
);

create table public.gestao_equipamentos (
  id uuid primary key,
  clinic_id uuid not null references public.clinics(id) on delete restrict,
  asset_code text not null check (
    pg_catalog.char_length(pg_catalog.btrim(asset_code)) between 2 and 40
    and asset_code ~ '^[A-Za-z0-9._/-]+$'
  ),
  category text not null check (pg_catalog.char_length(pg_catalog.btrim(category)) between 2 and 80),
  name text not null check (pg_catalog.char_length(pg_catalog.btrim(name)) between 2 and 120),
  brand text check (brand is null or pg_catalog.char_length(pg_catalog.btrim(brand)) between 2 and 80),
  model text check (model is null or pg_catalog.char_length(pg_catalog.btrim(model)) between 1 and 100),
  serial_number text check (
    serial_number is null or (
      pg_catalog.char_length(pg_catalog.btrim(serial_number)) between 1 and 100
      and serial_number !~ '[[:cntrl:]]'
    )
  ),
  patrimonial_number text check (
    patrimonial_number is null or pg_catalog.char_length(pg_catalog.btrim(patrimonial_number)) between 1 and 80
  ),
  location text check (location is null or pg_catalog.char_length(pg_catalog.btrim(location)) between 2 and 120),
  possession_mode text not null default 'proprio' check (
    possession_mode in ('proprio', 'locacao', 'comodato', 'leasing', 'outro')
  ),
  supplier_id uuid,
  acquisition_date date,
  acquisition_cost numeric(14,2) check (acquisition_cost is null or acquisition_cost >= 0),
  warranty_start date,
  warranty_end date,
  warranty_reference text check (
    warranty_reference is null or pg_catalog.char_length(pg_catalog.btrim(warranty_reference)) between 2 and 200
  ),
  manual_reference text check (
    manual_reference is null or pg_catalog.char_length(pg_catalog.btrim(manual_reference)) between 2 and 300
  ),
  technical_source_reference text check (
    technical_source_reference is null or pg_catalog.char_length(pg_catalog.btrim(technical_source_reference)) between 2 and 300
  ),
  responsible_label text check (
    responsible_label is null or pg_catalog.char_length(pg_catalog.btrim(responsible_label)) between 2 and 120
  ),
  criticality text not null default 'media' check (
    criticality in ('baixa', 'media', 'alta', 'critica')
  ),
  status text not null default 'em_cadastro' check (
    status in (
      'em_cadastro', 'ativo', 'disponivel', 'em_uso', 'reserva',
      'em_manutencao', 'aguardando_peca', 'aguardando_validacao',
      'quarentena', 'indisponivel', 'desativado', 'baixa_pendente', 'baixado'
    )
  ),
  notes text check (notes is null or pg_catalog.char_length(notes) <= 1000),
  idempotency_key uuid not null,
  archived_at timestamptz,
  archived_by uuid references auth.users(id) on delete restrict,
  archive_reason text check (
    archive_reason is null or pg_catalog.char_length(pg_catalog.btrim(archive_reason)) between 3 and 300
  ),
  created_by uuid not null references auth.users(id) on delete restrict,
  updated_by uuid references auth.users(id) on delete restrict,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  version integer not null default 1 check (version > 0),
  constraint gestao_equipamentos_clinic_id_id_key unique (clinic_id, id),
  constraint gestao_equipamentos_idempotency_unique unique (clinic_id, idempotency_key),
  constraint gestao_equipamentos_supplier_fk
    foreign key (clinic_id, supplier_id)
    references public.financeiro_fornecedores(clinic_id, id) on delete restrict,
  constraint gestao_equipamentos_warranty_check check (
    warranty_start is null or warranty_end is null or warranty_end >= warranty_start
  ),
  constraint gestao_equipamentos_archive_check check (
    (archived_at is null and archived_by is null and archive_reason is null)
    or
    (archived_at is not null and archived_by is not null and archive_reason is not null)
  )
);

create table public.gestao_equipamento_manutencoes (
  id uuid primary key,
  clinic_id uuid not null references public.clinics(id) on delete restrict,
  equipment_id uuid not null,
  correction_of_id uuid,
  maintenance_kind text not null check (
    maintenance_kind in (
      'preventiva', 'corretiva', 'inspecao_visual', 'verificacao_funcional',
      'teste_seguranca', 'calibracao', 'qualificacao', 'limpeza', 'outro'
    )
  ),
  status text not null default 'planejada' check (
    status in ('planejada', 'agendada', 'em_andamento', 'concluida', 'cancelada')
  ),
  description text not null check (
    pg_catalog.char_length(pg_catalog.btrim(description)) between 3 and 500
    and description !~ '[[:cntrl:]]'
  ),
  symptom text check (symptom is null or pg_catalog.char_length(pg_catalog.btrim(symptom)) between 3 and 500),
  service_provider text check (
    service_provider is null or pg_catalog.char_length(pg_catalog.btrim(service_provider)) between 2 and 160
  ),
  service_order_reference text check (
    service_order_reference is null or pg_catalog.char_length(pg_catalog.btrim(service_order_reference)) between 1 and 120
  ),
  scheduled_for date,
  started_at timestamptz,
  completed_at timestamptz,
  next_due_date date,
  technical_source_type text not null default 'pending_validation' check (
    technical_source_type in (
      'official_manual', 'manufacturer', 'authorized_service', 'contract',
      'regulatory', 'responsible_technical', 'pending_validation'
    )
  ),
  technical_source_reference text check (
    technical_source_reference is null or pg_catalog.char_length(pg_catalog.btrim(technical_source_reference)) between 3 and 300
  ),
  cost numeric(14,2) check (cost is null or cost >= 0),
  downtime_minutes integer check (downtime_minutes is null or downtime_minutes >= 0),
  result_summary text check (
    result_summary is null or pg_catalog.char_length(pg_catalog.btrim(result_summary)) between 3 and 1000
  ),
  evidence_reference text check (
    evidence_reference is null or pg_catalog.char_length(pg_catalog.btrim(evidence_reference)) between 2 and 300
  ),
  cancellation_reason text check (
    cancellation_reason is null or pg_catalog.char_length(pg_catalog.btrim(cancellation_reason)) between 3 and 300
  ),
  cancelled_at timestamptz,
  cancelled_by uuid references auth.users(id) on delete restrict,
  idempotency_key uuid not null,
  created_by uuid not null references auth.users(id) on delete restrict,
  updated_by uuid references auth.users(id) on delete restrict,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  version integer not null default 1 check (version > 0),
  constraint gestao_manutencoes_clinic_id_id_key unique (clinic_id, id),
  constraint gestao_manutencoes_idempotency_unique unique (clinic_id, idempotency_key),
  constraint gestao_manutencoes_equipment_fk
    foreign key (clinic_id, equipment_id)
    references public.gestao_equipamentos(clinic_id, id) on delete restrict,
  constraint gestao_manutencoes_correction_fk
    foreign key (clinic_id, correction_of_id)
    references public.gestao_equipamento_manutencoes(clinic_id, id) on delete restrict,
  constraint gestao_manutencoes_source_check check (
    next_due_date is null or (
      technical_source_type <> 'pending_validation'
      and technical_source_reference is not null
    )
  ),
  constraint gestao_manutencoes_status_fields_check check (
    (
      status = 'concluida'
      and completed_at is not null
      and result_summary is not null
      and cancelled_at is null and cancelled_by is null and cancellation_reason is null
    )
    or
    (
      status = 'cancelada'
      and cancelled_at is not null and cancelled_by is not null and cancellation_reason is not null
      and completed_at is null
    )
    or
    (
      status in ('planejada', 'agendada', 'em_andamento')
      and completed_at is null
      and cancelled_at is null and cancelled_by is null and cancellation_reason is null
    )
  )
);

create table public.gestao_administrativa_auditoria (
  id bigint generated always as identity primary key,
  clinic_id uuid not null references public.clinics(id) on delete restrict,
  actor_id uuid not null references auth.users(id) on delete restrict,
  entity text not null check (entity ~ '^[a-z][a-z0-9_.:-]{1,79}$'),
  entity_id uuid,
  action text not null check (action ~ '^[a-z][a-z0-9_.:-]{1,79}$'),
  outcome text not null default 'success' check (outcome in ('success', 'denied', 'error')),
  operation_id uuid not null,
  request_id uuid not null,
  details jsonb not null default '{}'::jsonb check (
    private.gestao_audit_details_are_safe(details)
  ),
  created_at timestamptz not null default pg_catalog.now(),
  constraint gestao_auditoria_operation_unique unique (clinic_id, operation_id)
);

create table public.gestao_fontes_catalogo (
  code text primary key check (code ~ '^[a-z][a-z0-9_.-]{2,79}$'),
  label text not null check (pg_catalog.char_length(pg_catalog.btrim(label)) between 3 and 120),
  source_relation text not null check (source_relation ~ '^public\.[a-z][a-z0-9_]{2,80}$'),
  classification text not null check (
    classification in ('operacional_observada', 'derivada_rastreavel', 'validacao_pendente')
  ),
  owner_role text not null default 'owner' check (owner_role in ('owner', 'contador', 'responsavel_tecnico')),
  status text not null check (status in ('observada', 'provisoria', 'validacao_contabil', 'inativa')),
  contains_personal_data boolean not null default false,
  notes text not null check (pg_catalog.char_length(pg_catalog.btrim(notes)) between 3 and 300),
  definition_version text not null default 'gestao-v1'
    check (definition_version ~ '^[a-z0-9_.-]{3,40}$')
);

create table public.gestao_metricas_catalogo (
  code text primary key check (code ~ '^[a-z][a-z0-9_.-]{2,79}$'),
  label text not null check (pg_catalog.char_length(pg_catalog.btrim(label)) between 3 and 120),
  definition text not null check (pg_catalog.char_length(pg_catalog.btrim(definition)) between 10 and 500),
  formula text not null check (pg_catalog.char_length(pg_catalog.btrim(formula)) between 3 and 500),
  unit text not null check (unit in ('BRL', 'percent', 'count', 'date', 'minutes')),
  source_code text not null references public.gestao_fontes_catalogo(code) on delete restrict,
  owner_role text not null default 'owner' check (owner_role in ('owner', 'contador', 'responsavel_tecnico')),
  status text not null check (status in ('aprovada_gerencial', 'provisoria', 'validacao_contabil', 'inativa')),
  privacy_level text not null default 'agregado' check (privacy_level = 'agregado'),
  limitation text not null check (pg_catalog.char_length(pg_catalog.btrim(limitation)) between 3 and 400),
  definition_version text not null default 'gestao-v1'
    check (definition_version ~ '^[a-z0-9_.-]{3,40}$')
);

create table public.gestao_backup_restauracao_evidencias (
  id uuid primary key,
  clinic_id uuid not null references public.clinics(id) on delete restrict,
  event_kind text not null check (
    event_kind in ('backup_executado', 'restauracao_testada', 'restauracao_falhou')
  ),
  system_scope text not null check (
    pg_catalog.char_length(pg_catalog.btrim(system_scope)) between 3 and 120
    and system_scope !~ '[[:cntrl:]]'
  ),
  occurred_at timestamptz not null,
  result text not null check (result in ('sucesso', 'falha')),
  evidence_reference text not null check (
    pg_catalog.char_length(pg_catalog.btrim(evidence_reference)) between 3 and 300
    and evidence_reference !~ '[[:cntrl:]]'
  ),
  notes text check (notes is null or pg_catalog.char_length(notes) <= 800),
  operation_id uuid not null,
  request_id uuid not null,
  recorded_by uuid not null references auth.users(id) on delete restrict,
  recorded_at timestamptz not null default pg_catalog.now(),
  constraint gestao_backup_operation_unique unique (clinic_id, operation_id),
  constraint gestao_backup_result_consistency check (
    (event_kind in ('backup_executado', 'restauracao_testada') and result = 'sucesso')
    or (event_kind = 'restauracao_falhou' and result = 'falha')
  )
);

create table public.gestao_contas_caixa (
  id uuid primary key,
  clinic_id uuid not null references public.clinics(id) on delete restrict,
  name text not null check (pg_catalog.char_length(pg_catalog.btrim(name)) between 2 and 100),
  account_type text not null check (
    account_type in ('banco', 'caixa', 'carteira', 'gateway', 'outro')
  ),
  institution_label text check (
    institution_label is null or pg_catalog.char_length(pg_catalog.btrim(institution_label)) between 2 and 100
  ),
  identifier_last4 text check (identifier_last4 is null or identifier_last4 ~ '^[A-Za-z0-9]{4}$'),
  currency text not null default 'BRL' check (currency = 'BRL'),
  opening_balance numeric(14,2) not null default 0,
  opening_balance_date date not null,
  idempotency_key uuid not null,
  archived_at timestamptz,
  archived_by uuid references auth.users(id) on delete restrict,
  archive_reason text check (
    archive_reason is null or pg_catalog.char_length(pg_catalog.btrim(archive_reason)) between 3 and 300
  ),
  created_by uuid not null references auth.users(id) on delete restrict,
  updated_by uuid references auth.users(id) on delete restrict,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  version integer not null default 1 check (version > 0),
  constraint gestao_contas_caixa_clinic_id_id_key unique (clinic_id, id),
  constraint gestao_contas_caixa_idempotency_unique unique (clinic_id, idempotency_key),
  constraint gestao_contas_caixa_archive_check check (
    (archived_at is null and archived_by is null and archive_reason is null)
    or (archived_at is not null and archived_by is not null and archive_reason is not null)
  )
);

create table public.gestao_liquidacoes_financeiras (
  id uuid primary key,
  clinic_id uuid not null references public.clinics(id) on delete restrict,
  account_id uuid not null,
  payment_id uuid not null,
  movement_kind text not null check (movement_kind in ('liquidacao', 'estorno')),
  gross_amount numeric(14,2) not null check (gross_amount > 0),
  fee_amount numeric(14,2) not null default 0 check (fee_amount >= 0),
  net_amount numeric(14,2) not null check (net_amount >= 0),
  settled_at timestamptz not null,
  reference text check (
    reference is null or (
      pg_catalog.char_length(pg_catalog.btrim(reference)) between 2 and 80
      and reference ~ '^[A-Za-z0-9 ._/-]+$'
      and pg_catalog.char_length(pg_catalog.regexp_replace(reference, '[^0-9]', '', 'g')) <= 8
    )
  ),
  reason text check (
    reason is null or pg_catalog.char_length(pg_catalog.btrim(reason)) between 3 and 300
  ),
  reversal_of_id uuid,
  operation_id uuid not null,
  request_id uuid not null,
  recorded_by uuid not null references auth.users(id) on delete restrict,
  recorded_at timestamptz not null default pg_catalog.now(),
  constraint gestao_liquidacoes_clinic_id_id_key unique (clinic_id, id),
  constraint gestao_liquidacoes_account_fk
    foreign key (clinic_id, account_id)
    references public.gestao_contas_caixa(clinic_id, id) on delete restrict,
  constraint gestao_liquidacoes_payment_fk
    foreign key (clinic_id, payment_id)
    references public.financeiro_pagamentos(clinic_id, id) on delete restrict,
  constraint gestao_liquidacoes_reversal_fk
    foreign key (clinic_id, reversal_of_id)
    references public.gestao_liquidacoes_financeiras(clinic_id, id) on delete restrict,
  constraint gestao_liquidacoes_reversal_check check (
    (movement_kind = 'liquidacao' and reversal_of_id is null and reason is null)
    or (movement_kind = 'estorno' and reversal_of_id is not null and reason is not null)
  ),
  constraint gestao_liquidacoes_operation_unique unique (clinic_id, operation_id)
);

create table public.gestao_conciliacoes_financeiras (
  id uuid primary key,
  clinic_id uuid not null references public.clinics(id) on delete restrict,
  account_id uuid not null,
  period_start date not null,
  period_end date not null,
  version integer not null check (version > 0),
  supersedes_id uuid,
  internal_amount numeric(14,2) not null,
  external_amount numeric(14,2) not null,
  difference_amount numeric(14,2) generated always as (external_amount - internal_amount) stored,
  status text not null check (status in ('conciliada', 'divergente', 'pendente')),
  evidence_reference text not null check (
    pg_catalog.char_length(pg_catalog.btrim(evidence_reference)) between 3 and 300
    and evidence_reference !~ '[[:cntrl:]]'
  ),
  notes text check (notes is null or pg_catalog.char_length(notes) <= 800),
  operation_id uuid not null,
  request_id uuid not null,
  reconciled_by uuid not null references auth.users(id) on delete restrict,
  reconciled_at timestamptz not null default pg_catalog.now(),
  constraint gestao_conciliacoes_clinic_id_id_key unique (clinic_id, id),
  constraint gestao_conciliacoes_account_fk
    foreign key (clinic_id, account_id)
    references public.gestao_contas_caixa(clinic_id, id) on delete restrict,
  constraint gestao_conciliacoes_supersedes_fk
    foreign key (clinic_id, supersedes_id)
    references public.gestao_conciliacoes_financeiras(clinic_id, id) on delete restrict,
  constraint gestao_conciliacoes_period_check check (period_end >= period_start),
  constraint gestao_conciliacoes_status_check check (
    (status = 'conciliada' and difference_amount = 0)
    or (status = 'divergente' and difference_amount <> 0)
    or status = 'pendente'
  ),
  constraint gestao_conciliacoes_version_unique
    unique (clinic_id, account_id, period_start, period_end, version),
  constraint gestao_conciliacoes_operation_unique unique (clinic_id, operation_id)
);

insert into public.gestao_fontes_catalogo
  (code, label, source_relation, classification, owner_role, status, contains_personal_data, notes)
values
  ('financeiro_lancamentos', 'Lançamentos financeiros', 'public.financeiro_lancamentos', 'operacional_observada', 'owner', 'observada', true, 'Fonte operacional de competência; o painel usa somente agregados.'),
  ('financeiro_pagamentos', 'Pagamentos e recebimentos', 'public.financeiro_pagamentos', 'operacional_observada', 'owner', 'observada', false, 'Eventos financeiros imutáveis usados na visão de caixa.'),
  ('financeiro_contas', 'Contas derivadas', 'public.gestao_contas_financeiras', 'derivada_rastreavel', 'owner', 'provisoria', false, 'Derivada de lançamentos, parcelas e pagamentos; não substitui escrituração contábil.'),
  ('financeiro_estoque', 'Estoque por razão de movimentos', 'public.financeiro_estoque_produto_saldos', 'derivada_rastreavel', 'owner', 'provisoria', false, 'Saldo e valor gerencial derivados de movimentos append-only.'),
  ('agenda_retornos', 'Fila operacional de retornos', 'public.operacao_retorno_resumo_diario', 'derivada_rastreavel', 'owner', 'provisoria', false, 'Agregado diário da fila validada de retornos, sem nomes, contatos ou procedimentos.'),
  ('gestao_ativos', 'Equipamentos e manutenções', 'public.gestao_equipamentos', 'operacional_observada', 'responsavel_tecnico', 'provisoria', false, 'Periodicidades e aptidão técnica dependem de fonte documentada.'),
  ('gestao_auditoria', 'Trilha administrativa', 'public.gestao_administrativa_auditoria', 'operacional_observada', 'owner', 'observada', false, 'Trilha técnica sem conteúdo clínico ou segredos.'),
  ('gestao_backup_evidencias', 'Evidências de backup e restauração', 'public.gestao_backup_restauracao_evidencias', 'operacional_observada', 'owner', 'provisoria', false, 'Registra evidência informada; não executa nem valida backup automaticamente.')
  ,('gestao_contas_caixa', 'Contas operacionais de caixa', 'public.gestao_contas_caixa', 'operacional_observada', 'owner', 'provisoria', false, 'Somente nome operacional, tipo e últimos quatro opcionais; não armazena credenciais ou conta completa.')
  ,('gestao_liquidacoes', 'Liquidações financeiras', 'public.gestao_liquidacoes_financeiras', 'operacional_observada', 'owner', 'provisoria', false, 'Eventos append-only de bruto, taxa, líquido, conta e data de liquidação.')
  ,('gestao_conciliacoes', 'Conciliações financeiras', 'public.gestao_conciliacoes_financeiras', 'operacional_observada', 'owner', 'provisoria', false, 'Versões imutáveis por conta e período com diferença e referência de evidência.')
on conflict (code) do nothing;

insert into public.gestao_metricas_catalogo
  (code, label, definition, formula, unit, source_code, owner_role, status, limitation)
values
  ('competence_revenue', 'Receitas por competência', 'Soma de lançamentos ativos de receita cuja data de competência está no período.', 'SUM(total_amount WHERE entry_type=receita AND state=ativo)', 'BRL', 'financeiro_lancamentos', 'contador', 'validacao_contabil', 'Não representa recebimento, caixa disponível, margem ou lucro.'),
  ('competence_expense', 'Despesas por competência', 'Soma de lançamentos ativos de despesa cuja data de competência está no período.', 'SUM(total_amount WHERE entry_type=despesa AND state=ativo)', 'BRL', 'financeiro_lancamentos', 'contador', 'validacao_contabil', 'Classificação contábil e tributária requer validação do contador.'),
  ('cash_in', 'Entradas de caixa registradas', 'Total líquido de pagamentos menos estornos ligados a lançamentos de receita no período.', 'SUM(pagamento-estorno WHERE entry_type=receita)', 'BRL', 'financeiro_pagamentos', 'owner', 'aprovada_gerencial', 'Não comprova saldo bancário conciliado.'),
  ('cash_out', 'Saídas de caixa registradas', 'Total líquido de pagamentos menos estornos ligados a lançamentos de despesa no período.', 'SUM(pagamento-estorno WHERE entry_type=despesa)', 'BRL', 'financeiro_pagamentos', 'owner', 'aprovada_gerencial', 'Não equivale automaticamente a despesa contábil do período.'),
  ('net_cash_flow', 'Fluxo líquido registrado', 'Diferença entre entradas e saídas de caixa registradas no período.', 'cash_in-cash_out', 'BRL', 'financeiro_pagamentos', 'owner', 'aprovada_gerencial', 'Não é lucro e não é saldo bancário conciliado.'),
  ('receivable_open', 'Contas a receber em aberto', 'Saldo atual positivo das contas de receita com vencimento até o fim do período selecionado.', 'SUM(balance WHERE nature=receber AND due_date<=period_end)', 'BRL', 'financeiro_contas', 'owner', 'provisoria', 'É posição atual derivada; não reconstrói cancelamentos históricos anteriores ao primeiro fechamento.'),
  ('payable_open', 'Contas a pagar em aberto', 'Saldo atual positivo das contas de despesa com vencimento até o fim do período selecionado.', 'SUM(balance WHERE nature=pagar AND due_date<=period_end)', 'BRL', 'financeiro_contas', 'owner', 'provisoria', 'É posição atual derivada e não substitui conciliação bancária.'),
  ('delinquency_rate', 'Inadimplência gerencial', 'Proporção do saldo vencido em aberto sobre o total de contas a receber vencidas elegíveis.', 'overdue_receivable/total_receivable_due*100; NULL quando denominador=0', 'percent', 'financeiro_contas', 'owner', 'provisoria', 'Usa vencimentos e saldos registrados; não conclui risco de crédito.'),
  ('inventory_value', 'Valor gerencial do estoque', 'Soma do valor efetivo dos saldos por produto calculado pela razão de movimentos.', 'SUM(effective_value)', 'BRL', 'financeiro_estoque', 'owner', 'provisoria', 'Não é valor contábil oficial e depende da qualidade das entradas e baixas.'),
  ('returns_overdue', 'Ações de retorno vencidas', 'Quantidade agregada de itens ativos da fila cuja próxima ação está vencida.', 'SUM(queue_count WHERE action_date<today AND status NOT IN final_statuses)', 'count', 'agenda_retornos', 'owner', 'provisoria', 'Não expõe pessoa ou procedimento; depende da recomendação validada e da atualização correta da fila.'),
  ('maintenance_overdue', 'Manutenções vencidas', 'Quantidade de próximas manutenções documentadas com data anterior a hoje.', 'COUNT(next_due_date<today AND source_confirmed)', 'count', 'gestao_ativos', 'responsavel_tecnico', 'provisoria', 'Não cria periodicidade; datas exigem fonte técnica registrada.'),
  ('restore_evidence', 'Última restauração testada', 'Data da evidência mais recente de teste de restauração registrado com sucesso.', 'MAX(occurred_at WHERE event_kind=restauracao_testada AND result=sucesso)', 'date', 'gestao_backup_evidencias', 'owner', 'provisoria', 'Comprova apenas o registro informado; a evidência deve ser conferida externamente.')
  ,('settled_net', 'Liquidação líquida por conta', 'Valor absoluto que efetivamente entrou ou saiu da conta após taxa registrada.', 'SUM(liquidacao-estorno BY account, entry_type)', 'BRL', 'gestao_liquidacoes', 'owner', 'provisoria', 'Depende do vínculo correto com o pagamento e não substitui extrato externo.')
  ,('reconciliation_difference', 'Diferença de conciliação', 'Diferença entre o saldo externo informado e o saldo interno acumulado desde a abertura da conta até o fim do período.', 'external_closing_balance-internal_closing_balance', 'BRL', 'gestao_conciliacoes', 'owner', 'provisoria', 'Valor externo e evidência são informados pelo proprietário e devem ser conferidos.')
on conflict (code) do nothing;

create unique index gestao_equipamentos_asset_code_unique
  on public.gestao_equipamentos(clinic_id, pg_catalog.lower(pg_catalog.btrim(asset_code)))
  where archived_at is null;
create unique index gestao_equipamentos_serial_unique
  on public.gestao_equipamentos(clinic_id, pg_catalog.lower(pg_catalog.btrim(serial_number)))
  where serial_number is not null and archived_at is null;
create index gestao_equipamentos_status_idx
  on public.gestao_equipamentos(clinic_id, status, criticality)
  where archived_at is null;
create index gestao_equipamentos_warranty_idx
  on public.gestao_equipamentos(clinic_id, warranty_end)
  where warranty_end is not null and archived_at is null;
create index gestao_equipamentos_supplier_idx
  on public.gestao_equipamentos(clinic_id, supplier_id)
  where supplier_id is not null;
create index gestao_equipamentos_actor_idx on public.gestao_equipamentos(created_by);
create index gestao_equipamentos_updated_actor_idx
  on public.gestao_equipamentos(updated_by) where updated_by is not null;

create index gestao_manutencoes_equipment_idx
  on public.gestao_equipamento_manutencoes(clinic_id, equipment_id, created_at desc);
create index gestao_manutencoes_due_idx
  on public.gestao_equipamento_manutencoes(clinic_id, next_due_date, status)
  where next_due_date is not null and status <> 'cancelada';
create index gestao_manutencoes_schedule_idx
  on public.gestao_equipamento_manutencoes(clinic_id, scheduled_for, status)
  where scheduled_for is not null and status not in ('concluida', 'cancelada');
create index gestao_manutencoes_correction_idx
  on public.gestao_equipamento_manutencoes(clinic_id, correction_of_id)
  where correction_of_id is not null;
create index gestao_manutencoes_actor_idx on public.gestao_equipamento_manutencoes(created_by);
create index gestao_manutencoes_updated_actor_idx
  on public.gestao_equipamento_manutencoes(updated_by) where updated_by is not null;

create index gestao_fechamentos_period_idx
  on public.gestao_fechamentos_mensais(clinic_id, period_start desc, version desc);
create index gestao_fechamentos_actor_idx on public.gestao_fechamentos_mensais(closed_by);
create index gestao_reaberturas_actor_idx on public.gestao_fechamento_reaberturas(reopened_by);
create index gestao_auditoria_time_idx
  on public.gestao_administrativa_auditoria(clinic_id, created_at desc);
create index gestao_auditoria_entity_idx
  on public.gestao_administrativa_auditoria(clinic_id, entity, entity_id, created_at desc);
create index gestao_auditoria_actor_idx
  on public.gestao_administrativa_auditoria(actor_id, created_at desc);
create index gestao_metricas_source_idx on public.gestao_metricas_catalogo(source_code, status);
create index gestao_backup_time_idx
  on public.gestao_backup_restauracao_evidencias(clinic_id, occurred_at desc, event_kind);
create index gestao_backup_actor_idx on public.gestao_backup_restauracao_evidencias(recorded_by);
create unique index gestao_contas_caixa_name_unique
  on public.gestao_contas_caixa(clinic_id, pg_catalog.lower(pg_catalog.btrim(name)))
  where archived_at is null;
create index gestao_contas_caixa_actor_idx on public.gestao_contas_caixa(created_by);
create index gestao_contas_caixa_updated_actor_idx
  on public.gestao_contas_caixa(updated_by) where updated_by is not null;
create index gestao_liquidacoes_account_time_idx
  on public.gestao_liquidacoes_financeiras(clinic_id, account_id, settled_at desc);
create index gestao_liquidacoes_payment_idx
  on public.gestao_liquidacoes_financeiras(clinic_id, payment_id, recorded_at);
create index gestao_liquidacoes_reversal_idx
  on public.gestao_liquidacoes_financeiras(clinic_id, reversal_of_id)
  where reversal_of_id is not null;
create unique index gestao_liquidacoes_full_reversal_unique
  on public.gestao_liquidacoes_financeiras(clinic_id, reversal_of_id)
  where movement_kind = 'estorno';
create index gestao_liquidacoes_actor_idx on public.gestao_liquidacoes_financeiras(recorded_by);
create index gestao_conciliacoes_period_idx
  on public.gestao_conciliacoes_financeiras(clinic_id, account_id, period_start desc, period_end desc, version desc);
create index gestao_conciliacoes_actor_idx on public.gestao_conciliacoes_financeiras(reconciled_by);

-- ---------------------------------------------------------------------------
-- Integridade, histórico append-only e trava de períodos fechados
-- ---------------------------------------------------------------------------

create or replace function private.gestao_block_mutation()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  raise exception 'gestao_append_only_record' using errcode = '55000';
end;
$function$;

create or replace function private.gestao_touch_row()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  new.updated_at := pg_catalog.now();
  new.version := old.version + 1;
  return new;
end;
$function$;

create or replace function private.gestao_guard_maintenance_final()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if tg_op = 'DELETE' then
    raise exception 'maintenance_hard_delete_forbidden' using errcode = '55000';
  end if;
  if old.status in ('concluida', 'cancelada') then
    raise exception 'maintenance_final_is_immutable' using errcode = '55000';
  end if;
  return new;
end;
$function$;

create or replace function private.gestao_period_is_closed(
  p_clinic_id uuid,
  p_date date
)
returns boolean
language sql
stable
set search_path = ''
as $function$
  select exists (
    select 1
    from public.gestao_fechamentos_mensais closure
    left join public.gestao_fechamento_reaberturas reopening
      on reopening.clinic_id = closure.clinic_id
     and reopening.closure_id = closure.id
    where closure.clinic_id = p_clinic_id
      and closure.period_start = pg_catalog.date_trunc('month', p_date)::date
      and reopening.id is null
  );
$function$;

-- Uma única trava transacional por clínica serializa fechamento/reabertura e
-- toda mutação que possa alterar os números do período. Sem isso, uma escrita
-- poderia validar "aberto", aguardar o commit do fechamento e ainda assim
-- entrar depois do snapshot.
create or replace function private.gestao_lock_financial_mutation(p_clinic_id uuid)
returns void
language plpgsql
volatile
set search_path = ''
as $function$
begin
  if p_clinic_id is null then
    raise exception 'gestao_clinic_required' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('amj-gestao:' || p_clinic_id::text, 0)
  );
end;
$function$;

create or replace function private.gestao_guard_snapshot_mutation()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  v_clinic_id uuid;
begin
  if tg_op = 'DELETE' then
    v_clinic_id := old.clinic_id;
  else
    v_clinic_id := new.clinic_id;
  end if;
  perform private.gestao_lock_financial_mutation(v_clinic_id);
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$function$;

create or replace function private.gestao_guard_lancamento_period()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if tg_op = 'DELETE' then
    perform private.gestao_lock_financial_mutation(old.clinic_id);
  else
    perform private.gestao_lock_financial_mutation(new.clinic_id);
  end if;
  if tg_op in ('UPDATE', 'DELETE')
     and private.gestao_period_is_closed(old.clinic_id, old.competence_date) then
    raise exception 'financial_period_closed' using errcode = '55000';
  end if;
  if tg_op in ('INSERT', 'UPDATE')
     and private.gestao_period_is_closed(new.clinic_id, new.competence_date) then
    raise exception 'financial_period_closed' using errcode = '55000';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$function$;

create or replace function private.gestao_guard_payment_period()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  perform private.gestao_lock_financial_mutation(new.clinic_id);
  if private.gestao_period_is_closed(
    new.clinic_id,
    (new.paid_at at time zone 'America/Sao_Paulo')::date
  ) then
    raise exception 'financial_period_closed' using errcode = '55000';
  end if;
  return new;
end;
$function$;

create or replace function private.gestao_guard_installment_period()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if tg_op = 'DELETE' then
    perform private.gestao_lock_financial_mutation(old.clinic_id);
  else
    perform private.gestao_lock_financial_mutation(new.clinic_id);
  end if;
  if tg_op in ('UPDATE', 'DELETE')
     and private.gestao_period_is_closed(old.clinic_id, old.due_date) then
    raise exception 'financial_period_closed' using errcode = '55000';
  end if;
  if tg_op in ('INSERT', 'UPDATE')
     and private.gestao_period_is_closed(new.clinic_id, new.due_date) then
    raise exception 'financial_period_closed' using errcode = '55000';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$function$;

create or replace function private.gestao_guard_stock_period()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  perform private.gestao_lock_financial_mutation(new.clinic_id);
  if private.gestao_period_is_closed(
    new.clinic_id,
    (new.occurred_at at time zone 'America/Sao_Paulo')::date
  ) then
    raise exception 'financial_period_closed' using errcode = '55000';
  end if;
  return new;
end;
$function$;

create or replace function private.gestao_guard_liquidation_period()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  perform private.gestao_lock_financial_mutation(new.clinic_id);
  if private.gestao_period_is_closed(
    new.clinic_id,
    (new.settled_at at time zone 'America/Sao_Paulo')::date
  ) then
    raise exception 'financial_period_closed' using errcode = '55000';
  end if;
  return new;
end;
$function$;

revoke all on function private.gestao_block_mutation()
  from public, anon, authenticated, service_role;
revoke all on function private.gestao_touch_row()
  from public, anon, authenticated, service_role;
revoke all on function private.gestao_guard_maintenance_final()
  from public, anon, authenticated, service_role;
revoke all on function private.gestao_period_is_closed(uuid,date)
  from public, anon, authenticated, service_role;
grant execute on function private.gestao_period_is_closed(uuid,date) to service_role;
revoke all on function private.gestao_lock_financial_mutation(uuid)
  from public, anon, authenticated, service_role;
grant execute on function private.gestao_lock_financial_mutation(uuid) to service_role;
revoke all on function private.gestao_guard_snapshot_mutation()
  from public, anon, authenticated, service_role;
revoke all on function private.gestao_guard_lancamento_period()
  from public, anon, authenticated, service_role;
revoke all on function private.gestao_guard_payment_period()
  from public, anon, authenticated, service_role;
revoke all on function private.gestao_guard_installment_period()
  from public, anon, authenticated, service_role;
revoke all on function private.gestao_guard_stock_period()
  from public, anon, authenticated, service_role;
revoke all on function private.gestao_guard_liquidation_period()
  from public, anon, authenticated, service_role;

create trigger gestao_fechamentos_immutable
before update or delete on public.gestao_fechamentos_mensais
for each row execute function private.gestao_block_mutation();
create trigger gestao_reaberturas_immutable
before update or delete on public.gestao_fechamento_reaberturas
for each row execute function private.gestao_block_mutation();
create trigger gestao_auditoria_immutable
before update or delete on public.gestao_administrativa_auditoria
for each row execute function private.gestao_block_mutation();
create trigger gestao_backup_evidencias_immutable
before update or delete on public.gestao_backup_restauracao_evidencias
for each row execute function private.gestao_block_mutation();
create trigger gestao_contas_caixa_no_delete
before delete on public.gestao_contas_caixa
for each row execute function private.gestao_block_mutation();
create trigger gestao_contas_caixa_touch
before update on public.gestao_contas_caixa
for each row execute function private.gestao_touch_row();
create trigger gestao_liquidacoes_immutable
before update or delete on public.gestao_liquidacoes_financeiras
for each row execute function private.gestao_block_mutation();
create trigger gestao_conciliacoes_immutable
before update or delete on public.gestao_conciliacoes_financeiras
for each row execute function private.gestao_block_mutation();
create trigger gestao_fontes_catalogo_immutable
before update or delete on public.gestao_fontes_catalogo
for each row execute function private.gestao_block_mutation();
create trigger gestao_metricas_catalogo_immutable
before update or delete on public.gestao_metricas_catalogo
for each row execute function private.gestao_block_mutation();
create trigger gestao_equipamentos_no_delete
before delete on public.gestao_equipamentos
for each row execute function private.gestao_block_mutation();
create trigger gestao_equipamentos_touch
before update on public.gestao_equipamentos
for each row execute function private.gestao_touch_row();
create trigger gestao_manutencoes_guard_final
before update or delete on public.gestao_equipamento_manutencoes
for each row execute function private.gestao_guard_maintenance_final();
create trigger gestao_manutencoes_touch
before update on public.gestao_equipamento_manutencoes
for each row execute function private.gestao_touch_row();

create trigger gestao_lancamentos_period_guard
before insert or update or delete on public.financeiro_lancamentos
for each row execute function private.gestao_guard_lancamento_period();
create trigger gestao_pagamentos_period_guard
before insert on public.financeiro_pagamentos
for each row execute function private.gestao_guard_payment_period();
create trigger gestao_parcelas_period_guard
before insert or update or delete on public.financeiro_parcelas
for each row execute function private.gestao_guard_installment_period();
create trigger gestao_stock_period_guard
before insert on public.financeiro_estoque_movimentos
for each row execute function private.gestao_guard_stock_period();
create trigger gestao_liquidacoes_period_guard
before insert on public.gestao_liquidacoes_financeiras
for each row execute function private.gestao_guard_liquidation_period();

-- Todas as fontes administrativas incluídas no snapshot participam da mesma
-- trava. O fechamento, portanto, não mistura estados de antes/depois de uma
-- manutenção, retorno, conciliação ou evidência concorrente.
create trigger gestao_fechamentos_snapshot_lock
before insert or update or delete on public.gestao_fechamentos_mensais
for each row execute function private.gestao_guard_snapshot_mutation();
create trigger gestao_reaberturas_snapshot_lock
before insert or update or delete on public.gestao_fechamento_reaberturas
for each row execute function private.gestao_guard_snapshot_mutation();
create trigger gestao_auditoria_snapshot_lock
before insert or update or delete on public.gestao_administrativa_auditoria
for each row execute function private.gestao_guard_snapshot_mutation();
create trigger gestao_backup_snapshot_lock
before insert or update or delete on public.gestao_backup_restauracao_evidencias
for each row execute function private.gestao_guard_snapshot_mutation();
create trigger gestao_contas_caixa_snapshot_lock
before insert or update or delete on public.gestao_contas_caixa
for each row execute function private.gestao_guard_snapshot_mutation();
create trigger gestao_liquidacoes_snapshot_lock
before insert or update or delete on public.gestao_liquidacoes_financeiras
for each row execute function private.gestao_guard_snapshot_mutation();
create trigger gestao_conciliacoes_snapshot_lock
before insert or update or delete on public.gestao_conciliacoes_financeiras
for each row execute function private.gestao_guard_snapshot_mutation();
create trigger gestao_equipamentos_snapshot_lock
before insert or update or delete on public.gestao_equipamentos
for each row execute function private.gestao_guard_snapshot_mutation();
create trigger gestao_manutencoes_snapshot_lock
before insert or update or delete on public.gestao_equipamento_manutencoes
for each row execute function private.gestao_guard_snapshot_mutation();
create trigger gestao_retorno_fila_snapshot_lock
before insert or update or delete on public.retorno_fila
for each row execute function private.gestao_guard_snapshot_mutation();

-- ---------------------------------------------------------------------------
-- Views minimizadas: nenhuma pessoa, contato, prontuário ou procedimento.
-- ---------------------------------------------------------------------------

create or replace view public.gestao_contas_financeiras
with (security_invoker = true)
as
with installment_accounts as (
  select
    installment.id as account_id,
    'parcela'::text as source_kind,
    installment.clinic_id,
    entry.id as entry_id,
    installment.id as installment_id,
    case when entry.entry_type = 'receita' then 'receber' else 'pagar' end as nature,
    entry.origin,
    case entry.origin
      when 'atendimento' then 'Receita de atendimento'
      when 'produto' then 'Movimento de produto'
      when 'compra' then 'Compra de fornecedor'
      when 'operacional' then 'Movimento operacional'
      else 'Ajuste financeiro'
    end as description,
    entry.origin as category,
    entry.competence_date,
    installment.due_date,
    installment.amount as total_amount,
    installment.paid_amount,
    installment.balance,
    installment.calculated_status as status,
    installment.planned_payment_method,
    installment.installment_number,
    entry.installments
  from public.financeiro_parcelas_resumo installment
  join public.financeiro_lancamentos entry
    on entry.clinic_id = installment.clinic_id
   and entry.id = installment.entry_id
  where installment.state = 'ativa'
    and entry.state = 'ativo'
), unplanned_accounts as (
  select
    entry.id as account_id,
    'lancamento'::text as source_kind,
    entry.clinic_id,
    entry.id as entry_id,
    null::uuid as installment_id,
    case when entry.entry_type = 'receita' then 'receber' else 'pagar' end as nature,
    entry.origin,
    case entry.origin
      when 'atendimento' then 'Receita de atendimento'
      when 'produto' then 'Movimento de produto'
      when 'compra' then 'Compra de fornecedor'
      when 'operacional' then 'Movimento operacional'
      else 'Ajuste financeiro'
    end as description,
    entry.origin as category,
    entry.competence_date,
    entry.due_date,
    entry.total_amount,
    entry.paid_amount,
    entry.balance,
    entry.calculated_status as status,
    null::text as planned_payment_method,
    null::smallint as installment_number,
    entry.installments
  from public.financeiro_lancamentos_resumo entry
  where entry.state = 'ativo'
    and not exists (
      select 1
      from public.financeiro_parcelas installment
      where installment.clinic_id = entry.clinic_id
        and installment.entry_id = entry.id
        and installment.state = 'ativa'
    )
)
select * from installment_accounts
union all
select * from unplanned_accounts;

create or replace view public.gestao_fluxo_caixa_diario
with (security_invoker = true)
as
select
  entry.clinic_id,
  (payment.paid_at at time zone 'America/Sao_Paulo')::date as cash_date,
  coalesce(pg_catalog.sum(
    case
      when entry.entry_type = 'receita' and payment.movement_type = 'pagamento' then payment.amount
      when entry.entry_type = 'receita' and payment.movement_type = 'estorno' then -payment.amount
      else 0
    end
  ), 0)::numeric(14,2) as cash_in,
  coalesce(pg_catalog.sum(
    case
      when entry.entry_type = 'despesa' and payment.movement_type = 'pagamento' then payment.amount
      when entry.entry_type = 'despesa' and payment.movement_type = 'estorno' then -payment.amount
      else 0
    end
  ), 0)::numeric(14,2) as cash_out,
  coalesce(pg_catalog.sum(
    case
      when entry.entry_type = 'receita' and payment.movement_type = 'pagamento' then payment.amount
      when entry.entry_type = 'receita' and payment.movement_type = 'estorno' then -payment.amount
      when entry.entry_type = 'despesa' and payment.movement_type = 'pagamento' then -payment.amount
      when entry.entry_type = 'despesa' and payment.movement_type = 'estorno' then payment.amount
      else 0
    end
  ), 0)::numeric(14,2) as net_cash_flow
from public.financeiro_pagamentos payment
join public.financeiro_lancamentos entry
  on entry.clinic_id = payment.clinic_id
 and entry.id = payment.entry_id
group by entry.clinic_id, (payment.paid_at at time zone 'America/Sao_Paulo')::date;

create or replace view public.gestao_fechamentos_mensais_resumo
with (security_invoker = true)
as
select
  closure.*,
  case when reopening.id is null then 'fechado' else 'reaberto' end as status,
  reopening.id as reopening_id,
  reopening.reopened_at,
  reopening.reopened_by,
  reopening.reopen_reason
from public.gestao_fechamentos_mensais closure
left join public.gestao_fechamento_reaberturas reopening
  on reopening.clinic_id = closure.clinic_id
 and reopening.closure_id = closure.id;

create or replace view public.gestao_alertas_equipamentos
with (security_invoker = true)
as
with effective_maintenance_due as (
  select distinct on (
    maintenance.clinic_id,
    maintenance.equipment_id,
    maintenance.maintenance_kind
  )
    maintenance.clinic_id,
    maintenance.equipment_id,
    maintenance.id,
    maintenance.maintenance_kind,
    maintenance.next_due_date,
    maintenance.technical_source_type,
    maintenance.technical_source_reference
  from public.gestao_equipamento_manutencoes maintenance
  join public.gestao_equipamentos equipment
    on equipment.clinic_id = maintenance.clinic_id
   and equipment.id = maintenance.equipment_id
   and equipment.archived_at is null
  where maintenance.status <> 'cancelada'
  order by
    maintenance.clinic_id,
    maintenance.equipment_id,
    maintenance.maintenance_kind,
    coalesce(maintenance.completed_at, maintenance.started_at, maintenance.created_at) desc,
    maintenance.version desc,
    maintenance.id desc
)
select
  equipment.clinic_id,
  equipment.id as equipment_id,
  null::uuid as maintenance_id,
  'equipment_status'::text as alert_kind,
  case when equipment.status = 'quarentena' then 'critico' else 'alto' end as severity,
  equipment.status as reason_code,
  null::date as due_date
from public.gestao_equipamentos equipment
where equipment.archived_at is null
  and equipment.status in ('quarentena', 'indisponivel', 'aguardando_peca')
union all
select
  maintenance.clinic_id,
  maintenance.equipment_id,
  maintenance.id as maintenance_id,
  'maintenance_overdue'::text as alert_kind,
  'alto'::text as severity,
  maintenance.maintenance_kind as reason_code,
  maintenance.next_due_date as due_date
from effective_maintenance_due maintenance
where maintenance.next_due_date < (pg_catalog.now() at time zone 'America/Sao_Paulo')::date
  and maintenance.technical_source_type <> 'pending_validation'
  and maintenance.technical_source_reference is not null;

create or replace view public.gestao_conciliacoes_atuais
with (security_invoker = true)
as
with latest as (
  select distinct on (
    reconciliation.clinic_id,
    reconciliation.account_id,
    reconciliation.period_start,
    reconciliation.period_end
  )
    reconciliation.*
  from public.gestao_conciliacoes_financeiras reconciliation
  order by
    reconciliation.clinic_id,
    reconciliation.account_id,
    reconciliation.period_start,
    reconciliation.period_end,
    reconciliation.version desc,
    reconciliation.reconciled_at desc,
    reconciliation.id desc
)
select
  latest.id,
  latest.clinic_id,
  latest.account_id,
  latest.period_start,
  latest.period_end,
  latest.version,
  latest.supersedes_id,
  latest.internal_amount,
  latest.external_amount,
  latest.difference_amount,
  case when account.updated_at > latest.reconciled_at or exists (
    select 1
    from public.gestao_liquidacoes_financeiras liquidation
    where liquidation.clinic_id = latest.clinic_id
      and liquidation.account_id = latest.account_id
      and liquidation.recorded_at > latest.reconciled_at
      and (liquidation.settled_at at time zone 'America/Sao_Paulo')::date
        between account.opening_balance_date and latest.period_end
  ) then 'pendente' else latest.status end as status,
  latest.evidence_reference,
  latest.notes,
  latest.operation_id,
  latest.request_id,
  latest.reconciled_by,
  latest.reconciled_at
from latest
join public.gestao_contas_caixa account
  on account.clinic_id = latest.clinic_id
 and account.id = latest.account_id;

create or replace view public.gestao_contas_caixa_resumo
with (security_invoker = true)
as
with movements as (
  select
    liquidation.clinic_id,
    liquidation.account_id,
    pg_catalog.sum(
      case
        when entry.entry_type = 'receita' and liquidation.movement_kind = 'liquidacao' then liquidation.net_amount
        when entry.entry_type = 'receita' and liquidation.movement_kind = 'estorno' then -liquidation.net_amount
        when entry.entry_type = 'despesa' and liquidation.movement_kind = 'liquidacao' then -liquidation.net_amount
        when entry.entry_type = 'despesa' and liquidation.movement_kind = 'estorno' then liquidation.net_amount
        else 0
      end
    )::numeric(14,2) as net_movement,
    pg_catalog.max(liquidation.settled_at) as last_settlement_at
  from public.gestao_liquidacoes_financeiras liquidation
  join public.financeiro_pagamentos payment
    on payment.clinic_id = liquidation.clinic_id
   and payment.id = liquidation.payment_id
  join public.financeiro_lancamentos entry
    on entry.clinic_id = payment.clinic_id
   and entry.id = payment.entry_id
  group by liquidation.clinic_id, liquidation.account_id
)
select
  account.id,
  account.clinic_id,
  account.name,
  account.account_type,
  account.institution_label,
  account.identifier_last4,
  account.currency,
  account.opening_balance,
  account.opening_balance_date,
  coalesce(movements.net_movement, 0)::numeric(14,2) as net_movement,
  (account.opening_balance + coalesce(movements.net_movement, 0))::numeric(14,2) as calculated_balance,
  movements.last_settlement_at,
  account.archived_at,
  account.created_at,
  account.updated_at,
  account.version
from public.gestao_contas_caixa account
left join movements
  on movements.clinic_id = account.clinic_id
 and movements.account_id = account.id;

create or replace view public.gestao_pagamentos_liquidacao_resumo
with (security_invoker = true)
as
with settlement_totals as (
  select
    liquidation.clinic_id,
    liquidation.payment_id,
    pg_catalog.sum(
      case when liquidation.movement_kind = 'liquidacao'
        then liquidation.gross_amount else -liquidation.gross_amount end
    )::numeric(14,2) as settled_gross,
    pg_catalog.sum(
      case when liquidation.movement_kind = 'liquidacao'
        then liquidation.fee_amount else -liquidation.fee_amount end
    )::numeric(14,2) as settled_fee,
    pg_catalog.sum(
      case when liquidation.movement_kind = 'liquidacao'
        then liquidation.net_amount else -liquidation.net_amount end
    )::numeric(14,2) as settled_net,
    pg_catalog.max(liquidation.settled_at) as last_settlement_at
  from public.gestao_liquidacoes_financeiras liquidation
  group by liquidation.clinic_id, liquidation.payment_id
)
select
  payment.id as payment_id,
  payment.clinic_id,
  payment.entry_id,
  entry.entry_type,
  payment.payment_method,
  payment.amount as payment_amount,
  payment.paid_at,
  greatest(coalesce(totals.settled_gross, 0), 0)::numeric(14,2) as settled_gross,
  greatest(payment.amount - coalesce(totals.settled_gross, 0), 0)::numeric(14,2) as pending_gross,
  greatest(coalesce(totals.settled_fee, 0), 0)::numeric(14,2) as settled_fee,
  greatest(coalesce(totals.settled_net, 0), 0)::numeric(14,2) as settled_net,
  totals.last_settlement_at
from public.financeiro_pagamentos payment
join public.financeiro_lancamentos entry
  on entry.clinic_id = payment.clinic_id
 and entry.id = payment.entry_id
left join settlement_totals totals
  on totals.clinic_id = payment.clinic_id
 and totals.payment_id = payment.id
where payment.movement_type = 'pagamento';

-- ---------------------------------------------------------------------------
-- Dashboard agregado e fechamento mensal versionado
-- ---------------------------------------------------------------------------

create or replace function public.gestao_administrativa_dashboard(
  p_clinic_id uuid,
  p_actor_id uuid,
  p_period_start date,
  p_period_end date,
  p_warning_days integer default 30
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_today date := (pg_catalog.now() at time zone 'America/Sao_Paulo')::date;
  v_due_cutoff date;
  v_competence_revenue numeric(14,2) := 0;
  v_competence_expense numeric(14,2) := 0;
  v_cash_in numeric(14,2) := 0;
  v_cash_out numeric(14,2) := 0;
  v_receivable_open numeric(14,2) := 0;
  v_payable_open numeric(14,2) := 0;
  v_overdue_receivable numeric(14,2) := 0;
  v_overdue_payable numeric(14,2) := 0;
  v_receivable_due_total numeric(14,2) := 0;
  v_inventory_value numeric(18,2) := 0;
  v_inventory_products integer := 0;
  v_inventory_negative integer := 0;
  v_returns_period integer := 0;
  v_returns_overdue integer := 0;
  v_equipment_count integer := 0;
  v_equipment_unavailable integer := 0;
  v_warranties_warning integer := 0;
  v_maintenance_overdue integer := 0;
  v_maintenance_cost numeric(14,2) := 0;
  v_audit_events integer := 0;
  v_active_accounts integer := 0;
  v_reconciliation_pending integer := 0;
  v_settled_fees numeric(14,2) := 0;
  v_settled_net_movement numeric(14,2) := 0;
  v_last_restore_test timestamptz;
  v_restore_tests integer := 0;
begin
  perform private.gestao_assert_owner(p_clinic_id, p_actor_id);
  if p_period_start is null or p_period_end is null
     or p_period_end < p_period_start
     or p_period_end > p_period_start + 5 * interval '1 year'
     or p_warning_days not between 1 and 365 then
    raise exception 'gestao_invalid_period' using errcode = '22007';
  end if;
  v_due_cutoff := least(p_period_end, v_today);

  select
    coalesce(pg_catalog.sum(entry.total_amount) filter (
      where entry.entry_type = 'receita' and entry.state = 'ativo'
    ), 0),
    coalesce(pg_catalog.sum(entry.total_amount) filter (
      where entry.entry_type = 'despesa' and entry.state = 'ativo'
    ), 0)
  into v_competence_revenue, v_competence_expense
  from public.financeiro_lancamentos entry
  where entry.clinic_id = p_clinic_id
    and entry.competence_date between p_period_start and p_period_end;

  select
    coalesce(pg_catalog.sum(flow.cash_in), 0),
    coalesce(pg_catalog.sum(flow.cash_out), 0)
  into v_cash_in, v_cash_out
  from public.gestao_fluxo_caixa_diario flow
  where flow.clinic_id = p_clinic_id
    and flow.cash_date between p_period_start and p_period_end;

  select
    coalesce(pg_catalog.sum(account.balance) filter (
      where account.nature = 'receber' and account.balance > 0
    ), 0),
    coalesce(pg_catalog.sum(account.balance) filter (
      where account.nature = 'pagar' and account.balance > 0
    ), 0),
    coalesce(pg_catalog.sum(account.balance) filter (
      where account.nature = 'receber' and account.balance > 0 and account.due_date < v_due_cutoff
    ), 0),
    coalesce(pg_catalog.sum(account.balance) filter (
      where account.nature = 'pagar' and account.balance > 0 and account.due_date < v_due_cutoff
    ), 0),
    coalesce(pg_catalog.sum(account.total_amount) filter (
      where account.nature = 'receber' and account.due_date < v_due_cutoff
    ), 0)
  into
    v_receivable_open, v_payable_open, v_overdue_receivable,
    v_overdue_payable, v_receivable_due_total
  from public.gestao_contas_financeiras account
  where account.clinic_id = p_clinic_id
    and account.due_date <= p_period_end;

  select
    coalesce(pg_catalog.sum(stock.effective_value), 0),
    pg_catalog.count(*) filter (where stock.quantity_balance <> 0)::integer,
    pg_catalog.count(*) filter (where stock.quantity_balance < 0)::integer
  into v_inventory_value, v_inventory_products, v_inventory_negative
  from public.financeiro_estoque_produto_saldos stock
  where stock.clinic_id = p_clinic_id;

  select
    coalesce(pg_catalog.sum(queue.queue_count) filter (
      where queue.action_date between p_period_start and p_period_end
        and queue.status not in ('concluido', 'cancelado', 'bloqueado')
    ), 0)::integer,
    coalesce(pg_catalog.sum(queue.queue_count) filter (
      where queue.action_date < v_today
        and queue.status not in ('concluido', 'cancelado', 'bloqueado')
    ), 0)::integer
  into v_returns_period, v_returns_overdue
  from public.operacao_retorno_resumo_diario queue
  where queue.clinic_id = p_clinic_id;

  select
    pg_catalog.count(*)::integer,
    pg_catalog.count(*) filter (
      where equipment.status in ('quarentena', 'indisponivel', 'aguardando_peca')
    )::integer,
    pg_catalog.count(*) filter (
      where equipment.warranty_end between v_today and v_today + p_warning_days
    )::integer
  into v_equipment_count, v_equipment_unavailable, v_warranties_warning
  from public.gestao_equipamentos equipment
  where equipment.clinic_id = p_clinic_id
    and equipment.archived_at is null;

  select pg_catalog.count(*)::integer
  into v_maintenance_overdue
  from public.gestao_alertas_equipamentos alert
  where alert.clinic_id = p_clinic_id
    and alert.alert_kind = 'maintenance_overdue';

  select coalesce(pg_catalog.sum(maintenance.cost) filter (
      where maintenance.status = 'concluida'
        and (maintenance.completed_at at time zone 'America/Sao_Paulo')::date
          between p_period_start and p_period_end
    ), 0)
  into v_maintenance_cost
  from public.gestao_equipamento_manutencoes maintenance
  where maintenance.clinic_id = p_clinic_id;

  select pg_catalog.count(*)::integer
  into v_audit_events
  from public.gestao_administrativa_auditoria audit
  where audit.clinic_id = p_clinic_id
    and (audit.created_at at time zone 'America/Sao_Paulo')::date
      between p_period_start and p_period_end;

  select pg_catalog.count(*)::integer
  into v_active_accounts
  from public.gestao_contas_caixa account
  where account.clinic_id = p_clinic_id
    and account.archived_at is null
    and account.opening_balance_date <= p_period_end;

  select pg_catalog.count(*)::integer
  into v_reconciliation_pending
  from public.gestao_contas_caixa account
  left join public.gestao_conciliacoes_atuais reconciliation
    on reconciliation.clinic_id = account.clinic_id
   and reconciliation.account_id = account.id
   and reconciliation.period_start = p_period_start
   and reconciliation.period_end = p_period_end
  where account.clinic_id = p_clinic_id
    and account.archived_at is null
    and account.opening_balance_date <= p_period_end
    and (reconciliation.id is null or reconciliation.status <> 'conciliada');

  select
    coalesce(pg_catalog.sum(
      case when liquidation.movement_kind = 'liquidacao'
        then liquidation.fee_amount else -liquidation.fee_amount end
    ), 0),
    coalesce(pg_catalog.sum(
      case
        when entry.entry_type = 'receita' and liquidation.movement_kind = 'liquidacao' then liquidation.net_amount
        when entry.entry_type = 'receita' and liquidation.movement_kind = 'estorno' then -liquidation.net_amount
        when entry.entry_type = 'despesa' and liquidation.movement_kind = 'liquidacao' then -liquidation.net_amount
        when entry.entry_type = 'despesa' and liquidation.movement_kind = 'estorno' then liquidation.net_amount
        else 0
      end
    ), 0)
  into v_settled_fees, v_settled_net_movement
  from public.gestao_liquidacoes_financeiras liquidation
  join public.financeiro_pagamentos payment
    on payment.clinic_id = liquidation.clinic_id and payment.id = liquidation.payment_id
  join public.financeiro_lancamentos entry
    on entry.clinic_id = payment.clinic_id and entry.id = payment.entry_id
  where liquidation.clinic_id = p_clinic_id
    and (liquidation.settled_at at time zone 'America/Sao_Paulo')::date
      between p_period_start and p_period_end;

  select
    pg_catalog.max(evidence.occurred_at) filter (
      where evidence.event_kind = 'restauracao_testada' and evidence.result = 'sucesso'
    ),
    pg_catalog.count(*) filter (
      where evidence.event_kind = 'restauracao_testada' and evidence.result = 'sucesso'
        and (evidence.occurred_at at time zone 'America/Sao_Paulo')::date
          between p_period_start and p_period_end
    )::integer
  into v_last_restore_test, v_restore_tests
  from public.gestao_backup_restauracao_evidencias evidence
  where evidence.clinic_id = p_clinic_id;

  return pg_catalog.jsonb_build_object(
    'periodo', pg_catalog.jsonb_build_object(
      'inicio', p_period_start, 'fim', p_period_end,
      'fuso', 'America/Sao_Paulo', 'gerado_em', pg_catalog.now()
    ),
    'financeiro', pg_catalog.jsonb_build_object(
      'receitas_competencia', v_competence_revenue,
      'despesas_competencia', v_competence_expense,
      'entradas_caixa', v_cash_in,
      'saidas_caixa', v_cash_out,
      'fluxo_liquido', v_cash_in - v_cash_out,
      'liquidado_liquido_movimento', v_settled_net_movement,
      'taxas_liquidacao', v_settled_fees
    ),
    'contas', pg_catalog.jsonb_build_object(
      'receber_aberto', v_receivable_open,
      'pagar_aberto', v_payable_open,
      'receber_vencido', v_overdue_receivable,
      'pagar_vencido', v_overdue_payable,
      'inadimplencia_percentual', case when v_receivable_due_total = 0 then null
        else pg_catalog.round(v_overdue_receivable * 100 / v_receivable_due_total, 2) end,
      'contas_caixa_ativas', v_active_accounts,
      'conciliacoes_pendentes', v_reconciliation_pending
    ),
    'estoque', pg_catalog.jsonb_build_object(
      'valor_gerencial', v_inventory_value,
      'produtos_com_saldo', v_inventory_products,
      'saldos_negativos', v_inventory_negative
    ),
    'retornos', pg_catalog.jsonb_build_object(
      'previstos_periodo', v_returns_period,
      'vencidos', v_returns_overdue
    ),
    'ativos', pg_catalog.jsonb_build_object(
      'cadastrados', v_equipment_count,
      'indisponiveis', v_equipment_unavailable,
      'garantias_no_horizonte', v_warranties_warning,
      'manutencoes_vencidas', v_maintenance_overdue,
      'custo_manutencoes_periodo', v_maintenance_cost,
      'horizonte_alerta_dias', p_warning_days
    ),
    'governanca', pg_catalog.jsonb_build_object(
      'eventos_auditoria_periodo', v_audit_events,
      'ultima_restauracao_testada_em', v_last_restore_test,
      'restauracoes_testadas_periodo', v_restore_tests,
      'backup_validado_automaticamente', false,
      'catalogo_definicoes', 'gestao-v1'
    ),
    'avisos', pg_catalog.jsonb_build_array(
      'Fluxo líquido não é lucro nem saldo bancário conciliado.',
      'Valor de estoque e custos são gerenciais, não escrituração contábil.',
      'Backup só é confiável após conferência da evidência e teste de restauração.'
    )
  );
end;
$function$;

create or replace function public.gestao_fechar_mes(
  p_closure_id uuid,
  p_clinic_id uuid,
  p_actor_id uuid,
  p_period_start date,
  p_close_reason text,
  p_operation_id uuid,
  p_request_id uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_period_end date;
  v_version integer;
  v_dashboard jsonb;
  v_existing public.gestao_fechamentos_mensais%rowtype;
begin
  perform private.gestao_assert_owner(p_clinic_id, p_actor_id);
  if p_closure_id is null or p_operation_id is null or p_request_id is null
     or p_period_start is null
     or p_period_start <> pg_catalog.date_trunc('month', p_period_start)::date
     or pg_catalog.char_length(pg_catalog.btrim(coalesce(p_close_reason, ''))) not between 3 and 300 then
    raise exception 'gestao_invalid_close' using errcode = '22023';
  end if;
  v_period_end := (p_period_start + interval '1 month - 1 day')::date;
  if v_period_end >= (pg_catalog.now() at time zone 'America/Sao_Paulo')::date then
    raise exception 'gestao_period_not_complete' using errcode = '55000';
  end if;

  perform private.gestao_lock_financial_mutation(p_clinic_id);
  select * into v_existing
  from public.gestao_fechamentos_mensais closure
  where closure.clinic_id = p_clinic_id and closure.operation_id = p_operation_id;
  if found then
    if v_existing.id <> p_closure_id or v_existing.period_start <> p_period_start then
      raise exception 'gestao_operation_reused' using errcode = '23505';
    end if;
    return pg_catalog.jsonb_build_object(
      'id', v_existing.id, 'version', v_existing.version, 'idempotent', true
    );
  end if;

  if exists (
    select 1
    from public.gestao_fechamentos_mensais closure
    left join public.gestao_fechamento_reaberturas reopening
      on reopening.clinic_id = closure.clinic_id and reopening.closure_id = closure.id
    where closure.clinic_id = p_clinic_id
      and closure.period_start = p_period_start
      and reopening.id is null
  ) then
    raise exception 'gestao_period_already_closed' using errcode = '55000';
  end if;
  if exists (
    select 1
    from public.gestao_contas_caixa account
    left join public.gestao_conciliacoes_atuais reconciliation
      on reconciliation.clinic_id = account.clinic_id
     and reconciliation.account_id = account.id
     and reconciliation.period_start = p_period_start
     and reconciliation.period_end = v_period_end
    where account.clinic_id = p_clinic_id
      and account.archived_at is null
      and account.opening_balance_date <= v_period_end
      and (reconciliation.id is null or reconciliation.status <> 'conciliada')
  ) then
    raise exception 'gestao_reconciliation_pending' using errcode = '55000';
  end if;

  select coalesce(pg_catalog.max(closure.version), 0) + 1
  into v_version
  from public.gestao_fechamentos_mensais closure
  where closure.clinic_id = p_clinic_id and closure.period_start = p_period_start;

  v_dashboard := public.gestao_administrativa_dashboard(
    p_clinic_id, p_actor_id, p_period_start, v_period_end, 30
  );
  insert into public.gestao_fechamentos_mensais (
    id, clinic_id, period_start, version,
    competence_revenue, competence_expense, cash_in, cash_out, net_cash_flow,
    receivable_open, payable_open, overdue_receivable, overdue_payable,
    inventory_value, inventory_negative_count, returns_due_count,
    equipment_count, equipment_unavailable_count, maintenance_overdue_count,
    close_reason, operation_id, request_id, closed_by
  ) values (
    p_closure_id, p_clinic_id, p_period_start, v_version,
    (v_dashboard #>> '{financeiro,receitas_competencia}')::numeric,
    (v_dashboard #>> '{financeiro,despesas_competencia}')::numeric,
    (v_dashboard #>> '{financeiro,entradas_caixa}')::numeric,
    (v_dashboard #>> '{financeiro,saidas_caixa}')::numeric,
    (v_dashboard #>> '{financeiro,fluxo_liquido}')::numeric,
    (v_dashboard #>> '{contas,receber_aberto}')::numeric,
    (v_dashboard #>> '{contas,pagar_aberto}')::numeric,
    (v_dashboard #>> '{contas,receber_vencido}')::numeric,
    (v_dashboard #>> '{contas,pagar_vencido}')::numeric,
    (v_dashboard #>> '{estoque,valor_gerencial}')::numeric,
    (v_dashboard #>> '{estoque,saldos_negativos}')::integer,
    (v_dashboard #>> '{retornos,previstos_periodo}')::integer,
    (v_dashboard #>> '{ativos,cadastrados}')::integer,
    (v_dashboard #>> '{ativos,indisponiveis}')::integer,
    (v_dashboard #>> '{ativos,manutencoes_vencidas}')::integer,
    pg_catalog.btrim(p_close_reason), p_operation_id, p_request_id, p_actor_id
  );
  insert into public.gestao_administrativa_auditoria (
    clinic_id, actor_id, entity, entity_id, action, operation_id, request_id, details
  ) values (
    p_clinic_id, p_actor_id, 'monthly_closure', p_closure_id, 'close',
    p_operation_id, p_request_id,
    pg_catalog.jsonb_build_object(
      'period_month', pg_catalog.to_char(p_period_start, 'YYYY-MM'),
      'closure_version', v_version, 'reason_present', true, 'source', 'gestao_edge'
    )
  );
  return pg_catalog.jsonb_build_object(
    'id', p_closure_id, 'version', v_version, 'idempotent', false
  );
end;
$function$;

create or replace function public.gestao_reabrir_mes(
  p_clinic_id uuid,
  p_actor_id uuid,
  p_closure_id uuid,
  p_reopen_reason text,
  p_operation_id uuid,
  p_request_id uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_closure public.gestao_fechamentos_mensais%rowtype;
  v_existing public.gestao_fechamento_reaberturas%rowtype;
begin
  perform private.gestao_assert_owner(p_clinic_id, p_actor_id);
  if p_closure_id is null or p_operation_id is null or p_request_id is null
     or pg_catalog.char_length(pg_catalog.btrim(coalesce(p_reopen_reason, ''))) not between 3 and 300 then
    raise exception 'gestao_invalid_reopen' using errcode = '22023';
  end if;
  perform private.gestao_lock_financial_mutation(p_clinic_id);
  select * into v_existing
  from public.gestao_fechamento_reaberturas reopening
  where reopening.clinic_id = p_clinic_id and reopening.operation_id = p_operation_id;
  if found then
    if v_existing.closure_id <> p_closure_id then
      raise exception 'gestao_operation_reused' using errcode = '23505';
    end if;
    return pg_catalog.jsonb_build_object('id', v_existing.id, 'idempotent', true);
  end if;
  select * into v_closure
  from public.gestao_fechamentos_mensais closure
  where closure.clinic_id = p_clinic_id and closure.id = p_closure_id
  for share;
  if not found then raise exception 'gestao_closure_not_found' using errcode = 'P0002'; end if;
  if exists (
    select 1 from public.gestao_fechamento_reaberturas reopening
    where reopening.clinic_id = p_clinic_id and reopening.closure_id = p_closure_id
  ) then
    raise exception 'gestao_closure_already_reopened' using errcode = '55000';
  end if;
  insert into public.gestao_fechamento_reaberturas (
    clinic_id, closure_id, reopen_reason, operation_id, request_id, reopened_by
  ) values (
    p_clinic_id, p_closure_id, pg_catalog.btrim(p_reopen_reason),
    p_operation_id, p_request_id, p_actor_id
  ) returning * into v_existing;
  insert into public.gestao_administrativa_auditoria (
    clinic_id, actor_id, entity, entity_id, action, operation_id, request_id, details
  ) values (
    p_clinic_id, p_actor_id, 'monthly_closure', p_closure_id, 'reopen',
    p_operation_id, p_request_id,
    pg_catalog.jsonb_build_object(
      'period_month', pg_catalog.to_char(v_closure.period_start, 'YYYY-MM'),
      'closure_version', v_closure.version, 'reason_present', true, 'source', 'gestao_edge'
    )
  );
  return pg_catalog.jsonb_build_object('id', v_existing.id, 'idempotent', false);
end;
$function$;

create or replace function public.gestao_registrar_evidencia_backup(
  p_id uuid,
  p_clinic_id uuid,
  p_actor_id uuid,
  p_event_kind text,
  p_system_scope text,
  p_occurred_at timestamptz,
  p_result text,
  p_evidence_reference text,
  p_notes text,
  p_operation_id uuid,
  p_request_id uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_existing public.gestao_backup_restauracao_evidencias%rowtype;
begin
  perform private.gestao_assert_owner(p_clinic_id, p_actor_id);
  if p_id is null or p_operation_id is null or p_request_id is null
     or p_event_kind not in ('backup_executado', 'restauracao_testada', 'restauracao_falhou')
     or p_result not in ('sucesso', 'falha')
     or (p_event_kind in ('backup_executado', 'restauracao_testada') and p_result <> 'sucesso')
     or (p_event_kind = 'restauracao_falhou' and p_result <> 'falha')
     or p_occurred_at is null or p_occurred_at > pg_catalog.now() + interval '5 minutes'
     or pg_catalog.char_length(pg_catalog.btrim(coalesce(p_system_scope, ''))) not between 3 and 120
     or pg_catalog.char_length(pg_catalog.btrim(coalesce(p_evidence_reference, ''))) not between 3 and 300 then
    raise exception 'gestao_invalid_backup_evidence' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext(p_clinic_id::text), pg_catalog.hashtext(p_operation_id::text)
  );
  select * into v_existing
  from public.gestao_backup_restauracao_evidencias evidence
  where evidence.clinic_id = p_clinic_id and evidence.operation_id = p_operation_id;
  if found then
    if v_existing.id <> p_id then raise exception 'gestao_operation_reused' using errcode = '23505'; end if;
    return pg_catalog.jsonb_build_object('id', v_existing.id, 'idempotent', true);
  end if;
  insert into public.gestao_backup_restauracao_evidencias (
    id, clinic_id, event_kind, system_scope, occurred_at, result,
    evidence_reference, notes, operation_id, request_id, recorded_by
  ) values (
    p_id, p_clinic_id, p_event_kind, pg_catalog.btrim(p_system_scope), p_occurred_at,
    p_result, pg_catalog.btrim(p_evidence_reference), nullif(pg_catalog.btrim(p_notes), ''),
    p_operation_id, p_request_id, p_actor_id
  ) returning * into v_existing;
  insert into public.gestao_administrativa_auditoria (
    clinic_id, actor_id, entity, entity_id, action, operation_id, request_id, details
  ) values (
    p_clinic_id, p_actor_id, 'backup_evidence', p_id, 'record',
    p_operation_id, p_request_id,
    pg_catalog.jsonb_build_object('new_status', p_result, 'reason_present', true, 'source', 'gestao_edge')
  );
  return pg_catalog.jsonb_build_object('id', p_id, 'idempotent', false);
end;
$function$;

-- ---------------------------------------------------------------------------
-- Contas operacionais, liquidação e conciliação (sem credenciais bancárias)
-- ---------------------------------------------------------------------------

create or replace function public.gestao_criar_conta_caixa(
  p_id uuid,
  p_clinic_id uuid,
  p_actor_id uuid,
  p_name text,
  p_account_type text,
  p_institution_label text,
  p_identifier_last4 text,
  p_opening_balance numeric,
  p_opening_balance_date date,
  p_idempotency_key uuid,
  p_request_id uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_existing public.gestao_contas_caixa%rowtype;
begin
  perform private.gestao_assert_owner(p_clinic_id, p_actor_id);
  if p_id is null or p_idempotency_key is null or p_request_id is null
     or p_account_type not in ('banco', 'caixa', 'carteira', 'gateway', 'outro')
     or p_opening_balance_date is null
     or pg_catalog.char_length(pg_catalog.btrim(coalesce(p_name, ''))) not between 2 and 100
     or (p_identifier_last4 is not null and p_identifier_last4 !~ '^[A-Za-z0-9]{4}$') then
    raise exception 'gestao_invalid_cash_account' using errcode = '22023';
  end if;
  perform private.gestao_lock_financial_mutation(p_clinic_id);
  if private.gestao_period_is_closed(p_clinic_id, p_opening_balance_date) then
    raise exception 'financial_period_closed' using errcode = '55000';
  end if;
  select * into v_existing
  from public.gestao_contas_caixa account
  where account.clinic_id = p_clinic_id and account.idempotency_key = p_idempotency_key;
  if found then
    if v_existing.id <> p_id then raise exception 'gestao_operation_reused' using errcode = '23505'; end if;
    return pg_catalog.jsonb_build_object('id', v_existing.id, 'version', v_existing.version, 'idempotent', true);
  end if;
  insert into public.gestao_contas_caixa (
    id, clinic_id, name, account_type, institution_label, identifier_last4,
    opening_balance, opening_balance_date, idempotency_key, created_by, updated_by
  ) values (
    p_id, p_clinic_id, pg_catalog.btrim(p_name), p_account_type,
    nullif(pg_catalog.btrim(p_institution_label), ''),
    nullif(pg_catalog.btrim(p_identifier_last4), ''),
    p_opening_balance, p_opening_balance_date, p_idempotency_key, p_actor_id, p_actor_id
  ) returning * into v_existing;
  insert into public.gestao_administrativa_auditoria (
    clinic_id, actor_id, entity, entity_id, action, operation_id, request_id, details
  ) values (
    p_clinic_id, p_actor_id, 'cash_account', p_id, 'create',
    p_idempotency_key, p_request_id,
    pg_catalog.jsonb_build_object('new_status', 'active', 'new_version', 1, 'source', 'gestao_edge')
  );
  return pg_catalog.jsonb_build_object('id', p_id, 'version', 1, 'idempotent', false);
end;
$function$;

create or replace function public.gestao_editar_conta_caixa(
  p_clinic_id uuid,
  p_actor_id uuid,
  p_id uuid,
  p_expected_version integer,
  p_name text,
  p_account_type text,
  p_institution_label text,
  p_identifier_last4 text,
  p_opening_balance numeric,
  p_opening_balance_date date,
  p_reason text,
  p_operation_id uuid,
  p_request_id uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_old public.gestao_contas_caixa%rowtype;
  v_new public.gestao_contas_caixa%rowtype;
begin
  perform private.gestao_assert_owner(p_clinic_id, p_actor_id);
  if p_id is null or p_operation_id is null or p_request_id is null or p_expected_version < 1
     or p_account_type not in ('banco', 'caixa', 'carteira', 'gateway', 'outro')
     or p_opening_balance_date is null
     or pg_catalog.char_length(pg_catalog.btrim(coalesce(p_name, ''))) not between 2 and 100
     or pg_catalog.char_length(pg_catalog.btrim(coalesce(p_reason, ''))) not between 3 and 300
     or (p_identifier_last4 is not null and p_identifier_last4 !~ '^[A-Za-z0-9]{4}$') then
    raise exception 'gestao_invalid_cash_account' using errcode = '22023';
  end if;
  perform private.gestao_lock_financial_mutation(p_clinic_id);
  select * into v_old from public.gestao_contas_caixa account
  where account.clinic_id = p_clinic_id and account.id = p_id for update;
  if not found then raise exception 'gestao_cash_account_not_found' using errcode = 'P0002'; end if;
  if v_old.archived_at is not null then raise exception 'gestao_record_archived' using errcode = '55000'; end if;
  if v_old.version <> p_expected_version then raise exception 'version_conflict' using errcode = '40001'; end if;
  if private.gestao_period_is_closed(p_clinic_id, v_old.opening_balance_date)
     or private.gestao_period_is_closed(p_clinic_id, p_opening_balance_date) then
    raise exception 'financial_period_closed' using errcode = '55000';
  end if;
  if exists (
    select 1
    from public.gestao_liquidacoes_financeiras liquidation
    where liquidation.clinic_id = p_clinic_id
      and liquidation.account_id = p_id
      and (liquidation.settled_at at time zone 'America/Sao_Paulo')::date
        < p_opening_balance_date
  ) then
    raise exception 'gestao_opening_balance_after_settlement' using errcode = '22023';
  end if;
  update public.gestao_contas_caixa
  set name = pg_catalog.btrim(p_name), account_type = p_account_type,
      institution_label = nullif(pg_catalog.btrim(p_institution_label), ''),
      identifier_last4 = nullif(pg_catalog.btrim(p_identifier_last4), ''),
      opening_balance = p_opening_balance, opening_balance_date = p_opening_balance_date,
      updated_by = p_actor_id
  where clinic_id = p_clinic_id and id = p_id
  returning * into v_new;
  insert into public.gestao_administrativa_auditoria (
    clinic_id, actor_id, entity, entity_id, action, operation_id, request_id, details
  ) values (
    p_clinic_id, p_actor_id, 'cash_account', p_id, 'edit', p_operation_id, p_request_id,
    pg_catalog.jsonb_build_object(
      'previous_version', v_old.version, 'new_version', v_new.version,
      'reason_present', true, 'source', 'gestao_edge'
    )
  );
  return pg_catalog.jsonb_build_object('id', p_id, 'version', v_new.version);
end;
$function$;

create or replace function public.gestao_alterar_arquivo_conta_caixa(
  p_clinic_id uuid,
  p_actor_id uuid,
  p_id uuid,
  p_expected_version integer,
  p_restore boolean,
  p_reason text,
  p_operation_id uuid,
  p_request_id uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_old public.gestao_contas_caixa%rowtype;
  v_new public.gestao_contas_caixa%rowtype;
begin
  perform private.gestao_assert_owner(p_clinic_id, p_actor_id);
  if p_id is null or p_operation_id is null or p_request_id is null or p_expected_version < 1
     or p_restore is null
     or pg_catalog.char_length(pg_catalog.btrim(coalesce(p_reason, ''))) not between 3 and 300 then
    raise exception 'gestao_invalid_cash_account' using errcode = '22023';
  end if;
  perform private.gestao_lock_financial_mutation(p_clinic_id);
  select * into v_old from public.gestao_contas_caixa account
  where account.clinic_id = p_clinic_id and account.id = p_id for update;
  if not found then raise exception 'gestao_cash_account_not_found' using errcode = 'P0002'; end if;
  if v_old.version <> p_expected_version then raise exception 'version_conflict' using errcode = '40001'; end if;
  if p_restore and v_old.archived_at is null then raise exception 'gestao_record_not_archived' using errcode = '55000'; end if;
  if not p_restore and v_old.archived_at is not null then raise exception 'gestao_record_archived' using errcode = '55000'; end if;
  update public.gestao_contas_caixa
  set archived_at = case when p_restore then null else pg_catalog.now() end,
      archived_by = case when p_restore then null else p_actor_id end,
      archive_reason = case when p_restore then null else pg_catalog.btrim(p_reason) end,
      updated_by = p_actor_id
  where clinic_id = p_clinic_id and id = p_id returning * into v_new;
  insert into public.gestao_administrativa_auditoria (
    clinic_id, actor_id, entity, entity_id, action, operation_id, request_id, details
  ) values (
    p_clinic_id, p_actor_id, 'cash_account', p_id, case when p_restore then 'restore' else 'archive' end,
    p_operation_id, p_request_id,
    pg_catalog.jsonb_build_object(
      'previous_status', case when p_restore then 'archived' else 'active' end,
      'new_status', case when p_restore then 'active' else 'archived' end,
      'previous_version', v_old.version, 'new_version', v_new.version,
      'reason_present', true, 'source', 'gestao_edge'
    )
  );
  return pg_catalog.jsonb_build_object('id', p_id, 'version', v_new.version);
end;
$function$;

create or replace function public.gestao_registrar_liquidacao(
  p_id uuid,
  p_clinic_id uuid,
  p_actor_id uuid,
  p_account_id uuid,
  p_payment_id uuid,
  p_gross_amount numeric,
  p_fee_amount numeric,
  p_net_amount numeric,
  p_settled_at timestamptz,
  p_reference text,
  p_operation_id uuid,
  p_request_id uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_account public.gestao_contas_caixa%rowtype;
  v_payment public.financeiro_pagamentos%rowtype;
  v_entry_type text;
  v_settled numeric(14,2);
begin
  perform private.gestao_assert_owner(p_clinic_id, p_actor_id);
  if p_id is null or p_account_id is null or p_payment_id is null
     or p_operation_id is null or p_request_id is null or p_settled_at is null
     or p_gross_amount is null or p_fee_amount is null or p_net_amount is null
     or p_settled_at > pg_catalog.now() + interval '5 minutes'
     or p_gross_amount <= 0 or p_fee_amount < 0 or p_net_amount < 0
     or (p_reference is not null and (
       p_reference !~ '^[A-Za-z0-9 ._/-]{2,80}$'
       or pg_catalog.char_length(pg_catalog.regexp_replace(p_reference, '[^0-9]', '', 'g')) > 8
     )) then
    raise exception 'gestao_invalid_settlement' using errcode = '22023';
  end if;
  select * into v_account from public.gestao_contas_caixa account
  where account.clinic_id = p_clinic_id and account.id = p_account_id for share;
  if not found or v_account.archived_at is not null then
    raise exception 'gestao_cash_account_not_found' using errcode = 'P0002';
  end if;
  if (p_settled_at at time zone 'America/Sao_Paulo')::date < v_account.opening_balance_date then
    raise exception 'gestao_invalid_settlement' using errcode = '22023';
  end if;
  select payment.* into v_payment
  from public.financeiro_pagamentos payment
  where payment.clinic_id = p_clinic_id and payment.id = p_payment_id
  for share;
  if not found or v_payment.movement_type <> 'pagamento' then
    raise exception 'gestao_payment_not_found' using errcode = 'P0002';
  end if;
  select entry.entry_type into v_entry_type
  from public.financeiro_lancamentos entry
  where entry.clinic_id = p_clinic_id and entry.id = v_payment.entry_id;
  if (v_entry_type = 'receita' and (p_fee_amount > p_gross_amount or p_net_amount <> p_gross_amount - p_fee_amount))
     or (v_entry_type = 'despesa' and p_net_amount <> p_gross_amount + p_fee_amount) then
    raise exception 'gestao_settlement_amount_mismatch' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(p_clinic_id::text), pg_catalog.hashtext(p_payment_id::text));
  select coalesce(pg_catalog.sum(
    case when liquidation.movement_kind = 'liquidacao' then liquidation.gross_amount else -liquidation.gross_amount end
  ), 0) into v_settled
  from public.gestao_liquidacoes_financeiras liquidation
  where liquidation.clinic_id = p_clinic_id and liquidation.payment_id = p_payment_id;
  if v_settled + p_gross_amount > v_payment.amount then
    raise exception 'gestao_settlement_exceeds_payment' using errcode = '22023';
  end if;
  insert into public.gestao_liquidacoes_financeiras (
    id, clinic_id, account_id, payment_id, movement_kind,
    gross_amount, fee_amount, net_amount, settled_at, reference, reason,
    operation_id, request_id, recorded_by
  ) values (
    p_id, p_clinic_id, p_account_id, p_payment_id, 'liquidacao',
    p_gross_amount, p_fee_amount, p_net_amount, p_settled_at,
    nullif(pg_catalog.btrim(p_reference), ''), null,
    p_operation_id, p_request_id, p_actor_id
  );
  insert into public.gestao_administrativa_auditoria (
    clinic_id, actor_id, entity, entity_id, action, operation_id, request_id, details
  ) values (
    p_clinic_id, p_actor_id, 'settlement', p_id, 'record', p_operation_id, p_request_id,
    pg_catalog.jsonb_build_object('new_status', 'settled', 'reason_present', true, 'source', 'gestao_edge')
  );
  return pg_catalog.jsonb_build_object('id', p_id, 'idempotent', false);
end;
$function$;

create or replace function public.gestao_estornar_liquidacao(
  p_id uuid,
  p_clinic_id uuid,
  p_actor_id uuid,
  p_original_id uuid,
  p_settled_at timestamptz,
  p_reason text,
  p_operation_id uuid,
  p_request_id uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_original public.gestao_liquidacoes_financeiras%rowtype;
begin
  perform private.gestao_assert_owner(p_clinic_id, p_actor_id);
  if p_id is null or p_original_id is null or p_operation_id is null or p_request_id is null
     or p_settled_at is null or p_settled_at > pg_catalog.now() + interval '5 minutes'
     or pg_catalog.char_length(pg_catalog.btrim(coalesce(p_reason, ''))) not between 3 and 300 then
    raise exception 'gestao_invalid_settlement_reversal' using errcode = '22023';
  end if;
  select * into v_original from public.gestao_liquidacoes_financeiras liquidation
  where liquidation.clinic_id = p_clinic_id and liquidation.id = p_original_id for share;
  if not found or v_original.movement_kind <> 'liquidacao' then
    raise exception 'gestao_settlement_not_found' using errcode = 'P0002';
  end if;
  if p_settled_at < v_original.settled_at then
    raise exception 'gestao_reversal_before_settlement' using errcode = '22023';
  end if;
  if exists (
    select 1 from public.gestao_liquidacoes_financeiras reversal
    where reversal.clinic_id = p_clinic_id and reversal.reversal_of_id = p_original_id
  ) then raise exception 'gestao_settlement_already_reversed' using errcode = '55000'; end if;
  insert into public.gestao_liquidacoes_financeiras (
    id, clinic_id, account_id, payment_id, movement_kind,
    gross_amount, fee_amount, net_amount, settled_at, reference, reason,
    reversal_of_id, operation_id, request_id, recorded_by
  ) values (
    p_id, p_clinic_id, v_original.account_id, v_original.payment_id, 'estorno',
    v_original.gross_amount, v_original.fee_amount, v_original.net_amount,
    p_settled_at, 'estorno_confirmado', pg_catalog.btrim(p_reason),
    p_original_id, p_operation_id, p_request_id, p_actor_id
  );
  insert into public.gestao_administrativa_auditoria (
    clinic_id, actor_id, entity, entity_id, action, operation_id, request_id, details
  ) values (
    p_clinic_id, p_actor_id, 'settlement', p_original_id, 'reverse', p_operation_id, p_request_id,
    pg_catalog.jsonb_build_object('previous_status', 'settled', 'new_status', 'reversed', 'reason_present', true, 'source', 'gestao_edge')
  );
  return pg_catalog.jsonb_build_object('id', p_id, 'reversal_of_id', p_original_id);
end;
$function$;

create or replace function public.gestao_registrar_conciliacao(
  p_id uuid,
  p_clinic_id uuid,
  p_actor_id uuid,
  p_account_id uuid,
  p_period_start date,
  p_period_end date,
  p_external_amount numeric,
  p_evidence_reference text,
  p_notes text,
  p_operation_id uuid,
  p_request_id uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_account public.gestao_contas_caixa%rowtype;
  v_current public.gestao_conciliacoes_financeiras%rowtype;
  v_internal numeric(14,2);
  v_version integer;
  v_status text;
begin
  perform private.gestao_assert_owner(p_clinic_id, p_actor_id);
  if p_id is null or p_account_id is null or p_operation_id is null or p_request_id is null
     or p_external_amount is null
     or p_period_start is null or p_period_end is null or p_period_end < p_period_start
     or p_period_end > p_period_start + interval '1 year'
     or pg_catalog.char_length(pg_catalog.btrim(coalesce(p_evidence_reference, ''))) not between 3 and 300 then
    raise exception 'gestao_invalid_reconciliation' using errcode = '22023';
  end if;
  perform private.gestao_lock_financial_mutation(p_clinic_id);
  if exists (
    select 1
    from pg_catalog.generate_series(
      pg_catalog.date_trunc('month', p_period_start::timestamp),
      pg_catalog.date_trunc('month', p_period_end::timestamp),
      interval '1 month'
    ) as series(month_start)
    where private.gestao_period_is_closed(p_clinic_id, series.month_start::date)
  ) then
    raise exception 'financial_period_closed' using errcode = '55000';
  end if;
  select * into v_account from public.gestao_contas_caixa account
  where account.clinic_id = p_clinic_id and account.id = p_account_id for share;
  if not found or v_account.archived_at is not null then
    raise exception 'gestao_cash_account_not_found' using errcode = 'P0002';
  end if;
  if v_account.opening_balance_date > p_period_end then
    raise exception 'gestao_reconciliation_before_opening' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext(p_clinic_id::text), pg_catalog.hashtext(p_account_id::text)
  );
  select * into v_current
  from public.gestao_conciliacoes_atuais reconciliation
  where reconciliation.clinic_id = p_clinic_id
    and reconciliation.account_id = p_account_id
    and reconciliation.period_start = p_period_start
    and reconciliation.period_end = p_period_end;
  v_version := coalesce(v_current.version, 0) + 1;
  select (
    v_account.opening_balance + coalesce(pg_catalog.sum(
      case
        when entry.entry_type = 'receita' and liquidation.movement_kind = 'liquidacao' then liquidation.net_amount
        when entry.entry_type = 'receita' and liquidation.movement_kind = 'estorno' then -liquidation.net_amount
        when entry.entry_type = 'despesa' and liquidation.movement_kind = 'liquidacao' then -liquidation.net_amount
        when entry.entry_type = 'despesa' and liquidation.movement_kind = 'estorno' then liquidation.net_amount
        else 0
      end
    ), 0)
  )::numeric(14,2) into v_internal
  from public.gestao_liquidacoes_financeiras liquidation
  join public.financeiro_pagamentos payment
    on payment.clinic_id = liquidation.clinic_id and payment.id = liquidation.payment_id
  join public.financeiro_lancamentos entry
    on entry.clinic_id = payment.clinic_id and entry.id = payment.entry_id
  where liquidation.clinic_id = p_clinic_id
    and liquidation.account_id = p_account_id
    and (liquidation.settled_at at time zone 'America/Sao_Paulo')::date
      between v_account.opening_balance_date and p_period_end;
  v_status := case when p_external_amount = v_internal then 'conciliada' else 'divergente' end;
  insert into public.gestao_conciliacoes_financeiras (
    id, clinic_id, account_id, period_start, period_end, version, supersedes_id,
    internal_amount, external_amount, status, evidence_reference, notes,
    operation_id, request_id, reconciled_by
  ) values (
    p_id, p_clinic_id, p_account_id, p_period_start, p_period_end, v_version, v_current.id,
    v_internal, p_external_amount, v_status, pg_catalog.btrim(p_evidence_reference),
    nullif(pg_catalog.btrim(p_notes), ''), p_operation_id, p_request_id, p_actor_id
  );
  insert into public.gestao_administrativa_auditoria (
    clinic_id, actor_id, entity, entity_id, action, operation_id, request_id, details
  ) values (
    p_clinic_id, p_actor_id, 'reconciliation', p_id, 'record', p_operation_id, p_request_id,
    pg_catalog.jsonb_build_object(
      'previous_version', coalesce(v_current.version, 0), 'new_version', v_version,
      'new_status', v_status, 'reason_present', true, 'source', 'gestao_edge'
    )
  );
  return pg_catalog.jsonb_build_object(
    'id', p_id, 'version', v_version, 'status', v_status,
    'internal_amount', v_internal, 'external_amount', p_external_amount,
    'difference_amount', p_external_amount - v_internal
  );
end;
$function$;

-- ---------------------------------------------------------------------------
-- Equipamentos e manutenções: edição versionada, finalização imutável.
-- ---------------------------------------------------------------------------

create or replace function public.gestao_criar_equipamento(
  p_id uuid,
  p_clinic_id uuid,
  p_actor_id uuid,
  p_asset_code text,
  p_category text,
  p_name text,
  p_brand text,
  p_model text,
  p_serial_number text,
  p_patrimonial_number text,
  p_location text,
  p_possession_mode text,
  p_supplier_id uuid,
  p_acquisition_date date,
  p_acquisition_cost numeric,
  p_warranty_start date,
  p_warranty_end date,
  p_warranty_reference text,
  p_manual_reference text,
  p_technical_source_reference text,
  p_responsible_label text,
  p_criticality text,
  p_status text,
  p_notes text,
  p_idempotency_key uuid,
  p_request_id uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_existing public.gestao_equipamentos%rowtype;
begin
  perform private.gestao_assert_owner(p_clinic_id, p_actor_id);
  if p_id is null or p_idempotency_key is null or p_request_id is null
     or pg_catalog.char_length(pg_catalog.btrim(coalesce(p_asset_code, ''))) not between 2 and 40
     or pg_catalog.char_length(pg_catalog.btrim(coalesce(p_category, ''))) not between 2 and 80
     or pg_catalog.char_length(pg_catalog.btrim(coalesce(p_name, ''))) not between 2 and 120
     or p_possession_mode not in ('proprio', 'locacao', 'comodato', 'leasing', 'outro')
     or p_criticality not in ('baixa', 'media', 'alta', 'critica')
     or p_status not in (
       'em_cadastro', 'ativo', 'disponivel', 'em_uso', 'reserva', 'em_manutencao',
       'aguardando_peca', 'aguardando_validacao', 'quarentena', 'indisponivel',
       'desativado', 'baixa_pendente', 'baixado'
     ) then
    raise exception 'gestao_invalid_equipment' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext(p_clinic_id::text), pg_catalog.hashtext(p_idempotency_key::text)
  );
  select * into v_existing from public.gestao_equipamentos equipment
  where equipment.clinic_id = p_clinic_id and equipment.idempotency_key = p_idempotency_key;
  if found then
    if v_existing.id <> p_id then raise exception 'gestao_operation_reused' using errcode = '23505'; end if;
    return pg_catalog.jsonb_build_object('id', v_existing.id, 'version', v_existing.version, 'idempotent', true);
  end if;
  insert into public.gestao_equipamentos (
    id, clinic_id, asset_code, category, name, brand, model, serial_number,
    patrimonial_number, location, possession_mode, supplier_id,
    acquisition_date, acquisition_cost, warranty_start, warranty_end,
    warranty_reference, manual_reference, technical_source_reference,
    responsible_label, criticality, status, notes, idempotency_key,
    created_by, updated_by
  ) values (
    p_id, p_clinic_id, pg_catalog.btrim(p_asset_code), pg_catalog.btrim(p_category),
    pg_catalog.btrim(p_name), nullif(pg_catalog.btrim(p_brand), ''),
    nullif(pg_catalog.btrim(p_model), ''),
    nullif(pg_catalog.btrim(p_serial_number), ''),
    nullif(pg_catalog.btrim(p_patrimonial_number), ''),
    nullif(pg_catalog.btrim(p_location), ''), p_possession_mode, p_supplier_id,
    p_acquisition_date, p_acquisition_cost, p_warranty_start, p_warranty_end,
    nullif(pg_catalog.btrim(p_warranty_reference), ''),
    nullif(pg_catalog.btrim(p_manual_reference), ''),
    nullif(pg_catalog.btrim(p_technical_source_reference), ''),
    nullif(pg_catalog.btrim(p_responsible_label), ''),
    p_criticality, p_status, nullif(pg_catalog.btrim(p_notes), ''),
    p_idempotency_key, p_actor_id, p_actor_id
  ) returning * into v_existing;
  insert into public.gestao_administrativa_auditoria (
    clinic_id, actor_id, entity, entity_id, action, operation_id, request_id, details
  ) values (
    p_clinic_id, p_actor_id, 'equipment', p_id, 'create', p_idempotency_key, p_request_id,
    pg_catalog.jsonb_build_object('new_status', p_status, 'new_version', 1, 'source', 'gestao_edge')
  );
  return pg_catalog.jsonb_build_object('id', p_id, 'version', 1, 'idempotent', false);
end;
$function$;

create or replace function public.gestao_editar_equipamento(
  p_clinic_id uuid,
  p_actor_id uuid,
  p_id uuid,
  p_expected_version integer,
  p_asset_code text,
  p_category text,
  p_name text,
  p_brand text,
  p_model text,
  p_serial_number text,
  p_patrimonial_number text,
  p_location text,
  p_possession_mode text,
  p_supplier_id uuid,
  p_acquisition_date date,
  p_acquisition_cost numeric,
  p_warranty_start date,
  p_warranty_end date,
  p_warranty_reference text,
  p_manual_reference text,
  p_technical_source_reference text,
  p_responsible_label text,
  p_criticality text,
  p_status text,
  p_notes text,
  p_reason text,
  p_operation_id uuid,
  p_request_id uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_old public.gestao_equipamentos%rowtype;
  v_new public.gestao_equipamentos%rowtype;
begin
  perform private.gestao_assert_owner(p_clinic_id, p_actor_id);
  if p_id is null or p_operation_id is null or p_request_id is null or p_expected_version < 1
     or pg_catalog.char_length(pg_catalog.btrim(coalesce(p_asset_code, ''))) not between 2 and 40
     or pg_catalog.char_length(pg_catalog.btrim(coalesce(p_category, ''))) not between 2 and 80
     or pg_catalog.char_length(pg_catalog.btrim(coalesce(p_name, ''))) not between 2 and 120
     or pg_catalog.char_length(pg_catalog.btrim(coalesce(p_reason, ''))) not between 3 and 300
     or p_possession_mode not in ('proprio', 'locacao', 'comodato', 'leasing', 'outro')
     or p_criticality not in ('baixa', 'media', 'alta', 'critica')
     or p_status not in (
       'em_cadastro', 'ativo', 'disponivel', 'em_uso', 'reserva', 'em_manutencao',
       'aguardando_peca', 'aguardando_validacao', 'quarentena', 'indisponivel',
       'desativado', 'baixa_pendente', 'baixado'
     ) then
    raise exception 'gestao_invalid_equipment' using errcode = '22023';
  end if;
  select * into v_old from public.gestao_equipamentos equipment
  where equipment.clinic_id = p_clinic_id and equipment.id = p_id for update;
  if not found then raise exception 'gestao_equipment_not_found' using errcode = 'P0002'; end if;
  if v_old.archived_at is not null then raise exception 'gestao_record_archived' using errcode = '55000'; end if;
  if v_old.version <> p_expected_version then raise exception 'version_conflict' using errcode = '40001'; end if;
  update public.gestao_equipamentos
  set asset_code = pg_catalog.btrim(p_asset_code), category = pg_catalog.btrim(p_category),
      name = pg_catalog.btrim(p_name), brand = nullif(pg_catalog.btrim(p_brand), ''),
      model = nullif(pg_catalog.btrim(p_model), ''),
      serial_number = nullif(pg_catalog.btrim(p_serial_number), ''),
      patrimonial_number = nullif(pg_catalog.btrim(p_patrimonial_number), ''),
      location = nullif(pg_catalog.btrim(p_location), ''),
      possession_mode = p_possession_mode, supplier_id = p_supplier_id,
      acquisition_date = p_acquisition_date, acquisition_cost = p_acquisition_cost,
      warranty_start = p_warranty_start, warranty_end = p_warranty_end,
      warranty_reference = nullif(pg_catalog.btrim(p_warranty_reference), ''),
      manual_reference = nullif(pg_catalog.btrim(p_manual_reference), ''),
      technical_source_reference = nullif(pg_catalog.btrim(p_technical_source_reference), ''),
      responsible_label = nullif(pg_catalog.btrim(p_responsible_label), ''),
      criticality = p_criticality, status = p_status,
      notes = nullif(pg_catalog.btrim(p_notes), ''), updated_by = p_actor_id
  where clinic_id = p_clinic_id and id = p_id returning * into v_new;
  insert into public.gestao_administrativa_auditoria (
    clinic_id, actor_id, entity, entity_id, action, operation_id, request_id, details
  ) values (
    p_clinic_id, p_actor_id, 'equipment', p_id, 'edit', p_operation_id, p_request_id,
    pg_catalog.jsonb_build_object(
      'previous_status', v_old.status, 'new_status', v_new.status,
      'previous_version', v_old.version, 'new_version', v_new.version,
      'reason_present', true, 'source', 'gestao_edge'
    )
  );
  return pg_catalog.jsonb_build_object('id', p_id, 'version', v_new.version);
end;
$function$;

create or replace function public.gestao_alterar_arquivo_equipamento(
  p_clinic_id uuid,
  p_actor_id uuid,
  p_id uuid,
  p_expected_version integer,
  p_restore boolean,
  p_reason text,
  p_operation_id uuid,
  p_request_id uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_old public.gestao_equipamentos%rowtype;
  v_new public.gestao_equipamentos%rowtype;
begin
  perform private.gestao_assert_owner(p_clinic_id, p_actor_id);
  if p_id is null or p_operation_id is null or p_request_id is null or p_expected_version < 1
     or p_restore is null
     or pg_catalog.char_length(pg_catalog.btrim(coalesce(p_reason, ''))) not between 3 and 300 then
    raise exception 'gestao_invalid_equipment_archive' using errcode = '22023';
  end if;
  select * into v_old from public.gestao_equipamentos equipment
  where equipment.clinic_id = p_clinic_id and equipment.id = p_id for update;
  if not found then raise exception 'gestao_equipment_not_found' using errcode = 'P0002'; end if;
  if v_old.version <> p_expected_version then raise exception 'version_conflict' using errcode = '40001'; end if;
  if p_restore and v_old.archived_at is null then raise exception 'gestao_record_not_archived' using errcode = '55000'; end if;
  if not p_restore and v_old.archived_at is not null then raise exception 'gestao_record_archived' using errcode = '55000'; end if;
  update public.gestao_equipamentos
  set archived_at = case when p_restore then null else pg_catalog.now() end,
      archived_by = case when p_restore then null else p_actor_id end,
      archive_reason = case when p_restore then null else pg_catalog.btrim(p_reason) end,
      status = case when p_restore then 'em_cadastro' else 'desativado' end,
      updated_by = p_actor_id
  where clinic_id = p_clinic_id and id = p_id returning * into v_new;
  insert into public.gestao_administrativa_auditoria (
    clinic_id, actor_id, entity, entity_id, action, operation_id, request_id, details
  ) values (
    p_clinic_id, p_actor_id, 'equipment', p_id, case when p_restore then 'restore' else 'archive' end,
    p_operation_id, p_request_id,
    pg_catalog.jsonb_build_object(
      'previous_status', v_old.status, 'new_status', v_new.status,
      'previous_version', v_old.version, 'new_version', v_new.version,
      'reason_present', true, 'source', 'gestao_edge'
    )
  );
  return pg_catalog.jsonb_build_object('id', p_id, 'version', v_new.version);
end;
$function$;

create or replace function public.gestao_criar_manutencao(
  p_id uuid,
  p_clinic_id uuid,
  p_actor_id uuid,
  p_equipment_id uuid,
  p_correction_of_id uuid,
  p_maintenance_kind text,
  p_status text,
  p_description text,
  p_symptom text,
  p_service_provider text,
  p_service_order_reference text,
  p_scheduled_for date,
  p_started_at timestamptz,
  p_next_due_date date,
  p_technical_source_type text,
  p_technical_source_reference text,
  p_cost numeric,
  p_downtime_minutes integer,
  p_evidence_reference text,
  p_idempotency_key uuid,
  p_request_id uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_existing public.gestao_equipamento_manutencoes%rowtype;
begin
  perform private.gestao_assert_owner(p_clinic_id, p_actor_id);
  if p_id is null or p_equipment_id is null or p_idempotency_key is null or p_request_id is null
     or p_maintenance_kind not in (
       'preventiva', 'corretiva', 'inspecao_visual', 'verificacao_funcional',
       'teste_seguranca', 'calibracao', 'qualificacao', 'limpeza', 'outro'
     )
     or p_status not in ('planejada', 'agendada', 'em_andamento')
     or (p_status = 'agendada' and p_scheduled_for is null)
     or p_technical_source_type not in (
       'official_manual', 'manufacturer', 'authorized_service', 'contract',
       'regulatory', 'responsible_technical', 'pending_validation'
     )
     or pg_catalog.char_length(pg_catalog.btrim(coalesce(p_description, ''))) not between 3 and 500
     or (p_next_due_date is not null and (
       p_technical_source_type = 'pending_validation'
       or pg_catalog.char_length(pg_catalog.btrim(coalesce(p_technical_source_reference, ''))) < 3
     )) then
    raise exception 'gestao_invalid_maintenance' using errcode = '22023';
  end if;
  perform 1
  from public.gestao_equipamentos equipment
  where equipment.clinic_id = p_clinic_id
    and equipment.id = p_equipment_id
    and equipment.archived_at is null
  for share;
  if not found then
    raise exception 'gestao_equipment_not_found' using errcode = 'P0002';
  end if;
  if p_correction_of_id is not null and not exists (
    select 1 from public.gestao_equipamento_manutencoes prior
    where prior.clinic_id = p_clinic_id and prior.id = p_correction_of_id
      and prior.equipment_id = p_equipment_id and prior.status in ('concluida', 'cancelada')
  ) then raise exception 'gestao_correction_target_invalid' using errcode = '22023'; end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext(p_clinic_id::text), pg_catalog.hashtext(p_idempotency_key::text)
  );
  select * into v_existing from public.gestao_equipamento_manutencoes maintenance
  where maintenance.clinic_id = p_clinic_id and maintenance.idempotency_key = p_idempotency_key;
  if found then
    if v_existing.id <> p_id then raise exception 'gestao_operation_reused' using errcode = '23505'; end if;
    return pg_catalog.jsonb_build_object('id', v_existing.id, 'version', v_existing.version, 'idempotent', true);
  end if;
  insert into public.gestao_equipamento_manutencoes (
    id, clinic_id, equipment_id, correction_of_id, maintenance_kind, status,
    description, symptom, service_provider, service_order_reference,
    scheduled_for, started_at, next_due_date, technical_source_type,
    technical_source_reference, cost, downtime_minutes, evidence_reference,
    idempotency_key, created_by, updated_by
  ) values (
    p_id, p_clinic_id, p_equipment_id, p_correction_of_id, p_maintenance_kind, p_status,
    pg_catalog.btrim(p_description), nullif(pg_catalog.btrim(p_symptom), ''),
    nullif(pg_catalog.btrim(p_service_provider), ''),
    nullif(pg_catalog.btrim(p_service_order_reference), ''),
    p_scheduled_for, p_started_at, p_next_due_date, p_technical_source_type,
    nullif(pg_catalog.btrim(p_technical_source_reference), ''),
    p_cost, p_downtime_minutes, nullif(pg_catalog.btrim(p_evidence_reference), ''),
    p_idempotency_key, p_actor_id, p_actor_id
  ) returning * into v_existing;
  insert into public.gestao_administrativa_auditoria (
    clinic_id, actor_id, entity, entity_id, action, operation_id, request_id, details
  ) values (
    p_clinic_id, p_actor_id, 'maintenance', p_id, 'create', p_idempotency_key, p_request_id,
    pg_catalog.jsonb_build_object(
      'new_status', p_status, 'maintenance_kind', p_maintenance_kind,
      'new_version', 1, 'source', 'gestao_edge'
    )
  );
  return pg_catalog.jsonb_build_object('id', p_id, 'version', 1, 'idempotent', false);
end;
$function$;

create or replace function public.gestao_editar_manutencao(
  p_clinic_id uuid,
  p_actor_id uuid,
  p_id uuid,
  p_expected_version integer,
  p_maintenance_kind text,
  p_status text,
  p_description text,
  p_symptom text,
  p_service_provider text,
  p_service_order_reference text,
  p_scheduled_for date,
  p_started_at timestamptz,
  p_next_due_date date,
  p_technical_source_type text,
  p_technical_source_reference text,
  p_cost numeric,
  p_downtime_minutes integer,
  p_evidence_reference text,
  p_reason text,
  p_operation_id uuid,
  p_request_id uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_old public.gestao_equipamento_manutencoes%rowtype;
  v_new public.gestao_equipamento_manutencoes%rowtype;
begin
  perform private.gestao_assert_owner(p_clinic_id, p_actor_id);
  if p_id is null or p_operation_id is null or p_request_id is null or p_expected_version < 1
     or p_maintenance_kind not in (
       'preventiva', 'corretiva', 'inspecao_visual', 'verificacao_funcional',
       'teste_seguranca', 'calibracao', 'qualificacao', 'limpeza', 'outro'
     )
     or p_status not in ('planejada', 'agendada', 'em_andamento')
     or (p_status = 'agendada' and p_scheduled_for is null)
     or p_technical_source_type not in (
       'official_manual', 'manufacturer', 'authorized_service', 'contract',
       'regulatory', 'responsible_technical', 'pending_validation'
     )
     or pg_catalog.char_length(pg_catalog.btrim(coalesce(p_description, ''))) not between 3 and 500
     or pg_catalog.char_length(pg_catalog.btrim(coalesce(p_reason, ''))) not between 3 and 300
     or (p_next_due_date is not null and (
       p_technical_source_type = 'pending_validation'
       or pg_catalog.char_length(pg_catalog.btrim(coalesce(p_technical_source_reference, ''))) < 3
     )) then
    raise exception 'gestao_invalid_maintenance' using errcode = '22023';
  end if;
  select * into v_old from public.gestao_equipamento_manutencoes maintenance
  where maintenance.clinic_id = p_clinic_id and maintenance.id = p_id for update;
  if not found then raise exception 'gestao_maintenance_not_found' using errcode = 'P0002'; end if;
  if v_old.version <> p_expected_version then raise exception 'version_conflict' using errcode = '40001'; end if;
  update public.gestao_equipamento_manutencoes
  set maintenance_kind = p_maintenance_kind, status = p_status,
      description = pg_catalog.btrim(p_description),
      symptom = nullif(pg_catalog.btrim(p_symptom), ''),
      service_provider = nullif(pg_catalog.btrim(p_service_provider), ''),
      service_order_reference = nullif(pg_catalog.btrim(p_service_order_reference), ''),
      scheduled_for = p_scheduled_for, started_at = p_started_at, next_due_date = p_next_due_date,
      technical_source_type = p_technical_source_type,
      technical_source_reference = nullif(pg_catalog.btrim(p_technical_source_reference), ''),
      cost = p_cost, downtime_minutes = p_downtime_minutes,
      evidence_reference = nullif(pg_catalog.btrim(p_evidence_reference), ''),
      updated_by = p_actor_id
  where clinic_id = p_clinic_id and id = p_id returning * into v_new;
  insert into public.gestao_administrativa_auditoria (
    clinic_id, actor_id, entity, entity_id, action, operation_id, request_id, details
  ) values (
    p_clinic_id, p_actor_id, 'maintenance', p_id, 'edit', p_operation_id, p_request_id,
    pg_catalog.jsonb_build_object(
      'previous_status', v_old.status, 'new_status', v_new.status,
      'maintenance_kind', v_new.maintenance_kind,
      'previous_version', v_old.version, 'new_version', v_new.version,
      'reason_present', true, 'source', 'gestao_edge'
    )
  );
  return pg_catalog.jsonb_build_object('id', p_id, 'version', v_new.version);
end;
$function$;

create or replace function public.gestao_concluir_manutencao(
  p_clinic_id uuid,
  p_actor_id uuid,
  p_id uuid,
  p_expected_version integer,
  p_completed_at timestamptz,
  p_result_summary text,
  p_cost numeric,
  p_downtime_minutes integer,
  p_next_due_date date,
  p_technical_source_type text,
  p_technical_source_reference text,
  p_evidence_reference text,
  p_reason text,
  p_operation_id uuid,
  p_request_id uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_old public.gestao_equipamento_manutencoes%rowtype;
  v_new public.gestao_equipamento_manutencoes%rowtype;
begin
  perform private.gestao_assert_owner(p_clinic_id, p_actor_id);
  if p_id is null or p_operation_id is null or p_request_id is null or p_expected_version < 1
     or p_completed_at is null
     or p_completed_at > pg_catalog.now() + interval '5 minutes'
     or pg_catalog.char_length(pg_catalog.btrim(coalesce(p_result_summary, ''))) not between 3 and 1000
     or pg_catalog.char_length(pg_catalog.btrim(coalesce(p_reason, ''))) not between 3 and 300
     or p_technical_source_type not in (
       'official_manual', 'manufacturer', 'authorized_service', 'contract',
       'regulatory', 'responsible_technical', 'pending_validation'
     )
     or (p_next_due_date is not null and (
       p_technical_source_type = 'pending_validation'
       or pg_catalog.char_length(pg_catalog.btrim(coalesce(p_technical_source_reference, ''))) < 3
     )) then
    raise exception 'gestao_invalid_maintenance_completion' using errcode = '22023';
  end if;
  select * into v_old from public.gestao_equipamento_manutencoes maintenance
  where maintenance.clinic_id = p_clinic_id and maintenance.id = p_id for update;
  if not found then raise exception 'gestao_maintenance_not_found' using errcode = 'P0002'; end if;
  if v_old.version <> p_expected_version then raise exception 'version_conflict' using errcode = '40001'; end if;
  if (v_old.started_at is not null and p_completed_at < v_old.started_at)
     or (
       p_next_due_date is not null
       and p_next_due_date < (p_completed_at at time zone 'America/Sao_Paulo')::date
     ) then
    raise exception 'gestao_invalid_maintenance_completion' using errcode = '22023';
  end if;
  update public.gestao_equipamento_manutencoes
  set status = 'concluida', completed_at = p_completed_at,
      result_summary = pg_catalog.btrim(p_result_summary), cost = p_cost,
      downtime_minutes = p_downtime_minutes, next_due_date = p_next_due_date,
      technical_source_type = p_technical_source_type,
      technical_source_reference = nullif(pg_catalog.btrim(p_technical_source_reference), ''),
      evidence_reference = nullif(pg_catalog.btrim(p_evidence_reference), ''),
      updated_by = p_actor_id
  where clinic_id = p_clinic_id and id = p_id returning * into v_new;
  insert into public.gestao_administrativa_auditoria (
    clinic_id, actor_id, entity, entity_id, action, operation_id, request_id, details
  ) values (
    p_clinic_id, p_actor_id, 'maintenance', p_id, 'complete', p_operation_id, p_request_id,
    pg_catalog.jsonb_build_object(
      'previous_status', v_old.status, 'new_status', 'concluida',
      'maintenance_kind', v_old.maintenance_kind,
      'previous_version', v_old.version, 'new_version', v_new.version,
      'reason_present', true, 'source', 'gestao_edge'
    )
  );
  return pg_catalog.jsonb_build_object('id', p_id, 'version', v_new.version);
end;
$function$;

create or replace function public.gestao_cancelar_manutencao(
  p_clinic_id uuid,
  p_actor_id uuid,
  p_id uuid,
  p_expected_version integer,
  p_reason text,
  p_operation_id uuid,
  p_request_id uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_old public.gestao_equipamento_manutencoes%rowtype;
  v_new public.gestao_equipamento_manutencoes%rowtype;
begin
  perform private.gestao_assert_owner(p_clinic_id, p_actor_id);
  if p_id is null or p_operation_id is null or p_request_id is null or p_expected_version < 1
     or pg_catalog.char_length(pg_catalog.btrim(coalesce(p_reason, ''))) not between 3 and 300 then
    raise exception 'gestao_invalid_maintenance_cancellation' using errcode = '22023';
  end if;
  select * into v_old from public.gestao_equipamento_manutencoes maintenance
  where maintenance.clinic_id = p_clinic_id and maintenance.id = p_id for update;
  if not found then raise exception 'gestao_maintenance_not_found' using errcode = 'P0002'; end if;
  if v_old.version <> p_expected_version then raise exception 'version_conflict' using errcode = '40001'; end if;
  update public.gestao_equipamento_manutencoes
  set status = 'cancelada', cancellation_reason = pg_catalog.btrim(p_reason),
      cancelled_at = pg_catalog.now(), cancelled_by = p_actor_id, updated_by = p_actor_id
  where clinic_id = p_clinic_id and id = p_id returning * into v_new;
  insert into public.gestao_administrativa_auditoria (
    clinic_id, actor_id, entity, entity_id, action, operation_id, request_id, details
  ) values (
    p_clinic_id, p_actor_id, 'maintenance', p_id, 'cancel', p_operation_id, p_request_id,
    pg_catalog.jsonb_build_object(
      'previous_status', v_old.status, 'new_status', 'cancelada',
      'maintenance_kind', v_old.maintenance_kind,
      'previous_version', v_old.version, 'new_version', v_new.version,
      'reason_present', true, 'source', 'gestao_edge'
    )
  );
  return pg_catalog.jsonb_build_object('id', p_id, 'version', v_new.version);
end;
$function$;

-- ---------------------------------------------------------------------------
-- Privilégio mínimo: sem políticas para clientes; somente service_role.
-- ---------------------------------------------------------------------------

alter table public.gestao_fechamentos_mensais enable row level security;
alter table public.gestao_fechamento_reaberturas enable row level security;
alter table public.gestao_equipamentos enable row level security;
alter table public.gestao_equipamento_manutencoes enable row level security;
alter table public.gestao_administrativa_auditoria enable row level security;
alter table public.gestao_fontes_catalogo enable row level security;
alter table public.gestao_metricas_catalogo enable row level security;
alter table public.gestao_backup_restauracao_evidencias enable row level security;
alter table public.gestao_contas_caixa enable row level security;
alter table public.gestao_liquidacoes_financeiras enable row level security;
alter table public.gestao_conciliacoes_financeiras enable row level security;

revoke all on table public.gestao_fechamentos_mensais
  from public, anon, authenticated, service_role;
revoke all on table public.gestao_fechamento_reaberturas
  from public, anon, authenticated, service_role;
revoke all on table public.gestao_equipamentos
  from public, anon, authenticated, service_role;
revoke all on table public.gestao_equipamento_manutencoes
  from public, anon, authenticated, service_role;
revoke all on table public.gestao_administrativa_auditoria
  from public, anon, authenticated, service_role;
revoke all on table public.gestao_fontes_catalogo
  from public, anon, authenticated, service_role;
revoke all on table public.gestao_metricas_catalogo
  from public, anon, authenticated, service_role;
revoke all on table public.gestao_backup_restauracao_evidencias
  from public, anon, authenticated, service_role;
revoke all on table public.gestao_contas_caixa
  from public, anon, authenticated, service_role;
revoke all on table public.gestao_liquidacoes_financeiras
  from public, anon, authenticated, service_role;
revoke all on table public.gestao_conciliacoes_financeiras
  from public, anon, authenticated, service_role;

revoke all on table public.gestao_contas_financeiras
  from public, anon, authenticated, service_role;
revoke all on table public.gestao_fluxo_caixa_diario
  from public, anon, authenticated, service_role;
revoke all on table public.gestao_fechamentos_mensais_resumo
  from public, anon, authenticated, service_role;
revoke all on table public.gestao_alertas_equipamentos
  from public, anon, authenticated, service_role;
revoke all on table public.gestao_conciliacoes_atuais
  from public, anon, authenticated, service_role;
revoke all on table public.gestao_contas_caixa_resumo
  from public, anon, authenticated, service_role;
revoke all on table public.gestao_pagamentos_liquidacao_resumo
  from public, anon, authenticated, service_role;

grant select, insert on table public.gestao_fechamentos_mensais to service_role;
grant select, insert on table public.gestao_fechamento_reaberturas to service_role;
grant select, insert, update on table public.gestao_equipamentos to service_role;
grant select, insert, update on table public.gestao_equipamento_manutencoes to service_role;
grant select, insert on table public.gestao_administrativa_auditoria to service_role;
grant select on table public.gestao_fontes_catalogo to service_role;
grant select on table public.gestao_metricas_catalogo to service_role;
grant select, insert on table public.gestao_backup_restauracao_evidencias to service_role;
grant select, insert, update on table public.gestao_contas_caixa to service_role;
grant select, insert on table public.gestao_liquidacoes_financeiras to service_role;
grant select, insert on table public.gestao_conciliacoes_financeiras to service_role;

grant select on table public.gestao_contas_financeiras to service_role;
grant select on table public.gestao_fluxo_caixa_diario to service_role;
grant select on table public.gestao_fechamentos_mensais_resumo to service_role;
grant select on table public.gestao_alertas_equipamentos to service_role;
grant select on table public.gestao_conciliacoes_atuais to service_role;
grant select on table public.gestao_contas_caixa_resumo to service_role;
grant select on table public.gestao_pagamentos_liquidacao_resumo to service_role;

do $grant_functions$
declare
  fn record;
begin
  for fn in
    select proc.oid::pg_catalog.regprocedure as signature
    from pg_catalog.pg_proc proc
    join pg_catalog.pg_namespace namespace on namespace.oid = proc.pronamespace
    where namespace.nspname = 'public' and proc.proname like 'gestao\_%' escape '\'
  loop
    execute pg_catalog.format(
      'revoke all on function %s from public, anon, authenticated, service_role',
      fn.signature
    );
    execute pg_catalog.format('grant execute on function %s to service_role', fn.signature);
  end loop;
end;
$grant_functions$;

do $grant_sequences$
declare
  seq record;
begin
  for seq in
    select sequence.oid::pg_catalog.regclass as signature
    from pg_catalog.pg_class sequence
    join pg_catalog.pg_namespace namespace on namespace.oid = sequence.relnamespace
    where namespace.nspname = 'public'
      and sequence.relkind = 'S'
      and sequence.relname like 'gestao\_%' escape '\'
  loop
    execute pg_catalog.format(
      'revoke all on sequence %s from public, anon, authenticated, service_role',
      seq.signature
    );
    execute pg_catalog.format('grant usage, select on sequence %s to service_role', seq.signature);
  end loop;
end;
$grant_sequences$;

comment on table public.gestao_fechamentos_mensais is
  'Snapshots mensais imutáveis; reabertura é evento separado e uma nova versão é criada no fechamento seguinte.';
comment on table public.gestao_contas_caixa is
  'Contas operacionais sem credenciais ou identificador bancário completo; apenas últimos quatro opcionais.';
comment on table public.gestao_liquidacoes_financeiras is
  'Eventos append-only de liquidação/estorno com bruto, taxa, líquido, conta e data.';
comment on table public.gestao_conciliacoes_financeiras is
  'Conciliações versionadas e imutáveis por conta/período; diferença nunca é apagada.';
comment on table public.gestao_backup_restauracao_evidencias is
  'Evidências informadas e append-only; a existência da linha não executa nem valida backup automaticamente.';
comment on view public.gestao_contas_financeiras is
  'Contas a pagar/receber derivadas dos lançamentos e parcelas, sem dados identificáveis.';
comment on view public.gestao_fluxo_caixa_diario is
  'Movimento líquido registrado por dia; não equivale a lucro nem saldo bancário conciliado.';

commit;

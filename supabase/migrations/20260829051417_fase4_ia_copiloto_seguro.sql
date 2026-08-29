-- Fase 4: copiloto seguro, agregado e sem automacao de dominio.
-- O modelo recebe exclusivamente `modelo_agregado`; `painel_privado` nunca sai
-- do Supabase e existe apenas para a navegacao consciente do owner.
begin;

create schema if not exists private;

create or replace function private.ia_assert_owner(
  p_clinic_id uuid,
  p_actor_id uuid
)
returns void
language plpgsql
security definer
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
    raise exception 'ia_owner_required' using errcode = '42501';
  end if;
end;
$function$;

create or replace function private.ia_suppress_count(p_value bigint)
returns jsonb
language sql
immutable
set search_path = ''
as $function$
  select case
    when coalesce(p_value, 0) between 1 and 4
      then pg_catalog.jsonb_build_object('valor', null, 'suprimido', true)
    else pg_catalog.jsonb_build_object('valor', coalesce(p_value, 0), 'suprimido', false)
  end;
$function$;

create or replace function private.ia_suppress_metric(
  p_cell_count bigint,
  p_value numeric
)
returns jsonb
language sql
immutable
set search_path = ''
as $function$
  select case
    when coalesce(p_cell_count, 0) between 1 and 4
      then pg_catalog.jsonb_build_object('valor', null, 'suprimido', true)
    else pg_catalog.jsonb_build_object('valor', p_value, 'suprimido', false)
  end;
$function$;

-- O replay pode guardar somente a resposta estruturada e saneada. Chaves que
-- poderiam carregar prompt, credencial, identificador pessoal ou conteudo
-- clinico sao recusadas em qualquer profundidade. Strings tambem recusam os
-- formatos pessoais mais comuns e URLs, inclusive URLs assinadas.
create or replace function private.ia_replay_is_safe(p_value jsonb)
returns boolean
language sql
immutable
strict
set search_path = ''
as $function$
  with recursive nodes(value) as (
    select p_value
    union all
    select child.value
    from nodes node
    cross join lateral (
      select object_item.value
      from pg_catalog.jsonb_each(
        case when pg_catalog.jsonb_typeof(node.value) = 'object'
          then node.value else '{}'::jsonb end
      ) object_item
      union all
      select array_item.value
      from pg_catalog.jsonb_array_elements(
        case when pg_catalog.jsonb_typeof(node.value) = 'array'
          then node.value else '[]'::jsonb end
      ) array_item
    ) child
  )
  select pg_catalog.jsonb_typeof(p_value) = 'object'
    -- Mede o payload serializado, nao o armazenamento JSONB possivelmente
    -- comprimido/TOAST, para o teto de replay ser realmente 32 KiB.
    and pg_catalog.octet_length(p_value::text) <= 32768
    and p_value::text !~* '"(prompt|messages?|input|raw(_[a-z0-9_]+)?|nome|name|cpf|telefone|phone|email|birth(_date)?|nascimento|patient(_id)?|paciente(_id)?|lead(_id)?|target_id|clinical|clinico|anamnes(e|is)?|diagnostico|diagnosis|photo|foto|signature|assinatura|documento|tcle|notes?|notas?|token|password|senha|url)"[[:space:]]*:'
    and not exists (
      select 1
      from nodes
      where pg_catalog.jsonb_typeof(nodes.value) = 'string'
        and (
          pg_catalog.length(nodes.value #>> '{}') > 4000
          or (nodes.value #>> '{}') ~* '[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+'
          or (nodes.value #>> '{}') ~ '(^|[^0-9])[0-9]{3}[.-]?[0-9]{3}[.-]?[0-9]{3}-?[0-9]{2}([^0-9]|$)'
          or (nodes.value #>> '{}') ~ '(^|[^0-9])(\+?55[[:space:].()-]*)?[1-9][0-9][[:space:].()-]*9?[0-9]{4}[[:space:].-]*[0-9]{4}([^0-9]|$)'
          or (nodes.value #>> '{}') ~* 'https?://'
          or (nodes.value #>> '{}') ~* '(^|[^a-z0-9])(sk-|eyj[a-z0-9_-]*\.)'
        )
    );
$function$;

create table public.ia_operations (
  id bigint generated always as identity primary key,
  clinic_id uuid not null references public.clinics(id) on delete restrict,
  idempotency_key uuid not null,
  event_type text not null check (event_type in ('started', 'completed', 'failed')),
  use_case text not null check (
    use_case in ('resumo', 'next_best_actions', 'previsao', 'rascunho_marketing')
  ),
  actor_id uuid not null,
  request_id uuid not null,
  fingerprint text not null check (fingerprint ~ '^[a-f0-9]{64}$'),
  prompt_version text not null check (prompt_version ~ '^[A-Za-z0-9._:-]{2,80}$'),
  context_hash text not null check (context_hash ~ '^[a-f0-9]{64}$'),
  model_snapshot text check (
    model_snapshot is null or model_snapshot ~ '^[A-Za-z0-9._:-]{2,120}$'
  ),
  replay_response jsonb check (
    replay_response is null or private.ia_replay_is_safe(replay_response)
  ),
  error_code text check (
    error_code is null or error_code ~ '^[a-z][a-z0-9_.:-]{1,79}$'
  ),
  input_tokens integer not null default 0 check (input_tokens between 0 and 1000000),
  output_tokens integer not null default 0 check (output_tokens between 0 and 1000000),
  latency_ms integer check (latency_ms is null or latency_ms between 0 and 120000),
  created_at timestamptz not null default pg_catalog.now(),
  constraint ia_operations_actor_fk foreign key (clinic_id, actor_id)
    references public.clinic_members(clinic_id, user_id) on delete restrict,
  constraint ia_operations_event_unique unique (clinic_id, idempotency_key, event_type),
  constraint ia_operations_request_event_unique unique (clinic_id, request_id, event_type),
  constraint ia_operations_shape_check check (
    (
      event_type = 'started' and model_snapshot is null and replay_response is null
      and error_code is null and input_tokens = 0 and output_tokens = 0 and latency_ms is null
    ) or (
      event_type = 'completed' and model_snapshot is not null and replay_response is not null
      and error_code is null and latency_ms is not null
    ) or (
      event_type = 'failed' and model_snapshot is null and replay_response is null
      and error_code is not null and input_tokens = 0 and output_tokens = 0 and latency_ms is not null
    )
  )
);

create unique index ia_operations_one_terminal_idx
  on public.ia_operations(clinic_id, idempotency_key)
  where event_type in ('completed', 'failed');
create index ia_operations_timeline_idx
  on public.ia_operations(clinic_id, created_at desc, id desc);
create index ia_operations_actor_idx
  on public.ia_operations(actor_id, created_at desc);
create index ia_operations_status_idx
  on public.ia_operations(clinic_id, event_type, use_case, created_at desc);

create table public.ia_feedback (
  id uuid not null,
  clinic_id uuid not null references public.clinics(id) on delete restrict,
  operation_idempotency_key uuid not null,
  actor_id uuid not null,
  request_id uuid not null,
  feedback text not null check (feedback in ('aceitar', 'descartar', 'util', 'nao_util')),
  created_at timestamptz not null default pg_catalog.now(),
  primary key (clinic_id, id),
  constraint ia_feedback_actor_fk foreign key (clinic_id, actor_id)
    references public.clinic_members(clinic_id, user_id) on delete restrict,
  constraint ia_feedback_operation_unique unique (clinic_id, operation_idempotency_key),
  constraint ia_feedback_request_unique unique (clinic_id, request_id)
);

create index ia_feedback_timeline_idx
  on public.ia_feedback(clinic_id, created_at desc, id);
create index ia_feedback_actor_idx
  on public.ia_feedback(actor_id, created_at desc);

create table private.ia_rate_limits (
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  actor_id uuid not null,
  use_case text not null check (
    use_case in ('resumo', 'next_best_actions', 'previsao', 'rascunho_marketing')
  ),
  window_kind text not null check (window_kind in ('minute', 'hour', 'day')),
  bucket_start timestamptz not null,
  request_count integer not null default 0 check (request_count between 0 and 1000000),
  updated_at timestamptz not null default pg_catalog.now(),
  primary key (clinic_id, actor_id, use_case, window_kind, bucket_start),
  constraint ia_rate_limits_actor_fk foreign key (clinic_id, actor_id)
    references public.clinic_members(clinic_id, user_id) on delete cascade
);

create index ia_rate_limits_cleanup_idx
  on private.ia_rate_limits(bucket_start);

create or replace function private.ia_block_mutation()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  raise exception 'ia_append_only' using errcode = '42501';
end;
$function$;

create trigger ia_operations_append_only
before update or delete on public.ia_operations
for each row execute function private.ia_block_mutation();

create trigger ia_feedback_append_only
before update or delete on public.ia_feedback
for each row execute function private.ia_block_mutation();

create or replace function private.ia_consume_rate_limit(
  p_clinic_id uuid,
  p_actor_id uuid,
  p_use_case text
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_window_kind text;
  v_limit integer;
  v_bucket timestamptz;
  v_count integer;
begin
  delete from private.ia_rate_limits
  where bucket_start < v_now - interval '2 days';

  for v_window_kind, v_limit in
    select setting.window_kind, setting.request_limit
    from (values
      ('minute'::text, 5),
      ('hour'::text, 30),
      ('day'::text, 100)
    ) setting(window_kind, request_limit)
  loop
    v_bucket := case v_window_kind
      when 'minute' then pg_catalog.date_trunc('minute', v_now)
      when 'hour' then pg_catalog.date_trunc('hour', v_now)
      else pg_catalog.date_trunc('day', v_now at time zone 'America/Sao_Paulo')
        at time zone 'America/Sao_Paulo'
    end;

    insert into private.ia_rate_limits(
      clinic_id, actor_id, use_case, window_kind, bucket_start,
      request_count, updated_at
    ) values (
      p_clinic_id, p_actor_id, p_use_case, v_window_kind, v_bucket, 1, v_now
    )
    on conflict (clinic_id, actor_id, use_case, window_kind, bucket_start)
    do update set
      request_count = private.ia_rate_limits.request_count + 1,
      updated_at = excluded.updated_at
    returning request_count into v_count;

    if v_count > v_limit then
      raise exception 'ia_rate_limited_%', v_window_kind using errcode = 'P0001';
    end if;
  end loop;
end;
$function$;

create or replace function public.ia_contexto_agregado(
  p_clinic_id uuid,
  p_actor_id uuid,
  p_start date,
  p_end date,
  p_focus text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_today date := (pg_catalog.now() at time zone 'America/Sao_Paulo')::date;
  v_focus text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_focus, '')));
  v_leads_no_response bigint;
  v_leads_overdue bigint;
  v_returns_overdue bigint;
  v_installments_overdue bigint;
  v_installments_balance numeric;
  v_installments_contributors bigint;
  v_stock_negative bigint;
  v_stock_zero bigint;
  v_campaigns_expired bigint;
  v_private_actions jsonb;
  v_financial jsonb;
  v_financial_safe jsonb := '{}'::jsonb;
  v_fin_received_count bigint := 0;
  v_fin_paid_count bigint := 0;
  v_fin_receivable_count bigint := 0;
  v_fin_payable_count bigint := 0;
  v_fin_billed_count bigint := 0;
  v_fin_incurred_count bigint := 0;
  v_fin_cash_count bigint := 0;
  v_marketing jsonb;
  v_marketing_safe jsonb := '{}'::jsonb;
  v_marketing_investment_count bigint := 0;
  v_marketing_revenue_count bigint := 0;
  v_marketing_cac_safe_count bigint := 0;
  v_marketing_roi_safe_count bigint := 0;
  v_followups jsonb;
  v_cash_series jsonb := '[]'::jsonb;
  v_forecast_status text := 'dados_insuficientes';
  v_forecast_value numeric;
  v_forecast_points integer := 0;
  v_forecast_contributors bigint := 0;
  v_marketing_leads bigint := 0;
  v_marketing_conversions bigint := 0;
  v_from timestamptz;
  v_until timestamptz;
  v_model jsonb;
begin
  if v_focus not in ('geral', 'crm', 'financeiro', 'agenda', 'marketing') then
    raise exception 'ia_focus_invalid' using errcode = '22023';
  end if;
  perform private.ia_assert_owner(p_clinic_id, p_actor_id);
  if p_start is null or p_end is null or p_end < p_start
     or p_end > v_today or p_end - p_start > 365 then
    raise exception 'ia_period_invalid' using errcode = '22023';
  end if;

  select pg_catalog.count(*)::bigint into v_leads_no_response
  from public.crm_leads lead
  where lead.clinic_id = p_clinic_id and lead.record_status = 'active'
    and lead.first_response_at is null;

  select pg_catalog.count(*)::bigint into v_leads_overdue
  from public.crm_leads lead
  where lead.clinic_id = p_clinic_id and lead.record_status = 'active'
    and lead.next_action_at < pg_catalog.now();

  select pg_catalog.count(*)::bigint into v_returns_overdue
  from public.retorno_fila queue
  where queue.clinic_id = p_clinic_id
    and queue.status not in ('concluido', 'cancelado', 'bloqueado')
    and queue.next_action_at < pg_catalog.now();

  select pg_catalog.count(*)::bigint,
    coalesce(pg_catalog.sum(installment.balance), 0),
    pg_catalog.count(distinct coalesce(entry.patient_id::text, 'unknown'))::bigint
    into v_installments_overdue, v_installments_balance,
      v_installments_contributors
  from public.financeiro_parcelas_resumo installment
  join public.financeiro_lancamentos entry
    on entry.clinic_id = installment.clinic_id and entry.id = installment.entry_id
  where installment.clinic_id = p_clinic_id
    and installment.state = 'ativa' and installment.calculated_status = 'vencida'
    and entry.state = 'ativo';

  select
    pg_catalog.count(*) filter (where stock.quantity_balance < 0)::bigint,
    pg_catalog.count(*) filter (where stock.quantity_balance = 0)::bigint
    into v_stock_negative, v_stock_zero
  from public.financeiro_estoque_produto_saldos stock
  join public.financeiro_produtos product
    on product.clinic_id = stock.clinic_id and product.id = stock.product_id
  where stock.clinic_id = p_clinic_id and product.active
    and product.archived_at is null and product.stock_control;

  select pg_catalog.count(*)::bigint into v_campaigns_expired
  from public.marketing_campaigns campaign
  where campaign.clinic_id = p_clinic_id and campaign.status = 'ativa'
    and campaign.ends_on is not null and campaign.ends_on < v_today;

  with candidates as (
    select 10 as priority, 'crm_primeira_resposta'::text as action_code,
      'lead'::text as target_kind, lead.id as target_id,
      pg_catalog.left(pg_catalog.btrim(lead.full_name), 120) as safe_name,
      lead.created_at as due_at, null::numeric as metric,
      'first_response_missing'::text as reason_code
    from public.crm_leads lead
    where v_focus in ('geral', 'crm') and lead.clinic_id = p_clinic_id
      and lead.record_status = 'active' and lead.first_response_at is null
    union all
    select 20, 'crm_proxima_acao', 'lead', lead.id,
      pg_catalog.left(pg_catalog.btrim(lead.full_name), 120), lead.next_action_at,
      null::numeric, 'next_action_overdue'
    from public.crm_leads lead
    where v_focus in ('geral', 'crm') and lead.clinic_id = p_clinic_id
      and lead.record_status = 'active' and lead.next_action_at < pg_catalog.now()
    union all
    select 30, 'retorno_revisar', 'retorno', queue.id,
      pg_catalog.left(pg_catalog.btrim(patient.full_name), 120), queue.next_action_at,
      queue.attempt_count::numeric, 'return_overdue'
    from public.retorno_fila queue
    join public.patients patient
      on patient.clinic_id = queue.clinic_id and patient.id = queue.patient_id
    where v_focus in ('geral', 'retornos') and queue.clinic_id = p_clinic_id
      and queue.status not in ('concluido', 'cancelado', 'bloqueado')
      and queue.next_action_at < pg_catalog.now()
    union all
    select 40, 'financeiro_parcela_revisar', 'parcela', installment.id,
      pg_catalog.left(pg_catalog.btrim(patient.full_name), 120),
      installment.due_date::timestamp at time zone 'America/Sao_Paulo',
      installment.balance, 'installment_overdue'
    from public.financeiro_parcelas_resumo installment
    join public.financeiro_lancamentos entry
      on entry.clinic_id = installment.clinic_id and entry.id = installment.entry_id
    left join public.patients patient
      on patient.clinic_id = entry.clinic_id and patient.id = entry.patient_id
    where v_focus in ('geral', 'financeiro') and installment.clinic_id = p_clinic_id
      and installment.state = 'ativa' and installment.calculated_status = 'vencida'
      and entry.state = 'ativo'
    union all
    select case when stock.quantity_balance < 0 then 5 else 50 end,
      'estoque_saldo_revisar', 'produto', product.id,
      pg_catalog.left(pg_catalog.btrim(product.name), 120), null::timestamptz,
      stock.quantity_balance, case when stock.quantity_balance < 0
        then 'stock_negative' else 'stock_zero' end
    from public.financeiro_estoque_produto_saldos stock
    join public.financeiro_produtos product
      on product.clinic_id = stock.clinic_id and product.id = stock.product_id
    where v_focus in ('geral', 'estoque') and stock.clinic_id = p_clinic_id
      and product.active and product.archived_at is null and product.stock_control
      and stock.quantity_balance <= 0
    union all
    select 60, 'marketing_campanha_revisar', 'campanha', campaign.id,
      pg_catalog.left(pg_catalog.btrim(campaign.name), 120),
      campaign.ends_on::timestamp at time zone 'America/Sao_Paulo',
      null::numeric, 'active_campaign_expired'
    from public.marketing_campaigns campaign
    where v_focus in ('geral', 'marketing') and campaign.clinic_id = p_clinic_id
      and campaign.status = 'ativa' and campaign.ends_on is not null
      and campaign.ends_on < v_today
  ), limited as (
    select * from candidates
    order by priority, due_at nulls last, target_id
    limit 3
  )
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_strip_nulls(
    pg_catalog.jsonb_build_object(
      'id', limited.target_id,
      'categoria', case limited.action_code
        when 'crm_primeira_resposta' then 'comercial'
        when 'crm_proxima_acao' then 'comercial'
        when 'financeiro_parcela_revisar' then 'financeiro'
        when 'marketing_campanha_revisar' then 'marketing'
        else 'operacional'
      end,
      'titulo', case limited.action_code
        when 'crm_primeira_resposta' then 'Responder lead sem primeira resposta'
        when 'crm_proxima_acao' then 'Revisar proxima acao vencida do lead'
        when 'retorno_revisar' then 'Revisar retorno vencido'
        when 'financeiro_parcela_revisar' then 'Revisar parcela vencida'
        when 'estoque_saldo_revisar' then 'Revisar saldo de estoque'
        else 'Revisar campanha ativa vencida'
      end,
      'motivo', case limited.reason_code
        when 'first_response_missing' then 'Primeira resposta ainda nao registrada.'
        when 'next_action_overdue' then 'Proxima acao ultrapassou o prazo.'
        when 'return_overdue' then 'Retorno manual ultrapassou o prazo.'
        when 'installment_overdue' then 'Parcela ativa esta vencida.'
        when 'stock_negative' then 'Saldo de estoque esta negativo.'
        when 'stock_zero' then 'Saldo de estoque esta zerado.'
        else 'Campanha ativa ultrapassou a data final.'
      end,
      'prazo', limited.due_at,
      'rota', case limited.target_kind
        when 'lead' then 'crm'
        when 'retorno' then 'acompanhamentos'
        when 'parcela' then 'receitas'
        when 'produto' then 'estoque'
        else 'marketing'
      end,
      'target_kind', limited.target_kind,
      'target_id', limited.target_id,
      'nome_exibicao', limited.safe_name,
      'prioridade', case
        when limited.priority <= 10 then 'alta'
        when limited.priority <= 40 then 'media'
        else 'baixa'
      end,
      'ordem', limited.priority,
      'atualizado_em', pg_catalog.now(),
      'fontes', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'titulo', case limited.target_kind
          when 'lead' then 'CRM'
          when 'retorno' then 'Fila de retornos'
          when 'parcela' then 'Financeiro'
          when 'produto' then 'Estoque'
          else 'Marketing'
        end,
        'atualizado_em', pg_catalog.now(),
        'rota', case limited.target_kind
          when 'lead' then 'crm'
          when 'retorno' then 'acompanhamentos'
          when 'parcela' then 'receitas'
          when 'produto' then 'estoque'
          else 'marketing'
        end
      )),
      'codigo_acao', limited.action_code,
      'tipo_alvo', limited.target_kind,
      'alvo_id', limited.target_id,
      'nome_seguro', limited.safe_name,
      'vencido_em', limited.due_at,
      'metrica', limited.metric,
      'codigo_motivo', limited.reason_code
    )
  ) order by limited.priority, limited.due_at nulls last, limited.target_id), '[]'::jsonb)
  into v_private_actions
  from limited;

  if v_focus in ('geral', 'financeiro') then
    v_financial := public.financeiro_resumo(p_clinic_id, p_start, p_end);

    -- A unidade de anonimato e a parte distinta, nao o lancamento. Vinculos
    -- ausentes formam um unico contribuinte desconhecido e nunca inflacionam k.
    select
      pg_catalog.count(distinct case
        when entry.entry_type = 'receita' and entry.paid_amount <> 0
          then coalesce(entry.patient_id::text, 'unknown')
      end)::bigint,
      pg_catalog.count(distinct case
        when entry.entry_type = 'despesa' and entry.paid_amount <> 0
          then coalesce(entry.supplier_id::text, 'unknown')
      end)::bigint,
      pg_catalog.count(distinct case
        when entry.entry_type = 'receita' and entry.balance <> 0
          then coalesce(entry.patient_id::text, 'unknown')
      end)::bigint,
      pg_catalog.count(distinct case
        when entry.entry_type = 'despesa' and entry.balance <> 0
          then coalesce(entry.supplier_id::text, 'unknown')
      end)::bigint,
      pg_catalog.count(distinct case
        when entry.entry_type = 'receita'
          then coalesce(entry.patient_id::text, 'unknown')
      end)::bigint,
      pg_catalog.count(distinct case
        when entry.entry_type = 'despesa'
          then coalesce(entry.supplier_id::text, 'unknown')
      end)::bigint
    into v_fin_received_count, v_fin_paid_count,
      v_fin_receivable_count, v_fin_payable_count,
      v_fin_billed_count, v_fin_incurred_count
    from public.financeiro_lancamentos_resumo entry
    where entry.clinic_id = p_clinic_id
      and entry.state = 'ativo'
      and entry.competence_date between p_start and p_end;

    v_fin_cash_count := v_fin_received_count + v_fin_paid_count;
    v_financial_safe := pg_catalog.jsonb_build_object(
      'receita_recebida', private.ia_suppress_metric(
        v_fin_received_count, (v_financial ->> 'receita_recebida')::numeric
      ),
      'despesa_paga', private.ia_suppress_metric(
        v_fin_paid_count, (v_financial ->> 'despesa_paga')::numeric
      ),
      'fluxo_liquido', private.ia_suppress_metric(
        v_fin_cash_count, (v_financial ->> 'fluxo_liquido')::numeric
      ),
      'contas_receber', private.ia_suppress_metric(
        v_fin_receivable_count, (v_financial ->> 'contas_receber')::numeric
      ),
      'contas_pagar', private.ia_suppress_metric(
        v_fin_payable_count, (v_financial ->> 'contas_pagar')::numeric
      ),
      'receita_faturada', private.ia_suppress_metric(
        v_fin_billed_count, (v_financial ->> 'receita_faturada')::numeric
      ),
      'despesa_incorrida', private.ia_suppress_metric(
        v_fin_incurred_count, (v_financial ->> 'despesa_incorrida')::numeric
      )
    );

    select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(series_row)
      order by series_row.mes), '[]'::jsonb)
    into v_cash_series
    from (
      select flow.month as mes,
        private.ia_suppress_metric(
          entry_count.billed_count, flow.billed_revenue
        ) as receita_faturada,
        private.ia_suppress_count(entry_count.billed_count)
          as contribuintes_receita_faturada,
        private.ia_suppress_metric(
          cash_count.received_count, flow.received_revenue
        ) as receita_recebida,
        private.ia_suppress_count(cash_count.received_count)
          as contribuintes_receita_recebida,
        private.ia_suppress_metric(
          entry_count.incurred_count, flow.incurred_expense
        ) as despesa_incorrida,
        private.ia_suppress_count(entry_count.incurred_count)
          as contribuintes_despesa_incorrida,
        private.ia_suppress_metric(
          cash_count.paid_count, flow.paid_expense
        ) as despesa_paga,
        private.ia_suppress_count(cash_count.paid_count)
          as contribuintes_despesa_paga,
        private.ia_suppress_metric(
          cash_count.received_count + cash_count.paid_count,
          flow.net_cash_flow
        ) as fluxo_liquido,
        private.ia_suppress_count(
          cash_count.received_count + cash_count.paid_count
        ) as contribuintes_fluxo
      from public.financeiro_fluxo_mensal flow
      cross join lateral (
        select
          pg_catalog.count(distinct case
            when entry.entry_type = 'receita' and entry.state = 'ativo'
              then coalesce(entry.patient_id::text, 'unknown')
          end)::bigint as billed_count,
          pg_catalog.count(distinct case
            when entry.entry_type = 'despesa' and entry.state = 'ativo'
              then coalesce(entry.supplier_id::text, 'unknown')
          end)::bigint as incurred_count
        from public.financeiro_lancamentos entry
        where entry.clinic_id = p_clinic_id
          and pg_catalog.date_trunc('month', entry.competence_date)::date = flow.month
      ) entry_count
      cross join lateral (
        select
          pg_catalog.count(*) filter (
            where party_cash.entry_type = 'receita' and party_cash.net <> 0
          )::bigint as received_count,
          pg_catalog.count(*) filter (
            where party_cash.entry_type = 'despesa' and party_cash.net <> 0
          )::bigint as paid_count
        from (
          select entry.entry_type,
            case when entry.entry_type = 'receita'
              then coalesce(entry.patient_id::text, 'unknown')
              else coalesce(entry.supplier_id::text, 'unknown')
            end as party_key,
            pg_catalog.sum(case when payment.movement_type = 'pagamento'
              then payment.amount else -payment.amount end) as net
          from public.financeiro_pagamentos payment
          join public.financeiro_lancamentos entry
            on entry.clinic_id = payment.clinic_id and entry.id = payment.entry_id
          where payment.clinic_id = p_clinic_id
            and pg_catalog.date_trunc(
              'month', payment.paid_at at time zone 'America/Sao_Paulo'
            )::date = flow.month
          group by entry.entry_type,
            case when entry.entry_type = 'receita'
              then coalesce(entry.patient_id::text, 'unknown')
              else coalesce(entry.supplier_id::text, 'unknown')
            end
        ) party_cash
      ) cash_count
      where flow.clinic_id = p_clinic_id
        and flow.month between pg_catalog.date_trunc('month', p_start)::date
          and pg_catalog.date_trunc('month', p_end)::date
      order by flow.month
    ) series_row;

    select pg_catalog.count(*)::integer,
      coalesce(pg_catalog.sum(
        (point.value #>> '{contribuintes_fluxo,valor}')::bigint
      ), 0)::bigint,
      pg_catalog.round(pg_catalog.avg(
        (point.value #>> '{fluxo_liquido,valor}')::numeric
      ), 2)
    into v_forecast_points, v_forecast_contributors, v_forecast_value
    from pg_catalog.jsonb_array_elements(v_cash_series) point(value)
    where coalesce(
        (point.value #>> '{fluxo_liquido,suprimido}')::boolean, true
      ) = false
      and coalesce(
        (point.value #>> '{contribuintes_fluxo,valor}')::bigint, 0
      ) >= 5
      and point.value #>> '{fluxo_liquido,valor}' is not null;

    if v_forecast_points >= 3 then
      v_forecast_status := 'estimativa';
    else
      v_forecast_value := null;
      v_forecast_status := 'dados_insuficientes';
    end if;
  end if;

  if v_focus in ('geral', 'marketing') then
    v_marketing := public.marketing_painel(p_clinic_id, p_actor_id, p_start, p_end);
    v_marketing_leads := coalesce((v_marketing #>> '{totais,leads}')::bigint, 0);
    v_marketing_conversions := coalesce(
      (v_marketing #>> '{totais,conversoes_pacientes}')::bigint, 0
    );
    v_from := p_start::timestamp at time zone 'America/Sao_Paulo';
    v_until := (p_end + 1)::timestamp at time zone 'America/Sao_Paulo';

    with paid as (
      select payment.entry_id,
        pg_catalog.sum(case when payment.movement_type = 'pagamento'
          then payment.amount else -payment.amount end) as net
      from public.financeiro_pagamentos payment
      where payment.clinic_id = p_clinic_id
        and payment.paid_at >= v_from and payment.paid_at < v_until
      group by payment.entry_id
    ), contributor_money as (
      select link.link_kind,
        case when link.link_kind = 'receita'
          then coalesce(link.patient_id::text, entry.patient_id::text, 'unknown')
          else coalesce(entry.supplier_id::text, 'unknown')
        end as party_key,
        pg_catalog.sum(paid.net) as net
      from public.marketing_campaign_financial_links link
      join public.financeiro_lancamentos entry
        on entry.clinic_id = link.clinic_id and entry.id = link.entry_id
      join paid on paid.entry_id = entry.id
      where link.clinic_id = p_clinic_id
        and link.state = 'ativo' and entry.state = 'ativo'
      group by link.link_kind,
        case when link.link_kind = 'receita'
          then coalesce(link.patient_id::text, entry.patient_id::text, 'unknown')
          else coalesce(entry.supplier_id::text, 'unknown')
        end
    )
    select
      pg_catalog.count(*) filter (
        where contributor_money.link_kind = 'investimento'
          and contributor_money.net <> 0
      )::bigint,
      pg_catalog.count(*) filter (
        where contributor_money.link_kind = 'receita'
          and contributor_money.net <> 0
      )::bigint
    into v_marketing_investment_count, v_marketing_revenue_count
    from contributor_money;

    v_marketing_cac_safe_count := case
      when v_marketing_investment_count between 1 and 4
        or v_marketing_conversions between 1 and 4 then 1
      when v_marketing_conversions >= 5
        and (v_marketing_investment_count = 0
          or v_marketing_investment_count >= 5)
        then v_marketing_investment_count + v_marketing_conversions
      else 0
    end;
    v_marketing_roi_safe_count := case
      when v_marketing_investment_count between 1 and 4
        or v_marketing_revenue_count between 1 and 4 then 1
      when v_marketing_investment_count >= 5
        and (v_marketing_revenue_count = 0
          or v_marketing_revenue_count >= 5)
        then v_marketing_investment_count + v_marketing_revenue_count
      else 0
    end;
    v_marketing_safe := pg_catalog.jsonb_build_object(
      'investimento_pago', private.ia_suppress_metric(
        v_marketing_investment_count,
        (v_marketing #>> '{totais,investimento_pago}')::numeric
      ),
      'receita_recebida', private.ia_suppress_metric(
        v_marketing_revenue_count,
        (v_marketing #>> '{totais,receita_recebida}')::numeric
      ),
      'leads', private.ia_suppress_count(v_marketing_leads),
      'conversoes', private.ia_suppress_count(v_marketing_conversions),
      'cac', private.ia_suppress_metric(
        v_marketing_cac_safe_count, (v_marketing #>> '{totais,cac}')::numeric
      ),
      'roi', private.ia_suppress_metric(
        v_marketing_roi_safe_count, (v_marketing #>> '{totais,roi}')::numeric
      ),
      'campanhas_ativas_vencidas', private.ia_suppress_count(v_campaigns_expired)
    );
  end if;

  if v_focus = 'geral' then
    v_followups := public.gestao_relatorio_acompanhamentos_fase2(
      p_clinic_id, p_actor_id, 'owner', 'supabase_auth', 'aal2', p_start, p_end
    );
  end if;

  v_model := pg_catalog.jsonb_build_object(
    'schema_version', 'ia-contexto-v1',
    'restricoes', pg_catalog.jsonb_build_object(
      'sem_pii', true,
      'dados_minimizados', true,
      'somente_agregados', true,
      'sem_midia', true,
      'sem_texto_livre', true,
      'sem_acao_automatica', true
    )
  );

  if v_focus = 'geral' then
    v_model := v_model || pg_catalog.jsonb_build_object(
      'nba', pg_catalog.jsonb_build_object(
        'leads_sem_primeira_resposta', private.ia_suppress_count(v_leads_no_response),
        'leads_com_acao_vencida', private.ia_suppress_count(v_leads_overdue),
        'retornos_vencidos', private.ia_suppress_count(v_returns_overdue),
        'parcelas_vencidas', pg_catalog.jsonb_build_object(
          'quantidade', private.ia_suppress_metric(
            v_installments_contributors, v_installments_overdue::numeric
          ),
          'saldo', private.ia_suppress_metric(
            v_installments_contributors, v_installments_balance
          )
        ),
        'estoque_negativo', private.ia_suppress_count(v_stock_negative),
        'estoque_zerado', private.ia_suppress_count(v_stock_zero),
        'agenda', pg_catalog.jsonb_build_object(
          'disponivel', false, 'codigo_motivo', 'tenant_scope_unavailable'
        )
      ),
      'financeiro', v_financial_safe,
      'marketing', v_marketing_safe,
      'acompanhamentos', pg_catalog.jsonb_build_object(
        'totais', v_followups -> 'totais', 'agregado_somente', true
      ),
      'series', pg_catalog.jsonb_build_object('fluxo_mensal', v_cash_series),
      'previsao', pg_catalog.jsonb_build_object(
        'rotulo', v_forecast_status,
        'valor_estimado', private.ia_suppress_metric(
          v_forecast_contributors, v_forecast_value
        ),
        'horizonte_dias', 30,
        'metodo', 'media_mensal_fluxo_liquido_observado',
        'pontos_observados', private.ia_suppress_count(v_forecast_points::bigint),
        'limitacoes', pg_catalog.jsonb_build_array(
          'estimativa_nao_e_garantia', 'minimo_tres_pontos_seguros'
        )
      )
    );
  elsif v_focus = 'crm' then
    v_model := v_model || pg_catalog.jsonb_build_object(
      'nba', pg_catalog.jsonb_build_object(
        'leads_sem_primeira_resposta', private.ia_suppress_count(v_leads_no_response),
        'leads_com_acao_vencida', private.ia_suppress_count(v_leads_overdue)
      )
    );
  elsif v_focus = 'marketing' then
    v_model := v_model || pg_catalog.jsonb_build_object('marketing', v_marketing_safe);
  elsif v_focus = 'financeiro' then
    v_model := v_model || pg_catalog.jsonb_build_object(
      'financeiro', v_financial_safe || pg_catalog.jsonb_build_object(
        'parcelas_vencidas', pg_catalog.jsonb_build_object(
          'quantidade', private.ia_suppress_metric(
            v_installments_contributors, v_installments_overdue::numeric
          ),
          'saldo', private.ia_suppress_metric(
            v_installments_contributors, v_installments_balance
          )
        )
      ),
      'series', pg_catalog.jsonb_build_object('fluxo_mensal', v_cash_series),
      'previsao', pg_catalog.jsonb_build_object(
        'rotulo', v_forecast_status,
        'valor_estimado', private.ia_suppress_metric(
          v_forecast_contributors, v_forecast_value
        ),
        'horizonte_dias', 30,
        'metodo', 'media_mensal_fluxo_liquido_observado',
        'pontos_observados', private.ia_suppress_count(v_forecast_points::bigint),
        'limitacoes', pg_catalog.jsonb_build_array(
          'estimativa_nao_e_garantia', 'minimo_tres_pontos_seguros'
        )
      )
    );
  else
    v_model := v_model || pg_catalog.jsonb_build_object(
      'agenda', pg_catalog.jsonb_build_object(
        'disponivel', false, 'codigo_motivo', 'tenant_scope_unavailable'
      )
    );
  end if;

  return pg_catalog.jsonb_build_object(
    'periodo', pg_catalog.jsonb_build_object(
      'inicio', p_start, 'fim', p_end, 'fuso', 'America/Sao_Paulo'
    ),
    'foco', v_focus,
    'painel_privado', pg_catalog.jsonb_build_object(
      'somente_owner', true,
      'enviar_ao_modelo', false,
      'atualizado_em', pg_catalog.now(),
      'resumo', 'Ate tres pendencias objetivas para verificacao humana.',
      'acoes', v_private_actions,
      'fontes', pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'titulo', 'Indicadores operacionais da clinica',
          'atualizado_em', pg_catalog.now(),
          'rota', 'gestao'
        )
      ),
      'limitacoes', pg_catalog.jsonb_build_array(
        'Sugestoes deterministicas; confirme os dados antes de agir.',
        'Nenhuma acao de dominio e executada automaticamente.'
      ),
      'previsao', pg_catalog.jsonb_build_object(
        'rotulo', v_forecast_status,
        'estimativa', v_forecast_value,
        'horizonte', '30 dias',
        'confiabilidade', case when v_forecast_status = 'estimativa'
          then 'baixa' else 'dados_insuficientes' end,
        'metodo', 'media_mensal_fluxo_liquido_observado',
        'pontos_observados', v_forecast_points,
        'limitacoes', pg_catalog.jsonb_build_array(
          'Estimativa deterministica; nao e garantia financeira.',
          'Requer ao menos tres meses com movimento observado.'
        )
      ),
      'agenda', pg_catalog.jsonb_build_object(
        'disponivel', false, 'codigo_motivo', 'tenant_scope_unavailable'
      )
    ),
    'modelo_agregado', v_model,
    'restricoes', pg_catalog.jsonb_build_object(
      'painel_privado_nao_enviado_ao_modelo', true,
      'modelo_somente_agregado', true,
      'revisao_humana_obrigatoria', true,
      'nenhuma_acao_automatica', true
    )
  );
end;
$function$;

create or replace function public.ia_operation_begin(
  p_clinic_id uuid,
  p_actor_id uuid,
  p_use_case text,
  p_idempotency_key uuid,
  p_request_id uuid,
  p_fingerprint text,
  p_prompt_version text,
  p_context_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_started public.ia_operations%rowtype;
  v_terminal public.ia_operations%rowtype;
begin
  if p_use_case not in ('resumo', 'next_best_actions', 'previsao', 'rascunho_marketing')
     or p_idempotency_key is null or p_request_id is null
     or p_fingerprint !~ '^[a-f0-9]{64}$'
     or p_prompt_version !~ '^[A-Za-z0-9._:-]{2,80}$'
     or p_context_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'ia_operation_invalid' using errcode = '22023';
  end if;
  perform private.ia_assert_owner(p_clinic_id, p_actor_id);
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_clinic_id::text || ':ia:' || p_idempotency_key::text, 0
  ));

  select operation.* into v_started
  from public.ia_operations operation
  where operation.clinic_id = p_clinic_id
    and operation.idempotency_key = p_idempotency_key
    and operation.event_type = 'started';

  if found then
    if v_started.actor_id <> p_actor_id or v_started.use_case <> p_use_case
       or v_started.fingerprint <> p_fingerprint
       or v_started.prompt_version <> p_prompt_version
       or v_started.context_hash <> p_context_hash then
      raise exception 'ia_idempotency_key_reused' using errcode = '23505';
    end if;
    select operation.* into v_terminal
    from public.ia_operations operation
    where operation.clinic_id = p_clinic_id
      and operation.idempotency_key = p_idempotency_key
      and operation.event_type in ('completed', 'failed')
    order by operation.id desc limit 1;
    if found then
      return pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
        'state', v_terminal.event_type,
        'replay', true,
        'response', v_terminal.replay_response,
        'error_code', v_terminal.error_code
      ));
    end if;
    return pg_catalog.jsonb_build_object('state', 'in_progress', 'replay', true);
  end if;

  perform private.ia_consume_rate_limit(p_clinic_id, p_actor_id, p_use_case);
  insert into public.ia_operations(
    clinic_id, idempotency_key, event_type, use_case, actor_id, request_id,
    fingerprint, prompt_version, context_hash
  ) values (
    p_clinic_id, p_idempotency_key, 'started', p_use_case, p_actor_id,
    p_request_id, p_fingerprint, p_prompt_version, p_context_hash
  );
  return pg_catalog.jsonb_build_object('state', 'started', 'replay', false);
end;
$function$;

create or replace function public.ia_operation_complete(
  p_clinic_id uuid,
  p_actor_id uuid,
  p_idempotency_key uuid,
  p_request_id uuid,
  p_fingerprint text,
  p_model_snapshot text,
  p_response jsonb,
  p_input_tokens integer,
  p_output_tokens integer,
  p_latency_ms integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_started public.ia_operations%rowtype;
  v_terminal public.ia_operations%rowtype;
begin
  if p_idempotency_key is null or p_request_id is null
     or p_fingerprint !~ '^[a-f0-9]{64}$'
     or p_model_snapshot !~ '^[A-Za-z0-9._:-]{2,120}$'
     or p_input_tokens not between 0 and 1000000
     or p_output_tokens not between 0 and 1000000
     or p_latency_ms not between 0 and 120000
     or not private.ia_replay_is_safe(p_response) then
    raise exception 'ia_completion_invalid' using errcode = '22023';
  end if;
  perform private.ia_assert_owner(p_clinic_id, p_actor_id);
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_clinic_id::text || ':ia:' || p_idempotency_key::text, 0
  ));
  select operation.* into v_started
  from public.ia_operations operation
  where operation.clinic_id = p_clinic_id
    and operation.idempotency_key = p_idempotency_key
    and operation.event_type = 'started';
  if not found then raise exception 'ia_operation_not_started' using errcode = 'P0002'; end if;
  if v_started.actor_id <> p_actor_id or v_started.fingerprint <> p_fingerprint then
    raise exception 'ia_operation_conflict' using errcode = '23505';
  end if;
  select operation.* into v_terminal
  from public.ia_operations operation
  where operation.clinic_id = p_clinic_id
    and operation.idempotency_key = p_idempotency_key
    and operation.event_type in ('completed', 'failed')
  order by operation.id desc limit 1;
  if found then
    return pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'state', v_terminal.event_type, 'replay', true,
      'response', v_terminal.replay_response, 'error_code', v_terminal.error_code
    ));
  end if;
  insert into public.ia_operations(
    clinic_id, idempotency_key, event_type, use_case, actor_id, request_id,
    fingerprint, prompt_version, context_hash, model_snapshot,
    replay_response, input_tokens, output_tokens, latency_ms
  ) values (
    p_clinic_id, p_idempotency_key, 'completed', v_started.use_case,
    p_actor_id, p_request_id, p_fingerprint, v_started.prompt_version,
    v_started.context_hash, p_model_snapshot, p_response,
    p_input_tokens, p_output_tokens, p_latency_ms
  );
  return pg_catalog.jsonb_build_object(
    'state', 'completed', 'replay', false, 'response', p_response
  );
end;
$function$;

create or replace function public.ia_operation_fail(
  p_clinic_id uuid,
  p_actor_id uuid,
  p_idempotency_key uuid,
  p_request_id uuid,
  p_fingerprint text,
  p_error_code text,
  p_latency_ms integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_started public.ia_operations%rowtype;
  v_terminal public.ia_operations%rowtype;
begin
  if p_idempotency_key is null or p_request_id is null
     or p_fingerprint !~ '^[a-f0-9]{64}$'
     or p_error_code !~ '^[a-z][a-z0-9_.:-]{1,79}$'
     or p_latency_ms not between 0 and 120000 then
    raise exception 'ia_failure_invalid' using errcode = '22023';
  end if;
  perform private.ia_assert_owner(p_clinic_id, p_actor_id);
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_clinic_id::text || ':ia:' || p_idempotency_key::text, 0
  ));
  select operation.* into v_started
  from public.ia_operations operation
  where operation.clinic_id = p_clinic_id
    and operation.idempotency_key = p_idempotency_key
    and operation.event_type = 'started';
  if not found then raise exception 'ia_operation_not_started' using errcode = 'P0002'; end if;
  if v_started.actor_id <> p_actor_id or v_started.fingerprint <> p_fingerprint then
    raise exception 'ia_operation_conflict' using errcode = '23505';
  end if;
  select operation.* into v_terminal
  from public.ia_operations operation
  where operation.clinic_id = p_clinic_id
    and operation.idempotency_key = p_idempotency_key
    and operation.event_type in ('completed', 'failed')
  order by operation.id desc limit 1;
  if found then
    return pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'state', v_terminal.event_type, 'replay', true,
      'response', v_terminal.replay_response, 'error_code', v_terminal.error_code
    ));
  end if;
  insert into public.ia_operations(
    clinic_id, idempotency_key, event_type, use_case, actor_id, request_id,
    fingerprint, prompt_version, context_hash, error_code, latency_ms
  ) values (
    p_clinic_id, p_idempotency_key, 'failed', v_started.use_case,
    p_actor_id, p_request_id, p_fingerprint, v_started.prompt_version,
    v_started.context_hash, p_error_code, p_latency_ms
  );
  return pg_catalog.jsonb_build_object(
    'state', 'failed', 'replay', false, 'error_code', p_error_code
  );
end;
$function$;

create or replace function public.ia_registrar_feedback(
  p_clinic_id uuid,
  p_actor_id uuid,
  p_operation_idempotency_key uuid,
  p_feedback_id uuid,
  p_request_id uuid,
  p_feedback text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_existing public.ia_feedback%rowtype;
begin
  if p_operation_idempotency_key is null or p_feedback_id is null
     or p_request_id is null
     or p_feedback not in ('aceitar', 'descartar', 'util', 'nao_util') then
    raise exception 'ia_feedback_invalid' using errcode = '22023';
  end if;
  perform private.ia_assert_owner(p_clinic_id, p_actor_id);
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_clinic_id::text || ':ia-feedback:' || p_operation_idempotency_key::text, 0
  ));
  if not exists (
    select 1 from public.ia_operations operation
    where operation.clinic_id = p_clinic_id
      and operation.idempotency_key = p_operation_idempotency_key
      and operation.event_type = 'completed'
  ) then
    raise exception 'ia_completed_operation_required' using errcode = '55000';
  end if;
  select feedback_row.* into v_existing
  from public.ia_feedback feedback_row
  where feedback_row.clinic_id = p_clinic_id
    and feedback_row.operation_idempotency_key = p_operation_idempotency_key;
  if found then
    if v_existing.actor_id <> p_actor_id or v_existing.feedback <> p_feedback then
      raise exception 'ia_feedback_conflict' using errcode = '23505';
    end if;
    return pg_catalog.jsonb_build_object(
      'feedback_id', v_existing.id, 'feedback', v_existing.feedback,
      'idempotent', true
    );
  end if;
  insert into public.ia_feedback(
    id, clinic_id, operation_idempotency_key, actor_id, request_id, feedback
  ) values (
    p_feedback_id, p_clinic_id, p_operation_idempotency_key,
    p_actor_id, p_request_id, p_feedback
  );
  return pg_catalog.jsonb_build_object(
    'feedback_id', p_feedback_id, 'feedback', p_feedback, 'idempotent', false
  );
end;
$function$;

alter table public.ia_operations enable row level security;
alter table public.ia_feedback enable row level security;
alter table private.ia_rate_limits enable row level security;

revoke all on table public.ia_operations
  from public, anon, authenticated, service_role;
revoke all on table public.ia_feedback
  from public, anon, authenticated, service_role;
revoke all on table private.ia_rate_limits
  from public, anon, authenticated, service_role;
revoke all on sequence public.ia_operations_id_seq
  from public, anon, authenticated, service_role;

revoke all on function private.ia_assert_owner(uuid,uuid),
  private.ia_suppress_count(bigint),
  private.ia_suppress_metric(bigint,numeric),
  private.ia_replay_is_safe(jsonb),
  private.ia_block_mutation(),
  private.ia_consume_rate_limit(uuid,uuid,text)
  from public, anon, authenticated, service_role;

revoke all on function public.ia_contexto_agregado(uuid,uuid,date,date,text),
  public.ia_operation_begin(uuid,uuid,text,uuid,uuid,text,text,text),
  public.ia_operation_complete(uuid,uuid,uuid,uuid,text,text,jsonb,integer,integer,integer),
  public.ia_operation_fail(uuid,uuid,uuid,uuid,text,text,integer),
  public.ia_registrar_feedback(uuid,uuid,uuid,uuid,uuid,text)
  from public, anon, authenticated, service_role;

grant execute on function public.ia_contexto_agregado(uuid,uuid,date,date,text),
  public.ia_operation_begin(uuid,uuid,text,uuid,uuid,text,text,text),
  public.ia_operation_complete(uuid,uuid,uuid,uuid,text,text,jsonb,integer,integer,integer),
  public.ia_operation_fail(uuid,uuid,uuid,uuid,text,text,integer),
  public.ia_registrar_feedback(uuid,uuid,uuid,uuid,uuid,text)
  to service_role;

comment on table public.ia_operations is
  'Eventos append-only do copiloto: metadados tecnicos e replay saneado; nunca prompt ou PHI.';
comment on table public.ia_feedback is
  'Feedback owner append-only por enum; nunca comentario ou texto livre.';
comment on table private.ia_rate_limits is
  'Contadores atomicos 5/min, 30/h e 100/d por clinica, owner e caso de uso.';
comment on function public.ia_contexto_agregado(uuid,uuid,date,date,text) is
  'Separa painel_privado interno de modelo_agregado sem nome, ID, PII, clinico, foto ou texto livre.';
comment on function public.ia_operation_begin(uuid,uuid,text,uuid,uuid,text,text,text) is
  'context_hash e o SHA-256 do seletor canonico de contexto, calculado antes da materializacao.';

commit;

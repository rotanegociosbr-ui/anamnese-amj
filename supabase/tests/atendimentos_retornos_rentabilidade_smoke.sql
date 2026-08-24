-- Executar depois das migrations 30000 e 35000. Somente metadados; sempre rollback.
begin;

do $test$
declare
  v_name text;
  v_oid regprocedure;
  v_definition text;
begin
  foreach v_name in array array[
    'atendimentos_realizados',
    'patient_operational_profile_events',
    'patient_contact_preference_events',
    'retorno_recomendacoes',
    'retorno_fila',
    'retorno_tentativas',
    'operacao_fichas_custo',
    'operacao_ficha_custo_itens',
    'operacao_consumo_eventos',
    'atendimento_pagamento_taxas'
  ] loop
    if pg_catalog.to_regclass('public.' || v_name) is null then
      raise exception 'missing_table:%', v_name;
    end if;
    if not exists (
      select 1 from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = v_name and c.relrowsecurity
    ) then
      raise exception 'rls_disabled:%', v_name;
    end if;
    if pg_catalog.has_table_privilege('anon', 'public.' || v_name, 'SELECT,INSERT,UPDATE,DELETE')
       or pg_catalog.has_table_privilege('authenticated', 'public.' || v_name, 'SELECT,INSERT,UPDATE,DELETE') then
      raise exception 'browser_table_privilege:%', v_name;
    end if;
  end loop;

  foreach v_name in array array[
    'patient_operational_profile_current',
    'patient_contact_preference_current',
    'operacao_ficha_custo_atual',
    'operacao_rentabilidade_atendimentos',
    'operacao_rentabilidade_mensal',
    'operacao_retorno_resumo_diario'
  ] loop
    if pg_catalog.to_regclass('public.' || v_name) is null then
      raise exception 'missing_view:%', v_name;
    end if;
    if not exists (
      select 1 from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = v_name
        and c.reloptions @> array['security_invoker=true']::text[]
    ) then
      raise exception 'security_invoker_missing:%', v_name;
    end if;
    if pg_catalog.has_table_privilege('anon', 'public.' || v_name, 'SELECT')
       or pg_catalog.has_table_privilege('authenticated', 'public.' || v_name, 'SELECT') then
      raise exception 'browser_view_privilege:%', v_name;
    end if;
  end loop;

  foreach v_oid in array array[
    'public.operacao_salvar_atendimento(uuid,uuid,text,text,text,uuid,integer,uuid,uuid,uuid,uuid,text,timestamptz,smallint,text,uuid,uuid,uuid)'::regprocedure,
    'public.operacao_definir_arquivamento_atendimento(uuid,uuid,text,text,text,uuid,integer,boolean,text,uuid)'::regprocedure,
    'public.operacao_registrar_perfil_paciente(uuid,uuid,text,text,text,uuid,text,text,text,text,uuid,uuid)'::regprocedure,
    'public.operacao_registrar_preferencia_contato(uuid,uuid,text,text,text,uuid,text,text,boolean,text,text,text,timestamptz,uuid,uuid)'::regprocedure,
    'public.operacao_criar_retorno(uuid,uuid,text,text,text,uuid,text,date,date,date,text,uuid,timestamptz,uuid,uuid)'::regprocedure,
    'public.operacao_atualizar_retorno(uuid,uuid,text,text,text,uuid,integer,text,text,timestamptz,uuid,text,uuid)'::regprocedure,
    'public.operacao_registrar_tentativa_retorno(uuid,uuid,text,text,text,uuid,integer,text,text,text,text,text,timestamptz,timestamptz,uuid,uuid)'::regprocedure,
    'public.operacao_vincular_retorno_agendamento(uuid,uuid,text,text,text,uuid,integer,uuid,uuid)'::regprocedure,
    'public.operacao_registrar_ficha_custo(uuid,uuid,text,text,text,text,text,date,text,jsonb,uuid,uuid)'::regprocedure,
    'public.operacao_registrar_evento_consumo(uuid,uuid,text,text,text,uuid,uuid,uuid,text,numeric,text,text,text,timestamptz,uuid,uuid)'::regprocedure,
    'public.operacao_registrar_taxa_pagamento(uuid,uuid,text,text,text,uuid,uuid,text,numeric,text,text,uuid,uuid,uuid)'::regprocedure
  ] loop
    if pg_catalog.has_function_privilege('anon', v_oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('authenticated', v_oid, 'EXECUTE') then
      raise exception 'browser_rpc_privilege:%', v_oid::text;
    end if;
    if not pg_catalog.has_function_privilege('service_role', v_oid, 'EXECUTE') then
      raise exception 'service_role_rpc_missing:%', v_oid::text;
    end if;
    v_definition := pg_catalog.pg_get_functiondef(v_oid::oid);
    if v_definition ~* '(http_post|net\.http|webhook|send_message|twilio)' then
      raise exception 'automatic_messaging_found:%', v_oid::text;
    end if;
  end loop;

  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.financeiro_estoque_movimentos'::regclass
      and conname = 'financeiro_estoque_movimentos_movement_kind_check'
      and pg_catalog.pg_get_constraintdef(oid) like '%perda_tecnica%'
      and pg_catalog.pg_get_constraintdef(oid) like '%desperdicio%'
      and pg_catalog.pg_get_constraintdef(oid) like '%devolucao_atendimento%'
  ) then
    raise exception 'stock_adjustment_contract_missing';
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name in ('operacao_rentabilidade_atendimentos', 'operacao_rentabilidade_mensal', 'operacao_retorno_resumo_diario')
      and column_name in ('patient_id', 'full_name', 'cpf', 'phone', 'email')
  ) then
    raise exception 'pii_exposed_in_aggregate_view';
  end if;

  if not exists (
    select 1 from pg_catalog.pg_trigger
    where tgrelid = 'public.retorno_tentativas'::regclass
      and tgname = 'retorno_tentativas_append_only' and not tgisinternal
  ) then
    raise exception 'return_attempt_append_only_missing';
  end if;
end;
$test$;

rollback;

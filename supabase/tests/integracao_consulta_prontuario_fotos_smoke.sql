-- Executar depois de 20260824063000. Teste somente de metadados; sempre rollback.
begin;

do $test$
declare
  v_rpc regprocedure :=
    'public.operacao_preparar_prontuario_atendimento(uuid,uuid,text,text,text,uuid,integer,uuid,text,uuid)'::regprocedure;
  v_normalizer regprocedure :=
    'private.prontuario_normalize_procedure_kind(text)'::regprocedure;
  v_definition text;
  v_summary_definition text;
begin
  if pg_catalog.to_regclass('public.operacao_consulta_prontuario_resumo') is null then
    raise exception 'consultation_protocol_summary_missing';
  end if;
  if (
    select pg_catalog.count(*)
    from pg_catalog.pg_class relation
    join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and relation.relname in (
        'operacao_consulta_prontuario_resumo', 'operacao_atendimento_fotos'
      )
      and relation.reloptions @> array['security_invoker=true']::text[]
  ) <> 2 then
    raise exception 'security_invoker_summary_missing';
  end if;
  if pg_catalog.has_table_privilege(
       'anon', 'public.operacao_consulta_prontuario_resumo', 'SELECT'
     ) or pg_catalog.has_table_privilege(
       'authenticated', 'public.operacao_consulta_prontuario_resumo', 'SELECT'
     ) or pg_catalog.has_table_privilege(
       'anon', 'public.operacao_atendimento_fotos', 'SELECT'
     ) or pg_catalog.has_table_privilege(
       'authenticated', 'public.operacao_atendimento_fotos', 'SELECT'
     ) then
    raise exception 'browser_summary_privilege_found';
  end if;
  if not pg_catalog.has_table_privilege(
    'service_role', 'public.operacao_consulta_prontuario_resumo', 'SELECT'
  ) or not pg_catalog.has_table_privilege(
    'service_role', 'public.operacao_atendimento_fotos', 'SELECT'
  ) then
    raise exception 'service_summary_privilege_missing';
  end if;

  if pg_catalog.has_function_privilege('anon', v_rpc, 'EXECUTE')
     or pg_catalog.has_function_privilege('authenticated', v_rpc, 'EXECUTE') then
    raise exception 'browser_prepare_rpc_privilege_found';
  end if;
  if not pg_catalog.has_function_privilege('service_role', v_rpc, 'EXECUTE') then
    raise exception 'service_prepare_rpc_privilege_missing';
  end if;
  if not exists (
    select 1 from pg_catalog.pg_proc where oid = v_normalizer::oid and provolatile = 'i'
  ) then
    raise exception 'procedure_normalizer_not_immutable';
  end if;
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.protocols'::regclass
      and conname = 'protocols_procedure_kind_check'
      and pg_catalog.pg_get_constraintdef(oid) like '%prontuario_normalize_procedure_kind%'
  ) then
    raise exception 'normalized_procedure_constraint_missing';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'operacao_consulta_prontuario_resumo'
      and column_name = 'active_clinical_count'
  ) or not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'operacao_consulta_prontuario_resumo'
      and column_name = 'active_product_count'
  ) then
    raise exception 'separate_photo_counts_missing';
  end if;

  v_summary_definition := pg_catalog.pg_get_viewdef(
    'public.operacao_consulta_prontuario_resumo'::regclass,
    true
  );
  if v_summary_definition !~ 'item\.protocol_id = protocol\.id'
     or v_summary_definition !~ 'current_consent\.protocol_id = protocol\.id'
     or v_summary_definition ~ '(item|current_consent)\.protocol_id = attendance\.protocol_id' then
    raise exception 'summary_cross_tenant_lateral_found';
  end if;

  v_definition := pg_catalog.pg_get_functiondef(v_rpc::oid);
  if v_definition !~ 'private\.operacao_assert_owner'
     or v_definition !~ 'private\.operacao_replay_guard'
     or v_definition !~ ':attendance-protocol-prepare:'
     or v_definition !~ 'responsible_user_id'
     or v_definition !~* 'member\.role[[:space:]]+in[[:space:]]+\(''owner'', ''professional''\)'
     or v_definition !~ 'America/Sao_Paulo' then
    raise exception 'prepare_rpc_security_contract_missing';
  end if;
  if v_definition ~* 'insert into public\.protocol_(consents|photos)'
     or v_definition ~* 'update public\.atendimentos_realizados[^;]*status[[:space:]]*=' then
    raise exception 'prepare_rpc_fabricates_clinical_state';
  end if;
  if v_definition !~ 'other_attendance\.id <> p_attendance_id'
     or v_definition ~ 'other_attendance\.archived_at' then
    raise exception 'archived_attendance_idempotency_reservation_missing';
  end if;
end;
$test$;

rollback;

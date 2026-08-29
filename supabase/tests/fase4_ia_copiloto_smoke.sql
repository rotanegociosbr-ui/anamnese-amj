-- Fase 4: auditoria estatica/sem fixtures. Executar depois das migrations.
-- O rollback preserva o banco mesmo se o arquivo for ampliado com testes mutaveis.
begin;

do $test$
declare
  v_relation text;
  v_oid regprocedure;
  v_definition text;
  v_check text;
  v_crm_branch text;
  v_marketing_branch text;
  v_finance_branch text;
  v_agenda_branch text;
begin
  foreach v_relation in array array[
    'public.ia_operations',
    'public.ia_feedback',
    'private.ia_rate_limits'
  ] loop
    if pg_catalog.to_regclass(v_relation) is null then
      raise exception 'fase4_missing_relation:%', v_relation;
    end if;
    if not exists (
      select 1
      from pg_catalog.pg_class relation
      where relation.oid = pg_catalog.to_regclass(v_relation)
        and relation.relrowsecurity
    ) then
      raise exception 'fase4_rls_disabled:%', v_relation;
    end if;
    if pg_catalog.has_table_privilege(
         'anon', v_relation, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
       )
       or pg_catalog.has_table_privilege(
         'authenticated', v_relation,
         'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
       )
       or pg_catalog.has_table_privilege(
         'service_role', v_relation,
         'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
       ) then
      raise exception 'fase4_direct_table_privilege:%', v_relation;
    end if;
    if exists (
      select 1 from pg_catalog.pg_policy policy
      where policy.polrelid = pg_catalog.to_regclass(v_relation)
    ) then
      raise exception 'fase4_rpc_only_relation_has_policy:%', v_relation;
    end if;
  end loop;

  if pg_catalog.has_sequence_privilege(
       'anon', 'public.ia_operations_id_seq', 'USAGE'
     )
     or pg_catalog.has_sequence_privilege(
       'authenticated', 'public.ia_operations_id_seq', 'USAGE'
     )
     or pg_catalog.has_sequence_privilege(
       'service_role', 'public.ia_operations_id_seq', 'USAGE'
     ) then
    raise exception 'fase4_direct_sequence_privilege';
  end if;

  foreach v_oid in array array[
    'public.ia_contexto_agregado(uuid,uuid,date,date,text)'::regprocedure,
    'public.ia_operation_begin(uuid,uuid,text,uuid,uuid,text,text,text)'::regprocedure,
    'public.ia_operation_complete(uuid,uuid,uuid,uuid,text,text,jsonb,integer,integer,integer)'::regprocedure,
    'public.ia_operation_fail(uuid,uuid,uuid,uuid,text,text,integer)'::regprocedure,
    'public.ia_registrar_feedback(uuid,uuid,uuid,uuid,uuid,text)'::regprocedure
  ] loop
    if pg_catalog.has_function_privilege('anon', v_oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('authenticated', v_oid, 'EXECUTE')
       or not pg_catalog.has_function_privilege('service_role', v_oid, 'EXECUTE') then
      raise exception 'fase4_rpc_privilege:%', v_oid::text;
    end if;
    if not exists (
      select 1
      from pg_catalog.pg_proc procedure
      where procedure.oid = v_oid::oid
        and procedure.prosecdef
        and coalesce(pg_catalog.array_to_string(procedure.proconfig, ','), '')
          like '%search_path=%'
    ) then
      raise exception 'fase4_rpc_hardening:%', v_oid::text;
    end if;
  end loop;

  foreach v_oid in array array[
    'private.ia_assert_owner(uuid,uuid)'::regprocedure,
    'private.ia_suppress_count(bigint)'::regprocedure,
    'private.ia_suppress_metric(bigint,numeric)'::regprocedure,
    'private.ia_replay_is_safe(jsonb)'::regprocedure,
    'private.ia_block_mutation()'::regprocedure,
    'private.ia_consume_rate_limit(uuid,uuid,text)'::regprocedure
  ] loop
    if pg_catalog.has_function_privilege('anon', v_oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('authenticated', v_oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('service_role', v_oid, 'EXECUTE') then
      raise exception 'fase4_private_function_exposed:%', v_oid::text;
    end if;
  end loop;

  if not exists (
    select 1 from pg_catalog.pg_trigger trigger
    where trigger.tgrelid = 'public.ia_operations'::regclass
      and trigger.tgname = 'ia_operations_append_only'
      and not trigger.tgisinternal and trigger.tgenabled <> 'D'
  ) or not exists (
    select 1 from pg_catalog.pg_trigger trigger
    where trigger.tgrelid = 'public.ia_feedback'::regclass
      and trigger.tgname = 'ia_feedback_append_only'
      and not trigger.tgisinternal and trigger.tgenabled <> 'D'
  ) then
    raise exception 'fase4_append_only_trigger_missing';
  end if;

  if exists (
    select 1
    from information_schema.columns column_info
    where column_info.table_schema = 'public'
      and column_info.table_name = 'ia_operations'
      and column_info.column_name in (
        'prompt', 'messages', 'input', 'input_payload', 'raw_payload',
        'patient_id', 'lead_id', 'clinical_data', 'free_text'
      )
  ) then
    raise exception 'fase4_operation_sensitive_column';
  end if;
  if exists (
    select 1
    from information_schema.columns column_info
    where column_info.table_schema = 'public'
      and column_info.table_name = 'ia_feedback'
      and column_info.column_name in ('comment', 'comments', 'note', 'notes', 'free_text')
  ) then
    raise exception 'fase4_feedback_free_text_column';
  end if;

  select pg_catalog.string_agg(
    pg_catalog.pg_get_constraintdef(constraint_row.oid), ' '
  ) into v_check
  from pg_catalog.pg_constraint constraint_row
  where constraint_row.conrelid = 'public.ia_feedback'::regclass
    and constraint_row.contype = 'c';
  if v_check is null
     or v_check !~ '''util'''
     or v_check !~ '''nao_util'''
     or v_check ~* 'comment|notes?|free_text' then
    raise exception 'fase4_feedback_enum_contract';
  end if;

  v_definition := pg_catalog.pg_get_functiondef(
    'private.ia_replay_is_safe(jsonb)'::regprocedure::oid
  );
  if v_definition !~ 'octet_length'
     or v_definition !~ '32768'
     or v_definition !~ 'prompt'
     or v_definition !~ 'patient'
     or v_definition !~ 'https' then
    raise exception 'fase4_replay_guard_incomplete';
  end if;
  if private.ia_replay_is_safe('{"titulo":"resumo agregado"}'::jsonb) is not true
     or private.ia_replay_is_safe('{"prompt":"segredo"}'::jsonb) is not false
     or private.ia_replay_is_safe(
       pg_catalog.jsonb_build_object('titulo', pg_catalog.repeat('x', 33000))
     ) is not false
     or private.ia_replay_is_safe('{"titulo":"a@b.example"}'::jsonb) is not false then
    raise exception 'fase4_replay_guard_behavior';
  end if;

  if private.ia_suppress_count(0) <> '{"valor":0,"suprimido":false}'::jsonb
     or private.ia_suppress_count(1) <> '{"valor":null,"suprimido":true}'::jsonb
     or private.ia_suppress_count(4) <> '{"valor":null,"suprimido":true}'::jsonb
     or private.ia_suppress_count(5) <> '{"valor":5,"suprimido":false}'::jsonb
     or private.ia_suppress_metric(1, 123.45)
       <> '{"valor":null,"suprimido":true}'::jsonb
     or private.ia_suppress_metric(4, 123.45)
       <> '{"valor":null,"suprimido":true}'::jsonb
     or private.ia_suppress_metric(5, 123.45)
       <> '{"valor":123.45,"suprimido":false}'::jsonb then
    raise exception 'fase4_small_cell_suppression';
  end if;

  v_definition := pg_catalog.pg_get_functiondef(
    'public.ia_contexto_agregado(uuid,uuid,date,date,text)'::regprocedure::oid
  );
  if v_definition !~ 'private.ia_assert_owner'
     or v_definition !~ 'p_end - p_start > 365'
     or v_definition !~ 'limit 3'
     or v_definition !~ '''painel_privado'''
     or v_definition !~ '''modelo_agregado'''
     or v_definition !~ '''target_kind'''
     or v_definition !~ '''target_id'''
     or v_definition !~ '''nome_exibicao'''
     or v_definition !~ 'v_forecast_points >= 3'
     or v_definition !~ '''dados_insuficientes'''
     or v_definition !~ '''valor_estimado'''
     or v_definition !~ 'ia_suppress_count'
     or v_definition !~ 'v_financial_safe := pg_catalog.jsonb_build_object'
     or v_definition !~ 'v_marketing_safe := pg_catalog.jsonb_build_object'
     or v_definition !~ 'contribuintes_fluxo'
     or v_definition !~ 'v_forecast_contributors'
     or v_definition !~ 'v_marketing_roi_safe_count'
     or v_definition !~ 'v_marketing_cac_safe_count'
     or v_definition !~ 'v_installments_contributors'
     or v_definition !~* 'count\(distinct case'
     or v_definition !~ 'count\(distinct coalesce\(entry\.patient_id::text, ''unknown''\)\)'
     or v_definition !~ 'coalesce\(entry\.supplier_id::text, ''unknown''\)'
     or v_definition !~ 'contributor_money'
     or v_definition !~ 'party_cash\.net <> 0'
     or v_definition !~ 'ia_suppress_metric\([[:space:]]*v_installments_contributors'
     or v_definition ~ 'ia_suppress_metric\([[:space:]]*v_installments_overdue'
     or v_definition !~ '>= 5'
     or v_definition ~ 'public.agendamentos_clinica' then
    raise exception 'fase4_context_contract';
  end if;
  v_check := pg_catalog.split_part(
    pg_catalog.split_part(v_definition, 'v_model :=', 2),
    'return pg_catalog.jsonb_build_object', 1
  );
  if v_check !~ '''dados_minimizados'''
     or v_check !~ '''somente_agregados'''
     or v_check !~ '''sem_midia'''
     or v_check ~ '\mv_financial\M'
     or v_check ~ 'v_marketing[[:space:]]*#>'
     or v_check ~* '''[^'']*(target_id|nome|names?|patients?|pacientes?|clinical|clinicos?|fotos?|photos?|images?|urls?|paths?|notes?|documentos?|signatures?)[^'']*''[[:space:]]*,' then
    raise exception 'fase4_aggregate_key_dlp_conflict';
  end if;

  v_crm_branch := pg_catalog.split_part(
    pg_catalog.split_part(v_definition, 'elsif v_focus = ''crm'' then', 2),
    'elsif v_focus = ''marketing'' then', 1
  );
  v_marketing_branch := pg_catalog.split_part(
    pg_catalog.split_part(v_definition, 'elsif v_focus = ''marketing'' then', 2),
    'elsif v_focus = ''financeiro'' then', 1
  );
  v_finance_branch := pg_catalog.split_part(
    pg_catalog.split_part(v_definition, 'elsif v_focus = ''financeiro'' then', 2),
    'else', 1
  );
  v_agenda_branch := pg_catalog.split_part(
    pg_catalog.split_part(
      pg_catalog.split_part(v_definition, 'elsif v_focus = ''financeiro'' then', 2),
      'else', 2
    ),
    'end if', 1
  );
  if v_crm_branch !~ '''nba'''
     or v_crm_branch ~ '''marketing''|''financeiro''|''series''|''previsao''|''agenda'''
     or v_marketing_branch !~ '''marketing'''
     or v_marketing_branch ~ '''nba''|''financeiro''|''series''|''previsao''|''agenda'''
     or v_finance_branch !~ '''financeiro'''
     or v_finance_branch !~ '''series'''
     or v_finance_branch !~ '''previsao'''
     or v_finance_branch ~ '''nba''|''marketing''|''acompanhamentos''|''agenda'''
     or v_agenda_branch !~ '''agenda'''
     or v_agenda_branch ~ '''nba''|''marketing''|''financeiro''|''series''|''previsao''|''acompanhamentos''' then
    raise exception 'fase4_focus_minimization_contract';
  end if;

  v_definition := pg_catalog.pg_get_functiondef(
    'public.ia_operation_begin(uuid,uuid,text,uuid,uuid,text,text,text)'::regprocedure::oid
  );
  if v_definition !~ 'pg_advisory_xact_lock'
     or v_definition !~ 'ia_consume_rate_limit'
     or v_definition !~ '''replay'''
     or v_definition !~ '''in_progress'''
     or v_definition !~ 'ia_idempotency_key_reused' then
    raise exception 'fase4_begin_contract';
  end if;

  v_definition := pg_catalog.pg_get_functiondef(
    'private.ia_consume_rate_limit(uuid,uuid,text)'::regprocedure::oid
  );
  if v_definition !~ '\(''minute''::text, 5\)'
     or v_definition !~ '\(''hour''::text, 30\)'
     or v_definition !~ '\(''day''::text, 100\)'
     or v_definition !~ 'ia_rate_limited_' then
    raise exception 'fase4_rate_limit_contract';
  end if;
end;
$test$;

select 'FASE4_IA_COPILOTO_SMOKE_OK' as resultado;
rollback;

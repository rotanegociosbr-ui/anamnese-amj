-- Executar depois da migration 20260826045218. Somente metadados; sempre rollback.
begin;

do $test$
declare
  v_name text;
  v_oid regprocedure;
  v_definition text;
  v_stages text[];
begin
  if pg_catalog.has_schema_privilege('anon', 'private', 'USAGE')
     or pg_catalog.has_schema_privilege('authenticated', 'private', 'USAGE') then
    raise exception 'browser_private_schema_usage';
  end if;
  if not pg_catalog.has_schema_privilege('service_role', 'private', 'USAGE') then
    raise exception 'legacy_edge_private_schema_usage_missing';
  end if;
  if pg_catalog.to_regprocedure('private.gestao_assert_owner(uuid,uuid)') is null
     or not pg_catalog.has_function_privilege(
       'service_role', 'private.gestao_assert_owner(uuid,uuid)', 'EXECUTE'
     ) then
    raise exception 'legacy_gestao_private_helper_privilege_missing';
  end if;

  foreach v_name in array array[
    'crm_pipeline_stages',
    'crm_leads',
    'crm_lead_stage_history',
    'crm_interactions',
    'crm_operations',
    'crm_audit_log'
  ] loop
    if pg_catalog.to_regclass('public.' || v_name) is null then
      raise exception 'missing_table:%', v_name;
    end if;
    if not exists (
      select 1 from pg_catalog.pg_class relation
      join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
      where namespace.nspname = 'public' and relation.relname = v_name
        and relation.relrowsecurity
    ) then
      raise exception 'rls_disabled:%', v_name;
    end if;
    if pg_catalog.has_table_privilege('anon', 'public.' || v_name, 'SELECT,INSERT,UPDATE,DELETE')
       or pg_catalog.has_table_privilege('authenticated', 'public.' || v_name, 'SELECT,INSERT,UPDATE,DELETE') then
      raise exception 'browser_table_privilege:%', v_name;
    end if;
    if pg_catalog.has_table_privilege('service_role', 'public.' || v_name, 'INSERT,UPDATE,DELETE') then
      raise exception 'service_direct_write_privilege:%', v_name;
    end if;
  end loop;

  foreach v_name in array array['anon', 'authenticated', 'service_role'] loop
    if pg_catalog.has_sequence_privilege(
      v_name, 'public.crm_audit_log_id_seq', 'USAGE,SELECT,UPDATE'
    ) then
      raise exception 'direct_audit_sequence_privilege:%', v_name;
    end if;
  end loop;

  select pg_catalog.array_agg(stage.code order by stage.sort_order)
  into v_stages
  from public.crm_pipeline_stages stage;
  if v_stages is distinct from array[
    'novo', 'primeiro_atendimento', 'interessada', 'avaliacao_sugerida',
    'avaliacao_agendada', 'avaliacao_realizada', 'plano_apresentado',
    'proposta_enviada', 'aguardando_decisao', 'procedimento_agendado',
    'convertida', 'nao_convertida', 'reativacao_futura'
  ]::text[] then
    raise exception 'canonical_stage_catalog_invalid:%', v_stages;
  end if;

  foreach v_oid in array array[
    'public.crm_salvar_lead(text,uuid,uuid,uuid,integer,uuid,uuid,jsonb)'::regprocedure,
    'public.crm_analisar_conversao(uuid,uuid,uuid)'::regprocedure,
    'public.crm_converter_lead(uuid,uuid,uuid,integer,uuid,uuid,uuid,boolean,text,text)'::regprocedure
  ] loop
    if pg_catalog.has_function_privilege('anon', v_oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('authenticated', v_oid, 'EXECUTE') then
      raise exception 'browser_rpc_privilege:%', v_oid::text;
    end if;
    if not pg_catalog.has_function_privilege('service_role', v_oid, 'EXECUTE') then
      raise exception 'service_role_rpc_missing:%', v_oid::text;
    end if;
    if not exists (
      select 1 from pg_catalog.pg_proc procedure
      where procedure.oid = v_oid::oid
        and procedure.prosecdef
        and coalesce(array_to_string(procedure.proconfig, ','), '') like '%search_path=%'
    ) then
      raise exception 'rpc_hardening_missing:%', v_oid::text;
    end if;
    v_definition := pg_catalog.pg_get_functiondef(v_oid::oid);
    if v_definition !~ 'crm_assert_owner'
       or v_definition ~* '(http_post|net\.http|webhook|send_message|twilio)' then
      raise exception 'rpc_boundary_invalid:%', v_oid::text;
    end if;
  end loop;

  v_definition := pg_catalog.pg_get_functiondef(
    'public.crm_salvar_lead(text,uuid,uuid,uuid,integer,uuid,uuid,jsonb)'::regprocedure::oid
  );
  if v_definition !~ 'crm_replay'
     or v_definition !~ 'crm_store_operation'
     or v_definition !~ 'crm_version_conflict'
     or v_definition !~ 'crm_lead_stage_history'
     or v_definition !~ 'v_previous_stage' then
    raise exception 'atomic_mutation_contract_missing';
  end if;
  if v_definition !~ 'crm_first_response_in_future'
     or (
       v_definition !~ 'clock_timestamp\(\)[[:space:]]*\+[[:space:]]*interval[[:space:]]+''5 minutes'''
       and v_definition !~ 'clock_timestamp\(\)[[:space:]]*\+[[:space:]]*''00:05:00''::interval'
     )
     or v_definition !~ 'coalesce\(first_response_at, v_first_response_at\)'
     or v_definition ~ 'first_response_at[[:space:]]+is[[:space:]]+distinct[[:space:]]+from[[:space:]]+v_first_response_at'
     or v_definition !~ 'least\(coalesce\(first_response_at, v_occurred_at\), v_occurred_at\)' then
    raise exception 'first_response_temporal_contract_missing';
  end if;
  if v_definition !~ 'record_status[[:space:]]*=[[:space:]]*case[[:space:]]+when v_action = ''archive'''
     or v_definition ~ 'stage_code[[:space:]]*=[[:space:]]*case[[:space:]]+when v_action = ''archive'''
     or v_definition ~ 'converted_at[[:space:]]*=[[:space:]]*case[[:space:]]+when v_action = ''archive''' then
    raise exception 'archive_must_preserve_conversion_history';
  end if;

  v_definition := pg_catalog.pg_get_functiondef(
    'public.crm_converter_lead(uuid,uuid,uuid,integer,uuid,uuid,uuid,boolean,text,text)'::regprocedure::oid
  );
  if v_definition !~ 'financeiro_patient_exact_key'
     or v_definition !~ 'patient_source_links'
     or v_definition !~ 'crm_lead'
     or v_definition !~ 'crm_possible_distinct_reason_required'
     or v_definition !~ 'confirmado_distinto'
     or v_definition !~ 'for update' then
    raise exception 'conversion_dedup_contract_missing';
  end if;
  if v_definition !~ 'p_candidate_fingerprint'
     or v_definition !~ 'crm_reanalysis_required'
     or v_definition !~ 'crm_candidate_set_too_large'
     or v_definition !~ 'crm_possible_distinct_confirmation_invalid'
     or v_definition ~ 'safe_label' then
    raise exception 'conversion_snapshot_contract_invalid';
  end if;
  if v_definition !~* 'update[[:space:]]+public\.clinic_duplicate_reviews[[:space:]]+review'
     or v_definition !~* 'version[[:space:]]*=[[:space:]]*review\.version[[:space:]]*\+[[:space:]]*1' then
    raise exception 'conversion_duplicate_review_version_increment_missing';
  end if;
  if v_definition !~ 'possible_phone'
     or v_definition !~ 'possible_email'
     or v_definition !~ 'possible_name_birth'
     or v_definition !~ 'get diagnostics v_review_count = row_count'
     or v_definition !~ 'v_review_count <> v_possible_count'
     or v_definition !~ 'where not exists'
     or v_definition !~ 'count\(\*\)(.|[[:space:]])*<> 1'
     or v_definition !~ 'crm_possible_distinct_decision_not_persisted' then
    raise exception 'conversion_all_possible_decisions_not_materialized';
  end if;

  v_definition := pg_catalog.pg_get_functiondef(
    'private.financeiro_guard_duplicate_review()'::regprocedure::oid
  );
  if v_definition !~* 'new\.version[[:space:]]*<>[[:space:]]*old\.version[[:space:]]*\+[[:space:]]*1' then
    raise exception 'duplicate_review_version_guard_missing';
  end if;

  v_definition := pg_catalog.pg_get_functiondef(
    'private.financeiro_sync_patient_dedup()'::regprocedure::oid
  );
  if v_definition !~* 'tg_op[[:space:]]*=[[:space:]]*''INSERT''(.|[[:space:]])*crm_lock_patient_identity(.|[[:space:]])*select[[:space:]]+patient\.id'
     or v_definition ~* 'tg_op[[:space:]]*=[[:space:]]*''UPDATE''(.|[[:space:]])*crm_lock_patient_identity' then
    raise exception 'patient_identity_lock_missing_or_late';
  end if;

  v_definition := pg_catalog.pg_get_functiondef(
    'public.crm_converter_lead(uuid,uuid,uuid,integer,uuid,uuid,uuid,boolean,text,text)'::regprocedure::oid
  );
  if v_definition !~* 'crm_lock_patient_identity(.|[[:space:]])*select[[:space:]]+\*[[:space:]]+into[[:space:]]+v_lead' then
    raise exception 'crm_conversion_identity_lock_missing_or_late';
  end if;

  v_definition := pg_catalog.pg_get_functiondef(
    'public.crm_analisar_conversao(uuid,uuid,uuid)'::regprocedure::oid
  );
  if v_definition !~* 'crm_lock_patient_identity(.|[[:space:]])*select[[:space:]]+\*[[:space:]]+into[[:space:]]+v_lead' then
    raise exception 'crm_analysis_identity_lock_missing_or_late';
  end if;

  foreach v_oid in array array[
    'public.financeiro_criar_cliente_com_vinculo(uuid,uuid,text,date,text,text,text,text,text,uuid,uuid,uuid)'::regprocedure,
    'public.financeiro_editar_cliente(uuid,uuid,uuid,integer,text,date,text,text,text,text,text,text,text,uuid)'::regprocedure,
    'public.financeiro_arquivar_cliente(uuid,uuid,uuid,integer,text,uuid)'::regprocedure,
    'public.financeiro_restaurar_cliente(uuid,uuid,uuid,integer,text,uuid)'::regprocedure
  ] loop
    v_definition := pg_catalog.pg_get_functiondef(v_oid::oid);
    if v_definition !~ 'crm_lock_patient_identity' then
      raise exception 'patient_writer_lock_missing:%', v_oid::text;
    end if;
    if v_oid::text not like '%criar_cliente_com_vinculo%'
       and v_definition !~* 'crm_lock_patient_identity(.|[[:space:]])*select[[:space:]]+\*' then
      raise exception 'patient_writer_lock_order_invalid:%', v_oid::text;
    end if;
  end loop;
  v_definition := pg_catalog.pg_get_functiondef(
    'public.crm_analisar_conversao(uuid,uuid,uuid)'::regprocedure::oid
  );
  if v_definition !~ 'candidate_fingerprint'
     or v_definition !~ 'safe_label'
     or v_definition !~ 'safe_alias'
     or v_definition !~ 'exact_safe_alias'
     or v_definition !~* 'md5\(patient\.id::text\)'
     or v_definition !~ 'has_more'
     or v_definition !~ 'ordinality <= 20'
     or v_definition ~* 'limit[[:space:]]+20' then
    raise exception 'crm_analysis_full_snapshot_or_safe_identity_missing';
  end if;

  v_definition := pg_catalog.pg_get_functiondef(
    'private.crm_sync_lead_dedup()'::regprocedure::oid
  );
  if v_definition !~* 'clinic:crm-lead-identity:(.|[[:space:]])*select[[:space:]]+lead\.id' then
    raise exception 'crm_lead_identity_lock_missing_or_late';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_index index_row
    where index_row.indrelid = 'public.patients'::regclass
      and index_row.indisunique
      and pg_catalog.pg_get_indexdef(index_row.indexrelid) like '%dedup_possible_key%'
  ) then
    raise exception 'patient_possible_key_must_not_be_unique';
  end if;

  if not exists (
    select 1 from pg_catalog.pg_constraint constraint_row
    where constraint_row.conrelid = 'public.patient_source_links'::regclass
      and constraint_row.conname = 'patient_source_links_source_kind_check'
      and pg_catalog.pg_get_constraintdef(constraint_row.oid) like '%crm_lead%'
  ) then
    raise exception 'crm_patient_source_link_missing';
  end if;

  if not exists (
    select 1 from pg_catalog.pg_constraint constraint_row
    where constraint_row.conrelid = 'public.clinic_duplicate_reviews'::regclass
      and constraint_row.conname = 'clinic_duplicate_reviews_entity_kind_check'
      and pg_catalog.pg_get_constraintdef(constraint_row.oid) like '%lead%'
  ) then
    raise exception 'crm_duplicate_review_kind_missing';
  end if;

  foreach v_name in array array[
    'crm_leads_no_delete',
    'crm_pipeline_stages_immutable',
    'crm_lead_stage_history_append_only',
    'crm_interactions_append_only',
    'crm_operations_append_only',
    'crm_audit_log_append_only'
  ] loop
    if not exists (
      select 1 from pg_catalog.pg_trigger trigger_row
      where trigger_row.tgname = v_name and not trigger_row.tgisinternal
    ) then
      raise exception 'immutability_trigger_missing:%', v_name;
    end if;
  end loop;

  if exists (
    select 1 from information_schema.columns column_row
    where column_row.table_schema = 'public'
      and column_row.table_name in ('crm_leads', 'crm_interactions')
      and column_row.column_name in (
        'diagnosis', 'diagnostico', 'anamnese', 'medical_history',
        'health_condition', 'clinical_notes', 'protocol_id', 'clinical_photo_id'
      )
  ) then
    raise exception 'clinical_column_in_crm';
  end if;

  if not exists (
    select 1 from pg_catalog.pg_description description
    join pg_catalog.pg_class relation on relation.oid = description.objoid
    join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public' and relation.relname = 'crm_leads'
      and description.objsubid = 0
      and description.description like '%dados clínicos e de saúde são proibidos%'
  ) then
    raise exception 'crm_no_health_contract_comment_missing';
  end if;
end;
$test$;

rollback;

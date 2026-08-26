-- Executar somente depois das migrations Fase 2A/2B/2C. Metadados, BEGIN/ROLLBACK.
begin;

do $test$
declare
  v_name text;
  v_oid regprocedure;
  v_definition text;
begin
  foreach v_name in array array[
    'clinic_professional_credentials','clinic_professional_verification_evidence',
    'patient_marketing_signature_evidence','patient_marketing_consent_events',
    'acompanhamento_planos','reactivation_contact_attempts','clinical_photo_object_gc_queue'
  ] loop
    if pg_catalog.to_regclass('public.'||v_name) is null then
      raise exception 'fase2_missing_table:%',v_name;
    end if;
    if not exists(select 1 from pg_catalog.pg_class relation
      join pg_catalog.pg_namespace namespace on namespace.oid=relation.relnamespace
      where namespace.nspname='public' and relation.relname=v_name and relation.relrowsecurity) then
      raise exception 'fase2_rls_disabled:%',v_name;
    end if;
    if pg_catalog.has_table_privilege('anon','public.'||v_name,'SELECT,INSERT,UPDATE,DELETE')
       or pg_catalog.has_table_privilege('authenticated','public.'||v_name,'SELECT,INSERT,UPDATE,DELETE')
       or pg_catalog.has_table_privilege('service_role','public.'||v_name,'INSERT,UPDATE,DELETE') then
      raise exception 'fase2_direct_table_privilege:%',v_name;
    end if;
  end loop;

  foreach v_oid in array array[
    'public.operacao_configurar_credencial_profissional(uuid,uuid,text,text,text,uuid,text,text,text,date,text,uuid,uuid)'::regprocedure,
    'public.fase2_revisar_credencial_profissional_tecnica(uuid,uuid,text,uuid,text,text,timestamptz,uuid,text,uuid,uuid)'::regprocedure,
    'public.fase2_registrar_evidencia_marketing_assinada_tecnica(uuid,uuid,text,uuid,uuid,text,timestamptz,uuid,uuid)'::regprocedure,
    'public.operacao_registrar_consentimento_marketing(uuid,uuid,text,text,text,uuid,text,boolean,uuid,uuid,uuid)'::regprocedure,
    'public.operacao_listar_acompanhamentos_fase2(uuid,uuid,text,text,text,integer,timestamptz,text,uuid)'::regprocedure,
    'public.operacao_ativar_sequencia_pos_procedimento(uuid,uuid,text,text,text,uuid,integer,uuid,jsonb,uuid,uuid,uuid)'::regprocedure,
    'public.operacao_ativar_reativacao(uuid,uuid,text,text,text,uuid,uuid,integer,text,uuid,uuid,uuid,uuid)'::regprocedure,
    'public.operacao_registrar_tentativa_reativacao(uuid,uuid,text,text,text,uuid,integer,uuid,integer,text,text,timestamptz,timestamptz,uuid,uuid)'::regprocedure,
    'public.prontuario_enfileirar_gc_foto_orfa(uuid,uuid,text,text,uuid,uuid,text,text,text,uuid)'::regprocedure,
    'public.gestao_relatorio_acompanhamentos_fase2(uuid,uuid,text,text,text,date,date)'::regprocedure
  ] loop
    if pg_catalog.has_function_privilege('anon',v_oid,'EXECUTE')
       or pg_catalog.has_function_privilege('authenticated',v_oid,'EXECUTE')
       or not pg_catalog.has_function_privilege('service_role',v_oid,'EXECUTE') then
      raise exception 'fase2_rpc_privilege:%',v_oid::text;
    end if;
    if not exists(select 1 from pg_catalog.pg_proc procedure where procedure.oid=v_oid::oid
      and procedure.prosecdef
      and coalesce(pg_catalog.array_to_string(procedure.proconfig,','),'') like '%search_path=%') then
      raise exception 'fase2_rpc_hardening:%',v_oid::text;
    end if;
  end loop;

  v_definition:=pg_catalog.pg_get_functiondef(
    'public.operacao_configurar_credencial_profissional(uuid,uuid,text,text,text,uuid,text,text,text,date,text,uuid,uuid)'::regprocedure::oid);
  if v_definition !~ '''pending''' or v_definition ~ 'verified_by' then
    raise exception 'credential_edge_must_only_create_pending';
  end if;
  v_definition:=pg_catalog.pg_get_functiondef(
    'public.fase2_revisar_credencial_profissional_tecnica(uuid,uuid,text,uuid,text,text,timestamptz,uuid,text,uuid,uuid)'::regprocedure::oid);
  if v_definition !~ 'independent_credential_verifier_required'
     or v_definition !~ 'verification_evidence_id'
     or v_definition !~ 'credential_not_current' then
    raise exception 'credential_independent_review_contract_missing';
  end if;

  v_definition:=pg_catalog.pg_get_functiondef(
    'public.operacao_registrar_consentimento_marketing(uuid,uuid,text,text,text,uuid,text,boolean,uuid,uuid,uuid)'::regprocedure::oid);
  if v_definition !~ 'patient_marketing_signature_evidence'
     or v_definition !~ 'published_marketing_term_required'
     or v_definition ~ 'p_term_sha256|p_signature_sha256|p_term_version'
     or v_definition !~ 'Consentimento de marketing alterado' then
    raise exception 'marketing_consent_evidence_or_invalidation_missing';
  end if;

  v_definition:=pg_catalog.pg_get_functiondef(
    'public.operacao_listar_acompanhamentos_fase2(uuid,uuid,text,text,text,integer,timestamptz,text,uuid)'::regprocedure::oid);
  if v_definition !~ 'page_plus_one' or v_definition !~ '''has_more'''
     or v_definition !~ '''plano_id''' or v_definition !~ '''versao_plano'''
     or v_definition !~ '''versao_fila''' or v_definition !~ '''responsaveis'''
     or v_definition !~ '''realizado''' or v_definition !~ '''concluido''' then
    raise exception 'fase2_atomic_list_contract_missing';
  end if;

  v_definition:=pg_catalog.pg_get_functiondef(
    'public.operacao_ativar_sequencia_pos_procedimento(uuid,uuid,text,text,text,uuid,integer,uuid,jsonb,uuid,uuid,uuid)'::regprocedure::oid);
  if v_definition !~ 'credential.user_id=p_user_id'
     or v_definition ~ 'p_validated_by'
     or v_definition !~ 'patient.archived_at is null' then
    raise exception 'post_procedure_actor_or_patient_guard_missing';
  end if;
  v_definition:=pg_catalog.pg_get_functiondef(
    'public.operacao_ativar_reativacao(uuid,uuid,text,text,text,uuid,uuid,integer,text,uuid,uuid,uuid,uuid)'::regprocedure::oid);
  if v_definition !~ 'America/Sao_Paulo' or v_definition !~ '365'
     or v_definition !~ '180' or v_definition !~ '120' or v_definition !~ '90'
     or v_definition !~ '60' or v_definition !~ 'active_reactivation_exists'
     or v_definition !~ '''realizado''' then
    raise exception 'reactivation_bucket_or_anchor_contract_missing';
  end if;
  v_definition:=pg_catalog.pg_get_functiondef(
    'public.operacao_registrar_tentativa_reativacao(uuid,uuid,text,text,text,uuid,integer,uuid,integer,text,text,timestamptz,timestamptz,uuid,uuid)'::regprocedure::oid);
  if v_definition !~ 'recorded_at<=v_attempted_at'
     or v_definition !~ 'reactivation_attempt_transition_invalid'
     or v_definition !~ '''mensagem_enviada'''
     or v_definition !~ '\mfalse\M'
     or v_definition !~ 'response_snapshot' then
    raise exception 'reactivation_attempt_temporal_or_replay_contract_missing';
  end if;

  foreach v_oid in array array[
    'public.prontuario_substituir_produtos(uuid,uuid,text,text,uuid,integer,jsonb,uuid)'::regprocedure,
    'public.financeiro_criar_compra(uuid,uuid,uuid,date,text,text,smallint,text,text,jsonb,uuid,uuid,numeric,boolean,text,uuid)'::regprocedure,
    'public.financeiro_cancelar_compra(uuid,uuid,uuid,integer,text,uuid,uuid)'::regprocedure,
    'public.financeiro_regularizar_item_compra_estoque(uuid,uuid,uuid,text,date,boolean,uuid,text,uuid)'::regprocedure,
    'public.operacao_registrar_evento_consumo(uuid,uuid,text,text,text,uuid,uuid,uuid,text,numeric,text,text,text,timestamptz,uuid,uuid)'::regprocedure,
    'public.financeiro_editar_produto(uuid,uuid,uuid,integer,uuid,text,text,text,text,text,numeric,numeric,text,boolean,text,uuid)'::regprocedure,
    'public.financeiro_arquivar_produto(uuid,uuid,uuid,integer,text,uuid)'::regprocedure,
    'public.financeiro_restaurar_produto(uuid,uuid,uuid,integer,text,uuid)'::regprocedure
  ] loop
    v_definition:=pg_catalog.pg_get_functiondef(v_oid::oid);
    if pg_catalog.strpos(v_definition,'fase2_lock_stock_ledger')=0
       or pg_catalog.strpos(v_definition,'fase2_lock_stock_ledger')>
          pg_catalog.strpos(v_definition,'_locked_impl') then
      raise exception 'stock_global_lock_missing_or_late:%',v_oid::text;
    end if;
  end loop;
  v_definition:=pg_catalog.pg_get_functiondef('private.financeiro_lock_stock_product()'::regprocedure::oid);
  if v_definition !~ 'financeiro_produtos'
     or v_definition !~ 'financeiro_estoque_movimentos'
     or v_definition !~ 'new.id' or v_definition !~ 'new.product_id' then
    raise exception 'stock_trigger_product_key_invalid';
  end if;

  v_definition:=pg_catalog.pg_get_functiondef(
    'public.prontuario_enfileirar_gc_foto_orfa(uuid,uuid,text,text,uuid,uuid,text,text,text,uuid)'::regprocedure::oid);
  if v_definition !~ 'protocol_photos' or v_definition !~ 'retido_por_referencia'
     or v_definition ~* 'storage\.delete|delete[[:space:]]+from[[:space:]]+storage' then
    raise exception 'photo_gc_reference_guard_invalid';
  end if;

  v_definition:=pg_catalog.pg_get_functiondef(
    'public.gestao_relatorio_acompanhamentos_fase2(uuid,uuid,text,text,text,date,date)'::regprocedure::oid);
  if v_definition !~ 'fase2_suppress_count' or v_definition !~ 'America/Sao_Paulo'
     or v_definition !~ 'protocol_photos' or v_definition !~ '''before'''
     or v_definition !~ '''after''' or v_definition !~ 'clinical_photography'
     or v_definition !~ 'reactivation_contact_attempts'
     or v_definition ~ '''patient_id''|''full_name''|''storage_path''|''url_assinada''|''signature_sha256''' then
    raise exception 'aggregate_report_contract_invalid';
  end if;
end;
$test$;

rollback;

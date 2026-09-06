-- Fix 42703 in draft saves: agendamentos_clinica has no clinic_id.
-- No data rewrite or privilege expansion. Preserve the current draft RPC.
begin;

create or replace function public.prontuario_salvar_rascunho(
  p_clinic_id uuid,
  p_user_id uuid,
  p_actor_role text,
  p_auth_method text,
  p_protocol_id uuid,
  p_expected_version integer,
  p_idempotency_key uuid,
  p_patient_id uuid,
  p_appointment_id uuid,
  p_procedure_kind text,
  p_complaint text,
  p_anamnesis jsonb,
  p_technique_notes text,
  p_procedure_date date,
  p_return_date date,
  p_care_notes text,
  p_products jsonb,
  p_consents jsonb,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_protocol public.protocols%rowtype;
  v_created boolean := false;
  v_product_count integer := 0;
  v_consent_count integer := 0;
  v_previous_id uuid;
  v_previous_version integer;
  v_previous_action text;
  v_procedure_kind text := private.prontuario_normalize_procedure_kind(p_procedure_kind);
  v_complaint text := nullif(pg_catalog.btrim(p_complaint), '');
  v_technique_notes text := nullif(pg_catalog.btrim(p_technique_notes), '');
  v_care_notes text := nullif(pg_catalog.btrim(p_care_notes), '');
begin
  perform private.prontuario_assert_actor(
    p_clinic_id, p_user_id, p_actor_role, p_auth_method,
    array['owner', 'professional']::text[]
  );

  if p_request_id is null or p_patient_id is null
     or p_idempotency_key is null then
    raise exception 'required_parameter_missing' using errcode = '22023';
  end if;

  select entity_id, action, nullif(details ->> 'version', '')::integer
  into v_previous_id, v_previous_action, v_previous_version
  from public.clinic_audit_log
  where clinic_id = p_clinic_id and request_id = p_request_id;

  if found then
    if p_protocol_id is not null
       and v_previous_id = p_protocol_id
       and v_previous_action = 'draft.update' then
      return pg_catalog.jsonb_build_object(
        'id', v_previous_id,
        'version', v_previous_version,
        'created', false,
        'idempotent', true,
        'product_count', 0,
        'consent_count', 0
      );
    end if;
    if p_protocol_id is not null then
      raise exception 'operation_id_reused' using errcode = '22023';
    end if;
  end if;
  if nullif(pg_catalog.btrim(p_procedure_kind), '') is not null and v_procedure_kind is null then
    raise exception 'procedure_kind_invalid' using errcode = '22023';
  end if;
  perform private.prontuario_validate_draft_products(p_clinic_id, p_products);
  if p_anamnesis is null or pg_catalog.jsonb_typeof(p_anamnesis) <> 'object'
     or pg_catalog.pg_column_size(p_anamnesis) > 131072 then
    raise exception 'anamnesis_invalid' using errcode = '22023';
  end if;
  if v_complaint is not null and pg_catalog.char_length(v_complaint) > 2000 then
    raise exception 'complaint_too_long' using errcode = '22023';
  end if;
  if v_technique_notes is not null and pg_catalog.char_length(v_technique_notes) > 5000 then
    raise exception 'technique_notes_too_long' using errcode = '22023';
  end if;
  if v_care_notes is not null and pg_catalog.char_length(v_care_notes) > 5000 then
    raise exception 'care_notes_too_long' using errcode = '22023';
  end if;
  if p_return_date is not null and p_procedure_date is not null
     and p_return_date < p_procedure_date then
    raise exception 'return_date_invalid' using errcode = '22023';
  end if;

  if not exists (
    select 1 from public.patients
    where id = p_patient_id
      and clinic_id = p_clinic_id
      and status = 'active'
      and archived_at is null
  ) then
    raise exception 'patient_not_found' using errcode = 'P0002';
  end if;

  -- The legacy agenda has no clinic_id. Tenant/patient ownership comes from
  -- the explicit confirmed source link, as in the attendance workflow.
  if p_appointment_id is not null then
    if not exists (
      select 1 from public.agendamentos_clinica
      where id = p_appointment_id
    ) then
      raise exception 'appointment_not_found' using errcode = 'P0002';
    end if;
    if not exists (
      select 1 from public.patient_source_links
      where clinic_id = p_clinic_id
        and patient_id = p_patient_id
        and source_kind = 'agendamento'
        and source_id = p_appointment_id
        and status = 'confirmado'
    ) then
      raise exception 'appointment_patient_link_required' using errcode = '23514';
    end if;
  end if;

  if p_protocol_id is null then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        p_clinic_id::text || ':protocol:' || p_idempotency_key::text,
        0
      )
    );

    select *
    into v_protocol
    from public.protocols
    where clinic_id = p_clinic_id
      and idempotency_key = p_idempotency_key
    for update;

    if found then
      if v_protocol.patient_id is distinct from p_patient_id
         or v_protocol.procedure_kind is distinct from v_procedure_kind
         or v_protocol.professional_id is distinct from p_user_id then
        raise exception 'idempotency_key_reused' using errcode = '22023';
      end if;

      return pg_catalog.jsonb_build_object(
        'id', v_protocol.id,
        'version', v_protocol.version,
        'created', false,
        'idempotent', true
      );
    end if;

    insert into public.protocols (
      clinic_id, patient_id, professional_id, appointment_id,
      procedure_kind, complaint, anamnesis, technique_notes,
      procedure_date, return_date, care_notes, status,
      version, updated_by, idempotency_key, draft_products
    ) values (
      p_clinic_id, p_patient_id, p_user_id, p_appointment_id,
      v_procedure_kind, v_complaint, p_anamnesis, v_technique_notes,
      p_procedure_date, p_return_date, v_care_notes, 'draft',
      1, p_user_id, p_idempotency_key, coalesce(p_products, '[]'::jsonb)
    ) returning * into v_protocol;
    v_created := true;
  else
    select *
    into v_protocol
    from public.protocols
    where id = p_protocol_id and clinic_id = p_clinic_id
    for update;

    if not found then
      raise exception 'protocol_not_found' using errcode = 'P0002';
    end if;
    if v_protocol.status <> 'draft' or v_protocol.archived_at is not null then
      raise exception 'protocol_locked' using errcode = '42501';
    end if;
    if p_expected_version is null or v_protocol.version <> p_expected_version then
      raise exception 'version_conflict' using errcode = '40001';
    end if;

    update public.protocols
    set patient_id = p_patient_id,
        appointment_id = p_appointment_id,
        procedure_kind = v_procedure_kind,
        complaint = v_complaint,
        anamnesis = p_anamnesis,
        technique_notes = v_technique_notes,
        procedure_date = p_procedure_date,
        return_date = p_return_date,
        care_notes = v_care_notes,
        draft_products = coalesce(p_products, draft_products),
        updated_by = p_user_id,
        updated_at = pg_catalog.now(),
        version = version + 1
    where id = p_protocol_id and clinic_id = p_clinic_id
    returning * into v_protocol;
  end if;

  v_product_count := coalesce(pg_catalog.jsonb_array_length(v_protocol.draft_products), 0);
  v_consent_count := private.prontuario_append_consents(
    v_protocol.id, p_user_id, p_consents
  );

  perform private.prontuario_log_event(
    p_clinic_id, p_user_id, p_actor_role, p_auth_method,
    'protocol', v_protocol.id,
    case when v_created then 'draft.create' else 'draft.update' end,
    pg_catalog.jsonb_build_object(
      'endpoint', 'prontuario-fichas',
      'operation', case
        when v_consent_count > 0 then 'consent.append'
        else 'draft.save'
      end,
      'version', v_protocol.version,
      'item_count', v_product_count,
      'result_count', v_consent_count,
      'idempotent', false
    ),
    p_request_id
  );

  return pg_catalog.jsonb_build_object(
    'id', v_protocol.id,
    'version', v_protocol.version,
    'created', v_created,
    'idempotent', false,
    'product_count', v_product_count,
    'consent_count', v_consent_count
  );
end;
$function$;

commit;

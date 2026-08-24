-- Integra a visita operacional ao prontuario clinico canonico.
--
-- A preparacao abaixo cria (ou reaproveita) somente um rascunho e o vincula
-- ao atendimento existente. Ela nao altera o status clinico do atendimento,
-- nao registra consentimento e nao cria fotografias. Consentimento, upload e
-- assinatura documental permanecem fluxos protegidos e explicitos.

begin;

-- ---------------------------------------------------------------------------
-- Dominio canonico e extensivel de tipos de procedimento
-- ---------------------------------------------------------------------------

create or replace function private.prontuario_normalize_procedure_kind(p_value text)
returns text
language plpgsql
immutable
strict
set search_path = ''
as $function$
declare
  v_kind text;
begin
  v_kind := pg_catalog.lower(pg_catalog.btrim(p_value));
  v_kind := pg_catalog.translate(
    v_kind,
    'áàâãäéèêëíìîïóòôõöúùûüçñ',
    'aaaaaeeeeiiiiooooouuuucn'
  );
  v_kind := pg_catalog.regexp_replace(v_kind, '[^a-z0-9]+', '_', 'g');
  v_kind := pg_catalog.btrim(v_kind, '_');

  -- Alias somente quando o significado e equivalente. Tipos desconhecidos
  -- conservam seu proprio slug; nunca sao convertidos silenciosamente em
  -- "outro" nem em outro procedimento clinico.
  v_kind := case v_kind
    when 'toxina_botulinica_terco_superior' then 'toxina_terco_superior'
    when 'botox_terco_superior' then 'toxina_terco_superior'
    when 'toxina_botulinica_full_face' then 'toxina_full_face'
    when 'botox_full_face' then 'toxina_full_face'
    when 'bioestimulador_de_colageno' then 'bioestimulador_colageno'
    when 'fios_de_pdo' then 'fios_pdo'
    else v_kind
  end;

  if pg_catalog.char_length(v_kind) not between 2 and 120
     or v_kind !~ '^[a-z0-9]+(_[a-z0-9]+)*$' then
    return null;
  end if;
  return v_kind;
end;
$function$;

revoke all on function private.prontuario_normalize_procedure_kind(text)
  from public, anon, authenticated, service_role;

-- Falha antes de trocar a regra se alguma instalação tiver texto que não possa
-- ser aceito sem reclassificação silenciosa. A correção desses dados precisa
-- ser explícita e revisada fora desta migration.
do $migration$
begin
  if exists (
    select 1
    from public.protocols protocol
    where private.prontuario_normalize_procedure_kind(protocol.procedure_kind) is null
       or protocol.procedure_kind is distinct from
          private.prontuario_normalize_procedure_kind(protocol.procedure_kind)
  ) then
    raise exception 'protocol_procedure_kind_noncanonical'
      using errcode = '23514';
  end if;
end;
$migration$;

-- Esta é a constraint fechada conhecida do schema live. Não remove checks
-- customizados/multicoluna por busca textual.
alter table public.protocols
  drop constraint if exists protocols_procedure_kind_check;
alter table public.protocols
  add constraint protocols_procedure_kind_check check (
    private.prontuario_normalize_procedure_kind(procedure_kind) is not null
    and procedure_kind = private.prontuario_normalize_procedure_kind(procedure_kind)
  ) not valid;
alter table public.protocols
  validate constraint protocols_procedure_kind_check;

comment on constraint protocols_procedure_kind_check on public.protocols is
  'Tipo clinico em slug normalizado; preserva procedimentos fora da lista historica sem reclassifica-los como outro.';

-- O catálogo financeiro já usa "aplicacao" como unidade. Mantém o mesmo
-- domínio no Edge, na função de substituição e na constraint material.
alter table public.protocol_products
  drop constraint if exists protocol_products_unit_check;
alter table public.protocol_products
  add constraint protocol_products_unit_check check (
    unit in (
      'U', 'mL', 'mg', 'g', 'un.', 'un', 'cx', 'frasco', 'ampola',
      'seringa', 'canula', 'kit', 'dose', 'aplicacao'
    )
  );

create or replace function private.prontuario_replace_products(
  p_protocol_id uuid,
  p_clinic_id uuid,
  p_products jsonb
)
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_status text;
  v_archived_at timestamptz;
  v_procedure_date date;
  v_item jsonb;
  v_ordinality bigint;
  v_product_id uuid;
  v_lot text;
  v_expiry date;
  v_amount numeric(14,4);
  v_unit text;
  v_position smallint;
  v_product public.financeiro_produtos%rowtype;
  v_brand_name text;
  v_count integer := 0;
begin
  if jsonb_typeof(p_products) <> 'array'
     or jsonb_array_length(p_products) > 50 then
    raise exception 'products_invalid' using errcode = '22023';
  end if;

  select status, archived_at, procedure_date
  into v_status, v_archived_at, v_procedure_date
  from public.protocols
  where id = p_protocol_id and clinic_id = p_clinic_id
  for update;

  if not found then
    raise exception 'protocol_not_found' using errcode = 'P0002';
  end if;
  if v_status <> 'draft' or v_archived_at is not null then
    raise exception 'protocol_products_locked' using errcode = '42501';
  end if;

  delete from public.protocol_products where protocol_id = p_protocol_id;

  for v_item, v_ordinality in
    select value, ordinality
    from jsonb_array_elements(p_products) with ordinality
  loop
    begin
      v_product_id := (v_item ->> 'product_id')::uuid;
      v_lot := nullif(btrim(v_item ->> 'lot'), '');
      v_expiry := (v_item ->> 'expiry')::date;
      v_amount := (v_item ->> 'amount')::numeric(14,4);
      v_unit := nullif(btrim(v_item ->> 'unit'), '');
      v_position := coalesce(
        nullif(v_item ->> 'position', '')::smallint,
        v_ordinality::smallint
      );
    exception when others then
      raise exception 'product_item_invalid' using errcode = '22023';
    end;

    if v_product_id is null or v_lot is null
       or char_length(v_lot) > 100
       or v_expiry is null
       or (v_procedure_date is not null and v_expiry < v_procedure_date)
       or v_amount is null or v_amount <= 0 or v_amount > 1000000
       or v_unit not in (
         'U', 'mL', 'mg', 'g', 'un.', 'un', 'cx', 'frasco', 'ampola',
         'seringa', 'canula', 'kit', 'dose', 'aplicacao'
       )
       or v_position not between 1 and 100 then
      raise exception 'product_item_invalid' using errcode = '22023';
    end if;

    select *
    into v_product
    from public.financeiro_produtos
    where id = v_product_id
      and clinic_id = p_clinic_id
      and active = true
      and archived_at is null;

    if not found then
      raise exception 'catalog_product_not_found' using errcode = 'P0002';
    end if;

    v_brand_name := null;
    if v_product.brand_id is not null then
      select name
      into v_brand_name
      from public.financeiro_marcas
      where id = v_product.brand_id
        and clinic_id = p_clinic_id
        and active = true
        and archived_at is null;

      if not found then
        raise exception 'catalog_brand_not_found' using errcode = 'P0002';
      end if;
    end if;

    insert into public.protocol_products (
      protocol_id, product_id, brand_id,
      product_name_snapshot, brand_name_snapshot,
      anvisa_registration_snapshot, lot, expiry, amount, unit,
      cost_snapshot, position
    ) values (
      p_protocol_id, v_product.id, v_product.brand_id,
      v_product.name, v_brand_name, v_product.anvisa_registration,
      v_lot, v_expiry, v_amount, v_unit,
      v_product.reference_cost, v_position
    );

    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$function$;

revoke all on function private.prontuario_replace_products(uuid,uuid,jsonb)
  from public, anon, authenticated, service_role;

-- O editor de prontuario passa a aceitar o mesmo dominio normalizado. O
-- restante do contrato, incluindo produtos, consentimentos e auditoria,
-- permanece identico ao RPC original.
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
  if v_procedure_kind is null then
    raise exception 'procedure_kind_invalid' using errcode = '22023';
  end if;
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

  if p_appointment_id is not null and not exists (
    select 1 from public.agendamentos_clinica
    where id = p_appointment_id and clinic_id = p_clinic_id
  ) then
    raise exception 'appointment_not_found' using errcode = 'P0002';
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
      version, updated_by, idempotency_key
    ) values (
      p_clinic_id, p_patient_id, p_user_id, p_appointment_id,
      v_procedure_kind, v_complaint, p_anamnesis, v_technique_notes,
      p_procedure_date, p_return_date, v_care_notes, 'draft',
      1, p_user_id, p_idempotency_key
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
        updated_by = p_user_id,
        updated_at = pg_catalog.now(),
        version = version + 1
    where id = p_protocol_id and clinic_id = p_clinic_id
    returning * into v_protocol;
  end if;

  if p_products is not null then
    v_product_count := private.prontuario_replace_products(
      v_protocol.id, p_clinic_id, p_products
    );
  end if;
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

revoke all on function public.prontuario_salvar_rascunho(
  uuid,uuid,text,text,uuid,integer,uuid,uuid,uuid,text,text,jsonb,text,date,date,text,jsonb,jsonb,uuid
) from public, anon, authenticated;
grant execute on function public.prontuario_salvar_rascunho(
  uuid,uuid,text,text,uuid,integer,uuid,uuid,uuid,text,text,jsonb,text,date,date,text,jsonb,jsonb,uuid
) to service_role;

-- ---------------------------------------------------------------------------
-- Galeria canonica e resumo leve para carregamento sob demanda
-- ---------------------------------------------------------------------------

create or replace view public.operacao_atendimento_fotos
with (security_invoker = true)
as
select
  photo.id,
  protocol.clinic_id,
  protocol.patient_id,
  attendance.id as attendance_id,
  photo.procedure_item_id,
  photo.id as photo_id,
  case photo.phase
    when 'before' then 'antes'
    when 'during' then 'durante'
    when 'after' then 'depois'
    when 'products_used' then 'produtos_utilizados'
    else 'durante_legado'
  end as category,
  photo.taken_at as captured_at,
  photo.operation_display_order as display_order,
  photo.operation_caption as caption,
  photo.storage_path,
  photo.mime_type,
  photo.size_bytes,
  photo.sha256,
  photo.thumbnail_storage_path,
  photo.thumbnail_mime_type,
  photo.thumbnail_size_bytes,
  photo.thumbnail_sha256,
  uploader.actor as uploader_id,
  photo.archived_at,
  photo.operation_version as version,
  photo.product_id,
  photo.lot_snapshot,
  photo.consumption_event_id,
  photo.protocol_id
from public.protocol_photos photo
join public.protocols protocol on protocol.id = photo.protocol_id
join lateral (
  select visit.id, visit.archived_at, visit.created_at
  from public.atendimentos_realizados visit
  where visit.clinic_id = protocol.clinic_id
    and visit.protocol_id = protocol.id
    and (photo.attendance_id is null or visit.id = photo.attendance_id)
  order by (visit.archived_at is null) desc, visit.created_at, visit.id
  limit 1
) attendance on true
left join lateral (
  select audit.actor
  from public.clinic_audit_log audit
  where audit.clinic_id = protocol.clinic_id
    and audit.entity = 'protocol_photo'
    and audit.entity_id = photo.id
    and audit.action = 'photo.add'
  order by audit.created_at, audit.id
  limit 1
) uploader on true;

create or replace view public.operacao_consulta_prontuario_resumo
with (security_invoker = true)
as
select
  attendance.clinic_id,
  attendance.id as attendance_id,
  protocol.id as protocol_id,
  protocol.status as protocol_status,
  protocol.version as protocol_version,
  coalesce(photo.active_photo_count, 0)::integer as active_photo_count,
  coalesce(photo.active_clinical_count, 0)::integer as active_clinical_count,
  coalesce(photo.active_product_count, 0)::integer as active_product_count,
  coalesce(photo.archived_photo_count, 0)::integer as archived_photo_count,
  coalesce(consent.clinical_photography_consented, false) as clinical_photography_consented
from public.atendimentos_realizados attendance
left join public.protocols protocol
  on protocol.id = attendance.protocol_id
 and protocol.clinic_id = attendance.clinic_id
left join lateral (
  select
    pg_catalog.count(*) filter (
      where item.archived_at is null
    )::integer as active_photo_count,
    pg_catalog.count(*) filter (
      where item.archived_at is null
        and item.phase in ('before', 'during', 'after')
    )::integer as active_clinical_count,
    pg_catalog.count(*) filter (
      where item.archived_at is null and item.phase = 'products_used'
    )::integer as active_product_count,
    pg_catalog.count(*) filter (
      where item.archived_at is not null
    )::integer as archived_photo_count
  from public.protocol_photos item
  where item.protocol_id = protocol.id
) photo on true
left join lateral (
  select coalesce(pg_catalog.bool_or(
    current_consent.kind = 'clinical_photography'
    and current_consent.accepted
    and current_consent.revoked_at is null
  ), false) as clinical_photography_consented
  from public.protocol_consent_current current_consent
  where current_consent.protocol_id = protocol.id
) consent on true;

revoke all on public.operacao_atendimento_fotos
  from public, anon, authenticated, service_role;
revoke all on public.operacao_consulta_prontuario_resumo
  from public, anon, authenticated, service_role;
grant select on public.operacao_atendimento_fotos to service_role;
grant select on public.operacao_consulta_prontuario_resumo to service_role;

comment on view public.operacao_consulta_prontuario_resumo is
  'Resumo leve da consulta: products_used e contado separadamente e nunca satisfaz active_clinical_count.';

-- ---------------------------------------------------------------------------
-- Acao protegida e idempotente: atendimento -> protocolo draft
-- ---------------------------------------------------------------------------

create or replace function public.operacao_preparar_prontuario_atendimento(
  p_clinic_id uuid,
  p_user_id uuid,
  p_actor_role text,
  p_auth_method text,
  p_aal text,
  p_attendance_id uuid,
  p_expected_version integer,
  p_idempotency_key uuid,
  p_reason text,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_attendance public.atendimentos_realizados%rowtype;
  v_protocol public.protocols%rowtype;
  v_source_kind text;
  v_procedure_kind text;
  v_reason text := pg_catalog.btrim(coalesce(p_reason, ''));
  v_fingerprint text;
  v_created boolean := false;
  v_reused boolean := false;
begin
  perform private.operacao_assert_owner(
    p_clinic_id, p_user_id, p_actor_role, p_auth_method, p_aal
  );
  if p_attendance_id is null or p_idempotency_key is null
     or p_request_id is null or p_expected_version is null
     or p_expected_version < 1 then
    raise exception 'required_parameter_missing' using errcode = '22023';
  end if;
  if pg_catalog.char_length(v_reason) not between 3 and 500 then
    raise exception 'reason_required' using errcode = '22023';
  end if;

  v_fingerprint := pg_catalog.md5(
    pg_catalog.jsonb_build_array(p_attendance_id)::text
  );
  if private.operacao_replay_guard(
    p_clinic_id, p_request_id, 'attendance', p_attendance_id,
    'attendance.protocol_prepare', v_fingerprint
  ) then
    select * into v_attendance
    from public.atendimentos_realizados
    where clinic_id = p_clinic_id and id = p_attendance_id;
    if not found then
      raise exception 'attendance_not_found' using errcode = 'P0002';
    end if;
    if v_attendance.protocol_id is null then
      raise exception 'attendance_protocol_required' using errcode = '23514';
    end if;
    select * into v_protocol
    from public.protocols
    where clinic_id = p_clinic_id and id = v_attendance.protocol_id;
    if not found then
      raise exception 'protocol_not_found' using errcode = 'P0002';
    end if;
    return pg_catalog.jsonb_build_object(
      'attendance_id', v_attendance.id,
      'attendance_version', v_attendance.version,
      'protocol_id', v_protocol.id,
      'protocol_version', v_protocol.version,
      'protocol_status', v_protocol.status,
      'procedure_kind', v_protocol.procedure_kind,
      'created', false,
      'reused', true,
      'linked', false,
      'idempotent', true
    );
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      p_clinic_id::text || ':attendance-protocol-prepare:' || p_attendance_id::text,
      0
    )
  );
  select * into v_attendance
  from public.atendimentos_realizados
  where clinic_id = p_clinic_id and id = p_attendance_id
  for update;
  if not found then
    raise exception 'attendance_not_found' using errcode = 'P0002';
  end if;
  if v_attendance.archived_at is not null then
    raise exception 'attendance_archived' using errcode = '42501';
  end if;

  select item.procedure_kind into v_source_kind
  from public.atendimento_procedimentos item
  where item.clinic_id = p_clinic_id
    and item.attendance_id = p_attendance_id
    and item.is_primary
    and item.archived_at is null
  order by item.created_at, item.id
  limit 1;
  v_source_kind := coalesce(v_source_kind, v_attendance.procedure_kind);
  v_procedure_kind := private.prontuario_normalize_procedure_kind(v_source_kind);
  if v_procedure_kind is null then
    raise exception 'procedure_kind_invalid' using errcode = '22023';
  end if;

  -- Uma repeticao depois do commit, mesmo com nova prova de senha, devolve o
  -- vinculo material existente e jamais cria um segundo prontuario.
  if v_attendance.protocol_id is not null then
    select * into v_protocol
    from public.protocols
    where clinic_id = p_clinic_id and id = v_attendance.protocol_id
    for update;
    if not found then
      raise exception 'protocol_not_found' using errcode = 'P0002';
    end if;
    if v_protocol.archived_at is not null
       or v_protocol.patient_id is distinct from v_attendance.patient_id
       or v_protocol.professional_id is distinct from v_attendance.responsible_user_id
       or v_protocol.appointment_id is distinct from v_attendance.appointment_id
       or v_protocol.procedure_date is distinct from
          (v_attendance.attended_at at time zone 'America/Sao_Paulo')::date
       or v_protocol.procedure_kind is distinct from v_procedure_kind then
      raise exception 'attendance_protocol_mismatch' using errcode = '23514';
    end if;
    perform private.prontuario_log_event(
      p_clinic_id, p_user_id, p_actor_role, p_auth_method,
      'attendance', v_attendance.id, 'attendance.protocol_prepare',
      pg_catalog.jsonb_build_object(
        'endpoint', 'operacao-clinica-fichas',
        'operation', 'protocol.prepare',
        'target_kind', 'protocol_existing',
        'reason_code', 'owner_prepared_protocol',
        'result_count', 0,
        'idempotent', true,
        'version', v_protocol.version,
        'previous_status', 'linked',
        'new_status', 'linked',
        'route', v_fingerprint
      ),
      p_request_id
    );
    return pg_catalog.jsonb_build_object(
      'attendance_id', v_attendance.id,
      'attendance_version', v_attendance.version,
      'protocol_id', v_protocol.id,
      'protocol_version', v_protocol.version,
      'protocol_status', v_protocol.status,
      'procedure_kind', v_protocol.procedure_kind,
      'created', false,
      'reused', true,
      'linked', false,
      'idempotent', true
    );
  end if;

  if v_attendance.version <> p_expected_version then
    raise exception 'version_conflict' using errcode = '40001';
  end if;
  if v_attendance.responsible_user_id is null or not exists (
    select 1 from public.clinic_members member
    where member.clinic_id = p_clinic_id
      and member.user_id = v_attendance.responsible_user_id
      and member.status = 'active'
      and member.role in ('owner', 'professional')
  ) then
    raise exception 'attendance_professional_required' using errcode = '23514';
  end if;
  if not exists (
    select 1 from public.patients patient
    where patient.clinic_id = p_clinic_id
      and patient.id = v_attendance.patient_id
      and patient.status = 'active'
      and patient.archived_at is null
  ) then
    raise exception 'patient_not_found' using errcode = 'P0002';
  end if;

  -- Somente a mesma chave de idempotencia pode reaproveitar um rascunho ainda
  -- nao ligado. Coincidencia de paciente/data/tipo nao une consultas reais.
  select * into v_protocol
  from public.protocols
  where clinic_id = p_clinic_id and idempotency_key = p_idempotency_key
  for update;
  if found then
    if v_protocol.status <> 'draft' or v_protocol.archived_at is not null
       or v_protocol.patient_id is distinct from v_attendance.patient_id
       or v_protocol.professional_id is distinct from v_attendance.responsible_user_id
       or v_protocol.appointment_id is distinct from v_attendance.appointment_id
       or v_protocol.procedure_date is distinct from
          (v_attendance.attended_at at time zone 'America/Sao_Paulo')::date
       or v_protocol.procedure_kind is distinct from v_procedure_kind
       or exists (
         select 1 from public.atendimentos_realizados other_attendance
         where other_attendance.protocol_id = v_protocol.id
           and other_attendance.id <> p_attendance_id
       ) then
      raise exception 'idempotency_key_reused' using errcode = '23505';
    end if;
    v_reused := true;
  else
    insert into public.protocols (
      clinic_id, patient_id, professional_id, appointment_id,
      procedure_kind, complaint, anamnesis, technique_notes,
      procedure_date, return_date, care_notes, status,
      version, updated_by, idempotency_key
    ) values (
      p_clinic_id, v_attendance.patient_id, v_attendance.responsible_user_id,
      v_attendance.appointment_id, v_procedure_kind,
      null, '{}'::jsonb, null,
      (v_attendance.attended_at at time zone 'America/Sao_Paulo')::date,
      null, null, 'draft', 1, p_user_id, p_idempotency_key
    ) returning * into v_protocol;
    v_created := true;
  end if;

  update public.atendimentos_realizados
  set protocol_id = v_protocol.id,
      version = version + 1,
      updated_by = p_user_id,
      updated_at = pg_catalog.now()
  where clinic_id = p_clinic_id
    and id = p_attendance_id
    and protocol_id is null
  returning * into v_attendance;
  if not found then
    raise exception 'attendance_link_exists' using errcode = '23505';
  end if;

  perform private.prontuario_log_event(
    p_clinic_id, p_user_id, p_actor_role, p_auth_method,
    'attendance', v_attendance.id, 'attendance.protocol_prepare',
    pg_catalog.jsonb_build_object(
      'endpoint', 'operacao-clinica-fichas',
      'operation', 'protocol.prepare',
      'target_kind', case when v_created then 'protocol_draft_created'
        else 'protocol_draft_reused' end,
      'reason_code', 'owner_prepared_protocol',
      'result_count', 1,
      'idempotent', false,
      'version', v_protocol.version,
      'previous_status', 'unlinked',
      'new_status', 'linked',
      'route', v_fingerprint
    ),
    p_request_id
  );

  return pg_catalog.jsonb_build_object(
    'attendance_id', v_attendance.id,
    'attendance_version', v_attendance.version,
    'protocol_id', v_protocol.id,
    'protocol_version', v_protocol.version,
    'protocol_status', v_protocol.status,
    'procedure_kind', v_protocol.procedure_kind,
    'created', v_created,
    'reused', v_reused,
    'linked', true,
    'idempotent', false
  );
end;
$function$;

revoke all on function public.operacao_preparar_prontuario_atendimento(
  uuid,uuid,text,text,text,uuid,integer,uuid,text,uuid
) from public, anon, authenticated;
grant execute on function public.operacao_preparar_prontuario_atendimento(
  uuid,uuid,text,text,text,uuid,integer,uuid,text,uuid
) to service_role;

comment on function public.operacao_preparar_prontuario_atendimento(
  uuid,uuid,text,text,text,uuid,integer,uuid,text,uuid
) is
  'Cria/reaproveita um draft e o vincula atomicamente a visita; nao altera status, consentimentos, fotos ou assinatura.';

commit;

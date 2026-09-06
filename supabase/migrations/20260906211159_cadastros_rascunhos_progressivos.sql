-- Progressive drafts remain in their canonical record. No placeholder clinical facts.
-- Existing catalog records are not reclassified by this migration.
begin;

alter table public.financeiro_produtos
  alter column product_type drop not null,
  alter column unit drop not null,
  add column registration_status text not null default 'complete'
    check (registration_status in ('draft','complete')),
  add constraint financeiro_product_draft_inactive
    check (registration_status <> 'draft' or active = false);
comment on column public.financeiro_produtos.registration_status is
  'Drafts are incomplete and inactive. Complete the same ID before any purchase or consumption.';

create or replace function private.financeiro_product_draft_guard()
returns trigger language plpgsql set search_path='' as $function$
declare v_complete boolean;
begin
  new.product_type := nullif(btrim(new.product_type), '');
  new.unit := nullif(btrim(new.unit), '');
  new.presentation := nullif(btrim(new.presentation), '');
  v_complete := new.product_type is not null and new.unit is not null
    and new.presentation is not null;
  if tg_op = 'INSERT' or old.registration_status = 'draft' then
    new.registration_status := case when v_complete then 'complete' else 'draft' end;
    if not v_complete then new.active := false;
    elsif tg_op = 'UPDATE' and old.registration_status = 'draft'
      and new.archived_at is null then new.active := true; end if;
  elsif not v_complete and (
    new.product_type is distinct from old.product_type
    or new.unit is distinct from old.unit
    or new.presentation is distinct from old.presentation
  ) then
    raise exception 'product_essentials_required' using errcode='23514';
  end if;
  if new.registration_status = 'draft' then new.active := false; end if;
  return new;
end; $function$;
revoke all on function private.financeiro_product_draft_guard() from public,anon,authenticated,service_role;
create trigger financeiro_produtos_01_draft
before insert or update on public.financeiro_produtos
for each row execute function private.financeiro_product_draft_guard();

create or replace function private.financeiro_sync_product_dedup()
returns trigger language plpgsql set search_path = '' as $function$
declare v_key text; v_possible text; v_existing uuid;
begin
  v_key := private.financeiro_product_exact_key(
    new.id, new.brand_id, new.name, new.presentation, new.unit, new.ean,
    new.anvisa_registration
  );
  v_possible := case
    when new.brand_id is null or private.financeiro_normalize_identity(new.name) = '' then null
    else 'product:' || pg_catalog.md5(pg_catalog.jsonb_build_array(
      new.brand_id, private.financeiro_normalize_identity(new.name),
      private.financeiro_normalize_identity(new.unit)
    )::text)
  end;
  if tg_op = 'INSERT' or v_key is distinct from old.dedup_exact_key then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      new.clinic_id::text || ':produto:' || v_key, 0
    ));
    select id into v_existing from public.financeiro_produtos
    where clinic_id = new.clinic_id and dedup_exact_key = v_key
      and id is distinct from new.id order by created_at, id limit 1;
    if found then
      raise exception using errcode = '23505', message = 'exact_duplicate',
        detail = v_existing::text;
    end if;
    new.dedup_enforced := true;
  end if;
  if v_possible is not null then
    select id into v_existing from public.financeiro_produtos
    where clinic_id = new.clinic_id and dedup_possible_key = v_possible
      and id is distinct from new.id order by created_at, id limit 1;
    if found then
      insert into public.clinic_duplicate_reviews (
        clinic_id, entity_kind, primary_id, candidate_id,
        match_kind, match_key_hash, reason_code
      ) values (
        new.clinic_id, 'produto', v_existing, new.id, 'possible',
        'md5:' || pg_catalog.md5(v_possible), 'possible_brand_name_unit'
      ) on conflict do nothing;
    end if;
  end if;
  new.dedup_exact_key := v_key;
  new.dedup_possible_key := v_possible;
  return new;
end;
$function$;

create or replace function public.fase2_financeiro_editar_produto_locked_impl(
  p_clinic_id uuid, p_user_id uuid, p_product_id uuid, p_expected_version integer,
  p_brand_id uuid, p_name text, p_product_type text, p_unit text,
  p_presentation text, p_ean text, p_reference_cost numeric,
  p_sale_price numeric, p_anvisa_registration text,
  p_stock_control boolean, p_reason text, p_request_id uuid
)
returns jsonb
language plpgsql
set search_path = ''
as $function$
declare
  v_row public.financeiro_produtos%rowtype;
  v_reason text := private.financeiro_operation_reason(p_reason);
  v_presentation text := nullif(pg_catalog.btrim(p_presentation), '');
  v_ean text := nullif(pg_catalog.regexp_replace(
    coalesce(p_ean, ''), '[^0-9]+', '', 'g'
  ), '');
begin
  if char_length(v_presentation) > 160
     or (v_ean is not null and char_length(v_ean) not between 8 and 14) then
    raise exception 'product_presentation_invalid' using errcode = '22023';
  end if;
  select * into v_row
  from public.financeiro_produtos
  where clinic_id = p_clinic_id and id = p_product_id
  for update;
  if not found then
    raise exception 'produto_nao_encontrado' using errcode = 'P0002';
  end if;
  if v_row.version <> p_expected_version then
    raise exception 'version_conflict' using errcode = '40001';
  end if;
  if v_row.archived_at is not null then
    raise exception 'registro_arquivado' using errcode = '55000';
  end if;
  if p_brand_id is not null and not exists (
    select 1 from public.financeiro_marcas
    where clinic_id = p_clinic_id and id = p_brand_id
      and active and archived_at is null
  ) then
    raise exception 'marca_invalida' using errcode = '23503';
  end if;

  if exists (
    select 1
    from public.financeiro_estoque_movimentos movement
    where movement.clinic_id = p_clinic_id
      and movement.product_id = p_product_id
  ) and (
    p_unit is distinct from v_row.unit
    or p_stock_control is distinct from v_row.stock_control
  ) then
    raise exception 'stock_product_configuration_locked'
      using errcode = '55000';
  end if;

  update public.financeiro_produtos
  set brand_id = p_brand_id,
      name = pg_catalog.btrim(p_name),
      product_type = p_product_type,
      unit = p_unit,
      presentation = v_presentation,
      ean = v_ean,
      reference_cost = p_reference_cost,
      sale_price = p_sale_price,
      anvisa_registration = nullif(pg_catalog.btrim(p_anvisa_registration), ''),
      stock_control = p_stock_control,
      updated_by = p_user_id
  where clinic_id = p_clinic_id and id = p_product_id
  returning * into v_row;

  insert into public.financeiro_auditoria (
    clinic_id, actor_id, entity, entity_id, action, details, request_id
  ) values (
    p_clinic_id, p_user_id, 'produto', p_product_id, 'editado',
    pg_catalog.jsonb_build_object(
      'operation', 'edit', 'version', v_row.version, 'reason', v_reason
    ),
    p_request_id
  );
  return pg_catalog.to_jsonb(v_row);
end;
$function$;

-- Defense in depth: a draft cannot be inserted into operational ledgers even
-- through a different RPC or a future UI that forgets to filter active=false.
create or replace function private.financeiro_require_complete_product()
returns trigger language plpgsql set search_path='' as $function$
begin
  if exists(select 1 from public.financeiro_produtos
    where id=new.product_id and registration_status='draft') then
    raise exception 'catalog_product_incomplete' using errcode='23514';
  end if;
  return new;
end; $function$;
revoke all on function private.financeiro_require_complete_product() from public,anon,authenticated,service_role;
create trigger financeiro_compra_itens_draft_guard before insert or update of product_id on public.financeiro_compra_itens
for each row execute function private.financeiro_require_complete_product();
create trigger financeiro_estoque_lotes_draft_guard before insert or update of product_id on public.financeiro_estoque_lotes
for each row execute function private.financeiro_require_complete_product();
create trigger financeiro_estoque_movimentos_draft_guard before insert on public.financeiro_estoque_movimentos
for each row execute function private.financeiro_require_complete_product();
create trigger protocol_products_draft_guard before insert or update of product_id on public.protocol_products
for each row execute function private.financeiro_require_complete_product();
create trigger operacao_consumo_eventos_draft_guard before insert on public.operacao_consumo_eventos
for each row execute function private.financeiro_require_complete_product();

alter table public.protocols
  alter column procedure_kind drop not null,
  alter column procedure_date drop not null,
  add column draft_products jsonb,
  drop constraint protocols_procedure_kind_check;
alter table public.protocols add constraint protocols_procedure_kind_check check(
  (procedure_kind is null and status='draft') or
  (private.prontuario_normalize_procedure_kind(procedure_kind) is not null
    and procedure_kind=private.prontuario_normalize_procedure_kind(procedure_kind))
);
-- NOT VALID avoids rewriting/reinterpreting legacy signed records. All new
-- writes and finalizations enforce genuine clinical essentials.
alter table public.protocols add constraint protocols_complete_essentials check(
  status='draft' or (procedure_kind is not null and procedure_date is not null)
) not valid;
alter table public.protocols add constraint protocols_draft_products_shape check(
  draft_products is null or (jsonb_typeof(draft_products)='array'
    and jsonb_array_length(draft_products)<=50 and pg_column_size(draft_products)<=32768)
);
comment on column public.protocols.draft_products is
  'Pending product form rows, including incomplete rows. No stock effect until explicit finalization. NULL retains legacy materialized products.';

create or replace function private.prontuario_validate_draft_products(p_clinic_id uuid,p_products jsonb)
returns void language plpgsql set search_path='' as $function$
declare v_item jsonb; v_key text; v_id uuid; v_amount numeric; v_date date;
begin
  if p_products is null then return; end if;
  if jsonb_typeof(p_products)<>'array' or jsonb_array_length(p_products)>50
     or pg_column_size(p_products)>32768 then
    raise exception 'products_invalid' using errcode='22023';
  end if;
  for v_item in select value from jsonb_array_elements(p_products) loop
    if jsonb_typeof(v_item)<>'object' then raise exception 'product_item_invalid' using errcode='22023'; end if;
    for v_key in select jsonb_object_keys(v_item) loop
      if v_key not in ('product_id','lot','expiry','amount','unit','position') then
        raise exception 'product_item_invalid' using errcode='22023';
      end if;
      if jsonb_typeof(v_item->v_key) not in ('string','number','null') then
        raise exception 'product_item_invalid' using errcode='22023';
      end if;
    end loop;
    if char_length(coalesce(v_item->>'lot',''))>100 or (v_item->>'lot') ~ '[[:cntrl:]]'
       or char_length(coalesce(v_item->>'unit',''))>20 then
      raise exception 'product_item_invalid' using errcode='22023';
    end if;
    begin
      v_id := nullif(v_item->>'product_id','')::uuid;
      v_amount := nullif(v_item->>'amount','')::numeric;
      v_date := nullif(v_item->>'expiry','')::date;
    exception when others then raise exception 'product_item_invalid' using errcode='22023'; end;
    if v_amount is not null and (v_amount<=0 or v_amount>1000000 or v_amount::text='NaN') then
      raise exception 'product_item_invalid' using errcode='22023';
    end if;
    if nullif(v_item->>'unit','') is not null and v_item->>'unit' not in
      ('U','mL','mg','g','un.','un','cx','frasco','ampola','seringa','canula','kit','dose','aplicacao') then
      raise exception 'product_item_invalid' using errcode='22023';
    end if;
    if v_id is not null and not exists(
      select 1 from public.financeiro_produtos where clinic_id=p_clinic_id and id=v_id
      and active and archived_at is null and registration_status='complete'
    ) then raise exception 'catalog_product_not_found' using errcode='P0002'; end if;
  end loop;
end; $function$;
revoke all on function private.prontuario_validate_draft_products(uuid,jsonb) from public,anon,authenticated,service_role;

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

create or replace function public.prontuario_salvar_rascunho_com_estoque(
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
begin
  -- Compatibility name only: a draft never materializes products or moves stock.
  return public.prontuario_salvar_rascunho(
    p_clinic_id, p_user_id, p_actor_role, p_auth_method,
    p_protocol_id, p_expected_version, p_idempotency_key,
    p_patient_id, p_appointment_id, p_procedure_kind,
    p_complaint, p_anamnesis, p_technique_notes,
    p_procedure_date, p_return_date, p_care_notes,
    p_products, p_consents, p_request_id
  );
end;
$function$;

create or replace function public.prontuario_finalizar(
  p_clinic_id uuid,
  p_user_id uuid,
  p_actor_role text,
  p_auth_method text,
  p_protocol_id uuid,
  p_expected_version integer,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_protocol public.protocols%rowtype;
  v_previous record;
  v_clinical_photo_count integer;
  v_guard text;
begin
  perform private.prontuario_assert_actor(
    p_clinic_id, p_user_id, p_actor_role, p_auth_method,
    array['owner', 'professional']::text[]
  );
  if p_protocol_id is null or p_expected_version is null
     or p_expected_version < 1 or p_request_id is null then
    raise exception 'required_parameter_missing' using errcode = '22023';
  end if;

  -- Serializa repeticoes simultaneas da mesma operacao antes de consultar a
  -- trilha append-only, evitando que um retry concorra com o primeiro INSERT.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      p_clinic_id::text || ':protocol-finalize:' || p_request_id::text,
      0
    )
  );

  select audit.entity, audit.entity_id, audit.action, audit.details
  into v_previous
  from public.clinic_audit_log audit
  where audit.clinic_id = p_clinic_id
    and audit.request_id = p_request_id;

  if found then
    if v_previous.entity = 'protocol'
       and v_previous.entity_id = p_protocol_id
       and v_previous.action = 'finalize' then
      return pg_catalog.jsonb_build_object(
        'id', p_protocol_id,
        'status', coalesce(v_previous.details ->> 'new_status', 'signed'),
        'version', nullif(v_previous.details ->> 'version', '')::integer,
        'idempotent', true
      );
    end if;
    raise exception 'operation_id_reused' using errcode = '22023';
  end if;

  -- Same stock-ledger-before-protocol lock order as stock RPCs.
  perform private.fase2_lock_stock_ledger(p_clinic_id);
  select protocol.*
  into v_protocol
  from public.protocols protocol
  where protocol.id = p_protocol_id
    and protocol.clinic_id = p_clinic_id
  for update;

  if not found then
    raise exception 'protocol_not_found' using errcode = 'P0002';
  end if;

  -- Arquivamento prevalece sobre idempotencia por estado: um protocolo fora
  -- do fluxo ativo nunca pode ser finalizado, mesmo que ja esteja assinado.
  if v_protocol.archived_at is not null then
    raise exception 'protocol_archived' using errcode = '42501';
  end if;

  -- A operacao e idempotente por estado, alem de ser idempotente por
  -- request_id. Um novo retry de um protocolo ativo ja assinado nao altera versao.
  if v_protocol.status = 'signed' then
    perform private.prontuario_log_event(
      p_clinic_id, p_user_id, p_actor_role, p_auth_method,
      'protocol', p_protocol_id, 'finalize',
      pg_catalog.jsonb_build_object(
        'endpoint', 'prontuario-fichas',
        'new_status', 'signed',
        'version', v_protocol.version,
        'idempotent', true
      ),
      p_request_id
    );
    return pg_catalog.jsonb_build_object(
      'id', v_protocol.id,
      'status', 'signed',
      'version', v_protocol.version,
      'idempotent', true
    );
  end if;

  if v_protocol.status <> 'draft' then
    raise exception 'protocol_locked' using errcode = '42501';
  end if;
  if v_protocol.version <> p_expected_version then
    raise exception 'version_conflict' using errcode = '40001';
  end if;

  if v_protocol.procedure_kind is null or v_protocol.procedure_date is null then
    raise exception 'protocol_essentials_required' using errcode = '23514';
  end if;

  if coalesce((
    select consent.accepted and consent.revoked_at is null
    from public.protocol_consents consent
    where consent.protocol_id = p_protocol_id
      and consent.kind = 'clinical_photography'
    order by consent.recorded_at desc, consent.id desc
    limit 1
  ), false) is not true then
    raise exception 'clinical_photography_consent_required'
      using errcode = '42501';
  end if;

  select pg_catalog.count(*)::integer
  into v_clinical_photo_count
  from public.protocol_photos photo
  join storage.objects stored_object
    on stored_object.bucket_id = 'clinic-media'
   and stored_object.name = photo.storage_path
  where photo.protocol_id = p_protocol_id
    and photo.archived_at is null
    and photo.phase in ('before', 'during', 'after');

  if v_clinical_photo_count < 1 then
    raise exception 'clinical_photo_required' using errcode = '23514';
  end if;

  if v_protocol.draft_products is not null then
    -- Strict validation, stock and signature share the same transaction: on any
    -- failure the draft and ledger remain unchanged.
    perform public.prontuario_substituir_produtos(
      p_clinic_id, p_user_id, p_actor_role, p_auth_method,
      p_protocol_id, v_protocol.version, v_protocol.draft_products,
      private.financeiro_estoque_request_id(p_request_id, 'finalize-products')
    );
    select * into v_protocol from public.protocols
      where id = p_protocol_id and clinic_id = p_clinic_id;
  end if;

  v_guard := p_protocol_id::text || ':' || v_protocol.version::text || ':' ||
    (v_protocol.version + 1)::text;
  perform pg_catalog.set_config(
    'amj.prontuario_finalize_guard', v_guard, true
  );

  update public.protocols
  set status = 'signed',
      updated_by = p_user_id,
      updated_at = pg_catalog.now(),
      version = version + 1
  where id = p_protocol_id
    and clinic_id = p_clinic_id
  returning * into v_protocol;

  -- Limita o contexto ate mesmo dentro da transacao do RPC. A versao exata
  -- ja impediria reuso, mas limpar explicitamente reduz o estado privilegiado.
  perform pg_catalog.set_config(
    'amj.prontuario_finalize_guard', '', true
  );

  perform private.prontuario_log_event(
    p_clinic_id, p_user_id, p_actor_role, p_auth_method,
    'protocol', p_protocol_id, 'finalize',
    pg_catalog.jsonb_build_object(
      'endpoint', 'prontuario-fichas',
      'new_status', v_protocol.status,
      'version', v_protocol.version,
      'target_kind', 'draft_to_signed',
      'item_count', v_clinical_photo_count,
      'idempotent', false
    ),
    p_request_id
  );

  return pg_catalog.jsonb_build_object(
    'id', v_protocol.id,
    'status', v_protocol.status,
    'version', v_protocol.version,
    'idempotent', false
  );
end;
$function$;

-- Preserve existing Edge-only RPC permissions after CREATE OR REPLACE.
revoke all on function public.fase2_financeiro_editar_produto_locked_impl(uuid,uuid,uuid,integer,uuid,text,text,text,text,text,numeric,numeric,text,boolean,text,uuid) from public,anon,authenticated,service_role;
revoke all on function public.prontuario_salvar_rascunho(uuid,uuid,text,text,uuid,integer,uuid,uuid,uuid,text,text,jsonb,text,date,date,text,jsonb,jsonb,uuid) from public,anon,authenticated;
revoke all on function public.prontuario_salvar_rascunho_com_estoque(uuid,uuid,text,text,uuid,integer,uuid,uuid,uuid,text,text,jsonb,text,date,date,text,jsonb,jsonb,uuid) from public,anon,authenticated;
revoke all on function public.prontuario_finalizar(uuid,uuid,text,text,uuid,integer,uuid) from public,anon,authenticated;
grant execute on function public.prontuario_salvar_rascunho(uuid,uuid,text,text,uuid,integer,uuid,uuid,uuid,text,text,jsonb,text,date,date,text,jsonb,jsonb,uuid) to service_role;
grant execute on function public.prontuario_salvar_rascunho_com_estoque(uuid,uuid,text,text,uuid,integer,uuid,uuid,uuid,text,text,jsonb,text,date,date,text,jsonb,jsonb,uuid) to service_role;
grant execute on function public.prontuario_finalizar(uuid,uuid,text,text,uuid,integer,uuid) to service_role;

-- Photo links use the pending draft as their authoritative source until
-- finalization. A partially entered product+lot is evidence, not consumption.
create or replace function private.prontuario_product_pair_exists(
  p_protocol_id uuid,p_product_id uuid,p_lot text
) returns boolean language sql stable set search_path='' as $function$
  select coalesce((
    select case when protocol.status='draft' and protocol.draft_products is not null then
      exists(select 1 from jsonb_array_elements(protocol.draft_products) item
        where item->>'product_id'=p_product_id::text and item->>'lot'=p_lot)
    else exists(select 1 from public.protocol_products item
      where item.protocol_id=protocol.id and item.product_id=p_product_id and item.lot=p_lot)
    end from public.protocols protocol where protocol.id=p_protocol_id
  ),false);
$function$;
revoke all on function private.prontuario_product_pair_exists(uuid,uuid,text) from public,anon,authenticated,service_role;

create or replace function private.prontuario_enforce_active_photo_product_context()
returns trigger language plpgsql security definer set search_path='' as $function$
declare v_protocol_id uuid;
begin
  if tg_table_name='protocols' then v_protocol_id:=new.id;
  elsif tg_table_name='protocol_products' then v_protocol_id:=old.protocol_id;
  elsif tg_table_name='protocol_photos' then v_protocol_id:=new.protocol_id;
  else raise exception 'active_photo_product_context_trigger_invalid' using errcode='55000'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'amj-prontuario-product-photo:'||v_protocol_id::text,0));
  if exists(
    select 1 from public.protocol_photos photo
    where photo.protocol_id=v_protocol_id and photo.phase='products_used'
      and photo.archived_at is null and photo.product_id is not null
      and not private.prontuario_product_pair_exists(photo.protocol_id,photo.product_id,photo.lot_snapshot)
  ) then
    raise exception 'protocol_product_referenced_by_active_photo' using errcode='23503',
      hint='Archive ou corrija a foto de produto antes de alterar o produto ou lote.';
  end if;
  return null;
end; $function$;
revoke all on function private.prontuario_enforce_active_photo_product_context() from public,anon,authenticated,service_role;
create constraint trigger protocols_preserve_draft_photo_context
after update on public.protocols deferrable initially deferred
for each row execute function private.prontuario_enforce_active_photo_product_context();

create or replace function public.prontuario_registrar_foto(
  p_clinic_id uuid,
  p_user_id uuid,
  p_actor_role text,
  p_auth_method text,
  p_photo_id uuid,
  p_protocol_id uuid,
  p_phase text,
  p_storage_path text,
  p_taken_at timestamptz,
  p_mime_type text,
  p_size_bytes bigint,
  p_sha256 text,
  p_original_name text,
  p_thumbnail_storage_path text,
  p_thumbnail_mime_type text,
  p_thumbnail_size_bytes bigint,
  p_thumbnail_sha256 text,
  p_product_id uuid,
  p_lot_snapshot text,
  p_attendance_id uuid,
  p_procedure_item_id uuid,
  p_confirm_distinct boolean,
  p_duplicate_reason text,
  p_duplicate_operation_id uuid,
  p_idempotency_key uuid,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_protocol_status text;
  v_protocol_archived_at timestamptz;
  v_existing public.protocol_photos%rowtype;
  v_duplicate public.protocol_photos%rowtype;
  v_original_name text := nullif(btrim(p_original_name), '');
  v_lot_snapshot text := nullif(btrim(p_lot_snapshot), '');
  v_duplicate_reason text := nullif(btrim(p_duplicate_reason), '');
  v_storage_metadata jsonb;
  v_thumbnail_metadata jsonb;
begin
  perform private.prontuario_assert_actor(
    p_clinic_id, p_user_id, p_actor_role, p_auth_method,
    array['owner', 'professional']::text[]
  );

  if p_photo_id is null or p_protocol_id is null
     or p_idempotency_key is null or p_request_id is null
     or p_phase not in ('before', 'during', 'after', 'products_used')
     or p_mime_type not in ('image/jpeg', 'image/png', 'image/webp')
     or p_size_bytes not between 1 and 26214400
     or lower(p_sha256) !~ '^[0-9a-f]{64}$'
     or v_original_name is null
     or char_length(v_original_name) > 180
     or v_original_name ~ '[[:cntrl:]/\\]'
     or p_storage_path is null
     or p_storage_path !~ '^[A-Za-z0-9_.:/-]+$'
     or p_storage_path not like p_clinic_id::text || '/' || p_protocol_id::text || '/%'
     or (p_procedure_item_id is not null and p_attendance_id is null)
     or (
       p_phase <> 'products_used'
       and (p_product_id is not null or v_lot_snapshot is not null)
     )
     or (v_lot_snapshot is not null and (
       char_length(v_lot_snapshot) > 100 or v_lot_snapshot ~ '[[:cntrl:]]'
     ))
     or (
       (p_thumbnail_storage_path is null) <> (p_thumbnail_mime_type is null)
       or (p_thumbnail_storage_path is null) <> (p_thumbnail_size_bytes is null)
       or (p_thumbnail_storage_path is null) <> (p_thumbnail_sha256 is null)
     )
     or (
       p_thumbnail_storage_path is not null
       and (
         p_thumbnail_storage_path = p_storage_path
         or p_thumbnail_storage_path !~ '^[A-Za-z0-9_.:/-]+$'
         or p_thumbnail_storage_path not like
           p_clinic_id::text || '/' || p_protocol_id::text || '/%'
         or p_thumbnail_mime_type not in ('image/jpeg', 'image/png', 'image/webp')
         or p_thumbnail_size_bytes not between 1 and 1048576
         or lower(p_thumbnail_sha256) !~ '^[0-9a-f]{64}$'
       )
     )
     or coalesce(p_taken_at, now()) > now() + interval '1 day'
     or (
       coalesce(p_confirm_distinct, false) is false
       and (v_duplicate_reason is not null or p_duplicate_operation_id is not null)
     )
     or (
       coalesce(p_confirm_distinct, false) is true
       and (
         v_duplicate_reason is null
         or char_length(v_duplicate_reason) > 500
         or v_duplicate_reason ~ '[[:cntrl:]]'
         or p_duplicate_operation_id is null
       )
     )
  then
    raise exception 'photo_metadata_invalid' using errcode = '22023';
  end if;

  select status, archived_at
  into v_protocol_status, v_protocol_archived_at
  from public.protocols
  where id = p_protocol_id and clinic_id = p_clinic_id
  for share;

  if not found or v_protocol_archived_at is not null
     or v_protocol_status not in ('draft', 'signed') then
    raise exception 'protocol_not_found_or_locked' using errcode = 'P0002';
  end if;

  -- Quando produto/lote forem informados na categoria Produtos utilizados,
  -- eles precisam pertencer ao mesmo protocolo/paciente. Ambos continuam
  -- opcionais para permitir uma foto geral da bandeja do procedimento.
  if p_phase = 'products_used'
     and (p_product_id is not null or v_lot_snapshot is not null)
     and not private.prontuario_product_pair_exists(p_protocol_id, p_product_id, v_lot_snapshot) then
    raise exception 'photo_product_context_invalid' using errcode = '23503';
  end if;

  if coalesce((
    select accepted
    from public.protocol_consents
    where protocol_id = p_protocol_id
      and kind = 'clinical_photography'
    order by recorded_at desc, id desc
    limit 1
  ), false) is not true then
    raise exception 'clinical_photography_consent_required'
      using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      p_protocol_id::text || ':photo:' || p_idempotency_key::text,
      0
    )
  );

  select * into v_existing
  from public.protocol_photos
  where protocol_id = p_protocol_id
    and idempotency_key = p_idempotency_key;

  if found then
    if v_existing.phase is distinct from p_phase
       or v_existing.storage_path is distinct from p_storage_path
       or v_existing.mime_type is distinct from p_mime_type
       or v_existing.size_bytes is distinct from p_size_bytes
       or v_existing.sha256 is distinct from lower(p_sha256)
       or v_existing.thumbnail_storage_path is distinct from p_thumbnail_storage_path
       or v_existing.thumbnail_mime_type is distinct from p_thumbnail_mime_type
       or v_existing.thumbnail_size_bytes is distinct from p_thumbnail_size_bytes
       or v_existing.thumbnail_sha256 is distinct from lower(p_thumbnail_sha256)
       or v_existing.product_id is distinct from p_product_id
       or v_existing.lot_snapshot is distinct from v_lot_snapshot
       or v_existing.attendance_id is distinct from p_attendance_id
       or v_existing.procedure_item_id is distinct from p_procedure_item_id
       or v_existing.duplicate_reason is distinct from v_duplicate_reason
       or v_existing.duplicate_operation_id is distinct from p_duplicate_operation_id then
      raise exception 'idempotency_key_reused' using errcode = '22023';
    end if;
    return jsonb_build_object(
      'id', v_existing.id,
      'storage_path', v_existing.storage_path,
      'idempotent', true
    );
  end if;

  -- SHA-256 e a fonte exata do arquivo. Por padrao a repeticao dentro do
  -- mesmo prontuario e bloqueada e o identificador existente volta no DETAIL.
  -- Uma foto realmente distinta (por exemplo, mesmo arquivo usado em outro
  -- enquadramento documental) exige confirmacao protegida e motivo auditavel.
  perform pg_advisory_xact_lock(
    hashtextextended(p_protocol_id::text || ':photo-sha256:' || lower(p_sha256), 0)
  );

  select photo.* into v_duplicate
  from public.protocol_photos photo
  where photo.protocol_id = p_protocol_id
    and photo.sha256 = lower(p_sha256)
    and photo.id <> p_photo_id
  order by photo.taken_at, photo.id
  limit 1;

  if found and coalesce(p_confirm_distinct, false) is false then
    raise exception using
      errcode = '23505',
      message = 'photo_exact_duplicate',
      detail = v_duplicate.id::text;
  end if;

  if not found and coalesce(p_confirm_distinct, false) is true then
    raise exception 'photo_duplicate_confirmation_stale' using errcode = '40001';
  end if;

  select metadata
  into v_storage_metadata
  from storage.objects
  where bucket_id = 'clinic-media' and name = p_storage_path;

  if not found then
    raise exception 'photo_object_not_found' using errcode = 'P0002';
  end if;
  if coalesce(v_storage_metadata ->> 'mimetype', '') <> p_mime_type
     or coalesce(v_storage_metadata ->> 'size', '') !~ '^[0-9]+$'
     or (v_storage_metadata ->> 'size')::bigint <> p_size_bytes then
    raise exception 'photo_object_metadata_mismatch' using errcode = '22023';
  end if;

  if p_thumbnail_storage_path is not null then
    select metadata
    into v_thumbnail_metadata
    from storage.objects
    where bucket_id = 'clinic-media' and name = p_thumbnail_storage_path;

    if not found then
      raise exception 'photo_thumbnail_object_not_found' using errcode = 'P0002';
    end if;
    if coalesce(v_thumbnail_metadata ->> 'mimetype', '') <> p_thumbnail_mime_type
       or coalesce(v_thumbnail_metadata ->> 'size', '') !~ '^[0-9]+$'
       or (v_thumbnail_metadata ->> 'size')::bigint <> p_thumbnail_size_bytes then
      raise exception 'photo_thumbnail_metadata_mismatch' using errcode = '22023';
    end if;
  end if;

  insert into public.protocol_photos (
    id, protocol_id, phase, storage_path, taken_at,
    mime_type, size_bytes, sha256, original_name,
    thumbnail_storage_path, thumbnail_mime_type, thumbnail_size_bytes,
    thumbnail_sha256, product_id, lot_snapshot, attendance_id,
    procedure_item_id, duplicate_of_photo_id, duplicate_reason,
    duplicate_confirmed_by, duplicate_confirmed_at,
    duplicate_operation_id, idempotency_key
  ) values (
    p_photo_id, p_protocol_id, p_phase, p_storage_path,
    coalesce(p_taken_at, now()), p_mime_type, p_size_bytes,
    lower(p_sha256), v_original_name,
    p_thumbnail_storage_path, p_thumbnail_mime_type, p_thumbnail_size_bytes,
    lower(p_thumbnail_sha256), p_product_id, v_lot_snapshot,
    p_attendance_id, p_procedure_item_id,
    case when coalesce(p_confirm_distinct, false) then v_duplicate.id else null end,
    case when coalesce(p_confirm_distinct, false) then v_duplicate_reason else null end,
    case when coalesce(p_confirm_distinct, false) then p_user_id else null end,
    case when coalesce(p_confirm_distinct, false) then now() else null end,
    case when coalesce(p_confirm_distinct, false) then p_duplicate_operation_id else null end,
    p_idempotency_key
  );

  perform private.prontuario_log_event(
    p_clinic_id, p_user_id, p_actor_role, p_auth_method,
    'protocol_photo', p_photo_id, 'photo.add',
    jsonb_build_object(
      'endpoint', 'prontuario-fichas',
      'target_kind', p_phase,
      'item_count', 1,
      'reason_code', case
        when coalesce(p_confirm_distinct, false) then 'duplicate_confirmed_distinct'
        else 'standard_upload'
      end,
      'idempotent', false
    ),
    p_request_id
  );

  return jsonb_build_object(
    'id', p_photo_id,
    'storage_path', p_storage_path,
    'thumbnail_storage_path', p_thumbnail_storage_path,
    'idempotent', false
  );
end;
$function$;

revoke all on function public.prontuario_registrar_foto(uuid,uuid,text,text,uuid,uuid,text,text,timestamptz,text,bigint,text,text,text,text,bigint,text,uuid,text,uuid,uuid,boolean,text,uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.prontuario_registrar_foto(uuid,uuid,text,text,uuid,uuid,text,text,timestamptz,text,bigint,text,text,text,text,bigint,text,uuid,text,uuid,uuid,boolean,text,uuid,uuid,uuid) to service_role;
commit;

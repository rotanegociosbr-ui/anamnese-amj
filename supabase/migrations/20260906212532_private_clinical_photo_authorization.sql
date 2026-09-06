-- Private clinical archive authorization, not patient consent.
-- Edge enforces active owner + MFA + tenant before invoking these service-only RPCs.
-- The SQL actor membership checks remain mandatory. Other roles retain their
-- previous consent rule. No consent event is created/updated and no public,
-- marketing, educational or publication permission is inferred.
begin;
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

  if p_actor_role is distinct from 'owner' and coalesce((
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
        else case when p_actor_role='owner' then 'private_owner_upload' else 'standard_upload' end
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

create or replace function public.prontuario_restaurar_foto(
  p_clinic_id uuid,
  p_user_id uuid,
  p_actor_role text,
  p_auth_method text,
  p_photo_id uuid,
  p_reason text,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_photo public.protocol_photos%rowtype;
  v_protocol_status text;
  v_protocol_archived_at timestamptz;
  v_reason text := nullif(pg_catalog.btrim(p_reason), '');
  v_previous_id uuid;
  v_previous_action text;
begin
  perform private.prontuario_assert_actor(
    p_clinic_id, p_user_id, p_actor_role, p_auth_method,
    array['owner']::text[]
  );
  if p_request_id is null or v_reason is null
     or pg_catalog.char_length(v_reason) not between 3 and 500 then
    raise exception 'photo_restore_reason_invalid' using errcode = '22023';
  end if;

  select entity_id, action
  into v_previous_id, v_previous_action
  from public.clinic_audit_log
  where clinic_id = p_clinic_id and request_id = p_request_id;
  if found then
    if v_previous_id = p_photo_id and v_previous_action = 'photo.restore' then
      return pg_catalog.jsonb_build_object(
        'id', p_photo_id, 'restored', true, 'idempotent', true
      );
    end if;
    raise exception 'operation_id_reused' using errcode = '22023';
  end if;

  -- PL/pgSQL não permite uma variável %ROWTYPE ao lado de outros alvos no
  -- mesmo INTO. Bloqueamos a foto primeiro e lemos o estado do protocolo em
  -- seguida; o SELECT original já bloqueava somente a linha de `photo`.
  select photo.*
  into v_photo
  from public.protocol_photos photo
  join public.protocols protocol on protocol.id = photo.protocol_id
  where photo.id = p_photo_id and protocol.clinic_id = p_clinic_id
  for update of photo;
  if not found then
    raise exception 'photo_not_found' using errcode = 'P0002';
  end if;

  select status, archived_at
  into v_protocol_status, v_protocol_archived_at
  from public.protocols
  where id = v_photo.protocol_id;
  if v_protocol_archived_at is not null
     or v_protocol_status not in ('draft', 'signed') then
    raise exception 'protocol_archived' using errcode = '42501';
  end if;

  if v_photo.archived_at is null then
    perform private.prontuario_log_event(
      p_clinic_id, p_user_id, p_actor_role, p_auth_method,
      'protocol_photo', p_photo_id, 'photo.restore',
      pg_catalog.jsonb_build_object(
        'endpoint', 'prontuario-fichas', 'reason_code', 'owner_request',
        'target_kind', v_protocol_status, 'idempotent', true
      ),
      p_request_id
    );
    return pg_catalog.jsonb_build_object(
      'id', p_photo_id, 'storage_path', v_photo.storage_path,
      'restored', true, 'idempotent', true
    );
  end if;

  if p_actor_role is distinct from 'owner' and coalesce((
    select accepted
    from public.protocol_consents
    where protocol_id = v_photo.protocol_id
      and kind = 'clinical_photography'
    order by recorded_at desc, id desc
    limit 1
  ), false) is not true then
    raise exception 'clinical_photography_consent_required'
      using errcode = '42501';
  end if;

  if not exists (
    select 1 from storage.objects
    where bucket_id = 'clinic-media' and name = v_photo.storage_path
  ) then
    raise exception 'photo_object_not_found' using errcode = 'P0002';
  end if;

  update public.protocol_photos
  set archived_at = null
  where id = p_photo_id;

  perform private.prontuario_log_event(
    p_clinic_id, p_user_id, p_actor_role, p_auth_method,
    'protocol_photo', p_photo_id, 'photo.restore',
    pg_catalog.jsonb_build_object(
      'endpoint', 'prontuario-fichas', 'reason_code', 'owner_request',
      'target_kind', v_protocol_status, 'route', v_photo.storage_path,
      'idempotent', false
    ),
    p_request_id
  );

  return pg_catalog.jsonb_build_object(
    'id', p_photo_id, 'storage_path', v_photo.storage_path,
    'restored', true, 'idempotent', false
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

  if p_actor_role is distinct from 'owner' and coalesce((
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
      'target_kind', 'draft_to_signed_private',
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

revoke all on function public.prontuario_registrar_foto(uuid,uuid,text,text,uuid,uuid,text,text,timestamptz,text,bigint,text,text,text,text,bigint,text,uuid,text,uuid,uuid,boolean,text,uuid,uuid,uuid) from public,anon,authenticated;
revoke all on function public.prontuario_restaurar_foto(uuid,uuid,text,text,uuid,text,uuid) from public,anon,authenticated;
revoke all on function public.prontuario_finalizar(uuid,uuid,text,text,uuid,integer,uuid) from public,anon,authenticated;
grant execute on function public.prontuario_registrar_foto(uuid,uuid,text,text,uuid,uuid,text,text,timestamptz,text,bigint,text,text,text,text,bigint,text,uuid,text,uuid,uuid,boolean,text,uuid,uuid,uuid) to service_role;
grant execute on function public.prontuario_restaurar_foto(uuid,uuid,text,text,uuid,text,uuid) to service_role;
grant execute on function public.prontuario_finalizar(uuid,uuid,text,text,uuid,integer,uuid) to service_role;
commit;

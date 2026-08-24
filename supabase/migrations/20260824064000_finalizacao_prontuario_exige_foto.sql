-- Finalizacao segura do prontuario clinico.
--
-- A transicao draft -> signed e exclusiva do RPC Edge-only abaixo. A guarda
-- usa um contexto transacional vinculado ao protocolo e as versoes exatas;
-- o service_role nao possui UPDATE direto na tabela e os clientes nao podem
-- executar o RPC.

begin;

create or replace function private.prontuario_guard_protocol_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_finalize_guard text :=
    pg_catalog.current_setting('amj.prontuario_finalize_guard', true);
  v_expected_finalize_guard text;
begin
  if tg_op = 'DELETE' then
    raise exception 'protocol_delete_forbidden' using errcode = '42501';
  end if;

  if new.version <> old.version + 1 then
    raise exception 'protocol_version_must_increment' using errcode = '40001';
  end if;
  if new.updated_by is null then
    raise exception 'protocol_updated_by_required' using errcode = '23502';
  end if;

  if old.status = 'draft' and old.archived_at is null then
    if new.status = 'draft' then
      return new;
    end if;

    if new.status <> 'signed' then
      raise exception 'protocol_signature_requires_dedicated_workflow'
        using errcode = '42501';
    end if;

    v_expected_finalize_guard :=
      old.id::text || ':' || old.version::text || ':' || new.version::text;
    if v_finalize_guard is distinct from v_expected_finalize_guard then
      raise exception 'protocol_signature_requires_dedicated_workflow'
        using errcode = '42501';
    end if;

    -- Finalizar muda somente o estado e os metadados de concorrencia/autoria.
    -- Nenhum dado clinico pode ser alterado junto com a assinatura.
    if (
      pg_catalog.to_jsonb(new) - array[
        'status', 'updated_by', 'updated_at', 'version'
      ]::text[]
    ) is distinct from (
      pg_catalog.to_jsonb(old) - array[
        'status', 'updated_by', 'updated_at', 'version'
      ]::text[]
    ) then
      raise exception 'protocol_signature_payload_forbidden'
        using errcode = '42501';
    end if;

    return new;
  end if;

  -- Assinados e arquivados continuam imutaveis. Somente os metadados de
  -- arquivamento/restauracao e controle de versao podem mudar.
  if (
    pg_catalog.to_jsonb(new) - array[
      'archived_at', 'archive_reason', 'archived_by', 'updated_by',
      'updated_at', 'version'
    ]::text[]
  ) is distinct from (
    pg_catalog.to_jsonb(old) - array[
      'archived_at', 'archive_reason', 'archived_by', 'updated_by',
      'updated_at', 'version'
    ]::text[]
  ) then
    raise exception 'signed_protocol_is_immutable' using errcode = '42501';
  end if;

  return new;
end;
$function$;

revoke all on function private.prontuario_guard_protocol_mutation()
  from public, anon, authenticated, service_role;

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

-- A remocao continua sendo arquivamento logico e somente de owner. Em
-- protocolo assinado, a ultima foto clinica ativa e um requisito permanente.
create or replace function public.prontuario_remover_foto(
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
  v_previous_path text;
  v_active_clinical_photo_count integer;
begin
  perform private.prontuario_assert_actor(
    p_clinic_id, p_user_id, p_actor_role, p_auth_method,
    array['owner']::text[]
  );
  if p_request_id is null or v_reason is null
     or pg_catalog.char_length(v_reason) not between 3 and 500 then
    raise exception 'photo_removal_reason_invalid' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      p_clinic_id::text || ':photo-archive:' || p_request_id::text,
      0
    )
  );

  select audit.entity_id, audit.action, audit.details ->> 'route'
  into v_previous_id, v_previous_action, v_previous_path
  from public.clinic_audit_log audit
  where audit.clinic_id = p_clinic_id
    and audit.request_id = p_request_id;

  if found then
    if v_previous_id = p_photo_id and v_previous_action = 'photo.archive' then
      return pg_catalog.jsonb_build_object(
        'id', v_previous_id,
        'storage_path', v_previous_path,
        'hard_delete', false,
        'archived', true,
        'idempotent', true
      );
    end if;
    raise exception 'operation_id_reused' using errcode = '22023';
  end if;

  select photo.*
  into v_photo
  from public.protocol_photos photo
  join public.protocols protocol on protocol.id = photo.protocol_id
  where photo.id = p_photo_id
    and protocol.clinic_id = p_clinic_id
  for update of photo;

  if not found then
    raise exception 'photo_not_found' using errcode = 'P0002';
  end if;

  -- Serializa todas as remocoes do mesmo protocolo. Sem este bloqueio, duas
  -- requisicoes poderiam observar duas fotos e arquivar ambas simultaneamente.
  select protocol.status, protocol.archived_at
  into v_protocol_status, v_protocol_archived_at
  from public.protocols protocol
  where protocol.id = v_photo.protocol_id
  for update;

  if v_protocol_archived_at is not null then
    raise exception 'protocol_archived' using errcode = '42501';
  end if;

  if v_photo.archived_at is not null then
    perform private.prontuario_log_event(
      p_clinic_id, p_user_id, p_actor_role, p_auth_method,
      'protocol_photo', p_photo_id, 'photo.archive',
      pg_catalog.jsonb_build_object(
        'endpoint', 'prontuario-fichas',
        'reason_code', 'owner_request',
        'target_kind', v_protocol_status,
        'route', v_photo.storage_path,
        'idempotent', true
      ),
      p_request_id
    );
    return pg_catalog.jsonb_build_object(
      'id', v_photo.id,
      'storage_path', v_photo.storage_path,
      'hard_delete', false,
      'archived', true,
      'idempotent', true
    );
  end if;

  if v_protocol_status = 'signed'
     and v_photo.phase in ('before', 'during', 'after') then
    select pg_catalog.count(*)::integer
    into v_active_clinical_photo_count
    from public.protocol_photos photo
    join storage.objects stored_object
      on stored_object.bucket_id = 'clinic-media'
     and stored_object.name = photo.storage_path
    where photo.protocol_id = v_photo.protocol_id
      and photo.archived_at is null
      and photo.phase in ('before', 'during', 'after');

    if v_active_clinical_photo_count <= 1 then
      raise exception 'last_clinical_photo_required' using errcode = '23514';
    end if;
  end if;

  update public.protocol_photos
  set archived_at = pg_catalog.now()
  where id = p_photo_id;

  perform private.prontuario_log_event(
    p_clinic_id, p_user_id, p_actor_role, p_auth_method,
    'protocol_photo', p_photo_id, 'photo.archive',
    pg_catalog.jsonb_build_object(
      'endpoint', 'prontuario-fichas',
      'reason_code', 'owner_request',
      'target_kind', v_protocol_status,
      'route', v_photo.storage_path,
      'idempotent', false
    ),
    p_request_id
  );

  return pg_catalog.jsonb_build_object(
    'id', v_photo.id,
    'storage_path', v_photo.storage_path,
    'hard_delete', false,
    'archived', true,
    'idempotent', false
  );
end;
$function$;

-- Consentimento fotografico e um evento append-only independente dos dados
-- clinicos. Continua revogavel depois da assinatura sem reabrir o protocolo.
create or replace function public.prontuario_alterar_consentimento_fotografia(
  p_clinic_id uuid,
  p_user_id uuid,
  p_actor_role text,
  p_auth_method text,
  p_protocol_id uuid,
  p_accepted boolean,
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
  v_previous_accepted boolean;
  v_has_previous boolean;
  v_count integer;
  v_requested_status text := case when p_accepted then 'accepted' else 'revoked' end;
begin
  perform private.prontuario_assert_actor(
    p_clinic_id, p_user_id, p_actor_role, p_auth_method,
    array['owner']::text[]
  );
  if p_protocol_id is null or p_accepted is null or p_request_id is null then
    raise exception 'required_parameter_missing' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      p_clinic_id::text || ':clinical-photography-consent:' || p_request_id::text,
      0
    )
  );

  select protocol.*
  into v_protocol
  from public.protocols protocol
  where protocol.id = p_protocol_id
    and protocol.clinic_id = p_clinic_id
  for update;

  if not found then
    raise exception 'protocol_not_found' using errcode = 'P0002';
  end if;
  if v_protocol.archived_at is not null then
    raise exception 'protocol_archived' using errcode = '42501';
  end if;
  if v_protocol.status not in ('draft', 'signed') then
    raise exception 'protocol_locked' using errcode = '42501';
  end if;

  select audit.entity, audit.entity_id, audit.action, audit.details
  into v_previous
  from public.clinic_audit_log audit
  where audit.clinic_id = p_clinic_id
    and audit.request_id = p_request_id;

  if found then
    if v_previous.entity = 'protocol'
       and v_previous.entity_id = p_protocol_id
       and v_previous.action = 'consent.clinical_photography'
       and v_previous.details ->> 'new_status' = v_requested_status then
      return pg_catalog.jsonb_build_object(
        'id', p_protocol_id,
        'accepted', p_accepted,
        'changed', false,
        'version', nullif(v_previous.details ->> 'version', '')::integer,
        'idempotent', true
      );
    end if;
    raise exception 'operation_id_reused' using errcode = '22023';
  end if;

  select consent.accepted
  into v_previous_accepted
  from public.protocol_consents consent
  where consent.protocol_id = p_protocol_id
    and consent.kind = 'clinical_photography'
  order by consent.recorded_at desc, consent.id desc
  limit 1;
  v_has_previous := found;

  v_count := private.prontuario_append_consents(
    p_protocol_id,
    p_user_id,
    pg_catalog.jsonb_build_object('clinical_photography', p_accepted)
  );

  perform private.prontuario_log_event(
    p_clinic_id, p_user_id, p_actor_role, p_auth_method,
    'protocol', p_protocol_id, 'consent.clinical_photography',
    pg_catalog.jsonb_build_object(
      'endpoint', 'prontuario-fichas',
      'operation', 'consent.append',
      'target_kind', 'clinical_photography',
      'previous_status', case
        when not v_has_previous then 'missing'
        when v_previous_accepted then 'accepted'
        else 'revoked'
      end,
      'new_status', v_requested_status,
      'item_count', v_count,
      'version', v_protocol.version,
      'idempotent', v_count = 0
    ),
    p_request_id
  );

  return pg_catalog.jsonb_build_object(
    'id', p_protocol_id,
    'accepted', p_accepted,
    'changed', v_count > 0,
    'version', v_protocol.version,
    'idempotent', v_count = 0
  );
end;
$function$;

-- RPCs publicos, mas Edge-only: somente o service_role recebe EXECUTE.
revoke all on function public.prontuario_finalizar(
  uuid,uuid,text,text,uuid,integer,uuid
) from public, anon, authenticated, service_role;
grant execute on function public.prontuario_finalizar(
  uuid,uuid,text,text,uuid,integer,uuid
) to service_role;

revoke all on function public.prontuario_remover_foto(
  uuid,uuid,text,text,uuid,text,uuid
) from public, anon, authenticated, service_role;
grant execute on function public.prontuario_remover_foto(
  uuid,uuid,text,text,uuid,text,uuid
) to service_role;

revoke all on function public.prontuario_alterar_consentimento_fotografia(
  uuid,uuid,text,text,uuid,boolean,uuid
) from public, anon, authenticated, service_role;
grant execute on function public.prontuario_alterar_consentimento_fotografia(
  uuid,uuid,text,text,uuid,boolean,uuid
) to service_role;

comment on function public.prontuario_finalizar(
  uuid,uuid,text,text,uuid,integer,uuid
) is
  'Finaliza um prontuario ativo com concorrencia otimista, consentimento atual e ao menos uma foto clinica ativa; Edge-only e auditado.';

comment on function public.prontuario_alterar_consentimento_fotografia(
  uuid,uuid,text,text,uuid,boolean,uuid
) is
  'Anexa ou revoga somente a atestacao de fotografia clinica em protocolo draft/signed; owner, Edge-only, idempotente e auditado sem PII.';

commit;

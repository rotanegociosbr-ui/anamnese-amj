-- Prompt 54: repair literal-dot matching in orphan-photo queue paths.
-- No rows or storage objects are removed. The queue is still manual/pending.
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '15s';

CREATE OR REPLACE FUNCTION public.prontuario_enfileirar_gc_foto_orfa(p_clinic_id uuid, p_user_id uuid, p_actor_role text, p_auth_method text, p_protocol_id uuid, p_photo_id uuid, p_storage_path text, p_thumbnail_storage_path text, p_reason_code text, p_request_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_queue public.clinical_photo_object_gc_queue%rowtype;
begin
  perform private.prontuario_assert_actor(p_clinic_id,p_user_id,p_actor_role,p_auth_method,array['owner']);
  if p_protocol_id is null or p_photo_id is null or p_request_id is null
     or p_reason_code not in ('metadata_rejected','thumbnail_failed')
     or p_storage_path !~ ('^'||p_clinic_id::text||'/'||p_protocol_id::text||'/'||p_photo_id::text||'[.][a-z0-9]+$')
     or p_storage_path ~ '[[:cntrl:]\\]' or p_storage_path ~ '(^|/)\.\.(/|$)'
     or (p_thumbnail_storage_path is not null and
       (p_thumbnail_storage_path !~ ('^'||p_clinic_id::text||'/'||p_protocol_id::text||'/'||p_photo_id::text||'[.]thumb[.][a-z0-9]+$')
        or p_thumbnail_storage_path ~ '[[:cntrl:]\\]' or p_thumbnail_storage_path ~ '(^|/)\.\.(/|$)')) then
    raise exception 'photo_gc_request_invalid' using errcode='22023';
  end if;
  if not exists(select 1 from public.protocols protocol where protocol.clinic_id=p_clinic_id
    and protocol.id=p_protocol_id) then raise exception 'protocol_not_found' using errcode='P0002'; end if;
  if exists(select 1 from public.protocol_photos photo
    join public.protocols protocol on protocol.id=photo.protocol_id
    where protocol.clinic_id=p_clinic_id
    and (photo.storage_path=p_storage_path or photo.thumbnail_storage_path=p_storage_path
      or (p_thumbnail_storage_path is not null and
        (photo.storage_path=p_thumbnail_storage_path or photo.thumbnail_storage_path=p_thumbnail_storage_path)))) then
    return pg_catalog.jsonb_build_object('enfileirado',false,'retido_por_referencia',true);
  end if;
  insert into public.clinical_photo_object_gc_queue(
    clinic_id,protocol_id,photo_id,storage_path,thumbnail_storage_path,reason_code,
    queued_by,request_id
  ) values (
    p_clinic_id,p_protocol_id,p_photo_id,p_storage_path,p_thumbnail_storage_path,
    p_reason_code,p_user_id,p_request_id
  ) on conflict(clinic_id,request_id) do nothing returning * into v_queue;
  if not found then select * into v_queue from public.clinical_photo_object_gc_queue
    where clinic_id=p_clinic_id and request_id=p_request_id; end if;
  perform private.prontuario_log_event(p_clinic_id,p_user_id,p_actor_role,p_auth_method,
    'photo_object_gc',v_queue.id,'photo_object_gc.queued',
    pg_catalog.jsonb_build_object('reason_code',v_queue.reason_code,'status_code',v_queue.status),p_request_id);
  return pg_catalog.jsonb_build_object('enfileirado',true,'fila_id',v_queue.id,
    'not_before',v_queue.not_before);
end;
$function$;

ALTER TABLE public.clinical_photo_object_gc_queue
  DROP CONSTRAINT clinical_photo_object_gc_queue_path_check;
ALTER TABLE public.clinical_photo_object_gc_queue
  ADD CONSTRAINT clinical_photo_object_gc_queue_path_check
  CHECK (((storage_path = ((((((clinic_id)::text || '/'::text) || (protocol_id)::text) || '/'::text) || (photo_id)::text) || "substring"(storage_path, '[.][a-z0-9]+$'::text))) AND (storage_path !~ '[[:cntrl:]\\]'::text) AND (storage_path !~ '(^|/)\.\.(/|$)'::text) AND ((thumbnail_storage_path IS NULL) OR ((thumbnail_storage_path ~~ ((((((clinic_id)::text || '/'::text) || (protocol_id)::text) || '/'::text) || (photo_id)::text) || '.thumb.%'::text)) AND (thumbnail_storage_path !~ '[[:cntrl:]\\]'::text) AND (thumbnail_storage_path !~ '(^|/)\.\.(/|$)'::text)))));

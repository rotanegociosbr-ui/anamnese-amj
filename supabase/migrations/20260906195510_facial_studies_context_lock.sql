-- Serialize study saves without granting UPDATE on protected protocols.
-- Protocol updates use a nonblocking advisory attempt because their row lock is
-- acquired before this trigger. Waiting here could deadlock with the study FK.
create function public.facial_protocol_context_guard()
returns trigger language plpgsql security invoker set search_path='' as $$
begin
 if row(new.id,new.clinic_id,new.patient_id,new.version,new.archived_at)
    is not distinct from row(old.id,old.clinic_id,old.patient_id,old.version,old.archived_at) then return new; end if;
 if not pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended('facial-study:'||old.clinic_id::text||':'||old.id::text,0)) then
  raise exception 'facial_protocol_busy' using errcode='40001';
 end if;
 if row(new.id,new.clinic_id,new.patient_id) is distinct from row(old.id,old.clinic_id,old.patient_id)
    and exists(select 1 from public.facial_studies where clinic_id=old.clinic_id and protocol_id=old.id) then
  raise exception 'facial_protocol_patient_locked' using errcode='23514';
 end if;
 return new;
end; $$;
revoke all on function public.facial_protocol_context_guard() from public,anon,authenticated,service_role;
create trigger facial_protocol_context_guard before update of id,clinic_id,patient_id,version,archived_at
 on public.protocols for each row execute function public.facial_protocol_context_guard();

-- Remove the unbound overload so every service call supplies the opened context.
drop function public.facial_study_save(uuid,uuid,uuid,uuid,integer,jsonb,text);
create function public.facial_study_save(p_clinic_id uuid,p_actor_id uuid,p_protocol_id uuid,p_operation_id uuid,
 p_expected_version integer,p_document jsonb,p_reason text,p_expected_patient_id uuid,p_expected_protocol_version integer)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare v_protocol public.protocols%rowtype; v_existing public.facial_studies%rowtype; v_version integer; v_new public.facial_studies%rowtype;
begin
 if not exists(select 1 from public.clinic_members where clinic_id=p_clinic_id and user_id=p_actor_id and role='owner' and status='active') then
  raise exception 'facial_owner_required' using errcode='42501';
 end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('facial-study:'||p_clinic_id::text||':'||p_protocol_id::text,0));
 select * into v_protocol from public.protocols where id=p_protocol_id and clinic_id=p_clinic_id;
 if not found or v_protocol.archived_at is not null then raise exception 'facial_protocol_unavailable' using errcode='P0001'; end if;
 if p_expected_patient_id is null or p_expected_protocol_version is null
    or v_protocol.patient_id is distinct from p_expected_patient_id or v_protocol.version is distinct from p_expected_protocol_version then
  raise exception 'facial_protocol_context_conflict' using errcode='40001';
 end if;
 if p_operation_id is null or p_expected_version is null or p_expected_version<0 or p_document is null
    or (p_document->>'schemaVersion') is distinct from '1'
    or (p_document->>'modelVersion') is distinct from 'amj-facial-20260906-v2'
    or jsonb_typeof(p_document->'points') is distinct from 'array' or jsonb_array_length(p_document->'points')>200 then
  raise exception 'facial_invalid_document' using errcode='22023';
 end if;
 select * into v_existing from public.facial_studies where operation_id=p_operation_id;
 if found then
  if v_existing.clinic_id<>p_clinic_id or v_existing.protocol_id<>p_protocol_id or v_existing.created_by<>p_actor_id or v_existing.document<>p_document then
   raise exception 'facial_operation_conflict' using errcode='23505';
  end if;
  return to_jsonb(v_existing);
 end if;
 select coalesce(max(version),0) into v_version from public.facial_studies where protocol_id=p_protocol_id and clinic_id=p_clinic_id;
 if v_version<>p_expected_version then raise exception 'facial_version_conflict' using errcode='40001'; end if;
 insert into public.facial_studies(clinic_id,protocol_id,version,document,created_by,operation_id,reason)
 values(p_clinic_id,p_protocol_id,v_version+1,p_document,p_actor_id,p_operation_id,p_reason) returning * into v_new;
 return to_jsonb(v_new);
end; $$;
revoke all on function public.facial_study_save(uuid,uuid,uuid,uuid,integer,jsonb,text,uuid,integer) from public,anon,authenticated;
grant execute on function public.facial_study_save(uuid,uuid,uuid,uuid,integer,jsonb,text,uuid,integer) to service_role;

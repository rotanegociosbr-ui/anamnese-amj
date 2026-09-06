-- Append-only facial notes; no browser role can read clinical rows directly.
create table public.facial_studies (
 id uuid primary key default gen_random_uuid(),
 clinic_id uuid not null references public.clinics(id),
 protocol_id uuid not null references public.protocols(id),
 version integer not null check(version > 0),
 document jsonb not null check(jsonb_typeof(document)='object' and octet_length(document::text)<=262144),
 created_by uuid not null references auth.users(id),
 operation_id uuid not null unique,
 reason text not null check(length(reason) between 3 and 500),
 created_at timestamptz not null default now(),
 unique(protocol_id,version)
);
create index facial_studies_clinic_protocol_idx on public.facial_studies(clinic_id,protocol_id,version desc);
create index facial_studies_created_by_idx on public.facial_studies(created_by);
alter table public.facial_studies enable row level security;
revoke all on public.facial_studies from public,anon,authenticated,service_role;
grant select,insert on public.facial_studies to service_role;
comment on table public.facial_studies is 'Versioned generic facial annotations per consultation; access through owner/AAL2 Edge endpoint only. No prediction or anatomical certification.';

create function public.facial_study_save(p_clinic_id uuid,p_actor_id uuid,p_protocol_id uuid,p_operation_id uuid,p_expected_version integer,p_document jsonb,p_reason text)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare v_protocol public.protocols%rowtype; v_existing public.facial_studies%rowtype; v_version integer; v_new public.facial_studies%rowtype;
begin
 if not exists(select 1 from public.clinic_members where clinic_id=p_clinic_id and user_id=p_actor_id and role='owner' and status='active') then raise exception 'facial_owner_required' using errcode='42501'; end if;
 select * into v_protocol from public.protocols where id=p_protocol_id and clinic_id=p_clinic_id for update;
 if not found or v_protocol.archived_at is not null then raise exception 'facial_protocol_unavailable' using errcode='P0001'; end if;
 if p_operation_id is null or p_expected_version is null or p_expected_version<0 or p_document is null or (p_document->>'schemaVersion') is distinct from '1' or (p_document->>'modelVersion') is distinct from 'amj-facial-20260906-v2' or jsonb_typeof(p_document->'points') is distinct from 'array' or jsonb_array_length(p_document->'points')>200 then raise exception 'facial_invalid_document' using errcode='22023'; end if;
 select * into v_existing from public.facial_studies where operation_id=p_operation_id;
 if found then
  if v_existing.clinic_id<>p_clinic_id or v_existing.protocol_id<>p_protocol_id or v_existing.created_by<>p_actor_id or v_existing.document<>p_document then raise exception 'facial_operation_conflict' using errcode='23505'; end if;
  return to_jsonb(v_existing);
 end if;
 select coalesce(max(version),0) into v_version from public.facial_studies where protocol_id=p_protocol_id and clinic_id=p_clinic_id;
 if v_version<>p_expected_version then raise exception 'facial_version_conflict' using errcode='40001'; end if;
 insert into public.facial_studies(clinic_id,protocol_id,version,document,created_by,operation_id,reason)
 values(p_clinic_id,p_protocol_id,v_version+1,p_document,p_actor_id,p_operation_id,p_reason) returning * into v_new;
 return to_jsonb(v_new);
end; $$;
revoke all on function public.facial_study_save(uuid,uuid,uuid,uuid,integer,jsonb,text) from public,anon,authenticated;
grant execute on function public.facial_study_save(uuid,uuid,uuid,uuid,integer,jsonb,text) to service_role;

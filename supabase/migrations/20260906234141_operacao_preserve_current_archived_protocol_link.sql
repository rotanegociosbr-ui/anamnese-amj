-- Preserve an existing historical link; do not allow attaching archived protocols.
-- Keep the authoritative version check/row lock, tenant checks, audit and ACLs intact.
do $migration$
declare
  v_oid regprocedure := 'public.operacao_salvar_atendimento(uuid,uuid,text,text,text,uuid,integer,uuid,uuid,uuid,uuid,text,timestamptz,smallint,text,uuid,uuid,uuid)'::regprocedure;
  v_definition text;
  v_old text := $old$    if not found or v_protocol.clinic_id <> p_clinic_id
       or v_protocol.patient_id <> p_patient_id or v_protocol.archived_at is not null then
      raise exception 'protocol_patient_mismatch' using errcode = '23514';
    end if;$old$;
  v_new text := $new$    if not found or v_protocol.clinic_id <> p_clinic_id
       or v_protocol.patient_id <> p_patient_id or (
         v_protocol.archived_at is not null and not exists (
           select 1 from public.atendimentos_realizados current_attendance
           where current_attendance.id = p_attendance_id
             and current_attendance.clinic_id = p_clinic_id
             and current_attendance.patient_id = p_patient_id
             and current_attendance.protocol_id = p_protocol_id
             and current_attendance.archived_at is null
         )
       ) then
      raise exception 'protocol_patient_mismatch' using errcode = '23514';
    end if;$new$;
begin
  v_definition := pg_catalog.pg_get_functiondef(v_oid);
  if (pg_catalog.length(v_definition) - pg_catalog.length(pg_catalog.replace(v_definition,v_old,'')))
      / pg_catalog.length(v_old) <> 1 then
    raise exception 'attendance_protocol_guard_drift';
  end if;
  execute pg_catalog.replace(v_definition,v_old,v_new);
end;
$migration$;

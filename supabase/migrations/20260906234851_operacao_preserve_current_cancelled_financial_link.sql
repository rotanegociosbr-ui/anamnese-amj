-- Preserve an existing cancelled revenue link; never attach another inactive entry.
-- No financial rows, locks, version checks, audit or RPC privileges are changed.
do $migration$
declare
  v_oid regprocedure := 'public.operacao_salvar_atendimento(uuid,uuid,text,text,text,uuid,integer,uuid,uuid,uuid,uuid,text,timestamptz,smallint,text,uuid,uuid,uuid)'::regprocedure;
  v_definition text;
  v_old text := $old$    if not found or v_entry.patient_id is distinct from p_patient_id
       or v_entry.entry_type <> 'receita' or v_entry.state <> 'ativo' then
      raise exception 'financial_entry_patient_mismatch' using errcode = '23514';
    end if;$old$;
  v_new text := $new$    if not found or v_entry.patient_id is distinct from p_patient_id
       or v_entry.entry_type <> 'receita' or (
         v_entry.state <> 'ativo' and not exists (
           select 1 from public.atendimentos_realizados current_attendance
           where current_attendance.id = p_attendance_id
             and current_attendance.clinic_id = p_clinic_id
             and current_attendance.patient_id = p_patient_id
             and current_attendance.financial_entry_id = p_financial_entry_id
             and current_attendance.archived_at is null
         )
       ) then
      raise exception 'financial_entry_patient_mismatch' using errcode = '23514';
    end if;$new$;
begin
  v_definition := pg_catalog.pg_get_functiondef(v_oid);
  if (pg_catalog.length(v_definition) - pg_catalog.length(pg_catalog.replace(v_definition,v_old,'')))
      / pg_catalog.length(v_old) <> 1 then
    raise exception 'attendance_financial_guard_drift';
  end if;
  execute pg_catalog.replace(v_definition,v_old,v_new);
end;
$migration$;

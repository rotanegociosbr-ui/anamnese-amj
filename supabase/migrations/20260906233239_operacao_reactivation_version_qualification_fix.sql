-- 42702 on attendance INSERT/UPDATE: UPDATE ... FROM has multiple version columns.
-- Preserve the existing trigger, predicates, invoker security, ACLs and side effects.
-- Only qualify the target relation on the two ambiguous right-hand expressions.
create or replace function private.fase2_invalidate_reactivation()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if new.archived_at is null and new.status in ('realizado','concluido') then
    update public.acompanhamento_planos plan
    set status = 'invalidated', version = version + 1,
        invalidated_by_attendance_id = new.id,
        invalidated_at = pg_catalog.now(),
        invalidation_reason = 'Novo atendimento concluido apos a ancora.',
        updated_at = pg_catalog.now()
    where plan.clinic_id = new.clinic_id
      and plan.patient_id = new.patient_id
      and plan.plan_kind = 'reactivation'
      and plan.status = 'active'
      and plan.attendance_id <> new.id
      and plan.anchor_date < (new.attended_at at time zone 'America/Sao_Paulo')::date;

    update public.retorno_fila queue
    set status = 'cancelado', next_action = 'nenhuma', next_action_at = null,
        closure_reason = 'Reativacao invalidada por novo atendimento.',
        version = queue.version + 1, updated_by = new.updated_by,
        updated_at = pg_catalog.now()
    from public.retorno_recomendacoes recommendation
    join public.acompanhamento_planos plan
      on plan.clinic_id = recommendation.clinic_id and plan.id = recommendation.plan_id
    where queue.clinic_id = new.clinic_id
      and queue.recommendation_id = recommendation.id
      and plan.invalidated_by_attendance_id = new.id
      and queue.status not in ('concluido', 'cancelado', 'bloqueado');

    update public.retorno_recomendacoes recommendation
    set status = 'cancelada', cancelled_by = coalesce(new.updated_by, new.created_by),
        cancelled_at = pg_catalog.now(),
        cancellation_reason = 'Reativacao invalidada por novo atendimento.',
        version = recommendation.version + 1, updated_at = pg_catalog.now()
    from public.acompanhamento_planos plan
    where recommendation.clinic_id = new.clinic_id
      and recommendation.plan_id = plan.id
      and plan.invalidated_by_attendance_id = new.id
      and recommendation.status = 'ativa';
  end if;
  return new;
end;
$function$;

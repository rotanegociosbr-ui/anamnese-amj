-- Fase 2C: relatorio operacional agregado-only, separado de respostas com PII.
begin;

create or replace function private.fase2_suppress_count(p_value bigint)
returns jsonb language sql immutable set search_path=''
as $function$
  select case when p_value between 1 and 4
    then pg_catalog.jsonb_build_object('valor',null,'suprimido',true)
    else pg_catalog.jsonb_build_object('valor',p_value,'suprimido',false)
  end;
$function$;

create function public.gestao_relatorio_acompanhamentos_fase2(
  p_clinic_id uuid,p_user_id uuid,p_actor_role text,p_auth_method text,p_aal text,
  p_start_date date,p_end_date date
) returns jsonb language plpgsql security definer stable set search_path=''
as $function$
declare v_result jsonb;
begin
  if p_actor_role<>'owner' or p_auth_method<>'supabase_auth' or p_aal<>'aal2' then
    raise exception 'owner_aal2_required' using errcode='42501';
  end if;
  perform private.gestao_assert_owner(p_clinic_id,p_user_id);
  if p_start_date is null or p_end_date is null or p_end_date<p_start_date
     or p_end_date>(pg_catalog.now() at time zone 'America/Sao_Paulo')::date
     or p_end_date-p_start_date>365 then
    raise exception 'report_period_invalid' using errcode='22023';
  end if;
  with attendance_scope as materialized (
    select attendance.id,attendance.protocol_id,attendance.procedure_kind
    from public.atendimentos_realizados attendance
    where attendance.clinic_id=p_clinic_id and attendance.archived_at is null
      and attendance.status in ('realizado','concluido')
      and (attendance.attended_at at time zone 'America/Sao_Paulo')::date
        between p_start_date and p_end_date
  ), comparison_state as materialized (
    select attendance.id,
      exists(select 1 from public.protocol_photos photo
        where photo.protocol_id=attendance.protocol_id
          and photo.attendance_id=attendance.id and photo.phase='before'
          and photo.archived_at is null) as has_before,
      exists(select 1 from public.protocol_photos photo
        where photo.protocol_id=attendance.protocol_id
          and photo.attendance_id=attendance.id and photo.phase='after'
          and photo.archived_at is null) as has_after,
      exists(select 1 from public.protocol_consent_current consent
        where consent.protocol_id=attendance.protocol_id
          and consent.kind='clinical_photography' and consent.accepted) as has_consent
    from attendance_scope attendance
  ), attempts as materialized (
    select 'operational:'||attempt.id::text as attempt_key,attempt.attempted_at
    from public.retorno_tentativas attempt where attempt.clinic_id=p_clinic_id
    union all
    select 'reactivation:'||attempt.id::text,attempt.attempted_at
    from public.reactivation_contact_attempts attempt where attempt.clinic_id=p_clinic_id
  ), total_counts as materialized (
    select
      (select pg_catalog.count(*) from attendance_scope)::bigint as attendances,
      (select pg_catalog.count(*) from comparison_state state
        where state.has_before and state.has_after and state.has_consent)::bigint as comparisons,
      (select pg_catalog.count(*) from public.acompanhamento_planos plan
        where plan.clinic_id=p_clinic_id and plan.plan_kind='post_procedure'
          and (plan.created_at at time zone 'America/Sao_Paulo')::date
            between p_start_date and p_end_date)::bigint as post_plans,
      (select pg_catalog.count(*) from public.acompanhamento_planos plan
        where plan.clinic_id=p_clinic_id and plan.plan_kind='reactivation'
          and (plan.created_at at time zone 'America/Sao_Paulo')::date
            between p_start_date and p_end_date)::bigint as reactivations,
      (select pg_catalog.count(distinct attempt.attempt_key) from attempts attempt
        where (attempt.attempted_at at time zone 'America/Sao_Paulo')::date
          between p_start_date and p_end_date)::bigint as attempts,
      (select pg_catalog.count(*) from public.operacao_rentabilidade_atendimentos profitability
        where profitability.clinic_id=p_clinic_id and profitability.attendance_date
          between p_start_date and p_end_date and profitability.is_incomplete)::bigint as incomplete_stock
  ), grouped as materialized (
    select attendance.procedure_kind,
      pg_catalog.count(distinct attendance.id)::bigint as attendances,
      pg_catalog.count(distinct attendance.id) filter(where comparison.has_before and comparison.has_after
        and comparison.has_consent)::bigint as comparisons,
      pg_catalog.count(distinct attendance.id) filter(where profitability.is_incomplete)::bigint as incomplete_stock,
      pg_catalog.count(distinct plan.id) filter(where plan.plan_kind='post_procedure')::bigint
        as post_plans
    from attendance_scope attendance
    join comparison_state comparison on comparison.id=attendance.id
    left join public.operacao_rentabilidade_atendimentos profitability
      on profitability.clinic_id=p_clinic_id and profitability.attendance_id=attendance.id
    left join public.acompanhamento_planos plan on plan.clinic_id=p_clinic_id
      and plan.attendance_id=attendance.id
    group by attendance.procedure_kind
  )
  select pg_catalog.jsonb_build_object(
    'periodo',pg_catalog.jsonb_build_object('inicio',p_start_date,'fim',p_end_date,
      'timezone','America/Sao_Paulo'),
    'totais',pg_catalog.jsonb_build_object(
      'atendimentos',private.fase2_suppress_count(total.attendances),
      'atendimentos_com_antes_depois_e_consentimento',private.fase2_suppress_count(total.comparisons),
      'sequencias_pos_procedimento_ativadas',private.fase2_suppress_count(total.post_plans),
      'reativacoes_ativadas',private.fase2_suppress_count(total.reactivations),
      'tentativas_manuais_registradas',private.fase2_suppress_count(total.attempts),
      'atendimentos_com_estoque_incompleto',private.fase2_suppress_count(total.incomplete_stock)),
    'por_procedimento',coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'procedimento',grouped.procedure_kind,
      'atendimentos',private.fase2_suppress_count(grouped.attendances),
      'atendimentos_com_antes_depois_e_consentimento',private.fase2_suppress_count(grouped.comparisons),
      'sequencias_pos_procedimento_ativadas',private.fase2_suppress_count(grouped.post_plans),
      'atendimentos_com_estoque_incompleto',private.fase2_suppress_count(grouped.incomplete_stock)
    ) order by grouped.procedure_kind) from grouped),'[]'::jsonb),
    'agregado_somente',true,'mensagem_enviada',false
  ) into v_result from total_counts total;
  return v_result;
end;
$function$;

revoke all on function private.fase2_suppress_count(bigint) from public,anon,authenticated,service_role;
revoke all on function public.gestao_relatorio_acompanhamentos_fase2(uuid,uuid,text,text,text,date,date)
  from public,anon,authenticated,service_role;
grant execute on function public.gestao_relatorio_acompanhamentos_fase2(uuid,uuid,text,text,text,date,date)
  to service_role;
comment on function public.gestao_relatorio_acompanhamentos_fase2(uuid,uuid,text,text,text,date,date) is
  'Agregado operacional sem PII/IDs/URLs/notas; suprime cada celula com contagem entre 1 e 4.';
commit;

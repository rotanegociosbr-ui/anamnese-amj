begin;

-- Estado central da automacao da agenda. A permissao de notificacoes continua
-- sendo local a cada navegador/aparelho; esta tabela informa somente o motor
-- do servidor, que funciona mesmo com o painel fechado.
create table if not exists public.agenda_automacao_estado (
  id boolean primary key default true check (id),
  ultima_execucao timestamptz,
  ultimo_sucesso boolean not null default false,
  prontos_promovidos integer not null default 0 check (prontos_promovidos >= 0),
  cancelados integer not null default 0 check (cancelados >= 0),
  pendencias_abertas integer not null default 0 check (pendencias_abertas >= 0),
  ultimo_erro_codigo text,
  updated_at timestamptz not null default now(),
  constraint agenda_automacao_estado_erro_check
    check (ultimo_erro_codigo is null or char_length(ultimo_erro_codigo) <= 80)
);

insert into public.agenda_automacao_estado (id)
values (true)
on conflict (id) do nothing;

alter table public.agenda_automacao_estado enable row level security;
revoke all on table public.agenda_automacao_estado from public, anon, authenticated;
grant select, update on table public.agenda_automacao_estado to service_role;

-- Um retorno convertido em novo horario e historico, nao mensagem enviada.
alter table public.agendamento_lembretes
  add column if not exists convertido_em timestamptz;

alter table public.agendamento_lembretes
  drop constraint if exists agendamento_lembretes_status_check;
alter table public.agendamento_lembretes
  add constraint agendamento_lembretes_status_check
  check (status in ('pendente', 'pronto', 'enviado', 'falhou', 'cancelado', 'convertido'));
alter table public.agendamento_lembretes
  add constraint agendamento_lembretes_convertido_check
  check (status <> 'convertido' or convertido_em is not null);

-- Processamento central idempotente. O lock transacional impede duas
-- execucoes concorrentes e a funcao nao faz chamadas externas.
create or replace function public.agenda_processar_lembretes()
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_agora timestamptz := clock_timestamp();
  v_promovidos integer := 0;
  v_cancelados integer := 0;
  v_pendencias integer := 0;
begin
  if not pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended('amj-agenda-processar-lembretes', 0)
  ) then
    return jsonb_build_object('executado', false, 'motivo', 'execucao_concorrente');
  end if;

  -- Cancela somente itens abertos que deixaram de ser validos. Itens enviados
  -- ou convertidos permanecem imutaveis como trilha operacional.
  update public.agendamento_lembretes as lembrete
  set
    status = 'cancelado',
    updated_at = v_agora
  from public.agendamentos_clinica as agendamento
  where agendamento.id = lembrete.agendamento_id
    and lembrete.status in ('pendente', 'pronto', 'falhou')
    and (
      agendamento.arquivado_em is not null
      or not agendamento.lembretes_autorizados
      or (
        lembrete.tipo = 'retorno'
        and (
          agendamento.retorno_em is null
          or agendamento.status not in ('solicitado', 'aguardando_confirmacao', 'confirmado', 'concluido')
          or lembrete.previsto_em <> (
            (agendamento.retorno_em + time '09:00') at time zone 'America/Sao_Paulo'
          )
        )
      )
      or (
        lembrete.tipo <> 'retorno'
        and agendamento.status not in ('solicitado', 'aguardando_confirmacao', 'confirmado')
      )
      or (
        lembrete.tipo = 'confirmacao'
        and (
          agendamento.status not in ('solicitado', 'aguardando_confirmacao')
          or v_agora > agendamento.inicio_em + interval '1 hour'
        )
      )
      or (
        lembrete.tipo = '24h'
        and (
          not agendamento.lembrete_24h
          or lembrete.previsto_em <> agendamento.inicio_em - interval '24 hours'
          or v_agora >= agendamento.inicio_em - interval '2 hours'
        )
      )
      or (
        lembrete.tipo = '2h'
        and (
          not agendamento.lembrete_2h
          or lembrete.previsto_em <> agendamento.inicio_em - interval '2 hours'
          or v_agora > agendamento.inicio_em + interval '1 hour'
        )
      )
    );
  get diagnostics v_cancelados = row_count;

  update public.agendamento_lembretes as lembrete
  set
    status = 'pronto',
    updated_at = v_agora
  from public.agendamentos_clinica as agendamento
  where agendamento.id = lembrete.agendamento_id
    and lembrete.status = 'pendente'
    and lembrete.previsto_em <= v_agora
    and agendamento.arquivado_em is null
    and agendamento.lembretes_autorizados
    and (
      (
        lembrete.tipo = 'confirmacao'
        and agendamento.status in ('solicitado', 'aguardando_confirmacao')
        and v_agora <= agendamento.inicio_em + interval '1 hour'
      )
      or (
        lembrete.tipo = '24h'
        and agendamento.status in ('solicitado', 'aguardando_confirmacao', 'confirmado')
        and agendamento.lembrete_24h
        and lembrete.previsto_em = agendamento.inicio_em - interval '24 hours'
        and v_agora < agendamento.inicio_em - interval '2 hours'
      )
      or (
        lembrete.tipo = '2h'
        and agendamento.status in ('solicitado', 'aguardando_confirmacao', 'confirmado')
        and agendamento.lembrete_2h
        and lembrete.previsto_em = agendamento.inicio_em - interval '2 hours'
        and v_agora <= agendamento.inicio_em + interval '1 hour'
      )
      or (
        lembrete.tipo = 'retorno'
        and agendamento.retorno_em is not null
        and agendamento.status in ('solicitado', 'aguardando_confirmacao', 'confirmado', 'concluido')
        and lembrete.previsto_em = (
          (agendamento.retorno_em + time '09:00') at time zone 'America/Sao_Paulo'
        )
      )
    );
  get diagnostics v_promovidos = row_count;

  select count(*)::integer
  into v_pendencias
  from public.agendamento_lembretes as lembrete
  join public.agendamentos_clinica as agendamento
    on agendamento.id = lembrete.agendamento_id
  where lembrete.status = 'pronto'
    and agendamento.arquivado_em is null
    and agendamento.lembretes_autorizados;

  update public.agenda_automacao_estado
  set
    ultima_execucao = v_agora,
    ultimo_sucesso = true,
    prontos_promovidos = v_promovidos,
    cancelados = v_cancelados,
    pendencias_abertas = v_pendencias,
    ultimo_erro_codigo = null,
    updated_at = v_agora
  where id;

  return jsonb_build_object(
    'executado', true,
    'prontos_promovidos', v_promovidos,
    'cancelados', v_cancelados,
    'pendencias_abertas', v_pendencias,
    'executado_em', v_agora
  );
exception
  when others then
    update public.agenda_automacao_estado
    set
      ultima_execucao = v_agora,
      ultimo_sucesso = false,
      ultimo_erro_codigo = sqlstate,
      updated_at = v_agora
    where id;
    return jsonb_build_object('executado', false, 'erro_codigo', sqlstate);
end;
$$;

revoke all on function public.agenda_processar_lembretes() from public, anon, authenticated;
grant execute on function public.agenda_processar_lembretes() to service_role;

-- Corrige apenas estados impossiveis: um atendimento futuro nao pode ter sido
-- classificado como falta. A lista temporaria limita a reabertura aos mesmos
-- registros corrigidos por esta migration.
create temporary table agenda_status_futuro_corrigido on commit drop as
select id
from public.agendamentos_clinica
where status = 'nao_compareceu'
  and inicio_em > now()
  and arquivado_em is null;

update public.agendamentos_clinica as agendamento
set
  status = 'aguardando_confirmacao',
  versao = versao + 1,
  updated_at = now()
where agendamento.id in (select id from agenda_status_futuro_corrigido);

update public.agendamento_lembretes as lembrete
set
  status = case when lembrete.previsto_em <= now() then 'pronto' else 'pendente' end,
  enviado_em = null,
  convertido_em = null,
  provider_message_id = null,
  erro_codigo = null,
  marcado_manualmente = false,
  updated_at = now()
where lembrete.agendamento_id in (select id from agenda_status_futuro_corrigido)
  and lembrete.status = 'cancelado';

-- O job usa apenas SQL local e nao precisa de pg_net nem de segredo externo.
create extension if not exists pg_cron;
select cron.schedule(
  'amj-agenda-alertas-centrais',
  '* * * * *',
  'select public.agenda_processar_lembretes();'
);

select public.agenda_processar_lembretes();

commit;

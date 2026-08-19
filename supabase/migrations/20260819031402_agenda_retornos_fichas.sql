begin;

-- Agenda privada da Ana Maria Jacob Estética.
-- O navegador nunca acessa estas tabelas diretamente: somente a Edge Function
-- agenda-fichas, autenticada pela mesma senha do painel, usa service_role.
create table if not exists public.agendamentos_clinica (
  id uuid primary key default gen_random_uuid(),
  idempotency_key uuid not null unique,
  nome text not null,
  telefone text not null,
  email text,
  categoria text not null,
  procedimento text not null,
  inicio_em timestamptz not null,
  fim_em timestamptz not null,
  fuso_horario text not null default 'America/Sao_Paulo',
  status text not null default 'aguardando_confirmacao',
  origem text not null default 'painel',
  observacoes text,
  retorno_de_id uuid references public.agendamentos_clinica(id) on delete restrict,
  retorno_em date,
  lembretes_autorizados boolean not null default false,
  lembretes_autorizados_em timestamptz,
  lembretes_revogados_em timestamptz,
  lembrete_24h boolean not null default false,
  lembrete_2h boolean not null default false,
  cancelado_em timestamptz,
  motivo_cancelamento text,
  arquivado_em timestamptz,
  versao integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint agendamentos_clinica_nome_check
    check (char_length(btrim(nome)) between 2 and 120),
  constraint agendamentos_clinica_telefone_check
    check (telefone ~ '^\+55[1-9][0-9]{9,10}$'),
  constraint agendamentos_clinica_email_check
    check (
      email is null or (
        char_length(email) <= 254 and
        email ~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
      )
    ),
  constraint agendamentos_clinica_categoria_check
    check (categoria in ('avaliacao', 'procedimento', 'retorno', 'acompanhamento')),
  constraint agendamentos_clinica_procedimento_check
    check (char_length(btrim(procedimento)) between 2 and 160),
  constraint agendamentos_clinica_periodo_check
    check (fim_em > inicio_em and fim_em <= inicio_em + interval '12 hours'),
  constraint agendamentos_clinica_fuso_check
    check (fuso_horario = 'America/Sao_Paulo'),
  constraint agendamentos_clinica_status_check
    check (
      status in (
        'solicitado',
        'aguardando_confirmacao',
        'confirmado',
        'concluido',
        'cancelado',
        'nao_compareceu',
        'reagendado'
      )
    ),
  constraint agendamentos_clinica_origem_check
    check (origem in ('painel', 'site', 'whatsapp', 'telefone', 'outro')),
  constraint agendamentos_clinica_observacoes_check
    check (observacoes is null or char_length(observacoes) <= 2000),
  constraint agendamentos_clinica_cancelamento_check
    check (
      status <> 'cancelado' or
      (cancelado_em is not null and char_length(btrim(coalesce(motivo_cancelamento, ''))) between 2 and 500)
    ),
  constraint agendamentos_clinica_lembretes_check
    check (
      (not lembretes_autorizados and not lembrete_24h and not lembrete_2h) or
      (lembretes_autorizados and lembretes_autorizados_em is not null and lembretes_revogados_em is null)
    ),
  constraint agendamentos_clinica_versao_check
    check (versao > 0),

  -- A clínica trabalha com um atendimento por vez. A restrição também fecha
  -- a janela de corrida entre duas chamadas simultâneas da Edge Function.
  constraint agendamentos_clinica_sem_sobreposicao
    exclude using gist (
      tstzrange(inicio_em, fim_em, '[)') with &&
    )
    where (
      arquivado_em is null and
      status in ('solicitado', 'aguardando_confirmacao', 'confirmado')
    )
);

comment on table public.agendamentos_clinica is
  'Agenda e retornos privados da clínica, acessíveis somente por Edge Function com service_role.';
comment on column public.agendamentos_clinica.telefone is
  'WhatsApp normalizado em E.164 brasileiro, por exemplo +5531999999999.';
comment on column public.agendamentos_clinica.idempotency_key is
  'Chave gerada uma vez no cliente e reutilizada em tentativas do mesmo agendamento.';

create index if not exists agendamentos_clinica_status_inicio_idx
  on public.agendamentos_clinica (status, inicio_em)
  where arquivado_em is null;
create index if not exists agendamentos_clinica_telefone_inicio_idx
  on public.agendamentos_clinica (telefone, inicio_em desc);
create index if not exists agendamentos_clinica_retorno_de_idx
  on public.agendamentos_clinica (retorno_de_id)
  where retorno_de_id is not null;
create index if not exists agendamentos_clinica_retorno_em_idx
  on public.agendamentos_clinica (retorno_em)
  where retorno_em is not null and arquivado_em is null;

create table if not exists public.agendamento_lembretes (
  id uuid primary key default gen_random_uuid(),
  agendamento_id uuid not null
    references public.agendamentos_clinica(id) on delete restrict,
  tipo text not null,
  canal text not null default 'whatsapp',
  previsto_em timestamptz not null,
  status text not null default 'pendente',
  tentativas smallint not null default 0,
  template_key text not null,
  enviado_em timestamptz,
  provider_message_id text,
  erro_codigo text,
  marcado_manualmente boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint agendamento_lembretes_tipo_check
    check (tipo in ('confirmacao', '24h', '2h', 'retorno')),
  constraint agendamento_lembretes_canal_check
    check (canal in ('interno', 'whatsapp', 'email')),
  constraint agendamento_lembretes_status_check
    check (status in ('pendente', 'pronto', 'enviado', 'falhou', 'cancelado')),
  constraint agendamento_lembretes_tentativas_check
    check (tentativas between 0 and 10),
  constraint agendamento_lembretes_template_check
    check (template_key ~ '^[a-z0-9_]{3,80}$'),
  constraint agendamento_lembretes_enviado_check
    check (status <> 'enviado' or enviado_em is not null),
  constraint agendamento_lembretes_provider_check
    check (provider_message_id is null or char_length(provider_message_id) <= 300),
  constraint agendamento_lembretes_erro_check
    check (erro_codigo is null or char_length(erro_codigo) <= 120),
  constraint agendamento_lembretes_unico
    unique (agendamento_id, tipo, canal, previsto_em)
);

comment on table public.agendamento_lembretes is
  'Fila e histórico de avisos da agenda. Um registro pronto não comprova envio externo.';
comment on column public.agendamento_lembretes.template_key is
  'Identificador do texto padronizado; o conteúdo completo não é duplicado no banco.';

create index if not exists agendamento_lembretes_agendamento_idx
  on public.agendamento_lembretes (agendamento_id, previsto_em desc);
create index if not exists agendamento_lembretes_pendentes_idx
  on public.agendamento_lembretes (previsto_em)
  where status in ('pendente', 'pronto');

alter table public.agendamentos_clinica enable row level security;
alter table public.agendamento_lembretes enable row level security;

-- Nenhuma policy pública é criada. O aviso INFO "RLS enabled no policy" é
-- intencional: o painel passa obrigatoriamente pela Edge Function protegida.
revoke all on table public.agendamentos_clinica from public, anon, authenticated;
revoke all on table public.agendamento_lembretes from public, anon, authenticated;
grant select, insert, update on table public.agendamentos_clinica to service_role;
grant select, insert, update on table public.agendamento_lembretes to service_role;

commit;

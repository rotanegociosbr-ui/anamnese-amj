begin;

-- Prontuários clínicos não são apagados pelo painel. A Lei 13.787/2018
-- estabelece guarda mínima de 20 anos a partir do último registro. Esta
-- migration oferece arquivamento reversível, com motivo e trilha de auditoria.
alter table public.anamneses
  add column if not exists arquivado_em timestamptz,
  add column if not exists arquivado_motivo text;

alter table public.documentos_clinicos
  add column if not exists arquivado_em timestamptz,
  add column if not exists arquivado_motivo text;

alter table public.anamneses
  drop constraint if exists anamneses_arquivamento_check;
alter table public.anamneses
  add constraint anamneses_arquivamento_check
  check (
    (arquivado_em is null and arquivado_motivo is null) or
    (
      arquivado_em is not null and
      char_length(btrim(coalesce(arquivado_motivo, ''))) between 3 and 500
    )
  );

alter table public.documentos_clinicos
  drop constraint if exists documentos_clinicos_arquivamento_check;
alter table public.documentos_clinicos
  add constraint documentos_clinicos_arquivamento_check
  check (
    (arquivado_em is null and arquivado_motivo is null) or
    (
      arquivado_em is not null and
      char_length(btrim(coalesce(arquivado_motivo, ''))) between 3 and 500
    )
  );

create index if not exists anamneses_ativas_criado_idx
  on public.anamneses (criado_em desc)
  where arquivado_em is null;
create index if not exists documentos_clinicos_ativos_recebido_idx
  on public.documentos_clinicos (recebido_em desc)
  where arquivado_em is null;

create table if not exists public.fichas_acoes_auditoria (
  id bigint generated always as identity primary key,
  origem text not null,
  documento_id uuid not null,
  acao text not null,
  motivo text not null,
  criado_em timestamptz not null default now(),

  constraint fichas_acoes_auditoria_origem_check
    check (origem in ('anamnese', 'documento_clinico')),
  constraint fichas_acoes_auditoria_acao_check
    check (acao in ('arquivar', 'restaurar')),
  constraint fichas_acoes_auditoria_motivo_check
    check (char_length(btrim(motivo)) between 3 and 500)
);

comment on table public.fichas_acoes_auditoria is
  'Trilha mínima e imutável de arquivamento/restauração no app Fichas; não replica dados clínicos.';

create index if not exists fichas_acoes_auditoria_documento_idx
  on public.fichas_acoes_auditoria (origem, documento_id, criado_em desc);

alter table public.fichas_acoes_auditoria enable row level security;
revoke all on table public.fichas_acoes_auditoria from public, anon, authenticated;
grant select on table public.fichas_acoes_auditoria to service_role;

-- Fecha privilégios herdados excessivos da tabela antiga. A paciente continua
-- podendo apenas inserir a própria anamnese; leitura e alteração passam pela
-- Edge Function protegida do painel.
revoke all on table public.anamneses from public, anon, authenticated;
grant insert on table public.anamneses to anon, authenticated;

-- A view histórica foi criada com privilégios amplos. Ela contém resumos de
-- saúde e deve ser consultada exclusivamente pelo backend autenticado.
revoke all on table public.anamneses_resumo from public, anon, authenticated;
grant select on table public.anamneses_resumo to service_role;

create or replace function public.painel_arquivar_ficha(
  p_origem text,
  p_documento_id uuid,
  p_acao text,
  p_motivo text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_arquivado_em timestamptz;
  v_motivo text := btrim(coalesce(p_motivo, ''));
  v_alterado boolean := false;
begin
  if p_origem not in ('anamnese', 'documento_clinico') then
    raise exception 'origem_invalida' using errcode = '22023';
  end if;
  if p_acao not in ('arquivar', 'restaurar') then
    raise exception 'acao_invalida' using errcode = '22023';
  end if;
  if char_length(v_motivo) not between 3 and 500 then
    raise exception 'motivo_invalido' using errcode = '22023';
  end if;

  if p_origem = 'anamnese' then
    select arquivado_em into v_arquivado_em
      from public.anamneses where id = p_documento_id for update;
    if not found then
      raise exception 'ficha_nao_encontrada' using errcode = 'P0002';
    end if;

    if p_acao = 'arquivar' and v_arquivado_em is null then
      update public.anamneses
        set arquivado_em = now(), arquivado_motivo = v_motivo
        where id = p_documento_id;
      v_alterado := true;
    elsif p_acao = 'restaurar' and v_arquivado_em is not null then
      update public.anamneses
        set arquivado_em = null, arquivado_motivo = null
        where id = p_documento_id;
      v_alterado := true;
    end if;
  else
    select arquivado_em into v_arquivado_em
      from public.documentos_clinicos where id = p_documento_id for update;
    if not found then
      raise exception 'ficha_nao_encontrada' using errcode = 'P0002';
    end if;

    if p_acao = 'arquivar' and v_arquivado_em is null then
      update public.documentos_clinicos
        set arquivado_em = now(), arquivado_motivo = v_motivo, updated_at = now()
        where id = p_documento_id;
      v_alterado := true;
    elsif p_acao = 'restaurar' and v_arquivado_em is not null then
      update public.documentos_clinicos
        set arquivado_em = null, arquivado_motivo = null, updated_at = now()
        where id = p_documento_id;
      v_alterado := true;
    end if;
  end if;

  if v_alterado then
    insert into public.fichas_acoes_auditoria (origem, documento_id, acao, motivo)
      values (p_origem, p_documento_id, p_acao, v_motivo);
  end if;

  return jsonb_build_object(
    'ok', true,
    'alterado', v_alterado,
    'arquivado', p_acao = 'arquivar'
  );
end;
$$;

revoke all on function public.painel_arquivar_ficha(text, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.painel_arquivar_ficha(text, uuid, text, text)
  to service_role;

commit;

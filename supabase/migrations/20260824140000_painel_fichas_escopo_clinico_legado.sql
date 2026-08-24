begin;

-- Anamneses, documentos e os buckets historicos ainda nao possuem clinic_id.
-- Enquanto essa origem existir, ela so pode ser usada no projeto singleton cuja
-- unica clinica seja exatamente a clinica autenticada pelo Edge.
--
-- Este indice constante tambem elimina o TOCTOU entre a validacao do Edge e as
-- consultas service_role seguintes: nenhuma transacao concorrente consegue
-- confirmar uma segunda clinica. Remover este indice somente depois de adicionar
-- clinic_id aos dois tipos de ficha, tenantizar os caminhos dos dois buckets e
-- fazer todas as leituras, assinaturas e mutacoes filtrarem esse clinic_id.
create unique index painel_fichas_legado_clinica_unica_guard
  on public.clinics ((true));

comment on index public.painel_fichas_legado_clinica_unica_guard is
  'Guard reversivel: remover somente apos tenantizar tabelas, buckets e fluxos clinicos legados.';

create or replace function private.painel_escopo_clinico_legado_valido(
  p_clinic_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_clinic_id is not null
    and (select pg_catalog.count(*) from public.clinics) = 1
    and exists (
      select 1
      from public.clinics as clinic
      where clinic.id = p_clinic_id
    );
$$;

revoke all on function private.painel_escopo_clinico_legado_valido(uuid)
  from public, anon, authenticated, service_role;

-- O Edge usa somente o resultado booleano; nenhuma identidade de outra clinica
-- e devolvida. Falha de RPC ou false sao tratados como indisponibilidade.
create or replace function public.painel_validar_escopo_clinico_legado(
  p_clinic_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.painel_escopo_clinico_legado_valido(p_clinic_id);
$$;

revoke all on function public.painel_validar_escopo_clinico_legado(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.painel_validar_escopo_clinico_legado(uuid)
  to service_role;

-- Assinatura tenant-aware usada pelo Edge atualizado. A verificacao ocorre
-- antes de procurar ou bloquear qualquer ficha, evitando inclusive IDOR por ID.
create or replace function public.painel_arquivar_ficha(
  p_clinic_id uuid,
  p_origem text,
  p_documento_id uuid,
  p_acao text,
  p_motivo text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_arquivado_em timestamptz;
  v_motivo text := pg_catalog.btrim(coalesce(p_motivo, ''));
  v_alterado boolean := false;
begin
  if not private.painel_escopo_clinico_legado_valido(p_clinic_id) then
    raise exception 'clinic_scope_ambiguous' using errcode = '55000';
  end if;

  if p_origem is null or p_origem not in ('anamnese', 'documento_clinico') then
    raise exception 'origem_invalida' using errcode = '22023';
  end if;
  if p_acao is null or p_acao not in ('arquivar', 'restaurar') then
    raise exception 'acao_invalida' using errcode = '22023';
  end if;
  if pg_catalog.char_length(v_motivo) not between 3 and 500 then
    raise exception 'motivo_invalido' using errcode = '22023';
  end if;

  if p_origem = 'anamnese' then
    select ficha.arquivado_em
      into v_arquivado_em
      from public.anamneses as ficha
      where ficha.id = p_documento_id
      for update;
    if not found then
      raise exception 'ficha_nao_encontrada' using errcode = 'P0002';
    end if;

    if p_acao = 'arquivar' and v_arquivado_em is null then
      update public.anamneses as ficha
        set arquivado_em = pg_catalog.now(), arquivado_motivo = v_motivo
        where ficha.id = p_documento_id;
      v_alterado := true;
    elsif p_acao = 'restaurar' and v_arquivado_em is not null then
      update public.anamneses as ficha
        set arquivado_em = null, arquivado_motivo = null
        where ficha.id = p_documento_id;
      v_alterado := true;
    end if;
  else
    select documento.arquivado_em
      into v_arquivado_em
      from public.documentos_clinicos as documento
      where documento.id = p_documento_id
      for update;
    if not found then
      raise exception 'ficha_nao_encontrada' using errcode = 'P0002';
    end if;

    if p_acao = 'arquivar' and v_arquivado_em is null then
      update public.documentos_clinicos as documento
        set arquivado_em = pg_catalog.now(),
            arquivado_motivo = v_motivo,
            updated_at = pg_catalog.now()
        where documento.id = p_documento_id;
      v_alterado := true;
    elsif p_acao = 'restaurar' and v_arquivado_em is not null then
      update public.documentos_clinicos as documento
        set arquivado_em = null,
            arquivado_motivo = null,
            updated_at = pg_catalog.now()
        where documento.id = p_documento_id;
      v_alterado := true;
    end if;
  end if;

  if v_alterado then
    insert into public.fichas_acoes_auditoria (
      origem,
      documento_id,
      acao,
      motivo
    ) values (
      p_origem,
      p_documento_id,
      p_acao,
      v_motivo
    );
  end if;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'alterado', v_alterado,
    'arquivado', p_acao = 'arquivar'
  );
end;
$$;

revoke all on function public.painel_arquivar_ficha(uuid, text, uuid, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.painel_arquivar_ficha(uuid, text, uuid, text, text)
  to service_role;

-- Compatibilidade fail-closed para qualquer chamador service_role ainda usando
-- a assinatura historica. Em singleton ela delega sem alterar o contrato.
create or replace function public.painel_arquivar_ficha(
  p_origem text,
  p_documento_id uuid,
  p_acao text,
  p_motivo text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_clinic_id uuid;
begin
  select clinic.id
    into v_clinic_id
    from public.clinics as clinic
    order by clinic.id
    limit 1;

  if not private.painel_escopo_clinico_legado_valido(v_clinic_id) then
    raise exception 'clinic_scope_ambiguous' using errcode = '55000';
  end if;

  return public.painel_arquivar_ficha(
    p_clinic_id => v_clinic_id,
    p_origem => p_origem,
    p_documento_id => p_documento_id,
    p_acao => p_acao,
    p_motivo => p_motivo
  );
end;
$$;

revoke all on function public.painel_arquivar_ficha(text, uuid, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.painel_arquivar_ficha(text, uuid, text, text)
  to service_role;

commit;

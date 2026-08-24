-- Exclusao definitiva excepcional de fichas sem vinculos de retencao.
--
-- O fluxo e deliberadamente dividido em duas fases: a Edge prepara e trava o
-- alvo, remove os objetos exatos pela Storage API e, por fim, conclui o DELETE
-- transacional. Nenhuma exclusao em cascata e usada. A prova de senha one-time,
-- o AAL2 e o papel owner sao validados pela Edge antes de chamar estas RPCs;
-- as RPCs revalidam a titularidade ativa no banco.

begin;

create schema if not exists private;

create table private.fichas_exclusao_intencoes (
  clinic_id uuid not null references public.clinics(id) on delete restrict,
  origem text not null,
  documento_id uuid not null,
  operation_id uuid not null,
  actor_user_id uuid not null references auth.users(id) on delete restrict,
  categoria text not null,
  motivo_hmac bytea not null,
  registro_fingerprint bytea not null,
  preparado_em timestamptz not null default pg_catalog.clock_timestamp(),
  expira_em timestamptz not null,
  request_id uuid not null,
  primary key (clinic_id, origem, documento_id),
  constraint fichas_exclusao_intencoes_operation_unique
    unique (clinic_id, operation_id),
  constraint fichas_exclusao_intencoes_origem_check
    check (origem in ('anamnese', 'documento_clinico')),
  constraint fichas_exclusao_intencoes_categoria_check
    check (categoria in ('teste', 'duplicada', 'erro_cadastral', 'solicitacao_validada')),
  constraint fichas_exclusao_intencoes_motivo_hmac_check
    check (pg_catalog.octet_length(motivo_hmac) = 32),
  constraint fichas_exclusao_intencoes_fingerprint_check
    check (pg_catalog.octet_length(registro_fingerprint) = 32),
  constraint fichas_exclusao_intencoes_expiracao_check
    check (expira_em > preparado_em and expira_em <= preparado_em + interval '20 minutes')
);

comment on table private.fichas_exclusao_intencoes is
  'Travas efemeras para exclusao de fichas. Nao replica nome, CPF, telefone, respostas nem caminhos de Storage.';

create index fichas_exclusao_intencoes_expira_idx
  on private.fichas_exclusao_intencoes (expira_em);

alter table private.fichas_exclusao_intencoes enable row level security;
revoke all on table private.fichas_exclusao_intencoes
  from public, anon, authenticated, service_role;

create table public.fichas_exclusao_tombstones (
  id bigint generated always as identity primary key,
  clinic_id uuid not null references public.clinics(id) on delete restrict,
  origem text not null,
  alvo_hmac bytea not null,
  categoria text not null,
  motivo_hmac bytea not null,
  operation_id uuid not null,
  request_id uuid not null,
  actor_user_id uuid not null references auth.users(id) on delete restrict,
  objetos_storage_removidos smallint not null,
  excluido_em timestamptz not null default pg_catalog.clock_timestamp(),
  constraint fichas_exclusao_tombstones_alvo_unique
    unique (clinic_id, origem, alvo_hmac),
  constraint fichas_exclusao_tombstones_operation_unique
    unique (clinic_id, operation_id),
  constraint fichas_exclusao_tombstones_origem_check
    check (origem in ('anamnese', 'documento_clinico')),
  constraint fichas_exclusao_tombstones_categoria_check
    check (categoria in ('teste', 'duplicada', 'erro_cadastral', 'solicitacao_validada')),
  constraint fichas_exclusao_tombstones_alvo_hmac_check
    check (pg_catalog.octet_length(alvo_hmac) = 32),
  constraint fichas_exclusao_tombstones_motivo_hmac_check
    check (pg_catalog.octet_length(motivo_hmac) = 32),
  constraint fichas_exclusao_tombstones_storage_count_check
    check (objetos_storage_removidos between 0 and 4)
);

comment on table public.fichas_exclusao_tombstones is
  'Auditoria minima e imutavel de exclusoes definitivas. Identificador do paciente e motivo ficam somente em HMAC-SHA256; nenhum dado clinico e preservado.';

alter table public.fichas_exclusao_tombstones enable row level security;
revoke all on table public.fichas_exclusao_tombstones
  from public, anon, authenticated, service_role;
grant select on table public.fichas_exclusao_tombstones to service_role;

create or replace function private.fichas_exclusao_tombstone_append_only()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  raise exception 'fichas_exclusao_tombstone_append_only' using errcode = '55000';
end;
$function$;

revoke execute on function private.fichas_exclusao_tombstone_append_only()
  from public, anon, authenticated, service_role;

create trigger fichas_exclusao_tombstones_append_only
before update or delete on public.fichas_exclusao_tombstones
for each row execute function private.fichas_exclusao_tombstone_append_only();

create or replace function private.fichas_exclusao_hmac(p_text text)
returns bytea
language sql
stable
security definer
set search_path = ''
as $function$
  select extensions.hmac(
    pg_catalog.convert_to(p_text, 'UTF8'),
    secret.secret,
    'sha256'
  )
  from private.clinic_password_proof_secrets as secret
  where secret.singleton = 1;
$function$;

revoke execute on function private.fichas_exclusao_hmac(text)
  from public, anon, authenticated, service_role;

create or replace function private.fichas_exclusao_vinculos(
  p_clinic_id uuid,
  p_origem text,
  p_documento_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_blockers jsonb := '[]'::jsonb;
  v_count bigint;
  v_patient_ids uuid[] := '{}'::uuid[];
  v_target regclass;
  v_fk record;
  v_fk_total bigint := 0;
begin
  if p_origem not in ('anamnese', 'documento_clinico') then
    return pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'codigo', 'origem_invalida',
      'descricao', 'O tipo da ficha nao e reconhecido.',
      'quantidade', 1
    ));
  end if;

  select pg_catalog.count(*)
  into v_count
  from public.patient_source_links as link
  where link.clinic_id = p_clinic_id
    and link.source_kind = p_origem
    and link.source_id = p_documento_id
    and link.status = 'confirmado';
  if v_count > 0 then
    v_blockers := v_blockers || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'codigo', 'paciente_confirmado',
        'descricao', 'A ficha esta vinculada a um cadastro de paciente confirmado.',
        'quantidade', v_count
      )
    );
  end if;

  select pg_catalog.count(*)
  into v_count
  from public.patient_source_links as link
  where link.clinic_id = p_clinic_id
    and link.source_kind = p_origem
    and link.source_id = p_documento_id
    and link.status <> 'confirmado';
  if v_count > 0 then
    v_blockers := v_blockers || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'codigo', 'historico_vinculo_paciente',
        'descricao', 'Existe um vinculo ou historico de vinculacao com cadastro de paciente.',
        'quantidade', v_count
      )
    );
  end if;

  select coalesce(pg_catalog.array_agg(distinct link.patient_id), '{}'::uuid[])
  into v_patient_ids
  from public.patient_source_links as link
  where link.clinic_id = p_clinic_id
    and link.source_kind = p_origem
    and link.source_id = p_documento_id
    and link.status = 'confirmado';

  if pg_catalog.cardinality(v_patient_ids) > 0 then
    select pg_catalog.count(*)
    into v_count
    from public.patient_source_links as appointment_link
    where appointment_link.clinic_id = p_clinic_id
      and appointment_link.patient_id = any(v_patient_ids)
      and appointment_link.source_kind = 'agendamento'
      and appointment_link.status = 'confirmado';
    if v_count > 0 then
      v_blockers := v_blockers || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'codigo', 'agenda',
          'descricao', 'O paciente vinculado possui agendamento registrado.',
          'quantidade', v_count
        )
      );
    end if;

    select pg_catalog.count(*)
    into v_count
    from public.atendimentos_realizados as attendance
    where attendance.clinic_id = p_clinic_id
      and attendance.patient_id = any(v_patient_ids);
    if v_count > 0 then
      v_blockers := v_blockers || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'codigo', 'atendimento',
          'descricao', 'O paciente vinculado possui atendimento registrado.',
          'quantidade', v_count
        )
      );
    end if;

    select pg_catalog.count(*)
    into v_count
    from public.protocols as protocol
    where protocol.clinic_id = p_clinic_id
      and protocol.patient_id = any(v_patient_ids);
    if v_count > 0 then
      v_blockers := v_blockers || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'codigo', 'prontuario_protocolo',
          'descricao', 'O paciente vinculado possui prontuario ou protocolo clinico.',
          'quantidade', v_count
        )
      );
    end if;

    select pg_catalog.count(*)
    into v_count
    from public.protocol_consents as consent
    join public.protocols as protocol on protocol.id = consent.protocol_id
    where protocol.clinic_id = p_clinic_id
      and protocol.patient_id = any(v_patient_ids);
    if v_count > 0 then
      v_blockers := v_blockers || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'codigo', 'termo_consentimento',
          'descricao', 'O prontuario vinculado possui termo ou consentimento que deve ser preservado.',
          'quantidade', v_count
        )
      );
    end if;

    select pg_catalog.count(*)
    into v_count
    from public.financeiro_lancamentos as entry
    where entry.clinic_id = p_clinic_id
      and entry.patient_id = any(v_patient_ids);
    if v_count > 0 then
      v_blockers := v_blockers || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'codigo', 'financeiro',
          'descricao', 'O paciente vinculado possui receita, despesa ou cobranca registrada.',
          'quantidade', v_count
        )
      );
    end if;

    select pg_catalog.count(*)
    into v_count
    from public.financeiro_pagamentos as payment
    join public.financeiro_lancamentos as entry
      on entry.clinic_id = payment.clinic_id and entry.id = payment.entry_id
    where entry.clinic_id = p_clinic_id
      and entry.patient_id = any(v_patient_ids);
    if v_count > 0 then
      v_blockers := v_blockers || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'codigo', 'pagamento',
          'descricao', 'O paciente vinculado possui pagamento ou estorno registrado.',
          'quantidade', v_count
        )
      );
    end if;

    select
      (select pg_catalog.count(*) from public.retorno_recomendacoes as item
       where item.clinic_id = p_clinic_id and item.patient_id = any(v_patient_ids)) +
      (select pg_catalog.count(*) from public.retorno_fila as item
       where item.clinic_id = p_clinic_id and item.patient_id = any(v_patient_ids)) +
      (select pg_catalog.count(*) from public.retorno_tentativas as item
       where item.clinic_id = p_clinic_id and item.patient_id = any(v_patient_ids))
    into v_count;
    if v_count > 0 then
      v_blockers := v_blockers || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'codigo', 'retorno',
          'descricao', 'O paciente vinculado possui retorno ou contato de acompanhamento registrado.',
          'quantidade', v_count
        )
      );
    end if;

    select
      (select pg_catalog.count(*) from public.patient_operational_profile_events as item
       where item.clinic_id = p_clinic_id and item.patient_id = any(v_patient_ids)) +
      (select pg_catalog.count(*) from public.patient_contact_preference_events as item
       where item.clinic_id = p_clinic_id and item.patient_id = any(v_patient_ids))
    into v_count;
    if v_count > 0 then
      v_blockers := v_blockers || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'codigo', 'historico_operacional',
          'descricao', 'O paciente vinculado possui historico operacional ou preferencia de contato.',
          'quantidade', v_count
        )
      );
    end if;
  end if;

  v_target := case p_origem
    when 'anamnese' then 'public.anamneses'::regclass
    else 'public.documentos_clinicos'::regclass
  end;

  -- Defesa para FKs presentes ou adicionadas no futuro. Nao apaga nem altera a
  -- relacao: apenas torna a ficha inelegivel e devolve uma mensagem humana.
  for v_fk in
    select namespace.nspname as schema_name,
           relation.relname as table_name,
           attribute.attname as column_name
    from pg_catalog.pg_constraint as constraint_row
    join pg_catalog.pg_class as relation
      on relation.oid = constraint_row.conrelid
    join pg_catalog.pg_namespace as namespace
      on namespace.oid = relation.relnamespace
    join pg_catalog.pg_attribute as attribute
      on attribute.attrelid = constraint_row.conrelid
     and attribute.attnum = constraint_row.conkey[1]
    where constraint_row.contype = 'f'
      and constraint_row.confrelid = v_target
      and pg_catalog.array_length(constraint_row.conkey, 1) = 1
      and pg_catalog.array_length(constraint_row.confkey, 1) = 1
      and namespace.nspname not in ('pg_catalog', 'information_schema')
  loop
    execute pg_catalog.format(
      'select pg_catalog.count(*) from %I.%I where %I = $1',
      v_fk.schema_name,
      v_fk.table_name,
      v_fk.column_name
    ) into v_count using p_documento_id;
    v_fk_total := v_fk_total + coalesce(v_count, 0);
  end loop;

  if v_fk_total > 0 then
    v_blockers := v_blockers || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'codigo', 'relacao_obrigatoria',
        'descricao', 'Outro registro relacionado exige que esta ficha seja preservada.',
        'quantidade', v_fk_total
      )
    );
  end if;

  return v_blockers;
end;
$function$;

revoke execute on function private.fichas_exclusao_vinculos(uuid, text, uuid)
  from public, anon, authenticated, service_role;

create or replace function private.fichas_bloquear_alvo_em_exclusao()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_id uuid := case when tg_op = 'DELETE' then old.id else new.id end;
  v_origem text := case tg_table_name
    when 'anamneses' then 'anamnese'
    else 'documento_clinico'
  end;
  v_operation uuid;
  v_bypass text := pg_catalog.current_setting('amj.fichas_delete_operation', true);
begin
  select intent.operation_id
  into v_operation
  from private.fichas_exclusao_intencoes as intent
  where intent.origem = v_origem
    and intent.documento_id = v_id
    and intent.expira_em > pg_catalog.clock_timestamp()
  limit 1;

  if v_operation is not null
     and coalesce(v_bypass, '') <> v_operation::text then
    raise exception 'ficha_em_exclusao' using errcode = '55000';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$function$;

revoke execute on function private.fichas_bloquear_alvo_em_exclusao()
  from public, anon, authenticated, service_role;

create trigger anamneses_bloquear_alvo_em_exclusao
before update or delete on public.anamneses
for each row execute function private.fichas_bloquear_alvo_em_exclusao();

create trigger documentos_clinicos_bloquear_alvo_em_exclusao
before update or delete on public.documentos_clinicos
for each row execute function private.fichas_bloquear_alvo_em_exclusao();

create or replace function private.fichas_bloquear_novo_vinculo_em_exclusao()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_target_hmac bytea;
begin
  if new.source_kind in ('anamnese', 'documento_clinico') then
    v_target_hmac := private.fichas_exclusao_hmac(
      new.clinic_id::text || ':' || new.source_kind || ':' || new.source_id::text
    );
    if exists (
         select 1
         from private.fichas_exclusao_intencoes as intent
         where intent.clinic_id = new.clinic_id
           and intent.origem = new.source_kind
           and intent.documento_id = new.source_id
           and intent.expira_em > pg_catalog.clock_timestamp()
       )
       or exists (
         select 1
         from public.fichas_exclusao_tombstones as tombstone
         where tombstone.clinic_id = new.clinic_id
           and tombstone.origem = new.source_kind
           and tombstone.alvo_hmac = v_target_hmac
       ) then
      raise exception 'ficha_excluida_ou_em_exclusao' using errcode = '55000';
    end if;
  end if;
  return new;
end;
$function$;

revoke execute on function private.fichas_bloquear_novo_vinculo_em_exclusao()
  from public, anon, authenticated, service_role;

create trigger patient_source_links_bloquear_alvo_em_exclusao
before insert or update on public.patient_source_links
for each row execute function private.fichas_bloquear_novo_vinculo_em_exclusao();

create or replace function public.painel_preparar_exclusao_ficha(
  p_clinic_id uuid,
  p_actor_user_id uuid,
  p_origem text,
  p_documento_id uuid,
  p_categoria text,
  p_motivo text,
  p_confirmacao text,
  p_operation_id uuid,
  p_request_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_motivo text := pg_catalog.btrim(coalesce(p_motivo, ''));
  v_target_hmac bytea;
  v_reason_hmac bytea;
  v_fingerprint bytea;
  v_blockers jsonb := '[]'::jsonb;
  v_storage jsonb := '[]'::jsonb;
  v_archived_at timestamptz;
  v_pdf_path text;
  v_signature_path text;
  v_updated_at timestamptz;
  v_status text;
  v_record_hash text;
begin
  if p_clinic_id is null or p_actor_user_id is null or p_documento_id is null
     or p_operation_id is null or p_request_id is null
     or p_origem not in ('anamnese', 'documento_clinico')
     or p_categoria not in ('teste', 'duplicada', 'erro_cadastral', 'solicitacao_validada')
     or p_confirmacao is distinct from 'EXCLUIR'
     or pg_catalog.char_length(v_motivo) not between 10 and 500 then
    raise exception 'exclusao_parametros_invalidos' using errcode = '22023';
  end if;

  if not exists (
    select 1
    from public.clinic_members as member
    where member.clinic_id = p_clinic_id
      and member.user_id = p_actor_user_id
      and member.role = 'owner'
      and member.status = 'active'
  ) then
    raise exception 'owner_required' using errcode = '42501';
  end if;

  -- As tabelas clinicas legadas nao possuem clinic_id. Enquanto essa origem
  -- nao for migrada, a exclusao definitiva so e segura em projeto de clinica
  -- unica; se outra clinica for criada, o fluxo fecha por padrao.
  if (select pg_catalog.count(*) from public.clinics) <> 1
     or not exists (select 1 from public.clinics where id = p_clinic_id) then
    raise exception 'clinic_scope_ambiguous' using errcode = '55000';
  end if;

  delete from private.fichas_exclusao_intencoes as stale
  where stale.expira_em <= v_now;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_clinic_id::text || ':ficha_delete:' || p_origem || ':' || p_documento_id::text,
    0
  ));

  v_target_hmac := private.fichas_exclusao_hmac(
    p_clinic_id::text || ':' || p_origem || ':' || p_documento_id::text
  );
  v_reason_hmac := private.fichas_exclusao_hmac(v_motivo);
  if v_target_hmac is null or v_reason_hmac is null then
    raise exception 'exclusao_hmac_indisponivel' using errcode = '55000';
  end if;

  if exists (
    select 1 from public.fichas_exclusao_tombstones as tombstone
    where tombstone.clinic_id = p_clinic_id
      and tombstone.origem = p_origem
      and tombstone.alvo_hmac = v_target_hmac
  ) then
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'eligible', true,
      'deleted', true,
      'idempotent', true,
      'storage', '[]'::jsonb
    );
  end if;

  if p_origem = 'anamnese' then
    select item.arquivado_em, item.pdf_path, item.assinatura_path,
           item.updated_at, item.status, item.registro_sha256
    into v_archived_at, v_pdf_path, v_signature_path,
         v_updated_at, v_status, v_record_hash
    from public.anamneses as item
    where item.id = p_documento_id
    for update;
  else
    select item.arquivado_em, item.pdf_path, item.assinatura_path,
           item.updated_at, item.status, item.registro_sha256
    into v_archived_at, v_pdf_path, v_signature_path,
         v_updated_at, v_status, v_record_hash
    from public.documentos_clinicos as item
    where item.id = p_documento_id
    for update;
  end if;

  if not found then
    raise exception 'ficha_nao_encontrada' using errcode = 'P0002';
  end if;

  -- Fecha a janela entre consultar os vinculos e publicar a intencao. Depois
  -- do commit, o trigger da tabela impede novos vinculos enquanto a remocao
  -- de Storage estiver em andamento.
  lock table public.patient_source_links in share row exclusive mode;

  if v_archived_at is null then
    v_blockers := v_blockers || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'codigo', 'arquivamento_obrigatorio',
        'descricao', 'Arquive a ficha antes de solicitar a exclusao definitiva.',
        'quantidade', 1
      )
    );
  end if;
  v_blockers := v_blockers || private.fichas_exclusao_vinculos(
    p_clinic_id, p_origem, p_documento_id
  );

  if pg_catalog.jsonb_array_length(v_blockers) > 0 then
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'eligible', false,
      'deleted', false,
      'idempotent', false,
      'blockers', v_blockers
    );
  end if;

  v_fingerprint := extensions.digest(pg_catalog.convert_to(
    p_origem || '|' || p_documento_id::text || '|' ||
    coalesce(v_archived_at::text, '') || '|' || coalesce(v_updated_at::text, '') || '|' ||
    coalesce(v_status, '') || '|' || coalesce(v_pdf_path, '') || '|' ||
    coalesce(v_signature_path, '') || '|' || coalesce(v_record_hash, ''),
    'UTF8'
  ), 'sha256');

  if nullif(pg_catalog.btrim(coalesce(v_pdf_path, '')), '') is not null then
    v_storage := v_storage || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'bucket', case when p_origem = 'anamnese' then 'fichas-pdf' else 'documentos-clinicos' end,
        'path', v_pdf_path
      )
    );
  end if;
  if nullif(pg_catalog.btrim(coalesce(v_signature_path, '')), '') is not null
     and v_signature_path is distinct from v_pdf_path then
    v_storage := v_storage || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'bucket', case when p_origem = 'anamnese' then 'fichas-pdf' else 'documentos-clinicos' end,
        'path', v_signature_path
      )
    );
  end if;

  -- Uma nova prova valida pode retomar uma remocao de Storage interrompida.
  -- A linha clinica continua travada enquanto a intencao estiver ativa.
  delete from private.fichas_exclusao_intencoes as intent
  where intent.clinic_id = p_clinic_id
    and intent.origem = p_origem
    and intent.documento_id = p_documento_id;

  insert into private.fichas_exclusao_intencoes (
    clinic_id, origem, documento_id, operation_id, actor_user_id, categoria,
    motivo_hmac, registro_fingerprint, preparado_em, expira_em, request_id
  ) values (
    p_clinic_id, p_origem, p_documento_id, p_operation_id, p_actor_user_id,
    p_categoria, v_reason_hmac, v_fingerprint, v_now,
    v_now + interval '15 minutes', p_request_id
  );

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'eligible', true,
    'deleted', false,
    'idempotent', false,
    'storage', v_storage
  );
end;
$function$;

revoke execute on function public.painel_preparar_exclusao_ficha(
  uuid, uuid, text, uuid, text, text, text, uuid, uuid
) from public, anon, authenticated;
grant execute on function public.painel_preparar_exclusao_ficha(
  uuid, uuid, text, uuid, text, text, text, uuid, uuid
) to service_role;

create or replace function public.painel_concluir_exclusao_ficha(
  p_clinic_id uuid,
  p_actor_user_id uuid,
  p_origem text,
  p_documento_id uuid,
  p_categoria text,
  p_operation_id uuid,
  p_request_id uuid,
  p_objetos_storage_removidos smallint
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_intent private.fichas_exclusao_intencoes%rowtype;
  v_target_hmac bytea;
  v_fingerprint bytea;
  v_blockers jsonb;
  v_archived_at timestamptz;
  v_pdf_path text;
  v_signature_path text;
  v_updated_at timestamptz;
  v_status text;
  v_record_hash text;
  v_deleted integer;
begin
  if p_clinic_id is null or p_actor_user_id is null or p_documento_id is null
     or p_operation_id is null or p_request_id is null
     or p_origem not in ('anamnese', 'documento_clinico')
     or p_categoria not in ('teste', 'duplicada', 'erro_cadastral', 'solicitacao_validada')
     or p_objetos_storage_removidos is null
     or p_objetos_storage_removidos not between 0 and 4 then
    raise exception 'exclusao_parametros_invalidos' using errcode = '22023';
  end if;

  if not exists (
    select 1
    from public.clinic_members as member
    where member.clinic_id = p_clinic_id
      and member.user_id = p_actor_user_id
      and member.role = 'owner'
      and member.status = 'active'
  ) then
    raise exception 'owner_required' using errcode = '42501';
  end if;

  if (select pg_catalog.count(*) from public.clinics) <> 1
     or not exists (select 1 from public.clinics where id = p_clinic_id) then
    raise exception 'clinic_scope_ambiguous' using errcode = '55000';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_clinic_id::text || ':ficha_delete:' || p_origem || ':' || p_documento_id::text,
    0
  ));

  v_target_hmac := private.fichas_exclusao_hmac(
    p_clinic_id::text || ':' || p_origem || ':' || p_documento_id::text
  );
  if v_target_hmac is null then
    raise exception 'exclusao_hmac_indisponivel' using errcode = '55000';
  end if;

  if exists (
    select 1 from public.fichas_exclusao_tombstones as tombstone
    where tombstone.clinic_id = p_clinic_id
      and tombstone.origem = p_origem
      and tombstone.alvo_hmac = v_target_hmac
  ) then
    return pg_catalog.jsonb_build_object(
      'ok', true, 'deleted', true, 'idempotent', true
    );
  end if;

  select intent.*
  into v_intent
  from private.fichas_exclusao_intencoes as intent
  where intent.clinic_id = p_clinic_id
    and intent.origem = p_origem
    and intent.documento_id = p_documento_id
  for update;
  if not found
     or v_intent.operation_id is distinct from p_operation_id
     or v_intent.actor_user_id is distinct from p_actor_user_id
     or v_intent.categoria is distinct from p_categoria then
    raise exception 'exclusao_intencao_invalida' using errcode = '55000';
  end if;

  if p_origem = 'anamnese' then
    select item.arquivado_em, item.pdf_path, item.assinatura_path,
           item.updated_at, item.status, item.registro_sha256
    into v_archived_at, v_pdf_path, v_signature_path,
         v_updated_at, v_status, v_record_hash
    from public.anamneses as item
    where item.id = p_documento_id
    for update;
  else
    select item.arquivado_em, item.pdf_path, item.assinatura_path,
           item.updated_at, item.status, item.registro_sha256
    into v_archived_at, v_pdf_path, v_signature_path,
         v_updated_at, v_status, v_record_hash
    from public.documentos_clinicos as item
    where item.id = p_documento_id
    for update;
  end if;
  if not found then
    raise exception 'ficha_nao_encontrada' using errcode = 'P0002';
  end if;

  v_fingerprint := extensions.digest(pg_catalog.convert_to(
    p_origem || '|' || p_documento_id::text || '|' ||
    coalesce(v_archived_at::text, '') || '|' || coalesce(v_updated_at::text, '') || '|' ||
    coalesce(v_status, '') || '|' || coalesce(v_pdf_path, '') || '|' ||
    coalesce(v_signature_path, '') || '|' || coalesce(v_record_hash, ''),
    'UTF8'
  ), 'sha256');
  if v_fingerprint is distinct from v_intent.registro_fingerprint then
    raise exception 'ficha_alterada_durante_exclusao' using errcode = '40001';
  end if;

  v_blockers := private.fichas_exclusao_vinculos(
    p_clinic_id, p_origem, p_documento_id
  );
  if v_archived_at is null or pg_catalog.jsonb_array_length(v_blockers) > 0 then
    raise exception 'ficha_nao_elegivel' using errcode = '55000';
  end if;

  perform pg_catalog.set_config(
    'amj.fichas_delete_operation', p_operation_id::text, true
  );
  if p_origem = 'anamnese' then
    delete from public.anamneses where id = p_documento_id;
  else
    delete from public.documentos_clinicos where id = p_documento_id;
  end if;
  get diagnostics v_deleted = row_count;
  if v_deleted <> 1 then
    raise exception 'ficha_nao_encontrada' using errcode = 'P0002';
  end if;

  insert into public.fichas_exclusao_tombstones (
    clinic_id, origem, alvo_hmac, categoria, motivo_hmac, operation_id,
    request_id, actor_user_id, objetos_storage_removidos
  ) values (
    p_clinic_id, p_origem, v_target_hmac, p_categoria, v_intent.motivo_hmac,
    p_operation_id, p_request_id, p_actor_user_id, p_objetos_storage_removidos
  );

  delete from private.fichas_exclusao_intencoes as intent
  where intent.clinic_id = p_clinic_id
    and intent.origem = p_origem
    and intent.documento_id = p_documento_id;

  return pg_catalog.jsonb_build_object(
    'ok', true, 'deleted', true, 'idempotent', false
  );
end;
$function$;

revoke execute on function public.painel_concluir_exclusao_ficha(
  uuid, uuid, text, uuid, text, uuid, uuid, smallint
) from public, anon, authenticated;
grant execute on function public.painel_concluir_exclusao_ficha(
  uuid, uuid, text, uuid, text, uuid, uuid, smallint
) to service_role;

-- O service_role nao recebe DELETE direto nas fichas. Somente a RPC de alvo
-- exato, protegida pelo lock e pelos bloqueadores acima, pode remover linhas.
revoke delete on table public.anamneses from service_role;
revoke delete on table public.documentos_clinicos from service_role;

commit;

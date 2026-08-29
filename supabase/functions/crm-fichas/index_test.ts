import {
  clinicTimestampToIso,
  conversionDto,
  conversionRequiresRecentPassword,
  corsOriginAllowed,
  handleRequest,
  leadDto,
  normalizeLeadPayload,
  normalizePhone,
  stageToApi,
  stageToDatabase,
  tenantFromContext,
  totalFromContentRange,
} from "./index.ts";

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Esperado ${JSON.stringify(expected)}, recebido ${JSON.stringify(actual)}.`);
  }
}

function assert(value: unknown, message: string): void {
  if (!value) throw new Error(message);
}

function assertThrows(callback: () => unknown): void {
  let thrown = false;
  try {
    callback();
  } catch {
    thrown = true;
  }
  if (!thrown) throw new Error("Era esperado que a operação falhasse.");
}

const CLINIC_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";
const PATIENT_1 = "33333333-3333-4333-8333-333333333333";
const PATIENT_2 = "44444444-4444-4444-8444-444444444444";

Deno.test("contrato traduz lead_novo sem divergir do catálogo canônico", () => {
  assertEquals(stageToDatabase("lead_novo"), "novo");
  assertEquals(stageToApi("novo"), "lead_novo");
  assertEquals(stageToApi("interessada"), "interessada");
  assertThrows(() => stageToDatabase("etapa_inventada"));
});

Deno.test("payload PT vira uma única mutação EN e recebe próxima ação contato", () => {
  const payload = normalizeLeadPayload({
    nome: "Maria Teste",
    telefone: "(11) 99999-9999",
    email: "MARIA@EXAMPLE.COM",
    origem: "instagram",
    suborigem: "story",
    campanha: "campanha-agosto",
    interesse: "avaliação estética",
    responsavel_id: USER_ID,
    estagio: "lead_novo",
    proxima_acao_em: "2026-08-27T10:30",
    observacoes: "Pediu retorno comercial.",
  });
  assertEquals(payload.stage_code, "novo");
  assertEquals(payload.full_name, "Maria Teste");
  assertEquals(payload.phone, "+5511999999999");
  assertEquals(payload.email, "maria@example.com");
  assertEquals(payload.next_action_type, "contato");
  assertEquals(payload.next_action_at, "2026-08-27T13:30:00.000Z");
});

Deno.test("etapas abertas exigem próxima ação e não convertida exige motivo", () => {
  const base = {
    nome: "Lead Teste",
    telefone: "11999999999",
    origem: "site",
    interesse: "contato comercial",
    responsavel_id: USER_ID,
  };
  assertThrows(() => normalizeLeadPayload({ ...base, estagio: "interessada" }));
  assertThrows(() => normalizeLeadPayload({ ...base, estagio: "nao_convertida" }));
  const closed = normalizeLeadPayload({
    ...base,
    estagio: "nao_convertida",
    motivo_perda: "Sem interesse neste momento.",
  });
  assertEquals(closed.next_action_at, null);
  assertEquals(closed.loss_reason, "Sem interesse neste momento.");
});

Deno.test("campos clínicos são recusados no CRM", () => {
  assertThrows(() =>
    normalizeLeadPayload({
      nome: "Lead Teste",
      telefone: "11999999999",
      origem: "site",
      interesse: "contato",
      responsavel_id: USER_ID,
      estagio: "lead_novo",
      proxima_acao_em: "2026-08-27T10:30",
      diagnostico: "não deve entrar",
    })
  );
});

Deno.test("telefone e datetime-local são normalizados deterministicamente", () => {
  assertEquals(normalizePhone("+55 (21) 98888-7777"), "+5521988887777");
  assertEquals(clinicTimestampToIso("2026-08-26T09:15"), "2026-08-26T12:15:00.000Z");
  assertEquals(clinicTimestampToIso("2026-08-26T12:15:00Z"), "2026-08-26T12:15:00.000Z");
});

Deno.test("DTO PT inclui record_status e fecha corretamente arquivados", () => {
  const dto = leadDto({
    id: CLINIC_ID,
    full_name: "Lead",
    phone: "+5511999999999",
    email: null,
    source: "site",
    subsource: null,
    campaign: null,
    interest: "contato",
    responsible_user_id: USER_ID,
    stage_code: "novo",
    record_status: "archived",
    version: 4,
  }, "Responsável Teste");
  assertEquals(dto.nome, "Lead");
  assertEquals(dto.estagio, "arquivada");
  assertEquals(dto.stage_code, "novo");
  assertEquals(dto.record_status, "archived");
  assertEquals(dto.arquivado, true);
});

Deno.test("arquivar convertido preserva estágio e data histórica", () => {
  const dto = leadDto({
    id: CLINIC_ID,
    full_name: "Lead convertido",
    stage_code: "convertida",
    record_status: "archived",
    patient_id: PATIENT_1,
    converted_at: "2026-08-25T10:00:00.000Z",
    version: 5,
  });
  assertEquals(dto.estagio, "arquivada");
  assertEquals(dto.stage_code, "convertida");
  assertEquals(dto.patient_id, PATIENT_1);
  assertEquals(dto.convertido_em, "2026-08-25T10:00:00.000Z");
});

Deno.test("análise de conversão produz candidatos seguros e pode_criar", () => {
  const dto = conversionDto({
    lead_id: CLINIC_ID,
    lead_version: 2,
    exact_patient_id: PATIENT_1,
    exact_safe_alias: "P-ABC123",
    exact_safe_label: "Paciente M*** · telefone final 1111",
    possible_candidates: [
      {
        patient_id: PATIENT_2,
        match_kind: "phone",
        safe_alias: "P-DEF456",
        safe_label: "Paciente A*** · telefone final 2222",
      },
    ],
    can_create_patient: false,
    candidate_fingerprint: "a".repeat(32),
    possible_count: 1,
    has_more: false,
  });
  const candidates = dto.candidatos as Array<Record<string, unknown>>;
  assertEquals(candidates.length, 2);
  assertEquals(candidates[0].tipo_correspondencia, "exata");
  assertEquals(candidates[1].tipo_correspondencia, "provavel");
  assertEquals(dto.exact_patient_id, PATIENT_1);
  assertEquals(candidates[0].alias_opaco, "P-ABC123");
  assertEquals(candidates[1].alias_opaco, "P-DEF456");
  assertEquals(candidates[0].rotulo_seguro, "Paciente M*** · telefone final 1111");
  assertEquals(candidates[1].rotulo_seguro, "Paciente A*** · telefone final 2222");
  assertEquals(dto.candidate_fingerprint, "a".repeat(32));
  assertEquals(dto.pode_criar, false);
  assert(!JSON.stringify(dto).includes("@"), "DTO seguro não deve conter e-mail.");
});

Deno.test("contagem PostgREST do KPI exige Content-Range total válido", () => {
  assertEquals(totalFromContentRange("0-0/37"), 37);
  assertEquals(totalFromContentRange("*/0"), 0);
  assertThrows(() => totalFromContentRange(null));
  assertThrows(() => totalFromContentRange("0-0/*"));
});

Deno.test("somente conversão final exige prova recente", () => {
  assertEquals(conversionRequiresRecentPassword("revisar"), false);
  assertEquals(conversionRequiresRecentPassword("vincular_existente"), true);
  assertEquals(conversionRequiresRecentPassword("criar_paciente"), true);
});

Deno.test("tenant vem apenas do owner AAL2 autenticado", () => {
  assertEquals(
    tenantFromContext({
      authMethod: "supabase_auth",
      role: "owner",
      userId: USER_ID,
      clinicId: CLINIC_ID,
      displayName: "Owner",
      aal: "aal2",
      sessionId: PATIENT_1,
      requestId: PATIENT_2,
    }),
    { clinicId: CLINIC_ID, userId: USER_ID },
  );
  assertThrows(() =>
    tenantFromContext({
      authMethod: "supabase_auth",
      role: "owner",
      userId: USER_ID,
      clinicId: CLINIC_ID,
      displayName: "Owner",
      aal: "aal1",
      requestId: PATIENT_2,
    })
  );
});

Deno.test("CORS permite apenas site oficial e desenvolvimento local", () => {
  assertEquals(corsOriginAllowed("https://anamariajacob.com.br"), true);
  assertEquals(corsOriginAllowed("http://127.0.0.1:8765"), true);
  assertEquals(corsOriginAllowed("https://example.org"), false);
});

Deno.test("preflight anuncia Bearer e reautenticação sem senha compartilhada", async () => {
  const response = await handleRequest(
    new Request("http://localhost/crm", {
      method: "OPTIONS",
      headers: { Origin: "http://127.0.0.1:8765" },
    }),
  );
  assertEquals(response.status, 204);
  assertEquals(response.headers.get("cache-control"), "no-store, max-age=0");
  const allowed = response.headers.get("access-control-allow-headers") || "";
  assert(allowed.includes("authorization"), "Bearer precisa ser permitido.");
  assert(allowed.includes("x-amj-reauthentication"), "Prova recente precisa ser permitida.");
  assert(!allowed.includes("x-senha"), "Senha compartilhada não pode ser permitida.");
});

Deno.test("requisição sem Bearer é recusada antes do corpo e do banco", async () => {
  const response = await handleRequest(
    new Request("http://localhost/crm", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-senha": "legado" },
      body: JSON.stringify({ action: "listar", payload: {} }),
    }),
  );
  assertEquals(response.status, 401);
  const body = await response.json();
  assertEquals(body.codigo, "authorization_required");
});

Deno.test("fonte liga ações UI a RPC única e protege apenas operações críticas", async () => {
  const source = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  for (
    const action of [
      "listar",
      "salvar_lead",
      "mudar_estagio",
      "registrar_interacao",
      "arquivar_lead",
      "cancelar_lead",
      "converter_lead",
    ]
  ) {
    assert(source.includes(`case \"${action}\"`), `Ação ausente: ${action}`);
  }
  assert(
    source.includes('p_action: creating ? "create" : "update"'),
    "Salvar deve chamar uma RPC atômica.",
  );
  assert(
    source.includes("requireRecentPasswordProof"),
    "Operações críticas devem consumir prova recente.",
  );
  assert(
    source.includes("p_confirm_possible_distinct"),
    "Confirmação de provável distinto deve chegar à RPC.",
  );
  assert(source.includes("p_possible_distinct_reason"), "Motivo da confirmação deve chegar à RPC.");
  assert(source.includes('"distinct_reason"'), "Alias final distinct_reason deve ser aceito.");
});

Deno.test("campanhas do CRM permanecem RPC-only e preservam referências históricas", async () => {
  const source = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  assert(
    !source.includes('selectRows("marketing_campaigns"'),
    "CRM não pode ler tabela RPC-only diretamente.",
  );
  assert(
    source.includes('rpc("marketing_crm_campaign_options"'),
    "Opções canônicas devem vir da RPC tenant/owner.",
  );
  assert(source.includes("p_current_ids"), "Campanhas históricas da página devem ser preservadas.");
});

Deno.test("listagem possui paginação exata com os mesmos filtros", async () => {
  const source = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  const listStart = source.indexOf("async function handleList");
  const listEnd = source.indexOf("function expectedVersion", listStart);
  const list = source.slice(listStart, listEnd);
  assert(
    list.includes("const totalParams = new URLSearchParams(params)"),
    "Contagem deve clonar os filtros da página.",
  );
  assert(list.includes('countRows("crm_leads", totalParams)'), "Total exato deve vir do banco.");
  assert(
    list.includes("has_more: offset + leads.length < total"),
    "Resposta deve informar se ainda existem leads.",
  );
  assert(
    list.includes("total,") && list.includes("limit,") && list.includes("offset,"),
    "Metadados de paginação estão incompletos.",
  );
});

Deno.test("migration preserva helpers legados e incrementa versão da revisão provável", async () => {
  const migration = await Deno.readTextFile(
    new URL("../../migrations/20260826045218_crm_fase1_leads.sql", import.meta.url),
  );
  assert(
    !/revoke all on schema private from[^;]*service_role/i.test(migration),
    "CRM não pode revogar USAGE legado do service_role no schema private.",
  );
  assert(
    /grant usage on schema private to service_role/i.test(migration),
    "USAGE técnico do service_role precisa permanecer explícito.",
  );
  assert(
    /revoke all on sequence public\.crm_audit_log_id_seq\s+from public, anon, authenticated, service_role/i
      .test(migration),
    "Sequência da auditoria não pode ter acesso direto.",
  );
  assert(
    /update public\.clinic_duplicate_reviews review[\s\S]*?set[\s\S]*?version\s*=\s*review\.version\s*\+\s*1[\s\S]*?where review\.clinic_id/i
      .test(
        migration,
      ),
    "Resolução confirmado_distinto deve incrementar a versão exigida pelo trigger.",
  );
});

Deno.test("identidade de pacientes é serializada por clínica sem criar unicidade provável", async () => {
  const migration = await Deno.readTextFile(
    new URL("../../migrations/20260826045218_crm_fase1_leads.sql", import.meta.url),
  );
  const helperStart = migration.indexOf(
    "create or replace function private.financeiro_sync_patient_dedup()",
  );
  const helperEnd = migration.indexOf("revoke all on function", helperStart);
  const helper = migration.slice(helperStart, helperEnd);
  const helperLock = helper.indexOf("private.crm_lock_patient_identity(new.clinic_id)");
  const helperSelect = helper.indexOf("select patient.id into v_existing");
  assert(helperStart >= 0 && helperEnd > helperStart, "Helper canônico precisa ser substituído.");
  assert(helperLock >= 0 && helperLock < helperSelect, "Lock clínico deve anteceder o SELECT.");
  assert(
    helper.includes("if tg_op = 'INSERT' then") &&
      !/tg_op\s*=\s*'UPDATE'[\s\S]*crm_lock_patient_identity/i.test(helper),
    "Trigger só pode adquirir advisory no INSERT, antes de qualquer row lock.",
  );

  const analysisStart = migration.indexOf(
    "create or replace function public.crm_analisar_conversao(",
  );
  const analysisEnd = migration.indexOf("create or replace function public.crm_converter_lead(");
  const analysis = migration.slice(analysisStart, analysisEnd);
  const analysisLock = analysis.indexOf("private.crm_lock_patient_identity(p_clinic_id)");
  const analysisSelect = analysis.indexOf("select * into v_lead");
  assert(
    analysisLock >= 0 && analysisSelect >= 0 && analysisLock < analysisSelect,
    "Análise deve usar o mesmo lock antes de consultar identidades.",
  );
  const converterStart = migration.indexOf("create or replace function public.crm_converter_lead(");
  const converterEnd = migration.indexOf("revoke all on function", converterStart);
  const converter = migration.slice(converterStart, converterEnd);
  const converterLock = converter.indexOf("private.crm_lock_patient_identity(p_clinic_id)");
  const candidateSelect = converter.indexOf("select * into v_lead");
  assert(
    converterLock >= 0 && converterLock < candidateSelect,
    "Conversão final deve usar o mesmo lock antes de reavaliar identidades.",
  );
  for (
    const rpc of [
      "financeiro_criar_cliente_com_vinculo",
      "financeiro_editar_cliente",
      "financeiro_arquivar_cliente",
      "financeiro_restaurar_cliente",
    ]
  ) {
    const start = migration.indexOf(`function public.${rpc}(`);
    const end = migration.indexOf("$function$;", start);
    const definition = migration.slice(start, end);
    const lock = definition.indexOf("private.crm_lock_patient_identity(p_clinic_id)");
    const rowSelect = definition.indexOf("select * into v_patient");
    assert(start >= 0 && lock >= 0, `Writer sem lock clínico: ${rpc}`);
    if (rpc !== "financeiro_criar_cliente_com_vinculo") {
      assert(rowSelect >= 0 && lock < rowSelect, `Ordem advisory→row inválida: ${rpc}`);
    }
  }

  const leadHelperStart = migration.indexOf(
    "create or replace function private.crm_sync_lead_dedup()",
  );
  const leadHelperEnd = migration.indexOf("create trigger crm_leads_00_dedup", leadHelperStart);
  const leadHelper = migration.slice(leadHelperStart, leadHelperEnd);
  const leadLock = leadHelper.indexOf("clinic:crm-lead-identity:");
  const leadSelect = leadHelper.indexOf("select lead.id");
  assert(
    leadLock >= 0 && leadSelect >= 0 && leadLock < leadSelect,
    "Trigger de leads deve serializar a detecção provável antes do SELECT.",
  );
  assert(
    !/unique[^;\n]*dedup_possible_key/i.test(migration),
    "Chave provável não pode impedir pessoas legitimamente distintas.",
  );
});

Deno.test("confirmação distinta persiste revisão para phone, email e name_birth", async () => {
  const migration = await Deno.readTextFile(
    new URL("../../migrations/20260826045218_crm_fase1_leads.sql", import.meta.url),
  );
  for (
    const marker of [
      "possible_phone",
      "possible_email",
      "possible_name_birth",
      "get diagnostics v_review_count = row_count",
      "v_review_count <> v_possible_count",
      "where not exists",
      "select pg_catalog.count(*)",
      "crm_possible_distinct_decision_not_persisted",
      "version = review.version + 1",
    ]
  ) {
    assert(migration.includes(marker), `Contrato ausente: ${marker}`);
  }
});

Deno.test("snapshot completo usa fingerprint sem PII e bloqueia visão truncada", async () => {
  const migration = await Deno.readTextFile(
    new URL("../../migrations/20260826045218_crm_fase1_leads.sql", import.meta.url),
  );
  for (
    const marker of [
      "p_candidate_fingerprint",
      "crm_reanalysis_required",
      "crm_candidate_set_too_large",
      "crm_possible_distinct_confirmation_invalid",
      "with ordinality candidate(value, ordinality)",
      "candidate.ordinality <= 20",
      "'has_more', v_possible_count > 20",
    ]
  ) {
    assert(migration.includes(marker), `Snapshot incompleto: ${marker}`);
  }
  const converterStart = migration.indexOf("create or replace function public.crm_converter_lead(");
  const converterEnd = migration.indexOf("$function$;", converterStart);
  const converter = migration.slice(converterStart, converterEnd);
  assert(!converter.includes("safe_label"), "Rótulos não podem chegar ao ledger da conversão.");
  assert(
    !converter.includes("safe_alias"),
    "Alias de exibição não pode chegar ao ledger da conversão.",
  );
  assert(
    converter.includes("candidate.value ->> 'patient_id'") &&
      converter.includes("candidate.value ->> 'match_kind'"),
    "Fingerprint deve conter apenas IDs e tipos técnicos.",
  );
  const dto = conversionDto({
    lead_id: CLINIC_ID,
    lead_version: 3,
    possible_candidates: [{
      patient_id: PATIENT_1,
      match_kind: "email",
      safe_label: "Paciente B*** · e-mail b***@example.com",
    }],
    possible_count: 21,
    has_more: true,
    candidate_fingerprint: "b".repeat(32),
  });
  assertEquals(dto.total_candidatos, 21);
  assertEquals(dto.has_more, true);
});

Deno.test("primeira resposta é temporal, monotônica e KPI usa histórico de conversão", async () => {
  const migration = await Deno.readTextFile(
    new URL("../../migrations/20260826045218_crm_fase1_leads.sql", import.meta.url),
  );
  for (
    const marker of [
      "crm_first_response_in_future",
      "clock_timestamp() + interval '5 minutes'",
      "first_response_at = coalesce(first_response_at, v_first_response_at)",
      "least(coalesce(first_response_at, v_occurred_at), v_occurred_at)",
    ]
  ) {
    assert(migration.includes(marker), `Invariante temporal ausente: ${marker}`);
  }
  assert(
    !migration.includes("first_response_at is distinct from v_first_response_at"),
    "Roundtrip com segundos truncados deve preservar o valor canônico sem comparar precisão.",
  );
  const smoke = await Deno.readTextFile(
    new URL("../../tests/crm_fase1_leads_smoke.sql", import.meta.url),
  );
  assert(
    smoke.includes("interval[[:space:]]+''5 minutes''") &&
      smoke.includes("''00:05:00''::interval"),
    "Smoke deve aceitar somente as duas renderizações equivalentes de cinco minutos.",
  );
  const source = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  assert(
    source.includes("const conversionCountParams = new URLSearchParams") &&
      source.includes('stage_code: "eq.convertida"') &&
      source.includes('converted_at: "not.is.null"') &&
      source.includes('countRows("crm_leads", conversionCountParams)') &&
      source.includes("convertidos: convertedCount"),
    "KPI de conversão deve usar uma contagem histórica separada.",
  );
  const countStart = source.indexOf("const conversionCountParams = new URLSearchParams");
  const countEnd = source.indexOf("const [leadRows", countStart);
  assert(
    !source.slice(countStart, countEnd).includes("record_status"),
    "KPI histórico não pode herdar o filtro padrão de arquivados/cancelados.",
  );
  assert(
    source.includes("p_candidate_fingerprint"),
    "Final deve enviar o snapshot revisado à RPC.",
  );
  const roundtrip = normalizeLeadPayload({
    nome: "Lead Roundtrip",
    telefone: "+55 11 99999-9999",
    origem: "site",
    interesse: "avaliação",
    responsavel_id: USER_ID,
    estagio: "lead_novo",
    primeira_resposta_em: "2026-08-25T10:20",
    proxima_acao_em: "2026-08-27T10:30",
  });
  assertEquals(roundtrip.first_response_at, "2026-08-25T13:20:00.000Z");
});

Deno.test("Fase 5B conecta listar, aceitar e arquivar somente às RPCs da caixa privada", async () => {
  const source = await Deno.readTextFile(new URL("./index.ts", import.meta.url));

  for (
    const action of [
      "listar_solicitacoes_site",
      "aceitar_solicitacao_site",
      "arquivar_solicitacao_site",
    ]
  ) {
    assert(source.includes(`case \"${action}\"`), `Ação Fase 5B ausente: ${action}`);
  }
  for (
    const rpcName of [
      "crm_site_booking_list",
      "crm_site_booking_accept",
      "crm_site_booking_archive",
    ]
  ) {
    assert(source.includes(`rpc(\"${rpcName}\"`), `RPC Fase 5B ausente: ${rpcName}`);
  }

  const listStart = source.indexOf("async function handleSiteRequestList");
  const listEnd = source.indexOf("async function handleSiteRequestAccept", listStart);
  const list = source.slice(listStart, listEnd);
  assert(listStart >= 0 && listEnd > listStart, "Handler de listagem da caixa privada ausente.");
  assert(
    list.includes("listSiteRequests(clinicId, userId"),
    "Listagem deve fixar o tenant autenticado.",
  );
  assert(
    list.includes("solicitacoes_site: result.items"),
    "Listagem deve devolver o contrato da inbox.",
  );
  assert(
    list.includes("solicitacoes_site_pendentes: result.pending"),
    "Listagem deve devolver a contagem pendente.",
  );
  assert(
    list.includes("total: result.total") && list.includes("has_more: result.hasMore"),
    "Listagem deve preservar a paginação da RPC.",
  );

  const mainListStart = source.indexOf("async function handleList");
  const mainListEnd = source.indexOf("function expectedVersion", mainListStart);
  const mainList = source.slice(mainListStart, mainListEnd);
  assert(
    mainList.includes('listSiteRequests(clinicId, userId, "pending", 100, 0)'),
    "Listagem principal precisa incorporar a inbox pendente.",
  );
  assert(
    mainList.includes("solicitacoes_site: siteInbox.items") &&
      mainList.includes("solicitacoes_site_pendentes: siteInbox.pending"),
    "Resposta principal deve expor itens e badge pendente.",
  );
});

Deno.test("Fase 5B mantém aceite owner+AAL2 e exige senha recente somente ao arquivar", async () => {
  const source = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  const acceptStart = source.indexOf("async function handleSiteRequestAccept");
  const acceptEnd = source.indexOf("async function handleSiteRequestArchive", acceptStart);
  const accept = source.slice(acceptStart, acceptEnd);
  const archiveStart = acceptEnd;
  const archiveEnd = source.indexOf("async function handleSave", archiveStart);
  const archive = source.slice(archiveStart, archiveEnd);

  assert(acceptStart >= 0 && acceptEnd > acceptStart, "Handler de aceite ausente.");
  assert(archiveStart >= 0 && archiveEnd > archiveStart, "Handler de arquivamento ausente.");
  assert(
    accept.includes('rpc("crm_site_booking_accept"') &&
      accept.includes("p_actor_id: userId") &&
      accept.includes("p_responsible_user_id: userId"),
    "Aceite deve usar exclusivamente o owner autenticado como ator e responsável inicial.",
  );
  assert(
    !accept.includes("requireProtected("),
    "Aceite owner+AAL2 não deve exigir a prova adicional reservada ao arquivamento.",
  );

  const passwordProof = archive.indexOf(
    'await requireProtected(req, context, payload, "archive_site_request", siteRequestId)',
  );
  const archiveRpc = archive.indexOf('rpc("crm_site_booking_archive"');
  assert(passwordProof >= 0, "Arquivamento deve exigir prova recente de senha e operation_id.");
  assert(
    archiveRpc > passwordProof,
    "Prova recente precisa ser validada antes de chamar a RPC de arquivamento.",
  );
  assert(
    source.includes('"authorization, apikey, content-type, x-client-info, x-amj-reauthentication"'),
    "CORS precisa permitir o cabeçalho da prova recente.",
  );
});

Deno.test("migration Fase 5B fecha tabelas privadas e concede somente EXECUTE ao service_role", async () => {
  const migration = await Deno.readTextFile(
    new URL(
      "../../migrations/20260829144846_fase5b_solicitacoes_site_privadas.sql",
      import.meta.url,
    ),
  );
  const privateTables = [
    "crm_site_booking_requests",
    "crm_site_booking_replays",
    "crm_site_booking_operations",
  ];
  for (const table of privateTables) {
    assert(migration.includes(`create table private.${table}`), `Tabela privada ausente: ${table}`);
    assert(
      migration.includes(`alter table private.${table} enable row level security;`),
      `RLS ausente: ${table}`,
    );
  }

  const tableRevokeStart = migration.indexOf(
    "revoke all on table private.crm_site_booking_requests",
  );
  const tableRevokeEnd = migration.indexOf("revoke all on function", tableRevokeStart);
  const tableRevoke = migration.slice(tableRevokeStart, tableRevokeEnd);
  assert(tableRevokeStart >= 0 && tableRevokeEnd > tableRevokeStart, "REVOKE das tabelas ausente.");
  for (const table of privateTables) {
    assert(tableRevoke.includes(`private.${table}`), `REVOKE não cobre ${table}.`);
  }
  for (const role of ["public", "anon", "authenticated", "service_role"]) {
    assert(tableRevoke.includes(role), `REVOKE direto não cobre o papel ${role}.`);
  }
  assert(
    !/grant\s+(?:all|select|insert|update|delete|truncate|references|trigger)(?:\s*,\s*\w+)*\s+on\s+table\s+private\.crm_site_booking_/i
      .test(migration),
    "Nenhum papel pode receber privilégio direto nas tabelas privadas.",
  );

  for (
    const rpcName of [
      "crm_site_booking_receive",
      "crm_site_booking_list",
      "crm_site_booking_accept",
      "crm_site_booking_archive",
    ]
  ) {
    const definitionStart = migration.indexOf(`create or replace function public.${rpcName}(`);
    const definitionEnd = migration.indexOf("$function$;", definitionStart);
    const definition = migration.slice(definitionStart, definitionEnd);
    assert(
      definitionStart >= 0 && definitionEnd > definitionStart,
      `Definição ausente: ${rpcName}`,
    );
    assert(/security definer/i.test(definition), `${rpcName} deve ser SECURITY DEFINER.`);
    assert(/set search_path = ''/i.test(definition), `${rpcName} deve fixar search_path vazio.`);
    assert(
      migration.includes(`revoke all on function public.${rpcName}(`),
      `REVOKE de EXECUTE ausente: ${rpcName}`,
    );
    const grantStart = migration.indexOf(`grant execute on function public.${rpcName}(`);
    const grantEnd = migration.indexOf(";", grantStart);
    const grant = migration.slice(grantStart, grantEnd);
    assert(grantStart >= 0 && grantEnd > grantStart, `GRANT de EXECUTE ausente: ${rpcName}`);
    assert(
      /\bto service_role\s*$/i.test(grant.trim()),
      `${rpcName} deve ser exclusivo do service_role.`,
    );
  }
});

Deno.test("migration Fase 5B não aceita objetivo livre nem cria agenda", async () => {
  const migration = await Deno.readTextFile(
    new URL(
      "../../migrations/20260829144846_fase5b_solicitacoes_site_privadas.sql",
      import.meta.url,
    ),
  );
  const executableSql = migration.replace(/--.*$/gm, "");

  assert(
    !/\b(?:p_)?objective\b/i.test(executableSql) &&
      !/\b(?:p_)?objetivo\b/i.test(executableSql) &&
      !/["'](?:objective|objetivo)["']/i.test(executableSql),
    "Caixa privada não pode receber nem persistir objetivo livre.",
  );
  assert(
    !/public\.(?:agendamentos_clinica|agendamento_lembretes|agenda_[a-z0-9_]*)/i.test(
      executableSql,
    ),
    "Aceitar solicitação não pode escrever ou consultar tabelas da agenda.",
  );
  assert(
    !/\b(?:insert\s+into|update|delete\s+from)\s+[^;\n]*(?:agenda|appointment)/i.test(
      executableSql,
    ),
    "Migration não pode criar compromisso por efeito colateral.",
  );
  assert(
    executableSql.includes("public.marketing_crm_salvar_lead("),
    "Aceite deve terminar somente em lead/interação comercial revisada.",
  );
});

Deno.test("aceite Fase 5B serializa a identidade por clínica e telefone antes da deduplicação", async () => {
  const migration = await Deno.readTextFile(
    new URL(
      "../../migrations/20260829144846_fase5b_solicitacoes_site_privadas.sql",
      import.meta.url,
    ),
  );
  const acceptStart = migration.indexOf(
    "create or replace function public.crm_site_booking_accept(",
  );
  const acceptEnd = migration.indexOf("$function$;", acceptStart);
  const accept = migration.slice(acceptStart, acceptEnd);
  const phoneLock = accept.indexOf(
    "'site-booking:lead-identity:' || p_clinic_id::text || ':' || v_request.phone",
  );
  const identityRead = accept.indexOf("pg_catalog.count(*)::integer");

  assert(acceptStart >= 0 && acceptEnd > acceptStart, "RPC de aceite ausente.");
  assert(phoneLock >= 0, "Aceite deve usar lock clinic+telefone para a identidade pública.");
  assert(
    identityRead > phoneLock,
    "Contagem por telefone não pode ocorrer antes do advisory lock da identidade.",
  );
});

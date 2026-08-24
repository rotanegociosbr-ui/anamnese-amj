import "jsr:@supabase/functions-js@2.112.3/edge-runtime.d.ts";
import {
  authenticateDual,
  authResponseFields,
  DualAuthConfig,
  DualAuthContext,
  DualAuthError,
  requireRecentPasswordProof,
  writeClinicAudit,
} from "../_shared/dual-auth.ts";
import {
  containsMessagingInstruction,
  isOperationalPurpose,
  JsonRecord,
  requiresRecentProof,
  returnScheduleIsValid,
} from "./logic.ts";

const URL = (Deno.env.get("SUPABASE_URL") || "").replace(/\/+$/, "");
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const AUTH_CONFIG: DualAuthConfig = {
  supabaseUrl: URL,
  serviceRoleKey: SERVICE,
  allowedRoles: ["owner"],
  requireAal2: true,
};

const MAX_JSON_BYTES = 384 * 1024;
const CLINIC_MEDIA_BUCKET = "clinic-media";
const PHOTO_SIGNED_URL_SECONDS = 300;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ALLOWED_ORIGINS = new Set([
  "https://anamariajacob.com.br",
  "https://www.anamariajacob.com.br",
  "http://127.0.0.1:8765",
  "http://localhost:8765",
]);
const requestAuth = new WeakMap<Request, DualAuthContext>();

class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly publicMessage: string,
    readonly existingId: string | null = null,
  ) {
    super(publicMessage);
    this.name = "ApiError";
  }
}

function cors(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") || "";
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.has(origin)
      ? origin
      : "https://anamariajacob.com.br",
    "Access-Control-Allow-Headers":
      "authorization, apikey, content-type, x-client-info, x-amj-reauthentication",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "600",
    "Vary": "Origin",
  };
}

function json(req: Request, body: unknown, status = 200): Response {
  const context = requestAuth.get(req);
  const payload = context && body && typeof body === "object" && !Array.isArray(body)
    ? { ...(body as JsonRecord), ...authResponseFields(context) }
    : body;
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...cors(req),
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store, max-age=0",
      "Pragma": "no-cache",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
    },
  });
}

function safeText(value: unknown, max = 500): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function optionalText(value: unknown, max: number): string | null {
  const normalized = safeText(value, max);
  return normalized || null;
}

function validUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function requiredUuid(value: unknown, field: string): string {
  if (!validUuid(value)) throw new ApiError(422, "invalid_uuid", `Informe ${field} corretamente.`);
  return value;
}

function optionalUuid(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  return requiredUuid(value, field);
}

function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !DATE_PATTERN.test(value)) return false;
  const parsed = new Date(value + "T00:00:00Z");
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function optionalDate(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (!validDate(value)) throw new ApiError(422, "invalid_date", `Informe ${field} corretamente.`);
  return value;
}

function requiredDate(value: unknown, field: string): string {
  const date = optionalDate(value, field);
  if (!date) throw new ApiError(422, "invalid_date", `Informe ${field} corretamente.`);
  return date;
}

function optionalTimestamp(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") {
    throw new ApiError(422, "invalid_timestamp", `Informe ${field} corretamente.`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new ApiError(422, "invalid_timestamp", `Informe ${field} corretamente.`);
  }
  return parsed.toISOString();
}

function requiredTimestamp(value: unknown, field: string): string {
  const timestamp = optionalTimestamp(value, field);
  if (!timestamp) throw new ApiError(422, "invalid_timestamp", `Informe ${field} corretamente.`);
  return timestamp;
}

function optionalInteger(value: unknown, field: string, min: number, max: number): number | null {
  if (value === undefined || value === null || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new ApiError(422, "invalid_number", `Informe ${field} corretamente.`);
  }
  return parsed;
}

function requiredInteger(value: unknown, field: string, min: number, max: number): number {
  const parsed = optionalInteger(value, field, min, max);
  if (parsed === null) throw new ApiError(422, "invalid_number", `Informe ${field} corretamente.`);
  return parsed;
}

function requiredNumber(value: unknown, field: string, min = 0): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < min) {
    throw new ApiError(422, "invalid_number", `Informe ${field} corretamente.`);
  }
  return parsed;
}

function tenant(context: DualAuthContext): { clinicId: string; userId: string } {
  if (
    context.authMethod !== "supabase_auth" || context.aal !== "aal2" ||
    context.role !== "owner" || !validUuid(context.clinicId) || !validUuid(context.userId)
  ) {
    throw new ApiError(
      403,
      "owner_aal2_required",
      "Entre com a conta de responsável e confirme o autenticador.",
    );
  }
  return { clinicId: context.clinicId, userId: context.userId };
}

function baseRpc(context: DualAuthContext): JsonRecord {
  const { clinicId, userId } = tenant(context);
  return {
    p_clinic_id: clinicId,
    p_user_id: userId,
    p_actor_role: context.role,
    p_auth_method: context.authMethod,
    p_aal: context.aal,
  };
}

async function serviceFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers || {});
  headers.set("apikey", SERVICE);
  headers.set("Authorization", "Bearer " + SERVICE);
  return await fetch(URL + path, { ...init, headers });
}

async function readBackendError(
  response: Response,
): Promise<{ code: string; existingId: string | null }> {
  try {
    const body = await response.json();
    const message = safeText(body?.message, 160);
    const code = /^[a-z0-9_]+$/.test(message)
      ? message
      : safeText(body?.code, 40) || "backend_error";
    const detail = safeText(body?.details, 80);
    return { code, existingId: validUuid(detail) ? detail : null };
  } catch {
    return { code: "backend_error", existingId: null };
  }
}

const BACKEND_MESSAGES: Record<string, string> = {
  owner_aal2_required: "Confirme a conta de responsável e o autenticador.",
  aal2_required: "Confirme o autenticador para continuar.",
  role_forbidden: "Somente os responsáveis podem acessar esta área.",
  patient_not_found: "Cliente não encontrado.",
  responsible_not_found: "Responsável não encontrado ou sem acesso ativo.",
  appointment_not_found: "Agendamento não encontrado.",
  appointment_patient_link_required: "Confirme o vínculo do agendamento com o cliente.",
  protocol_patient_mismatch: "O prontuário não pertence ao cliente selecionado.",
  financial_entry_patient_mismatch: "O lançamento financeiro não pertence a este atendimento.",
  attendance_not_found: "Atendimento não encontrado.",
  attendance_archived: "Restaure o atendimento antes de alterá-lo.",
  attendance_date_invalid: "A data do atendimento não pode ficar no futuro.",
  attendance_day_exists:
    "Já existe uma visita desta paciente nessa data. Adicione o procedimento à visita existente.",
  attendance_link_exists:
    "Este agendamento, prontuário ou vínculo financeiro já pertence a outra visita. Abra o atendimento existente.",
  attendance_links_locked_by_return:
    "Os vínculos do atendimento não podem mudar depois que existe um retorno.",
  attendance_protocol_locked_by_stock:
    "O prontuário não pode mudar depois que existe movimentação de estoque.",
  attendance_financial_locked_by_fee:
    "A receita não pode mudar depois que existe taxa de pagamento vinculada.",
  attendance_procedure_items_required: "Altere os procedimentos pelos itens da visita da paciente.",
  attendance_procedure_not_found: "Procedimento do atendimento não encontrado.",
  attendance_procedure_archived: "Restaure o procedimento antes de alterá-lo.",
  attendance_last_procedure_required: "O atendimento precisa manter ao menos um procedimento.",
  attendance_procedure_limit: "Este atendimento atingiu o limite de procedimentos.",
  procedure_date_invalid:
    "O procedimento precisa ocorrer na mesma data da visita e não pode estar no futuro.",
  procedure_financial_link_invalid:
    "A cobrança deve ser de atendimento, ativa e pertencer à paciente.",
  procedure_financial_locked_by_fee:
    "O vínculo financeiro não pode mudar depois que existe taxa declarada.",
  procedure_duplicate_requires_confirmation:
    "Este procedimento parece repetir outro item da mesma visita. Confirme que é distinto e informe o motivo.",
  procedure_duplicate_exists:
    "Este procedimento já está registrado com o mesmo horário e região. Abra o existente.",
  procedure_possible_duplicate_requires_review:
    "Já existe um procedimento do mesmo tipo nesta visita. Confira região e horário; se for outro, confirme e justifique.",
  version_conflict: "O registro mudou em outro acesso. Atualize a tela.",
  return_queue_not_found: "Retorno não encontrado.",
  return_duplicate_exists: "Este retorno já está registrado para o mesmo procedimento e período.",
  return_queue_closed: "Este retorno já foi encerrado e não pode ser reaberto por esta operação.",
  return_attempt_date_invalid: "A data da tentativa não pertence ao período deste retorno.",
  operational_preference_purpose_invalid:
    "Este módulo aceita somente preferências de retorno ou agenda.",
  operational_contact_not_allowed: "Este canal não está autorizado para essa finalidade.",
  return_appointment_invalid: "Selecione um agendamento de retorno válido.",
  stock_lot_not_found: "Lote não encontrado.",
  stock_insufficient: "O lote não possui saldo suficiente.",
  return_quantity_exceeds_withdrawal:
    "A devolução supera a quantidade retirada para o procedimento.",
  payment_attendance_mismatch: "O pagamento não pertence ao atendimento.",
  cost_sheet_item_invalid: "Revise os produtos e quantidades da ficha de custo.",
  append_only_record: "Este histórico é imutável; registre um novo evento de correção.",
  attendance_photo_invalid: "A foto não pertence ao prontuário desta paciente.",
  attendance_photo_category_invalid: "A categoria da galeria não corresponde à etapa da foto.",
  attendance_photo_product_link_invalid: "Revise o produto, lote ou consumo vinculado à foto.",
  attendance_photo_already_linked: "Esta foto já está vinculada a um atendimento.",
  attendance_photo_link_not_found: "Vínculo da foto não encontrado.",
  attendance_photo_parent_immutable: "A imagem original do vínculo não pode ser substituída.",
  attendance_photo_metadata_invalid: "Revise a organização e a legenda da foto.",
  attendance_photo_consumption_invalid:
    "O consumo não corresponde ao produto fotografado neste atendimento.",
  attendance_protocol_required: "Vincule um prontuário ao atendimento antes de adicionar fotos.",
  clinical_photography_consent_required:
    "Registre o consentimento clínico de fotografia no prontuário antes do upload.",
};

function backendStatus(code: string): number {
  if (code.endsWith("_not_found")) return 404;
  if (code === "version_conflict" || code === "40001" || code === "23505") return 409;
  if (
    code === "42501" || code.includes("forbidden") ||
    code === "aal2_required" || code === "owner_aal2_required" ||
    code === "operational_contact_not_allowed"
  ) return 403;
  if (
    code === "22023" || code === "23514" || code.includes("invalid") || code.includes("mismatch")
  ) return 422;
  return 409;
}

async function rpc(name: string, body: JsonRecord): Promise<JsonRecord> {
  const response = await serviceFetch("/rest/v1/rpc/" + name, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const failure = await readBackendError(response);
    throw new ApiError(
      backendStatus(failure.code),
      failure.code,
      BACKEND_MESSAGES[failure.code] || "Não foi possível concluir a operação.",
      failure.existingId,
    );
  }
  const value = await response.json();
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

async function rest(path: string): Promise<unknown[]> {
  const response = await serviceFetch(path, { headers: { "Accept": "application/json" } });
  if (!response.ok) {
    const failure = await readBackendError(response);
    throw new ApiError(503, failure.code, "Não foi possível carregar os dados operacionais.");
  }
  const value = await response.json();
  return Array.isArray(value) ? value : [];
}

async function signedPhotoLinks(paths: string[]): Promise<Record<string, string>> {
  const uniquePaths = [...new Set(paths.map((path) => safeText(path, 600)).filter(Boolean))];
  if (!uniquePaths.length) return {};
  const result: Record<string, string> = {};
  for (let offset = 0; offset < uniquePaths.length; offset += 100) {
    const batch = uniquePaths.slice(offset, offset + 100);
    const response = await serviceFetch(`/storage/v1/object/sign/${CLINIC_MEDIA_BUCKET}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expiresIn: PHOTO_SIGNED_URL_SECONDS, paths: batch }),
    });
    if (!response.ok) continue;
    const rows = await response.json();
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      const path = safeText(row?.path, 600);
      const signedUrl = safeText(row?.signedURL, 2000);
      if (path && signedUrl) result[path] = `${URL}/storage/v1${signedUrl}`;
    }
  }
  return result;
}

async function requireProof(
  req: Request,
  context: DualAuthContext,
  payload: JsonRecord,
  action: string,
  targetId: string,
): Promise<string> {
  const operationId = requiredUuid(payload.operation_id, "a identificação da confirmação");
  const reason = safeText(payload.motivo, 500);
  if (reason.length < 3) {
    throw new ApiError(422, "reason_required", "Informe o motivo da operação.");
  }
  await requireRecentPasswordProof(req, AUTH_CONFIG, context, {
    operationId,
    action,
    targetId,
  });
  return operationId;
}

async function requestId(
  req: Request,
  context: DualAuthContext,
  payload: JsonRecord,
  action: string,
  targetId: string,
): Promise<string> {
  if (requiresRecentProof(action, payload)) {
    return await requireProof(req, context, payload, `operacao.${action}`, targetId);
  }
  return requiredUuid(payload.idempotency_key, "a chave da operação");
}

function response(req: Request, result: JsonRecord, extras: JsonRecord = {}): Response {
  return json(req, { ok: true, resultado: result, ...extras });
}

async function handleList(
  req: Request,
  context: DualAuthContext,
  payload: JsonRecord,
): Promise<Response> {
  const { clinicId } = tenant(context);
  const clinic = encodeURIComponent(clinicId);
  const limit = optionalInteger(payload.limite, "o limite da listagem", 100, 5_000) || 1_000;
  const detailLimit = Math.min(limit * 2, 10_000);
  const [
    patients,
    attendances,
    attendanceProcedures,
    profiles,
    preferences,
    recommendations,
    queues,
    attempts,
    sheets,
    sheetItems,
    profitability,
    monthlyProfitability,
    returnSummary,
    products,
    inventory,
    protocols,
    entries,
    payments,
    paymentFees,
    attendancePhotos,
    consumptionEvents,
    members,
    appointmentLinks,
  ] = await Promise.all([
    rest(
      `/rest/v1/patients?select=id,full_name,status,archived_at&clinic_id=eq.${clinic}&order=full_name.asc&limit=${limit}`,
    ),
    rest(
      `/rest/v1/atendimentos_realizados?select=*&clinic_id=eq.${clinic}&order=attended_at.desc&limit=${limit}`,
    ),
    rest(
      `/rest/v1/atendimento_procedimentos?select=*&clinic_id=eq.${clinic}&order=attendance_id.asc,is_primary.desc,created_at.asc&limit=${detailLimit}`,
    ),
    rest(
      `/rest/v1/patient_operational_profile_current?select=*&clinic_id=eq.${clinic}&limit=${limit}`,
    ),
    rest(
      `/rest/v1/patient_contact_preference_current?select=*&clinic_id=eq.${clinic}&limit=${detailLimit}`,
    ),
    rest(
      `/rest/v1/retorno_recomendacoes?select=*&clinic_id=eq.${clinic}&order=created_at.desc&limit=${limit}`,
    ),
    rest(
      `/rest/v1/retorno_fila?select=*&clinic_id=eq.${clinic}&order=next_action_at.asc.nullslast&limit=${limit}`,
    ),
    rest(
      `/rest/v1/retorno_tentativas?select=*&clinic_id=eq.${clinic}&order=attempted_at.desc&limit=${limit}`,
    ),
    rest(
      `/rest/v1/operacao_fichas_custo?select=*&clinic_id=eq.${clinic}&order=procedure_kind.asc,version.desc&limit=${limit}`,
    ),
    rest(
      `/rest/v1/operacao_ficha_custo_itens?select=*&clinic_id=eq.${clinic}&order=position.asc&limit=${detailLimit}`,
    ),
    rest(
      `/rest/v1/operacao_rentabilidade_atendimentos?select=*&clinic_id=eq.${clinic}&order=attendance_date.desc&limit=${limit}`,
    ),
    rest(
      `/rest/v1/operacao_rentabilidade_mensal?select=*&clinic_id=eq.${clinic}&order=competence_month.desc&limit=${limit}`,
    ),
    rest(
      `/rest/v1/operacao_retorno_resumo_diario?select=*&clinic_id=eq.${clinic}&order=action_date.asc.nullslast&limit=${limit}`,
    ),
    rest(
      `/rest/v1/financeiro_produtos?select=id,brand_id,name,product_type,unit,active,archived_at,stock_control&clinic_id=eq.${clinic}&order=name.asc&limit=${limit}`,
    ),
    rest(
      `/rest/v1/financeiro_estoque_saldos?select=product_id,lot_id,lot,expiry,unit,quantity_balance,effective_value&clinic_id=eq.${clinic}&order=expiry.asc&limit=${detailLimit}`,
    ),
    rest(
      `/rest/v1/protocols?select=id,patient_id,appointment_id,procedure_kind,procedure_date,status,archived_at,version&clinic_id=eq.${clinic}&order=procedure_date.desc&limit=${limit}`,
    ),
    rest(
      `/rest/v1/financeiro_lancamentos?select=id,patient_id,entry_type,origin,description,competence_date,total_amount,state&clinic_id=eq.${clinic}&entry_type=eq.receita&origin=eq.atendimento&order=competence_date.desc&limit=${limit}`,
    ),
    rest(
      `/rest/v1/financeiro_pagamentos?select=id,entry_id,movement_type,payment_method,amount,paid_at,reversed_payment_id&clinic_id=eq.${clinic}&order=paid_at.desc&limit=${detailLimit}`,
    ),
    rest(
      `/rest/v1/atendimento_pagamento_taxas?select=*&clinic_id=eq.${clinic}&order=recorded_at.desc&limit=${detailLimit}`,
    ),
    rest(
      `/rest/v1/operacao_atendimento_fotos?select=*&clinic_id=eq.${clinic}&order=attendance_id.asc,category.asc,display_order.asc&limit=${detailLimit}`,
    ),
    rest(
      `/rest/v1/operacao_consumo_eventos?select=id,attendance_id,product_id,lot_id,event_kind,amount,unit,occurred_at&clinic_id=eq.${clinic}&order=occurred_at.desc&limit=${detailLimit}`,
    ),
    rest(
      `/rest/v1/clinic_members?select=user_id,display_name,status&clinic_id=eq.${clinic}&status=eq.active&order=display_name.asc&limit=100`,
    ),
    rest(
      `/rest/v1/patient_source_links?select=patient_id,source_id,status&clinic_id=eq.${clinic}&source_kind=eq.agendamento&status=eq.confirmado&limit=${detailLimit}`,
    ),
  ]);

  const appointmentIds = [
    ...new Set(
      appointmentLinks.map((item) => safeText((item as JsonRecord).source_id, 40)).filter(
        validUuid,
      ),
    ),
  ];
  const appointments = appointmentIds.length
    ? await rest(
      "/rest/v1/agendamentos_clinica?select=id,categoria,procedimento,inicio_em,fim_em,status,retorno_de_id" +
        `&id=in.(${appointmentIds.join(",")})&order=inicio_em.desc&limit=${detailLimit}`,
    )
    : [];
  const photoLinks = await signedPhotoLinks(
    attendancePhotos.filter((item) => !(item as JsonRecord).archived_at)
      .flatMap((item) => {
        const row = item as JsonRecord;
        return [
          safeText(row.thumbnail_storage_path, 600),
          safeText(row.storage_path, 600),
        ].filter(Boolean);
      }),
  );
  const gallery = attendancePhotos.map((item) => {
    const row = item as JsonRecord;
    const path = safeText(row.storage_path, 600);
    const thumbnailPath = safeText(row.thumbnail_storage_path, 600);
    return {
      ...row,
      url_assinada: row.archived_at ? null : photoLinks[path] || null,
      miniatura_url: row.archived_at ? null : photoLinks[thumbnailPath] || photoLinks[path] || null,
      expira_em_segundos: row.archived_at ? null : PHOTO_SIGNED_URL_SECONDS,
    };
  });

  return json(req, {
    ok: true,
    clientes: patients,
    atendimentos: attendances,
    procedimentos_atendimento: attendanceProcedures,
    perfis_operacionais: profiles,
    preferencias_contato: preferences,
    recomendacoes_retorno: recommendations,
    fila_retorno: queues,
    tentativas_retorno: attempts,
    fichas_custo: sheets,
    itens_ficha_custo: sheetItems,
    rentabilidade_atendimentos: profitability,
    rentabilidade_mensal: monthlyProfitability,
    resumo_retornos: returnSummary,
    produtos: products,
    estoque_lotes: inventory,
    protocolos: protocols,
    lancamentos_receita: entries,
    pagamentos: payments,
    taxas_pagamento: paymentFees,
    fotos_atendimento: gallery,
    eventos_consumo: consumptionEvents,
    responsaveis: members,
    vinculos_agenda: appointmentLinks,
    agendamentos: appointments,
    automacao_mensagens: false,
    metrica_financeira: "margem_de_contribuicao_gerencial",
    paginacao: {
      limite: limit,
      maximo: 5_000,
      possivelmente_truncado: [
        patients,
        attendances,
        profiles,
        recommendations,
        queues,
        attempts,
        sheets,
        profitability,
        monthlyProfitability,
        returnSummary,
        products,
        protocols,
        entries,
      ].some((items) => items.length >= limit) || [
        preferences,
        attendanceProcedures,
        sheetItems,
        inventory,
        payments,
        paymentFees,
        attendancePhotos,
        consumptionEvents,
        appointmentLinks,
        appointments,
      ].some((items) => items.length >= detailLimit),
    },
  });
}

async function handleSaveAttendance(
  req: Request,
  context: DualAuthContext,
  payload: JsonRecord,
): Promise<Response> {
  const attendanceId = optionalUuid(payload.atendimento_id, "o atendimento");
  const idempotencyKey = requiredUuid(payload.idempotency_key, "a chave da operação");
  const targetId = attendanceId || idempotencyKey;
  const operationRequestId = await requestId(req, context, payload, "salvar_atendimento", targetId);
  const result = await rpc("operacao_salvar_atendimento", {
    ...baseRpc(context),
    p_attendance_id: attendanceId,
    p_expected_version: attendanceId
      ? requiredInteger(payload.versao, "a versão", 1, 2_000_000_000)
      : null,
    p_patient_id: requiredUuid(payload.cliente_id, "o cliente"),
    p_appointment_id: optionalUuid(payload.agendamento_id, "o agendamento"),
    p_protocol_id: optionalUuid(payload.protocolo_id, "o prontuário"),
    p_financial_entry_id: optionalUuid(payload.lancamento_financeiro_id, "o lançamento financeiro"),
    p_procedure_kind: safeText(payload.procedimento, 120),
    p_attended_at: requiredTimestamp(payload.realizado_em, "a data do atendimento"),
    p_duration_minutes: optionalInteger(payload.duracao_minutos, "a duração", 1, 720),
    p_status: safeText(payload.status, 30) || "realizado",
    p_responsible_user_id: requiredUuid(payload.responsavel_id, "o responsável"),
    p_idempotency_key: idempotencyKey,
    p_request_id: operationRequestId,
  });
  return response(req, result);
}

async function handleArchive(
  req: Request,
  context: DualAuthContext,
  payload: JsonRecord,
  archive: boolean,
): Promise<Response> {
  const attendanceId = requiredUuid(payload.atendimento_id, "o atendimento");
  const action = archive ? "arquivar_atendimento" : "restaurar_atendimento";
  const operationId = await requestId(req, context, payload, action, attendanceId);
  const result = await rpc("operacao_definir_arquivamento_atendimento", {
    ...baseRpc(context),
    p_attendance_id: attendanceId,
    p_expected_version: requiredInteger(payload.versao, "a versão", 1, 2_000_000_000),
    p_archive: archive,
    p_reason: safeText(payload.motivo, 500),
    p_request_id: operationId,
  });
  return response(req, result);
}

async function handleSaveAttendanceProcedure(
  req: Request,
  context: DualAuthContext,
  payload: JsonRecord,
): Promise<Response> {
  const itemId = optionalUuid(payload.procedimento_item_id, "o procedimento");
  const attendanceId = requiredUuid(payload.atendimento_id, "o atendimento");
  const operationId = await requestId(
    req,
    context,
    payload,
    "salvar_procedimento_atendimento",
    itemId || attendanceId,
  );
  const result = await rpc("operacao_salvar_procedimento_atendimento", {
    ...baseRpc(context),
    p_procedure_item_id: itemId,
    p_expected_version: itemId
      ? requiredInteger(payload.versao, "a versão", 1, 2_000_000_000)
      : null,
    p_attendance_id: attendanceId,
    p_financial_entry_id: optionalUuid(payload.lancamento_financeiro_id, "a cobrança"),
    p_procedure_kind: safeText(payload.procedimento, 120),
    p_procedure_region: optionalText(payload.regiao_procedimento, 120),
    p_performed_at: optionalTimestamp(payload.procedimento_em, "o horário do procedimento"),
    p_confirm_distinct: payload.confirmar_repeticao_distinta === true,
    p_distinct_reason: optionalText(payload.motivo_repeticao_distinta, 500),
    p_idempotency_key: requiredUuid(payload.idempotency_key, "a chave da operação"),
    p_request_id: operationId,
  });
  return response(req, result, { hard_delete: false });
}

async function handleArchiveAttendanceProcedure(
  req: Request,
  context: DualAuthContext,
  payload: JsonRecord,
  archive: boolean,
): Promise<Response> {
  const itemId = requiredUuid(payload.procedimento_item_id, "o procedimento");
  const action = archive
    ? "arquivar_procedimento_atendimento"
    : "restaurar_procedimento_atendimento";
  const operationId = await requestId(req, context, payload, action, itemId);
  const result = await rpc("operacao_definir_arquivamento_procedimento", {
    ...baseRpc(context),
    p_procedure_item_id: itemId,
    p_expected_version: requiredInteger(payload.versao, "a versão", 1, 2_000_000_000),
    p_archive: archive,
    p_confirm_distinct: !archive && payload.confirmar_repeticao_distinta === true,
    p_distinct_reason: !archive ? optionalText(payload.motivo_repeticao_distinta, 500) : null,
    p_reason: safeText(payload.motivo, 500),
    p_request_id: operationId,
  });
  return response(req, result, { hard_delete: false });
}

async function handleProfile(
  req: Request,
  context: DualAuthContext,
  payload: JsonRecord,
): Promise<Response> {
  const patientId = requiredUuid(payload.cliente_id, "o cliente");
  const operationId = await requestId(
    req,
    context,
    payload,
    "registrar_perfil_paciente",
    patientId,
  );
  const result = await rpc("operacao_registrar_perfil_paciente", {
    ...baseRpc(context),
    p_patient_id: patientId,
    p_preferred_name: optionalText(payload.nome_preferido, 80),
    p_accessibility_note: optionalText(payload.acessibilidade, 500),
    p_privacy_notice_version: optionalText(payload.aviso_privacidade_versao, 80),
    p_reason: safeText(payload.motivo, 500),
    p_idempotency_key: requiredUuid(payload.idempotency_key, "a chave da operação"),
    p_request_id: operationId,
  });
  return response(req, result);
}

async function handlePreference(
  req: Request,
  context: DualAuthContext,
  payload: JsonRecord,
): Promise<Response> {
  const patientId = requiredUuid(payload.cliente_id, "o cliente");
  const operationId = await requestId(
    req,
    context,
    payload,
    "registrar_preferencia_contato",
    patientId,
  );
  const purpose = safeText(payload.finalidade, 20);
  if (!isOperationalPurpose(purpose)) {
    throw new ApiError(
      422,
      "operational_preference_purpose_invalid",
      "Este módulo aceita somente preferências de retorno ou agenda.",
    );
  }
  const result = await rpc("operacao_registrar_preferencia_contato", {
    ...baseRpc(context),
    p_patient_id: patientId,
    p_purpose: purpose,
    p_channel: safeText(payload.canal, 20),
    p_allowed: payload.autorizado === true,
    p_evidence_kind: safeText(payload.tipo_evidencia, 40),
    p_evidence_reference: optionalText(payload.referencia_evidencia, 180),
    p_privacy_notice_version: optionalText(payload.aviso_privacidade_versao, 80),
    p_effective_at: optionalTimestamp(payload.efetivo_em, "a data de vigência"),
    p_idempotency_key: requiredUuid(payload.idempotency_key, "a chave da operação"),
    p_request_id: operationId,
  });
  return response(req, result);
}

async function handleCreateReturn(
  req: Request,
  context: DualAuthContext,
  payload: JsonRecord,
): Promise<Response> {
  const attendanceId = requiredUuid(payload.atendimento_id, "o atendimento");
  const operationId = await requestId(req, context, payload, "criar_retorno", attendanceId);
  const exactDate = optionalDate(payload.data_exata, "a data exata");
  const windowStart = optionalDate(payload.janela_inicio, "o início da janela");
  const windowEnd = optionalDate(payload.janela_fim, "o fim da janela");
  if (!returnScheduleIsValid(exactDate, windowStart, windowEnd)) {
    throw new ApiError(
      422,
      "return_schedule_invalid",
      "Informe uma data exata ou uma janela completa.",
    );
  }
  const result = await rpc("operacao_criar_retorno", {
    ...baseRpc(context),
    p_attendance_id: attendanceId,
    p_recommendation_kind: safeText(payload.recomendacao, 120),
    p_exact_date: exactDate,
    p_window_start: windowStart,
    p_window_end: windowEnd,
    p_instruction: optionalText(payload.orientacao, 500),
    p_responsible_user_id: requiredUuid(payload.responsavel_id, "o responsável"),
    p_next_action_at: requiredTimestamp(payload.proxima_acao_em, "a próxima ação"),
    p_idempotency_key: requiredUuid(payload.idempotency_key, "a chave da operação"),
    p_request_id: operationId,
  });
  return response(req, result, { mensagem_enviada: false });
}

async function handleUpdateReturn(
  req: Request,
  context: DualAuthContext,
  payload: JsonRecord,
): Promise<Response> {
  const queueId = requiredUuid(payload.fila_id, "o retorno");
  const operationId = await requestId(req, context, payload, "atualizar_retorno", queueId);
  const result = await rpc("operacao_atualizar_retorno", {
    ...baseRpc(context),
    p_queue_id: queueId,
    p_expected_version: requiredInteger(payload.versao, "a versão", 1, 2_000_000_000),
    p_status: safeText(payload.status, 40),
    p_next_action: safeText(payload.proxima_acao, 40),
    p_next_action_at: optionalTimestamp(payload.proxima_acao_em, "a próxima ação"),
    p_responsible_user_id: requiredUuid(payload.responsavel_id, "o responsável"),
    p_reason: safeText(payload.motivo, 500),
    p_request_id: operationId,
  });
  return response(req, result, { mensagem_enviada: false });
}

async function handleAttempt(
  req: Request,
  context: DualAuthContext,
  payload: JsonRecord,
): Promise<Response> {
  const queueId = requiredUuid(payload.fila_id, "o retorno");
  const operationId = await requestId(
    req,
    context,
    payload,
    "registrar_tentativa_retorno",
    queueId,
  );
  const result = await rpc("operacao_registrar_tentativa_retorno", {
    ...baseRpc(context),
    p_queue_id: queueId,
    p_expected_version: requiredInteger(payload.versao, "a versão", 1, 2_000_000_000),
    p_channel: safeText(payload.canal, 20),
    p_purpose: safeText(payload.finalidade, 20) || "retorno",
    p_result: safeText(payload.resultado, 40),
    p_template_reference: optionalText(payload.template_referencia, 120),
    p_next_action: safeText(payload.proxima_acao, 40),
    p_next_action_at: optionalTimestamp(payload.proxima_acao_em, "a próxima ação"),
    p_attempted_at: optionalTimestamp(payload.tentado_em, "a data da tentativa"),
    p_idempotency_key: requiredUuid(payload.idempotency_key, "a chave da operação"),
    p_request_id: operationId,
  });
  return response(req, result, { mensagem_enviada: false });
}

async function handleLinkAppointment(
  req: Request,
  context: DualAuthContext,
  payload: JsonRecord,
): Promise<Response> {
  const queueId = requiredUuid(payload.fila_id, "o retorno");
  const operationId = await requestId(
    req,
    context,
    payload,
    "vincular_retorno_agendamento",
    queueId,
  );
  const result = await rpc("operacao_vincular_retorno_agendamento", {
    ...baseRpc(context),
    p_queue_id: queueId,
    p_expected_version: requiredInteger(payload.versao, "a versão", 1, 2_000_000_000),
    p_appointment_id: requiredUuid(payload.agendamento_id, "o agendamento"),
    p_request_id: operationId,
  });
  return response(req, result, { mensagem_enviada: false });
}

async function handleCostSheet(
  req: Request,
  context: DualAuthContext,
  payload: JsonRecord,
): Promise<Response> {
  const { clinicId } = tenant(context);
  const operationId = await requestId(req, context, payload, "registrar_ficha_custo", clinicId);
  const status = safeText(payload.status, 20) || "rascunho";
  const items = payload.itens;
  if (
    !Array.isArray(items) || items.length > 100 ||
    (status === "retirada" ? items.length !== 0 : items.length < 1)
  ) {
    throw new ApiError(
      422,
      "cost_sheet_items_invalid",
      "Informe os itens e quantidades previstos.",
    );
  }
  const result = await rpc("operacao_registrar_ficha_custo", {
    ...baseRpc(context),
    p_procedure_kind: safeText(payload.procedimento, 120),
    p_status: status,
    p_valid_from: requiredDate(payload.vigente_desde, "a vigência"),
    p_reason: safeText(payload.motivo, 500),
    p_items: items,
    p_idempotency_key: requiredUuid(payload.idempotency_key, "a chave da operação"),
    p_request_id: operationId,
  });
  return response(req, result, { quantidades_inferidas: false });
}

async function handleConsumption(
  req: Request,
  context: DualAuthContext,
  payload: JsonRecord,
): Promise<Response> {
  const attendanceId = requiredUuid(payload.atendimento_id, "o atendimento");
  const operationId = await requestId(
    req,
    context,
    payload,
    "registrar_evento_consumo",
    attendanceId,
  );
  const result = await rpc("operacao_registrar_evento_consumo", {
    ...baseRpc(context),
    p_attendance_id: attendanceId,
    p_product_id: requiredUuid(payload.produto_id, "o produto"),
    p_lot_id: requiredUuid(payload.lote_id, "o lote"),
    p_event_kind: safeText(payload.tipo_evento, 40),
    p_amount: requiredNumber(payload.quantidade, "a quantidade", Number.EPSILON),
    p_unit: safeText(payload.unidade, 30),
    p_reason: safeText(payload.motivo, 500),
    p_evidence_reference: optionalText(payload.referencia_evidencia, 180),
    p_occurred_at: requiredTimestamp(payload.ocorrido_em, "a data do evento"),
    p_idempotency_key: requiredUuid(payload.idempotency_key, "a chave da operação"),
    p_request_id: operationId,
  });
  return response(req, result);
}

async function handleFee(
  req: Request,
  context: DualAuthContext,
  payload: JsonRecord,
): Promise<Response> {
  const attendanceId = requiredUuid(payload.atendimento_id, "o atendimento");
  const operationId = await requestId(
    req,
    context,
    payload,
    "registrar_taxa_pagamento",
    attendanceId,
  );
  const result = await rpc("operacao_registrar_taxa_pagamento", {
    ...baseRpc(context),
    p_attendance_id: attendanceId,
    p_payment_id: requiredUuid(payload.pagamento_id, "o pagamento"),
    p_event_kind: safeText(payload.tipo_evento, 20),
    p_amount: requiredNumber(payload.valor, "o valor", 0),
    p_source_kind: safeText(payload.tipo_fonte, 30),
    p_source_reference: optionalText(payload.referencia_fonte, 180),
    p_reversal_of_id: optionalUuid(payload.estorno_de_id, "a taxa original"),
    p_idempotency_key: requiredUuid(payload.idempotency_key, "a chave da operação"),
    p_request_id: operationId,
  });
  return response(req, result);
}

function photoMetadataRpc(
  context: DualAuthContext,
  attendanceId: string,
  payload: JsonRecord,
  requestId: string,
  reason: string,
): JsonRecord {
  return {
    ...baseRpc(context),
    p_photo_id: requiredUuid(payload.foto_id, "a foto"),
    p_expected_version: requiredInteger(payload.versao, "a versão", 1, 2_000_000_000),
    p_attendance_id: attendanceId,
    p_procedure_item_id: optionalUuid(payload.procedimento_item_id, "o procedimento"),
    p_display_order: optionalInteger(payload.ordem, "a ordem", 1, 2_147_483_647),
    p_caption: optionalText(payload.legenda, 300),
    p_consumption_event_id: optionalUuid(payload.evento_consumo_id, "o consumo"),
    p_reason: reason,
    p_request_id: requestId,
  };
}

async function handlePhotoMetadata(
  req: Request,
  context: DualAuthContext,
  payload: JsonRecord,
): Promise<Response> {
  const attendanceId = requiredUuid(payload.atendimento_id, "o atendimento");
  const photoId = requiredUuid(payload.foto_id, "a foto");
  const operationId = await requestId(
    req,
    context,
    payload,
    "atualizar_foto_atendimento",
    photoId,
  );
  const result = await rpc(
    "operacao_atualizar_foto_atendimento",
    photoMetadataRpc(
      context,
      attendanceId,
      payload,
      operationId,
      safeText(payload.motivo, 500),
    ),
  );
  return response(req, result, {
    marketing_autorizado: false,
    publicacao_automatica: false,
    original_sobrescrito: false,
  });
}

async function handlePhotoMetadataBatch(
  req: Request,
  context: DualAuthContext,
  payload: JsonRecord,
): Promise<Response> {
  const attendanceId = requiredUuid(payload.atendimento_id, "o atendimento");
  if (!Array.isArray(payload.fotos) || payload.fotos.length < 1 || payload.fotos.length > 500) {
    throw new ApiError(
      422,
      "attendance_photo_metadata_invalid",
      "Selecione as fotos deste atendimento.",
    );
  }
  await requireProof(
    req,
    context,
    payload,
    "operacao.vincular_fotos_atendimento",
    attendanceId,
  );
  const reason = safeText(payload.motivo, 500);
  const results: JsonRecord[] = [];
  for (const raw of payload.fotos) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new ApiError(422, "attendance_photo_metadata_invalid", "Revise as fotos selecionadas.");
    }
    const item = raw as JsonRecord;
    const itemRequestId = requiredUuid(item.idempotency_key, "a chave da foto");
    results.push(
      await rpc(
        "operacao_atualizar_foto_atendimento",
        photoMetadataRpc(context, attendanceId, item, itemRequestId, reason),
      ),
    );
  }
  return json(req, {
    ok: true,
    resultados: results,
    marketing_autorizado: false,
    publicacao_automatica: false,
    original_sobrescrito: false,
  });
}

async function parseJsonBody(req: Request): Promise<JsonRecord> {
  const contentLength = Number(req.headers.get("content-length") || 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_JSON_BYTES) {
    throw new ApiError(413, "request_too_large", "Requisição muito grande.");
  }
  const raw = await req.text();
  if (new TextEncoder().encode(raw).length > MAX_JSON_BYTES) {
    throw new ApiError(413, "request_too_large", "Requisição muito grande.");
  }
  try {
    const parsed = JSON.parse(raw || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid");
    return parsed as JsonRecord;
  } catch {
    throw new ApiError(400, "invalid_json", "Dados inválidos.");
  }
}

async function auditFailure(
  context: DualAuthContext,
  code: string,
  outcome: "denied" | "error",
): Promise<void> {
  await writeClinicAudit(AUTH_CONFIG, context, {
    entity: "clinical_operation",
    action: "request",
    outcome,
    details: { endpoint: "operacao-clinica-fichas", reason_code: code },
  });
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin") || "";
  if (req.method === "OPTIONS") {
    if (origin && !ALLOWED_ORIGINS.has(origin)) return new Response(null, { status: 403 });
    return new Response(null, { status: 204, headers: cors(req) });
  }
  if (req.method !== "POST") {
    return json(
      req,
      { ok: false, erro: "Método não permitido", codigo: "method_not_allowed" },
      405,
    );
  }
  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    return json(req, { ok: false, erro: "Origem não permitida", codigo: "origin_forbidden" }, 403);
  }
  if (!URL || !SERVICE) {
    console.error("Clinical operation backend environment is not configured");
    return json(req, {
      ok: false,
      erro: "Acesso temporariamente indisponível",
      codigo: "backend_unavailable",
    }, 503);
  }
  if (!/^Bearer\s+\S+$/i.test((req.headers.get("authorization") || "").trim())) {
    return json(req, {
      ok: false,
      erro: "Entre com sua conta individual.",
      codigo: "individual_auth_required",
    }, 401);
  }

  let context: DualAuthContext;
  try {
    context = await authenticateDual(req, AUTH_CONFIG);
    requestAuth.set(req, context);
    tenant(context);
  } catch (error) {
    if (error instanceof DualAuthError) {
      if (error.auditContext) {
        requestAuth.set(req, error.auditContext);
        await auditFailure(error.auditContext, error.code, "denied");
      }
      return json(req, {
        ok: false,
        erro: error.publicMessage,
        codigo: error.code,
      }, error.status);
    }
    if (error instanceof ApiError) {
      return json(req, {
        ok: false,
        erro: error.publicMessage,
        codigo: error.code,
        existing_id: error.existingId,
      }, error.status);
    }
    console.error("Clinical operation authentication failed");
    return json(req, {
      ok: false,
      erro: "Acesso temporariamente indisponível",
      codigo: "auth_unavailable",
    }, 503);
  }

  try {
    if (!(req.headers.get("content-type") || "").toLowerCase().includes("application/json")) {
      throw new ApiError(415, "invalid_content_type", "Conteúdo inválido.");
    }
    const payload = await parseJsonBody(req);
    if (containsMessagingInstruction(payload)) {
      throw new ApiError(
        422,
        "automatic_messaging_forbidden",
        "Este módulo registra contatos, mas não envia mensagens automaticamente.",
      );
    }
    const action = safeText(payload.acao, 60);
    switch (action) {
      case "listar":
        return await handleList(req, context, payload);
      case "salvar_atendimento":
        return await handleSaveAttendance(req, context, payload);
      case "arquivar_atendimento":
        return await handleArchive(req, context, payload, true);
      case "restaurar_atendimento":
        return await handleArchive(req, context, payload, false);
      case "salvar_procedimento_atendimento":
        return await handleSaveAttendanceProcedure(req, context, payload);
      case "arquivar_procedimento_atendimento":
        return await handleArchiveAttendanceProcedure(req, context, payload, true);
      case "restaurar_procedimento_atendimento":
        return await handleArchiveAttendanceProcedure(req, context, payload, false);
      case "registrar_perfil_paciente":
        return await handleProfile(req, context, payload);
      case "registrar_preferencia_contato":
        return await handlePreference(req, context, payload);
      case "criar_retorno":
        return await handleCreateReturn(req, context, payload);
      case "atualizar_retorno":
        return await handleUpdateReturn(req, context, payload);
      case "registrar_tentativa_retorno":
        return await handleAttempt(req, context, payload);
      case "vincular_retorno_agendamento":
        return await handleLinkAppointment(req, context, payload);
      case "registrar_ficha_custo":
        return await handleCostSheet(req, context, payload);
      case "registrar_evento_consumo":
        return await handleConsumption(req, context, payload);
      case "registrar_taxa_pagamento":
        return await handleFee(req, context, payload);
      case "atualizar_foto_atendimento":
        return await handlePhotoMetadata(req, context, payload);
      case "vincular_fotos_atendimento":
        return await handlePhotoMetadataBatch(req, context, payload);
      default:
        throw new ApiError(422, "invalid_action", "Ação inválida.");
    }
  } catch (error) {
    if (error instanceof DualAuthError) {
      await auditFailure(context, error.code, "denied");
      return json(req, { ok: false, erro: error.publicMessage, codigo: error.code }, error.status);
    }
    if (error instanceof ApiError) {
      await auditFailure(
        context,
        error.code,
        error.status === 401 || error.status === 403 ? "denied" : "error",
      );
      return json(req, {
        ok: false,
        erro: error.publicMessage,
        codigo: error.code,
        existing_id: error.existingId,
      }, error.status);
    }
    console.error("Clinical operation request failed", String(error));
    await auditFailure(context, "unhandled_error", "error");
    return json(req, {
      ok: false,
      erro: "Não foi possível concluir a operação.",
      codigo: "unhandled_error",
    }, 500);
  }
});

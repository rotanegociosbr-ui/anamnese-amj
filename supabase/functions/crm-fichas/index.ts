import "@supabase/functions-js/edge-runtime.d.ts";
import {
  authenticateDual,
  authResponseFields,
  DualAuthConfig,
  DualAuthContext,
  DualAuthError,
  requireRecentPasswordProof,
  writeClinicAudit,
} from "../_shared/dual-auth.ts";

type JsonRecord = Record<string, unknown>;

const SUPABASE_URL = (Deno.env.get("SUPABASE_URL") || "").replace(/\/+$/, "");
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const AUTH_CONFIG: DualAuthConfig = {
  supabaseUrl: SUPABASE_URL,
  serviceRoleKey: SERVICE_ROLE,
  allowedRoles: ["owner"],
  requireAal2: true,
};

const MAX_BODY_BYTES = 64 * 1024;
const MAX_PAGE_SIZE = 200;
const MAX_OFFSET = 100_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const LOCAL_TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;
const OFFSET_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/i;
const SAFE_ACTION = /^[a-z][a-z0-9_]{1,79}$/;
const SAFE_SEARCH = /^[\p{L}\p{N}\s@.+_-]{1,120}$/u;
const STAGES = new Set([
  "novo",
  "primeiro_atendimento",
  "interessada",
  "avaliacao_sugerida",
  "avaliacao_agendada",
  "avaliacao_realizada",
  "plano_apresentado",
  "proposta_enviada",
  "aguardando_decisao",
  "procedimento_agendado",
  "convertida",
  "nao_convertida",
  "reativacao_futura",
]);
const INTERACTION_TYPES = new Set([
  "telefone",
  "whatsapp",
  "email",
  "presencial",
  "nota_interna",
  "outro",
]);
const DIRECTIONS = new Set(["inbound", "outbound", "internal"]);
const CLINICAL_KEYS = new Set([
  "anamnese",
  "diagnostico",
  "condicao_saude",
  "dados_saude",
  "prontuario",
  "consentimento",
  "foto_clinica",
  "procedimento_clinico",
]);

class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly publicMessage: string,
  ) {
    super(publicMessage);
    this.name = "ApiError";
  }
}

interface AdminResult {
  response: Response;
  data: unknown;
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function rows(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function firstRow(value: unknown): JsonRecord | null {
  return rows(value)[0] || (isRecord(value) ? value : null);
}

function pick(payload: JsonRecord, ...keys: string[]): unknown {
  for (const key of keys) if (payload[key] !== undefined) return payload[key];
  return undefined;
}

function validUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function requiredUuid(value: unknown, field: string): string {
  if (!validUuid(value)) throw new ApiError(422, `invalid_${field}`, "Identificador inválido.");
  return value.toLowerCase();
}

function optionalUuid(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  return requiredUuid(value, field);
}

function requiredText(value: unknown, field: string, min: number, max: number): string {
  if (typeof value !== "string") {
    throw new ApiError(422, `invalid_${field}`, `Confira o campo ${field}.`);
  }
  const normalized = value.trim().replace(/\s+/g, " ");
  const unsafe = Array.from(normalized).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 8 || code === 11 || code === 12 || (code >= 14 && code <= 31) || code === 127;
  });
  if (normalized.length < min || normalized.length > max || unsafe) {
    throw new ApiError(422, `invalid_${field}`, `Confira o campo ${field}.`);
  }
  return normalized;
}

function optionalText(value: unknown, field: string, max: number, min = 1): string | null {
  if (value === undefined || value === null || value === "") return null;
  return requiredText(value, field, min, max);
}

function integerValue(
  value: unknown,
  field: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new ApiError(422, `invalid_${field}`, `Confira o campo ${field}.`);
  }
  return parsed;
}

function optionalDate(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !DATE_PATTERN.test(value)) {
    throw new ApiError(422, `invalid_${field}`, `Confira a data ${field}.`);
  }
  const parsed = new Date(`${value}T12:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new ApiError(422, `invalid_${field}`, `Confira a data ${field}.`);
  }
  return value;
}

function clinicParts(value: Date): Record<string, number> {
  const parts: Record<string, number> = {};
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(value).forEach((part) => {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  });
  return parts;
}

export function clinicTimestampToIso(value: string): string {
  const normalized = value.trim();
  const local = LOCAL_TIMESTAMP_PATTERN.exec(normalized);
  if (!local) {
    if (!OFFSET_TIMESTAMP_PATTERN.test(normalized)) throw new Error("timezone required");
    const explicit = new Date(normalized);
    if (!Number.isFinite(explicit.getTime())) throw new Error("invalid timestamp");
    return explicit.toISOString();
  }
  const wanted = [
    Number(local[1]),
    Number(local[2]),
    Number(local[3]),
    Number(local[4]),
    Number(local[5]),
    Number(local[6] || "0"),
  ];
  let guess = Date.UTC(wanted[0], wanted[1] - 1, wanted[2], wanted[3] + 3, wanted[4], wanted[5]);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = clinicParts(new Date(guess));
    const represented = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
    );
    const desired = Date.UTC(wanted[0], wanted[1] - 1, wanted[2], wanted[3], wanted[4], wanted[5]);
    guess += desired - represented;
  }
  const final = clinicParts(new Date(guess));
  const actual = [final.year, final.month, final.day, final.hour, final.minute, final.second];
  if (actual.some((part, index) => part !== wanted[index])) {
    throw new Error("invalid local timestamp");
  }
  return new Date(guess).toISOString();
}

function optionalTimestamp(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > 40) {
    throw new ApiError(422, `invalid_${field}`, `Confira a data e hora ${field}.`);
  }
  try {
    return clinicTimestampToIso(value);
  } catch {
    throw new ApiError(422, `invalid_${field}`, `Confira a data e hora ${field}.`);
  }
}

export function normalizePhone(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new ApiError(422, "invalid_telefone", "Confira o telefone.");
  let digits = value.replace(/[^0-9]+/g, "");
  if (digits.length === 10 || digits.length === 11) digits = `55${digits}`;
  if (
    (digits.length !== 12 && digits.length !== 13) || !digits.startsWith("55") || digits[2] === "0"
  ) {
    throw new ApiError(422, "invalid_telefone", "Confira o telefone com DDD.");
  }
  return `+${digits}`;
}

function normalizeEmail(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  const email = requiredText(value, "email", 3, 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new ApiError(422, "invalid_email", "Confira o e-mail.");
  }
  return email;
}

function normalizeCpf(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new ApiError(422, "invalid_cpf", "Confira o CPF.");
  const cpf = value.replace(/[^0-9]+/g, "");
  if (cpf.length !== 11) throw new ApiError(422, "invalid_cpf", "Confira o CPF.");
  return cpf;
}

export function stageToDatabase(value: unknown): string {
  const stage = requiredText(value ?? "novo", "estagio", 3, 40).toLowerCase();
  const normalized = stage === "lead_novo" ? "novo" : stage;
  if (!STAGES.has(normalized)) throw new ApiError(422, "invalid_estagio", "Etapa inválida.");
  return normalized;
}

export function stageToApi(value: unknown, status?: unknown): string {
  if (status === "archived" || status === "cancelled") return "arquivada";
  return value === "novo" ? "lead_novo" : String(value || "");
}

export function normalizeSearch(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new ApiError(422, "invalid_busca", "Confira a busca.");
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!SAFE_SEARCH.test(normalized)) {
    throw new ApiError(422, "invalid_busca", "Use uma busca curta, sem operadores especiais.");
  }
  return normalized;
}

function enumValue(value: unknown, field: string, allowed: Set<string>): string {
  const normalized = requiredText(value, field, 2, 80).toLowerCase();
  if (!allowed.has(normalized)) throw new ApiError(422, `invalid_${field}`, `Confira ${field}.`);
  return normalized;
}

function assertNoClinicalFields(payload: JsonRecord): void {
  for (const key of Object.keys(payload)) {
    if (CLINICAL_KEYS.has(key.toLowerCase())) {
      throw new ApiError(422, "clinical_data_forbidden", "Dados clínicos pertencem ao prontuário.");
    }
  }
}

export function normalizeLeadPayload(payload: JsonRecord): JsonRecord {
  assertNoClinicalFields(payload);
  const stage = stageToDatabase(pick(payload, "estagio", "stage_code") ?? "novo");
  if (stage === "convertida") {
    throw new ApiError(422, "conversion_route_required", "Use a conversão protegida.");
  }
  const phone = normalizePhone(pick(payload, "telefone", "phone"));
  const email = normalizeEmail(payload.email);
  if (!phone && !email) throw new ApiError(422, "contact_required", "Informe telefone ou e-mail.");
  const nextActionAt = optionalTimestamp(
    pick(payload, "proxima_acao_em", "next_action_at"),
    "proxima_acao_em",
  );
  const lossReason = optionalText(
    pick(payload, "motivo_perda", "loss_reason"),
    "motivo_perda",
    500,
    3,
  );
  if (stage === "nao_convertida") {
    if (!lossReason) {
      throw new ApiError(422, "loss_reason_required", "Informe o motivo da não conversão.");
    }
    if (nextActionAt) {
      throw new ApiError(
        422,
        "closed_stage_next_action",
        "Etapa encerrada não recebe próxima ação.",
      );
    }
  } else if (!nextActionAt) {
    throw new ApiError(422, "next_action_required", "Defina a próxima ação.");
  }
  return {
    full_name: requiredText(pick(payload, "nome", "full_name"), "nome", 2, 160),
    birth_date: optionalDate(pick(payload, "data_nascimento", "birth_date"), "data_nascimento"),
    cpf: normalizeCpf(payload.cpf),
    phone,
    email,
    source: requiredText(pick(payload, "origem", "source"), "origem", 2, 80),
    subsource: optionalText(pick(payload, "suborigem", "subsource"), "suborigem", 120),
    campaign_id: optionalUuid(pick(payload, "campanha_id", "campaign_id"), "campanha_id"),
    interest: requiredText(pick(payload, "interesse", "interest"), "interesse", 1, 160),
    responsible_user_id: requiredUuid(
      pick(payload, "responsavel_id", "responsible_user_id"),
      "responsavel_id",
    ),
    stage_code: stage,
    first_response_at: optionalTimestamp(
      pick(payload, "primeira_resposta_em", "first_response_at"),
      "primeira_resposta_em",
    ),
    next_action_type: nextActionAt
      ? optionalText(
        pick(payload, "proxima_acao_tipo", "next_action_type"),
        "proxima_acao_tipo",
        40,
      ) || "contato"
      : null,
    next_action_at: nextActionAt,
    loss_reason: stage === "nao_convertida" ? lossReason : null,
    commercial_notes: optionalText(
      pick(payload, "observacoes", "commercial_notes"),
      "observacoes",
      2000,
    ),
  };
}

export function corsOriginAllowed(origin: string | null): boolean {
  if (origin === null) return true;
  if (origin === "https://anamariajacob.com.br" || origin === "https://www.anamariajacob.com.br") {
    return true;
  }
  const local = /^http:\/\/(localhost|127\.0\.0\.1)(?::(\d{1,5}))?$/.exec(origin);
  return Boolean(local && (!local[2] || Number(local[2]) <= 65_535));
}

function responseHeaders(req: Request, jsonContent = true): Headers {
  const headers = new Headers({
    "Cache-Control": "no-store, max-age=0",
    "Pragma": "no-cache",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Resource-Policy": "same-site",
    "Vary": "Origin",
  });
  if (jsonContent) headers.set("Content-Type", "application/json; charset=utf-8");
  const origin = req.headers.get("origin");
  if (origin && corsOriginAllowed(origin)) headers.set("Access-Control-Allow-Origin", origin);
  return headers;
}

function json(req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: responseHeaders(req) });
}

function fail(req: Request, message: string, status: number, code: string): Response {
  return json(req, { erro: message, codigo: code }, status);
}

function success(req: Request, context: DualAuthContext, body: JsonRecord, status = 200): Response {
  return json(req, { ...authResponseFields(context), ...body }, status);
}

async function readJsonBody(req: Request): Promise<JsonRecord> {
  const contentType = (req.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new ApiError(415, "content_type_required", "Envie os dados em JSON.");
  }
  const declared = Number(req.headers.get("content-length") || "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new ApiError(413, "body_too_large", "A solicitação é muito grande.");
  }
  const reader = req.body?.getReader();
  if (!reader) throw new ApiError(400, "empty_body", "Envie os dados da solicitação.");
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new ApiError(413, "body_too_large", "A solicitação é muito grande.");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!isRecord(parsed)) throw new Error("object required");
    return parsed;
  } catch {
    throw new ApiError(400, "invalid_json", "JSON inválido.");
  }
}

export function tenantFromContext(context: DualAuthContext): { clinicId: string; userId: string } {
  if (
    context.authMethod !== "supabase_auth" || context.role !== "owner" || context.aal !== "aal2" ||
    !validUuid(context.clinicId) || !validUuid(context.userId)
  ) {
    throw new ApiError(403, "owner_mfa_required", "Use uma conta proprietária individual com MFA.");
  }
  return { clinicId: context.clinicId, userId: context.userId };
}

async function admin(path: string, method = "GET", body?: JsonRecord): Promise<AdminResult> {
  if (!SUPABASE_URL || !SERVICE_ROLE) {
    throw new ApiError(503, "backend_unavailable", "Backend temporariamente indisponível.");
  }
  let response: Response;
  try {
    response = await fetch(`${SUPABASE_URL}${path}`, {
      method,
      headers: {
        apikey: SERVICE_ROLE,
        Authorization: `Bearer ${SERVICE_ROLE}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(method === "GET" ? { Prefer: "count=exact" } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(12_000),
    });
  } catch {
    throw new ApiError(503, "database_unavailable", "Banco temporariamente indisponível.");
  }
  let data: unknown = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  return { response, data };
}

function databaseMessage(result: AdminResult): string {
  if (!isRecord(result.data)) return "";
  return [result.data.message, result.data.details, result.data.hint]
    .filter((value) => typeof value === "string").join(" ").toLowerCase();
}

function mapDatabaseError(result: AdminResult): never {
  const message = databaseMessage(result);
  const mappings: Array<[string, number, string, string]> = [
    ["crm_owner_required", 403, "owner_required", "Somente a proprietária pode usar o CRM."],
    ["crm_lead_not_found", 404, "lead_not_found", "Lead não encontrado."],
    ["crm_patient_not_found", 404, "patient_not_found", "Paciente não encontrada."],
    [
      "crm_version_conflict",
      409,
      "version_conflict",
      "O lead mudou em outro acesso. Recarregue e tente novamente.",
    ],
    [
      "crm_idempotency_key_reused",
      409,
      "idempotency_key_reused",
      "Use uma nova chave para dados diferentes.",
    ],
    [
      "crm_exact_duplicate_lead",
      409,
      "exact_duplicate_lead",
      "Já existe um lead com a mesma identificação exata.",
    ],
    [
      "exact_duplicate",
      409,
      "exact_duplicate_patient",
      "Já existe uma paciente com a mesma identificação exata.",
    ],
    [
      "crm_exact_patient_conflict",
      409,
      "exact_patient_conflict",
      "Há uma correspondência exata diferente; revise antes de vincular.",
    ],
    [
      "crm_patient_not_candidate",
      409,
      "patient_not_candidate",
      "O cadastro escolhido não corresponde aos candidatos seguros.",
    ],
    [
      "crm_lead_already_linked",
      409,
      "lead_already_linked",
      "Este lead já está vinculado a outra paciente.",
    ],
    [
      "crm_lead_immutable",
      409,
      "lead_immutable",
      "Este lead está encerrado e não pode ser alterado.",
    ],
    ["crm_loss_reason_required", 422, "loss_reason_required", "Informe o motivo da não conversão."],
    ["crm_next_action_required", 422, "next_action_required", "Defina a próxima ação."],
    [
      "crm_first_response_in_future",
      422,
      "first_response_in_future",
      "A primeira resposta não pode estar no futuro.",
    ],
    [
      "crm_possible_distinct_decision_not_persisted",
      409,
      "possible_distinct_decision_not_persisted",
      "A decisão de cadastro distinto não foi persistida. Tente novamente.",
    ],
    [
      "crm_reanalysis_required",
      409,
      "reanalysis_required",
      "Os candidatos mudaram. Revise novamente antes de confirmar.",
    ],
    [
      "crm_candidate_set_too_large",
      409,
      "candidate_set_too_large",
      "Há muitos candidatos. Refine os dados antes de confirmar.",
    ],
    [
      "crm_possible_distinct_confirmation_invalid",
      422,
      "possible_distinct_confirmation_invalid",
      "A confirmação de cadastro distinto não corresponde aos candidatos atuais.",
    ],
    [
      "crm_responsible_invalid",
      422,
      "responsible_invalid",
      "Escolha uma pessoa responsável ativa.",
    ],
    [
      "crm_possible_distinct_reason_required",
      422,
      "possible_distinct_reason_required",
      "Justifique por que os cadastros são distintos.",
    ],
    [
      "site_booking_review_required",
      409,
      "site_booking_review_required",
      "Existe contato com o mesmo telefone e identidade diferente. Revise manualmente sem mesclar.",
    ],
    [
      "site_booking_not_found",
      404,
      "site_booking_not_found",
      "Solicitação do site não encontrada.",
    ],
    [
      "site_booking_version_conflict",
      409,
      "site_booking_version_conflict",
      "A solicitação mudou em outro acesso. Recarregue e tente novamente.",
    ],
    [
      "site_booking_already_handled",
      409,
      "site_booking_already_handled",
      "Esta solicitação já foi tratada.",
    ],
    [
      "site_booking_idempotency_conflict",
      409,
      "site_booking_idempotency_conflict",
      "Use uma nova chave para uma decisão diferente.",
    ],
    [
      "site_booking_invalid_",
      422,
      "site_booking_invalid_request",
      "Confira os dados da solicitação.",
    ],
  ];
  for (const [needle, status, code, publicMessage] of mappings) {
    if (message.includes(needle)) throw new ApiError(status, code, publicMessage);
  }
  if (result.response.status === 409 || message.includes("duplicate key")) {
    throw new ApiError(409, "conflict", "A operação conflita com um registro existente.");
  }
  if (result.response.status >= 500) {
    throw new ApiError(503, "database_unavailable", "Banco temporariamente indisponível.");
  }
  throw new ApiError(422, "crm_operation_failed", "Não foi possível concluir a operação.");
}

async function rpc(
  name:
    | "marketing_crm_salvar_lead"
    | "marketing_crm_campaign_options"
    | "crm_analisar_conversao"
    | "crm_converter_lead"
    | "crm_site_booking_list"
    | "crm_site_booking_accept"
    | "crm_site_booking_archive",
  body: JsonRecord,
): Promise<JsonRecord> {
  const result = await admin(`/rest/v1/rpc/${name}`, "POST", body);
  if (!result.response.ok) mapDatabaseError(result);
  const row = firstRow(result.data);
  if (!row) throw new ApiError(502, "invalid_backend_response", "Resposta inválida do backend.");
  return row;
}

async function selectRows(table: string, params: URLSearchParams): Promise<JsonRecord[]> {
  const result = await admin(`/rest/v1/${table}?${params.toString()}`);
  if (!result.response.ok) mapDatabaseError(result);
  return rows(result.data);
}

export function totalFromContentRange(value: string | null): number {
  const match = /\/(\d+)$/.exec(value || "");
  if (!match) throw new ApiError(502, "invalid_backend_count", "Contagem inválida do backend.");
  return Number(match[1]);
}

async function countRows(table: string, params: URLSearchParams): Promise<number> {
  const result = await admin(`/rest/v1/${table}?${params.toString()}`);
  if (!result.response.ok) mapDatabaseError(result);
  return totalFromContentRange(result.response.headers.get("content-range"));
}

export function leadDto(
  row: JsonRecord,
  ownerName = "Responsável ativa",
  history: JsonRecord[] = [],
): JsonRecord {
  const status = String(row.record_status || "");
  const stage = stageToApi(row.stage_code, status);
  return {
    id: row.id,
    lead_id: row.id,
    nome: row.full_name,
    full_name: row.full_name,
    telefone: row.phone,
    phone: row.phone,
    email: row.email,
    origem: row.source,
    source: row.source,
    suborigem: row.subsource,
    campanha: row.campaign,
    campanha_id: row.campaign_id,
    campaign_id: row.campaign_id,
    interesse: row.interest,
    responsavel_id: row.responsible_user_id,
    owner_id: row.responsible_user_id,
    responsavel_nome: ownerName,
    estagio: stage,
    stage,
    stage_code: row.stage_code,
    record_status: status,
    primeira_resposta_em: row.first_response_at,
    first_response_at: row.first_response_at,
    proxima_acao_em: row.next_action_at,
    next_action_at: row.next_action_at,
    proxima_acao_tipo: row.next_action_type,
    motivo_perda: row.loss_reason,
    observacoes: row.commercial_notes,
    patient_id: row.patient_id,
    convertido_em: row.converted_at,
    arquivado: status === "archived" || status === "cancelled",
    archived: status === "archived" || status === "cancelled",
    version: row.version,
    criado_em: row.created_at,
    atualizado_em: row.updated_at,
    historico: history,
  };
}

function siteRequestDto(row: JsonRecord): JsonRecord | null {
  const id = typeof row.id === "string" && validUuid(row.id) ? row.id : null;
  const version = Number(row.versao ?? row.version);
  if (!id || !Number.isInteger(version) || version < 1) return null;
  return {
    id,
    solicitacao_id: id,
    nome: typeof row.nome === "string" ? row.nome : "",
    telefone: typeof row.telefone === "string" ? row.telefone : "",
    primeira_visita: typeof row.primeira_visita === "string" ? row.primeira_visita : "",
    interesse: typeof row.interesse === "string" ? row.interesse : "",
    data_preferida: typeof row.data_preferida === "string" ? row.data_preferida : null,
    periodo: typeof row.periodo === "string" ? row.periodo : "",
    consentimento_contato: row.consentimento_contato === true,
    consentimento_versao: typeof row.consentimento_versao === "string"
      ? row.consentimento_versao
      : null,
    status: typeof row.status === "string" ? row.status : "pending",
    lead_id: typeof row.lead_id === "string" && validUuid(row.lead_id) ? row.lead_id : null,
    decisao: typeof row.decisao === "string" ? row.decisao : null,
    versao: version,
    version,
    recebido_em: typeof row.recebido_em === "string"
      ? row.recebido_em
      : typeof row.created_at === "string"
      ? row.created_at
      : null,
    atualizado_em: typeof row.atualizado_em === "string" ? row.atualizado_em : null,
    tratado_em: typeof row.tratado_em === "string" ? row.tratado_em : null,
  };
}

async function listSiteRequests(
  clinicId: string,
  userId: string,
  status = "pending",
  limit = 100,
  offset = 0,
): Promise<{ items: JsonRecord[]; pending: number; total: number; hasMore: boolean }> {
  const result = await rpc("crm_site_booking_list", {
    p_clinic_id: clinicId,
    p_actor_id: userId,
    p_status: status,
    p_limit: limit,
    p_offset: offset,
  });
  const items = rows(result.solicitacoes_site).map(siteRequestDto).filter(
    (item): item is JsonRecord => item !== null,
  );
  const pending = Number(result.pendentes);
  const total = Number(result.total);
  return {
    items,
    pending: Number.isInteger(pending) && pending >= 0 ? pending : 0,
    total: Number.isInteger(total) && total >= 0 ? total : items.length,
    hasMore: result.has_more === true,
  };
}

function historyEvent(row: JsonRecord, kind: "stage" | "interaction"): JsonRecord {
  if (kind === "stage") {
    return {
      id: row.id,
      tipo: "mudanca_etapa",
      descricao: row.from_stage_code
        ? `Etapa alterada para ${stageToApi(row.to_stage_code)}`
        : `Lead criado em ${stageToApi(row.to_stage_code)}`,
      etapa_anterior: row.from_stage_code ? stageToApi(row.from_stage_code) : null,
      etapa_nova: stageToApi(row.to_stage_code),
      motivo: row.reason,
      versao: row.resulting_version,
      criado_em: row.changed_at,
      created_at: row.changed_at,
    };
  }
  return {
    id: row.id,
    tipo: "interacao",
    descricao: row.commercial_summary,
    canal: row.interaction_type,
    direcao: row.direction,
    resultado: row.outcome,
    versao: row.resulting_version,
    criado_em: row.occurred_at,
    created_at: row.occurred_at,
  };
}

async function ownersForClinic(
  clinicId: string,
): Promise<{ rows: JsonRecord[]; names: Map<string, string> }> {
  const params = new URLSearchParams({
    select: "user_id,display_name,role,status",
    clinic_id: `eq.${clinicId}`,
    status: "eq.active",
    order: "display_name.asc,user_id.asc",
  });
  const members = await selectRows("clinic_members", params);
  const names = new Map<string, string>();
  const ownerRows = members.map((member) => {
    const id = String(member.user_id || "");
    const name = String(member.display_name || "Responsável ativa");
    names.set(id, name);
    return { id, user_id: id, nome: name, name, role: member.role };
  });
  return { rows: ownerRows, names };
}

async function historiesForLeads(
  clinicId: string,
  leadIds: string[],
): Promise<Map<string, JsonRecord[]>> {
  const result = new Map<string, JsonRecord[]>();
  if (!leadIds.length) return result;
  const list = `in.(${leadIds.join(",")})`;
  const stageParams = new URLSearchParams({
    select: "id,lead_id,from_stage_code,to_stage_code,reason,resulting_version,changed_at",
    clinic_id: `eq.${clinicId}`,
    lead_id: list,
    order: "changed_at.desc,id.desc",
  });
  const interactionParams = new URLSearchParams({
    select:
      "id,lead_id,interaction_type,direction,outcome,commercial_summary,occurred_at,resulting_version",
    clinic_id: `eq.${clinicId}`,
    lead_id: list,
    order: "occurred_at.desc,id.desc",
  });
  const [stageRows, interactionRows] = await Promise.all([
    selectRows("crm_lead_stage_history", stageParams),
    selectRows("crm_interactions", interactionParams),
  ]);
  for (const row of stageRows) {
    const id = String(row.lead_id || "");
    if (!result.has(id)) result.set(id, []);
    result.get(id)?.push(historyEvent(row, "stage"));
  }
  for (const row of interactionRows) {
    const id = String(row.lead_id || "");
    if (!result.has(id)) result.set(id, []);
    result.get(id)?.push(historyEvent(row, "interaction"));
  }
  for (const events of result.values()) {
    events.sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
  }
  return result;
}

async function handleList(
  req: Request,
  context: DualAuthContext,
  payload: JsonRecord,
): Promise<Response> {
  const { clinicId, userId } = tenantFromContext(context);
  const limit = integerValue(payload.limit, "limit", 100, 1, MAX_PAGE_SIZE);
  const offset = integerValue(payload.offset, "offset", 0, 0, MAX_OFFSET);
  const params = new URLSearchParams({
    select:
      "id,full_name,phone,email,stage_code,source,subsource,campaign,campaign_id,interest,responsible_user_id,first_response_at,next_action_type,next_action_at,loss_reason,commercial_notes,record_status,patient_id,converted_at,version,created_at,updated_at",
    clinic_id: `eq.${clinicId}`,
    order: "next_action_at.asc.nullslast,updated_at.desc,id.asc",
    limit: String(limit),
    offset: String(offset),
  });
  if (payload.incluir_arquivados !== true) {
    params.set("record_status", "not.in.(archived,cancelled)");
  }
  const stageRaw = optionalText(pick(payload, "estagio", "stage_code"), "estagio", 40);
  if (stageRaw === "arquivada") {
    params.set("record_status", "in.(archived,cancelled)");
  } else if (stageRaw) {
    params.set("stage_code", `eq.${stageToDatabase(stageRaw)}`);
  }
  const status = optionalText(payload.status, "status", 20);
  if (status) params.set("record_status", `eq.${status.toLowerCase()}`);
  const origin = optionalText(pick(payload, "origem", "source"), "origem", 80);
  if (origin) params.set("source", `eq.${origin}`);
  const responsible = optionalUuid(
    pick(payload, "responsavel_id", "responsible_user_id"),
    "responsavel_id",
  );
  if (responsible) params.set("responsible_user_id", `eq.${responsible}`);
  const campaign = optionalText(pick(payload, "campanha", "campaign"), "campanha", 160);
  if (campaign) params.set("campaign", `eq.${campaign}`);
  const interest = optionalText(pick(payload, "interesse", "interest"), "interesse", 160);
  if (interest) params.set("interest", `eq.${interest}`);
  if (payload.sem_primeira_resposta === true) params.set("first_response_at", "is.null");
  const nextFrom = optionalTimestamp(payload.proxima_acao_de, "proxima_acao_de");
  const nextTo = optionalTimestamp(payload.proxima_acao_ate, "proxima_acao_ate");
  if (nextFrom) params.append("next_action_at", `gte.${nextFrom}`);
  if (nextTo) params.append("next_action_at", `lte.${nextTo}`);
  const search = normalizeSearch(pick(payload, "busca", "search"));
  if (search) {
    params.set(
      "or",
      `(full_name.ilike.*${search}*,phone.ilike.*${search}*,email.ilike.*${search}*,campaign.ilike.*${search}*,interest.ilike.*${search}*)`,
    );
  }

  // A contagem usa exatamente os mesmos filtros da página. Apenas projeção,
  // ordenação e janela são removidas para que nenhum lead fique invisível.
  const totalParams = new URLSearchParams(params);
  totalParams.set("select", "id");
  totalParams.delete("order");
  totalParams.delete("offset");
  totalParams.set("limit", "1");

  const conversionCountParams = new URLSearchParams({
    select: "id",
    clinic_id: `eq.${clinicId}`,
    stage_code: "eq.convertida",
    converted_at: "not.is.null",
    limit: "1",
  });
  const [leadRows, owners, convertedCount, total, siteInbox] = await Promise.all([
    selectRows("crm_leads", params),
    ownersForClinic(clinicId),
    countRows("crm_leads", conversionCountParams),
    countRows("crm_leads", totalParams),
    listSiteRequests(clinicId, userId, "pending", 100, 0),
  ]);
  const currentCampaignIds = Array.from(
    new Set(
      leadRows.map((lead) => String(lead.campaign_id || "")).filter(validUuid),
    ),
  );
  const campaignOptions = await rpc("marketing_crm_campaign_options", {
    p_clinic_id: clinicId,
    p_actor_id: userId,
    p_current_ids: currentCampaignIds,
  });
  const campaignRows = Array.isArray(campaignOptions.campanhas_ativas)
    ? campaignOptions.campanhas_ativas.filter(isRecord)
    : [];
  const history = await historiesForLeads(
    clinicId,
    leadRows.map((lead) => String(lead.id)).filter((id) => validUuid(id)),
  );
  const leads = leadRows.map((lead) =>
    leadDto(
      lead,
      owners.names.get(String(lead.responsible_user_id || "")) || "Responsável ativa",
      history.get(String(lead.id)) || [],
    )
  );
  const summary = {
    total: leads.length,
    abertos: leadRows.filter((lead) => lead.record_status === "active").length,
    convertidos: convertedCount,
    vencidos:
      leadRows.filter((lead) =>
        lead.record_status === "active" && typeof lead.next_action_at === "string" &&
        new Date(lead.next_action_at).getTime() < Date.now()
      ).length,
    sem_primeira_resposta:
      leadRows.filter((lead) => lead.record_status === "active" && !lead.first_response_at).length,
    solicitacoes_site_pendentes: siteInbox.pending,
  };
  return success(req, context, {
    leads,
    solicitacoes_site: siteInbox.items,
    responsaveis: owners.rows,
    campanhas_ativas: campaignRows.map((row) => ({
      id: row.id,
      nome: row.nome,
      codigo: row.codigo,
      canal: row.canal,
      status: row.status,
      selecionavel: row.selecionavel === true,
      historica: row.historica === true,
    })),
    resumo: summary,
    paginacao: {
      total,
      limit,
      offset,
      has_more: offset + leads.length < total,
    },
    paginacao_solicitacoes_site: {
      total: siteInbox.total,
      limit: 100,
      offset: 0,
      has_more: siteInbox.hasMore,
    },
  });
}

function expectedVersion(value: unknown, creating = false): number {
  if (creating && (value === undefined || value === null || value === "")) return 0;
  return integerValue(
    value,
    "expected_version",
    creating ? 0 : -1,
    creating ? 0 : 1,
    2_147_483_647,
  );
}

async function handleSiteRequestList(
  req: Request,
  context: DualAuthContext,
  payload: JsonRecord,
): Promise<Response> {
  const { clinicId, userId } = tenantFromContext(context);
  const status = optionalText(payload.status, "status", 20) || "pending";
  if (!["pending", "accepted", "archived", "all"].includes(status.toLowerCase())) {
    throw new ApiError(422, "invalid_status", "Status inválido.");
  }
  const limit = integerValue(payload.limit, "limit", 100, 1, MAX_PAGE_SIZE);
  const offset = integerValue(payload.offset, "offset", 0, 0, MAX_OFFSET);
  const result = await listSiteRequests(clinicId, userId, status.toLowerCase(), limit, offset);
  return success(req, context, {
    solicitacoes_site: result.items,
    resumo: { solicitacoes_site_pendentes: result.pending },
    paginacao: {
      total: result.total,
      limit,
      offset,
      has_more: result.hasMore,
    },
  });
}

async function handleSiteRequestAccept(
  req: Request,
  context: DualAuthContext,
  envelope: JsonRecord,
  payload: JsonRecord,
): Promise<Response> {
  const { clinicId, userId } = tenantFromContext(context);
  const siteRequestId = requiredUuid(
    pick(payload, "solicitacao_id", "site_request_id", "request_id", "id"),
    "solicitacao_id",
  );
  const nextActionAt = optionalTimestamp(
    pick(payload, "proxima_acao_em", "next_action_at"),
    "proxima_acao_em",
  ) || new Date().toISOString();
  const result = await rpc("crm_site_booking_accept", {
    p_clinic_id: clinicId,
    p_actor_id: userId,
    p_site_request_id: siteRequestId,
    p_expected_version: expectedVersion(envelope.expected_version),
    // O owner autenticado é também o responsável inicial; não há ator técnico.
    p_responsible_user_id: userId,
    p_next_action_at: nextActionAt,
    p_idempotency_key: requiredUuid(envelope.idempotency_key, "idempotency_key"),
    p_operation_request_id: context.requestId,
  });
  return success(req, context, {
    solicitacao_id: result.solicitacao_id,
    status: result.status,
    lead_id: result.lead_id,
    lead_version: result.lead_version,
    decisao: result.decisao,
    versao: result.versao,
    version: result.versao,
    idempotente: result.idempotent === true,
  }, result.idempotent === true ? 200 : 201);
}

async function handleSiteRequestArchive(
  req: Request,
  context: DualAuthContext,
  envelope: JsonRecord,
  payload: JsonRecord,
): Promise<Response> {
  const { clinicId, userId } = tenantFromContext(context);
  const siteRequestId = requiredUuid(
    pick(payload, "solicitacao_id", "site_request_id", "request_id", "id"),
    "solicitacao_id",
  );
  const reason = requiredText(pick(payload, "motivo", "reason"), "motivo", 3, 500);
  await requireProtected(req, context, payload, "archive_site_request", siteRequestId);
  const result = await rpc("crm_site_booking_archive", {
    p_clinic_id: clinicId,
    p_actor_id: userId,
    p_site_request_id: siteRequestId,
    p_expected_version: expectedVersion(envelope.expected_version),
    p_reason: reason,
    p_idempotency_key: requiredUuid(envelope.idempotency_key, "idempotency_key"),
    p_operation_request_id: context.requestId,
  });
  return success(req, context, {
    solicitacao_id: result.solicitacao_id,
    status: result.status,
    decisao: result.decisao,
    versao: result.versao,
    version: result.versao,
    idempotente: result.idempotent === true,
  });
}

async function handleSave(
  req: Request,
  context: DualAuthContext,
  envelope: JsonRecord,
  payload: JsonRecord,
): Promise<Response> {
  const { clinicId, userId } = tenantFromContext(context);
  const leadId = optionalUuid(pick(payload, "lead_id", "id"), "lead_id");
  const creating = !leadId;
  const normalized = normalizeLeadPayload(payload);
  const result = await rpc("marketing_crm_salvar_lead", {
    p_action: creating ? "create" : "update",
    p_clinic_id: clinicId,
    p_actor_id: userId,
    p_lead_id: leadId,
    p_expected_version: expectedVersion(envelope.expected_version, creating),
    p_idempotency_key: requiredUuid(envelope.idempotency_key, "idempotency_key"),
    p_request_id: context.requestId,
    p_payload: normalized,
  });
  return success(req, context, {
    lead_id: result.lead_id,
    version: result.version,
    estagio: stageToApi(result.stage_code, result.status),
    record_status: result.status,
    idempotente: result.idempotent === true,
  }, creating && result.idempotent !== true ? 201 : 200);
}

async function requireProtected(
  req: Request,
  context: DualAuthContext,
  payload: JsonRecord,
  action: string,
  targetId: string,
): Promise<void> {
  const operationId = requiredUuid(payload.operation_id, "operation_id");
  try {
    await requireRecentPasswordProof(req, AUTH_CONFIG, context, {
      operationId,
      action: `crm.${action}`,
      targetId,
    });
  } catch (error) {
    if (error instanceof DualAuthError) {
      if (error.auditContext) {
        await writeClinicAudit(AUTH_CONFIG, error.auditContext, {
          entity: "crm_protected_operation",
          action: "reauthenticate",
          outcome: "denied",
          details: { endpoint: "crm-fichas", reason_code: error.code },
        });
      }
      throw new ApiError(error.status, error.code, error.publicMessage);
    }
    throw new ApiError(
      503,
      "reauthentication_unavailable",
      "Não foi possível confirmar sua senha agora.",
    );
  }
}

async function handleStateChange(
  req: Request,
  context: DualAuthContext,
  envelope: JsonRecord,
  payload: JsonRecord,
  action: "archive" | "cancel",
): Promise<Response> {
  const { clinicId, userId } = tenantFromContext(context);
  const leadId = requiredUuid(pick(payload, "lead_id", "id"), "lead_id");
  await requireProtected(req, context, payload, action, leadId);
  const result = await rpc("marketing_crm_salvar_lead", {
    p_action: action,
    p_clinic_id: clinicId,
    p_actor_id: userId,
    p_lead_id: leadId,
    p_expected_version: expectedVersion(envelope.expected_version),
    p_idempotency_key: requiredUuid(envelope.idempotency_key, "idempotency_key"),
    p_request_id: context.requestId,
    p_payload: { reason: requiredText(pick(payload, "motivo", "reason"), "motivo", 3, 500) },
  });
  return success(req, context, {
    lead_id: result.lead_id,
    version: result.version,
    record_status: result.status,
    arquivado: action === "archive",
    cancelado: action === "cancel",
    idempotente: result.idempotent === true,
  });
}

async function handleStageChange(
  req: Request,
  context: DualAuthContext,
  envelope: JsonRecord,
  payload: JsonRecord,
): Promise<Response> {
  const { clinicId, userId } = tenantFromContext(context);
  const leadId = requiredUuid(pick(payload, "lead_id", "id"), "lead_id");
  const stage = stageToDatabase(pick(payload, "estagio", "stage_code"));
  if (stage === "convertida") {
    throw new ApiError(422, "conversion_route_required", "Use a conversão protegida.");
  }
  const nextAt = optionalTimestamp(
    pick(payload, "proxima_acao_em", "next_action_at"),
    "proxima_acao_em",
  );
  const result = await rpc("marketing_crm_salvar_lead", {
    p_action: "change_stage",
    p_clinic_id: clinicId,
    p_actor_id: userId,
    p_lead_id: leadId,
    p_expected_version: expectedVersion(envelope.expected_version),
    p_idempotency_key: requiredUuid(envelope.idempotency_key, "idempotency_key"),
    p_request_id: context.requestId,
    p_payload: {
      stage_code: stage,
      reason: optionalText(pick(payload, "motivo", "motivo_perda", "reason"), "motivo", 500, 3),
      next_action_type: nextAt
        ? optionalText(
          pick(payload, "proxima_acao_tipo", "next_action_type"),
          "proxima_acao_tipo",
          40,
        ) || "contato"
        : null,
      next_action_at: nextAt,
    },
  });
  return success(req, context, {
    lead_id: result.lead_id,
    version: result.version,
    estagio: stageToApi(result.stage_code, result.status),
    record_status: result.status,
    idempotente: result.idempotent === true,
  });
}

async function handleInteraction(
  req: Request,
  context: DualAuthContext,
  envelope: JsonRecord,
  payload: JsonRecord,
): Promise<Response> {
  assertNoClinicalFields(payload);
  const { clinicId, userId } = tenantFromContext(context);
  const leadId = requiredUuid(pick(payload, "lead_id", "id"), "lead_id");
  const nextAt = optionalTimestamp(
    pick(payload, "proxima_acao_em", "next_action_at"),
    "proxima_acao_em",
  );
  const result = await rpc("marketing_crm_salvar_lead", {
    p_action: "add_interaction",
    p_clinic_id: clinicId,
    p_actor_id: userId,
    p_lead_id: leadId,
    p_expected_version: expectedVersion(envelope.expected_version),
    p_idempotency_key: requiredUuid(envelope.idempotency_key, "idempotency_key"),
    p_request_id: context.requestId,
    p_payload: {
      interaction_type: enumValue(
        pick(payload, "tipo", "interaction_type"),
        "tipo",
        INTERACTION_TYPES,
      ),
      direction: enumValue(pick(payload, "direcao", "direction"), "direcao", DIRECTIONS),
      outcome: optionalText(pick(payload, "resultado", "outcome"), "resultado", 120, 2),
      commercial_summary: requiredText(
        pick(payload, "resumo", "commercial_summary"),
        "resumo",
        2,
        1000,
      ),
      occurred_at: optionalTimestamp(pick(payload, "ocorrido_em", "occurred_at"), "ocorrido_em") ||
        new Date().toISOString(),
      next_action_type: nextAt
        ? optionalText(
          pick(payload, "proxima_acao_tipo", "next_action_type"),
          "proxima_acao_tipo",
          40,
        ) || "contato"
        : null,
      next_action_at: nextAt,
    },
  });
  return success(req, context, {
    lead_id: result.lead_id,
    interaction_id: result.interaction_id,
    version: result.version,
    idempotente: result.idempotent === true,
  }, result.idempotent === true ? 200 : 201);
}

export function conversionDto(result: JsonRecord): JsonRecord {
  const candidates: JsonRecord[] = [];
  if (validUuid(result.exact_patient_id)) {
    candidates.push({
      paciente_id: result.exact_patient_id,
      patient_id: result.exact_patient_id,
      tipo_correspondencia: "exata",
      alias_opaco: result.exact_safe_alias,
      safe_alias: result.exact_safe_alias,
      rotulo_seguro: typeof result.exact_safe_label === "string"
        ? result.exact_safe_label
        : "Cadastro canônico com correspondência exata",
    });
  }
  for (const candidate of rows(result.possible_candidates)) {
    if (!validUuid(candidate.patient_id) || candidate.patient_id === result.exact_patient_id) {
      continue;
    }
    const match = String(candidate.match_kind || "provavel");
    candidates.push({
      paciente_id: candidate.patient_id,
      patient_id: candidate.patient_id,
      tipo_correspondencia: "provavel",
      motivo_tecnico: match,
      alias_opaco: candidate.safe_alias,
      safe_alias: candidate.safe_alias,
      rotulo_seguro: typeof candidate.safe_label === "string"
        ? candidate.safe_label
        : `Possível cadastro existente (${match})`,
    });
  }
  return {
    lead_id: result.lead_id,
    version: result.lead_version ?? result.version,
    exact_patient_id: result.exact_patient_id,
    paciente_exato_id: result.exact_patient_id,
    candidatos: candidates,
    candidates,
    pode_criar: result.can_create_patient === true,
    can_create: result.can_create_patient === true,
    candidate_fingerprint: result.candidate_fingerprint,
    fingerprint_candidatos: result.candidate_fingerprint,
    total_candidatos: result.possible_count,
    has_more: result.has_more === true,
  };
}

export function conversionRequiresRecentPassword(mode: string): boolean {
  return mode === "vincular_existente" || mode === "criar_paciente";
}

async function handleConversion(
  req: Request,
  context: DualAuthContext,
  envelope: JsonRecord,
  payload: JsonRecord,
): Promise<Response> {
  const { clinicId, userId } = tenantFromContext(context);
  const leadId = requiredUuid(pick(payload, "lead_id", "id"), "lead_id");
  const mode = requiredText(pick(payload, "modo", "mode"), "modo", 3, 40).toLowerCase();
  if (!["revisar", "vincular_existente", "criar_paciente"].includes(mode)) {
    throw new ApiError(422, "invalid_conversion_mode", "Modo de conversão inválido.");
  }
  if (mode === "revisar") {
    const analysis = await rpc("crm_analisar_conversao", {
      p_clinic_id: clinicId,
      p_actor_id: userId,
      p_lead_id: leadId,
    });
    return success(req, context, conversionDto(analysis));
  }
  if (!conversionRequiresRecentPassword(mode)) {
    throw new ApiError(422, "invalid_conversion_mode", "Modo de conversão inválido.");
  }
  requiredText(payload.motivo, "motivo", 3, 500);
  const confirmDistinct = payload.confirmar_distinta === true ||
    payload.confirm_possible_distinct === true;
  const distinctReason = optionalText(
    pick(payload, "motivo_duplicidade", "possible_distinct_reason", "distinct_reason"),
    "motivo_duplicidade",
    500,
    3,
  );
  if (confirmDistinct && !distinctReason) {
    throw new ApiError(
      422,
      "possible_distinct_reason_required",
      "Justifique por que os cadastros são distintos.",
    );
  }
  if (confirmDistinct && mode !== "criar_paciente") {
    throw new ApiError(
      422,
      "possible_distinct_mode_invalid",
      "A confirmação de cadastro distinto só vale ao criar uma nova paciente.",
    );
  }
  const candidateFingerprint = requiredText(
    pick(payload, "candidate_fingerprint", "fingerprint_candidatos"),
    "candidate_fingerprint",
    32,
    32,
  ).toLowerCase();
  if (!/^[a-f0-9]{32}$/.test(candidateFingerprint)) {
    throw new ApiError(422, "invalid_candidate_fingerprint", "Revise os candidatos novamente.");
  }
  await requireProtected(req, context, payload, `converter_${mode}`, leadId);
  const result = await rpc("crm_converter_lead", {
    p_clinic_id: clinicId,
    p_actor_id: userId,
    p_lead_id: leadId,
    p_expected_version: expectedVersion(envelope.expected_version),
    p_idempotency_key: requiredUuid(envelope.idempotency_key, "idempotency_key"),
    p_request_id: context.requestId,
    p_patient_id: mode === "vincular_existente"
      ? requiredUuid(pick(payload, "paciente_id", "patient_id"), "paciente_id")
      : null,
    p_confirm_possible_distinct: confirmDistinct,
    p_possible_distinct_reason: distinctReason,
    p_candidate_fingerprint: candidateFingerprint,
  });
  if (result.match_status === "possible_duplicate") {
    return success(req, context, {
      ...conversionDto(result),
      erro: "Revise os cadastros possivelmente existentes antes de criar.",
      codigo: "possible_duplicate_review_required",
    }, 409);
  }
  return success(req, context, {
    convertido: true,
    converted: true,
    lead_id: result.lead_id,
    paciente_id: result.patient_id,
    patient_id: result.patient_id,
    paciente_criada: result.patient_created === true,
    tipo_correspondencia: result.match_status,
    version: result.version,
    idempotente: result.idempotent === true,
  }, result.idempotent === true ? 200 : 201);
}

export async function handleRequest(req: Request): Promise<Response> {
  const origin = req.headers.get("origin");
  if (origin && !corsOriginAllowed(origin)) {
    return fail(req, "Origem não autorizada.", 403, "origin_forbidden");
  }
  if (req.method === "OPTIONS") {
    const headers = responseHeaders(req, false);
    headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    headers.set(
      "Access-Control-Allow-Headers",
      "authorization, apikey, content-type, x-client-info, x-amj-reauthentication",
    );
    headers.set("Access-Control-Max-Age", "600");
    return new Response(null, { status: 204, headers });
  }
  if (req.method !== "POST") {
    const response = fail(req, "Método não permitido.", 405, "method_not_allowed");
    response.headers.set("Allow", "POST, OPTIONS");
    return response;
  }
  if (!(req.headers.get("authorization") || "").trim()) {
    return fail(req, "Entre com seu acesso individual e MFA.", 401, "authorization_required");
  }

  let context: DualAuthContext;
  try {
    context = await authenticateDual(req, AUTH_CONFIG);
    tenantFromContext(context);
  } catch (error) {
    if (error instanceof DualAuthError) {
      if (error.auditContext) {
        await writeClinicAudit(AUTH_CONFIG, error.auditContext, {
          entity: "crm_access",
          action: "authenticate",
          outcome: "denied",
          details: { endpoint: "crm-fichas", reason_code: error.code },
        });
      }
      return fail(req, error.publicMessage, error.status, error.code);
    }
    if (error instanceof ApiError) return fail(req, error.publicMessage, error.status, error.code);
    return fail(req, "Autenticação temporariamente indisponível.", 503, "auth_unavailable");
  }

  let action = "request";
  let entityId: string | null = null;
  let auditEntity = "crm_lead";
  try {
    const envelope = await readJsonBody(req);
    action = requiredText(pick(envelope, "action", "acao"), "action", 2, 80).toLowerCase();
    if (!SAFE_ACTION.test(action)) throw new ApiError(422, "invalid_action", "Ação inválida.");
    const payload = isRecord(envelope.payload) ? envelope.payload : envelope;
    entityId = optionalUuid(
      pick(payload, "solicitacao_id", "site_request_id", "lead_id", "id"),
      "entity_id",
    );
    if (action.includes("solicitacao_site")) auditEntity = "crm_site_booking";

    let response: Response;
    switch (action) {
      case "listar":
      case "listar_leads":
        response = await handleList(req, context, payload);
        break;
      case "listar_solicitacoes_site":
        response = await handleSiteRequestList(req, context, payload);
        break;
      case "aceitar_solicitacao_site":
        response = await handleSiteRequestAccept(req, context, envelope, payload);
        break;
      case "arquivar_solicitacao_site":
        response = await handleSiteRequestArchive(req, context, envelope, payload);
        break;
      case "salvar_lead":
        response = await handleSave(req, context, envelope, payload);
        break;
      case "mudar_estagio":
        response = await handleStageChange(req, context, envelope, payload);
        break;
      case "registrar_interacao":
        response = await handleInteraction(req, context, envelope, payload);
        break;
      case "arquivar_lead":
        response = await handleStateChange(req, context, envelope, payload, "archive");
        break;
      case "cancelar_lead":
        response = await handleStateChange(req, context, envelope, payload, "cancel");
        break;
      case "converter_lead":
        response = await handleConversion(req, context, envelope, payload);
        break;
      default:
        throw new ApiError(422, "invalid_action", "Ação inválida.");
    }

    await writeClinicAudit(AUTH_CONFIG, context, {
      entity: auditEntity,
      entityId,
      action,
      outcome: response.ok ? "success" : "error",
      details: { endpoint: "crm-fichas", status_code: response.status },
    });
    return response;
  } catch (error) {
    if (error instanceof ApiError) {
      await writeClinicAudit(AUTH_CONFIG, context, {
        entity: auditEntity,
        entityId,
        action: SAFE_ACTION.test(action) ? action : "request",
        outcome: "error",
        details: { endpoint: "crm-fichas", reason_code: error.code, status_code: error.status },
      });
      return fail(req, error.publicMessage, error.status, error.code);
    }
    console.error("CRM request failed");
    await writeClinicAudit(AUTH_CONFIG, context, {
      entity: auditEntity,
      entityId,
      action: SAFE_ACTION.test(action) ? action : "request",
      outcome: "error",
      details: { endpoint: "crm-fichas", reason_code: "unhandled_error" },
    });
    return fail(req, "Não foi possível concluir a operação agora.", 500, "internal_error");
  }
}

if (import.meta.main) Deno.serve(handleRequest);

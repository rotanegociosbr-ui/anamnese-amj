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
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const LOCAL_TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;
const OFFSET_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/i;
const SAFE_ACTION = /^[a-z][a-z0-9_]{1,79}$/;
const PROTECTED_ACTIONS = new Set([
  "fechar_mes",
  "reabrir_mes",
  "editar_conta_caixa",
  "arquivar_conta_caixa",
  "restaurar_conta_caixa",
  "registrar_liquidacao",
  "estornar_liquidacao",
  "registrar_conciliacao",
  "registrar_evidencia_backup",
  "editar_equipamento",
  "arquivar_equipamento",
  "restaurar_equipamento",
  "editar_manutencao",
  "concluir_manutencao",
  "cancelar_manutencao",
]);

const EQUIPMENT_STATUSES = new Set([
  "em_cadastro",
  "ativo",
  "disponivel",
  "em_uso",
  "reserva",
  "em_manutencao",
  "aguardando_peca",
  "aguardando_validacao",
  "quarentena",
  "indisponivel",
  "desativado",
  "baixa_pendente",
  "baixado",
]);
const MAINTENANCE_KINDS = new Set([
  "preventiva",
  "corretiva",
  "inspecao_visual",
  "verificacao_funcional",
  "teste_seguranca",
  "calibracao",
  "qualificacao",
  "limpeza",
  "outro",
]);
const MAINTENANCE_OPEN_STATUSES = new Set(["planejada", "agendada", "em_andamento"]);
const TECHNICAL_SOURCE_TYPES = new Set([
  "official_manual",
  "manufacturer",
  "authorized_service",
  "contract",
  "regulatory",
  "responsible_technical",
  "pending_validation",
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
  return rows(value)[0] || null;
}

function pick(payload: JsonRecord, ...keys: string[]): unknown {
  for (const key of keys) {
    if (payload[key] !== undefined) return payload[key];
  }
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
  if (value === null || value === undefined || value === "") return null;
  return requiredUuid(value, field);
}

function requiredText(value: unknown, field: string, min: number, max: number): string {
  if (typeof value !== "string") {
    throw new ApiError(422, `invalid_${field}`, `Confira o campo ${field}.`);
  }
  const normalized = value.trim();
  const hasUnsafeControl = Array.from(normalized).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 8 || code === 11 || code === 12 || (code >= 14 && code <= 31);
  });
  if (normalized.length < min || normalized.length > max || hasUnsafeControl) {
    throw new ApiError(422, `invalid_${field}`, `Confira o campo ${field}.`);
  }
  return normalized;
}

function optionalText(value: unknown, field: string, max: number, min = 1): string | null {
  if (value === null || value === undefined || value === "") return null;
  return requiredText(value, field, min, max);
}

function enumValue(value: unknown, field: string, allowed: Set<string>): string {
  if (typeof value !== "string") {
    throw new ApiError(422, `invalid_${field}`, `Confira o campo ${field}.`);
  }
  const normalized = value.trim().toLowerCase();
  if (!allowed.has(normalized)) {
    throw new ApiError(422, `invalid_${field}`, `Confira o campo ${field}.`);
  }
  return normalized;
}

function numberValue(
  value: unknown,
  field: string,
  min: number,
  max: number,
  nullable = false,
): number | null {
  if (nullable && (value === null || value === undefined || value === "")) return null;
  if (value === null || value === undefined || value === "") {
    throw new ApiError(422, `invalid_${field}`, `Confira o campo ${field}.`);
  }
  const parsed = typeof value === "string" ? Number(value.trim().replace(",", ".")) : Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new ApiError(422, `invalid_${field}`, `Confira o campo ${field}.`);
  }
  return parsed;
}

function integerValue(value: unknown, field: string, min: number, max: number): number {
  const parsed = numberValue(value, field, min, max);
  if (parsed === null || !Number.isInteger(parsed)) {
    throw new ApiError(422, `invalid_${field}`, `Confira o campo ${field}.`);
  }
  return parsed;
}

function optionalInteger(value: unknown, field: string, min: number, max: number): number | null {
  if (value === null || value === undefined || value === "") return null;
  return integerValue(value, field, min, max);
}

function dateValue(value: unknown, field: string, nullable = false): string | null {
  if (nullable && (value === null || value === undefined || value === "")) return null;
  if (typeof value !== "string" || !DATE_PATTERN.test(value)) {
    throw new ApiError(422, `invalid_${field}`, `Confira a data ${field}.`);
  }
  const parsed = new Date(`${value}T12:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new ApiError(422, `invalid_${field}`, `Confira a data ${field}.`);
  }
  return value;
}

function timestampValue(value: unknown, field: string, nullable = false): string | null {
  if (nullable && (value === null || value === undefined || value === "")) return null;
  if (typeof value !== "string" || value.length > 40) {
    throw new ApiError(422, `invalid_${field}`, `Confira a data e hora ${field}.`);
  }
  let normalized: string;
  try {
    normalized = clinicTimestampToIso(value);
  } catch {
    throw new ApiError(422, `invalid_${field}`, `Confira a data e hora ${field}.`);
  }
  return normalized;
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

export function clinicDateForInstant(value: Date): string {
  if (!Number.isFinite(value.getTime())) throw new Error("invalid instant");
  const parts = clinicParts(value);
  return [
    String(parts.year).padStart(4, "0"),
    String(parts.month).padStart(2, "0"),
    String(parts.day).padStart(2, "0"),
  ].join("-");
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
    Number(local[6] || 0),
  ];
  const wallUtc = Date.UTC(wanted[0], wanted[1] - 1, wanted[2], wanted[3], wanted[4], wanted[5]);
  const offsetAt = (instant: number) => {
    const parts = clinicParts(new Date(instant));
    return Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
    ) - instant;
  };
  let instant = wallUtc - offsetAt(wallUtc);
  instant = wallUtc - offsetAt(instant);
  const actual = clinicParts(new Date(instant));
  const actualValues = [
    actual.year,
    actual.month,
    actual.day,
    actual.hour,
    actual.minute,
    actual.second,
  ];
  if (wanted.some((part, index) => part !== actualValues[index])) {
    throw new Error("invalid local timestamp");
  }
  return new Date(instant).toISOString();
}

export function normalizeDateRange(payload: JsonRecord): { start: string; end: string } {
  const now = new Date();
  const endDefault = clinicDateForInstant(now);
  const start = dateValue(pick(payload, "inicio", "periodo_inicio"), "periodo_inicio", true) ||
    `${endDefault.slice(0, 8)}01`;
  const end = dateValue(pick(payload, "fim", "periodo_fim"), "periodo_fim", true) || endDefault;
  if (end < start) {
    throw new ApiError(
      422,
      "invalid_period",
      "O fim do período deve ser igual ou posterior ao início.",
    );
  }
  const span = new Date(`${end}T00:00:00Z`).getTime() - new Date(`${start}T00:00:00Z`).getTime();
  if (span > 366 * 5 * 86_400_000) {
    throw new ApiError(422, "period_too_large", "Selecione um período de até cinco anos.");
  }
  return { start, end };
}

function pagination(payload: JsonRecord): { limit: number; offset: number } {
  const limit = payload.limite === undefined
    ? 100
    : integerValue(payload.limite, "limite", 1, MAX_PAGE_SIZE);
  const offset = payload.offset === undefined
    ? 0
    : integerValue(payload.offset, "offset", 0, 100_000);
  return { limit, offset };
}

function tenant(context: DualAuthContext): { clinicId: string; userId: string } {
  if (
    context.authMethod !== "supabase_auth" || context.role !== "owner" || context.aal !== "aal2" ||
    !validUuid(context.clinicId) || !validUuid(context.userId)
  ) {
    throw new ApiError(403, "owner_mfa_required", "Use uma conta proprietária individual com MFA.");
  }
  return { clinicId: context.clinicId, userId: context.userId };
}

export function corsOriginAllowed(origin: string | null): boolean {
  if (origin === null) return true;
  if (origin === "https://anamariajacob.com.br" || origin === "https://www.anamariajacob.com.br") {
    return true;
  }
  const match = /^http:\/\/(localhost|127\.0\.0\.1)(?::(\d{1,5}))?$/.exec(origin);
  return Boolean(match && (!match[2] || Number(match[2]) <= 65_535));
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
  const declared = Number(req.headers.get("content-length") || 0);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new ApiError(413, "payload_too_large", "Os dados enviados são muito grandes.");
  }
  const text = await req.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    throw new ApiError(413, "payload_too_large", "Os dados enviados são muito grandes.");
  }
  try {
    const parsed = JSON.parse(text);
    if (!isRecord(parsed)) throw new Error();
    return parsed;
  } catch {
    throw new ApiError(400, "invalid_json", "JSON inválido.");
  }
}

async function admin(
  path: string,
  method = "GET",
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<AdminResult> {
  if (!SUPABASE_URL || !SERVICE_ROLE) {
    throw new ApiError(503, "backend_unavailable", "Gestão administrativa indisponível.");
  }
  let response: Response;
  try {
    response = await fetch(`${SUPABASE_URL}${path}`, {
      method,
      headers: {
        apikey: SERVICE_ROLE,
        Authorization: `Bearer ${SERVICE_ROLE}`,
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...extraHeaders,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(12_000),
    });
  } catch {
    throw new ApiError(503, "database_unavailable", "Banco temporariamente indisponível.");
  }
  let data: unknown = null;
  if (response.status !== 204) {
    const responseText = await response.text();
    if (responseText) {
      try {
        data = JSON.parse(responseText);
      } catch {
        data = null;
      }
    }
  }
  return { response, data };
}

function postgresMessage(result: AdminResult): string {
  return isRecord(result.data) && typeof result.data.message === "string"
    ? result.data.message
    : "";
}

function mapDatabaseError(result: AdminResult): never {
  const message = postgresMessage(result);
  const mappings: Array<[string, number, string, string]> = [
    ["gestao_owner_required", 403, "owner_required", "Acesso exclusivo dos proprietários."],
    ["gestao_invalid_period", 422, "invalid_period", "Confira o período informado."],
    [
      "gestao_period_not_complete",
      409,
      "period_not_complete",
      "O mês ainda não terminou e não pode ser fechado.",
    ],
    ["gestao_period_already_closed", 409, "period_already_closed", "Este mês já está fechado."],
    [
      "gestao_reconciliation_pending",
      409,
      "reconciliation_pending",
      "Concilie todas as contas ativas antes de fechar o mês.",
    ],
    ["gestao_closure_not_found", 404, "closure_not_found", "Fechamento não encontrado."],
    [
      "gestao_closure_already_reopened",
      409,
      "closure_already_reopened",
      "Este fechamento já foi reaberto.",
    ],
    [
      "financial_period_closed",
      409,
      "financial_period_closed",
      "O período está fechado. Reabra-o antes de alterar os registros.",
    ],
    [
      "gestao_cash_account_not_found",
      404,
      "cash_account_not_found",
      "Conta operacional não encontrada.",
    ],
    ["gestao_payment_not_found", 404, "payment_not_found", "Pagamento não encontrado."],
    [
      "gestao_settlement_exceeds_payment",
      409,
      "settlement_exceeds_payment",
      "A liquidação excede o valor ainda não liquidado.",
    ],
    [
      "gestao_settlement_amount_mismatch",
      422,
      "settlement_amount_mismatch",
      "Bruto, taxa e líquido não conferem.",
    ],
    [
      "gestao_reversal_before_settlement",
      422,
      "reversal_before_settlement",
      "O estorno não pode ter data anterior à liquidação original.",
    ],
    [
      "gestao_opening_balance_after_settlement",
      422,
      "opening_balance_after_settlement",
      "A data do saldo inicial não pode ficar depois de uma liquidação já registrada.",
    ],
    ["gestao_settlement_not_found", 404, "settlement_not_found", "Liquidação não encontrada."],
    [
      "gestao_settlement_already_reversed",
      409,
      "settlement_already_reversed",
      "Esta liquidação já foi estornada.",
    ],
    ["gestao_equipment_not_found", 404, "equipment_not_found", "Equipamento não encontrado."],
    ["gestao_maintenance_not_found", 404, "maintenance_not_found", "Manutenção não encontrada."],
    ["gestao_record_archived", 409, "record_archived", "O cadastro está arquivado."],
    ["gestao_record_not_archived", 409, "record_not_archived", "O cadastro não está arquivado."],
    [
      "maintenance_final_is_immutable",
      409,
      "maintenance_final_immutable",
      "Manutenção concluída ou cancelada é imutável; crie uma correção vinculada.",
    ],
    [
      "version_conflict",
      409,
      "version_conflict",
      "O registro foi alterado em outro acesso. Recarregue e tente novamente.",
    ],
  ];
  for (const [needle, status, code, publicMessage] of mappings) {
    if (message.includes(needle)) throw new ApiError(status, code, publicMessage);
  }
  if (result.response.status === 409 || message.includes("duplicate key")) {
    throw new ApiError(409, "conflict", "Já existe um registro com estes dados.");
  }
  if (result.response.status >= 500) {
    throw new ApiError(503, "database_unavailable", "Banco temporariamente indisponível.");
  }
  throw new ApiError(
    422,
    "administrative_operation_failed",
    "Não foi possível concluir a operação.",
  );
}

async function rpc(name: string, body: JsonRecord): Promise<unknown> {
  const result = await admin(`/rest/v1/rpc/${name}`, "POST", body);
  if (!result.response.ok) mapDatabaseError(result);
  return result.data;
}

async function selectRows(table: string, params: URLSearchParams): Promise<JsonRecord[]> {
  const result = await admin(`/rest/v1/${table}?${params.toString()}`);
  if (!result.response.ok) mapDatabaseError(result);
  return rows(result.data);
}

function listParams(
  clinicId: string | null,
  select: string,
  order: string,
  page: { limit: number; offset: number },
): URLSearchParams {
  const params = new URLSearchParams({
    select,
    order,
    limit: String(page.limit),
    offset: String(page.offset),
  });
  if (clinicId) params.set("clinic_id", `eq.${clinicId}`);
  return params;
}

async function requireProtected(
  req: Request,
  context: DualAuthContext,
  payload: JsonRecord,
  action: string,
  targetId: string,
): Promise<void> {
  const operationId = requiredUuid(payload.operation_id, "operation_id");
  reason(payload);
  try {
    await requireRecentPasswordProof(req, AUTH_CONFIG, context, {
      operationId,
      action: `gestao.${action}`,
      targetId,
    });
  } catch (error) {
    if (error instanceof DualAuthError) {
      if (error.auditContext) {
        await writeClinicAudit(AUTH_CONFIG, error.auditContext, {
          entity: "administrative_protected_operation",
          action: "reauthenticate",
          outcome: "denied",
          details: { endpoint: "gestao-administrativa-fichas", reason_code: error.code },
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

function protectedTarget(action: string, payload: JsonRecord): string {
  switch (action) {
    case "fechar_mes":
      return requiredUuid(pick(payload, "fechamento_id", "id"), "fechamento_id");
    case "reabrir_mes":
      return requiredUuid(pick(payload, "fechamento_id", "id"), "fechamento_id");
    case "editar_conta_caixa":
    case "arquivar_conta_caixa":
    case "restaurar_conta_caixa":
      return requiredUuid(pick(payload, "conta_id", "id"), "conta_id");
    case "registrar_liquidacao":
      return requiredUuid(pick(payload, "liquidacao_id", "id"), "liquidacao_id");
    case "estornar_liquidacao":
      return requiredUuid(pick(payload, "liquidacao_id", "original_id", "id"), "liquidacao_id");
    case "registrar_conciliacao":
      return requiredUuid(pick(payload, "conciliacao_id", "id"), "conciliacao_id");
    case "registrar_evidencia_backup":
      return requiredUuid(pick(payload, "evidencia_id", "id"), "evidencia_id");
    case "editar_equipamento":
    case "arquivar_equipamento":
    case "restaurar_equipamento":
      return requiredUuid(pick(payload, "equipamento_id", "id"), "equipamento_id");
    case "editar_manutencao":
    case "concluir_manutencao":
    case "cancelar_manutencao":
      return requiredUuid(pick(payload, "manutencao_id", "id"), "manutencao_id");
    default:
      throw new ApiError(500, "protected_scope_missing", "Operação protegida sem escopo seguro.");
  }
}

function reason(payload: JsonRecord): string {
  return requiredText(payload.motivo, "motivo", 3, 300);
}

function optionalMoney(value: unknown, field: string): number | null {
  return numberValue(value, field, 0, 999_999_999_999.99, true);
}

async function handleDashboard(
  req: Request,
  context: DualAuthContext,
  payload: JsonRecord,
): Promise<Response> {
  const { clinicId, userId } = tenant(context);
  const range = normalizeDateRange(payload);
  const warningDays = payload.horizonte_alerta_dias === undefined
    ? 30
    : integerValue(payload.horizonte_alerta_dias, "horizonte_alerta_dias", 1, 365);
  const data = await rpc("gestao_administrativa_dashboard", {
    p_clinic_id: clinicId,
    p_actor_id: userId,
    p_period_start: range.start,
    p_period_end: range.end,
    p_warning_days: warningDays,
  });
  return success(req, context, { dashboard: data });
}

async function handlePhase2FollowupReport(
  req: Request,
  context: DualAuthContext,
  payload: JsonRecord,
): Promise<Response> {
  const { clinicId, userId } = tenant(context);
  const start = dateValue(payload.inicio, "inicio");
  const end = dateValue(payload.fim, "fim");
  if (!start || !end) throw new ApiError(422, "report_period_invalid", "Informe o período.");
  const today = clinicDateForInstant(new Date());
  const days = (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) /
    86_400_000;
  if (end < start || end > today || days > 365) {
    throw new ApiError(422, "report_period_invalid", "Selecione até 366 dias, sem datas futuras.");
  }
  const report = await rpc("gestao_relatorio_acompanhamentos_fase2", {
    p_clinic_id: clinicId,
    p_user_id: userId,
    p_actor_role: context.role,
    p_auth_method: context.authMethod,
    p_aal: context.aal,
    p_start_date: start,
    p_end_date: end,
  });
  return success(req, context, { relatorio: report });
}

async function handleList(
  req: Request,
  context: DualAuthContext,
  payload: JsonRecord,
  kind: string,
): Promise<Response> {
  const { clinicId } = tenant(context);
  const page = pagination(payload);
  let table = "";
  let select = "*";
  let order = "created_at.desc";
  let key = "registros";
  let params: URLSearchParams;
  switch (kind) {
    case "contas_financeiras": {
      table = "gestao_contas_financeiras";
      select =
        "account_id,source_kind,entry_id,installment_id,nature,origin,description,category,competence_date,due_date,total_amount,paid_amount,balance,status,planned_payment_method,installment_number,installments";
      order = "due_date.asc,account_id.asc";
      key = "contas";
      params = listParams(clinicId, select, order, page);
      const nature = payload.natureza
        ? enumValue(payload.natureza, "natureza", new Set(["receber", "pagar"]))
        : null;
      if (nature) params.set("nature", `eq.${nature}`);
      const status = optionalText(payload.status, "status", 20);
      if (status) params.set("status", `eq.${status.toLowerCase()}`);
      const range = normalizeDateRange(payload);
      params.set("due_date", `gte.${range.start}`);
      params.append("due_date", `lte.${range.end}`);
      break;
    }
    case "fechamentos":
      table = "gestao_fechamentos_mensais_resumo";
      select =
        "id,period_start,version,competence_revenue,competence_expense,cash_in,cash_out,net_cash_flow,receivable_open,payable_open,overdue_receivable,overdue_payable,inventory_value,inventory_negative_count,returns_due_count,equipment_count,equipment_unavailable_count,maintenance_overdue_count,definition_version,source_cutoff_at,closed_at,status,reopened_at,reopen_reason";
      order = "period_start.desc,version.desc";
      key = "fechamentos";
      params = listParams(clinicId, select, order, page);
      break;
    case "contas_caixa":
      table = "gestao_contas_caixa_resumo";
      select =
        "id,name,account_type,institution_label,identifier_last4,currency,opening_balance,opening_balance_date,net_movement,calculated_balance,last_settlement_at,archived_at,created_at,updated_at,version";
      order = "archived_at.asc,name.asc";
      key = "contas_caixa";
      params = listParams(clinicId, select, order, page);
      if (payload.incluir_arquivados !== true) params.set("archived_at", "is.null");
      break;
    case "pagamentos_liquidacao":
      table = "gestao_pagamentos_liquidacao_resumo";
      select =
        "payment_id,entry_id,entry_type,payment_method,payment_amount,paid_at,settled_gross,pending_gross,settled_fee,settled_net,last_settlement_at";
      order = "paid_at.desc,payment_id.desc";
      key = "pagamentos";
      params = listParams(clinicId, select, order, page);
      if (payload.somente_pendentes !== false) params.set("pending_gross", "gt.0");
      break;
    case "liquidacoes":
      table = "gestao_liquidacoes_financeiras";
      select =
        "id,account_id,payment_id,movement_kind,gross_amount,fee_amount,net_amount,settled_at,reference,reversal_of_id,recorded_at";
      order = "settled_at.desc,id.desc";
      key = "liquidacoes";
      params = listParams(clinicId, select, order, page);
      break;
    case "conciliacoes":
      table = "gestao_conciliacoes_atuais";
      select =
        "id,account_id,period_start,period_end,version,supersedes_id,internal_amount,external_amount,difference_amount,status,evidence_reference,notes,reconciled_at";
      order = "period_end.desc,account_id.asc";
      key = "conciliacoes";
      params = listParams(clinicId, select, order, page);
      break;
    case "equipamentos":
      table = "gestao_equipamentos";
      select =
        "id,asset_code,category,name,brand,model,serial_number,patrimonial_number,location,possession_mode,supplier_id,acquisition_date,acquisition_cost,warranty_start,warranty_end,warranty_reference,manual_reference,technical_source_reference,responsible_label,criticality,status,notes,archived_at,created_at,updated_at,version";
      order = "archived_at.asc,criticality.desc,name.asc";
      key = "equipamentos";
      params = listParams(clinicId, select, order, page);
      if (payload.incluir_arquivados !== true) params.set("archived_at", "is.null");
      if (payload.status) {
        params.set("status", `eq.${enumValue(payload.status, "status", EQUIPMENT_STATUSES)}`);
      }
      break;
    case "manutencoes":
      table = "gestao_equipamento_manutencoes";
      select =
        "id,equipment_id,correction_of_id,maintenance_kind,status,description,symptom,service_provider,service_order_reference,scheduled_for,started_at,completed_at,next_due_date,technical_source_type,technical_source_reference,cost,downtime_minutes,result_summary,evidence_reference,cancellation_reason,cancelled_at,created_at,updated_at,version";
      order = "created_at.desc,id.desc";
      key = "manutencoes";
      params = listParams(clinicId, select, order, page);
      if (payload.equipamento_id) {
        params.set("equipment_id", `eq.${requiredUuid(payload.equipamento_id, "equipamento_id")}`);
      }
      break;
    case "alertas":
      table = "gestao_alertas_equipamentos";
      select = "equipment_id,maintenance_id,alert_kind,severity,reason_code,due_date";
      order = "severity.asc,due_date.asc";
      key = "alertas";
      params = listParams(clinicId, select, order, page);
      break;
    case "auditoria":
      table = "gestao_administrativa_auditoria";
      select = "id,entity,entity_id,action,outcome,operation_id,details,created_at";
      order = "created_at.desc,id.desc";
      key = "auditoria";
      params = listParams(clinicId, select, order, page);
      break;
    case "evidencias_backup":
      table = "gestao_backup_restauracao_evidencias";
      select = "id,event_kind,system_scope,occurred_at,result,evidence_reference,notes,recorded_at";
      order = "occurred_at.desc,id.desc";
      key = "evidencias";
      params = listParams(clinicId, select, order, page);
      break;
    default:
      throw new ApiError(500, "list_contract_missing", "Listagem administrativa sem contrato.");
  }
  const data = await selectRows(table, params!);
  return success(req, context, { [key]: data, total_retornado: data.length });
}

async function handleCatalog(req: Request, context: DualAuthContext): Promise<Response> {
  tenant(context);
  const sourceParams = new URLSearchParams({
    select:
      "code,label,source_relation,classification,owner_role,status,contains_personal_data,notes,definition_version",
    order: "code.asc",
  });
  const metricParams = new URLSearchParams({
    select:
      "code,label,definition,formula,unit,source_code,owner_role,status,privacy_level,limitation,definition_version",
    order: "code.asc",
  });
  const [sources, metrics] = await Promise.all([
    selectRows("gestao_fontes_catalogo", sourceParams),
    selectRows("gestao_metricas_catalogo", metricParams),
  ]);
  return success(req, context, { fontes: sources, metricas: metrics });
}

async function handleCloseMonth(
  req: Request,
  context: DualAuthContext,
  payload: JsonRecord,
): Promise<Response> {
  const { clinicId, userId } = tenant(context);
  const result = await rpc("gestao_fechar_mes", {
    p_closure_id: requiredUuid(pick(payload, "fechamento_id", "id"), "fechamento_id"),
    p_clinic_id: clinicId,
    p_actor_id: userId,
    p_period_start: dateValue(pick(payload, "mes", "periodo_inicio"), "mes"),
    p_close_reason: reason(payload),
    p_operation_id: requiredUuid(payload.operation_id, "operation_id"),
    p_request_id: context.requestId,
  });
  return success(req, context, { fechamento: result }, 201);
}

async function handleReopenMonth(
  req: Request,
  context: DualAuthContext,
  payload: JsonRecord,
): Promise<Response> {
  const { clinicId, userId } = tenant(context);
  const result = await rpc("gestao_reabrir_mes", {
    p_clinic_id: clinicId,
    p_actor_id: userId,
    p_closure_id: requiredUuid(pick(payload, "fechamento_id", "id"), "fechamento_id"),
    p_reopen_reason: reason(payload),
    p_operation_id: requiredUuid(payload.operation_id, "operation_id"),
    p_request_id: context.requestId,
  });
  return success(req, context, { reabertura: result }, 201);
}

async function handleCashAccount(
  req: Request,
  context: DualAuthContext,
  payload: JsonRecord,
  mode: "create" | "edit" | "archive" | "restore",
): Promise<Response> {
  const { clinicId, userId } = tenant(context);
  let result: unknown;
  if (mode === "create") {
    result = await rpc("gestao_criar_conta_caixa", {
      p_id: requiredUuid(pick(payload, "conta_id", "id"), "conta_id"),
      p_clinic_id: clinicId,
      p_actor_id: userId,
      p_name: requiredText(payload.nome, "nome", 2, 100),
      p_account_type: enumValue(
        payload.tipo,
        "tipo",
        new Set(["banco", "caixa", "carteira", "gateway", "outro"]),
      ),
      p_institution_label: optionalText(payload.instituicao, "instituicao", 100, 2),
      p_identifier_last4: optionalText(payload.ultimos_4, "ultimos_4", 4, 4),
      p_opening_balance: numberValue(
        payload.saldo_inicial ?? 0,
        "saldo_inicial",
        -999_999_999_999.99,
        999_999_999_999.99,
      ),
      p_opening_balance_date: dateValue(payload.data_saldo_inicial, "data_saldo_inicial"),
      p_idempotency_key: requiredUuid(payload.idempotency_key, "idempotency_key"),
      p_request_id: context.requestId,
    });
  } else if (mode === "edit") {
    result = await rpc("gestao_editar_conta_caixa", {
      p_clinic_id: clinicId,
      p_actor_id: userId,
      p_id: requiredUuid(pick(payload, "conta_id", "id"), "conta_id"),
      p_expected_version: integerValue(payload.versao, "versao", 1, 2_147_483_647),
      p_name: requiredText(payload.nome, "nome", 2, 100),
      p_account_type: enumValue(
        payload.tipo,
        "tipo",
        new Set(["banco", "caixa", "carteira", "gateway", "outro"]),
      ),
      p_institution_label: optionalText(payload.instituicao, "instituicao", 100, 2),
      p_identifier_last4: optionalText(payload.ultimos_4, "ultimos_4", 4, 4),
      p_opening_balance: numberValue(
        payload.saldo_inicial ?? 0,
        "saldo_inicial",
        -999_999_999_999.99,
        999_999_999_999.99,
      ),
      p_opening_balance_date: dateValue(payload.data_saldo_inicial, "data_saldo_inicial"),
      p_reason: reason(payload),
      p_operation_id: requiredUuid(payload.operation_id, "operation_id"),
      p_request_id: context.requestId,
    });
  } else {
    result = await rpc("gestao_alterar_arquivo_conta_caixa", {
      p_clinic_id: clinicId,
      p_actor_id: userId,
      p_id: requiredUuid(pick(payload, "conta_id", "id"), "conta_id"),
      p_expected_version: integerValue(payload.versao, "versao", 1, 2_147_483_647),
      p_restore: mode === "restore",
      p_reason: reason(payload),
      p_operation_id: requiredUuid(payload.operation_id, "operation_id"),
      p_request_id: context.requestId,
    });
  }
  return success(req, context, { conta_caixa: result }, mode === "create" ? 201 : 200);
}

async function handleSettlement(
  req: Request,
  context: DualAuthContext,
  payload: JsonRecord,
  reversal: boolean,
): Promise<Response> {
  const { clinicId, userId } = tenant(context);
  const id = requiredUuid(
    pick(payload, "novo_id", "registro_id", reversal ? "estorno_id" : "liquidacao_id", "id"),
    reversal ? "estorno_id" : "liquidacao_id",
  );
  const result = reversal
    ? await rpc("gestao_estornar_liquidacao", {
      p_id: id,
      p_clinic_id: clinicId,
      p_actor_id: userId,
      p_original_id: requiredUuid(pick(payload, "liquidacao_id", "original_id"), "liquidacao_id"),
      p_settled_at: timestampValue(payload.liquidado_em, "liquidado_em"),
      p_reason: reason(payload),
      p_operation_id: requiredUuid(payload.operation_id, "operation_id"),
      p_request_id: context.requestId,
    })
    : await rpc("gestao_registrar_liquidacao", {
      p_id: id,
      p_clinic_id: clinicId,
      p_actor_id: userId,
      p_account_id: requiredUuid(payload.conta_id, "conta_id"),
      p_payment_id: requiredUuid(payload.pagamento_id, "pagamento_id"),
      p_gross_amount: numberValue(payload.valor_bruto, "valor_bruto", 0.01, 999_999_999_999.99),
      p_fee_amount: numberValue(payload.taxa ?? 0, "taxa", 0, 999_999_999_999.99),
      p_net_amount: numberValue(payload.valor_liquido, "valor_liquido", 0, 999_999_999_999.99),
      p_settled_at: timestampValue(payload.liquidado_em, "liquidado_em"),
      p_reference: optionalText(payload.referencia, "referencia", 80, 2),
      p_operation_id: requiredUuid(payload.operation_id, "operation_id"),
      p_request_id: context.requestId,
    });
  return success(req, context, { liquidacao: result }, 201);
}

async function handleReconciliation(
  req: Request,
  context: DualAuthContext,
  payload: JsonRecord,
): Promise<Response> {
  const { clinicId, userId } = tenant(context);
  const result = await rpc("gestao_registrar_conciliacao", {
    p_id: requiredUuid(pick(payload, "conciliacao_id", "id"), "conciliacao_id"),
    p_clinic_id: clinicId,
    p_actor_id: userId,
    p_account_id: requiredUuid(payload.conta_id, "conta_id"),
    p_period_start: dateValue(payload.periodo_inicio, "periodo_inicio"),
    p_period_end: dateValue(payload.periodo_fim, "periodo_fim"),
    p_external_amount: numberValue(
      payload.saldo_externo,
      "saldo_externo",
      -999_999_999_999.99,
      999_999_999_999.99,
    ),
    p_evidence_reference: requiredText(payload.evidencia, "evidencia", 3, 300),
    p_notes: optionalText(payload.observacoes, "observacoes", 800),
    p_operation_id: requiredUuid(payload.operation_id, "operation_id"),
    p_request_id: context.requestId,
  });
  return success(req, context, { conciliacao: result }, 201);
}

async function handleBackupEvidence(
  req: Request,
  context: DualAuthContext,
  payload: JsonRecord,
): Promise<Response> {
  const { clinicId, userId } = tenant(context);
  const kind = enumValue(
    payload.tipo,
    "tipo",
    new Set(["backup_executado", "restauracao_testada", "restauracao_falhou"]),
  );
  const result = await rpc("gestao_registrar_evidencia_backup", {
    p_id: requiredUuid(pick(payload, "evidencia_id", "id"), "evidencia_id"),
    p_clinic_id: clinicId,
    p_actor_id: userId,
    p_event_kind: kind,
    p_system_scope: requiredText(payload.escopo, "escopo", 3, 120),
    p_occurred_at: timestampValue(payload.ocorrido_em, "ocorrido_em"),
    p_result: kind === "restauracao_falhou" ? "falha" : "sucesso",
    p_evidence_reference: requiredText(payload.evidencia, "evidencia", 3, 300),
    p_notes: optionalText(payload.observacoes, "observacoes", 800),
    p_operation_id: requiredUuid(payload.operation_id, "operation_id"),
    p_request_id: context.requestId,
  });
  return success(req, context, { evidencia: result }, 201);
}

function equipmentRpcFields(payload: JsonRecord): JsonRecord {
  return {
    p_asset_code: requiredText(payload.codigo_patrimonio, "codigo_patrimonio", 2, 40),
    p_category: requiredText(payload.categoria, "categoria", 2, 80),
    p_name: requiredText(payload.nome, "nome", 2, 120),
    p_brand: optionalText(payload.marca, "marca", 80, 2),
    p_model: optionalText(payload.modelo, "modelo", 100),
    p_serial_number: optionalText(payload.numero_serie, "numero_serie", 100),
    p_patrimonial_number: optionalText(payload.numero_patrimonial, "numero_patrimonial", 80),
    p_location: optionalText(payload.localizacao, "localizacao", 120, 2),
    p_possession_mode: enumValue(
      payload.modalidade_posse ?? "proprio",
      "modalidade_posse",
      new Set(["proprio", "locacao", "comodato", "leasing", "outro"]),
    ),
    p_supplier_id: optionalUuid(payload.fornecedor_id, "fornecedor_id"),
    p_acquisition_date: dateValue(payload.data_aquisicao, "data_aquisicao", true),
    p_acquisition_cost: optionalMoney(payload.custo_aquisicao, "custo_aquisicao"),
    p_warranty_start: dateValue(payload.garantia_inicio, "garantia_inicio", true),
    p_warranty_end: dateValue(payload.garantia_fim, "garantia_fim", true),
    p_warranty_reference: optionalText(payload.referencia_garantia, "referencia_garantia", 200, 2),
    p_manual_reference: optionalText(payload.referencia_manual, "referencia_manual", 300, 2),
    p_technical_source_reference: optionalText(payload.fonte_tecnica, "fonte_tecnica", 300, 2),
    p_responsible_label: optionalText(payload.responsavel, "responsavel", 120, 2),
    p_criticality: enumValue(
      payload.criticidade ?? "media",
      "criticidade",
      new Set(["baixa", "media", "alta", "critica"]),
    ),
    p_status: enumValue(payload.status ?? "em_cadastro", "status", EQUIPMENT_STATUSES),
    p_notes: optionalText(payload.observacoes, "observacoes", 1000),
  };
}

async function handleEquipment(
  req: Request,
  context: DualAuthContext,
  payload: JsonRecord,
  mode: "create" | "edit" | "archive" | "restore",
): Promise<Response> {
  const { clinicId, userId } = tenant(context);
  const id = requiredUuid(pick(payload, "equipamento_id", "id"), "equipamento_id");
  let result: unknown;
  if (mode === "create") {
    result = await rpc("gestao_criar_equipamento", {
      p_id: id,
      p_clinic_id: clinicId,
      p_actor_id: userId,
      ...equipmentRpcFields(payload),
      p_idempotency_key: requiredUuid(payload.idempotency_key, "idempotency_key"),
      p_request_id: context.requestId,
    });
  } else if (mode === "edit") {
    result = await rpc("gestao_editar_equipamento", {
      p_clinic_id: clinicId,
      p_actor_id: userId,
      p_id: id,
      p_expected_version: integerValue(payload.versao, "versao", 1, 2_147_483_647),
      ...equipmentRpcFields(payload),
      p_reason: reason(payload),
      p_operation_id: requiredUuid(payload.operation_id, "operation_id"),
      p_request_id: context.requestId,
    });
  } else {
    result = await rpc("gestao_alterar_arquivo_equipamento", {
      p_clinic_id: clinicId,
      p_actor_id: userId,
      p_id: id,
      p_expected_version: integerValue(payload.versao, "versao", 1, 2_147_483_647),
      p_restore: mode === "restore",
      p_reason: reason(payload),
      p_operation_id: requiredUuid(payload.operation_id, "operation_id"),
      p_request_id: context.requestId,
    });
  }
  return success(req, context, { equipamento: result }, mode === "create" ? 201 : 200);
}

function maintenanceBaseFields(payload: JsonRecord): JsonRecord {
  return {
    p_maintenance_kind: enumValue(payload.tipo, "tipo", MAINTENANCE_KINDS),
    p_status: enumValue(payload.status ?? "planejada", "status", MAINTENANCE_OPEN_STATUSES),
    p_description: requiredText(payload.descricao, "descricao", 3, 500),
    p_symptom: optionalText(payload.sintoma, "sintoma", 500, 3),
    p_service_provider: optionalText(payload.prestador, "prestador", 160, 2),
    p_service_order_reference: optionalText(payload.ordem_servico, "ordem_servico", 120),
    p_scheduled_for: dateValue(payload.agendada_para, "agendada_para", true),
    p_started_at: timestampValue(payload.iniciada_em, "iniciada_em", true),
    p_next_due_date: dateValue(payload.proxima_data, "proxima_data", true),
    p_technical_source_type: enumValue(
      payload.tipo_fonte_tecnica ?? "pending_validation",
      "tipo_fonte_tecnica",
      TECHNICAL_SOURCE_TYPES,
    ),
    p_technical_source_reference: optionalText(payload.fonte_tecnica, "fonte_tecnica", 300, 3),
    p_cost: optionalMoney(payload.custo, "custo"),
    p_downtime_minutes: optionalInteger(
      payload.minutos_indisponivel,
      "minutos_indisponivel",
      0,
      10_000_000,
    ),
    p_evidence_reference: optionalText(payload.evidencia, "evidencia", 300, 2),
  };
}

async function handleMaintenance(
  req: Request,
  context: DualAuthContext,
  payload: JsonRecord,
  mode: "create" | "edit" | "complete" | "cancel",
): Promise<Response> {
  const { clinicId, userId } = tenant(context);
  const id = requiredUuid(pick(payload, "manutencao_id", "id"), "manutencao_id");
  let result: unknown;
  if (mode === "create") {
    result = await rpc("gestao_criar_manutencao", {
      p_id: id,
      p_clinic_id: clinicId,
      p_actor_id: userId,
      p_equipment_id: requiredUuid(payload.equipamento_id, "equipamento_id"),
      p_correction_of_id: optionalUuid(payload.correcao_de_id, "correcao_de_id"),
      ...maintenanceBaseFields(payload),
      p_idempotency_key: requiredUuid(payload.idempotency_key, "idempotency_key"),
      p_request_id: context.requestId,
    });
  } else if (mode === "edit") {
    result = await rpc("gestao_editar_manutencao", {
      p_clinic_id: clinicId,
      p_actor_id: userId,
      p_id: id,
      p_expected_version: integerValue(payload.versao, "versao", 1, 2_147_483_647),
      ...maintenanceBaseFields(payload),
      p_reason: reason(payload),
      p_operation_id: requiredUuid(payload.operation_id, "operation_id"),
      p_request_id: context.requestId,
    });
  } else if (mode === "complete") {
    result = await rpc("gestao_concluir_manutencao", {
      p_clinic_id: clinicId,
      p_actor_id: userId,
      p_id: id,
      p_expected_version: integerValue(payload.versao, "versao", 1, 2_147_483_647),
      p_completed_at: timestampValue(payload.concluida_em, "concluida_em"),
      p_result_summary: requiredText(payload.resultado, "resultado", 3, 1000),
      p_cost: optionalMoney(payload.custo, "custo"),
      p_downtime_minutes: optionalInteger(
        payload.minutos_indisponivel,
        "minutos_indisponivel",
        0,
        10_000_000,
      ),
      p_next_due_date: dateValue(payload.proxima_data, "proxima_data", true),
      p_technical_source_type: enumValue(
        payload.tipo_fonte_tecnica ?? "pending_validation",
        "tipo_fonte_tecnica",
        TECHNICAL_SOURCE_TYPES,
      ),
      p_technical_source_reference: optionalText(payload.fonte_tecnica, "fonte_tecnica", 300, 3),
      p_evidence_reference: optionalText(payload.evidencia, "evidencia", 300, 2),
      p_reason: reason(payload),
      p_operation_id: requiredUuid(payload.operation_id, "operation_id"),
      p_request_id: context.requestId,
    });
  } else {
    result = await rpc("gestao_cancelar_manutencao", {
      p_clinic_id: clinicId,
      p_actor_id: userId,
      p_id: id,
      p_expected_version: integerValue(payload.versao, "versao", 1, 2_147_483_647),
      p_reason: reason(payload),
      p_operation_id: requiredUuid(payload.operation_id, "operation_id"),
      p_request_id: context.requestId,
    });
  }
  return success(req, context, { manutencao: result }, mode === "create" ? 201 : 200);
}

async function handleGetRecord(
  req: Request,
  context: DualAuthContext,
  payload: JsonRecord,
  kind: "equipamento" | "manutencao" | "conta_caixa",
): Promise<Response> {
  const { clinicId } = tenant(context);
  const idField = kind === "conta_caixa" ? "conta_id" : `${kind}_id`;
  const id = requiredUuid(
    kind === "conta_caixa"
      ? pick(payload, "conta_id", "conta_caixa_id", "id")
      : pick(payload, idField, "id"),
    idField,
  );
  const contracts = {
    equipamento: ["gestao_equipamentos", "equipamento"],
    manutencao: ["gestao_equipamento_manutencoes", "manutencao"],
    conta_caixa: ["gestao_contas_caixa_resumo", "conta_caixa"],
  } as const;
  const [table, key] = contracts[kind];
  const params = new URLSearchParams({
    select: "*",
    clinic_id: `eq.${clinicId}`,
    id: `eq.${id}`,
    limit: "1",
  });
  const row = firstRow(await selectRows(table, params));
  if (!row) throw new ApiError(404, `${kind}_not_found`, "Registro não encontrado.");
  return success(req, context, { [key]: row });
}

export async function handleRequest(req: Request): Promise<Response> {
  if (!corsOriginAllowed(req.headers.get("origin"))) {
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
    tenant(context);
  } catch (error) {
    if (error instanceof DualAuthError) {
      if (error.auditContext) {
        await writeClinicAudit(AUTH_CONFIG, error.auditContext, {
          entity: "administrative_access",
          action: "authenticate",
          outcome: "denied",
          details: { endpoint: "gestao-administrativa-fichas", reason_code: error.code },
        });
      }
      return fail(req, error.publicMessage, error.status, error.code);
    }
    if (error instanceof ApiError) return fail(req, error.publicMessage, error.status, error.code);
    return fail(req, "Autenticação temporariamente indisponível.", 503, "auth_unavailable");
  }

  let action = "request";
  try {
    const payload = await readJsonBody(req);
    action = requiredText(payload.acao, "acao", 2, 80).toLowerCase();
    if (!SAFE_ACTION.test(action)) {
      throw new ApiError(422, "invalid_action", "Ação administrativa inválida.");
    }
    if (PROTECTED_ACTIONS.has(action)) {
      await requireProtected(req, context, payload, action, protectedTarget(action, payload));
    }

    let response: Response;
    switch (action) {
      case "dashboard":
        response = await handleDashboard(req, context, payload);
        break;
      case "relatorio_acompanhamentos_fase2":
        response = await handlePhase2FollowupReport(req, context, payload);
        break;
      case "listar_contas_financeiras":
        response = await handleList(req, context, payload, "contas_financeiras");
        break;
      case "listar_fechamentos":
        response = await handleList(req, context, payload, "fechamentos");
        break;
      case "fechar_mes":
        response = await handleCloseMonth(req, context, payload);
        break;
      case "reabrir_mes":
        response = await handleReopenMonth(req, context, payload);
        break;
      case "listar_contas_caixa":
        response = await handleList(req, context, payload, "contas_caixa");
        break;
      case "obter_conta_caixa":
        response = await handleGetRecord(req, context, payload, "conta_caixa");
        break;
      case "criar_conta_caixa":
        response = await handleCashAccount(req, context, payload, "create");
        break;
      case "editar_conta_caixa":
        response = await handleCashAccount(req, context, payload, "edit");
        break;
      case "arquivar_conta_caixa":
        response = await handleCashAccount(req, context, payload, "archive");
        break;
      case "restaurar_conta_caixa":
        response = await handleCashAccount(req, context, payload, "restore");
        break;
      case "listar_pagamentos_liquidacao":
        response = await handleList(req, context, payload, "pagamentos_liquidacao");
        break;
      case "listar_liquidacoes":
        response = await handleList(req, context, payload, "liquidacoes");
        break;
      case "registrar_liquidacao":
        response = await handleSettlement(req, context, payload, false);
        break;
      case "estornar_liquidacao":
        response = await handleSettlement(req, context, payload, true);
        break;
      case "listar_conciliacoes":
        response = await handleList(req, context, payload, "conciliacoes");
        break;
      case "registrar_conciliacao":
        response = await handleReconciliation(req, context, payload);
        break;
      case "listar_equipamentos":
        response = await handleList(req, context, payload, "equipamentos");
        break;
      case "obter_equipamento":
        response = await handleGetRecord(req, context, payload, "equipamento");
        break;
      case "criar_equipamento":
        response = await handleEquipment(req, context, payload, "create");
        break;
      case "editar_equipamento":
        response = await handleEquipment(req, context, payload, "edit");
        break;
      case "arquivar_equipamento":
        response = await handleEquipment(req, context, payload, "archive");
        break;
      case "restaurar_equipamento":
        response = await handleEquipment(req, context, payload, "restore");
        break;
      case "listar_manutencoes":
        response = await handleList(req, context, payload, "manutencoes");
        break;
      case "obter_manutencao":
        response = await handleGetRecord(req, context, payload, "manutencao");
        break;
      case "criar_manutencao":
        response = await handleMaintenance(req, context, payload, "create");
        break;
      case "editar_manutencao":
        response = await handleMaintenance(req, context, payload, "edit");
        break;
      case "concluir_manutencao":
        response = await handleMaintenance(req, context, payload, "complete");
        break;
      case "cancelar_manutencao":
        response = await handleMaintenance(req, context, payload, "cancel");
        break;
      case "listar_alertas":
        response = await handleList(req, context, payload, "alertas");
        break;
      case "listar_auditoria":
        response = await handleList(req, context, payload, "auditoria");
        break;
      case "listar_catalogo_metricas":
        response = await handleCatalog(req, context);
        break;
      case "listar_evidencias_backup":
        response = await handleList(req, context, payload, "evidencias_backup");
        break;
      case "registrar_evidencia_backup":
        response = await handleBackupEvidence(req, context, payload);
        break;
      default:
        throw new ApiError(422, "invalid_action", "Ação administrativa inválida.");
    }

    await writeClinicAudit(AUTH_CONFIG, context, {
      entity: "administrative_management",
      action,
      outcome: response.ok ? "success" : "error",
      details: { endpoint: "gestao-administrativa-fichas", status_code: response.status },
    });
    return response;
  } catch (error) {
    if (error instanceof ApiError) {
      await writeClinicAudit(AUTH_CONFIG, context, {
        entity: "administrative_management",
        action: SAFE_ACTION.test(action) ? action : "request",
        outcome: "error",
        details: {
          endpoint: "gestao-administrativa-fichas",
          reason_code: error.code,
          status_code: error.status,
        },
      });
      return fail(req, error.publicMessage, error.status, error.code);
    }
    console.error("Administrative request failed");
    await writeClinicAudit(AUTH_CONFIG, context, {
      entity: "administrative_management",
      action: SAFE_ACTION.test(action) ? action : "request",
      outcome: "error",
      details: { endpoint: "gestao-administrativa-fichas", reason_code: "unhandled_error" },
    });
    return fail(req, "Não foi possível concluir a operação agora.", 500, "internal_error");
  }
}

if (import.meta.main) Deno.serve(handleRequest);

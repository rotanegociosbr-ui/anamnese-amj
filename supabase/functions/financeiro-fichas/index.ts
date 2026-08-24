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
const SOURCE_CLINIC_ID = Deno.env.get("CLINIC_ID") || "";
const AUTH_CONFIG: DualAuthConfig = {
  supabaseUrl: SUPABASE_URL,
  serviceRoleKey: SERVICE_ROLE,
  allowedRoles: ["owner"],
  requireAal2: true,
};

const MAX_BODY_BYTES = 64 * 1024;
const MAX_PAGE_SIZE = 200;
const MAX_AUDIT_SIZE = 200;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SAFE_TECHNICAL_NAME = /^[a-z0-9][a-z0-9_.:-]{1,99}$/;

const ENTRY_TYPES = new Set(["receita", "despesa"]);
const ENTRY_ORIGINS = new Set([
  "atendimento",
  "produto",
  "compra",
  "operacional",
  "ajuste",
]);
const PAYMENT_CONDITIONS = new Set(["avista", "parcelado", "entrada_saldo"]);
const PAYMENT_METHODS = new Set([
  "pix",
  "dinheiro",
  "cartao_debito",
  "cartao_credito",
  "boleto",
  "transferencia",
  "outro",
]);
const CALCULATED_STATUSES = new Set([
  "pendente",
  "parcial",
  "pago",
  "vencido",
  "cancelado",
]);
const PRODUCT_TYPES = new Set([
  "bioestimulador",
  "toxina_botulinica",
  "preenchedor",
  "skinbooster",
  "injetavel",
  "medicamento",
  "dermocosmetico",
  "descartavel",
  "epi",
  "limpeza",
  "revenda",
  "outro",
]);
const PRODUCT_UNITS = new Set([
  "un",
  "u",
  "cx",
  "frasco",
  "seringa",
  "ampola",
  "aplicacao",
  "canula",
  "dose",
  "ml",
  "mg",
  "g",
  "kit",
]);
const SOURCE_KINDS = new Set(["anamnese", "documento_clinico", "agendamento"]);
const PAYMENT_SITUATIONS = new Set(["recebido", "parcial", "pendente"]);
const PATIENT_STATUSES = new Set(["active", "inactive"]);
const DUPLICATE_REVIEW_STATUSES = new Set([
  "pendente",
  "confirmado_distinto",
  "resolvido_existente",
  "descartado",
]);
const DUPLICATE_REVIEW_RESOLUTIONS = new Set([
  "confirmado_distinto",
  "resolvido_existente",
  "descartado",
]);
const PROCEDURE_LABELS: Record<string, string> = {
  toxina_terco_superior: "Toxina botulínica · terço superior",
  toxina_full_face: "Toxina botulínica · full face",
  preenchimento_facial: "Preenchimento facial",
  bioestimulador_colageno: "Bioestimulador de colágeno",
  fios_pdo: "Fios de PDO",
  peeling_quimico: "Peeling químico",
  intradermoterapia: "Intradermoterapia",
  skinbooster: "Skinbooster",
  microagulhamento: "Microagulhamento",
  avaliacao_facial: "Avaliação facial",
  outro: "Outro procedimento",
};
const PROCEDURE_CODES = new Set(Object.keys(PROCEDURE_LABELS));
const FORBIDDEN_PAYMENT_KEYS = new Set([
  "cardnumber",
  "card_number",
  "numerocartao",
  "numero_cartao",
  "pan",
  "cvv",
  "cvc",
  "securitycode",
  "codigo_seguranca",
  "senhacartao",
  "senha_cartao",
  "track1",
  "track2",
]);
const RECENT_PASSWORD_ACTIONS = new Set([
  "editar_cliente",
  "arquivar_cliente",
  "restaurar_cliente",
  "editar_fornecedor",
  "arquivar_fornecedor",
  "restaurar_fornecedor",
  "editar_marca",
  "arquivar_marca",
  "restaurar_marca",
  "editar_produto",
  "arquivar_produto",
  "restaurar_produto",
  "salvar_custo_produto",
  "cancelar_custo_produto",
  "regularizar_item_compra_estoque",
  "cancelar_compra",
  "cancelar_lancamento",
  "estornar_pagamento",
  "resolver_revisao_duplicidade",
]);

const ENTRY_SELECT = [
  "id",
  "clinic_id",
  "patient_id",
  "supplier_id",
  "entry_type",
  "origin",
  "description",
  "category",
  "competence_date",
  "due_date",
  "total_amount",
  "paid_amount",
  "balance",
  "payment_condition",
  "installments",
  "calculated_status",
  "state",
  "notes",
  "created_at",
  "updated_at",
  "version",
].join(",");

const PAYMENT_SELECT = [
  "id",
  "entry_id",
  "movement_type",
  "payment_method",
  "amount",
  "paid_at",
  "installments",
  "reference",
  "reversed_payment_id",
  "created_at",
].join(",");

const INSTALLMENT_SELECT = [
  "id",
  "entry_id",
  "installment_number",
  "due_date",
  "amount",
  "planned_payment_method",
  "paid_amount",
  "balance",
  "calculated_status",
  "state",
  "created_at",
  "updated_at",
].join(",");

class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly publicMessage: string,
    readonly details: JsonRecord | null = null,
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

function validUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function requiredUuid(value: unknown, field: string): string {
  if (!validUuid(value)) {
    throw new ApiError(422, "invalid_" + field, "Identificador inválido.");
  }
  return value.toLowerCase();
}

function optionalUuid(value: unknown, field: string): string | null {
  if (value === null || value === undefined || value === "") return null;
  return requiredUuid(value, field);
}

function normalizeTechnicalKey(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "");
}

function assertNoPaymentSecrets(value: unknown, depth = 0): void {
  if (depth > 8) {
    throw new ApiError(422, "payload_too_deep", "Dados enviados são muito complexos.");
  }
  if (Array.isArray(value)) {
    for (const item of value) assertNoPaymentSecrets(item, depth + 1);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, nested] of Object.entries(value)) {
    const normalized = normalizeTechnicalKey(key);
    if (
      FORBIDDEN_PAYMENT_KEYS.has(normalized) ||
      normalized.includes("cvv") ||
      normalized.includes("cvc") ||
      normalized.includes("cardnumber") ||
      normalized.includes("numerocartao")
    ) {
      throw new ApiError(
        422,
        "payment_secret_forbidden",
        "Não envie número de cartão, senha ou código de segurança.",
      );
    }
    if (["__proto__", "prototype", "constructor"].includes(key)) {
      throw new ApiError(422, "invalid_json_key", "Campo JSON inválido.");
    }
    assertNoPaymentSecrets(nested, depth + 1);
  }
}

function requiredText(
  value: unknown,
  field: string,
  min: number,
  max: number,
): string {
  if (typeof value !== "string") {
    throw new ApiError(422, "invalid_" + field, "Preencha os campos obrigatórios.");
  }
  const normalized = value.trim().replace(/\s+/g, " ");
  const hasControlCharacter = [...normalized].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
  if (
    normalized.length < min || normalized.length > max || hasControlCharacter
  ) {
    throw new ApiError(422, "invalid_" + field, "Campo inválido: " + field + ".");
  }
  return normalized;
}

function optionalText(value: unknown, field: string, max: number): string | null {
  if (value === null || value === undefined || value === "") return null;
  return requiredText(value, field, 1, max);
}

function enumValue(value: unknown, field: string, allowed: ReadonlySet<string>): string {
  const normalized = requiredText(value, field, 1, 100).toLowerCase();
  if (!allowed.has(normalized)) {
    throw new ApiError(422, "invalid_" + field, "Opção inválida: " + field + ".");
  }
  return normalized;
}

function integerValue(
  value: unknown,
  field: string,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined || value === null || value === "") return fallback;
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new ApiError(422, "invalid_" + field, "Número inválido: " + field + ".");
  }
  return number;
}

function booleanValue(value: unknown, field: string, fallback = false): boolean {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value !== "boolean") {
    throw new ApiError(422, "invalid_" + field, "Valor inválido: " + field + ".");
  }
  return value;
}

function expectedVersion(payload: JsonRecord): number {
  const value = payload.version ?? payload.versao;
  if (value === undefined || value === null || value === "") {
    throw new ApiError(422, "version_required", "Informe a versão atual do cadastro.");
  }
  return integerValue(value, "version", 1, 1, 2_147_483_647);
}

function operationId(payload: JsonRecord): string {
  return requiredUuid(payload.operation_id ?? payload.idempotency_key, "operation_id");
}

function operationReason(payload: JsonRecord): string {
  return requiredText(payload.motivo, "motivo", 3, 500);
}

function decimalValue(
  value: unknown,
  field: string,
  decimals: number,
  allowZero = false,
): string {
  let source: string;
  if (typeof value === "number" && Number.isFinite(value)) {
    source = value.toFixed(decimals);
  } else if (typeof value === "string") {
    source = value.trim().replace(",", ".");
  } else {
    throw new ApiError(422, "invalid_" + field, "Valor monetário inválido.");
  }
  const match = /^(\d{1,12})(?:\.(\d{1,4}))?$/.exec(source);
  if (!match || (match[2]?.length || 0) > decimals) {
    throw new ApiError(422, "invalid_" + field, "Valor monetário inválido.");
  }
  const fraction = (match[2] || "").padEnd(decimals, "0");
  const canonical = String(BigInt(match[1])) + (decimals ? "." + fraction : "");
  const numeric = Number(canonical);
  if (!Number.isFinite(numeric) || numeric > 999_999_999_999.99 || (!allowZero && numeric <= 0)) {
    throw new ApiError(422, "invalid_" + field, "Valor monetário inválido.");
  }
  return canonical;
}

function optionalDecimal(
  value: unknown,
  field: string,
  decimals: number,
): string | null {
  if (value === undefined || value === null || value === "") return null;
  return decimalValue(value, field, decimals, true);
}

export function dateValue(value: unknown, field: string, minimumYear = 2000): string {
  const source = requiredText(value, field, 10, 10);
  if (!DATE_PATTERN.test(source)) {
    throw new ApiError(422, "invalid_" + field, "Data inválida.");
  }
  const [year, month, day] = source.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day || year < minimumYear || year > 2100
  ) {
    throw new ApiError(422, "invalid_" + field, "Data inválida.");
  }
  return source;
}

function optionalDate(value: unknown, field: string, minimumYear = 2000): string | null {
  if (value === undefined || value === null || value === "") return null;
  return dateValue(value, field, minimumYear);
}

export function dateKeyInSaoPaulo(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  return `${values.get("year")}-${values.get("month")}-${values.get("day")}`;
}

export function monthStartMonthsAgo(dateKey: string, monthsAgo: number): string {
  const [year, month] = dateKey.split("-").map(Number);
  const monthIndex = year * 12 + (month - 1) - monthsAgo;
  const targetYear = Math.floor(monthIndex / 12);
  const targetMonth = monthIndex - targetYear * 12 + 1;
  return `${targetYear.toString().padStart(4, "0")}-${targetMonth.toString().padStart(2, "0")}-01`;
}

function dateTimeValue(value: unknown, field: string, fallbackNow = false): string {
  if ((value === undefined || value === null || value === "") && fallbackNow) {
    return new Date().toISOString();
  }
  const source = requiredText(value, field, 20, 40);
  const timestamp = Date.parse(source);
  if (!Number.isFinite(timestamp)) {
    throw new ApiError(422, "invalid_" + field, "Data e hora inválidas.");
  }
  const year = new Date(timestamp).getUTCFullYear();
  if (year < 2000 || year > 2100) {
    throw new ApiError(422, "invalid_" + field, "Data e hora inválidas.");
  }
  return new Date(timestamp).toISOString();
}

function normalizeSearchName(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeExactText(value: string): string {
  return normalizeSearchName(value).replace(/\s+/g, "");
}

function normalizeCpf(value: unknown, required = false): string | null {
  if (value === undefined || value === null || value === "") {
    if (required) throw new ApiError(422, "invalid_cpf", "CPF inválido.");
    return null;
  }
  const cpf = String(value).replace(/\D/g, "");
  if (!/^\d{11}$/.test(cpf) || /^(\d)\1{10}$/.test(cpf)) {
    throw new ApiError(422, "invalid_cpf", "CPF inválido.");
  }
  for (let size = 9; size <= 10; size++) {
    let sum = 0;
    for (let index = 0; index < size; index++) sum += Number(cpf[index]) * (size + 1 - index);
    const digit = ((sum * 10) % 11) % 10;
    if (digit !== Number(cpf[size])) {
      throw new ApiError(422, "invalid_cpf", "CPF inválido.");
    }
  }
  return cpf;
}

function normalizePhone(value: unknown, field = "telefone"): string | null {
  if (value === undefined || value === null || value === "") return null;
  let digits = String(value).replace(/\D/g, "");
  if (/^(\d)\1+$/.test(digits)) {
    throw new ApiError(422, "invalid_" + field, "Telefone inválido.");
  }
  if (digits.startsWith("55") && (digits.length === 12 || digits.length === 13)) {
    digits = digits.slice(2);
  }
  if (!/^\d{10,11}$/.test(digits) || digits[0] === "0") {
    throw new ApiError(422, "invalid_" + field, "Telefone inválido.");
  }
  return "+55" + digits;
}

function normalizeEmail(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  const email = requiredText(value, "email", 5, 254).toLowerCase();
  if (!EMAIL_PATTERN.test(email)) {
    throw new ApiError(422, "invalid_email", "E-mail inválido.");
  }
  return email;
}

function normalizeDocument(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  const document = String(value).replace(/\D/g, "");
  if (!/^\d{11,14}$/.test(document)) {
    throw new ApiError(422, "invalid_document", "CPF/CNPJ do fornecedor inválido.");
  }
  return document;
}

function normalizeEan(value: unknown): string | null {
  const raw = optionalText(value, "ean", 24);
  if (raw === null) return null;
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 8 || digits.length > 14) {
    throw new ApiError(422, "invalid_ean", "Informe um EAN/GTIN com 8 a 14 dígitos.");
  }
  return digits;
}

function passesLuhn(digits: string): boolean {
  let sum = 0;
  let doubleDigit = false;
  for (let index = digits.length - 1; index >= 0; index--) {
    let digit = Number(digits[index]);
    if (doubleDigit) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    doubleDigit = !doubleDigit;
  }
  return sum > 0 && sum % 10 === 0;
}

export function referenceContainsPan(reference: string): boolean {
  const candidates = reference.match(/(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g) || [];
  return candidates.some((candidate) => {
    const digits = candidate.replace(/\D/g, "");
    return digits.length >= 13 && digits.length <= 19 && passesLuhn(digits);
  });
}

export function referenceContainsCardSecret(reference: string): boolean {
  return referenceContainsPan(reference) || /(^|[^a-z])(cvv|cvc)([^a-z]|$)/i.test(reference);
}

export function paymentMethodForMovement(
  refund: boolean,
  suppliedMethod: unknown,
  originalMethod: unknown,
): string {
  // Estorno sempre preserva a forma do pagamento original. Um valor enviado
  // pelo navegador nunca pode reclassificar o livro financeiro imutável.
  return enumValue(
    refund ? originalMethod : suppliedMethod,
    "forma_pagamento",
    PAYMENT_METHODS,
  );
}

function safeReference(value: unknown): string | null {
  const reference = optionalText(value, "referencia", 120);
  if (!reference) return null;
  if (
    !/^[\p{L}\p{N} ._\-/#:]+$/u.test(reference) || /\d{9,}/.test(reference) ||
    referenceContainsCardSecret(reference)
  ) {
    throw new ApiError(
      422,
      "invalid_referencia",
      "Use apenas uma referência curta; nunca informe número completo de cartão.",
    );
  }
  return reference;
}

function maskCpf(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{11}$/.test(value)) return null;
  return "***.***.***-" + value.slice(-2);
}

function maskDocument(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const digits = value.replace(/\D/g, "");
  if (digits.length === 11) return maskCpf(digits);
  if (digits.length === 14) return "**.***.***/****-" + digits.slice(-2);
  return digits.length >= 4 ? "***" + digits.slice(-4) : null;
}

function maskEmail(value: unknown): string | null {
  if (typeof value !== "string" || !value.includes("@")) return null;
  const [name, domain] = value.split("@", 2);
  return (name.slice(0, 1) || "*") + "***@" + domain;
}

function phoneSuffix(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const digits = value.replace(/\D/g, "");
  return digits.length >= 4 ? digits.slice(-4) : null;
}

function corsOriginAllowed(origin: string | null): boolean {
  if (origin === null) return true;
  if (
    origin === "https://anamariajacob.com.br" ||
    origin === "https://www.anamariajacob.com.br"
  ) return true;
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
  if (origin && corsOriginAllowed(origin)) {
    headers.set("Access-Control-Allow-Origin", origin);
  }
  return headers;
}

function json(req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: responseHeaders(req),
  });
}

function fail(
  req: Request,
  message: string,
  status: number,
  code?: string,
  details?: JsonRecord | null,
): Response {
  const body: JsonRecord = { erro: message };
  if (code) body.codigo = code;
  if (details) body.dados = details;
  return json(req, body, status);
}

function success(
  req: Request,
  context: DualAuthContext,
  body: JsonRecord,
  status = 200,
): Response {
  return json(req, { ...authResponseFields(context), ...body }, status);
}

async function readJsonBody(req: Request): Promise<JsonRecord> {
  const contentType = req.headers.get("content-type") || "";
  const [mediaType, ...parameters] = contentType.split(";").map((part) =>
    part.trim().toLowerCase()
  );
  if (mediaType !== "application/json") {
    throw new ApiError(415, "content_type_required", "Envie os dados em JSON.");
  }
  for (const parameter of parameters) {
    if (parameter && parameter !== "charset=utf-8") {
      throw new ApiError(415, "invalid_content_type", "Codificação JSON inválida.");
    }
  }
  const declaredLength = Number(req.headers.get("content-length") || "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    throw new ApiError(413, "body_too_large", "A solicitação excede 64 KiB.");
  }
  if (!req.body) throw new ApiError(400, "empty_body", "Envie os dados da operação.");

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new ApiError(413, "body_too_large", "A solicitação excede 64 KiB.");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let parsed: unknown;
  try {
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (!source.trim()) throw new Error("empty");
    parsed = JSON.parse(source);
  } catch {
    throw new ApiError(400, "invalid_json", "JSON inválido.");
  }
  if (!isRecord(parsed)) {
    throw new ApiError(400, "invalid_json_object", "O JSON deve ser um objeto.");
  }
  assertNoPaymentSecrets(parsed);
  return parsed;
}

function tenant(context: DualAuthContext): { clinicId: string; userId: string } {
  if (
    context.authMethod !== "supabase_auth" || context.role !== "owner" ||
    context.aal !== "aal2" || !validUuid(context.clinicId) || !validUuid(context.userId)
  ) {
    throw new ApiError(403, "legacy_auth_forbidden", "Use seu acesso individual com MFA.");
  }
  return { clinicId: context.clinicId, userId: context.userId };
}

async function requireProtectedOperation(
  req: Request,
  context: DualAuthContext,
  payload: JsonRecord,
  action: string,
  targetId: string,
): Promise<void> {
  const protectedOperationId = requiredUuid(payload.operation_id, "operation_id");
  // Os session_id seguem transitoriamente às RPCs privadas; somente HMAC e
  // metadados técnicos da operação são persistidos. JWT/senha nunca vão ao banco.
  try {
    await requireRecentPasswordProof(req, AUTH_CONFIG, context, {
      operationId: protectedOperationId,
      action: `financeiro.${action}`,
      targetId,
    });
  } catch (error) {
    if (error instanceof DualAuthError) {
      if (error.auditContext) {
        await writeClinicAudit(AUTH_CONFIG, error.auditContext, {
          entity: "financial_protected_operation",
          action: "reauthenticate",
          outcome: "denied",
          details: { endpoint: "financeiro-fichas", reason_code: error.code },
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

async function protectedTargetForAction(
  action: string,
  payload: JsonRecord,
  context: DualAuthContext,
): Promise<string> {
  switch (action) {
    case "editar_cliente":
    case "arquivar_cliente":
    case "restaurar_cliente":
      return requiredUuid(payload.id ?? payload.cliente_id, "cliente_id");
    case "editar_fornecedor":
    case "arquivar_fornecedor":
    case "restaurar_fornecedor":
      return requiredUuid(payload.id ?? payload.fornecedor_id, "fornecedor_id");
    case "editar_marca":
    case "arquivar_marca":
    case "restaurar_marca":
      return requiredUuid(payload.id ?? payload.marca_id, "marca_id");
    case "editar_produto":
    case "arquivar_produto":
    case "restaurar_produto":
    case "salvar_custo_produto":
      return requiredUuid(payload.id ?? payload.produto_id, "produto_id");
    case "cancelar_custo_produto":
      return requiredUuid(payload.custo_id ?? payload.id, "custo_id");
    case "regularizar_item_compra_estoque":
      return requiredUuid(
        payload.item_compra_id ?? payload.purchase_item_id,
        "item_compra_id",
      );
    case "estornar_pagamento":
      return requiredUuid(payload.pagamento_id ?? payload.payment_id, "pagamento_id");
    case "cancelar_lancamento":
      return requiredUuid(
        payload.lancamento_id ?? payload.entry_id,
        "lancamento_id",
      );
    case "cancelar_compra": {
      const { clinicId } = tenant(context);
      const suppliedPurchaseId = optionalUuid(
        payload.id ?? payload.compra_id,
        "compra_id",
      );
      const suppliedEntryId = suppliedPurchaseId ? null : requiredUuid(
        payload.lancamento_id ?? payload.entry_id,
        "lancamento_id",
      );
      const purchase = await getPurchase(
        clinicId,
        suppliedPurchaseId,
        suppliedEntryId,
      );
      if (!purchase || !validUuid(purchase.id)) {
        throw new ApiError(404, "purchase_not_found", "Compra não encontrada.");
      }
      return purchase.id;
    }
    case "resolver_revisao_duplicidade":
      enumValue(
        payload.resolucao ?? payload.status,
        "resolucao",
        DUPLICATE_REVIEW_RESOLUTIONS,
      );
      requiredText(payload.motivo, "motivo", 10, 500);
      expectedVersion(payload);
      return requiredUuid(
        payload.revisao_id ?? payload.review_id ?? payload.id,
        "revisao_id",
      );
    default:
      throw new ApiError(
        500,
        "protected_scope_missing",
        "Operação protegida sem escopo seguro.",
      );
  }
}

async function admin(
  path: string,
  method = "GET",
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<AdminResult> {
  if (!SUPABASE_URL || !SERVICE_ROLE) {
    throw new ApiError(503, "backend_unavailable", "Serviço financeiro indisponível.");
  }
  let response: Response;
  try {
    response = await fetch(SUPABASE_URL + path, {
      method,
      headers: {
        apikey: SERVICE_ROLE,
        Authorization: "Bearer " + SERVICE_ROLE,
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
    const text = await response.text();
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
    }
  }
  return { response, data };
}

function encode(value: string): string {
  return encodeURIComponent(value);
}

function inFilter(values: string[]): string {
  return "(" + values.map(encode).join(",") + ")";
}

function postgresMessage(result: AdminResult): string {
  return isRecord(result.data) && typeof result.data.message === "string"
    ? result.data.message
    : "";
}

function mapDatabaseError(
  result: AdminResult,
  fallbackCode: string,
  fallbackMessage: string,
): never {
  const message = postgresMessage(result);
  const mappings: Record<string, [number, string, string]> = {
    lancamento_nao_encontrado: [404, "entry_not_found", "Lançamento não encontrado."],
    lancamento_inativo: [409, "entry_inactive", "O lançamento não está ativo."],
    valor_excede_saldo: [409, "amount_exceeds_balance", "O valor excede o saldo do lançamento."],
    pagamento_original_nao_encontrado: [404, "payment_not_found", "Pagamento não encontrado."],
    valor_excede_estornavel: [
      409,
      "amount_exceeds_reversible",
      "O valor excede o saldo que pode ser estornado.",
    ],
    lancamento_com_pagamento: [
      409,
      "entry_has_payment",
      "Estorne os pagamentos antes de cancelar.",
    ],
    fornecedor_invalido: [422, "invalid_supplier", "Fornecedor inválido."],
    produto_invalido: [422, "invalid_product", "Produto inválido."],
    itens_invalidos: [422, "invalid_items", "Itens da compra inválidos."],
    total_invalido: [422, "invalid_total", "Total da compra inválido."],
    estorno_invalido: [422, "invalid_refund", "Estorno inválido."],
    tipo_movimento_invalido: [422, "invalid_movement", "Movimento financeiro inválido."],
    idempotency_key_reused: [
      409,
      "idempotency_key_reused",
      "Use uma nova chave para dados diferentes.",
    ],
    source_already_linked: [
      409,
      "source_already_linked",
      "Este registro de origem já está vinculado a outro cliente.",
    ],
    source_pair_invalid: [422, "incomplete_source", "Informe a origem completa do cliente."],
    possible_duplicate: [
      409,
      "possible_duplicate",
      "Já existe um cliente com o mesmo CPF ou telefone.",
    ],
    period_invalid: [422, "invalid_period", "Período inválido."],
    purchase_cancel_requires_full_workflow: [
      409,
      "purchase_cancel_requires_full_workflow",
      "Uma compra não pode ser cancelada parcialmente.",
    ],
    purchase_exact_duplicate: [
      409,
      "purchase_exact_duplicate",
      "Esta compra já foi cadastrada. Abra o registro existente.",
    ],
    purchase_possible_duplicate: [
      409,
      "purchase_possible_duplicate",
      "Há uma compra muito parecida já cadastrada. Confira antes de continuar.",
    ],
    purchase_duplicate_confirmation_stale: [
      409,
      "purchase_duplicate_confirmation_stale",
      "A compra parecida mudou. Confira novamente antes de continuar.",
    ],
    parcelas_invalidas: [422, "invalid_installments", "As parcelas informadas são inválidas."],
    parcela_data_ou_forma_invalida: [
      422,
      "invalid_installment_due_or_method",
      "Confira as datas e a forma de pagamento das parcelas.",
    ],
    parcelas_nao_sequenciais: [
      422,
      "invalid_installment_sequence",
      "As parcelas devem estar numeradas em sequência.",
    ],
    lancamento_sem_saldo: [409, "entry_has_no_balance", "Este lançamento já está quitado."],
    parcelas_soma_diverge_saldo: [
      409,
      "installment_total_mismatch",
      "A soma das parcelas deve ser exatamente igual ao saldo restante.",
    ],
    parcelas_com_pagamentos: [
      409,
      "installments_have_payments",
      "Não é possível reprogramar parcelas que já possuem recebimentos.",
    ],
    parcela_nao_encontrada: [404, "installment_not_found", "Parcela não encontrada."],
    parcela_inativa: [409, "installment_inactive", "Esta parcela não está ativa."],
    pagamento_nao_pertence_parcela: [
      409,
      "payment_installment_mismatch",
      "O pagamento não pertence a esta parcela.",
    ],
    pagamento_vinculado_outra_parcela: [
      409,
      "payment_already_linked",
      "O pagamento já está ligado a outra parcela.",
    ],
    valor_excede_saldo_parcela: [
      409,
      "amount_exceeds_installment_balance",
      "O valor excede o saldo desta parcela.",
    ],
    version_conflict: [
      409,
      "version_conflict",
      "Este cadastro foi alterado em outro acesso. Recarregue os dados e tente novamente.",
    ],
    registro_arquivado: [409, "record_archived", "O cadastro está arquivado."],
    motivo_invalido: [422, "invalid_reason", "Informe um motivo válido."],
    cliente_nao_encontrado: [404, "client_not_found", "Cliente não encontrado."],
    fornecedor_nao_encontrado: [404, "supplier_not_found", "Fornecedor não encontrado."],
    marca_nao_encontrada: [404, "brand_not_found", "Marca não encontrada."],
    produto_nao_encontrado: [404, "product_not_found", "Produto não encontrado."],
    custo_nao_encontrado: [404, "product_cost_not_found", "Custo não encontrado."],
    custo_ja_cancelado: [409, "product_cost_already_cancelled", "Este custo já foi cancelado."],
    cancelamento_custo_parametros_invalidos: [
      422,
      "invalid_product_cost_cancellation",
      "Revise o custo e a confirmação do cancelamento.",
    ],
    marca_invalida: [422, "invalid_brand", "Marca inválida ou arquivada."],
    custo_total_diverge: [
      422,
      "cost_total_mismatch",
      "O custo total deve corresponder à quantidade multiplicada pelo custo unitário.",
    ],
    compra_nao_encontrada: [404, "purchase_not_found", "Compra não encontrada."],
    compra_ja_cancelada: [409, "purchase_already_cancelled", "A compra já foi cancelada."],
    item_compra_nao_encontrado: [404, "purchase_item_not_found", "Item de compra não encontrado."],
    regularizacao_item_conflitante: [
      409,
      "stock_regularization_conflict",
      "Este item já foi regularizado com outros dados. Recarregue a lista.",
    ],
    regularizacao_parametros_invalidos: [
      422,
      "invalid_stock_regularization",
      "Revise o lote, a validade e os dados da regularização.",
    ],
    validade_anterior_compra: [
      422,
      "expiry_before_purchase",
      "A validade não pode ser anterior à data da compra.",
    ],
    stock_control_disabled: [
      409,
      "stock_control_disabled",
      "O produto não está habilitado para controle de estoque.",
    ],
    stock_insufficient: [
      409,
      "stock_insufficient",
      "O saldo do lote é insuficiente para concluir esta operação.",
    ],
    stock_purchase_consumed: [
      409,
      "purchase_stock_already_consumed",
      "Esta compra não pode ser cancelada porque um de seus lotes já teve consumo posterior. Registre um ajuste compensatório separado.",
    ],
    stock_product_configuration_locked: [
      409,
      "stock_product_configuration_locked",
      "A unidade e o controle de estoque não podem ser alterados depois do primeiro movimento deste produto.",
    ],
    stock_product_has_balance: [
      409,
      "stock_product_has_balance",
      "Este produto ainda possui saldo em estoque e não pode ser arquivado.",
    ],
    compra_lancamento_inconsistente: [
      409,
      "purchase_entry_inconsistent",
      "A compra possui vínculo financeiro inconsistente e não foi alterada.",
    ],
    duplicate_review_invalid_arguments: [
      422,
      "invalid_duplicate_review",
      "Confira a revisão de duplicidade e tente novamente.",
    ],
    duplicate_review_resolution_invalid: [
      422,
      "invalid_duplicate_resolution",
      "Escolha uma decisão válida para a duplicidade.",
    ],
    duplicate_review_reason_invalid: [
      422,
      "invalid_duplicate_reason",
      "Informe um motivo detalhado entre 10 e 500 caracteres.",
    ],
    duplicate_review_not_found: [
      404,
      "duplicate_review_not_found",
      "Revisão de duplicidade não encontrada.",
    ],
    duplicate_review_already_resolved: [
      409,
      "duplicate_review_already_resolved",
      "Esta revisão já foi encerrada. Atualize a lista.",
    ],
    duplicate_review_version_conflict: [
      409,
      "duplicate_review_version_conflict",
      "Esta revisão foi alterada em outro acesso. Atualize a lista.",
    ],
    duplicate_review_operation_reused: [
      409,
      "duplicate_review_operation_reused",
      "Esta confirmação já foi usada para outra decisão.",
    ],
  };
  for (const [needle, mapped] of Object.entries(mappings)) {
    if (message.includes(needle)) throw new ApiError(...mapped);
  }
  if (result.response.status === 409 || message.includes("duplicate key")) {
    throw new ApiError(409, "conflict", "Já existe um cadastro com estes dados.");
  }
  if (result.response.status === 404) {
    throw new ApiError(502, fallbackCode, fallbackMessage);
  }
  if (result.response.status >= 500) {
    throw new ApiError(503, "database_unavailable", "Banco temporariamente indisponível.");
  }
  throw new ApiError(422, fallbackCode, fallbackMessage);
}

async function rpc(name: string, body: JsonRecord): Promise<unknown> {
  const result = await admin("/rest/v1/rpc/" + name, "POST", body);
  if (!result.response.ok) {
    mapDatabaseError(result, "financial_operation_failed", "Não foi possível concluir a operação.");
  }
  return result.data;
}

async function deterministicUuid(namespace: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(namespace)),
  );
  const bytes = digest.slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${
    hex.slice(20)
  }`;
}

async function financeAudit(
  context: DualAuthContext,
  entity: string,
  entityId: string | null,
  action: string,
  details: JsonRecord = {},
): Promise<void> {
  const { clinicId, userId } = tenant(context);
  if (!SAFE_TECHNICAL_NAME.test(entity) || !SAFE_TECHNICAL_NAME.test(action)) return;
  const safeDetails: JsonRecord = {};
  for (const [key, value] of Object.entries(details)) {
    if (!/^[a-z0-9_]{1,40}$/.test(key)) continue;
    if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) {
      safeDetails[key] = value;
    } else if (typeof value === "string" && /^[a-z0-9_.:-]{1,80}$/i.test(value)) {
      safeDetails[key] = value;
    }
  }
  const result = await admin(
    "/rest/v1/financeiro_auditoria",
    "POST",
    {
      clinic_id: clinicId,
      actor_id: userId,
      entity,
      entity_id: entityId,
      action,
      details: safeDetails,
      request_id: context.requestId,
    },
    { Prefer: "return=minimal" },
  );
  if (!result.response.ok) console.error("Financial audit write failed", result.response.status);
}

function numberFrom(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function nullableDecimalEqual(stored: unknown, expected: string | null): boolean {
  if (stored === null || stored === undefined) return expected === null;
  if (expected === null) return false;
  return numberFrom(stored) === numberFrom(expected);
}

function sameTimestamp(left: unknown, right: string): boolean {
  return typeof left === "string" && Date.parse(left) === Date.parse(right);
}

async function paymentForms(): Promise<JsonRecord[]> {
  // Catálogo global, sem clinic_id por desenho da migration. Não contém dado de cliente.
  const result = await admin(
    "/rest/v1/financeiro_formas_pagamento?select=code,label,sort_order,active&active=eq.true&order=sort_order.asc",
  );
  if (!result.response.ok) {
    throw new ApiError(
      502,
      "payment_methods_read_failed",
      "Não foi possível ler as formas de pagamento.",
    );
  }
  return rows(result.data).map((row) => ({
    codigo: row.code,
    nome: row.label,
    ordem: row.sort_order,
    ativo: row.active,
  }));
}

async function assertPaymentMethodActive(method: string): Promise<void> {
  // Catálogo global e sem dados pessoais. Estornos não usam este gate para que
  // um pagamento histórico continue reversível mesmo se a forma for desativada.
  const result = await admin(
    "/rest/v1/financeiro_formas_pagamento?select=code" +
      `&code=eq.${encode(method)}&active=eq.true&limit=1`,
  );
  if (!result.response.ok) {
    throw new ApiError(
      502,
      "payment_method_check_failed",
      "Não foi possível conferir a forma de pagamento.",
    );
  }
  if (!rows(result.data).length) {
    throw new ApiError(422, "inactive_payment_method", "Forma de pagamento indisponível.");
  }
}

function centsFromCanonical(value: string): bigint {
  return BigInt(value.replace(".", ""));
}

async function installmentSchedule(
  value: unknown,
  minimumDate: string,
  expectedBalance: string,
): Promise<JsonRecord[]> {
  if (!Array.isArray(value) || value.length < 1 || value.length > 120) {
    throw new ApiError(
      422,
      "invalid_installments",
      "Informe as parcelas do saldo, com valor e data de cada vencimento.",
    );
  }
  const parsed = value.map((raw, index) => {
    if (!isRecord(raw)) {
      throw new ApiError(422, "invalid_installments", "Parcela inválida.");
    }
    const number = integerValue(
      raw.numero ?? raw.installment_number,
      `parcela_${index + 1}_numero`,
      index + 1,
      1,
      120,
    );
    const due = dateValue(raw.vencimento ?? raw.due_date, `parcela_${number}_vencimento`);
    if (due < minimumDate) {
      throw new ApiError(
        422,
        "invalid_installment_due_date",
        "O vencimento de uma parcela não pode ser anterior ao atendimento.",
      );
    }
    const amount = decimalValue(raw.valor ?? raw.amount, `parcela_${number}_valor`, 2);
    const method = enumValue(
      raw.forma_pagamento ?? raw.planned_payment_method,
      `parcela_${number}_forma_pagamento`,
      PAYMENT_METHODS,
    );
    return {
      numero: number,
      vencimento: due,
      valor: amount,
      forma_pagamento: method,
    };
  }).sort((left, right) => Number(left.numero) - Number(right.numero));

  parsed.forEach((item, index) => {
    if (item.numero !== index + 1) {
      throw new ApiError(
        422,
        "invalid_installment_sequence",
        "As parcelas devem estar numeradas em sequência.",
      );
    }
  });
  const total = parsed.reduce(
    (sum, item) => sum + centsFromCanonical(String(item.valor)),
    0n,
  );
  if (total !== centsFromCanonical(expectedBalance)) {
    throw new ApiError(
      422,
      "installment_total_mismatch",
      "A soma das parcelas deve ser exatamente igual ao saldo restante.",
    );
  }
  await Promise.all(
    [...new Set(parsed.map((item) => String(item.forma_pagamento)))]
      .map(assertPaymentMethodActive),
  );
  return parsed;
}

async function relatedNames(
  clinicId: string,
  table: "patients" | "financeiro_fornecedores",
  ids: string[],
): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter(validUuid))];
  if (!unique.length) return new Map();
  const nameColumn = table === "patients" ? "full_name" : "name";
  const result = await admin(
    `/rest/v1/${table}?select=id,${nameColumn}&clinic_id=eq.${encode(clinicId)}&id=in.${
      inFilter(unique)
    }`,
  );
  if (!result.response.ok) return new Map();
  return new Map(
    rows(result.data)
      .filter((row) => typeof row.id === "string" && typeof row[nameColumn] === "string")
      .map((row) => [row.id as string, row[nameColumn] as string]),
  );
}

async function paymentsForEntries(
  clinicId: string,
  entryIds: string[],
): Promise<Map<string, JsonRecord[]>> {
  const unique = [...new Set(entryIds.filter(validUuid))];
  const grouped = new Map<string, JsonRecord[]>();
  if (!unique.length) return grouped;
  const result = await admin(
    `/rest/v1/financeiro_pagamentos?select=${PAYMENT_SELECT}` +
      `&clinic_id=eq.${encode(clinicId)}&entry_id=in.${inFilter(unique)}` +
      "&order=paid_at.desc&limit=1000",
  );
  if (!result.response.ok) {
    throw new ApiError(502, "payments_read_failed", "Não foi possível ler os pagamentos.");
  }
  const paymentRows = rows(result.data);
  const paymentIds = paymentRows.map((row) => row.id).filter(validUuid);
  const installmentByPayment = new Map<string, string>();
  if (paymentIds.length) {
    const links = await admin(
      "/rest/v1/financeiro_parcela_pagamentos?select=payment_id,installment_id" +
        `&clinic_id=eq.${encode(clinicId)}&payment_id=in.${inFilter(paymentIds)}` +
        `&limit=${Math.min(paymentIds.length, 1000)}`,
    );
    if (!links.response.ok) {
      throw new ApiError(
        502,
        "payment_links_read_failed",
        "Não foi possível ler os vínculos das parcelas.",
      );
    }
    for (const link of rows(links.data)) {
      if (typeof link.payment_id === "string" && typeof link.installment_id === "string") {
        installmentByPayment.set(link.payment_id, link.installment_id);
      }
    }
  }
  for (const row of paymentRows) {
    if (typeof row.entry_id !== "string") continue;
    const list = grouped.get(row.entry_id) || [];
    list.push({
      id: row.id,
      parcela_id: typeof row.id === "string" ? installmentByPayment.get(row.id) || null : null,
      tipo: row.movement_type,
      forma: row.payment_method,
      valor: numberFrom(row.amount),
      pago_em: row.paid_at,
      parcelas: row.installments,
      referencia: row.reference,
      pagamento_estornado_id: row.reversed_payment_id,
      criado_em: row.created_at,
    });
    grouped.set(row.entry_id, list);
  }
  return grouped;
}

async function installmentsForEntries(
  clinicId: string,
  entryIds: string[],
): Promise<Map<string, JsonRecord[]>> {
  const unique = [...new Set(entryIds.filter(validUuid))];
  const grouped = new Map<string, JsonRecord[]>();
  if (!unique.length) return grouped;
  const result = await admin(
    `/rest/v1/financeiro_parcelas_resumo?select=${INSTALLMENT_SELECT}` +
      `&clinic_id=eq.${encode(clinicId)}&entry_id=in.${inFilter(unique)}` +
      "&state=eq.ativa&order=entry_id.asc,installment_number.asc&limit=1000",
  );
  if (!result.response.ok) {
    throw new ApiError(
      502,
      "installments_read_failed",
      "Não foi possível ler as parcelas previstas.",
    );
  }
  for (const row of rows(result.data)) {
    if (typeof row.entry_id !== "string") continue;
    const list = grouped.get(row.entry_id) || [];
    list.push({
      id: row.id,
      numero: row.installment_number,
      vencimento: row.due_date,
      valor: numberFrom(row.amount),
      valor_pago: numberFrom(row.paid_amount),
      saldo: numberFrom(row.balance),
      forma_pagamento: row.planned_payment_method,
      status: row.calculated_status,
      estado: row.state,
      criado_em: row.created_at,
      atualizado_em: row.updated_at,
    });
    grouped.set(row.entry_id, list);
  }
  return grouped;
}

async function purchasesForEntries(
  clinicId: string,
  entryIds: string[],
): Promise<Map<string, JsonRecord>> {
  const grouped = new Map<string, JsonRecord>();
  const uniqueEntries = [...new Set(entryIds.filter(validUuid))];
  if (!uniqueEntries.length) return grouped;
  const purchaseResult = await admin(
    "/rest/v1/financeiro_compras?select=id,expense_entry_id,supplier_id,purchase_date," +
      "invoice_number,payment_condition,installments,items_subtotal,freight_amount," +
      "total_amount,state,cancelled_at,version" +
      `&clinic_id=eq.${encode(clinicId)}&expense_entry_id=in.${inFilter(uniqueEntries)}` +
      `&limit=${uniqueEntries.length}`,
  );
  if (!purchaseResult.response.ok) {
    throw new ApiError(502, "purchases_read_failed", "Não foi possível ler as compras vinculadas.");
  }
  const purchases = rows(purchaseResult.data);
  const purchaseIds = purchases.map((row) => row.id).filter(validUuid);
  const itemsByPurchase = new Map<string, JsonRecord[]>();
  if (purchaseIds.length) {
    const itemResult = await admin(
      "/rest/v1/financeiro_compra_itens?select=id,purchase_id,product_id,quantity," +
        "unit_cost,total_amount,position,lot,expiry,allocated_freight,landed_unit_cost" +
        `&clinic_id=eq.${encode(clinicId)}&purchase_id=in.${inFilter(purchaseIds)}` +
        `&order=purchase_id.asc,position.asc&limit=${Math.min(purchaseIds.length * 50, 5000)}`,
    );
    if (!itemResult.response.ok) {
      throw new ApiError(
        502,
        "purchase_items_read_failed",
        "Não foi possível ler os itens das compras.",
      );
    }
    for (const item of rows(itemResult.data)) {
      if (!validUuid(item.purchase_id)) continue;
      const list = itemsByPurchase.get(item.purchase_id) || [];
      list.push({
        id: item.id,
        produto_id: item.product_id,
        quantidade: numberFrom(item.quantity),
        custo_unitario: numberFrom(item.unit_cost),
        valor_total: numberFrom(item.total_amount),
        posicao: item.position,
        lote: item.lot,
        validade: item.expiry,
        frete_rateado: numberFrom(item.allocated_freight),
        custo_unitario_efetivo: numberFrom(item.landed_unit_cost),
      });
      itemsByPurchase.set(item.purchase_id, list);
    }
  }
  for (const purchase of purchases) {
    if (!validUuid(purchase.expense_entry_id) || !validUuid(purchase.id)) continue;
    grouped.set(purchase.expense_entry_id, {
      id: purchase.id,
      fornecedor_id: purchase.supplier_id,
      data_compra: purchase.purchase_date,
      nota_fiscal: purchase.invoice_number,
      condicao_pagamento: purchase.payment_condition,
      parcelas: purchase.installments,
      subtotal_itens: numberFrom(purchase.items_subtotal),
      frete: numberFrom(purchase.freight_amount),
      valor_total: numberFrom(purchase.total_amount),
      estado: purchase.state,
      cancelada_em: purchase.cancelled_at,
      versao: purchase.version,
      itens: itemsByPurchase.get(purchase.id) || [],
    });
  }
  return grouped;
}

async function attendancesForEntries(
  clinicId: string,
  entryIds: string[],
): Promise<Map<string, JsonRecord>> {
  const grouped = new Map<string, JsonRecord>();
  const unique = [...new Set(entryIds.filter(validUuid))];
  if (!unique.length) return grouped;
  const result = await admin(
    "/rest/v1/atendimentos_realizados?select=id,financial_entry_id,patient_id," +
      "appointment_id,protocol_id,procedure_kind,attended_at,status,archived_at" +
      `&clinic_id=eq.${encode(clinicId)}&financial_entry_id=in.${inFilter(unique)}` +
      `&limit=${unique.length}`,
  );
  if (!result.response.ok) {
    throw new ApiError(
      502,
      "attendances_read_failed",
      "Não foi possível ler os procedimentos vinculados.",
    );
  }
  for (const row of rows(result.data)) {
    if (!validUuid(row.financial_entry_id)) continue;
    grouped.set(row.financial_entry_id, {
      id: row.id,
      paciente_id: row.patient_id,
      agendamento_id: row.appointment_id,
      prontuario_id: row.protocol_id,
      tipo_procedimento: row.procedure_kind,
      realizado_em: row.attended_at,
      status: row.status,
      arquivado_em: row.archived_at,
    });
  }
  return grouped;
}

async function presentEntries(clinicId: string, rawRows: JsonRecord[]): Promise<JsonRecord[]> {
  const patientIds = rawRows.map((row) => row.patient_id).filter(validUuid);
  const supplierIds = rawRows.map((row) => row.supplier_id).filter(validUuid);
  const entryIds = rawRows.map((row) => row.id).filter(validUuid);
  const [patientNames, supplierNames, payments, installments, purchases, attendances] =
    await Promise.all([
      relatedNames(clinicId, "patients", patientIds),
      relatedNames(clinicId, "financeiro_fornecedores", supplierIds),
      paymentsForEntries(clinicId, entryIds),
      installmentsForEntries(clinicId, entryIds),
      purchasesForEntries(clinicId, entryIds),
      attendancesForEntries(clinicId, entryIds),
    ]);
  return rawRows.map((row) => {
    const patientId = typeof row.patient_id === "string" ? row.patient_id : null;
    const supplierId = typeof row.supplier_id === "string" ? row.supplier_id : null;
    const id = typeof row.id === "string" ? row.id : "";
    return {
      id,
      tipo: row.entry_type,
      origem: row.origin,
      descricao: row.description,
      categoria: row.category,
      competencia: row.competence_date,
      vencimento: row.due_date,
      valor_total: numberFrom(row.total_amount),
      valor_pago: numberFrom(row.paid_amount),
      saldo: numberFrom(row.balance),
      condicao_pagamento: row.payment_condition,
      parcelas: row.installments,
      status: row.calculated_status,
      estado: row.state,
      observacoes: row.notes,
      patient_name: patientId ? patientNames.get(patientId) || "Cliente" : null,
      supplier_name: supplierId ? supplierNames.get(supplierId) || "Fornecedor" : null,
      cliente: patientId ? { id: patientId, nome: patientNames.get(patientId) || "Cliente" } : null,
      fornecedor: supplierId
        ? { id: supplierId, nome: supplierNames.get(supplierId) || "Fornecedor" }
        : null,
      pagamentos: payments.get(id) || [],
      parcelas_previstas: installments.get(id) || [],
      compra: purchases.get(id) || null,
      atendimento: attendances.get(id) || null,
      criado_em: row.created_at,
      atualizado_em: row.updated_at,
      versao: row.version,
    };
  });
}

function entryListPath(
  clinicId: string,
  payload: JsonRecord,
  limit: number,
  offset: number,
): string {
  let path = `/rest/v1/financeiro_lancamentos_resumo?select=${ENTRY_SELECT}` +
    `&clinic_id=eq.${encode(clinicId)}`;
  const from = optionalDate(payload.de, "de");
  const through = optionalDate(payload.ate, "ate");
  if (from) path += `&competence_date=gte.${encode(from)}`;
  if (through) path += `&competence_date=lte.${encode(through)}`;
  if (from && through && from > through) {
    throw new ApiError(422, "invalid_period", "Período inválido.");
  }
  if (payload.tipo !== undefined && payload.tipo !== null && payload.tipo !== "") {
    const type = enumValue(payload.tipo, "tipo", ENTRY_TYPES);
    path += `&entry_type=eq.${encode(type)}`;
  }
  if (payload.status !== undefined && payload.status !== null && payload.status !== "") {
    const status = enumValue(payload.status, "status", CALCULATED_STATUSES);
    path += `&calculated_status=eq.${encode(status)}`;
  }
  return path + `&order=competence_date.desc,created_at.desc&limit=${limit}&offset=${offset}`;
}

async function fetchEntries(
  clinicId: string,
  payload: JsonRecord,
  limit: number,
  offset = 0,
): Promise<{ entries: JsonRecord[]; hasMore: boolean }> {
  const result = await admin(entryListPath(clinicId, payload, limit + 1, offset));
  if (!result.response.ok) {
    throw new ApiError(502, "entries_read_failed", "Não foi possível ler os lançamentos.");
  }
  const raw = rows(result.data);
  const hasMore = raw.length > limit;
  return { entries: await presentEntries(clinicId, raw.slice(0, limit)), hasMore };
}

async function handleSummary(
  req: Request,
  context: DualAuthContext,
  payload: JsonRecord,
): Promise<Response> {
  const { clinicId } = tenant(context);
  const from = optionalDate(payload.de, "de");
  const through = optionalDate(payload.ate, "ate");
  if (from && through && from > through) {
    throw new ApiError(422, "invalid_period", "Período inválido.");
  }
  const flowFrom = monthStartMonthsAgo(dateKeyInSaoPaulo(), 11);
  const flowPath = "/rest/v1/financeiro_fluxo_mensal?select=" +
    "month,billed_revenue,received_revenue,incurred_expense,paid_expense,net_cash_flow" +
    `&clinic_id=eq.${encode(clinicId)}&month=gte.${encode(flowFrom)}&order=month.asc&limit=24`;

  const [summaryResult, flowResult, forms, recent] = await Promise.all([
    rpc("financeiro_resumo", {
      p_clinic_id: clinicId,
      p_from: from,
      p_through: through,
    }),
    admin(flowPath),
    paymentForms(),
    fetchEntries(clinicId, {}, 10),
  ]);
  if (!flowResult.response.ok || !isRecord(summaryResult)) {
    throw new ApiError(
      502,
      "summary_read_failed",
      "Não foi possível carregar o resumo financeiro.",
    );
  }
  const summary = {
    receita_recebida: numberFrom(summaryResult.receita_recebida),
    despesa_paga: numberFrom(summaryResult.despesa_paga),
    fluxo_liquido: numberFrom(summaryResult.fluxo_liquido),
    contas_receber: numberFrom(summaryResult.contas_receber),
    contas_pagar: numberFrom(summaryResult.contas_pagar),
    receita_faturada: numberFrom(summaryResult.receita_faturada),
    despesa_incorrida: numberFrom(summaryResult.despesa_incorrida),
  };
  const flow = rows(flowResult.data).map((row) => ({
    mes: row.month,
    receita_faturada: numberFrom(row.billed_revenue),
    receita_recebida: numberFrom(row.received_revenue),
    despesa_incorrida: numberFrom(row.incurred_expense),
    despesa_paga: numberFrom(row.paid_expense),
    fluxo_liquido: numberFrom(row.net_cash_flow),
  }));
  return success(req, context, {
    resumo: summary,
    fluxo_mensal: flow,
    formas_pagamento: forms,
    ultimos_lancamentos: recent.entries,
  });
}

async function handleListEntries(
  req: Request,
  context: DualAuthContext,
  payload: JsonRecord,
): Promise<Response> {
  const { clinicId } = tenant(context);
  const page = integerValue(payload.pagina, "pagina", 1, 1, 100_000);
  const pageSize = integerValue(payload.por_pagina, "por_pagina", 50, 1, MAX_PAGE_SIZE);
  const result = await fetchEntries(clinicId, payload, pageSize, (page - 1) * pageSize);
  return success(req, context, {
    lancamentos: result.entries,
    paginacao: { pagina: page, por_pagina: pageSize, tem_mais: result.hasMore },
  });
}

async function getEntryById(clinicId: string, id: string): Promise<JsonRecord | null> {
  const result = await admin(
    `/rest/v1/financeiro_lancamentos_resumo?select=${ENTRY_SELECT}` +
      `&clinic_id=eq.${encode(clinicId)}&id=eq.${encode(id)}&limit=1`,
  );
  if (!result.response.ok) {
    throw new ApiError(502, "entry_read_failed", "Não foi possível ler o lançamento.");
  }
  return rows(result.data)[0] || null;
}

async function getEntryByIdempotency(clinicId: string, key: string): Promise<JsonRecord | null> {
  const result = await admin(
    "/rest/v1/financeiro_lancamentos?select=id,patient_id,supplier_id,entry_type,origin," +
      "description,category,competence_date,due_date,total_amount,payment_condition,installments,notes" +
      `&clinic_id=eq.${encode(clinicId)}&idempotency_key=eq.${encode(key)}&limit=1`,
  );
  if (!result.response.ok) {
    throw new ApiError(502, "idempotency_read_failed", "Não foi possível validar a solicitação.");
  }
  return rows(result.data)[0] || null;
}

async function assertParty(
  clinicId: string,
  table: "patients" | "financeiro_fornecedores" | "financeiro_marcas" | "financeiro_produtos",
  id: string,
  errorCode: string,
): Promise<void> {
  const archived = table === "patients" || table.startsWith("financeiro_")
    ? "&archived_at=is.null"
    : "";
  const result = await admin(
    `/rest/v1/${table}?select=id&clinic_id=eq.${encode(clinicId)}&id=eq.${
      encode(id)
    }${archived}&limit=1`,
  );
  if (!result.response.ok || !rows(result.data).length) {
    throw new ApiError(422, errorCode, "Cadastro relacionado inválido.");
  }
}

async function handleCreateEntry(
  req: Request,
  context: DualAuthContext,
  payload: JsonRecord,
): Promise<Response> {
  const { clinicId, userId } = tenant(context);
  const key = requiredUuid(
    payload.idempotency_key ?? payload.operation_id,
    "idempotency_key",
  );
  const type = enumValue(payload.tipo, "tipo", ENTRY_TYPES);
  const origin = enumValue(payload.origem, "origem", ENTRY_ORIGINS);
  const patientId = optionalUuid(payload.cliente_id ?? payload.patient_id, "cliente_id");
  const supplierId = optionalUuid(payload.fornecedor_id ?? payload.supplier_id, "fornecedor_id");
  const description = requiredText(payload.descricao, "descricao", 2, 200);
  const category = requiredText(payload.categoria, "categoria", 2, 100);
  const competence = dateValue(payload.competencia ?? payload.data_competencia, "competencia");
  const due = dateValue(payload.vencimento, "vencimento");
  const total = decimalValue(payload.valor_total, "valor_total", 2);
  const condition = enumValue(payload.condicao_pagamento, "condicao_pagamento", PAYMENT_CONDITIONS);
  const installments = integerValue(payload.parcelas, "parcelas", 1, 1, 120);
  const notes = optionalText(payload.observacoes, "observacoes", 1000);
  if (type === "receita" && !patientId && origin !== "ajuste") {
    throw new ApiError(422, "client_required", "Selecione o cliente da receita.");
  }
  if (patientId) await assertParty(clinicId, "patients", patientId, "invalid_client");
  if (supplierId) {
    await assertParty(clinicId, "financeiro_fornecedores", supplierId, "invalid_supplier");
  }

  const matchesRequest = (row: JsonRecord): boolean =>
    row.entry_type === type && row.origin === origin &&
    row.patient_id === patientId && row.supplier_id === supplierId &&
    row.description === description && row.category === category &&
    row.competence_date === competence && row.due_date === due &&
    numberFrom(row.total_amount) === numberFrom(total) &&
    row.payment_condition === condition && row.installments === installments &&
    row.notes === notes;
  const existing = await getEntryByIdempotency(clinicId, key);
  if (existing) {
    if (!matchesRequest(existing)) {
      throw new ApiError(
        409,
        "idempotency_key_reused",
        "Use uma nova chave para dados diferentes.",
      );
    }
    const row = await getEntryById(clinicId, requiredUuid(existing.id, "lancamento_id"));
    return success(req, context, {
      lancamento: (await presentEntries(clinicId, row ? [row] : []))[0] || null,
      idempotente: true,
    });
  }

  const result = await rpc("financeiro_criar_lancamento", {
    p_clinic_id: clinicId,
    p_user_id: userId,
    p_patient_id: patientId,
    p_supplier_id: supplierId,
    p_entry_type: type,
    p_origin: origin,
    p_description: description,
    p_category: category,
    p_competence_date: competence,
    p_due_date: due,
    p_total_amount: total,
    p_payment_condition: condition,
    p_installments: installments,
    p_notes: notes,
    p_idempotency_key: key,
    p_request_id: context.requestId,
  });
  const id = requiredUuid(result, "lancamento_id");
  const row = await getEntryById(clinicId, id);
  if (!row || !matchesRequest(row)) {
    throw new ApiError(409, "idempotency_key_reused", "Use uma nova chave para dados diferentes.");
  }
  return success(req, context, {
    lancamento: (await presentEntries(clinicId, [row]))[0] || null,
    idempotente: false,
  }, 201);
}

async function handleProgramInstallments(
  req: Request,
  context: DualAuthContext,
  payload: JsonRecord,
): Promise<Response> {
  const { clinicId, userId } = tenant(context);
  const key = requiredUuid(payload.idempotency_key, "idempotency_key");
  const entryId = requiredUuid(payload.lancamento_id ?? payload.entry_id, "lancamento_id");
  const entry = await getEntryById(clinicId, entryId);
  if (!entry) throw new ApiError(404, "entry_not_found", "Lançamento não encontrado.");
  if (entry.state !== "ativo") {
    throw new ApiError(409, "entry_inactive", "O lançamento não está ativo.");
  }
  const balanceNumber = numberFrom(entry.balance);
  if (balanceNumber <= 0) {
    throw new ApiError(409, "entry_has_no_balance", "Este lançamento já está quitado.");
  }
  const minimumDate = dateValue(entry.competence_date, "competencia");
  const balance = balanceNumber.toFixed(2);
  const planned = await installmentSchedule(
    payload.parcelas ?? payload.parcelas_previstas,
    minimumDate,
    balance,
  );
  const result = await rpc("financeiro_programar_parcelas", {
    p_clinic_id: clinicId,
    p_user_id: userId,
    p_entry_id: entryId,
    p_installments: planned,
    p_idempotency_key: key,
    p_request_id: context.requestId,
  });
  const refreshed = await getEntryById(clinicId, entryId);
  if (!refreshed) {
    throw new ApiError(
      502,
      "installments_read_failed",
      "As parcelas foram salvas, mas não foi possível recarregá-las.",
    );
  }
  return success(req, context, {
    resultado: result,
    lancamento: (await presentEntries(clinicId, [refreshed]))[0] || null,
  }, 201);
}

async function handleRegisterService(
  req: Request,
  context: DualAuthContext,
  payload: JsonRecord,
): Promise<Response> {
  const { clinicId, userId } = tenant(context);
  const entryKey = requiredUuid(payload.idempotency_key, "idempotency_key");
  const patientId = requiredUuid(payload.cliente_id ?? payload.patient_id, "cliente_id");
  await assertParty(clinicId, "patients", patientId, "invalid_client");
  const procedureCode = enumValue(payload.procedimento, "procedimento", PROCEDURE_CODES);
  const procedureLabel = procedureCode === "outro"
    ? requiredText(payload.procedimento_outro, "procedimento_outro", 2, 100)
    : PROCEDURE_LABELS[procedureCode];
  const serviceDate = dateValue(payload.data_atendimento, "data_atendimento");
  const total = decimalValue(payload.valor_total, "valor_total", 2);
  const totalNumber = numberFrom(total);
  const situation = enumValue(
    payload.situacao_pagamento,
    "situacao_pagamento",
    PAYMENT_SITUATIONS,
  );
  const notes = optionalText(payload.observacoes, "observacoes", 1000);
  let paidAmount = 0;
  if (situation === "recebido") paidAmount = totalNumber;
  if (situation === "parcial") {
    paidAmount = numberFrom(decimalValue(payload.valor_recebido, "valor_recebido", 2));
    if (paidAmount >= totalNumber) {
      throw new ApiError(
        422,
        "invalid_partial_payment",
        "No pagamento parcial, o valor recebido deve ser menor que o total.",
      );
    }
  }
  const balance = (totalNumber - paidAmount).toFixed(2);
  const rawSchedule = payload.parcelas_previstas ?? payload.parcelas_saldo;
  let plannedInstallments: JsonRecord[] = [];
  const hasRawSchedule = rawSchedule !== undefined && rawSchedule !== null &&
    (!Array.isArray(rawSchedule) || rawSchedule.length > 0);
  if (hasRawSchedule) {
    if (numberFrom(balance) <= 0) {
      throw new ApiError(
        422,
        "unexpected_installments",
        "Um atendimento já quitado não precisa de parcelas futuras.",
      );
    }
    plannedInstallments = await installmentSchedule(rawSchedule, serviceDate, balance);
  }
  const installments = plannedInstallments.length ||
    integerValue(payload.parcelas, "parcelas", 1, 1, 120);
  const dueDate = plannedInstallments.length
    ? String(plannedInstallments[0].vencimento)
    : dateValue(payload.vencimento ?? serviceDate, "vencimento");
  if (dueDate < serviceDate) {
    throw new ApiError(
      422,
      "invalid_due_date",
      "O vencimento não pode ser anterior ao atendimento.",
    );
  }
  let paymentMethod: string | null = null;
  let paymentKey: string | null = null;
  const paidAt = payload.recebido_em === undefined || payload.recebido_em === null ||
      payload.recebido_em === ""
    ? `${serviceDate}T12:00:00-03:00`
    : dateTimeValue(payload.recebido_em, "recebido_em");
  if (paidAmount > 0) {
    paymentMethod = enumValue(payload.forma_pagamento, "forma_pagamento", PAYMENT_METHODS);
    await assertPaymentMethodActive(paymentMethod);
    paymentKey = requiredUuid(
      payload.pagamento_idempotency_key,
      "pagamento_idempotency_key",
    );
  }
  const condition = situation === "parcial"
    ? "entrada_saldo"
    : installments > 1
    ? "parcelado"
    : "avista";
  const description = `Atendimento · ${procedureLabel}`;
  const entryId = requiredUuid(
    await rpc("financeiro_criar_lancamento", {
      p_clinic_id: clinicId,
      p_user_id: userId,
      p_patient_id: patientId,
      p_supplier_id: null,
      p_entry_type: "receita",
      p_origin: "atendimento",
      p_description: description,
      p_category: procedureLabel,
      p_competence_date: serviceDate,
      p_due_date: dueDate,
      p_total_amount: total,
      p_payment_condition: condition,
      p_installments: installments,
      p_notes: notes,
      p_idempotency_key: entryKey,
      p_request_id: context.requestId,
    }),
    "lancamento_id",
  );
  let paymentId: string | null = null;
  if (paidAmount > 0 && paymentMethod && paymentKey) {
    paymentId = requiredUuid(
      await rpc("financeiro_registrar_pagamento", {
        p_clinic_id: clinicId,
        p_user_id: userId,
        p_entry_id: entryId,
        p_movement_type: "pagamento",
        p_payment_method: paymentMethod,
        p_amount: paidAmount.toFixed(2),
        p_paid_at: paidAt,
        p_installments: 1,
        p_reference: null,
        p_reversed_payment_id: null,
        p_idempotency_key: paymentKey,
        p_request_id: context.requestId,
      }),
      "pagamento_id",
    );
  }
  let installmentPlan: unknown = null;
  if (plannedInstallments.length) {
    installmentPlan = await rpc("financeiro_programar_parcelas", {
      p_clinic_id: clinicId,
      p_user_id: userId,
      p_entry_id: entryId,
      p_installments: plannedInstallments,
      p_idempotency_key: await deterministicUuid(
        `${clinicId}:financeiro_parcelas:${entryKey}`,
      ),
      p_request_id: context.requestId,
    });
  }
  const row = await getEntryById(clinicId, entryId);
  if (!row) {
    throw new ApiError(
      502,
      "service_read_failed",
      "Atendimento salvo, mas não foi possível recarregá-lo.",
    );
  }
  return success(req, context, {
    lancamento: (await presentEntries(clinicId, [row]))[0] || null,
    pagamento_id: paymentId,
    parcelas_programadas: installmentPlan,
  }, 201);
}

async function getPaymentById(clinicId: string, id: string): Promise<JsonRecord | null> {
  const result = await admin(
    `/rest/v1/financeiro_pagamentos?select=${PAYMENT_SELECT},idempotency_key` +
      `&clinic_id=eq.${encode(clinicId)}&id=eq.${encode(id)}&limit=1`,
  );
  if (!result.response.ok) {
    throw new ApiError(502, "payment_read_failed", "Não foi possível ler o pagamento.");
  }
  return rows(result.data)[0] || null;
}

async function getPaymentByIdempotency(clinicId: string, key: string): Promise<JsonRecord | null> {
  const result = await admin(
    `/rest/v1/financeiro_pagamentos?select=${PAYMENT_SELECT},idempotency_key` +
      `&clinic_id=eq.${encode(clinicId)}&idempotency_key=eq.${encode(key)}&limit=1`,
  );
  if (!result.response.ok) {
    throw new ApiError(502, "idempotency_read_failed", "Não foi possível validar a solicitação.");
  }
  return rows(result.data)[0] || null;
}

async function installmentForPayment(clinicId: string, paymentId: string): Promise<string | null> {
  const result = await admin(
    "/rest/v1/financeiro_parcela_pagamentos?select=installment_id" +
      `&clinic_id=eq.${encode(clinicId)}&payment_id=eq.${encode(paymentId)}&limit=1`,
  );
  if (!result.response.ok) {
    throw new ApiError(
      502,
      "payment_link_read_failed",
      "Não foi possível conferir a parcela do pagamento.",
    );
  }
  const value = rows(result.data)[0]?.installment_id;
  return typeof value === "string" && validUuid(value) ? value : null;
}

async function entryHasActiveInstallments(clinicId: string, entryId: string): Promise<boolean> {
  const result = await admin(
    "/rest/v1/financeiro_parcelas?select=id" +
      `&clinic_id=eq.${encode(clinicId)}&entry_id=eq.${encode(entryId)}` +
      "&state=eq.ativa&limit=1",
  );
  if (!result.response.ok) {
    throw new ApiError(
      502,
      "installments_check_failed",
      "Não foi possível conferir as parcelas do lançamento.",
    );
  }
  return rows(result.data).length > 0;
}

function presentPayment(row: JsonRecord): JsonRecord {
  return {
    id: row.id,
    lancamento_id: row.entry_id,
    parcela_id: row.parcela_id ?? null,
    tipo: row.movement_type,
    forma: row.payment_method,
    valor: numberFrom(row.amount),
    pago_em: row.paid_at,
    parcelas: row.installments,
    referencia: row.reference,
    pagamento_estornado_id: row.reversed_payment_id,
    criado_em: row.created_at,
  };
}

async function handlePayment(
  req: Request,
  context: DualAuthContext,
  payload: JsonRecord,
  refund: boolean,
): Promise<Response> {
  const { clinicId, userId } = tenant(context);
  const key = requiredUuid(
    payload.idempotency_key ?? payload.operation_id,
    "idempotency_key",
  );
  const entryId = requiredUuid(payload.lancamento_id ?? payload.entry_id, "lancamento_id");
  let installmentId = optionalUuid(payload.parcela_id ?? payload.installment_id, "parcela_id");
  const originalId = refund
    ? requiredUuid(payload.pagamento_id ?? payload.payment_id, "pagamento_id")
    : null;
  let original: JsonRecord | null = null;
  if (originalId) {
    original = await getPaymentById(clinicId, originalId);
    if (!original || original.entry_id !== entryId || original.movement_type !== "pagamento") {
      throw new ApiError(404, "payment_not_found", "Pagamento não encontrado.");
    }
    const originalInstallmentId = await installmentForPayment(clinicId, originalId);
    if (installmentId && installmentId !== originalInstallmentId) {
      throw new ApiError(
        409,
        "payment_installment_mismatch",
        "O pagamento não pertence a esta parcela.",
      );
    }
    installmentId = originalInstallmentId;
  }
  if (!refund && !installmentId && await entryHasActiveInstallments(clinicId, entryId)) {
    throw new ApiError(
      422,
      "installment_required",
      "Selecione qual parcela está sendo recebida ou paga.",
    );
  }
  const existing = await getPaymentByIdempotency(clinicId, key);
  const method = paymentMethodForMovement(
    refund,
    payload.forma ?? payload.forma_pagamento,
    original?.payment_method,
  );
  if (!refund && !existing) await assertPaymentMethodActive(method);
  const amount = decimalValue(payload.valor, "valor", 2);
  const installments = integerValue(payload.parcelas, "parcelas", 1, 1, 120);
  if (method !== "cartao_credito" && installments !== 1) {
    throw new ApiError(
      422,
      "invalid_transaction_installments",
      "O número de parcelas da transação só se aplica ao cartão de crédito.",
    );
  }
  const reference = safeReference(payload.referencia);
  const paidAtSource = payload.paid_at ?? payload.pago_em;
  const paidAt = paidAtSource === undefined && typeof existing?.paid_at === "string"
    ? existing.paid_at
    : dateTimeValue(paidAtSource, "pago_em", true);
  if (Date.parse(paidAt) > Date.now() + 5 * 60_000) {
    throw new ApiError(422, "payment_in_future", "A data do pagamento não pode estar no futuro.");
  }
  const matchesRequest = (row: JsonRecord): boolean =>
    row.entry_id === entryId &&
    row.movement_type === (refund ? "estorno" : "pagamento") &&
    row.payment_method === method && numberFrom(row.amount) === numberFrom(amount) &&
    row.reversed_payment_id === originalId && sameTimestamp(row.paid_at, paidAt) &&
    row.installments === installments && row.reference === reference;
  if (existing) {
    if (!matchesRequest(existing)) {
      throw new ApiError(
        409,
        "idempotency_key_reused",
        "Use uma nova chave para dados diferentes.",
      );
    }
    const existingInstallmentId = await installmentForPayment(
      clinicId,
      requiredUuid(existing.id, "pagamento_id"),
    );
    if (existingInstallmentId !== installmentId) {
      throw new ApiError(
        409,
        "idempotency_key_reused",
        "Use uma nova chave para dados diferentes.",
      );
    }
    existing.parcela_id = existingInstallmentId;
    return success(req, context, { pagamento: presentPayment(existing), idempotente: true });
  }
  const rpcName = installmentId
    ? "financeiro_registrar_pagamento_parcela"
    : "financeiro_registrar_pagamento";
  const rpcPayload: JsonRecord = {
    p_clinic_id: clinicId,
    p_user_id: userId,
    p_entry_id: entryId,
    p_movement_type: refund ? "estorno" : "pagamento",
    p_payment_method: method,
    p_amount: amount,
    p_paid_at: paidAt,
    p_installments: installments,
    p_reference: reference,
    p_reversed_payment_id: originalId,
    p_idempotency_key: key,
    p_request_id: context.requestId,
  };
  if (installmentId) rpcPayload.p_installment_id = installmentId;
  const result = await rpc(rpcName, rpcPayload);
  const id = requiredUuid(result, "pagamento_id");
  const created = await getPaymentById(clinicId, id);
  if (!created || !matchesRequest(created)) {
    throw new ApiError(409, "idempotency_key_reused", "Use uma nova chave para dados diferentes.");
  }
  const createdInstallmentId = await installmentForPayment(clinicId, id);
  if (createdInstallmentId !== installmentId) {
    throw new ApiError(
      409,
      "payment_link_failed",
      "Não foi possível vincular o pagamento à parcela.",
    );
  }
  created.parcela_id = createdInstallmentId;
  return success(req, context, {
    pagamento: presentPayment(created),
    idempotente: false,
  }, 201);
}

async function handleCancelEntry(
  req: Request,
  context: DualAuthContext,
  payload: JsonRecord,
): Promise<Response> {
  const { clinicId, userId } = tenant(context);
  const requestId = operationId(payload);
  const entryId = requiredUuid(payload.lancamento_id ?? payload.entry_id, "lancamento_id");
  const reason = requiredText(payload.motivo, "motivo", 3, 500);
  const existing = await getEntryById(clinicId, entryId);
  if (!existing) throw new ApiError(404, "entry_not_found", "Lançamento não encontrado.");
  if (existing.origin === "compra") {
    throw new ApiError(
      409,
      "purchase_cancel_requires_full_workflow",
      "Uma compra não pode ser cancelada parcialmente. Use o fluxo completo de cancelamento de compra.",
    );
  }
  if (existing.state === "cancelado") {
    return success(req, context, { cancelado: true, idempotente: true });
  }
  await rpc("financeiro_cancelar_lancamento", {
    p_clinic_id: clinicId,
    p_user_id: userId,
    p_entry_id: entryId,
    p_reason: reason,
    p_request_id: requestId,
  });
  return success(req, context, { cancelado: true, idempotente: false });
}

function presentClient(row: JsonRecord): JsonRecord {
  return {
    id: row.id,
    nome: row.full_name,
    data_nascimento: row.birth_date,
    telefone: row.phone,
    email: row.email,
    telefone_emergencia: row.emergency_phone,
    cpf: row.cpf,
    cpf_mascarado: maskCpf(row.cpf),
    status: row.status,
    ativo: row.status === "active" && row.archived_at === null,
    arquivado_em: row.archived_at,
    versao: row.version,
    criado_em: row.created_at,
    atualizado_em: row.updated_at,
  };
}

function presentClientList(row: JsonRecord): JsonRecord {
  const presented = presentClient(row);
  delete presented.cpf;
  return presented;
}

function presentExistingClientCandidate(row: JsonRecord): JsonRecord {
  return {
    id: row.id,
    nome: row.full_name,
    cpf_mascarado: maskCpf(row.cpf),
    telefone_final: phoneSuffix(row.phone),
    email_mascarado: maskEmail(row.email),
    data_nascimento: row.birth_date,
    arquivado: Boolean(row.archived_at) || row.status !== "active",
  };
}

async function handleListClients(
  req: Request,
  context: DualAuthContext,
  payload: JsonRecord,
): Promise<Response> {
  const { clinicId } = tenant(context);
  const page = integerValue(payload.pagina, "pagina", 1, 1, 100_000);
  const pageSize = integerValue(payload.por_pagina, "por_pagina", 50, 1, MAX_PAGE_SIZE);
  const includeArchived = booleanValue(
    payload.incluir_arquivados,
    "incluir_arquivados",
    false,
  );
  const offset = (page - 1) * pageSize;
  let path = "/rest/v1/patients?select=id,full_name,birth_date,phone,email,emergency_phone,cpf," +
    "status,archived_at,version,created_at,updated_at" +
    `&clinic_id=eq.${encode(clinicId)}` +
    (includeArchived ? "" : "&archived_at=is.null");
  if (payload.busca !== undefined && payload.busca !== null && payload.busca !== "") {
    const rawSearch = requiredText(payload.busca, "busca", 2, 80);
    const search = normalizeSearchName(rawSearch);
    const digits = rawSearch.replace(/\D/g, "");
    const filters: string[] = [];
    if (search) filters.push(`search_name.ilike.*${search}*`);
    if (digits.length >= 4) filters.push(`phone.ilike.*${digits}*`);
    if (digits.length === 11) filters.push(`cpf.eq.${digits}`);
    if (!filters.length) throw new ApiError(422, "invalid_search", "Busca inválida.");
    path += `&or=(${filters.map(encode).join(",")})`;
  }
  path += `&order=full_name.asc&limit=${pageSize + 1}&offset=${offset}`;
  const result = await admin(path);
  if (!result.response.ok) {
    throw new ApiError(502, "clients_read_failed", "Não foi possível ler os clientes.");
  }
  const clientRows = rows(result.data);
  return success(req, context, {
    clientes: clientRows.slice(0, pageSize).map(presentClientList),
    paginacao: { pagina: page, por_pagina: pageSize, tem_mais: clientRows.length > pageSize },
  });
}

interface SourceCandidate {
  source_kind: "anamnese" | "documento_clinico" | "agendamento";
  source_id: string;
  nome: string;
  cpf: string | null;
  telefone: string | null;
  email: string | null;
  data: string | null;
}

interface ConfirmedSource {
  kind: "anamnese" | "documento_clinico" | "agendamento";
  id: string;
}

async function assertLegacySourceTenant(clinicId: string): Promise<void> {
  if (SOURCE_CLINIC_ID.trim()) {
    if (!validUuid(SOURCE_CLINIC_ID)) {
      throw new ApiError(503, "legacy_source_tenant_unavailable", "Fontes clínicas indisponíveis.");
    }
    if (SOURCE_CLINIC_ID.toLowerCase() !== clinicId) {
      throw new ApiError(403, "legacy_source_tenant_forbidden", "Fontes clínicas indisponíveis.");
    }
    return;
  }

  // Compatibilidade segura com a base histórica, que ainda não possui clinic_id:
  // só é possível consultá-la quando o projeto tem uma única clínica cadastrada.
  const result = await admin("/rest/v1/clinics?select=id&order=id.asc&limit=2");
  const clinicRows = rows(result.data);
  if (!result.response.ok || clinicRows.length !== 1 || clinicRows[0].id !== clinicId) {
    throw new ApiError(503, "legacy_source_tenant_unavailable", "Fontes clínicas indisponíveis.");
  }
}

function optionalSource(payload: JsonRecord): ConfirmedSource | null {
  const kindValue = payload.origem ?? payload.source_kind;
  const idValue = payload.origem_id ?? payload.source_id;
  if (
    (kindValue === undefined || kindValue === null || kindValue === "") &&
    (idValue === undefined || idValue === null || idValue === "")
  ) return null;
  if (
    kindValue === undefined || kindValue === null || kindValue === "" ||
    idValue === undefined || idValue === null || idValue === ""
  ) {
    throw new ApiError(422, "incomplete_source", "Informe a origem e o identificador da origem.");
  }
  return {
    kind: enumValue(kindValue, "origem", SOURCE_KINDS) as ConfirmedSource["kind"],
    id: requiredUuid(idValue, "origem_id"),
  };
}

async function assertSourceExists(clinicId: string, source: ConfirmedSource): Promise<void> {
  await assertLegacySourceTenant(clinicId);
  const table = source.kind === "anamnese"
    ? "anamneses"
    : source.kind === "documento_clinico"
    ? "documentos_clinicos"
    : "agendamentos_clinica";
  const result = await admin(
    `/rest/v1/${table}?select=id&id=eq.${encode(source.id)}&arquivado_em=is.null&limit=1`,
  );
  if (!result.response.ok) {
    throw new ApiError(502, "source_read_failed", "Não foi possível conferir a origem.");
  }
  if (!rows(result.data).length) {
    throw new ApiError(404, "source_not_found", "Registro de origem não encontrado.");
  }
}

async function handleSuggestClients(
  req: Request,
  context: DualAuthContext,
  payload: JsonRecord,
): Promise<Response> {
  const { clinicId } = tenant(context);
  // As três fontes são tabelas clínicas legadas sem clinic_id. O gate abaixo
  // exige CLINIC_ID correspondente ou comprovação de projeto single-clinic.
  await assertLegacySourceTenant(clinicId);
  const search = normalizeSearchName(requiredText(payload.busca, "busca", 2, 80));
  const digits = String(payload.busca).replace(/\D/g, "");
  const limit = integerValue(payload.limite, "limite", 30, 1, 100);
  const [currentPatients, anamneses, documents, appointments, links] = await Promise.all([
    admin(
      "/rest/v1/patients?select=id,full_name,birth_date,cpf,phone,email,status,archived_at," +
        `created_at&clinic_id=eq.${encode(clinicId)}&order=created_at.desc&limit=300`,
    ),
    admin(
      "/rest/v1/anamneses?select=id,nome,cpf,telefone,criado_em&arquivado_em=is.null" +
        "&order=criado_em.desc&limit=150",
    ),
    admin(
      "/rest/v1/documentos_clinicos?select=id,nome,cpf,telefone,email,recebido_em" +
        "&arquivado_em=is.null&order=recebido_em.desc&limit=150",
    ),
    admin(
      "/rest/v1/agendamentos_clinica?select=id,nome,telefone,email,inicio_em" +
        "&arquivado_em=is.null&order=inicio_em.desc&limit=150",
    ),
    admin(
      "/rest/v1/patient_source_links?select=source_kind,source_id,patient_id,status" +
        `&clinic_id=eq.${encode(clinicId)}&limit=1000`,
    ),
  ]);
  if (
    ![currentPatients, anamneses, documents, appointments, links].every((result) =>
      result.response.ok
    )
  ) {
    throw new ApiError(502, "sources_read_failed", "Não foi possível ler as fontes de clientes.");
  }
  const candidates: SourceCandidate[] = [];
  for (const row of rows(anamneses.data)) {
    if (typeof row.id === "string" && typeof row.nome === "string") {
      candidates.push({
        source_kind: "anamnese",
        source_id: row.id,
        nome: row.nome,
        cpf: typeof row.cpf === "string" ? row.cpf : null,
        telefone: typeof row.telefone === "string" ? row.telefone : null,
        email: null,
        data: typeof row.criado_em === "string" ? row.criado_em : null,
      });
    }
  }
  for (const row of rows(documents.data)) {
    if (typeof row.id === "string" && typeof row.nome === "string") {
      candidates.push({
        source_kind: "documento_clinico",
        source_id: row.id,
        nome: row.nome,
        cpf: typeof row.cpf === "string" ? row.cpf : null,
        telefone: typeof row.telefone === "string" ? row.telefone : null,
        email: typeof row.email === "string" ? row.email : null,
        data: typeof row.recebido_em === "string" ? row.recebido_em : null,
      });
    }
  }
  for (const row of rows(appointments.data)) {
    if (typeof row.id === "string" && typeof row.nome === "string") {
      candidates.push({
        source_kind: "agendamento",
        source_id: row.id,
        nome: row.nome,
        cpf: null,
        telefone: typeof row.telefone === "string" ? row.telefone : null,
        email: typeof row.email === "string" ? row.email : null,
        data: typeof row.inicio_em === "string" ? row.inicio_em : null,
      });
    }
  }
  const linkMap = new Map(
    rows(links.data)
      .filter((row) => typeof row.source_kind === "string" && typeof row.source_id === "string")
      .map((row) => [row.source_kind + ":" + row.source_id, row]),
  );
  const currentMatches = rows(currentPatients.data).filter((row) => {
    const name = normalizeSearchName(String(row.full_name || ""));
    const candidateDigits = String(row.cpf || "") + String(row.phone || "");
    return name.includes(search) || (digits.length >= 4 && candidateDigits.includes(digits));
  }).map((row) => ({
    origem: "cliente_cadastrado",
    origem_id: null,
    cliente_id: row.id,
    nome: row.full_name,
    cpf_mascarado: maskCpf(row.cpf),
    telefone_final: phoneSuffix(row.phone),
    email_mascarado: maskEmail(row.email),
    data_origem: row.created_at,
    vinculo: { status: "canonical", cliente_id: row.id },
    correspondencia: "existente",
    abrir_existente: true,
    exige_confirmacao: false,
  }));
  const legacyMatches = candidates.filter((candidate) => {
    const name = normalizeSearchName(candidate.nome);
    const candidateDigits = ((candidate.cpf || "") + (candidate.telefone || "")).replace(
      /\D/g,
      "",
    );
    return name.includes(search) || (digits.length >= 4 && candidateDigits.includes(digits));
  }).slice(0, limit).map((candidate) => {
    const link = linkMap.get(candidate.source_kind + ":" + candidate.source_id);
    return {
      origem: candidate.source_kind,
      origem_id: candidate.source_id,
      nome: candidate.nome,
      cpf_mascarado: maskCpf(candidate.cpf),
      telefone_final: phoneSuffix(candidate.telefone),
      email_mascarado: maskEmail(candidate.email),
      data_origem: candidate.data,
      vinculo: link ? { status: link.status, cliente_id: link.patient_id } : null,
      correspondencia: link ? "existente" : "possivel",
      abrir_existente: Boolean(link && link.patient_id),
      exige_confirmacao: true,
    };
  });
  const filtered: JsonRecord[] = [...currentMatches, ...legacyMatches].slice(0, limit);
  return success(req, context, { candidatos: filtered, mesclagem_automatica: false });
}

async function getClientByIdempotency(clinicId: string, key: string): Promise<JsonRecord | null> {
  const result = await admin(
    "/rest/v1/patients?select=id,full_name,birth_date,phone,email,emergency_phone,cpf,status," +
      "archived_at,version,created_at,updated_at,idempotency_key" +
      `&clinic_id=eq.${encode(clinicId)}&idempotency_key=eq.${encode(key)}&limit=1`,
  );
  if (!result.response.ok) {
    throw new ApiError(502, "idempotency_read_failed", "Não foi possível validar a solicitação.");
  }
  return rows(result.data)[0] || null;
}

async function getClientById(
  clinicId: string,
  id: string,
  includeArchived = false,
): Promise<JsonRecord | null> {
  const result = await admin(
    "/rest/v1/patients?select=id,full_name,birth_date,phone,email,emergency_phone,cpf,status," +
      "archived_at,version,created_at,updated_at,idempotency_key" +
      `&clinic_id=eq.${encode(clinicId)}&id=eq.${encode(id)}` +
      (includeArchived ? "" : "&archived_at=is.null") + "&limit=1",
  );
  if (!result.response.ok) {
    throw new ApiError(502, "client_read_failed", "Não foi possível ler o cliente.");
  }
  return rows(result.data)[0] || null;
}

async function handleCreateClient(
  req: Request,
  context: DualAuthContext,
  payload: JsonRecord,
): Promise<Response> {
  const { clinicId, userId } = tenant(context);
  const key = requiredUuid(payload.idempotency_key, "idempotency_key");
  const name = requiredText(payload.nome, "nome", 2, 160);
  const cpf = normalizeCpf(payload.cpf);
  const phone = normalizePhone(payload.telefone);
  const email = normalizeEmail(payload.email);
  const emergencyPhone = normalizePhone(payload.telefone_emergencia, "telefone_emergencia");
  const birthDate = optionalDate(payload.data_nascimento, "data_nascimento", 1900);
  const source = optionalSource(payload);
  if (birthDate && birthDate > dateKeyInSaoPaulo()) {
    throw new ApiError(422, "invalid_birth_date", "Data de nascimento inválida.");
  }
  if (source) await assertSourceExists(clinicId, source);

  const existing = await getClientByIdempotency(clinicId, key);
  if (existing) {
    const same = existing.full_name === name && existing.cpf === cpf && existing.phone === phone &&
      existing.email === email && existing.birth_date === birthDate &&
      existing.emergency_phone === emergencyPhone;
    if (!same) {
      throw new ApiError(
        409,
        "idempotency_key_reused",
        "Use uma nova chave para dados diferentes.",
      );
    }
  }

  if (!existing && (cpf || phone || email)) {
    const filters: string[] = [];
    if (cpf) filters.push(`cpf.eq.${cpf}`);
    if (phone) filters.push(`phone.eq.${phone}`);
    if (email) filters.push(`email.eq.${email}`);
    const duplicate = await admin(
      "/rest/v1/patients?select=id,full_name,birth_date,cpf,phone,email,status,archived_at" +
        "&clinic_id=eq." + encode(clinicId) +
        "&or=(" + filters.map(encode).join(",") + ")&limit=10",
    );
    if (!duplicate.response.ok) {
      throw new ApiError(502, "duplicate_check_failed", "Não foi possível conferir o cadastro.");
    }
    const exact = rows(duplicate.data).find((candidate) =>
      (cpf !== null && candidate.cpf === cpf) ||
      (birthDate !== null && candidate.birth_date === birthDate &&
        normalizeExactText(String(candidate.full_name || "")) === normalizeExactText(name) &&
        (phone !== null ? candidate.phone === phone : email !== null && candidate.email === email))
    );
    if (exact) {
      throw new ApiError(
        409,
        "exact_duplicate",
        "Este cliente já está cadastrado. Abra o registro existente.",
        {
          tipo: "cliente",
          correspondencia: "exata",
          existing_id: exact.id,
          candidato: presentExistingClientCandidate(exact),
        },
      );
    }
  }

  const result = await rpc("financeiro_criar_cliente_com_vinculo", {
    p_clinic_id: clinicId,
    p_user_id: userId,
    p_full_name: name,
    p_birth_date: birthDate,
    p_cpf: cpf,
    p_phone: phone,
    p_email: email,
    p_emergency_phone: emergencyPhone,
    p_source_kind: source?.kind || null,
    p_source_id: source?.id || null,
    p_idempotency_key: key,
    p_request_id: context.requestId,
  });
  if (!isRecord(result) || !validUuid(result.patient_id)) {
    throw new ApiError(502, "client_create_failed", "Não foi possível cadastrar o cliente.");
  }
  const created = await getClientById(clinicId, result.patient_id);
  if (!created) {
    throw new ApiError(502, "client_create_failed", "Não foi possível cadastrar o cliente.");
  }
  return success(req, context, {
    cliente: presentClient(created),
    vinculo_origem: validUuid(result.source_link_id),
    idempotente: result.idempotent === true,
  }, result.idempotent === true ? 200 : 201);
}

async function handleGetClient(
  req: Request,
  context: DualAuthContext,
  payload: JsonRecord,
): Promise<Response> {
  const { clinicId } = tenant(context);
  const id = requiredUuid(payload.id ?? payload.cliente_id, "cliente_id");
  const client = await getClientById(clinicId, id, true);
  if (!client) throw new ApiError(404, "client_not_found", "Cliente não encontrado.");
  return success(req, context, { cliente: presentClient(client) });
}

async function handleEditClient(
  req: Request,
  context: DualAuthContext,
  payload: JsonRecord,
): Promise<Response> {
  const { clinicId, userId } = tenant(context);
  const id = requiredUuid(payload.id ?? payload.cliente_id, "cliente_id");
  const version = expectedVersion(payload);
  const reason = operationReason(payload);
  const requestId = operationId(payload);
  const name = requiredText(payload.nome, "nome", 2, 160);
  const cpf = normalizeCpf(payload.cpf);
  const phone = normalizePhone(payload.telefone);
  const email = normalizeEmail(payload.email);
  const emergencyPhone = normalizePhone(payload.telefone_emergencia, "telefone_emergencia");
  const birthDate = optionalDate(payload.data_nascimento, "data_nascimento", 1900);
  const status = enumValue(payload.status ?? "active", "status", PATIENT_STATUSES);
  if (birthDate && birthDate > dateKeyInSaoPaulo()) {
    throw new ApiError(422, "invalid_birth_date", "Data de nascimento inválida.");
  }
  const result = await rpc("financeiro_editar_cliente", {
    p_clinic_id: clinicId,
    p_user_id: userId,
    p_patient_id: id,
    p_expected_version: version,
    p_full_name: name,
    p_birth_date: birthDate,
    p_cpf: cpf,
    p_phone: phone,
    p_email: email,
    p_emergency_phone: emergencyPhone,
    p_status: status,
    p_search_name: normalizeSearchName(name),
    p_reason: reason,
    p_request_id: requestId,
  });
  if (!isRecord(result)) {
    throw new ApiError(502, "client_update_failed", "Não foi possível atualizar o cliente.");
  }
  return success(req, context, { cliente: presentClient(result) });
}

async function handleClientArchiveState(
  req: Request,
  context: DualAuthContext,
  payload: JsonRecord,
  restore: boolean,
): Promise<Response> {
  const { clinicId, userId } = tenant(context);
  const id = requiredUuid(payload.id ?? payload.cliente_id, "cliente_id");
  const result = await rpc(
    restore ? "financeiro_restaurar_cliente" : "financeiro_arquivar_cliente",
    {
      p_clinic_id: clinicId,
      p_user_id: userId,
      p_patient_id: id,
      p_expected_version: expectedVersion(payload),
      p_reason: operationReason(payload),
      p_request_id: operationId(payload),
    },
  );
  if (!isRecord(result)) {
    throw new ApiError(502, "client_archive_failed", "Não foi possível alterar o cliente.");
  }
  return success(req, context, { cliente: presentClient(result) });
}

function presentSupplier(row: JsonRecord): JsonRecord {
  return {
    id: row.id,
    nome: row.name,
    documento: row.document,
    telefone: row.phone,
    email: row.email,
    ativo: row.active,
    arquivado_em: row.archived_at,
    versao: row.version,
    criado_em: row.created_at,
    atualizado_em: row.updated_at,
  };
}

function presentSupplierList(row: JsonRecord): JsonRecord {
  const presented = presentSupplier(row);
  delete presented.documento;
  presented.documento_mascarado = maskDocument(row.document);
  return presented;
}

function presentBrand(row: JsonRecord): JsonRecord {
  return {
    id: row.id,
    nome: row.name,
    ativo: row.active,
    arquivado_em: row.archived_at,
    versao: row.version,
    criado_em: row.created_at,
    atualizado_em: row.updated_at,
  };
}

function presentProduct(row: JsonRecord): JsonRecord {
  return {
    id: row.id,
    marca_id: row.brand_id,
    nome: row.name,
    tipo: row.product_type,
    unidade: row.unit,
    apresentacao: row.presentation,
    ean: row.ean,
    custo_referencia: row.reference_cost === null ? null : numberFrom(row.reference_cost),
    preco_venda: row.sale_price === null ? null : numberFrom(row.sale_price),
    registro_anvisa: row.anvisa_registration,
    controla_estoque: row.stock_control,
    ativo: row.active,
    arquivado_em: row.archived_at,
    versao: row.version,
    criado_em: row.created_at,
    atualizado_em: row.updated_at,
  };
}

async function handleListCatalogs(
  req: Request,
  context: DualAuthContext,
  payload: JsonRecord,
): Promise<Response> {
  const { clinicId } = tenant(context);
  const includeArchived = booleanValue(
    payload.incluir_arquivados,
    "incluir_arquivados",
    false,
  );
  const archiveFilter = includeArchived ? "" : "&archived_at=is.null";
  const [forms, suppliers, brands, products] = await Promise.all([
    paymentForms(),
    admin(
      "/rest/v1/financeiro_fornecedores?select=id,name,document,phone,email,active,created_at," +
        `updated_at,archived_at,version&clinic_id=eq.${encode(clinicId)}${archiveFilter}` +
        "&order=name.asc&limit=1000",
    ),
    admin(
      "/rest/v1/financeiro_marcas?select=id,name,active,created_at,updated_at,archived_at,version" +
        `&clinic_id=eq.${encode(clinicId)}${archiveFilter}&order=name.asc&limit=1000`,
    ),
    admin(
      "/rest/v1/financeiro_produtos?select=id,brand_id,name,product_type,unit,presentation,ean,reference_cost," +
        "sale_price,anvisa_registration,stock_control,active,created_at,updated_at,archived_at,version" +
        `&clinic_id=eq.${encode(clinicId)}${archiveFilter}&order=name.asc&limit=2000`,
    ),
  ]);
  if (![suppliers, brands, products].every((result) => result.response.ok)) {
    throw new ApiError(502, "catalogs_read_failed", "Não foi possível ler os catálogos.");
  }
  return success(req, context, {
    formas_pagamento: forms,
    fornecedores: rows(suppliers.data).map(presentSupplierList),
    marcas: rows(brands.data).map(presentBrand),
    produtos: rows(products.data).map(presentProduct),
  });
}

async function findExactCatalogCandidate(
  clinicId: string,
  table: "financeiro_marcas" | "financeiro_fornecedores" | "financeiro_produtos",
  record: JsonRecord,
  excludeId?: string,
): Promise<JsonRecord | null> {
  let path = `/rest/v1/${table}?select=*&clinic_id=eq.${encode(clinicId)}`;
  if (table === "financeiro_marcas") {
    // O banco remove acentos na chave canonica; a filtragem final em memoria
    // usa a mesma regra para nao perder, por exemplo, nomes com/sem acento.
  } else if (table === "financeiro_fornecedores") {
    if (record.document) {
      path += `&document=eq.${encode(String(record.document))}`;
    } else if (record.phone) {
      path += `&phone=eq.${encode(String(record.phone))}`;
    } else if (record.email) {
      path += `&email=eq.${encode(String(record.email))}`;
    } else {
      return null;
    }
  } else if (record.ean) {
    path += `&ean=eq.${encode(String(record.ean))}`;
  } else if (record.brand_id && record.presentation) {
    path += `&brand_id=eq.${encode(String(record.brand_id))}` +
      `&unit=eq.${encode(String(record.unit || ""))}`;
  } else {
    return null;
  }
  path += "&order=created_at.asc,id.asc&limit=2000";
  const result = await admin(path);
  if (!result.response.ok) {
    throw new ApiError(502, "duplicate_check_failed", "Não foi possível conferir o cadastro.");
  }
  const normalizedName = normalizeExactText(String(record.name || ""));
  const normalizedPresentation = normalizeExactText(String(record.presentation || ""));
  return rows(result.data).find((row) => {
    if (excludeId && row.id === excludeId) return false;
    if (table === "financeiro_marcas") {
      return normalizeExactText(String(row.name || "")) === normalizedName;
    }
    if (table === "financeiro_fornecedores") {
      return record.document
        ? row.document === record.document
        : normalizeExactText(String(row.name || "")) === normalizedName &&
          (record.phone ? row.phone === record.phone : row.email === record.email);
    }
    return record.ean ? row.ean === record.ean : row.brand_id === record.brand_id &&
      normalizeExactText(String(row.name || "")) === normalizedName &&
      normalizeExactText(String(row.presentation || "")) === normalizedPresentation &&
      row.unit === record.unit &&
      normalizeExactText(String(row.anvisa_registration || "")) ===
        normalizeExactText(String(record.anvisa_registration || ""));
  }) || null;
}

async function createCatalogRecord(
  context: DualAuthContext,
  table: "financeiro_marcas" | "financeiro_fornecedores" | "financeiro_produtos",
  action: string,
  key: string,
  record: JsonRecord,
  compare: (existing: JsonRecord) => boolean,
): Promise<{ row: JsonRecord; idempotent: boolean }> {
  const { clinicId } = tenant(context);
  const id = await deterministicUuid(`${clinicId}:${action}:${key}`);
  const current = await admin(
    `/rest/v1/${table}?select=*&clinic_id=eq.${encode(clinicId)}&id=eq.${encode(id)}&limit=1`,
  );
  if (!current.response.ok) {
    throw new ApiError(502, "catalog_read_failed", "Não foi possível conferir o cadastro.");
  }
  const existing = rows(current.data)[0];
  if (existing) {
    if (!compare(existing)) {
      throw new ApiError(
        409,
        "idempotency_key_reused",
        "Use uma nova chave para dados diferentes.",
      );
    }
    return { row: existing, idempotent: true };
  }
  const exactCandidate = await findExactCatalogCandidate(clinicId, table, record, id);
  if (exactCandidate) {
    const kind = table === "financeiro_fornecedores"
      ? "fornecedor"
      : table === "financeiro_marcas"
      ? "marca"
      : "produto";
    throw new ApiError(
      409,
      "exact_duplicate",
      "Este cadastro já existe. Abra o registro existente.",
      {
        tipo: kind,
        correspondencia: "exata",
        existing_id: exactCandidate.id,
        candidato: presentCatalog(kind, exactCandidate),
      },
    );
  }
  const result = await admin(
    `/rest/v1/${table}`,
    "POST",
    { id, clinic_id: clinicId, ...record },
    { Prefer: "return=representation" },
  );
  if (!result.response.ok) {
    if (result.response.status === 409) {
      const concurrent = await admin(
        `/rest/v1/${table}?select=*&clinic_id=eq.${encode(clinicId)}&id=eq.${encode(id)}&limit=1`,
      );
      const concurrentRow = rows(concurrent.data)[0];
      if (concurrent.response.ok && concurrentRow && compare(concurrentRow)) {
        return { row: concurrentRow, idempotent: true };
      }
      const duplicate = await findExactCatalogCandidate(clinicId, table, record, id);
      if (duplicate) {
        const kind = table === "financeiro_fornecedores"
          ? "fornecedor"
          : table === "financeiro_marcas"
          ? "marca"
          : "produto";
        throw new ApiError(
          409,
          "exact_duplicate",
          "Este cadastro já existe. Abra o registro existente.",
          {
            tipo: kind,
            correspondencia: "exata",
            existing_id: duplicate.id,
            candidato: presentCatalog(kind, duplicate),
          },
        );
      }
    }
    mapDatabaseError(result, "catalog_create_failed", "Não foi possível salvar o cadastro.");
  }
  const created = rows(result.data)[0];
  if (!created) {
    throw new ApiError(502, "catalog_create_failed", "Não foi possível salvar o cadastro.");
  }
  await financeAudit(context, table.slice("financeiro_".length, -1), id, "criado");
  return { row: created, idempotent: false };
}

async function handleCreateBrand(
  req: Request,
  context: DualAuthContext,
  payload: JsonRecord,
): Promise<Response> {
  const { userId } = tenant(context);
  const key = requiredUuid(payload.idempotency_key, "idempotency_key");
  const name = requiredText(payload.nome, "nome", 2, 120);
  const created = await createCatalogRecord(
    context,
    "financeiro_marcas",
    "criar_marca",
    key,
    { name, active: true, created_by: userId, updated_by: userId },
    (row) => row.name === name,
  );
  return success(req, context, {
    marca: presentBrand(created.row),
    idempotente: created.idempotent,
  }, created.idempotent ? 200 : 201);
}

async function handleCreateSupplier(
  req: Request,
  context: DualAuthContext,
  payload: JsonRecord,
): Promise<Response> {
  const { userId } = tenant(context);
  const key = requiredUuid(payload.idempotency_key, "idempotency_key");
  const name = requiredText(payload.nome, "nome", 2, 160);
  const document = normalizeDocument(payload.documento);
  const phone = normalizePhone(payload.telefone);
  const email = normalizeEmail(payload.email);
  const created = await createCatalogRecord(
    context,
    "financeiro_fornecedores",
    "criar_fornecedor",
    key,
    { name, document, phone, email, active: true, created_by: userId, updated_by: userId },
    (row) =>
      row.name === name && row.document === document && row.phone === phone && row.email === email,
  );
  return success(req, context, {
    fornecedor: presentSupplier(created.row),
    idempotente: created.idempotent,
  }, created.idempotent ? 200 : 201);
}

async function handleCreateProduct(
  req: Request,
  context: DualAuthContext,
  payload: JsonRecord,
): Promise<Response> {
  const { clinicId, userId } = tenant(context);
  const key = requiredUuid(payload.idempotency_key, "idempotency_key");
  const brandId = optionalUuid(payload.marca_id, "marca_id");
  if (brandId) await assertParty(clinicId, "financeiro_marcas", brandId, "invalid_brand");
  const name = requiredText(payload.nome, "nome", 2, 160);
  const type = enumValue(payload.tipo, "tipo", PRODUCT_TYPES);
  const unit = enumValue(payload.unidade, "unidade", PRODUCT_UNITS);
  const presentation = requiredText(payload.apresentacao, "apresentacao", 1, 160);
  const ean = normalizeEan(payload.ean);
  const referenceCost =
    payload.custo_referencia === undefined || payload.custo_referencia === null ||
      payload.custo_referencia === ""
      ? null
      : decimalValue(payload.custo_referencia, "custo_referencia", 2, true);
  const salePrice = payload.preco_venda === undefined || payload.preco_venda === null ||
      payload.preco_venda === ""
    ? null
    : decimalValue(payload.preco_venda, "preco_venda", 2, true);
  const anvisa = optionalText(payload.registro_anvisa, "registro_anvisa", 80);
  const stockControl = booleanValue(payload.controla_estoque, "controla_estoque", false);
  const created = await createCatalogRecord(
    context,
    "financeiro_produtos",
    "criar_produto",
    key,
    {
      brand_id: brandId,
      name,
      product_type: type,
      unit,
      presentation,
      ean,
      reference_cost: referenceCost,
      sale_price: salePrice,
      anvisa_registration: anvisa,
      stock_control: stockControl,
      active: true,
      created_by: userId,
      updated_by: userId,
    },
    (row) =>
      row.brand_id === brandId && row.name === name && row.product_type === type &&
      row.unit === unit && row.presentation === presentation && row.ean === ean &&
      nullableDecimalEqual(row.reference_cost, referenceCost) &&
      nullableDecimalEqual(row.sale_price, salePrice) && row.anvisa_registration === anvisa &&
      row.stock_control === stockControl,
  );
  return success(req, context, {
    produto: presentProduct(created.row),
    idempotente: created.idempotent,
  }, created.idempotent ? 200 : 201);
}

type CatalogKind = "fornecedor" | "marca" | "produto";

const CATALOG_READ_CONFIG: Record<
  CatalogKind,
  { table: string; select: string; responseKey: string }
> = {
  fornecedor: {
    table: "financeiro_fornecedores",
    select: "id,name,document,phone,email,active,archived_at,version,created_at,updated_at",
    responseKey: "fornecedor",
  },
  marca: {
    table: "financeiro_marcas",
    select: "id,name,active,archived_at,version,created_at,updated_at",
    responseKey: "marca",
  },
  produto: {
    table: "financeiro_produtos",
    select:
      "id,brand_id,name,product_type,unit,presentation,ean,reference_cost,sale_price,anvisa_registration," +
      "stock_control,active,archived_at,version,created_at,updated_at",
    responseKey: "produto",
  },
};

async function getCatalogRow(
  clinicId: string,
  kind: CatalogKind,
  id: string,
): Promise<JsonRecord | null> {
  const config = CATALOG_READ_CONFIG[kind];
  const result = await admin(
    `/rest/v1/${config.table}?select=${config.select}&clinic_id=eq.${encode(clinicId)}` +
      `&id=eq.${encode(id)}&limit=1`,
  );
  if (!result.response.ok) {
    throw new ApiError(502, `${kind}_read_failed`, "Não foi possível ler o cadastro.");
  }
  return rows(result.data)[0] || null;
}

function presentCatalog(kind: CatalogKind, row: JsonRecord): JsonRecord {
  if (kind === "fornecedor") return presentSupplier(row);
  if (kind === "marca") return presentBrand(row);
  return presentProduct(row);
}

async function handleGetCatalog(
  req: Request,
  context: DualAuthContext,
  payload: JsonRecord,
  kind: CatalogKind,
): Promise<Response> {
  const { clinicId } = tenant(context);
  const id = requiredUuid(
    payload.id ?? payload[`${kind}_id`],
    `${kind}_id`,
  );
  const row = await getCatalogRow(clinicId, kind, id);
  if (!row) throw new ApiError(404, `${kind}_not_found`, "Cadastro não encontrado.");
  return success(req, context, {
    [CATALOG_READ_CONFIG[kind].responseKey]: presentCatalog(kind, row),
  });
}

async function handleEditSupplier(
  req: Request,
  context: DualAuthContext,
  payload: JsonRecord,
): Promise<Response> {
  const { clinicId, userId } = tenant(context);
  const result = await rpc("financeiro_editar_fornecedor", {
    p_clinic_id: clinicId,
    p_user_id: userId,
    p_supplier_id: requiredUuid(payload.id ?? payload.fornecedor_id, "fornecedor_id"),
    p_expected_version: expectedVersion(payload),
    p_name: requiredText(payload.nome, "nome", 2, 160),
    p_document: normalizeDocument(payload.documento),
    p_phone: normalizePhone(payload.telefone),
    p_email: normalizeEmail(payload.email),
    p_reason: operationReason(payload),
    p_request_id: operationId(payload),
  });
  if (!isRecord(result)) {
    throw new ApiError(502, "supplier_update_failed", "Não foi possível atualizar o fornecedor.");
  }
  return success(req, context, { fornecedor: presentSupplier(result) });
}

async function handleEditBrand(
  req: Request,
  context: DualAuthContext,
  payload: JsonRecord,
): Promise<Response> {
  const { clinicId, userId } = tenant(context);
  const result = await rpc("financeiro_editar_marca", {
    p_clinic_id: clinicId,
    p_user_id: userId,
    p_brand_id: requiredUuid(payload.id ?? payload.marca_id, "marca_id"),
    p_expected_version: expectedVersion(payload),
    p_name: requiredText(payload.nome, "nome", 2, 120),
    p_reason: operationReason(payload),
    p_request_id: operationId(payload),
  });
  if (!isRecord(result)) {
    throw new ApiError(502, "brand_update_failed", "Não foi possível atualizar a marca.");
  }
  return success(req, context, { marca: presentBrand(result) });
}

async function handleEditProduct(
  req: Request,
  context: DualAuthContext,
  payload: JsonRecord,
): Promise<Response> {
  const { clinicId, userId } = tenant(context);
  const brandId = optionalUuid(payload.marca_id, "marca_id");
  if (brandId) await assertParty(clinicId, "financeiro_marcas", brandId, "invalid_brand");
  const result = await rpc("financeiro_editar_produto", {
    p_clinic_id: clinicId,
    p_user_id: userId,
    p_product_id: requiredUuid(payload.id ?? payload.produto_id, "produto_id"),
    p_expected_version: expectedVersion(payload),
    p_brand_id: brandId,
    p_name: requiredText(payload.nome, "nome", 2, 160),
    p_product_type: enumValue(payload.tipo, "tipo", PRODUCT_TYPES),
    p_unit: enumValue(payload.unidade, "unidade", PRODUCT_UNITS),
    p_presentation: requiredText(payload.apresentacao, "apresentacao", 1, 160),
    p_ean: normalizeEan(payload.ean),
    p_reference_cost: optionalDecimal(payload.custo_referencia, "custo_referencia", 2),
    p_sale_price: optionalDecimal(payload.preco_venda, "preco_venda", 2),
    p_anvisa_registration: optionalText(payload.registro_anvisa, "registro_anvisa", 80),
    p_stock_control: booleanValue(payload.controla_estoque, "controla_estoque", false),
    p_reason: operationReason(payload),
    p_request_id: operationId(payload),
  });
  if (!isRecord(result)) {
    throw new ApiError(502, "product_update_failed", "Não foi possível atualizar o produto.");
  }
  return success(req, context, { produto: presentProduct(result) });
}

async function handleCatalogArchiveState(
  req: Request,
  context: DualAuthContext,
  payload: JsonRecord,
  kind: CatalogKind,
  restore: boolean,
): Promise<Response> {
  const { clinicId, userId } = tenant(context);
  const config = {
    fornecedor: {
      idKey: "fornecedor_id",
      rpcArchive: "financeiro_arquivar_fornecedor",
      rpcRestore: "financeiro_restaurar_fornecedor",
      rpcId: "p_supplier_id",
    },
    marca: {
      idKey: "marca_id",
      rpcArchive: "financeiro_arquivar_marca",
      rpcRestore: "financeiro_restaurar_marca",
      rpcId: "p_brand_id",
    },
    produto: {
      idKey: "produto_id",
      rpcArchive: "financeiro_arquivar_produto",
      rpcRestore: "financeiro_restaurar_produto",
      rpcId: "p_product_id",
    },
  }[kind];
  const id = requiredUuid(payload.id ?? payload[config.idKey], config.idKey);
  const rpcPayload: JsonRecord = {
    p_clinic_id: clinicId,
    p_user_id: userId,
    p_expected_version: expectedVersion(payload),
    p_reason: operationReason(payload),
    p_request_id: operationId(payload),
    [config.rpcId]: id,
  };
  const result = await rpc(restore ? config.rpcRestore : config.rpcArchive, rpcPayload);
  if (!isRecord(result)) {
    throw new ApiError(502, `${kind}_archive_failed`, "Não foi possível alterar o cadastro.");
  }
  return success(req, context, {
    [CATALOG_READ_CONFIG[kind].responseKey]: presentCatalog(kind, result),
  });
}

function presentProductCost(
  row: JsonRecord,
  supplierName: string | null = null,
  cancellation: JsonRecord | null = null,
): JsonRecord {
  return {
    id: row.id,
    produto_id: row.product_id,
    fornecedor_id: row.supplier_id,
    fornecedor_nome: supplierName,
    fonte: row.source,
    data_custo: row.cost_date,
    condicao_pagamento: row.payment_condition,
    quantidade_embalagem: numberFrom(row.package_quantity),
    unidade_embalagem: row.package_unit,
    custo_total: numberFrom(row.total_cost),
    custo_unitario: numberFrom(row.unit_cost),
    observacoes: row.notes,
    atual: row.is_current,
    operation_id: row.operation_id,
    criado_em: row.created_at,
    cancelado: cancellation !== null,
    cancelamento: cancellation
      ? {
        id: cancellation.id,
        motivo: cancellation.reason,
        resultado: cancellation.result_status,
        custo_substituto_id: cancellation.replacement_cost_id,
        cancelado_em: cancellation.cancelled_at,
      }
      : null,
  };
}

async function handleListProductCosts(
  req: Request,
  context: DualAuthContext,
  payload: JsonRecord,
): Promise<Response> {
  const { clinicId } = tenant(context);
  const productId = requiredUuid(payload.produto_id ?? payload.id, "produto_id");
  const page = integerValue(payload.pagina, "pagina", 1, 1, 100_000);
  const pageSize = integerValue(payload.por_pagina, "por_pagina", 50, 1, MAX_PAGE_SIZE);
  const offset = (page - 1) * pageSize;
  const result = await admin(
    "/rest/v1/financeiro_produto_custos?select=id,product_id,supplier_id,source,cost_date," +
      "payment_condition,package_quantity,package_unit,total_cost,unit_cost,notes,is_current," +
      `operation_id,created_at&clinic_id=eq.${encode(clinicId)}` +
      `&product_id=eq.${encode(productId)}&order=cost_date.desc,created_at.desc` +
      `&limit=${pageSize + 1}&offset=${offset}`,
  );
  if (!result.response.ok) {
    throw new ApiError(
      502,
      "product_costs_read_failed",
      "Não foi possível ler os custos do produto.",
    );
  }
  const costRows = rows(result.data);
  const costIds = costRows.map((row) => row.id).filter(validUuid);
  const cancellationByCost = new Map<string, JsonRecord>();
  if (costIds.length) {
    const cancellations = await admin(
      "/rest/v1/financeiro_produto_custo_cancelamentos?select=id,cost_id," +
        "replacement_cost_id,reason,result_status,operation_id,cancelled_at" +
        `&clinic_id=eq.${encode(clinicId)}&cost_id=in.${inFilter(costIds)}` +
        `&limit=${costIds.length}`,
    );
    if (!cancellations.response.ok) {
      throw new ApiError(
        502,
        "product_cost_cancellations_read_failed",
        "Não foi possível ler os cancelamentos de custos.",
      );
    }
    for (const cancellation of rows(cancellations.data)) {
      if (validUuid(cancellation.cost_id)) {
        cancellationByCost.set(cancellation.cost_id, cancellation);
      }
    }
  }
  const supplierIds = [...new Set(costRows.map((row) => row.supplier_id).filter(validUuid))];
  const supplierNames = new Map<string, string>();
  if (supplierIds.length) {
    const suppliers = await admin(
      "/rest/v1/financeiro_fornecedores?select=id,name" +
        `&clinic_id=eq.${encode(clinicId)}&id=in.${
          inFilter(supplierIds)
        }&limit=${supplierIds.length}`,
    );
    if (!suppliers.response.ok) {
      throw new ApiError(502, "suppliers_read_failed", "Não foi possível ler os fornecedores.");
    }
    for (const row of rows(suppliers.data)) {
      if (typeof row.id === "string" && typeof row.name === "string") {
        supplierNames.set(row.id, row.name);
      }
    }
  }
  return success(req, context, {
    custos: costRows.slice(0, pageSize).map((row) =>
      presentProductCost(
        row,
        typeof row.supplier_id === "string" ? supplierNames.get(row.supplier_id) || null : null,
        typeof row.id === "string" ? cancellationByCost.get(row.id) || null : null,
      )
    ),
    paginacao: { pagina: page, por_pagina: pageSize, tem_mais: costRows.length > pageSize },
  });
}

async function handleSaveProductCost(
  req: Request,
  context: DualAuthContext,
  payload: JsonRecord,
): Promise<Response> {
  const { clinicId, userId } = tenant(context);
  const productId = requiredUuid(payload.produto_id ?? payload.id, "produto_id");
  const supplierId = optionalUuid(payload.fornecedor_id, "fornecedor_id");
  if (supplierId) {
    await assertParty(clinicId, "financeiro_fornecedores", supplierId, "invalid_supplier");
  }
  const result = await rpc("financeiro_salvar_custo_produto", {
    p_clinic_id: clinicId,
    p_user_id: userId,
    p_product_id: productId,
    p_expected_product_version: expectedVersion(payload),
    p_supplier_id: supplierId,
    p_source: requiredText(payload.fonte, "fonte", 2, 160),
    p_cost_date: dateValue(payload.data_custo, "data_custo"),
    p_payment_condition: optionalText(payload.condicao_pagamento, "condicao_pagamento", 80),
    p_package_quantity: decimalValue(
      payload.quantidade_embalagem,
      "quantidade_embalagem",
      4,
    ),
    p_package_unit: requiredText(payload.unidade_embalagem, "unidade_embalagem", 1, 40),
    p_total_cost: decimalValue(payload.custo_total, "custo_total", 2),
    p_unit_cost: decimalValue(payload.custo_unitario, "custo_unitario", 4),
    p_notes: optionalText(payload.observacoes, "observacoes", 1000),
    p_is_current: booleanValue(payload.atual, "atual", false),
    p_operation_id: operationId(payload),
    p_reason: operationReason(payload),
    p_request_id: context.requestId,
  });
  if (!isRecord(result) || !isRecord(result.custo) || !isRecord(result.produto)) {
    throw new ApiError(502, "product_cost_save_failed", "Não foi possível salvar o custo.");
  }
  return success(req, context, {
    custo: presentProductCost(result.custo),
    produto: presentProduct(result.produto),
    idempotente: result.idempotente === true,
  }, result.idempotente === true ? 200 : 201);
}

async function handleCancelProductCost(
  req: Request,
  context: DualAuthContext,
  payload: JsonRecord,
): Promise<Response> {
  const { clinicId, userId } = tenant(context);
  const costId = requiredUuid(payload.custo_id ?? payload.id, "custo_id");
  const result = await rpc("financeiro_cancelar_custo_produto", {
    p_clinic_id: clinicId,
    p_user_id: userId,
    p_cost_id: costId,
    p_expected_product_version: expectedVersion(payload),
    p_reason: operationReason(payload),
    p_operation_id: operationId(payload),
    p_request_id: context.requestId,
  });
  if (
    !isRecord(result) || !isRecord(result.cancelamento) ||
    !isRecord(result.custo) || !isRecord(result.produto)
  ) {
    throw new ApiError(
      502,
      "product_cost_cancel_failed",
      "Não foi possível cancelar o custo.",
    );
  }
  return success(req, context, {
    custo: presentProductCost(result.custo, null, result.cancelamento),
    custo_substituto: isRecord(result.custo_substituto)
      ? presentProductCost(result.custo_substituto)
      : null,
    produto: presentProduct(result.produto),
    idempotente: result.idempotente === true,
  });
}

function normalizePurchaseItems(value: unknown): JsonRecord[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 50) {
    throw new ApiError(422, "invalid_items", "Inclua de 1 a 50 itens na compra.");
  }
  return value.map((item, index) => {
    if (!isRecord(item)) throw new ApiError(422, "invalid_items", "Item de compra inválido.");
    const lot = optionalText(item.lote ?? item.lot, `lote_${index}`, 100);
    const expiry = optionalDate(item.validade ?? item.expiry, `validade_${index}`);
    if ((lot === null) !== (expiry === null)) {
      throw new ApiError(
        422,
        "invalid_lot_expiry",
        "Informe lote e validade juntos em cada item controlado.",
      );
    }
    return {
      produto_id: requiredUuid(item.produto_id, `produto_${index}`),
      quantidade: decimalValue(item.quantidade, `quantidade_${index}`, 4),
      valor_unitario: decimalValue(item.valor_unitario, `valor_unitario_${index}`, 4, true),
      lote: lot,
      validade: expiry,
      posicao: index + 1,
    };
  });
}

function purchaseItemIdentity(item: JsonRecord): JsonRecord {
  return {
    produto_id: String(item.produto_id ?? item.product_id ?? ""),
    quantidade: numberFrom(item.quantidade ?? item.quantity),
    valor_unitario: numberFrom(item.valor_unitario ?? item.unit_cost),
    lote: normalizeSearchName(String(item.lote ?? item.lot ?? "")),
    validade: String(item.validade ?? item.expiry ?? ""),
    posicao: numberFrom(item.posicao ?? item.position),
  };
}

function purchaseItemsEqual(requested: JsonRecord[], stored: JsonRecord[]): boolean {
  const normalize = (items: JsonRecord[]) =>
    items.map(purchaseItemIdentity).sort((left, right) =>
      Number(left.posicao) - Number(right.posicao)
    );
  return JSON.stringify(normalize(requested)) === JSON.stringify(normalize(stored));
}

async function purchaseDuplicateCandidate(
  clinicId: string,
  supplierId: string,
  purchaseDate: string,
  invoice: string | null,
  condition: string,
  installments: number,
  freight: string,
  items: JsonRecord[],
): Promise<{ match: "exact" | "possible"; purchase: JsonRecord; candidate: JsonRecord } | null> {
  const subtotal = items.reduce(
    (sum, item) =>
      sum + Math.round(numberFrom(item.quantidade) * numberFrom(item.valor_unitario) * 100),
    0,
  ) / 100;
  const total = Math.round((subtotal + numberFrom(freight)) * 100) / 100;
  let path = "/rest/v1/financeiro_compras?select=id,supplier_id,expense_entry_id,purchase_date," +
    "invoice_number,payment_condition,installments,items_subtotal,freight_amount,total_amount," +
    "state,created_at&clinic_id=eq." + encode(clinicId) + "&supplier_id=eq." + encode(supplierId);
  if (invoice) {
    path += "&invoice_number=not.is.null";
  } else {
    path += "&invoice_number=is.null&purchase_date=eq." + encode(purchaseDate) +
      "&payment_condition=eq." + encode(condition) + "&installments=eq." + installments +
      "&items_subtotal=eq." + encode(String(subtotal)) + "&freight_amount=eq." + encode(freight) +
      "&total_amount=eq." + encode(String(total));
  }
  path += "&order=created_at.asc,id.asc&limit=500";
  const result = await admin(path);
  if (!result.response.ok) {
    throw new ApiError(
      502,
      "purchase_duplicate_check_failed",
      "Não foi possível conferir compras anteriores.",
    );
  }
  let candidates = rows(result.data);
  if (invoice) {
    const normalizedInvoice = normalizeExactText(invoice);
    candidates = candidates.filter((row) =>
      normalizeExactText(String(row.invoice_number || "")) === normalizedInvoice
    );
  }
  if (!candidates.length) return null;

  const ids = candidates.map((row) => row.id).filter(validUuid);
  const itemResult = await admin(
    "/rest/v1/financeiro_compra_itens?select=purchase_id,product_id,quantity,unit_cost,position,lot,expiry" +
      `&clinic_id=eq.${encode(clinicId)}&purchase_id=in.${inFilter(ids)}` +
      "&order=purchase_id.asc,position.asc&limit=25000",
  );
  if (!itemResult.response.ok) {
    throw new ApiError(
      502,
      "purchase_duplicate_items_failed",
      "Não foi possível conferir os itens da compra.",
    );
  }
  const grouped = new Map<string, JsonRecord[]>();
  for (const row of rows(itemResult.data)) {
    if (!validUuid(row.purchase_id)) continue;
    const group = grouped.get(row.purchase_id) || [];
    group.push(row);
    grouped.set(row.purchase_id, group);
  }
  const purchase = invoice
    ? candidates[0]
    : candidates.find((row) =>
      validUuid(row.id) && purchaseItemsEqual(items, grouped.get(row.id) || [])
    );
  if (!purchase || !validUuid(purchase.id)) return null;

  const supplierResult = await admin(
    "/rest/v1/financeiro_fornecedores?select=id,name&clinic_id=eq." + encode(clinicId) +
      "&id=eq." + encode(supplierId) + "&limit=1",
  );
  const supplier = supplierResult.response.ok ? rows(supplierResult.data)[0] : null;
  const storedItems = grouped.get(purchase.id) || [];
  const productIds = storedItems.map((row) => row.product_id).filter(validUuid);
  const productNames = new Map<string, string>();
  if (productIds.length) {
    const productResult = await admin(
      "/rest/v1/financeiro_produtos?select=id,name&clinic_id=eq." + encode(clinicId) +
        `&id=in.${inFilter([...new Set(productIds)])}`,
    );
    if (productResult.response.ok) {
      for (const product of rows(productResult.data)) {
        if (validUuid(product.id) && typeof product.name === "string") {
          productNames.set(product.id, product.name);
        }
      }
    }
  }
  return {
    match: invoice ? "exact" : "possible",
    purchase,
    candidate: {
      id: purchase.id,
      lancamento_id: purchase.expense_entry_id,
      fornecedor_id: purchase.supplier_id,
      fornecedor: supplier && typeof supplier.name === "string" ? supplier.name : "Fornecedor",
      data_compra: purchase.purchase_date,
      numero_documento: purchase.invoice_number,
      condicao_pagamento: purchase.payment_condition,
      parcelas: purchase.installments,
      subtotal_itens: numberFrom(purchase.items_subtotal),
      valor_frete: numberFrom(purchase.freight_amount),
      total: numberFrom(purchase.total_amount),
      situacao: purchase.state,
      itens: storedItems.map((row) => ({
        produto_id: row.product_id,
        produto: validUuid(row.product_id)
          ? productNames.get(row.product_id) || "Produto"
          : "Produto",
        quantidade: numberFrom(row.quantity),
        valor_unitario: numberFrom(row.unit_cost),
        lote: row.lot,
        validade: row.expiry,
      })),
    },
  };
}

async function handleCreatePurchase(
  req: Request,
  context: DualAuthContext,
  payload: JsonRecord,
): Promise<Response> {
  const { clinicId, userId } = tenant(context);
  const key = requiredUuid(payload.idempotency_key, "idempotency_key");
  const supplierId = requiredUuid(payload.fornecedor_id, "fornecedor_id");
  const purchaseDate = dateValue(payload.data_compra, "data_compra");
  const invoice = optionalText(
    payload.numero_documento ?? payload.nota_fiscal,
    "numero_documento",
    80,
  );
  const condition = enumValue(payload.condicao_pagamento, "condicao_pagamento", PAYMENT_CONDITIONS);
  const installments = integerValue(payload.parcelas, "parcelas", 1, 1, 120);
  if (
    (condition === "avista" && installments !== 1) ||
    (condition !== "avista" && installments < 2)
  ) {
    throw new ApiError(
      422,
      "invalid_purchase_installments",
      condition === "avista"
        ? "Compra a vista deve ter exatamente uma parcela."
        : "Compra parcelada ou com entrada e saldo deve ter pelo menos duas parcelas.",
    );
  }
  const category = requiredText(payload.categoria, "categoria", 2, 100);
  const notes = optionalText(payload.observacoes, "observacoes", 1000);
  const freight = decimalValue(
    payload.valor_frete ?? payload.frete ?? 0,
    "valor_frete",
    2,
    true,
  );
  const items = normalizePurchaseItems(payload.itens);
  await assertParty(clinicId, "financeiro_fornecedores", supplierId, "invalid_supplier");
  for (const productId of [...new Set(items.map((item) => item.produto_id as string))]) {
    await assertParty(clinicId, "financeiro_produtos", productId, "invalid_product");
  }
  const confirmDistinct = booleanValue(
    payload.confirmar_compra_distinta,
    "confirmar_compra_distinta",
    false,
  );
  const duplicate = await purchaseDuplicateCandidate(
    clinicId,
    supplierId,
    purchaseDate,
    invoice,
    condition,
    installments,
    freight,
    items,
  );
  if (duplicate?.match === "exact") {
    throw new ApiError(
      409,
      "purchase_exact_duplicate",
      "Esta compra já foi cadastrada. Abra o registro existente.",
      {
        tipo: "compra",
        correspondencia: "exata",
        existing_id: duplicate.purchase.id,
        candidato: duplicate.candidate,
      },
    );
  }
  if (duplicate?.match === "possible" && !confirmDistinct) {
    throw new ApiError(
      409,
      "purchase_possible_duplicate",
      "Há uma compra muito parecida já cadastrada. Confira antes de continuar.",
      {
        tipo: "compra",
        correspondencia: "possivel",
        existing_id: duplicate.purchase.id,
        candidato: duplicate.candidate,
      },
    );
  }
  const confirmedDuplicateId = confirmDistinct
    ? requiredUuid(payload.compra_duplicada_id, "compra_duplicada_id")
    : null;
  if (confirmDistinct && (!duplicate || duplicate.purchase.id !== confirmedDuplicateId)) {
    throw new ApiError(
      409,
      "purchase_duplicate_confirmation_stale",
      "A compra parecida mudou. Confira novamente antes de continuar.",
    );
  }
  let result: unknown;
  try {
    result = await rpc("financeiro_criar_compra", {
      p_clinic_id: clinicId,
      p_user_id: userId,
      p_supplier_id: supplierId,
      p_purchase_date: purchaseDate,
      p_invoice_number: invoice,
      p_payment_condition: condition,
      p_installments: installments,
      p_category: category,
      p_notes: notes,
      p_items: items,
      p_idempotency_key: key,
      p_request_id: context.requestId,
      p_freight_amount: freight,
      p_confirm_distinct: confirmDistinct,
      p_duplicate_reason: confirmDistinct
        ? requiredText(payload.motivo_duplicidade, "motivo_duplicidade", 3, 500)
        : null,
      p_duplicate_operation_id: confirmDistinct ? operationId(payload) : null,
    });
  } catch (error) {
    if (
      error instanceof ApiError &&
      ["purchase_exact_duplicate", "purchase_possible_duplicate"].includes(error.code)
    ) {
      const concurrent = await purchaseDuplicateCandidate(
        clinicId,
        supplierId,
        purchaseDate,
        invoice,
        condition,
        installments,
        freight,
        items,
      );
      if (concurrent) {
        throw new ApiError(error.status, error.code, error.publicMessage, {
          tipo: "compra",
          correspondencia: concurrent.match === "exact" ? "exata" : "possivel",
          existing_id: concurrent.purchase.id,
          candidato: concurrent.candidate,
        });
      }
    }
    throw error;
  }
  if (!isRecord(result)) {
    throw new ApiError(502, "purchase_create_failed", "Não foi possível registrar a compra.");
  }
  const purchaseId = requiredUuid(result.compra_id, "compra_id");
  const savedPurchase = await getPurchase(clinicId, purchaseId, null);
  if (!savedPurchase) {
    throw new ApiError(
      502,
      "purchase_read_failed",
      "A compra foi salva, mas não pôde ser recarregada.",
    );
  }
  return success(req, context, {
    compra: presentPurchase(savedPurchase),
    idempotente: result.idempotente === true,
  }, result.idempotente === true ? 200 : 201);
}

function presentPurchase(row: JsonRecord): JsonRecord {
  return {
    id: row.id,
    fornecedor_id: row.supplier_id,
    lancamento_id: row.expense_entry_id,
    data_compra: row.purchase_date,
    numero_documento: row.invoice_number,
    condicao_pagamento: row.payment_condition,
    parcelas: row.installments,
    subtotal_itens: numberFrom(row.items_subtotal),
    valor_frete: numberFrom(row.freight_amount),
    total: numberFrom(row.total_amount),
    situacao: row.state,
    observacoes: row.notes,
    versao: row.version,
    cancelada_em: row.cancelled_at,
    motivo_cancelamento: row.cancellation_reason,
    criado_em: row.created_at,
    atualizado_em: row.updated_at,
  };
}

async function getPurchase(
  clinicId: string,
  purchaseId: string | null,
  entryId: string | null,
): Promise<JsonRecord | null> {
  const identity = purchaseId
    ? `id=eq.${encode(purchaseId)}`
    : `expense_entry_id=eq.${encode(entryId || "")}`;
  const result = await admin(
    "/rest/v1/financeiro_compras?select=id,supplier_id,expense_entry_id,purchase_date," +
      "invoice_number,payment_condition,installments,items_subtotal,freight_amount," +
      "total_amount,state,notes,version," +
      "cancelled_at,cancellation_reason,created_at,updated_at" +
      `&clinic_id=eq.${encode(clinicId)}&${identity}&limit=1`,
  );
  if (!result.response.ok) {
    throw new ApiError(502, "purchase_read_failed", "Não foi possível ler a compra.");
  }
  return rows(result.data)[0] || null;
}

async function handleGetPurchase(
  req: Request,
  context: DualAuthContext,
  payload: JsonRecord,
): Promise<Response> {
  const { clinicId } = tenant(context);
  const purchaseId = optionalUuid(payload.id ?? payload.compra_id, "compra_id");
  const entryId = purchaseId
    ? null
    : requiredUuid(payload.lancamento_id ?? payload.entry_id, "lancamento_id");
  const purchase = await getPurchase(clinicId, purchaseId, entryId);
  if (!purchase) throw new ApiError(404, "purchase_not_found", "Compra não encontrada.");
  const itemsResult = await admin(
    "/rest/v1/financeiro_compra_itens?select=id,product_id,quantity,unit_cost,total_amount," +
      "position,lot,expiry,allocated_freight,landed_unit_cost," +
      `created_at&clinic_id=eq.${encode(clinicId)}&purchase_id=eq.${encode(String(purchase.id))}` +
      "&order=position.asc&limit=100",
  );
  if (!itemsResult.response.ok) {
    throw new ApiError(
      502,
      "purchase_items_read_failed",
      "Não foi possível ler os itens da compra.",
    );
  }
  return success(req, context, {
    compra: {
      ...presentPurchase(purchase),
      itens: rows(itemsResult.data).map((item) => ({
        id: item.id,
        produto_id: item.product_id,
        quantidade: numberFrom(item.quantity),
        custo_unitario: numberFrom(item.unit_cost),
        total: numberFrom(item.total_amount),
        posicao: numberFrom(item.position),
        lote: item.lot,
        validade: item.expiry,
        frete_rateado: numberFrom(item.allocated_freight),
        custo_unitario_efetivo: numberFrom(item.landed_unit_cost),
      })),
    },
  });
}

async function handleListInventory(
  req: Request,
  context: DualAuthContext,
  payload: JsonRecord,
): Promise<Response> {
  const { clinicId } = tenant(context);
  const productId = optionalUuid(payload.produto_id, "produto_id");
  const includeEmpty = booleanValue(payload.incluir_zerados, "incluir_zerados", false);
  const pageSize = integerValue(payload.limite, "limite", 300, 1, 500);
  let path = "/rest/v1/financeiro_estoque_saldos?select=product_id,lot_id,lot,expiry," +
    "unit,quantity_balance,effective_value" +
    `&clinic_id=eq.${encode(clinicId)}`;
  if (productId) path += `&product_id=eq.${encode(productId)}`;
  if (!includeEmpty) path += "&quantity_balance=gt.0";
  path += `&order=expiry.asc,lot.asc&limit=${pageSize}`;
  const result = await admin(path);
  if (!result.response.ok) {
    throw new ApiError(502, "inventory_read_failed", "Não foi possível ler o estoque.");
  }
  return success(req, context, {
    estoque: rows(result.data).map((row) => ({
      produto_id: row.product_id,
      lote_id: row.lot_id,
      lote: row.lot,
      validade: row.expiry,
      unidade: row.unit,
      saldo: numberFrom(row.quantity_balance),
      valor_efetivo: numberFrom(row.effective_value),
    })),
  });
}

async function handleListPendingStockRegularizations(
  req: Request,
  context: DualAuthContext,
  payload: JsonRecord,
): Promise<Response> {
  const { clinicId } = tenant(context);
  const pageSize = integerValue(payload.limite, "limite", 100, 1, 200);
  const result = await admin(
    "/rest/v1/financeiro_compras_itens_pendentes_estoque?select=" +
      "purchase_item_id,purchase_id,supplier_id,supplier_name,purchase_date,invoice_number," +
      "product_id,product_name,unit,quantity,unit_cost,total_amount" +
      `&clinic_id=eq.${
        encode(clinicId)
      }&order=purchase_date.asc,purchase_item_id.asc&limit=${pageSize}`,
  );
  if (!result.response.ok) {
    throw new ApiError(
      502,
      "pending_stock_read_failed",
      "Não foi possível ler as compras antigas pendentes de lote.",
    );
  }
  return success(req, context, {
    pendencias: rows(result.data).map((row) => ({
      item_compra_id: row.purchase_item_id,
      compra_id: row.purchase_id,
      fornecedor_id: row.supplier_id,
      fornecedor: row.supplier_name,
      data_compra: row.purchase_date,
      documento: row.invoice_number,
      produto_id: row.product_id,
      produto: row.product_name,
      unidade: row.unit,
      quantidade: numberFrom(row.quantity),
      custo_unitario_original: numberFrom(row.unit_cost),
      custo_total_original: numberFrom(row.total_amount),
    })),
  });
}

async function handleRegularizePurchaseItemStock(
  req: Request,
  context: DualAuthContext,
  payload: JsonRecord,
): Promise<Response> {
  const { clinicId, userId } = tenant(context);
  const purchaseItemId = requiredUuid(
    payload.item_compra_id ?? payload.purchase_item_id,
    "item_compra_id",
  );
  const result = await rpc("financeiro_regularizar_item_compra_estoque", {
    p_clinic_id: clinicId,
    p_user_id: userId,
    p_purchase_item_id: purchaseItemId,
    p_lot: requiredText(payload.lote, "lote", 1, 100),
    p_expiry: dateValue(payload.validade, "validade"),
    p_use_as_current_cost: booleanValue(
      payload.usar_como_custo_atual,
      "usar_como_custo_atual",
      false,
    ),
    p_operation_id: operationId(payload),
    p_reason: operationReason(payload),
    p_request_id: context.requestId,
  });
  if (!isRecord(result)) {
    throw new ApiError(
      502,
      "stock_regularization_failed",
      "Não foi possível regularizar o estoque deste item.",
    );
  }
  return success(req, context, {
    regularizacao: {
      item_compra_id: result.purchase_item_id,
      lote_id: result.lot_id,
      movimento_id: result.movement_id,
      custo_id: result.cost_id,
      usado_como_custo_atual: result.used_as_current_cost === true,
      idempotente: result.idempotent === true,
    },
  });
}

async function handleCancelPurchase(
  req: Request,
  context: DualAuthContext,
  payload: JsonRecord,
): Promise<Response> {
  const { clinicId, userId } = tenant(context);
  const suppliedPurchaseId = optionalUuid(payload.id ?? payload.compra_id, "compra_id");
  const suppliedEntryId = suppliedPurchaseId
    ? null
    : requiredUuid(payload.lancamento_id ?? payload.entry_id, "lancamento_id");
  const purchase = await getPurchase(clinicId, suppliedPurchaseId, suppliedEntryId);
  if (!purchase || !validUuid(purchase.id)) {
    throw new ApiError(404, "purchase_not_found", "Compra não encontrada.");
  }
  const result = await rpc("financeiro_cancelar_compra", {
    p_clinic_id: clinicId,
    p_user_id: userId,
    p_purchase_id: purchase.id,
    p_expected_version: expectedVersion(payload),
    p_reason: operationReason(payload),
    p_operation_id: operationId(payload),
    p_request_id: context.requestId,
  });
  if (!isRecord(result)) {
    throw new ApiError(502, "purchase_cancel_failed", "Não foi possível cancelar a compra.");
  }
  return success(req, context, {
    compra: {
      id: result.compra_id,
      lancamento_id: result.lancamento_id,
      versao: result.versao,
      estornos_criados: result.estornos,
      estornos_estoque: result.estornos_estoque,
      parcelas_canceladas: result.parcelas_canceladas,
      cancelada: true,
    },
    idempotente: result.idempotente === true,
  });
}

function duplicateEntityQuery(
  clinicId: string,
  entityKind: string,
  ids: string[],
): string | null {
  const filter = inFilter(ids);
  const tenantFilter = `&clinic_id=eq.${encode(clinicId)}`;
  switch (entityKind) {
    case "cliente":
      return `/rest/v1/patients?select=id,full_name${tenantFilter}&id=in.${filter}`;
    case "fornecedor":
      return `/rest/v1/financeiro_fornecedores?select=id,name${tenantFilter}&id=in.${filter}`;
    case "marca":
      return `/rest/v1/financeiro_marcas?select=id,name${tenantFilter}&id=in.${filter}`;
    case "produto":
      return `/rest/v1/financeiro_produtos?select=id,name,presentation,unit${tenantFilter}&id=in.${filter}`;
    case "compra":
      return "/rest/v1/financeiro_compras?select=id,purchase_date,invoice_number," +
        `total_amount,freight_amount${tenantFilter}&id=in.${filter}`;
    case "lancamento":
      return "/rest/v1/financeiro_lancamentos?select=id,description,competence_date," +
        `total_amount,entry_type${tenantFilter}&id=in.${filter}`;
    case "pagamento":
      return "/rest/v1/financeiro_pagamentos?select=id,paid_at,amount,payment_method" +
        `${tenantFilter}&id=in.${filter}`;
    case "custo_produto":
      return "/rest/v1/financeiro_produto_custos?select=id,product_id,cost_date," +
        `total_cost,unit_cost${tenantFilter}&id=in.${filter}`;
    case "foto_clinica":
      return "/rest/v1/protocol_photos?select=id,protocol_id,phase,taken_at," +
        `protocols!inner(clinic_id)&id=in.${filter}&protocols.clinic_id=eq.${encode(clinicId)}`;
    default:
      return null;
  }
}

function duplicateEntityDescriptor(
  entityKind: string,
  entityId: string,
  row: JsonRecord | undefined,
): JsonRecord {
  const suffix = entityId.slice(0, 8);
  if (!row) {
    return { id: entityId, titulo: "Registro " + suffix, resumo: "Cadastro não localizado" };
  }
  switch (entityKind) {
    case "cliente":
      return { id: entityId, titulo: String(row.full_name || "Cliente"), resumo: "Cliente · " + suffix };
    case "fornecedor":
      return { id: entityId, titulo: String(row.name || "Fornecedor"), resumo: "Fornecedor · " + suffix };
    case "marca":
      return { id: entityId, titulo: String(row.name || "Marca"), resumo: "Marca · " + suffix };
    case "produto": {
      const presentation = typeof row.presentation === "string" && row.presentation.trim()
        ? " · " + row.presentation.trim()
        : "";
      const unit = typeof row.unit === "string" && row.unit.trim() ? " · " + row.unit.trim() : "";
      return {
        id: entityId,
        titulo: String(row.name || "Produto"),
        resumo: "Produto" + presentation + unit + " · " + suffix,
      };
    }
    case "compra":
      return {
        id: entityId,
        titulo: "Compra de " + String(row.purchase_date || "data não informada"),
        resumo: "Total " + numberFrom(row.total_amount).toFixed(2) +
          " · frete " + numberFrom(row.freight_amount).toFixed(2) +
          (row.invoice_number ? " · documento " + String(row.invoice_number).slice(0, 80) : "") +
          " · " + suffix,
      };
    case "lancamento":
      return {
        id: entityId,
        titulo: String(row.description || "Lançamento").slice(0, 200),
        resumo: String(row.entry_type || "lançamento") + " · " +
          String(row.competence_date || "sem data") + " · " +
          numberFrom(row.total_amount).toFixed(2) + " · " + suffix,
      };
    case "pagamento":
      return {
        id: entityId,
        titulo: "Pagamento · " + String(row.payment_method || "forma não informada"),
        resumo: String(row.paid_at || "sem data") + " · " +
          numberFrom(row.amount).toFixed(2) + " · " + suffix,
      };
    case "custo_produto":
      return {
        id: entityId,
        titulo: "Custo de produto · " + String(row.cost_date || "sem data"),
        resumo: "Total " + numberFrom(row.total_cost).toFixed(2) +
          " · unitário " + numberFrom(row.unit_cost).toFixed(4) + " · " + suffix,
      };
    case "foto_clinica":
      return {
        id: entityId,
        titulo: "Foto clínica · " + String(row.phase || "categoria não informada"),
        resumo: String(row.taken_at || "sem data") + " · " + suffix,
      };
    default:
      return { id: entityId, titulo: "Registro " + suffix, resumo: entityKind };
  }
}

async function duplicateDescriptors(
  clinicId: string,
  reviewRows: JsonRecord[],
): Promise<Map<string, JsonRecord>> {
  const idsByKind = new Map<string, string[]>();
  for (const review of reviewRows) {
    const kind = String(review.entity_kind || "");
    const ids = idsByKind.get(kind) || [];
    if (validUuid(review.primary_id)) ids.push(review.primary_id);
    if (validUuid(review.candidate_id)) ids.push(review.candidate_id);
    idsByKind.set(kind, ids);
  }
  const output = new Map<string, JsonRecord>();
  await Promise.all([...idsByKind.entries()].map(async ([kind, ids]) => {
    const unique = [...new Set(ids)];
    const path = duplicateEntityQuery(clinicId, kind, unique);
    if (!path) return;
    const result = await admin(path);
    const byId = new Map<string, JsonRecord>();
    if (result.response.ok) {
      for (const row of rows(result.data)) {
        if (validUuid(row.id)) byId.set(row.id, row);
      }
    }
    for (const id of unique) {
      output.set(kind + ":" + id, duplicateEntityDescriptor(kind, id, byId.get(id)));
    }
  }));
  return output;
}

async function handleListDuplicateReviews(
  req: Request,
  context: DualAuthContext,
  payload: JsonRecord,
): Promise<Response> {
  const { clinicId } = tenant(context);
  const page = integerValue(payload.pagina, "pagina", 1, 1, 100_000);
  const pageSize = integerValue(payload.por_pagina, "por_pagina", 50, 1, 100);
  const requestedStatus = payload.status === undefined || payload.status === null || payload.status === ""
    ? "pendente"
    : requiredText(payload.status, "status", 3, 40).toLowerCase();
  if (requestedStatus !== "todos" && !DUPLICATE_REVIEW_STATUSES.has(requestedStatus)) {
    throw new ApiError(422, "invalid_duplicate_status", "Filtro de duplicidades inválido.");
  }
  const offset = (page - 1) * pageSize;
  let path = "/rest/v1/clinic_duplicate_reviews?select=id,entity_kind,primary_id," +
    "candidate_id,match_kind,reason_code,status,detected_at,reviewed_at,review_reason,version" +
    `&clinic_id=eq.${encode(clinicId)}`;
  if (requestedStatus !== "todos") path += `&status=eq.${encode(requestedStatus)}`;
  path += `&order=detected_at.desc,id.desc&limit=${pageSize + 1}&offset=${offset}`;
  const result = await admin(path);
  if (!result.response.ok) {
    throw new ApiError(502, "duplicate_reviews_read_failed", "Não foi possível ler a fila de duplicidades.");
  }
  const allRows = rows(result.data);
  const visibleRows = allRows.slice(0, pageSize);
  const descriptors = await duplicateDescriptors(clinicId, visibleRows);
  return success(req, context, {
    revisoes: visibleRows.map((review) => ({
      id: review.id,
      entidade: review.entity_kind,
      tipo_correspondencia: review.match_kind,
      motivo_tecnico: review.reason_code,
      status: review.status,
      versao: review.version,
      detectado_em: review.detected_at,
      revisado_em: review.reviewed_at,
      motivo_revisao: review.review_reason,
      principal: validUuid(review.primary_id)
        ? descriptors.get(String(review.entity_kind) + ":" + review.primary_id) || null
        : null,
      candidato: validUuid(review.candidate_id)
        ? descriptors.get(String(review.entity_kind) + ":" + review.candidate_id) || null
        : null,
    })),
    paginacao: {
      pagina: page,
      por_pagina: pageSize,
      tem_mais: allRows.length > pageSize,
    },
  });
}

async function handleResolveDuplicateReview(
  req: Request,
  context: DualAuthContext,
  payload: JsonRecord,
): Promise<Response> {
  const { clinicId, userId } = tenant(context);
  const domainOperationId = operationId(payload);
  const reviewId = requiredUuid(
    payload.revisao_id ?? payload.review_id ?? payload.id,
    "revisao_id",
  );
  const resolution = enumValue(
    payload.resolucao ?? payload.status,
    "resolucao",
    DUPLICATE_REVIEW_RESOLUTIONS,
  );
  const result = await rpc("financeiro_resolver_revisao_duplicidade", {
    p_clinic_id: clinicId,
    p_actor_id: userId,
    p_review_id: reviewId,
    p_expected_version: expectedVersion(payload),
    p_resolution: resolution,
    p_reason: requiredText(payload.motivo, "motivo", 10, 500),
    p_operation_id: domainOperationId,
    // A prova one-time audita com context.requestId. O evento de domínio usa a
    // chave idempotente da própria decisão para não colidir nem perder trilha.
    p_request_id: domainOperationId,
  });
  const resolved = rows(result)[0];
  if (!resolved || !validUuid(resolved.review_id)) {
    throw new ApiError(502, "duplicate_review_resolve_failed", "Não foi possível encerrar a revisão.");
  }
  return success(req, context, {
    revisao: {
      id: resolved.review_id,
      status: resolved.status,
      versao: resolved.version,
      revisado_em: resolved.reviewed_at,
    },
    idempotente: resolved.idempotent === true,
  });
}

async function handleListAudit(
  req: Request,
  context: DualAuthContext,
  payload: JsonRecord,
): Promise<Response> {
  const { clinicId } = tenant(context);
  const limit = integerValue(payload.limite, "limite", 100, 1, MAX_AUDIT_SIZE);
  let path = "/rest/v1/financeiro_auditoria?select=id,actor_id,entity,entity_id,action,details," +
    `request_id,created_at&clinic_id=eq.${encode(clinicId)}`;
  const from = payload.de === undefined ? null : dateTimeValue(payload.de, "de");
  const through = payload.ate === undefined ? null : dateTimeValue(payload.ate, "ate");
  if (from) path += `&created_at=gte.${encode(from)}`;
  if (through) path += `&created_at=lte.${encode(through)}`;
  if (payload.entidade !== undefined && payload.entidade !== null && payload.entidade !== "") {
    const entity = requiredText(payload.entidade, "entidade", 2, 80).toLowerCase();
    if (!SAFE_TECHNICAL_NAME.test(entity)) {
      throw new ApiError(422, "invalid_entity", "Entidade de auditoria inválida.");
    }
    path += `&entity=eq.${encode(entity)}`;
  }
  path += `&order=created_at.desc&limit=${limit}`;
  const result = await admin(path);
  if (!result.response.ok) {
    throw new ApiError(502, "audit_read_failed", "Não foi possível ler a auditoria.");
  }
  const auditRows = rows(result.data);
  const actorIds = [...new Set(auditRows.map((row) => row.actor_id).filter(validUuid))];
  const actorNames = new Map<string, string>();
  if (actorIds.length) {
    const members = await admin(
      "/rest/v1/clinic_members?select=user_id,display_name" +
        `&clinic_id=eq.${encode(clinicId)}&user_id=in.${inFilter(actorIds)}&limit=50`,
    );
    if (members.response.ok) {
      for (const row of rows(members.data)) {
        if (typeof row.user_id === "string" && typeof row.display_name === "string") {
          actorNames.set(row.user_id, row.display_name);
        }
      }
    }
  }
  return success(req, context, {
    auditoria: auditRows.map((row) => ({
      id: row.id,
      ator: typeof row.actor_id === "string"
        ? { id: row.actor_id, nome: actorNames.get(row.actor_id) || "Proprietário" }
        : null,
      entidade: row.entity,
      entidade_id: row.entity_id,
      acao: row.action,
      detalhes: row.details,
      solicitacao_id: row.request_id,
      criado_em: row.created_at,
    })),
  });
}

const requestAuth = new WeakMap<Request, DualAuthContext>();

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

  const authorization = (req.headers.get("authorization") || "").trim();
  if (!authorization) {
    return fail(req, "Entre com seu acesso individual e MFA.", 401, "authorization_required");
  }
  let context: DualAuthContext;
  try {
    context = await authenticateDual(req, AUTH_CONFIG);
    requestAuth.set(req, context);
    tenant(context);
  } catch (error) {
    if (error instanceof DualAuthError) {
      if (error.auditContext) {
        await writeClinicAudit(AUTH_CONFIG, error.auditContext, {
          entity: "financial_access",
          action: "authenticate",
          outcome: "denied",
          details: { endpoint: "financeiro-fichas", reason_code: error.code },
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
    if (RECENT_PASSWORD_ACTIONS.has(action)) {
      const targetId = await protectedTargetForAction(action, payload, context);
      await requireProtectedOperation(req, context, payload, action, targetId);
    }
    if (
      action === "criar_compra" &&
      booleanValue(payload.confirmar_compra_distinta, "confirmar_compra_distinta", false)
    ) {
      await requireProtectedOperation(
        req,
        context,
        payload,
        "confirmar_compra_distinta",
        requiredUuid(payload.compra_duplicada_id, "compra_duplicada_id"),
      );
    }
    let response: Response;
    switch (action) {
      case "resumo":
        response = await handleSummary(req, context, payload);
        break;
      case "listar_lancamentos":
        response = await handleListEntries(req, context, payload);
        break;
      case "criar_lancamento":
        response = await handleCreateEntry(req, context, payload);
        break;
      case "registrar_atendimento":
        response = await handleRegisterService(req, context, payload);
        break;
      case "programar_parcelas":
        response = await handleProgramInstallments(req, context, payload);
        break;
      case "registrar_pagamento":
        response = await handlePayment(req, context, payload, false);
        break;
      case "estornar_pagamento":
        response = await handlePayment(req, context, payload, true);
        break;
      case "cancelar_lancamento":
        response = await handleCancelEntry(req, context, payload);
        break;
      case "listar_clientes":
        response = await handleListClients(req, context, payload);
        break;
      case "obter_cliente":
        response = await handleGetClient(req, context, payload);
        break;
      case "sugerir_clientes":
        response = await handleSuggestClients(req, context, payload);
        break;
      case "criar_cliente":
        response = await handleCreateClient(req, context, payload);
        break;
      case "editar_cliente":
        response = await handleEditClient(req, context, payload);
        break;
      case "arquivar_cliente":
        response = await handleClientArchiveState(req, context, payload, false);
        break;
      case "restaurar_cliente":
        response = await handleClientArchiveState(req, context, payload, true);
        break;
      case "listar_catalogos":
        response = await handleListCatalogs(req, context, payload);
        break;
      case "criar_marca":
        response = await handleCreateBrand(req, context, payload);
        break;
      case "obter_marca":
        response = await handleGetCatalog(req, context, payload, "marca");
        break;
      case "editar_marca":
        response = await handleEditBrand(req, context, payload);
        break;
      case "arquivar_marca":
        response = await handleCatalogArchiveState(req, context, payload, "marca", false);
        break;
      case "restaurar_marca":
        response = await handleCatalogArchiveState(req, context, payload, "marca", true);
        break;
      case "criar_produto":
        response = await handleCreateProduct(req, context, payload);
        break;
      case "obter_produto":
        response = await handleGetCatalog(req, context, payload, "produto");
        break;
      case "editar_produto":
        response = await handleEditProduct(req, context, payload);
        break;
      case "arquivar_produto":
        response = await handleCatalogArchiveState(req, context, payload, "produto", false);
        break;
      case "restaurar_produto":
        response = await handleCatalogArchiveState(req, context, payload, "produto", true);
        break;
      case "listar_custos_produto":
        response = await handleListProductCosts(req, context, payload);
        break;
      case "salvar_custo_produto":
        response = await handleSaveProductCost(req, context, payload);
        break;
      case "cancelar_custo_produto":
        response = await handleCancelProductCost(req, context, payload);
        break;
      case "criar_fornecedor":
        response = await handleCreateSupplier(req, context, payload);
        break;
      case "obter_fornecedor":
        response = await handleGetCatalog(req, context, payload, "fornecedor");
        break;
      case "editar_fornecedor":
        response = await handleEditSupplier(req, context, payload);
        break;
      case "arquivar_fornecedor":
        response = await handleCatalogArchiveState(req, context, payload, "fornecedor", false);
        break;
      case "restaurar_fornecedor":
        response = await handleCatalogArchiveState(req, context, payload, "fornecedor", true);
        break;
      case "criar_compra":
        response = await handleCreatePurchase(req, context, payload);
        break;
      case "obter_compra":
        response = await handleGetPurchase(req, context, payload);
        break;
      case "listar_estoque":
        response = await handleListInventory(req, context, payload);
        break;
      case "listar_pendencias_estoque":
        response = await handleListPendingStockRegularizations(req, context, payload);
        break;
      case "regularizar_item_compra_estoque":
        response = await handleRegularizePurchaseItemStock(req, context, payload);
        break;
      case "cancelar_compra":
        response = await handleCancelPurchase(req, context, payload);
        break;
      case "listar_revisoes_duplicidade":
        response = await handleListDuplicateReviews(req, context, payload);
        break;
      case "resolver_revisao_duplicidade":
        response = await handleResolveDuplicateReview(req, context, payload);
        break;
      case "listar_auditoria":
        response = await handleListAudit(req, context, payload);
        break;
      default:
        throw new ApiError(422, "invalid_action", "Ação financeira inválida.");
    }
    await writeClinicAudit(AUTH_CONFIG, context, {
      entity: "financial",
      action,
      outcome: response.ok ? "success" : "error",
      details: { endpoint: "financeiro-fichas", status_code: response.status },
    });
    return response;
  } catch (error) {
    if (error instanceof ApiError) {
      await writeClinicAudit(AUTH_CONFIG, context, {
        entity: "financial",
        action: SAFE_TECHNICAL_NAME.test(action) ? action : "request",
        outcome: "error",
        details: {
          endpoint: "financeiro-fichas",
          reason_code: error.code,
          status_code: error.status,
        },
      });
      return fail(req, error.publicMessage, error.status, error.code, error.details);
    }
    console.error("Financial request failed");
    await writeClinicAudit(AUTH_CONFIG, context, {
      entity: "financial",
      action: SAFE_TECHNICAL_NAME.test(action) ? action : "request",
      outcome: "error",
      details: { endpoint: "financeiro-fichas", reason_code: "unhandled_error" },
    });
    return fail(req, "Não foi possível concluir a operação agora.", 500, "internal_error");
  }
}

if (import.meta.main) Deno.serve(handleRequest);

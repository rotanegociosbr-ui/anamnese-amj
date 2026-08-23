import "@supabase/functions-js/edge-runtime.d.ts";
import {
  authenticateDual,
  authResponseFields,
  DualAuthConfig,
  DualAuthContext,
  DualAuthError,
  writeClinicAudit,
} from "../_shared/dual-auth.ts";

type JsonRecord = Record<string, unknown>;

const SUPABASE_URL = (Deno.env.get("SUPABASE_URL") || "").replace(/\/+$/, "");
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const LEGACY_CLINIC_ID = Deno.env.get("CLINIC_ID") || "";
const AUTH_CONFIG: DualAuthConfig = {
  supabaseUrl: SUPABASE_URL,
  serviceRoleKey: SERVICE_ROLE,
  legacyHash: (Deno.env.get("PAINEL_HASH_SENHA") || "").toLowerCase(),
  legacyClinicId: LEGACY_CLINIC_ID,
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
const PRODUCT_UNITS = new Set(["un", "cx", "frasco", "seringa", "ml", "mg", "g", "kit"]);
const SOURCE_KINDS = new Set(["anamnese", "documento_clinico", "agendamento"]);
const PAYMENT_SITUATIONS = new Set(["recebido", "parcial", "pendente"]);
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

function fail(req: Request, message: string, status: number, code?: string): Response {
  const body: JsonRecord = { erro: message };
  if (code) body.codigo = code;
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
  for (const row of rows(result.data)) {
    if (typeof row.entry_id !== "string") continue;
    const list = grouped.get(row.entry_id) || [];
    list.push({
      id: row.id,
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

async function presentEntries(clinicId: string, rawRows: JsonRecord[]): Promise<JsonRecord[]> {
  const patientIds = rawRows.map((row) => row.patient_id).filter(validUuid);
  const supplierIds = rawRows.map((row) => row.supplier_id).filter(validUuid);
  const entryIds = rawRows.map((row) => row.id).filter(validUuid);
  const [patientNames, supplierNames, payments] = await Promise.all([
    relatedNames(clinicId, "patients", patientIds),
    relatedNames(clinicId, "financeiro_fornecedores", supplierIds),
    paymentsForEntries(clinicId, entryIds),
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
      cliente: patientId ? { id: patientId, nome: patientNames.get(patientId) || "Cliente" } : null,
      fornecedor: supplierId
        ? { id: supplierId, nome: supplierNames.get(supplierId) || "Fornecedor" }
        : null,
      pagamentos: payments.get(id) || [],
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
  const key = requiredUuid(payload.idempotency_key, "idempotency_key");
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
  const dueDate = dateValue(payload.vencimento ?? serviceDate, "vencimento");
  if (dueDate < serviceDate) {
    throw new ApiError(422, "invalid_due_date", "O vencimento não pode ser anterior ao atendimento.");
  }
  const total = decimalValue(payload.valor_total, "valor_total", 2);
  const totalNumber = numberFrom(total);
  const situation = enumValue(
    payload.situacao_pagamento,
    "situacao_pagamento",
    PAYMENT_SITUATIONS,
  );
  const installments = integerValue(payload.parcelas, "parcelas", 1, 1, 120);
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
        p_installments: installments,
        p_reference: null,
        p_reversed_payment_id: null,
        p_idempotency_key: paymentKey,
        p_request_id: context.requestId,
      }),
      "pagamento_id",
    );
  }
  const row = await getEntryById(clinicId, entryId);
  if (!row) {
    throw new ApiError(502, "service_read_failed", "Atendimento salvo, mas não foi possível recarregá-lo.");
  }
  return success(req, context, {
    lancamento: (await presentEntries(clinicId, [row]))[0] || null,
    pagamento_id: paymentId,
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

function presentPayment(row: JsonRecord): JsonRecord {
  return {
    id: row.id,
    lancamento_id: row.entry_id,
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
  const key = requiredUuid(payload.idempotency_key, "idempotency_key");
  const entryId = requiredUuid(payload.lancamento_id ?? payload.entry_id, "lancamento_id");
  const originalId = refund
    ? requiredUuid(payload.pagamento_id ?? payload.payment_id, "pagamento_id")
    : null;
  let original: JsonRecord | null = null;
  if (originalId) {
    original = await getPaymentById(clinicId, originalId);
    if (!original || original.entry_id !== entryId || original.movement_type !== "pagamento") {
      throw new ApiError(404, "payment_not_found", "Pagamento não encontrado.");
    }
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
    return success(req, context, { pagamento: presentPayment(existing), idempotente: true });
  }
  const result = await rpc("financeiro_registrar_pagamento", {
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
  });
  const id = requiredUuid(result, "pagamento_id");
  const created = await getPaymentById(clinicId, id);
  if (!created || !matchesRequest(created)) {
    throw new ApiError(409, "idempotency_key_reused", "Use uma nova chave para dados diferentes.");
  }
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
  requiredUuid(payload.idempotency_key, "idempotency_key");
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
    p_request_id: context.requestId,
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
    cpf_mascarado: maskCpf(row.cpf),
    status: row.status,
    criado_em: row.created_at,
    atualizado_em: row.updated_at,
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
  const offset = (page - 1) * pageSize;
  let path = "/rest/v1/patients?select=id,full_name,birth_date,phone,email,emergency_phone,cpf," +
    "status,created_at,updated_at" +
    `&clinic_id=eq.${encode(clinicId)}&archived_at=is.null`;
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
    clientes: clientRows.slice(0, pageSize).map(presentClient),
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
  if (LEGACY_CLINIC_ID.trim()) {
    if (!validUuid(LEGACY_CLINIC_ID)) {
      throw new ApiError(503, "legacy_source_tenant_unavailable", "Fontes clínicas indisponíveis.");
    }
    if (LEGACY_CLINIC_ID.toLowerCase() !== clinicId) {
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
  const [anamneses, documents, appointments, links] = await Promise.all([
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
  if (![anamneses, documents, appointments, links].every((result) => result.response.ok)) {
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
  const filtered = candidates.filter((candidate) => {
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
      exige_confirmacao: true,
    };
  });
  return success(req, context, { candidatos: filtered, mesclagem_automatica: false });
}

async function getClientByIdempotency(clinicId: string, key: string): Promise<JsonRecord | null> {
  const result = await admin(
    "/rest/v1/patients?select=id,full_name,birth_date,phone,email,emergency_phone,cpf,status," +
      "created_at,updated_at,idempotency_key" +
      `&clinic_id=eq.${encode(clinicId)}&idempotency_key=eq.${encode(key)}&limit=1`,
  );
  if (!result.response.ok) {
    throw new ApiError(502, "idempotency_read_failed", "Não foi possível validar a solicitação.");
  }
  return rows(result.data)[0] || null;
}

async function getClientById(clinicId: string, id: string): Promise<JsonRecord | null> {
  const result = await admin(
    "/rest/v1/patients?select=id,full_name,birth_date,phone,email,emergency_phone,cpf,status," +
      "created_at,updated_at,idempotency_key" +
      `&clinic_id=eq.${encode(clinicId)}&id=eq.${encode(id)}&archived_at=is.null&limit=1`,
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

  if (!existing && (cpf || phone)) {
    const filters: string[] = [];
    if (cpf) filters.push(`cpf.eq.${cpf}`);
    if (phone) filters.push(`phone.eq.${phone}`);
    const duplicate = await admin(
      "/rest/v1/patients?select=id,full_name&clinic_id=eq." + encode(clinicId) +
        "&archived_at=is.null&or=(" + filters.map(encode).join(",") + ")&limit=5",
    );
    if (!duplicate.response.ok) {
      throw new ApiError(502, "duplicate_check_failed", "Não foi possível conferir o cadastro.");
    }
    if (rows(duplicate.data).length) {
      throw new ApiError(
        409,
        "possible_duplicate",
        "Já existe um cliente com o mesmo CPF ou telefone.",
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

async function handleListCatalogs(req: Request, context: DualAuthContext): Promise<Response> {
  const { clinicId } = tenant(context);
  const [forms, suppliers, brands, products] = await Promise.all([
    paymentForms(),
    admin(
      "/rest/v1/financeiro_fornecedores?select=id,name,document,phone,email,active,created_at," +
        `updated_at&clinic_id=eq.${encode(clinicId)}&archived_at=is.null&order=name.asc&limit=1000`,
    ),
    admin(
      "/rest/v1/financeiro_marcas?select=id,name,active,created_at,updated_at" +
        `&clinic_id=eq.${encode(clinicId)}&archived_at=is.null&order=name.asc&limit=1000`,
    ),
    admin(
      "/rest/v1/financeiro_produtos?select=id,brand_id,name,product_type,unit,reference_cost," +
        "sale_price,anvisa_registration,stock_control,active,created_at,updated_at" +
        `&clinic_id=eq.${encode(clinicId)}&archived_at=is.null&order=name.asc&limit=2000`,
    ),
  ]);
  if (![suppliers, brands, products].every((result) => result.response.ok)) {
    throw new ApiError(502, "catalogs_read_failed", "Não foi possível ler os catálogos.");
  }
  return success(req, context, {
    formas_pagamento: forms,
    fornecedores: rows(suppliers.data).map((row) => ({
      id: row.id,
      nome: row.name,
      documento: row.document,
      telefone: row.phone,
      email: row.email,
      ativo: row.active,
      criado_em: row.created_at,
      atualizado_em: row.updated_at,
    })),
    marcas: rows(brands.data).map((row) => ({
      id: row.id,
      nome: row.name,
      ativo: row.active,
      criado_em: row.created_at,
      atualizado_em: row.updated_at,
    })),
    produtos: rows(products.data).map((row) => ({
      id: row.id,
      marca_id: row.brand_id,
      nome: row.name,
      tipo: row.product_type,
      unidade: row.unit,
      custo_referencia: row.reference_cost === null ? null : numberFrom(row.reference_cost),
      preco_venda: row.sale_price === null ? null : numberFrom(row.sale_price),
      registro_anvisa: row.anvisa_registration,
      controla_estoque: row.stock_control,
      ativo: row.active,
      criado_em: row.created_at,
      atualizado_em: row.updated_at,
    })),
  });
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
    marca: { id: created.row.id, nome: created.row.name, ativo: created.row.active },
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
  const document =
    payload.documento === undefined || payload.documento === null || payload.documento === ""
      ? null
      : String(payload.documento).replace(/\D/g, "");
  if (document && !/^\d{11,14}$/.test(document)) {
    throw new ApiError(422, "invalid_document", "CPF/CNPJ do fornecedor inválido.");
  }
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
    fornecedor: {
      id: created.row.id,
      nome: created.row.name,
      documento: created.row.document,
      telefone: created.row.phone,
      email: created.row.email,
      ativo: created.row.active,
    },
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
      row.unit === unit && nullableDecimalEqual(row.reference_cost, referenceCost) &&
      nullableDecimalEqual(row.sale_price, salePrice) && row.anvisa_registration === anvisa &&
      row.stock_control === stockControl,
  );
  return success(req, context, {
    produto: {
      id: created.row.id,
      marca_id: created.row.brand_id,
      nome: created.row.name,
      tipo: created.row.product_type,
      unidade: created.row.unit,
      custo_referencia: created.row.reference_cost === null
        ? null
        : numberFrom(created.row.reference_cost),
      preco_venda: created.row.sale_price === null ? null : numberFrom(created.row.sale_price),
      registro_anvisa: created.row.anvisa_registration,
      controla_estoque: created.row.stock_control,
    },
    idempotente: created.idempotent,
  }, created.idempotent ? 200 : 201);
}

function normalizePurchaseItems(value: unknown): JsonRecord[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 50) {
    throw new ApiError(422, "invalid_items", "Inclua de 1 a 50 itens na compra.");
  }
  return value.map((item, index) => {
    if (!isRecord(item)) throw new ApiError(422, "invalid_items", "Item de compra inválido.");
    return {
      produto_id: requiredUuid(item.produto_id, `produto_${index}`),
      quantidade: decimalValue(item.quantidade, `quantidade_${index}`, 4),
      valor_unitario: decimalValue(item.valor_unitario, `valor_unitario_${index}`, 4, true),
    };
  });
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
  const category = requiredText(payload.categoria, "categoria", 2, 100);
  const notes = optionalText(payload.observacoes, "observacoes", 1000);
  const items = normalizePurchaseItems(payload.itens);
  await assertParty(clinicId, "financeiro_fornecedores", supplierId, "invalid_supplier");
  for (const productId of [...new Set(items.map((item) => item.produto_id as string))]) {
    await assertParty(clinicId, "financeiro_produtos", productId, "invalid_product");
  }
  const result = await rpc("financeiro_criar_compra", {
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
  });
  if (!isRecord(result)) {
    throw new ApiError(502, "purchase_create_failed", "Não foi possível registrar a compra.");
  }
  return success(req, context, {
    compra: {
      id: result.compra_id,
      lancamento_id: result.lancamento_id,
      total: numberFrom(result.total),
    },
    idempotente: result.idempotente === true,
  }, result.idempotente === true ? 200 : 201);
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
      "authorization, apikey, content-type, x-client-info",
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
      case "sugerir_clientes":
        response = await handleSuggestClients(req, context, payload);
        break;
      case "criar_cliente":
        response = await handleCreateClient(req, context, payload);
        break;
      case "listar_catalogos":
        response = await handleListCatalogs(req, context);
        break;
      case "criar_marca":
        response = await handleCreateBrand(req, context, payload);
        break;
      case "criar_produto":
        response = await handleCreateProduct(req, context, payload);
        break;
      case "criar_fornecedor":
        response = await handleCreateSupplier(req, context, payload);
        break;
      case "criar_compra":
        response = await handleCreatePurchase(req, context, payload);
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
      return fail(req, error.publicMessage, error.status, error.code);
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

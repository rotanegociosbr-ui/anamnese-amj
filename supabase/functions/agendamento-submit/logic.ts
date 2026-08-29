export type JsonRecord = Record<string, unknown>;

export const FORM_VERSION = "agendamento-site-v1";
export const MAX_BODY_BYTES = 8 * 1024;
export const MIN_FILL_MS = 3_000;
export const MAX_FILL_MS = 12 * 60 * 60_000;
export const MAX_ADVANCE_DAYS = 180;

export const ALLOWED_ORIGINS = new Set([
  "https://anamariajacob.com.br",
  "https://www.anamariajacob.com.br",
]);

export const LOCAL_ORIGINS = new Set([
  "http://127.0.0.1:8765",
  "http://localhost:8765",
]);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const ALLOWED_KEYS = new Set([
  "idempotency_key",
  "started_at",
  "website",
  "nome",
  "telefone",
  "primeira_visita",
  "interesse",
  "data_preferida",
  "periodo",
  "consentimento_contato",
]);
const VISIT_KINDS = new Set(["primeira_avaliacao", "paciente_atual"]);
const INTERESTS = new Set([
  "avaliacao_sem_procedimento",
  "preenchimento_facial",
  "skinbooster",
  "toxina_botulinica",
  "fios_pdo",
  "intradermoterapia_facial",
  "intradermoterapia_capilar",
  "peeling",
  "microagulhamento_facial",
  "microagulhamento_capilar",
  "harmonizacao_facial",
  "aplicacao_intramuscular",
  "retorno_acompanhamento",
]);
const PERIODS = new Set(["manha", "tarde", "noite", "a_combinar"]);

export class SubmissionError extends Error {
  readonly status: number;
  readonly code: string;
  readonly publicMessage: string;

  constructor(
    status: number,
    code: string,
    publicMessage: string,
  ) {
    super(publicMessage);
    this.name = "SubmissionError";
    this.status = status;
    this.code = code;
    this.publicMessage = publicMessage;
  }
}

export interface NormalizedSubmission {
  idempotencyKey: string;
  startedAt: string;
  fullName: string;
  normalizedName: string;
  phone: string;
  visitKind: string;
  interest: string;
  preferredDate: string;
  preferredPeriod: string;
  contactConsent: true;
  consentVersion: typeof FORM_VERSION;
  payloadSha256: string;
  dedupSha256: string;
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cleanText(value: unknown, field: string, min: number, max: number): string {
  if (typeof value !== "string") {
    throw new SubmissionError(422, `invalid_${field}`, "Confira os campos informados.");
  }
  const normalized = value.trim().replace(/\s+/g, " ");
  const hasControlCharacter = Array.from(normalized).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
  if (
    normalized.length < min || normalized.length > max ||
    hasControlCharacter
  ) {
    throw new SubmissionError(422, `invalid_${field}`, "Confira os campos informados.");
  }
  return normalized;
}

export function normalizeIdentity(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(
    /[^a-z0-9]+/g,
    "",
  );
}

export function normalizePhone(value: unknown): string {
  if (typeof value !== "string") {
    throw new SubmissionError(422, "invalid_telefone", "Confira o WhatsApp informado.");
  }
  let digits = value.replace(/[^0-9]+/g, "");
  if ((digits.length === 12 || digits.length === 13) && digits.startsWith("55")) {
    digits = digits.slice(2);
  }
  if (!/^[1-9][0-9]{9,10}$/.test(digits)) {
    throw new SubmissionError(422, "invalid_telefone", "Confira o WhatsApp informado.");
  }
  return `+55${digits}`;
}

export function saoPauloDate(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function addDays(date: string, days: number): string {
  const parsed = new Date(`${date}T12:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function validCalendarDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function normalizeSubmission(
  value: unknown,
  now = new Date(),
): Promise<NormalizedSubmission> {
  if (!isRecord(value)) {
    throw new SubmissionError(400, "invalid_json", "Não foi possível ler a solicitação.");
  }
  for (const key of Object.keys(value)) {
    if (!ALLOWED_KEYS.has(key)) {
      throw new SubmissionError(422, "unexpected_field", "Confira os campos informados.");
    }
  }
  if (typeof value.website !== "string" || value.website.trim() !== "") {
    throw new SubmissionError(422, "invalid_submission", "Confira os campos informados.");
  }
  const idempotencyKey = cleanText(value.idempotency_key, "idempotency_key", 36, 36)
    .toLowerCase();
  if (!UUID_PATTERN.test(idempotencyKey)) {
    throw new SubmissionError(
      422,
      "invalid_idempotency_key",
      "Atualize a página e tente novamente.",
    );
  }
  const startedAt = cleanText(value.started_at, "started_at", 20, 40);
  const startedTime = Date.parse(startedAt);
  const elapsed = now.getTime() - startedTime;
  if (!Number.isFinite(startedTime) || elapsed < MIN_FILL_MS || elapsed > MAX_FILL_MS) {
    throw new SubmissionError(422, "invalid_fill_time", "Atualize a página e tente novamente.");
  }
  const fullName = cleanText(value.nome, "nome", 2, 160);
  const normalizedName = normalizeIdentity(fullName);
  if (normalizedName.length < 2) {
    throw new SubmissionError(422, "invalid_nome", "Confira o nome informado.");
  }
  const phone = normalizePhone(value.telefone);
  const visitKind = cleanText(value.primeira_visita, "primeira_visita", 3, 40);
  const interest = cleanText(value.interesse, "interesse", 3, 80);
  const preferredDate = cleanText(value.data_preferida, "data_preferida", 10, 10);
  const preferredPeriod = cleanText(value.periodo, "periodo", 3, 30);
  if (!VISIT_KINDS.has(visitKind) || !INTERESTS.has(interest) || !PERIODS.has(preferredPeriod)) {
    throw new SubmissionError(422, "invalid_option", "Confira as opções selecionadas.");
  }
  const today = saoPauloDate(now);
  if (
    !validCalendarDate(preferredDate) || preferredDate < today ||
    preferredDate > addDays(today, MAX_ADVANCE_DAYS)
  ) {
    throw new SubmissionError(422, "invalid_data_preferida", "Confira a data preferida.");
  }
  if (value.consentimento_contato !== true) {
    throw new SubmissionError(422, "contact_consent_required", "Confirme o aceite para contato.");
  }

  const persisted = {
    full_name: fullName,
    normalized_name: normalizedName,
    phone,
    visit_kind: visitKind,
    interest,
    preferred_date: preferredDate,
    preferred_period: preferredPeriod,
    contact_consent: true,
    consent_version: FORM_VERSION,
    started_at: new Date(startedTime).toISOString(),
  };
  const dedup = {
    normalized_name: normalizedName,
    phone,
    preferred_date: preferredDate,
    preferred_period: preferredPeriod,
    interest,
  };
  const [payloadSha256, dedupSha256] = await Promise.all([
    sha256(JSON.stringify(persisted)),
    sha256(JSON.stringify(dedup)),
  ]);
  if (!SHA256_PATTERN.test(payloadSha256) || !SHA256_PATTERN.test(dedupSha256)) {
    throw new SubmissionError(500, "hash_unavailable", "Não foi possível concluir agora.");
  }
  return {
    idempotencyKey,
    startedAt: persisted.started_at,
    fullName,
    normalizedName,
    phone,
    visitKind,
    interest,
    preferredDate,
    preferredPeriod,
    contactConsent: true,
    consentVersion: FORM_VERSION,
    payloadSha256,
    dedupSha256,
  };
}

export async function readJsonBody(req: Request): Promise<unknown> {
  const declared = Number(req.headers.get("content-length") || "0");
  if (!Number.isFinite(declared) || declared < 0 || declared > MAX_BODY_BYTES) {
    throw new SubmissionError(
      413,
      "body_too_large",
      "A solicitação ultrapassou o limite permitido.",
    );
  }
  if (!req.body) {
    throw new SubmissionError(400, "empty_body", "Não foi possível ler a solicitação.");
  }
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new SubmissionError(
        413,
        "body_too_large",
        "A solicitação ultrapassou o limite permitido.",
      );
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    throw new SubmissionError(400, "invalid_json", "Não foi possível ler a solicitação.");
  }
}

export function isAllowedOrigin(origin: string, allowLocalOrigins = false): boolean {
  return ALLOWED_ORIGINS.has(origin) || (allowLocalOrigins && LOCAL_ORIGINS.has(origin));
}

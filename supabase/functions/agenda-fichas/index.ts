const HASH_SENHA = (Deno.env.get("PAINEL_HASH_SENHA") || "").toLowerCase();
const HASH_SENHA_CONFIGURADO = /^[0-9a-f]{64}$/.test(HASH_SENHA);
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const MAX_BODY_BYTES = 32 * 1024;
const MAX_LIST_ITEMS = 300;

const ALLOWED_ORIGINS = new Set([
  "https://anamariajacob.com.br",
  "https://www.anamariajacob.com.br",
  "http://127.0.0.1:8765",
  "http://localhost:8765",
]);

const CATEGORIES = new Set(["avaliacao", "procedimento", "retorno", "acompanhamento"]);
const STATUSES = new Set([
  "solicitado",
  "aguardando_confirmacao",
  "confirmado",
  "concluido",
  "cancelado",
  "nao_compareceu",
  "reagendado",
]);
const ACTIVE_STATUSES = new Set(["solicitado", "aguardando_confirmacao", "confirmado"]);
const ORIGINS = new Set(["painel", "site", "whatsapp", "telefone", "outro"]);
const REMINDER_TYPES = new Set(["confirmacao", "24h", "2h", "retorno"]);
const OPEN_REMINDER_STATUSES = new Set(["pendente", "pronto", "falhou"]);
const STATUS_TRANSITIONS: Record<string, ReadonlySet<string>> = {
  solicitado: new Set([
    "aguardando_confirmacao",
    "confirmado",
    "concluido",
    "nao_compareceu",
    "cancelado",
  ]),
  aguardando_confirmacao: new Set(["confirmado", "concluido", "nao_compareceu", "cancelado"]),
  confirmado: new Set(["concluido", "nao_compareceu", "cancelado"]),
  concluido: new Set(),
  cancelado: new Set(),
  nao_compareceu: new Set(),
  reagendado: new Set(),
};

const APPOINTMENT_SELECT = [
  "id",
  "idempotency_key",
  "nome",
  "telefone",
  "email",
  "categoria",
  "procedimento",
  "inicio_em",
  "fim_em",
  "fuso_horario",
  "status",
  "origem",
  "observacoes",
  "retorno_de_id",
  "retorno_em",
  "lembretes_autorizados",
  "lembretes_autorizados_em",
  "lembretes_revogados_em",
  "lembrete_24h",
  "lembrete_2h",
  "cancelado_em",
  "motivo_cancelamento",
  "arquivado_em",
  "versao",
  "created_at",
  "updated_at",
].join(",");

const REMINDER_SELECT = [
  "id",
  "agendamento_id",
  "tipo",
  "canal",
  "previsto_em",
  "status",
  "tentativas",
  "template_key",
  "enviado_em",
  "provider_message_id",
  "erro_codigo",
  "marcado_manualmente",
  "created_at",
  "updated_at",
].join(",");

type JsonRecord = Record<string, unknown>;

interface AppointmentRow {
  id: string;
  idempotency_key: string;
  nome: string;
  telefone: string;
  email: string | null;
  categoria: string;
  procedimento: string;
  inicio_em: string;
  fim_em: string;
  fuso_horario: string;
  status: string;
  origem: string;
  observacoes: string | null;
  retorno_de_id: string | null;
  retorno_em: string | null;
  lembretes_autorizados: boolean;
  lembretes_autorizados_em: string | null;
  lembretes_revogados_em: string | null;
  lembrete_24h: boolean;
  lembrete_2h: boolean;
  cancelado_em: string | null;
  motivo_cancelamento: string | null;
  arquivado_em: string | null;
  versao: number;
  created_at: string;
  updated_at: string;
}

interface ReminderRow {
  id: string;
  agendamento_id: string;
  tipo: string;
  canal: string;
  previsto_em: string;
  status: string;
  tentativas: number;
  template_key: string;
  enviado_em: string | null;
  provider_message_id: string | null;
  erro_codigo: string | null;
  marcado_manualmente: boolean;
  created_at: string;
  updated_at: string;
}

interface NormalizedAppointment {
  nome: string;
  telefone: string;
  email: string | null;
  categoria: string;
  procedimento: string;
  inicio_em: string;
  fim_em: string;
  fuso_horario: "America/Sao_Paulo";
  status: string;
  origem: string;
  observacoes: string | null;
  retorno_de_id: string | null;
  retorno_em: string | null;
  lembretes_autorizados: boolean;
  lembretes_autorizados_em: string | null;
  lembretes_revogados_em: string | null;
  lembrete_24h: boolean;
  lembrete_2h: boolean;
  cancelado_em: string | null;
  motivo_cancelamento: string | null;
}

class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const attempts = new Map<string, { count: number; resetAt: number }>();

function cors(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") || "";
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.has(origin)
      ? origin
      : "https://anamariajacob.com.br",
    "Access-Control-Allow-Headers": "content-type, x-senha",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

function json(req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...cors(req),
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store, max-age=0",
      "Pragma": "no-cache",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
}

function fail(req: Request, code: string, message: string, status = 400): Response {
  return json(req, { erro: message, codigo: code }, status);
}

function equalConstantTime(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index++) {
    difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return difference === 0;
}

function hasOwn(source: JsonRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(source, key);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function optionalText(value: unknown, max: number): string | null {
  const text = stringValue(value);
  return text ? text.slice(0, max) : null;
}

function requiredText(value: unknown, field: string, min: number, max: number): string {
  const text = stringValue(value);
  if (text.length < min || text.length > max) {
    throw new ApiError(422, "invalid_" + field, `Confira o campo ${field}.`);
  }
  return text;
}

function validUuid(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function normalizePhone(value: unknown): string {
  let digits = stringValue(value).replace(/\D/g, "");
  if (digits.startsWith("55") && (digits.length === 12 || digits.length === 13)) {
    digits = digits.slice(2);
  }
  if (!/^[1-9][0-9]{9,10}$/.test(digits)) {
    throw new ApiError(422, "invalid_phone", "Informe um WhatsApp brasileiro com DDD.");
  }
  return "+55" + digits;
}

function normalizeEmail(value: unknown): string | null {
  const email = stringValue(value).toLowerCase();
  if (!email) return null;
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new ApiError(422, "invalid_email", "Confira o e-mail informado.");
  }
  return email;
}

function normalizeDateTime(value: unknown, field: string): string {
  const text = stringValue(value);
  if (!/(?:z|[+-]\d{2}:\d{2})$/i.test(text)) {
    throw new ApiError(422, "invalid_" + field, `Informe ${field} com data, hora e fuso horário.`);
  }
  const timestamp = Date.parse(text);
  if (!Number.isFinite(timestamp)) {
    throw new ApiError(422, "invalid_" + field, `Confira o campo ${field}.`);
  }
  return new Date(timestamp).toISOString();
}

function normalizeDateOnly(value: unknown): string | null {
  const text = stringValue(value);
  if (!text) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw new ApiError(422, "invalid_return_date", "Confira a data recomendada de retorno.");
  }
  const date = new Date(text + "T12:00:00Z");
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== text) {
    throw new ApiError(422, "invalid_return_date", "Confira a data recomendada de retorno.");
  }
  return text;
}

function dateKeyInSaoPaulo(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const part = (type: string): string => parts.find((item) => item.type === type)?.value || "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function validateStatusTransition(current: string, next: string): void {
  if (current === next) return;
  if (!STATUS_TRANSITIONS[current]?.has(next)) {
    throw new ApiError(
      422,
      "invalid_status_transition",
      "Essa mudança de status não é permitida. Atualize a agenda e confira o atendimento.",
    );
  }
}

function boolValue(value: unknown, fallback: boolean, field: string): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") {
    throw new ApiError(422, "invalid_" + field, `Confira o campo ${field}.`);
  }
  return value;
}

function integerValue(
  value: unknown,
  fallback: number,
  field: string,
  min: number,
  max: number,
): number {
  if (value === undefined) return fallback;
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new ApiError(422, "invalid_" + field, `Confira o campo ${field}.`);
  }
  return number;
}

function appointmentRows(data: unknown): AppointmentRow[] {
  return Array.isArray(data) ? data as AppointmentRow[] : [];
}

function reminderRows(data: unknown): ReminderRow[] {
  return Array.isArray(data) ? data as ReminderRow[] : [];
}

async function readJsonBody(req: Request): Promise<JsonRecord> {
  if (!req.body) throw new ApiError(400, "empty_body", "Envie os dados da solicitação.");
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new ApiError(413, "payload_too_large", "A solicitação excedeu o limite permitido.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(merged));
  } catch {
    throw new ApiError(400, "invalid_json", "Os dados enviados não formam um JSON válido.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ApiError(400, "invalid_body", "Envie um objeto JSON válido.");
  }
  return parsed as JsonRecord;
}

async function admin(
  path: string,
  init: RequestInit = {},
): Promise<{ response: Response; data: unknown }> {
  if (!SUPABASE_URL || !SERVICE_ROLE) {
    throw new ApiError(503, "backend_unavailable", "Agenda temporariamente indisponível.");
  }
  const headers = new Headers(init.headers);
  headers.set("apikey", SERVICE_ROLE);
  headers.set("Authorization", "Bearer " + SERVICE_ROLE);
  headers.set("Content-Type", "application/json");
  const response = await fetch(SUPABASE_URL + path, { ...init, headers });
  const raw = await response.text();
  let data: unknown = null;
  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch {
      data = null;
    }
  }
  return { response, data };
}

function normalizeAppointment(
  payload: JsonRecord,
  existing?: AppointmentRow,
): NormalizedAppointment {
  const now = new Date().toISOString();
  const nameSource = hasOwn(payload, "nome") ? payload.nome : existing?.nome;
  const phoneSource = hasOwn(payload, "telefone") ? payload.telefone : existing?.telefone;
  const categorySource = hasOwn(payload, "categoria")
    ? payload.categoria
    : hasOwn(payload, "tipo")
    ? payload.tipo
    : existing?.categoria;
  const procedureSource = hasOwn(payload, "procedimento")
    ? payload.procedimento
    : existing?.procedimento;
  const startSource = hasOwn(payload, "data_hora")
    ? payload.data_hora
    : hasOwn(payload, "inicio_em")
    ? payload.inicio_em
    : existing?.inicio_em;

  const nome = requiredText(nameSource, "nome", 2, 120);
  const telefone = normalizePhone(phoneSource);
  const categoria = stringValue(categorySource).toLowerCase();
  if (!CATEGORIES.has(categoria)) {
    throw new ApiError(422, "invalid_category", "Escolha uma categoria válida.");
  }
  const procedimento = requiredText(procedureSource, "procedimento", 2, 160);
  const inicioEm = normalizeDateTime(startSource, "data_hora");
  const existingDuration = existing
    ? Math.round((Date.parse(existing.fim_em) - Date.parse(existing.inicio_em)) / 60_000)
    : 60;
  const durationSource = hasOwn(payload, "duracao_min") ? payload.duracao_min : undefined;
  const duracaoMin = integerValue(durationSource, existingDuration, "duracao_min", 15, 720);
  const fimEm = new Date(Date.parse(inicioEm) + duracaoMin * 60_000).toISOString();

  const statusSource = hasOwn(payload, "status")
    ? payload.status
    : existing?.status || "aguardando_confirmacao";
  const status = stringValue(statusSource).toLowerCase();
  if (!STATUSES.has(status)) {
    throw new ApiError(422, "invalid_status", "Escolha um status válido.");
  }

  const originSource = hasOwn(payload, "origem") ? payload.origem : existing?.origem || "painel";
  const origem = stringValue(originSource).toLowerCase();
  if (!ORIGINS.has(origem)) {
    throw new ApiError(422, "invalid_origin", "Origem de agendamento inválida.");
  }

  const emailSource = hasOwn(payload, "email") ? payload.email : existing?.email;
  const notesSource = hasOwn(payload, "observacoes") ? payload.observacoes : existing?.observacoes;
  const returnSource = hasOwn(payload, "retorno_em") ? payload.retorno_em : existing?.retorno_em;
  const parentSource = hasOwn(payload, "retorno_de_id")
    ? payload.retorno_de_id
    : existing?.retorno_de_id;
  const retornoDeId = stringValue(parentSource) || null;
  if (retornoDeId && !validUuid(retornoDeId)) {
    throw new ApiError(422, "invalid_return_parent", "Vínculo de retorno inválido.");
  }
  if (existing && retornoDeId === existing.id) {
    throw new ApiError(422, "invalid_return_parent", "Um retorno não pode apontar para ele mesmo.");
  }

  const authorizationValue = hasOwn(payload, "lembretes_autorizados")
    ? payload.lembretes_autorizados
    : hasOwn(payload, "autoriza_lembretes")
    ? payload.autoriza_lembretes
    : undefined;
  const remindersAuthorized = boolValue(
    authorizationValue,
    existing?.lembretes_autorizados || false,
    "lembretes_autorizados",
  );
  const reminder24Value = hasOwn(payload, "lembrete_24h") ? payload.lembrete_24h : undefined;
  const reminder2Value = hasOwn(payload, "lembrete_2h") ? payload.lembrete_2h : undefined;
  const reminder24 = remindersAuthorized
    ? boolValue(reminder24Value, existing?.lembrete_24h || false, "lembrete_24h")
    : false;
  const reminder2 = remindersAuthorized
    ? boolValue(reminder2Value, existing?.lembrete_2h || false, "lembrete_2h")
    : false;

  let authorizedAt: string | null = null;
  let revokedAt: string | null = null;
  if (remindersAuthorized) {
    authorizedAt = existing?.lembretes_autorizados ? existing.lembretes_autorizados_em || now : now;
  } else if (existing?.lembretes_autorizados) {
    authorizedAt = existing.lembretes_autorizados_em;
    revokedAt = now;
  } else {
    authorizedAt = existing?.lembretes_autorizados_em || null;
    revokedAt = existing?.lembretes_revogados_em || null;
  }

  const reasonSource = hasOwn(payload, "motivo_cancelamento")
    ? payload.motivo_cancelamento
    : existing?.motivo_cancelamento;
  const cancellationReason = status === "cancelado" ? optionalText(reasonSource, 500) : null;
  if (status === "cancelado" && (!cancellationReason || cancellationReason.length < 2)) {
    throw new ApiError(422, "cancellation_reason_required", "Informe o motivo do cancelamento.");
  }

  const retornoEm = normalizeDateOnly(returnSource);
  const appointmentDate = dateKeyInSaoPaulo(inicioEm);
  if (retornoEm && (!appointmentDate || retornoEm < appointmentDate)) {
    throw new ApiError(
      422,
      "return_before_appointment",
      "O retorno não pode ser anterior à data do atendimento.",
    );
  }

  return {
    nome,
    telefone,
    email: normalizeEmail(emailSource),
    categoria,
    procedimento,
    inicio_em: inicioEm,
    fim_em: fimEm,
    fuso_horario: "America/Sao_Paulo",
    status,
    origem,
    observacoes: optionalText(notesSource, 2000),
    retorno_de_id: retornoDeId,
    retorno_em: retornoEm,
    lembretes_autorizados: remindersAuthorized,
    lembretes_autorizados_em: authorizedAt,
    lembretes_revogados_em: revokedAt,
    lembrete_24h: reminder24,
    lembrete_2h: reminder2,
    cancelado_em: status === "cancelado" ? existing?.cancelado_em || now : null,
    motivo_cancelamento: cancellationReason,
  };
}

async function getAppointmentById(id: string): Promise<AppointmentRow | null> {
  const result = await admin(
    `/rest/v1/agendamentos_clinica?select=${APPOINTMENT_SELECT}&id=eq.${
      encodeURIComponent(id)
    }&limit=1`,
  );
  if (!result.response.ok) {
    throw new ApiError(502, "agenda_read_failed", "Não foi possível ler a agenda.");
  }
  return appointmentRows(result.data)[0] || null;
}

async function getAppointmentByIdempotency(key: string): Promise<AppointmentRow | null> {
  const result = await admin(
    `/rest/v1/agendamentos_clinica?select=${APPOINTMENT_SELECT}&idempotency_key=eq.${
      encodeURIComponent(key)
    }&limit=1`,
  );
  if (!result.response.ok) {
    throw new ApiError(
      502,
      "idempotency_lookup_failed",
      "Não foi possível verificar a solicitação.",
    );
  }
  return appointmentRows(result.data)[0] || null;
}

async function hasConflict(start: string, end: string, excludeId?: string): Promise<boolean> {
  let path = `/rest/v1/agendamentos_clinica?select=id` +
    `&arquivado_em=is.null` +
    `&status=in.(solicitado,aguardando_confirmacao,confirmado)` +
    `&inicio_em=lt.${encodeURIComponent(end)}` +
    `&fim_em=gt.${encodeURIComponent(start)}`;
  if (excludeId) path += `&id=neq.${encodeURIComponent(excludeId)}`;
  path += "&limit=1";
  const result = await admin(path);
  if (!result.response.ok) {
    throw new ApiError(
      502,
      "conflict_check_failed",
      "Não foi possível conferir a disponibilidade.",
    );
  }
  return Array.isArray(result.data) && result.data.length > 0;
}

async function getReminders(appointmentIds: string[]): Promise<ReminderRow[]> {
  if (!appointmentIds.length) return [];
  const ids = appointmentIds.map((id) => encodeURIComponent(id)).join(",");
  const result = await admin(
    `/rest/v1/agendamento_lembretes?select=${REMINDER_SELECT}` +
      `&agendamento_id=in.(${ids})&order=previsto_em.desc&limit=1500`,
  );
  if (!result.response.ok) {
    throw new ApiError(502, "reminders_read_failed", "Não foi possível ler os lembretes.");
  }
  return reminderRows(result.data);
}

function reminderPlan(
  row: AppointmentRow,
  includeConfirmation: boolean,
  now = Date.now(),
): JsonRecord[] {
  if (!row.lembretes_autorizados) return [];
  const active = ACTIVE_STATUSES.has(row.status);
  if (!active && row.status !== "concluido") return [];
  const updatedAt = new Date(now).toISOString();
  const rows: JsonRecord[] = [];
  const add = (tipo: string, planned: Date, template: string): void => {
    rows.push({
      agendamento_id: row.id,
      tipo,
      canal: "whatsapp",
      previsto_em: planned.toISOString(),
      status: planned.getTime() <= now ? "pronto" : "pendente",
      tentativas: 0,
      template_key: template,
      enviado_em: null,
      provider_message_id: null,
      erro_codigo: null,
      marcado_manualmente: false,
      updated_at: updatedAt,
    });
  };

  const start = Date.parse(row.inicio_em);
  if (
    active && includeConfirmation &&
    ["solicitado", "aguardando_confirmacao"].includes(row.status) &&
    now <= start + 60 * 60_000
  ) {
    add("confirmacao", new Date(now), "agenda_confirmacao_v1");
  }
  if (active && row.lembrete_24h && now < start - 2 * 60 * 60_000) {
    add("24h", new Date(start - 24 * 60 * 60_000), "agenda_lembrete_24h_v1");
  }
  if (active && row.lembrete_2h && now <= start + 60 * 60_000) {
    add("2h", new Date(start - 2 * 60 * 60_000), "agenda_lembrete_2h_v1");
  }
  if (row.retorno_em) {
    add("retorno", new Date(row.retorno_em + "T09:00:00-03:00"), "agenda_retorno_v1");
  }
  return rows;
}

async function cancelOpenReminderTypes(
  appointmentId: string,
  requestedTypes: string[],
): Promise<void> {
  const safeTypes = requestedTypes.filter((type) => REMINDER_TYPES.has(type));
  if (!safeTypes.length) return;
  const types = `(${safeTypes.join(",")})`;
  const result = await admin(
    `/rest/v1/agendamento_lembretes?agendamento_id=eq.${encodeURIComponent(appointmentId)}` +
      `&tipo=in.${types}&status=in.(pendente,pronto,falhou)`,
    {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ status: "cancelado", updated_at: new Date().toISOString() }),
    },
  );
  if (!result.response.ok) {
    throw new ApiError(502, "reminders_update_failed", "Não foi possível atualizar os lembretes.");
  }
}

async function cancelOpenReminders(appointmentId: string, allTypes: boolean): Promise<void> {
  const types = allTypes ? ["confirmacao", "24h", "2h", "retorno"] : ["24h", "2h", "retorno"];
  await cancelOpenReminderTypes(appointmentId, types);
}

async function insertReminderPlan(
  row: AppointmentRow,
  includeConfirmation: boolean,
): Promise<void> {
  const plan = reminderPlan(row, includeConfirmation);
  if (!plan.length) return;
  await insertReminderRows(plan);
}

async function insertReminderRows(plan: JsonRecord[]): Promise<void> {
  if (!plan.length) return;
  const result = await admin(
    "/rest/v1/agendamento_lembretes?on_conflict=agendamento_id,tipo,canal,previsto_em",
    {
      method: "POST",
      headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
      body: JSON.stringify(plan),
    },
  );
  if (!result.response.ok) {
    throw new ApiError(502, "reminders_create_failed", "Não foi possível preparar os lembretes.");
  }
}

function sameReminderSchedule(reminder: ReminderRow, planned: JsonRecord): boolean {
  return reminder.tipo === planned.tipo &&
    Math.abs(Date.parse(reminder.previsto_em) - Date.parse(String(planned.previsto_em))) < 1_000;
}

function reminderMatchesPlan(reminder: ReminderRow, planned: JsonRecord): boolean {
  if (reminder.tipo !== planned.tipo) return false;
  return reminder.tipo === "confirmacao" || sameReminderSchedule(reminder, planned);
}

async function updateReminderIds(ids: string[], values: JsonRecord): Promise<void> {
  const validIds = [...new Set(ids.filter(validUuid))];
  if (!validIds.length) return;
  const encoded = validIds.map((id) => encodeURIComponent(id)).join(",");
  const result = await admin(`/rest/v1/agendamento_lembretes?id=in.(${encoded})`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify(values),
  });
  if (!result.response.ok) {
    throw new ApiError(
      502,
      "reminders_update_failed",
      "Não foi possível reconciliar os lembretes.",
    );
  }
}

async function ensureReminderPlans(
  appointments: AppointmentRow[],
  currentReminders: ReminderRow[],
): Promise<ReminderRow[]> {
  const now = Date.now();
  const updatedAt = new Date(now).toISOString();
  const missing: JsonRecord[] = [];
  const staleIds: string[] = [];
  const reopenReadyIds: string[] = [];
  const reopenPendingIds: string[] = [];

  for (const appointment of appointments) {
    const appointmentReminders = currentReminders.filter((item) =>
      item.agendamento_id === appointment.id
    );
    const includeConfirmation = ["solicitado", "aguardando_confirmacao"].includes(
      appointment.status,
    );
    const desired = reminderPlan(appointment, includeConfirmation, now);
    const keepIds = new Set<string>();

    for (const planned of desired) {
      const candidates = appointmentReminders.filter((item) => reminderMatchesPlan(item, planned));
      const current = candidates.find((item) => item.status !== "cancelado");
      if (current) {
        keepIds.add(current.id);
        continue;
      }
      const cancelled = candidates.find((item) => item.status === "cancelado");
      if (cancelled) {
        keepIds.add(cancelled.id);
        if (planned.status === "pronto") reopenReadyIds.push(cancelled.id);
        else reopenPendingIds.push(cancelled.id);
        continue;
      }
      missing.push(planned);
    }

    for (const reminder of appointmentReminders) {
      if (OPEN_REMINDER_STATUSES.has(reminder.status) && !keepIds.has(reminder.id)) {
        staleIds.push(reminder.id);
      }
    }
  }

  await updateReminderIds(staleIds, { status: "cancelado", updated_at: updatedAt });
  const reopened = {
    enviado_em: null,
    provider_message_id: null,
    erro_codigo: null,
    marcado_manualmente: false,
    updated_at: updatedAt,
  };
  await updateReminderIds(reopenReadyIds, { ...reopened, status: "pronto" });
  await updateReminderIds(reopenPendingIds, { ...reopened, status: "pendente" });
  await insertReminderRows(missing);
  if (!staleIds.length && !reopenReadyIds.length && !reopenPendingIds.length && !missing.length) {
    return currentReminders;
  }
  return await getReminders(appointments.map((item) => item.id));
}

async function synchronizeAppointmentReminders(
  appointment: AppointmentRow,
): Promise<{ reminders: ReminderRow[]; synchronized: boolean }> {
  let reminders = await getReminders([appointment.id]);
  try {
    reminders = await ensureReminderPlans([appointment], reminders);
    return { reminders, synchronized: true };
  } catch (error) {
    console.error(
      "Agenda reminder synchronization failed",
      error instanceof Error ? error.message : "unknown_error",
    );
    return { reminders, synchronized: false };
  }
}

function reminderIsActionable(
  reminder: ReminderRow,
  appointment: AppointmentRow | undefined,
  now: number,
): boolean {
  if (!appointment?.lembretes_autorizados) return false;
  if (!OPEN_REMINDER_STATUSES.has(reminder.status)) return false;
  const active = ACTIVE_STATUSES.has(appointment.status);
  const start = Date.parse(appointment.inicio_em);
  const planned = Date.parse(reminder.previsto_em);
  if (!Number.isFinite(start) || !Number.isFinite(planned)) return false;
  if (planned > now) return false;

  if (reminder.tipo === "retorno") {
    if (!appointment.retorno_em || (!active && appointment.status !== "concluido")) return false;
    const expected = Date.parse(appointment.retorno_em + "T09:00:00-03:00");
    return Math.abs(planned - expected) < 1_000;
  }
  if (!active) return false;
  if (reminder.tipo === "confirmacao") {
    return ["solicitado", "aguardando_confirmacao"].includes(appointment.status) &&
      now <= start + 60 * 60_000;
  }
  if (reminder.tipo === "24h") {
    return appointment.lembrete_24h && Math.abs(planned - (start - 24 * 60 * 60_000)) < 1_000 &&
      now < start - 2 * 60 * 60_000;
  }
  if (reminder.tipo === "2h") {
    return appointment.lembrete_2h && Math.abs(planned - (start - 2 * 60 * 60_000)) < 1_000 &&
      now <= start + 60 * 60_000;
  }
  return false;
}

function latestSent(reminders: ReminderRow[], type: string): string | null {
  return reminders
    .filter((item) => item.tipo === type && item.status === "enviado" && item.enviado_em)
    .map((item) => item.enviado_em as string)
    .sort()
    .at(-1) || null;
}

function currentReminderStatus(reminders: ReminderRow[], type: string): string | null {
  return reminders.find((item) => item.tipo === type)?.status || null;
}

function presentAppointment(row: AppointmentRow, reminders: ReminderRow[]): JsonRecord {
  const duration = Math.round((Date.parse(row.fim_em) - Date.parse(row.inicio_em)) / 60_000);
  return {
    id: row.id,
    idempotency_key: row.idempotency_key,
    nome: row.nome,
    telefone: row.telefone,
    email: row.email,
    categoria: row.categoria,
    procedimento: row.procedimento,
    data_hora: row.inicio_em,
    fim_em: row.fim_em,
    duracao_min: duration,
    fuso_horario: row.fuso_horario,
    status: row.status,
    origem: row.origem,
    observacoes: row.observacoes,
    retorno_de_id: row.retorno_de_id,
    retorno_em: row.retorno_em,
    lembretes_autorizados: row.lembretes_autorizados,
    lembrete_24h: row.lembrete_24h,
    lembrete_2h: row.lembrete_2h,
    lembrete_confirmacao_status: currentReminderStatus(reminders, "confirmacao"),
    lembrete_24h_status: currentReminderStatus(reminders, "24h"),
    lembrete_2h_status: currentReminderStatus(reminders, "2h"),
    lembrete_retorno_status: currentReminderStatus(reminders, "retorno"),
    lembrete_confirmacao_enviado_em: latestSent(reminders, "confirmacao"),
    lembrete_24h_enviado_em: latestSent(reminders, "24h"),
    lembrete_2h_enviado_em: latestSent(reminders, "2h"),
    lembrete_retorno_enviado_em: latestSent(reminders, "retorno"),
    cancelado_em: row.cancelado_em,
    motivo_cancelamento: row.motivo_cancelamento,
    versao: row.versao,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function sameIdempotentRequest(row: AppointmentRow, normalized: NormalizedAppointment): boolean {
  return row.nome === normalized.nome &&
    row.telefone === normalized.telefone &&
    row.categoria === normalized.categoria &&
    row.procedimento === normalized.procedimento &&
    Date.parse(row.inicio_em) === Date.parse(normalized.inicio_em) &&
    Date.parse(row.fim_em) === Date.parse(normalized.fim_em);
}

async function handleList(req: Request, payload: JsonRecord): Promise<Response> {
  const limit = integerValue(payload.limite, 200, "limite", 1, MAX_LIST_ITEMS);
  let path = `/rest/v1/agendamentos_clinica?select=${APPOINTMENT_SELECT}` +
    `&arquivado_em=is.null&order=inicio_em.desc&limit=${limit}`;

  if (payload.de !== undefined) {
    path += `&inicio_em=gte.${encodeURIComponent(normalizeDateTime(payload.de, "de"))}`;
  }
  if (payload.ate !== undefined) {
    path += `&inicio_em=lte.${encodeURIComponent(normalizeDateTime(payload.ate, "ate"))}`;
  }
  if (payload.status !== undefined) {
    const status = stringValue(payload.status).toLowerCase();
    if (!STATUSES.has(status)) {
      throw new ApiError(422, "invalid_status", "Filtro de status inválido.");
    }
    path += `&status=eq.${encodeURIComponent(status)}`;
  }

  const result = await admin(path);
  if (!result.response.ok) {
    throw new ApiError(502, "agenda_read_failed", "Não foi possível carregar a agenda.");
  }
  const appointments = appointmentRows(result.data);
  let reminders = await getReminders(appointments.map((item) => item.id));
  let remindersSynchronized = true;
  try {
    reminders = await ensureReminderPlans(appointments, reminders);
  } catch (error) {
    remindersSynchronized = false;
    console.error(
      "Agenda reminder reconciliation failed",
      error instanceof Error ? error.message : "unknown_error",
    );
  }
  const grouped = new Map<string, ReminderRow[]>();
  for (const reminder of reminders) {
    const list = grouped.get(reminder.agendamento_id) || [];
    list.push(reminder);
    grouped.set(reminder.agendamento_id, list);
  }
  const presented = appointments.map((item) =>
    presentAppointment(item, grouped.get(item.id) || [])
  );
  const appointmentById = new Map(appointments.map((item) => [item.id, item]));
  const now = Date.now();
  const pending = reminders
    .filter((item) =>
      ["pendente", "pronto", "falhou"].includes(item.status) &&
      Date.parse(item.previsto_em) <= now &&
      reminderIsActionable(item, appointmentById.get(item.agendamento_id), now)
    )
    .map((item) => {
      const appointment = appointmentById.get(item.agendamento_id);
      return {
        id: item.id,
        agendamento_id: item.agendamento_id,
        tipo: item.tipo,
        previsto_em: item.previsto_em,
        status: item.status,
        nome: appointment?.nome || "",
        telefone: appointment?.telefone || "",
        categoria: appointment?.categoria || "",
        data_hora: appointment?.inicio_em || null,
      };
    })
    .sort((a, b) => Date.parse(a.previsto_em) - Date.parse(b.previsto_em));

  return json(req, {
    agendamentos: presented,
    lembretes_pendentes: pending,
    total: presented.length,
    lembretes_sincronizados: remindersSynchronized,
    agora: new Date().toISOString(),
  });
}

async function handleCreate(req: Request, payload: JsonRecord): Promise<Response> {
  const key = hasOwn(payload, "idempotency_key")
    ? payload.idempotency_key
    : payload.chave_idempotencia;
  if (!validUuid(key)) {
    throw new ApiError(422, "invalid_idempotency", "Atualize a página e tente novamente.");
  }
  const normalized = normalizeAppointment(payload);
  const previous = await getAppointmentByIdempotency(key);
  if (previous) {
    if (!sameIdempotentRequest(previous, normalized)) {
      throw new ApiError(
        409,
        "idempotency_conflict",
        "Esta solicitação já foi usada em outro horário.",
      );
    }
    const sync = await synchronizeAppointmentReminders(previous);
    return json(req, {
      agendamento: presentAppointment(previous, sync.reminders),
      idempotente: true,
      lembretes_sincronizados: sync.synchronized,
    });
  }

  if (Date.parse(normalized.inicio_em) <= Date.now()) {
    throw new ApiError(422, "appointment_not_future", "Escolha um horário futuro.");
  }

  if (
    ACTIVE_STATUSES.has(normalized.status) &&
    await hasConflict(normalized.inicio_em, normalized.fim_em)
  ) {
    throw new ApiError(409, "schedule_conflict", "Já existe outro atendimento nesse período.");
  }

  const result = await admin(`/rest/v1/agendamentos_clinica?select=${APPOINTMENT_SELECT}`, {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({ idempotency_key: key, ...normalized }),
  });
  if (!result.response.ok) {
    if (result.response.status === 409) {
      const concurrent = await getAppointmentByIdempotency(key);
      if (concurrent && sameIdempotentRequest(concurrent, normalized)) {
        const sync = await synchronizeAppointmentReminders(concurrent);
        return json(req, {
          agendamento: presentAppointment(concurrent, sync.reminders),
          idempotente: true,
          lembretes_sincronizados: sync.synchronized,
        });
      }
      throw new ApiError(409, "schedule_conflict", "Já existe outro atendimento nesse período.");
    }
    throw new ApiError(502, "agenda_create_failed", "Não foi possível salvar o agendamento.");
  }

  const created = appointmentRows(result.data)[0];
  if (!created) {
    throw new ApiError(502, "agenda_create_failed", "Não foi possível confirmar o agendamento.");
  }
  const sync = await synchronizeAppointmentReminders(created);
  return json(
    req,
    {
      agendamento: presentAppointment(created, sync.reminders),
      idempotente: false,
      lembretes_sincronizados: sync.synchronized,
    },
    201,
  );
}

function checkConcurrency(payload: JsonRecord, existing: AppointmentRow): void {
  if (payload.versao !== undefined) {
    const version = Number(payload.versao);
    if (!Number.isInteger(version) || version !== existing.versao) {
      throw new ApiError(
        409,
        "stale_record",
        "Este agendamento foi alterado em outra tela. Recarregue.",
      );
    }
    return;
  }
  const updatedAt = stringValue(payload.updated_at);
  if (!updatedAt || Date.parse(updatedAt) !== Date.parse(existing.updated_at)) {
    throw new ApiError(409, "stale_record", "Recarregue a agenda antes de alterar.");
  }
}

async function handleUpdate(req: Request, payload: JsonRecord): Promise<Response> {
  if (!validUuid(payload.id)) throw new ApiError(422, "invalid_id", "Agendamento inválido.");
  const existing = await getAppointmentById(payload.id);
  if (!existing || existing.arquivado_em) {
    throw new ApiError(404, "not_found", "Agendamento não encontrado.");
  }
  checkConcurrency(payload, existing);
  const normalized = normalizeAppointment(payload, existing);
  const scheduleChanged = Date.parse(existing.inicio_em) !== Date.parse(normalized.inicio_em);
  if (scheduleChanged) {
    if (payload.reagendar !== true) {
      throw new ApiError(
        422,
        "reschedule_confirmation_required",
        "Confirme o reagendamento para alterar a data ou o horário.",
      );
    }
    if (!ACTIVE_STATUSES.has(existing.status)) {
      throw new ApiError(
        422,
        "reschedule_not_allowed",
        "Esse atendimento não pode ser reagendado.",
      );
    }
    if (Date.parse(normalized.inicio_em) <= Date.now()) {
      throw new ApiError(422, "appointment_not_future", "Escolha um novo horário futuro.");
    }
    normalized.status = "aguardando_confirmacao";
    normalized.cancelado_em = null;
    normalized.motivo_cancelamento = null;
  } else {
    validateStatusTransition(existing.status, normalized.status);
  }

  if (
    ACTIVE_STATUSES.has(normalized.status) &&
    await hasConflict(normalized.inicio_em, normalized.fim_em, existing.id)
  ) {
    throw new ApiError(409, "schedule_conflict", "Já existe outro atendimento nesse período.");
  }

  const now = new Date().toISOString();
  const nextVersion = existing.versao + 1;
  const result = await admin(
    `/rest/v1/agendamentos_clinica?select=${APPOINTMENT_SELECT}` +
      `&id=eq.${encodeURIComponent(existing.id)}&versao=eq.${existing.versao}`,
    {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({ ...normalized, versao: nextVersion, updated_at: now }),
    },
  );
  if (!result.response.ok) {
    if (result.response.status === 409) {
      throw new ApiError(409, "schedule_conflict", "Já existe outro atendimento nesse período.");
    }
    throw new ApiError(502, "agenda_update_failed", "Não foi possível atualizar o agendamento.");
  }
  const updated = appointmentRows(result.data)[0];
  if (!updated) {
    throw new ApiError(409, "stale_record", "O agendamento mudou. Recarregue a agenda.");
  }

  let reminders = await getReminders([updated.id]);
  let remindersSynchronized = true;
  try {
    if (scheduleChanged) {
      await cancelOpenReminders(updated.id, true);
      await insertReminderPlan(updated, true);
      reminders = await getReminders([updated.id]);
    } else {
      reminders = await ensureReminderPlans([updated], reminders);
    }
  } catch (error) {
    remindersSynchronized = false;
    console.error(
      "Agenda reminder synchronization failed",
      error instanceof Error ? error.message : "unknown_error",
    );
  }

  return json(req, {
    agendamento: presentAppointment(updated, reminders),
    lembretes_sincronizados: remindersSynchronized,
    reagendado: scheduleChanged,
  });
}

async function handleStatus(req: Request, payload: JsonRecord): Promise<Response> {
  const statusPayload: JsonRecord = { ...payload };
  if (!hasOwn(statusPayload, "status") && hasOwn(statusPayload, "novo_status")) {
    statusPayload.status = statusPayload.novo_status;
  }
  return await handleUpdate(req, statusPayload);
}

function normalizeReminderType(value: unknown): string {
  const raw = stringValue(value).toLowerCase();
  const aliases: Record<string, string> = {
    lembrete_confirmacao: "confirmacao",
    lembrete_24h: "24h",
    lembrete_2h: "2h",
    lembrete_retorno: "retorno",
  };
  const type = aliases[raw] || raw;
  if (!REMINDER_TYPES.has(type)) {
    throw new ApiError(422, "invalid_reminder_type", "Tipo de lembrete inválido.");
  }
  return type;
}

async function handleReminder(req: Request, payload: JsonRecord): Promise<Response> {
  if (!validUuid(payload.id)) throw new ApiError(422, "invalid_id", "Agendamento inválido.");
  if (!validUuid(payload.lembrete_id)) {
    throw new ApiError(
      422,
      "reminder_id_required",
      "Atualize a agenda e selecione novamente o lembrete.",
    );
  }
  const appointment = await getAppointmentById(payload.id);
  if (!appointment || appointment.arquivado_em) {
    throw new ApiError(404, "not_found", "Agendamento não encontrado.");
  }
  if (!appointment.lembretes_autorizados) {
    throw new ApiError(409, "reminders_not_authorized", "Os lembretes não estão autorizados.");
  }
  const typeSource = hasOwn(payload, "tipo")
    ? payload.tipo
    : hasOwn(payload, "lembrete_tipo")
    ? payload.lembrete_tipo
    : payload.lembrete;
  const type = normalizeReminderType(typeSource);
  const nextStatus = stringValue(payload.status || "enviado").toLowerCase();
  if (!["pronto", "enviado", "cancelado"].includes(nextStatus)) {
    throw new ApiError(422, "invalid_reminder_status", "Status de lembrete inválido.");
  }

  const path = `/rest/v1/agendamento_lembretes?select=${REMINDER_SELECT}` +
    `&id=eq.${encodeURIComponent(payload.lembrete_id)}` +
    `&agendamento_id=eq.${encodeURIComponent(appointment.id)}` +
    `&tipo=eq.${encodeURIComponent(type)}&limit=1`;
  const currentResult = await admin(path);
  if (!currentResult.response.ok) {
    throw new ApiError(502, "reminder_read_failed", "Não foi possível abrir o lembrete.");
  }
  const current = reminderRows(currentResult.data)[0];
  if (!current) throw new ApiError(404, "reminder_not_found", "Lembrete não encontrado.");
  const nowMs = Date.now();
  if (!reminderIsActionable(current, appointment, nowMs)) {
    throw new ApiError(
      409,
      "reminder_not_actionable",
      "Este lembrete não está disponível para envio. Atualize a agenda.",
    );
  }

  const now = new Date(nowMs).toISOString();
  const update = {
    status: nextStatus,
    enviado_em: nextStatus === "enviado" ? now : null,
    marcado_manualmente: nextStatus === "enviado",
    tentativas: nextStatus === "pronto" ? Math.min(10, current.tentativas + 1) : current.tentativas,
    erro_codigo: null,
    updated_at: now,
  };
  const updateResult = await admin(
    `/rest/v1/agendamento_lembretes?select=${REMINDER_SELECT}&id=eq.${
      encodeURIComponent(current.id)
    }&status=eq.${encodeURIComponent(current.status)}`,
    {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify(update),
    },
  );
  if (!updateResult.response.ok) {
    throw new ApiError(502, "reminder_update_failed", "Não foi possível atualizar o lembrete.");
  }
  const updatedReminder = reminderRows(updateResult.data)[0];
  if (!updatedReminder) {
    throw new ApiError(409, "reminder_changed", "O lembrete mudou. Atualize a agenda.");
  }
  let remindersSynchronized = true;
  if (nextStatus === "enviado" && type === "2h") {
    try {
      await cancelOpenReminderTypes(appointment.id, ["24h"]);
    } catch (error) {
      remindersSynchronized = false;
      console.error(
        "Agenda reminder follow-up synchronization failed",
        error instanceof Error ? error.message : "unknown_error",
      );
    }
  }
  const reminders = await getReminders([appointment.id]);
  return json(req, {
    agendamento: presentAppointment(appointment, reminders),
    lembrete: updatedReminder,
    idempotente: false,
    lembretes_sincronizados: remindersSynchronized,
    agora: now,
  });
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin") || "";
  if (req.method === "OPTIONS") {
    if (origin && !ALLOWED_ORIGINS.has(origin)) return new Response(null, { status: 403 });
    return new Response(null, { status: 204, headers: cors(req) });
  }
  if (req.method !== "POST") return fail(req, "method_not_allowed", "Método não permitido.", 405);
  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    return fail(req, "origin_not_allowed", "Origem não permitida.", 403);
  }
  if (!HASH_SENHA_CONFIGURADO || !SUPABASE_URL || !SERVICE_ROLE) {
    console.error("Agenda environment is not configured");
    return fail(req, "backend_unavailable", "Agenda temporariamente indisponível.", 503);
  }

  const contentType = (req.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    return fail(req, "invalid_content_type", "Envie os dados em JSON.", 415);
  }
  const declaredLength = Number(req.headers.get("content-length") || "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return fail(req, "payload_too_large", "A solicitação excedeu o limite permitido.", 413);
  }

  const ip = req.headers.get("cf-connecting-ip") ||
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const now = Date.now();
  const record = attempts.get(ip);
  if (record && record.resetAt > now && record.count >= 12) {
    return fail(req, "rate_limited", "Muitas tentativas. Aguarde alguns minutos.", 429);
  }

  const sent = (req.headers.get("x-senha") || "").toLowerCase();
  if (!equalConstantTime(sent, HASH_SENHA)) {
    const current = record && record.resetAt > now
      ? record
      : { count: 0, resetAt: now + 10 * 60_000 };
    current.count++;
    attempts.set(ip, current);
    await new Promise((resolve) => setTimeout(resolve, 700));
    return fail(req, "invalid_password", "Senha incorreta.", 401);
  }
  attempts.delete(ip);

  try {
    const payload = await readJsonBody(req);
    const action = stringValue(payload.acao).toLowerCase();
    switch (action) {
      case "listar":
        return await handleList(req, payload);
      case "criar":
        return await handleCreate(req, payload);
      case "atualizar":
        return await handleUpdate(req, payload);
      case "status":
      case "marcar_status":
        return await handleStatus(req, payload);
      case "lembrete":
      case "marcar_lembrete":
        return await handleReminder(req, payload);
      default:
        return fail(req, "invalid_action", "Ação de agenda inválida.", 422);
    }
  } catch (error) {
    if (error instanceof ApiError) return fail(req, error.code, error.message, error.status);
    console.error(
      "Agenda request failed",
      error instanceof Error ? error.message : "unknown_error",
    );
    return fail(req, "internal_error", "Não foi possível concluir a operação agora.", 500);
  }
});

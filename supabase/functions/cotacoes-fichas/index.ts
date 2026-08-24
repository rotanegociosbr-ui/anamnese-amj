import "@supabase/functions-js/edge-runtime.d.ts";
import {
  authenticateDual,
  authResponseFields,
  DualAuthConfig,
  DualAuthContext,
  DualAuthError,
  requireRecentPasswordProof,
} from "../_shared/dual-auth.ts";

type JsonRecord = Record<string, unknown>;

// Esta função precisa ser publicada com verify_jwt=false: o corpo valida o JWT,
// a sessão ativa, o vínculo owner e AAL2 antes de qualquer leitura administrativa.
const SUPABASE_URL = (Deno.env.get("SUPABASE_URL") || "").replace(/\/+$/, "");
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const AUTH_CONFIG: DualAuthConfig = {
  supabaseUrl: SUPABASE_URL,
  serviceRoleKey: SERVICE_ROLE,
  allowedRoles: ["owner"],
  requireAal2: true,
};

const MAX_BODY_BYTES = 16 * 1024;
const MAX_PAGE_SIZE = 100;
const MAX_OFFSET = 100_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const SAFE_SEARCH = /^[\p{L}\p{N}\s./+-]*$/u;
const REVIEW_STATUSES = new Set([
  "pendente_revisao",
  "aprovado_exato",
  "conflito",
  "rejeitado",
]);
const EVIDENCE_SELECT = [
  "evidence_id",
  "item_id",
  "source_id",
  "source_name",
  "supplier_name",
  "source_date",
  "revision",
  "source_code",
  "brand",
  "item_name",
  "composition",
  "concentration",
  "presentation",
  "package_quantity",
  "package_unit",
  "exact_sku_key",
  "exact_match_eligible",
  "review_status",
  "review_reason",
  "page_number",
  "line_reference",
  "quote_date",
  "commercial_condition",
  "price",
  "currency",
  "extraction_status",
  "same_price_evidence_count",
  "same_price_evidence_ordinal",
  "has_source_conflict",
  "counts_in_statistics",
  "review_version",
  "reviewed_at",
  "review_operation_id",
].join(",");

type ReviewDecision = "aprovar" | "rejeitar";

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

function validUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
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

export function normalizeSearch(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") {
    throw new ApiError(422, "invalid_busca", "Confira o texto da busca.");
  }
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized) return null;
  if (normalized.length > 120 || !SAFE_SEARCH.test(normalized)) {
    throw new ApiError(422, "invalid_busca", "Use somente letras e números na busca.");
  }
  return normalized;
}

function optionalUuid(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (!validUuid(value)) {
    throw new ApiError(422, `invalid_${field}`, "Identificador inválido.");
  }
  return value.toLowerCase();
}

function reviewStatus(value: unknown): string | null {
  if (value === undefined || value === null || value === "" || value === "todos") return null;
  if (typeof value !== "string" || !REVIEW_STATUSES.has(value)) {
    throw new ApiError(422, "invalid_status", "Situação de revisão inválida.");
  }
  return value;
}

export function reviewDecision(value: unknown): ReviewDecision {
  if (value !== "aprovar" && value !== "rejeitar") {
    throw new ApiError(422, "invalid_decision", "Escolha aprovar ou rejeitar a identidade.");
  }
  return value;
}

export function reviewReason(value: unknown): string {
  if (typeof value !== "string") {
    throw new ApiError(422, "invalid_reason", "Informe o motivo da revisão.");
  }
  const hasControl = Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
  const reason = value.trim().replace(/\s+/g, " ");
  if (reason.length < 3 || reason.length > 500 || hasControl) {
    throw new ApiError(422, "invalid_reason", "Informe um motivo entre 3 e 500 caracteres.");
  }
  return reason;
}

export function reviewProofAction(decision: ReviewDecision): string {
  return decision === "aprovar" ? "cotacoes.aprovar_sku_exato" : "cotacoes.rejeitar_sku_exato";
}

export function tenantClinicId(context: DualAuthContext): string {
  if (!validUuid(context.clinicId)) {
    throw new ApiError(403, "tenant_required", "Não foi possível identificar a clínica.");
  }
  if (
    context.authMethod !== "supabase_auth" || context.role !== "owner" ||
    context.aal !== "aal2" || !validUuid(context.userId)
  ) {
    throw new ApiError(
      403,
      "owner_mfa_required",
      "Use uma conta proprietária individual com MFA.",
    );
  }
  return context.clinicId;
}

export function corsOriginAllowed(origin: string | null): boolean {
  if (origin === null) return true;
  if (
    origin === "https://anamariajacob.com.br" ||
    origin === "https://www.anamariajacob.com.br"
  ) return true;
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

function success(req: Request, context: DualAuthContext, body: JsonRecord): Response {
  return json(req, { ...authResponseFields(context), ...body });
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
  if (!reader) throw new ApiError(400, "empty_body", "Envie os filtros da consulta.");
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
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new ApiError(400, "invalid_json", "JSON inválido.");
  }
  if (!isRecord(parsed)) throw new ApiError(400, "invalid_json_object", "JSON inválido.");
  return parsed;
}

async function admin(path: string, method = "GET", body?: JsonRecord): Promise<AdminResult> {
  if (!SUPABASE_URL || !SERVICE_ROLE) {
    throw new ApiError(503, "backend_unavailable", "Consulta temporariamente indisponível.");
  }
  let response: Response;
  try {
    response = await fetch(SUPABASE_URL + path, {
      method,
      headers: {
        apikey: SERVICE_ROLE,
        Authorization: `Bearer ${SERVICE_ROLE}`,
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(method === "GET" ? { Prefer: "count=exact" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(12_000),
    });
  } catch {
    throw new ApiError(503, "database_unavailable", "Consulta temporariamente indisponível.");
  }
  let data: unknown = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  return { response, data };
}

function rows(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function ensureQuerySuccess(result: AdminResult): JsonRecord[] {
  if (!result.response.ok) {
    const status = result.response.status >= 500 ? 503 : 502;
    throw new ApiError(status, "quotes_query_failed", "Não foi possível consultar as cotações.");
  }
  return rows(result.data);
}

function ensureRpcSuccess(result: AdminResult): JsonRecord {
  if (!result.response.ok || !isRecord(result.data)) {
    const status = result.response.status >= 500 ? 503 : 502;
    throw new ApiError(status, "review_write_failed", "Não foi possível registrar a revisão.");
  }
  return result.data;
}

function rpcReviewError(result: JsonRecord): ApiError {
  const code = typeof result.code === "string" ? result.code : "review_rejected";
  const errors: Record<string, [number, string]> = {
    invalid_request: [422, "Confira os dados da revisão."],
    invalid_reason: [422, "Informe um motivo válido para a revisão."],
    owner_required: [403, "Somente uma conta proprietária pode revisar cotações."],
    proof_invalid: [403, "A confirmação por senha expirou ou já foi utilizada."],
    item_not_found: [404, "Esta identidade de cotação não foi encontrada."],
    operation_conflict: [409, "Esta operação já foi usada para outra revisão."],
    version_conflict: [409, "A cotação foi revisada em outra tela. Atualize e confira novamente."],
    item_has_conflict: [409, "Resolva o conflito da fonte antes de aprovar esta identidade."],
    exact_identity_incomplete: [422, "A identidade exata está incompleta e não pode ser aprovada."],
    exact_identity_invalid: [422, "A identidade exata não confere com os campos preservados."],
    evidence_not_verified: [422, "Existem evidências ainda não verificadas nesta identidade."],
    evidence_price_conflict: [409, "Existem preços conflitantes para esta identidade na fonte."],
  };
  const mapped: [number, string] = errors[code] || [
    422,
    "A identidade não pôde ser revisada.",
  ];
  return new ApiError(mapped[0], code, mapped[1]);
}

export function totalFromContentRange(value: string | null, fallback: number): number {
  const match = /\/(\d+)$/.exec(value || "");
  return match ? Number(match[1]) : fallback;
}

function evidenceSearchFilter(search: string): string {
  const pattern = `*${search}*`;
  return "(" + [
    "source_name",
    "supplier_name",
    "source_code",
    "brand",
    "item_name",
    "composition",
    "concentration",
    "presentation",
  ].map((column) => `${column}.ilike.${pattern}`).join(",") + ")";
}

async function listQuotes(
  req: Request,
  context: DualAuthContext,
  payload: JsonRecord,
): Promise<Response> {
  const clinicId = tenantClinicId(context);
  const search = normalizeSearch(payload.busca);
  const sourceId = optionalUuid(payload.fonte_id, "fonte_id");
  const status = reviewStatus(payload.status);
  const start = optionalDate(payload.data_inicio, "data_inicio");
  const end = optionalDate(payload.data_fim, "data_fim");
  if (start && end && end < start) {
    throw new ApiError(422, "invalid_period", "A data final deve ser posterior à inicial.");
  }
  const page = integerValue(payload.pagina, "pagina", 1, 1, 10_000);
  const pageSize = integerValue(payload.por_pagina, "por_pagina", 25, 10, MAX_PAGE_SIZE);
  const offset = (page - 1) * pageSize;
  if (offset > MAX_OFFSET) {
    throw new ApiError(422, "page_too_far", "Refine os filtros para continuar.");
  }

  const query = new URLSearchParams({
    select: EVIDENCE_SELECT,
    clinic_id: `eq.${clinicId}`,
    order: "quote_date.desc,source_name.asc,page_number.asc.nullslast,line_reference.asc",
    limit: String(pageSize),
    offset: String(offset),
  });
  if (search) query.set("or", evidenceSearchFilter(search));
  if (sourceId) query.set("source_id", `eq.${sourceId}`);
  if (status) query.set("review_status", `eq.${status}`);
  if (start) query.set("quote_date", `gte.${start}`);
  if (end) query.append("quote_date", `lte.${end}`);

  const sourceQuery = new URLSearchParams({
    select: "id,source_name,supplier_name,source_date,revision",
    clinic_id: `eq.${clinicId}`,
    order: "source_date.desc,source_name.asc",
    limit: "500",
  });

  const [evidenceResult, sourcesResult, statisticsResult] = await Promise.all([
    admin(`/rest/v1/cotacoes_painel_evidencias?${query.toString()}`),
    admin(`/rest/v1/cotacao_fontes?${sourceQuery.toString()}`),
    admin("/rest/v1/rpc/cotacoes_resumo_referencia", "POST", {
      p_clinic_id: clinicId,
      p_search: search,
      p_limit: 60,
      p_offset: 0,
    }),
  ]);

  const evidences = ensureQuerySuccess(evidenceResult);
  const sources = ensureQuerySuccess(sourcesResult);
  const statistics = ensureQuerySuccess(statisticsResult);
  const total = totalFromContentRange(
    evidenceResult.response.headers.get("content-range"),
    evidences.length,
  );

  return success(req, context, {
    cotacoes: evidences,
    fontes: sources,
    estatisticas: statistics,
    paginacao: {
      pagina: page,
      por_pagina: pageSize,
      total,
      paginas: Math.max(1, Math.ceil(total / pageSize)),
    },
    contrato: {
      somente_leitura: false,
      somente_revisao_identidade: true,
      altera_custo_real: false,
      altera_preco_venda: false,
      altera_estoque: false,
      estatistica_somente_sku_exato: true,
    },
  });
}

async function reviewExactSku(
  req: Request,
  context: DualAuthContext,
  payload: JsonRecord,
): Promise<Response> {
  const clinicId = tenantClinicId(context);
  const actorId = context.userId;
  if (!validUuid(actorId)) {
    throw new ApiError(403, "owner_mfa_required", "Use uma conta proprietária com MFA.");
  }
  const itemId = optionalUuid(payload.item_id, "item_id");
  if (!itemId) throw new ApiError(422, "invalid_item_id", "Identidade da cotação inválida.");
  const decision = reviewDecision(payload.decisao);
  const reason = reviewReason(payload.motivo);
  if (
    payload.expected_version === undefined || payload.expected_version === null ||
    payload.expected_version === ""
  ) {
    throw new ApiError(422, "invalid_expected_version", "Atualize a cotação antes de revisar.");
  }
  const expectedVersion = integerValue(
    payload.expected_version,
    "expected_version",
    1,
    1,
    2_147_483_647,
  );
  const operationId = optionalUuid(payload.operation_id, "operation_id");
  if (!operationId) throw new ApiError(422, "invalid_operation_id", "Operação protegida inválida.");

  let proof;
  try {
    proof = await requireRecentPasswordProof(req, AUTH_CONFIG, context, {
      operationId,
      action: reviewProofAction(decision),
      targetId: itemId,
    });
  } catch (error) {
    if (error instanceof DualAuthError) {
      throw new ApiError(error.status, error.code, error.publicMessage);
    }
    throw new ApiError(
      503,
      "reauthentication_unavailable",
      "Não foi possível confirmar sua senha agora.",
    );
  }

  const rpcResult = await admin("/rest/v1/rpc/cotacoes_revisar_sku_exato", "POST", {
    p_clinic_id: clinicId,
    p_item_id: itemId,
    p_decision: decision,
    p_reason: reason,
    p_expected_version: expectedVersion,
    p_operation_id: operationId,
    p_actor_id: actorId,
    p_proof_id: proof.proofId,
    p_request_id: context.requestId,
  });
  const result = ensureRpcSuccess(rpcResult);
  if (result.ok !== true) throw rpcReviewError(result);

  return success(req, context, {
    ok: true,
    revisao: result,
    contrato: {
      somente_revisao_identidade: true,
      altera_custo_real: false,
      altera_preco_venda: false,
      altera_estoque: false,
      vincula_produto: false,
    },
  });
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
    return fail(
      req,
      "Entre com sua conta proprietária e confirme o autenticador.",
      401,
      "authorization_required",
    );
  }

  let context: DualAuthContext;
  try {
    context = await authenticateDual(req, AUTH_CONFIG);
    tenantClinicId(context);
  } catch (error) {
    if (error instanceof DualAuthError) {
      return fail(req, error.publicMessage, error.status, error.code);
    }
    if (error instanceof ApiError) return fail(req, error.publicMessage, error.status, error.code);
    return fail(req, "Autenticação temporariamente indisponível.", 503, "auth_unavailable");
  }

  try {
    const payload = await readJsonBody(req);
    const action = typeof payload.acao === "string" ? payload.acao.trim().toLowerCase() : "";
    if (action === "listar_cotacoes") return await listQuotes(req, context, payload);
    if (action === "revisar_sku_exato") return await reviewExactSku(req, context, payload);
    throw new ApiError(422, "invalid_action", "Ação de cotações inválida.");
  } catch (error) {
    if (error instanceof ApiError) return fail(req, error.publicMessage, error.status, error.code);
    return fail(req, "Não foi possível consultar as cotações agora.", 500, "internal_error");
  }
}

if (import.meta.main) Deno.serve(handleRequest);

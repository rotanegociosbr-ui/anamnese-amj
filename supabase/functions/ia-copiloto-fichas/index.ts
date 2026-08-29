import "jsr:@supabase/functions-js@2.112.3/edge-runtime.d.ts";
import {
  authenticateDual,
  authResponseFields,
  DualAuthConfig,
  DualAuthContext,
  DualAuthError,
} from "../_shared/dual-auth.ts";
import {
  AnalyzeRequest,
  buildOpenAIRequest,
  ContractError,
  CopilotAnalysis,
  DEFAULT_OPENAI_MODEL,
  extractAggregateModel,
  JsonRecord,
  MAX_REQUEST_BYTES,
  normalizeModel,
  parseCopilotRequest,
  PROMPT_VERSION,
  requestFingerprint,
  safetyIdentifier,
  safeUsageInteger,
  sanitizeAnalysis,
  useCaseForQuestion,
} from "./logic.ts";

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type AuthenticateLike = (
  req: Request,
  config: DualAuthConfig,
) => Promise<DualAuthContext>;

interface RuntimeEnvironment {
  supabaseUrl: string;
  serviceRoleKey: string;
  openaiApiKey: string;
  openaiModel: string;
}

export interface HandlerDependencies {
  fetchImpl: FetchLike;
  authenticate: AuthenticateLike;
  environment: () => RuntimeEnvironment;
  now: () => number;
}

interface RpcResult extends JsonRecord {}

interface OpenAIResult {
  analysis: CopilotAnalysis;
  inputTokens: number;
  outputTokens: number;
}

class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly publicMessage: string,
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(publicMessage);
    this.name = "ApiError";
  }
}

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_UPSTREAM_RESPONSE_BYTES = 128 * 1024;
const MAX_PANEL_RESPONSE_BYTES = 256 * 1024;
const DATABASE_TIMEOUT_MS = 12_000;
const OPENAI_TIMEOUT_MS = 25_000;

const DEFAULT_DEPENDENCIES: HandlerDependencies = {
  fetchImpl: fetch,
  authenticate: authenticateDual,
  environment: () => ({
    supabaseUrl: (Deno.env.get("SUPABASE_URL") || "").replace(/\/+$/, ""),
    serviceRoleKey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "",
    openaiApiKey: Deno.env.get("OPENAI_API_KEY") || "",
    openaiModel: Deno.env.get("OPENAI_MODEL") || DEFAULT_OPENAI_MODEL,
  }),
  now: () => Date.now(),
};

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
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

function json(
  req: Request,
  body: unknown,
  status = 200,
  retryAfterSeconds: number | null = null,
): Response {
  const headers = responseHeaders(req);
  if (retryAfterSeconds !== null) headers.set("Retry-After", String(retryAfterSeconds));
  return new Response(JSON.stringify(body), { status, headers });
}

function fail(req: Request, error: ApiError | ContractError): Response {
  return json(
    req,
    { erro: error.publicMessage, codigo: error.code },
    error.status,
    error instanceof ApiError ? error.retryAfterSeconds : null,
  );
}

function success(
  req: Request,
  context: DualAuthContext,
  body: JsonRecord,
  status = 200,
): Response {
  return json(req, { ok: true, ...authResponseFields(context), ...body }, status);
}

function tenant(context: DualAuthContext): { clinicId: string; userId: string } {
  if (
    context.authMethod !== "supabase_auth" || context.role !== "owner" || context.aal !== "aal2" ||
    !validUuid(context.clinicId) || !validUuid(context.userId) || !validUuid(context.requestId)
  ) {
    throw new ApiError(
      403,
      "owner_mfa_required",
      "Entre com uma conta proprietaria individual e confirme o MFA.",
    );
  }
  return { clinicId: context.clinicId, userId: context.userId };
}

async function readJsonBody(req: Request): Promise<unknown> {
  const contentType = (req.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new ContractError(415, "content_type_required", "Envie os dados em JSON.");
  }
  const declared = Number(req.headers.get("content-length") || "0");
  if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) {
    throw new ContractError(413, "body_too_large", "A solicitacao excede 4 KiB.");
  }
  const reader = req.body?.getReader();
  if (!reader) throw new ContractError(400, "empty_body", "Envie os dados da solicitacao.");
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > MAX_REQUEST_BYTES) {
      await reader.cancel();
      throw new ContractError(413, "body_too_large", "A solicitacao excede 4 KiB.");
    }
    chunks.push(value);
  }
  if (!total) throw new ContractError(400, "empty_body", "Envie os dados da solicitacao.");
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new ContractError(400, "invalid_json", "JSON invalido.");
  }
}

function safeRetryAfter(value: unknown): number | null {
  if (typeof value === "string" && /^\d{1,6}$/.test(value)) value = Number(value);
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(1, Math.min(86_400, Math.trunc(value)))
    : null;
}

async function boundedJson(
  response: Response,
  maxBytes = MAX_UPSTREAM_RESPONSE_BYTES,
): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new ApiError(502, "upstream_response_too_large", "Resposta externa invalida.");
    }
    chunks.push(value);
  }
  if (!total) return null;
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
}

function rpcError(data: unknown, status: number): ApiError {
  const record = isRecord(data) ? data : {};
  const message = typeof record.message === "string" ? record.message : "";
  const code = typeof record.code === "string" ? record.code : "";
  const technical = `${code} ${message}`.toLowerCase();
  const retry = safeRetryAfter(record.retry_after_seconds);
  if (technical.includes("rate_limited") || technical.includes("rate limit")) {
    return new ApiError(
      429,
      "ai_rate_limited",
      "Limite de analises atingido. Aguarde e tente novamente.",
      retry || 60,
    );
  }
  if (technical.includes("owner_required") || technical.includes("owner_aal2")) {
    return new ApiError(403, "owner_mfa_required", "Acesso proprietario com MFA obrigatorio.");
  }
  if (technical.includes("not_found")) {
    return new ApiError(404, "operation_not_found", "Operacao nao encontrada.");
  }
  if (status === 409 || technical.includes("conflict") || technical.includes("in_progress")) {
    return new ApiError(409, "operation_conflict", "A operacao ja esta em andamento.");
  }
  return new ApiError(503, "backend_unavailable", "Copiloto temporariamente indisponivel.");
}

async function rpc(
  deps: HandlerDependencies,
  env: RuntimeEnvironment,
  name: string,
  body: JsonRecord,
): Promise<RpcResult> {
  if (!env.supabaseUrl || !env.serviceRoleKey) {
    throw new ApiError(503, "backend_unavailable", "Copiloto temporariamente indisponivel.");
  }
  let response: Response;
  let data: unknown;
  try {
    response = await deps.fetchImpl(`${env.supabaseUrl}/rest/v1/rpc/${name}`, {
      method: "POST",
      headers: {
        apikey: env.serviceRoleKey,
        Authorization: `Bearer ${env.serviceRoleKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(DATABASE_TIMEOUT_MS),
    });
    data = await boundedJson(response);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    const name = error instanceof Error ? error.name : "";
    throw new ApiError(
      503,
      name === "TimeoutError" || name === "AbortError" ? "backend_timeout" : "backend_unavailable",
      "Copiloto temporariamente indisponivel.",
    );
  }
  if (!response.ok) throw rpcError(data, response.status);
  if (!isRecord(data)) {
    throw new ApiError(503, "invalid_backend_response", "Copiloto temporariamente indisponivel.");
  }
  return data;
}

function contextRpcBody(
  tenantIds: { clinicId: string; userId: string },
  request: { inicio: string; fim: string; foco: string },
): JsonRecord {
  return {
    p_clinic_id: tenantIds.clinicId,
    p_actor_id: tenantIds.userId,
    p_start: request.inicio,
    p_end: request.fim,
    p_focus: request.foco,
  };
}

function openAIErrorCode(data: unknown): string {
  if (!isRecord(data) || !isRecord(data.error)) return "";
  return typeof data.error.code === "string" ? data.error.code.toLowerCase() : "";
}

function openAIHttpError(response: Response, data: unknown): ApiError {
  const upstreamCode = openAIErrorCode(data);
  if (upstreamCode === "billing_not_active") {
    return new ApiError(
      503,
      "ai_billing_inactive",
      "A analise com IA esta indisponivel ate a ativacao do faturamento da API.",
    );
  }
  if (response.status === 401 || response.status === 403) {
    return new ApiError(503, "ai_credentials_invalid", "A analise com IA nao esta configurada.");
  }
  if (response.status === 429) {
    const retry = safeRetryAfter(response.headers.get("retry-after")) || 60;
    return new ApiError(
      429,
      "ai_rate_limited",
      "A IA esta ocupada. Aguarde e tente novamente.",
      retry,
    );
  }
  if (response.status >= 500) {
    return new ApiError(
      503,
      "ai_unavailable",
      "A analise com IA esta temporariamente indisponivel.",
    );
  }
  return new ApiError(
    502,
    "ai_request_rejected",
    "A IA nao conseguiu processar os dados agregados.",
  );
}

function responseText(data: JsonRecord): string {
  const texts: string[] = [];
  if (typeof data.output_text === "string" && data.output_text.trim()) texts.push(data.output_text);
  if (Array.isArray(data.output)) {
    for (const item of data.output) {
      if (!isRecord(item) || !Array.isArray(item.content)) continue;
      for (const content of item.content) {
        if (!isRecord(content)) continue;
        if (content.type === "refusal" || typeof content.refusal === "string") {
          throw new ApiError(
            422,
            "ai_refused",
            "A IA recusou esta analise. Revise o periodo e tente novamente.",
          );
        }
        if (
          content.type === "output_text" && typeof content.text === "string" && content.text.trim()
        ) {
          texts.push(content.text);
        }
      }
    }
  }
  const distinct = [...new Set(texts)];
  if (distinct.length !== 1) {
    throw new ApiError(502, "ai_invalid_output", "A IA retornou uma resposta invalida.");
  }
  return distinct[0];
}

async function callOpenAI(
  deps: HandlerDependencies,
  env: RuntimeEnvironment,
  body: ReturnType<typeof buildOpenAIRequest>,
): Promise<OpenAIResult> {
  if (!env.openaiApiKey.trim()) {
    throw new ApiError(503, "ai_not_configured", "A analise com IA ainda nao esta configurada.");
  }
  let response: Response;
  let raw: unknown;
  try {
    response = await deps.fetchImpl(OPENAI_RESPONSES_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.openaiApiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(OPENAI_TIMEOUT_MS),
    });
    raw = await boundedJson(response);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    const name = error instanceof Error ? error.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      throw new ApiError(504, "ai_timeout", "A IA demorou demais para responder. Tente novamente.");
    }
    throw new ApiError(
      503,
      "ai_unavailable",
      "A analise com IA esta temporariamente indisponivel.",
    );
  }
  if (!response.ok) throw openAIHttpError(response, raw);
  if (!isRecord(raw)) {
    throw new ApiError(502, "ai_invalid_output", "A IA retornou uma resposta invalida.");
  }
  if (raw.status === "incomplete") {
    throw new ApiError(502, "ai_incomplete", "A IA nao concluiu a resposta. Tente novamente.");
  }
  if (raw.status !== "completed") {
    throw new ApiError(
      503,
      "ai_unavailable",
      "A analise com IA esta temporariamente indisponivel.",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(responseText(raw));
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(502, "ai_invalid_json", "A IA retornou uma resposta invalida.");
  }
  const usage = isRecord(raw.usage) ? raw.usage : {};
  return {
    analysis: sanitizeAnalysis(parsed),
    inputTokens: safeUsageInteger(usage.input_tokens),
    outputTokens: safeUsageInteger(usage.output_tokens),
  };
}

function elapsedMs(deps: HandlerDependencies, startedAt: number): number {
  return Math.max(0, Math.min(600_000, Math.trunc(deps.now() - startedAt)));
}

async function failOperationBestEffort(
  deps: HandlerDependencies,
  env: RuntimeEnvironment,
  context: DualAuthContext,
  request: AnalyzeRequest,
  fingerprint: string,
  code: string,
  startedAt: number,
): Promise<void> {
  const ids = tenant(context);
  try {
    await rpc(deps, env, "ia_operation_fail", {
      p_clinic_id: ids.clinicId,
      p_actor_id: ids.userId,
      p_idempotency_key: request.idempotency_key,
      p_request_id: context.requestId,
      p_fingerprint: fingerprint,
      p_error_code: code.replace(/[^a-z0-9_.:-]/gi, "_").slice(0, 80),
      p_latency_ms: elapsedMs(deps, startedAt),
    });
  } catch {
    // Falha de auditoria terminal nunca substitui o erro original nem gera log com dados.
  }
}

async function handleAnalyze(
  req: Request,
  deps: HandlerDependencies,
  env: RuntimeEnvironment,
  context: DualAuthContext,
  request: AnalyzeRequest,
): Promise<Response> {
  const ids = tenant(context);
  const startedAt = deps.now();
  const { fingerprint, contextSelectorHash } = await requestFingerprint(
    ids.clinicId,
    ids.userId,
    request,
  );
  const begin = await rpc(deps, env, "ia_operation_begin", {
    p_clinic_id: ids.clinicId,
    p_actor_id: ids.userId,
    p_use_case: useCaseForQuestion(request.pergunta_chave),
    p_idempotency_key: request.idempotency_key,
    p_request_id: context.requestId,
    p_fingerprint: fingerprint,
    p_prompt_version: PROMPT_VERSION,
    p_context_hash: contextSelectorHash,
  });
  const state = typeof begin.state === "string" ? begin.state : "";
  if (state === "completed" && begin.replay === true) {
    const analysis = sanitizeAnalysis(begin.response);
    return success(req, context, {
      operation_id: request.idempotency_key,
      replay: true,
      analise: analysis,
    });
  }
  if (state === "in_progress") {
    throw new ApiError(409, "ai_operation_in_progress", "Esta analise ja esta em andamento.");
  }
  if (state === "failed") {
    throw new ApiError(
      409,
      "ai_previous_attempt_failed",
      "Use uma nova solicitacao para tentar novamente.",
    );
  }
  if (state !== "started") {
    throw new ApiError(503, "invalid_operation_state", "Copiloto temporariamente indisponivel.");
  }

  try {
    const snapshot = await rpc(
      deps,
      env,
      "ia_contexto_agregado",
      contextRpcBody(ids, request),
    );
    const aggregateModel = extractAggregateModel(snapshot);
    const model = normalizeModel(env.openaiModel);
    const safety = await safetyIdentifier(ids.clinicId, ids.userId);
    const openaiBody = buildOpenAIRequest(model, aggregateModel, request.pergunta_chave, safety);
    const generated = await callOpenAI(deps, env, openaiBody);
    const completed = await rpc(deps, env, "ia_operation_complete", {
      p_clinic_id: ids.clinicId,
      p_actor_id: ids.userId,
      p_idempotency_key: request.idempotency_key,
      p_request_id: context.requestId,
      p_fingerprint: fingerprint,
      p_model_snapshot: model,
      p_response: generated.analysis,
      p_input_tokens: generated.inputTokens,
      p_output_tokens: generated.outputTokens,
      p_latency_ms: elapsedMs(deps, startedAt),
    });
    const analysis = Object.hasOwn(completed, "response")
      ? sanitizeAnalysis(completed.response)
      : generated.analysis;
    return success(req, context, {
      operation_id: request.idempotency_key,
      replay: completed.replay === true,
      analise: analysis,
    });
  } catch (error) {
    const code = error instanceof ApiError || error instanceof ContractError
      ? error.code
      : "unhandled_error";
    await failOperationBestEffort(
      deps,
      env,
      context,
      request,
      fingerprint,
      code,
      startedAt,
    );
    throw error;
  }
}

export function createHandler(overrides: Partial<HandlerDependencies> = {}) {
  const deps: HandlerDependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };
  return async (req: Request): Promise<Response> => {
    const origin = req.headers.get("origin");
    if (origin && !corsOriginAllowed(origin)) {
      return fail(req, new ApiError(403, "origin_forbidden", "Origem nao autorizada."));
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
      const response = fail(req, new ApiError(405, "method_not_allowed", "Metodo nao permitido."));
      response.headers.set("Allow", "POST, OPTIONS");
      return response;
    }

    const env = deps.environment();
    const authConfig: DualAuthConfig = {
      supabaseUrl: env.supabaseUrl,
      serviceRoleKey: env.serviceRoleKey,
      allowedRoles: ["owner"],
      requireAal2: true,
      fetchImpl: deps.fetchImpl,
    };
    let context: DualAuthContext;
    try {
      // Autenticacao precede a leitura e a validacao do corpo em todo POST.
      context = await deps.authenticate(req, authConfig);
      tenant(context);
    } catch (error) {
      if (error instanceof DualAuthError) {
        return json(req, { erro: error.publicMessage, codigo: error.code }, error.status);
      }
      if (error instanceof ApiError || error instanceof ContractError) return fail(req, error);
      return fail(
        req,
        new ApiError(503, "auth_unavailable", "Autenticacao temporariamente indisponivel."),
      );
    }

    try {
      const request = parseCopilotRequest(await readJsonBody(req));
      const ids = tenant(context);
      if (request.acao === "painel") {
        const snapshot = await rpc(
          deps,
          env,
          "ia_contexto_agregado",
          contextRpcBody(ids, request),
        );
        // O mesmo guard DLP protege o modelo agregado, embora painel_privado nunca seja enviado a OpenAI.
        extractAggregateModel(snapshot);
        const responseBytes = new TextEncoder().encode(JSON.stringify(snapshot)).byteLength;
        if (responseBytes > MAX_PANEL_RESPONSE_BYTES) {
          throw new ApiError(502, "panel_snapshot_too_large", "Painel agregado excede os limites.");
        }
        return success(req, context, { snapshot });
      }
      if (request.acao === "feedback") {
        const feedback = await rpc(deps, env, "ia_registrar_feedback", {
          p_clinic_id: ids.clinicId,
          p_actor_id: ids.userId,
          p_operation_idempotency_key: request.operation_id,
          p_feedback_id: request.idempotency_key,
          p_request_id: context.requestId,
          p_feedback: request.avaliacao,
        });
        return success(req, context, {
          operation_id: request.operation_id,
          feedback,
        });
      }
      return await handleAnalyze(req, deps, env, context, request);
    } catch (error) {
      if (error instanceof ApiError || error instanceof ContractError) return fail(req, error);
      return fail(
        req,
        new ApiError(500, "internal_error", "Nao foi possivel concluir a operacao agora."),
      );
    }
  };
}

export const handleRequest = createHandler();

if (import.meta.main) Deno.serve(handleRequest);

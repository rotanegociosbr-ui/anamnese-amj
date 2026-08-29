import "jsr:@supabase/functions-js@2.112.3/edge-runtime.d.ts";
import {
  authenticateDual,
  authResponseFields,
  type DualAuthConfig,
  type DualAuthContext,
  DualAuthError,
} from "../_shared/dual-auth.ts";
import { type FetchLike, IntegrationDisabledError, integrationStatusDto } from "./logic.ts";

export {
  IntegrationDisabledError,
  integrationStatusDto,
  NULL_INTEGRATION_ADAPTER,
} from "./logic.ts";

type AuthenticateLike = (
  req: Request,
  config: DualAuthConfig,
) => Promise<DualAuthContext>;

interface RuntimeEnvironment {
  supabaseUrl: string;
  serviceRoleKey: string;
}

export interface HandlerDependencies {
  authenticate: AuthenticateLike;
  environment: () => RuntimeEnvironment;
  /** Reservado a adaptadores futuros; o adaptador nulo nunca o executa. */
  transport: FetchLike;
}

interface StatusRequest {
  acao: "status";
}

class ContractError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly publicMessage: string,
  ) {
    super(publicMessage);
    this.name = "ContractError";
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_REQUEST_BYTES = 1_024;

const DEFAULT_DEPENDENCIES: HandlerDependencies = {
  authenticate: authenticateDual,
  environment: () => ({
    supabaseUrl: (Deno.env.get("SUPABASE_URL") || "").replace(/\/+$/, ""),
    serviceRoleKey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "",
  }),
  transport: fetch,
};

function validUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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
  if (jsonContent) {
    headers.set("Content-Type", "application/json; charset=utf-8");
  }
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
  error: ContractError | IntegrationDisabledError,
): Response {
  return json(
    req,
    { erro: error.publicMessage, codigo: error.code },
    error.status,
  );
}

function tenant(context: DualAuthContext): void {
  if (
    context.authMethod !== "supabase_auth" || context.role !== "owner" ||
    context.aal !== "aal2" || !validUuid(context.clinicId) ||
    !validUuid(context.userId) || !validUuid(context.requestId)
  ) {
    throw new ContractError(
      403,
      "owner_mfa_required",
      "Entre com uma conta proprietaria individual e confirme o MFA.",
    );
  }
}

async function readJsonBody(req: Request): Promise<unknown> {
  const contentType = (req.headers.get("content-type") || "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (contentType !== "application/json") {
    throw new ContractError(415, "content_type_required", "Envie os dados em JSON.");
  }
  const declared = Number(req.headers.get("content-length") || "0");
  if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) {
    throw new ContractError(413, "body_too_large", "A solicitacao excede 1 KiB.");
  }
  const reader = req.body?.getReader();
  if (!reader) {
    throw new ContractError(400, "empty_body", "Envie os dados da solicitacao.");
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > MAX_REQUEST_BYTES) {
      await reader.cancel();
      throw new ContractError(413, "body_too_large", "A solicitacao excede 1 KiB.");
    }
    chunks.push(value);
  }
  if (!total) {
    throw new ContractError(400, "empty_body", "Envie os dados da solicitacao.");
  }
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

function parseStatusRequest(value: unknown): StatusRequest {
  if (!isRecord(value)) {
    throw new ContractError(422, "invalid_contract", "Solicitacao invalida.");
  }
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== "acao" || value.acao !== "status") {
    throw new ContractError(
      422,
      "action_not_allowed",
      "Somente a consulta de status esta disponivel.",
    );
  }
  return { acao: "status" };
}

export function createHandler(overrides: Partial<HandlerDependencies> = {}) {
  const deps: HandlerDependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };
  return async (req: Request): Promise<Response> => {
    const origin = req.headers.get("origin");
    if (origin && !corsOriginAllowed(origin)) {
      return fail(
        req,
        new ContractError(403, "origin_forbidden", "Origem nao autorizada."),
      );
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
      const response = fail(
        req,
        new ContractError(405, "method_not_allowed", "Metodo nao permitido."),
      );
      response.headers.set("Allow", "POST, OPTIONS");
      return response;
    }

    const env = deps.environment();
    const authConfig: DualAuthConfig = {
      supabaseUrl: env.supabaseUrl,
      serviceRoleKey: env.serviceRoleKey,
      allowedRoles: ["owner"],
      requireAal2: true,
      // A autenticacao e a unica dependencia autorizada a acessar o Supabase.
      // O transporte reservado a integracoes permanece isolado e inutilizado.
      fetchImpl: fetch,
    };
    let context: DualAuthContext;
    try {
      context = await deps.authenticate(req, authConfig);
      tenant(context);
    } catch (error) {
      if (error instanceof DualAuthError) {
        return json(
          req,
          { erro: error.publicMessage, codigo: error.code },
          error.status,
        );
      }
      if (error instanceof ContractError) return fail(req, error);
      return fail(
        req,
        new ContractError(
          503,
          "auth_unavailable",
          "Autenticacao temporariamente indisponivel.",
        ),
      );
    }

    try {
      parseStatusRequest(await readJsonBody(req));
      return json(req, {
        ok: true,
        ...authResponseFields(context),
        chamadas_externas: false,
        cobranca_automatica: false,
        integracoes: integrationStatusDto(),
      });
    } catch (error) {
      if (error instanceof ContractError || error instanceof IntegrationDisabledError) {
        return fail(req, error);
      }
      return fail(
        req,
        new ContractError(
          500,
          "internal_error",
          "Nao foi possivel consultar as integracoes agora.",
        ),
      );
    }
  };
}

export const handleRequest = createHandler();

if (import.meta.main) Deno.serve(handleRequest);

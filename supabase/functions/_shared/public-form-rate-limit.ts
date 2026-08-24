const DEFAULT_LIMIT = 15;
const DEFAULT_WINDOW_SECONDS = 15 * 60;
const DEFAULT_TIMEOUT_MS = 3_000;

type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export type PublicFormRateLimitResult = {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
};

export type PublicFormRateLimitOptions = {
  supabaseUrl: string;
  serviceRoleKey: string;
  scope: string;
  limit?: number;
  windowSeconds?: number;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
};

export class PublicFormRateLimitUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublicFormRateLimitUnavailableError";
  }
}

export function publicFormClientAddress(req: Request): string {
  const cloudflare = (req.headers.get("cf-connecting-ip") || "").trim();
  if (cloudflare) return cloudflare.slice(0, 100);

  const forwarded = (req.headers.get("x-forwarded-for") || "")
    .split(",")[0]
    .trim();
  return (forwarded || "origem-indisponivel").slice(0, 100);
}

async function hmacSha256(value: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(value),
  );
  return Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function unavailable(message: string): PublicFormRateLimitUnavailableError {
  return new PublicFormRateLimitUnavailableError(message);
}

export async function consumePublicFormRateLimit(
  req: Request,
  options: PublicFormRateLimitOptions,
): Promise<PublicFormRateLimitResult> {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const windowSeconds = options.windowSeconds ?? DEFAULT_WINDOW_SECONDS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  if (!/^https?:\/\//.test(options.supabaseUrl) || !options.serviceRoleKey) {
    throw unavailable("rate_limit_configuration_invalid");
  }
  if (!/^[a-z0-9][a-z0-9_-]{1,63}$/.test(options.scope)) {
    throw unavailable("rate_limit_scope_invalid");
  }
  if (
    !Number.isInteger(limit) || limit < 1 || limit > 100 ||
    !Number.isInteger(windowSeconds) || windowSeconds < 60 ||
    windowSeconds > 86_400 || !Number.isInteger(timeoutMs) || timeoutMs < 100 ||
    timeoutMs > 30_000
  ) {
    throw unavailable("rate_limit_parameters_invalid");
  }

  let rpcUrl: string;
  try {
    rpcUrl = new URL(
      "/rest/v1/rpc/public_form_rate_limit_consume",
      options.supabaseUrl,
    ).toString();
  } catch {
    throw unavailable("rate_limit_configuration_invalid");
  }

  const originHash = await hmacSha256(
    publicFormClientAddress(req),
    options.serviceRoleKey,
  );
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(rpcUrl, {
      method: "POST",
      headers: {
        apikey: options.serviceRoleKey,
        Authorization: `Bearer ${options.serviceRoleKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        p_scope: options.scope,
        p_origin_hash: originHash,
        p_limit: limit,
        p_window_seconds: windowSeconds,
      }),
      signal: controller.signal,
    });
  } catch {
    throw unavailable("rate_limit_request_failed");
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw unavailable(`rate_limit_rpc_failed_${response.status}`);
  }

  let decoded: unknown;
  try {
    decoded = await response.json();
  } catch {
    throw unavailable("rate_limit_response_invalid");
  }

  const record = Array.isArray(decoded) ? decoded[0] : decoded;
  if (!record || typeof record !== "object") {
    throw unavailable("rate_limit_response_invalid");
  }

  const value = record as Record<string, unknown>;
  const remaining = Number(value.remaining);
  const retryAfterSeconds = Number(value.retry_after_seconds);
  if (
    typeof value.allowed !== "boolean" || !Number.isInteger(remaining) ||
    remaining < 0 || !Number.isInteger(retryAfterSeconds) ||
    retryAfterSeconds < 0
  ) {
    throw unavailable("rate_limit_response_invalid");
  }

  return {
    allowed: value.allowed,
    remaining,
    retryAfterSeconds,
  };
}

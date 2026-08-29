import "jsr:@supabase/functions-js@2.112.3/edge-runtime.d.ts";
import { consumePublicFormRateLimit } from "../_shared/public-form-rate-limit.ts";
import { isAllowedOrigin, normalizeSubmission, readJsonBody, SubmissionError } from "./logic.ts";
import type { JsonRecord } from "./logic.ts";

interface HandlerDependencies {
  env?: (name: string) => string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  rateLimiter?: typeof consumePublicFormRateLimit;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// Projeto single-clinic. Este UUID identifica a clínica no próprio banco e
// não é segredo; CLINIC_ID continua disponível como override operacional.
const DEFAULT_CLINIC_ID = "34a18ef9-28c2-426a-afb3-eaa732ffed58";

function corsHeaders(origin: string, allowLocalOrigins = false): Headers {
  const headers = new Headers({
    "Access-Control-Allow-Headers": "apikey, authorization, content-type, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "600",
    "Vary": "Origin",
  });
  if (isAllowedOrigin(origin, allowLocalOrigins)) {
    headers.set("Access-Control-Allow-Origin", origin);
  }
  return headers;
}

function json(origin: string, body: unknown, status: number, allowLocalOrigins = false): Response {
  const headers = corsHeaders(origin, allowLocalOrigins);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store, max-age=0");
  headers.set("Pragma", "no-cache");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("Cross-Origin-Resource-Policy", "same-site");
  return new Response(JSON.stringify(body), { status, headers });
}

function fail(origin: string, error: SubmissionError, allowLocalOrigins = false): Response {
  return json(
    origin,
    {
      ok: false,
      codigo_erro: error.code,
      erro: error.publicMessage,
    },
    error.status,
    allowLocalOrigins,
  );
}

function rpcBody(
  clinicId: string,
  submission: Awaited<ReturnType<typeof normalizeSubmission>>,
): JsonRecord {
  return {
    p_clinic_id: clinicId,
    p_full_name: submission.fullName,
    p_phone: submission.phone,
    p_visit_kind: submission.visitKind,
    p_interest: submission.interest,
    p_preferred_date: submission.preferredDate,
    p_preferred_period: submission.preferredPeriod,
    p_contact_consent: submission.contactConsent,
    p_consent_version: submission.consentVersion,
    p_started_at: submission.startedAt,
    p_idempotency_key: submission.idempotencyKey,
    p_payload_sha256: submission.payloadSha256,
    p_dedup_sha256: submission.dedupSha256,
  };
}

export function createHandler(dependencies: HandlerDependencies = {}) {
  const env = dependencies.env || ((name: string) => Deno.env.get(name) || "");
  const fetchImpl = dependencies.fetchImpl || fetch;
  const now = dependencies.now || (() => new Date());
  const rateLimiter = dependencies.rateLimiter || consumePublicFormRateLimit;

  return async (req: Request): Promise<Response> => {
    const origin = (req.headers.get("origin") || "").trim();
    const allowLocalOrigins = env("ALLOW_LOCAL_ORIGINS") === "true";
    if (!isAllowedOrigin(origin, allowLocalOrigins)) {
      return json(origin, { ok: false, erro: "Origem não autorizada." }, 403);
    }
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin, allowLocalOrigins) });
    }
    if (req.method !== "POST") {
      const response = json(
        origin,
        { ok: false, erro: "Método não permitido." },
        405,
        allowLocalOrigins,
      );
      response.headers.set("Allow", "POST, OPTIONS");
      return response;
    }
    const mediaType = (req.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
    if (mediaType !== "application/json") {
      return fail(
        origin,
        new SubmissionError(415, "invalid_content_type", "Envie a solicitação em JSON."),
        allowLocalOrigins,
      );
    }

    const supabaseUrl = env("SUPABASE_URL").replace(/\/+$/, "");
    const serviceRoleKey = env("SUPABASE_SERVICE_ROLE_KEY");
    const clinicId = (env("CLINIC_ID") || DEFAULT_CLINIC_ID).toLowerCase();
    if (!supabaseUrl || !serviceRoleKey || !UUID_PATTERN.test(clinicId)) {
      return fail(
        origin,
        new SubmissionError(
          503,
          "service_unavailable",
          "O recebimento está temporariamente indisponível.",
        ),
        allowLocalOrigins,
      );
    }

    try {
      const rate = await rateLimiter(req, {
        supabaseUrl,
        serviceRoleKey,
        scope: "agendamento-submit",
        limit: 8,
        windowSeconds: 15 * 60,
      });
      if (!rate.allowed) {
        return fail(
          origin,
          new SubmissionError(
            429,
            "rate_limited",
            "Aguarde alguns minutos antes de tentar novamente.",
          ),
          allowLocalOrigins,
        );
      }
    } catch {
      return fail(
        origin,
        new SubmissionError(
          503,
          "rate_limit_unavailable",
          "O recebimento está temporariamente indisponível.",
        ),
        allowLocalOrigins,
      );
    }

    try {
      const raw = await readJsonBody(req);
      const submission = await normalizeSubmission(raw, now());
      // Terceiro limite usa HMAC do telefone pelo helper compartilhado. A
      // Request sintética nunca sai da função e somente o hash chega ao banco.
      let contactRate;
      try {
        contactRate = await rateLimiter(
          new Request(req.url, { headers: { "x-forwarded-for": submission.phone } }),
          {
            supabaseUrl,
            serviceRoleKey,
            scope: "agendamento-contact",
            limit: 5,
            windowSeconds: 15 * 60,
          },
        );
      } catch {
        return fail(
          origin,
          new SubmissionError(
            503,
            "rate_limit_unavailable",
            "O recebimento está temporariamente indisponível.",
          ),
          allowLocalOrigins,
        );
      }
      if (!contactRate.allowed) {
        return fail(
          origin,
          new SubmissionError(
            429,
            "rate_limited",
            "Aguarde alguns minutos antes de tentar novamente.",
          ),
          allowLocalOrigins,
        );
      }

      // O teto global só é consumido depois da validação e do limite por
      // contato. Assim, corpos inválidos não conseguem bloquear a clínica.
      // O helper persiste somente o HMAC desta chave constante.
      let globalRate;
      try {
        globalRate = await rateLimiter(
          new Request(req.url, { headers: { "x-forwarded-for": `clinic:${clinicId}` } }),
          {
            supabaseUrl,
            serviceRoleKey,
            scope: "agendamento-global",
            limit: 60,
            windowSeconds: 15 * 60,
          },
        );
      } catch {
        return fail(
          origin,
          new SubmissionError(
            503,
            "rate_limit_unavailable",
            "O recebimento está temporariamente indisponível.",
          ),
          allowLocalOrigins,
        );
      }
      if (!globalRate.allowed) {
        return fail(
          origin,
          new SubmissionError(
            429,
            "rate_limited",
            "Aguarde alguns minutos antes de tentar novamente.",
          ),
          allowLocalOrigins,
        );
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8_000);
      let result: Response;
      try {
        result = await fetchImpl(`${supabaseUrl}/rest/v1/rpc/crm_site_booking_receive`, {
          method: "POST",
          headers: {
            apikey: serviceRoleKey,
            Authorization: `Bearer ${serviceRoleKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(rpcBody(clinicId, submission)),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeout);
      }
      if (!result.ok) {
        console.error("agendamento-submit backend unavailable");
        return fail(
          origin,
          new SubmissionError(
            503,
            "database_unavailable",
            "O recebimento está temporariamente indisponível.",
          ),
          allowLocalOrigins,
        );
      }
      // Intencionalmente não expõe request_id, deduplicação ou existência no CRM.
      return json(origin, { ok: true, recebido: true }, 202, allowLocalOrigins);
    } catch (error) {
      if (error instanceof SubmissionError) return fail(origin, error, allowLocalOrigins);
      console.error("agendamento-submit failed");
      return fail(
        origin,
        new SubmissionError(500, "internal_error", "Não foi possível concluir agora."),
        allowLocalOrigins,
      );
    }
  };
}

export const handleRequest = createHandler();

if (import.meta.main) Deno.serve(handleRequest);

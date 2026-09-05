import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  consumePublicFormRateLimit,
  PublicFormRateLimitUnavailableError,
  publicFormClientAddress,
} from "./public-form-rate-limit.ts";

const TEST_URL = "https://project.supabase.co";
const TEST_KEY = "service-role-test-secret";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FUNCTIONS = path.resolve(HERE, "..");
const MIGRATIONS = path.resolve(FUNCTIONS, "..", "migrations");

function options(fetchImpl, overrides = {}) {
  return {
    supabaseUrl: TEST_URL,
    serviceRoleKey: TEST_KEY,
    scope: "tcle-submit",
    fetchImpl,
    ...overrides,
  };
}

test("consome o RPC sem expor o endereço de rede", async () => {
  let rpcUrl = "";
  let rpcInit;
  const fetchImpl = async (input, init) => {
    rpcUrl = String(input);
    rpcInit = init;
    return new Response(JSON.stringify({
      allowed: true,
      remaining: 14,
      retry_after_seconds: 0,
    }), { status: 200 });
  };
  const req = new Request("https://example.test", {
    headers: {
      "cf-connecting-ip": "203.0.113.42",
      "x-forwarded-for": "198.51.100.9, 192.0.2.8",
    },
  });

  const result = await consumePublicFormRateLimit(req, options(fetchImpl));

  assert.deepEqual(result, {
    allowed: true,
    remaining: 14,
    retryAfterSeconds: 0,
  });
  assert.equal(
    rpcUrl,
    "https://project.supabase.co/rest/v1/rpc/public_form_rate_limit_consume",
  );
  assert.equal(rpcInit.method, "POST");
  assert.equal(rpcInit.headers.apikey, TEST_KEY);
  const body = JSON.parse(rpcInit.body);
  assert.equal(body.p_scope, "tcle-submit");
  assert.equal(body.p_limit, 15);
  assert.equal(body.p_window_seconds, 900);
  assert.equal(
    body.p_origin_hash,
    createHmac("sha256", TEST_KEY).update("203.0.113.42").digest("hex"),
  );
  assert.equal(rpcInit.body.includes("203.0.113.42"), false);
});

test("usa somente o primeiro endereço encaminhado quando Cloudflare não informa", () => {
  const req = new Request("https://example.test", {
    headers: { "x-forwarded-for": " 198.51.100.10, 192.0.2.1 " },
  });
  assert.equal(publicFormClientAddress(req), "198.51.100.10");
});

test("propaga uma decisão atômica de bloqueio", async () => {
  const fetchImpl = async () => new Response(JSON.stringify({
    allowed: false,
    remaining: 0,
    retry_after_seconds: 321,
  }), { status: 200 });

  const result = await consumePublicFormRateLimit(
    new Request("https://example.test"),
    options(fetchImpl),
  );

  assert.deepEqual(result, {
    allowed: false,
    remaining: 0,
    retryAfterSeconds: 321,
  });
});

test("falha fechado quando o RPC retorna erro", async () => {
  const fetchImpl = async () => new Response("erro", { status: 500 });
  await assert.rejects(
    consumePublicFormRateLimit(
      new Request("https://example.test"),
      options(fetchImpl),
    ),
    PublicFormRateLimitUnavailableError,
  );
});

test("falha fechado quando a rede ou a resposta são inválidas", async () => {
  const networkFailure = async () => {
    throw new Error("offline");
  };
  const invalidResponse = async () =>
    new Response(JSON.stringify({ allowed: "yes" }), { status: 200 });

  await assert.rejects(
    consumePublicFormRateLimit(
      new Request("https://example.test"),
      options(networkFailure),
    ),
    PublicFormRateLimitUnavailableError,
  );
  await assert.rejects(
    consumePublicFormRateLimit(
      new Request("https://example.test"),
      options(invalidResponse),
    ),
    PublicFormRateLimitUnavailableError,
  );
});

test("interrompe e falha fechado quando o RPC não responde", async () => {
  const neverResponds = (_input, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => {
        reject(new DOMException("aborted", "AbortError"));
      });
    });

  await assert.rejects(
    consumePublicFormRateLimit(
      new Request("https://example.test"),
      options(neverResponds, { timeoutMs: 100 }),
    ),
    PublicFormRateLimitUnavailableError,
  );
});

const HANDLERS = [
  ["anamnese-submit", "anamnese-submit", "Deno.serve", "await consumePublicFormRateLimit"],
  ["tcle-submit", "tcle-submit", "Deno.serve", "await consumePublicFormRateLimit"],
  ["tcle-preenchimento-submit", "tcle-submit", "Deno.serve", "await consumePublicFormRateLimit"],
  ["tcle-intradermoterapia-submit", "tcle-submit", "Deno.serve", "await consumePublicFormRateLimit"],
  ["tcle-bioestimulador-submit", "tcle-submit", "Deno.serve", "await consumePublicFormRateLimit"],
  ["tcle-peeling-quimico-submit", "tcle-submit", "Deno.serve", "await consumePublicFormRateLimit"],
  ["tcle-fios-pdo-submit", "tcle-submit", "Deno.serve", "await consumePublicFormRateLimit"],
  ["agendamento-submit", "agendamento-submit", "return async (req: Request)", "await rateLimiter(req"],
];

test("todos os formulários aplicam o limite antes do corpo e da idempotência", async () => {
  for (const [directory, scope, handlerNeedle, limiterNeedle] of HANDLERS) {
    const source = await readFile(
      path.join(FUNCTIONS, directory, "index.ts"),
      "utf8",
    );
    const handler = source.indexOf(handlerNeedle);
    const limiter = source.indexOf(limiterNeedle, handler);
    const bodyRead = Math.max(
      source.indexOf("await readBody(req)", handler),
      source.indexOf("await req.arrayBuffer()", handler),
      source.indexOf("await readJsonBody(req)", handler),
      source.indexOf("await readLimitedBody(req, MAX_BODY_BYTES)", handler),
    );
    const idempotencyReads = [
      source.indexOf("await findExisting(", handler),
      source.indexOf("await existing(", handler),
    ].filter((position) => position >= 0);
    const firstIdempotencyRead = Math.min(...idempotencyReads);

    assert.ok(handler >= 0, `${directory}: handler ausente`);
    assert.ok(limiter > handler, `${directory}: limitador ausente`);
    assert.doesNotMatch(
      source.slice(handler, limiter),
      /await (?:admin|existing|findExisting|successfulRateCount|signedPdf)\(/,
      `${directory}: houve acesso privilegiado antes do limitador`,
    );
    assert.doesNotMatch(
      source.slice(handler, limiter),
      /\bSERVICE\b/,
      `${directory}: service_role foi usado antes do limitador`,
    );
    assert.ok(limiter < bodyRead, `${directory}: limitador executado após o corpo`);
    assert.ok(
      limiter < firstIdempotencyRead,
      `${directory}: limitador executado após leitura idempotente`,
    );
    assert.match(
      source.slice(limiter, bodyRead),
      /(?:temporary_error[\s\S]*503|503[\s\S]*rate_limit_unavailable)/,
      `${directory}: indisponibilidade do limitador não falha fechado`,
    );
    assert.match(
      source.slice(limiter, bodyRead),
      new RegExp(`scope: "${scope}"`),
      `${directory}: escopo inesperado`,
    );
  }
});

test("dry_run exige habilitação do servidor antes de validação e PDF", async () => {
  const source = await readFile(
    path.join(FUNCTIONS, "anamnese-submit", "index.ts"),
    "utf8",
  );
  const handler = source.indexOf("Deno.serve");
  const rejection = source.indexOf("payload.dry_run === true", handler);
  const validation = source.indexOf("const data = safeData(payload)", handler);
  const idempotency = source.indexOf("await findExisting(", handler);
  const pdf = source.indexOf("await generatePdf(", handler);

  assert.match(
    source,
    /Deno\.env\.get\("ANAMNESE_ENABLE_DRY_RUN"\) === "true" &&[\s\S]*127\\\.0\\\.0\\\.1\|localhost/,
  );
  assert.ok(rejection > handler);
  assert.ok(rejection < validation);
  assert.ok(rejection < idempotency);
  assert.ok(rejection < pdf);
  assert.match(
    source.slice(rejection, validation),
    /!DRY_RUN_ENABLED \|\| !LOCAL_TEST_ORIGINS\.has\(origin\)/,
  );
});

test("migration mantém contador privado, atômico e exclusivo de service_role", async () => {
  const migration = await readFile(
    path.join(MIGRATIONS, "20260824143000_public_form_rate_limit_atomic.sql"),
    "utf8",
  );

  assert.match(migration, /private\.public_form_rate_limits/);
  assert.match(migration, /on conflict \(scope, origin_hash\) do update/i);
  assert.match(migration, /least\(current_limit\.request_count \+ 1, p_limit \+ 1\)/i);
  assert.match(
    migration,
    /public_form_rate_limits_updated_at_idx[\s\S]*updated_at/i,
  );
  assert.match(
    migration,
    /make_interval\(hours => 24\)[\s\S]*limit 25[\s\S]*for update skip locked/i,
  );
  assert.match(migration, /security definer[\s\S]*set search_path = ''/i);
  assert.match(
    migration,
    /revoke all on table private\.public_form_rate_limits[\s\S]*service_role/i,
  );
  assert.match(
    migration,
    /revoke all on function public\.public_form_rate_limit_consume[\s\S]*from public, anon, authenticated, service_role/i,
  );
  assert.match(
    migration,
    /grant execute on function public\.public_form_rate_limit_consume[\s\S]*to service_role/i,
  );
});

import { createHandler } from "./index.ts";
import { MAX_BODY_BYTES, normalizeSubmission, readJsonBody, SubmissionError } from "./logic.ts";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

function equals(actual: unknown, expected: unknown, message = "valores diferentes"): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}: esperado ${JSON.stringify(expected)}, recebido ${JSON.stringify(actual)}`,
    );
  }
}

async function rejects(callback: () => Promise<unknown>, code?: string): Promise<void> {
  let error: unknown;
  try {
    await callback();
  } catch (caught) {
    error = caught;
  }
  assert(error instanceof SubmissionError, "era esperado SubmissionError");
  if (code) equals(error.code, code);
}

const NOW = new Date("2026-08-29T15:00:00.000Z");
const CLINIC_ID = "11111111-1111-4111-8111-111111111111";

function validPayload(): Record<string, unknown> {
  return {
    idempotency_key: "22222222-2222-4222-8222-222222222222",
    started_at: "2026-08-29T14:59:55.000Z",
    website: "",
    nome: "Ana da Silva",
    telefone: "31995844803",
    primeira_visita: "paciente_atual",
    interesse: "toxina_botulinica",
    data_preferida: "2026-08-30",
    periodo: "a_combinar",
    consentimento_contato: true,
  };
}

function post(body: unknown, origin = "https://anamariajacob.com.br"): Request {
  return new Request("https://edge.test/agendamento-submit", {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

Deno.test("normaliza contrato exato da UI e gera SHA-256 sem objetivo livre", async () => {
  const normalized = await normalizeSubmission(validPayload(), NOW);
  equals(normalized.phone, "+5531995844803");
  equals(normalized.visitKind, "paciente_atual");
  equals(normalized.preferredPeriod, "a_combinar");
  assert(/^[a-f0-9]{64}$/.test(normalized.payloadSha256), "payload deve usar SHA-256");
  assert(/^[a-f0-9]{64}$/.test(normalized.dedupSha256), "dedup deve usar SHA-256");
  assert(!("objetivo" in normalized), "texto livre não pode atravessar a normalização");
});

Deno.test("dedup exata ignora somente primeira visita e inclui interesse/data/período", async () => {
  const first = await normalizeSubmission(validPayload(), NOW);
  const replay = validPayload();
  replay.primeira_visita = "primeira_avaliacao";
  const second = await normalizeSubmission(replay, NOW);
  equals(first.dedupSha256, second.dedupSha256);
  assert(first.payloadSha256 !== second.payloadSha256, "payload diferente deve ter hash diferente");

  const changed = validPayload();
  changed.periodo = "tarde";
  const third = await normalizeSubmission(changed, NOW);
  assert(first.dedupSha256 !== third.dedupSha256, "período participa da deduplicação");
});

Deno.test("rejeita campo objetivo, enum fora da allowlist e tempo fora de 3s..12h", async () => {
  await rejects(
    () => normalizeSubmission({ ...validPayload(), objetivo: "texto livre" }, NOW),
    "unexpected_field",
  );
  await rejects(
    () => normalizeSubmission({ ...validPayload(), interesse: "inventado" }, NOW),
    "invalid_option",
  );
  await rejects(
    () => normalizeSubmission({ ...validPayload(), started_at: NOW.toISOString() }, NOW),
    "invalid_fill_time",
  );
  await rejects(
    () =>
      normalizeSubmission(
        { ...validPayload(), started_at: "2026-08-28T02:59:59.000Z" },
        NOW,
      ),
    "invalid_fill_time",
  );
});

Deno.test("leitor rejeita JSON maior que 8KB mesmo sem content-length confiável", async () => {
  const oversized = "x".repeat(MAX_BODY_BYTES + 1);
  const req = new Request("https://edge.test", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ oversized }),
  });
  await rejects(() => readJsonBody(req), "body_too_large");
});

Deno.test("handler usa três rate limits, RPC privada e devolve 202 genérico", async () => {
  const rateCalls: Array<{ scope: string; address: string }> = [];
  let rpcBody: Record<string, unknown> = {};
  let rpcSignal: AbortSignal | null = null;
  const handler = createHandler({
    env: (name) =>
      ({
        SUPABASE_URL: "https://project.supabase.co",
        SUPABASE_SERVICE_ROLE_KEY: "service-role-test-only",
        CLINIC_ID,
      })[name] || "",
    now: () => NOW,
    rateLimiter: (req, options) => {
      rateCalls.push({
        scope: options.scope,
        address: req.headers.get("x-forwarded-for") || "",
      });
      return Promise.resolve({ allowed: true, remaining: 4, retryAfterSeconds: 0 });
    },
    fetchImpl: (_input, init) => {
      rpcBody = JSON.parse(String(init?.body || "{}"));
      rpcSignal = init?.signal || null;
      return Promise.resolve(Response.json({ request_id: "opaque" }, { status: 200 }));
    },
  });
  const response = await handler(post(validPayload()));
  equals(response.status, 202);
  equals(await response.json(), { ok: true, recebido: true });
  equals(rateCalls.map((call) => call.scope), [
    "agendamento-submit",
    "agendamento-contact",
    "agendamento-global",
  ]);
  equals(rateCalls[1].address, "+5531995844803");
  equals(rateCalls[2].address, `clinic:${CLINIC_ID}`);
  assert((rpcSignal as unknown) instanceof AbortSignal, "RPC deve receber AbortSignal de timeout");
  assert(!("objetivo" in rpcBody), "RPC não pode receber objetivo");
  equals(rpcBody.p_clinic_id, CLINIC_ID);
});

Deno.test("rate limit por contato/global também falha fechado", async () => {
  let calls = 0;
  const handler = createHandler({
    env: (name) =>
      ({
        SUPABASE_URL: "https://project.supabase.co",
        SUPABASE_SERVICE_ROLE_KEY: "service-role-test-only",
        CLINIC_ID,
      })[name] || "",
    now: () => NOW,
    rateLimiter: () => {
      calls++;
      if (calls === 3) return Promise.reject(new Error("unavailable"));
      return Promise.resolve({ allowed: true, remaining: 1, retryAfterSeconds: 0 });
    },
    fetchImpl: () => {
      throw new Error("RPC não deve ser chamada");
    },
  });
  const response = await handler(post(validPayload()));
  equals(response.status, 503);
  equals(calls, 3);
});

Deno.test("projeto single-clinic funciona sem secret CLINIC_ID", async () => {
  const handler = createHandler({
    env: (name) =>
      ({
        SUPABASE_URL: "https://project.supabase.co",
        SUPABASE_SERVICE_ROLE_KEY: "service-role-test-only",
      })[name] || "",
    now: () => NOW,
    rateLimiter: () => Promise.resolve({ allowed: true, remaining: 4, retryAfterSeconds: 0 }),
    fetchImpl: () => {
      throw new Error("RPC não deve ser chamada com corpo inválido");
    },
  });
  const response = await handler(post({}));
  equals(response.status, 422);
});

Deno.test("CORS libera local somente com ALLOW_LOCAL_ORIGINS=true", async () => {
  const handler = createHandler();
  for (
    const origin of [
      "https://anamariajacob.com.br",
      "https://www.anamariajacob.com.br",
    ]
  ) {
    const response = await handler(
      new Request("https://edge.test", {
        method: "OPTIONS",
        headers: { origin },
      }),
    );
    equals(response.status, 204);
    equals(response.headers.get("access-control-allow-origin"), origin);
  }
  const localDenied = await handler(
    new Request("https://edge.test", {
      method: "OPTIONS",
      headers: { origin: "http://127.0.0.1:8765" },
    }),
  );
  equals(localDenied.status, 403);

  const localHandler = createHandler({
    env: (name) => name === "ALLOW_LOCAL_ORIGINS" ? "true" : "",
  });
  for (const origin of ["http://127.0.0.1:8765", "http://localhost:8765"]) {
    const response = await localHandler(
      new Request("https://edge.test", {
        method: "OPTIONS",
        headers: { origin },
      }),
    );
    equals(response.status, 204);
    equals(response.headers.get("access-control-allow-origin"), origin);
  }
  const denied = await handler(
    new Request("https://edge.test", {
      method: "OPTIONS",
      headers: { origin: "https://evil.example" },
    }),
  );
  equals(denied.status, 403);
  equals(denied.headers.get("access-control-allow-origin"), null);
});

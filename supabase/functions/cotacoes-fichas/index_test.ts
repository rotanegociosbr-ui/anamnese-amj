import {
  corsOriginAllowed,
  handleRequest,
  normalizeSearch,
  reviewDecision,
  reviewProofAction,
  reviewReason,
  tenantClinicId,
  totalFromContentRange,
} from "./index.ts";

function assertEquals(actual: unknown, expected: unknown): void {
  if (!Object.is(actual, expected)) {
    throw new Error(`Esperado ${String(expected)}, recebido ${String(actual)}.`);
  }
}

function assertThrows(callback: () => unknown): void {
  let thrown = false;
  try {
    callback();
  } catch {
    thrown = true;
  }
  if (!thrown) throw new Error("Era esperado que a operação falhasse.");
}

const CLINIC_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";

Deno.test("aceita origem oficial e localhost, mas recusa origem externa", () => {
  assertEquals(corsOriginAllowed("https://anamariajacob.com.br"), true);
  assertEquals(corsOriginAllowed("http://127.0.0.1:8765"), true);
  assertEquals(corsOriginAllowed("https://example.org"), false);
});

Deno.test("busca é curta e não aceita gramática de filtro PostgREST", () => {
  assertEquals(normalizeSearch("  Nabota   100 U  "), "Nabota 100 U");
  assertThrows(() => normalizeSearch("nome),clinic_id.eq.outro"));
});

Deno.test("revisão aceita apenas decisão e motivo explícitos", () => {
  assertEquals(reviewDecision("aprovar"), "aprovar");
  assertEquals(reviewDecision("rejeitar"), "rejeitar");
  assertEquals(reviewReason("  Conferido na fonte oficial  "), "Conferido na fonte oficial");
  assertEquals(reviewProofAction("aprovar"), "cotacoes.aprovar_sku_exato");
  assertEquals(reviewProofAction("rejeitar"), "cotacoes.rejeitar_sku_exato");
  assertThrows(() => reviewDecision("vincular"));
  assertThrows(() => reviewReason("x"));
});

Deno.test("somente owner AAL2 resolve o próprio tenant", () => {
  assertEquals(
    tenantClinicId({
      authMethod: "supabase_auth",
      role: "owner",
      userId: USER_ID,
      clinicId: CLINIC_ID,
      displayName: "Owner",
      aal: "aal2",
      sessionId: "33333333-3333-4333-8333-333333333333",
      requestId: "req",
    }),
    CLINIC_ID,
  );
  assertThrows(() =>
    tenantClinicId({
      authMethod: "supabase_auth",
      role: "owner",
      userId: USER_ID,
      clinicId: CLINIC_ID,
      displayName: "Owner",
      aal: "aal1",
      requestId: "req",
    })
  );
});

Deno.test("total da paginação vem do Content-Range", () => {
  assertEquals(totalFromContentRange("0-24/199", 25), 199);
  assertEquals(totalFromContentRange(null, 7), 7);
});

Deno.test("preflight permite Bearer sem cache", async () => {
  const response = await handleRequest(
    new Request("http://localhost/cotacoes", {
      method: "OPTIONS",
      headers: { Origin: "http://127.0.0.1:8765" },
    }),
  );
  assertEquals(response.status, 204);
  assertEquals(response.headers.get("cache-control"), "no-store, max-age=0");
  const allowed = response.headers.get("access-control-allow-headers") || "";
  assertEquals(allowed.includes("authorization"), true);
  assertEquals(allowed.includes("x-amj-reauthentication"), true);
  assertEquals(allowed.includes("x-senha"), false);
});

Deno.test("método de escrita é recusado antes de qualquer acesso ao banco", async () => {
  const response = await handleRequest(
    new Request("http://localhost/cotacoes", {
      method: "PUT",
    }),
  );
  assertEquals(response.status, 405);
});

Deno.test("senha compartilhada sem Bearer não alcança a consulta", async () => {
  const response = await handleRequest(
    new Request("http://localhost/cotacoes", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-senha": "a".repeat(64),
      },
      body: JSON.stringify({ acao: "listar_cotacoes" }),
    }),
  );
  assertEquals(response.status, 401);
  const body = await response.json();
  assertEquals(body.codigo, "authorization_required");
});

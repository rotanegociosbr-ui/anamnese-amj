import {
  clinicDateForInstant,
  clinicTimestampToIso,
  corsOriginAllowed,
  handleRequest,
  normalizeDateRange,
} from "./index.ts";

function equal(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

Deno.test("normaliza período explícito", () => {
  const range = normalizeDateRange({ inicio: "2026-08-01", fim: "2026-08-31" });
  equal(range.start, "2026-08-01", "start");
  equal(range.end, "2026-08-31", "end");
});

Deno.test("rejeita período invertido", () => {
  try {
    normalizeDateRange({ inicio: "2026-08-31", fim: "2026-08-01" });
  } catch (error) {
    equal((error as { code?: string }).code, "invalid_period", "error code");
    return;
  }
  throw new Error("Expected invalid_period");
});

Deno.test("data padrão respeita o dia da clínica, não a virada UTC", () => {
  equal(
    clinicDateForInstant(new Date("2026-09-01T02:30:00.000Z")),
    "2026-08-31",
    "clinic date",
  );
});

Deno.test("datetime-local é interpretado no fuso da clínica", () => {
  equal(
    clinicTimestampToIso("2026-08-23T18:00"),
    "2026-08-23T21:00:00.000Z",
    "clinic timestamp",
  );
  equal(
    clinicTimestampToIso("2026-08-23T21:00:00Z"),
    "2026-08-23T21:00:00.000Z",
    "explicit timestamp",
  );
});

Deno.test("CORS permite somente origens oficiais e desenvolvimento local", () => {
  equal(corsOriginAllowed("https://anamariajacob.com.br"), true, "official origin");
  equal(corsOriginAllowed("http://127.0.0.1:8765"), true, "local origin");
  equal(corsOriginAllowed("https://evil.example"), false, "foreign origin");
  equal(corsOriginAllowed("http://localhost:99999"), false, "invalid port");
});

Deno.test("preflight inclui cabeçalho de reautenticação", async () => {
  const response = await handleRequest(
    new Request("https://edge.test", {
      method: "OPTIONS",
      headers: { Origin: "https://anamariajacob.com.br" },
    }),
  );
  equal(response.status, 204, "status");
  const allowed = response.headers.get("Access-Control-Allow-Headers") || "";
  if (!allowed.includes("x-amj-reauthentication")) {
    throw new Error("Missing reauthentication header");
  }
});

Deno.test("nega POST sem sessão antes de acessar dados", async () => {
  const response = await handleRequest(
    new Request("https://edge.test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ acao: "dashboard" }),
    }),
  );
  equal(response.status, 401, "status");
  const body = await response.json();
  equal(body.codigo, "authorization_required", "error code");
});

Deno.test("nega método não suportado", async () => {
  const response = await handleRequest(new Request("https://edge.test", { method: "GET" }));
  equal(response.status, 405, "status");
  equal(response.headers.get("Allow"), "POST, OPTIONS", "allow header");
});

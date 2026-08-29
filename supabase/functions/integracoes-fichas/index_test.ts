import {
  createHandler,
  type HandlerDependencies,
  IntegrationDisabledError,
  integrationStatusDto,
  NULL_INTEGRATION_ADAPTER,
} from "./index.ts";
import { type DualAuthContext, DualAuthError } from "../_shared/dual-auth.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function equals(actual: unknown, expected: unknown, message = "valores diferentes"): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}: esperado ${JSON.stringify(expected)}, recebido ${JSON.stringify(actual)}`,
    );
  }
}

const CONTEXT: DualAuthContext = {
  authMethod: "supabase_auth",
  role: "owner",
  userId: "22222222-2222-4222-8222-222222222222",
  clinicId: "11111111-1111-4111-8111-111111111111",
  displayName: "Owner",
  aal: "aal2",
  sessionId: "33333333-3333-4333-8333-333333333333",
  requestId: "44444444-4444-4444-8444-444444444444",
};

function baseDependencies(
  transport: HandlerDependencies["transport"],
  authenticate: HandlerDependencies["authenticate"] = () => Promise.resolve(CONTEXT),
): Partial<HandlerDependencies> {
  return {
    transport,
    authenticate,
    environment: () => ({
      supabaseUrl: "https://project.supabase.co",
      serviceRoleKey: "service-role-test-only",
    }),
  };
}

function post(body: unknown): Request {
  return new Request("https://edge.test/integracoes-fichas", {
    method: "POST",
    headers: {
      Origin: "https://anamariajacob.com.br",
      Authorization: "Bearer test",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

Deno.test("catalogo canonico e DTO expõem somente campos sanitizados e desligados", () => {
  const catalog = integrationStatusDto();
  equals(
    catalog.map((item) => item.id),
    [
      "site_futuro",
      "whatsapp_oficial",
      "calendario",
      "pagamentos_online",
      "outras_apis",
    ],
  );
  for (const item of catalog) {
    equals(Object.keys(item), [
      "id",
      "nome",
      "state",
      "enabled",
      "verified",
      "external_calls_allowed",
    ]);
    equals(item.state, "disabled");
    equals(item.enabled, false);
    equals(item.verified, false);
    equals(item.external_calls_allowed, false);
    assert(!JSON.stringify(item).includes("secret"), "DTO nao pode expor segredo");
    assert(!JSON.stringify(item).includes("http"), "DTO nao pode expor endpoint");
  }
});

Deno.test("status autentica owner AAL2 e faz zero chamadas ao transporte", async () => {
  let transportCalls = 0;
  const handler = createHandler(baseDependencies(() => {
    transportCalls++;
    return Promise.reject(new Error("transporte nao deveria ser executado"));
  }));
  const response = await handler(post({ acao: "status" }));
  equals(response.status, 200);
  const body = await response.json();
  equals(body.chamadas_externas, false);
  equals(body.cobranca_automatica, false);
  equals(body.integracoes, integrationStatusDto());
  equals(transportCalls, 0, "status nao pode chamar transporte");
});

Deno.test("adaptador nulo falha tipado antes de chamar o transporte", async () => {
  let transportCalls = 0;
  let caught: unknown = null;
  try {
    await NULL_INTEGRATION_ADAPTER.execute("whatsapp_oficial", () => {
      transportCalls++;
      return Promise.resolve(new Response("nao permitido"));
    });
  } catch (error) {
    caught = error;
  }
  assert(caught instanceof IntegrationDisabledError, "erro deve ser tipado");
  equals(caught.code, "integration_disabled");
  equals(caught.integrationId, "whatsapp_oficial");
  equals(transportCalls, 0, "adaptador nulo nao pode alcancar transporte");
});

Deno.test("somente a acao status e aceita, sem efeitos externos", async () => {
  let transportCalls = 0;
  const handler = createHandler(baseDependencies(() => {
    transportCalls++;
    return Promise.resolve(new Response("nao permitido"));
  }));
  for (
    const request of [
      { acao: "enviar" },
      { acao: "status", provider: "whatsapp_oficial" },
      { acao: "status", enabled: true },
    ]
  ) {
    const response = await handler(post(request));
    equals(response.status, 422);
    equals((await response.json()).codigo, "action_not_allowed");
  }
  equals(transportCalls, 0);
});

Deno.test("autenticacao precede corpo e endpoint recusa contexto sem owner AAL2", async () => {
  let transportCalls = 0;
  const denied = createHandler(baseDependencies(
    () => {
      transportCalls++;
      return Promise.resolve(new Response("nao permitido"));
    },
    () => Promise.reject(new DualAuthError(403, "mfa_required", "MFA obrigatorio.")),
  ));
  const malformed = await denied(
    new Request("https://edge.test/integracoes-fichas", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{json quebrado",
    }),
  );
  equals(malformed.status, 403);
  equals((await malformed.json()).codigo, "mfa_required");

  const professional = createHandler(baseDependencies(
    () => {
      transportCalls++;
      return Promise.resolve(new Response("nao permitido"));
    },
    () => Promise.resolve({ ...CONTEXT, role: "professional" }),
  ));
  const forbidden = await professional(post({ acao: "status" }));
  equals(forbidden.status, 403);
  equals((await forbidden.json()).codigo, "owner_mfa_required");
  equals(transportCalls, 0);
});

Deno.test("CORS e configuracao preservam endpoint privado e sem cache", async () => {
  const handler = createHandler(baseDependencies(() => {
    return Promise.reject(new Error("transporte nao deveria ser executado"));
  }));
  const preflight = await handler(
    new Request("https://edge.test/integracoes-fichas", {
      method: "OPTIONS",
      headers: { Origin: "http://127.0.0.1:8765" },
    }),
  );
  equals(preflight.status, 204);
  equals(preflight.headers.get("cache-control"), "no-store, max-age=0");
  equals(
    preflight.headers.get("access-control-allow-origin"),
    "http://127.0.0.1:8765",
  );
  assert(
    !(preflight.headers.get("access-control-allow-headers") || "").includes("x-senha"),
    "senha compartilhada nao pode ser anunciada",
  );

  const config = await Deno.readTextFile(
    new URL("../../config.toml", import.meta.url),
  );
  assert(config.includes("[functions.integracoes-fichas]"), "funcao ausente do config");
  assert(
    config.includes('entrypoint = "./functions/integracoes-fichas/index.ts"'),
    "entrypoint privado ausente do config",
  );
});

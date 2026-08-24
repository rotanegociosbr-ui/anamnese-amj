import {
  authenticateDual,
  authResponseFields,
  DualAuthConfig,
  DualAuthError,
  writeClinicAudit,
} from "./dual-auth.ts";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const CLINIC_ID = "22222222-2222-4222-8222-222222222222";
const SESSION_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_CLINIC_ID = "44444444-4444-4444-8444-444444444444";
const LEGACY_HASH = "a".repeat(64);
const SUPABASE_URL = "https://project.supabase.co";

function token(aal: "aal1" | "aal2"): string {
  const encode = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/=/g, "").replace(/\+/g, "-").replace(
      /\//g,
      "_",
    );
  return [
    encode({ alg: "RS256", typ: "JWT" }),
    encode({
      sub: USER_ID,
      role: "authenticated",
      aal,
      iss: SUPABASE_URL + "/auth/v1",
      exp: Math.floor(Date.now() / 1000) + 600,
      session_id: SESSION_ID,
    }),
    "mock-signature",
  ].join(".");
}

function config(options: {
  authStatus?: number;
  activeSession?: boolean;
  multipleActiveMemberships?: boolean;
  memberStatus?: "active" | "suspended";
  role?: "owner" | "professional" | "assistant" | "viewer";
} = {}): DualAuthConfig {
  const authStatus = options.authStatus ?? 200;
  const memberStatus = options.memberStatus ?? "active";
  const role = options.role ?? "owner";
  return {
    supabaseUrl: SUPABASE_URL,
    serviceRoleKey: "service-role-test-only",
    allowedRoles: ["owner", "professional", "assistant"],
    fetchImpl: (input) => {
      const url = String(input);
      if (url.endsWith("/auth/v1/user")) {
        return Promise.resolve(
          new Response(
            authStatus === 200
              ? JSON.stringify({ id: USER_ID, is_anonymous: false })
              : "{}",
            {
              status: authStatus,
              headers: { "Content-Type": "application/json" },
            },
          ),
        );
      }
      if (url.includes("/rest/v1/clinic_members?")) {
        const memberships = [{
          clinic_id: CLINIC_ID,
          user_id: USER_ID,
          role,
          status: memberStatus,
          display_name: "Ana Maria",
        }];
        if (options.multipleActiveMemberships) {
          memberships.push({
            clinic_id: OTHER_CLINIC_ID,
            user_id: USER_ID,
            role: "viewer",
            status: "active",
            display_name: "Ana Maria",
          });
        }
        return Promise.resolve(Response.json(memberships));
      }
      if (url.endsWith("/rest/v1/rpc/clinic_validate_auth_session")) {
        return Promise.resolve(Response.json(options.activeSession !== false));
      }
      throw new Error("unexpected mocked URL");
    },
  };
}

async function expectAuthError(
  promise: Promise<unknown>,
  code: string,
): Promise<DualAuthError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DualAuthError && error.code === code) return error;
    throw error;
  }
  throw new Error("Expected DualAuthError: " + code);
}

Deno.test("Bearer inválido nunca cai na senha legada válida", async () => {
  const req = new Request("https://edge.test", {
    headers: {
      Authorization: "Bearer " + token("aal2"),
      "x-senha": LEGACY_HASH,
    },
  });
  const error = await expectAuthError(
    authenticateDual(req, config({ authStatus: 401 })),
    "invalid_token",
  );
  if (error.status !== 401) throw new Error("Expected HTTP 401");
});

Deno.test("sessão aal1 é negada mesmo com membro ativo", async () => {
  const bearer = token("aal1");
  const req = new Request("https://edge.test", {
    headers: { Authorization: "Bearer " + bearer },
  });
  const error = await expectAuthError(
    authenticateDual(req, config()),
    "mfa_required",
  );
  if (error.status !== 403) throw new Error("Expected HTTP 403");
});

Deno.test("sessão removida é negada imediatamente", async () => {
  const req = new Request("https://edge.test", {
    headers: { Authorization: "Bearer " + token("aal2") },
  });
  const error = await expectAuthError(
    authenticateDual(req, config({ activeSession: false })),
    "session_revoked",
  );
  if (error.status !== 401) throw new Error("Expected HTTP 401");
});

Deno.test("membro suspenso é negado", async () => {
  const req = new Request("https://edge.test", {
    headers: { Authorization: "Bearer " + token("aal2") },
  });
  const error = await expectAuthError(
    authenticateDual(req, config({ memberStatus: "suspended" })),
    "membership_inactive",
  );
  if (error.status !== 403) throw new Error("Expected HTTP 403");
});

Deno.test("múltiplas clínicas ativas falham fechado", async () => {
  const req = new Request("https://edge.test", {
    headers: { Authorization: "Bearer " + token("aal2") },
  });
  const error = await expectAuthError(
    authenticateDual(req, config({ multipleActiveMemberships: true })),
    "ambiguous_membership",
  );
  if (error.status !== 403) throw new Error("Expected HTTP 403");
});

Deno.test("owner ativo com aal2 é autorizado", async () => {
  const req = new Request("https://edge.test", {
    headers: { Authorization: "Bearer " + token("aal2") },
  });
  const result = await authenticateDual(req, config());
  if (result.authMethod !== "supabase_auth") {
    throw new Error("Wrong auth method");
  }
  if (result.role !== "owner") throw new Error("Wrong role");
  if (result.clinicId !== CLINIC_ID) throw new Error("Wrong clinic");
  if (result.displayName !== "Ana Maria") throw new Error("Wrong display name");
});

Deno.test("x-senha sozinho é sempre negado sem revelar dados privados", async () => {
  const req = new Request("https://edge.test", {
    headers: { "x-senha": LEGACY_HASH },
  });
  const error = await expectAuthError(
    authenticateDual(req, config()),
    "authorization_required",
  );
  if (error.status !== 401 || error.auditContext !== null) {
    throw new Error("Shared secret must fail closed without PII context");
  }
});

Deno.test("resposta autenticada expõe somente identidade mínima", async () => {
  const req = new Request("https://edge.test", {
    headers: { Authorization: "Bearer " + token("aal2") },
  });
  const result = await authenticateDual(req, config());
  const fields = authResponseFields(result);
  const identity = fields.identity as Record<string, unknown>;
  if (fields.auth_method !== "supabase_auth" || fields.role !== "owner") {
    throw new Error("Missing response auth fields");
  }
  if (
    identity.display_name !== "Ana Maria" || Object.keys(identity).length !== 2
  ) {
    throw new Error("Identity is not minimal");
  }
});

Deno.test("auditoria descarta PHI, IP e chaves não técnicas", async () => {
  const captured: Record<string, unknown>[] = [];
  const auditConfig: DualAuthConfig = {
    ...config(),
    fetchImpl: (_input, init) => {
      captured.push(JSON.parse(String(init?.body || "{}")));
      return Promise.resolve(new Response(null, { status: 201 }));
    },
  };
  const ok = await writeClinicAudit(
    auditConfig,
    {
      authMethod: "supabase_auth",
      role: "owner",
      userId: USER_ID,
      clinicId: CLINIC_ID,
      displayName: "Ana Maria",
      aal: "aal2",
      requestId: crypto.randomUUID(),
    },
    {
      entity: "appointment",
      action: "list",
      outcome: "success",
      details: {
        endpoint: "agenda-fichas",
        reason_code: "ok",
        patient_name: "NÃO DEVE IR",
        ip: "198.51.100.10",
        token: "NÃO DEVE IR",
      },
    },
  );
  if (!ok || captured.length !== 1) {
    throw new Error("Audit write was not captured");
  }
  const details = captured[0].details as Record<string, unknown>;
  if (Object.keys(details).sort().join(",") !== "endpoint,reason_code") {
    throw new Error("Unsafe audit details were retained");
  }
});

import { LegacyClinicalScopeError, requireLegacyClinicalScope, signedLinks } from "./index.ts";
import type { LegacyClinicalScope } from "./index.ts";

const CLINIC_ID = "11111111-1111-4111-8111-111111111111";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function equal(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

async function assertScopeDenied(run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch (error) {
    assert(error instanceof LegacyClinicalScopeError, "erro deve ser fail-closed");
    equal(error.code, "legacy_clinical_scope_unavailable", "codigo");
    equal(error.status, 503, "status");
    return;
  }
  throw new Error("escopo ambiguo foi aceito");
}

Deno.test("singleton da clinica autenticada libera a fonte legada e a assinatura", async () => {
  let validationCalls = 0;
  const scope = await requireLegacyClinicalScope(CLINIC_ID, (path, init) => {
    validationCalls++;
    equal(path, "/rest/v1/rpc/painel_validar_escopo_clinico_legado", "RPC de escopo");
    equal(init?.method, "POST", "metodo da validacao");
    equal(
      (JSON.parse(String(init?.body)) as { p_clinic_id?: string }).p_clinic_id,
      CLINIC_ID,
      "tenant enviado",
    );
    return Promise.resolve(
      new Response("true", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  });
  equal(validationCalls, 1, "quantidade de validacoes");
  equal(scope.clinicId, CLINIC_ID, "tenant validado");

  let signingCalls = 0;
  const links = await signedLinks(
    scope,
    "fichas-pdf",
    ["ficha.pdf"],
    (path, init) => {
      signingCalls++;
      equal(path, "/storage/v1/object/sign/fichas-pdf", "rota de assinatura");
      const body = JSON.parse(String(init?.body)) as { expiresIn?: number; paths?: string[] };
      equal(body.expiresIn, 900, "validade da assinatura");
      equal(body.paths?.[0], "ficha.pdf", "arquivo assinado");
      return Promise.resolve(
        new Response(
          JSON.stringify([{
            path: "ficha.pdf",
            signedURL: "/object/sign/fichas-pdf/ficha.pdf?token=teste",
          }]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    },
  );
  equal(signingCalls, 1, "quantidade de assinaturas");
  assert(
    links["ficha.pdf"].endsWith("/object/sign/fichas-pdf/ficha.pdf?token=teste"),
    "link assinado ausente",
  );
});

Deno.test("zero ou multiplas clinicas fecham antes de qualquer assinatura", async () => {
  for (const responseBody of [false, null, { permitido: true }]) {
    await assertScopeDenied(() =>
      requireLegacyClinicalScope(
        CLINIC_ID,
        () =>
          Promise.resolve(
            new Response(JSON.stringify(responseBody), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
          ),
      )
    );
  }

  let signingCalls = 0;
  await assertScopeDenied(() =>
    signedLinks(
      { clinicId: CLINIC_ID } as LegacyClinicalScope,
      "documentos-clinicos",
      ["documento.pdf"],
      () => {
        signingCalls++;
        return Promise.resolve(new Response("[]", { status: 200 }));
      },
    )
  );
  equal(signingCalls, 0, "assinatura sem comprovante de escopo");
});

Deno.test("falha ou resposta invalida da validacao tambem fecha por padrao", async () => {
  await assertScopeDenied(() =>
    requireLegacyClinicalScope(
      CLINIC_ID,
      () => Promise.resolve(new Response("erro", { status: 500 })),
    )
  );
  await assertScopeDenied(() =>
    requireLegacyClinicalScope(
      CLINIC_ID,
      () => Promise.resolve(new Response("nao-json", { status: 200 })),
    )
  );
  await assertScopeDenied(() =>
    requireLegacyClinicalScope(
      CLINIC_ID,
      () => Promise.reject(new Error("offline")),
    )
  );
});

Deno.test("listagem e arquivamento validam tenant antes dos sinks globais", async () => {
  const source = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  const archiveStart = source.indexOf(
    'if (action === "arquivar" || action === "restaurar")',
  );
  const archiveGate = source.indexOf(
    "requireLegacyClinicalScope(authContext.clinicId)",
    archiveStart,
  );
  const recentProof = source.indexOf("requireRecentPasswordProof", archiveGate);
  const archiveRpc = source.indexOf('"/rest/v1/rpc/painel_arquivar_ficha"', archiveGate);
  assert(
    archiveStart >= 0 && archiveGate > archiveStart && recentProof > archiveGate &&
      archiveRpc > recentProof,
    "arquivamento deve validar tenant antes da prova e da mutacao",
  );

  const invalidAction = source.indexOf('if (action && action !== "listar")');
  const listGate = source.indexOf(
    "requireLegacyClinicalScope(authContext.clinicId)",
    invalidAction,
  );
  const legacyRead = source.indexOf('"/rest/v1/anamneses_resumo?select=*"', listGate);
  assert(
    invalidAction >= 0 && listGate > invalidAction && legacyRead > listGate,
    "listagem deve validar tenant antes da primeira leitura global",
  );
  assert(
    source.includes("p_clinic_id: legacyScope.clinicId"),
    "RPC de arquivamento deve receber o tenant validado",
  );
});

Deno.test("migration protege as duas assinaturas da RPC e mantem Edge-only", async () => {
  const migration = await Deno.readTextFile(
    new URL(
      "../../migrations/20260824140000_painel_fichas_escopo_clinico_legado.sql",
      import.meta.url,
    ),
  );
  assert(
    migration.includes("(select pg_catalog.count(*) from public.clinics) = 1"),
    "predicate singleton ausente",
  );
  assert(
    migration.includes(
      "create unique index painel_fichas_legado_clinica_unica_guard\n  on public.clinics ((true));",
    ),
    "guard concorrente de clinica unica ausente",
  );
  assert(
    migration.includes("Remover este indice somente depois de adicionar"),
    "instrucao de remocao apos tenantizacao ausente",
  );
  assert(
    migration.includes("where clinic.id = p_clinic_id"),
    "predicate do tenant autenticado ausente",
  );

  const tenantAware = migration.indexOf(
    "create or replace function public.painel_arquivar_ficha(\n  p_clinic_id uuid",
  );
  const tenantGate = migration.indexOf(
    "if not private.painel_escopo_clinico_legado_valido(p_clinic_id)",
    tenantAware,
  );
  const firstClinicalRead = migration.indexOf("from public.anamneses as ficha", tenantAware);
  assert(
    tenantAware >= 0 && tenantGate > tenantAware && firstClinicalRead > tenantGate,
    "overload tenant-aware nao fecha antes de consultar a ficha",
  );

  const legacyOverload = migration.indexOf(
    "create or replace function public.painel_arquivar_ficha(\n  p_origem text",
    tenantAware + 1,
  );
  const legacyGate = migration.indexOf(
    "if not private.painel_escopo_clinico_legado_valido(v_clinic_id)",
    legacyOverload,
  );
  const delegatedCall = migration.indexOf(
    "return public.painel_arquivar_ficha(",
    legacyOverload,
  );
  assert(
    legacyOverload > tenantAware && legacyGate > legacyOverload && delegatedCall > legacyGate,
    "overload compativel nao fecha antes de delegar",
  );
  assert(
    !/grant execute[\s\S]*?to (?:anon|authenticated)/.test(migration),
    "RPC clinica nao pode ser executada pelo navegador",
  );
  assert(
    migration.includes(
      "grant execute on function public.painel_arquivar_ficha(uuid, text, uuid, text, text)\n  to service_role;",
    ),
    "grant Edge-only do overload tenant-aware ausente",
  );
});

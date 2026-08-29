import assert from "node:assert/strict";
import test from "node:test";
import {
  IntegrationDisabledError,
  integrationStatusDto,
  NULL_INTEGRATION_ADAPTER,
} from "./logic.ts";

test("catalogo fica integralmente desativado e o DTO usa allowlist", () => {
  const catalog = integrationStatusDto();
  assert.deepEqual(catalog.map((item) => item.id), [
    "site_futuro",
    "whatsapp_oficial",
    "calendario",
    "pagamentos_online",
    "outras_apis",
  ]);
  for (const item of catalog) {
    assert.deepEqual(Object.keys(item), [
      "id",
      "nome",
      "state",
      "enabled",
      "verified",
      "external_calls_allowed",
    ]);
    assert.equal(item.state, "disabled");
    assert.equal(item.enabled, false);
    assert.equal(item.verified, false);
    assert.equal(item.external_calls_allowed, false);
  }
});

test("adaptador nulo falha tipado com zero chamadas ao transporte", async () => {
  let transportCalls = 0;
  await assert.rejects(
    NULL_INTEGRATION_ADAPTER.execute("whatsapp_oficial", () => {
      transportCalls++;
      return Promise.resolve(new Response("nao permitido"));
    }),
    (error) => {
      assert.ok(error instanceof IntegrationDisabledError);
      assert.equal(error.code, "integration_disabled");
      assert.equal(error.integrationId, "whatsapp_oficial");
      return true;
    },
  );
  assert.equal(transportCalls, 0);
});

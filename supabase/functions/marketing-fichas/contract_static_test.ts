function assertEquals(actual: unknown, expected: unknown): void {
  if (actual !== expected) throw new Error(`Esperado ${expected}; recebido ${actual}`);
}
function assertStringIncludes(actual: string, expected: string): void {
  if (!actual.includes(expected)) throw new Error(`Contrato ausente: ${expected}`);
}

const source = await Deno.readTextFile(new URL("./index.ts", import.meta.url));

Deno.test("leituras não exigem idempotency_key", () => {
  const prefix = source.slice(0, source.indexOf('case "salvar_campanha"'));
  assertEquals(prefix.includes("mutationBase(p, c)"), false);
});

Deno.test("contrato proíbe automação externa", () => {
  assertStringIncludes(source, "mensagens_automaticas: false");
  assertStringIncludes(source, "publicacao_automatica: false");
});

Deno.test("operações destrutivas exigem prova recente", () => {
  for (
    const action of [
      "arquivar_campanha",
      "vincular_lancamento",
      "cancelar_vinculo",
      "cancelar_indicacao",
      "arquivar_conteudo",
    ]
  ) assertStringIncludes(source, `"${action}"`);
  assertStringIncludes(source, "requireRecentPasswordProof");
  assertStringIncludes(source, "x-amj-reauthentication");
});

Deno.test("endpoint de lançamentos disponíveis integra o contrato", () => {
  assertStringIncludes(source, 'case "listar_lancamentos_disponiveis"');
  assertStringIncludes(source, "leads_elegiveis");
  assertStringIncludes(source, "has_more");
});

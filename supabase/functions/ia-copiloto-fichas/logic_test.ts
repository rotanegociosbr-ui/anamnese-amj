import {
  assertAggregateModelSafe,
  buildOpenAIRequest,
  canonicalJson,
  ContractError,
  DEFAULT_OPENAI_MODEL,
  extractAggregateModel,
  HUMAN_REVIEW_NOTICE,
  MAX_OUTPUT_TOKENS,
  parseCopilotRequest,
  requestFingerprint,
  safetyIdentifier,
  sanitizeAnalysis,
  sha256Hex,
  useCaseForQuestion,
} from "./logic.ts";

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

function expectCode(callback: () => unknown, code: string): void {
  try {
    callback();
  } catch (error) {
    if (error instanceof ContractError && error.code === code) return;
    throw error;
  }
  throw new Error(`Era esperado ContractError ${code}.`);
}

const CLINIC_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";
const IDEMPOTENCY = "33333333-3333-4333-8333-333333333333";

const SAFE_AGGREGATE = {
  periodo: { inicio: "2026-08-01", fim: "2026-08-29" },
  crm: { leads_abertos: 12, taxa_conversao: 0.25 },
  agenda: { atendimentos: 18, retornos_pendentes: 3 },
  financeiro: { entradas_centavos: 250000, saidas_centavos: 100000 },
  marketing: { alcance_total: 5000, variacao_percentual: -4.2 },
};

const SAFE_ANALYSIS = {
  titulo: "Revisao agregada do periodo",
  resumo: "Os indicadores pedem verificacao comercial e financeira.",
  prioridades: [{
    categoria: "comercial",
    titulo: "Revisar conversao agregada",
    justificativa: "A taxa agregada variou no periodo selecionado.",
    proxima_verificacao: "Comparar os totais com o periodo anterior.",
  }],
  previsao: {
    leitura: "A leitura de caixa permanece positiva nos agregados informados.",
    horizonte: "Proximos 30 dias",
    confiabilidade: "media",
    limitacoes: ["Nao ha serie historica diaria completa."],
  },
  limitacoes: ["Analise restrita aos totais fornecidos."],
  aviso: HUMAN_REVIEW_NOTICE,
};

Deno.test("contrato aceita somente as tres formas fechadas", () => {
  equals(
    parseCopilotRequest({
      acao: "painel",
      inicio: "2026-08-01",
      fim: "2026-08-29",
      foco: "geral",
    }),
    {
      acao: "painel",
      inicio: "2026-08-01",
      fim: "2026-08-29",
      foco: "geral",
    },
  );
  equals(
    parseCopilotRequest({
      acao: "analisar",
      inicio: "2026-08-01",
      fim: "2026-08-29",
      foco: "crm",
      pergunta_chave: "leads_prioritarios",
      idempotency_key: IDEMPOTENCY,
    }).acao,
    "analisar",
  );
  const feedback = parseCopilotRequest({
    acao: "feedback",
    operation_id: IDEMPOTENCY,
    idempotency_key: CLINIC_ID,
    avaliacao: "nao_util",
  });
  assert(feedback.acao === "feedback", "acao de feedback esperada");
  equals(feedback.avaliacao, "nao_util");
});

Deno.test("contrato recusa prompt, model, tools, store e texto livre", () => {
  for (const extra of ["prompt", "model", "tools", "store", "texto", "instructions"]) {
    expectCode(() =>
      parseCopilotRequest({
        acao: "painel",
        inicio: "2026-08-01",
        fim: "2026-08-29",
        foco: "geral",
        [extra]: "nao permitido",
      }), "invalid_contract");
  }
  expectCode(() =>
    parseCopilotRequest({
      acao: "analisar",
      inicio: "2026-08-01",
      fim: "2026-08-29",
      foco: "geral",
      pergunta_chave: "pergunta livre",
      idempotency_key: IDEMPOTENCY,
    }), "invalid_pergunta_chave");
});

Deno.test("cada pergunta aceita somente o menor foco necessario", () => {
  const common = {
    acao: "analisar",
    inicio: "2026-08-01",
    fim: "2026-08-29",
    idempotency_key: IDEMPOTENCY,
  };
  const pairs = [
    ["atencao_hoje", "geral"],
    ["leads_prioritarios", "crm"],
    ["mudancas_marketing", "marketing"],
    ["previsao_caixa", "financeiro"],
  ] as const;
  for (const [pergunta_chave, foco] of pairs) {
    const parsed = parseCopilotRequest({ ...common, pergunta_chave, foco });
    assert(parsed.acao === "analisar", "analise esperada");
    equals(parsed.foco, foco);
  }
  expectCode(
    () =>
      parseCopilotRequest({ ...common, pergunta_chave: "leads_prioritarios", foco: "financeiro" }),
    "invalid_focus_for_question",
  );
});

Deno.test("datas sao reais, ordenadas e limitadas a 366 dias inclusivos", () => {
  expectCode(() =>
    parseCopilotRequest({
      acao: "painel",
      inicio: "2026-02-30",
      fim: "2026-03-01",
      foco: "geral",
    }), "invalid_inicio");
  expectCode(() =>
    parseCopilotRequest({
      acao: "painel",
      inicio: "2026-09-01",
      fim: "2026-08-01",
      foco: "geral",
    }), "invalid_period");
  expectCode(() =>
    parseCopilotRequest({
      acao: "painel",
      inicio: "2025-08-28",
      fim: "2026-08-29",
      foco: "geral",
    }), "invalid_period");
});

Deno.test("DLP aceita apenas modelo agregado curto e finito", () => {
  assertAggregateModelSafe(SAFE_AGGREGATE);
  equals(
    extractAggregateModel({
      painel_privado: { acoes: [{ rota: "crm" }] },
      modelo_agregado: SAFE_AGGREGATE,
    }),
    SAFE_AGGREGATE,
  );
});

Deno.test("DLP aceita o formato agregado produzido pela RPC SQL", () => {
  assertAggregateModelSafe({
    schema_version: "ia-contexto-v1",
    nba: {
      leads_sem_primeira_resposta: { valor: 12, suprimido: false },
      agenda: { disponivel: false, codigo_motivo: "tenant_scope_unavailable" },
    },
    financeiro: {
      receita_recebida: 150000,
      despesa_paga: 45000,
      fluxo_liquido: 105000,
    },
    marketing: {
      investimento_pago: 1500,
      leads: { valor: null, suprimido: true },
      conversoes: { valor: 8, suprimido: false },
    },
    acompanhamentos: {
      totais: { atendimentos: { valor: 20, suprimido: false } },
      agregado_somente: true,
    },
    series: {
      fluxo_mensal: [{
        mes: "2026-08-01",
        receita_faturada: 120000,
        despesa_incorrida: 30000,
      }],
    },
    previsao: {
      rotulo: "estimativa",
      valor_estimado: 105000,
      horizonte_dias: 30,
      limitacoes: ["Media mensal pre-calculada."],
    },
    restricoes: {
      dados_minimizados: true,
      somente_agregados: true,
      sem_midia: true,
      sem_texto_livre: true,
      sem_acao_automatica: true,
    },
  });
});

Deno.test("DLP bloqueia chaves de identidade, notas, clinico e fotos", () => {
  for (
    const key of [
      "nome",
      "lead_id",
      "patient_uuid",
      "observacoes",
      "notas_internas",
      "dados_clinicos",
      "dadosClinicos",
      "patientUuid",
      "patientuuid",
      "fotos",
      "fotoUrl",
      "pdf_path",
      "telefone",
    ]
  ) {
    expectCode(
      () => assertAggregateModelSafe({ total: 1, [key]: "segredo" }),
      "unsafe_aggregate_context",
    );
  }
});

Deno.test("DLP bloqueia UUID, email, telefone, CPF, URL e hash longo nos valores", () => {
  for (
    const value of [
      CLINIC_ID,
      "pessoa@example.com",
      "+55 (11) 99999-9999",
      "123.456.789-09",
      "https://example.com/privado",
      "mailto:pessoa@example.com",
      "a".repeat(32),
    ]
  ) {
    expectCode(
      () => assertAggregateModelSafe({ descricao_agregada: value }),
      "unsafe_aggregate_context",
    );
  }
});

Deno.test("corpo OpenAI e stateless, sem painel privado e limitado", () => {
  const body = buildOpenAIRequest(
    DEFAULT_OPENAI_MODEL,
    SAFE_AGGREGATE,
    "atencao_hoje",
    "amj_abcdefghijklmnopqrstuvwxyz0123456789ABCDE",
  );
  equals(body.store, false);
  equals(body.background, false);
  equals(body.tools, []);
  equals(body.max_output_tokens, MAX_OUTPUT_TOKENS);
  equals(body.text.format.type, "json_schema");
  equals(body.text.format.strict, true);
  equals(JSON.parse(body.input), SAFE_AGGREGATE);
  assert(!body.input.includes("painel_privado"), "painel_privado nao pode chegar a OpenAI");
  assert(!Object.hasOwn(body, "previous_response_id"), "nao deve manter estado");
  assert(!Object.hasOwn(body, "metadata"), "nao deve enviar metadata");
});

Deno.test("saida estrita e sanitizada exige aviso humano constante", () => {
  equals(sanitizeAnalysis(SAFE_ANALYSIS), SAFE_ANALYSIS);
  expectCode(
    () => sanitizeAnalysis({ ...SAFE_ANALYSIS, aviso: "confie automaticamente" }),
    "invalid_ai_output",
  );
  expectCode(() => sanitizeAnalysis({ ...SAFE_ANALYSIS, extra: true }), "invalid_ai_output");
  expectCode(
    () => sanitizeAnalysis({ ...SAFE_ANALYSIS, resumo: "Veja https://example.com" }),
    "unsafe_ai_output",
  );
  expectCode(() =>
    sanitizeAnalysis({
      ...SAFE_ANALYSIS,
      prioridades: [...SAFE_ANALYSIS.prioridades, ...Array(8).fill(SAFE_ANALYSIS.prioridades[0])],
    }), "invalid_ai_output");
});

Deno.test("hashes sao estaveis e nao expõem ids brutos", async () => {
  const first = await safetyIdentifier(CLINIC_ID, USER_ID);
  const second = await safetyIdentifier(CLINIC_ID, USER_ID);
  equals(first, second);
  assert(first.startsWith("amj_") && first.length < 64, "safety_identifier deve ser opaco e curto");
  assert(!first.includes(CLINIC_ID.slice(0, 8)), "nao pode conter id bruto");
  equals(await sha256Hex("teste"), await sha256Hex("teste"));
  equals(canonicalJson({ b: 2, a: 1 }), '{"a":1,"b":2}');
});

Deno.test("fingerprint ignora idempotencia mas vincula seletor e tenant", async () => {
  const request = parseCopilotRequest({
    acao: "analisar",
    inicio: "2026-08-01",
    fim: "2026-08-29",
    foco: "financeiro",
    pergunta_chave: "previsao_caixa",
    idempotency_key: IDEMPOTENCY,
  });
  if (request.acao !== "analisar") throw new Error("contrato inesperado");
  const first = await requestFingerprint(CLINIC_ID, USER_ID, request);
  const second = await requestFingerprint(CLINIC_ID, USER_ID, {
    ...request,
    idempotency_key: "44444444-4444-4444-8444-444444444444",
  });
  equals(first, second);
  assert(/^[0-9a-f]{64}$/.test(first.fingerprint), "fingerprint SHA-256 esperado");
  equals(useCaseForQuestion("previsao_caixa"), "previsao");
  equals(useCaseForQuestion("mudancas_marketing"), "rascunho_marketing");
});

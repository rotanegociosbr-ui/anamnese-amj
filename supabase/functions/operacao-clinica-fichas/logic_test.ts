import {
  containsMessagingInstruction,
  contributionMargin,
  isOperationalPurpose,
  requiresRecentProof,
  returnScheduleIsValid,
} from "./logic.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("nao aceita instrucao de envio nem aninhada", () => {
  assert(containsMessagingInstruction({ mensagem: "ola" }), "mensagem deveria ser bloqueada");
  assert(containsMessagingInstruction({ dados: { send: true } }), "send deveria ser bloqueado");
  assert(
    !containsMessagingInstruction({ template_referencia: "retorno-v1" }),
    "referencia e permitida",
  );
});

Deno.test("preferencia operacional nao mistura marketing", () => {
  assert(isOperationalPurpose("retorno"), "retorno deve ser operacional");
  assert(isOperationalPurpose("agenda"), "agenda deve ser operacional");
  assert(!isOperationalPurpose("marketing"), "marketing pertence a outro fluxo");
});

Deno.test("edicao e operacoes criticas exigem prova recente", () => {
  assert(!requiresRecentProof("salvar_atendimento", {}), "criacao inicial usa AAL2");
  assert(
    requiresRecentProof("salvar_atendimento", { atendimento_id: "x" }),
    "edicao deve exigir prova",
  );
  assert(requiresRecentProof("registrar_evento_consumo", {}), "estoque deve exigir prova");
  assert(requiresRecentProof("registrar_tentativa_retorno", {}), "contato deve exigir prova");
  assert(
    requiresRecentProof("salvar_procedimento_atendimento", {}),
    "inclusao ou correcao de procedimento deve exigir prova",
  );
  assert(
    requiresRecentProof("atualizar_foto_atendimento", {}),
    "edição da galeria deve exigir prova",
  );
  assert(
    requiresRecentProof("vincular_fotos_atendimento", {}),
    "lote da galeria deve exigir prova",
  );
});

Deno.test("agenda de retorno aceita data exata ou janela, nunca ambas", () => {
  assert(returnScheduleIsValid("2026-09-01", null, null), "data exata valida");
  assert(returnScheduleIsValid(null, "2026-09-01", "2026-09-10"), "janela valida");
  assert(!returnScheduleIsValid("2026-09-01", "2026-09-01", "2026-09-10"), "formas misturadas");
  assert(!returnScheduleIsValid(null, "2026-09-01", null), "janela incompleta");
});

Deno.test("margem gerencial fica nula se alguma fonte estiver incompleta", () => {
  assert(contributionMargin(1200, 400, 30, false) === 770, "margem completa incorreta");
  assert(contributionMargin(1200, 400, 30, true) === null, "dado incompleto nao pode calcular");
  assert(contributionMargin(null, 400, 30, false) === null, "receita ausente nao pode calcular");
});

export type JsonRecord = Record<string, unknown>;

const MESSAGE_KEYS = new Set([
  "mensagem",
  "message",
  "texto_mensagem",
  "message_body",
  "body",
  "conteudo",
  "content",
  "enviar",
  "send",
  "destinatario",
  "recipient",
]);

export const PROTECTED_ACTIONS = new Set([
  "arquivar_atendimento",
  "restaurar_atendimento",
  "salvar_procedimento_atendimento",
  "arquivar_procedimento_atendimento",
  "restaurar_procedimento_atendimento",
  "registrar_perfil_paciente",
  "registrar_preferencia_contato",
  "criar_retorno",
  "atualizar_retorno",
  "registrar_tentativa_retorno",
  "vincular_retorno_agendamento",
  "registrar_ficha_custo",
  "registrar_evento_consumo",
  "registrar_taxa_pagamento",
  "atualizar_foto_atendimento",
  "vincular_fotos_atendimento",
]);

export function containsMessagingInstruction(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(containsMessagingInstruction);
  for (const [key, nested] of Object.entries(value as JsonRecord)) {
    if (MESSAGE_KEYS.has(key.toLowerCase())) return true;
    if (containsMessagingInstruction(nested)) return true;
  }
  return false;
}

export function requiresRecentProof(action: string, payload: JsonRecord): boolean {
  if (action === "salvar_atendimento") {
    return typeof payload.atendimento_id === "string" && payload.atendimento_id.length > 0;
  }
  return PROTECTED_ACTIONS.has(action);
}

export function isOperationalPurpose(value: unknown): value is "retorno" | "agenda" {
  return value === "retorno" || value === "agenda";
}

export function returnScheduleIsValid(
  exactDate: unknown,
  windowStart: unknown,
  windowEnd: unknown,
): boolean {
  const exact = typeof exactDate === "string" && exactDate.length > 0;
  const start = typeof windowStart === "string" && windowStart.length > 0;
  const end = typeof windowEnd === "string" && windowEnd.length > 0;
  return (exact && !start && !end) || (!exact && start && end);
}

export function contributionMargin(
  revenue: number | null,
  materialCost: number | null,
  feeAmount: number | null,
  incomplete: boolean,
): number | null {
  if (incomplete || revenue === null || materialCost === null || feeAmount === null) return null;
  return Math.round((revenue - materialCost - feeAmount + Number.EPSILON) * 1_000_000) / 1_000_000;
}

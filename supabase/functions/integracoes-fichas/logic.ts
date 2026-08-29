export type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export type IntegrationId =
  | "site_futuro"
  | "whatsapp_oficial"
  | "calendario"
  | "pagamentos_online"
  | "outras_apis";

export interface IntegrationStatusDto {
  id: IntegrationId;
  nome: string;
  state: "disabled";
  enabled: false;
  verified: false;
  external_calls_allowed: false;
}

export class IntegrationDisabledError extends Error {
  readonly status = 409;
  readonly code = "integration_disabled";
  readonly publicMessage = "A integracao esta desativada e nao pode realizar chamadas externas.";
  readonly integrationId: IntegrationId;

  constructor(integrationId: IntegrationId) {
    super("Integration disabled: " + integrationId);
    this.name = "IntegrationDisabledError";
    this.integrationId = integrationId;
  }
}

export interface IntegrationAdapter {
  execute(integrationId: IntegrationId, transport: FetchLike): Promise<never>;
}

/**
 * Adaptador deliberadamente nulo da Fase 5A.
 *
 * Ele falha antes de consultar o transporte, mesmo se um chamador futuro
 * fornecer uma implementacao de rede valida. Credenciais, endpoints e payloads
 * de provedores nao fazem parte deste modulo.
 */
export const NULL_INTEGRATION_ADAPTER: IntegrationAdapter = Object.freeze({
  execute(
    integrationId: IntegrationId,
    _transport: FetchLike,
  ): Promise<never> {
    return Promise.reject(new IntegrationDisabledError(integrationId));
  },
});

const CANONICAL_INTEGRATIONS: ReadonlyArray<
  Readonly<{ id: IntegrationId; nome: string }>
> = Object.freeze([
  Object.freeze({ id: "site_futuro", nome: "Site futuro" }),
  Object.freeze({ id: "whatsapp_oficial", nome: "WhatsApp oficial" }),
  Object.freeze({ id: "calendario", nome: "Calendario" }),
  Object.freeze({ id: "pagamentos_online", nome: "Pagamentos online" }),
  Object.freeze({ id: "outras_apis", nome: "Outras APIs" }),
]);

export function integrationStatusDto(): IntegrationStatusDto[] {
  // DTO construido por allowlist. Nenhum endpoint, segredo, identificador de
  // paciente ou configuracao interna pode atravessar esta fronteira.
  return CANONICAL_INTEGRATIONS.map((integration) => ({
    id: integration.id,
    nome: integration.nome,
    state: "disabled",
    enabled: false,
    verified: false,
    external_calls_allowed: false,
  }));
}

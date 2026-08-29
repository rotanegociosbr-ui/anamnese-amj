# Fase 5B — captação segura de pedidos de agendamento

## Escopo

O formulário público registra um **pedido de contato**, não um horário confirmado. Ele não chama
WhatsApp Business API, calendário, pagamento, OpenAI ou qualquer outro serviço pago. O WhatsApp
continua sendo aberto manualmente pela pessoa após o salvamento técnico.

O fluxo é:

1. `agendamento-submit` valida e recebe o formulário público.
2. `crm_site_booking_receive` grava somente na caixa privada
   `private.crm_site_booking_requests`.
3. Um owner com sessão ativa e AAL2 visualiza a caixa pelo `crm-fichas`.
4. Ao aceitar, a RPC usa a identidade real desse owner para criar o lead ou registrar uma interação.
5. Ao arquivar, o `crm-fichas` também exige prova recente de senha e motivo.

Nenhum envio público grava diretamente em `public.crm_leads`.

## Contrato público

Endpoint: `POST /functions/v1/agendamento-submit`

Origens de produção permitidas:

- `https://anamariajacob.com.br`
- `https://www.anamariajacob.com.br`

Os endereços `http://127.0.0.1:8765` e `http://localhost:8765` só são aceitos quando
`ALLOW_LOCAL_ORIGINS=true`; o padrão de produção é `false`.

Corpo JSON permitido, sem campos extras:

```json
{
  "idempotency_key": "UUID",
  "started_at": "ISO-8601",
  "website": "",
  "nome": "Nome completo",
  "telefone": "31999999999",
  "primeira_visita": "primeira_avaliacao",
  "interesse": "toxina_botulinica",
  "data_preferida": "2026-09-10",
  "periodo": "manha",
  "consentimento_contato": true
}
```

Limites principais:

- corpo máximo de 8 KB;
- `website` é honeypot e deve permanecer vazio;
- preenchimento entre 3 segundos e 12 horas;
- data entre hoje e 180 dias;
- telefone brasileiro normalizado para E.164;
- três limites atômicos e fail-closed: origem de rede antes do corpo; HMAC do telefone e teto
  global da clínica somente depois da validação e do honeypot;
- UUID de idempotência e fingerprints SHA-256;
- deduplicação pendente por nome normalizado + telefone + data + período + interesse.

O campo livre `objetivo` não pertence à allowlist, não é enviado à RPC e não existe na tabela. Ele
pode continuar apenas na mensagem manual preparada para o WhatsApp.

Resposta de sucesso, inclusive replay/deduplicação:

```json
{
  "ok": true,
  "recebido": true
}
```

Status HTTP: `202`. A resposta não revela identificador interno, correspondência ou existência no CRM.

## Contrato privado do CRM

O retorno de `listar`/`listar_leads` inclui:

- `solicitacoes_site`: pedidos pendentes;
- `resumo.solicitacoes_site_pendentes`: total pendente.

Ações adicionais do `crm-fichas`:

- `listar_solicitacoes_site` — filtros `status`, `limit` e `offset`;
- `aceitar_solicitacao_site` — `solicitacao_id`, `expected_version` e `idempotency_key`;
- `arquivar_solicitacao_site` — os mesmos campos, mais `motivo`, `operation_id` e prova recente de senha.

No aceite:

- um único lead ativo com telefone e nome normalizado iguais recebe interação;
- nenhum lead ativo com o telefone cria um lead via `marketing_crm_salvar_lead`;
- telefone igual com nome diferente, ou múltiplos candidatos, retorna revisão obrigatória e não mescla;
- a próxima ação é `agendar_avaliacao`, pois o pedido ainda não confirma horário.

## Configuração

Variáveis já usadas pelo projeto:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `CLINIC_ID` — override opcional. Por padrão, a Edge usa o UUID não secreto da clínica deste
  projeto single-clinic, validado antes da publicação.
- `ALLOW_LOCAL_ORIGINS` — opcional; somente `true` habilita os dois endereços locais de teste.

Em `supabase/config.toml`, somente `agendamento-submit` usa `verify_jwt=false` por ser formulário
público. A RPC pública tem `EXECUTE` concedido apenas a `service_role`; tabelas privadas não possuem
privilégio para `anon` ou `authenticated`.

## Publicação realizada

Em 29/08/2026 foram aplicadas as migrations da caixa privada e dos índices de apoio. Também foram
publicadas `agendamento-submit` v2, `crm-fichas` v4 e `integracoes-fichas` v2. O smoke SQL, os
contratos locais, CORS, métodos inválidos e a recusa de acesso sem sessão foram verificados sem
criar cadastro fictício de paciente.

A publicação não ativou nem alterou WhatsApp oficial, calendário, pagamento, OpenAI ou outro
provedor externo. A identificação padrão da clínica é interna ao projeto single-clinic; `CLINIC_ID`
permanece apenas como override opcional.

Não há exclusão automática sem uma política de retenção aprovada pela clínica. Cada pedido recebe
`retention_review_at` para revisão em 90 dias; esse marco não apaga nem arquiva dados sozinho.

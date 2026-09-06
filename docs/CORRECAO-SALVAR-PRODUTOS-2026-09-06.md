# Correção do salvamento de produtos na consulta

6 de setembro de 2026 — correção posterior à entrega de sessão administrativa.

## Erro e causa

Relato: “Atualize a tela e tente novamente” ao salvar produtos em Pacientes e
consultas. A auditoria técnica registrou `operation_id_required`, na API de
prontuários, às 21:52:46 UTC. Não foi necessário ler prontuários ou nomes.

Foi reproduzida uma incompatibilidade de contrato: o formulário anterior enviava
`idempotency_key` válida e, na criação, `clinical_photography:false`, mas não
`operation_id`. O serviço novo exigia esse segundo identificador na edição e
na criação com o campo de consentimento presente. A origem exata da versão da
tela usada pela paciente/profissional não foi inspecionada; cache não é uma
conclusão comprovada. A incompatibilidade e os dois payloads rejeitados foram
reproduzidos pelo handler real antes da correção.

## Correção

Prontuario-fichas v9 reutiliza a chave de idempotência já validada como ID da
operação somente quando esse campo está ausente. Não é uma credencial: owner,
MFA, sessão válida, clínica, paciente e versão seguem sendo verificados.
Valores explicitamente inválidos, vazios ou nulos continuam recusados.
O campo de consentimento não é removido nem inventado. Nenhuma migração foi
necessária. Nenhum produto, foto ou cadastro real foi modificado por este teste.

O ajuste é no serviço: a pessoa pode tentar salvar novamente o mesmo formulário,
sem cadastrar outra paciente/consulta por causa desse erro. Não há garantia de
que qualquer outro erro seja resolvido por esta correção específica.

## Verificação

- 9 testes novos de regressão executam o listener real da API com transportes
  sintéticos: formato legado completo, edição, ausência e má-formação de ID,
  sessão/MFA/revogação, conflito de versão e repetição sem segunda gravação.
- Suíte completa da interface: 150/150 testes, 37 arquivos, 15,181 segundos;
  zero falhas, cancelamentos ou casos ignorados.
- Teste da API administrativa e envio real do JavaScript atual confirma UUID,
  versão, produto, lote e validade. Dados digitados são preservados em erro.
- Deno check do endpoint aprovado. Fonte remota v9 conferida com o bundle local.
- Requisição anônima na versão publicada continua retornando 401.
- Não foi feito salvamento autenticado de uma consulta real da clínica para
  testar. Os testes sintéticos não equivalem a uma certificação do aplicativo.

## Reversão

Fonte v8 preservada no backup versionado. Reverter apenas este serviço à v8
reintroduz a incompatibilidade descrita. Se houver regressão, preservar os
dados/formulários e corrigir o contrato; nunca apagar consultas para contornar.

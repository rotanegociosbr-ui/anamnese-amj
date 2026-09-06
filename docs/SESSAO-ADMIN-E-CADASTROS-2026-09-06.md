# Sessão administrativa e cadastros progressivos

Data: 6 de setembro de 2026. Escopo: Fichas AMJ.

## Decisão vigente

O pedido mais recente substituiu a autorização de edição por 30 minutos:
administradores já autenticados não precisam informar outra senha para operar.
Login, MFA, expiração, revogação, vínculo com a clínica e permissões permanecem.
Não se armazena senha no navegador. Não foi criado acesso anônimo.

Salvar e editar usam a sessão atual. Excluir, arquivar, restaurar, finalizar e
demais ações críticas preservam confirmação/cancelamento, motivo, versão,
idempotência e auditoria. Os nomes legados de algumas funções contêm “senha”,
mas o diálogo ativo não possui campo de senha e não solicita prova adicional.

O endpoint de janela de edição foi aposentado (410 após autenticação). A migração
histórica da janela permanece versionada e suas tabelas não foram apagadas;
nenhum serviço de negócio ativo utiliza essa janela.

## Correções incluídas

- Clientes e fornecedores: cadastro inicial reduzido, com complementação depois.
- Produtos: salvar rascunho e completar o mesmo registro. Produtos incompletos
  não entram em compra, estoque ou consumo como se estivessem completos.
- Prontuário: salvar campos e linhas parciais sem gerar cobrança ou baixa de
  estoque; finalizar continua transacional e validado.
- Lote: seleção de lote e validade já cadastrados, disponível ao editar;
  se houver mais de um lote, a escolha permanece explícita.
- Erro real ao adicionar produto: a função de prontuário consultava uma coluna
  inexistente em agendamentos. O vínculo agora usa a associação confirmada do
  agendamento com a mesma paciente e clínica.
- Fotos: upload, visualização e restauração do arquivo clínico privado por owner
  com MFA, sem transformar o login em consentimento da paciente para publicidade.
  Produto, lote e protocolo continuam vinculados. Marketing permanece separado.
- Galeria: falha de autorização não provoca repetição automática infinita.
- Estoque vazio: opção “Arquivar produto sem saldo”, com confirmação e
  cancelamento. Não é automática e não apaga compras, lotes ou prontuários.
  O produto poderá ser restaurado pelo catálogo de arquivados.

## Banco e serviços

Migrações aplicadas em produção:

1. 20260906211135_routine_edit_authorization_window (histórica, aposentada).
2. 20260906211159_cadastros_rascunhos_progressivos.
3. 20260906212526_prontuario_appointment_patient_scope_fix.
4. 20260906212532_private_clinical_photo_authorization.
5. 20260906212911_cotacoes_admin_session_authorization.

Dez Edge Functions atualizadas e conferidas contra os arquivos enviados:
financeiro-fichas v8, prontuario-fichas v8, operacao-clinica-fichas v5,
cotacoes-fichas v3, crm-fichas v5, gestao-administrativa-fichas v4,
painel-fichas v19, marketing-fichas v5, rosto3d-fichas v3 e
edicao-autorizacao v2. Todas responderam 401 a POST sem sessão.

## Evidências e limites

- Suíte completa da interface: 147/147 testes em 36 arquivos, zero falhas,
  cancelamentos ou testes ignorados; duração de 15,397 segundos. Execução com
  timeout explícito para evitar testes pendurados.
- Nova execução Deno pertinente: 61/61 testes aprovados (autorização, rascunhos,
  fotos e 3D). Revisão adicional do conjunto de serviços sem erros de tipos.
- Regressão offline SQL: 14 grupos de cadastros/rascunhos/fotos e reprodução do
  erro 42703 seguida da correção com testes de vínculo e isolamento aprovados.
- Testes SQL transacionais no banco real: rascunhos, vínculo do agendamento,
  fotos privadas e revisão de cotação por sessão administrativa. Todos com
  rollback; nenhuma paciente, produto, consulta ou foto real foi alterada.
- Testes sintéticos em navegador desktop e celular: salvar e reabrir o mesmo
  cadastro, lote na edição, foto privada, estados de erro e ausência de overflow.
- Testes de autorização: sessão expirada/revogada, troca de papel ou clínica,
  cancelamento e nova sessão entre abertura e confirmação da operação.
- Revisão de segurança do Supabase: zero WARN/ERROR; 95 avisos INFO de RLS
  habilitada sem política, na arquitetura de acesso mediado pelos serviços.
  Isso não constitui certificação de segurança nem garantia de ausência de falhas.
  [Explicação do linter](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy).
- Não foi realizada uma sessão clínica real usando a conta de Ana, nem uma
  exclusão/compra/atendimento real para testar. Não se afirma que todo o app foi
  validado de ponta a ponta com dados reais.

## Backup e reversão

Código anterior preservado em arquivo versionado a partir de 3c18850d0c30922941fa492120c5c78b81f05806;
fontes anteriores dos serviços e definições SQL relevantes foram copiadas para
o backup desta entrega. Nenhum original ou backup preexistente foi sobrescrito.

Em incidente, interromper novas operações afetadas e avaliar correção progressiva.
Não reverter o banco apagando rascunhos ou dados novos. Uma reversão de interface
deve ser coordenada com o contrato de autenticação e serviços correspondente;
restaurar somente a tela antiga reintroduziria os pedidos de senha.

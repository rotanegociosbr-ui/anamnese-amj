# Fichas — revisão de acessos e recuperação de cadastros

Data: 06/09/2026. Base preservada: `4772157`.

## Escopo e limites

Correções de interface, acesso, navegação e recuperação após falhas de conexão. Não há novo módulo, alteração de marca, migração do banco, mudança de Edge Function ou alteração de registros reais nesta entrega. Os cenários de escrita foram executados com dados sintéticos e respostas controladas, incluindo o SDK Supabase distribuído com o aplicativo.

Login individual, MFA, autorização de proprietário, isolamento de dados, versões de registros e auditoria continuam necessários. Não foi reintroduzida senha secundária. Operações críticas continuam com confirmação/cancelamento. Fotografias clínicas privadas continuam distintas de autorização de divulgação.

## Falhas encontradas e tratadas

1. Falha temporária na verificação inicial deixava a tela sem recuperação explícita. O botão **Repetir verificação** reutiliza a sessão válida, respeitando o relógio de expiração e MFA; não repete senha automaticamente.
2. O SDK podia devolver erro de rede na saída antes de remover a sessão local. A saída agora fecha o acesso local mesmo sem rede, informa quando não foi possível confirmar revogação no servidor e impede respostas antigas de login/renovação de restaurarem a sessão. Tentativas de login são serializadas.
3. Abrir consulta filtrada dependia de um botão oculto na listagem. O atalho usa a API do prontuário; navegação cancelada e respostas antigas não abrem outra tela. Falha ao inicializar módulo deixa de manter a abertura pendente indefinidamente.
4. Produto confirmado pelo servidor podia desaparecer da listagem se outra leitura financeira falhasse. O registro confirmado é preservado; atualização anterior ao salvamento não substitui sua versão. Falha sem confirmação de gravação não é apresentada como sucesso.
5. Resposta tardia ao salvar um cadastro podia modificar ou limpar outro editor aberto. Os editores têm controle de contexto; respostas antigas não trocam identidade, versão, texto ou estado de salvamento do cadastro atual.
6. Consultas com atualização pendente não devem ser reabertas a partir de versão antiga. O formulário preenchido é preservado e a recuperação exige leitura canônica antes de reutilizar um registro desatualizado.
7. Pedidos que aguardavam cabeçalhos ou confirmação podiam iniciar depois da saída/reset. Prontuário, Operação e Acompanhamentos conferem novamente o contexto antes do envio e descartam efeitos tardios na interface.
8. Retorno repetido após resposta perdida recriava a chave da operação. A mesma intenção é mantida até confirmação; mudança de conteúdo inicia outra intenção.
9. Acompanhamentos recriava a data da tentativa usando a mesma chave, provocando conflito idempotente. Data e chave são preservadas no retry do mesmo conteúdo.

## Verificação de qualidade

- Regressões reproduzidas antes das correções, com testes de erro de rede, respostas invertidas, saída durante operações e repetição após resposta perdida.
- Suíte completa: `node --test --test-timeout=45000 painel/tests/*.test.cjs painel/tests/*.test.mjs`.
- Inclui formulários e preservação de rascunhos em navegador desktop/mobile; testes de fotos, pontos 3D, financeiro, frete, Pix/boleto, idempotência e permissões existentes.
- Resultado final da suíte: **219 testes aprovados, 0 falhas, 0 ignorados**. Navegador desktop e mobile incluídos. O erro `synthetic offline` presente no log é uma falha simulada intencionalmente no teste do SDK, não erro de produção.
- Commit publicado, hashes públicos e cópia no pen drive são registrados na entrega correspondente.

## O que esta revisão não comprova

Não é garantia de ausência absoluta de erros. Intermitências anteriores `database_unavailable` do Financeiro não tiveram uma causa de infraestrutura isolada; a interface agora distingue confirmação de gravação de falha na atualização, mas isso não resolve uma indisponibilidade externa. Não foram realizados lançamentos, exclusões ou alteração de pacientes reais como teste. Nenhuma mensagem foi enviada a pacientes.

## Atualização e recuperação

Os arquivos alterados recebem versões novas de cache. Uma aba já aberta não é recarregada à força: salvar o preenchimento em andamento antes de reabrir o aplicativo. O backup anterior permite recuperação do código sem modificar dados clínicos. Se necessário, publicar um revert do commit desta entrega; não restaurar banco ou apagar registros.

# Prompt 54 — execução, correções e evidências

Data: 05/09/2026. Base auditada: main, d82792cf95c96b77abf8ccff3cbf12faf56817c1, inicialmente limpa.
Lote de correções: cf8fd9a4460be56b93c88ed31cf13d1c2f768608.
Estado: correções revisadas e liberadas; qualificação operacional integral ainda pendente. Este relatório não certifica ausência de erros, conformidade jurídica nem segurança absoluta.

## Resultado desta execução

Foram corrigidos defeitos reproduzidos no aplicativo existente, sem criar módulos paralelos:

| ID | Defeito e impacto | Correção | Evidência |
|---|---|---|---|
| F54-01 | Atualizar catálogos apagava a escolha de cliente, fornecedor ou marca em formulários em preenchimento | Preservar a seleção enquanto ela continuar válida no catálogo | Regressão comportamental em financeiro-context-behavior.test.cjs |
| F54-02 | Abrir outro lançamento com saldo semelhante podia reaproveitar datas/valores de parcelas do anterior | Vincular formulário e intenção de parcelamento ao ID do lançamento; preservar edição/reenvio apenas no mesmo lançamento | Dois lançamentos, entrada Pix e três boletos, timeout/reenvio simulados |
| F54-03 | Resposta atrasada de upload podia afetar o contexto de outra consulta ou de uma sessão encerrada | Verificar sessão, consulta e contexto antes/depois das operações assíncronas nas duas superfícies de fotos; reutilizar a intenção no retry | photos-async-context.test.cjs: nove regressões; não prova câmera física |
| F54-04 | Carregamento lento de um módulo podia substituir a tela escolhida depois | Descartar navegação atrasada e revalidar acesso depois do carregamento | app-shell-navigation-race.test.cjs: sete regressões |
| F54-05 | Procedimentos ocupava 649 px em celulares de 360/390/430 px | Corrigir largura mínima da grade e controles, sem esconder a rolagem global | 32 medições finais aprovadas; desktop preserva duas colunas |
| F54-06 | Sete funções mediam o tamanho do envio depois de ler todo o corpo | Leitura incremental limitada; autenticar marketing antes de consumir o corpo; manter Unicode, JSON e limites dos termos | Treze testes específicos do leitor/handlers, typecheck e conferência dos pacotes publicados |
| F54-07 | Regex da fila de fotos órfãs rejeitava caminhos canônicos de imagens | Corrigir pontos literais na função e constraint, sem executar limpeza ou excluir fotos | PostgreSQL: falha anterior confirmada; 12 casos sintéticos, metadados e ACLs conferidos após migration |

A documentação de autenticação foi atualizada: conta individual e segunda etapa, não senha compartilhada. Os parâmetros de versão dos arquivos alterados foram atualizados para evitar uso da interface antiga em cache. Testes estáticos que exigiam o número antigo receberam o número novo, sem remover a verificação.

## Mapa e fonte única

Interface estática HTML/JS/CSS organizada por painel/app-shell.js; módulos carregados sob demanda. Financeiro concentra os cadastros canônicos. Operação liga paciente, atendimento, procedimentos e consumo; Prontuário apresenta documentos e fotos privadas. Edge Functions e RPCs controlam acesso e persistência.

Jornada: pessoa/lead → cadastro → avaliação/orçamento → agenda → atendimento → procedimento/produto/lote/foto → cobrança/pagamento → retorno/histórico.

Ver um registro em várias telas não significa duplicidade; as telas devem compartilhar o mesmo ID. Nenhuma fusão de pessoas ou alteração de cadastros reais foi feita nesta execução.

## Matriz de aceitação — limites explícitos

“Verificado” vale somente para a evidência descrita, não para todos os ambientes.

| Requisito/cenário | Tela/ação e fonte | Estado | Evidência / próximo teste |
|---|---|---|---|
| Cadastrar e encontrar cliente, fornecedor, marca e produto | Cadastros / Financeiro | Implementado mas não testado de ponta a ponta | Seleções e listagem sintética verificadas; falta salvar e reabrir com banco isolado |
| Dois procedimentos no mesmo atendimento | Procedimentos / Operação e RPCs | Implementado mas não testado de ponta a ponta | Leitura de vínculos/tenant e testes de contrato; falta jornada transacional isolada |
| Novo atendimento em outro dia | Paciente → Procedimentos | Implementado mas não testado de ponta a ponta | Contexto de foto/navegação coberto; criação real não executada |
| Antes/depois e fotos das ampolas | Adicionar fotos ao atendimento / Prontuário | Implementado mas não testado de ponta a ponta | Galerias e ações sintéticas visíveis; falta upload/recarga reais em homologação |
| Trocar paciente durante upload | Operação e Prontuário | Verificado localmente | Respostas atrasadas não contaminam novo contexto; nove regressões |
| R$ 1.800, entrada R$ 600 Pix + 3 boletos de R$ 400 | Financeiro → parcelamento | Verificado no frontend simulado | Payload, intenção e troca de lançamento; falta receber/estornar no banco isolado |
| Compra R$ 100 + R$ 200 + R$ 30 de frete | Estoque → Nova compra | Verificado no frontend simulado | Total R$ 330 e retry da mesma compra; rateio/caixa precisam reconciliação SQL isolada |
| Consumo de dois produtos/lotes/fornecedores | Procedimentos / estoque | Implementado mas não testado de ponta a ponta | RPCs de estoque/estorno revisadas seletivamente; falta movimentação isolada |
| Duplo clique, timeout e reenvio | Fotos, parcelas, compras | Verificado nos casos simulados | Intenção idempotente e contexto preservados; não equivale a ensaio de falha da infraestrutura |
| Duas sessões editam; exclusão sem permissão | APIs e RPCs protegidas | Implementado mas não testado integralmente | Auth/versão em código e suites locais; falta duas sessões reais de homologação |
| Cancelamento, estorno e retificação | Financeiro / Prontuário | Implementado mas não testado integralmente | Revisão de locks, saldo, elegibilidade e histórico; nenhum registro real excluído |
| Reagendar e abrir WhatsApp | Agenda / WhatsApp assistido | Implementado mas não testado de ponta a ponta | Contratos locais aprovados; não houve envio de mensagem nem confirmação de entrega |
| PDF e relatórios reconciliados | Atendimento / Financeiro | Implementado mas não testado integralmente | Contratos existentes; faltam gerar, imprimir e reconciliar documentos sintéticos com banco isolado |
| Sessão expirada, foto e IDs indevidos | Auth / Edge / Storage | Verificado parcialmente | Testes locais de acesso, revisão fonte, buckets privados e sonda anônima; falta teste completo de permissões implantadas |
| Celular e computador | Cotações, fotos, procedimentos, clientes, receitas, despesas e estoque | Verificado em Edge desktop redimensionado | 360/390/430/1366 px; não substitui Android/iPhone/Safari |
| Fotos órfãs após falha de upload | Fila técnica privada | Verificado em expressão SQL e metadados | Caminhos corrigidos; nenhum objeto foi enfileirado, apagado ou recuperado como teste |

## Testes executados

Ambiente: Windows, Node 24.18.0, Deno 2.9.5, Edge/Chromium 152.0.4191.62 headless. Dados sintéticos; nenhum paciente fictício inserido em produção.

- Baseline do painel: 36 entradas do runner aprovadas em 23 arquivos.
- Painel após correções: 57 aprovadas, zero falhas.
- Node backend/shared: 28 aprovadas, zero falhas.
- Deno: 115 aprovadas em 12 arquivos, zero falhas/ignorados. Auth 9, painel 5, operação 6, prontuário 11, marketing 4, CRM 27, cotações 8, gestão 8, agendamento 8, integrações 6, IA 23.
- Browser: 32 medições, zero overflow, ações verificadas alcançáveis, zero erro JavaScript e zero chamada fora das fixtures.
- SQL somente leitura: 12 casos de caminhos de foto; metadados confirmaram os três padrões corrigidos e manutenção das permissões.
- Typecheck: sete handlers alterados aprovados com Deno check; diff sem erros de whitespace.

As contagens misturam testes comportamentais, contratos estáticos e entradas de runner. Não significam 200 jornadas completas nem um percentual de segurança.

Comandos no repositório canônico:

```powershell
node --test painel/tests/*.test.cjs painel/tests/*.test.mjs
node --test supabase/functions/_shared/*.test.mjs supabase/functions/agendamento-submit/logic_node_test.mjs supabase/functions/integracoes-fichas/logic_node_test.mjs
node painel/tests/browser-layout-smoke.cjs
```

Para cada suite Deno, foi usado seu deno.json e:
```text
deno.exe test --cached-only --frozen --deny-net --deny-write --deny-run --no-prompt --allow-read=<repo> --allow-env=SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY,ALLOW_LOCAL_ORIGINS --config <config> <teste>
```
As variáveis eram sintéticas e limitadas às necessárias por suite; transporte de IA/RPC simulado. Configurações e lockfiles não foram alterados.

Evidência visual sanitizada: pasta local amj-layout-smoke-s6h5fr no Temp, copiada para o backup desta execução. São capturas da interface real com sessão/dados simulados e fontes externas bloqueadas. Não houve medição comparativa confiável de latência real em produção; não atribuímos um ganho percentual de velocidade.

## Segurança e dados

A skill de Supabase orientou conferência do projeto, metadados e implantação; Codex Security orientou investigação independente e validação do problema de limite de corpo; as referências de PostgreSQL orientaram uma alteração pequena com timeout e preservação de privilégios.

A revisão estática de segurança é parcial: 81 arquivos no inventário, 16 arquivos TypeScript integralmente revisados, controles complementares seletivos. Um achado médio de consumo de recursos foi validado e corrigido; não foi feito ataque de carga em produção. O serviço opcional TAC não estava conectado; isso não impede os testes locais nem comprova ausência de outras falhas.

Conferência somente leitura no projeto correto:

- clinic-media, fichas-pdf e documentos-clinicos: privados;
- 88 tabelas públicas com RLS habilitada; zero sem RLS;
- nenhum SELECT concedido diretamente a anon nas tabelas públicas consultadas;
- autenticação individual owner/AAL2 e reautenticação sensível revisadas no código.

RLS habilitada e buckets privados são controles, não certificação. Políticas, views, funções, configuração completa e todas as combinações de acesso ainda exigem homologação. Não foi acessado conteúdo de pacientes, chave secreta, senha ou código MFA.

## Publicação e recuperação

- Código: commit cf8fd9a4460be56b93c88ed31cf13d1c2f768608 enviado ao repositório autorizado rotanegociosbr-ui/anamnese-amj, branch main.
- Interface: Pages confirmou build concluído de cf8fd9a. Os seis arquivos (HTML, App Shell, Financeiro, Prontuário, Operação JS/CSS) responderam HTTP 200 e conferem integralmente com a versão local após normalizar quebras de linha. Revisão de assets: 20260905-1.
- Sete Edge Functions publicadas e relidas: marketing-fichas 4; tcle-submit 15; preenchimento 14; intradermoterapia 11; bioestimulador 5; peeling químico 5; fios PDO 5. Todos os arquivos TypeScript publicados conferem com o patch.
- Preflight OPTIONS das sete funções: 204 com origem autorizada. POST anônimo pequeno no marketing: 401. Isso não comprova submissão de termo ou autenticação de proprietários.
- Migration aplicada: 20260905151848_prompt54_photo_gc_literal_paths.sql. Altera somente padrões de caminhos, função/constraint e timeouts; mantém ACLs, retenção, auditoria e fila pendente. Nenhuma limpeza automática ou exclusão física foi executada.
- Backup de código e definições: 08 - Backup/Site Ana Maria Jacob/Antes Prompt54 20260905-151300. Contém bundle Git anterior, fontes das sete funções e definição SQL anterior. Bundle verificado; SHA-256 83DEC292380E1BF9DBF321A1222A049E2FF464962132CE138FCD98ABF8317B42.
- Isso NÃO é backup de banco/pacientes/Storage e não é ensaio de restauração. Não restaurar sobre produção; eventual reversão deve ser seletiva e considerar alterações posteriores.
- Projeto Atual: 25 arquivos de código/teste sincronizados, após equivalência com a base d82792c; hashes de origem/destino conferidos. O relatório também é copiado ao fechar a execução. O pendrive E: não estava disponível; a sincronização física permanece pendente.
- Nenhuma API de IA paga, cobrança, chave, envio WhatsApp ou plano de serviço foi ativado. WhatsApp segue assistido/manual.

## Guia curto para Ana e Rodney

1. **Encontrar cadastros:** menu Clientes, Fornecedores, Marcas ou Produtos; pesquisar e abrir o registro existente. Não recadastrar só porque ele também aparece em outra tela.
2. **Atender:** em Procedimentos, selecionar a paciente e criar/abrir o atendimento da data correta. Acrescentar procedimentos nessa visita; outro dia, novo atendimento.
3. **Fotografar:** em Procedimentos → Adicionar fotos ao atendimento, escolher paciente/consulta → Adicionar ou tirar fotos. Na galeria da consulta, escolher categoria e usar Adicionar fotos ou Tirar foto. Conferir a consulta antes de enviar; consultar também Fotos e prontuários. JPEG/PNG/WebP até 25 MB por arquivo; HEIC não está validado/aceito nesse fluxo.
4. **Fotos de produtos:** escolher a categoria de produtos/ativos/ampolas e vincular produto/lote/consumo quando aplicável. Guardar no prontuário não autoriza publicar.
5. **Receber:** abrir o lançamento ligado ao atendimento, registrar entrada e planejar saldo com vencimentos. Pix e boleto podem compor o mesmo caso; vencimento não equivale a recebimento.
6. **Registrar frete:** Estoque → Nova compra, selecionar fornecedor, itens e campo Frete. Não criar um fornecedor fictício chamado frete.
7. **Corrigir/excluir:** abrir o cadastro ou registro e usar a ação permitida. Operações sensíveis exigem senha atual; registros assinados e histórico financeiro podem exigir retificação/estorno/arquivamento, não exclusão.
8. **Imprimir:** abrir os detalhes do atendimento/lançamento e a opção PDF/impressão disponível. Conferir paciente, itens, valores e situação antes de arquivar.

## Pendências para qualificação integral

- P1 de validação: jornada ponta a ponta com banco e contas isoladas; pagamentos, estoque, frete, conflitos de duas sessões, estorno e permissões negativas precisam evidência transacional.
- P1 de validação: câmera e seleção múltipla em iPhone/Android reais; reconexão, formatos/rotação, original/miniatura e reabertura das fotos.
- P1 de recuperação: definir/verificar backup de banco e Storage e testar restauração em ambiente isolado. O bundle de código não resolve esse requisito.
- P2: impressão/PDF, agenda/modais e acessibilidade completa nos aparelhos; medir latência real com condições documentadas.
- P2: auditar os arquivos restantes, confirmar políticas efetivamente aplicadas e política de retenção aprovada.
- Sincronização física: pendrive ausente.

Nenhum bloqueador P0/P1 foi confirmado como remanescente nos defeitos corrigidos neste lote. As lacunas críticas acima impedem chamar o aplicativo inteiro de totalmente concluído ou dar uma nota global de confiabilidade.

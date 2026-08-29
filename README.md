# Ana Maria Jacob Estética

Site institucional, ficha de anamnese e documentos clínicos digitais da Ana
Maria Jacob Estética.

## Rotas

- `/` — página inicial da clínica
- `/tratamentos/` — guia educativo em linguagem simples sobre os tratamentos
  faciais, capilares e a administração intramuscular mediante avaliação,
  anamnese, indicação individual e prescrição válida
- `/anamnese/` — ficha de anamnese preservada
- `/tcle-toxina/` — TCLE de toxina botulínica para leitura, preenchimento,
  assinatura da paciente e geração de sua cópia em PDF
- `/tcle-preenchimento/` — TCLE de preenchimento facial com ácido hialurônico,
  com triagem específica, assinatura e geração canônica da cópia em PDF
- `/tcle-intradermoterapia/` — TCLE de intradermoterapia estética facial,
  corporal ou capilar, sem abranger aplicação intramuscular
- `/tcle-bioestimulador/` — pré-avaliação para bioestimulador de colágeno,
  com envio, assinatura e geração canônica da cópia em PDF
- `/tcle-peeling-quimico/` — pré-avaliação restrita a peeling químico
  superficial não fenólico; não abrange fenol nem peelings médios ou profundos
- `/tcle-fios-pdo/` — pré-avaliação para fios absorvíveis de polidioxanona,
  dependente da identificação profissional do dispositivo, região e técnica
- `/termos/` — central pública para escolher o documento do procedimento,
  mantendo a ficha de anamnese separada
- `/painel/` — acesso restrito da equipe, com filtros para anamneses e TCLEs,
  links de convite, QR codes, acesso aos PDFs armazenados e o módulo interno
  **Agenda e retornos**; proprietários autenticados com MFA também recebem a
  aba privada **Financeiro** e a **Central de integrações** somente leitura

Domínio: `anamariajacob.com.br`

O guia de tratamentos apresenta informações gerais para ajudar pessoas leigas a
entender cada possibilidade. Ele não substitui avaliação, diagnóstico,
orientação individual ou consentimento informado. Subtécnicas, produtos,
regiões e protocolos somente devem ser anunciados depois de confirmação da
profissional responsável. O conteúdo de aplicação intramuscular é apenas
educativo, não é coberto pelo TCLE de intradermoterapia e requer consentimento
específico antes do procedimento.

## Área privada Fichas

A rota `/painel/` corresponde à área interna **Fichas** da clínica. Todas as
anamneses e todos os termos liberados aparecem nela, com acesso restrito por
senha à equipe. Os documentos usam armazenamento privado e o painel recebe
apenas os resumos necessários e links temporários para os PDFs.

## Agenda e retornos

O módulo fica na aba **Agenda e retornos** da própria rota protegida `/painel/`.
Depois de entrar com a senha já usada pelo Fichas, a equipe pode cadastrar e
editar horários, controlar estados do atendimento e organizar lembretes de
confirmação, 24 horas, 2 horas e retorno. A página pública `/agendar/` continua
apenas iniciando uma conversa no WhatsApp e não confirma nem grava um horário.

O botão **Ativar alertas do navegador** solicita permissão somente após um
clique da equipe e a autorização vale para aquele navegador e aparelho. Os
alertas do sistema operacional usam texto genérico, sem nome, telefone,
procedimento ou horário. Os avisos internos continuam funcionando quando a
permissão é negada ou o recurso não está disponível.

Nesta versão, as pendências são consultadas quando o Fichas abre, volta a ficar
visível e periodicamente enquanto permanece aberto. Sem Web Push e sem um
serviço de envio, não é possível garantir alertas com o Fichas ou o navegador
fechado; as pendências reaparecem na próxima abertura.

O WhatsApp permanece **manual**: o sistema apenas prepara e abre o link depois
de uma ação consciente da equipe. Abrir a conversa não registra envio; a equipe
precisa usar **Marcar como enviado** depois de realmente enviar a mensagem.
Nenhuma API externa está ativa, e os textos não incluem procedimento nem dado
de saúde.

Arquivos principais do módulo:

- `painel/index.html` — interface da agenda, retornos, filtros, estados, alertas
  e ações manuais de WhatsApp;
- `supabase/migrations/20260819031402_agenda_retornos_fichas.sql` — cria as
  tabelas privadas `agendamentos_clinica` e `agendamento_lembretes`, constraints,
  índices, RLS e permissões;
- `supabase/functions/agenda-fichas/index.ts` — API server-side de consulta e
  mutação da agenda, protegida pelo acesso do Fichas;
- `supabase/functions/agenda-fichas/deno.json` e `deno.lock` — dependências
  fixadas da função;
- `supabase/config.toml` — registra a Edge Function `agenda-fichas`.

O navegador não acessa as tabelas da agenda diretamente. A Edge Function valida
origem, senha, conteúdo, transições de estado e idempotência; somente ela usa a
`service_role`, mantida no servidor. As tabelas têm RLS habilitada, não possuem
acesso para `public`, `anon` ou `authenticated` e não armazenam a senha. Dados da
agenda e credenciais também não devem ser gravados em `localStorage`, exibidos
em notificações ou registrados em logs.

## Central de integrações — Fase 5A

A área privada **Integrações** apresenta o inventário das conexões futuras com
site, WhatsApp oficial, calendário, pagamentos online e outras APIs autorizadas.
Nesta fase ela é deliberadamente somente leitura: todos os conectores aparecem
como **Desativados**, **Não verificados** e **Sem conexão externa**.

O catálogo usa um adaptador nulo que interrompe qualquer tentativa antes de um
transporte externo. A Fase 5A não possui botão de conectar, autorização OAuth,
webhook público, envio de mensagem, sincronização de calendário, cobrança,
consulta bancária, SDK de provedor ou segredo de integração. Portanto, ela não
cria custo externo. O site, a anamnese, os TCLEs, a agenda interna, o financeiro
administrativo e o modo inteligente gratuito por regras continuam funcionando
como antes; o item “site” na Central representa apenas uma integração futura.

Arquivos principais:

- `painel/integracoes.js` e `painel/integracoes.css` — módulo responsivo e
  somente leitura da Central;
- `supabase/functions/integracoes-fichas/` — endpoint privado de status,
  protegido por conta individual `owner` e MFA `aal2`, sem chamar provedores;
- `supabase/config.toml` — registro da Edge Function privada.

Antes da Fase 5B, cada integração exige decisão explícita de provedor, análise
do contrato oficial vigente, custos conhecidos e autorizados, credenciais em
secrets do servidor, ambiente de testes e critérios próprios de segurança. Um
webhook futuro deverá validar assinatura sobre o corpo bruto, deduplicar eventos
e impedir replay antes de qualquer efeito. Filas futuras deverão ser duráveis,
carregar preferencialmente referências em vez de dados clínicos e possuir
reconciliação e tratamento de falhas. Nenhum desses mecanismos está ativo na
Fase 5A.

## Financeiro, estoque e operação clínica

O `/painel/` registra clientes reaproveitáveis, procedimentos, receitas avulsas,
despesas, recebimentos e pagamentos manuais, fornecedores, marcas, produtos e
compras. Produtos, marcas e fornecedores possuem áreas próprias no menu, mas
continuam usando um único cadastro canônico, sem duplicação. O sistema também
mostra valores recebidos, pagos, em aberto e a evolução dos últimos seis meses.
Fluxo de caixa não é apresentado como lucro contábil.

O Financeiro exige conta individual `owner` e MFA `aal2`. A senha compartilhada
de transição não autoriza nem revela a aba. Ana Maria Costa Jacob e Rodney Neri
de Souza Junior devem possuir memberships `owner` ativas, com poderes iguais.

Pagamentos são registros administrativos do que efetivamente ocorreu. Esta fase
não cobra cartão, não gera PIX ou boleto, não consulta banco e não armazena
número completo de cartão, CVV, senha ou token. Correções usam cancelamento ou
estorno auditado; não existe exclusão física de fatos financeiros.

Arquivos principais:

- `painel/index.html`, `painel/financeiro.css` e `painel/financeiro.js` — aba,
  formulários, indicadores, gráfico, filtros e auditoria;
- `supabase/migrations/20260819135410_gestao_financeira_mvp.sql` — cadastro
  canônico de clientes, catálogos, lançamentos, pagamentos, compras, views,
  RPCs, RLS e menor privilégio;
- `supabase/functions/financeiro-fichas/` — API owner-only, com MFA, filtro por
  clínica, validação, idempotência e auditoria nominal.

Compras podem reunir vários produtos do mesmo fornecedor, incluir frete e gerar
lotes com validade. O estoque registra entradas, saídas, estornos, perdas,
desperdícios e devoluções, com rastreabilidade por atendimento. Cada atendimento
pode reunir vários procedimentos, prontuário, produtos e lotes, fotos privadas
de antes/durante/depois e fotos dos produtos utilizados.

## Fluxo do TCLE

1. A paciente lê a versão canônica do termo, responde às perguntas, registra
   suas declarações e assina desenhando ou confirmando o nome digitado.
2. O navegador envia o texto verificado, as respostas e a assinatura, sem criar
   nem fornecer o documento final.
3. A Edge Function específica do procedimento valida no servidor a origem, a
   versão, o hash e o modelo canônico do termo, a identificação, as respostas e a assinatura.
   Em seguida, gera a cópia oficial em PDF e aplica idempotência e limitação de
   abuso.
4. Somente a função, usando `service_role`, grava o registro na tabela
   `documentos_clinicos` e salva PDF e assinatura no bucket privado
   `documentos-clinicos`.
5. O painel chama a Edge Function `painel-fichas`, que mantém compatibilidade
   com as anamneses existentes, acrescenta os TCLEs e fornece URLs assinadas
   temporárias para o PDF exato de cada documento.

O envio da paciente permanece com o estado **aguardando revisão profissional**.
Ele registra a manifestação da paciente, mas não conclui a avaliação nem
autoriza o procedimento. A profissional deve revisar as respostas, esclarecer
dúvidas, registrar produto/lote/validade e concluir sua parte antes da aplicação.

A anamnese atual continua no fluxo original. O TCLE usa tabela e bucket
separados para que a evolução dos próximos termos não altere os registros já
existentes.

## Arquivamento das fichas

O app Fichas permite retirar uma anamnese ou um documento clínico da lista
principal por meio de **Arquivar ficha**. A operação exige confirmação e motivo,
é reversível pela área **Arquivadas** e gera registro em
`fichas_acoes_auditoria`. O PDF, a assinatura e o registro clínico não são
apagados pelo arquivamento.

A exclusão definitiva existe somente para fichas independentes consideradas
elegíveis pelo servidor. Ela exige usuário individual `owner`, MFA, senha atual,
motivo e confirmação explícita. O sistema recusa a exclusão quando encontra
paciente, agenda, atendimento, prontuário, financeiro, pagamento, termo,
consentimento ou qualquer vínculo que precise ser preservado. Operações
financeiras e clínicas relacionadas usam cancelamento, estorno ou arquivamento
auditado, preservando a rastreabilidade legal e administrativa.

## Arquivos do TCLE

- `tcle-toxina/index.html` — formulário e conteúdo apresentado à paciente
- `tcle-toxina/tcle.css` — apresentação responsiva do formulário
- `tcle-toxina/tcle.js` — validação, assinatura, envio e acesso à cópia gerada
  pelo servidor
- `tcle-toxina/termo-v1.txt` — texto canônico versionado e vinculado por SHA-256
- `tcle-preenchimento/` — formulário, estilos, validação e texto canônico do
  TCLE de preenchimento facial
- `tcle-intradermoterapia/` — formulário, estilos, validação e texto canônico
  do TCLE de intradermoterapia estética
- `tcle-bioestimulador/` — formulário, estilos, validação e texto canônico da
  pré-avaliação do bioestimulador de colágeno
- `tcle-peeling-quimico/` — pré-avaliação do peeling químico superficial não
  fenólico, com triagem, autorizações e texto canônico próprios
- `tcle-fios-pdo/` — pré-avaliação para fios absorvíveis de PDO, com triagem,
  autorizações e texto canônico próprios

## Pré-avaliações liberadas em 18/08/2026

| Documento | Versão | SHA-256 canônico |
| --- | --- | --- |
| Bioestimulador de colágeno | `2026-08-18-v1` | `cf2c0958cc679441b99849ded246d12ee1b9f7aaa102604a441dda1720a66213` |
| Peeling químico superficial | `2026-08-18-v1` | `3f04db1af1f0e984385862abdd0b1b93ae34ebfd49f09587f541c317022b530b` |
| Fios absorvíveis de PDO | `2026-08-18-v1` | `6a31a13133e29132763e2ded44c6d1a424d64154d0cb883b02628d897924bd24` |

Os três documentos registram uma manifestação inicial e não autorizam
automaticamente a realização do procedimento. Produto ou dispositivo, região,
quantidade, técnica e plano continuam sujeitos à avaliação profissional
individual, à rastreabilidade e à confirmação antes da execução.

## Supabase

- `supabase/config.toml` — configuração das funções do projeto
- `supabase/migrations/20260811203817_documentos_clinicos_tcle_toxina.sql` —
  tabela com RLS, permissões exclusivas de `service_role`, índices e bucket
  privado de documentos clínicos
- `supabase/migrations/20260811214204_documentos_clinicos_tcle_preenchimento.sql` —
  amplia o tipo permitido sem alterar RLS, permissões ou registros existentes
- `supabase/migrations/20260812021638_documentos_clinicos_tcle_intradermoterapia.sql` —
  acrescenta o tipo da intradermoterapia ao mesmo armazenamento protegido
- `supabase/migrations/20260818111337_documentos_clinicos_tcle_bioestimulador.sql` —
  acrescenta o tipo do bioestimulador ao armazenamento protegido
- `supabase/migrations/20260818115439_documentos_clinicos_tcle_peeling_quimico.sql` —
  acrescenta o tipo do peeling químico ao armazenamento protegido
- `supabase/migrations/20260818115450_documentos_clinicos_tcle_fios_pdo.sql` —
  acrescenta o tipo dos fios de PDO ao armazenamento protegido
- `supabase/migrations/20260819031402_agenda_retornos_fichas.sql` — cria a
  agenda operacional privada e sua fila de lembretes, com RLS e acesso exclusivo
  pela Edge Function
- `supabase/migrations/20260819031744_arquivamento_fichas_painel.sql` —
  acrescenta arquivamento reversível, motivo, auditoria imutável e fecha a
  leitura pública herdada da view de anamneses
- `supabase/migrations/20260819031852_minimizar_privilegios_fichas.sql` —
  reduz os privilégios internos ao mínimo necessário e mantém operações
  destrutivas fora das Edge Functions
- `supabase/functions/tcle-submit/index.ts` — endpoint server-side de recepção,
  validação, geração canônica do PDF, integridade e armazenamento do TCLE
- `supabase/functions/tcle-preenchimento-submit/index.ts` — endpoint isolado do
  preenchimento facial, com validação e PDF canônico próprios
- `supabase/functions/tcle-intradermoterapia-submit/index.ts` — endpoint isolado
  da intradermoterapia, com validação e PDF canônico próprios
- `supabase/functions/tcle-bioestimulador-submit/index.ts` — endpoint isolado da
  pré-avaliação do bioestimulador
- `supabase/functions/tcle-peeling-quimico-submit/index.ts` — endpoint isolado
  da pré-avaliação do peeling químico
- `supabase/functions/tcle-fios-pdo-submit/index.ts` — endpoint isolado da
  pré-avaliação dos fios de PDO
- `supabase/functions/agenda-fichas/index.ts` — endpoint isolado da agenda e dos
  retornos, autenticado pelo acesso restrito do Fichas
- `supabase/functions/painel-fichas/index.ts` — endpoint server-side do painel,
  unificando resumos das anamneses e dos TCLEs e emitindo links assinados

Os dados sensíveis permanecem no projeto Supabase da clínica. Não inclua
senhas, chaves privilegiadas ou registros de pacientes neste repositório.

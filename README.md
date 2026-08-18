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
  links de convite, QR codes e acesso aos PDFs armazenados

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
- `supabase/functions/painel-fichas/index.ts` — endpoint server-side do painel,
  unificando resumos das anamneses e dos TCLEs e emitindo links assinados

Os dados sensíveis permanecem no projeto Supabase da clínica. Não inclua
senhas, chaves privilegiadas ou registros de pacientes neste repositório.

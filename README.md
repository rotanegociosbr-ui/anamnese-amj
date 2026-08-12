# Ana Maria Jacob Estética

Site institucional, ficha de anamnese e documentos clínicos digitais da Ana
Maria Jacob Estética.

## Rotas

- `/` — página inicial da clínica
- `/anamnese/` — ficha de anamnese preservada
- `/tcle-toxina/` — TCLE de toxina botulínica para leitura, preenchimento,
  assinatura da paciente e geração de sua cópia em PDF
- `/tcle-preenchimento/` — TCLE de preenchimento facial com ácido hialurônico,
  com triagem específica, assinatura e geração canônica da cópia em PDF
- `/painel/` — acesso restrito da equipe, com filtros para anamneses e TCLEs,
  links de convite, QR codes e acesso aos PDFs armazenados

Domínio: `anamariajacob.com.br`

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

## Supabase

- `supabase/config.toml` — configuração das funções do projeto
- `supabase/migrations/20260811203817_documentos_clinicos_tcle_toxina.sql` —
  tabela com RLS, permissões exclusivas de `service_role`, índices e bucket
  privado de documentos clínicos
- `supabase/migrations/20260811214204_documentos_clinicos_tcle_preenchimento.sql` —
  amplia o tipo permitido sem alterar RLS, permissões ou registros existentes
- `supabase/functions/tcle-submit/index.ts` — endpoint server-side de recepção,
  validação, geração canônica do PDF, integridade e armazenamento do TCLE
- `supabase/functions/tcle-preenchimento-submit/index.ts` — endpoint isolado do
  preenchimento facial, com validação e PDF canônico próprios
- `supabase/functions/painel-fichas/index.ts` — endpoint server-side do painel,
  unificando resumos das anamneses e dos TCLEs e emitindo links assinados

Os dados sensíveis permanecem no projeto Supabase da clínica. Não inclua
senhas, chaves privilegiadas ou registros de pacientes neste repositório.

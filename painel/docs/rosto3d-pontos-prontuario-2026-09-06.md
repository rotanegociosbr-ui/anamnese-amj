# Rosto 3D — pontos e prontuário

Entrega funcional de 06/09/2026. Substitui as instruções antigas que descreviam o visor como exportação local sem prontuário. Não altera os modelos nem afirma equivalência anatômica com uma paciente.

## Como usar

1. Atualize o Fichas e entre com a conta individual autorizada e o autenticador.
2. Abra **Fotos e prontuários → paciente → consulta → Rosto 3D e pontos**.
3. Confira o nome/data da consulta. No editor **Pontos e observações**, escolha **Marcar ponto**, toque ou clique na superfície e escreva o nome e a observação. É possível acrescentar observações gerais.
4. Escolha **Salvar no prontuário** e confirme sua senha. Aguarde **Salvo no prontuário · versão N**. Fechar antes dessa confirmação não equivale a salvar.
5. Ao reabrir a mesma consulta, o sistema recupera os pontos e textos. Escolher um ponto na lista revela sua base/camada; **Voltar a esta consulta** retorna ao registro correto.
6. Para corrigir, selecione/mova/renomeie/exclua um ponto e salve uma nova versão. O histórico anterior permanece no banco.

O rosto externo e o atlas anatômico são bases independentes. Pontos não são transferidos automaticamente entre elas. O atlas é ilustrativo, não serve como guia de aplicação, dose, profundidade ou previsão de resultado.

## Sincronização e segurança

- Armazenamento privado por clínica e consulta em `facial_studies`; sem dados de paciente na URL do visor ou em armazenamento persistente do navegador.
- Leitura/gravação exigem proprietário ativo, sessão individual válida e MFA AAL2. Uma nova gravação exige prova recente de senha.
- O servidor devolve e verifica o vínculo paciente + consulta + versão. A interface confere o paciente do prontuário antes de carregar. Mudanças concorrentes geram conflito, não sobrescrita silenciosa.
- Saves serializados por lock transacional; operação idempotente e versões append-only. Não foi concedido UPDATE de consultas ao service_role.
- Uma consulta que já possui estudo não pode ser transferida para outro paciente. Arquivar mantém o histórico.
- Rascunhos não salvos são preservados em falhas. **Recarregar do prontuário** pede confirmação antes de substituí-los. Não é sincronização automática em tempo real entre aparelhos: use salvar/reabrir ou recarregar.
- Auditoria de leitura/gravação permanece ativa; RLS ligado, sem SELECT público para anon/authenticated. O gateway JWT continua configurado como antes: a função faz a autenticação individual completa internamente.

## Verificação e publicação

- 79 testes Node aprovados: pontos/âncoras, gestos, integração do host, prontuário e navegação.
- 25 testes Deno aprovados: endpoint e autenticação compartilhada, incluindo troca de paciente/versão durante a leitura.
- Teste PostgreSQL local reproduziu o erro antigo `42501` e validou a correção sob `service_role`.
- Smoke transacional executado no Supabase real com dados exclusivamente fictícios, permissões reais de service_role e ROLLBACK. Conferência posterior: zero fixtures residuais; RLS mantido; sem ampliação de UPDATE.
- Edge Function `rosto3d-fichas` versão 2 ativa; chamadas públicas sem sessão bloqueadas com 401, origem não autorizada 403, preflight autorizado 204.
- Migration: `20260906195510_facial_studies_context_lock.sql` (aplicada pelo conector com o nome `facial_studies_context_lock`).
- Visor em navegador real validado com host sintético, desktop e viewport móvel. Isso não equivale a testar a conta real, MFA e senha da Ana em um celular físico.
- Concorrência simultânea em duas sessões PostgreSQL não foi exercitada; a ordem dos locks e os conflitos foram revisados e testados sequencialmente.
- O advisor retornou apenas avisos informativos. `facial_studies` tem RLS sem policies de acesso direto por desenho: somente a função autenticada lê pelo serviço. [Referência do aviso](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy).

## Recuperação

Antes de publicar foram preservadas as fontes do commit `065b367eac7ebb68787529f808e0529bed0cdad8` e a Edge Function v1 na pasta de backup do projeto. Se houver falha de persistência, interromper novas gravações e inspecionar os logs; não apagar estudos, não remover o bloqueio de paciente e não restaurar a função antiga com o erro de permissão. Corrigir à frente preservando a migration e o histórico. Uma eventual reversão visual deve manter o contrato de vínculo ou desabilitar salvar até a correção.

O acabamento visual/humano do modelo é uma etapa separada desta correção funcional e continua sujeito à aprovação da clínica.

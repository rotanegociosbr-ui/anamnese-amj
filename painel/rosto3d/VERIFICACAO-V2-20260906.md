# Rosto 3D v2 — implantação de 06/09/2026

Escopo: refinamento da aparência, atlas existente, pontos com nome e observações
vinculados ao protocolo/consulta. A pasta v1 foi preservada.

## Como usar

Fotos e prontuários → paciente → consulta → Rosto 3D e pontos.
Marcar ponto → tocar na superfície → nome e observações → Salvar no prontuário.
A gravação exige conta proprietária, MFA e senha recente.
O modo isolado/local permite estudo genérico, mas não salva no prontuário.

## Verificações executadas

- 43 testes Node passaram: âncoras de superfície, nomes, texto, movimento, exclusão
  de ponto, salvamento/reabertura, falha de rede, limite de pontos, acesso e sessão,
  prontuário existente e proteção contra respostas tardias.
- 22 verificações da preparação passaram: integridade geométrica, UV, matrizes,
  seleção de camadas, proveniência, arquivos e hashes dos renders.
- 17 verificações HTTP locais passaram; arquivos, tipo de conteúdo e métodos.
- Deno check do novo endpoint passou.
- Teste SQL transacional passou: versão, repetição, conflito, proprietário,
  privilégios e histórico. ROLLBACK; zero pacientes sintéticos restantes.
- Endpoint implantado: sem sessão = 401; origem indevida = 403; preflight válido = 204.
- Advisor de segurança: sem WARN/ERROR na consulta realizada. INFO de RLS sem
  política em facial_studies é intencional: anon/authenticated não têm acesso;
  somente endpoint com verificação de clínica/proprietário/AAL2 e senha na escrita.
  Referência: https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy

## Arquitetura

Frontend estático na hospedagem GitHub Pages existente, sem tokens na URL do visor.
Edge Function rosto3d-fichas e migração 20260906170538_facial_studies_prontuario.
Revisões append-only, operação idempotente, lock por protocolo e conflito de versão.
Sem armazenamento local de conteúdo clínico nem envio a IA ou API paga nova.

## Limites da verificação e do modelo

Não houve inspeção/interação em navegador nem gravação autenticada de paciente real.
Renders offline não certificam o resultado WebGL, fluidez ou ergonomia no celular.
Cabeça externa MakeHuman e atlas Z-Anatomy são bases diferentes; nunca apresentados
como registro anatômico individual. Pontos pertencem à base onde foram marcados.
Revisão anatômica profissional e aprovação visual pela clínica ainda são necessárias.
O módulo não sugere dose, indicação, profundidade, zonas seguras ou conduta.
O acabamento é ilustrativo, não fotorealista.

## Recuperação

Versão antiga do visor mantida em painel/rosto3d/v1. Em falha de publicação,
reverter apenas o commit deste pacote após diagnóstico; não apagar facial_studies.
Revisões existentes precisam continuar preservadas, mesmo se o visor for desativado.

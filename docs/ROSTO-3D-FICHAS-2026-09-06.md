# Rosto 3D integrado ao Fichas — 06/09/2026

## Entrega

O visor deixou de depender do servidor local: integra o site existente, na rota
`/painel/`, pelo menu **Registro clínico → Rosto 3D** e pelo atalho
**Início → Comece uma tarefa → Rosto 3D**. No celular, abra **Mais** para ver o menu.
Nenhuma migração de banco, contratação, API paga ou alteração de prontuários.

O acesso no app reutiliza a identidade de proprietário retornada pelo backend,
sessão individual e a confirmação atual de MFA AAL2. Ana e Rodney, enquanto
owners ativos, usam o mesmo acesso. O frame não recebe tokens, fotos, nomes,
identificadores de pacientes ou qualquer dado do Supabase.

## Funcionalidades

- Aparência genérica: girar, aproximar, alternar pele, cabelo e olhos e cores.
- Musculatura: vista separada com 36 objetos de 18 famílias da fonte Z-Anatomy.
  Toque/clique em uma estrutura visível para destacar e exibir seu nome no
  próprio visor. A lista continua como alternativa de seleção.
- Marcação manual: estrutura ativa, nome e observação por ponto; até 100 pontos.
- Remodelagem ilustrativa da superfície, desfazer, comparar com o original.
- Exportar/reabrir estudo JSON com pontos, observações, cores e deformação.
- Trocar de aba pausa a GPU, mantendo o estudo na memória da sessão.
  Sair da conta remove o visor e seus dados da memória. Exporte antes de sair
  ou recarregar: não há salvamento automático, prontuário ou nuvem neste módulo.
- Falhas de inicialização permitem tentar novamente. Reiniciar um visor
  interrompido com alterações exige confirmação para evitar descarte silencioso.

## Limites e proteção

Modelo genérico, não anatomia da paciente. A musculatura é uma referência
separada, não uma subcamada registrada geometricamente no rosto MakeHuman.
Não determina aplicações, doses, profundidades, diagnósticos, condutas ou
previsões de resultado. Nomes traduzidos exigem revisão profissional.

GitHub Pages serve arquivos estáticos publicamente. Login/MFA restringem o
fluxo de entrada no app, não tornam os modelos genéricos secretos. Por isso,
nenhum dado de paciente é incluído nesses arquivos ou deve ser escrito nos
estudos. JSON exportado não é criptografado e não é prontuário.

## Fontes e preservação

Protótipo de origem: `05 - Fotos e Videos/Rosto 3D AMJ/2026-09-06/v3`.
Original preservado. Backup dos dois arquivos existentes alterados:
`08 - Backup/2026-09-06-fichas-rosto3d-pre-integracao`.

Somente runtime necessário copiado para `painel/rosto3d/v1/`.
MakeHuman CC0, Three.js MIT, fontes SIL OFL, derivados musculares CC BY-SA 4.0
com atribuições Z-Anatomy/BodyParts3D. Consulte `fontes.html` e `licencas/`
no módulo. Licença dos músculos não altera a titularidade da marca AMJ.

## Verificação

- Suite Node do painel: 69 testes/entradas aprovados, zero falhas.
- 12 testes novos: montagem inerte, proprietário/MFA, identidade divergente,
  cancelamento durante login/carregamento, troca de aba, descarte no logout,
  atividade do frame correto, recuperação de falha, recursos relativos e
  raycast real do Three.js com seleção do músculo mais próximo e visível.
- Regressão dos módulos existentes: testes de login, navegação, financeiro,
  prontuário, fotos, idempotência, CRM, acompanhamento e integrações.
- Referências de runtime presentes e geometrias com índices/vértices válidos.
  Aproximadamente 24,4 MB sem compressão; carregamento só ao abrir o 3D.
- Não realizado nesta entrega: teste visual em navegador autenticado,
  dispositivo móvel físico, validação clínica ou teste de desempenho em rede
  móvel. Os testes são locais/sintéticos e não comprovam esses itens.

Para conferir após publicar: abrir Fichas, atualizar a página, entrar com MFA,
abrir Rosto 3D, testar musculatura/toque e exportação. Sem dados reais de
pacientes nos estudos. A publicação deve ser verificada pelo commit do Pages e
pela disponibilidade HTTP dos arquivos, sem confundir isso com aceite visual.

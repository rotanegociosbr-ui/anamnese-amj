# App Fichas — revisão operacional de 6 de setembro de 2026

## Escopo e preservação

Correção do aplicativo existente. Novos recursos de foto/3D, reaproveitamento de formulários, site público e marketing ficaram fora desta publicação. A identidade visual da Ana Maria Jacob foi mantida.

A revisão foi isolada na branch `codex/amj-revisao-operacional-20260906`, a partir de `e03a90d`. Alterações não publicadas da pasta de trabalho anterior foram preservadas. Esta revisão de interface não executa migrações, exclusões, restaurações ou fusões de dados das pacientes.

## O que foi identificado e corrigido

| Problema identificado | Correção |
| --- | --- |
| Fotografias existentes em consultas arquivadas eram barradas pela validação de envio. | Hotfix anterior `e03a90d`, função `prontuario-fichas` v10: proprietários autenticados podem ler as fotos ativas do histórico arquivado, sem restaurar a consulta. |
| Falha de estoque/catálogo impedia abrir o histórico clínico. | Fontes independentes carregam separadamente. Histórico válido continua disponível; informação indisponível é sinalizada, sem inventar estoque zero. |
| Atualização malsucedida escondia listas já carregadas. | Cadastros, documentos, agenda, CRM e galeria preservam a leitura anterior na mesma sessão, com aviso de atualização pendente. |
| Lista de clientes parava na primeira página. | Carregamento paginado completo de clientes em Financeiro e Prontuários; páginas incompletas não substituem a lista anterior. |
| Uma atualização antiga podia sobrepor cadastro recém-salvo. | Versões e gerações protegem respostas já confirmadas pelo servidor. Falha na atualização não é confundida com falha do salvamento. |
| Resumo financeiro podia substituir a lista por apenas os últimos lançamentos. | Resumo e listagem completa têm estados independentes. |
| Atendimento salvo desaparecia visualmente quando o cliente não estava na lista auxiliar. | Atendimento permanece listado por seu vínculo histórico; edição preserva referências existentes. |
| Resposta atrasada podia interferir em outra sessão. | Respostas antigas são descartadas e o encerramento limpa os dados locais da sessão. |
| Menu plano e atalhos redundantes dificultavam encontrar o que já existe. | Menu organizado por assunto; clientes e prontuários destacados; atalhos repetidos removidos da Home, mantendo as funções. |
| Ações, campos e avisos dos prontuários usavam letras pequenas. | Tipografia ampliada, campos de 16 px, ações de 14–15 px e área de clique mínima de 44 px; espaçamento ajustado no celular e computador. |
| Atalho de parcelas levava a receitas avulsas. | Cobranças de procedimentos ganhou acesso próprio no menu e na Home. |
| Textos mencionavam nova senha mesmo sem pedir uma. | Cópia corrigida. Edição administrativa utiliza a sessão atual; ações destrutivas mantêm confirmação, sem nova senha. |

Não foram removidos autenticação de entrada, isolamento da clínica, auditoria, integridade de vínculos ou proteção contra duplicação acidental. Arquivamento continua sendo reversível, distinto de exclusão definitiva.

## Evidência sobre os registros relatados como ausentes

A consulta agregada e somente leitura encontrou 5 pacientes ativos, 6 anamneses ativas e 3 prontuários arquivados. Foram encontradas 15 fotos ativas vinculadas a esses prontuários, com os 15 originais e as 15 miniaturas presentes no armazenamento privado. Nenhum desses registros foi recriado para aparecer na interface.

Esses números comprovam a existência dos registros encontrados, não a completude de todo o histórico anterior da clínica. Não foi realizada alteração de dados reais para teste.

## Verificação da publicação

- Suíte completa local: 320 testes aprovados, nenhum reprovado, incluindo fluxos em navegador com dados sintéticos.
- Layout: 36 verificações, larguras 360, 390, 430 e 1366; sem erro de execução ou extravasamento identificado pelo teste.
- Revisão independente: geração de sessão, descarte de respostas antigas e acesso às rotas reorganizadas.
- Hotfix de leitura de fotos: 41 testes Deno aprovados; versão implantada conferida por leitura de retorno.
- Versões dos arquivos de interface atualizadas para evitar carregamento de JavaScript/CSS antigos.
- `painel/tests/verify-operational-publication.mjs` compara os oito arquivos publicados com o conteúdo local, normalizando somente quebras de linha.

Os logs finais, relatório de layout e evidência de publicação ficam na entrega local e na cópia do projeto em `E:\Clinica de Estetica\07 - Entregas`. Os testes são locais/sintéticos, não execução autenticada na sessão da Ana ou do Rodney. A sessão real não estava disponível para esta conferência; não se afirma que todos os fluxos reais do aplicativo foram comprovados em produção.

## Verificação de segurança antes/depois

Nenhum segredo foi colocado no navegador. Nenhuma tabela ou bucket foi tornado público. Falhas de autorização não são tratadas como simples falha de atualização para conservar acesso indevido. Não houve teste destrutivo com cadastro real.

## Reversão se houver regressão

Se esta versão impedir a abertura de cadastros anteriormente acessíveis, expuser dados entre sessões ou apresentar erro JavaScript no fluxo principal, interromper novas alterações e reverter exclusivamente o commit desta revisão por um novo commit, preservando o hotfix `e03a90d` e os dados. Não executar reset destrutivo, restauração indiscriminada do banco ou substituição da pasta com trabalho não publicado.

Não há monitoramento contínuo configurado por esta revisão, nem comprovação de quinze minutos de métricas autenticadas de produção. A verificação pós-publicação cobre o build e a igualdade dos arquivos servidos; falhas reais subsequentes exigem diagnóstico com contexto da operação.

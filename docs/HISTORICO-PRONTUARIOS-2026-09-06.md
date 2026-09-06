# Prontuários existentes: abertura e clareza

Base anterior preservada: `0fcabbc`. Data: 06/09/2026.

## Causas verificadas

1. A consulta agregada ao banco encontrou três registros de consulta, todos arquivados, nenhum ativo. Não houve evidência de exclusão desses registros. A API retorna arquivados, mas o filtro da tela os escondia por padrão.
2. Mesmo após incluir arquivados, a interface removia o botão de abrir os dados do registro. O histórico não deveria depender de restauração para ser lido.
3. Em Clientes, o botão chamado Prontuário iniciava uma consulta nova em vez de abrir o histórico da paciente.
4. A tela apresentava primeiro um formulário aberto de novo registro, deixando as consultas existentes abaixo. Menu, cabeçalho e atalhos usavam nomes diferentes.

## Correções desta entrega

- Prontuários e fotos fica no menu principal, após Clientes, com atalho na Home.
- A lista de consultas aparece antes do editor. O editor começa fechado; Novo registro é uma ação separada, que pede confirmação antes de descartar preenchimento existente.
- Consultas arquivadas são incluídas inicialmente, identificadas como arquivadas e podem ser abertas em modo somente leitura. O filtro pode ocultá-las, com aviso quando existirem registros ocultos.
- Abrir registro arquivado não restaura, edita, finaliza, altera consentimento nem permite enviar fotos. Os dados permanecem sob as permissões clínicas existentes.
- Ver prontuários em Clientes abre histórico por ID da paciente, não por nome. Nomes iguais não misturam prontuários; o filtro pode ser limpo explicitamente.
- Fichas e termos identifica anamnese e documentos; Prontuários e fotos identifica registros de consulta.

## Verificação

Suíte completa: 229 testes aprovados, zero falhas, cancelamentos ou testes ignorados. Duração: 43,34 segundos. Inclui cenário de zero consultas ativas e exatamente três arquivadas, todas abertas em desktop e celular sem qualquer restauração ou escrita.

Testes de navegador com registros preexistentes, no formato retornado pela API, em celular e computador: rascunho, concluído e arquivado, abertura pelo menu e pelos botões, campos clínicos e produtos/lotes, bloqueio de escrita em arquivados, nomes iguais e preservação de rascunhos. Não foram usados dados clínicos reais nos testes de escrita.

O diagnóstico de produção usou consultas agregadas de contagem, tipos e auditoria técnica; não houve restauração ou alteração de pacientes. As leituras recentes do backend estavam bem-sucedidas. A verificação automatizada não substitui a confirmação do usuário na sessão do notebook.

Resultado da suíte e hashes da publicação estão na pasta versionada da entrega. Para carregar a versão nova, salvar qualquer formulário em andamento antes de reabrir o app. Não há recarga forçada nem mudança de senha/MFA.

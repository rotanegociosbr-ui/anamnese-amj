# Correção urgente: fotos de prontuários arquivados

Data: 06/09/2026 (Brasil). Publicação Supabase: prontuario-fichas v10, ACTIVE.

## Evidência e causa

Leitura agregada do projeto rjxtxoqprnumouqakxbc: 5 pacientes ativos, 6 anamneses não arquivadas, 3 prontuários (todos arquivados) e 15 fotografias ativas vinculadas a esses prontuários. Os 15 caminhos de originais e as 15 miniaturas possuem objeto correspondente no bucket privado clinic-media. Esta contagem não comprova que nenhum registro tenha sido excluído em outra ocasião.

listar_fotos reutilizava a validação de envio de fotos, que negava também a leitura de uma consulta arquivada. A nova guarda separa leitura de envio, mantém a sessão administrativa da entrada e confirma o vínculo com a clínica. Não restaura nem altera prontuário para exibir fotografias ativas. Fotos individualmente arquivadas mantêm o tratamento anterior. Duas mensagens antigas que mencionavam senha adicional foram corrigidas; operações administrativas usam a sessão atual, não uma segunda senha.

## Verificação

41 testes Deno passaram, incluindo o handler real com respostas sintéticas para consulta arquivada, isolamento de clínica, sessão revogada, acesso sem login, leitura de URLs e ausência de gravação/restauração. A função publicada foi relida e seus três arquivos coincidem com o pacote enviado. Não houve alteração em pacientes, prontuários ou fotografias reais nesta correção. Nenhuma sessão autenticada do app estava disponível nas superfícies de navegador conectadas; a abertura visual no notebook do usuário não foi confirmada.

## Escopo e pendências conhecidas

Esta entrega corrige a galeria; não declara que todo o aplicativo foi revisado ou que não existam outras falhas. A carga inicial do histórico ainda depende de leituras auxiliares em Promise.all: falha de catálogos ou estoque pode impedir exibição. A lista de clientes pede apenas os primeiros 100 registros (há 5 nesta base). Existem mensagens legadas de senha em outras áreas, embora a confirmação atual não solicite senha por operação. Esses itens foram identificados, não corrigidos nesta publicação.

O novo editor fotográfico/3D e o reaproveitamento de anamnese do trabalho paralelo não foram publicados no frontend nesta correção. Seus arquivos locais permanecem preservados. A migração privada e as Edges daquela etapa já haviam sido publicadas antes do incidente.

## Recuperação

Backup da Edge anterior (v9) guardado na pasta da entrega, backup-edge/prontuario-fichas-v9.json. O backup é de código, não um backup integral do banco. Não reverter apagando tabelas ou arquivos clínicos.

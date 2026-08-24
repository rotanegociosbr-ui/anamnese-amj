'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const panelDir = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(panelDir, 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(panelDir, 'financeiro.js'), 'utf8');
const css = fs.readFileSync(path.join(panelDir, 'financeiro.css'), 'utf8');
const api = fs.readFileSync(path.join(panelDir, '..', 'supabase', 'functions', 'financeiro-fichas', 'index.ts'), 'utf8');
const prontuarioApi = fs.readFileSync(
  path.join(panelDir, '..', 'supabase', 'functions', 'prontuario-fichas', 'index.ts'),
  'utf8',
);
const prontuarioJs = fs.readFileSync(path.join(panelDir, 'prontuario.js'), 'utf8');
const prontuarioCss = fs.readFileSync(path.join(panelDir, 'prontuario.css'), 'utf8');
const costMigration = fs.readFileSync(
  path.join(
    panelDir,
    '..',
    'supabase',
    'migrations',
    '20260823234710_financeiro_crud_seguro_custos_cancelamento.sql',
  ),
  'utf8',
);
const prontuarioMigration = fs.readFileSync(
  path.join(
    panelDir,
    '..',
    'supabase',
    'migrations',
    '20260824010000_prontuario_fotos_produtos_seguros.sql',
  ),
  'utf8',
);
const costSeedMigration = fs.readFileSync(
  path.join(
    panelDir,
    '..',
    'supabase',
    'migrations',
    '20260824020000_catalogo_custos_reais_informados.sql',
  ),
  'utf8',
);
const dedupMigration = fs.readFileSync(
  path.join(
    panelDir,
    '..',
    'supabase',
    'migrations',
    '20260824025000_fonte_unica_deduplicacao_financeira.sql',
  ),
  'utf8',
);
const stockMigration = fs.readFileSync(
  path.join(
    panelDir,
    '..',
    'supabase',
    'migrations',
    '20260824030000_estoque_integrado_lotes_frete.sql',
  ),
  'utf8',
);
const operationMigration = fs.readFileSync(
  path.join(
    panelDir,
    '..',
    'supabase',
    'migrations',
    '20260824035000_atendimentos_retornos_rentabilidade.sql',
  ),
  'utf8',
);
const newMigrationSources = fs.readdirSync(path.join(panelDir, '..', 'supabase', 'migrations'))
  .filter(name => /^\d{14}_.*\.sql$/.test(name) && name.slice(0, 14) >= '20260823234710')
  .map(name => ({
    name,
    source: fs.readFileSync(path.join(panelDir, '..', 'supabase', 'migrations', name), 'utf8')
  }));

new vm.Script(js, { filename: 'financeiro.js' });
new vm.Script(prontuarioJs, { filename: 'prontuario.js' });

const parseMoneySource = js.match(/function parseMoney\(value\) \{[\s\S]*?\n  \}/);
assert(parseMoneySource, 'Função parseMoney ausente');
const parseMoney = vm.runInNewContext(`(${parseMoneySource[0]})`);
assert.equal(parseMoney('1.234'), 1234);
assert.equal(parseMoney('1.234,56'), 1234.56);
assert.equal(parseMoney('1234,56'), 1234.56);
assert.equal(parseMoney('1234.56'), 1234.56);
assert(Number.isNaN(parseMoney('12,345')), 'Não aceitar mais de duas casas decimais');
assert(Number.isNaN(parseMoney('1.2345')), 'Não arredondar silenciosamente dinheiro');
const roundMoneySource = js.match(/function roundMoney\(value\) \{[\s\S]*?\n  \}/);
assert(roundMoneySource, 'Função roundMoney ausente');
const roundMoney = vm.runInNewContext(`(${roundMoneySource[0]})`);
assert.equal(roundMoney(0.5 * 0.01) + roundMoney(0.5 * 0.01), 0.02);
const allocateSource = js.match(/function allocateInstallments\(value, count\) \{[\s\S]*?\n  \}/);
assert(allocateSource, 'Função allocateInstallments ausente');
const allocateInstallments = vm.runInNewContext(`(${allocateSource[0]})`);
assert.deepEqual(Array.from(allocateInstallments(1200, 3)), [400, 400, 400]);
const uneven = Array.from(allocateInstallments(1000, 3));
assert.equal(Math.round(uneven.reduce((sum, value) => sum + value, 0) * 100), 100000);
assert.deepEqual(uneven, [333.34, 333.33, 333.33]);
assert.match(js, /roundMoney\(item\.quantidade \* item\.valor_unitario\)/);
assert.match(js, /saoPauloCalendarParts\(\)/);
assert.match(js, /rawCost && !Number\.isFinite\(cost\)/);
assert.match(js, /rawSale && !Number\.isFinite\(sale\)/);
assert.match(js, /function renderRegistries\(\)/);
assert.match(js, /function submitService\(event\)/);
assert.match(js, /data-financeiro-atender/);
assert.match(js, /Paciente: /);
assert.match(js, /function clearSelectedCandidate\(message\)/);
assert.match(js, /function markCandidateForReconfirmation\(\)/);
assert.match(js, /financeiro-confirmar-vinculo/);
assert.match(js, /state\.selectedCandidate && !state\.candidateConfirmed/);
assert.match(js, /nova pesquisa foi iniciada/);
assert.match(js, /state\.generation \+= 1/);
assert.match(js, /state\.pendingRequests\.forEach/);
assert.match(js, /controller\.abort\(\)/);
assert.match(js, /generation !== state\.generation/);
assert.match(js, /panel\.querySelectorAll\('form'\)/);
assert.match(js, /financeiro-lista', 'financeiro-auditoria', 'financeiro-cliente-candidatos'/);
assert.match(js, /error\.status === 401 \|\| error\.status === 403/);
assert.doesNotMatch(js, /pagamento_id:[\s\S]{0,250}pago_em: new Date\(\)\.toISOString\(\)/);
assert.match(js, /row\.remove\(\);\s*clearIntent\('compra'\)/);

const entryViewSource = js.match(/function entryViewOf\(entry\) \{[\s\S]*?\n  \}/);
assert(entryViewSource, 'Classificação das visões financeiras ausente');
const entryViewOf = vm.runInNewContext(
  `(function (entryType, entryOrigin) { return ${entryViewSource[0]}; })`,
)(
  entry => entry.tipo,
  entry => entry.origem,
);
assert.equal(entryViewOf({ tipo: 'receita', origem: 'atendimento' }), 'procedimentos');
assert.equal(entryViewOf({ tipo: 'receita', origem: 'manual' }), 'receitas_avulsas');
assert.equal(entryViewOf({ tipo: 'despesa', origem: 'compra' }), 'despesas');
assert.match(js, /\['procedimentos', 'Procedimentos'\]/);
assert.match(js, /\['receitas_avulsas', 'Receitas avulsas'\]/);
assert.match(js, /data-financeiro-abrir-procedimentos/);
assert.match(js, /window\.AMJOperacaoClinica/);

const printSource = js.match(/function openAdministrativePrint\(entry\) \{[\s\S]*?\n  \}/);
assert(printSource, 'Documento administrativo para impressão/PDF ausente');
assert.match(printSource[0], /Resumo administrativo/);
assert.match(printSource[0], /não é nota fiscal nem recibo fiscal/);
assert.match(printSource[0], /Imprimir \/ Salvar como PDF/);
assert.match(printSource[0], /Compra \/ despesa/);
assert.match(printSource[0], /Frete da compra/);
assert.match(printSource[0], /Produtos e rateio do frete/);
assert.match(printSource[0], /custo_unitario_efetivo/);
assert.doesNotMatch(printSource[0], /\bcpf\b|anamnese|notas? cl[ií]nicas?/i);
assert.match(js, /Abrir resumo para imprimir\/PDF/);

const requiredIds = [
  'aba-bt-financeiro', 'aba-financeiro', 'financeiro-status', 'financeiro-grafico',
  'financeiro-form-atendimento', 'financeiro-atendimento-cliente',
  'financeiro-atendimento-procedimento', 'financeiro-atendimento-valor',
  'financeiro-atendimento-saldo', 'financeiro-atendimento-saldo-forma',
  'financeiro-atendimento-parcelas-lista',
  'financeiro-form-lancamento', 'financeiro-form-pagamento', 'financeiro-form-cliente',
  'financeiro-pagamento-parcela', 'financeiro-pagamento-parcelas-campo',
  'financeiro-editor-parcelas', 'financeiro-form-parcelas', 'financeiro-parcelas-lancamento',
  'financeiro-parcelas-forma', 'financeiro-parcelas-quantidade', 'financeiro-parcelas-lista',
  'financeiro-parcelas-saldo', 'financeiro-parcelas-status',
  'financeiro-form-fornecedor', 'financeiro-form-marca', 'financeiro-form-produto',
  'financeiro-form-compra', 'financeiro-compra-itens', 'financeiro-lista',
  'financeiro-editor-auditoria', 'financeiro-auditoria', 'financeiro-clientes-lista',
  'financeiro-fornecedores-lista', 'financeiro-produtos-lista',
  'financeiro-pendencias-estoque', 'financeiro-pendencias-contagem',
  'financeiro-cliente-nascimento', 'financeiro-cliente-emergencia',
  'financeiro-fornecedor-telefone', 'financeiro-fornecedor-email',
  'financeiro-produto-venda', 'financeiro-produto-estoque'
];
for (const id of requiredIds) {
  assert.match(html, new RegExp(`id=["']${id}["']`), `ID ausente: ${id}`);
}

assert.match(html, /<link href="\.\/financeiro\.css\?v=\d+-\d+" rel="stylesheet">/);
assert.match(html, /<script src="\.\/financeiro\.js\?v=\d+-\d+"><\/script>/);
assert.match(html, /<script src="\.\/prontuario\.js\?v=\d+-\d+"><\/script>/);
assert.match(html, /const abas = \[[^\]]*'fichas'[^\]]*'agenda'[^\]]*'prontuarios'[^\]]*'financeiro'[^\]]*\]/);
assert.match(html, /window\.AMJFinanceiro\.ativar\(\)/);
assert.match(html, /window\.AMJFinanceiro\.reset\(\)/);
assert.match(html, /window\.AMJFinanceiro\.atualizarAcesso\(\)/);

for (const action of [
  'resumo', 'listar_catalogos', 'listar_clientes', 'listar_lancamentos',
  'criar_lancamento', 'registrar_atendimento', 'registrar_pagamento', 'programar_parcelas',
  'sugerir_clientes', 'criar_cliente',
  'criar_fornecedor', 'criar_marca', 'criar_produto', 'criar_compra',
  'listar_estoque', 'listar_pendencias_estoque', 'regularizar_item_compra_estoque',
  'cancelar_lancamento', 'estornar_pagamento', 'cancelar_custo_produto', 'listar_auditoria'
]) {
  assert(js.includes(`'${action}'`), `Ação da API ausente na UI: ${action}`);
}

assert.match(js, /modoAcesso === 'auth'/);
assert.match(js, /identidadeBackend\.role[^\n]+owner/);
assert.doesNotMatch(js, /x-senha|hashSenha|localStorage|service_role|SUPABASE_SERVICE_ROLE/i);
assert.match(js, /cache: 'no-store'/);
assert.match(js, /referrerPolicy: 'no-referrer'/);
assert.match(js, /idempotency_key: intentKey\('lancamento'\)/);
assert.match(js, /idempotency_key: intentKey\('atendimento'\)/);
assert.match(js, /pagamento_idempotency_key:/);
assert.match(js, /idempotency_key: intentKey\('pagamento'\)/);
assert.match(js, /parcelas_previstas: planned/);
assert.match(js, /parcela_id: byId\('financeiro-pagamento-parcela'\)\.value \|\| null/);
assert.match(js, /const total = scheduled\.length/);
assert.match(api, /"installment_required"/);
assert.match(js, /function submitInstallmentSchedule\(event\)/);
assert.match(js, /data-financeiro-programar-parcelas/);
assert.match(js, /data-financeiro-pagar-parcela/);
assert.match(js, /forma_pagamento: method/);
assert.match(js, /actualCents === Math\.round\(Number\(expected\) \* 100\)/);
assert.match(js, /idempotency_key: intentKey\('compra'\)/);
assert.match(js, /Possível compra repetida/);
assert.match(js, /Confirmar compra distinta com senha/);
assert.match(js, /protectedCall\('criar_compra'/);
assert.match(js, /data-financeiro-abrir-compra-existente/);
assert.match(js, /resetIntentOnEdit/);
assert.match(js, /entryOrigin\(entry\) !== 'compra'/);
assert.match(js, /pagamento original/i);
assert.match(js, /item\.codigo/);
assert.match(js, /entry\.tipo/);
assert.match(js, /candidate\.origem_id/);
assert.match(js, /item\.ator/);
assert.match(html, /não informe cartão completo ou CVV/i);
assert.match(html, /Forma do valor recebido agora/);
assert.match(html, /Forma prevista para o saldo/);
assert.match(html, /Quantidade de parcelas do saldo/);
assert.match(html, /Parcelas desta transação/);
assert.doesNotMatch(html, /Parcelas no cartão/);
for (const productType of ['bioestimulador', 'toxina_botulinica', 'preenchedor', 'skinbooster']) {
  assert.match(html, new RegExp(`value=["']${productType}["']`), `Tipo de produto ausente: ${productType}`);
  assert(api.includes(`"${productType}"`), `Tipo de produto ausente na API: ${productType}`);
}
assert.match(api, /async function handleRegisterService\(/);
assert.match(api, /case "registrar_atendimento":/);
assert.match(api, /financeiro_criar_lancamento/);
assert.match(api, /financeiro_registrar_pagamento/);
assert.match(api, /T12:00:00-03:00/);
assert.match(api, /purchase_stock_already_consumed/);
assert.match(api, /stock_product_configuration_locked/);
assert.match(api, /stock_product_has_balance/);
assert.match(api, /patient_name:/);
assert.match(api, /supplier_name:/);
assert.match(api, /async function purchasesForEntries\(/);
assert.match(api, /async function purchaseDuplicateCandidate\(/);
assert.match(api, /"purchase_possible_duplicate"/);
assert.match(api, /"confirmar_compra_distinta"/);
assert.match(api, /requiredUuid\(payload\.compra_duplicada_id/);
assert.match(api, /async function attendancesForEntries\(/);
assert.match(api, /Promise\.all\(\[/);
assert.match(api, /case "cancelar_custo_produto":/);
assert.doesNotMatch(html, /name=["'](?:card_number|cvv|pin|senha_bancaria)["']/i);

// Custos financeiros são eventos imutáveis. Um lançamento incorreto é
// cancelado por evento compensatório protegido, nunca por DELETE.
assert.match(costMigration, /create table public\.financeiro_produto_custo_cancelamentos/);
assert.match(costMigration, /before update or delete on public\.financeiro_produto_custo_cancelamentos/);
assert.match(costMigration, /alter table public\.financeiro_produto_custo_cancelamentos enable row level security/);
assert.match(costMigration, /revoke all on public\.financeiro_produto_custo_cancelamentos[\s\S]{0,160}from public, anon, authenticated, service_role/);
assert.match(costMigration, /grant select, insert on public\.financeiro_produto_custo_cancelamentos to service_role/);
assert.match(costMigration, /create or replace function public\.financeiro_cancelar_custo_produto/);
assert.match(costMigration, /grant execute on function public\.financeiro_cancelar_custo_produto[\s\S]{0,160}to service_role/);
assert.match(costMigration, /pg_advisory_xact_lock[\s\S]{0,500}produto_custo/);
assert.match(js, /data-financeiro-cancelar-custo/);
assert.match(js, /protectedCall\('cancelar_custo_produto'/);
assert.match(costSeedMigration, /v_seed_exists := false/);
assert.match(costSeedMigration, /and not v_seed_exists/);
assert.match(costSeedMigration, /seed-cost-20260823/);
assert.match(dedupMigration, /create table public\.clinic_duplicate_reviews/);
assert.match(dedupMigration, /strong-phone:/);
assert.match(dedupMigration, /strong-email:/);
assert.match(dedupMigration, /provider_reference/);
assert.match(dedupMigration, /'foto_clinica'/);

// Fotos clínicas permanecem no bucket privado e são apenas arquivadas. A
// restauração exige a rota protegida e consentimento clínico vigente.
const removePhotoSql = prontuarioMigration.match(
  /create or replace function public\.prontuario_remover_foto\([\s\S]*?\n\$function\$;/,
);
assert(removePhotoSql, 'RPC de arquivamento de foto ausente');
assert.doesNotMatch(removePhotoSql[0], /delete\s+from\s+public\.protocol_photos/i);
assert.match(removePhotoSql[0], /set archived_at = now\(\)/);
assert.match(removePhotoSql[0], /'hard_delete', false/);
assert.match(prontuarioMigration, /create or replace function public\.prontuario_restaurar_foto/);
assert.match(prontuarioMigration, /kind = 'clinical_photography'/);
assert.match(prontuarioMigration, /bucket_id = 'clinic-media'/);
assert.match(prontuarioMigration, /clinic_media_edge_only_guard/);
assert.match(prontuarioMigration, /before insert or update or delete on public\.protocol_photos/);
assert.match(prontuarioMigration, /protocol_photo_delete_forbidden/);
assert.match(prontuarioMigration, /phase in \('before', 'during', 'after', 'products_used'\)/);
assert.match(prontuarioMigration, /thumbnail_storage_path/);
assert.match(prontuarioMigration, /size_bytes is null or size_bytes between 1 and 26214400/);
assert.match(prontuarioMigration, /file_size_limit[\s\S]{0,100}26214400/);
assert.match(prontuarioMigration, /create or replace view public\.protocol_photo_counts/);
assert.match(prontuarioMigration, /photo_product_context_invalid/);
assert.doesNotMatch(prontuarioMigration, /unique[^\n]*protocol[^\n]*phase/i);
assert.match(prontuarioApi, /case "restaurar_foto":/);
assert.match(prontuarioApi, /"prontuario\.photo\.restore"/);
assert.match(prontuarioApi, /case "listar_fotos":/);
assert.match(prontuarioApi, /pageSize \+ 1/);
assert.match(prontuarioApi, /miniatura_url/);
assert.match(prontuarioApi, /MAX_IMAGE_BYTES = 25 \* 1024 \* 1024/);
assert.match(prontuarioApi, /p_thumbnail_storage_path: thumbnailPath/);
assert.match(prontuarioApi, /p_product_id: productId/);
assert.match(prontuarioApi, /case "vincular_foto_operacao":/);
assert.doesNotMatch(prontuarioApi, /protocol_photos\?[^\n]*limit=5000/);
assert.match(prontuarioJs, /products_used: 'Produtos utilizados'/);
assert.match(prontuarioJs, /function createPhotoThumbnail\(file\)/);
assert.match(prontuarioJs, /25 \* 1024 \* 1024/);
assert.match(prontuarioJs, /data\.append\('miniatura'/);
assert.match(prontuarioJs, /data\.append\('produto_id'/);
assert.match(prontuarioJs, /jsonRequest\(API, 'listar_fotos'/);
assert.match(prontuarioJs, /por_pagina: 12/);
assert.match(prontuarioJs, /loading="lazy" decoding="async"/);
assert.match(prontuarioJs, /vincularFotoOperacao: linkPhotoOperation/);
assert.match(prontuarioCss, /\.prontuario-fotos-controles/);
assert.match(operationMigration, /protocol_photos_attendance_id_fkey/);
assert.match(operationMigration, /protocol_photos_procedure_item_id_fkey/);
assert.match(operationMigration, /create or replace function public\.prontuario_vincular_foto_operacao/);
const removePhotoApi = prontuarioApi.match(/async function handleRemovePhoto\([\s\S]*?\n\}/);
assert(removePhotoApi, 'Handler de arquivamento de foto ausente');
assert.doesNotMatch(removePhotoApi[0], /deletePrivateImage/);

// COALESCE/NULLIF/GREATEST/LEAST são formas especiais da gramática SQL e não
// podem ser qualificadas como se fossem funções de pg_catalog.
assert.doesNotMatch(stockMigration, /pg_catalog\.(?:coalesce|nullif|greatest|least)\s*\(/i);
for (const migration of newMigrationSources) {
  assert.doesNotMatch(
    migration.source,
    /pg_catalog\.(?:coalesce|nullif|greatest|least)\s*\(/i,
    `Forma especial SQL qualificada incorretamente em ${migration.name}`,
  );
}
// O frete é rateado em centavos pelo método do maior resto, com desempate pela
// posição. Linhas de subtotal zero nunca recebem os centavos residuais.
assert.match(stockMigration, /freight_remainder_fraction/);
assert.match(stockMigration, /freight_remainder_rank <= freight_remaining_cents/);
assert.match(stockMigration, /when line_total > 0[\s\S]{0,180}freight_remainder_rank/);
// Cancelamento e baixa concorrente usam o mesmo lock; consumo posterior ativo
// bloqueia o estorno pelo custo original em vez de corromper o valor do estoque.
assert.match(stockMigration, /pg_advisory_xact_lock[\s\S]{0,1600}stock_purchase_consumed/);
assert.match(stockMigration, /movement_kind = 'saida_procedimento'[\s\S]{0,500}reversal_of_id = consumption\.id/);
assert.match(stockMigration, /p_unit is distinct from v_row\.unit/);
assert.match(stockMigration, /p_stock_control is distinct from v_row\.stock_control/);
assert.match(stockMigration, /balance\.quantity_balance > 0/);
assert.match(stockMigration, /on conflict \(clinic_id, cost_id\) do nothing/);
assert.match(stockMigration, /freight_amount/);
assert.match(stockMigration, /landed_unit_cost/);
assert.match(stockMigration, /purchase_exact_duplicate/);
assert.match(stockMigration, /purchase_possible_duplicate/);
assert.match(stockMigration, /p_confirm_distinct boolean default false/);
assert.match(stockMigration, /confirmed_distinct_purchase_without_document/);
assert.match(api, /frete_rateado: numberFrom\(item\.allocated_freight\)/);
assert.match(api, /custo_unitario_efetivo: numberFrom\(item\.landed_unit_cost\)/);
assert.match(js, /Subtotal[\s\S]{0,120}frete[\s\S]{0,120}total/);
assert.match(
  stockMigration,
  /revoke all on function public\.financeiro_editar_produto[\s\S]{0,350}from public, anon, authenticated, service_role/,
);

assert(css.includes('.financeiro-kpis'));
assert(css.includes('@media(max-width:640px)'));
assert(css.includes('.financeiro-grafico'));
assert(css.includes('.financeiro-parcela-linha'));
assert(css.includes('.financeiro-parcelas-resumo'));

const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]);
const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
assert.deepEqual([...new Set(duplicates)], [], `IDs duplicados: ${duplicates.join(', ')}`);

console.log('OK: Financeiro owner+AAL2, formulários, indicadores, compras e ações auditáveis.');

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const panelDir = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(panelDir, 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(panelDir, 'financeiro.js'), 'utf8');
const css = fs.readFileSync(path.join(panelDir, 'financeiro.css'), 'utf8');

new vm.Script(js, { filename: 'financeiro.js' });

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
assert.match(js, /roundMoney\(item\.quantidade \* item\.valor_unitario\)/);
assert.match(js, /saoPauloCalendarParts\(\)/);
assert.match(js, /rawCost && !Number\.isFinite\(cost\)/);
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

const requiredIds = [
  'aba-bt-financeiro', 'aba-financeiro', 'financeiro-status', 'financeiro-grafico',
  'financeiro-form-lancamento', 'financeiro-form-pagamento', 'financeiro-form-cliente',
  'financeiro-form-fornecedor', 'financeiro-form-marca', 'financeiro-form-produto',
  'financeiro-form-compra', 'financeiro-compra-itens', 'financeiro-lista',
  'financeiro-editor-auditoria', 'financeiro-auditoria'
];
for (const id of requiredIds) {
  assert.match(html, new RegExp(`id=["']${id}["']`), `ID ausente: ${id}`);
}

assert.match(html, /<link href="\.\/financeiro\.css" rel="stylesheet">/);
assert.match(html, /<script src="\.\/financeiro\.js"><\/script>\s*<script>/);
assert.match(html, /const abas = \['fichas', 'agenda', 'financeiro'\]/);
assert.match(html, /window\.AMJFinanceiro\.ativar\(\)/);
assert.match(html, /window\.AMJFinanceiro\.reset\(\)/);
assert.match(html, /window\.AMJFinanceiro\.atualizarAcesso\(\)/);

for (const action of [
  'resumo', 'listar_catalogos', 'listar_clientes', 'listar_lancamentos',
  'criar_lancamento', 'registrar_pagamento', 'sugerir_clientes', 'criar_cliente',
  'criar_fornecedor', 'criar_marca', 'criar_produto', 'criar_compra',
  'cancelar_lancamento', 'estornar_pagamento', 'listar_auditoria'
]) {
  assert(js.includes(`'${action}'`), `Ação da API ausente na UI: ${action}`);
}

assert.match(js, /modoAcesso === 'auth'/);
assert.match(js, /identidadeBackend\.role[^\n]+owner/);
assert.doesNotMatch(js, /x-senha|hashSenha|localStorage|service_role|SUPABASE_SERVICE_ROLE/i);
assert.match(js, /cache: 'no-store'/);
assert.match(js, /referrerPolicy: 'no-referrer'/);
assert.match(js, /idempotency_key: intentKey\('lancamento'\)/);
assert.match(js, /idempotency_key: intentKey\('pagamento'\)/);
assert.match(js, /idempotency_key: intentKey\('compra'\)/);
assert.match(js, /resetIntentOnEdit/);
assert.match(js, /entryOrigin\(entry\) !== 'compra'/);
assert.match(js, /pagamento original/i);
assert.match(js, /item\.codigo/);
assert.match(js, /entry\.tipo/);
assert.match(js, /candidate\.origem_id/);
assert.match(js, /item\.ator/);
assert.match(html, /não informe cartão completo ou CVV/i);
assert.doesNotMatch(html, /name=["'](?:card_number|cvv|pin|senha_bancaria)["']/i);

assert(css.includes('.financeiro-kpis'));
assert(css.includes('@media(max-width:640px)'));
assert(css.includes('.financeiro-grafico'));

const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]);
const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
assert.deepEqual([...new Set(duplicates)], [], `IDs duplicados: ${duplicates.join(', ')}`);

console.log('OK: Financeiro owner+AAL2, formulários, indicadores, compras e ações auditáveis.');

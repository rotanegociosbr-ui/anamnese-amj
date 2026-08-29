'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const panel = path.resolve(__dirname, '..');
const js = fs.readFileSync(path.join(panel, 'integracoes.js'), 'utf8');
const css = fs.readFileSync(path.join(panel, 'integracoes.css'), 'utf8');
const shell = fs.readFileSync(path.join(panel, 'app-shell.js'), 'utf8');
const html = fs.readFileSync(path.join(panel, 'index.html'), 'utf8');

assert.match(js, /functions\/v1\/integracoes-fichas/,
  'a Central deve consultar apenas a Edge Function privada da Fase 5A');
assert.match(js, /cabecalhosAcesso\(true\)/,
  'a consulta deve exigir a conta individual com MFA');
assert.match(js, /body: JSON\.stringify\(\{ acao: 'status' \}\)/,
  'a UI deve enviar somente a ação de status');
assert.match(js, /method: 'POST', headers: headers, cache: 'no-store', referrerPolicy: 'no-referrer'/,
  'a consulta deve ser privada e sem cache ou referrer');
assert.match(js, /new AbortController\(\)[\s\S]*?state\.generation/,
  'a Central deve cancelar ou invalidar respostas de sessão antiga');
assert.match(js, /state\.controller\.abort\(\)/,
  'logout deve cancelar a consulta em andamento');
assert.match(js, /function requestIsCurrent\(generation, controller\)[\s\S]*generation === state\.generation[\s\S]*controller === state\.controller/,
  'a resposta só pode alterar a sessão que iniciou a consulta');
assert.match(js, /catch \(error\)[\s\S]*!requestIsCurrent\(generation, controller\)[\s\S]*finally[\s\S]*if \(requestIsCurrent\(generation, controller\)\)/,
  'catch e finally devem ignorar consultas de sessão antiga');

for (const title of ['Formulários do site', 'WhatsApp oficial', 'Calendário', 'Pagamentos online', 'Outras APIs']) {
  assert.ok(js.includes(title), 'cartão ausente: ' + title);
}
for (const safeState of ['Desativado', 'Não verificado', 'Sem conexão externa']) {
  assert.ok(js.includes(safeState), 'estado seguro ausente: ' + safeState);
}
assert.match(js, /Os formulários e páginas atuais permanecem como estão/,
  'a Central deve afirmar que o site atual continua funcionando');
assert.match(js, /Sem cobrança e sem ativação/,
  'a tela deve explicar claramente que não existe cobrança');
assert.match(js, /data-integracoes-atualizar>Atualizar status/,
  'Atualizar status deve ser a única ação disponível');
assert.doesNotMatch(js, /data-integracoes-(?:conectar|testar|enviar|sincronizar|autorizar|cobrar)/i,
  'a Fase 5A não pode oferecer ações externas');
assert.doesNotMatch(js, /window\.open\(|wa\.me|googleapis\.com|graph\.facebook\.com|stripe\.com|mercadopago/i,
  'a UI não pode chamar ou abrir provedores externos');
assert.match(js, /operation: SAFE_STATE\.operation[\s\S]*verification: SAFE_STATE\.verification[\s\S]*connection: SAFE_STATE\.connection/,
  'o normalizador deve impor o fallback seguro, independentemente da resposta');

assert.match(shell, /integracoes: Object\.freeze\(\{ title: 'Integrações', legacy: 'integracoes', owner: true/,
  'a rota deve ser exclusiva dos proprietários');
assert.match(shell, /global: 'AMJIntegracoes'[\s\S]*src: '\.\/integracoes\.js\?v=[\s\S]*css: '\.\/integracoes\.css\?v=/,
  'JavaScript e CSS devem ser carregados somente ao abrir a rota');
assert.match(html, /id="aba-bt-integracoes"[\s\S]*aria-controls="aba-integracoes"[\s\S]*hidden/,
  'a aba legada deve nascer escondida');
assert.match(html, /id="aba-integracoes"[\s\S]*id="integracoes-root"/,
  'o painel deve expor somente o ponto de montagem lazy');
assert.doesNotMatch(html, /<script[^>]+integracoes\.js|<link[^>]+integracoes\.css/i,
  'o módulo não pode entrar no carregamento inicial');
assert.match(html, /const abas = \[[^\]]*'integracoes'/,
  'o ativador legado deve conhecer a nova aba');
assert.match(html, /aba-bt-integracoes'[\s\S]*agendaAtivarAba\('integracoes'/,
  'o clique legado deve abrir a nova aba');
assert.match(html, /const disponiveis = \[[^\]]*'integracoes'/,
  'a navegação por teclado deve alcançar a Central');
assert.match(html, /AMJIntegracoes\.atualizarAcesso\(\)/,
  'mudança de identidade deve recalcular o acesso');
assert.match(html, /AMJIntegracoes\.reset\(\)/,
  'logout deve limpar a Central');

assert.match(css, /grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/,
  'desktop deve usar cartões em duas colunas');
assert.match(css, /@media\(max-width:840px\)[\s\S]*grid-template-columns:1fr/,
  'celular e notebook estreito devem usar uma coluna');
assert.match(css, /@media\(max-width:430\.98px\)/,
  'a tela deve possuir ajuste específico para celulares pequenos');
assert.match(css, /min-height:44px/,
  'o botão deve manter alvo de toque acessível');
assert.doesNotMatch(css, /outline:none|min-width:\s*(?:8|9)\d{2}px/,
  'o layout não pode remover foco nem exigir largura fixa grande');

const sandbox = { window: {}, document: {}, Intl, Date, Set, AbortController, console };
vm.runInNewContext(js, sandbox, { filename: 'integracoes.js' });
const runtime = sandbox.window.AMJIntegracoes.__test;
const rows = runtime.normalizeIntegrations({ ok: true, integracoes: [
  { id: 'site_futuro', state: 'enabled', enabled: true, verified: true, external_calls_allowed: true },
  { id: 'whatsapp_oficial', state: 'disabled', enabled: false, verified: false, external_calls_allowed: false },
  { id: 'calendario' }, { id: 'pagamentos_online' }, { id: 'outras_apis' }
] });
assert.equal(rows.length, 5);
assert.deepEqual(Array.from(rows, function (row) { return row.key; }),
  ['site', 'whatsapp', 'calendario', 'pagamentos', 'outras_apis']);
for (const row of rows) {
  assert.equal(row.operation, 'Desativado');
  assert.equal(row.verification, 'Não verificado');
  assert.equal(row.connection, 'Sem conexão externa');
  assert.equal(row.registered, true);
}
const fallback = runtime.normalizeIntegrations({ erro: 'indisponível' });
assert.equal(fallback.length, 5);
assert.ok(fallback.every(function (row) { return row.operation === 'Desativado' && !row.registered; }));

assert.equal(runtime.requestIsCurrent(0, null), true);
sandbox.window.AMJIntegracoes.reset();
assert.equal(runtime.requestIsCurrent(0, null), false,
  'logout/relogin deve invalidar a consulta antiga antes que ela altere a nova sessão');
assert.equal(runtime.requestIsCurrent(1, {}), false,
  'controller antigo não pode concluir uma nova consulta');

console.log('fase5-integracoes-ui.test.cjs: leitura segura, rota lazy, owner-only e mobile OK');

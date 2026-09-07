'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const financeSource = fs.readFileSync(path.resolve(__dirname, '../financeiro.js'), 'utf8');
const shellSource = fs.readFileSync(path.resolve(__dirname, '../app-shell.js'), 'utf8');
const patientId = '11111111-1111-4111-8111-111111111111';
function clickHarness(historyApi) {
  const calls = [], messages = [];
  const currentDraft = { id: 'existing-draft', note: 'Anotação ainda não salva' };
  let listener;
  const context = {
    window: { AMJProntuario: {
      abrirHistoricoPaciente: historyApi ? async id => { calls.push(id); return historyApi(id); } : undefined,
      novoParaPaciente() { currentDraft.id = ''; currentDraft.note = ''; throw Error('Must not create a consultation'); }
    } },
    byId() { return { closest() { return { addEventListener(_event, callback) { listener = callback; } }; } }; },
    status(id, message, error) { messages.push({ id, message, error }); }
  };
  const start = financeSource.indexOf("    byId('financeiro-cadastros-titulo').closest('.financeiro-cadastros-card').addEventListener");
  const end = financeSource.indexOf("    byId('financeiro-clientes-lista').addEventListener", start);
  assert(start >= 0 && end > start);
  vm.runInNewContext(financeSource.slice(start, end), context);
  const button = { dataset: { financeiroProntuario: patientId } };
  const click = () => listener({ target: { closest: selector => selector === '[data-financeiro-prontuario]' ? button : null } });
  return { click, calls, messages, currentDraft };
}

test('client history button calls only the history API and does not clear an existing unsaved draft', async () => {
  const h = clickHarness(async () => true);
  await h.click();
  assert.deepEqual(h.calls, [patientId]);
  assert.deepEqual(h.currentDraft, { id: 'existing-draft', note: 'Anotação ainda não salva' });
  assert.equal(h.messages.length, 0);
  assert.match(financeSource, /data-financeiro-prontuario=[\s\S]{0,100}>Ver prontuários<\/button>/);
});

test('an unavailable history API reports a visible error and never falls back to a new consultation', async () => {
  const h = clickHarness();
  await h.click();
  assert.equal(h.calls.length, 0);
  assert.equal(h.currentDraft.note, 'Anotação ainda não salva');
  assert.equal(h.messages.length, 1);
  assert.equal(h.messages[0].error, true);
});

test('an archived client keeps a read-only history entry without enabling a new attendance', () => {
  const start = financeSource.indexOf("    byId('financeiro-clientes-lista').innerHTML = clients.length ? clients.map");
  const end = financeSource.indexOf("    byId('financeiro-fornecedores-lista').innerHTML", start);
  assert(start >= 0 && end > start);
  const target = { innerHTML: '' };
  vm.runInNewContext(financeSource.slice(start, end), {
    clients: [{ id: patientId, nome: 'Paciente de teste arquivada', arquivado_em: '2026-09-01' }],
    byId: () => target,
    isArchived: item => Boolean(item.arquivado_em),
    escapeHtml: value => String(value),
    safeDate: value => value
  });
  assert.match(target.innerHTML, /data-financeiro-prontuario=/);
  assert.match(target.innerHTML, />Ver prontuários<\/button>/);
  assert.doesNotMatch(target.innerHTML, /data-financeiro-atender=/);
});

test('history navigation failure is surfaced without changing the current draft', async () => {
  const h = clickHarness(async () => { throw Error('Falha sintética ao abrir histórico'); });
  await h.click();
  assert.deepEqual(h.calls, [patientId]);
  assert.match(h.messages[0].message, /Falha sintética/);
  assert.equal(h.currentDraft.note, 'Anotação ainda não salva');
});

test('canonical history stays owner-only, follows Clientes, and is not duplicated in secondary navigation', () => {
  const start = shellSource.indexOf('  const ROUTES = Object.freeze(');
  const end = shellSource.indexOf('  const STORAGE_ROUTE', start);
  const context = {};
  vm.runInNewContext(shellSource.slice(start, end) + '\nthis.navigation={ROUTES,NAV_GROUPS};', context);
  const { ROUTES, NAV_GROUPS } = context.navigation;
  const PRIMARY_ORDER = NAV_GROUPS[0].routes;
  assert.equal(ROUTES.prontuarios.title, 'Prontuários e fotos');
  assert.equal(ROUTES.prontuarios.owner, true);
  assert.equal(ROUTES.prontuarios.legacy, 'prontuarios');
  assert.equal(ROUTES.fichas.title, 'Fichas e termos');
  assert.equal(PRIMARY_ORDER[PRIMARY_ORDER.indexOf('clientes') + 1], 'prontuarios');
  const allRoutes = NAV_GROUPS.flatMap(group => group.routes);
  assert.equal(allRoutes.filter(route => route === 'prontuarios').length, 1);
  assert.equal(new Set(allRoutes).size, allRoutes.length, 'cada área aparece uma vez no menu');
  assert.deepEqual(Array.from(allRoutes).sort(), Object.keys(ROUTES).sort(), 'nenhuma área existente fica inacessível');
  assert.match(shellSource, /data-shell-route="prontuarios">Prontuários e fotos<\/button>/);
  assert.match(shellSource, /navButton\('inicio', true\) \+ navButton\('clientes', true\) \+ navButton\('prontuarios', true\) \+ navButton\('agenda', true\)/);
});

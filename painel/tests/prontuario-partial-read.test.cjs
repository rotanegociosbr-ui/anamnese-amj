'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), crypto = require('node:crypto');
const source = fs.readFileSync(path.resolve(__dirname, '../prontuario.js'), 'utf8');
const protocol = (id = 'synthetic-protocol', version = 1) => ({ id, patient_id: 'synthetic-patient', paciente: { nome: 'Paciente sintética' }, version, status: 'draft', produtos: [{ product_id: 'synthetic-product', product_name_snapshot: 'Produto histórico sintético', lot: 'LOTE HISTÓRICO', expiry: '2027-01-31', amount: 1, unit: 'un' }] });
const response = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { resolve, promise }; };
const flush = () => new Promise(resolve => setImmediate(resolve));
function harness() {
  const nodes = new Map(), calls = [];
  function node(id) {
    if (!nodes.has(id)) nodes.set(id, { value: '', checked: false, textContent: '', innerHTML: '', options: [], dataset: {}, attributes: {},
      classList: { toggle() {}, add() {}, remove() {} }, querySelectorAll: () => [], setAttribute(k, v) { this.attributes[k] = String(v); }, getAttribute(k) { return this.attributes[k]; } });
    return nodes.get(id);
  }
  const fail = new Map(); let rows = [protocol()], patients = [{ id: 'synthetic-patient', nome: 'Paciente sintética' }];
  const sandbox = { window: { crypto }, document: { readyState: 'loading', addEventListener() {}, getElementById: node, querySelectorAll: () => [] },
    modoAcesso: 'auth', identidadeBackend: { role: 'owner' }, cabecalhosAcesso: async () => ({}), Intl, Date, URL, console,
    fetch: async (url, options) => {
      const body = JSON.parse(options.body); calls.push(body);
      if (fail.has(body.acao)) return response({ erro: 'Falha sintética', codigo: fail.get(body.acao).code }, fail.get(body.acao).status);
      if (body.acao === 'listar') return response({ protocolos: rows.slice((body.pagina - 1) * 100, body.pagina * 100), paginacao: { pagina: body.pagina, tem_mais: rows.length > body.pagina * 100 } });
      if (body.acao === 'listar_clientes') return response({ clientes: patients.slice((body.pagina - 1) * 100, body.pagina * 100), paginacao: { pagina: body.pagina, tem_mais: patients.length > body.pagina * 100 } });
      if (body.acao === 'listar_catalogos') return response({ marcas: [], produtos: [{ id: 'synthetic-product', nome: 'Produto sintético', controla_estoque: true, unidade: 'un' }] });
      if (body.acao === 'listar_estoque') return response({ estoque: [{ produto_id: 'synthetic-product', lote: 'LOTE ATUAL', validade: '2028-01-31', saldo: 5 }] });
      return response({ fotos: [], paginacao: { pagina: 1, tem_mais: false } });
    }
  };
  vm.runInNewContext(source.replace('  window.AMJProntuario = {', '  window.partialReads = { state, load, loadPhotos, inventoryForProduct, productName, syncProductStock, protocolNeedsRefresh };\n  window.AMJProntuario = {'), sandbox);
  return { ...sandbox.window.partialReads, sandbox, node, calls, fail, setRows(value) { rows = value; }, setPatients(value) { patients = value; } };
}

const patientRows = count => Array.from({ length: count }, (_, i) => ({ id: 'synthetic-patient-' + i, nome: 'Cliente sintético ' + i }));
test('all 205 clients are read in pages of 100, including archived records', async () => {
  const h = harness(); h.setPatients(patientRows(205));
  assert.equal(await h.load(), true); assert.equal(h.state.patients.length, 205);
  assert.equal(new Set(h.state.patients.map(patient => patient.id)).size, 205);
  assert.equal(h.state.patients[204].id, 'synthetic-patient-204');
  const calls = h.calls.filter(call => call.acao === 'listar_clientes');
  assert.deepEqual(calls.map(call => call.pagina), [1, 2, 3]);
  assert(calls.every(call => call.por_pagina === 100 && call.incluir_arquivados === true));
});

test('client page two failure preserves the entire old client cache while clinical history updates', async () => {
  const h = harness(); await h.load(); const previous = h.state.patients, fetch = h.sandbox.fetch;
  h.setPatients(patientRows(205)); h.setRows([protocol('updated-clinical-history')]);
  h.sandbox.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    if (body.acao === 'listar_clientes' && body.pagina === 2) { h.calls.push(body); return response({ erro: 'Página de clientes indisponível' }, 503); }
    return fetch(url, options);
  };
  assert.equal(await h.load(), true); assert.equal(h.state.patients, previous);
  assert.equal(h.state.protocols[0].id, 'updated-clinical-history');
  assert.match(h.node('prontuario-status').textContent, /Não foi possível atualizar: clientes/);
  assert.deepEqual(h.calls.filter(call => call.acao === 'listar_clientes').map(call => call.pagina), [1, 1, 2]);
});

for (const hasMore of [true, false]) test('repeated client page cannot replace the complete cache, tem_mais=' + hasMore, async () => {
  const h = harness(); await h.load(); const previous = h.state.patients, fetch = h.sandbox.fetch;
  h.setPatients(patientRows(205));
  h.sandbox.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    if (body.acao === 'listar_clientes' && body.pagina === 2) {
      h.calls.push(body); return response({ clientes: patientRows(100), paginacao: { pagina: 2, tem_mais: hasMore } });
    }
    return fetch(url, options);
  };
  assert.equal(await h.load(), true); assert.equal(h.state.patients, previous);
  assert.deepEqual(h.calls.filter(call => call.acao === 'listar_clientes').map(call => call.pagina), [1, 1, 2]);
  assert.match(h.node('prontuario-status').textContent, /Não foi possível atualizar: clientes/);
});

test('logout during client pagination cannot fetch another page or restore the previous session cache', async () => {
  const h = harness(); await h.load(); h.setPatients(patientRows(205));
  const pending = deferred(), fetch = h.sandbox.fetch;
  h.sandbox.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    if (body.acao === 'listar_clientes' && body.pagina === 2) { h.calls.push(body); return pending.promise; }
    return fetch(url, options);
  };
  const loading = h.load(); await flush();
  h.state.generation++; h.state.loading = false; h.state.loaded = false;
  h.state.patients = []; h.state.protocols = []; h.sandbox.modoAcesso = 'none';
  h.node('prontuario-status').textContent = 'Sessão encerrada';
  pending.resolve(response({ clientes: patientRows(205).slice(100, 200), paginacao: { pagina: 2, tem_mais: true } }));
  assert.equal(await loading, false); assert.equal(h.state.patients.length, 0); assert.equal(h.state.protocols.length, 0);
  assert.equal(h.state.loading, false); assert.equal(h.state.loaded, false);
  assert.equal(h.node('prontuario-status').textContent, 'Sessão encerrada');
  assert.deepEqual(h.calls.filter(call => call.acao === 'listar_clientes').map(call => call.pagina), [1, 1, 2]);
});

for (const failures of [['listar_clientes'], ['listar_catalogos'], ['listar_estoque'], ['listar_clientes', 'listar_catalogos', 'listar_estoque']]) {
  test('cold history reads all pages despite unavailable ' + failures.join(', '), async () => {
    const h = harness(); h.setRows(Array.from({ length: 101 }, (_, i) => protocol('synthetic-' + i)));
    failures.forEach(action => h.fail.set(action, { status: 503 }));
    assert.equal(await h.load(), true); assert.equal(h.state.loaded, true); assert.equal(h.state.protocols.length, 101);
    assert.deepEqual(h.calls.filter(call => call.acao === 'listar').map(call => call.pagina), [1, 2]);
    assert.match(h.node('prontuario-lista').innerHTML, /Produto histórico sintético/);
    assert.match(h.node('prontuario-status').textContent, /Histórico carregado/);
    assert.equal(h.node('prontuario-lista').attributes['aria-busy'], 'false');
  });
}
test('auxiliary caches, open notes and photos survive failure; stock becomes unknown until a successful retry', async () => {
  const h = harness(); await h.load();
  const previous = { patients: h.state.patients, products: h.state.products, brands: h.state.brands, inventory: h.state.inventory };
  h.node('prontuario-notas').value = 'Notas sintéticas não salvas';
  const gallery = { items: [{ id: 'photo-existing' }], includeArchived: false, page: 1 };
  h.state.photosByProtocol.set('synthetic-protocol', gallery);
  ['listar_clientes', 'listar_catalogos', 'listar_estoque'].forEach(action => h.fail.set(action, { status: 503 }));
  assert.equal(await h.load(), true);
  for (const [name, value] of Object.entries(previous)) assert.equal(h.state[name], value);
  assert.equal(h.node('prontuario-notas').value, 'Notas sintéticas não salvas');
  assert.equal(h.state.photosByProtocol.get('synthetic-protocol'), gallery);
  assert.equal(h.state.inventoryAvailable, false); assert.equal(h.inventoryForProduct('synthetic-product').length, 0);
  assert.match(h.productName(previous.products[0]), /estoque não atualizado/); assert.doesNotMatch(h.productName(previous.products[0]), /estoque 0/);
  const controls = new Map();
  const row = { querySelector(selector) {
    if (!controls.has(selector)) controls.set(selector, { value: '', innerHTML: '', textContent: '', setAttribute() {}, closest: () => ({ hidden: false }) });
    return controls.get(selector);
  } };
  row.querySelector('.prontuario-produto-select').value = 'synthetic-product';
  row.querySelector('.prontuario-produto-lote').value = 'LOTE HISTÓRICO'; row.querySelector('.prontuario-produto-validade').value = '2027-01-31';
  h.syncProductStock(row, false);
  assert.equal(row.querySelector('.prontuario-produto-lote').value, 'LOTE HISTÓRICO'); assert.equal(row.querySelector('.prontuario-produto-validade').value, '2027-01-31');
  assert.doesNotMatch(row.querySelector('.prontuario-produto-lote-select').innerHTML, /LOTE ATUAL/);
  assert.doesNotMatch(row.querySelector('.prontuario-produto-estoque').textContent, /Saldo total: 0|Sem lote disponível/);
  h.syncProductStock(row, true); assert.equal(row.querySelector('.prontuario-produto-lote').value, '', 'stale cached lot is not automatically selected');
  h.fail.clear(); assert.equal(await h.load(), true); assert.equal(h.state.inventoryAvailable, true); assert.equal(h.inventoryForProduct('synthetic-product').length, 1);
});
test('failed clinical page two preserves the old complete snapshot, even when auxiliaries succeed', async () => {
  const h = harness(); await h.load(); const previous = h.state.protocols;
  const fetch = h.sandbox.fetch;
  h.setRows(Array.from({ length: 101 }, (_, i) => protocol('next-' + i)));
  h.sandbox.fetch = async (url, options) => JSON.parse(options.body).pagina === 2 ? response({ erro: 'Página clínica indisponível' }, 503) : fetch(url, options);
  assert.equal(await h.load(), false); assert.equal(h.state.protocols, previous); assert.equal(h.state.protocols.length, 1);
});
for (const failure of [{ status: 401 }, { status: 403 }, { status: 503, code: 'session_validation_unavailable' }]) {
  test('authentication failure never becomes an auxiliary fallback: ' + JSON.stringify(failure), async () => {
    const h = harness(); h.fail.set('listar_catalogos', failure);
    assert.equal(await h.load(), false); assert.equal(h.state.protocols.length, 0); assert.equal(h.state.loaded, false);
    assert.doesNotMatch(h.node('prontuario-status').textContent, /Histórico carregado/);
  });
}
test('genuine 401/403 uses the existing application signout handler without treating it as a recoverable catalog failure', async () => {
  const h = harness(); await h.load(); let denied = 0;
  h.sandbox.acessoNegado = async () => { denied++; h.state.generation++; h.state.protocols = []; h.state.photosByProtocol.clear(); h.state.loading = false; };
  h.fail.set('listar_clientes', { status: 403, code: 'membership_inactive' });
  assert.equal(await h.load(), false); assert.equal(denied, 1); assert.equal(h.state.protocols.length, 0);
});
test('acknowledged draft is unlocked only by its canonical version despite an auxiliary failure', async () => {
  const h = harness(); h.state.protocols = [protocol('synthetic-protocol', 7)]; h.state.pendingProtocolVersions.set('synthetic-protocol', 8);
  h.fail.set('listar_estoque', { status: 503 }); h.setRows([protocol('synthetic-protocol', 7)]);
  assert.equal(await h.load(), false); assert.equal(h.protocolNeedsRefresh('synthetic-protocol'), true);
  h.setRows([protocol('synthetic-protocol', 8)]); assert.equal(await h.load(), true); assert.equal(h.protocolNeedsRefresh('synthetic-protocol'), false);
  assert(h.calls.every(call => ['listar', 'listar_clientes', 'listar_catalogos', 'listar_estoque'].includes(call.acao)), 'read recovery issues no duplicate write');
});
function photoCache(h, includeArchived = false) {
  h.state.photosByProtocol.set('synthetic-protocol', { items: [{ id: 'photo-existing', phase: 'before' }], page: 1, hasMore: true, includeArchived });
}
test('photo refresh retains the same gallery during a transient failure and successful retry replaces rather than duplicates it', async () => {
  const h = harness(); photoCache(h); const pending = deferred();
  h.sandbox.fetch = async () => pending.promise;
  const loading = h.loadPhotos('synthetic-protocol', false); await flush();
  assert.equal(h.state.photosByProtocol.get('synthetic-protocol').items.length, 1);
  pending.resolve(response({ erro: 'Galeria temporariamente indisponível' }, 503)); await loading;
  assert.equal(h.state.photosByProtocol.get('synthetic-protocol').items[0].id, 'photo-existing');
  assert.match(h.state.photosByProtocol.get('synthetic-protocol').error, /temporariamente/);
  h.sandbox.fetch = async () => response({ fotos: [{ id: 'photo-existing' }, { id: 'photo-existing' }, { id: 'photo-new' }], paginacao: { tem_mais: false } });
  await h.loadPhotos('synthetic-protocol', false); assert.equal(h.state.photosByProtocol.get('synthetic-protocol').items.length, 2);
});
test('photo fallback cannot retain a different filter or denied access, and an old session cannot restore a gallery', async () => {
  const h = harness(); photoCache(h, true); h.node('prontuario-mostrar-arquivados').checked = false;
  h.sandbox.fetch = async () => response({ erro: 'Falha sintética' }, 503);
  await h.loadPhotos('synthetic-protocol', false); assert.equal(h.state.photosByProtocol.get('synthetic-protocol').items.length, 0);
  photoCache(h); h.sandbox.fetch = async () => response({ erro: 'Acesso negado' }, 403);
  await h.loadPhotos('synthetic-protocol', false); assert.equal(h.state.photosByProtocol.get('synthetic-protocol').items.length, 0);
  photoCache(h); const pending = deferred(); h.sandbox.fetch = async () => pending.promise;
  const loading = h.loadPhotos('synthetic-protocol', false); await flush(); h.state.generation++; h.state.photosByProtocol.clear();
  pending.resolve(response({ fotos: [{ id: 'old-session-photo' }] })); await loading;
  assert.equal(h.state.photosByProtocol.size, 0);
});

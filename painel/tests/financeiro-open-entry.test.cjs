'use strict';

// The production closure, synthetic DOM and mocked HTTP only; no patient data or services.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.resolve(__dirname, '../financeiro.js'), 'utf8');
const ID = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const entry = (overrides = {}) => ({ id: ID, tipo: 'receita', origem: 'atendimento',
  estado: 'ativo', status: 'pendente', descricao: 'Cobrança sintética', valor_total: 100,
  valor_pago: 0, saldo: 100, pagamentos: [], parcelas_previstas: [], versao: 2, ...overrides });
const response = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));

function runtime(transport = () => response({ lancamentos: [], paginacao: { tem_mais: false } })) {
  const nodes = new Map(), requests = [], routes = [], focused = [];
  let route = 'procedimentos';
  class Node {
    constructor(id) {
      this.id = id; this.value = ''; this.textContent = ''; this.dataset = {}; this.options = [];
      this.attributes = {}; this.children = []; this.classList = { add() {}, remove() {}, toggle() {} };
    }
    set innerHTML(html) {
      this.html = html;
      if (html.includes('<option')) {
        this.options = [...html.matchAll(/<option value="([^"]*)"/g)].map(m => ({ value: m[1] }));
        this.value = this.options[0]?.value || '';
      }
      if (this.id === 'financeiro-lista') this.children = [...html.matchAll(/data-financeiro-entry-card="([^"]*)"/g)].map(m => {
        const card = new Node('card-' + m[1]); card.dataset.financeiroEntryCard = m[1];
        card.details = new Node('details'); return card;
      });
    }
    get innerHTML() { return this.html || ''; }
    querySelectorAll(selector) { return selector === '[data-financeiro-entry-card]' ? this.children : []; }
    querySelector(selector) { return selector === '.financeiro-lancamento-detalhes' ? this.details : null; }
    setAttribute(key, value) { this.attributes[key] = String(value); }
    getAttribute(key) { return this.attributes[key]; }
    removeAttribute(key) { delete this.attributes[key]; }
    reset() { throw Error('Opening an existing entry must never reset a form'); }
    focus(options) { this.focusOptions = options; focused.push(this.id); }
    scrollIntoView(options) { this.scrollOptions = options; }
    addEventListener() {}
  }
  const node = id => { if (!nodes.has(id)) nodes.set(id, new Node(id)); return nodes.get(id); };
  const env = {
    AbortController, Intl, Date, console, clearTimeout, setTimeout, modoAcesso: 'auth', identidadeBackend: { role: 'owner' },
    cabecalhosAcesso: async () => ({ Authorization: 'Bearer synthetic-only' }),
    document: { readyState: 'loading', addEventListener() {}, getElementById: id => id === 'aba-financeiro' ? null : node(id), querySelectorAll() { return []; } },
    window: { AMJProtecao: new Proxy({}, { get() { throw Error('Read-only opening cannot request mutation authorization'); } }) },
    fetch: async (_url, init) => { const body = JSON.parse(init.body); requests.push(body); return transport(body, requests); }
  };
  vm.runInNewContext(source.replace('  window.AMJFinanceiro = {',
    '  window.entryTest = { state };\n  window.AMJFinanceiro = {'), env);
  const api = env.window.AMJFinanceiro, state = env.window.entryTest.state;
  env.window.AMJShell = {
    currentRoute: () => route,
    navigate: async target => {
      routes.push(target); route = target; api.ativar();
      // The shell switches the existing finance view while navigating.
      api.abrirVisao({ cobrancas: 'procedimentos', receitas: 'receitas_avulsas', despesas: 'despesas' }[target]);
      return true;
    }
  };
  return { api, state, node, env, routes, requests, focused, setRoute: value => { route = value; },
    card: id => node('financeiro-lista').children.find(card => card.dataset.financeiroEntryCard === id) };
}

for (const [overrides, expectedRoute, expectedView] of [
  [{}, 'cobrancas', 'procedimentos'],
  [{ origem: 'manual' }, 'receitas', 'receitas_avulsas'],
  [{ tipo: 'despesa', origem: 'compra', estado: 'cancelado', status: 'cancelado' }, 'despesas', 'despesas']
]) test('existing entry opens its exact read-only card in ' + expectedRoute, async () => {
  const h = runtime(() => { throw Error('Loaded entry needs no request'); });
  h.state.loaded = true; h.state.entries = [entry({ id: OTHER }), entry(overrides)];
  h.node('financeiro-filtro-status').value = 'pago';
  for (const id of ['financeiro-pagamento-lancamento', 'financeiro-pagamento-valor', 'financeiro-parcelas-lancamento',
    'financeiro-parcelas-lista', 'financeiro-produto-nome', 'financeiro-lancamento-descricao']) {
    h.node(id).value = 'Rascunho inalterado'; h.node(id).innerHTML = '<p>Conteúdo ainda não salvo</p>';
  }
  assert.equal(await h.api.abrirLancamento(ID), true);
  assert.deepEqual(h.routes, [expectedRoute]); assert.equal(h.state.entryView, expectedView);
  assert.equal(h.node('financeiro-filtro-status').value, '');
  assert.equal(h.card(ID).details.open, true); assert.equal(h.card(ID).attributes.tabindex, '-1');
  assert.equal(h.card(ID).focusOptions.preventScroll, true); assert.equal(h.card(ID).scrollOptions.block, 'center');
  assert.deepEqual(h.focused, ['card-' + ID]); assert.equal(h.requests.length, 0);
  for (const id of ['financeiro-pagamento-lancamento', 'financeiro-pagamento-valor', 'financeiro-parcelas-lancamento',
    'financeiro-parcelas-lista', 'financeiro-produto-nome', 'financeiro-lancamento-descricao']) {
    assert.equal(h.node(id).value, 'Rascunho inalterado'); assert.equal(h.node(id).innerHTML, '<p>Conteúdo ainda não salvo</p>');
  }
});

test('missing cached entry is found on a later supported page without broad load or invented ID filter', async () => {
  const h = runtime(body => response({ lancamentos: body.pagina === 1 ? [entry({ id: OTHER })] : [entry()], paginacao: { tem_mais: body.pagina === 1 } }));
  h.node('financeiro-filtro-status').value = 'pendente';
  h.node('financeiro-pagamento-lancamento').value = 'Unsaved selection';
  assert.equal(await h.api.abrirLancamento(ID), true);
  assert.deepEqual(h.requests, [1, 2].map(pagina => ({ acao: 'listar_lancamentos', pagina, por_pagina: 100 })));
  assert.equal(h.node('financeiro-filtro-status').value, 'pendente', 'a matching filter is retained');
  assert.equal(h.node('financeiro-pagamento-lancamento').value, 'Unsaved selection');
  assert.equal(h.state.entries.length, 1); assert.equal(h.card(ID).details.open, true);
  assert.equal(h.state.loaded, false, 'a targeted read must not claim all finance catalogs were loaded');
});

test('opening waits for the actual initial refresh before looking beyond its first page', async () => {
  const gate = deferred();
  const h = runtime(async (body, requests) => {
    if (requests.length <= 8) {
      await gate.promise;
      return response(body.acao === 'listar_lancamentos' ? { lancamentos: [entry({ id: OTHER })] } : {});
    }
    return response({ lancamentos: [entry()], paginacao: { tem_mais: false } });
  });
  const loading = h.api.carregar(); await tick(); assert.equal(h.requests.length, 8);
  const opening = h.api.abrirLancamento(ID); await tick(); assert.equal(h.requests.length, 8);
  gate.resolve(); await loading;
  assert.equal(await opening, true); assert.equal(h.requests.length, 9);
  assert.equal(h.card(ID).details.open, true); assert.equal(h.state.loadCompletion, null);
});

for (const [name, transport, pattern] of [
  ['not found', () => response({ lancamentos: [] }), /não encontrado/i],
  ['server unavailable', () => response({ erro: 'Falha sintética do servidor' }, 503), /Falha sintética/]
]) test(name + ' is visible and does not create or navigate', async () => {
  const h = runtime(transport); h.node('financeiro-produto-nome').value = 'Rascunho';
  h.node('financeiro-lista').innerHTML = '<p>Lista anterior preservada</p>';
  assert.equal(await h.api.abrirLancamento(ID), false);
  assert.match(h.node('financeiro-status').textContent, pattern); assert.equal(h.routes.length, 0);
  assert.equal(h.node('financeiro-lista').innerHTML, '<p>Lista anterior preservada</p>');
  assert.equal(h.node('financeiro-produto-nome').value, 'Rascunho');
  assert(h.requests.every(body => body.acao === 'listar_lancamentos'));
});

test('a non-owner cannot read or open even a cached entry', async () => {
  const h = runtime(); h.state.loaded = true; h.state.entries = [entry()]; h.env.identidadeBackend.role = 'professional';
  assert.equal(await h.api.abrirLancamento(ID), false); assert.equal(h.requests.length, 0);
  assert.equal(h.routes.length, 0); assert.match(h.node('financeiro-status').textContent, /conta proprietária/);
});

test('logout while asynchronous headers are pending prevents even the request', async () => {
  const h = runtime(), headers = deferred(); h.env.cabecalhosAcesso = () => headers.promise;
  const opening = h.api.abrirLancamento(ID); h.state.generation += 1; h.env.identidadeBackend = null;
  h.node('financeiro-status').textContent = 'Nova sessão'; headers.resolve({});
  assert.equal(await opening, false); assert.equal(h.requests.length, 0); assert.equal(h.routes.length, 0);
  assert.equal(h.node('financeiro-status').textContent, 'Nova sessão');
});

test('leaving the route during a read does not steal focus or replace the new screen status', async () => {
  const gate = deferred(), h = runtime(() => gate.promise);
  const opening = h.api.abrirLancamento(ID); await tick(); h.setRoute('agenda');
  h.node('financeiro-status').textContent = 'Outra tela'; gate.resolve(response({ lancamentos: [entry()] }));
  assert.equal(await opening, false); assert.equal(h.routes.length, 0); assert.equal(h.focused.length, 0);
  assert.equal(h.node('financeiro-status').textContent, 'Outra tela'); assert.equal(h.state.entries.length, 0);
});

test('a slower first open cannot replace the second selected entry', async () => {
  const first = deferred(), second = deferred();
  const h = runtime((_body, requests) => requests.length === 1 ? first.promise : second.promise);
  const a = h.api.abrirLancamento(ID); await tick(); const b = h.api.abrirLancamento(OTHER); await tick();
  second.resolve(response({ lancamentos: [entry({ id: OTHER })] })); assert.equal(await b, true);
  first.resolve(response({ lancamentos: [entry()] })); assert.equal(await a, false);
  assert.deepEqual(h.focused, ['card-' + OTHER]); assert.equal(h.card(OTHER).details.open, true);
});

test('a refused route exposes the failure without activating edits', async () => {
  const h = runtime(); h.state.loaded = true; h.state.entries = [entry()];
  h.env.window.AMJShell.navigate = async () => false;
  assert.equal(await h.api.abrirLancamento(ID), false);
  assert.match(h.node('financeiro-status').textContent, /Não foi possível abrir/); assert.equal(h.focused.length, 0);
});

'use strict';

// Real client closure, synthetic DOM and HTTP responses only. No live services.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const source = fs.readFileSync(path.resolve(__dirname, '..', 'financeiro.js'), 'utf8');
const ID = '33333333-3333-4333-8333-333333333333';
const OLD = { id: ID, nome: 'Produto sintético anterior', versao: 1, ativo: true,
  status_cadastro: 'completo', tipo: 'descartavel', unidade: 'un', apresentacao: 'Unidade' };
const SAVED = { ...OLD, nome: 'Produto sintético salvo', versao: 2 };
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const response = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

class Node {
  constructor(id) {
    this.id = id; this.value = ''; this.textContent = ''; this.dataset = {};
    this.options = []; this.checked = false; this.attributes = {}; this.isConnected = true;
    this.classList = { add() {}, remove() {}, toggle() {} };
  }
  set innerHTML(value) {
    this.html = value;
    if (value.includes('<option')) {
      this.options = [...value.matchAll(/<option value="([^"]*)"/g)].map(m => ({ value: m[1] }));
      this.value = this.options[0]?.value || '';
    }
  }
  get innerHTML() { return this.html || ''; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  getAttribute(key) { return this.attributes[key]; }
  removeAttribute(key) { delete this.attributes[key]; }
  reset() {}
  focus() {}
  scrollIntoView() {}
  addEventListener() {}
}

function runtime(transport) {
  const nodes = new Map(), requests = [];
  const node = id => { if (!nodes.has(id)) nodes.set(id, new Node(id)); return nodes.get(id); };
  let sequence = 0;
  const sandbox = {
    AbortController, Intl, Date, console, clearTimeout, setTimeout,
    modoAcesso: 'auth', identidadeBackend: { role: 'owner' },
    cabecalhosAcesso: async () => ({ Authorization: 'Bearer synthetic-offline-only' }),
    document: { readyState: 'loading', addEventListener() {}, getElementById: id => id === 'aba-financeiro' ? null : node(id), querySelectorAll() { return []; } },
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body); requests.push(body); return transport(body, requests);
    },
    window: {
      crypto: { randomUUID: () => '00000000-0000-4000-8000-' + String(++sequence).padStart(12, '0') },
      AMJProtecao: {
        solicitarSenhaRecente: async () => { throw Error('Routine product edits must not open a critical dialog'); },
        solicitarEdicaoRotineira: async () => ({ operation_id: '11111111-1111-4111-8111-111111111111', motivo: 'Synthetic update' })
      }
    }
  };
  const marker = '  window.AMJFinanceiro = {';
  assert(source.includes(marker));
  vm.runInNewContext(source.replace(marker,
    '  window.testProducts = {state, saveRegistry, load, beginRegistryEdit, productRegistry, productOptions};\n' + marker), sandbox);
  const ui = sandbox.window.testProducts;
  ui.state.catalogs.produtos = [{ ...OLD }];
  ui.state.loaded = true;
  node('financeiro-produto-id').value = ID;
  node('financeiro-produto-versao').value = '1';
  node('financeiro-produto-nome').value = SAVED.nome;
  const save = (payload = { nome: SAVED.nome }) => ui.saveRegistry(node('financeiro-form-produto'), 'produto', payload, 'financeiro-produto-status', 'Produto salvo.');
  return { ui, node, requests, save, sandbox };
}

const reads = (body, products = [OLD], drafts = []) => response(body.acao === 'listar_catalogos'
  ? { formas_pagamento: [], fornecedores: [], marcas: [], produtos: products, produtos_rascunho: drafts } : {});

test('confirmed edit stays visible and reopens the new version when an unrelated refresh read fails', async () => {
  const r = runtime(body => body.acao === 'editar_produto' ? response({ produto: SAVED }) :
    body.acao === 'listar_auditoria' ? response({ erro: 'Falha sintética', codigo: 'database_unavailable' }, 503) : reads(body));
  await r.save();
  assert.equal(r.ui.productRegistry()[0].nome, SAVED.nome);
  assert.match(r.node('financeiro-produtos-lista').innerHTML, /Produto sintético salvo/);
  assert.match(r.node('financeiro-produto-status').textContent, /salv|atualizad/i);
  assert.match(r.node('financeiro-produto-status').textContent, /atualiza.*pendente|não foi possível atualizar/i);
  await r.ui.beginRegistryEdit('produto', ID);
  assert.equal(Number(r.node('financeiro-produto-versao').value), 2);
  assert.equal(r.node('financeiro-produto-nome').value, SAVED.nome);
  assert.equal(r.requests.filter(p => p.acao === 'editar_produto').length, 1, 'No automatic mutation retry');
});

test('new name-only draft remains reopenable after refresh fails and never enters operation selectors', async () => {
  const draft = { id: ID, nome: 'Rascunho sintético', versao: 1, status_cadastro: 'rascunho',
    ativo: false, tipo: null, unidade: null, apresentacao: null, pendencias: ['tipo', 'unidade', 'apresentacao'] };
  const r = runtime(body => body.acao === 'criar_produto' ? response({ produto: draft }) :
    response({ erro: 'Falha sintética', codigo: 'database_unavailable' }, 503));
  r.ui.state.catalogs.produtos = [];
  r.node('financeiro-produto-id').value = '';
  await r.save({ nome: draft.nome, tipo: null, unidade: null, apresentacao: null });
  assert.equal(r.ui.productRegistry().length, 1);
  assert.equal(r.ui.productRegistry()[0].status_cadastro, 'rascunho');
  assert.match(r.node('financeiro-produtos-lista').innerHTML, /Continuar cadastro/);
  assert.doesNotMatch(r.ui.productOptions(), /Rascunho sintético/);
  assert.equal(r.node('financeiro-produto-id').value, ID);
  assert.equal(r.requests[0].tipo, null, 'No fabricated essentials');
  assert.equal(r.requests.filter(p => p.acao === 'criar_produto').length, 1);
});

test('refresh started before edit cannot replace the acknowledged product with its older version', async () => {
  const pending = [];
  const r = runtime(body => {
    if (body.acao === 'editar_produto') return response({ produto: SAVED });
    const d = defer(); pending.push({ d, body }); return d.promise;
  });
  const oldRefresh = r.ui.load({ silent: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pending.length, 8);
  await r.save();
  for (const { d, body } of pending) d.resolve(reads(body));
  await oldRefresh;
  assert.equal(r.ui.productRegistry()[0].versao, 2);
  assert.equal(r.ui.productRegistry()[0].nome, SAVED.nome);
  await r.ui.beginRegistryEdit('produto', ID);
  assert.equal(Number(r.node('financeiro-produto-versao').value), 2);
});

test('uncertain write preserves all form values and does not invent success or retry automatically', async () => {
  const r = runtime(() => response({ erro: 'Banco temporariamente indisponível.', codigo: 'database_unavailable' }, 503));
  r.node('financeiro-produto-apresentacao').value = 'Preenchimento não confirmado';
  await r.save();
  assert.equal(r.requests.length, 1);
  assert.equal(r.node('financeiro-produto-nome').value, SAVED.nome);
  assert.equal(r.node('financeiro-produto-apresentacao').value, 'Preenchimento não confirmado');
  assert.equal(r.node('financeiro-produto-versao').value, '1');
  assert.equal(r.ui.productRegistry()[0].versao, 1);
  assert.match(r.node('financeiro-produto-status').textContent, /não foi possível confirmar/i);
  assert.match(r.node('financeiro-produto-status').textContent, /preservado/i);
});

test('logout before a delayed write response clears context and cannot resurrect the saved product', async () => {
  const pending = defer();
  const r = runtime(() => pending.promise);
  const saving = r.save();
  await new Promise(resolve => setImmediate(resolve));
  r.sandbox.modoAcesso = null;
  r.sandbox.identidadeBackend = null;
  r.sandbox.window.AMJFinanceiro.reset();
  pending.resolve(response({ produto: SAVED }));
  await saving;
  assert.equal(r.ui.productRegistry().length, 0);
  assert.equal(r.node('financeiro-produto-id').value, '');
  assert.doesNotMatch(r.node('financeiro-produtos-lista').innerHTML, /Produto sintético/);
});

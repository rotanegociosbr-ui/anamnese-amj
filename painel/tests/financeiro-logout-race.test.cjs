'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.resolve(__dirname, '..', 'financeiro.js'), 'utf8');

class FakeClassList {
  add() {}
  remove() {}
  toggle() {}
}

class FakeNode {
  constructor(id) {
    this.id = id;
    this.value = '';
    this.textContent = '';
    this.innerHTML = '';
    this.hidden = false;
    this.disabled = false;
    this.open = false;
    this.options = [];
    this.dataset = Object.create(null);
    this.classList = new FakeClassList();
    this.attributes = Object.create(null);
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] || null; }
  removeAttribute(name) { delete this.attributes[name]; }
  addEventListener() {}
  appendChild() {}
  querySelector() { return new FakeNode('query'); }
  querySelectorAll() { return []; }
  reset() { this.value = ''; }
  focus() {}
  scrollIntoView() {}
}

const nodes = new Map();
function node(id) {
  if (!nodes.has(id)) nodes.set(id, new FakeNode(id));
  return nodes.get(id);
}

const clientForm = new FakeNode('financeiro-form-cliente');
clientForm.reset = function () { node('financeiro-cliente-nome').value = ''; };
node('aba-financeiro').querySelectorAll = function (selector) {
  if (selector === 'form') return [clientForm];
  return [];
};

const pending = [];
const sandbox = {
  AbortController,
  Date,
  Intl,
  Map,
  Math,
  Number,
  Object,
  Promise,
  Set,
  String,
  clearTimeout,
  console,
  crypto: crypto.webcrypto,
  document: {
    readyState: 'loading',
    addEventListener() {},
    createElement(id) { return new FakeNode(id); },
    getElementById(id) { return node(id); },
    querySelectorAll() { return []; }
  },
  fetch(_url, init) {
    return new Promise(resolve => pending.push({ resolve, init }));
  },
  identidadeBackend: { role: 'owner' },
  modoAcesso: 'auth',
  cabecalhosAcesso: async () => ({ Authorization: 'Bearer test-only' }),
  setTimeout,
  window: null
};
sandbox.window = sandbox;
vm.runInNewContext(source, sandbox, { filename: 'financeiro.js' });

(async () => {
  node('financeiro-lista').innerHTML = '<p>Paciente Teste</p>';
  node('financeiro-auditoria').innerHTML = '<p>Ana Maria</p>';
  node('financeiro-lancamento-cliente').innerHTML = '<option>Paciente Teste</option>';
  node('financeiro-cliente-nome').value = 'Paciente Teste';

  const loading = sandbox.AMJFinanceiro.carregar();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pending.length, 5, 'O carregamento deve iniciar cinco consultas protegidas');

  sandbox.modoAcesso = null;
  sandbox.identidadeBackend = null;
  sandbox.AMJFinanceiro.reset();

  assert.equal(node('financeiro-lista').innerHTML, '');
  assert.equal(node('financeiro-auditoria').innerHTML, '');
  assert(!node('financeiro-lancamento-cliente').innerHTML.includes('Paciente Teste'));
  assert.equal(node('financeiro-cliente-nome').value, '');

  for (const request of pending) {
    const action = JSON.parse(request.init.body).acao;
    const payload = action === 'resumo' ? { resumo: {}, fluxo_mensal: [], ultimos_lancamentos: [] } :
      action === 'listar_catalogos' ? { formas_pagamento: [], fornecedores: [], marcas: [], produtos: [] } :
      action === 'listar_clientes' ? { clientes: [{ nome: 'Paciente Tardio' }] } :
      action === 'listar_lancamentos' ? { lancamentos: [{ descricao: 'Resposta tardia' }] } :
      { auditoria: [{ ator: { nome: 'Resposta tardia' } }] };
    request.resolve({ ok: true, status: 200, json: async () => payload });
  }
  await loading;

  assert.equal(node('financeiro-lista').innerHTML, '', 'Resposta tardia não pode repopular a lista');
  assert.equal(node('financeiro-auditoria').innerHTML, '', 'Resposta tardia não pode repopular auditoria');
  assert(!node('financeiro-lancamento-cliente').innerHTML.includes('Paciente Tardio'));
  console.log('OK: logout limpa o DOM e descarta respostas financeiras tardias.');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

// Execute the real module with an in-memory DOM and a transport that always
// rejects. No credential, patient data or network service is used by this file.
const source = fs.readFileSync(path.resolve(__dirname, '..', 'financeiro.js'), 'utf8');

class Node {
  constructor(id = '') {
    this.id = id;
    this.value = '';
    this.textContent = '';
    this.dataset = {};
    this.attributes = {};
    this.options = [];
    this.rows = [];
    this.fields = {};
    this.classList = { toggle() {}, add() {}, remove() {} };
  }
  set innerHTML(value) {
    this.html = value;
    if (value.includes('<option')) {
      this.options = Array.from(value.matchAll(/<option value="([^"]*)"/g), match => ({ value: match[1] }));
      this.value = this.options[0]?.value || '';
    }
    this.rows = Array.from(value.matchAll(/<div class="financeiro-parcela-linha" data-financeiro-parcela-numero="(\d+)"[^]*?<\/div>/g), match => {
      const row = new Node();
      row.dataset.financeiroParcelaNumero = match[1];
      for (const type of ['data', 'valor']) {
        const field = new Node();
        field.value = match[0].match(new RegExp('data-financeiro-parcela-' + type + ' value="([^"]*)"'))[1];
        row.fields['[data-financeiro-parcela-' + type + ']'] = field;
      }
      return row;
    });
  }
  get innerHTML() { return this.html || ''; }
  querySelector(selector) { return this.fields[selector] || null; }
  querySelectorAll(selector) {
    if (selector === '.financeiro-parcela-linha') return this.rows;
    if (selector === '[data-financeiro-parcela-data]') {
      return this.rows.map(row => row.querySelector(selector));
    }
    return [];
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  removeAttribute(name) { delete this.attributes[name]; }
  getAttribute(name) { return this.attributes[name] || null; }
  addEventListener() {}
  focus() {}
}

function runtime() {
  const nodes = new Map();
  const requests = [];
  const purchaseRows = [];
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, new Node(id));
    return nodes.get(id);
  };
  let uuid = 0;
  const sandbox = {
    AbortController, Intl, Date, console,
    modoAcesso: 'auth', identidadeBackend: { role: 'owner' },
    cabecalhosAcesso: async () => ({ Authorization: 'Bearer offline-test' }),
    document: {
      readyState: 'loading', addEventListener() {}, getElementById: node,
      querySelectorAll: selector => selector === '.financeiro-item' ? purchaseRows : []
    },
    fetch: async (_url, init) => {
      requests.push(JSON.parse(init.body));
      throw new TypeError('Conexão interrompida (simulação offline).');
    },
    window: { crypto: { randomUUID: () => 'intent-' + (++uuid) } }
  };
  // Only expose closure functions in this test copy; production exports stay intact.
  const marker = '  window.AMJFinanceiro = {';
  assert(source.includes(marker));
  const instrumented = source.replace(marker,
    '  window.testFinanceiro = { state, populateCatalogs, syncInstallmentEditor, submitInstallmentSchedule,' +
    ' syncServiceForm, submitService, updatePurchaseTotal, submitPurchase };\n' + marker);
  vm.runInNewContext(instrumented, sandbox, { filename: 'financeiro.js' });
  return { node, requests, purchaseRows, ui: sandbox.window.testFinanceiro };
}

function datesAndAmounts(container) {
  return container.rows.map(row => ({
    date: row.querySelector('[data-financeiro-parcela-data]').value,
    value: row.querySelector('[data-financeiro-parcela-valor]').value
  }));
}

function setInstallments(container, values) {
  container.rows.forEach((row, index) => {
    row.querySelector('[data-financeiro-parcela-data]').value = values[index].date;
    row.querySelector('[data-financeiro-parcela-valor]').value = values[index].value;
  });
}

const eventFor = form => ({ preventDefault() {}, currentTarget: form });

test('atualizar catálogos preserva seleções válidas em formulários em preenchimento', () => {
  const { ui, node } = runtime();
  ui.state.clients = [{ id: 'cliente-1', nome: 'Cliente sintético' }];
  ui.state.catalogs.fornecedores = [{ id: 'fornecedor-1', nome: 'Fornecedor sintético' }];
  ui.state.catalogs.marcas = [{ id: 'marca-1', nome: 'Marca sintética' }];
  ui.populateCatalogs();
  const selections = {
    'financeiro-atendimento-cliente': 'cliente-1',
    'financeiro-lancamento-cliente': 'cliente-1',
    'financeiro-lancamento-fornecedor': 'fornecedor-1',
    'financeiro-compra-fornecedor': 'fornecedor-1',
    'financeiro-produto-marca': 'marca-1'
  };
  for (const [id, value] of Object.entries(selections)) node(id).value = value;
  ui.populateCatalogs();
  for (const [id, value] of Object.entries(selections)) {
    assert.equal(node(id).value, value, id + ' não deve perder o vínculo durante atualização');
  }
  ui.state.catalogs.marcas[0].ativo = false;
  ui.populateCatalogs();
  assert.equal(node('financeiro-produto-marca').value, '', 'marca arquivada deve exigir nova escolha');
});

test('trocar de lançamento limpa parcelas anteriores, mas sincronizar o mesmo preserva a edição', () => {
  const { ui, node } = runtime();
  ui.state.entries = [{ id: 'A', saldo: 1200 }, { id: 'B', saldo: 1200 }];
  node('financeiro-parcelas-quantidade').value = '3';
  node('financeiro-parcelas-lancamento').value = 'A';
  ui.syncInstallmentEditor();
  const container = node('financeiro-parcelas-lista');
  const edited = [
    { date: '2026-10-10', value: '600,00' },
    { date: '2026-11-10', value: '300,00' },
    { date: '2026-12-10', value: '300,00' }
  ];
  setInstallments(container, edited);
  ui.syncInstallmentEditor();
  assert.deepEqual(datesAndAmounts(container), edited);
  node('financeiro-parcelas-lancamento').value = 'B';
  ui.syncInstallmentEditor();
  assert.deepEqual(datesAndAmounts(container), [
    { date: '', value: '400,00' }, { date: '', value: '400,00' }, { date: '', value: '400,00' }
  ], 'outro lançamento não pode herdar acordo de datas e valores do anterior');
});

test('entrada Pix de 600 e saldo de 1200 em três boletos preservam payload e intento após timeout', async () => {
  const { ui, node, requests } = runtime();
  const values = {
    cliente: 'cliente-sintetico', procedimento: 'outro', outro: 'Procedimento de teste',
    data: '2026-09-05', valor: '1800,00', situacao: 'parcial', 'valor-recebido': '600,00',
    forma: 'pix', 'saldo-forma': 'boleto', parcelas: '3'
  };
  for (const [id, value] of Object.entries(values)) node('financeiro-atendimento-' + id).value = value;
  ui.syncServiceForm();
  assert.equal(node('financeiro-atendimento-saldo').textContent.replace(/\s/g, ''), 'R$1.200,00');
  setInstallments(node('financeiro-atendimento-parcelas-lista'), [
    { date: '2026-10-05', value: '400,00' },
    { date: '2026-11-05', value: '400,00' },
    { date: '2026-12-05', value: '400,00' }
  ]);
  const event = eventFor(node('financeiro-form-atendimento'));
  await ui.submitService(event);
  await ui.submitService(event);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1], requests[0], 'reenvio incerto conserva ambas as chaves e a mesma intenção');
  assert.equal(requests[0].cliente_id, 'cliente-sintetico');
  assert.equal(requests[0].valor_total, 1800);
  assert.equal(requests[0].valor_recebido, 600);
  assert.equal(requests[0].forma_pagamento, 'pix');
  assert.deepEqual(requests[0].parcelas_previstas.map(row => [row.valor, row.forma_pagamento]),
    [[400, 'boleto'], [400, 'boleto'], [400, 'boleto']]);
});

test('abrir outro lançamento inicia outra intenção após tentativa de parcelamento sem resposta', async () => {
  const { ui, node, requests } = runtime();
  ui.state.entries = [{ id: 'A', saldo: 400 }, { id: 'B', saldo: 400 }];
  node('financeiro-parcelas-quantidade').value = '1';
  node('financeiro-parcelas-forma').value = 'boleto';
  for (const id of ['A', 'A', 'B']) {
    node('financeiro-parcelas-lancamento').value = id;
    ui.syncInstallmentEditor();
    setInstallments(node('financeiro-parcelas-lista'), [{ date: '2026-10-05', value: '400,00' }]);
    await ui.submitInstallmentSchedule(eventFor(node('financeiro-form-parcelas')));
  }
  assert.equal(requests.length, 3);
  assert.equal(requests[0].idempotency_key, requests[1].idempotency_key);
  assert.notEqual(requests[1].idempotency_key, requests[2].idempotency_key,
    'abrir outro lançamento pelo cartão não dispara input/change e precisa renovar a intenção');
});

test('compra com itens 100 + 200 e frete 30 mostra 330 e reenvia a mesma compra vinculada', async () => {
  const { ui, node, requests, purchaseRows } = runtime();
  for (const [index, amount] of [100, 200].entries()) {
    const row = new Node();
    for (const [field, value] of Object.entries({
      produto: 'produto-' + index, quantidade: '1', valor: String(amount), lote: '', validade: ''
    })) {
      const input = new Node();
      input.value = value;
      row.fields['.financeiro-item-' + field] = input;
    }
    purchaseRows.push(row);
  }
  node('financeiro-compra-frete').value = '30,00';
  node('financeiro-compra-condicao').value = 'avista';
  node('financeiro-compra-parcelas').value = '1';
  node('financeiro-compra-fornecedor').value = 'fornecedor-sintetico';
  node('financeiro-compra-data').value = '2026-09-05';
  ui.updatePurchaseTotal();
  assert.equal(node('financeiro-compra-subtotal').textContent.replace(/\s/g, ''), 'R$300,00');
  assert.equal(node('financeiro-compra-frete-resumo').textContent.replace(/\s/g, ''), 'R$30,00');
  assert.equal(node('financeiro-compra-total').textContent.replace(/\s/g, ''), 'R$330,00');
  const event = eventFor(node('financeiro-form-compra'));
  await ui.submitPurchase(event);
  await ui.submitPurchase(event);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0], requests[1]);
  assert.equal(requests[0].fornecedor_id, 'fornecedor-sintetico');
  assert.equal(requests[0].valor_frete, 30);
  assert.deepEqual(requests[0].itens.map(item => item.valor_unitario), [100, 200]);
});

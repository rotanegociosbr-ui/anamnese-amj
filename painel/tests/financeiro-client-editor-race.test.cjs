'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.resolve(__dirname, '../financeiro.js'), 'utf8');
const A = { id: '11111111-1111-4111-8111-111111111111', nome: 'Cadastro sintético A', versao: 1, ativo: true };
const B = { ...A, id: '22222222-2222-4222-8222-222222222222', nome: 'Cadastro sintético B', versao: 4 };
const defer = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise(done => setImmediate(done));
const reply = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

function fixture() {
  const nodes = new Map(), requests = [];
  function node(id) {
    if (!nodes.has(id)) nodes.set(id, {
      id, value: '', textContent: '', disabled: false, checked: false, dataset: {}, options: [], attributes: {},
      classList: { add() {}, remove() {}, toggle() {} },
      set innerHTML(value) { this.html = value; }, get innerHTML() { return this.html || ''; },
      setAttribute(key, value) { this.attributes[key] = String(value); }, getAttribute(key) { return this.attributes[key]; }, removeAttribute(key) { delete this.attributes[key]; },
      querySelector() { return null; }, closest() { return null; },
      querySelectorAll(selector) {
        if (selector === 'button,input,select,textarea') return [node(id.replace('form-', '') + '-salvar')];
        if (selector !== 'input,select,textarea') return [];
        const fields = id.endsWith('cliente') ? ['id', 'versao', 'nome', 'nascimento', 'telefone', 'email', 'cpf', 'emergencia'] :
          ['id', 'versao', 'nome', 'documento', 'telefone', 'email'];
        return fields.map(field => node(id.replace('form-', '') + '-' + field));
      },
      reset() { const prefix = id.replace('form-', '') + '-'; for (const [key, value] of nodes) if (key.startsWith(prefix)) value.value = ''; },
      focus() {}, scrollIntoView() {}, addEventListener() {}
    });
    return nodes.get(id);
  }
  const env = {
    AbortController, Intl, Date, console, clearTimeout, setTimeout,
    modoAcesso: 'auth', identidadeBackend: { role: 'owner' }, cabecalhosAcesso: async () => ({}),
    document: { readyState: 'loading', addEventListener() {}, getElementById: id => id === 'aba-financeiro' ? null : node(id), querySelectorAll() { return []; } },
    window: { crypto: { randomUUID: () => '33333333-3333-4333-8333-333333333333' }, AMJProtecao: {
      solicitarSenhaRecente: async () => { throw Error('No extra password or critical dialog'); },
      solicitarEdicaoRotineira: async () => ({ operation_id: '44444444-4444-4444-8444-444444444444' })
    } },
    fetch: async (_url, options) => { const pending = defer(); requests.push({ body: JSON.parse(options.body), pending }); return pending.promise; }
  };
  vm.runInNewContext(source.replace('  window.AMJFinanceiro = {',
    '  window.editorReview={state,beginRegistryEdit,submitClient,resetClientEdit,resetCatalogEdit};\n  window.AMJFinanceiro = {'), env);
  const api = env.window.editorReview;
  api.state.clients = [{ ...A }, { ...B }]; api.state.catalogs.fornecedores = [{ ...A }, { ...B }];
  api.state.loaded = true; api.state.loading = true;
  async function open(type, item) {
    const opening = api.beginRegistryEdit(type, item.id); await tick();
    requests.at(-1).pending.resolve(reply({ [type]: item })); await opening;
  }
  const save = () => api.submitClient({ preventDefault() {}, currentTarget: node('financeiro-form-cliente') });
  return { api, node, requests, open, save, env };
}

for (const type of ['cliente', 'fornecedor']) {
  test(`${type}: inverted lookup responses cannot replace B with A`, async () => {
    const h = fixture();
    const openingA = h.api.beginRegistryEdit(type, A.id); await tick();
    const openingB = h.api.beginRegistryEdit(type, B.id); await tick();
    h.requests[1].pending.resolve(reply({ [type]: B })); await openingB;
    h.node(`financeiro-${type}-nome`).value = 'Alteração de B ainda não salva';
    h.requests[0].pending.resolve(reply({ [type]: A })); await openingA;
    assert.equal(h.node(`financeiro-${type}-id`).value, B.id);
    assert.equal(h.node(`financeiro-${type}-nome`).value, 'Alteração de B ainda não salva');
  });

  test(`${type}: canceling a pending lookup preserves the subsequent new draft`, async () => {
    const h = fixture();
    const opening = h.api.beginRegistryEdit(type, A.id); await tick();
    if (type === 'cliente') h.api.resetClientEdit(); else h.api.resetCatalogEdit(type);
    h.node(`financeiro-${type}-nome`).value = 'Novo cadastro ainda não salvo';
    h.requests[0].pending.resolve(reply({ [type]: A })); await opening;
    assert.equal(h.node(`financeiro-${type}-id`).value, '');
    assert.equal(h.node(`financeiro-${type}-nome`).value, 'Novo cadastro ainda não salvo');
  });

  test(`${type}: a failed obsolete lookup cannot overwrite the current status`, async () => {
    const h = fixture();
    const openingA = h.api.beginRegistryEdit(type, A.id); await tick();
    await h.open(type, B); h.node('financeiro-status').textContent = 'Editando B';
    h.requests[0].pending.resolve(reply({ erro: 'Falha antiga sintética' }, 503)); await openingA;
    assert.equal(h.node('financeiro-status').textContent, 'Editando B');
    assert.equal(h.node(`financeiro-${type}-id`).value, B.id);
  });

  test(`${type}: edits typed while details are loading must remain unsaved and untouched`, async () => {
    const h = fixture();
    const opening = h.api.beginRegistryEdit(type, A.id); await tick();
    h.node(`financeiro-${type}-nome`).value = 'Preenchimento digitado durante a espera';
    h.requests[0].pending.resolve(reply({ [type]: A })); await opening;
    assert.equal(h.node(`financeiro-${type}-id`).value, '');
    assert.equal(h.node(`financeiro-${type}-nome`).value, 'Preenchimento digitado durante a espera');
  });
}

test('late client A save cannot reset fields, candidate or idempotency key of B', async () => {
  const h = fixture(); await h.open('cliente', A);
  const saving = h.save(); await tick(); const request = h.requests.at(-1);
  assert.equal(request.body.acao, 'editar_cliente'); assert.equal(request.body.id, A.id);
  await h.open('cliente', B);
  h.node('financeiro-cliente-nome').value = 'B ainda não salvo';
  h.node('financeiro-cliente-status').textContent = 'Editando B';
  h.api.state.intentKeys.cliente = 'newer-intent';
  request.pending.resolve(reply({ cliente: { ...A, versao: 2 } })); await saving;
  assert.equal(h.node('financeiro-cliente-id').value, B.id);
  assert.equal(h.node('financeiro-cliente-nome').value, 'B ainda não salvo');
  assert.equal(h.node('financeiro-cliente-status').textContent, 'Editando B');
  assert.equal(h.api.state.intentKeys.cliente, 'newer-intent');
});

test('late client A failure cannot unlock B while B is saving', async () => {
  const h = fixture(), form = h.node('financeiro-form-cliente');
  await h.open('cliente', A); const savingA = h.save(); await tick(); const reqA = h.requests.at(-1);
  await h.open('cliente', B); const savingB = h.save(); await tick(); const reqB = h.requests.at(-1);
  h.node('financeiro-cliente-status').textContent = 'Salvando B';
  reqA.pending.resolve(reply({ erro: 'Falha antiga sintética' }, 503)); await savingA;
  assert.equal(form.getAttribute('aria-busy'), 'true');
  assert.equal(h.node('financeiro-cliente-salvar').disabled, true);
  assert.equal(h.node('financeiro-cliente-status').textContent, 'Salvando B');
  reqB.pending.resolve(reply({ cliente: { ...B, versao: 5 } })); await savingB;
  assert.equal(form.getAttribute('aria-busy'), 'false');
  assert.equal(h.node('financeiro-cliente-salvar').disabled, false);
});

test('ordinary client save still resets the acknowledged editor and releases controls', async () => {
  const h = fixture(); await h.open('cliente', A);
  const saving = h.save(); await tick();
  h.requests.at(-1).pending.resolve(reply({ cliente: { ...A, versao: 2 } })); await saving;
  assert.equal(h.node('financeiro-cliente-id').value, '');
  assert.equal(h.node('financeiro-cliente-salvar').disabled, false);
  assert.match(h.node('financeiro-cliente-status').textContent, /atualizados/);
  assert.equal(h.node('financeiro-clientes-busca').value, A.nome);
});

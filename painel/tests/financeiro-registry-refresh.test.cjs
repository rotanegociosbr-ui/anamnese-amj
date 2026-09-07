'use strict';

// Real finance module with synthetic DOM/HTTP only; never contacts live services.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.resolve(__dirname, '../financeiro.js'), 'utf8');
const reply = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
const tick = () => new Promise(resolve => setImmediate(resolve));
const defer = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const record = (number, extra = {}) => ({ id: '00000000-0000-4000-8000-' + String(number).padStart(12, '0'),
  nome: 'Cadastro sintético ' + number, versao: 1, ativo: true, ...extra });
const catalogs = { formas_pagamento: [], fornecedores: [], marcas: [], produtos: [], produtos_rascunho: [] };
const summary = { receita_recebida: 125, despesa_paga: 25, fluxo_liquido: 100, contas_receber: 50,
  contas_pagar: 20, receita_faturada: 175, despesa_incorrida: 45 };
const reads = body => reply(body.acao === 'listar_catalogos' ? catalogs : body.acao === 'listar_clientes'
  ? { clientes: [], paginacao: { pagina: body.pagina || 1, por_pagina: 100, tem_mais: false } } :
  body.acao === 'resumo' ? { resumo: summary, fluxo_mensal: [], ultimos_lancamentos: [] } :
  { [{ listar_lancamentos: 'lancamentos', listar_auditoria: 'auditoria', listar_estoque: 'estoque',
    listar_pendencias_estoque: 'pendencias', listar_revisoes_duplicidade: 'revisoes' }[body.acao]]: [] });

function fixture(transport = reads) {
  const nodes = new Map(), requests = [];
  function node(id) {
    if (!nodes.has(id)) nodes.set(id, {
      id, value: '', textContent: '', checked: false, disabled: false, dataset: {}, options: [], attributes: {},
      classList: { add() {}, remove() {}, toggle() {} },
      set innerHTML(value) {
        this.html = value;
        if (value.includes('<option')) {
          this.options = [...value.matchAll(/<option value="([^"]*)"/g)].map(m => ({ value: m[1] }));
          this.value = this.options[0]?.value || '';
        }
      },
      get innerHTML() { return this.html || ''; },
      setAttribute(key, value) { this.attributes[key] = String(value); },
      getAttribute(key) { return this.attributes[key]; },
      removeAttribute(key) { delete this.attributes[key]; },
      querySelector() { return null; }, closest() { return null; },
      querySelectorAll(selector) {
        if (selector === 'button,input,select,textarea') return [node(id.replace('form-', '') + '-salvar')];
        if (selector === 'input,select,textarea') return ['nome', 'id', 'versao'].map(field => node(id.replace('form-', '') + '-' + field));
        return [];
      },
      reset() { const prefix = id.replace('form-', '') + '-'; for (const [key, item] of nodes) if (key.startsWith(prefix)) item.value = ''; },
      focus() {}, scrollIntoView() {}, addEventListener() {}
    });
    return nodes.get(id);
  }
  const sandbox = {
    AbortController, Intl, Date, console, clearTimeout, setTimeout,
    modoAcesso: 'auth', identidadeBackend: { role: 'owner' }, cabecalhosAcesso: async () => ({}),
    document: { readyState: 'loading', addEventListener() {}, getElementById: id => id === 'aba-financeiro' ? null : node(id), querySelectorAll() { return []; } },
    window: { crypto: { randomUUID: () => record(900).id }, AMJProtecao: {
      solicitarSenhaRecente: async () => { throw Error('Routine edits must not request a critical confirmation or password'); },
      solicitarEdicaoRotineira: async () => ({ operation_id: record(901).id })
    } },
    fetch: async (_url, init) => { const body = JSON.parse(init.body); requests.push(body); return transport(body); }
  };
  vm.runInNewContext(source.replace('  window.AMJFinanceiro = {',
    '  window.testRegistry={state,load,renderRegistries,submitClient,saveRegistry,beginRegistryEdit,openExistingRegistration,changeRegistryState};\n  window.AMJFinanceiro = {'), sandbox);
  const ui = sandbox.window.testRegistry;
  const save = (type, item, edit = false) => {
    node('financeiro-' + type + '-nome').value = item.nome;
    node('financeiro-' + type + '-id').value = edit ? item.id : '';
    node('financeiro-' + type + '-versao').value = edit ? '1' : '';
    const form = node('financeiro-form-' + type);
    return type === 'cliente' ? ui.submitClient({ preventDefault() {}, currentTarget: form }) :
      ui.saveRegistry(form, type, { nome: item.nome }, 'financeiro-' + type + '-status', 'Cadastro salvo.');
  };
  return { ui, node, requests, save, sandbox };
}

test('all 205 clients load with archived rows, and a later-page client remains searchable and editable', async () => {
  const rows = Array.from({ length: 205 }, (_, index) => record(index + 1, index === 150 ? { ativo: false, arquivado_em: '2026-09-01' } : {}));
  const h = fixture(body => body.acao === 'listar_clientes' ? reply({
    clientes: rows.slice(((body.pagina || 1) - 1) * 100, (body.pagina || 1) * 100),
    paginacao: { pagina: body.pagina || 1, por_pagina: 100, tem_mais: (body.pagina || 1) < 3 }
  }) : body.acao === 'obter_cliente' ? reply({ cliente: rows[204] }) : reads(body));
  assert.equal(await h.ui.load(), true);
  assert.equal(h.ui.state.clients.length, 205);
  assert.deepEqual(h.requests.filter(row => row.acao === 'listar_clientes').map(row => row.pagina), [1, 2, 3]);
  assert(h.requests.filter(row => row.acao === 'listar_clientes').every(row => row.incluir_arquivados === true));
  h.node('financeiro-clientes-busca').value = rows[204].nome;
  h.ui.renderRegistries();
  assert.match(h.node('financeiro-clientes-lista').innerHTML, /Cadastro sintético 205/);
  await h.ui.beginRegistryEdit('cliente', rows[204].id);
  assert.equal(h.node('financeiro-cliente-id').value, rows[204].id);
  assert.equal(h.node('financeiro-cliente-nome').value, rows[204].nome);
  h.node('financeiro-clientes-busca').value = rows[150].nome;
  h.ui.renderRegistries();
  assert.doesNotMatch(h.node('financeiro-clientes-lista').innerHTML, /Cadastro sintético 151/);
  h.node('financeiro-mostrar-arquivados').checked = true;
  h.ui.renderRegistries();
  assert.match(h.node('financeiro-clientes-lista').innerHTML, /Cadastro sintético 151/);
});

for (const problem of ['second-page-failure', 'missing-array', 'repeated-page']) {
  test(`client read ${problem} keeps the last complete registry and financial view`, async () => {
    const h = fixture(body => {
      if (body.acao === 'listar_catalogos') return reply({ ...catalogs, marcas: [record(3)] });
      if (body.acao === 'listar_lancamentos') return reply({ erro: 'Leitura sintética indisponível' }, 503);
      if (body.acao !== 'listar_clientes') return reads(body);
      if (problem === 'missing-array') return reply({});
      if (body.pagina === 2 && problem === 'second-page-failure') return reply({ erro: 'Leitura sintética interrompida' }, 503);
      return reply({ clientes: [record(2)], paginacao: { pagina: 1, por_pagina: 100, tem_mais: true } });
    });
    h.ui.state.clients = [record(1)]; h.ui.state.loaded = true;
    h.ui.state.entries = [record(8, { descricao: 'Lançamento sintético já carregado' })];
    h.ui.state.catalogs.marcas = [record(3)];
    h.ui.renderRegistries();
    h.node('financeiro-lista').innerHTML = '<p>Lançamento sintético já carregado</p>';
    const previous = h.node('financeiro-clientes-lista').innerHTML;
    assert.equal(await h.ui.load(), false);
    assert.equal(h.ui.state.clients.length, 1);
    assert.equal(h.ui.state.clients[0].id, record(1).id);
    assert.equal(h.ui.state.catalogs.marcas[0].id, record(3).id);
    assert.equal(h.node('financeiro-clientes-lista').innerHTML, previous);
    assert.match(h.node('financeiro-lista').innerHTML, /já carregado/);
    assert.match(h.node('financeiro-status').textContent, /atualiz|preservad/i);
    assert(h.requests.filter(row => row.acao === 'listar_clientes').length <= 2);
  });
}

for (const type of ['cliente', 'fornecedor', 'marca']) for (const edit of [false, true]) {
  test(`${type} ${edit ? 'edit' : 'create'} acknowledged before refresh failure stays listed with its server version`, async () => {
    const saved = record(50, { nome: 'Cadastro confirmado pelo servidor', versao: edit ? 2 : 1, cpf: '12345678901', documento: '12345678901234' });
    const h = fixture(body => body.acao === (edit ? 'editar_' : 'criar_') + type ? reply({ [type]: saved }) :
      body.acao === 'obter_' + type ? reply({ [type]: saved }) : reply({ erro: 'Atualização sintética indisponível' }, 503));
    if (edit) {
      if (type === 'cliente') h.ui.state.clients = [record(50)];
      else h.ui.state.catalogs[type === 'marca' ? 'marcas' : 'fornecedores'] = [record(50)];
    }
    h.ui.state.loaded = true;
    await h.save(type, saved, edit);
    const cached = type === 'cliente' ? h.ui.state.clients : h.ui.state.catalogs[type === 'marca' ? 'marcas' : 'fornecedores'];
    assert.equal(cached.length, 1);
    assert.equal(cached[0].nome, saved.nome);
    assert.equal(cached[0].versao, saved.versao);
    if (type === 'cliente') assert.equal(cached[0].cpf, undefined, 'List cache must not retain the full document from the editor response');
    if (type === 'fornecedor') assert.equal(cached[0].documento, undefined);
    assert.match(h.node('financeiro-' + type + '-status').textContent, /atualização.*pendente/i);
    await h.ui.beginRegistryEdit(type, saved.id);
    assert.equal(h.node('financeiro-' + type + '-nome').value, saved.nome);
    assert.equal(Number(h.node('financeiro-' + type + '-versao').value), saved.versao);
    assert.equal(h.requests.filter(row => row.acao === (edit ? 'editar_' : 'criar_') + type).length, 1);
  });
}

for (const type of ['cliente', 'fornecedor', 'marca']) test(`a refresh started before a ${type} save cannot overwrite the acknowledged server record`, async () => {
  const pending = [];
  const saved = record(2, { versao: 2 });
  const h = fixture(body => {
    if (body.acao === 'editar_' + type) return reply({ [type]: saved });
    const item = defer(); pending.push({ body, item }); return item.promise;
  });
  h.ui.state.clients = [record(2)]; h.ui.state.catalogs.fornecedores = [record(2)];
  h.ui.state.catalogs.marcas = [record(2)]; h.ui.state.loaded = true;
  const loading = h.ui.load(); await tick();
  await h.save(type, saved, true);
  for (const { body, item } of pending) item.resolve(body.acao === 'listar_clientes'
    ? reply({ clientes: [record(2)], paginacao: { pagina: 1, por_pagina: 100, tem_mais: false } }) :
    body.acao === 'listar_catalogos' ? reply({ ...catalogs, fornecedores: [record(2)], marcas: [record(2)] }) : reads(body));
  await loading;
  const rows = type === 'cliente' ? h.ui.state.clients : h.ui.state.catalogs[type === 'marca' ? 'marcas' : 'fornecedores'];
  assert.equal(rows[0].versao, 2);
});

test('malformed catalog response preserves catalogs while successful clients still update', async () => {
  const h = fixture(body => body.acao === 'listar_catalogos' ? reply({ ...catalogs, marcas: null }) :
    body.acao === 'listar_clientes' ? reply({ clientes: [record(7)], paginacao: { pagina: 1, tem_mais: false } }) : reads(body));
  h.ui.state.catalogs.marcas = [record(3)]; h.ui.state.clients = [record(1)]; h.ui.state.loaded = true;
  h.ui.renderRegistries();
  const previous = h.node('financeiro-marcas-lista').innerHTML;
  assert.equal(await h.ui.load(), false);
  assert.equal(h.ui.state.catalogs.marcas[0].id, record(3).id);
  assert.equal(h.ui.state.clients[0].id, record(7).id);
  assert.equal(h.node('financeiro-marcas-lista').innerHTML, previous);
});

for (const type of ['cliente', 'fornecedor', 'marca', 'produto']) test(`${type} acknowledged archive remains archived when the following read fails`, async () => {
  const saved = record(2, { versao: 2, ativo: false, arquivado_em: '2026-09-06' });
  const h = fixture(body => body.acao === 'arquivar_' + type ? reply({ [type]: saved }) : reply({ erro: 'Falha sintética de atualização' }, 503));
  let confirmations = 0;
  h.sandbox.window.AMJProtecao.solicitarSenhaRecente = async () => {
    confirmations += 1; return { operation_id: record(901).id, motivo: 'Arquivamento sintético confirmado' };
  };
  h.ui.state.clients = [record(2)]; h.ui.state.catalogs.fornecedores = [record(2)];
  h.ui.state.catalogs.marcas = [record(2)]; h.ui.state.catalogs.produtos = [record(2)]; h.ui.state.loaded = true;
  await h.ui.changeRegistryState(type, saved.id, 'arquivar');
  const rows = type === 'cliente' ? h.ui.state.clients : h.ui.state.catalogs[{ fornecedor: 'fornecedores', marca: 'marcas', produto: 'produtos' }[type]];
  assert.equal(rows[0].ativo, false);
  assert.equal(rows[0].versao, 2);
  assert.equal(confirmations, 1, 'The existing audited confirmation must remain');
  assert.equal(h.requests[0].version, 1, 'Optimistic version must remain');
  assert.equal(h.requests[0].motivo, 'Arquivamento sintético confirmado');
});

test('logout during client pagination stops further pages and cannot restore sensitive registries', async () => {
  const pageTwo = defer();
  const h = fixture(body => body.acao === 'listar_clientes' ? body.pagina === 1
    ? reply({ clientes: [record(1)], paginacao: { pagina: 1, tem_mais: true } }) : pageTwo.promise : reads(body));
  h.ui.state.clients = [record(9)];
  const loading = h.ui.load(); await tick();
  assert.equal(h.requests.filter(row => row.acao === 'listar_clientes').length, 2);
  h.sandbox.modoAcesso = null; h.sandbox.identidadeBackend = null;
  h.sandbox.window.AMJFinanceiro.reset();
  pageTwo.resolve(reply({ clientes: [record(2)], paginacao: { pagina: 2, tem_mais: true } }));
  await loading;
  assert.equal(h.ui.state.clients.length, 0);
  assert.equal(h.requests.filter(row => row.acao === 'listar_clientes').length, 2);
});

test('opening an existing registration waits for the already running catalog load', async () => {
  const pending = [];
  const saved = record(2);
  const h = fixture(body => {
    const item = defer(); pending.push({ body, item }); return item.promise;
  });
  const loading = h.ui.load(); await tick();
  const opening = h.ui.openExistingRegistration('marca', saved.id); await tick();
  for (const { body, item } of pending) item.resolve(body.acao === 'listar_catalogos'
    ? reply({ ...catalogs, marcas: [saved] }) : reads(body));
  await loading; await opening;
  assert.equal(h.node('financeiro-marca-id').value, saved.id);
  assert.equal(h.node('financeiro-marca-nome').value, saved.nome);
});

test('an authorization failure still clears registries instead of preserving protected data', async () => {
  const h = fixture(() => reply({ erro: 'Sessão indisponível' }, 403));
  h.ui.state.clients = [record(2)]; h.ui.state.catalogs.marcas = [record(3)];
  await h.ui.load();
  assert.equal(h.ui.state.clients.length, 0);
  assert.equal(h.ui.state.catalogs.marcas.length, 0);
});

test('cold clients/catalogs remain usable while summary, audit and inventory are unavailable', async () => {
  const clients = Array.from({ length: 205 }, (_, index) => record(index + 1));
  const product = record(500, { controla_estoque: true });
  const h = fixture(body => ['resumo', 'listar_auditoria', 'listar_estoque'].includes(body.acao)
    ? reply({ erro: 'Fonte sintética indisponível' }, 503) :
    body.acao === 'listar_clientes' ? reply({ clientes: clients.slice((body.pagina - 1) * 100, body.pagina * 100),
      paginacao: { pagina: body.pagina, tem_mais: body.pagina < 3 } }) :
    body.acao === 'listar_catalogos' ? reply({ ...catalogs, produtos: [product], marcas: [record(600)] }) :
    body.acao === 'obter_cliente' ? reply({ cliente: clients[204] }) : reads(body));
  assert.equal(await h.ui.load(), false, 'Partial load must not claim every financial source is current');
  assert.equal(h.ui.state.clients.length, 205);
  assert.match(h.node('financeiro-clientes-lista').innerHTML, /Cadastro sintético 205/);
  await h.ui.openExistingRegistration('cliente', clients[204].id);
  assert.equal(h.node('financeiro-cliente-id').value, clients[204].id);
  await h.ui.openExistingRegistration('marca', record(600).id);
  assert.equal(h.node('financeiro-marca-id').value, record(600).id);
  assert.equal(h.node('financeiro-kpi-recebido').textContent, '—');
  assert.doesNotMatch(h.node('financeiro-estoque-resumo').innerHTML, /Saldo: 0|sem saldo|Nenhum produto/i);
  assert.match(h.node('financeiro-estoque-resumo').innerHTML, /indisponível|não atualizado/i);
  assert.match(h.node('financeiro-auditoria').innerHTML, /indisponível/i);
  assert.equal(h.requests.filter(row => /^(criar|editar|arquivar)_/.test(row.acao)).length, 0);
});

test('cold financial sources update when clients and catalogs fail, without claiming zero registered clients', async () => {
  const h = fixture(body => ['listar_clientes', 'listar_catalogos'].includes(body.acao)
    ? reply({ erro: 'Cadastro sintético indisponível' }, 503) : reads(body));
  assert.equal(await h.ui.load(), false);
  assert.equal(h.ui.state.summary.receita_recebida, 125);
  assert.match(h.node('financeiro-kpi-recebido').textContent, /125/);
  assert.equal(h.node('financeiro-clientes-contagem').textContent, '—');
  assert.match(h.node('financeiro-clientes-lista').innerHTML, /indisponível/i);
  assert.doesNotMatch(h.node('financeiro-clientes-lista').innerHTML, /Nenhum cliente/);
  assert.equal(h.node('financeiro-produtos-contagem').textContent, '—');
});

for (const malformed of [false, true]) test(`partial ${malformed ? 'malformed' : 'failed'} reads preserve exact financial history and never substitute summary's recent entries`, async () => {
  const old = record(100, { descricao: 'Histórico financeiro existente' });
  const h = fixture(body => body.acao === 'resumo' ? reply({ resumo: summary, fluxo_mensal: [], ultimos_lancamentos: [record(999)] }) :
    ['listar_lancamentos', 'listar_auditoria', 'listar_estoque', 'listar_pendencias_estoque', 'listar_revisoes_duplicidade'].includes(body.acao)
      ? malformed ? reply({}) : reply({ erro: 'Histórico sintético indisponível' }, 503) : reads(body));
  h.ui.state.entries = [old]; h.ui.state.audit = [old]; h.ui.state.inventory = [old];
  h.ui.state.pendingStock = [old]; h.ui.state.duplicateReviews = [old]; h.ui.state.loaded = true;
  for (const id of ['financeiro-lista', 'financeiro-auditoria', 'financeiro-estoque-resumo', 'financeiro-pendencias-estoque', 'financeiro-duplicidades-lista']) {
    h.node(id).innerHTML = '<p>Histórico já carregado e inalterado</p>';
  }
  assert.equal(await h.ui.load(), false);
  for (const key of ['entries', 'audit', 'inventory', 'pendingStock', 'duplicateReviews']) assert.equal(h.ui.state[key][0].id, old.id, key);
  for (const id of ['financeiro-lista', 'financeiro-auditoria', 'financeiro-estoque-resumo', 'financeiro-pendencias-estoque', 'financeiro-duplicidades-lista']) {
    assert.equal(h.node(id).innerHTML, '<p>Histórico já carregado e inalterado</p>', id);
  }
  assert.equal(h.ui.state.summary.receita_recebida, 125);
  assert.match(h.node('financeiro-status').textContent, /indisponíveis/);
  assert.match(h.node('financeiro-status').textContent, /lançamentos/);
});

test('malformed summary does not invent zero KPIs or recalculate old amounts as current', async () => {
  const h = fixture(body => body.acao === 'resumo' ? reply({ resumo: {}, fluxo_mensal: [] }) : reads(body));
  h.ui.state.summary = { ...summary };
  h.node('financeiro-kpi-recebido').textContent = 'R$ 125,00 (anterior)';
  h.node('financeiro-grafico').innerHTML = '<p>Gráfico anterior</p>';
  assert.equal(await h.ui.load(), false);
  assert.equal(h.node('financeiro-kpi-recebido').textContent, 'R$ 125,00 (anterior)');
  assert.equal(h.node('financeiro-grafico').innerHTML, '<p>Gráfico anterior</p>');
  assert.match(h.node('financeiro-status').textContent, /resumo/);
});

for (const statusCode of [401, 403]) test(`one ${statusCode} source rejects an otherwise successful partial refresh and clears access`, async () => {
  let denied = 0;
  const h = fixture(body => body.acao === 'listar_auditoria' ? reply({ erro: 'Acesso sintético negado' }, statusCode) :
    body.acao === 'listar_clientes' ? reply({ clientes: [record(7)], paginacao: { pagina: 1, tem_mais: false } }) : reads(body));
  h.sandbox.acessoNegado = async () => { denied += 1; };
  h.ui.state.clients = [record(1)]; h.ui.state.catalogs.marcas = [record(2)];
  assert.equal(await h.ui.load(), false);
  assert.equal(denied, 1);
  assert.equal(h.ui.state.clients.length, 0);
  assert.equal(h.ui.state.catalogs.marcas.length, 0);
  assert.equal(Object.keys(h.ui.state.summary).length, 0);
});

'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.resolve(__dirname, '../crm.js'), 'utf8');
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function runtime({ transport, confirmation } = {}) {
  const nodes = new Map(), calls = [], closed = [];
  function node(id) {
    if (!nodes.has(id)) nodes.set(id, { value: '', checked: false, innerHTML: '', textContent: '',
      attributes: {}, classList: { toggle() {} }, setAttribute(k, v) { this.attributes[k] = v; },
      querySelectorAll() { return []; } });
    return nodes.get(id);
  }
  const ctx = { Intl, Date, console, AbortController, CustomEvent: class {},
    modoAcesso: 'auth', identidadeBackend: { role: 'owner' },
    document: { getElementById: node, addEventListener() {} },
    cabecalhosAcesso: async () => ({ Authorization: 'Bearer synthetic' }),
    fetch: async (url, init) => { calls.push(JSON.parse(init.body)); return transport ? transport() :
      { ok: true, status: 200, json: async () => ({ ok: true, leads: [] }) }; },
    window: { crypto: { randomUUID: () => 'synthetic-intent' }, dispatchEvent() {},
      AMJProtecao: { solicitarSenhaRecente: confirmation || (async () => ({ operation_id: 'synthetic-proof',
        motivo: 'Synthetic reason', encerrar: async () => closed.push(true) })) } }
  };
  const marker = '  window.AMJCRMLeads = Object.freeze({';
  assert(source.includes(marker));
  vm.runInNewContext(source.replace(marker, '  window.review = {state,load,protectedRequest};\n' + marker), ctx);
  return { ctx, ui: ctx.window.review, node, calls, closed };
}

test('CRM preserves already loaded leads and site requests after a failed refresh', async () => {
  const r = runtime({ transport: async () => { throw new Error('Synthetic offline'); } });
  r.ui.state.loaded = true;
  r.ui.state.leads = [{ id: 'synthetic-lead', nome: 'Lead sintético salvo', estagio: 'lead_novo' }];
  r.ui.state.siteRequests = [{ id: 'synthetic-request', nome: 'Pedido sintético salvo', status: 'pending' }];
  r.node('crm-content').innerHTML = 'previously rendered lead';
  r.node('crm-site-content').innerHTML = 'previously rendered request';
  const loaded = await r.ui.load(true);
  assert.match(r.node('crm-content').innerHTML, /previously rendered lead|Lead sintético salvo/);
  assert.match(r.node('crm-site-content').innerHTML, /previously rendered request|Pedido sintético salvo/);
  assert.match(r.node('crm-status').textContent, /anterior|última/i);
  assert.equal(loaded, false);
  assert.equal(r.ui.state.leads.length, 1);
  assert.equal(r.node('crm-content').attributes['aria-busy'], 'false');
});

test('CRM initial failure is an error, not an empty saved list', async () => {
  const r = runtime({ transport: async () => { throw new Error('Synthetic offline'); } });
  assert.equal(await r.ui.load(true), false);
  assert.match(r.node('crm-content').innerHTML, /Não foi possível carregar/);
  assert.equal(r.ui.state.loaded, false);
});

test('CRM discards a protected intent confirmed after a session reset', async () => {
  const pending = defer(), r = runtime({ confirmation: () => pending.promise });
  const work = r.ui.protectedRequest('arquivar_lead', { lead_id: 'synthetic-old-target' });
  r.ctx.window.AMJCRMLeads.reset();
  pending.resolve({ operation_id: 'old-proof', motivo: 'Old intent', encerrar: async () => r.closed.push(true) });
  await assert.rejects(work, error => error.code === 'stale_session');
  assert.equal(r.calls.length, 0);
  assert.equal(r.closed.length, 1);
});

test('a completed stale CRM load does not release the newer load busy state', async () => {
  const first = defer(), second = defer(); let count = 0;
  const r = runtime({ transport: () => (++count === 1 ? first.promise : second.promise) });
  const oldWork = r.ui.load(true);
  await new Promise(resolve => setImmediate(resolve));
  r.ctx.window.AMJCRMLeads.reset();
  r.ui.state.root = { querySelector() { return null; } };
  const newWork = r.ui.load(true);
  first.resolve({ ok: true, json: async () => ({ leads: [] }) });
  await oldWork;
  assert.equal(r.ui.state.loading, true);
  assert.equal(r.node('crm-content').attributes['aria-busy'], 'true');
  second.resolve({ ok: true, json: async () => ({ leads: [] }) });
  assert.equal(await newWork, true);
  assert.equal(r.ui.state.loading, false);
});

test('CRM open-by-ID reports a missing record instead of a successful open', async () => {
  const r = runtime();
  r.ui.state.root = {}; r.ui.state.loaded = true;
  assert.equal(await r.ctx.window.AMJCRMLeads.abrirLead('synthetic-missing'), false);
});

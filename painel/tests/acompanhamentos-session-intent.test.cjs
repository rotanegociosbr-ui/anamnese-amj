'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.resolve(__dirname, '../acompanhamentos.js'), 'utf8');
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const response = data => ({ ok: true, status: 200, json: async () => Object.assign({ ok: true }, data) });

function runtime({ headers, confirmation, transport } = {}) {
  let sequence = 0, now = Date.parse('2026-09-06T22:00:00Z');
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  const calls = [], row = { id: 'synthetic-row', plano_id: 'synthetic-plan', versao_plano: 4,
    fila_id: 'synthetic-queue', versao_fila: 2, tipo: 'reactivation', activation_id: 'synthetic-activation' };
  const root = { dataset: {}, handlers: {}, attributes: {}, hidden: false,
    set innerHTML(value) {
      this.html = value;
      this.status = { textContent: '', classList: { toggle() {} } };
      this.list = { innerHTML: '' };
      this.control = { disabled: false, dataset: {} };
    },
    querySelector(selector) { return selector === '[data-acomp-status]' ? this.status : selector === '[data-acomp-lista]' ? this.list : null; },
    querySelectorAll() { return [this.control]; },
    setAttribute(name, value) { this.attributes[name] = value; },
    addEventListener(name, handler) { this.handlers[name] = handler; }
  };
  root.innerHTML = '';
  const card = { dataset: { acompRow: row.id } };
  const form = { dataset: { acompForm: 'tentativa' }, elements: {},
    closest: selector => selector === '[data-acomp-row]' ? card : selector === '[data-acomp-form]' ? form : null };
  for (const [name, value] of Object.entries({ motivo: 'Registro sintético', resultado: 'sem_resposta',
    proxima_acao: 'recontatar', proxima_acao_em: '2026-09-08T10:00' })) form.elements[name] = { value };
  const ctx = { Intl, Date: Clock, console, modoAcesso: 'auth', identidadeBackend: { role: 'owner' },
    cabecalhosAcesso: headers || (async () => ({ Authorization: 'Bearer synthetic-only' })),
    fetch: async (url, init) => { const body = JSON.parse(init.body); calls.push(body); return transport ? transport(body) : response({ acompanhamentos: [row] }); },
    window: { crypto: { randomUUID: () => '00000000-0000-4000-8000-' + String(++sequence).padStart(12, '0') },
      AMJProtecao: { solicitarSenhaRecente: confirmation || (async options => ({ operation_id: 'synthetic-operation', motivo: options.motivo })) } }
  };
  const marker = '  window.AMJAcompanhamentos = {';
  vm.runInNewContext(source.replace(marker, '  window.contractTest = {state,request,protectedRequest,load,submit,bind,setBusy,status};\n' + marker), ctx);
  const ui = ctx.window.contractTest;
  ui.state.root = root; ui.state.rows = [row]; ui.bind();
  function resetIntoNewContext() {
    ctx.window.AMJAcompanhamentos.reset();
    ui.setBusy(true); ui.status('Novo contexto em andamento');
  }
  return { ctx, ui, calls, row, form, root, resetIntoNewContext, advance() { now += 1000; } };
}

test('request never starts transport with headers resolved after reset/logout', async () => {
  const pending = deferred(), r = runtime({ headers: () => pending.promise });
  const work = r.ui.request('listar_acompanhamentos_fase2', {});
  r.ctx.window.AMJAcompanhamentos.reset(); r.ctx.modoAcesso = null; r.ctx.identidadeBackend = null;
  pending.resolve({ Authorization: 'Bearer synthetic-old-session' });
  await assert.rejects(work, /encerrada/);
  assert.equal(r.calls.length, 0, 'The stale request must not reach fetch');
});

test('confirmation resolved after reset cannot create a request even for the same owner', async () => {
  let closed = 0;
  const pending = deferred(), r = runtime({ confirmation: () => pending.promise });
  const work = r.ui.protectedRequest('synthetic-action', {}, 'Confirmar', 'Motivo sintético');
  r.ctx.window.AMJAcompanhamentos.reset();
  pending.resolve({ operation_id: 'old-operation', motivo: 'Motivo sintético', encerrar: async () => { closed++; } });
  await assert.rejects(work, /encerrada/);
  assert.equal(r.calls.length, 0);
  assert.equal(closed, 1, 'Confirmation cleanup must still run');
});

test('same attempt retries the original timestamp and idempotency key after a lost response', async () => {
  const r = runtime({ transport: async () => { throw new TypeError('Synthetic response lost'); } });
  await assert.rejects(r.ui.submit(r.form), /response lost/);
  r.advance(); await assert.rejects(r.ui.submit(r.form), /response lost/);
  assert.equal(r.calls[1].idempotency_key, r.calls[0].idempotency_key);
  assert.equal(r.calls[1].tentativa_em, r.calls[0].tentativa_em, 'Server fingerprint includes tentativa_em');
  assert.equal(r.form.elements.motivo.value, 'Registro sintético');
});

test('editing material attempt fields starts a new intent instead of reusing a mismatched key', async () => {
  const r = runtime({ transport: async () => { throw new TypeError('Synthetic response lost'); } });
  await assert.rejects(r.ui.submit(r.form));
  for (const edit of [() => { r.form.elements.resultado.value = 'respondeu'; },
    () => { r.form.elements.proxima_acao_em.value = '2026-09-09T11:00'; },
    () => { r.form.elements.motivo.value = 'Outro registro sintético'; },
    () => { r.row.versao_plano++; }, () => { r.row.versao_fila++; }]) {
    edit(); r.advance(); await assert.rejects(r.ui.submit(r.form));
    const [prior, current] = r.calls.slice(-2);
    assert.notEqual(current.idempotency_key, prior.idempotency_key);
    assert.notEqual(current.tentativa_em, prior.tentativa_em);
  }
});

test('acknowledged success clears the intent and preserves administrative operation scope', async () => {
  const r = runtime();
  await r.ui.submit(r.form); r.advance(); await r.ui.submit(r.form);
  const writes = r.calls.filter(call => call.acao === 'registrar_tentativa_reativacao');
  assert.equal(writes.length, 2);
  assert.notEqual(writes[1].idempotency_key, writes[0].idempotency_key);
  assert.equal(writes[0].operation_id, 'synthetic-operation');
  assert.equal(writes[0].plano_id, 'synthetic-plan');
  assert.equal(writes[0].versao_plano, 4);
  assert.equal(writes[0].fila_id, 'synthetic-queue');
  assert.equal(writes[0].versao_fila, 2);
});

for (const failure of [false, true]) test('late load ' + (failure ? 'failure' : 'success') + ' cannot overwrite or unlock UI after reset', async () => {
  const pending = deferred(), r = runtime({ transport: () => pending.promise });
  const work = r.ui.load(); await tick();
  r.resetIntoNewContext();
  if (failure) pending.reject(new TypeError('Old synthetic failure'));
  else pending.resolve(response({ acompanhamentos: [{ id: 'stale-synthetic-row' }] }));
  await work;
  assert.equal(r.ui.state.rows.length, 0);
  assert.equal(r.ui.state.loaded, false);
  assert.equal(r.root.list.innerHTML, '');
  assert.equal(r.root.status.textContent, 'Novo contexto em andamento');
  assert.equal(r.ui.state.loading, true);
  assert.equal(r.root.control.disabled, true);
});

test('bound submit handler cannot refresh, report old errors or unlock a new context after reset', async () => {
  const pending = deferred(), r = runtime({ transport: () => pending.promise });
  r.root.handlers.submit({ target: r.form, preventDefault() {} }); await tick();
  assert.equal(r.calls.length, 1);
  r.resetIntoNewContext(); pending.resolve(response()); await tick();
  assert.equal(r.calls.length, 1, 'No follow-up read may be started by the old submit');
  assert.equal(r.root.status.textContent, 'Novo contexto em andamento');
  assert.equal(r.ui.state.loading, true);
  assert.equal(r.root.control.disabled, true);
});

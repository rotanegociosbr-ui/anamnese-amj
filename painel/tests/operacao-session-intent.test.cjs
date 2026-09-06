'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.resolve(__dirname, '../operacao.js'), 'utf8');
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
function runtime({ headers, confirmation, transport } = {}) {
  const calls = [];
  let sequence = 0;
  const form = { elements: {}, handlers: {}, reportValidity: () => true,
    addEventListener(name, fn) { this.handlers[name] = fn; },
    querySelector(selector) { return this.elements[selector.slice(7, -2)] || null; }
  };
  for (const [name, value] of Object.entries({ atendimento_id: 'synthetic-attendance', recomendacao: 'avaliação',
    data_exata: '2026-10-01', janela_inicio: '', janela_fim: '', proxima_acao_em: '2026-09-20T10:00',
    responsavel_id: 'synthetic-owner', orientacao: 'Orientação sintética' })) form.elements[name] = { value };
  form.elements.namedItem = name => form.elements[name];
  const ctx = { Intl, Date, console, modoAcesso: 'auth', identidadeBackend: { role: 'owner' },
    document: { addEventListener() {}, getElementById() { return null; } },
    cabecalhosAcesso: headers || (async () => ({ Authorization: 'Bearer synthetic-only' })),
    fetch: async (url, init) => { const body = JSON.parse(init.body); calls.push(body); return transport
      ? transport(body) : { ok: true, status: 200, json: async () => ({ ok: true }) }; },
    window: { crypto: { randomUUID: () => '00000000-0000-4000-8000-' + String(++sequence).padStart(12, '0') },
      AMJProtecao: { solicitarSenhaRecente: confirmation || (async () => ({ operation_id: 'proof-operation', motivo: 'Synthetic confirmation' })) } }
  };
  // The event handler itself is taken unchanged from bind(); only unrelated UI setup is omitted.
  const returnStart = source.indexOf("    const returnForm = bySelector('[data-form-retorno]');", source.indexOf('  function bind()'));
  const returnBinding = source.slice(returnStart,
    source.indexOf("    const preference = bySelector('[data-form-preferencia]');", returnStart));
  assert(returnBinding.includes('criar_retorno'));
  const marker = '  window.AMJOperacaoClinica = {';
  const expose = '  window.contractTest = {state,jsonRequest,prontuarioJsonRequest,protectedRequest,protectedProntuarioRequest,' +
    'bindReturn(){' + returnBinding + '},skipRefresh(){loadAfterMutation=async()=>{};}};\n';
  vm.runInNewContext(source.replace(marker, expose + marker), ctx);
  const ui = ctx.window.contractTest;
  ui.state.root = { querySelector: selector => selector === '[data-form-retorno]' ? form :
    { textContent: '', classList: { toggle() {} } }, querySelectorAll: () => [], setAttribute() {} };
  return { ctx, ui, calls, form };
}

for (const method of ['jsonRequest', 'prontuarioJsonRequest']) test(method + ' never starts a POST after logout while headers were pending', async () => {
  const pending = defer(), r = runtime({ headers: () => pending.promise });
  const work = r.ui[method]('synthetic-operation', { id: 'synthetic-target' });
  r.ctx.window.AMJOperacaoClinica.reset();
  r.ctx.modoAcesso = null;
  r.ctx.identidadeBackend = null;
  pending.resolve({ Authorization: 'Bearer synthetic-old-session' });
  await assert.rejects(work, /encerrada/);
  assert.equal(r.calls.length, 0, 'Discard stale credentials before transport, not only after its response');
});

for (const method of ['protectedRequest', 'protectedProntuarioRequest']) test(method + ' rejects a confirmation from before module reset', async () => {
  const pending = defer(), r = runtime({ confirmation: () => pending.promise });
  const work = r.ui[method]('synthetic-operation', { id: 'synthetic-target' });
  r.ctx.window.AMJOperacaoClinica.reset();
  // Same authenticated owner: a module context reset is enough to invalidate the old intent.
  pending.resolve({ operation_id: 'synthetic-operation', motivo: 'Old intent' });
  await assert.rejects(work, /encerrada/);
  assert.equal(r.calls.length, 0);
});

test('current administrative confirmation preserves operation scope and reaches transport once', async () => {
  const r = runtime();
  await r.ui.protectedRequest('criar_retorno', { atendimento_id: 'synthetic-target', idempotency_key: 'stable-intent' });
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].atendimento_id, 'synthetic-target');
  assert.equal(r.calls[0].idempotency_key, 'stable-intent');
  assert.equal(r.calls[0].operation_id, 'proof-operation');
});

test('actual return submit retains its intent after uncertain response and changes it only for new content or acknowledged success', async () => {
  let fail = true;
  const r = runtime({ transport: async () => {
    if (fail) throw new TypeError('Synthetic response lost after commit');
    return { ok: true, status: 200, json: async () => ({ ok: true, idempotent: true }) };
  } });
  r.ui.skipRefresh(); r.ui.bindReturn();
  const submit = async () => { r.form.handlers.submit({ preventDefault() {} }); await tick(); };
  await submit(); await submit();
  assert.equal(r.calls[1].idempotency_key, r.calls[0].idempotency_key, 'Retry must recover, not hit material-duplicate rejection');
  assert.equal(r.form.elements.orientacao.value, 'Orientação sintética');
  r.form.elements.orientacao.value = 'Outra orientação sintética';
  await submit();
  assert.notEqual(r.calls[2].idempotency_key, r.calls[1].idempotency_key);
  fail = false; await submit();
  assert.equal(r.calls[3].idempotency_key, r.calls[2].idempotency_key);
  await submit();
  assert.notEqual(r.calls[4].idempotency_key, r.calls[3].idempotency_key);
});

'use strict';
// Execute the actual intent/confirmation/transport functions. No real session or network.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.resolve(__dirname, '../operacao.js'), 'utf8');
const uuid = value => '00000000-0000-4000-8000-' + String(value).padStart(12, '0');
const payload = { atendimento_id: uuid(100), versao: 3, cliente_id: uuid(101),
  procedimento: 'Procedimento sintético', realizado_em: '2026-09-03T12:35:00Z',
  duracao_minutos: '63', responsavel_id: uuid(102), agendamento_id: uuid(103),
  protocolo_id: uuid(104), lancamento_financeiro_id: uuid(105), status: 'realizado' };

function runtime({ confirmation, transport } = {}) {
  const calls = [], confirmations = [], closed = [];
  let sequence = 0;
  const ctx = {
    Intl, Date, console, modoAcesso: 'auth', identidadeBackend: { role: 'owner' },
    document: { addEventListener() {}, getElementById() { return null; } },
    cabecalhosAcesso: async () => ({ 'Content-Type': 'application/json' }),
    fetch: async (url, init) => {
      const body = JSON.parse(init.body); calls.push(body);
      return transport ? transport(body) : { ok: true, status: 200,
        json: async () => ({ ok: true, resultado: { id: body.atendimento_id, version: 4 } }) };
    },
    window: { crypto: { randomUUID: () => uuid(++sequence) },
      AMJProtecao: { solicitarSenhaRecente: async options => {
        const operationId = uuid(++sequence);
        confirmations.push({ options, operationId });
        if (confirmation) return confirmation(operationId);
        return { operation_id: operationId, motivo: 'Confirmação administrativa sintética',
          encerrar: async () => { closed.push(operationId); } };
      } }
    }
  };
  const marker = '  window.AMJOperacaoClinica = {';
  const bindingStart = source.indexOf("    const attendance = bySelector('[data-form-atendimento]');", source.indexOf('  function bind()'));
  const bindingEnd = source.indexOf("    bySelector('[data-atendimento-cancelar-edicao]').addEventListener", bindingStart);
  const attendanceBinding = source.slice(bindingStart, bindingEnd);
  assert(attendanceBinding.includes('confirmar_remocao_vinculos'));
  vm.runInNewContext(source.replace(marker,
    '  window.review = {state,intentKeyForForm,confirmFormIntent,protectedRequest,' +
    'bindAttendance(){' + attendanceBinding + '},skipRefresh(){loadAfterMutation=async()=>{};}};\n' + marker), ctx);
  return { ctx, ui: ctx.window.review, calls, confirmations, closed };
}

test('an uncertain attendance update retries with the same canonical RPC request ID and fresh confirmation', async () => {
  let requestCount = 0;
  const r = runtime({ transport: async () => {
    if (++requestCount === 1) throw new TypeError('Synthetic response lost after commit');
    return { ok: true, status: 200, json: async () => ({ ok: true, resultado: {
      id: payload.atendimento_id, version: 4, idempotent: true
    } }) };
  } });
  const form = {};
  const send = () => r.ui.protectedRequest('salvar_atendimento', {
    ...payload, idempotency_key: r.ui.intentKeyForForm(form, payload)
  }, 'Edição auditada do atendimento');
  await assert.rejects(send(), /response lost/);
  const response = await send();
  assert.equal(response.resultado.idempotent, true);
  assert.equal(r.calls.length, 2);
  assert.equal(r.calls[0].idempotency_key, r.calls[1].idempotency_key);
  assert.equal(r.calls[0].operation_id, r.calls[1].operation_id,
    'SQL attendance.update replay is keyed by operation_id/p_request_id, not p_idempotency_key');
  assert.equal(r.calls[0].operation_id, r.calls[0].idempotency_key);
  assert.equal(r.confirmations.length, 2, 'a stable request identifier does not cache authorization');
  assert.notEqual(r.confirmations[0].operationId, r.confirmations[1].operationId);
  assert.equal(r.closed.length, 2, 'every confirmation is closed even after an uncertain response');
  for (const call of r.calls) {
    assert.equal(call.versao, payload.versao);
    assert.equal(call.protocolo_id, payload.protocolo_id);
    assert.equal(call.password, undefined);
  }
});

test('changed content, version, link data or acknowledged save cannot reuse an old update request ID', async () => {
  const r = runtime(), form = {};
  const contents = [payload, { ...payload, duracao_minutos: '64' },
    { ...payload, versao: 4 }, { ...payload, protocolo_id: null, confirmar_remocao_vinculos: ['protocolo_id'] }];
  for (const content of contents) {
    const key = r.ui.intentKeyForForm(form, content);
    await r.ui.protectedRequest('salvar_atendimento', { ...content, idempotency_key: key });
  }
  assert.equal(new Set(r.calls.map(call => call.operation_id)).size, contents.length);
  r.calls.forEach(call => assert.equal(call.operation_id, call.idempotency_key));
  const current = contents.at(-1), acknowledged = r.calls.at(-1).idempotency_key;
  r.ui.confirmFormIntent(form, acknowledged);
  const next = r.ui.intentKeyForForm(form, current);
  assert.notEqual(next, acknowledged, 'acknowledged success ends this intent');
});

test('other operational actions keep the explicit confirmation operation ID', async () => {
  const r = runtime();
  await r.ui.protectedRequest('arquivar_atendimento', {
    ...payload, idempotency_key: uuid(999)
  }, 'Arquivamento sintético');
  assert.equal(r.calls[0].operation_id, r.confirmations[0].operationId);
  assert.notEqual(r.calls[0].operation_id, r.calls[0].idempotency_key);
});

test('a stable update intent cannot send a request after logout during confirmation', async () => {
  let resolve;
  const pending = new Promise(done => { resolve = done; });
  const r = runtime({ confirmation: () => pending });
  const work = r.ui.protectedRequest('salvar_atendimento', {
    ...payload, idempotency_key: r.ui.intentKeyForForm({}, payload)
  });
  r.ctx.window.AMJOperacaoClinica.reset();
  r.ctx.modoAcesso = null;
  r.ctx.identidadeBackend = null;
  resolve({ operation_id: uuid(500), motivo: 'Old confirmation', encerrar: async () => {} });
  await assert.rejects(work, /encerrada/);
  assert.equal(r.calls.length, 0);
});

test('actual removal submit keeps its RPC intent across a lost response and refreshed link state', async () => {
  const r = runtime({ transport: async () => { throw new TypeError('Synthetic response lost after commit'); } });
  const form = { elements: {}, handlers: {}, reportValidity: () => true,
    addEventListener(name, handler) { this.handlers[name] = handler; } };
  for (const [name, value] of Object.entries({ ...payload, protocolo_id: '', realizado_em: '2026-09-03T09:35' })) {
    form.elements[name] = { value: String(value), addEventListener() {} };
  }
  form.elements.namedItem = name => form.elements[name];
  r.ui.state.root = { setAttribute() {}, querySelectorAll: () => [],
    querySelector: selector => selector === '[data-form-atendimento]' ? form : null };
  r.ui.state.data.atendimentos = [{ id: payload.atendimento_id, version: 3,
    appointment_id: payload.agendamento_id, protocol_id: payload.protocolo_id,
    financial_entry_id: payload.lancamento_financeiro_id }];
  const removalConfirmations = [];
  r.ctx.window.confirm = message => { removalConfirmations.push(message); return true; };
  r.ui.skipRefresh(); r.ui.bindAttendance();
  const submit = async () => {
    form.handlers.submit({ preventDefault() {} });
    await new Promise(resolve => setImmediate(resolve));
  };
  await submit();
  await submit();
  assert.deepEqual(r.calls[0].confirmar_remocao_vinculos, ['protocolo_id']);
  assert.deepEqual(r.calls[1].confirmar_remocao_vinculos, ['protocolo_id']);
  assert.equal(r.calls[0].operation_id, r.calls[1].operation_id, 'direct retry is the same operation');
  // A manual list refresh sees the committed unlink, while hydrateForms preserves
  // the unresolved editor's original version and intended empty protocol field.
  r.ui.state.data.atendimentos[0] = { ...r.ui.state.data.atendimentos[0], version: 4, protocol_id: null };
  await submit();
  assert.equal(r.calls[2].confirmar_remocao_vinculos, undefined, 'fresh list no longer has a link to remove');
  assert.equal(r.calls[2].versao, 3, 'the unacknowledged editor version remains unchanged');
  assert.equal(r.calls[2].idempotency_key, r.calls[0].idempotency_key,
    'confirmation metadata is not part of the canonical SQL update payload');
  assert.equal(r.calls[2].operation_id, r.calls[0].operation_id, 'retry after refresh recovers the same committed operation');
  form.elements.duracao_minutos.value = '64';
  await submit();
  assert.notEqual(r.calls[3].operation_id, r.calls[2].operation_id, 'a real data change is a new operation');
  assert.equal(removalConfirmations.length, 2, 'explicit removal guard still runs when a stored link is being removed');
  assert.equal(r.confirmations.length, 4, 'every attempt still obtains fresh administrative confirmation');
  r.ui.state.data.atendimentos[0].protocol_id = payload.protocolo_id;
  r.ctx.window.confirm = () => false;
  await submit();
  assert.equal(r.calls.length, 4, 'cancelling explicit unlink confirmation still prevents every POST');
});

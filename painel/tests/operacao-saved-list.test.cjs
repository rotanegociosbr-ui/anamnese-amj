'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.resolve(__dirname, '../operacao.js'), 'utf8');
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

// Select setters deliberately reproduce the browser: an unknown value becomes empty.
function select(values = []) {
  let value = '', rows = values.map(value => ({ value, textContent: value }));
  return { get value() { return value; }, set value(next) { value = rows.some(row => row.value === String(next)) ? String(next) : ''; },
    get options() { return rows; }, set innerHTML(html) {
      rows = [...html.matchAll(/<option value="([^"]*)"[^>]*>([^<]*)<\/option>/g)]
        .map(match => ({ value: match[1], textContent: match[2] }));
      value = rows[0]?.value || '';
    }, insertAdjacentHTML(position, html) {
      const match = /value="([^"]*)"[^>]*>([^<]*)</.exec(html);
      rows.push({ value: match[1], textContent: match[2] });
    } };
}
function runtime() {
  const elements = {};
  for (const name of ['atendimento_id','versao','cliente_id','procedimento','realizado_em','duracao_minutos',
    'responsavel_id','status','agendamento_id','protocolo_id','lancamento_financeiro_id']) elements[name] = { value: '' };
  for (const name of ['cliente_id','responsavel_id','agendamento_id','protocolo_id','lancamento_financeiro_id']) elements[name] = select(['']);
  elements.namedItem = name => elements[name];
  const form = { elements, reset() { for (const node of Object.values(elements)) if (node && typeof node !== 'function') node.value = ''; },
    scrollIntoView() {}, querySelector(selector) { return elements[selector.slice(7, -2)] || null; } };
  const list = { innerHTML: '' }, message = { textContent: '', classList: { toggle() {} } };
  let cardReady = false;
  const card = { hidden: false, classList: { add() {}, remove() {} }, closest() { return null; },
    querySelector() { return null; }, scrollIntoView() {} };
  const ctx = { Intl, Date, console, CSS: { escape: value => value }, modoAcesso: 'auth', identidadeBackend: { role: 'owner' },
    document: { addEventListener() {} }, window: { setTimeout() {}, confirm: () => true } };
  const marker = '  window.AMJOperacaoClinica = {';
  vm.runInNewContext(source.replace(marker, '  window.review = {state,renderAttendances,editAttendance,openAttendance,resetAttendanceEditor};\n' + marker), ctx);
  const ui = ctx.window.review;
  ui.state.root = { querySelector(selector) {
    if (selector === '[data-form-atendimento]') return form;
    if (selector === '[data-operacao-atendimentos]') return list;
    if (selector === '[data-atendimento-status]') return message;
    if (selector.startsWith('[data-atendimento-card=')) return cardReady ? card : null;
    return null;
  }, querySelectorAll() { return []; } };
  return { ctx, ui, elements, list, message, card, showCard() { cardReady = true; } };
}
const visit = { id: 'synthetic-visit', patient_id: 'synthetic-patient-outside-page', version: 4,
  procedure_kind: 'Procedimento sintético salvo', attended_at: '2026-09-01T13:00:00Z', status: 'realizado',
  responsible_user_id: 'synthetic-historical-owner', protocol_id: 'synthetic-protocol', archived_at: null };

test('an attendance remains visible when its patient is outside the independently limited patient list', () => {
  const r = runtime(); r.ui.state.data.atendimentos = [{ ...visit }];
  r.ui.state.data.clientes = [{ id: 'synthetic-other-patient', full_name: 'Outra paciente sintética' }];
  r.ui.renderAttendances();
  assert.match(r.list.innerHTML, /data-atendimento-card="synthetic-visit"/);
  assert.match(r.list.innerHTML, /não carregad/i);
  assert.equal(r.ui.state.data.clientes.length, 1, 'Do not invent a patient database row');
});

for (const archived of [false, true]) test('editing preserves the original patient and protocol without selecting another patient: ' + (archived ? 'archived patient' : 'outside current page'), () => {
  const r = runtime(); r.ui.state.data.atendimentos = [{ ...visit }];
  r.ui.state.data.clientes = archived ? [{ id: visit.patient_id, full_name: 'Paciente histórica sintética', archived_at: '2026-09-01' }] : [];
  assert.equal(r.ui.editAttendance(visit.id, true), true);
  assert.equal(r.elements.cliente_id.value, visit.patient_id);
  assert.equal(r.elements.protocolo_id.value, visit.protocol_id);
  assert.equal(r.elements.responsavel_id.value, visit.responsible_user_id);
  assert.equal(r.elements.atendimento_id.value, visit.id);
  r.ui.resetAttendanceEditor();
  assert.equal(r.elements.cliente_id.value, '');
  assert.equal(r.elements.cliente_id.options.some(row => row.value === visit.patient_id), false,
    'An unavailable historical patient is preserved only on its existing attendance, not offered to a new one');
});

test('open saved attendance waits for an already running refresh even when an older list was loaded', async () => {
  const r = runtime(), pending = defer(); r.ui.state.loaded = true;
  r.ui.state.loadPromise = pending.promise;
  const opening = r.ui.openAttendance(visit.id);
  r.showCard(); pending.resolve(true);
  assert.equal(await opening, true);
  assert.equal(r.card.open, true);
});

test('open saved attendance discards an old session target after an awaited refresh', async () => {
  const r = runtime(), pending = defer(); r.ui.state.loaded = true;
  r.ui.state.loadPromise = pending.promise;
  const opening = r.ui.openAttendance(visit.id);
  r.ctx.window.AMJOperacaoClinica.reset(); r.showCard(); pending.resolve(true);
  assert.equal(await opening, false);
  assert.notEqual(r.card.open, true);
});

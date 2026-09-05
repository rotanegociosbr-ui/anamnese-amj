'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function harness(moduleName, fetchImpl) {
  const nodes = new Map();
  let serial = 0;
  function node(id) {
    if (!nodes.has(id)) nodes.set(id, {
      value: '', checked: false, files: [], dataset: {}, disabled: false, resets: 0,
      classList: { toggle() {}, add() {}, remove() {} },
      querySelectorAll: () => [], querySelector: () => null,
      setAttribute() {}, reset() { this.resets += 1; }
    });
    return nodes.get(id);
  }
  const sandbox = {
    window: { __AMJ_TEST__: true, crypto: { randomUUID: () => `intent-${++serial}` } },
    document: {
      readyState: 'loading', addEventListener() {},
      getElementById: id => id === 'prontuario-foto-duplicada' ? null : node(id),
      createElement: () => ({ getContext: () => null })
    },
    fetch: fetchImpl, cabecalhosAcesso: async () => ({}),
    Intl, Date, Math, Number, String, Array, Object, Set, Map, WeakMap, JSON, URL,
    AbortController, FormData, File, console
  };
  const source = fs.readFileSync(path.join(__dirname, '..', `${moduleName}.js`), 'utf8');
  const hooks = moduleName === 'prontuario'
    ? '{ state, submitPhoto }' : '{ state, uploadClinicalPhoto, metadataForUploadedPhoto }';
  vm.runInNewContext(source.replace('if (window.__AMJ_TEST__) {',
    `window.photoHarness = ${hooks};\n  if (window.__AMJ_TEST__) {`), sandbox);
  return { ...sandbox.window.photoHarness, node, sandbox };
}

function photoEditor(h) {
  h.node('prontuario-id').value = 'consulta-a';
  h.node('prontuario-consentimento-fotos').checked = true;
  h.node('prontuario-foto-fase').value = 'before';
  h.node('prontuario-foto-data').value = '2026-09-05T10:00';
  h.node('prontuario-foto-arquivo').files = [new File(['foto sintética'], 'teste.png', { type: 'image/png' })];
  return { preventDefault() {}, currentTarget: h.node('prontuario-foto-form') };
}

function operationForm() {
  const values = { categoria: 'antes', capturada_em: '2026-09-05T10:00', procedimento_item_id: '',
    produto_id: '', lote_selecionado: '', legenda: '', evento_consumo_id: '' };
  const elements = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { value }]));
  elements.namedItem = name => elements[name];
  return { dataset: { protocoloId: 'consulta-a', atendimentoId: 'visita-a' }, elements,
    querySelector: () => null };
}

test('resposta atrasada de foto não limpa nem reabre o editor de outra consulta', async () => {
  const response = deferred();
  const started = deferred();
  const h = harness('prontuario', async () => { started.resolve(); return response.promise; });
  const event = photoEditor(h);
  const pending = h.submitPhoto(event);
  await started.promise;
  h.node('prontuario-id').value = 'consulta-b';
  h.node('prontuario-foto-status').textContent = 'Contexto da consulta B';
  response.resolve({ ok: true, json: async () => ({ ok: true }) });
  await pending;
  assert.equal(event.currentTarget.resets, 0);
  assert.equal(h.node('prontuario-id').value, 'consulta-b');
  assert.equal(h.node('prontuario-foto-status').textContent, 'Contexto da consulta B');
});

test('retry após resposta perdida mantém a intenção da mesma foto', async () => {
  const keys = [];
  const h = harness('prontuario', async (_, options) => {
    keys.push(options.body.get('idempotency_key'));
    throw new Error('Resposta perdida após salvar');
  });
  const event = photoEditor(h);
  await h.submitPhoto(event);
  await h.submitPhoto(event);
  assert.equal(keys.length, 2);
  assert.equal(keys[0], keys[1]);
});

test('troca de consulta enquanto prepara miniatura impede payload com contextos misturados', async () => {
  const bitmap = deferred();
  const started = deferred();
  let requests = 0;
  const h = harness('operacao', async () => {
    requests += 1;
    return { ok: true, json: async () => ({ foto: { id: 'foto-a' } }) };
  });
  h.sandbox.window.createImageBitmap = async () => { started.resolve(); return bitmap.promise; };
  const form = operationForm();
  const pending = h.uploadClinicalPhoto(form, new File(['foto sintética'], 'teste.png', { type: 'image/png' }));
  await started.promise;
  form.dataset.protocoloId = 'consulta-b';
  form.dataset.atendimentoId = 'visita-b';
  form.elements.categoria.value = 'depois';
  bitmap.resolve({ width: 1, height: 1, close() {} });
  await assert.rejects(pending, /contexto|consulta|outros dados/i);
  assert.equal(requests, 0);
});

test('logout durante upload operacional descarta resposta e interrompe a organização', async () => {
  const response = deferred();
  const started = deferred();
  const h = harness('operacao', async () => { started.resolve(); return response.promise; });
  const pending = h.uploadClinicalPhoto(operationForm(), new File(['foto sintética'], 'teste.png', { type: 'image/png' }));
  await started.promise;
  h.state.generation += 1;
  response.resolve({ ok: true, json: async () => ({ foto: { id: 'foto-a' } }) });
  await assert.rejects(pending, /sessão|contexto/i);
});

test('erro atrasado após sair e voltar à mesma consulta não substitui o novo editor', async () => {
  const response = deferred();
  const started = deferred();
  const h = harness('prontuario', async () => { started.resolve(); return response.promise; });
  const pending = h.submitPhoto(photoEditor(h));
  await started.promise;
  h.state.editorGeneration += 2;
  h.node('prontuario-foto-status').textContent = 'Novo editor';
  response.resolve({ ok: false, json: async () => ({ erro: 'Falha antiga' }) });
  await pending;
  assert.equal(h.node('prontuario-foto-status').textContent, 'Novo editor');
});

test('logout durante preparação dos cabeçalhos impede envio do prontuário', async () => {
  const headers = deferred();
  const started = deferred();
  let requests = 0;
  const h = harness('prontuario', async () => { requests += 1; throw new Error('Não deve enviar'); });
  h.sandbox.cabecalhosAcesso = async () => { started.resolve(); return headers.promise; };
  const pending = h.submitPhoto(photoEditor(h));
  await started.promise;
  h.state.generation += 1;
  h.node('prontuario-foto-status').textContent = 'Nova sessão';
  headers.resolve({});
  await pending;
  assert.equal(requests, 0);
  assert.equal(h.node('prontuario-foto-status').textContent, 'Nova sessão');
});

test('data inválida pode ser corrigida antes do primeiro envio', async () => {
  let requests = 0;
  const h = harness('prontuario', async () => { requests += 1; throw new Error('Falha de rede'); });
  const event = photoEditor(h);
  h.node('prontuario-foto-data').value = 'data inválida';
  await h.submitPhoto(event);
  assert.equal(requests, 0);
  h.node('prontuario-foto-data').value = '2026-09-05T10:00';
  await h.submitPhoto(event);
  assert.equal(requests, 1);
});

test('retry parcial reutiliza foto enviada e chave dos metadados sem segundo upload', async () => {
  let requests = 0;
  const h = harness('operacao', async () => {
    requests += 1;
    return { ok: true, json: async () => ({ foto: { id: 'foto-a', operation_version: 1 } }) };
  });
  const form = operationForm();
  const file = new File(['foto sintética'], 'teste.png', { type: 'image/png' });
  const photo = await h.uploadClinicalPhoto(form, file);
  const firstMetadata = h.metadataForUploadedPhoto(form, file, photo);
  const replay = await h.uploadClinicalPhoto(form, file);
  const repeatedMetadata = h.metadataForUploadedPhoto(form, file, replay);
  assert.equal(requests, 1);
  assert.equal(replay.id, photo.id);
  assert.equal(repeatedMetadata.idempotency_key, firstMetadata.idempotency_key);
  form.elements.legenda.value = 'Organização alterada após falha';
  assert.throws(() => h.metadataForUploadedPhoto(form, file, replay), /outra organização/);
});

test('retry da foto já enviada não permite reaproveitar o arquivo em outra consulta', async () => {
  let requests = 0;
  const h = harness('operacao', async () => {
    requests += 1;
    return { ok: true, json: async () => ({ foto: { id: 'foto-a' } }) };
  });
  const form = operationForm();
  const file = new File(['foto sintética'], 'teste.png', { type: 'image/png' });
  await h.uploadClinicalPhoto(form, file);
  form.dataset.atendimentoId = 'visita-b';
  form.dataset.protocoloId = 'consulta-b';
  await assert.rejects(h.uploadClinicalPhoto(form, file), /outros dados/);
  assert.equal(requests, 1);
});

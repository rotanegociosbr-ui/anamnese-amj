'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'app-shell.js'), 'utf8');

function harness() {
  const scripts = [];
  const routes = [];
  const events = [];
  const status = { textContent: '' };
  const storage = new Map();
  const elements = new Map();
  const observers = [];
  const sandbox = {
    modoAcesso: 'auth', identidadeBackend: { role: 'owner' },
    document: {
      readyState: 'loading', addEventListener() {},
      body: { classList: { remove() {}, contains() { return false; } } },
      getElementById(id) { return elements.get(id) || null; },
      querySelector(selector) { return selector === '.app-shell-route-status' ? status : elements.get(selector) || null; }, querySelectorAll() { return []; },
      createElement() { return {}; }, head: { appendChild(script) { scripts.push(script); } }
    },
    sessionStorage: { setItem(key, value) { storage.set(key, value); } },
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
    MutationObserver: class { constructor(callback) { this.callback = callback; observers.push(this); } observe() {} disconnect() {} },
    console, Map, Set, clearTimeout() {}, CSS: { escape: value => value },
    window: {
      innerWidth: 1280, clearTimeout() {}, setTimeout() { return 1; },
      agendaAtivarAba(route) { routes.push(route); },
      dispatchEvent(event) { events.push(event); }, scrollTo() {}
    }
  };
  // Expose state only in this VM; the unmodified production functions run below.
  vm.runInNewContext(source.replace('window.AMJShell = Object.freeze({',
    'window.testState = state; window.AMJShell = Object.freeze({'), sandbox);
  sandbox.window.testState.authenticated = true;
  return { sandbox, scripts, routes, events, status, storage, elements, observers, shell: sandbox.window.AMJShell };
}

async function startedScript(h) {
  await Promise.resolve();
  assert.equal(h.scripts.length, 1);
  return h.scripts[0];
}

test('late lazy module cannot replace the most recent navigation', async () => {
  const h = harness();
  const pending = h.shell.navigate('cotacoes', { focus: false });
  const script = await startedScript(h);
  assert.equal(await h.shell.navigate('agenda', { focus: false }), true);
  h.sandbox.window.AMJCotacoes = {};
  script.onload();
  assert.equal(await pending, false);
  assert.deepEqual(h.routes, ['agenda']);
  assert.equal(h.shell.currentRoute(), 'agenda');
  assert.equal(h.storage.get('amj_shell_route'), 'agenda');
  assert.equal(h.events.length, 1);
});

test('logout during load prevents later activation', async () => {
  const h = harness();
  const pending = h.shell.navigate('cotacoes', { focus: false });
  const script = await startedScript(h);
  h.sandbox.window.testState.authenticated = false;
  h.sandbox.window.AMJCotacoes = {};
  script.onload();
  assert.equal(await pending, false);
  assert.deepEqual(h.routes, []);
});

test('owner access is checked again after lazy loading', async () => {
  const h = harness();
  const pending = h.shell.navigate('cotacoes', { focus: false });
  const script = await startedScript(h);
  h.sandbox.identidadeBackend.role = 'reception';
  h.sandbox.window.AMJCotacoes = {};
  script.onload();
  assert.equal(await pending, false);
  assert.deepEqual(h.routes, []);
});

test('stale failure does not replace status of the current screen', async () => {
  const h = harness();
  const pending = h.shell.navigate('cotacoes', { focus: false });
  const script = await startedScript(h);
  await h.shell.navigate('agenda', { focus: false });
  h.status.textContent = 'Agenda atual';
  script.onerror();
  assert.equal(await pending, false);
  assert.equal(h.status.textContent, 'Agenda atual');
});

test('cancelled open-existing does not open a record in a different screen', async () => {
  const h = harness();
  let opened = 0;
  const pending = h.shell.openExisting({ type: 'atendimento', id: 'synthetic-visit' });
  const script = await startedScript(h);
  await h.shell.navigate('agenda', { focus: false });
  h.sandbox.window.AMJOperacaoClinica = { abrirAtendimento() { opened++; } };
  script.onload();
  assert.equal(await pending, false);
  assert.equal(opened, 0);
});

test('signed-out navigation does not activate even a non-owner route', async () => {
  const h = harness();
  h.sandbox.window.testState.authenticated = false;
  assert.equal(await h.shell.navigate('agenda', { focus: false }), false);
  assert.deepEqual(h.routes, []);
});

test('current load failure is reported and the module can be retried', async () => {
  const h = harness();
  const pending = h.shell.navigate('cotacoes', { focus: false });
  const script = await startedScript(h);
  script.onerror();
  assert.equal(await pending, false);
  assert.match(h.status.textContent, /Não foi possível carregar/);
  const retry = h.shell.navigate('cotacoes', { focus: false });
  await Promise.resolve();
  assert.equal(h.scripts.length, 2);
  h.sandbox.window.AMJCotacoes = {};
  h.scripts[1].onload();
  assert.equal(await retry, true);
  assert.deepEqual(h.routes, ['cotacoes']);
});

test('filtered consultation opens through its canonical API without waiting for a hidden list button', { timeout: 2000 }, async () => {
  const h = harness(), opened = [];
  h.sandbox.window.AMJProntuario = { abrirProtocolo(id) { opened.push(id); } };
  assert.equal(await h.shell.openExisting({ type: 'protocolo', id: 'synthetic-filtered-protocol' }), true);
  assert.deepEqual(opened, ['synthetic-filtered-protocol']);
  assert.equal(h.observers.length, 0, 'filtered DOM is not the source of record identity');
});

for (const cancellation of ['navigate', 'logout', 'permission']) test('late existing-record fallback cannot edit after ' + cancellation, { timeout: 2000 }, async () => {
  const h = harness(); let clicks = 0;
  const pending = h.shell.openExisting({ type: 'protocolo', id: 'synthetic-late-protocol' });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(h.observers.length, 1);
  if (cancellation === 'navigate') await h.shell.navigate('agenda', { focus: false });
  else if (cancellation === 'logout') h.sandbox.window.testState.authenticated = false;
  else h.sandbox.identidadeBackend.role = 'assistant';
  h.status.textContent = 'Preserve current screen';
  h.elements.set('[data-prontuario-editar="synthetic-late-protocol"]', { click() { clicks++; } });
  h.observers[0].callback();
  assert.equal(await pending, false); assert.equal(clicks, 0);
  assert.equal(h.status.textContent, 'Preserve current screen');
});

test('module mount exception rejects loading and allows retry without leaving a pending route', { timeout: 2000 }, async () => {
  const h = harness(); let mounts = 0;
  h.elements.set('cotacoes-root', { firstElementChild: null });
  const pending = h.shell.navigate('cotacoes', { focus: false });
  const script = await startedScript(h);
  h.sandbox.window.AMJCotacoes = { montar() { mounts++; if (mounts === 1) throw new Error('Synthetic mount failure'); } };
  assert.doesNotThrow(() => script.onload());
  assert.equal(await pending, false); assert.match(h.status.textContent, /Synthetic mount failure/);
  assert.equal(h.sandbox.window.testState.scripts.has('cotacoes'), false);
  assert.equal(await h.shell.navigate('cotacoes', { focus: false }), true); assert.equal(mounts, 2);
});

test('double activation of the same linked record opens it once and permits a later retry', { timeout: 2000 }, async () => {
  const h = harness(); let opened = 0, release;
  const completion = new Promise(resolve => { release = resolve; });
  h.sandbox.window.AMJProntuario = { abrirProtocolo() { opened++; return completion; } };
  const pending = h.shell.openExisting({ type: 'protocolo', id: 'synthetic-protocol' });
  assert.equal(await h.shell.openExisting({ type: 'protocolo', id: 'synthetic-protocol' }), false);
  await Promise.resolve(); await Promise.resolve(); assert.equal(opened, 1);
  release(false); assert.equal(await pending, false, 'failed module opening is not reported as success');
  h.sandbox.window.AMJProntuario.abrirProtocolo = () => { opened++; return true; };
  assert.equal(await h.shell.openExisting({ type: 'protocolo', id: 'synthetic-protocol' }), true); assert.equal(opened, 2);
});

test('late record-open error never replaces status on a newer screen', { timeout: 2000 }, async () => {
  const h = harness(); let reject;
  h.sandbox.window.AMJProntuario = { abrirProtocolo() { return new Promise((_, fail) => { reject = fail; }); } };
  const pending = h.shell.openExisting({ type: 'protocolo', id: 'synthetic-protocol' });
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  await h.shell.navigate('agenda', { focus: false });h.status.textContent = 'Keep current work';
  reject(new Error('Synthetic old error')); assert.equal(await pending, false); assert.equal(h.status.textContent, 'Keep current work');
});

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
  const sandbox = {
    modoAcesso: 'auth', identidadeBackend: { role: 'owner' },
    document: {
      readyState: 'loading', addEventListener() {},
      body: { classList: { remove() {}, contains() { return false; } } },
      getElementById() { return null; },
      querySelector(selector) { return selector === '.app-shell-route-status' ? status : null; }, querySelectorAll() { return []; },
      createElement() { return {}; }, head: { appendChild(script) { scripts.push(script); } }
    },
    sessionStorage: { setItem(key, value) { storage.set(key, value); } },
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
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
  return { sandbox, scripts, routes, events, status, storage, shell: sandbox.window.AMJShell };
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

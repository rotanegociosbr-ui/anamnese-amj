'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const repo = path.resolve(__dirname, '../..');
let html = fs.readFileSync(path.join(repo, 'painel/index.html'), 'utf8').replace(/\r\n/g, '\n');
const helperStart = html.indexOf('function falhaTemporariaDeSessao(');
const helpers = html.slice(helperStart, html.indexOf('function limparEstadoAplicativo()', helperStart));
const stepStart = html.indexOf('async function processarEtapaAuth(');
const step = html.slice(stepStart, html.indexOf("el('form-login-individual')", stepStart));
const initStart = html.lastIndexOf('(async () => {');
const startup = html.slice(initStart, html.indexOf('</script>', initStart));
const temporary = () => Object.assign(new Error('synthetic connection interruption'), { code: 'session_error', cause: { name: 'AuthRetryableFetchError', status: 503 } });
const session = { access_token: 'synthetic-aal2', user: { id: 'synthetic-user', email: 'test@example.invalid' } };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function fixture(options = {}) {
  const els = new Map();
  const data = new Map([['amj_login_em', String(Date.now() - 60000)], ['amj_atividade_em', String(Date.now() - 30000)]]);
  const calls = { open: 0, exit: 0, step: 0, session: 0, signIn: 0 };
  const controller = {
    async initialize() { throw temporary(); },
    async getSession() { calls.session++; return options.session ? options.session() : session; },
    async getNextStep() { calls.step++; return options.step ? options.step() : { step: 'ready', session }; },
    async signIn() { calls.signIn++; throw new Error('No password re-entry allowed in retry'); }
  };
  const ctx = {
    console, Date, Number, Boolean, Promise, setTimeout,
    authController: null, authSession: null, modoAcesso: null,
    authInicioConcluido: false, authEncerrando: false, aplicativoLiberado: false,
    authRetomadaPendente: false, authRetomadaEmCurso: false, authRetomadaRevisao: 0,
    SUPABASE_URL: 'https://synthetic.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'synthetic',
    sessionStorage: { getItem: key => data.get(key) || null, setItem: (key, value) => data.set(key, String(value)) },
    el(id) {
      if (!els.has(id)) els.set(id, { hidden: id === 'auth-retomar', disabled: false, textContent: '', focus() {}, addEventListener() {} });
      return els.get(id);
    },
    mensagemAuth: error => error.message,
    mostrarTelaAutenticacao(id) { ctx.screen = id; },
    selecionarMetodoLogin() {},
    sessaoAindaValida: () => options.clockValid !== false,
    iniciarRelogioSessao(restoring) { assert.equal(restoring, true, 'Retry must not create a fresh absolute session lifetime'); },
    async abrirAplicativo(_mode, value, restoring) { assert.equal(restoring, true); assert.equal(value, session); calls.open++; ctx.aplicativoLiberado = true; },
    async prepararCadastroMfa() { ctx.screen = 'tela-mfa-cadastro'; },
    async sair() { calls.exit++; ctx.cancelarRetomadaAuth(); },
    finalizarSaidaInterface() { ctx.cancelarRetomadaAuth(); }
  };
  ctx.window = { sessionStorage: ctx.sessionStorage, supabase: {}, AMJAuth: { createController: () => controller } };
  vm.createContext(ctx);
  vm.runInContext(helpers + '\n' + step, ctx);
  await vm.runInContext(startup, ctx);
  return { ctx, calls, els, data };
}

test('transient startup exposes explicit retry and restores existing session without password', async () => {
  const { ctx, calls, els, data } = await fixture();
  const originalClock = data.get('amj_login_em');
  assert.equal(els.get('auth-retomar').hidden, false);
  assert.equal(calls.open, 0);
  await ctx.repetirVerificacaoAuth();
  assert.equal(calls.session, 1);
  assert.equal(calls.step, 1);
  assert.equal(calls.open, 1);
  assert.equal(calls.signIn, 0);
  assert.equal(data.get('amj_login_em'), originalClock);
  assert.equal(ctx.authRetomadaPendente, false);
  assert.equal(els.get('auth-retomar').disabled, false);
});

test('retry does not bypass MFA challenge', async () => {
  const { ctx, calls } = await fixture({ step: async () => ({ step: 'challenge', session }) });
  await ctx.repetirVerificacaoAuth();
  assert.equal(ctx.screen, 'tela-mfa-desafio');
  assert.equal(calls.open, 0);
  assert.equal(ctx.aplicativoLiberado, false);
});

test('truly expired local clock still signs out', async () => {
  const { ctx, calls } = await fixture({ clockValid: false });
  await ctx.repetirVerificacaoAuth();
  assert.equal(calls.exit, 1);
  assert.equal(calls.step, 0);
  assert.equal(calls.open, 0);
});

test('no session returns to login; does not retry signIn', async () => {
  const { ctx, calls, els } = await fixture({ session: async () => null });
  await ctx.repetirVerificacaoAuth();
  assert.equal(calls.open, 0);
  assert.equal(calls.step, 0);
  assert.equal(calls.signIn, 0);
  assert.equal(els.get('auth-retomar').hidden, true);
});

test('repeated network failure keeps retry and always releases busy buttons', async () => {
  const { ctx, calls, els } = await fixture({ session: async () => { throw temporary(); } });
  await ctx.repetirVerificacaoAuth();
  assert.equal(calls.open, 0);
  assert.equal(ctx.authRetomadaPendente, true);
  assert.equal(ctx.authRetomadaEmCurso, false);
  assert.equal(els.get('auth-retomar').disabled, false);
  assert.equal(els.get('entrar-individual').disabled, false);
});

test('definitive authentication rejection is not classified as a recoverable outage', async () => {
  const error = Object.assign(new Error('revoked'), { code: 'session_error', cause: { status: 401, code: 'refresh_token_not_found' } });
  const { ctx, calls, els } = await fixture({ session: async () => { throw error; } });
  await ctx.repetirVerificacaoAuth();
  assert.equal(calls.open, 0);
  assert.equal(ctx.authRetomadaPendente, false);
  assert.equal(els.get('auth-retomar').hidden, true);
});

test('duplicate retry is single flight and cancellation ignores a late session response', async () => {
  const pending = deferred();
  const { ctx, calls } = await fixture({ session: () => pending.promise });
  const request = ctx.repetirVerificacaoAuth();
  await ctx.repetirVerificacaoAuth();
  assert.equal(calls.session, 1);
  ctx.cancelarRetomadaAuth();
  pending.resolve(session);
  await request;
  assert.equal(calls.open, 0);
  assert.equal(calls.step, 0);
});

test('cancellation during MFA assurance check cannot reopen the app', async () => {
  const pending = deferred();
  const { ctx, calls } = await fixture({ step: () => pending.promise });
  const request = ctx.repetirVerificacaoAuth();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.step, 1);
  ctx.cancelarRetomadaAuth();
  pending.resolve({ step: 'ready', session });
  await request;
  assert.equal(calls.open, 0);
});

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const panelDir = path.resolve(__dirname, '..');
const authSource = fs.readFileSync(path.join(panelDir, 'auth-mfa.js'), 'utf8');
const html = fs.readFileSync(path.join(panelDir, 'index.html'), 'utf8');

function memoryStorage() {
  const data = new Map();
  return {
    getItem(key) { return data.has(key) ? data.get(key) : null; },
    setItem(key, value) { data.set(key, String(value)); },
    removeItem(key) { data.delete(key); },
    entries() { return [...data.entries()]; }
  };
}

function makeWindow(url) {
  let current = new URL(url);
  return {
    get location() {
      return {
        href: current.href,
        search: current.search,
        hash: current.hash,
        pathname: current.pathname
      };
    },
    history: {
      replaceState(_state, _title, relative) {
        current = new URL(relative, current.origin);
      }
    },
    currentUrl() { return current.href; }
  };
}

function loadModule(windowLike) {
  const context = {
    window: windowLike,
    URL,
    URLSearchParams,
    Set,
    Error,
    Object,
    String,
    Boolean,
    Date,
    console
  };
  vm.runInNewContext(authSource, context, { filename: 'auth-mfa.js' });
  return windowLike.AMJAuth;
}

function makeSupabaseMock(initial) {
  const state = Object.assign({
    session: {
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      user: { email: 'anamariajacob95@gmail.com' }
    },
    aal: { currentLevel: 'aal1', nextLevel: 'aal1' },
    factors: { all: [], totp: [] }
  }, initial || {});
  const calls = [];
  let authCallback = null;
  let createOptions = null;

  const client = {
    auth: {
      onAuthStateChange(callback) {
        authCallback = callback;
        return { data: { subscription: { unsubscribe() { calls.push(['unsubscribe']); } } } };
      },
      async verifyOtp(payload) {
        calls.push(['verifyOtp', payload]);
        return { data: { session: state.session }, error: state.verifyOtpError || null };
      },
      async getSession() {
        calls.push(['getSession']);
        return { data: { session: state.session }, error: null };
      },
      async signInWithPassword(payload) {
        calls.push(['signInWithPassword', payload]);
        return { data: { session: state.session }, error: null };
      },
      async updateUser(payload) {
        calls.push(['updateUser', payload]);
        return { data: { user: state.session.user }, error: null };
      },
      async refreshSession() {
        calls.push(['refreshSession']);
        return { data: { session: state.session }, error: null };
      },
      async signOut(payload) {
        calls.push(['signOut', payload]);
        state.session = null;
        if (authCallback) authCallback('SIGNED_OUT', null);
        return { error: null };
      },
      mfa: {
        async getAuthenticatorAssuranceLevel() {
          calls.push(['getAuthenticatorAssuranceLevel']);
          return { data: state.aal, error: null };
        },
        async listFactors() {
          calls.push(['listFactors']);
          return { data: state.factors, error: null };
        },
        async unenroll(payload) {
          calls.push(['unenroll', payload]);
          return { data: {}, error: null };
        },
        async enroll(payload) {
          calls.push(['enroll', payload]);
          return {
            data: {
              id: 'factor-new',
              totp: {
                qr_code: 'data:image/svg+xml;charset=utf-8,%3Csvg%3E%3C/svg%3E',
                secret: 'SECRET123'
              }
            },
            error: null
          };
        },
        async challenge(payload) {
          calls.push(['challenge', payload]);
          return { data: { id: 'challenge-1' }, error: null };
        },
        async verify(payload) {
          calls.push(['verify', payload]);
          state.aal = { currentLevel: 'aal2', nextLevel: 'aal2' };
          return { data: { access_token: 'access-token-aal2' }, error: null };
        }
      }
    }
  };

  return {
    global: {
      createClient(url, key, options) {
        calls.push(['createClient', { url, key }]);
        createOptions = options;
        return client;
      }
    },
    calls,
    state,
    getOptions() { return createOptions; }
  };
}

async function controllerTests() {
  const storage = memoryStorage();
  const windowLike = makeWindow('https://anamariajacob.com.br/painel/');
  const AMJAuth = loadModule(windowLike);
  const mock = makeSupabaseMock();
  const controller = AMJAuth.createController({
    supabaseGlobal: mock.global,
    supabaseUrl: 'https://project.supabase.co',
    publishableKey: 'sb_publishable_test',
    storage,
    windowLike
  });

  assert.equal(AMJAuth.CLIENT_VERSION, '2.112.3');
  assert.equal(mock.getOptions().auth.storageKey, 'amj-auth-v1');
  assert.equal(mock.getOptions().auth.persistSession, true);
  assert.equal(mock.getOptions().auth.detectSessionInUrl, true);
  assert.equal(mock.getOptions().auth.flowType, 'implicit');
  mock.getOptions().auth.storage.setItem('only-this-tab', 'yes');
  assert.equal(storage.getItem('only-this-tab'), 'yes');

  const initial = await controller.initialize();
  assert.equal(initial.session.user.email, 'anamariajacob95@gmail.com');
  assert.equal(initial.requiresPassword, false);
  const signedIn = await controller.signIn(' AnaMariaJacob95@gmail.com ', 'password-value');
  assert.equal(signedIn.access_token, 'access-token');
  const signInCall = mock.calls.find(call => call[0] === 'signInWithPassword');
  assert.equal(signInCall[1].email, 'anamariajacob95@gmail.com');
  assert.equal(signInCall[1].password, 'password-value');
  assert.equal((await controller.getNextStep()).step, 'enroll');

  const enrollment = await controller.beginEnrollment();
  assert.equal(enrollment.factorId, 'factor-new');
  assert.equal(enrollment.secret, 'SECRET123');
  const enrolled = mock.calls.find(call => call[0] === 'enroll');
  assert.equal(enrolled[1].factorType, 'totp');
  const aal2Session = await controller.verifyEnrollment('123 456');
  assert.equal(aal2Session.access_token, 'access-token');
  const verifyCall = mock.calls.find(call => call[0] === 'verify');
  assert.deepEqual(JSON.parse(JSON.stringify(verifyCall[1])), {
    factorId: 'factor-new',
    challengeId: 'challenge-1',
    code: '123456'
  });

  await controller.signOut();
  const signOutCall = mock.calls.find(call => call[0] === 'signOut');
  assert.equal(signOutCall[1].scope, 'local');
}

async function invitationAndChallengeTests() {
  const storage = memoryStorage();
  const windowLike = makeWindow(
    'https://anamariajacob.com.br/painel/#access_token=a&refresh_token=b&type=invite'
  );
  const AMJAuth = loadModule(windowLike);
  const mock = makeSupabaseMock();
  const controller = AMJAuth.createController({
    supabaseGlobal: mock.global,
    supabaseUrl: 'https://project.supabase.co',
    publishableKey: 'sb_publishable_test',
    storage,
    windowLike
  });

  const initial = await controller.initialize();
  assert.equal(initial.requiresPassword, true);
  assert.equal(windowLike.currentUrl(), 'https://anamariajacob.com.br/painel/');
  assert.equal((await controller.getNextStep()).step, 'password');
  await assert.rejects(() => controller.updatePassword('short'), /12 caracteres/);
  await controller.updatePassword('uma-senha-com-12-ou-mais');
  assert.equal(controller.requiresPassword(), false);

  mock.state.aal = { currentLevel: 'aal1', nextLevel: 'aal2' };
  mock.state.factors = {
    all: [{ id: 'factor-ok', factor_type: 'totp', status: 'verified' }],
    totp: [{ id: 'factor-ok', status: 'verified' }]
  };
  assert.equal((await controller.getNextStep()).step, 'challenge');
  await controller.verifyChallenge('654321');
  const challenged = mock.calls.find(call => call[0] === 'challenge');
  assert.equal(challenged[1].factorId, 'factor-ok');

  const tokenStorage = memoryStorage();
  const tokenWindow = makeWindow(
    'https://anamariajacob.com.br/painel/?token_hash=invite-hash&type=invite'
  );
  const TokenAMJAuth = loadModule(tokenWindow);
  const tokenMock = makeSupabaseMock();
  const tokenController = TokenAMJAuth.createController({
    supabaseGlobal: tokenMock.global,
    supabaseUrl: 'https://project.supabase.co',
    publishableKey: 'sb_publishable_test',
    storage: tokenStorage,
    windowLike: tokenWindow
  });
  const tokenInitial = await tokenController.initialize();
  assert.equal(tokenInitial.requiresPassword, true);
  const verifyOtp = tokenMock.calls.find(call => call[0] === 'verifyOtp');
  assert.deepEqual(JSON.parse(JSON.stringify(verifyOtp[1])), {
    token_hash: 'invite-hash',
    type: 'invite'
  });
  assert.equal(tokenWindow.currentUrl(), 'https://anamariajacob.com.br/painel/');
}

function staticAndAccessibilityTests() {
  new vm.Script(authSource, { filename: 'auth-mfa.js' });
  const inlineStart = html.lastIndexOf('<script>') + '<script>'.length;
  const inlineEnd = html.indexOf('</script>', inlineStart);
  const inlineSource = html.slice(inlineStart, inlineEnd);
  new vm.Script(inlineSource, { filename: 'painel-inline.js' });

  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length, 'Todos os IDs do DOM devem ser únicos.');
  const idSet = new Set(ids);
  const referencedIds = [...new Set(
    [...inlineSource.matchAll(/\bel\('([^']+)'\)/g)].map(match => match[1])
  )];
  referencedIds.forEach(id => assert(idSet.has(id), `Referência el('${id}') não existe no DOM.`));
  const labels = new Set([...html.matchAll(/<label[^>]*\sfor="([^"]+)"/g)].map(match => match[1]));
  [
    'auth-email', 'auth-senha', 'senha', 'auth-nova-senha', 'auth-confirma-senha',
    'mfa-cadastro-codigo', 'mfa-desafio-codigo'
  ].forEach(id => assert(labels.has(id), `Campo ${id} precisa de label.`));

  assert(html.includes('role="tablist" aria-label="Escolha o modo de acesso"'));
  assert(html.includes('role="alert" aria-live="assertive"'));
  const referrerPolicy = '<meta name="referrer" content="no-referrer">';
  const referrerPolicyPosition = html.indexOf(referrerPolicy);
  const firstResourcePosition = Math.min(
    ...['<link ', '<script '].map(marker => {
      const position = html.indexOf(marker);
      return position >= 0 ? position : Number.POSITIVE_INFINITY;
    })
  );
  assert(referrerPolicyPosition >= 0, 'O painel precisa declarar Referrer-Policy no-referrer.');
  assert(referrerPolicyPosition < firstResourcePosition,
    'A Referrer-Policy deve aparecer antes de qualquer recurso carregado.');
  assert(html.includes('./vendor/supabase-js-2.112.3.min.js'));
  assert(html.indexOf('./vendor/supabase-js-2.112.3.min.js') < html.indexOf('./auth-mfa.js'));
  assert(!authSource.includes('localStorage'));
  assert(!html.includes('localStorage'));
  assert(!authSource.includes('.signUp('));
  assert(!html.includes('.signUp('));
  assert(html.includes("headers.Authorization = 'Bearer ' + session.access_token"));
  assert(html.includes("headers['x-senha'] = hashSenha"));
  assert(html.includes("if (modoAcesso === 'auth')"));
  assert(html.includes("if (modoAcesso === 'legacy' && hashSenha)"));

  const carregarAgendaStart = inlineSource.indexOf('async function carregarAgenda');
  const carregarAgendaEnd = inlineSource.indexOf('function agendaPararPolling', carregarAgendaStart);
  const carregarAgendaSource = inlineSource.slice(carregarAgendaStart, carregarAgendaEnd);
  assert(carregarAgendaStart >= 0 && carregarAgendaEnd > carregarAgendaStart);
  assert(carregarAgendaSource.includes('if (!sessaoAplicativoAtiva() || agendaCarregando) return;'));
  assert(!carregarAgendaSource.includes('hashSenha'),
    'carregarAgenda não pode depender da senha legada no modo individual.');

  const pollingStart = inlineSource.indexOf('function agendaIniciarPolling');
  const pollingEnd = inlineSource.indexOf('function agendaAtivarAba', pollingStart);
  const pollingSource = inlineSource.slice(pollingStart, pollingEnd);
  assert(pollingStart >= 0 && pollingEnd > pollingStart);
  assert(pollingSource.includes('if (!sessaoAplicativoAtiva() || document.hidden) return;'));
  assert(!pollingSource.includes('hashSenha'),
    'O polling da agenda não pode depender da senha legada no modo individual.');

  assert(!/if\s*\(\s*!hashSenha/.test(inlineSource),
    'Gates gerais de sessão devem aceitar Auth e legado.');
  assert(!/if\s*\(\s*hashSenha\s*&&/.test(inlineSource),
    'Gates gerais de sessão devem usar sessaoAplicativoAtiva().');
}

(async () => {
  await controllerTests();
  await invitationAndChallengeTests();
  staticAndAccessibilityTests();
  console.log('OK: Auth individual, convite, senha, TOTP, AAL2, sessão e DOM.');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

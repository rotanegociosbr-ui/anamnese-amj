(function (global) {
  'use strict';

  const CLIENT_VERSION = '2.112.3';
  const AUTH_STORAGE_KEY = 'amj-auth-v1';
  const PASSWORD_REQUIRED_KEY = 'amj_auth_requires_password';
  const PENDING_FACTOR_KEY = 'amj_auth_pending_factor';
  const SUPPORTED_LINK_TYPES = new Set(['invite', 'recovery']);

  function authError(code, message, cause) {
    const error = new Error(message);
    error.code = code;
    if (cause) error.cause = cause;
    return error;
  }

  function createSessionStorageAdapter(storage) {
    if (!storage || typeof storage.getItem !== 'function' ||
      typeof storage.setItem !== 'function' || typeof storage.removeItem !== 'function') {
      throw authError(
        'session_storage_unavailable',
        'O armazenamento seguro desta aba não está disponível.'
      );
    }

    const probe = 'amj_auth_probe_' + Date.now();
    try {
      storage.setItem(probe, '1');
      storage.removeItem(probe);
    } catch (cause) {
      throw authError(
        'session_storage_unavailable',
        'O navegador bloqueou o armazenamento seguro desta aba.',
        cause
      );
    }

    return {
      getItem(key) {
        return storage.getItem(key);
      },
      setItem(key, value) {
        storage.setItem(key, value);
      },
      removeItem(key) {
        storage.removeItem(key);
      }
    };
  }

  function readAuthLink(locationLike) {
    const search = new URLSearchParams(locationLike && locationLike.search || '');
    const hashText = String(locationLike && locationLike.hash || '').replace(/^#/, '');
    const hash = new URLSearchParams(hashText);
    const type = hash.get('type') || search.get('type') || '';
    const tokenHash = search.get('token_hash') || '';
    const hasImplicitTokens = Boolean(hash.get('access_token') && hash.get('refresh_token'));
    const linkError = hash.get('error') || search.get('error') || '';

    const isPasswordLink = type === 'invite' || type === 'recovery';
    return {
      type,
      tokenHash,
      hasImplicitTokens,
      linkError,
      requiresPassword: isPasswordLink && Boolean(tokenHash || hasImplicitTokens)
    };
  }

  function cleanAuthUrl(windowLike) {
    if (!windowLike || !windowLike.location || !windowLike.history ||
      typeof windowLike.history.replaceState !== 'function') return;

    try {
      const url = new URL(windowLike.location.href);
      ['token_hash', 'type', 'error', 'error_code', 'error_description'].forEach(key => url.searchParams.delete(key));
      const hash = new URLSearchParams(url.hash.replace(/^#/, ''));
      if (hash.has('access_token') || hash.has('refresh_token') || hash.has('error')) {
        url.hash = '';
      }
      windowLike.history.replaceState({}, '', url.pathname + url.search + url.hash);
    } catch (_) {
      // Falhar ao limpar a URL não altera a validação do token no Supabase.
    }
  }

  function normalizeOtp(value) {
    const code = String(value || '').replace(/\D/g, '');
    if (!/^\d{6}$/.test(code)) {
      throw authError('invalid_totp', 'Digite os 6 números do aplicativo autenticador.');
    }
    return code;
  }

  function createController(options) {
    const settings = options || {};
    const supabaseGlobal = settings.supabaseGlobal;
    const storage = settings.storage;
    const windowLike = settings.windowLike || global;
    const onAuthEvent = typeof settings.onAuthEvent === 'function'
      ? settings.onAuthEvent
      : function () {};

    if (!supabaseGlobal || typeof supabaseGlobal.createClient !== 'function') {
      throw authError(
        'client_unavailable',
        'O componente de acesso individual não pôde ser carregado.'
      );
    }
    if (!settings.supabaseUrl || !settings.publishableKey) {
      throw authError('invalid_configuration', 'A configuração pública de autenticação está incompleta.');
    }

    const sessionStorageAdapter = createSessionStorageAdapter(storage);
    const initialLink = readAuthLink(windowLike.location || {});
    if (initialLink.requiresPassword) {
      sessionStorageAdapter.setItem(PASSWORD_REQUIRED_KEY, '1');
    }

    const client = supabaseGlobal.createClient(
      settings.supabaseUrl,
      settings.publishableKey,
      {
        auth: {
          storage: sessionStorageAdapter,
          storageKey: AUTH_STORAGE_KEY,
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true,
          flowType: 'implicit'
        }
      }
    );

    let enrollment = null;
    const authListener = client.auth.onAuthStateChange(function (event, session) {
      onAuthEvent(event, session || null);
    });

    function requiresPassword() {
      return sessionStorageAdapter.getItem(PASSWORD_REQUIRED_KEY) === '1';
    }

    function clearPasswordRequirement() {
      sessionStorageAdapter.removeItem(PASSWORD_REQUIRED_KEY);
    }

    function pendingFactorId() {
      return String(sessionStorageAdapter.getItem(PENDING_FACTOR_KEY) || '').trim();
    }

    function rememberPendingFactor(factorId) {
      const normalized = String(factorId || '').trim();
      if (normalized) sessionStorageAdapter.setItem(PENDING_FACTOR_KEY, normalized);
    }

    function clearPendingFactor() {
      sessionStorageAdapter.removeItem(PENDING_FACTOR_KEY);
    }

    async function initialize() {
      if (initialLink.linkError) {
        clearPasswordRequirement();
        cleanAuthUrl(windowLike);
        throw authError('invalid_invite', 'Este convite é inválido ou expirou.');
      }
      if (initialLink.tokenHash && SUPPORTED_LINK_TYPES.has(initialLink.type)) {
        const verified = await client.auth.verifyOtp({
          token_hash: initialLink.tokenHash,
          type: initialLink.type
        });
        if (verified.error) {
          clearPasswordRequirement();
          cleanAuthUrl(windowLike);
          throw authError('invalid_invite', 'Este convite é inválido ou expirou.', verified.error);
        }
      }

      const result = await client.auth.getSession();
      if (result.error) {
        throw authError('session_error', 'Não foi possível validar a sessão individual.', result.error);
      }
      if (initialLink.requiresPassword && !(result.data && result.data.session)) {
        clearPasswordRequirement();
        cleanAuthUrl(windowLike);
        throw authError('invalid_invite', 'Este convite é inválido ou expirou.');
      }
      if (result.data && result.data.session) cleanAuthUrl(windowLike);
      return {
        session: result.data && result.data.session || null,
        linkType: initialLink.type,
        requiresPassword: requiresPassword()
      };
    }

    async function signIn(email, password) {
      const normalizedEmail = String(email || '').trim().toLowerCase();
      if (!normalizedEmail || !String(password || '')) {
        throw authError('missing_credentials', 'Informe o e-mail e a senha.');
      }
      const result = await client.auth.signInWithPassword({
        email: normalizedEmail,
        password: String(password)
      });
      if (result.error || !result.data || !result.data.session) {
        throw authError('invalid_credentials', 'E-mail ou senha não conferem.', result.error);
      }
      return result.data.session;
    }

    async function updatePassword(password) {
      const nextPassword = String(password || '');
      if (nextPassword.length < 12) {
        throw authError('weak_password', 'Crie uma senha com pelo menos 12 caracteres.');
      }
      const result = await client.auth.updateUser({ password: nextPassword });
      if (result.error) {
        throw authError('password_update_failed', 'Não foi possível definir a senha.', result.error);
      }
      clearPasswordRequirement();
      return result.data && result.data.user || null;
    }

    async function getSession() {
      const result = await client.auth.getSession();
      if (result.error) {
        throw authError('session_error', 'Não foi possível validar a sessão individual.', result.error);
      }
      return result.data && result.data.session || null;
    }

    async function getNextStep() {
      const session = await getSession();
      if (!session) return { step: 'login', session: null };
      if (requiresPassword()) return { step: 'password', session };

      const result = await client.auth.mfa.getAuthenticatorAssuranceLevel();
      if (result.error) {
        throw authError('aal_error', 'Não foi possível conferir a proteção em duas etapas.', result.error);
      }
      const aal = result.data || {};
      if (aal.currentLevel === 'aal2') return { step: 'ready', session, aal };
      if (aal.nextLevel === 'aal2') return { step: 'challenge', session, aal };
      return { step: 'enroll', session, aal };
    }

    async function beginEnrollment() {
      const factorsResult = await client.auth.mfa.listFactors();
      if (factorsResult.error) {
        throw authError('factor_list_failed', 'Não foi possível consultar o autenticador.', factorsResult.error);
      }
      const factorData = factorsResult.data || {};
      const verifiedTotp = (factorData.totp || []).find(function (factor) {
        return !factor.status || factor.status === 'verified';
      });
      if (verifiedTotp) {
        enrollment = null;
        clearPendingFactor();
        return { alreadyEnrolled: true, factorId: verifiedTotp.id };
      }

      const unverified = (factorData.all || []).filter(function (factor) {
        return factor.factor_type === 'totp' && factor.status === 'unverified';
      });
      const pendingId = pendingFactorId();
      const resumable = unverified.find(function (factor) {
        return pendingId && factor.id === pendingId;
      });
      if (resumable) {
        enrollment = {
          factorId: resumable.id,
          qrCode: '',
          secret: '',
          resumed: true
        };
        return {
          alreadyEnrolled: false,
          resumed: true,
          factorId: enrollment.factorId,
          qrCode: '',
          secret: ''
        };
      }

      clearPendingFactor();
      for (const factor of unverified) {
        const removed = await client.auth.mfa.unenroll({ factorId: factor.id });
        if (removed.error) {
          throw authError(
            'factor_cleanup_failed',
            'Não foi possível reiniciar a configuração do autenticador.',
            removed.error
          );
        }
      }

      const enrolled = await client.auth.mfa.enroll({
        factorType: 'totp',
        friendlyName: 'Ana Maria Jacob - aplicativo Fichas'
      });
      if (enrolled.error || !enrolled.data || !enrolled.data.totp) {
        throw authError('enrollment_failed', 'Não foi possível iniciar o autenticador.', enrolled.error);
      }
      enrollment = {
        factorId: enrolled.data.id,
        qrCode: enrolled.data.totp.qr_code,
        secret: enrolled.data.totp.secret
      };
      rememberPendingFactor(enrollment.factorId);
      return {
        alreadyEnrolled: false,
        resumed: false,
        factorId: enrollment.factorId,
        qrCode: enrollment.qrCode,
        secret: enrollment.secret
      };
    }

    async function verifyFactor(factorId, rawCode) {
      const code = normalizeOtp(rawCode);
      const challenged = await client.auth.mfa.challenge({ factorId });
      if (challenged.error || !challenged.data || !challenged.data.id) {
        throw authError('challenge_failed', 'Não foi possível validar este código.', challenged.error);
      }
      const verified = await client.auth.mfa.verify({
        factorId,
        challengeId: challenged.data.id,
        code
      });
      if (verified.error) {
        throw authError('invalid_totp_code', 'O código não confere ou já expirou.', verified.error);
      }

      let next = await getNextStep();
      if (next.step !== 'ready') {
        const refreshed = await client.auth.refreshSession();
        if (refreshed.error) {
          throw authError('aal_refresh_failed', 'O código foi aceito, mas a sessão não foi atualizada.', refreshed.error);
        }
        next = await getNextStep();
      }
      if (next.step !== 'ready') {
        throw authError('aal2_required', 'A proteção em duas etapas ainda não foi confirmada.');
      }
      return next.session;
    }

    async function verifyEnrollment(code) {
      if (!enrollment || !enrollment.factorId) {
        throw authError('enrollment_missing', 'Reinicie a configuração do autenticador.');
      }
      const session = await verifyFactor(enrollment.factorId, code);
      enrollment = null;
      clearPendingFactor();
      return session;
    }

    async function verifyChallenge(code) {
      const factorsResult = await client.auth.mfa.listFactors();
      if (factorsResult.error) {
        throw authError('factor_list_failed', 'Não foi possível consultar o autenticador.', factorsResult.error);
      }
      const factor = ((factorsResult.data && factorsResult.data.totp) || []).find(function (item) {
        return !item.status || item.status === 'verified';
      });
      if (!factor || !factor.id) {
        throw authError('factor_missing', 'Nenhum autenticador ativo foi encontrado.');
      }
      return verifyFactor(factor.id, code);
    }

    async function signOut() {
      enrollment = null;
      clearPendingFactor();
      clearPasswordRequirement();
      const result = await client.auth.signOut({ scope: 'local' });
      if (result && result.error) {
        throw authError('signout_failed', 'Não foi possível encerrar a sessão completamente.', result.error);
      }
    }

    function destroy() {
      const subscription = authListener && authListener.data && authListener.data.subscription;
      if (subscription && typeof subscription.unsubscribe === 'function') subscription.unsubscribe();
      enrollment = null;
    }

    return {
      client,
      initialize,
      signIn,
      updatePassword,
      getSession,
      getNextStep,
      beginEnrollment,
      verifyEnrollment,
      verifyChallenge,
      signOut,
      requiresPassword,
      clearPasswordRequirement,
      destroy
    };
  }

  global.AMJAuth = Object.freeze({
    CLIENT_VERSION,
    AUTH_STORAGE_KEY,
    PASSWORD_REQUIRED_KEY,
    PENDING_FACTOR_KEY,
    createController,
    normalizeOtp,
    readAuthLink
  });
})(window);

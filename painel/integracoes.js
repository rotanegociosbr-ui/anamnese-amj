(function () {
  'use strict';

  const API = 'https://rjxtxoqprnumouqakxbc.supabase.co/functions/v1/integracoes-fichas';
  const DATE_TIME = new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Sao_Paulo'
  });
  const PROVIDERS = Object.freeze([
    Object.freeze({ key: 'site', title: 'Formulários do site', symbol: 'SITE',
      description: 'Captação interna de pedidos do site para revisão segura no CRM da clínica.' }),
    Object.freeze({ key: 'whatsapp', title: 'WhatsApp oficial', symbol: 'WA',
      description: 'Preparação para confirmações, lembretes e acompanhamento por canal oficial.' }),
    Object.freeze({ key: 'calendario', title: 'Calendário', symbol: 'CAL',
      description: 'Preparação para sincronizar compromissos autorizados sem duplicar a agenda.' }),
    Object.freeze({ key: 'pagamentos', title: 'Pagamentos online', symbol: 'R$',
      description: 'Preparação para conciliar pagamentos autorizados sem iniciar cobranças.' }),
    Object.freeze({ key: 'outras_apis', title: 'Outras APIs', symbol: 'API',
      description: 'Base reservada para integrações futuras avaliadas e autorizadas pela clínica.' })
  ]);
  const ALIASES = Object.freeze({
    site_futuro: 'site', site_formularios: 'site', formularios_site: 'site', formularios: 'site',
    whatsapp_oficial: 'whatsapp', meta_whatsapp: 'whatsapp',
    calendar: 'calendario', google_calendar: 'calendario', agenda_externa: 'calendario',
    pagamentos_online: 'pagamentos', pagamento: 'pagamentos', payment: 'pagamentos', payments: 'pagamentos',
    outros: 'outras_apis', other: 'outras_apis', outras: 'outras_apis'
  });
  const SAFE_STATE = Object.freeze({
    operation: 'Desativado', verification: 'Não verificado', connection: 'Sem conexão externa'
  });
  const INTERNAL_SITE_STATE = Object.freeze({
    operation: 'Ativo internamente', verification: 'Verificado', connection: 'Somente Supabase da clínica'
  });
  const state = {
    root: null, loaded: false, loading: false, generation: 0, controller: null,
    integrations: [], checkedAt: '', registered: new Set()
  };

  function text(value) { return String(value == null ? '' : value).trim(); }
  function escapeHtml(value) {
    return text(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }
  function normalized(value) {
    return text(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
      .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  }
  function ownerAccess() {
    try {
      return typeof modoAcesso !== 'undefined' && modoAcesso === 'auth' &&
        typeof identidadeBackend !== 'undefined' && identidadeBackend &&
        text(identidadeBackend.role).toLowerCase() === 'owner';
    } catch (_) { return false; }
  }
  function byId(id) { return state.root && state.root.querySelector('#' + id); }
  function safeDateTime(value) {
    if (!value) return '';
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? DATE_TIME.format(parsed) : '';
  }
  function unwrap(payload) {
    if (!payload || typeof payload !== 'object') return {};
    let result = payload;
    if (result.data && typeof result.data === 'object' && !Array.isArray(result.data)) result = result.data;
    return result || {};
  }
  function integrationRows(payload) {
    const envelope = unwrap(payload);
    const source = envelope.integracoes || envelope.conexoes || envelope.providers || [];
    if (Array.isArray(source)) return source;
    if (!source || typeof source !== 'object') return [];
    return Object.keys(source).map(function (key) {
      const row = source[key];
      return Object.assign({ codigo: key }, row && typeof row === 'object' ? row : {});
    });
  }
  function normalizeIntegrations(payload) {
    const registered = new Set();
    const rowsByKey = new Map();
    integrationRows(payload).forEach(function (row) {
      const sourceKey = normalized(row && (row.id || row.codigo || row.code || row.chave || row.key || row.tipo || row.provider));
      const key = ALIASES[sourceKey] || sourceKey;
      if (PROVIDERS.some(function (provider) { return provider.key === key; })) {
        registered.add(key);
        rowsByKey.set(key, row || {});
      }
    });
    return PROVIDERS.map(function (provider) {
      const raw = rowsByKey.get(provider.key) || {};
      const internalActive = provider.key === 'site' && raw.state === 'internal_active' &&
        raw.enabled === true && raw.verified === true && raw.external_calls_allowed === false;
      const displayState = internalActive ? INTERNAL_SITE_STATE : SAFE_STATE;
      return Object.freeze({
        key: provider.key, title: provider.title, symbol: provider.symbol, description: provider.description,
        operation: displayState.operation, verification: displayState.verification,
        connection: displayState.connection, registered: registered.has(provider.key), active: internalActive
      });
    });
  }
  function checkedAtFrom(payload) {
    const envelope = unwrap(payload);
    return safeDateTime(envelope.atualizado_em || envelope.consultado_em || envelope.checked_at || envelope.generated_at);
  }

  function shell() {
    return '<section class="integracoes-shell" aria-labelledby="integracoes-titulo">' +
      '<header class="integracoes-header"><div><p>Fase 5B · captação interna segura</p>' +
      '<h2 id="integracoes-titulo">Central de integrações</h2>' +
      '<span>Consulte o recebimento interno do site e os provedores externos que continuam bloqueados.</span></div>' +
      '<button type="button" data-integracoes-atualizar>Atualizar status</button></header>' +
      '<aside class="integracoes-safe-note" role="note"><strong>Sem cobrança nova</strong>' +
      '<span>WhatsApp API, calendário, pagamentos e demais provedores continuam desligados. Nenhuma assinatura ou cobrança foi ativada.</span></aside>' +
      '<aside class="integracoes-site-note" role="note"><strong>Pedidos do site no CRM</strong>' +
      '<span>O formulário de agendamento salva o pedido na caixa privada da clínica. O pedido não reserva horário automaticamente.</span></aside>' +
      '<aside class="integracoes-site-note" role="note"><strong>WhatsApp Web assistido</strong>' +
      '<span>Confirmações, lembretes e retornos podem abrir a conversa com texto pronto quando a sessão estiver conectada. A equipe confere e envia manualmente; nenhuma API paga ou robô de envio foi ativado.</span></aside>' +
      '<p id="integracoes-status" class="integracoes-status" role="status" aria-live="polite"></p>' +
      '<div id="integracoes-cards" class="integracoes-cards" aria-live="off"></div>' +
      '<footer class="integracoes-footer"><strong>Próximas etapas, somente quando autorizadas</strong>' +
      '<span>Cada integração será tratada separadamente, com testes, auditoria e opção de permanecer desligada.</span></footer>' +
      '</section>';
  }
  function card(row) {
    return '<article class="integracoes-card" data-integracao="' + escapeHtml(row.key) + '">' +
      '<header><span class="integracoes-symbol" aria-hidden="true">' + escapeHtml(row.symbol) + '</span>' +
      '<div><h3>' + escapeHtml(row.title) + '</h3><p>' + escapeHtml(row.description) + '</p></div></header>' +
      '<dl><div><dt>Operação</dt><dd><span class="integracoes-dot' + (row.active ? ' ativo' : '') + '" aria-hidden="true"></span>' + escapeHtml(row.operation) + '</dd></div>' +
      '<div><dt>Verificação</dt><dd>' + escapeHtml(row.verification) + '</dd></div>' +
      '<div><dt>Conexão externa</dt><dd>' + escapeHtml(row.connection) + '</dd></div></dl>' +
      '<p class="integracoes-registry">' + (row.active ? 'Fluxo interno ativo, sem chamada a provedor externo.' :
        (row.registered ? 'Base identificada; conexão externa continua bloqueada.' : 'Aguardando configuração futura; continua bloqueada.')) + '</p>' +
      '</article>';
  }
  function render() {
    const cards = byId('integracoes-cards');
    if (!cards) return;
    const rows = state.integrations.length ? state.integrations : normalizeIntegrations({});
    cards.innerHTML = rows.map(card).join('');
  }
  function setStatus(message, error) {
    const node = byId('integracoes-status');
    if (!node) return;
    node.textContent = message || '';
    node.classList.toggle('erro', Boolean(error));
  }
  function setBusy(busy) {
    state.loading = Boolean(busy);
    if (!state.root) return;
    state.root.setAttribute('aria-busy', String(state.loading));
    const button = state.root.querySelector('[data-integracoes-atualizar]');
    if (button) button.disabled = state.loading;
  }
  function requestIsCurrent(generation, controller) {
    return generation === state.generation && controller === state.controller;
  }
  async function load(force) {
    if (!ownerAccess() || state.loading || (state.loaded && !force)) return;
    if (typeof cabecalhosAcesso !== 'function') {
      setStatus('O acesso seguro não foi carregado. Tudo continua desativado e sem conexão externa.', true);
      return;
    }
    const generation = state.generation;
    if (state.controller) state.controller.abort();
    const controller = new AbortController();
    state.controller = controller;
    setBusy(true);
    setStatus('Consultando somente o status seguro…', false);
    try {
      const headers = await cabecalhosAcesso(true);
      if (generation !== state.generation || !ownerAccess()) throw new Error('Sessão de integrações encerrada.');
      const response = await fetch(API, {
        method: 'POST', headers: headers, cache: 'no-store', referrerPolicy: 'no-referrer',
        signal: controller.signal, body: JSON.stringify({ acao: 'status' })
      });
      let data = {};
      try { data = await response.json(); } catch (_) { data = {}; }
      if (generation !== state.generation || !ownerAccess()) throw new Error('Sessão de integrações encerrada.');
      if (!response.ok || data.ok === false || data.erro || data.error) {
        const error = new Error(data.erro || data.error || 'Não foi possível consultar o status das integrações.');
        error.code = data.codigo || data.code || String(response.status);
        throw error;
      }
      if (data.identity && typeof atualizarIdentidade === 'function') atualizarIdentidade(data);
      state.integrations = normalizeIntegrations(data);
      state.checkedAt = checkedAtFrom(data);
      state.loaded = true;
      render();
      setStatus('Status atualizado' + (state.checkedAt ? ' em ' + state.checkedAt : '') +
        '. A captação do site é interna e nenhuma conexão externa foi ativada.', false);
    } catch (error) {
      if ((error && error.name === 'AbortError') || !requestIsCurrent(generation, controller)) return;
      state.integrations = normalizeIntegrations({});
      render();
      setStatus((error && error.message ? error.message + ' ' : '') +
        'Por segurança, tudo continua desativado e sem conexão externa.', true);
    } finally {
      if (requestIsCurrent(generation, controller)) {
        state.controller = null;
        setBusy(false);
      }
    }
  }
  function bind() {
    if (!state.root || state.root.dataset.integracoesBound === '1') return;
    state.root.dataset.integracoesBound = '1';
    state.root.addEventListener('click', function (event) {
      if (event.target.closest('[data-integracoes-atualizar]')) void load(true);
    });
  }
  function mount(target) {
    const root = typeof target === 'string' ? document.querySelector(target) : target;
    if (!root) return false;
    if (state.root && state.root !== root) reset();
    state.root = root;
    state.root.innerHTML = shell();
    state.integrations = normalizeIntegrations({});
    bind();
    render();
    updateAccess();
    return true;
  }
  function activate() {
    updateAccess();
    if (ownerAccess() && !state.loaded && !state.loading) void load(false);
  }
  function updateAccess() {
    const allowed = ownerAccess();
    const tab = document.getElementById('aba-bt-integracoes');
    if (tab) { tab.hidden = !allowed; tab.disabled = !allowed; }
    if (!state.root) return;
    state.root.hidden = !allowed;
    if (!allowed) setStatus('Esta área exige a conta proprietária com MFA.', true);
  }
  function reset() {
    state.generation += 1;
    if (state.controller) state.controller.abort();
    state.controller = null;
    state.loaded = false;
    state.loading = false;
    state.checkedAt = '';
    state.registered = new Set();
    state.integrations = normalizeIntegrations({});
    if (state.root) {
      state.root.innerHTML = shell();
      delete state.root.dataset.integracoesBound;
      bind();
      render();
      state.root.hidden = true;
    }
  }

  window.AMJIntegracoes = Object.freeze({
    montar: mount, ativar: activate, carregar: load, atualizarAcesso: updateAccess, reset: reset,
    contrato: Object.freeze({ endpoint: API, acao: 'status', somenteLeitura: true, ownerMfa: true,
      captacaoSiteInterna: true, conexoesExternas: false, cobrancasNovas: false,
      whatsappManual: true, whatsappWebAssistido: true, envioAutomatico: false }),
    __test: Object.freeze({ normalizeIntegrations: normalizeIntegrations, checkedAtFrom: checkedAtFrom,
      requestIsCurrent: requestIsCurrent })
  });
}());

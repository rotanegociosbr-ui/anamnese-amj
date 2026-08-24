(function () {
  'use strict';

  const ROUTES = Object.freeze({
    inicio: Object.freeze({ title: 'Início', legacy: 'inicio', group: 'principal' }),
    procedimentos: Object.freeze({ title: 'Procedimentos', legacy: 'operacao', owner: true, group: 'principal' }),
    clientes: Object.freeze({ title: 'Clientes', legacy: 'financeiro', owner: true, financeView: 'clientes', group: 'principal' }),
    agenda: Object.freeze({ title: 'Agenda', legacy: 'agenda', group: 'principal' }),
    receitas: Object.freeze({ title: 'Receitas avulsas', legacy: 'financeiro', owner: true, financeView: 'receitas', entryView: 'receitas_avulsas', group: 'principal' }),
    despesas: Object.freeze({ title: 'Despesas', legacy: 'financeiro', owner: true, financeView: 'despesas', entryView: 'despesas', group: 'principal' }),
    estoque: Object.freeze({ title: 'Estoque', legacy: 'financeiro', owner: true, financeView: 'estoque', group: 'principal' }),
    cotacoes: Object.freeze({ title: 'Cotações e preços', legacy: 'cotacoes', owner: true, group: 'principal' }),
    fichas: Object.freeze({ title: 'Fichas', legacy: 'fichas', group: 'principal' }),
    gestao: Object.freeze({ title: 'Gestão', legacy: 'gestao', owner: true, group: 'principal' }),
    prontuarios: Object.freeze({ title: 'Fotos e prontuários', legacy: 'prontuarios', owner: true, group: 'secondary' })
  });

  const PRIMARY_ORDER = ['inicio', 'procedimentos', 'clientes', 'agenda', 'receitas', 'despesas', 'estoque', 'cotacoes', 'fichas', 'gestao'];
  const SECONDARY_ORDER = ['prontuarios'];
  const STORAGE_ROUTE = 'amj_shell_route';
  const MODULES = Object.freeze({
    operacao: Object.freeze({
      global: 'AMJOperacaoClinica',
      src: './operacao.js?v=20260824-2',
      root: 'operacao-clinica-root'
    }),
    gestao: Object.freeze({
      global: 'AMJGestaoAdministrativa',
      src: './gestao.js?v=20260824-1',
      root: 'gestao-administrativa-root'
    }),
    cotacoes: Object.freeze({
      global: 'AMJCotacoes',
      src: './cotacoes.js?v=20260824-1',
      root: 'cotacoes-root'
    })
  });

  const ICONS = Object.freeze({
    inicio: '<path d="M3 10.5 10 4l7 6.5v6.2a1.3 1.3 0 0 1-1.3 1.3H4.3A1.3 1.3 0 0 1 3 16.7Z"/><path d="M7.5 18v-5h5v5"/>',
    procedimentos: '<path d="M6.5 4.5h7v12h-7z"/><path d="M8.5 2.5h3v3h-3zM8.5 9.5h3M10 8v3M14 7h2.5M14 10h2.5M14 13h2.5"/>',
    clientes: '<circle cx="8" cy="7" r="3"/><path d="M2.8 17c.6-3 2.3-4.5 5.2-4.5s4.6 1.5 5.2 4.5M14 7.5a2.5 2.5 0 0 1 0 5M14.5 13.5c1.5.5 2.4 1.6 2.7 3.5"/>',
    agenda: '<rect x="3" y="4.5" width="14" height="13" rx="2"/><path d="M6.5 2.5v4M13.5 2.5v4M3 8h14M6.5 11.5h.01M10 11.5h.01M13.5 11.5h.01M6.5 14.5h.01M10 14.5h.01"/>',
    receitas: '<path d="M3 6h14v10H3zM3 9h14M6 13h3"/><path d="m13.5 3 2 2 2-2"/>',
    despesas: '<path d="M3 6h14v10H3zM3 9h14M6 13h3"/><path d="m13.5 3 2-2 2 2"/>',
    estoque: '<path d="m3 6 7-3 7 3-7 3Z"/><path d="M3 6v8l7 3 7-3V6M10 9v8"/>',
    cotacoes: '<path d="M3 5h14v11H3z"/><path d="M3 8h14M6 12h2M12 11.5c-.4-.5-1-.7-1.6-.5-.7.2-.9 1.1-.3 1.5l1.5.7c.7.4.5 1.4-.2 1.6-.7.2-1.4 0-1.8-.5M11 10v1M11 15v1"/>',
    fichas: '<path d="M5 2.5h7l3 3V18H5z"/><path d="M12 2.5V6h3M7.5 10h5M7.5 13h5M7.5 16h3"/>',
    gestao: '<path d="M3 17V9h3v8M8.5 17V5h3v12M14 17V2.5h3V17M2 17.5h16"/>',
    prontuarios: '<rect x="2.5" y="4" width="15" height="12" rx="2"/><circle cx="7" cy="8" r="1.5"/><path d="m4.5 14 4-3 2.5 2 2.5-2 2 3"/>',
    mais: '<circle cx="4" cy="10" r="1"/><circle cx="10" cy="10" r="1"/><circle cx="16" cy="10" r="1"/>'
  });

  const state = {
    mounted: false,
    authenticated: false,
    currentRoute: 'inicio',
    pendingFinanceRoute: null,
    lastFocused: null,
    scripts: new Map(),
    accessObserver: null,
    panelObserver: null,
    metricObservers: [],
    restoredForSession: false,
    routeStatusTimer: 0,
    mobileMedia: null,
    openingExisting: new Set()
  };

  function byId(id) { return document.getElementById(id); }
  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function icon(name) {
    return '<svg aria-hidden="true" viewBox="0 0 20 20">' + (ICONS[name] || ICONS.mais) + '</svg>';
  }
  function isOwner() {
    try {
      return typeof modoAcesso !== 'undefined' && modoAcesso === 'auth' &&
        typeof identidadeBackend !== 'undefined' && identidadeBackend &&
        String(identidadeBackend.role || '').toLowerCase() === 'owner';
    } catch (_) { return false; }
  }
  function routeAllowed(route) {
    if (!route) return false;
    return !route.owner || isOwner();
  }
  function isVisible(element) {
    return Boolean(element && !element.hidden && !element.classList.contains('oculto'));
  }

  function navButton(routeName, mobile) {
    const route = ROUTES[routeName];
    if (mobile) {
      return '<button class="app-mobile-action" type="button" data-shell-route="' + routeName + '">' +
        icon(routeName) + '<span>' + escapeHtml(route.title) + '</span></button>';
    }
    return '<button class="app-shell-nav-button" type="button" data-shell-route="' + routeName + '">' +
      '<span class="app-shell-nav-icon">' + icon(routeName) + '</span>' +
      '<span>' + escapeHtml(route.title) + '</span><span class="app-shell-nav-arrow" aria-hidden="true">›</span></button>';
  }

  function buildShell() {
    const list = byId('tela-lista');
    if (!list || list.querySelector('.app-shell-layout')) return;
    const identity = list.querySelector('.identidade-sessao');
    const tabs = list.querySelector('.abas');
    const panels = Array.from(list.children).filter(function (child) {
      return child.classList && child.classList.contains('painel-aba');
    });

    const layout = document.createElement('div');
    layout.className = 'app-shell-layout';
    layout.innerHTML =
      '<button class="app-shell-overlay" type="button" aria-label="Fechar menu"></button>' +
      '<aside class="app-shell-sidebar" id="app-shell-sidebar" aria-label="Menu principal">' +
        '<div class="app-shell-brand"><img src="../assets/identidade-visual-transparente-v1.png" alt=""><div>' +
          '<strong>Ana Maria Jacob</strong><span>Gestão da clínica</span></div></div>' +
        '<div class="app-shell-nav-scroll"><p class="app-shell-nav-label">Trabalho</p>' +
          '<nav class="app-shell-nav" aria-label="Áreas principais">' + PRIMARY_ORDER.map(function (route) {
            return navButton(route, false);
          }).join('') + '</nav><p class="app-shell-nav-label">Registro clínico</p>' +
          '<nav class="app-shell-nav" aria-label="Área clínica protegida">' + SECONDARY_ORDER.map(function (route) {
            return navButton(route, false);
          }).join('') + '</nav></div>' +
        '<div class="app-shell-privacy"><strong>Dados privados</strong>Pacientes, fotos, fichas e finanças permanecem nas áreas protegidas da clínica.</div>' +
      '</aside>' +
      '<div class="app-shell-workspace"><header class="app-shell-topbar">' +
        '<button class="app-shell-menu-button" type="button" aria-expanded="false" aria-controls="app-shell-sidebar" aria-label="Abrir menu"><span></span></button>' +
        '<div class="app-shell-location"><span class="app-shell-breadcrumb">Fichas / área atual</span>' +
          '<h1 class="app-shell-current-title" id="app-shell-current-title" tabindex="-1">Início</h1></div>' +
        '<div class="app-shell-session"></div></header>' +
        '<div class="app-shell-content" id="app-shell-content"></div></div>' +
      '<nav class="app-shell-mobile-bar" aria-label="Atalhos no celular">' +
        navButton('inicio', true) + navButton('procedimentos', true) + navButton('agenda', true) +
        '<button class="app-mobile-action" type="button" data-shell-open-menu>' + icon('mais') + '<span>Mais</span></button>' +
      '</nav><p class="app-shell-route-status" role="status" aria-live="polite"></p>';

    const sessionSlot = layout.querySelector('.app-shell-session');
    const content = layout.querySelector('.app-shell-content');
    if (identity) sessionSlot.appendChild(identity);
    if (tabs) content.appendChild(tabs);
    panels.forEach(function (panel) { content.appendChild(panel); });
    list.appendChild(layout);
  }

  function setRouteStatus(message) {
    const node = document.querySelector('.app-shell-route-status');
    if (!node) return;
    clearTimeout(state.routeStatusTimer);
    node.textContent = message || '';
    if (message) state.routeStatusTimer = window.setTimeout(function () { node.textContent = ''; }, 5000);
  }

  function openDrawer() {
    state.lastFocused = document.activeElement;
    document.body.classList.add('app-shell-drawer-open');
    updateDrawerAccessibility();
    const button = document.querySelector('.app-shell-menu-button');
    if (button) button.setAttribute('aria-expanded', 'true');
    const first = document.querySelector('.app-shell-sidebar .app-shell-nav-button:not([hidden])');
    if (first) window.setTimeout(function () { first.focus(); }, 20);
  }
  function closeDrawer(restoreFocus) {
    document.body.classList.remove('app-shell-drawer-open');
    const button = document.querySelector('.app-shell-menu-button');
    if (button) button.setAttribute('aria-expanded', 'false');
    if (restoreFocus && state.lastFocused && typeof state.lastFocused.focus === 'function') state.lastFocused.focus();
    updateDrawerAccessibility();
  }

  function updateDrawerAccessibility() {
    const sidebar = byId('app-shell-sidebar');
    if (!sidebar) return;
    const mobile = state.mobileMedia ? state.mobileMedia.matches : window.innerWidth <= 840;
    const open = document.body.classList.contains('app-shell-drawer-open');
    sidebar.inert = Boolean(mobile && !open);
    if (mobile && !open) sidebar.setAttribute('aria-hidden', 'true');
    else sidebar.removeAttribute('aria-hidden');
  }

  function setControlAccess(button, allowed) {
    const blocked = !allowed;
    // O observador de acesso também acompanha estes atributos. Reescrevê-los
    // sem mudança real cria um ciclo infinito de MutationObserver no navegador.
    if (button.hidden !== blocked) button.hidden = blocked;
    if (button.disabled !== blocked) button.disabled = blocked;
  }

  function syncAccess() {
    const owner = isOwner();
    document.querySelectorAll('[data-shell-route]').forEach(function (button) {
      const route = ROUTES[button.dataset.shellRoute];
      if (!route) return;
      const allowed = routeAllowed(route);
      setControlAccess(button, allowed);
    });

    ['operacao', 'gestao', 'cotacoes'].forEach(function (legacy) {
      const button = byId('aba-bt-' + legacy);
      if (!button) return;
      const allowed = owner;
      setControlAccess(button, allowed);
    });

    const mobile = document.querySelector('.app-shell-mobile-bar');
    if (mobile) {
      const visible = Array.from(mobile.querySelectorAll('button')).filter(function (button) { return !button.hidden; }).length;
      mobile.style.gridTemplateColumns = 'repeat(' + Math.max(1, visible) + ', minmax(0, 1fr))';
    }
    if (window.AMJCotacoes && typeof window.AMJCotacoes.atualizarAcesso === 'function') {
      window.AMJCotacoes.atualizarAcesso();
    }
    if (!routeAllowed(ROUTES[state.currentRoute]) && state.authenticated) {
      void navigate('inicio', { source: 'access', focus: false, persist: false });
    }
  }

  function updateRouteChrome(routeName) {
    const route = ROUTES[routeName] || ROUTES.inicio;
    state.currentRoute = routeName;
    const title = byId('app-shell-current-title');
    if (title) title.textContent = route.title;
    document.querySelectorAll('[data-shell-route]').forEach(function (button) {
      const active = button.dataset.shellRoute === routeName;
      if (active) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });
    if (state.authenticated) document.title = route.title + ' — Ana Maria Jacob Estética';
  }

  function ensureModule(legacy) {
    const config = MODULES[legacy];
    if (!config) return Promise.resolve(null);
    const prepare = function (api) {
      const root = byId(config.root);
      if (root && typeof api.montar === 'function' && !root.firstElementChild) api.montar(root);
      if (typeof api.atualizarAcesso === 'function') api.atualizarAcesso();
      return api;
    };
    if (window[config.global]) return Promise.resolve(prepare(window[config.global]));
    if (state.scripts.has(legacy)) return state.scripts.get(legacy);
    const promise = new Promise(function (resolve, reject) {
      const script = document.createElement('script');
      script.src = config.src;
      script.async = true;
      script.onload = function () {
        const api = window[config.global];
        if (!api) { reject(new Error('O módulo foi carregado, mas não iniciou.')); return; }
        resolve(prepare(api));
      };
      script.onerror = function () { reject(new Error('Não foi possível carregar esta área agora.')); };
      document.head.appendChild(script);
    }).catch(function (error) {
      state.scripts.delete(legacy);
      throw error;
    });
    state.scripts.set(legacy, promise);
    return promise;
  }

  function activateLegacy(route) {
    const legacyButton = byId('aba-bt-' + route.legacy);
    if (legacyButton && route.owner && isOwner()) {
      legacyButton.hidden = false;
      legacyButton.disabled = false;
    }
    if (typeof window.agendaAtivarAba === 'function') window.agendaAtivarAba(route.legacy, false);
  }

  function financeContextCopy(routeName) {
    const copies = {
      clientes: ['Clientes', 'Cadastros reaproveitáveis, pesquisáveis e ligados ao histórico da paciente.'],
      receitas: ['Receitas avulsas', 'Entradas que não nasceram de um procedimento. Procedimentos permanecem na área própria.'],
      despesas: ['Despesas', 'Contas, compras e pagamentos com saldo, datas e histórico auditável.'],
      estoque: ['Estoque', 'Produtos, compras, lotes, validades, consumo e frete no custo real.']
    };
    return copies[routeName] || ['Financeiro', 'Gestão financeira protegida.'];
  }

  function financeContextActions(routeName) {
    const refresh = '<button type="button" data-app-action="refresh-finance" class="secundario">Atualizar</button>';
    if (routeName === 'clientes') {
      return refresh + '<button type="button" data-app-action="focus-client-search" class="secundario">Buscar cliente</button>' +
        '<button type="button" data-app-action="new-client">Novo cliente</button>';
    }
    if (routeName === 'receitas') {
      return refresh + '<button type="button" data-app-action="view-finance-list" class="secundario">Ver registros</button>' +
        '<button type="button" data-app-action="new-revenue">Nova receita avulsa</button>';
    }
    if (routeName === 'despesas') {
      return refresh + '<button type="button" data-app-action="view-finance-list" class="secundario">Ver registros</button>' +
        '<button type="button" data-app-action="new-expense">Nova despesa</button>';
    }
    return refresh + '<button type="button" data-app-action="new-product" class="secundario">Cadastrar produto</button>' +
      '<button type="button" data-app-action="new-purchase">Registrar compra com frete</button>';
  }

  function ensureFinanceContext(routeName) {
    const content = byId('financeiro-conteudo');
    const panel = byId('aba-financeiro');
    if (!content || !panel) return;
    panel.dataset.appFinanceView = routeName;
    let context = byId('app-finance-context');
    if (!context) {
      context = document.createElement('section');
      context.id = 'app-finance-context';
      context.className = 'app-route-context';
      content.insertBefore(context, content.firstChild);
    }
    const copy = financeContextCopy(routeName);
    context.innerHTML = '<div><h2>' + escapeHtml(copy[0]) + '</h2><p>' + escapeHtml(copy[1]) +
      '</p></div><div class="app-context-actions">' + financeContextActions(routeName) + '</div>';
    applyFinanceEntryView(routeName);
  }

  function applyFinanceEntryView(routeName) {
    const route = ROUTES[routeName];
    if (!route || !route.entryView) return;
    const button = document.querySelector('[data-financeiro-visao="' + route.entryView + '"]');
    if (button && button.getAttribute('aria-pressed') !== 'true') {
      button.click();
      state.pendingFinanceRoute = null;
    } else if (!button) state.pendingFinanceRoute = routeName;
  }

  function openDetails(id, focusSelector) {
    const details = byId(id);
    if (!details) return false;
    details.open = true;
    details.scrollIntoView({ behavior: 'smooth', block: 'start' });
    const focusable = focusSelector ? details.querySelector(focusSelector) : details.querySelector('input:not([type="hidden"]),select,textarea,button');
    if (focusable) window.setTimeout(function () { focusable.focus({ preventScroll: true }); }, 250);
    return true;
  }

  function selectValue(id, value) {
    const control = byId(id);
    if (!control) return;
    control.value = value;
    control.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function waitForElement(selector, timeout) {
    const current = document.querySelector(selector);
    if (current) return Promise.resolve(current);
    return new Promise(function (resolve) {
      let finished = false;
      const observer = new MutationObserver(function () {
        const found = document.querySelector(selector);
        if (!found || finished) return;
        finished = true;
        observer.disconnect();
        resolve(found);
      });
      observer.observe(document.body, { childList: true, subtree: true });
      window.setTimeout(function () {
        if (finished) return;
        finished = true;
        observer.disconnect();
        resolve(null);
      }, Number(timeout) || 5000);
    });
  }

  async function openExisting(detail) {
    const data = detail || {};
    if (data.handled === true) return false;
    const type = String(data.type || data.tipo || '').toLowerCase();
    const id = String(data.id || data.existing_id || '').trim();
    if (!type || !id) return false;
    const key = type + ':' + id;
    if (state.openingExisting.has(key)) return false;
    state.openingExisting.add(key);
    try {
      if (['cliente', 'fornecedor', 'marca', 'produto'].includes(type)) {
        await navigate(type === 'produto' ? 'estoque' : 'clientes', { source: 'open-existing', focus: false });
        if (window.AMJFinanceiro && typeof window.AMJFinanceiro.abrirCadastro === 'function') {
          await window.AMJFinanceiro.abrirCadastro(type, id);
          return true;
        }
        const selector = '[data-financeiro-editar="' + CSS.escape(type) + '"][data-financeiro-id="' + CSS.escape(id) + '"]';
        const button = await waitForElement(selector, 5000);
        if (button) { button.click(); return true; }
      } else if (['atendimento', 'procedimento'].includes(type)) {
        await navigate('procedimentos', { source: 'open-existing', focus: false });
        if (window.AMJOperacaoClinica && typeof window.AMJOperacaoClinica.abrirAtendimento === 'function') {
          await window.AMJOperacaoClinica.abrirAtendimento(id);
          return true;
        }
        const button = await waitForElement('[data-atendimento-editar="' + CSS.escape(id) + '"]', 5000);
        if (button) { button.click(); return true; }
      } else if (['prontuario', 'protocolo'].includes(type)) {
        await navigate('prontuarios', { source: 'open-existing', focus: false });
        const button = await waitForElement('[data-prontuario-editar="' + CSS.escape(id) + '"]', 5000);
        if (button) { button.click(); return true; }
      }
      setRouteStatus('O registro existente foi localizado, mas não pôde ser aberto nesta tela. Atualize e tente novamente.');
      return false;
    } finally {
      state.openingExisting.delete(key);
    }
  }

  function handleAppAction(action) {
    if (action === 'refresh-finance') {
      const refresh = byId('financeiro-atualizar');
      if (refresh) refresh.click();
    } else if (action === 'new-client') openDetails('financeiro-editor-cliente', '#financeiro-cliente-pesquisa');
    else if (action === 'focus-client-search') {
      const search = byId('financeiro-clientes-busca');
      if (search) { search.scrollIntoView({ behavior: 'smooth', block: 'center' }); search.focus({ preventScroll: true }); }
    } else if (action === 'new-revenue') {
      openDetails('financeiro-editor-lancamento', '#financeiro-lancamento-tipo');
      selectValue('financeiro-lancamento-tipo', 'receita');
      selectValue('financeiro-lancamento-origem', 'operacional');
    } else if (action === 'new-expense') {
      openDetails('financeiro-editor-lancamento', '#financeiro-lancamento-tipo');
      selectValue('financeiro-lancamento-tipo', 'despesa');
    } else if (action === 'view-finance-list') {
      const list = byId('financeiro-lista-titulo');
      if (list) list.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else if (action === 'new-product') openDetails('financeiro-editor-catalogo', '#financeiro-produto-nome');
    else if (action === 'new-purchase') openDetails('financeiro-editor-compra', '#financeiro-compra-fornecedor');
  }

  function decorateProcedures() {
    const root = byId('operacao-clinica-root');
    if (!root || byId('app-procedure-context')) return;
    root.classList.add('app-shell-procedure-view');
    const context = document.createElement('section');
    context.id = 'app-procedure-context';
    context.className = 'app-procedure-context';
    context.innerHTML = '<div><h2>Procedimentos por paciente e data</h2>' +
      '<p>Registre a visita, os itens realizados, produtos, fotos antes/depois, cobrança e retorno no mesmo histórico.</p></div>' +
      '<div class="app-context-actions"><button type="button" class="secundario" data-app-action="refresh-procedures">Atualizar</button>' +
      '<button type="button" class="secundario" data-shell-route="prontuarios">Fotos e prontuários</button>' +
      '<button type="button" data-app-action="new-procedure">Novo procedimento</button></div>';
    root.insertBefore(context, root.firstChild);
  }

  function focusNewProcedure() {
    const form = document.querySelector('#operacao-clinica-root [data-form-atendimento]');
    if (!form) return;
    form.scrollIntoView({ behavior: 'smooth', block: 'start' });
    const first = form.querySelector('select[name="cliente_id"],input,select');
    if (first) window.setTimeout(function () { first.focus({ preventScroll: true }); }, 250);
  }

  function applyRouteAction(routeName, options) {
    const action = options && options.action;
    if (routeName === 'agenda') {
      const filterName = options && options.agendaFilter;
      if (action === 'novo-agendamento') {
        const editor = byId('agenda-editor');
        if (editor) { editor.open = true; editor.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
        const name = byId('agenda-nome');
        if (name) window.setTimeout(function () { name.focus({ preventScroll: true }); }, 250);
      } else if (filterName) {
        const filter = document.querySelector('.agenda-filtro[data-agenda-filtro="' + filterName + '"],.agenda-resumo[data-agenda-filtro="' + filterName + '"]');
        if (filter) filter.click();
      }
    } else if (routeName === 'clientes' && action === 'novo-cliente') handleAppAction('new-client');
    else if (routeName === 'estoque' && action === 'nova-compra') handleAppAction('new-purchase');
    else if (routeName === 'despesas' && action === 'nova-despesa') handleAppAction('new-expense');
    else if (routeName === 'procedimentos') {
      decorateProcedures();
      if (action === 'novo-procedimento') focusNewProcedure();
    }
  }

  async function navigate(routeName, options) {
    const route = ROUTES[routeName];
    const settings = options || {};
    if (!route) return false;
    if (!routeAllowed(route)) {
      setRouteStatus('Esta área exige a conta proprietária com autenticação em duas etapas.');
      return false;
    }
    closeDrawer(false);
    try {
      if (MODULES[route.legacy]) await ensureModule(route.legacy);
      activateLegacy(route);
      updateRouteChrome(routeName);
      if (route.financeView) ensureFinanceContext(routeName);
      applyRouteAction(routeName, settings);
      if (settings.persist !== false) sessionStorage.setItem(STORAGE_ROUTE, routeName);
      if (settings.focus !== false) {
        const title = byId('app-shell-current-title');
        if (title) title.focus({ preventScroll: true });
        const workspace = document.querySelector('.app-shell-workspace');
        if (workspace) workspace.scrollTo({ top: 0, behavior: 'smooth' });
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
      window.dispatchEvent(new CustomEvent('amj:shell-route', {
        detail: Object.freeze({ route: routeName, legacy: route.legacy, source: settings.source || 'interface' })
      }));
      return true;
    } catch (error) {
      setRouteStatus(error && error.message ? error.message : 'Não foi possível abrir esta área agora.');
      return false;
    }
  }

  function syncFromVisiblePanel() {
    if (!state.authenticated) return;
    const visible = Object.keys(ROUTES).find(function (routeName) {
      const route = ROUTES[routeName];
      return isVisible(byId('aba-' + route.legacy));
    });
    if (!visible) return;
    let routeName = visible;
    const legacy = ROUTES[visible].legacy;
    if (legacy === 'financeiro') {
      routeName = ['clientes', 'receitas', 'despesas', 'estoque'].includes(state.currentRoute) ? state.currentRoute : 'receitas';
    }
    if (routeName !== state.currentRoute) updateRouteChrome(routeName);
  }

  function updateMetrics() {
    const fichas = document.querySelector('[data-shell-metric="fichas"]');
    const fichasCount = byId('contagem');
    if (fichas && fichasCount && fichasCount.textContent.trim()) fichas.textContent = fichasCount.textContent.trim();
    const fichasStatus = byId('fichas-status');
    if (fichas && fichasStatus && fichasStatus.classList.contains('erro') && fichasStatus.textContent.trim()) {
      fichas.textContent = 'Fichas indisponíveis — abra para tentar novamente';
    }

    let agendaLoaded = false;
    try { agendaLoaded = typeof agendaCarregada !== 'undefined' && agendaCarregada === true; } catch (_) {}
    if (agendaLoaded) {
      const today = byId('agenda-total-hoje');
      const returns = byId('agenda-total-retornos');
      const todayMetric = document.querySelector('[data-shell-metric="agenda-hoje"]');
      const returnMetric = document.querySelector('[data-shell-metric="retornos"]');
      if (today && todayMetric) {
        const count = Number(today.textContent) || 0;
        todayMetric.textContent = count + (count === 1 ? ' agendamento hoje' : ' agendamentos hoje');
      }
      if (returns && returnMetric) {
        const count = Number(returns.textContent) || 0;
        returnMetric.textContent = count + (count === 1 ? ' retorno na fila' : ' retornos na fila');
      }
    } else {
      const agendaStatus = byId('agenda-status');
      if (agendaStatus && agendaStatus.classList.contains('erro') && agendaStatus.textContent.trim()) {
        const todayMetric = document.querySelector('[data-shell-metric="agenda-hoje"]');
        const returnMetric = document.querySelector('[data-shell-metric="retornos"]');
        if (todayMetric) todayMetric.textContent = 'Agenda indisponível — abra para tentar novamente';
        if (returnMetric) returnMetric.textContent = 'Retornos indisponíveis — abra para tentar novamente';
      }
    }

    const stockMetric = document.querySelector('[data-shell-metric="estoque"]');
    const stockPending = byId('financeiro-pendencias-contagem');
    if (stockMetric && stockPending) {
      const value = stockPending.textContent.trim();
      if (value && !/carregando/i.test(value)) stockMetric.textContent = value;
    }
    const financeLoaded = byId('financeiro-contagem') && byId('financeiro-contagem').textContent.trim();
    const installmentMetric = document.querySelector('[data-shell-metric="parcelas"]');
    const receivable = byId('financeiro-kpi-receber');
    if (financeLoaded && installmentMetric && receivable) installmentMetric.textContent = 'A receber: ' + receivable.textContent.trim();
    const financeStatus = byId('financeiro-status');
    if (financeStatus && financeStatus.classList.contains('erro') && financeStatus.textContent.trim()) {
      if (installmentMetric) installmentMetric.textContent = 'Financeiro indisponível — abra para tentar novamente';
      if (stockMetric) stockMetric.textContent = 'Estoque indisponível — abra para tentar novamente';
    }
  }

  function observeMetrics() {
    ['contagem', 'fichas-status', 'agenda-total-hoje', 'agenda-total-retornos', 'agenda-status',
      'financeiro-pendencias-contagem', 'financeiro-contagem', 'financeiro-kpi-receber', 'financeiro-status'].forEach(function (id) {
      const node = byId(id);
      if (!node) return;
      const observer = new MutationObserver(updateMetrics);
      observer.observe(node, { childList: true, subtree: true, characterData: true });
      state.metricObservers.push(observer);
    });
    updateMetrics();
  }

  function decorateDuplicateCandidates() {
    const container = byId('financeiro-cliente-candidatos');
    if (!container) return;
    container.classList.toggle('app-duplicate-results', Boolean(container.textContent.trim()));
  }

  function showDuplicateAlert(options) {
    const settings = options || {};
    const container = typeof settings.container === 'string' ? document.querySelector(settings.container) : settings.container;
    if (!container) return null;
    const level = settings.level === 'exact' ? 'exact' : 'possible';
    const saveButton = typeof settings.saveButton === 'string' ? document.querySelector(settings.saveButton) : settings.saveButton;
    container.querySelectorAll('.app-duplicate-alert').forEach(function (item) { item.remove(); });
    if (saveButton && saveButton.dataset.appDisabledByDuplicate === 'true') {
      saveButton.disabled = false;
      delete saveButton.dataset.appDisabledByDuplicate;
    }
    if (saveButton && level === 'exact') {
      saveButton.disabled = true;
      saveButton.dataset.appDisabledByDuplicate = 'true';
    }
    const alert = document.createElement('section');
    alert.className = 'app-duplicate-alert';
    alert.dataset.level = level;
    alert.setAttribute('role', level === 'exact' ? 'alert' : 'status');
    alert.innerHTML = '<strong>' + escapeHtml(settings.title || (level === 'exact' ? 'Cadastro já existente' : 'Possível cadastro existente')) +
      '</strong><span>' + escapeHtml(settings.message || 'Confira os dados antes de criar. Nenhum vínculo será feito automaticamente.') + '</span>' +
      (settings.existingId ? '<button type="button">Abrir existente</button>' : '');
    const button = alert.querySelector('button');
    if (button) button.addEventListener('click', function () {
      window.dispatchEvent(new CustomEvent('amj:open-existing', {
        detail: Object.freeze({ type: settings.type || 'record', id: String(settings.existingId) })
      }));
      if (typeof settings.onOpen === 'function') settings.onOpen(settings.existingId);
    });
    container.prepend(alert);
    return alert;
  }

  function clearDuplicateAlert(containerTarget, saveButtonTarget) {
    const container = typeof containerTarget === 'string' ? document.querySelector(containerTarget) : containerTarget;
    const saveButton = typeof saveButtonTarget === 'string' ? document.querySelector(saveButtonTarget) : saveButtonTarget;
    if (container) container.querySelectorAll('.app-duplicate-alert').forEach(function (item) { item.remove(); });
    if (saveButton && saveButton.dataset.appDisabledByDuplicate === 'true') {
      saveButton.disabled = false;
      delete saveButton.dataset.appDisabledByDuplicate;
    }
  }

  function bind() {
    document.addEventListener('click', function (event) {
      const procedureLink = event.target.closest('[data-financeiro-abrir-procedimentos]');
      if (!procedureLink) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      void navigate('procedimentos', { source: 'financeiro', focus: true });
    }, true);

    document.addEventListener('click', function (event) {
      const routeButton = event.target.closest('[data-shell-route]');
      if (routeButton) {
        event.preventDefault();
        void navigate(routeButton.dataset.shellRoute, {
          source: 'interface',
          action: routeButton.dataset.shellAction || null,
          agendaFilter: routeButton.dataset.shellAgendaFilter || null
        });
        return;
      }
      const appAction = event.target.closest('[data-app-action]');
      if (appAction) {
        event.preventDefault();
        const action = appAction.dataset.appAction;
        if (action === 'new-procedure') focusNewProcedure();
        else if (action === 'refresh-procedures') {
          const refresh = document.querySelector('#operacao-clinica-root [data-operacao-recarregar]');
          if (refresh) refresh.click();
        }
        else handleAppAction(action);
        return;
      }
      if (event.target.closest('.app-shell-menu-button,[data-shell-open-menu]')) { openDrawer(); return; }
      if (event.target.closest('.app-shell-overlay')) closeDrawer(true);
    });

    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && document.body.classList.contains('app-shell-drawer-open')) closeDrawer(true);
      if (event.key === 'Tab' && document.body.classList.contains('app-shell-drawer-open')) {
        const sidebar = byId('app-shell-sidebar');
        const focusable = sidebar ? Array.from(sidebar.querySelectorAll('button:not([disabled]):not([hidden]),a[href]')).filter(function (item) {
          return window.getComputedStyle(item).display !== 'none';
        }) : [];
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    });

    window.addEventListener('amj:navigate', function (event) {
      const detail = event.detail || {};
      void navigate(detail.route, {
        source: detail.source || 'module',
        action: detail.action || null,
        agendaFilter: detail.agendaFilter || null,
        focus: detail.focus !== false
      });
    });

    window.addEventListener('amj:open-existing', function (event) {
      void openExisting(event.detail || {});
    });

    const financeContent = byId('financeiro-conteudo');
    if (financeContent) {
      const financeObserver = new MutationObserver(function () {
        if (state.pendingFinanceRoute) applyFinanceEntryView(state.pendingFinanceRoute);
        decorateDuplicateCandidates();
      });
      financeObserver.observe(financeContent, { childList: true, subtree: true });
      state.metricObservers.push(financeObserver);
    }
  }

  function observeApplication() {
    const list = byId('tela-lista');
    if (!list) return;
    const updateAuthentication = function () {
      const authenticated = isVisible(list);
      if (authenticated === state.authenticated) { syncAccess(); return; }
      state.authenticated = authenticated;
      document.body.classList.toggle('app-shell-authenticated', authenticated);
      if (!authenticated) {
        if (window.AMJCotacoes && typeof window.AMJCotacoes.reset === 'function') window.AMJCotacoes.reset();
        state.restoredForSession = false;
        document.title = 'Fichas, Agenda, Prontuários e Financeiro — Ana Maria Jacob Estética';
        closeDrawer(false);
        return;
      }
      syncAccess();
      const stored = sessionStorage.getItem(STORAGE_ROUTE);
      const canRestore = stored && ROUTES[stored] && routeAllowed(ROUTES[stored]);
      const next = canRestore ? stored : 'inicio';
      state.restoredForSession = true;
      void navigate(next, { source: 'session', focus: false, persist: false });
    };
    state.accessObserver = new MutationObserver(function () {
      updateAuthentication();
      syncAccess();
      if (state.authenticated && state.restoredForSession && state.currentRoute === 'inicio') {
        const stored = sessionStorage.getItem(STORAGE_ROUTE);
        if (stored && ROUTES[stored] && routeAllowed(ROUTES[stored])) {
          void navigate(stored, { source: 'session', focus: false, persist: false });
        }
      }
    });
    state.accessObserver.observe(list, { attributes: true, attributeFilter: ['class', 'hidden'] });
    const identity = byId('usuario-detalhes');
    if (identity) state.accessObserver.observe(identity, { childList: true, subtree: true });
    ['aba-bt-financeiro', 'aba-bt-prontuarios', 'aba-bt-cotacoes'].forEach(function (id) {
      const button = byId(id);
      if (button) state.accessObserver.observe(button, { attributes: true, attributeFilter: ['hidden', 'disabled'] });
    });

    const panels = Object.keys(ROUTES).map(function (routeName) { return byId('aba-' + ROUTES[routeName].legacy); })
      .filter(function (panel, index, rows) { return panel && rows.indexOf(panel) === index; });
    state.panelObserver = new MutationObserver(syncFromVisiblePanel);
    panels.forEach(function (panel) {
      state.panelObserver.observe(panel, { attributes: true, attributeFilter: ['class', 'hidden'] });
    });
    updateAuthentication();
  }

  function mount() {
    if (state.mounted) return;
    state.mounted = true;
    document.body.classList.add('app-shell-mounted');
    buildShell();
    state.mobileMedia = window.matchMedia('(max-width: 840px)');
    if (typeof state.mobileMedia.addEventListener === 'function') {
      state.mobileMedia.addEventListener('change', function () {
        if (!state.mobileMedia.matches) document.body.classList.remove('app-shell-drawer-open');
        updateDrawerAccessibility();
      });
    }
    updateDrawerAccessibility();
    bind();
    observeMetrics();
    observeApplication();
    updateRouteChrome('inicio');
  }

  window.AMJShell = Object.freeze({
    navigate: function (route, options) { return navigate(route, options || {}); },
    currentRoute: function () { return state.currentRoute; },
    updateAccess: syncAccess,
    showDuplicateAlert: showDuplicateAlert,
    clearDuplicateAlert: clearDuplicateAlert,
    openExisting: openExisting,
    contract: Object.freeze({
      navigateEvent: 'amj:navigate',
      routeEvent: 'amj:shell-route',
      openExistingEvent: 'amj:open-existing',
      duplicateLevels: Object.freeze(['exact', 'possible'])
    })
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
})();

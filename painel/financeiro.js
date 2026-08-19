(function () {
  'use strict';

  const API_FINANCEIRO = 'https://rjxtxoqprnumouqakxbc.supabase.co/functions/v1/financeiro-fichas';
  const LOCALE = 'pt-BR';
  const MONEY = new Intl.NumberFormat(LOCALE, { style: 'currency', currency: 'BRL' });
  const DATE = new Intl.DateTimeFormat(LOCALE, { dateStyle: 'short', timeZone: 'America/Sao_Paulo' });
  const DATE_TIME = new Intl.DateTimeFormat(LOCALE, {
    dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Sao_Paulo'
  });
  const state = {
    loaded: false,
    loading: false,
    catalogs: { formas_pagamento: [], fornecedores: [], marcas: [], produtos: [] },
    clients: [],
    entries: [],
    audit: [],
    summary: {},
    flow: [],
    selectedCandidate: null,
    candidateConfirmed: false,
    searchTimer: null,
    intentKeys: Object.create(null),
    generation: 0,
    pendingRequests: new Set()
  };

  function byId(id) { return document.getElementById(id); }
  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }
  function num(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  function money(value) { return MONEY.format(num(value)); }
  function roundMoney(value) {
    return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
  }
  function parseMoney(value) {
    const raw = String(value || '').trim().replace(/\s/g, '').replace(/^R\$/i, '');
    if (!raw) return NaN;
    let normalized = '';
    if (/^\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?$/.test(raw)) {
      normalized = raw.replace(/\./g, '').replace(',', '.');
    } else if (/^\d+(?:,\d{1,2})?$/.test(raw)) {
      normalized = raw.replace(',', '.');
    } else if (/^\d+(?:\.\d{1,2})?$/.test(raw)) {
      normalized = raw;
    } else {
      return NaN;
    }
    const result = Number(normalized);
    return Number.isFinite(result) ? result : NaN;
  }
  function digits(value) { return String(value || '').replace(/\D/g, ''); }
  function uuid() {
    return window.crypto && typeof window.crypto.randomUUID === 'function'
      ? window.crypto.randomUUID()
      : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (char) {
        const random = Math.random() * 16 | 0;
        return (char === 'x' ? random : (random & 3 | 8)).toString(16);
      });
  }
  function intentKey(name) {
    if (!state.intentKeys[name]) state.intentKeys[name] = uuid();
    return state.intentKeys[name];
  }
  function clearIntent(name) { delete state.intentKeys[name]; }
  function resetIntentOnEdit(form, name) {
    form.addEventListener('input', function () { clearIntent(name); });
    form.addEventListener('change', function () { clearIntent(name); });
  }
  function isoLocalNow() {
    const date = new Date(Date.now() - new Date().getTimezoneOffset() * 60000);
    return date.toISOString().slice(0, 16);
  }
  function today() {
    const date = new Date(Date.now() - new Date().getTimezoneOffset() * 60000);
    return date.toISOString().slice(0, 10);
  }
  function saoPauloCalendarParts() {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(new Date());
    const values = Object.create(null);
    parts.forEach(function (part) { if (part.type !== 'literal') values[part.type] = part.value; });
    return { year: Number(values.year), month: Number(values.month), day: Number(values.day) };
  }
  function safeDate(value) {
    const raw = String(value || '');
    const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw + 'T12:00:00-03:00' : raw);
    return Number.isFinite(date.getTime()) ? DATE.format(date) : '—';
  }
  function safeDateTime(value) {
    const date = new Date(String(value || ''));
    return Number.isFinite(date.getTime()) ? DATE_TIME.format(date) : '—';
  }
  function entryType(entry) { return entry.entry_type || entry.tipo || ''; }
  function entryOrigin(entry) { return entry.origin || entry.origem || ''; }
  function entryState(entry) { return entry.state || entry.estado || ''; }
  function entryDescription(entry) { return entry.description || entry.descricao || ''; }
  function entryCategory(entry) { return entry.category || entry.categoria || ''; }
  function entryTotal(entry) {
    return entry.total_amount != null ? entry.total_amount : entry.valor_total;
  }
  function entryPaid(entry) {
    return entry.paid_amount != null ? entry.paid_amount : entry.valor_pago;
  }
  function entryBalance(entry) {
    return entry.balance_amount != null ? entry.balance_amount : entry.saldo;
  }
  function entryStatus(entry) { return entry.calculated_status || entry.status || ''; }
  function status(id, message, error) {
    const node = byId(id);
    if (!node) return;
    node.textContent = message || '';
    node.classList.toggle('erro', Boolean(error));
  }
  function setBusy(form, busy) {
    form.querySelectorAll('button,input,select,textarea').forEach(function (control) {
      control.disabled = Boolean(busy);
    });
    form.setAttribute('aria-busy', String(Boolean(busy)));
  }
  function requireValid(form) {
    const controls = Array.from(form.querySelectorAll('[required]'));
    controls.forEach(function (control) { control.removeAttribute('aria-invalid'); });
    const invalid = controls.find(function (control) { return !control.checkValidity(); });
    if (!invalid) return true;
    invalid.setAttribute('aria-invalid', 'true');
    invalid.reportValidity();
    invalid.focus();
    return false;
  }
  function ownerAccess() {
    try {
      return typeof modoAcesso !== 'undefined' && modoAcesso === 'auth' &&
        typeof identidadeBackend !== 'undefined' && identidadeBackend &&
        String(identidadeBackend.role || '').toLowerCase() === 'owner';
    } catch (_) {
      return false;
    }
  }
  function authAccess() {
    try { return typeof modoAcesso !== 'undefined' && modoAcesso === 'auth'; } catch (_) { return false; }
  }

  function staleSessionError() {
    const error = new Error('Sessão financeira encerrada.');
    error.code = 'stale_session';
    return error;
  }
  function isStaleSession(error) {
    return Boolean(error && (error.code === 'stale_session' || error.name === 'AbortError'));
  }

  async function call(action, payload) {
    const generation = state.generation;
    const controller = new AbortController();
    state.pendingRequests.add(controller);
    try {
    if (!ownerAccess()) {
      const error = new Error('O Financeiro exige conta proprietária individual com MFA.');
      error.code = 'owner_mfa_required';
      throw error;
    }
    const headers = await cabecalhosAcesso(true);
    if (generation !== state.generation || !ownerAccess()) throw staleSessionError();
    const response = await fetch(API_FINANCEIRO, {
      method: 'POST',
      headers: headers,
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      signal: controller.signal,
      body: JSON.stringify(Object.assign({ acao: action }, payload || {}))
    });
    let data = {};
    try { data = await response.json(); } catch (_) { data = {}; }
    if (generation !== state.generation || !ownerAccess()) throw staleSessionError();
    if (!response.ok || data.erro) {
      const error = new Error(data.erro || 'Não foi possível concluir a operação financeira.');
      error.code = data.codigo || String(response.status);
      error.status = response.status;
      throw error;
    }
    if (data.identity && typeof atualizarIdentidade === 'function') atualizarIdentidade(data);
    return data;
    } catch (error) {
      if (generation !== state.generation || error.name === 'AbortError') throw staleSessionError();
      throw error;
    } finally {
      state.pendingRequests.delete(controller);
    }
  }

  function updateAccess() {
    const button = byId('aba-bt-financeiro');
    const panel = byId('aba-financeiro');
    const block = byId('financeiro-bloqueio');
    const content = byId('financeiro-conteudo');
    if (!button || !panel) return;
    const allowed = ownerAccess();
    button.hidden = !allowed;
    button.disabled = !allowed;
    block.classList.toggle('oculto', allowed);
    content.classList.toggle('oculto', !allowed);
    if (!allowed && button.getAttribute('aria-selected') === 'true' &&
        typeof agendaAtivarAba === 'function') agendaAtivarAba('fichas', false);
  }

  function options(items, placeholder, getLabel) {
    return '<option value="">' + escapeHtml(placeholder) + '</option>' +
      (Array.isArray(items) ? items : []).map(function (item) {
        return '<option value="' + escapeHtml(item.id || item.code || item.codigo) + '">' +
          escapeHtml(getLabel ? getLabel(item) : item.nome || item.name || item.label) + '</option>';
      }).join('');
  }

  function populateCatalogs() {
    const catalog = state.catalogs;
    const clientOptions = options(state.clients, 'Selecione um cliente', function (item) {
      return item.nome || item.name || item.full_name || 'Cliente';
    });
    const supplierOptions = options(catalog.fornecedores, 'Sem fornecedor', function (item) {
      return item.nome || item.name;
    });
    const requiredSupplier = options(catalog.fornecedores, 'Selecione', function (item) {
      return item.nome || item.name;
    });
    const brandOptions = options(catalog.marcas, 'Sem marca', function (item) { return item.nome || item.name; });
    const methodOptions = options(catalog.formas_pagamento, 'Selecione', function (item) {
      return item.nome || item.label;
    });
    byId('financeiro-lancamento-cliente').innerHTML = clientOptions;
    byId('financeiro-lancamento-fornecedor').innerHTML = supplierOptions;
    byId('financeiro-compra-fornecedor').innerHTML = requiredSupplier;
    byId('financeiro-produto-marca').innerHTML = brandOptions;
    byId('financeiro-pagamento-forma').innerHTML = methodOptions;
    populateOpenEntries();
    document.querySelectorAll('.financeiro-item-produto').forEach(function (select) {
      const current = select.value;
      select.innerHTML = productOptions();
      select.value = current;
    });
  }

  function productOptions() {
    return options(state.catalogs.produtos, 'Selecione o produto', function (item) {
      const brandRow = state.catalogs.marcas.find(function (row) {
        return row.id === (item.marca_id || item.brand_id);
      });
      const brand = item.brand_name || (item.financeiro_marcas && item.financeiro_marcas.name) ||
        (brandRow && (brandRow.nome || brandRow.name)) || '';
      return [item.nome || item.name, brand].filter(Boolean).join(' · ');
    });
  }

  function populateOpenEntries() {
    const open = state.entries.filter(function (entry) {
      return entryState(entry) !== 'cancelado' && num(entryBalance(entry)) > 0;
    });
    byId('financeiro-pagamento-lancamento').innerHTML = options(open, 'Selecione', function (entry) {
      const type = entryType(entry) === 'receita' ? 'Receber' : 'Pagar';
      return type + ' · ' + (entryDescription(entry) || 'Lançamento') + ' · ' + money(entryBalance(entry));
    });
  }

  function renderSummary(data) {
    state.summary = data.resumo || {};
    state.flow = Array.isArray(data.fluxo_mensal) ? data.fluxo_mensal : [];
    if (Array.isArray(data.ultimos_lancamentos)) state.entries = data.ultimos_lancamentos;
    const summary = state.summary;
    byId('financeiro-kpi-recebido').textContent = money(summary.receita_recebida);
    byId('financeiro-kpi-pago').textContent = money(summary.despesa_paga);
    byId('financeiro-kpi-fluxo').textContent = money(summary.fluxo_liquido);
    byId('financeiro-kpi-receber').textContent = money(summary.contas_receber);
    byId('financeiro-kpi-pagar').textContent = money(summary.contas_pagar);
    byId('financeiro-kpi-competencia').textContent = money(
      num(summary.receita_faturada) - num(summary.despesa_incorrida)
    );
    renderChart();
  }

  function renderChart() {
    const chart = byId('financeiro-grafico');
    const receivedByMonth = new Map(state.flow.map(function (item) {
      return [String(item.month || item.mes || '').slice(0, 7), item];
    }));
    const current = saoPauloCalendarParts();
    const flow = [];
    for (let offset = 5; offset >= 0; offset -= 1) {
      const date = new Date(Date.UTC(current.year, current.month - 1 - offset, 1));
      const key = date.toISOString().slice(0, 7);
      flow.push(Object.assign({ mes: key + '-01' }, receivedByMonth.get(key) || {}));
    }
    const hasValue = flow.some(function (item) {
      return num(item.received_revenue != null ? item.received_revenue : item.receita_recebida) > 0 ||
        num(item.paid_expense != null ? item.paid_expense : item.despesa_paga) > 0;
    });
    if (!hasValue) chart.setAttribute('aria-label', 'Seis meses sem entradas ou saídas registradas');
    const max = Math.max(1, ...flow.map(function (item) {
      return Math.max(num(item.received_revenue != null ? item.received_revenue : item.receita_recebida),
        num(item.paid_expense != null ? item.paid_expense : item.despesa_paga));
    }));
    chart.innerHTML = flow.map(function (item) {
      const revenue = num(item.received_revenue != null ? item.received_revenue : item.receita_recebida);
      const expense = num(item.paid_expense != null ? item.paid_expense : item.despesa_paga);
      const month = String(item.month || item.mes || '').slice(0, 7);
      const label = month ? month.slice(5) + '/' + month.slice(2, 4) : '—';
      return '<div class="financeiro-mes" title="' + escapeHtml(label) + ': recebido ' +
        escapeHtml(money(revenue)) + '; pago ' + escapeHtml(money(expense)) + '">' +
        '<i class="financeiro-barra" style="height:' + Math.max(2, revenue / max * 100) + '%"></i>' +
        '<i class="financeiro-barra despesa" style="height:' + Math.max(2, expense / max * 100) + '%"></i>' +
        '<span>' + escapeHtml(label) + '</span></div>';
    }).join('');
    if (hasValue) chart.setAttribute('aria-label', 'Gráfico mensal de valores recebidos e pagos nos últimos seis meses');
  }

  function statusLabel(value) {
    return ({ pendente: 'Pendente', parcial: 'Parcial', pago: 'Quitado', vencido: 'Vencido',
      cancelado: 'Cancelado' })[String(value || '')] || String(value || 'Pendente');
  }

  function filteredEntries() {
    const type = byId('financeiro-filtro-tipo').value;
    const situation = byId('financeiro-filtro-status').value;
    return state.entries.filter(function (entry) {
      const calculated = entry.calculated_status || entry.status || '';
      return (!type || entryType(entry) === type) && (!situation || calculated === situation ||
        (situation === 'cancelado' && entryState(entry) === 'cancelado'));
    });
  }

  function renderEntries() {
    const list = byId('financeiro-lista');
    const entries = filteredEntries();
    byId('financeiro-contagem').textContent = entries.length + (entries.length === 1 ? ' lançamento' : ' lançamentos');
    list.setAttribute('aria-busy', 'false');
    if (!entries.length) {
      list.innerHTML = '<p class="financeiro-vazio">Nenhum lançamento encontrado neste filtro.</p>';
      populateOpenEntries();
      return;
    }
    list.innerHTML = entries.map(function (entry) {
      const calculated = entryState(entry) === 'cancelado' ? 'cancelado' : (entryStatus(entry) || 'pendente');
      const type = entryType(entry) === 'receita' ? 'receita' : 'despesa';
      const received = num(entryPaid(entry));
      const balance = num(entryBalance(entry));
      const payments = Array.isArray(entry.pagamentos) ? entry.pagamentos : [];
      const actions = [];
      if (entryState(entry) !== 'cancelado' && balance > 0) {
        actions.push('<button type="button" data-financeiro-pagar="' + escapeHtml(entry.id) + '">' +
          (type === 'receita' ? 'Registrar recebimento' : 'Registrar pagamento') + '</button>');
      }
      if (entryState(entry) !== 'cancelado' && received === 0 && entryOrigin(entry) !== 'compra') {
        actions.push('<button type="button" data-financeiro-cancelar="' + escapeHtml(entry.id) + '">Cancelar</button>');
      }
      payments.filter(function (payment) {
        const movement = payment.movement_type || payment.tipo;
        if (movement !== 'pagamento') return false;
        const reversed = payments.filter(function (row) {
          return (row.movement_type || row.tipo) === 'estorno' &&
            (row.reversed_payment_id || row.pagamento_estornado_id) === payment.id;
        }).reduce(function (sum, row) { return sum + num(row.amount != null ? row.amount : row.valor); }, 0);
        payment.__estornado = reversed;
        return reversed < num(payment.amount != null ? payment.amount : payment.valor);
      }).forEach(function (payment) {
        const available = num(payment.amount != null ? payment.amount : payment.valor) - num(payment.__estornado);
        actions.push('<button type="button" data-financeiro-estornar="' + escapeHtml(payment.id) +
          '" data-financeiro-entry="' + escapeHtml(entry.id) + '" data-financeiro-max="' + available +
          '" data-financeiro-forma="' + escapeHtml(payment.payment_method || payment.forma || '') + '">Estornar ' +
          escapeHtml(money(available)) + '</button>');
      });
      return '<article class="financeiro-lancamento"><div class="financeiro-lancamento-topo"><div>' +
        '<h4>' + escapeHtml(entryDescription(entry) || 'Lançamento') + '</h4>' +
        '<p class="financeiro-lancamento-meta">Competência ' + escapeHtml(safeDate(entry.competence_date || entry.competencia)) +
        ' · vencimento ' + escapeHtml(safeDate(entry.due_date || entry.vencimento)) + '</p></div>' +
        '<span class="financeiro-lancamento-valor">' + escapeHtml(money(entryTotal(entry))) + '</span></div>' +
        '<div class="financeiro-selos"><span class="financeiro-selo ' + type + '">' +
        (type === 'receita' ? 'Receita' : 'Despesa') + '</span><span class="financeiro-selo ' +
        escapeHtml(calculated) + '">' + escapeHtml(statusLabel(calculated)) + '</span>' +
        '<span class="financeiro-selo">' + escapeHtml(entryCategory(entry)) + '</span></div>' +
        '<p class="financeiro-lancamento-meta">Pago: ' + escapeHtml(money(received)) +
        ' · saldo: ' + escapeHtml(money(balance)) + '</p>' +
        (actions.length ? '<div class="financeiro-lancamento-acoes">' + actions.join('') + '</div>' : '') +
        '</article>';
    }).join('');
    populateOpenEntries();
  }

  function renderAudit() {
    const box = byId('financeiro-auditoria');
    const rows = state.audit.slice(0, 50);
    if (!rows.length) {
      box.innerHTML = '<p class="financeiro-vazio">A auditoria aparecerá após a primeira ação financeira.</p>';
      return;
    }
    box.innerHTML = rows.map(function (item) {
      const actor = item.actor_name || item.display_name || (item.ator && item.ator.nome) || 'Proprietário identificado';
      const action = String(item.action || item.acao || 'ação').replace(/_/g, ' ');
      const entity = String(item.entity || item.entidade || 'registro').replace(/_/g, ' ');
      return '<article class="financeiro-auditoria-item"><div><strong>' + escapeHtml(actor) +
        '</strong><span>' + escapeHtml(action) + ' · ' + escapeHtml(entity) +
        '</span></div><small>' + escapeHtml(safeDateTime(item.created_at || item.criado_em)) + '</small></article>';
    }).join('');
  }

  async function load(options) {
    if (state.loading || !ownerAccess()) return;
    state.loading = true;
    status('financeiro-status', options && options.silent ? '' : 'Atualizando dados financeiros…', false);
    byId('financeiro-lista').setAttribute('aria-busy', 'true');
    try {
      const results = await Promise.all([
        call('resumo'), call('listar_catalogos'), call('listar_clientes', { por_pagina: 100 }),
        call('listar_lancamentos', { por_pagina: 100 }), call('listar_auditoria', { limite: 50 })
      ]);
      renderSummary(results[0]);
      state.catalogs = Object.assign(state.catalogs, results[1] || {});
      state.clients = Array.isArray(results[2].clientes) ? results[2].clientes : [];
      state.entries = Array.isArray(results[3].lancamentos) ? results[3].lancamentos : state.entries;
      state.audit = Array.isArray(results[4].auditoria) ? results[4].auditoria : [];
      populateCatalogs();
      renderEntries();
      renderAudit();
      state.loaded = true;
      status('financeiro-status', 'Financeiro atualizado com dados do servidor.', false);
    } catch (error) {
      if (isStaleSession(error)) return;
      if (error.status === 401 || error.status === 403) {
        reset();
        if (typeof acessoNegado === 'function') await acessoNegado();
        return;
      }
      status('financeiro-status', error.message, true);
      byId('financeiro-lista').innerHTML = '<p class="financeiro-vazio">Não foi possível carregar o Financeiro.</p>';
    } finally {
      state.loading = false;
      byId('financeiro-lista').setAttribute('aria-busy', 'false');
    }
  }

  function activate() {
    updateAccess();
    if (ownerAccess() && !state.loaded) load();
  }

  function reset() {
    state.generation += 1;
    state.pendingRequests.forEach(function (controller) { controller.abort(); });
    state.pendingRequests.clear();
    clearTimeout(state.searchTimer);
    state.loaded = false;
    state.loading = false;
    state.catalogs = { formas_pagamento: [], fornecedores: [], marcas: [], produtos: [] };
    state.clients = [];
    state.entries = [];
    state.audit = [];
    state.summary = {};
    state.flow = [];
    state.selectedCandidate = null;
    state.candidateConfirmed = false;
    state.intentKeys = Object.create(null);
    const panel = byId('aba-financeiro');
    if (panel) {
      panel.querySelectorAll('form').forEach(function (form) {
        form.reset();
        setBusy(form, false);
      });
      panel.querySelectorAll('details').forEach(function (details) { details.open = false; });
      panel.querySelectorAll('.financeiro-form-status').forEach(function (node) {
        node.textContent = '';
        node.classList.remove('erro');
      });
      ['financeiro-lancamento-cliente', 'financeiro-lancamento-fornecedor',
        'financeiro-compra-fornecedor', 'financeiro-produto-marca', 'financeiro-pagamento-forma',
        'financeiro-pagamento-lancamento'].forEach(function (id) {
        const select = byId(id);
        if (select) select.innerHTML = '<option value="">Selecione</option>';
      });
      ['financeiro-lista', 'financeiro-auditoria', 'financeiro-cliente-candidatos',
        'financeiro-compra-itens'].forEach(function (id) {
        const node = byId(id);
        if (node) node.innerHTML = '';
      });
      ['financeiro-kpi-recebido', 'financeiro-kpi-pago', 'financeiro-kpi-fluxo',
        'financeiro-kpi-receber', 'financeiro-kpi-pagar', 'financeiro-kpi-competencia'].forEach(function (id) {
        const node = byId(id);
        if (node) node.textContent = money(0);
      });
      byId('financeiro-grafico').innerHTML = '';
      byId('financeiro-grafico').setAttribute('aria-label', 'Sem dados financeiros para exibir');
      byId('financeiro-contagem').textContent = '0 lançamentos';
      byId('financeiro-status').textContent = '';
      byId('financeiro-lista').setAttribute('aria-busy', 'false');
      setInitialDates();
      syncEntryForm();
      addPurchaseItem();
    }
    updateAccess();
  }

  function syncEntryForm() {
    const revenue = byId('financeiro-lancamento-tipo').value === 'receita';
    const adjustment = byId('financeiro-lancamento-origem').value === 'ajuste';
    byId('financeiro-lancamento-cliente-campo').classList.toggle('oculto', !revenue);
    byId('financeiro-lancamento-cliente').required = revenue && !adjustment;
    byId('financeiro-lancamento-fornecedor-campo').classList.toggle('oculto', revenue);
    if (revenue && byId('financeiro-lancamento-origem').value === 'operacional') {
      byId('financeiro-lancamento-origem').value = 'atendimento';
    }
    if (!revenue && ['atendimento', 'produto'].includes(byId('financeiro-lancamento-origem').value)) {
      byId('financeiro-lancamento-origem').value = 'operacional';
    }
  }

  async function submitEntry(event) {
    event.preventDefault();
    const form = event.currentTarget;
    if (!requireValid(form)) return;
    const amount = parseMoney(byId('financeiro-lancamento-valor').value);
    if (!(amount > 0)) { status('financeiro-lancamento-status', 'Informe um valor maior que zero.', true); return; }
    setBusy(form, true);
    try {
      await call('criar_lancamento', {
        idempotency_key: intentKey('lancamento'),
        patient_id: byId('financeiro-lancamento-cliente').value || null,
        supplier_id: byId('financeiro-lancamento-fornecedor').value || null,
        tipo: byId('financeiro-lancamento-tipo').value,
        origem: byId('financeiro-lancamento-origem').value,
        descricao: byId('financeiro-lancamento-descricao').value.trim(),
        categoria: byId('financeiro-lancamento-categoria').value.trim(),
        competencia: byId('financeiro-lancamento-competencia').value,
        vencimento: byId('financeiro-lancamento-vencimento').value,
        valor_total: amount,
        condicao_pagamento: byId('financeiro-lancamento-condicao').value,
        parcelas: Number(byId('financeiro-lancamento-parcelas').value),
        observacoes: byId('financeiro-lancamento-observacoes').value.trim() || null
      });
      clearIntent('lancamento');
      form.reset();
      setInitialDates();
      syncEntryForm();
      status('financeiro-lancamento-status', 'Lançamento salvo e auditado.', false);
      await load({ silent: true });
    } catch (error) { if (!isStaleSession(error)) status('financeiro-lancamento-status', error.message, true); }
    finally { setBusy(form, false); }
  }

  async function submitPayment(event) {
    event.preventDefault();
    const form = event.currentTarget;
    if (!requireValid(form)) return;
    const amount = parseMoney(byId('financeiro-pagamento-valor').value);
    if (!(amount > 0)) { status('financeiro-pagamento-status', 'Informe um valor maior que zero.', true); return; }
    setBusy(form, true);
    try {
      await call('registrar_pagamento', {
        entry_id: byId('financeiro-pagamento-lancamento').value,
        forma_pagamento: byId('financeiro-pagamento-forma').value,
        valor: amount,
        pago_em: new Date(byId('financeiro-pagamento-data').value).toISOString(),
        parcelas: Number(byId('financeiro-pagamento-parcelas').value),
        referencia: byId('financeiro-pagamento-referencia').value.trim() || null,
        idempotency_key: intentKey('pagamento')
      });
      clearIntent('pagamento');
      form.reset();
      byId('financeiro-pagamento-data').value = isoLocalNow();
      byId('financeiro-pagamento-parcelas').value = '1';
      status('financeiro-pagamento-status', 'Valor registrado no livro financeiro.', false);
      await load({ silent: true });
    } catch (error) { if (!isStaleSession(error)) status('financeiro-pagamento-status', error.message, true); }
    finally { setBusy(form, false); }
  }

  async function searchCandidates() {
    const query = byId('financeiro-cliente-pesquisa').value.trim();
    const box = byId('financeiro-cliente-candidatos');
    if (query.length < 3) { box.innerHTML = ''; return; }
    box.innerHTML = '<p class="financeiro-vazio">Pesquisando…</p>';
    try {
      const data = await call('sugerir_clientes', { busca: query, limite: 10 });
      const candidates = Array.isArray(data.candidatos) ? data.candidatos : [];
      if (!candidates.length) { box.innerHTML = '<p class="financeiro-vazio">Nenhum cadastro candidato encontrado.</p>'; return; }
      box.innerHTML = candidates.map(function (item, index) {
        const contact = [item.telefone_mascarado || item.phone_masked || item.telefone_final,
          item.email_mascarado || item.email_masked]
          .filter(Boolean).join(' · ');
        const linked = item.vinculo && item.vinculo.cliente_id;
        return '<article class="financeiro-candidato"><div><strong>' + escapeHtml(item.nome || item.name) +
          '</strong><small>' + escapeHtml(contact || 'Sem contato exibido') + ' · ' +
          escapeHtml(item.origem_rotulo || item.source_kind || item.origem || 'cadastro') + '</small></div>' +
          (linked
            ? '<button type="button" disabled title="Este registro já está ligado ao cadastro canônico">Já vinculado</button>'
            : '<button type="button" data-financeiro-candidato="' + index + '">Usar dados</button>') + '</article>';
      }).join('');
      box.querySelectorAll('[data-financeiro-candidato]').forEach(function (button) {
        button.addEventListener('click', function () {
          const candidate = candidates[Number(button.dataset.financeiroCandidato)];
          state.selectedCandidate = candidate;
          byId('financeiro-cliente-nome').value = candidate.nome || candidate.name || '';
          byId('financeiro-cliente-telefone').value = candidate.telefone || candidate.phone || '';
          byId('financeiro-cliente-email').value = candidate.email || '';
          byId('financeiro-cliente-cpf').value = candidate.cpf || '';
          renderCandidateConfirmation('Candidato selecionado. Confirme o vínculo antes de salvar.', true);
        });
      });
    } catch (error) {
      if (!isStaleSession(error)) box.innerHTML = '<p class="financeiro-form-status erro">' + escapeHtml(error.message) + '</p>';
    }
  }

  function renderCandidateConfirmation(message, checked) {
    const candidate = state.selectedCandidate;
    if (!candidate) return;
    const box = byId('financeiro-cliente-candidatos');
    const sourceName = candidate.nome || candidate.name || 'cadastro selecionado';
    const sourceKind = candidate.origem_rotulo || candidate.source_kind || candidate.origem || 'cadastro';
    state.candidateConfirmed = Boolean(checked);
    box.innerHTML = '<div class="financeiro-nota"><p>' + escapeHtml(message) + '</p>' +
      '<label><input id="financeiro-confirmar-vinculo" type="checkbox" ' +
      (checked ? 'checked ' : '') + '> Confirmo vincular este cliente a “' + escapeHtml(sourceName) +
      '” (' + escapeHtml(sourceKind) + ').</label> ' +
      '<button id="financeiro-remover-vinculo" type="button">Remover vínculo</button></div>';
    byId('financeiro-confirmar-vinculo').addEventListener('change', function (event) {
      state.candidateConfirmed = event.currentTarget.checked;
      clearIntent('cliente');
    });
    byId('financeiro-remover-vinculo').addEventListener('click', function () {
      clearSelectedCandidate('O vínculo foi removido. O cliente será salvo sem ligação a uma ficha.');
    });
  }

  function markCandidateForReconfirmation() {
    if (!state.selectedCandidate) return;
    renderCandidateConfirmation(
      'Os dados foram editados. Confira a pessoa de origem e marque novamente a confirmação do vínculo.',
      false
    );
  }

  function clearSelectedCandidate(message) {
    if (!state.selectedCandidate) return;
    state.selectedCandidate = null;
    state.candidateConfirmed = false;
    clearIntent('cliente');
    const box = byId('financeiro-cliente-candidatos');
    if (box) {
      box.innerHTML = '<p class="financeiro-nota">' + escapeHtml(message ||
        'O vínculo anterior foi removido. Pesquise e selecione novamente para ligar este cliente a uma ficha.') + '</p>';
    }
  }

  async function submitClient(event) {
    event.preventDefault();
    const form = event.currentTarget;
    if (!requireValid(form)) return;
    if (state.selectedCandidate && !state.candidateConfirmed) {
      status('financeiro-cliente-status', 'Confirme o vínculo selecionado ou remova-o antes de salvar.', true);
      const confirmation = byId('financeiro-confirmar-vinculo');
      if (confirmation) confirmation.focus();
      return;
    }
    setBusy(form, true);
    try {
      const candidate = state.selectedCandidate;
      await call('criar_cliente', {
        idempotency_key: intentKey('cliente'),
        nome: byId('financeiro-cliente-nome').value.trim(),
        telefone: byId('financeiro-cliente-telefone').value.trim() || null,
        email: byId('financeiro-cliente-email').value.trim() || null,
        cpf: digits(byId('financeiro-cliente-cpf').value) || null,
        origem: candidate ? (candidate.origem || candidate.source_kind) : null,
        origem_id: candidate ? (candidate.origem_id || candidate.source_id) : null,
        match_method: candidate ? (candidate.match_method || 'manual') : null
      });
      clearIntent('cliente');
      form.reset();
      state.selectedCandidate = null;
      state.candidateConfirmed = false;
      byId('financeiro-cliente-candidatos').innerHTML = '';
      status('financeiro-cliente-status', 'Cliente salvo para reaproveitamento.', false);
      await load({ silent: true });
    } catch (error) { if (!isStaleSession(error)) status('financeiro-cliente-status', error.message, true); }
    finally { setBusy(form, false); }
  }

  async function simpleCreate(form, action, payload, statusId, success) {
    if (!requireValid(form)) return;
    setBusy(form, true);
    try {
      await call(action, Object.assign({ idempotency_key: intentKey(action) }, payload));
      clearIntent(action);
      form.reset();
      status(statusId, success, false);
      await load({ silent: true });
    } catch (error) { if (!isStaleSession(error)) status(statusId, error.message, true); }
    finally { setBusy(form, false); }
  }

  function addPurchaseItem() {
    const row = document.createElement('div');
    row.className = 'financeiro-item';
    row.innerHTML = '<label><span>Produto</span><select class="financeiro-item-produto" required>' +
      productOptions() + '</select></label><label><span>Quantidade</span><input class="financeiro-item-quantidade" type="number" min="0.0001" max="9999999999" step="0.0001" value="1" required></label>' +
      '<label><span>Valor unitário</span><input class="financeiro-item-valor" type="text" inputmode="decimal" placeholder="0,00" required></label>' +
      '<button class="financeiro-botao perigo financeiro-remover-item" type="button" aria-label="Remover item">Remover</button>';
    row.querySelector('.financeiro-remover-item').addEventListener('click', function () {
      row.remove();
      clearIntent('compra');
      updatePurchaseTotal();
    });
    row.querySelectorAll('input,select').forEach(function (control) {
      control.addEventListener('input', updatePurchaseTotal);
      control.addEventListener('change', updatePurchaseTotal);
    });
    byId('financeiro-compra-itens').appendChild(row);
    clearIntent('compra');
    updatePurchaseTotal();
  }

  function purchaseItems() {
    return Array.from(document.querySelectorAll('.financeiro-item')).map(function (row) {
      return {
        produto_id: row.querySelector('.financeiro-item-produto').value,
        quantidade: Number(row.querySelector('.financeiro-item-quantidade').value),
        valor_unitario: parseMoney(row.querySelector('.financeiro-item-valor').value)
      };
    });
  }

  function updatePurchaseTotal() {
    const total = purchaseItems().reduce(function (sum, item) {
      return sum + (Number.isFinite(item.quantidade) && Number.isFinite(item.valor_unitario)
        ? roundMoney(item.quantidade * item.valor_unitario) : 0);
    }, 0);
    byId('financeiro-compra-total').textContent = money(total);
  }

  async function submitPurchase(event) {
    event.preventDefault();
    const form = event.currentTarget;
    if (!requireValid(form)) return;
    const items = purchaseItems();
    if (!items.length || items.some(function (item) {
      return !item.produto_id || !(item.quantidade > 0) || !(item.valor_unitario >= 0);
    })) { status('financeiro-compra-status', 'Revise os produtos, quantidades e valores.', true); return; }
    setBusy(form, true);
    try {
      await call('criar_compra', {
        fornecedor_id: byId('financeiro-compra-fornecedor').value,
        data_compra: byId('financeiro-compra-data').value,
        numero_documento: byId('financeiro-compra-nota').value.trim() || null,
        condicao_pagamento: byId('financeiro-compra-condicao').value,
        parcelas: Number(byId('financeiro-compra-parcelas').value),
        categoria: byId('financeiro-compra-categoria').value.trim(),
        observacoes: byId('financeiro-compra-observacoes').value.trim() || null,
        itens: items,
        idempotency_key: intentKey('compra')
      });
      clearIntent('compra');
      form.reset();
      byId('financeiro-compra-itens').innerHTML = '';
      byId('financeiro-compra-categoria').value = 'Produtos e insumos';
      byId('financeiro-compra-parcelas').value = '1';
      byId('financeiro-compra-data').value = today();
      addPurchaseItem();
      status('financeiro-compra-status', 'Compra e despesa vinculada foram salvas.', false);
      await load({ silent: true });
    } catch (error) { if (!isStaleSession(error)) status('financeiro-compra-status', error.message, true); }
    finally { setBusy(form, false); }
  }

  async function cancelEntry(id) {
    const reason = window.prompt('Informe o motivo do cancelamento (mínimo 3 caracteres):');
    if (reason === null) return;
    if (reason.trim().length < 3) { status('financeiro-status', 'O motivo precisa ter ao menos 3 caracteres.', true); return; }
    if (!window.confirm('Cancelar este lançamento sem pagamento? A auditoria será preservada.')) return;
    try {
      const intent = 'cancelar:' + id;
      await call('cancelar_lancamento', {
        entry_id: id,
        motivo: reason.trim(),
        idempotency_key: intentKey(intent)
      });
      clearIntent(intent);
      status('financeiro-status', 'Lançamento cancelado com auditoria.', false);
      await load({ silent: true });
    } catch (error) { if (!isStaleSession(error)) status('financeiro-status', error.message, true); }
  }

  async function reversePayment(button) {
    const max = Number(button.dataset.financeiroMax);
    const raw = window.prompt('Valor a estornar (máximo ' + money(max) + '):', String(max).replace('.', ','));
    if (raw === null) return;
    const amount = parseMoney(raw);
    if (!(amount > 0) || amount > max) { status('financeiro-status', 'Valor de estorno inválido.', true); return; }
    if (!window.confirm('Confirmar o estorno de ' + money(amount) + '?')) return;
    try {
      await call('estornar_pagamento', {
        entry_id: button.dataset.financeiroEntry,
        pagamento_id: button.dataset.financeiroEstornar,
        forma_pagamento: button.dataset.financeiroForma,
        valor: amount,
        idempotency_key: intentKey('estorno:' + button.dataset.financeiroEstornar + ':' + amount)
      });
      clearIntent('estorno:' + button.dataset.financeiroEstornar + ':' + amount);
      status('financeiro-status', 'Estorno registrado e ligado ao pagamento original.', false);
      await load({ silent: true });
    } catch (error) { if (!isStaleSession(error)) status('financeiro-status', error.message, true); }
  }

  function setInitialDates() {
    const date = today();
    byId('financeiro-lancamento-competencia').value = date;
    byId('financeiro-lancamento-vencimento').value = date;
    byId('financeiro-compra-data').value = date;
    byId('financeiro-pagamento-data').value = isoLocalNow();
  }

  function bind() {
    setInitialDates();
    syncEntryForm();
    addPurchaseItem();
    byId('financeiro-atualizar').addEventListener('click', function () { load(); });
    document.querySelectorAll('[data-financeiro-abrir]').forEach(function (button) {
      button.addEventListener('click', function () {
        const details = byId(button.dataset.financeiroAbrir);
        details.open = true;
        details.scrollIntoView({ behavior: 'smooth', block: 'start' });
        const focusable = details.querySelector('input:not([type=hidden]),select,button');
        if (focusable) focusable.focus({ preventScroll: true });
      });
    });
    byId('financeiro-lancamento-tipo').addEventListener('change', syncEntryForm);
    byId('financeiro-lancamento-origem').addEventListener('change', syncEntryForm);
    byId('financeiro-form-lancamento').addEventListener('submit', submitEntry);
    byId('financeiro-form-pagamento').addEventListener('submit', submitPayment);
    byId('financeiro-form-cliente').addEventListener('submit', submitClient);
    resetIntentOnEdit(byId('financeiro-form-lancamento'), 'lancamento');
    resetIntentOnEdit(byId('financeiro-form-pagamento'), 'pagamento');
    resetIntentOnEdit(byId('financeiro-form-cliente'), 'cliente');
    resetIntentOnEdit(byId('financeiro-form-compra'), 'compra');
    resetIntentOnEdit(byId('financeiro-form-fornecedor'), 'criar_fornecedor');
    resetIntentOnEdit(byId('financeiro-form-marca'), 'criar_marca');
    resetIntentOnEdit(byId('financeiro-form-produto'), 'criar_produto');
    byId('financeiro-cliente-pesquisa').addEventListener('input', function () {
      clearSelectedCandidate('A origem selecionada foi removida porque uma nova pesquisa foi iniciada.');
      clearTimeout(state.searchTimer);
      state.searchTimer = setTimeout(searchCandidates, 450);
    });
    ['financeiro-cliente-nome', 'financeiro-cliente-telefone', 'financeiro-cliente-email',
      'financeiro-cliente-cpf'].forEach(function (id) {
      byId(id).addEventListener('input', function () {
        markCandidateForReconfirmation();
      });
    });
    byId('financeiro-form-fornecedor').addEventListener('submit', function (event) {
      event.preventDefault();
      simpleCreate(event.currentTarget, 'criar_fornecedor', {
        nome: byId('financeiro-fornecedor-nome').value.trim(),
        documento: digits(byId('financeiro-fornecedor-documento').value) || null
      }, 'financeiro-fornecedor-status', 'Fornecedor salvo.');
    });
    byId('financeiro-form-marca').addEventListener('submit', function (event) {
      event.preventDefault();
      simpleCreate(event.currentTarget, 'criar_marca', {
        nome: byId('financeiro-marca-nome').value.trim()
      }, 'financeiro-marca-status', 'Marca salva.');
    });
    byId('financeiro-form-produto').addEventListener('submit', function (event) {
      event.preventDefault();
      const costField = byId('financeiro-produto-custo');
      const rawCost = costField.value.trim();
      const cost = parseMoney(rawCost);
      if (rawCost && !Number.isFinite(cost)) {
        status('financeiro-produto-status', 'Informe o custo com no máximo duas casas decimais.', true);
        costField.focus();
        return;
      }
      simpleCreate(event.currentTarget, 'criar_produto', {
        nome: byId('financeiro-produto-nome').value.trim(),
        marca_id: byId('financeiro-produto-marca').value || null,
        tipo: byId('financeiro-produto-tipo').value,
        unidade: byId('financeiro-produto-unidade').value,
        custo_referencia: Number.isFinite(cost) ? cost : null,
        registro_anvisa: byId('financeiro-produto-anvisa').value.trim() || null
      }, 'financeiro-produto-status', 'Produto salvo.');
    });
    byId('financeiro-adicionar-item').addEventListener('click', addPurchaseItem);
    byId('financeiro-form-compra').addEventListener('submit', submitPurchase);
    byId('financeiro-filtro-tipo').addEventListener('change', renderEntries);
    byId('financeiro-filtro-status').addEventListener('change', renderEntries);
    byId('financeiro-lista').addEventListener('click', function (event) {
      const payment = event.target.closest('[data-financeiro-pagar]');
      const cancel = event.target.closest('[data-financeiro-cancelar]');
      const reversal = event.target.closest('[data-financeiro-estornar]');
      if (payment) {
        byId('financeiro-pagamento-lancamento').value = payment.dataset.financeiroPagar;
        byId('financeiro-editor-pagamento').open = true;
        byId('financeiro-editor-pagamento').scrollIntoView({ behavior: 'smooth', block: 'start' });
      } else if (cancel) cancelEntry(cancel.dataset.financeiroCancelar);
      else if (reversal) reversePayment(reversal);
    });
    updateAccess();
  }

  window.AMJFinanceiro = {
    ativar: activate,
    atualizarAcesso: updateAccess,
    reset: reset,
    carregar: load
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind, { once: true });
  else setTimeout(bind, 0);
})();

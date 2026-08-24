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
    costs: [],
    inventory: [],
    pendingStock: [],
    clients: [],
    entries: [],
    audit: [],
    duplicateReviews: [],
    summary: {},
    flow: [],
    selectedCandidate: null,
    candidateConfirmed: false,
    searchTimer: null,
    intentKeys: Object.create(null),
    entryView: 'procedimentos',
    generation: 0,
    pendingRequests: new Set()
  };

  function byId(id) { return document.getElementById(id); }
  function removeNode(node) {
    if (!node) return;
    if (typeof node.remove === 'function') node.remove();
    else if (node.parentNode && typeof node.parentNode.removeChild === 'function') node.parentNode.removeChild(node);
  }
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
  function normalizeSearch(value) {
    return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .toLowerCase().trim();
  }
  function maskedDocument(value) {
    const raw = digits(value);
    if (raw.length === 11) return '***.***.***-' + raw.slice(-2);
    if (raw.length === 14) return '**.***.***/****-' + raw.slice(-2);
    return raw ? 'Final ' + raw.slice(-4) : '';
  }
  function productTypeLabel(value) {
    return ({ bioestimulador: 'Bioestimulador', toxina_botulinica: 'Toxina botulínica',
      preenchedor: 'Preenchedor', skinbooster: 'Skinbooster', injetavel: 'Outro injetável',
      medicamento: 'Medicamento', dermocosmetico: 'Dermocosmético', descartavel: 'Descartável',
      epi: 'EPI', limpeza: 'Limpeza', revenda: 'Revenda', outro: 'Outro' })[String(value || '')] ||
      String(value || '');
  }
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
  function entryInstallments(entry) {
    const rows = Array.isArray(entry && entry.parcelas_previstas) ? entry.parcelas_previstas : [];
    return rows.filter(function (row) { return String(row.estado || '').toLowerCase() !== 'cancelado'; });
  }
  function installmentBalance(row) {
    if (row && row.saldo != null) return num(row.saldo);
    return Math.max(0, num(row && row.valor) - num(row && row.valor_pago));
  }
  function paymentMethodLabel(code) {
    const found = state.catalogs.formas_pagamento.find(function (item) {
      return String(item.codigo || item.code || item.id || '') === String(code || '');
    });
    return found ? (found.nome || found.label || code) : String(code || 'Não informada');
  }
  function allocateInstallments(value, count) {
    const totalCents = Math.round(Number(value) * 100);
    const quantity = Number(count);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 120 || !Number.isFinite(totalCents) || totalCents < 1) return [];
    const base = Math.floor(totalCents / quantity);
    const remainder = totalCents - base * quantity;
    return Array.from({ length: quantity }, function (_, index) {
      return (base + (index < remainder ? 1 : 0)) / 100;
    });
  }
  function moneyInput(value) { return num(value).toFixed(2).replace('.', ','); }
  function addMonthsIso(value, amount) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
    if (!match) return today();
    const year = Number(match[1]);
    const monthIndex = Number(match[2]) - 1 + amount;
    const targetYear = year + Math.floor(monthIndex / 12);
    const targetMonth = ((monthIndex % 12) + 12) % 12;
    const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
    const day = Math.min(Number(match[3]), lastDay);
    return String(targetYear).padStart(4, '0') + '-' + String(targetMonth + 1).padStart(2, '0') + '-' +
      String(day).padStart(2, '0');
  }
  function renderInstallmentRows(containerId, value, count, baseDate) {
    const container = byId(containerId);
    const amounts = allocateInstallments(value, count);
    if (!container) return;
    if (!amounts.length) {
      container.innerHTML = '<p class="financeiro-vazio">Informe um saldo e a quantidade de parcelas.</p>';
      delete container.dataset.signature;
      return;
    }
    const previousDates = Array.from(container.querySelectorAll('[data-financeiro-parcela-data]'))
      .map(function (input) { return input.value; });
    const signature = Math.round(Number(value) * 100) + ':' + amounts.length;
    if (container.dataset.signature === signature &&
        container.querySelectorAll('.financeiro-parcela-linha').length === amounts.length) return;
    container.innerHTML = '<div class="financeiro-parcelas-topo"><strong>Datas e valores do saldo</strong>' +
      '<small>Confira cada vencimento antes de salvar. A soma precisa ser ' + escapeHtml(money(value)) + '.</small></div>' +
      amounts.map(function (amount, index) {
        const dueDate = previousDates[index] || '';
        return '<div class="financeiro-parcela-linha" data-financeiro-parcela-numero="' + (index + 1) + '">' +
          '<span class="financeiro-parcela-numero">' + (index + 1) + '/' + amounts.length + '</span>' +
          '<label><span>Vencimento</span><input type="date" data-financeiro-parcela-data value="' +
          escapeHtml(dueDate) + '" required></label>' +
          '<label><span>Valor</span><input type="text" inputmode="decimal" data-financeiro-parcela-valor value="' +
          escapeHtml(moneyInput(amount)) + '" required></label></div>';
      }).join('');
    container.dataset.signature = signature;
  }
  function collectInstallments(containerId, method) {
    return Array.from(byId(containerId).querySelectorAll('.financeiro-parcela-linha')).map(function (row) {
      return {
        numero: Number(row.dataset.financeiroParcelaNumero),
        vencimento: row.querySelector('[data-financeiro-parcela-data]').value,
        valor: parseMoney(row.querySelector('[data-financeiro-parcela-valor]').value),
        forma_pagamento: method
      };
    });
  }
  function validateInstallments(rows, expected) {
    if (!rows.length || rows.some(function (row) {
      return !row.vencimento || !(row.valor > 0) || !row.forma_pagamento;
    })) return false;
    const actualCents = rows.reduce(function (sum, row) { return sum + Math.round(row.valor * 100); }, 0);
    return actualCents === Math.round(Number(expected) * 100);
  }
  function status(id, message, error) {
    const node = byId(id);
    if (!node) return;
    node.textContent = message || '';
    node.classList.toggle('erro', Boolean(error));
  }
  function setBusy(form, busy) {
    form.querySelectorAll('button,input,select,textarea').forEach(function (control) {
      if (busy) {
        if (!control.disabled) {
          control.dataset.amjBusyDisabled = '1';
          control.disabled = true;
        }
      } else if (control.dataset.amjBusyDisabled === '1') {
        control.disabled = false;
        delete control.dataset.amjBusyDisabled;
      }
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

  async function call(action, payload, passwordProof) {
    const generation = state.generation;
    const controller = new AbortController();
    state.pendingRequests.add(controller);
    try {
    if (!ownerAccess()) {
      const error = new Error('O Financeiro exige conta proprietária individual com MFA.');
      error.code = 'owner_mfa_required';
      throw error;
    }
    const headers = await cabecalhosAcesso(true, passwordProof);
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
      error.data = data.dados || null;
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

  async function protectedCall(action, payload, options) {
    if (!window.AMJProtecao || typeof window.AMJProtecao.solicitarSenhaRecente !== 'function') {
      throw new Error('A confirmação segura por senha não está disponível. Atualize a página e tente novamente.');
    }
    let proof = null;
    try {
      proof = await window.AMJProtecao.solicitarSenhaRecente(options || {});
      const securedPayload = Object.assign({}, payload || {}, {
        operation_id: proof.operation_id,
        motivo: proof.motivo || (payload && payload.motivo) || 'Alteração confirmada pelo proprietário'
      });
      if (options && options.campoMotivoPayload) {
        securedPayload[options.campoMotivoPayload] = securedPayload.motivo;
      }
      return await call(action, securedPayload, proof);
    } finally {
      if (proof && typeof proof.encerrar === 'function') await proof.encerrar();
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

  function ensureProductIdentityFields() {
    const form = byId('financeiro-form-produto');
    const unit = byId('financeiro-produto-unidade');
    if (!form || !unit || byId('financeiro-produto-apresentacao')) return;
    const presentation = document.createElement('label');
    presentation.innerHTML = '<span>Apresentação / concentração</span>' +
      '<input id="financeiro-produto-apresentacao" type="text" minlength="1" maxlength="160" ' +
      'placeholder="Ex.: 100 U, 1 mL, 210 mg, caixa com 10" required>';
    const ean = document.createElement('label');
    ean.innerHTML = '<span>EAN/GTIN <small>opcional</small></span>' +
      '<input id="financeiro-produto-ean" type="text" inputmode="numeric" maxlength="18" ' +
      'placeholder="8 a 14 dígitos">';
    const anchor = unit.closest('label');
    anchor.insertAdjacentElement('afterend', ean);
    anchor.insertAdjacentElement('afterend', presentation);
  }

  function ensureDuplicateReviewPanel() {
    if (byId('financeiro-duplicidades')) return;
    const audit = byId('financeiro-editor-auditoria');
    if (!audit || !audit.parentNode) return;
    const section = document.createElement('section');
    section.className = 'financeiro-lista-card financeiro-duplicidades-card';
    section.id = 'financeiro-duplicidades';
    section.setAttribute('aria-labelledby', 'financeiro-duplicidades-titulo');
    section.innerHTML = '<div class="financeiro-lista-topo"><div>' +
      '<h3 id="financeiro-duplicidades-titulo">Revisão de possíveis duplicidades</h3>' +
      '<p>Confira os dois registros. A decisão nunca une nem apaga cadastros automaticamente.</p></div>' +
      '<div class="financeiro-filtros"><select id="financeiro-duplicidades-status" aria-label="Filtrar revisões">' +
      '<option value="pendente">Pendentes</option><option value="todos">Todas</option>' +
      '<option value="confirmado_distinto">Confirmados como distintos</option>' +
      '<option value="resolvido_existente">Resolvidos como já existentes</option>' +
      '<option value="descartado">Alertas descartados</option></select>' +
      '<button class="financeiro-botao secundario" id="financeiro-duplicidades-atualizar" type="button">Atualizar fila</button>' +
      '</div></div><p class="financeiro-nota">Encerrar uma pendência exige conta proprietária, MFA, senha individual recente e motivo. A trilha de auditoria é imutável.</p>' +
      '<p class="financeiro-form-status" id="financeiro-duplicidades-status-msg" role="status" aria-live="polite"></p>' +
      '<div class="financeiro-duplicidades-lista" id="financeiro-duplicidades-lista" aria-live="polite"></div>';
    audit.parentNode.insertBefore(section, audit);
  }

  function options(items, placeholder, getLabel) {
    return '<option value="">' + escapeHtml(placeholder) + '</option>' +
      (Array.isArray(items) ? items : []).map(function (item) {
        return '<option value="' + escapeHtml(item.id || item.code || item.codigo) + '">' +
          escapeHtml(getLabel ? getLabel(item) : item.nome || item.name || item.label) + '</option>';
      }).join('');
  }

  function replaceOptions(id, html, preferred) {
    const select = byId(id);
    if (!select) return;
    const current = select.value;
    select.innerHTML = html;
    if (current && Array.from(select.options).some(function (option) { return option.value === current; })) {
      select.value = current;
    } else if (preferred && Array.from(select.options).some(function (option) { return option.value === preferred; })) {
      select.value = preferred;
    }
  }

  function isArchived(item) {
    return Boolean(item && (item.arquivado_em || item.archived_at || item.ativo === false || item.active === false));
  }

  function activeRows(items) {
    return (Array.isArray(items) ? items : []).filter(function (item) { return !isArchived(item); });
  }

  function populateCatalogs() {
    const catalog = state.catalogs;
    const activeClients = activeRows(state.clients);
    const activeSuppliers = activeRows(catalog.fornecedores);
    const activeBrands = activeRows(catalog.marcas);
    const activeProducts = activeRows(catalog.produtos);
    const clientOptions = options(activeClients, 'Selecione um cliente', function (item) {
      return item.nome || item.name || item.full_name || 'Cliente';
    });
    const supplierOptions = options(activeSuppliers, 'Sem fornecedor', function (item) {
      return item.nome || item.name;
    });
    const requiredSupplier = options(activeSuppliers, 'Selecione', function (item) {
      return item.nome || item.name;
    });
    const brandOptions = options(activeBrands, 'Sem marca', function (item) { return item.nome || item.name; });
    const methodOptions = options(catalog.formas_pagamento, 'Selecione', function (item) {
      return item.nome || item.label;
    });
    byId('financeiro-lancamento-cliente').innerHTML = clientOptions;
    byId('financeiro-atendimento-cliente').innerHTML = options(
      activeClients, 'Selecione um cliente cadastrado', function (item) {
        return item.nome || item.name || item.full_name || 'Cliente';
      }
    );
    byId('financeiro-lancamento-fornecedor').innerHTML = supplierOptions;
    byId('financeiro-compra-fornecedor').innerHTML = requiredSupplier;
    byId('financeiro-produto-marca').innerHTML = brandOptions;
    replaceOptions('financeiro-custo-produto', options(activeProducts, 'Selecione', function (item) {
      return item.nome || item.name;
    }));
    replaceOptions('financeiro-custo-fornecedor', supplierOptions);
    replaceOptions('financeiro-pagamento-forma', methodOptions);
    replaceOptions('financeiro-atendimento-forma', methodOptions);
    replaceOptions('financeiro-atendimento-saldo-forma', methodOptions, 'boleto');
    replaceOptions('financeiro-parcelas-forma', methodOptions, 'boleto');
    populateOpenEntries();
    document.querySelectorAll('.financeiro-item-produto').forEach(function (select) {
      const current = select.value;
      select.innerHTML = productOptions();
      select.value = current;
    });
  }

  function productOptions() {
    return options(activeRows(state.catalogs.produtos), 'Selecione o produto', function (item) {
      const brandRow = state.catalogs.marcas.find(function (row) {
        return row.id === (item.marca_id || item.brand_id);
      });
      const brand = item.brand_name || (item.financeiro_marcas && item.financeiro_marcas.name) ||
        (brandRow && (brandRow.nome || brandRow.name)) || '';
      const lots = inventoryForProduct(item.id);
      const balance = lots.reduce(function (sum, lot) { return sum + num(lot.saldo); }, 0);
      const stock = item.controla_estoque ? 'Estoque ' + balance + ' ' + (item.unidade || '') : '';
      return [item.nome || item.name, brand, stock].filter(Boolean).join(' · ');
    });
  }

  function inventoryForProduct(productId) {
    return state.inventory.filter(function (item) {
      return String(item.produto_id) === String(productId) && num(item.saldo) > 0;
    });
  }

  function renderInventory() {
    const box = byId('financeiro-estoque-resumo');
    if (!box) return;
    const controlled = activeRows(state.catalogs.produtos).filter(function (product) {
      return product.controla_estoque;
    });
    if (!controlled.length) {
      box.innerHTML = '<p class="financeiro-vazio">Nenhum produto está marcado para controle de estoque.</p>';
      return;
    }
    box.innerHTML = controlled.map(function (product) {
      const lots = inventoryForProduct(product.id);
      const balance = lots.reduce(function (sum, lot) { return sum + num(lot.saldo); }, 0);
      return '<article class="financeiro-estoque-produto"><div><strong>' +
        escapeHtml(product.nome || product.name) + '</strong><span>Saldo: ' +
        escapeHtml(String(balance)) + ' ' + escapeHtml(product.unidade || '') + '</span></div>' +
        (lots.length ? '<ul>' + lots.map(function (lot) {
          return '<li><span>Lote ' + escapeHtml(lot.lote) + '</span><span>' +
            escapeHtml(String(lot.saldo)) + ' ' + escapeHtml(lot.unidade) +
            ' · validade ' + escapeHtml(safeDate(lot.validade)) + '</span></li>';
        }).join('') + '</ul>' : '<p class="financeiro-vazio">Sem saldo disponível.</p>') + '</article>';
    }).join('');
  }

  function renderPendingStock() {
    const box = byId('financeiro-pendencias-estoque');
    const count = byId('financeiro-pendencias-contagem');
    if (!box || !count) return;
    const rows = Array.isArray(state.pendingStock) ? state.pendingStock : [];
    count.textContent = rows.length ? String(rows.length) + ' pendente(s)' : 'Nenhuma pendência';
    if (!rows.length) {
      box.innerHTML = '<p class="financeiro-vazio">Todas as compras controladas já possuem lote e entrada de estoque.</p>';
      return;
    }
    box.innerHTML = rows.map(function (item) {
      const documentLabel = item.documento ? ' · documento ' + item.documento : '';
      return '<form class="financeiro-pendencia-estoque" data-financeiro-regularizar="' +
        escapeHtml(item.item_compra_id) + '" novalidate><div class="financeiro-pendencia-descricao"><strong>' +
        escapeHtml(item.produto || 'Produto') + '</strong><span>' +
        escapeHtml(String(item.quantidade)) + ' ' + escapeHtml(item.unidade || '') + ' · ' +
        escapeHtml(item.fornecedor || 'Fornecedor') + ' · compra ' + escapeHtml(safeDate(item.data_compra)) +
        escapeHtml(documentLabel) + '</span><small>Custo original preservado: ' +
        escapeHtml(money(item.custo_total_original)) + ' (' +
        escapeHtml(money(item.custo_unitario_original)) + ' por ' +
        escapeHtml(item.unidade || 'unidade') + ')</small></div>' +
        '<label><span>Lote</span><input name="lote" type="text" minlength="1" maxlength="100" required></label>' +
        '<label><span>Validade</span><input name="validade" type="date" min="' +
        escapeHtml(item.data_compra || '') + '" required></label>' +
        '<label class="financeiro-check"><input name="usar_como_custo_atual" type="checkbox"><span>Usar também como custo atual</span></label>' +
        '<button class="financeiro-botao" type="submit">Regularizar com senha</button>' +
        '<p class="financeiro-form-status" role="status"></p></form>';
    }).join('');
  }

  async function regularizePendingStock(form) {
    if (!requireValid(form)) return;
    const itemId = form.dataset.financeiroRegularizar;
    const statusNode = form.querySelector('.financeiro-form-status');
    const lot = form.elements.lote.value.trim();
    const expiry = form.elements.validade.value;
    const useCurrent = form.elements.usar_como_custo_atual.checked;
    setBusy(form, true);
    statusNode.textContent = 'Aguardando confirmação segura…';
    statusNode.classList.remove('erro');
    try {
      await protectedCall('regularizar_item_compra_estoque', {
        item_compra_id: itemId,
        lote: lot,
        validade: expiry,
        usar_como_custo_atual: useCurrent
      }, {
        titulo: 'Regularizar entrada de estoque',
        explicacao: 'O lote e a validade informados gerarão uma entrada auditável sem alterar a compra original.',
        motivo: 'Regularização manual de lote e validade de compra anterior'
      });
      status('financeiro-pendencias-status', 'Entrada regularizada. A compra original e o histórico foram preservados.', false);
      await load({ silent: true });
    } catch (error) {
      if (!isStaleSession(error)) {
        statusNode.textContent = error.message || 'Não foi possível regularizar este item.';
        statusNode.classList.add('erro');
      }
    } finally {
      if (form.isConnected) setBusy(form, false);
    }
  }

  function renderRegistries() {
    const clientQuery = normalizeSearch(byId('financeiro-clientes-busca').value);
    const supplierQuery = normalizeSearch(byId('financeiro-fornecedores-busca').value);
    const productQuery = normalizeSearch(byId('financeiro-produtos-busca').value);
    const brandQuery = normalizeSearch(byId('financeiro-marcas-busca').value);
    const showArchived = byId('financeiro-mostrar-arquivados').checked;
    const clients = state.clients.filter(function (item) {
      return (showArchived || !isArchived(item)) && normalizeSearch(
        [item.nome, item.telefone, item.email, item.cpf_mascarado].join(' '))
        .includes(clientQuery);
    });
    const suppliers = state.catalogs.fornecedores.filter(function (item) {
      return (showArchived || !isArchived(item)) && normalizeSearch(
        [item.nome, item.telefone, item.email, item.documento].join(' '))
        .includes(supplierQuery);
    });
    const products = state.catalogs.produtos.filter(function (item) {
      const brand = state.catalogs.marcas.find(function (row) { return row.id === item.marca_id; });
      return (showArchived || !isArchived(item)) &&
        normalizeSearch([item.nome, item.tipo, brand && brand.nome].join(' ')).includes(productQuery);
    });
    const brands = state.catalogs.marcas.filter(function (item) {
      return (showArchived || !isArchived(item)) && normalizeSearch([item.nome, 'marca'].join(' ')).includes(brandQuery);
    });
    byId('financeiro-clientes-contagem').textContent = String(activeRows(state.clients).length);
    byId('financeiro-fornecedores-contagem').textContent = String(activeRows(state.catalogs.fornecedores).length);
    byId('financeiro-produtos-contagem').textContent = String(activeRows(state.catalogs.produtos).length);
    byId('financeiro-marcas-contagem').textContent = String(activeRows(state.catalogs.marcas).length);
    byId('financeiro-clientes-lista').innerHTML = clients.length ? clients.map(function (item) {
      const contact = [item.telefone, item.email].filter(Boolean).join(' · ');
      const details = [contact, item.cpf_mascarado, item.data_nascimento ? 'Nasc. ' + safeDate(item.data_nascimento) : '']
        .filter(Boolean).join(' · ');
      const archived = isArchived(item);
      return '<article class="financeiro-cadastro-item' + (archived ? ' arquivado' : '') + '"><div><strong>' +
        escapeHtml(item.nome) + (archived ? ' · Arquivado' : '') + '</strong><small>' +
        escapeHtml(details || 'Sem contato informado') + '</small></div><div class="financeiro-cadastro-acoes">' +
        (archived ? '' : '<button type="button" data-financeiro-atender="' + escapeHtml(item.id) + '">Atendimento</button>') +
        (archived ? '' : '<button type="button" data-financeiro-prontuario="' + escapeHtml(item.id) + '">Prontuário</button>') +
        '<button type="button" data-financeiro-editar="cliente" data-financeiro-id="' + escapeHtml(item.id) + '">Editar</button>' +
        '<button class="' + (archived ? '' : 'perigo') + '" type="button" data-financeiro-registro-acao="' +
        (archived ? 'restaurar' : 'arquivar') + '" data-financeiro-entidade="cliente" data-financeiro-id="' +
        escapeHtml(item.id) + '">' + (archived ? 'Restaurar' : 'Apagar/Arquivar') + '</button></div></article>';
    }).join('') : '<p class="financeiro-vazio">Nenhum cliente encontrado.</p>';
    byId('financeiro-fornecedores-lista').innerHTML = suppliers.length ? suppliers.map(function (item) {
      const details = [item.documento_mascarado || maskedDocument(item.documento), item.telefone, item.email]
        .filter(Boolean).join(' · ');
      const archived = isArchived(item);
      return '<article class="financeiro-cadastro-item' + (archived ? ' arquivado' : '') + '"><div><strong>' +
        escapeHtml(item.nome) + (archived ? ' · Arquivado' : '') + '</strong><small>' +
        escapeHtml(details || 'Sem contato informado') + '</small></div><div class="financeiro-cadastro-acoes">' +
        (archived ? '' : '<button type="button" data-financeiro-comprar="' + escapeHtml(item.id) + '">Compra</button>') +
        '<button type="button" data-financeiro-editar="fornecedor" data-financeiro-id="' + escapeHtml(item.id) + '">Editar</button>' +
        '<button class="' + (archived ? '' : 'perigo') + '" type="button" data-financeiro-registro-acao="' +
        (archived ? 'restaurar' : 'arquivar') + '" data-financeiro-entidade="fornecedor" data-financeiro-id="' +
        escapeHtml(item.id) + '">' + (archived ? 'Restaurar' : 'Apagar/Arquivar') + '</button></div></article>';
    }).join('') : '<p class="financeiro-vazio">Nenhum fornecedor encontrado.</p>';
    const brandHtml = brands.map(function (item) {
      const archived = isArchived(item);
      return '<article class="financeiro-cadastro-item' + (archived ? ' arquivado' : '') + '"><div><strong>' +
        escapeHtml(item.nome) + (archived ? ' · Arquivada' : '') + '</strong><small>Marca</small></div>' +
        '<div class="financeiro-cadastro-acoes"><button type="button" data-financeiro-editar="marca" data-financeiro-id="' +
        escapeHtml(item.id) + '">Editar</button><button class="' + (archived ? '' : 'perigo') +
        '" type="button" data-financeiro-registro-acao="' + (archived ? 'restaurar' : 'arquivar') +
        '" data-financeiro-entidade="marca" data-financeiro-id="' + escapeHtml(item.id) + '">' +
        (archived ? 'Restaurar' : 'Apagar/Arquivar') + '</button></div></article>';
    }).join('');
    const productHtml = products.map(function (item) {
      const brand = state.catalogs.marcas.find(function (row) { return row.id === item.marca_id; });
      const archived = isArchived(item);
      const values = [brand && brand.nome, productTypeLabel(item.tipo),
        item.custo_referencia != null ? 'Custo ' + money(item.custo_referencia) : '',
        item.preco_venda != null ? 'Venda ' + money(item.preco_venda) : ''].filter(Boolean).join(' · ');
      return '<article class="financeiro-cadastro-item' + (archived ? ' arquivado' : '') + '"><div><strong>' +
        escapeHtml(item.nome) + (archived ? ' · Arquivado' : '') + '</strong><small>' + escapeHtml(values) +
        '</small></div><div class="financeiro-cadastro-acoes">' +
        (archived ? '' : '<button type="button" data-financeiro-custo="' + escapeHtml(item.id) + '">Custos</button>') +
        '<button type="button" data-financeiro-editar="produto" data-financeiro-id="' + escapeHtml(item.id) + '">Editar</button>' +
        '<button class="' + (archived ? '' : 'perigo') + '" type="button" data-financeiro-registro-acao="' +
        (archived ? 'restaurar' : 'arquivar') + '" data-financeiro-entidade="produto" data-financeiro-id="' +
        escapeHtml(item.id) + '">' + (archived ? 'Restaurar' : 'Apagar/Arquivar') + '</button></div></article>';
    }).join('');
    byId('financeiro-produtos-lista').innerHTML = productHtml ||
      '<p class="financeiro-vazio">Nenhum produto encontrado.</p>';
    byId('financeiro-marcas-lista').innerHTML = brandHtml ||
      '<p class="financeiro-vazio">Nenhuma marca encontrada.</p>';
  }

  function showClientsRegistry(query, message) {
    const search = byId('financeiro-clientes-busca');
    const title = byId('financeiro-cadastros-titulo');
    if (!search || !title) return;
    search.value = query || '';
    renderRegistries();
    const card = title.closest('.financeiro-cadastros-card');
    if (card) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
    search.focus({ preventScroll: true });
    if (message) status('financeiro-status', message, false);
  }

  function populateOpenEntries() {
    const open = state.entries.filter(function (entry) {
      return entryState(entry) !== 'cancelado' && num(entryBalance(entry)) > 0;
    });
    const paymentOptions = options(open, 'Selecione', function (entry) {
      const type = entryType(entry) === 'receita' ? 'Receber' : 'Pagar';
      return type + ' · ' + (entryDescription(entry) || 'Lançamento') + ' · ' + money(entryBalance(entry));
    });
    replaceOptions('financeiro-pagamento-lancamento', paymentOptions);
    const withoutSchedule = open.filter(function (entry) { return entryInstallments(entry).length === 0; });
    const scheduleOptions = options(withoutSchedule, 'Selecione', function (entry) {
      return (entryDescription(entry) || 'Lançamento') + ' · saldo ' + money(entryBalance(entry));
    });
    replaceOptions('financeiro-parcelas-lancamento', scheduleOptions);
    syncPaymentEntry();
    syncInstallmentEditor();
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

  function installmentStatus(row) {
    const stateValue = String(row.estado || '').toLowerCase();
    const value = String(row.status || '').toLowerCase();
    if (stateValue === 'cancelado' || value === 'cancelada' || value === 'cancelado') {
      return { code: 'cancelada', label: 'Cancelada' };
    }
    if (installmentBalance(row) <= 0 || value === 'paga' || value === 'pago' || value === 'quitada') {
      return { code: 'paga', label: 'Paga' };
    }
    if (value === 'vencida' || value === 'vencido' || (row.vencimento && row.vencimento < today())) {
      return { code: 'vencida', label: 'Vencida' };
    }
    if (num(row.valor_pago) > 0 || value === 'parcial') return { code: 'parcial', label: 'Parcial' };
    return { code: 'aberta', label: 'Em aberto' };
  }

  function renderInstallmentSummary(entry) {
    const rows = entryInstallments(entry);
    if (!rows.length) return '';
    const revenue = entryType(entry) === 'receita';
    const activeEntry = entryState(entry) !== 'cancelado';
    return '<div class="financeiro-parcelas-resumo"><strong>Parcelas programadas</strong>' +
      rows.map(function (row, index) {
        const current = installmentStatus(row);
        const number = Number(row.numero) || index + 1;
        const balance = installmentBalance(row);
        const details = [paymentMethodLabel(row.forma_pagamento), 'vence ' + safeDate(row.vencimento), money(row.valor)]
          .filter(Boolean).join(' · ');
        return '<div class="financeiro-parcela-registro"><div><span>' + number + '/' + rows.length + ' · ' +
          escapeHtml(details) + '</span><small>Pago ' + escapeHtml(money(row.valor_pago)) + ' · saldo ' +
          escapeHtml(money(balance)) + '</small></div><span class="financeiro-parcela-status ' + current.code + '">' +
          current.label + '</span>' + (activeEntry && balance > 0 && current.code !== 'cancelada'
            ? '<button type="button" data-financeiro-pagar-parcela="' + escapeHtml(row.id) +
              '" data-financeiro-parcela-entry="' + escapeHtml(entry.id) + '">' +
              (revenue ? 'Receber parcela' : 'Pagar parcela') + '</button>' : '') + '</div>';
      }).join('') + '</div>';
  }

  function entryViewOf(entry) {
    if (entryType(entry) === 'despesa') return 'despesas';
    return entryOrigin(entry) === 'atendimento' ? 'procedimentos' : 'receitas_avulsas';
  }

  function entryViewLabel(view) {
    return view === 'despesas' ? 'Despesas' : (view === 'receitas_avulsas' ? 'Receitas avulsas' : 'Procedimentos');
  }

  function ensureEntryViews() {
    if (byId('financeiro-visoes-lancamentos')) return;
    const list = byId('financeiro-lista');
    if (!list || !list.parentNode) return;
    const navigation = document.createElement('nav');
    navigation.id = 'financeiro-visoes-lancamentos';
    navigation.className = 'financeiro-visoes-lancamentos';
    navigation.setAttribute('aria-label', 'Visões financeiras');
    navigation.innerHTML = [
      ['procedimentos', 'Procedimentos'],
      ['receitas_avulsas', 'Receitas avulsas'],
      ['despesas', 'Despesas']
    ].map(function (item) {
      return '<button type="button" data-financeiro-visao="' + item[0] + '">' + item[1] + '</button>';
    }).join('');
    list.parentNode.insertBefore(navigation, list);
    navigation.addEventListener('click', function (event) {
      const button = event.target.closest('[data-financeiro-visao]');
      if (!button) return;
      state.entryView = button.dataset.financeiroVisao;
      const typeFilter = byId('financeiro-filtro-tipo');
      if (typeFilter) typeFilter.value = '';
      renderEntries();
    });
    const typeFilter = byId('financeiro-filtro-tipo');
    if (typeFilter && typeFilter.closest('label')) typeFilter.closest('label').hidden = true;
  }

  function openEntryView(view) {
    if (!['procedimentos', 'receitas_avulsas', 'despesas'].includes(view)) return false;
    ensureEntryViews();
    state.entryView = view;
    const typeFilter = byId('financeiro-filtro-tipo');
    if (typeFilter) typeFilter.value = '';
    renderEntries();
    const list = byId('financeiro-lista');
    if (list) list.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return true;
  }

  function renderPaymentHistory(entry) {
    const payments = Array.isArray(entry.pagamentos) ? entry.pagamentos : [];
    if (!payments.length) return '<p>Nenhum recebimento ou pagamento registrado.</p>';
    return '<div class="financeiro-detalhe-lista"><strong>Movimentações</strong>' + payments.map(function (payment) {
      const kind = (payment.movement_type || payment.tipo) === 'estorno' ? 'Estorno' :
        (entryType(entry) === 'receita' ? 'Recebimento' : 'Pagamento');
      return '<p>' + escapeHtml(kind + ' · ' + money(payment.amount != null ? payment.amount : payment.valor) +
        ' · ' + paymentMethodLabel(payment.payment_method || payment.forma) + ' · ' +
        safeDateTime(payment.paid_at || payment.pago_em || payment.created_at)) + '</p>';
    }).join('') + '</div>';
  }

  function renderPurchaseDetails(entry) {
    const purchase = entry.compra;
    if (!purchase) return '';
    const items = Array.isArray(purchase.itens) ? purchase.itens : [];
    return '<div class="financeiro-detalhe-lista"><strong>Compra vinculada</strong><p>' +
      escapeHtml('Subtotal ' + money(purchase.subtotal_itens) + ' · frete ' + money(purchase.frete) +
        ' · total ' + money(purchase.valor_total) + (purchase.nota_fiscal ? ' · documento ' + purchase.nota_fiscal : '')) +
      '</p>' + items.map(function (item) {
        const product = recordByType('produto', item.produto_id);
        return '<p>' + escapeHtml((product && product.nome ? product.nome : 'Produto') + ' · ' +
          num(item.quantidade) + ' · ' + money(item.valor_total) + ' · frete rateado ' + money(item.frete_rateado) +
          ' · custo unitário com frete ' + money(item.custo_unitario_efetivo) +
          (item.lote ? ' · lote ' + item.lote : '') + (item.validade ? ' · validade ' + safeDate(item.validade) : '')) + '</p>';
      }).join('') + '</div>';
  }

  function renderEntryDetails(entry) {
    const paymentCondition = entry.condicao_pagamento ? '<p>Condição: ' +
      escapeHtml(entry.condicao_pagamento) + '</p>' : '';
    const attendance = entry.atendimento ? '<div class="financeiro-detalhe-lista"><strong>Procedimento vinculado</strong><p>' +
      escapeHtml(String(entry.atendimento.tipo_procedimento || 'Procedimento').replace(/_/g, ' ') + ' · ' +
        safeDateTime(entry.atendimento.realizado_em) + ' · ' + (entry.atendimento.status || 'realizado')) +
      '</p></div>' : '';
    return '<details class="financeiro-lancamento-detalhes"><summary>Ver detalhes</summary><div>' +
      '<p>Total ' + escapeHtml(money(entryTotal(entry))) + ' · realizado ' +
      escapeHtml(money(entryPaid(entry))) + ' · saldo ' + escapeHtml(money(entryBalance(entry))) + '</p>' +
      paymentCondition + attendance + renderPaymentHistory(entry) + renderPurchaseDetails(entry) + '</div></details>';
  }

  function openAdministrativePrint(entry) {
    if (!entry) return;
    const expense = entryType(entry) === 'despesa';
    const procedure = !expense && entryOrigin(entry) === 'atendimento';
    const purchase = entry.compra || null;
    const documentKind = expense ? (purchase ? 'Compra / despesa' : 'Despesa') :
      (procedure ? 'Procedimento' : 'Receita avulsa');
    const partyLabel = expense ? 'Fornecedor' : 'Paciente';
    const partyName = expense
      ? (entry.supplier_name || (entry.fornecedor && entry.fornecedor.nome) || 'Fornecedor não informado')
      : (entry.patient_name || (entry.cliente && entry.cliente.nome) || 'Paciente não informado');
    const payments = Array.isArray(entry.pagamentos) ? entry.pagamentos : [];
    const installments = entryInstallments(entry);
    const row = function (label, value) {
      return '<tr><th>' + escapeHtml(label) + '</th><td>' + escapeHtml(value) + '</td></tr>';
    };
    const paymentRows = payments.map(function (payment) {
      const kind = (payment.movement_type || payment.tipo) === 'estorno' ? 'Estorno' :
        (expense ? 'Pagamento' : 'Recebimento');
      return '<tr><td>' + escapeHtml(kind) + '</td><td>' + escapeHtml(money(payment.amount != null ? payment.amount : payment.valor)) +
        '</td><td>' + escapeHtml(paymentMethodLabel(payment.payment_method || payment.forma)) + '</td><td>' +
        escapeHtml(safeDateTime(payment.paid_at || payment.pago_em || payment.created_at)) + '</td></tr>';
    }).join('') || '<tr><td colspan="4">Nenhuma movimentação registrada.</td></tr>';
    const installmentRows = installments.map(function (installment) {
      return '<tr><td>' + escapeHtml(String(installment.numero || '')) + '</td><td>' +
        escapeHtml(safeDate(installment.vencimento)) + '</td><td>' + escapeHtml(money(installment.valor)) +
        '</td><td>' + escapeHtml(paymentMethodLabel(installment.forma_pagamento)) + '</td><td>' +
        escapeHtml(statusLabel(installment.status)) + '</td></tr>';
    }).join('') || '<tr><td colspan="5">Sem parcelas programadas.</td></tr>';
    const purchaseRows = purchase ? row('Subtotal dos produtos', money(purchase.subtotal_itens)) +
      row('Frete da compra', money(purchase.frete)) + row('Total da compra', money(purchase.valor_total)) +
      row('Data da compra', safeDate(purchase.data_compra)) +
      (purchase.nota_fiscal ? row('Documento da compra', purchase.nota_fiscal) : '') : '';
    const purchaseItems = purchase && Array.isArray(purchase.itens) ? purchase.itens : [];
    const purchaseItemRows = purchaseItems.map(function (item) {
      const product = recordByType('produto', item.produto_id);
      return '<tr><td>' + escapeHtml(product && product.nome ? product.nome : 'Produto') + '</td><td>' +
        escapeHtml(String(num(item.quantidade))) + '</td><td>' + escapeHtml(money(item.valor_total)) + '</td><td>' +
        escapeHtml(money(item.frete_rateado)) + '</td><td>' + escapeHtml(money(item.custo_unitario_efetivo)) + '</td><td>' +
        escapeHtml(item.lote || '—') + '</td></tr>';
    }).join('');
    const purchaseItemsSection = purchase ? '<h2>Produtos e rateio do frete</h2><table><thead><tr><th>Produto</th><th>Quantidade</th>' +
      '<th>Subtotal</th><th>Frete rateado</th><th>Custo unitário com frete</th><th>Lote</th></tr></thead><tbody>' +
      (purchaseItemRows || '<tr><td colspan="6">Nenhum item vinculado.</td></tr>') + '</tbody></table>' : '';
    const popup = window.open('', '_blank');
    if (!popup) {
      status('financeiro-status', 'O navegador bloqueou a janela de impressão. Libere pop-ups e tente novamente.', true);
      return;
    }
    popup.opener = null;
    popup.document.write('<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>' +
      escapeHtml('Resumo administrativo de ' + documentKind.toLowerCase()) +
      '</title><style>@page{size:A4;margin:18mm}body{font-family:Arial,sans-serif;color:#2c2623;line-height:1.4;max-width:820px;margin:28px auto;padding:0 20px}h1{font-size:22px;margin-bottom:4px}h2{font-size:15px;margin-top:24px}p.aviso{padding:10px;border:1px solid #9a7b52;background:#faf6ef}table{width:100%;border-collapse:collapse;margin-top:8px}th,td{border:1px solid #ddd;padding:7px;text-align:left;font-size:12px}th{background:#f5f1eb}button{padding:10px 14px;margin-bottom:20px}@media print{button{display:none}body{margin:0;max-width:none}}</style></head><body>' +
      '<button type="button" onclick="window.print()">Imprimir / Salvar como PDF</button><h1>Ana Maria Jacob Estética</h1>' +
      '<p class="aviso">Resumo administrativo — não é nota fiscal nem recibo fiscal.</p><h2>' +
      escapeHtml(documentKind) + '</h2><table>' +
      row(partyLabel, partyName) + row('Data', safeDate(entry.competencia || entry.competence_date)) +
      row('Descrição', entryDescription(entry) || 'Sem descrição') + row('Valor total', money(entryTotal(entry))) +
      (procedure && entry.atendimento ? row('Procedimento vinculado',
        String(entry.atendimento.tipo_procedimento || 'Procedimento').replace(/_/g, ' ')) : '') +
      purchaseRows + row(expense ? 'Pago' : 'Recebido', money(entryPaid(entry))) +
      row('Saldo', money(entryBalance(entry))) +
      row('Status', statusLabel(entryState(entry) === 'cancelado' ? 'cancelado' : entryStatus(entry))) +
      row('ID administrativo', String(entry.id || '')) + row('Gerado em', DATE_TIME.format(new Date())) +
      '</table><h2>Parcelas</h2><table><thead><tr><th>Nº</th><th>Vencimento</th><th>Valor</th><th>Forma</th><th>Status</th></tr></thead><tbody>' +
      installmentRows + '</tbody></table><h2>' + escapeHtml(expense ? 'Pagamentos e estornos' : 'Recebimentos e estornos') +
      '</h2><table><thead><tr><th>Tipo</th><th>Valor</th><th>Forma</th><th>Data</th></tr></thead><tbody>' +
      paymentRows + '</tbody></table>' + purchaseItemsSection + '</body></html>');
    popup.document.close();
    popup.focus();
  }

  function filteredEntries() {
    const situation = byId('financeiro-filtro-status').value;
    return state.entries.filter(function (entry) {
      const calculated = entry.calculated_status || entry.status || '';
      return entryViewOf(entry) === state.entryView && (!situation || calculated === situation ||
        (situation === 'cancelado' && entryState(entry) === 'cancelado'));
    });
  }

  function renderEntries() {
    ensureEntryViews();
    document.querySelectorAll('[data-financeiro-visao]').forEach(function (button) {
      const active = button.dataset.financeiroVisao === state.entryView;
      button.classList.toggle('ativo', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
    const list = byId('financeiro-lista');
    const entries = filteredEntries();
    byId('financeiro-contagem').textContent = entryViewLabel(state.entryView) + ': ' + entries.length +
      (entries.length === 1 ? ' registro' : ' registros');
    list.setAttribute('aria-busy', 'false');
    if (!entries.length) {
      list.innerHTML = '<p class="financeiro-vazio">Nenhum lançamento encontrado neste filtro.</p>';
      populateOpenEntries();
      return;
    }
    list.innerHTML = entries.map(function (entry) {
      const calculated = entryState(entry) === 'cancelado' ? 'cancelado' : (entryStatus(entry) || 'pendente');
      const type = entryType(entry) === 'receita' ? 'receita' : 'despesa';
      const view = entryViewOf(entry);
      const received = num(entryPaid(entry));
      const balance = num(entryBalance(entry));
      const patientName = entry.patient_name || (entry.cliente && entry.cliente.nome);
      const supplierName = entry.supplier_name || (entry.fornecedor && entry.fornecedor.nome);
      const party = patientName ? 'Paciente: ' + patientName : (supplierName ? 'Fornecedor: ' + supplierName : '');
      const payments = Array.isArray(entry.pagamentos) ? entry.pagamentos : [];
      const scheduled = entryInstallments(entry);
      const openScheduled = scheduled.filter(function (row) { return installmentBalance(row) > 0; });
      const actions = [];
      if (entryState(entry) !== 'cancelado' && balance > 0 && (!scheduled.length || !openScheduled.length)) {
        actions.push('<button type="button" data-financeiro-pagar="' + escapeHtml(entry.id) + '">' +
          (type === 'receita' ? 'Registrar recebimento' : 'Registrar pagamento') + '</button>');
      }
      if (entryState(entry) !== 'cancelado' && balance > 0 && !scheduled.length) {
        actions.push('<button type="button" data-financeiro-programar-parcelas="' + escapeHtml(entry.id) +
          '">Programar parcelas do saldo</button>');
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
      actions.push('<button type="button" data-financeiro-imprimir="' + escapeHtml(entry.id) +
        '">Abrir resumo para imprimir/PDF</button>');
      if (view === 'procedimentos') {
        actions.push('<button type="button" data-financeiro-abrir-procedimentos="' + escapeHtml(entry.id) +
          '">Abrir gestão do procedimento</button>');
      }
      return '<article class="financeiro-lancamento" data-financeiro-entry-card="' + escapeHtml(entry.id) + '"><div class="financeiro-lancamento-topo"><div>' +
        '<h4>' + escapeHtml(entryDescription(entry) || 'Lançamento') + '</h4>' +
        '<p class="financeiro-lancamento-meta">Competência ' + escapeHtml(safeDate(entry.competence_date || entry.competencia)) +
        ' · vencimento ' + escapeHtml(safeDate(entry.due_date || entry.vencimento)) + '</p></div>' +
        '<span class="financeiro-lancamento-valor">' + escapeHtml(money(entryTotal(entry))) + '</span></div>' +
        (party ? '<p class="financeiro-lancamento-parte">' + escapeHtml(party) + '</p>' : '') +
        '<div class="financeiro-selos"><span class="financeiro-selo ' + type + '">' +
        escapeHtml(entryViewLabel(view)) + '</span><span class="financeiro-selo ' +
        escapeHtml(calculated) + '">' + escapeHtml(statusLabel(calculated)) + '</span>' +
        '<span class="financeiro-selo">' + escapeHtml(entryCategory(entry)) + '</span></div>' +
        '<p class="financeiro-lancamento-meta">Pago: ' + escapeHtml(money(received)) +
        ' · saldo: ' + escapeHtml(money(balance)) + '</p>' +
        renderInstallmentSummary(entry) +
        renderEntryDetails(entry) +
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

  function duplicateEntityLabel(value) {
    return ({ cliente: 'Cliente', fornecedor: 'Fornecedor', marca: 'Marca', produto: 'Produto',
      compra: 'Compra', lancamento: 'Lançamento', pagamento: 'Pagamento',
      custo_produto: 'Custo de produto', foto_clinica: 'Foto clínica' })[String(value || '')] ||
      String(value || 'Registro');
  }

  function duplicateStatusLabel(value) {
    return ({ pendente: 'Pendente', confirmado_distinto: 'Registros distintos',
      resolvido_existente: 'Registro já existente', descartado: 'Alerta descartado' })[String(value || '')] ||
      String(value || '');
  }

  function renderDuplicateParty(party, caption, entityKind) {
    const item = party || {};
    const canOpen = ['cliente', 'fornecedor', 'marca', 'produto'].includes(entityKind) && item.id;
    return '<article class="financeiro-duplicidade-parte"><small>' + escapeHtml(caption) + '</small>' +
      '<strong>' + escapeHtml(item.titulo || 'Registro não localizado') + '</strong>' +
      '<span>' + escapeHtml(item.resumo || '') + '</span>' +
      (canOpen ? '<button type="button" data-financeiro-duplicidade-abrir data-tipo="' +
        escapeHtml(entityKind) + '" data-id="' + escapeHtml(item.id) + '">Abrir existente</button>' : '') +
      '</article>';
  }

  function renderDuplicateReviews() {
    const box = byId('financeiro-duplicidades-lista');
    if (!box) return;
    const reviews = Array.isArray(state.duplicateReviews) ? state.duplicateReviews : [];
    if (!reviews.length) {
      box.innerHTML = '<p class="financeiro-vazio">Nenhuma revisão encontrada neste filtro.</p>';
      return;
    }
    box.innerHTML = reviews.map(function (review) {
      const pending = review.status === 'pendente';
      const entityKind = String(review.entidade || '');
      const actions = pending
        ? '<div class="financeiro-duplicidade-acoes">' +
          '<button type="button" data-financeiro-duplicidade-resolver="confirmado_distinto" data-id="' +
          escapeHtml(review.id) + '" data-versao="' + escapeHtml(review.versao) + '">Confirmar que são distintos</button>' +
          '<button type="button" data-financeiro-duplicidade-resolver="resolvido_existente" data-id="' +
          escapeHtml(review.id) + '" data-versao="' + escapeHtml(review.versao) + '">Marcar como já existente</button>' +
          '<button class="secundario" type="button" data-financeiro-duplicidade-resolver="descartado" data-id="' +
          escapeHtml(review.id) + '" data-versao="' + escapeHtml(review.versao) + '">Descartar alerta</button></div>'
        : '';
      return '<article class="financeiro-duplicidade-item"><div class="financeiro-duplicidade-topo"><div><strong>' +
        escapeHtml(duplicateEntityLabel(entityKind)) + '</strong><small>Detecção ' +
        escapeHtml(safeDateTime(review.detectado_em)) + ' · ' +
        escapeHtml(String(review.tipo_correspondencia || '').replace(/_/g, ' ')) + '</small></div>' +
        '<span class="financeiro-selo ' + (pending ? 'parcial' : 'pago') + '">' +
        escapeHtml(duplicateStatusLabel(review.status)) + '</span></div>' +
        '<div class="financeiro-duplicidade-comparacao">' +
        renderDuplicateParty(review.principal, 'Registro principal', entityKind) +
        renderDuplicateParty(review.candidato, 'Registro candidato', entityKind) + '</div>' +
        (!pending && review.motivo_revisao
          ? '<p class="financeiro-duplicidade-motivo"><strong>Motivo:</strong> ' +
            escapeHtml(review.motivo_revisao) + '</p>' : '') + actions + '</article>';
    }).join('');
  }

  async function loadDuplicateReviews(options) {
    const select = byId('financeiro-duplicidades-status');
    const filter = select ? select.value : 'pendente';
    if (!(options && options.silent)) {
      status('financeiro-duplicidades-status-msg', 'Atualizando a fila de duplicidades…', false);
    }
    const result = await call('listar_revisoes_duplicidade', {
      status: filter,
      por_pagina: 100
    });
    state.duplicateReviews = Array.isArray(result.revisoes) ? result.revisoes : [];
    renderDuplicateReviews();
    status('financeiro-duplicidades-status-msg',
      state.duplicateReviews.length + ' revisão(ões) neste filtro.', false);
  }

  async function resolveDuplicateReview(button) {
    const resolution = button.dataset.financeiroDuplicidadeResolver;
    const labels = {
      confirmado_distinto: 'Confirmar registros distintos',
      resolvido_existente: 'Marcar como registro já existente',
      descartado: 'Descartar alerta de duplicidade'
    };
    button.disabled = true;
    status('financeiro-duplicidades-status-msg', 'Aguardando confirmação segura…', false);
    try {
      await protectedCall('resolver_revisao_duplicidade', {
        revisao_id: button.dataset.id,
        versao: Number(button.dataset.versao),
        resolucao: resolution
      }, {
        titulo: labels[resolution] || 'Encerrar revisão de duplicidade',
        explicacao: 'A decisão encerra somente o alerta. Nenhum cadastro será unido ou apagado automaticamente.',
        motivo: 'Revisão manual dos dois registros pelo proprietário'
      });
      await loadDuplicateReviews({ silent: true });
      status('financeiro-duplicidades-status-msg',
        'Revisão encerrada com auditoria. Os registros originais foram preservados.', false);
    } catch (error) {
      if (!isStaleSession(error)) status('financeiro-duplicidades-status-msg', error.message, true);
    } finally {
      if (button.isConnected) button.disabled = false;
    }
  }

  async function load(options) {
    if (state.loading || !ownerAccess()) return;
    state.loading = true;
    status('financeiro-status', options && options.silent ? '' : 'Atualizando dados financeiros…', false);
    byId('financeiro-lista').setAttribute('aria-busy', 'true');
    try {
      const results = await Promise.all([
        call('resumo'), call('listar_catalogos', { incluir_arquivados: true }),
        call('listar_clientes', { por_pagina: 100, incluir_arquivados: true }),
        call('listar_lancamentos', { por_pagina: 100 }), call('listar_auditoria', { limite: 50 }),
        call('listar_estoque', { limite: 500 }),
        call('listar_pendencias_estoque', { limite: 200 }),
        call('listar_revisoes_duplicidade', {
          status: byId('financeiro-duplicidades-status').value || 'pendente',
          por_pagina: 100
        })
      ]);
      renderSummary(results[0]);
      state.catalogs = Object.assign(state.catalogs, results[1] || {});
      state.clients = Array.isArray(results[2].clientes) ? results[2].clientes : [];
      state.entries = Array.isArray(results[3].lancamentos) ? results[3].lancamentos : state.entries;
      state.audit = Array.isArray(results[4].auditoria) ? results[4].auditoria : [];
      state.inventory = Array.isArray(results[5].estoque) ? results[5].estoque : [];
      state.pendingStock = Array.isArray(results[6].pendencias) ? results[6].pendencias : [];
      state.duplicateReviews = Array.isArray(results[7].revisoes) ? results[7].revisoes : [];
      populateCatalogs();
      renderRegistries();
      renderInventory();
      renderPendingStock();
      renderEntries();
      renderAudit();
      renderDuplicateReviews();
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
    state.costs = [];
    state.inventory = [];
    state.pendingStock = [];
    state.clients = [];
    state.entries = [];
    state.audit = [];
    state.duplicateReviews = [];
    state.summary = {};
    state.flow = [];
    state.selectedCandidate = null;
    state.candidateConfirmed = false;
    state.intentKeys = Object.create(null);
    state.entryView = 'procedimentos';
    resetClientEdit();
    ['fornecedor', 'marca', 'produto'].forEach(resetCatalogEdit);
    if (byId('financeiro-form-custo-produto')) byId('financeiro-form-custo-produto').reset();
    if (byId('financeiro-custos-historico')) {
      byId('financeiro-custos-historico').innerHTML =
        '<p class="financeiro-vazio">Selecione um produto para consultar o histórico.</p>';
    }
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
      ['financeiro-atendimento-cliente', 'financeiro-atendimento-forma', 'financeiro-atendimento-saldo-forma',
        'financeiro-lancamento-cliente', 'financeiro-lancamento-fornecedor',
        'financeiro-compra-fornecedor', 'financeiro-produto-marca', 'financeiro-pagamento-forma',
        'financeiro-pagamento-lancamento', 'financeiro-pagamento-parcela',
        'financeiro-parcelas-lancamento', 'financeiro-parcelas-forma'].forEach(function (id) {
        const select = byId(id);
        if (select) select.innerHTML = '<option value="">Selecione</option>';
      });
      ['financeiro-lista', 'financeiro-auditoria', 'financeiro-cliente-candidatos',
        'financeiro-compra-itens', 'financeiro-clientes-lista', 'financeiro-fornecedores-lista',
        'financeiro-produtos-lista', 'financeiro-marcas-lista', 'financeiro-pendencias-estoque', 'financeiro-atendimento-parcelas-lista',
        'financeiro-parcelas-lista', 'financeiro-duplicidades-lista'].forEach(function (id) {
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
      byId('financeiro-clientes-contagem').textContent = '0';
      byId('financeiro-fornecedores-contagem').textContent = '0';
      byId('financeiro-produtos-contagem').textContent = '0';
      byId('financeiro-marcas-contagem').textContent = '0';
      byId('financeiro-clientes-busca').value = '';
      byId('financeiro-fornecedores-busca').value = '';
      byId('financeiro-produtos-busca').value = '';
      byId('financeiro-marcas-busca').value = '';
      byId('financeiro-status').textContent = '';
      byId('financeiro-lista').setAttribute('aria-busy', 'false');
      setInitialDates();
      syncServiceForm();
      syncEntryForm();
      syncPaymentEntry();
      syncInstallmentEditor();
      syncPurchaseForm();
      addPurchaseItem();
    }
    updateAccess();
  }

  function syncServiceForm() {
    const procedureOther = byId('financeiro-atendimento-procedimento').value === 'outro';
    const situation = byId('financeiro-atendimento-situacao').value;
    const partial = situation === 'parcial';
    const paid = situation !== 'pendente';
    const parsedTotal = parseMoney(byId('financeiro-atendimento-valor').value);
    const total = Number.isFinite(parsedTotal) && parsedTotal > 0 ? parsedTotal : 0;
    const parsedReceived = partial ? parseMoney(byId('financeiro-atendimento-valor-recebido').value) : 0;
    const received = situation === 'recebido' ? total :
      (partial && Number.isFinite(parsedReceived) && parsedReceived > 0 ? parsedReceived : 0);
    const balance = roundMoney(Math.max(0, total - received));
    const hasFutureBalance = total > 0 && balance > 0 && situation !== 'recebido';
    byId('financeiro-atendimento-outro-campo').classList.toggle('oculto', !procedureOther);
    byId('financeiro-atendimento-outro').required = procedureOther;
    byId('financeiro-atendimento-valor-recebido-campo').classList.toggle('oculto', !partial);
    byId('financeiro-atendimento-valor-recebido').required = partial;
    byId('financeiro-atendimento-forma-campo').classList.toggle('oculto', !paid);
    byId('financeiro-atendimento-forma').required = paid;
    byId('financeiro-atendimento-saldo').textContent = money(balance);
    byId('financeiro-atendimento-saldo-forma-campo').classList.toggle('oculto', !hasFutureBalance);
    byId('financeiro-atendimento-parcelas-campo').classList.toggle('oculto', !hasFutureBalance);
    byId('financeiro-atendimento-parcelas-lista').classList.toggle('oculto', !hasFutureBalance);
    byId('financeiro-atendimento-saldo-forma').required = hasFutureBalance;
    byId('financeiro-atendimento-parcelas').required = hasFutureBalance;
    if (hasFutureBalance) {
      if (!byId('financeiro-atendimento-saldo-forma').value &&
          Array.from(byId('financeiro-atendimento-saldo-forma').options).some(function (option) {
            return option.value === 'boleto';
          })) byId('financeiro-atendimento-saldo-forma').value = 'boleto';
      renderInstallmentRows('financeiro-atendimento-parcelas-lista', balance,
        Number(byId('financeiro-atendimento-parcelas').value),
        byId('financeiro-atendimento-data').value || today());
    } else {
      byId('financeiro-atendimento-parcelas-lista').innerHTML = '';
      delete byId('financeiro-atendimento-parcelas-lista').dataset.signature;
    }
    if (!partial) byId('financeiro-atendimento-valor-recebido').value = '';
  }

  async function submitService(event) {
    event.preventDefault();
    const form = event.currentTarget;
    syncServiceForm();
    if (!requireValid(form)) return;
    const total = parseMoney(byId('financeiro-atendimento-valor').value);
    if (!(total > 0)) {
      status('financeiro-atendimento-status', 'Informe um valor total maior que zero.', true);
      byId('financeiro-atendimento-valor').focus();
      return;
    }
    const situation = byId('financeiro-atendimento-situacao').value;
    let received = 0;
    if (situation === 'recebido') received = total;
    if (situation === 'parcial') received = parseMoney(byId('financeiro-atendimento-valor-recebido').value);
    if (situation === 'parcial' && (!(received > 0) || received >= total)) {
      status('financeiro-atendimento-status', 'No pagamento parcial, informe um valor maior que zero e menor que o total.', true);
      byId('financeiro-atendimento-valor-recebido').focus();
      return;
    }
    const balance = roundMoney(total - received);
    const plannedMethod = byId('financeiro-atendimento-saldo-forma').value;
    const planned = balance > 0
      ? collectInstallments('financeiro-atendimento-parcelas-lista', plannedMethod) : [];
    if (balance > 0 && !validateInstallments(planned, balance)) {
      status('financeiro-atendimento-status',
        'Confira as datas e os valores: as parcelas precisam somar exatamente ' + money(balance) + '.', true);
      return;
    }
    setBusy(form, true);
    try {
      await call('registrar_atendimento', {
        idempotency_key: intentKey('atendimento'),
        pagamento_idempotency_key: received > 0 ? intentKey('atendimento_pagamento') : null,
        cliente_id: byId('financeiro-atendimento-cliente').value,
        procedimento: byId('financeiro-atendimento-procedimento').value,
        procedimento_outro: byId('financeiro-atendimento-outro').value.trim() || null,
        data_atendimento: byId('financeiro-atendimento-data').value,
        valor_total: total,
        situacao_pagamento: situation,
        valor_recebido: received,
        forma_pagamento: received > 0 ? byId('financeiro-atendimento-forma').value : null,
        parcelas_pagamento: received > 0 ? 1 : null,
        parcelas: planned.length || 1,
        vencimento: planned.length ? planned[0].vencimento : byId('financeiro-atendimento-data').value,
        parcelas_previstas: planned,
        observacoes: byId('financeiro-atendimento-observacoes').value.trim() || null
      });
      clearIntent('atendimento');
      clearIntent('atendimento_pagamento');
      form.reset();
      setInitialDates();
      syncServiceForm();
      status('financeiro-atendimento-status',
        planned.length ? 'Atendimento, entrada e datas do saldo foram salvos e auditados.' :
          'Atendimento e pagamento foram salvos e auditados.', false);
      await load({ silent: true });
    } catch (error) {
      if (!isStaleSession(error)) status('financeiro-atendimento-status', error.message, true);
    } finally { setBusy(form, false); }
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

  function syncPaymentForm() {
    const credit = byId('financeiro-pagamento-forma').value === 'cartao_credito';
    byId('financeiro-pagamento-parcelas-campo').classList.toggle('oculto', !credit);
    if (!credit) byId('financeiro-pagamento-parcelas').value = '1';
  }

  function syncPaymentSelection() {
    const entry = state.entries.find(function (row) {
      return row.id === byId('financeiro-pagamento-lancamento').value;
    });
    const installment = entryInstallments(entry).find(function (row) {
      return row.id === byId('financeiro-pagamento-parcela').value;
    });
    if (installment) {
      byId('financeiro-pagamento-valor').value = moneyInput(installmentBalance(installment));
      if (Array.from(byId('financeiro-pagamento-forma').options).some(function (option) {
        return option.value === installment.forma_pagamento;
      })) byId('financeiro-pagamento-forma').value = installment.forma_pagamento;
    }
    syncPaymentForm();
  }

  function syncPaymentEntry(preferredInstallment) {
    const select = byId('financeiro-pagamento-parcela');
    if (!select) return;
    const entry = state.entries.find(function (row) {
      return row.id === byId('financeiro-pagamento-lancamento').value;
    });
    const scheduled = entryInstallments(entry);
    const open = scheduled.filter(function (row) { return installmentBalance(row) > 0; });
    const total = scheduled.length;
    const previous = preferredInstallment || select.value;
    select.innerHTML = options(open, 'Selecione a parcela', function (row) {
      return (row.numero || 1) + '/' + total + ' · ' + safeDate(row.vencimento) + ' · ' +
        money(installmentBalance(row)) + ' · ' + paymentMethodLabel(row.forma_pagamento);
    });
    const hasSchedule = open.length > 0;
    byId('financeiro-pagamento-parcela-campo').classList.toggle('oculto', !hasSchedule);
    select.required = hasSchedule;
    if (previous && Array.from(select.options).some(function (option) { return option.value === previous; })) {
      select.value = previous;
    } else if (open.length === 1) select.value = open[0].id;
    syncPaymentSelection();
  }

  function syncInstallmentEditor() {
    const entry = state.entries.find(function (row) {
      return row.id === byId('financeiro-parcelas-lancamento').value;
    });
    const balance = entry ? num(entryBalance(entry)) : 0;
    byId('financeiro-parcelas-saldo').textContent = money(balance);
    if (!entry || !(balance > 0)) {
      byId('financeiro-parcelas-lista').innerHTML =
        '<p class="financeiro-vazio">Selecione um lançamento para informar as datas.</p>';
      delete byId('financeiro-parcelas-lista').dataset.signature;
      return;
    }
    if (!byId('financeiro-parcelas-forma').value &&
        Array.from(byId('financeiro-parcelas-forma').options).some(function (option) {
          return option.value === 'boleto';
        })) byId('financeiro-parcelas-forma').value = 'boleto';
    renderInstallmentRows('financeiro-parcelas-lista', balance,
      Number(byId('financeiro-parcelas-quantidade').value), today());
  }

  async function submitInstallmentSchedule(event) {
    event.preventDefault();
    const form = event.currentTarget;
    syncInstallmentEditor();
    if (!requireValid(form)) return;
    const entryId = byId('financeiro-parcelas-lancamento').value;
    const entry = state.entries.find(function (row) { return row.id === entryId; });
    const balance = entry ? num(entryBalance(entry)) : 0;
    const installments = collectInstallments('financeiro-parcelas-lista', byId('financeiro-parcelas-forma').value);
    if (!(balance > 0) || !validateInstallments(installments, balance)) {
      status('financeiro-parcelas-status',
        'Confira as datas e os valores: as parcelas precisam somar exatamente ' + money(balance) + '.', true);
      return;
    }
    setBusy(form, true);
    try {
      await call('programar_parcelas', {
        entry_id: entryId,
        idempotency_key: intentKey('parcelas'),
        parcelas: installments
      });
      clearIntent('parcelas');
      form.reset();
      if (Array.from(byId('financeiro-parcelas-forma').options).some(function (option) {
        return option.value === 'boleto';
      })) byId('financeiro-parcelas-forma').value = 'boleto';
      syncInstallmentEditor();
      status('financeiro-parcelas-status', 'Datas e valores das parcelas foram salvos.', false);
      await load({ silent: true });
    } catch (error) {
      if (!isStaleSession(error)) status('financeiro-parcelas-status', error.message, true);
    } finally { setBusy(form, false); }
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
        parcela_id: byId('financeiro-pagamento-parcela').value || null,
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
      syncPaymentEntry();
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
        const linked = item.cliente_id || (item.vinculo && item.vinculo.cliente_id);
        const matchLabel = linked ? 'Cadastro existente' : 'Possível cadastro · revisar';
        return '<article class="financeiro-candidato"><div><strong>' + escapeHtml(item.nome || item.name) +
          '</strong><small>' + escapeHtml(contact || 'Sem contato exibido') + ' · ' +
          escapeHtml(item.origem_rotulo || item.source_kind || item.origem || 'cadastro') +
          ' · ' + escapeHtml(matchLabel) + '</small></div>' +
          (linked
            ? '<button type="button" data-financeiro-abrir-existente data-tipo="cliente" data-id="' +
              escapeHtml(linked) + '">Abrir existente</button>'
            : '<button type="button" data-financeiro-candidato="' + index + '">Usar dados</button>') + '</article>';
      }).join('');
      box.querySelectorAll('[data-financeiro-abrir-existente]').forEach(function (button) {
        button.addEventListener('click', function () {
          openExistingRegistration(button.dataset.tipo, button.dataset.id);
        });
      });
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

  function versionOf(item) {
    return Number(item && (item.versao != null ? item.versao : item.version)) || 1;
  }

  function recordByType(type, id) {
    const source = type === 'cliente' ? state.clients
      : type === 'fornecedor' ? state.catalogs.fornecedores
      : type === 'marca' ? state.catalogs.marcas
      : type === 'produto' ? state.catalogs.produtos : [];
    return source.find(function (item) { return String(item.id) === String(id); }) || null;
  }

  function resetClientEdit() {
    const form = byId('financeiro-form-cliente');
    if (!form) return;
    form.reset();
    byId('financeiro-cliente-id').value = '';
    byId('financeiro-cliente-versao').value = '';
    byId('financeiro-cliente-pesquisa').disabled = false;
    byId('financeiro-cliente-salvar').textContent = 'Salvar cliente';
    byId('financeiro-cliente-cancelar-edicao').classList.add('oculto');
    byId('financeiro-cliente-candidatos').innerHTML = '';
    state.selectedCandidate = null;
    state.candidateConfirmed = false;
    const duplicate = form.querySelector('[data-financeiro-duplicata-exata]');
    removeNode(duplicate);
    clearIntent('cliente');
  }

  function resetCatalogEdit(type) {
    const form = byId('financeiro-form-' + type);
    if (!form) return;
    form.reset();
    byId('financeiro-' + type + '-id').value = '';
    byId('financeiro-' + type + '-versao').value = '';
    const singular = type === 'fornecedor' ? 'fornecedor' : type === 'marca' ? 'marca' : 'produto';
    byId('financeiro-' + type + '-titulo').textContent =
      (type === 'marca' ? 'Nova ' : 'Novo ') + singular;
    byId('financeiro-' + type + '-salvar').textContent =
      'Salvar ' + singular;
    byId('financeiro-' + type + '-cancelar-edicao').classList.add('oculto');
    if (type === 'produto') byId('financeiro-produto-tipo').value = 'bioestimulador';
    const duplicate = form.querySelector('[data-financeiro-duplicata-exata]');
    removeNode(duplicate);
    clearIntent('criar_' + type);
  }

  async function openExistingRegistration(type, id) {
    if (!['cliente', 'fornecedor', 'marca', 'produto'].includes(type) || !id) return;
    if (!recordByType(type, id)) await load({ silent: true });
    await beginRegistryEdit(type, id);
  }

  function showExactDuplicate(statusId, error) {
    const details = error && error.data;
    const existingId = details && (details.existing_id ||
      (details.candidato && details.candidato.id));
    const type = details && (details.tipo || details.type);
    if (!existingId || !type) return false;
    const statusNode = byId(statusId);
    if (!statusNode) return false;
    const previous = statusNode.parentElement.querySelector('[data-financeiro-duplicata-exata]');
    removeNode(previous);
    const box = document.createElement('div');
    box.className = 'financeiro-nota';
    box.setAttribute('data-financeiro-duplicata-exata', '');
    box.innerHTML = '<strong>Cadastro exato já existente.</strong> ' +
      '<button type="button" data-financeiro-abrir-existente data-tipo="' + escapeHtml(type) +
      '" data-id="' + escapeHtml(existingId) + '">Abrir existente</button>';
    statusNode.insertAdjacentElement('afterend', box);
    box.querySelector('[data-financeiro-abrir-existente]').addEventListener('click', function (event) {
      const button = event.currentTarget;
      openExistingRegistration(button.dataset.tipo, button.dataset.id);
    });
    return true;
  }

  async function beginRegistryEdit(type, id) {
    let item = recordByType(type, id);
    if (!item) {
      status('financeiro-status', 'O cadastro selecionado não foi encontrado. Atualize os dados.', true);
      return;
    }
    if (type === 'cliente' || type === 'fornecedor') {
      status('financeiro-status', 'Carregando os dados protegidos para edição…', false);
      try {
        const result = await call('obter_' + type, { id: id });
        item = result[type] || item;
      } catch (error) {
        status('financeiro-status', error.message, true);
        return;
      }
    }
    if (type === 'cliente') {
      resetClientEdit();
      byId('financeiro-cliente-id').value = item.id;
      byId('financeiro-cliente-versao').value = versionOf(item);
      byId('financeiro-cliente-nome').value = item.nome || '';
      byId('financeiro-cliente-nascimento').value = item.data_nascimento || '';
      byId('financeiro-cliente-telefone').value = item.telefone || '';
      byId('financeiro-cliente-email').value = item.email || '';
      byId('financeiro-cliente-cpf').value = item.cpf || '';
      byId('financeiro-cliente-emergencia').value = item.telefone_emergencia || '';
      byId('financeiro-cliente-pesquisa').disabled = true;
      byId('financeiro-cliente-salvar').textContent = 'Salvar alterações';
      byId('financeiro-cliente-cancelar-edicao').classList.remove('oculto');
      byId('financeiro-editor-cliente').open = true;
      byId('financeiro-editor-cliente').scrollIntoView({ behavior: 'smooth', block: 'start' });
      byId('financeiro-cliente-nome').focus({ preventScroll: true });
      return;
    }
    resetCatalogEdit(type);
    byId('financeiro-' + type + '-id').value = item.id;
    byId('financeiro-' + type + '-versao').value = versionOf(item);
    byId('financeiro-' + type + '-titulo').textContent =
      'Editar ' + (type === 'marca' ? 'marca' : type);
    byId('financeiro-' + type + '-salvar').textContent = 'Salvar alterações';
    byId('financeiro-' + type + '-cancelar-edicao').classList.remove('oculto');
    if (type === 'fornecedor') {
      byId('financeiro-fornecedor-nome').value = item.nome || '';
      byId('financeiro-fornecedor-documento').value = item.documento || '';
      byId('financeiro-fornecedor-telefone').value = item.telefone || '';
      byId('financeiro-fornecedor-email').value = item.email || '';
    } else if (type === 'marca') {
      byId('financeiro-marca-nome').value = item.nome || '';
    } else if (type === 'produto') {
      byId('financeiro-produto-nome').value = item.nome || '';
      if (item.marca_id && !Array.from(byId('financeiro-produto-marca').options).some(function (option) {
        return option.value === item.marca_id;
      })) {
        const historicalBrand = state.catalogs.marcas.find(function (row) { return row.id === item.marca_id; });
        if (historicalBrand) byId('financeiro-produto-marca').insertAdjacentHTML('beforeend',
          '<option value="' + escapeHtml(historicalBrand.id) + '">' + escapeHtml(historicalBrand.nome) +
          ' · arquivada (restaure ou troque)</option>');
      }
      byId('financeiro-produto-marca').value = item.marca_id || '';
      byId('financeiro-produto-tipo').value = item.tipo || 'outro';
      byId('financeiro-produto-unidade').value = item.unidade || 'un';
      byId('financeiro-produto-apresentacao').value = item.apresentacao || '';
      byId('financeiro-produto-ean').value = item.ean || '';
      byId('financeiro-produto-custo').value = item.custo_referencia == null ? '' : moneyInput(item.custo_referencia);
      byId('financeiro-produto-venda').value = item.preco_venda == null ? '' : moneyInput(item.preco_venda);
      byId('financeiro-produto-anvisa').value = item.registro_anvisa || '';
      byId('financeiro-produto-estoque').checked = Boolean(item.controla_estoque);
    }
    byId('financeiro-editor-catalogo').open = true;
    byId('financeiro-editor-catalogo').scrollIntoView({ behavior: 'smooth', block: 'start' });
    byId('financeiro-' + type + '-nome').focus({ preventScroll: true });
  }

  async function changeRegistryState(type, id, action) {
    const item = recordByType(type, id);
    if (!item) return;
    const restoring = action === 'restaurar';
    const label = item.nome || 'cadastro';
    try {
      await protectedCall(action + '_' + type, {
        id: item.id,
        version: versionOf(item)
      }, {
        titulo: (restoring ? 'Restaurar ' : 'Arquivar ') + type,
        explicacao: (restoring ? 'O cadastro voltará a aparecer nas seleções ativas.' :
          'O cadastro deixará de aparecer nas novas operações, mas o histórico será preservado.') +
          ' Cadastro: ' + label + '.',
        motivo: (restoring ? 'Restauração' : 'Arquivamento') + ' solicitado pela gestão'
      });
      status('financeiro-status', label + (restoring ? ' foi restaurado.' : ' foi arquivado com auditoria.'), false);
      if (type === 'cliente' && byId('financeiro-cliente-id').value === String(id)) resetClientEdit();
      if (type !== 'cliente' && byId('financeiro-' + type + '-id').value === String(id)) resetCatalogEdit(type);
      await load({ silent: true });
    } catch (error) {
      if (!isStaleSession(error)) status('financeiro-status', error.message, true);
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
      const clientId = byId('financeiro-cliente-id').value;
      const payload = {
        nome: byId('financeiro-cliente-nome').value.trim(),
        data_nascimento: byId('financeiro-cliente-nascimento').value || null,
        telefone: byId('financeiro-cliente-telefone').value.trim() || null,
        email: byId('financeiro-cliente-email').value.trim() || null,
        cpf: digits(byId('financeiro-cliente-cpf').value) || null,
        telefone_emergencia: byId('financeiro-cliente-emergencia').value.trim() || null,
        origem: candidate ? (candidate.origem || candidate.source_kind) : null,
        origem_id: candidate ? (candidate.origem_id || candidate.source_id) : null,
        match_method: candidate ? (candidate.match_method || 'manual') : null
      };
      if (clientId) {
        payload.id = clientId;
        payload.version = Number(byId('financeiro-cliente-versao').value);
        delete payload.origem;
        delete payload.origem_id;
        delete payload.match_method;
        await protectedCall('editar_cliente', payload, {
          titulo: 'Editar cliente',
          explicacao: 'Confirme com sua senha atual a alteração dos dados de ' + payload.nome + '.',
          motivo: 'Atualização cadastral solicitada pela gestão'
        });
      } else {
        payload.idempotency_key = intentKey('cliente');
        await call('criar_cliente', payload);
      }
      clearIntent('cliente');
      resetClientEdit();
      const successMessage = clientId ? 'Dados do cliente atualizados.' :
        'Cliente salvo e exibido em Clientes cadastrados.';
      status('financeiro-cliente-status', successMessage, false);
      await load({ silent: true });
      showClientsRegistry(payload.nome, successMessage);
    } catch (error) {
      if (!isStaleSession(error)) {
        status('financeiro-cliente-status', error.message, true);
        showExactDuplicate('financeiro-cliente-status', error);
      }
    }
    finally { setBusy(form, false); }
  }

  async function saveRegistry(form, type, payload, statusId, success) {
    if (!requireValid(form)) return;
    setBusy(form, true);
    try {
      const id = byId('financeiro-' + type + '-id').value;
      if (id) {
        await protectedCall('editar_' + type, Object.assign({}, payload, {
          id: id,
          version: Number(byId('financeiro-' + type + '-versao').value)
        }), {
          titulo: 'Editar ' + type,
          explicacao: 'Confirme com sua senha atual a alteração deste cadastro.',
          motivo: 'Atualização de ' + type + ' solicitada pela gestão'
        });
      } else {
        await call('criar_' + type, Object.assign({ idempotency_key: intentKey('criar_' + type) }, payload));
      }
      clearIntent('criar_' + type);
      resetCatalogEdit(type);
      status(statusId, id ? 'Cadastro atualizado.' : success, false);
      await load({ silent: true });
    } catch (error) {
      if (!isStaleSession(error)) {
        status(statusId, error.message, true);
        showExactDuplicate(statusId, error);
      }
    }
    finally { setBusy(form, false); }
  }

  function renderCosts() {
    const box = byId('financeiro-custos-historico');
    if (!box) return;
    if (!state.costs.length) {
      box.innerHTML = '<p class="financeiro-vazio">Ainda não há custos registrados para este produto.</p>';
      return;
    }
    box.innerHTML = state.costs.map(function (item) {
      const source = [item.fornecedor_nome, item.fonte, item.condicao_pagamento].filter(Boolean).join(' · ');
      const pack = num(item.quantidade_embalagem) + ' ' + (item.unidade_embalagem || 'un');
      const cancellation = item.cancelamento || {};
      const cancelled = item.cancelado === true;
      return '<article class="financeiro-custo-item"><div><strong>' + escapeHtml(safeDate(item.data_custo)) +
        ' · total ' + escapeHtml(money(item.custo_total)) + '</strong><small>' + escapeHtml(pack +
          ' · custo unitário ' + money(item.custo_unitario) + (source ? ' · ' + source : '')) +
        '</small>' + (cancelled ? '<small>Cancelado com auditoria' +
          (cancellation.motivo ? ' · ' + escapeHtml(cancellation.motivo) : '') + '</small>' : '') +
        '</div>' + (cancelled ? '<em>Cancelado</em>' : (item.atual ? '<em>Custo atual</em>' : '')) +
        (cancelled ? '' : '<button class="perigo" type="button" data-financeiro-cancelar-custo="' +
          escapeHtml(item.id) + '">Apagar/Cancelar custo</button>') + '</article>';
    }).join('');
  }

  async function loadCosts(productId) {
    const box = byId('financeiro-custos-historico');
    state.costs = [];
    if (!productId) {
      if (box) box.innerHTML = '<p class="financeiro-vazio">Selecione um produto para consultar o histórico.</p>';
      return;
    }
    if (box) box.innerHTML = '<p class="financeiro-vazio">Carregando histórico de custos…</p>';
    try {
      const result = await call('listar_custos_produto', { produto_id: productId, por_pagina: 100 });
      state.costs = Array.isArray(result.custos) ? result.custos : [];
      renderCosts();
    } catch (error) {
      if (!isStaleSession(error) && box) box.innerHTML = '<p class="financeiro-vazio">' +
        escapeHtml(error.message) + '</p>';
    }
  }

  async function cancelProductCost(costId) {
    const cost = state.costs.find(function (item) { return String(item.id) === String(costId); });
    const productId = cost && cost.produto_id;
    const product = recordByType('produto', productId);
    if (!cost || cost.cancelado || !product) {
      status('financeiro-custo-status', 'Recarregue o histórico antes de cancelar este custo.', true);
      return;
    }
    try {
      const result = await protectedCall('cancelar_custo_produto', {
        custo_id: cost.id,
        produto_id: productId,
        version: versionOf(product)
      }, {
        titulo: 'Apagar/Cancelar custo incorreto',
        explicacao: 'O lançamento original será preservado como cancelado. Se ele for o custo atual, o sistema vai repor o último custo válido ou marcar o custo como pendente.',
        motivo: 'Cancelamento de custo lançado incorretamente pela gestão'
      });
      status('financeiro-custo-status', result.custo_substituto ?
        'Custo cancelado. A referência anterior foi recomposta por evento auditável.' :
        'Custo cancelado com auditoria. Cadastre um novo custo se a referência ficou pendente.', false);
      await load({ silent: true });
      byId('financeiro-custo-produto').value = productId;
      await loadCosts(productId);
    } catch (error) {
      if (!isStaleSession(error)) status('financeiro-custo-status', error.message, true);
    }
  }

  async function submitCost(event) {
    event.preventDefault();
    const form = event.currentTarget;
    if (!requireValid(form)) return;
    const productId = byId('financeiro-custo-produto').value;
    const product = recordByType('produto', productId);
    const quantity = Number(byId('financeiro-custo-quantidade').value);
    const total = parseMoney(byId('financeiro-custo-total').value);
    if (!product || isArchived(product)) {
      status('financeiro-custo-status', 'Selecione um produto ativo.', true);
      return;
    }
    if (!(quantity > 0) || !(total >= 0)) {
      status('financeiro-custo-status', 'Revise a quantidade e o valor total.', true);
      return;
    }
    const unitCost = Math.round((total / quantity + Number.EPSILON) * 10000) / 10000;
    setBusy(form, true);
    try {
      await protectedCall('salvar_custo_produto', {
        produto_id: productId,
        fornecedor_id: byId('financeiro-custo-fornecedor').value || null,
        fonte: byId('financeiro-custo-fonte').value.trim() || 'Registro manual',
        data_custo: byId('financeiro-custo-data').value,
        condicao_pagamento: byId('financeiro-custo-condicao').value.trim() || null,
        quantidade_embalagem: quantity,
        unidade_embalagem: byId('financeiro-custo-unidade').value,
        custo_total: total,
        custo_unitario: unitCost,
        observacoes: byId('financeiro-custo-observacoes').value.trim() || null,
        atual: byId('financeiro-custo-atual').checked,
        version: versionOf(product)
      }, {
        titulo: 'Salvar custo do produto',
        explicacao: 'O histórico será preservado. Se marcado como atual, a referência do produto será atualizada.',
        motivo: 'Registro de custo confirmado pela gestão'
      });
      form.reset();
      byId('financeiro-custo-data').value = today();
      byId('financeiro-custo-quantidade').value = '1';
      byId('financeiro-custo-atual').checked = true;
      status('financeiro-custo-status', 'Custo salvo sem apagar os preços anteriores.', false);
      await load({ silent: true });
      byId('financeiro-custo-produto').value = productId;
      await loadCosts(productId);
    } catch (error) {
      if (!isStaleSession(error)) status('financeiro-custo-status', error.message, true);
    } finally {
      setBusy(form, false);
    }
  }

  function addPurchaseItem() {
    const row = document.createElement('div');
    row.className = 'financeiro-item';
    row.innerHTML = '<label><span>Produto</span><select class="financeiro-item-produto" required>' +
      productOptions() + '</select></label><label><span>Quantidade</span><input class="financeiro-item-quantidade" type="number" min="0.0001" max="9999999999" step="0.0001" value="1" required></label>' +
      '<label><span>Valor unitário</span><input class="financeiro-item-valor" type="text" inputmode="decimal" placeholder="0,00" required></label>' +
      '<label><span>Lote <small>obrigatório quando controla estoque</small></span><input class="financeiro-item-lote" type="text" maxlength="100"></label>' +
      '<label><span>Validade <small>obrigatória quando controla estoque</small></span><input class="financeiro-item-validade" type="date"></label>' +
      '<p class="financeiro-item-estoque"></p>' +
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
    row.querySelector('.financeiro-item-produto').addEventListener('change', function () {
      syncPurchaseItem(row);
    });
    byId('financeiro-compra-itens').appendChild(row);
    clearIntent('compra');
    syncPurchaseItem(row);
    updatePurchaseTotal();
  }

  function syncPurchaseItem(row) {
    const productId = row.querySelector('.financeiro-item-produto').value;
    const product = state.catalogs.produtos.find(function (item) {
      return String(item.id) === String(productId);
    });
    const lot = row.querySelector('.financeiro-item-lote');
    const expiry = row.querySelector('.financeiro-item-validade');
    const hint = row.querySelector('.financeiro-item-estoque');
    const controlled = Boolean(product && product.controla_estoque);
    lot.required = controlled;
    expiry.required = controlled;
    if (!product) {
      hint.textContent = '';
      return;
    }
    const lots = inventoryForProduct(product.id);
    const balance = lots.reduce(function (sum, item) { return sum + num(item.saldo); }, 0);
    hint.textContent = controlled
      ? 'Unidade canônica: ' + (product.unidade || '—') + '. Saldo atual: ' + balance +
        ' em ' + lots.length + ' lote(s). Esta compra criará uma entrada.'
      : 'Produto sem controle automático de estoque; lote e validade são opcionais.';
    const value = row.querySelector('.financeiro-item-valor');
    if (!value.value && product.custo_referencia != null) {
      value.value = moneyInput(product.custo_referencia);
    }
  }

  function purchaseItems() {
    return Array.from(document.querySelectorAll('.financeiro-item')).map(function (row) {
      return {
        produto_id: row.querySelector('.financeiro-item-produto').value,
        quantidade: Number(row.querySelector('.financeiro-item-quantidade').value),
        valor_unitario: parseMoney(row.querySelector('.financeiro-item-valor').value),
        lote: row.querySelector('.financeiro-item-lote').value.trim() || null,
        validade: row.querySelector('.financeiro-item-validade').value || null
      };
    });
  }

  function updatePurchaseTotal() {
    const subtotal = purchaseItems().reduce(function (sum, item) {
      return sum + (Number.isFinite(item.quantidade) && Number.isFinite(item.valor_unitario)
        ? roundMoney(item.quantidade * item.valor_unitario) : 0);
    }, 0);
    const parsedFreight = parseMoney(byId('financeiro-compra-frete').value || '0');
    const freight = Number.isFinite(parsedFreight) && parsedFreight >= 0 ? parsedFreight : 0;
    byId('financeiro-compra-subtotal').textContent = money(subtotal);
    byId('financeiro-compra-frete-resumo').textContent = money(freight);
    byId('financeiro-compra-total').textContent = money(roundMoney(subtotal + freight));
  }

  function syncPurchaseForm() {
    const condition = byId('financeiro-compra-condicao').value;
    const installments = byId('financeiro-compra-parcelas');
    const cash = condition === 'avista';
    installments.min = cash ? '1' : '2';
    installments.readOnly = cash;
    if (cash) installments.value = '1';
    else if (!Number.isInteger(Number(installments.value)) || Number(installments.value) < 2) {
      installments.value = '2';
    }
  }

  function removePurchaseDuplicateNotice() {
    const form = byId('financeiro-form-compra');
    removeNode(form && form.querySelector('[data-financeiro-compra-duplicata]'));
  }

  async function openExistingPurchase(id) {
    let entry = state.entries.find(function (item) {
      return item.compra && String(item.compra.id) === String(id);
    });
    if (!entry) {
      await load({ silent: true });
      entry = state.entries.find(function (item) {
        return item.compra && String(item.compra.id) === String(id);
      });
    }
    if (entry) {
      openEntryView('despesas');
      const card = document.querySelector('[data-financeiro-entry-card="' + String(entry.id) + '"]');
      if (card) {
        const details = card.querySelector('.financeiro-lancamento-detalhes');
        if (details) details.open = true;
        card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      return;
    }
    try {
      const result = await call('obter_compra', { compra_id: id });
      const purchase = result.compra || {};
      status('financeiro-compra-status', 'Compra existente: ' + safeDate(purchase.data_compra) +
        ' · subtotal ' + money(purchase.subtotal_itens) + ' · frete ' + money(purchase.valor_frete) +
        ' · total ' + money(purchase.total) + '.', false);
    } catch (error) {
      if (!isStaleSession(error)) status('financeiro-compra-status', error.message, true);
    }
  }

  async function completePurchaseSave(form) {
    clearIntent('compra');
    removePurchaseDuplicateNotice();
    form.reset();
    byId('financeiro-compra-itens').innerHTML = '';
    byId('financeiro-compra-categoria').value = 'Produtos e insumos';
    byId('financeiro-compra-parcelas').value = '1';
    byId('financeiro-compra-data').value = today();
    syncPurchaseForm();
    addPurchaseItem();
    status('financeiro-compra-status', 'Compra e despesa vinculada foram salvas.', false);
    await load({ silent: true });
  }

  function showPurchaseDuplicate(error, payload, form) {
    const details = error && error.data;
    const candidate = details && details.candidato;
    const existingId = details && (details.existing_id || (candidate && candidate.id));
    const possible = details && details.correspondencia === 'possivel';
    if (!existingId || !candidate || !['purchase_exact_duplicate', 'purchase_possible_duplicate'].includes(error.code)) {
      return false;
    }
    removePurchaseDuplicateNotice();
    const box = document.createElement('div');
    box.className = 'financeiro-nota';
    box.setAttribute('data-financeiro-compra-duplicata', '');
    const itemLabels = Array.isArray(candidate.itens) ? candidate.itens.map(function (item) {
      return (item.produto || 'Produto') + ' × ' + num(item.quantidade);
    }).join(', ') : '';
    box.innerHTML = '<strong>' + (possible ? 'Possível compra repetida.' : 'Compra já cadastrada.') + '</strong>' +
      '<p>' + escapeHtml((candidate.fornecedor || 'Fornecedor') + ' · ' + safeDate(candidate.data_compra) +
        (candidate.numero_documento ? ' · documento ' + candidate.numero_documento : '') +
        ' · subtotal ' + money(candidate.subtotal_itens) + ' · frete ' + money(candidate.valor_frete) +
        ' · total ' + money(candidate.total)) + '</p>' +
      (itemLabels ? '<small>' + escapeHtml(itemLabels) + '</small>' : '') +
      '<div class="financeiro-lancamento-acoes"><button type="button" data-financeiro-abrir-compra-existente>Abrir existente</button>' +
      (possible ? '<button type="button" data-financeiro-confirmar-compra-distinta>Confirmar compra distinta com senha</button>' : '') +
      '</div>';
    byId('financeiro-compra-status').insertAdjacentElement('afterend', box);
    box.querySelector('[data-financeiro-abrir-compra-existente]').addEventListener('click', function () {
      openExistingPurchase(existingId);
    });
    const confirmButton = box.querySelector('[data-financeiro-confirmar-compra-distinta]');
    if (confirmButton) confirmButton.addEventListener('click', async function () {
      setBusy(form, true);
      confirmButton.disabled = true;
      try {
        await protectedCall('criar_compra', Object.assign({}, payload, {
          confirmar_compra_distinta: true,
          compra_duplicada_id: existingId
        }), {
          titulo: 'Confirmar compra distinta',
          explicacao: 'Os valores e itens coincidem com uma compra sem documento. Confirme apenas se esta é outra compra legítima.',
          motivo: 'Compra legítima distinta conferida pela gestão',
          campoMotivoPayload: 'motivo_duplicidade'
        });
        await completePurchaseSave(form);
      } catch (retryError) {
        if (!isStaleSession(retryError)) {
          status('financeiro-compra-status', retryError.message, true);
          showPurchaseDuplicate(retryError, payload, form);
        }
      } finally {
        setBusy(form, false);
      }
    });
    return true;
  }

  async function submitPurchase(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const condition = byId('financeiro-compra-condicao').value;
    const installments = Number(byId('financeiro-compra-parcelas').value);
    const termsAreValid = Number.isInteger(installments) && installments >= 1 && installments <= 120 &&
      ((condition === 'avista' && installments === 1) ||
        (['parcelado', 'entrada_saldo'].includes(condition) && installments >= 2));
    if (!termsAreValid) {
      status('financeiro-compra-status', condition === 'avista'
        ? 'Uma compra à vista deve ter exatamente 1 parcela.'
        : 'Compra parcelada ou com entrada e saldo deve ter pelo menos 2 parcelas.', true);
      byId('financeiro-compra-parcelas').focus();
      return;
    }
    if (!requireValid(form)) return;
    const items = purchaseItems();
    if (!items.length || items.some(function (item) {
      const product = state.catalogs.produtos.find(function (candidate) {
        return String(candidate.id) === String(item.produto_id);
      });
      return !item.produto_id || !(item.quantidade > 0) || !(item.valor_unitario >= 0) ||
        (product && product.controla_estoque && (!item.lote || !item.validade));
    })) { status('financeiro-compra-status', 'Revise produtos, quantidades, valores, lotes e validades.', true); return; }
    const freight = parseMoney(byId('financeiro-compra-frete').value || '0');
    if (!(freight >= 0)) {
      status('financeiro-compra-status', 'Revise o valor do frete.', true);
      byId('financeiro-compra-frete').focus();
      return;
    }
    setBusy(form, true);
    removePurchaseDuplicateNotice();
    const payload = {
      fornecedor_id: byId('financeiro-compra-fornecedor').value,
      data_compra: byId('financeiro-compra-data').value,
      numero_documento: byId('financeiro-compra-nota').value.trim() || null,
      condicao_pagamento: condition,
      parcelas: installments,
      categoria: byId('financeiro-compra-categoria').value.trim(),
      valor_frete: freight,
      observacoes: byId('financeiro-compra-observacoes').value.trim() || null,
      itens: items,
      idempotency_key: intentKey('compra')
    };
    try {
      await call('criar_compra', payload);
      await completePurchaseSave(form);
    } catch (error) {
      if (!isStaleSession(error)) {
        status('financeiro-compra-status', error.message, true);
        showPurchaseDuplicate(error, payload, form);
      }
    }
    finally { setBusy(form, false); }
  }

  async function cancelEntry(id) {
    const entry = state.entries.find(function (item) { return String(item.id) === String(id); });
    try {
      const intent = 'cancelar:' + id;
      if (entryOrigin(entry || {}) === 'compra') {
        const purchaseResult = await call('obter_compra', { lancamento_id: id });
        const purchase = purchaseResult.compra;
        if (!purchase) throw new Error('A compra ligada a este lançamento não foi encontrada.');
        await protectedCall('cancelar_compra', {
          lancamento_id: id,
          version: versionOf(purchase)
        }, {
          titulo: 'Cancelar compra',
          explicacao: 'A compra, as parcelas e o lançamento financeiro serão cancelados em conjunto. Os itens e a auditoria serão preservados.',
          motivo: 'Cancelamento de compra solicitado pela gestão'
        });
      } else {
        await protectedCall('cancelar_lancamento', {
          entry_id: id,
          idempotency_key: intentKey(intent)
        }, {
          titulo: 'Cancelar lançamento',
          explicacao: 'O lançamento “' + (entryDescription(entry || {}) || 'selecionado') +
            '” será cancelado, sem apagar a auditoria.',
          motivo: 'Cancelamento de lançamento solicitado pela gestão'
        });
      }
      clearIntent(intent);
      status('financeiro-status', entryOrigin(entry || {}) === 'compra' ?
        'Compra e movimentações vinculadas canceladas com auditoria.' : 'Lançamento cancelado com auditoria.', false);
      await load({ silent: true });
    } catch (error) { if (!isStaleSession(error)) status('financeiro-status', error.message, true); }
  }

  async function reversePayment(button) {
    const max = Number(button.dataset.financeiroMax);
    const raw = window.prompt('Valor a estornar (máximo ' + money(max) + '):', String(max).replace('.', ','));
    if (raw === null) return;
    const amount = parseMoney(raw);
    if (!(amount > 0) || amount > max) { status('financeiro-status', 'Valor de estorno inválido.', true); return; }
    try {
      await protectedCall('estornar_pagamento', {
        entry_id: button.dataset.financeiroEntry,
        pagamento_id: button.dataset.financeiroEstornar,
        forma_pagamento: button.dataset.financeiroForma,
        valor: amount,
        idempotency_key: intentKey('estorno:' + button.dataset.financeiroEstornar + ':' + amount)
      }, {
        titulo: 'Estornar pagamento',
        explicacao: 'Será registrado um estorno de ' + money(amount) + ' ligado ao pagamento original.',
        motivo: 'Estorno de pagamento solicitado pela gestão'
      });
      clearIntent('estorno:' + button.dataset.financeiroEstornar + ':' + amount);
      status('financeiro-status', 'Estorno registrado e ligado ao pagamento original.', false);
      await load({ silent: true });
    } catch (error) { if (!isStaleSession(error)) status('financeiro-status', error.message, true); }
  }

  function setInitialDates() {
    const date = today();
    byId('financeiro-atendimento-data').value = date;
    byId('financeiro-lancamento-competencia').value = date;
    byId('financeiro-lancamento-vencimento').value = date;
    byId('financeiro-compra-data').value = date;
    byId('financeiro-custo-data').value = date;
    byId('financeiro-pagamento-data').value = isoLocalNow();
  }

  function bind() {
    ensureProductIdentityFields();
    ensureDuplicateReviewPanel();
    setInitialDates();
    syncServiceForm();
    syncEntryForm();
    syncPaymentEntry();
    syncInstallmentEditor();
    syncPurchaseForm();
    addPurchaseItem();
    byId('financeiro-atualizar').addEventListener('click', function () { load(); });
    byId('financeiro-duplicidades-atualizar').addEventListener('click', function () {
      loadDuplicateReviews();
    });
    byId('financeiro-duplicidades-status').addEventListener('change', function () {
      loadDuplicateReviews();
    });
    byId('financeiro-duplicidades-lista').addEventListener('click', function (event) {
      const open = event.target.closest('[data-financeiro-duplicidade-abrir]');
      const resolve = event.target.closest('[data-financeiro-duplicidade-resolver]');
      if (open) openExistingRegistration(open.dataset.tipo, open.dataset.id);
      else if (resolve) resolveDuplicateReview(resolve);
    });
    document.querySelectorAll('[data-financeiro-abrir]').forEach(function (button) {
      button.addEventListener('click', function () {
        const details = byId(button.dataset.financeiroAbrir);
        details.open = true;
        details.scrollIntoView({ behavior: 'smooth', block: 'start' });
        const focusable = details.querySelector('input:not([type=hidden]),select,button');
        if (focusable) focusable.focus({ preventScroll: true });
      });
    });
    const viewClients = document.querySelector('[data-financeiro-ver-clientes]');
    if (viewClients) viewClients.addEventListener('click', function () {
      showClientsRegistry('', 'Clientes cadastrados carregados. Use a busca para localizar um cadastro.');
    });
    byId('financeiro-lancamento-tipo').addEventListener('change', syncEntryForm);
    byId('financeiro-lancamento-origem').addEventListener('change', syncEntryForm);
    byId('financeiro-atendimento-procedimento').addEventListener('change', syncServiceForm);
    byId('financeiro-atendimento-situacao').addEventListener('change', syncServiceForm);
    ['financeiro-atendimento-valor', 'financeiro-atendimento-valor-recebido',
      'financeiro-atendimento-parcelas', 'financeiro-atendimento-data'].forEach(function (id) {
      byId(id).addEventListener('input', syncServiceForm);
      byId(id).addEventListener('change', syncServiceForm);
    });
    byId('financeiro-form-atendimento').addEventListener('submit', submitService);
    byId('financeiro-form-lancamento').addEventListener('submit', submitEntry);
    byId('financeiro-form-pagamento').addEventListener('submit', submitPayment);
    byId('financeiro-form-parcelas').addEventListener('submit', submitInstallmentSchedule);
    byId('financeiro-form-cliente').addEventListener('submit', submitClient);
    resetIntentOnEdit(byId('financeiro-form-atendimento'), 'atendimento');
    resetIntentOnEdit(byId('financeiro-form-atendimento'), 'atendimento_pagamento');
    resetIntentOnEdit(byId('financeiro-form-lancamento'), 'lancamento');
    resetIntentOnEdit(byId('financeiro-form-pagamento'), 'pagamento');
    resetIntentOnEdit(byId('financeiro-form-parcelas'), 'parcelas');
    resetIntentOnEdit(byId('financeiro-form-cliente'), 'cliente');
    resetIntentOnEdit(byId('financeiro-form-compra'), 'compra');
    byId('financeiro-form-compra').addEventListener('input', removePurchaseDuplicateNotice);
    byId('financeiro-form-compra').addEventListener('change', removePurchaseDuplicateNotice);
    resetIntentOnEdit(byId('financeiro-form-fornecedor'), 'criar_fornecedor');
    resetIntentOnEdit(byId('financeiro-form-marca'), 'criar_marca');
    resetIntentOnEdit(byId('financeiro-form-produto'), 'criar_produto');
    byId('financeiro-cliente-cancelar-edicao').addEventListener('click', resetClientEdit);
    ['fornecedor', 'marca', 'produto'].forEach(function (type) {
      byId('financeiro-' + type + '-cancelar-edicao').addEventListener('click', function () {
        resetCatalogEdit(type);
      });
    });
    byId('financeiro-cliente-pesquisa').addEventListener('input', function () {
      clearSelectedCandidate('A origem selecionada foi removida porque uma nova pesquisa foi iniciada.');
      clearTimeout(state.searchTimer);
      state.searchTimer = setTimeout(searchCandidates, 450);
    });
    ['financeiro-cliente-nome', 'financeiro-cliente-nascimento', 'financeiro-cliente-telefone',
      'financeiro-cliente-email', 'financeiro-cliente-cpf', 'financeiro-cliente-emergencia'].forEach(function (id) {
      byId(id).addEventListener('input', function () {
        markCandidateForReconfirmation();
      });
    });
    ['financeiro-clientes-busca', 'financeiro-fornecedores-busca', 'financeiro-produtos-busca',
      'financeiro-marcas-busca']
      .forEach(function (id) { byId(id).addEventListener('input', renderRegistries); });
    byId('financeiro-mostrar-arquivados').addEventListener('change', renderRegistries);
    byId('financeiro-cadastros-titulo').closest('.financeiro-cadastros-card').addEventListener('click', function (event) {
      const edit = event.target.closest('[data-financeiro-editar]');
      const stateButton = event.target.closest('[data-financeiro-registro-acao]');
      const cost = event.target.closest('[data-financeiro-custo]');
      const protocol = event.target.closest('[data-financeiro-prontuario]');
      if (edit) {
        beginRegistryEdit(edit.dataset.financeiroEditar, edit.dataset.financeiroId);
      } else if (stateButton) {
        changeRegistryState(stateButton.dataset.financeiroEntidade, stateButton.dataset.financeiroId,
          stateButton.dataset.financeiroRegistroAcao);
      } else if (cost) {
        const productId = cost.dataset.financeiroCusto;
        byId('financeiro-editor-catalogo').open = true;
        byId('financeiro-custo-produto').value = productId;
        byId('financeiro-form-custo-produto').scrollIntoView({ behavior: 'smooth', block: 'start' });
        loadCosts(productId);
      } else if (protocol && window.AMJProntuario && typeof window.AMJProntuario.novoParaPaciente === 'function') {
        window.AMJProntuario.novoParaPaciente(protocol.dataset.financeiroProntuario);
      }
    });
    byId('financeiro-clientes-lista').addEventListener('click', function (event) {
      const button = event.target.closest('[data-financeiro-atender]');
      if (!button) return;
      byId('financeiro-atendimento-cliente').value = button.dataset.financeiroAtender;
      byId('financeiro-editor-atendimento').open = true;
      byId('financeiro-editor-atendimento').scrollIntoView({ behavior: 'smooth', block: 'start' });
      byId('financeiro-atendimento-procedimento').focus({ preventScroll: true });
    });
    byId('financeiro-fornecedores-lista').addEventListener('click', function (event) {
      const button = event.target.closest('[data-financeiro-comprar]');
      if (!button) return;
      byId('financeiro-compra-fornecedor').value = button.dataset.financeiroComprar;
      byId('financeiro-editor-compra').open = true;
      byId('financeiro-editor-compra').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    byId('financeiro-form-fornecedor').addEventListener('submit', function (event) {
      event.preventDefault();
      saveRegistry(event.currentTarget, 'fornecedor', {
        nome: byId('financeiro-fornecedor-nome').value.trim(),
        documento: digits(byId('financeiro-fornecedor-documento').value) || null,
        telefone: byId('financeiro-fornecedor-telefone').value.trim() || null,
        email: byId('financeiro-fornecedor-email').value.trim() || null
      }, 'financeiro-fornecedor-status', 'Fornecedor salvo.');
    });
    byId('financeiro-form-marca').addEventListener('submit', function (event) {
      event.preventDefault();
      saveRegistry(event.currentTarget, 'marca', {
        nome: byId('financeiro-marca-nome').value.trim()
      }, 'financeiro-marca-status', 'Marca salva.');
    });
    byId('financeiro-form-produto').addEventListener('submit', function (event) {
      event.preventDefault();
      const costField = byId('financeiro-produto-custo');
      const saleField = byId('financeiro-produto-venda');
      const rawCost = costField.value.trim();
      const rawSale = saleField.value.trim();
      const cost = parseMoney(rawCost);
      const sale = parseMoney(rawSale);
      if (rawCost && !Number.isFinite(cost)) {
        status('financeiro-produto-status', 'Informe o custo com no máximo duas casas decimais.', true);
        costField.focus();
        return;
      }
      if (rawSale && !Number.isFinite(sale)) {
        status('financeiro-produto-status', 'Informe o preço de venda com no máximo duas casas decimais.', true);
        saleField.focus();
        return;
      }
      saveRegistry(event.currentTarget, 'produto', {
        nome: byId('financeiro-produto-nome').value.trim(),
        marca_id: byId('financeiro-produto-marca').value || null,
        tipo: byId('financeiro-produto-tipo').value,
        unidade: byId('financeiro-produto-unidade').value,
        apresentacao: byId('financeiro-produto-apresentacao').value.trim(),
        ean: digits(byId('financeiro-produto-ean').value) || null,
        custo_referencia: Number.isFinite(cost) ? cost : null,
        preco_venda: Number.isFinite(sale) ? sale : null,
        registro_anvisa: byId('financeiro-produto-anvisa').value.trim() || null,
        controla_estoque: byId('financeiro-produto-estoque').checked
      }, 'financeiro-produto-status', 'Produto salvo.');
    });
    byId('financeiro-form-custo-produto').addEventListener('submit', submitCost);
    byId('financeiro-custos-historico').addEventListener('click', function (event) {
      const button = event.target.closest('[data-financeiro-cancelar-custo]');
      if (button) cancelProductCost(button.dataset.financeiroCancelarCusto);
    });
    byId('financeiro-custo-produto').addEventListener('change', function () {
      loadCosts(byId('financeiro-custo-produto').value);
    });
    byId('financeiro-adicionar-item').addEventListener('click', addPurchaseItem);
    byId('financeiro-compra-condicao').addEventListener('change', syncPurchaseForm);
    byId('financeiro-compra-frete').addEventListener('input', updatePurchaseTotal);
    byId('financeiro-form-compra').addEventListener('submit', submitPurchase);
    byId('financeiro-pendencias-estoque').addEventListener('submit', function (event) {
      const form = event.target.closest('[data-financeiro-regularizar]');
      if (!form) return;
      event.preventDefault();
      regularizePendingStock(form);
    });
    byId('financeiro-pagamento-lancamento').addEventListener('change', function () { syncPaymentEntry(); });
    byId('financeiro-pagamento-parcela').addEventListener('change', syncPaymentSelection);
    byId('financeiro-pagamento-forma').addEventListener('change', syncPaymentForm);
    byId('financeiro-parcelas-lancamento').addEventListener('change', syncInstallmentEditor);
    byId('financeiro-parcelas-quantidade').addEventListener('input', syncInstallmentEditor);
    byId('financeiro-parcelas-quantidade').addEventListener('change', syncInstallmentEditor);
    byId('financeiro-filtro-tipo').addEventListener('change', renderEntries);
    byId('financeiro-filtro-status').addEventListener('change', renderEntries);
    byId('financeiro-lista').addEventListener('click', function (event) {
      const payment = event.target.closest('[data-financeiro-pagar]');
      const installmentPayment = event.target.closest('[data-financeiro-pagar-parcela]');
      const schedule = event.target.closest('[data-financeiro-programar-parcelas]');
      const cancel = event.target.closest('[data-financeiro-cancelar]');
      const reversal = event.target.closest('[data-financeiro-estornar]');
      const print = event.target.closest('[data-financeiro-imprimir]');
      const procedure = event.target.closest('[data-financeiro-abrir-procedimentos]');
      if (installmentPayment) {
        byId('financeiro-pagamento-lancamento').value = installmentPayment.dataset.financeiroParcelaEntry;
        syncPaymentEntry(installmentPayment.dataset.financeiroPagarParcela);
        byId('financeiro-editor-pagamento').open = true;
        byId('financeiro-editor-pagamento').scrollIntoView({ behavior: 'smooth', block: 'start' });
        byId('financeiro-pagamento-data').focus({ preventScroll: true });
      } else if (schedule) {
        byId('financeiro-parcelas-lancamento').value = schedule.dataset.financeiroProgramarParcelas;
        syncInstallmentEditor();
        byId('financeiro-editor-parcelas').open = true;
        byId('financeiro-editor-parcelas').scrollIntoView({ behavior: 'smooth', block: 'start' });
      } else if (payment) {
        byId('financeiro-pagamento-lancamento').value = payment.dataset.financeiroPagar;
        syncPaymentEntry();
        byId('financeiro-editor-pagamento').open = true;
        byId('financeiro-editor-pagamento').scrollIntoView({ behavior: 'smooth', block: 'start' });
      } else if (print) {
        openAdministrativePrint(state.entries.find(function (entry) {
          return String(entry.id) === String(print.dataset.financeiroImprimir);
        }));
      } else if (procedure) {
        const root = byId('operacao-clinica-root');
        if (window.AMJOperacaoClinica && typeof window.AMJOperacaoClinica.carregar === 'function') {
          window.AMJOperacaoClinica.carregar();
        }
        if (root) root.scrollIntoView({ behavior: 'smooth', block: 'start' });
        else status('financeiro-status', 'A gestão integrada de procedimentos ainda não está montada nesta tela.', true);
      } else if (cancel) cancelEntry(cancel.dataset.financeiroCancelar);
      else if (reversal) reversePayment(reversal);
    });
    updateAccess();
  }

  window.AMJFinanceiro = {
    ativar: activate,
    atualizarAcesso: updateAccess,
    reset: reset,
    carregar: load,
    abrirCadastro: openExistingRegistration,
    abrirVisao: openEntryView
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind, { once: true });
  else setTimeout(bind, 0);
})();

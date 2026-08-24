(function () {
  'use strict';

  const API = 'https://rjxtxoqprnumouqakxbc.supabase.co/functions/v1/cotacoes-fichas';
  const MONEY = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
  const DATE = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeZone: 'America/Sao_Paulo' });
  const state = {
    root: null,
    loaded: false,
    loading: false,
    page: 1,
    pageSize: 25,
    totalPages: 1,
    total: 0,
    quotes: [],
    sources: [],
    statistics: [],
    generation: 0,
    controller: null
  };

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }
  function accessAllowed() {
    try {
      return typeof modoAcesso !== 'undefined' && modoAcesso === 'auth' &&
        typeof identidadeBackend !== 'undefined' && identidadeBackend &&
        String(identidadeBackend.role || '').toLowerCase() === 'owner';
    } catch (_) { return false; }
  }
  function byId(id) { return state.root && state.root.querySelector('#' + id); }
  function money(value) {
    const amount = Number(value);
    return Number.isFinite(amount) ? MONEY.format(amount) : '—';
  }
  function date(value) {
    if (!value) return '—';
    const parsed = new Date(/^\d{4}-\d{2}-\d{2}$/.test(String(value))
      ? String(value) + 'T12:00:00-03:00' : String(value));
    return Number.isFinite(parsed.getTime()) ? DATE.format(parsed) : '—';
  }
  function text(value, fallback) {
    const normalized = String(value == null ? '' : value).trim();
    return normalized || (fallback || '—');
  }
  function setStatus(message, error) {
    const node = byId('cotacoes-status');
    if (!node) return;
    node.textContent = message || '';
    node.classList.toggle('erro', Boolean(error));
  }
  function setBusy(busy) {
    state.loading = Boolean(busy);
    if (!state.root) return;
    state.root.setAttribute('aria-busy', String(state.loading));
    state.root.querySelectorAll('button,input,select').forEach(function (control) {
      if (state.loading) {
        control.dataset.cotacoesWasDisabled = control.disabled ? '1' : '0';
        control.disabled = true;
      } else if (control.dataset.cotacoesWasDisabled) {
        control.disabled = control.dataset.cotacoesWasDisabled === '1';
        delete control.dataset.cotacoesWasDisabled;
      }
    });
  }

  function shell() {
    return '<section class="cotacoes-shell" aria-labelledby="cotacoes-titulo">' +
      '<header class="cotacoes-cabecalho"><div><p class="cotacoes-sobretitulo">AMJ · inteligência de compras</p>' +
      '<h2 id="cotacoes-titulo">Cotações e preços de referência</h2>' +
      '<p>Consulte todas as linhas recebidas e revise, com confirmação segura, a identidade exata de cada SKU.</p></div>' +
      '<button type="button" data-cotacoes-atualizar>Atualizar</button></header>' +
      '<aside class="cotacoes-regra" aria-label="Regra de segurança dos preços"><strong>Somente referência de mercado</strong>' +
      '<span>Uma cotação nunca altera o custo real do lote, o frete, o estoque nem o preço de venda. Esses valores continuam nas fontes oficiais do Financeiro.</span></aside>' +
      '<form id="cotacoes-filtros" class="cotacoes-filtros" role="search">' +
      '<label class="cotacoes-busca">Buscar<input name="busca" type="search" maxlength="120" ' +
      'placeholder="Produto, marca, código, apresentação ou fonte"></label>' +
      '<label>Fonte<select name="fonte_id" id="cotacoes-fonte"><option value="">Todas as fontes</option></select></label>' +
      '<label>Situação<select name="status"><option value="todos">Todas</option>' +
      '<option value="pendente_revisao">Pendente de revisão</option><option value="aprovado_exato">SKU exato aprovado</option>' +
      '<option value="conflito">Conflito na fonte</option><option value="rejeitado">Rejeitado</option></select></label>' +
      '<label>Desde<input name="data_inicio" type="date"></label><label>Até<input name="data_fim" type="date"></label>' +
      '<label>Por página<select name="por_pagina"><option value="25">25</option><option value="50">50</option>' +
      '<option value="100">100</option></select></label>' +
      '<div class="cotacoes-filtro-acoes"><button type="submit">Aplicar filtros</button>' +
      '<button type="reset" class="secundario">Limpar</button></div></form>' +
      '<p id="cotacoes-status" class="cotacoes-status" role="status" aria-live="polite"></p>' +
      '<div id="cotacoes-resumo" class="cotacoes-resumo"></div>' +
      '<section class="cotacoes-bloco" aria-labelledby="cotacoes-estatisticas-titulo">' +
      '<header><div><h3 id="cotacoes-estatisticas-titulo">Referências estatísticas por SKU exato</h3>' +
      '<p>Mínimo, máximo, média, mediana e preço mais recente usam somente SKU exato aprovado e evidência verificada. São valores totais da embalagem.</p></div></header>' +
      '<div id="cotacoes-estatisticas" class="cotacoes-estatisticas"></div></section>' +
      '<section class="cotacoes-bloco" aria-labelledby="cotacoes-evidencias-titulo">' +
      '<header><div><h3 id="cotacoes-evidencias-titulo">Linhas das tabelas recebidas</h3>' +
      '<p id="cotacoes-contagem">Nenhuma consulta realizada.</p></div></header>' +
      '<div id="cotacoes-lista" class="cotacoes-tabela-wrap" aria-live="polite"></div>' +
      '<nav id="cotacoes-paginacao" class="cotacoes-paginacao" aria-label="Paginação das cotações"></nav></section>' +
      '</section>';
  }

  async function call(action, payload, passwordProof) {
    if (!accessAllowed()) {
      throw new Error('Entre com a conta proprietária e confirme o autenticador.');
    }
    if (typeof cabecalhosAcesso !== 'function') {
      throw new Error('O componente de acesso seguro não foi carregado.');
    }
    const generation = state.generation;
    if (state.controller) state.controller.abort();
    const controller = new AbortController();
    state.controller = controller;
    try {
      const headers = await cabecalhosAcesso(true, passwordProof || null);
      const response = await fetch(API, {
        method: 'POST', headers: headers, cache: 'no-store', referrerPolicy: 'no-referrer',
        signal: controller.signal,
        body: JSON.stringify(Object.assign({}, payload || {}, { acao: action }))
      });
      let data = {};
      try { data = await response.json(); } catch (_) { data = {}; }
      if (generation !== state.generation) throw new Error('Sessão de cotações encerrada.');
      if (!response.ok || data.erro) {
        const error = new Error(data.erro || 'Não foi possível consultar as cotações.');
        error.code = data.codigo || String(response.status);
        throw error;
      }
      if (data.identity && typeof atualizarIdentidade === 'function') atualizarIdentidade(data);
      return data;
    } finally {
      if (state.controller === controller) state.controller = null;
    }
  }

  function filterPayload() {
    const form = byId('cotacoes-filtros');
    const data = new FormData(form);
    return {
      busca: String(data.get('busca') || '').trim() || null,
      fonte_id: String(data.get('fonte_id') || '') || null,
      status: String(data.get('status') || 'todos'),
      data_inicio: String(data.get('data_inicio') || '') || null,
      data_fim: String(data.get('data_fim') || '') || null,
      pagina: state.page,
      por_pagina: Number(data.get('por_pagina')) || state.pageSize
    };
  }

  function reviewMeta(row) {
    if (row.has_source_conflict || row.review_status === 'conflito') {
      return { label: 'Conflito na fonte', tone: 'conflito' };
    }
    if (row.review_status === 'aprovado_exato' && row.exact_match_eligible && row.exact_sku_key) {
      return { label: 'SKU exato aprovado', tone: 'exato' };
    }
    if (row.review_status === 'rejeitado' || row.extraction_status === 'rejeitado') {
      return { label: 'Rejeitado', tone: 'rejeitado' };
    }
    return { label: 'Pendente de revisão', tone: 'pendente' };
  }

  function renderSources() {
    const select = byId('cotacoes-fonte');
    if (!select) return;
    const current = select.value;
    select.innerHTML = '<option value="">Todas as fontes</option>' + state.sources.map(function (source) {
      const label = text(source.source_name) + (source.source_date ? ' · ' + date(source.source_date) : '');
      return '<option value="' + escapeHtml(source.id) + '">' + escapeHtml(label) + '</option>';
    }).join('');
    if (state.sources.some(function (source) { return String(source.id) === current; })) select.value = current;
  }

  function renderSummary() {
    const node = byId('cotacoes-resumo');
    if (!node) return;
    const exact = new Set(state.quotes.filter(function (row) {
      return row.review_status === 'aprovado_exato' && row.exact_match_eligible && row.exact_sku_key;
    }).map(function (row) { return row.item_id; })).size;
    const pending = new Set(state.quotes.filter(function (row) {
      return reviewMeta(row).tone === 'pendente';
    }).map(function (row) { return row.item_id; })).size;
    const conflicts = new Set(state.quotes.filter(function (row) {
      return reviewMeta(row).tone === 'conflito';
    }).map(function (row) { return row.item_id; })).size;
    node.innerHTML = '<article><span>Total encontrado</span><strong>' + escapeHtml(state.total) + '</strong><small>linhas nas fontes</small></article>' +
      '<article><span>Nesta página</span><strong>' + escapeHtml(state.quotes.length) + '</strong><small>todas as situações</small></article>' +
      '<article class="exato"><span>SKU exato aprovado</span><strong>' + escapeHtml(exact) + '</strong><small>identidade(s) na página</small></article>' +
      '<article class="pendente"><span>A conferir</span><strong>' + escapeHtml(pending + conflicts) + '</strong><small>' +
      escapeHtml(pending) + ' pendente(s) · ' + escapeHtml(conflicts) + ' conflito(s)</small></article>';
  }

  function identityLabel(row) {
    return [row.brand, row.item_name, row.concentration, row.presentation].filter(Boolean).join(' · ');
  }

  function renderStatistics() {
    const node = byId('cotacoes-estatisticas');
    if (!node) return;
    if (!state.statistics.length) {
      node.innerHTML = '<p class="cotacoes-vazio"><strong>Nenhuma média disponível para esta busca.</strong>' +
        '<span>Itens pendentes aparecem abaixo, mas nenhuma linha entra no cálculo antes da aprovação manual da identidade exata.</span></p>';
      return;
    }
    node.innerHTML = state.statistics.map(function (row) {
      const period = date(row.period_start) + ' a ' + date(row.period_end);
      const normalizedUnit = row.reference_average_unit_price == null ? '' :
        '<p class="cotacoes-preco-unitario"><strong>Referência unitária normalizada: ' +
        money(row.reference_average_unit_price) + '</strong><span>por ' +
        escapeHtml(text(row.package_unit, 'unidade da embalagem')) + '</span></p>';
      const cost = row.authoritative_unit_cost == null ? '' :
        '<p class="cotacoes-custo-real"><strong>Custo real atual: ' + money(row.authoritative_unit_cost) + '</strong>' +
        '<span>por ' + escapeHtml(text(row.authoritative_cost_package_unit, 'unidade cadastrada')) +
        ' · informativo; esta tela não o altera.</span></p>';
      const comparison = row.comparison_status === 'comparavel' &&
          row.average_minus_authoritative_cost != null && row.difference_percent != null
        ? '<p class="cotacoes-comparacao"><strong>Diferença matemática: ' +
          money(row.average_minus_authoritative_cost) + ' · ' +
          escapeHtml(Number(row.difference_percent).toLocaleString('pt-BR', { maximumFractionDigits: 2 })) +
          '%</strong><span>Referência unitária média menos custo real; não é margem de venda.</span></p>'
        : '';
      const comparisonUnavailable = row.comparison_status && row.comparison_status !== 'comparavel'
        ? '<p class="cotacoes-comparacao-indisponivel">' + escapeHtml({
          sku_nao_vinculado: 'Comparação com custo real indisponível: SKU ainda não vinculado ao produto.',
          sem_custo_real_corrente: 'Comparação com custo real indisponível: produto sem custo corrente.',
          unidade_incompativel: 'Comparação com custo real indisponível: unidades incompatíveis.'
        }[row.comparison_status] || 'Comparação com custo real indisponível.') + '</p>'
        : '';
      return '<article class="cotacoes-estatistica"><header><div><span>' + escapeHtml(text(row.commercial_condition, 'Condição não informada')) +
        '</span><h4>' + escapeHtml(identityLabel(row)) + '</h4></div><small>' + escapeHtml(row.quote_count) +
        ' cotação(ões) · ' + escapeHtml(row.source_count) + ' fonte(s)</small></header>' +
        '<dl><div><dt>Mínimo · embalagem</dt><dd>' + money(row.minimum_price) + '</dd></div>' +
        '<div><dt>Máximo · embalagem</dt><dd>' + money(row.maximum_price) + '</dd></div>' +
        '<div class="destaque"><dt>Média · embalagem</dt><dd>' + money(row.average_price) + '</dd></div>' +
        '<div><dt>Mediana · embalagem</dt><dd>' + money(row.median_price) + '</dd></div>' +
        '<div><dt>Mais recente · embalagem</dt><dd>' + money(row.latest_price) + '</dd></div></dl>' +
        '<p class="cotacoes-periodo">Período: ' + escapeHtml(period) + ' · última em ' + escapeHtml(date(row.latest_date)) + '</p>' +
        normalizedUnit + cost + comparison + comparisonUnavailable + '</article>';
    }).join('');
  }

  function evidenceNote(row, meta) {
    if (meta.tone === 'pendente') return 'Média indisponível até aprovar manualmente a identidade exata.';
    if (meta.tone === 'conflito') return 'Preço conflitante: não entra nas estatísticas.';
    if (meta.tone === 'rejeitado') return 'Linha preservada como evidência, sem participar dos cálculos.';
    if (Number(row.same_price_evidence_count) > 1 && Number(row.same_price_evidence_ordinal) > 1) {
      return 'Página repetida preservada; não conta novamente na média.';
    }
    return row.counts_in_statistics ? 'Evidência válida nas estatísticas.' : 'Evidência preservada sem duplicar o cálculo.';
  }

  function reviewActions(row) {
    const actions = [];
    const canApprove = row.review_status !== 'aprovado_exato' &&
      row.review_status !== 'conflito' && row.exact_match_eligible && row.exact_sku_key &&
      row.extraction_status === 'verificado_fonte' && !row.has_source_conflict;
    if (canApprove) {
      actions.push('<button type="button" class="cotacoes-revisao aprovar" data-cotacoes-revisar="aprovar" ' +
        'data-cotacoes-item="' + escapeHtml(row.item_id) + '">Aprovar identidade exata</button>');
    }
    if (row.review_status !== 'rejeitado') {
      actions.push('<button type="button" class="cotacoes-revisao rejeitar" data-cotacoes-revisar="rejeitar" ' +
        'data-cotacoes-item="' + escapeHtml(row.item_id) + '">Rejeitar identidade</button>');
    }
    if (!actions.length) return '';
    return '<div class="cotacoes-revisao-acoes" aria-label="Revisão administrativa da identidade">' +
      actions.join('') + '</div>';
  }

  async function reviewSku(row, decision) {
    if (!row || !row.item_id || !Number.isInteger(Number(row.review_version)) || Number(row.review_version) < 1) {
      throw new Error('Atualize a tela antes de revisar esta identidade.');
    }
    if (!window.AMJProtecao || typeof window.AMJProtecao.solicitarSenhaRecente !== 'function') {
      throw new Error('A confirmação segura por senha não está disponível. Atualize a página.');
    }
    const approving = decision === 'aprovar';
    const verb = approving ? 'aprovar' : 'rejeitar';
    let proof = null;
    try {
      proof = await window.AMJProtecao.solicitarSenhaRecente({
        titulo: approving ? 'Aprovar identidade exata da cotação' : 'Rejeitar identidade da cotação',
        explicacao: 'Confirme sua senha e registre o motivo. A decisão será auditada e não altera custo, venda, estoque ou produto.',
        motivo: (approving ? 'Aprovação' : 'Rejeição') + ' manual da identidade exata do SKU'
      });
      return await call('revisar_sku_exato', {
        item_id: row.item_id,
        decisao: verb,
        motivo: proof.motivo,
        expected_version: Number(row.review_version),
        operation_id: proof.operation_id
      }, proof);
    } finally {
      if (proof && typeof proof.encerrar === 'function') await proof.encerrar();
    }
  }

  async function executeReview(row, decision) {
    setBusy(true);
    setStatus(decision === 'aprovar' ? 'Confirmando a identidade exata…' : 'Registrando a rejeição…', false);
    let completed = false;
    try {
      await reviewSku(row, decision);
      state.loaded = false;
      completed = true;
    } catch (error) {
      if (error && error.name === 'AbortError') return;
      setStatus(error && error.message ? error.message : 'Não foi possível registrar a revisão.', true);
    } finally {
      setBusy(false);
    }
    if (completed) await load();
  }

  function renderQuotes() {
    const node = byId('cotacoes-lista');
    const count = byId('cotacoes-contagem');
    if (!node || !count) return;
    const first = state.total ? (state.page - 1) * state.pageSize + 1 : 0;
    const last = Math.min(state.total, state.page * state.pageSize);
    count.textContent = state.total ? 'Exibindo ' + first + '–' + last + ' de ' + state.total + ' linhas.' : 'Nenhuma linha encontrada.';
    if (!state.quotes.length) {
      node.innerHTML = '<p class="cotacoes-vazio"><strong>Nenhuma cotação encontrada.</strong><span>Altere os filtros e tente novamente.</span></p>';
      return;
    }
    const reviewItemsShown = new Set();
    const body = state.quotes.map(function (row) {
      const meta = reviewMeta(row);
      const sourceDetail = [row.supplier_name, row.source_date ? date(row.source_date) : null].filter(Boolean).join(' · ');
      const evidence = ['Pág. ' + text(row.page_number), text(row.line_reference, null)].filter(function (item) {
        return item && item !== 'Pág. —';
      }).join(' · ');
      const product = [row.brand, row.item_name, row.composition, row.concentration].filter(Boolean).join(' · ');
      const presentation = [row.presentation,
        row.package_quantity && row.package_unit ? row.package_quantity + ' ' + row.package_unit : null].filter(Boolean).join(' · ');
      const actions = reviewItemsShown.has(row.item_id) ? '' : reviewActions(row);
      reviewItemsShown.add(row.item_id);
      return '<tr><td data-label="Fonte"><strong>' + escapeHtml(text(row.source_name)) + '</strong><small>' +
        escapeHtml(sourceDetail || 'Data não informada') + '</small><small>' + escapeHtml(evidence || 'Referência de linha não informada') + '</small></td>' +
        '<td data-label="Produto"><strong>' + escapeHtml(product) + '</strong><small>Código: ' +
        escapeHtml(text(row.source_code, 'não informado')) + '</small><small>Apresentação: ' +
        escapeHtml(text(presentation, 'não informada')) + '</small></td>' +
        '<td data-label="Condição"><span>' + escapeHtml(text(row.commercial_condition, 'Preço de tabela')) + '</span>' +
        '<small>Cotado em ' + escapeHtml(date(row.quote_date)) + '</small></td>' +
        '<td data-label="Preço"><strong class="cotacoes-preco">' + money(row.price) + '</strong><small>' +
        escapeHtml(text(row.currency, 'BRL')) + '</small></td>' +
        '<td data-label="Situação"><span class="cotacoes-selo ' + escapeHtml(meta.tone) + '">' + escapeHtml(meta.label) + '</span>' +
        '<small class="cotacoes-nota-linha">' + escapeHtml(evidenceNote(row, meta)) + '</small>' +
        '<small>Revisão v' + escapeHtml(row.review_version) + '</small>' + actions + '</td></tr>';
    }).join('');
    node.innerHTML = '<table><thead><tr><th scope="col">Fonte e evidência</th><th scope="col">Produto e apresentação</th>' +
      '<th scope="col">Condição</th><th scope="col">Preço</th><th scope="col">Situação</th></tr></thead><tbody>' + body + '</tbody></table>';
  }

  function renderPagination() {
    const node = byId('cotacoes-paginacao');
    if (!node) return;
    node.innerHTML = '<button type="button" data-cotacoes-pagina="anterior"' + (state.page <= 1 ? ' disabled' : '') + '>← Anterior</button>' +
      '<span>Página <strong>' + escapeHtml(state.page) + '</strong> de <strong>' + escapeHtml(state.totalPages) + '</strong></span>' +
      '<button type="button" data-cotacoes-pagina="proxima"' + (state.page >= state.totalPages ? ' disabled' : '') + '>Próxima →</button>';
  }

  function render() {
    renderSources();
    renderSummary();
    renderStatistics();
    renderQuotes();
    renderPagination();
  }

  async function load() {
    if (state.loading || !accessAllowed()) return;
    const payload = filterPayload();
    state.pageSize = payload.por_pagina;
    setBusy(true);
    setStatus('Consultando as fontes de preços…', false);
    try {
      const data = await call('listar_cotacoes', payload);
      state.quotes = Array.isArray(data.cotacoes) ? data.cotacoes : [];
      state.sources = Array.isArray(data.fontes) ? data.fontes : [];
      state.statistics = Array.isArray(data.estatisticas) ? data.estatisticas : [];
      const pagination = data.paginacao || {};
      state.page = Number(pagination.pagina) || 1;
      state.total = Number(pagination.total) || 0;
      state.totalPages = Math.max(1, Number(pagination.paginas) || 1);
      state.loaded = true;
      render();
      setStatus('Cotações atualizadas. Nenhum custo real, venda ou estoque foi modificado.', false);
    } catch (error) {
      if (error && error.name === 'AbortError') return;
      setStatus(error && error.message ? error.message : 'Não foi possível consultar as cotações.', true);
    } finally {
      setBusy(false);
    }
  }

  function bind() {
    if (!state.root || state.root.dataset.cotacoesBound === '1') return;
    state.root.dataset.cotacoesBound = '1';
    state.root.addEventListener('click', function (event) {
      if (event.target.closest('[data-cotacoes-atualizar]')) { void load(); return; }
      const reviewButton = event.target.closest('[data-cotacoes-revisar]');
      if (reviewButton) {
        const itemId = String(reviewButton.dataset.cotacoesItem || '');
        const row = state.quotes.find(function (quote) { return String(quote.item_id) === itemId; });
        if (!row) { setStatus('Atualize a tela antes de revisar esta identidade.', true); return; }
        void executeReview(row, reviewButton.dataset.cotacoesRevisar);
        return;
      }
      const pageButton = event.target.closest('[data-cotacoes-pagina]');
      if (!pageButton || pageButton.disabled) return;
      state.page += pageButton.dataset.cotacoesPagina === 'proxima' ? 1 : -1;
      state.page = Math.max(1, Math.min(state.totalPages, state.page));
      void load();
    });
    state.root.addEventListener('submit', function (event) {
      if (event.target.id !== 'cotacoes-filtros') return;
      event.preventDefault();
      state.page = 1;
      void load();
    });
    state.root.addEventListener('reset', function (event) {
      if (event.target.id !== 'cotacoes-filtros') return;
      window.setTimeout(function () { state.page = 1; void load(); }, 0);
    });
  }

  function mount(target) {
    const root = typeof target === 'string' ? document.querySelector(target) : target;
    if (!root) return false;
    if (state.root && state.root !== root) reset();
    state.root = root;
    state.root.innerHTML = shell();
    bind();
    updateAccess();
    return true;
  }
  function activate() {
    updateAccess();
    if (accessAllowed() && !state.loaded && !state.loading) void load();
  }
  function updateAccess() {
    const tab = document.getElementById('aba-bt-cotacoes');
    const allowed = accessAllowed();
    if (tab) { tab.hidden = !allowed; tab.disabled = !allowed; }
    if (!state.root) return;
    state.root.hidden = !allowed;
    if (allowed && !state.loaded && !state.loading) void load();
    if (!allowed) setStatus('Esta área exige a conta proprietária com MFA.', true);
  }
  function reset() {
    state.generation += 1;
    if (state.controller) state.controller.abort();
    state.controller = null;
    state.loaded = false;
    state.loading = false;
    state.page = 1;
    state.pageSize = 25;
    state.totalPages = 1;
    state.total = 0;
    state.quotes = [];
    state.sources = [];
    state.statistics = [];
    if (state.root) {
      state.root.innerHTML = shell();
      delete state.root.dataset.cotacoesBound;
      bind();
      state.root.hidden = !accessAllowed();
    }
  }

  window.AMJCotacoes = Object.freeze({
    montar: mount,
    ativar: activate,
    carregar: load,
    atualizarAcesso: updateAccess,
    reset: reset,
    contrato: Object.freeze({
      endpoint: API,
      somenteLeitura: false,
      somenteRevisaoIdentidade: true,
      aceitaOwnerAal2: true,
      aceitaLegacy: false,
      alteraCustoReal: false,
      alteraPrecoVenda: false,
      alteraEstoque: false
    })
  });
  document.addEventListener('DOMContentLoaded', function () {
    const root = document.getElementById('cotacoes-root');
    if (root) mount(root);
  }, { once: true });
})();

(function () {
  'use strict';

  const API = 'https://rjxtxoqprnumouqakxbc.supabase.co/functions/v1/ia-copiloto-fichas';
  const TIME_ZONE = 'America/Sao_Paulo';
  const WARNING = 'Sugestão gerencial — confirme antes de agir';
  const QUESTIONS = Object.freeze([
    Object.freeze({ key: 'atencao_hoje', label: 'O que precisa de atenção hoje?' }),
    Object.freeze({ key: 'leads_prioritarios', label: 'Quais leads devo contatar primeiro?' }),
    Object.freeze({ key: 'mudancas_marketing', label: 'O que mudou no Marketing?' }),
    Object.freeze({ key: 'previsao_caixa', label: 'Qual é a estimativa de caixa?' })
  ]);
  const QUESTION_KEYS = new Set(QUESTIONS.map(function (item) { return item.key; }));
  const FOCUS_BY_QUESTION = Object.freeze({
    atencao_hoje: 'geral', leads_prioritarios: 'crm', mudancas_marketing: 'marketing',
    previsao_caixa: 'financeiro'
  });
  const SAFE_ROUTES = new Set(['inicio', 'crm', 'marketing', 'procedimentos', 'acompanhamentos', 'clientes',
    'produtos', 'marcas', 'fornecedores', 'agenda', 'receitas', 'despesas', 'estoque', 'cotacoes', 'fichas',
    'gestao', 'prontuarios']);
  const ROUTE_LABELS = Object.freeze({
    inicio: 'Início', crm: 'CRM Leads', marketing: 'Marketing', procedimentos: 'Procedimentos',
    acompanhamentos: 'Acompanhamentos', clientes: 'Clientes', produtos: 'Produtos', marcas: 'Marcas',
    fornecedores: 'Fornecedores', agenda: 'Agenda', receitas: 'Receitas avulsas', despesas: 'Despesas',
    estoque: 'Estoque', cotacoes: 'Cotações e preços', fichas: 'Fichas', gestao: 'Gestão',
    prontuarios: 'Fotos e prontuários'
  });
  const ROUTE_ALIASES = Object.freeze({
    lead: 'crm', leads: 'crm', crm_leads: 'crm', comercial: 'crm', campanha: 'marketing', campanhas: 'marketing',
    conteudo: 'marketing', caixa: 'receitas', financeiro: 'receitas', recebimento: 'receitas', recebimentos: 'receitas',
    pagamento: 'despesas', pagamentos: 'despesas', despesa: 'despesas', agendamento: 'agenda', retorno: 'agenda',
    retornos: 'acompanhamentos', procedimento: 'procedimentos', paciente: 'clientes', pacientes: 'clientes',
    cliente: 'clientes', produto: 'produtos', compra: 'estoque', lote: 'estoque', estoque_baixo: 'estoque',
    prontuario: 'prontuarios', foto: 'prontuarios', documentos: 'fichas', auditoria: 'gestao',
    operacional: 'gestao'
  });
  const FOCUS_BY_ROUTE = Object.freeze({
    crm: 'crm', marketing: 'marketing', agenda: 'agenda', receitas: 'financeiro', despesas: 'financeiro',
    produtos: 'financeiro', marcas: 'financeiro', fornecedores: 'financeiro', estoque: 'financeiro',
    cotacoes: 'financeiro'
  });
  const ACTION_PRESENTATION = Object.freeze({
    crm_primeira_resposta: Object.freeze({ title: 'Responder novo contato', route: 'crm' }),
    crm_proxima_acao: Object.freeze({ title: 'Retomar próxima ação', route: 'crm' }),
    retorno_revisar: Object.freeze({ title: 'Revisar retorno', route: 'acompanhamentos' }),
    financeiro_parcela_revisar: Object.freeze({ title: 'Revisar parcela vencida', route: 'receitas' }),
    estoque_saldo_revisar: Object.freeze({ title: 'Revisar saldo de estoque', route: 'estoque' }),
    marketing_campanha_revisar: Object.freeze({ title: 'Revisar campanha ativa', route: 'marketing' })
  });
  const REASON_LABELS = Object.freeze({
    first_response_missing: 'Primeira resposta ainda não registrada.',
    next_action_overdue: 'A próxima ação registrada está vencida.',
    return_overdue: 'O acompanhamento previsto está vencido.',
    installment_overdue: 'Há uma parcela vencida aguardando revisão.',
    stock_negative: 'O saldo calculado está negativo.',
    stock_zero: 'O saldo calculado chegou a zero.',
    active_campaign_expired: 'A campanha continua ativa após a data final registrada.'
  });
  const PRIORITY_RANK = Object.freeze({ critica: 0, urgente: 0, alta: 1, media: 2, normal: 2, baixa: 3 });

  const state = {
    root: null,
    home: null,
    bound: false,
    opened: false,
    generation: 0,
    controllers: new Set(),
    kindControllers: new Map(),
    panelPromise: null,
    panel: null,
    panelState: 'idle',
    panelError: '',
    currentFocus: 'inicio',
    returnFocus: null,
    inertRestore: [],
    analysisIntent: null,
    analysis: null,
    analysisState: 'idle',
    analysisError: '',
    feedbackState: 'idle'
  };

  function byId(id) { return document.getElementById(id); }
  function text(value) { return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : ''; }
  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }
  function normalized(value) {
    return text(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
  }
  function uuid() {
    return window.crypto && typeof window.crypto.randomUUID === 'function'
      ? window.crypto.randomUUID()
      : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (char) {
        const random = Math.random() * 16 | 0;
        return (char === 'x' ? random : (random & 3 | 8)).toString(16);
      });
  }
  function validUuid(value) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text(value));
  }
  function ownerAccess() {
    try {
      return typeof modoAcesso !== 'undefined' && modoAcesso === 'auth' &&
        typeof identidadeBackend !== 'undefined' && identidadeBackend &&
        text(identidadeBackend.role).toLowerCase() === 'owner';
    } catch (_) { return false; }
  }
  function staleError() {
    const error = new Error('Sessão do Copiloto encerrada.');
    error.code = 'stale_session';
    return error;
  }
  function questionLabel(key) {
    const row = QUESTIONS.find(function (item) { return item.key === key; });
    return row ? row.label : 'Análise gerencial';
  }

  function dateParts(date) {
    const result = {};
    new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(date).forEach(function (part) {
        if (part.type !== 'literal') result[part.type] = part.value;
      });
    return result;
  }
  function analysisWindow(questionKey) {
    const parts = dateParts(new Date());
    let startYear = Number(parts.year);
    let startMonth = Number(parts.month);
    if (questionKey === 'previsao_caixa') {
      const monthIndex = startYear * 12 + (startMonth - 1) - 5;
      startYear = Math.floor(monthIndex / 12);
      startMonth = monthIndex % 12 + 1;
    }
    return {
      inicio: String(startYear).padStart(4, '0') + '-' + String(startMonth).padStart(2, '0') + '-01',
      fim: parts.year + '-' + parts.month + '-' + parts.day
    };
  }
  function safeDateTime(value) {
    if (!value) return 'Atualização não informada';
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return text(value) || 'Atualização não informada';
    return new Intl.DateTimeFormat('pt-BR', { timeZone: TIME_ZONE, dateStyle: 'short', timeStyle: 'short' }).format(date);
  }

  function firstText() {
    for (let index = 0; index < arguments.length; index += 1) {
      const value = arguments[index];
      const direct = text(value);
      if (direct) return direct;
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const nested = firstText(value.texto, value.leitura, value.valor, value.resumo, value.titulo, value.descricao,
          value.mensagem, value.justificativa);
        if (nested) return nested;
      }
    }
    return '';
  }
  function stringList(value) {
    const rows = Array.isArray(value) ? value : (value == null || value === '' ? [] : [value]);
    return rows.map(function (item) {
      return firstText(item, item && item.rotulo, item && item.nome, item && item.fonte, item && item.tipo);
    }).filter(Boolean);
  }
  function errorMessage(payload, fallback) {
    const nested = payload && typeof payload === 'object' ? payload.data : null;
    return firstText(payload && payload.erro, payload && payload.error, payload && payload.message,
      nested && nested.erro, nested && nested.error, nested && nested.message, fallback);
  }
  function unwrap(payload) {
    if (!payload || typeof payload !== 'object') return {};
    if (payload.ok === false || payload.erro || payload.error) throw new Error(errorMessage(payload, 'A solicitação não pôde ser concluída.'));
    let result = payload;
    for (let pass = 0; pass < 2; pass += 1) {
      if (result && result.data && typeof result.data === 'object' && !Array.isArray(result.data)) result = result.data;
      else break;
    }
    if (result && (result.ok === false || result.erro || result.error)) {
      throw new Error(errorMessage(result, 'A solicitação não pôde ser concluída.'));
    }
    return result || {};
  }

  function normalizeRoute(value) {
    const key = normalized(value);
    if (SAFE_ROUTES.has(key)) return key;
    return ROUTE_ALIASES[key] || '';
  }
  function normalizeFocus(route) {
    const safeRoute = normalizeRoute(route) || 'inicio';
    return FOCUS_BY_ROUTE[safeRoute] || 'geral';
  }
  function normalizedPriority(value) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      if (numeric < 10) return { label: 'Crítica', rank: numeric };
      if (numeric <= 20) return { label: 'Alta', rank: numeric };
      if (numeric <= 40) return { label: 'Média', rank: numeric };
      return { label: 'Baixa', rank: numeric };
    }
    const label = firstText(value) || 'Próxima ação';
    const knownRank = PRIORITY_RANK[normalized(label)];
    return { label: label, rank: Number.isFinite(knownRank) ? knownRank * 10 : 90 };
  }
  function metricDetail(actionCode, value) {
    if (value == null || value === '') return '';
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return '';
    if (actionCode === 'financeiro_parcela_revisar') {
      return 'Saldo pendente: ' + new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(numeric) + '.';
    }
    if (actionCode === 'retorno_revisar') {
      return 'Tentativas registradas: ' + new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 }).format(numeric) + '.';
    }
    if (actionCode === 'estoque_saldo_revisar') {
      return 'Saldo atual: ' + new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 3 }).format(numeric) + '.';
    }
    return '';
  }
  function normalizeEvidence(value) {
    const rows = Array.isArray(value) ? value : (value == null || value === '' ? [] : [value]);
    return rows.map(function (item) {
      if (typeof item === 'string' || typeof item === 'number') {
        return { label: text(item), detail: '', updatedAt: '', route: '' };
      }
      item = item && typeof item === 'object' ? item : {};
      return {
        label: firstText(item.rotulo, item.titulo, item.nome, item.fonte, item.tipo, item.descricao),
        detail: firstText(item.detalhe, item.valor, item.justificativa, item.contexto),
        updatedAt: firstText(item.atualizado_em, item.updated_at, item.gerado_em, item.data),
        route: normalizeRoute(item.rota || item.route || item.area || item.categoria)
      };
    }).filter(function (item) { return item.label; });
  }
  function normalizeAction(raw, index, panelUpdated) {
    if (typeof raw === 'string' || typeof raw === 'number') raw = { titulo: text(raw) };
    raw = raw && typeof raw === 'object' ? raw : {};
    const actionCode = normalized(raw.codigo_acao);
    const targetType = normalized(raw.tipo_alvo);
    const targetId = validUuid(raw.alvo_id) ? text(raw.alvo_id) : '';
    const safeName = firstText(raw.nome_seguro);
    const reasonCode = normalized(raw.codigo_motivo);
    const presentation = ACTION_PRESENTATION[actionCode] || null;
    const priority = normalizedPriority(raw.prioridade || raw.urgencia || raw.nivel);
    const reason = REASON_LABELS[reasonCode] || '';
    const metric = metricDetail(actionCode, raw.metrica);
    const evidence = normalizeEvidence(raw.evidencias || raw.fontes || raw.sinais || raw.motivos || raw.justificativa);
    const category = firstText(raw.categoria, raw.area, raw.tipo);
    const route = normalizeRoute(raw.rota || raw.route || raw.destino || raw.area ||
      (presentation && presentation.route) || targetType || category);
    const forecast = raw.estimativa === true || /previs|tendencia|projecao/.test(normalized(raw.tipo || raw.categoria));
    const generatedTitle = presentation ? presentation.title + (safeName ? ': ' + safeName : '') : '';
    const detail = firstText(raw.descricao, raw.detalhe, raw.resumo, raw.por_que, raw.motivo, raw.justificativa,
      [reason, metric].filter(Boolean).join(' '));
    return {
      index: index,
      actionCode: actionCode,
      targetType: targetType,
      targetId: targetId,
      reasonCode: reasonCode,
      metric: raw.metrica == null ? null : raw.metrica,
      title: firstText(raw.titulo, raw.acao, raw.recomendacao, raw.label, generatedTitle, category) || 'Revisar prioridade',
      detail: detail,
      priority: priority.label,
      priorityRank: priority.rank,
      due: firstText(raw.vencido_em, raw.prazo, raw.vence_em, raw.data_limite, raw.proxima_verificacao),
      dueLabel: raw.vencido_em ? 'Vencido em' : 'Próxima verificação',
      route: route,
      updatedAt: firstText(raw.atualizado_em, raw.updated_at, raw.gerado_em, panelUpdated),
      evidence: evidence,
      forecast: forecast,
      horizon: firstText(raw.horizonte, raw.janela, raw.periodo),
      limitations: stringList(raw.limitacoes || raw.ressalvas)
    };
  }
  function stableActions(value, panelUpdated) {
    const rows = Array.isArray(value) ? value : [];
    return rows.map(function (item, index) { return normalizeAction(item, index, panelUpdated); })
      .sort(function (left, right) {
        const rankA = Number.isFinite(left.priorityRank) ? left.priorityRank : 90;
        const rankB = Number.isFinite(right.priorityRank) ? right.priorityRank : 90;
        if (rankA !== rankB) return rankA - rankB;
        const dueA = new Date(left.due || '').getTime();
        const dueB = new Date(right.due || '').getTime();
        if (Number.isFinite(dueA) && Number.isFinite(dueB) && dueA !== dueB) return dueA - dueB;
        if (Number.isFinite(dueA) !== Number.isFinite(dueB)) return Number.isFinite(dueA) ? -1 : 1;
        return left.index - right.index;
      }).slice(0, 3);
  }
  function normalizePanel(payload) {
    const envelope = unwrap(payload);
    const snapshot = envelope.snapshot && typeof envelope.snapshot === 'object' ? envelope.snapshot : envelope;
    const panel = snapshot.painel_privado && typeof snapshot.painel_privado === 'object'
      ? snapshot.painel_privado : (snapshot.painel && typeof snapshot.painel === 'object' ? snapshot.painel : snapshot);
    const updatedAt = firstText(panel.atualizado_em, panel.gerado_em, panel.snapshot_em, snapshot.atualizado_em,
      envelope.atualizado_em);
    const actions = stableActions(panel.acoes || panel.prioridades || panel.next_best_actions, updatedAt);
    const sources = normalizeEvidence(panel.evidencias || panel.fontes || panel.sinais);
    const limitations = stringList(panel.limitacoes || panel.ressalvas || snapshot.limitacoes);
    const summary = firstText(panel.resumo, panel.sintese, panel.briefing, panel.mensagem, panel.texto);
    const explicitPartial = panel.parcial === true || panel.incompleto === true || snapshot.parcial === true;
    const missingActionContext = actions.some(function (action) { return !action.evidence.length || !action.updatedAt; });
    return {
      summary: summary,
      actions: actions,
      sources: sources,
      limitations: limitations,
      updatedAt: updatedAt,
      partial: explicitPartial || missingActionContext,
      empty: !summary && !actions.length
    };
  }
  function normalizeAnalysis(payload, questionKey) {
    const envelope = unwrap(payload);
    const rawAnalysis = envelope.analise && typeof envelope.analise === 'object' ? envelope.analise : envelope;
    const analysis = rawAnalysis.painel_privado && typeof rawAnalysis.painel_privado === 'object'
      ? rawAnalysis.painel_privado : (rawAnalysis.analise_privada && typeof rawAnalysis.analise_privada === 'object'
        ? rawAnalysis.analise_privada : rawAnalysis);
    const updatedAt = firstText(analysis.atualizado_em, analysis.gerado_em, envelope.atualizado_em);
    const priorities = analysis.prioridades || analysis.acoes || analysis.next_best_actions;
    const actions = stableActions(priorities, updatedAt);
    const forecastRaw = analysis.previsao && typeof analysis.previsao === 'object' ? analysis.previsao : {};
    const hasForecast = questionKey === 'previsao_caixa' || Object.keys(forecastRaw).length > 0 || analysis.estimativa != null;
    const limitations = stringList(analysis.limitacoes || analysis.ressalvas || forecastRaw.limitacoes);
    const sources = normalizeEvidence(analysis.evidencias || analysis.fontes || analysis.sinais);
    const summary = firstText(analysis.resumo, analysis.sintese, analysis.briefing, analysis.mensagem,
      forecastRaw.leitura, analysis.leitura);
    const operationId = firstText(envelope.operation_id, analysis.operation_id, payload && payload.operation_id);
    const explicitPartial = analysis.parcial === true || analysis.incompleto === true;
    return {
      title: firstText(analysis.titulo, questionLabel(questionKey)),
      summary: summary,
      actions: actions,
      sources: sources,
      limitations: limitations,
      updatedAt: updatedAt,
      partial: explicitPartial,
      empty: !summary && !actions.length && !hasForecast,
      operationId: validUuid(operationId) ? operationId : '',
      warning: firstText(analysis.aviso),
      forecast: hasForecast ? {
        value: firstText(forecastRaw.leitura, forecastRaw.valor, forecastRaw.resumo, analysis.estimativa),
        horizon: firstText(forecastRaw.horizonte, analysis.horizonte) || 'janela analisada',
        confidence: firstText(forecastRaw.confiabilidade, forecastRaw.confianca, analysis.confiabilidade),
        limitations: stringList(forecastRaw.limitacoes || analysis.limitacoes)
      } : null
    };
  }

  async function request(fields, kind) {
    const generation = state.generation;
    const controller = new AbortController();
    const previous = state.kindControllers.get(kind);
    if (previous) previous.abort();
    state.kindControllers.set(kind, controller);
    state.controllers.add(controller);
    try {
      if (!ownerAccess()) throw new Error('O Copiloto exige conta proprietária individual com MFA.');
      const headers = await cabecalhosAcesso(true);
      if (generation !== state.generation || !ownerAccess()) throw staleError();
      const response = await fetch(API, {
        method: 'POST', headers: headers, cache: 'no-store', referrerPolicy: 'no-referrer',
        signal: controller.signal, body: JSON.stringify(fields)
      });
      let payload = {};
      try { payload = await response.json(); } catch (_) { payload = {}; }
      if (generation !== state.generation || !ownerAccess()) throw staleError();
      if (!response.ok || payload.ok === false || payload.erro || payload.error) {
        const error = new Error(errorMessage(payload, 'Não foi possível concluir a solicitação ao Copiloto.'));
        error.code = firstText(payload.codigo, payload.code, String(response.status));
        throw error;
      }
      if (payload.identity && typeof atualizarIdentidade === 'function') atualizarIdentidade(payload);
      return payload;
    } catch (error) {
      if (generation !== state.generation || error.name === 'AbortError') throw staleError();
      throw error;
    } finally {
      state.controllers.delete(controller);
      if (state.kindControllers.get(kind) === controller) state.kindControllers.delete(kind);
    }
  }

  function warningHtml() {
    return '<p class="copiloto-warning" role="note"><strong>' + escapeHtml(WARNING) + '</strong>' +
      '<span>O Copiloto não salva, envia, publica, converte ou executa decisões por você.</span></p>';
  }
  function evidenceHtml(rows, updatedAt) {
    const items = rows.length ? '<ul>' + rows.map(function (item) {
      return '<li><strong>' + escapeHtml(item.label) + '</strong>' +
        (item.detail ? '<span>' + escapeHtml(item.detail) + '</span>' : '') +
        (item.updatedAt ? '<small>Atualizado em ' + escapeHtml(safeDateTime(item.updatedAt)) + '</small>' : '') + '</li>';
    }).join('') + '</ul>' : '<p>A resposta não trouxe evidência detalhada para esta sugestão.</p>';
    return '<details class="copiloto-evidence"><summary>Evidências e atualização</summary>' + items +
      '<p class="copiloto-updated">Atualização: ' + escapeHtml(safeDateTime(updatedAt)) + '</p></details>';
  }
  function forecastHtml(forecast) {
    if (!forecast) return '';
    const limitations = forecast.limitations && forecast.limitations.length
      ? forecast.limitations : ['A estimativa pode mudar com novos recebimentos, despesas ou registros.'];
    return '<aside class="copiloto-forecast" role="note"><strong>Estimativa gerencial</strong>' +
      (forecast.value ? '<p>' + escapeHtml(forecast.value) + '</p>' : '<p>Sem valor estimado suficiente.</p>') +
      '<dl><div><dt>Horizonte</dt><dd>' + escapeHtml(forecast.horizon || 'janela analisada') + '</dd></div>' +
      '<div><dt>Confiabilidade</dt><dd>' + escapeHtml(forecast.confidence || 'não informada') + '</dd></div></dl>' +
      '<details><summary>Limitações da estimativa</summary><ul>' + limitations.map(function (item) {
        return '<li>' + escapeHtml(item) + '</li>';
      }).join('') + '</ul></details></aside>';
  }
  function actionHtml(action) {
    const forecast = action.forecast ? {
      value: action.detail,
      horizon: action.horizon || 'janela informada',
      confidence: '',
      limitations: action.limitations
    } : null;
    return '<article class="copiloto-nba">' +
      '<div class="copiloto-nba-heading"><span>' + escapeHtml(action.priority || 'Próxima ação') + '</span>' +
      (action.forecast ? '<b>Estimativa</b>' : '') + '</div><h4>' + escapeHtml(action.title) + '</h4>' +
      (action.detail ? '<p>' + escapeHtml(action.detail) + '</p>' : '') +
      (action.due ? '<p class="copiloto-nba-due">' + escapeHtml(action.dueLabel || 'Próxima verificação') + ': ' +
        escapeHtml(safeDateTime(action.due)) + '</p>' : '') +
      forecastHtml(forecast) + evidenceHtml(action.evidence, action.updatedAt) +
      (action.route ? '<button type="button" class="copiloto-route" data-copiloto-route="' + escapeHtml(action.route) +
        '">Abrir ' + escapeHtml(ROUTE_LABELS[action.route] || 'área') + '</button>' : '') + '</article>';
  }
  function sourcesHtml(rows, updatedAt) {
    if (!rows.length) return '';
    return '<details class="copiloto-evidence copiloto-sources"><summary>Fontes do resumo</summary><ul>' + rows.map(function (item) {
      return '<li><strong>' + escapeHtml(item.label) + '</strong>' +
        (item.detail ? '<span>' + escapeHtml(item.detail) + '</span>' : '') + '</li>';
    }).join('') + '</ul><p class="copiloto-updated">Atualização: ' + escapeHtml(safeDateTime(updatedAt)) + '</p></details>';
  }

  function renderHomeLoading() {
    if (!state.home) return;
    state.home.hidden = false;
    state.home.setAttribute('aria-busy', 'true');
    state.home.innerHTML = '<section class="copiloto-home-card" data-state="loading" aria-labelledby="ai-home-title">' +
      '<header><div><p>Copiloto gerencial</p><h3 id="ai-home-title">Preparando o resumo de hoje</h3></div></header>' + warningHtml() +
      '<p class="copiloto-state-message" role="status" aria-live="polite">Carregando dados atualizados…</p>' +
      '<div class="copiloto-skeletons" aria-hidden="true"><i></i><i></i><i></i></div></section>';
  }
  function renderHomeError(message) {
    if (!state.home) return;
    state.home.hidden = false;
    state.home.setAttribute('aria-busy', 'false');
    state.home.innerHTML = '<section class="copiloto-home-card copiloto-state-error" data-state="erro" aria-labelledby="ai-home-title">' +
      '<header><div><p>Copiloto gerencial</p><h3 id="ai-home-title">O resumo não pôde ser carregado</h3></div></header>' + warningHtml() +
      '<div class="copiloto-state-message" role="alert"><strong>As tarefas normais continuam disponíveis.</strong><span>' +
      escapeHtml(message || 'Tente novamente em instantes.') + '</span><button type="button" data-copiloto-retry-panel>Tentar novamente</button></div></section>';
  }
  function renderHomeEmpty() {
    if (!state.home) return;
    state.home.hidden = false;
    state.home.setAttribute('aria-busy', 'false');
    state.home.innerHTML = '<section class="copiloto-home-card" data-state="vazio" aria-labelledby="ai-home-title">' +
      '<header><div><p>Copiloto gerencial</p><h3 id="ai-home-title">Nenhuma prioridade nova</h3></div><span class="copiloto-state-tag">Dados insuficientes</span></header>' +
      warningHtml() + '<p class="copiloto-state-message" role="status">Não há informações suficientes para gerar um briefing agora. Use os atalhos por área abaixo.</p>' +
      '</section>';
  }
  function renderHomePanel(panel) {
    if (!state.home) return;
    if (!panel || panel.empty) { renderHomeEmpty(); return; }
    state.home.hidden = false;
    state.home.setAttribute('aria-busy', 'false');
    const stateName = panel.partial ? 'parcial' : 'sucesso';
    const actions = panel.actions.length ? '<div class="copiloto-nba-grid">' + panel.actions.map(actionHtml).join('') + '</div>' :
      '<p class="copiloto-state-message">Nenhuma ação prioritária foi indicada. Os atalhos por área continuam disponíveis.</p>';
    const limitations = panel.limitations.length ? '<details class="copiloto-limitations"><summary>Limitações deste resumo</summary><ul>' +
      panel.limitations.map(function (item) { return '<li>' + escapeHtml(item) + '</li>'; }).join('') + '</ul></details>' : '';
    state.home.innerHTML = '<section class="copiloto-home-card" data-state="' + stateName + '" aria-labelledby="ai-home-title">' +
      '<header><div><p>Copiloto gerencial</p><h3 id="ai-home-title">Resumo de hoje</h3></div>' +
      (panel.partial ? '<span class="copiloto-state-tag">Leitura parcial</span>' : '<span class="copiloto-state-tag">Atualizado</span>') + '</header>' +
      warningHtml() + (panel.summary ? '<p class="copiloto-summary">' + escapeHtml(panel.summary) + '</p>' : '') +
      '<div class="copiloto-section-heading"><h4>Próximas melhores ações</h4><span>Até 3 prioridades ordenadas</span></div>' + actions +
      sourcesHtml(panel.sources, panel.updatedAt) + limitations +
      '<p class="copiloto-updated">Resumo atualizado: ' + escapeHtml(safeDateTime(panel.updatedAt)) + '</p>' +
      '<p class="copiloto-state-announcement" role="status" aria-live="polite" aria-atomic="true">' +
      (panel.partial ? 'Resumo parcial carregado.' : 'Resumo carregado.') + '</p></section>';
  }

  function drawerHtml() {
    return '<button class="copiloto-overlay" type="button" tabindex="-1" data-copiloto-close aria-label="Fechar Copiloto"></button>' +
      '<aside class="copiloto-drawer" id="copiloto-drawer" role="dialog" aria-modal="true" aria-labelledby="copiloto-title" ' +
      'aria-describedby="copiloto-warning-text" tabindex="-1"><header class="copiloto-drawer-header"><div><p>Assistente gerencial</p>' +
      '<h2 id="copiloto-title">Copiloto</h2><span id="copiloto-context">Contexto: Início</span></div>' +
      '<button type="button" data-copiloto-close aria-label="Fechar Copiloto">×</button></header>' +
      '<div class="copiloto-drawer-scroll"><p class="copiloto-warning" id="copiloto-warning-text" role="note"><strong>' +
      escapeHtml(WARNING) + '</strong><span>As sugestões não executam nenhuma ação automaticamente.</span></p>' +
      '<section class="copiloto-drawer-briefing" aria-labelledby="copiloto-briefing-title"><h3 id="copiloto-briefing-title">Resumo do dia</h3>' +
      '<div id="copiloto-briefing-body"></div></section>' +
      '<section class="copiloto-questions" aria-labelledby="copiloto-questions-title"><div class="copiloto-section-heading">' +
      '<h3 id="copiloto-questions-title">Perguntas rápidas</h3><span>Escolha uma pergunta pronta</span></div><div>' +
      QUESTIONS.map(function (item) {
        return '<button type="button" data-copiloto-question="' + item.key + '" aria-pressed="false">' + escapeHtml(item.label) + '</button>';
      }).join('') + '</div></section>' +
      '<p id="copiloto-analysis-status" class="copiloto-visually-hidden" role="status" aria-live="polite" aria-atomic="true"></p>' +
      '<section class="copiloto-analysis" id="copiloto-analysis" aria-labelledby="copiloto-analysis-title" aria-busy="false">' +
      '<h3 id="copiloto-analysis-title">Análise</h3><div class="copiloto-analysis-placeholder"><strong>Escolha uma pergunta acima.</strong>' +
      '<span>A resposta aparece aqui sem bloquear o resumo ou as outras áreas.</span></div></section></div></aside>';
  }
  function renderDrawerBriefing() {
    const target = byId('copiloto-briefing-body');
    if (!target) return;
    if (state.panelState === 'loading') {
      target.innerHTML = '<div class="copiloto-inline-loading" role="status">Atualizando resumo…</div>';
      return;
    }
    if (state.panelState === 'error') {
      target.innerHTML = '<div class="copiloto-inline-error"><span>Resumo indisponível. As perguntas continuam funcionando.</span>' +
        '<button type="button" data-copiloto-retry-panel>Tentar novamente</button></div>';
      return;
    }
    if (!state.panel || state.panel.empty) {
      target.innerHTML = '<p class="copiloto-muted">Nenhuma prioridade nova foi encontrada.</p>';
      return;
    }
    target.innerHTML = (state.panel.summary ? '<p>' + escapeHtml(state.panel.summary) + '</p>' : '') +
      '<small>Atualizado: ' + escapeHtml(safeDateTime(state.panel.updatedAt)) +
      (state.panel.partial ? ' · leitura parcial' : '') + '</small>';
  }
  function announceAnalysis(message) {
    const status = byId('copiloto-analysis-status');
    if (status) status.textContent = message || '';
  }
  function updateQuestionState(activeKey, loading) {
    if (!state.root) return;
    state.root.querySelectorAll('[data-copiloto-question]').forEach(function (button) {
      const active = button.dataset.copilotoQuestion === activeKey;
      button.setAttribute('aria-pressed', String(active));
      if (active && loading) button.setAttribute('aria-busy', 'true');
      else button.removeAttribute('aria-busy');
    });
  }
  function renderAnalysisLoading(key) {
    const target = byId('copiloto-analysis');
    if (!target) return;
    target.setAttribute('aria-busy', 'true');
    target.innerHTML = '<h3 id="copiloto-analysis-title">' + escapeHtml(questionLabel(key)) + '</h3>' +
      '<div class="copiloto-analysis-loading"><span>Preparando análise separada…</span><i aria-hidden="true"></i><i aria-hidden="true"></i></div>';
    updateQuestionState(key, true);
    announceAnalysis('Preparando análise gerencial.');
  }
  function renderAnalysisError(key, message) {
    const target = byId('copiloto-analysis');
    if (!target) return;
    target.setAttribute('aria-busy', 'false');
    target.innerHTML = '<h3 id="copiloto-analysis-title">' + escapeHtml(questionLabel(key)) + '</h3>' +
      '<div class="copiloto-state-message copiloto-state-error" role="alert"><strong>Não foi possível concluir esta análise.</strong>' +
      '<span>' + escapeHtml(message || 'Tente novamente em instantes.') + '</span><button type="button" data-copiloto-retry-analysis="' +
      escapeHtml(key) + '">Tentar novamente</button></div>';
    updateQuestionState(key, false);
    announceAnalysis('A análise não pôde ser concluída.');
  }
  function renderAnalysisEmpty(key) {
    const target = byId('copiloto-analysis');
    if (!target) return;
    target.setAttribute('aria-busy', 'false');
    target.innerHTML = '<h3 id="copiloto-analysis-title">' + escapeHtml(questionLabel(key)) + '</h3>' +
      '<div class="copiloto-analysis-placeholder"><strong>Dados insuficientes para analisar.</strong>' +
      '<span>Nenhuma estimativa ou ação foi inventada. Tente novamente quando houver mais registros.</span></div>';
    updateQuestionState(key, false);
    announceAnalysis('Análise concluída sem dados suficientes.');
  }
  function renderAnalysisResult(key, analysis) {
    const target = byId('copiloto-analysis');
    if (!target) return;
    if (!analysis || analysis.empty) { renderAnalysisEmpty(key); return; }
    target.setAttribute('aria-busy', 'false');
    const actions = analysis.actions.length ? '<div class="copiloto-analysis-actions">' + analysis.actions.map(actionHtml).join('') + '</div>' : '';
    const limitations = analysis.limitations.length ? '<details class="copiloto-limitations"><summary>Limitações da análise</summary><ul>' +
      analysis.limitations.map(function (item) { return '<li>' + escapeHtml(item) + '</li>'; }).join('') + '</ul></details>' : '';
    const feedback = analysis.operationId ? '<div class="copiloto-feedback" aria-label="Avaliar esta análise"><span>Esta análise foi útil?</span>' +
      '<button type="button" data-copiloto-feedback="util">Sim</button><button type="button" data-copiloto-feedback="nao_util">Não</button>' +
      '<small id="copiloto-feedback-status" role="status" aria-live="polite"></small></div>' : '';
    target.innerHTML = '<header><div><span class="copiloto-state-tag">' + (analysis.partial ? 'Leitura parcial' : 'Análise concluída') + '</span>' +
      '<h3 id="copiloto-analysis-title">' + escapeHtml(analysis.title || questionLabel(key)) + '</h3></div></header>' +
      warningHtml() + (analysis.warning ? '<p class="copiloto-muted">' + escapeHtml(analysis.warning) + '</p>' : '') +
      (analysis.summary ? '<p class="copiloto-summary">' + escapeHtml(analysis.summary) + '</p>' : '') +
      forecastHtml(analysis.forecast) + actions + sourcesHtml(analysis.sources, analysis.updatedAt) + limitations + feedback;
    updateQuestionState(key, false);
    announceAnalysis(analysis.partial ? 'Análise parcial concluída.' : 'Análise concluída.');
  }

  async function loadPanel(force) {
    if (!ownerAccess()) return;
    if (state.panelPromise) return state.panelPromise;
    if (state.panel && !force) { state.panelState = 'success'; renderHomePanel(state.panel); renderDrawerBriefing(); return; }
    state.panelState = 'loading'; state.panelError = '';
    renderHomeLoading(); renderDrawerBriefing();
    const period = analysisWindow();
    let promise = null;
    promise = (async function () {
      try {
        const payload = await request({ acao: 'painel', inicio: period.inicio, fim: period.fim, foco: 'geral' }, 'painel');
        state.panel = normalizePanel(payload);
        state.panelState = state.panel.empty ? 'empty' : (state.panel.partial ? 'partial' : 'success');
        renderHomePanel(state.panel); renderDrawerBriefing();
      } catch (error) {
        if (error.code !== 'stale_session') {
          state.panelState = 'error'; state.panelError = error.message || 'Não foi possível carregar o resumo.';
          renderHomeError(state.panelError); renderDrawerBriefing();
        }
      } finally {
        if (state.panelPromise === promise) state.panelPromise = null;
      }
    }());
    state.panelPromise = promise;
    return promise;
  }

  function analysisIntent(key, retry) {
    const period = analysisWindow(key);
    // A pergunta fixa define o menor contexto necessario. A rota atual nao pode
    // ampliar silenciosamente os dados agregados enviados ao provedor de IA.
    const focus = FOCUS_BY_QUESTION[key] || 'geral';
    const signature = [key, period.inicio, period.fim, focus].join('|');
    if (retry && state.analysisIntent && state.analysisIntent.signature === signature) return state.analysisIntent;
    state.analysisIntent = {
      key: key,
      inicio: period.inicio,
      fim: period.fim,
      foco: focus,
      signature: signature,
      idempotencyKey: uuid()
    };
    return state.analysisIntent;
  }
  async function analyze(key, retry) {
    if (!QUESTION_KEYS.has(key) || !ownerAccess()) return;
    const intent = analysisIntent(key, Boolean(retry));
    state.analysisState = 'loading'; state.analysisError = ''; state.feedbackState = 'idle';
    renderAnalysisLoading(key);
    try {
      const payload = await request({
        acao: 'analisar', inicio: intent.inicio, fim: intent.fim, foco: intent.foco,
        pergunta_chave: key, idempotency_key: intent.idempotencyKey
      }, 'analise');
      state.analysis = normalizeAnalysis(payload, key);
      state.analysisState = state.analysis.empty ? 'empty' : (state.analysis.partial ? 'partial' : 'success');
      renderAnalysisResult(key, state.analysis);
    } catch (error) {
      if (error.code !== 'stale_session') {
        // Primeiro, o retry consulta a mesma chave para recuperar uma resposta cujo retorno
        // possa ter se perdido. Se o servidor confirmar que a tentativa anterior terminou
        // em falha, abre uma unica operacao nova para nao prender o usuario em replay 409.
        if (retry && error.code === 'ai_previous_attempt_failed') return analyze(key, false);
        state.analysisState = 'error'; state.analysisError = error.message || 'Não foi possível concluir a análise.';
        renderAnalysisError(key, state.analysisError);
      }
    }
  }
  async function sendFeedback(value) {
    if (!state.analysis || !state.analysis.operationId || !['util', 'nao_util'].includes(value)) return;
    const controls = state.root ? state.root.querySelectorAll('[data-copiloto-feedback]') : [];
    controls.forEach(function (button) { button.disabled = true; });
    const status = byId('copiloto-feedback-status');
    if (status) status.textContent = 'Enviando avaliação…';
    state.feedbackState = 'loading';
    try {
      await request({ acao: 'feedback', operation_id: state.analysis.operationId,
        idempotency_key: uuid(), avaliacao: value }, 'feedback');
      state.feedbackState = 'success';
      if (status) status.textContent = 'Obrigado. Avaliação registrada.';
    } catch (error) {
      if (error.code !== 'stale_session') {
        state.feedbackState = 'error';
        controls.forEach(function (button) { button.disabled = false; });
        if (status) status.textContent = error.message || 'Não foi possível registrar a avaliação.';
      }
    }
  }

  function routeTo(route) {
    const safeRoute = normalizeRoute(route);
    if (!safeRoute) return;
    close(false);
    window.dispatchEvent(new CustomEvent('amj:navigate', {
      detail: Object.freeze({ route: safeRoute, source: 'copiloto', focus: true })
    }));
  }
  function setTriggersExpanded(expanded) {
    document.querySelectorAll('[data-copiloto-open]').forEach(function (button) {
      button.setAttribute('aria-expanded', String(Boolean(expanded)));
    });
  }
  function saveAndApplyInert() {
    state.inertRestore = [];
    document.querySelectorAll('.app-shell-sidebar,.app-shell-workspace,.app-shell-mobile-bar').forEach(function (node) {
      state.inertRestore.push({ node: node, inert: Boolean(node.inert) });
      node.inert = true;
    });
  }
  function restoreInert() {
    state.inertRestore.forEach(function (item) { item.node.inert = item.inert; });
    state.inertRestore = [];
  }
  function open(options) {
    mount(); updateAccess();
    if (!ownerAccess() || !state.root) return false;
    options = options || {};
    updateContext(options.foco || state.currentFocus);
    state.returnFocus = options.gatilho || document.activeElement;
    state.opened = true;
    state.root.hidden = false;
    state.root.setAttribute('aria-hidden', 'false');
    const drawer = byId('copiloto-drawer');
    if (drawer) drawer.inert = false;
    document.body.classList.add('copiloto-aberto');
    setTriggersExpanded(true);
    saveAndApplyInert();
    renderDrawerBriefing();
    const closeButton = state.root.querySelector('.copiloto-drawer-header [data-copiloto-close]');
    if (closeButton) window.setTimeout(function () { closeButton.focus(); }, 20);
    if (!state.panel && state.panelState !== 'loading') void loadPanel(false);
    return true;
  }
  function close(restoreFocus) {
    if (!state.root || !state.opened) return;
    state.opened = false;
    state.root.hidden = true;
    state.root.setAttribute('aria-hidden', 'true');
    const drawer = byId('copiloto-drawer');
    if (drawer) drawer.inert = true;
    document.body.classList.remove('copiloto-aberto');
    setTriggersExpanded(false);
    restoreInert();
    if (restoreFocus !== false && state.returnFocus && typeof state.returnFocus.focus === 'function') state.returnFocus.focus();
  }
  function updateContext(route) {
    const normalizedRoute = normalizeRoute(route) || 'inicio';
    state.currentFocus = normalizedRoute;
    const context = byId('copiloto-context');
    if (context) context.textContent = 'Contexto: ' + (ROUTE_LABELS[normalizedRoute] || 'Início');
  }
  function focusTrap(event) {
    if (!state.opened || !state.root) return;
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation(); close(true); return;
    }
    if (event.key !== 'Tab') return;
    const items = Array.from(state.root.querySelectorAll('.copiloto-drawer button:not([disabled]),.copiloto-drawer a[href],.copiloto-drawer summary,[tabindex="0"]'))
      .filter(function (item) { return !item.hidden && window.getComputedStyle(item).display !== 'none'; });
    if (!items.length) return;
    const first = items[0]; const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
  function handleClick(event) {
    const closeButton = event.target.closest('[data-copiloto-close]');
    if (closeButton) { event.preventDefault(); close(true); return; }
    const question = event.target.closest('[data-copiloto-question]');
    if (question) { event.preventDefault(); void analyze(question.dataset.copilotoQuestion, false); return; }
    const retryAnalysis = event.target.closest('[data-copiloto-retry-analysis]');
    if (retryAnalysis) { event.preventDefault(); void analyze(retryAnalysis.dataset.copilotoRetryAnalysis, true); return; }
    const retryPanel = event.target.closest('[data-copiloto-retry-panel]');
    if (retryPanel) { event.preventDefault(); void loadPanel(true); return; }
    const feedback = event.target.closest('[data-copiloto-feedback]');
    if (feedback) { event.preventDefault(); void sendFeedback(feedback.dataset.copilotoFeedback); return; }
    const route = event.target.closest('[data-copiloto-route]');
    if (route) { event.preventDefault(); routeTo(route.dataset.copilotoRoute); }
  }
  function bind() {
    if (state.bound) return;
    state.bound = true;
    document.addEventListener('click', handleClick);
    document.addEventListener('keydown', focusTrap);
    window.addEventListener('amj:shell-route', function (event) {
      const detail = event.detail || {};
      updateContext(detail.route || 'inicio');
    });
  }
  function mount(target) {
    if (state.root) return true;
    state.root = typeof target === 'string' ? document.querySelector(target) : target;
    if (!state.root) state.root = byId('copiloto-root');
    state.home = byId('ai-home-root');
    if (!state.root) return false;
    state.root.className = 'copiloto-host';
    state.root.innerHTML = drawerHtml();
    state.root.hidden = true;
    state.root.setAttribute('aria-hidden', 'true');
    const drawer = byId('copiloto-drawer');
    if (drawer) drawer.inert = true;
    bind(); updateContext(state.currentFocus); updateAccess();
    return true;
  }
  function updateAccess() {
    state.home = state.home || byId('ai-home-root');
    const allowed = ownerAccess();
    if (state.home) state.home.hidden = !allowed;
    if (!allowed && state.opened) close(false);
  }
  function activate(options) {
    mount(); updateAccess(); options = options || {};
    updateContext(options.foco || 'inicio');
    if (ownerAccess()) void loadPanel(false);
  }
  function reset() {
    state.generation += 1;
    state.controllers.forEach(function (controller) { controller.abort(); });
    state.controllers.clear(); state.kindControllers.clear();
    close(false);
    state.panelPromise = null; state.panel = null; state.panelState = 'idle'; state.panelError = '';
    state.analysisIntent = null; state.analysis = null; state.analysisState = 'idle'; state.analysisError = '';
    state.feedbackState = 'idle'; state.currentFocus = 'inicio'; state.returnFocus = null;
    if (state.home) { state.home.innerHTML = ''; state.home.hidden = true; state.home.setAttribute('aria-busy', 'false'); }
    if (state.root) {
      state.root.innerHTML = drawerHtml(); state.root.hidden = true; state.root.setAttribute('aria-hidden', 'true');
      const drawer = byId('copiloto-drawer'); if (drawer) drawer.inert = true;
    }
  }

  window.AMJCopiloto = Object.freeze({
    montar: mount,
    ativar: activate,
    abrir: open,
    fechar: function () { close(true); },
    carregar: loadPanel,
    atualizarAcesso: updateAccess,
    atualizarContexto: updateContext,
    reset: reset,
    contrato: Object.freeze({
      endpoint: API,
      perguntas: Object.freeze(QUESTIONS.map(function (item) { return item.key; })),
      executaAcoesAutomaticas: false,
      feedback: Object.freeze(['util', 'nao_util'])
    }),
    __test: Object.freeze({
      analysisWindow: analysisWindow,
      normalizePanel: normalizePanel,
      normalizeAnalysis: normalizeAnalysis,
      normalizeRoute: normalizeRoute,
      normalizeFocus: normalizeFocus,
      stableActions: stableActions,
      validUuid: validUuid
    })
  });
}());

(function () {
  'use strict';

  const API = 'https://rjxtxoqprnumouqakxbc.supabase.co/functions/v1/marketing-fichas';
  const TIME_ZONE = 'America/Sao_Paulo';
  const DATE = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeZone: TIME_ZONE });
  const MONEY = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
  const CHANNELS = Object.freeze([
    ['instagram_organico', 'Instagram orgânico'], ['instagram_ads', 'Instagram Ads'],
    ['facebook', 'Facebook'], ['google', 'Google'], ['google_maps', 'Google Maps'],
    ['indicacao', 'Indicação'], ['paciente_atual', 'Paciente atual'], ['influenciadora', 'Influenciadora'],
    ['site', 'Site'], ['whatsapp', 'WhatsApp'], ['evento', 'Evento'], ['parceria', 'Parceria'], ['outro', 'Outro']
  ]);
  const CAMPAIGN_STATUS = Object.freeze([
    ['rascunho', 'Rascunho / planejada'], ['ativa', 'Ativa'], ['pausada', 'Pausada'], ['encerrada', 'Encerrada']
  ]);
  const CONTENT_FORMATS = Object.freeze([
    ['reels', 'Reels'], ['stories', 'Stories'], ['carrossel', 'Carrossel'], ['post', 'Post'],
    ['video', 'Vídeo'], ['artigo', 'Artigo'], ['email', 'E-mail'], ['whatsapp', 'WhatsApp']
  ]);
  const CONTENT_PILLARS = Object.freeze([
    ['educacao', 'Educação'], ['autoridade', 'Autoridade'], ['bastidores', 'Bastidores'],
    ['procedimento', 'Procedimento'], ['ciencia', 'Ciência'], ['cuidados', 'Cuidados'],
    ['duvidas', 'Dúvidas'], ['resultados', 'Resultados'], ['humanizacao', 'Humanização']
  ]);
  const CONTENT_STATUS = Object.freeze([
    ['ideia', 'Ideia'], ['roteiro', 'Roteiro'], ['gravacao', 'Gravação'], ['edicao', 'Edição'],
    ['agendado', 'Agendado'], ['publicado', 'Publicado manualmente']
  ]);
  const state = {
    root: null, loaded: false, loading: false, generation: 0, view: 'dashboard', bound: false,
    campaigns: [], links: [], availableInvestments: [], availableRevenues: [], revenueLeads: [], launchPages: {},
    referrals: [], referralPatients: [], referralLeads: [], contents: [], dashboard: {}, pages: {},
    controllers: new Set(), intents: Object.create(null), editingCampaign: '', editingContent: ''
  };

  function byId(id) { return document.getElementById(id); }
  function text(value) { return String(value == null ? '' : value).trim(); }
  function escapeHtml(value) {
    return text(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
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
    if (!state.intents[name]) state.intents[name] = uuid();
    return state.intents[name];
  }
  function clearIntent(name) { delete state.intents[name]; }
  function ownerAccess() {
    try {
      return typeof modoAcesso !== 'undefined' && modoAcesso === 'auth' &&
        typeof identidadeBackend !== 'undefined' && identidadeBackend &&
        text(identidadeBackend.role).toLowerCase() === 'owner';
    } catch (_) { return false; }
  }
  function staleError() {
    const error = new Error('Sessão do Marketing encerrada.'); error.code = 'stale_session'; return error;
  }
  function safeDate(value) {
    if (!value) return '—';
    const raw = /^\d{4}-\d{2}-\d{2}$/.test(text(value)) ? text(value) + 'T12:00:00-03:00' : value;
    const parsed = new Date(raw);
    return Number.isFinite(parsed.getTime()) ? DATE.format(parsed) : '—';
  }
  function money(value) {
    if (value == null || value === '') return 'Não calculável';
    const parsed = Number(value);
    return Number.isFinite(parsed) ? MONEY.format(parsed) : 'Não calculável';
  }
  function count(value) {
    if (value == null || value === '') return 'Não calculável';
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed.toLocaleString('pt-BR') : 'Não calculável';
  }
  function ratio(value) {
    if (value == null || value === '') return 'Não calculável';
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed.toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + '%' : 'Não calculável';
  }
  function parseMoney(value) {
    const normalized = text(value).replace(/\s/g, '').replace(/R\$/gi, '').replace(/\./g, '').replace(',', '.');
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : NaN;
  }
  function optionRows(rows, selected) {
    return rows.map(function (row) {
      return '<option value="' + escapeHtml(row[0]) + '"' + (text(row[0]) === text(selected) ? ' selected' : '') + '>' +
        escapeHtml(row[1]) + '</option>';
    }).join('');
  }
  function campaignOptions(selected, activeOnly) {
    const rows = state.campaigns.filter(function (campaign) {
      return !activeOnly || text(campaign.status) === 'ativa';
    }).map(function (campaign) {
      return [campaign.id, (campaign.codigo ? campaign.codigo + ' · ' : '') + (campaign.nome || 'Campanha')];
    });
    return '<option value="">Selecione</option>' + optionRows(rows, selected);
  }
  function safeEntityOptions(rows, selected, emptyLabel) {
    return '<option value="">' + escapeHtml(emptyLabel || 'Selecione') + '</option>' + rows.map(function (item) {
      const id = text(item.id || item.patient_id || item.lead_id);
      const label = text(item.rotulo_seguro || item.safe_label || item.alias_opaco || item.nome || item.name) || 'Cadastro protegido';
      return '<option value="' + escapeHtml(id) + '"' + (id === text(selected) ? ' selected' : '') + '>' + escapeHtml(label) + '</option>';
    }).join('');
  }
  function monthWindow() {
    const now = new Date();
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit' }).formatToParts(now);
    const value = function (name) { return (parts.find(function (part) { return part.type === name; }) || {}).value; };
    const dayParts = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
    const dayValue = function (name) { return (dayParts.find(function (part) { return part.type === name; }) || {}).value; };
    const year = Number(value('year')); const month = Number(value('month'));
    return { inicio: String(year).padStart(4, '0') + '-' + String(month).padStart(2, '0') + '-01',
      fim: dayValue('year') + '-' + dayValue('month') + '-' + dayValue('day') };
  }
  function dateTimeLocal(value) {
    if (!value) return '';
    const parsed = new Date(value); if (!Number.isFinite(parsed.getTime())) return '';
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(parsed);
    const part = function (name) { return (parts.find(function (item) { return item.type === name; }) || {}).value; };
    return part('year') + '-' + part('month') + '-' + part('day') + 'T' + part('hour') + ':' + part('minute');
  }
  function safeDateTime(value) {
    if (!value) return 'Sem data'; const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? new Intl.DateTimeFormat('pt-BR', { timeZone: TIME_ZONE, dateStyle: 'short', timeStyle: 'short' }).format(parsed) : 'Sem data';
  }
  function saoPauloInputToIso(value) { return value ? new Date(value + ':00-03:00').toISOString() : null; }
  function pageButton(area) {
    const page = state.pages[area] || {};
    return page.has_more ? '<div class="marketing-form-actions"><button type="button" class="marketing-button secondary" data-marketing-more-area="' + area + '">Carregar mais</button></div>' : '';
  }

  async function request(action, fields, options) {
    const generation = state.generation;
    const controller = new AbortController();
    state.controllers.add(controller); options = options || {};
    try {
      if (!ownerAccess()) throw new Error('Marketing exige conta proprietária individual com MFA.');
      const headers = await cabecalhosAcesso(true, options.proof);
      if (generation !== state.generation || !ownerAccess()) throw staleError();
      const body = Object.assign({ action: action }, fields || {});
      if (options.idempotencyKey) body.idempotency_key = options.idempotencyKey;
      if (options.expectedVersion != null) body.expected_version = options.expectedVersion;
      const response = await fetch(API, { method: 'POST', headers: headers, cache: 'no-store',
        referrerPolicy: 'no-referrer', signal: controller.signal, body: JSON.stringify(body) });
      let data = {};
      try { data = await response.json(); } catch (_) { data = {}; }
      if (generation !== state.generation || !ownerAccess()) throw staleError();
      if (!response.ok || data.erro || data.error || data.ok === false) {
        const error = new Error(data.erro || data.error || 'Não foi possível concluir a operação no Marketing.');
        error.code = data.codigo || data.code || String(response.status); throw error;
      }
      if (data.identity && typeof atualizarIdentidade === 'function') atualizarIdentidade(data);
      return data;
    } catch (error) {
      if (generation !== state.generation || error.name === 'AbortError') throw staleError();
      throw error;
    } finally { state.controllers.delete(controller); }
  }
  async function protectedRequest(action, fields, options) {
    if (!window.AMJProtecao || typeof window.AMJProtecao.solicitarSenhaRecente !== 'function') {
      throw new Error('A confirmação segura por senha não está disponível. Atualize a página.');
    }
    let proof = null;
    try {
      proof = await window.AMJProtecao.solicitarSenhaRecente(options || {});
      return await request(action, Object.assign({}, fields || {}, { operation_id: proof.operation_id,
        motivo: proof.motivo || 'Alteração de marketing confirmada pela gestão' }),
      { proof: proof, idempotencyKey: options && options.idempotencyKey,
        expectedVersion: options && options.expectedVersion });
    } finally { if (proof && typeof proof.encerrar === 'function') await proof.encerrar(); }
  }
  function status(message, error) {
    const node = byId('marketing-status'); if (!node) return;
    node.textContent = message || ''; node.classList.toggle('erro', Boolean(error));
  }
  function setBusy(busy) {
    state.loading = Boolean(busy);
    if (!state.root) return;
    state.root.setAttribute('aria-busy', String(Boolean(busy)));
    state.root.querySelectorAll('button,input,select,textarea').forEach(function (control) {
      if (busy && !control.disabled) { control.disabled = true; control.dataset.marketingBusy = '1'; }
      else if (!busy && control.dataset.marketingBusy === '1') { control.disabled = false; delete control.dataset.marketingBusy; }
    });
  }
  function shellHtml() {
    const tabs = [['dashboard', 'Visão geral'], ['campaigns', 'Campanhas'], ['links', 'Atribuição financeira'],
      ['referrals', 'Indicações'], ['content', 'Conteúdo']];
    return '<section class="marketing-shell" aria-labelledby="marketing-title"><header class="marketing-header"><div>' +
      '<p>Gestão de aquisição e relacionamento</p><h2 id="marketing-title">Marketing</h2>' +
      '<span>Campanhas, resultados, indicações e conteúdo — sem disparos ou publicações automáticas.</span></div>' +
      '<button type="button" class="marketing-button secondary" data-marketing-action="refresh">Atualizar</button></header>' +
      '<p id="marketing-status" class="marketing-status" role="status" aria-live="polite"></p>' +
      '<nav class="marketing-tabs" aria-label="Áreas do Marketing">' + tabs.map(function (tab) {
        return '<button type="button" data-marketing-view="' + tab[0] + '" aria-pressed="' + String(tab[0] === state.view) + '">' + tab[1] + '</button>';
      }).join('') + '</nav><div id="marketing-content" class="marketing-content" tabindex="-1"></div></section>';
  }
  function emptyState(title, detail) {
    return '<div class="marketing-empty"><strong>' + escapeHtml(title) + '</strong><span>' + escapeHtml(detail) + '</span></div>';
  }
  function kpi(label, value, detail) {
    return '<div class="marketing-kpi"><span>' + escapeHtml(label) + '</span><strong>' + escapeHtml(value) + '</strong><small>' + escapeHtml(detail) + '</small></div>';
  }
  function renderDashboard() {
    const dashboard = state.dashboard || {};
    const campaigns = Array.isArray(dashboard.campanhas) ? dashboard.campanhas : [];
    const windowValue = dashboard.periodo || monthWindow();
    const unassigned = dashboard.nao_atribuido || {};
    const totals = dashboard.totais || {};
    return '<aside class="marketing-disclosure" role="note"><strong>Leitura transparente</strong><span>Receita atribuída considera recebimentos líquidos efetivamente pagos. Investimento considera despesas efetivamente pagas. CAC e ROI usam esta janela; sem denominador, mostram “Não calculável”.</span></aside>' +
      '<div class="marketing-period"><span>Janela analisada</span><strong>' + safeDate(windowValue.inicio) + ' a ' + safeDate(windowValue.fim) + '</strong></div>' +
      '<div class="marketing-kpis">' + kpi('Investimento pago', money(totals.investimento_pago), 'Despesas pagas e atribuídas') +
      kpi('Receita recebida líquida', money(totals.receita_recebida), 'Recebimentos pagos e atribuídos') +
      kpi('Leads atribuídos', count(totals.leads), 'Campanha selecionada no CRM') +
      kpi('Pacientes convertidas', count(totals.conversoes_pacientes), 'Pacientes distintas na janela') +
      kpi('CAC', money(totals.cac), 'Investimento pago ÷ pacientes distintas') +
      kpi('ROI', ratio(totals.roi), '(receita − investimento) ÷ investimento') + '</div>' +
      '<section class="marketing-unassigned" aria-labelledby="marketing-unassigned-title"><div><p>Sem vínculo</p><h3 id="marketing-unassigned-title">Valores não atribuídos</h3></div>' +
      '<dl><div><dt>Receitas</dt><dd>' + count(unassigned.receitas_quantidade) + ' · ' + money(unassigned.receita_recebida) + '</dd></div>' +
      '<div><dt>Despesas</dt><dd>' + count(unassigned.despesas_quantidade) + ' · ' + money(unassigned.despesa_paga) + '</dd></div></dl></section>' +
      (Array.isArray(dashboard.limitacoes) && dashboard.limitacoes.length ? '<ul class="marketing-limitations">' + dashboard.limitacoes.map(function (item) { return '<li>' + escapeHtml(item) + '</li>'; }).join('') + '</ul>' : '') +
      '<section class="marketing-panel"><header><div><p>Desempenho</p><h3>Campanhas na janela</h3></div></header>' +
      (campaigns.length ? '<div class="marketing-metric-cards">' + campaigns.map(function (item) {
        return '<article class="marketing-metric-card"><h4>' + escapeHtml(item.nome || 'Campanha') + '</h4><dl>' +
          '<div><dt>Investimento pago</dt><dd>' + money(item.investimento_pago) + '</dd></div><div><dt>Leads</dt><dd>' + count(item.leads) + '</dd></div>' +
          '<div><dt>Conversões</dt><dd>' + count(item.conversoes_pacientes) + '</dd></div><div><dt>Receita líquida</dt><dd>' + money(item.receita_recebida) + '</dd></div>' +
          '<div><dt>CAC</dt><dd>' + money(item.cac) + '</dd></div><div><dt>ROI</dt><dd>' + ratio(item.roi) + '</dd></div></dl></article>';
      }).join('') + '</div>' : emptyState('Sem resultados atribuídos nesta janela.', 'Cadastre campanhas e use os vínculos estruturados.')) + '</section>';
  }
  function campaignForm(campaign) {
    campaign = campaign || {};
    return '<details class="marketing-editor"' + (campaign.id ? ' open' : '') + '><summary>' + (campaign.id ? 'Editar campanha' : 'Nova campanha') + '</summary>' +
      '<form data-marketing-form="campaign" novalidate><input type="hidden" name="id" value="' + escapeHtml(campaign.id) + '"><input type="hidden" name="version" value="' + escapeHtml(campaign.version) + '">' +
      '<div class="marketing-form-grid"><label><span>Código único</span><input name="codigo" value="' + escapeHtml(campaign.codigo) + '" minlength="2" maxlength="40" required></label>' +
      '<label><span>Nome</span><input name="nome" value="' + escapeHtml(campaign.nome) + '" minlength="3" maxlength="120" required></label>' +
      '<label><span>Canal</span><select name="canal" required><option value="">Selecione</option>' + optionRows(CHANNELS, campaign.canal) + '</select></label>' +
      '<label><span>Objetivo</span><input name="objetivo" value="' + escapeHtml(campaign.objetivo) + '" minlength="3" maxlength="160" required></label>' +
      '<label><span>Orçamento planejado <small>opcional</small></span><input name="orcamento_planejado" type="number" min="0" step="0.01" inputmode="decimal" value="' + escapeHtml(campaign.orcamento_planejado) + '" placeholder="0,00"></label>' +
      '<label><span>Início</span><input name="inicio" type="date" value="' + escapeHtml(text(campaign.inicio).slice(0, 10)) + '" required></label>' +
      '<label><span>Fim <small>opcional</small></span><input name="fim" type="date" value="' + escapeHtml(text(campaign.fim).slice(0, 10)) + '"></label>' +
      '<label><span>Janela de atribuição</span><input name="janela_atribuicao_dias" type="number" min="1" max="365" value="' + escapeHtml(campaign.janela_atribuicao_dias || 30) + '" required></label>' +
      '<label><span>Status</span><select name="status" required>' + optionRows(CAMPAIGN_STATUS, campaign.status || 'rascunho') + '</select></label></div>' +
      '<p class="marketing-form-note">O código e o identificador evitam campanhas duplicadas. Leads escolhem este cadastro; nomes não são digitados novamente.</p>' +
      '<div class="marketing-form-actions"><button type="button" class="marketing-button secondary" data-marketing-action="cancel-edit">Cancelar</button><button type="submit" class="marketing-button">Salvar campanha</button></div></form></details>';
  }
  function renderCampaigns() {
    const editing = state.campaigns.find(function (item) { return text(item.id) === state.editingCampaign; });
    return campaignForm(editing) + '<section class="marketing-panel"><header><div><p>Cadastro canônico</p><h3>Campanhas</h3></div><strong>' + state.campaigns.length + '</strong></header>' +
      (state.campaigns.length ? '<div class="marketing-card-grid">' + state.campaigns.map(function (item) {
        return '<article class="marketing-card"><header><div><span>' + escapeHtml(item.codigo || item.canal || 'Campanha') + '</span><h4>' + escapeHtml(item.nome || 'Campanha') + '</h4></div><b>' + escapeHtml(item.status || '—') + '</b></header>' +
          '<dl><div><dt>Canal</dt><dd>' + escapeHtml(item.canal || '—') + '</dd></div><div><dt>Objetivo</dt><dd>' + escapeHtml(item.objetivo || '—') + '</dd></div>' +
          '<div><dt>Orçamento planejado</dt><dd>' + money(item.orcamento_planejado) + '</dd></div><div><dt>Período</dt><dd>' + safeDate(item.inicio) + ' a ' + (item.fim ? safeDate(item.fim) : 'em aberto') + '</dd></div><div><dt>Janela</dt><dd>' + escapeHtml(item.janela_atribuicao_dias) + ' dias</dd></div></dl>' +
          (item.arquivado_em ? '<p class="marketing-muted">Arquivada: ' + escapeHtml(item.motivo_arquivamento || 'motivo protegido registrado') + '</p>' :
            '<div class="marketing-card-actions"><button type="button" class="marketing-button secondary" data-marketing-edit-campaign="' + escapeHtml(item.id) + '">Editar</button><button type="button" class="marketing-button danger" data-marketing-archive-campaign="' + escapeHtml(item.id) + '">Arquivar</button></div>') + '</article>';
      }).join('') + '</div>' : emptyState('Nenhuma campanha cadastrada.', 'Crie a campanha antes de atribuir leads ou lançamentos.')) + pageButton('campaigns') + '</section>';
  }
  function availableLaunchOptions(rows) {
    return '<option value="">Selecione</option>' + rows.map(function (item) {
      const label = safeDate(item.data_competencia) + ' · ' + (item.descricao || item.tipo || 'Lançamento') + ' · comprometido ' + money(item.valor_total) + ' · pago líquido ' + money(item.liquido_pago);
      return '<option value="' + escapeHtml(item.id) + '">' + escapeHtml(label) + '</option>';
    }).join('');
  }
  function linkForm() {
    const moreHidden = (state.launchPages.investimento || {}).has_more === false ? ' hidden' : '';
    return '<details class="marketing-editor"><summary>Atribuir lançamento existente</summary><form data-marketing-form="link" novalidate><div class="marketing-form-grid">' +
      '<label><span>Campanha</span><select name="campanha_id" required>' + campaignOptions('', true) + '</select></label>' +
      '<label><span>Tipo</span><select name="tipo" required><option value="investimento">Despesa / investimento</option><option value="receita">Receita</option></select></label>' +
      '<label class="wide" data-marketing-launch-field><span>Lançamento financeiro</span><select name="lancamento_id" required>' + availableLaunchOptions(state.availableInvestments) + '</select></label>' +
      '<label class="wide" data-marketing-lead-field hidden><span>Lead convertido da mesma campanha</span><select name="lead_id">' + safeEntityOptions(state.revenueLeads, '', 'Selecione') + '</select></label></div>' +
      '<p class="marketing-form-note">A atribuição não cria receita nem despesa. Vincula um lançamento financeiro existente, pago ou a pagar. Os KPIs usam somente o caixa efetivamente pago/recebido.</p>' +
      '<div class="marketing-form-actions"><button type="button" class="marketing-button secondary" data-marketing-more-launches' + moreHidden + '>Carregar mais lançamentos</button><button type="submit" class="marketing-button">Vincular com confirmação</button></div></form></details>';
  }
  function renderLinks() {
    return linkForm() + '<section class="marketing-panel"><header><div><p>Rastreabilidade</p><h3>Vínculos financeiros</h3></div></header>' +
      (state.links.length ? '<div class="marketing-card-grid">' + state.links.map(function (item) {
        return '<article class="marketing-card"><header><div><span>' + escapeHtml(item.tipo || 'Vínculo') + '</span><h4>' + escapeHtml(item.campanha_nome || 'Campanha') + '</h4></div><b>Pago líquido: ' + money(item.liquido_pago) + '</b></header><p><strong>Lançamento:</strong> ' + escapeHtml(item.descricao || 'Sem descrição') + '</p><p>Valor comprometido: ' + money(item.valor_comprometido) + '</p>' +
          '<p>Criado em ' + safeDate(item.criado_em) + (item.cancelado ? ' · Cancelado em ' + safeDate(item.cancelado_em) : '') + '</p>' +
          (item.cancelado ? '<p class="marketing-muted"><strong>Motivo do cancelamento:</strong> ' + escapeHtml(item.motivo_cancelamento || 'motivo protegido registrado') + '</p>' : '') +
          (!item.cancelado ? '<div class="marketing-card-actions"><button type="button" class="marketing-button danger" data-marketing-cancel-link="' + escapeHtml(item.id) + '">Cancelar vínculo</button></div>' : '') + '</article>';
      }).join('') + '</div>' : emptyState('Nenhum lançamento atribuído.', 'Escolha uma campanha e um lançamento financeiro existente.')) + pageButton('links') + '</section>';
  }
  function referralForm() {
    const ready = state.referralPatients.length && state.referralLeads.length;
    return '<details class="marketing-editor"><summary>Registrar indicação</summary><form data-marketing-form="referral" novalidate><div class="marketing-form-grid">' +
      '<label><span>Paciente que indicou</span><select name="indicadora_paciente_id" required>' + safeEntityOptions(state.referralPatients, '', 'Selecione') + '</select></label>' +
      '<label><span>Lead indicado já cadastrado</span><select name="lead_indicado_id" required>' + safeEntityOptions(state.referralLeads, '', 'Selecione') + '</select></label>' +
      '<label class="wide"><span>Origem <small>opcional</small></span><input name="origem" maxlength="120"></label></div>' +
      (!ready ? '<p class="marketing-blocked" role="note">Cadastre o lead no CRM antes de registrar a indicação. A tela não cria pessoas automaticamente.</p>' : '') +
      '<p class="marketing-form-note">A indicação não autoriza marketing, não envia mensagem e não concede recompensa automaticamente.</p>' +
      '<div class="marketing-form-actions"><button type="submit" class="marketing-button"' + (ready ? '' : ' disabled') + '>Salvar indicação</button></div></form></details>';
  }
  function renderReferrals() {
    return referralForm() + '<section class="marketing-panel"><header><div><p>Relacionamento</p><h3>Indicações</h3></div></header>' +
      (state.referrals.length ? '<div class="marketing-card-grid">' + state.referrals.map(function (item) {
        return '<article class="marketing-card"><header><div><span>' + (item.cancelado ? 'Indicação cancelada' : 'Indicação registrada') + '</span><h4>' + escapeHtml(item.indicadora_rotulo || item.indicadora_nome || 'Paciente protegida') + '</h4></div><b>' + safeDate(item.criado_em) + '</b></header>' +
          '<p>Indicou: ' + escapeHtml(item.lead_rotulo || item.lead_nome || 'Lead existente') + '</p><p class="marketing-muted">Registro interno. Nenhuma mensagem foi enviada.</p>' +
          (item.cancelado ? '<p class="marketing-muted">Cancelada em ' + safeDate(item.cancelado_em) + ': ' + escapeHtml(item.motivo_cancelamento || 'motivo registrado') + '</p>' : '') +
          (!item.cancelado ? '<div class="marketing-card-actions"><button type="button" class="marketing-button danger" data-marketing-cancel-referral="' + escapeHtml(item.id) + '">Cancelar indicação</button></div>' : '') + '</article>';
      }).join('') + '</div>' : emptyState('Nenhuma indicação registrada.', 'Vincule uma paciente a um lead já existente.')) + pageButton('referrals') + '</section>';
  }
  function contentForm(item) {
    item = item || {};
    return '<details class="marketing-editor"' + (item.id ? ' open' : '') + '><summary>' + (item.id ? 'Editar conteúdo' : 'Planejar conteúdo') + '</summary><form data-marketing-form="content" novalidate>' +
      '<input type="hidden" name="id" value="' + escapeHtml(item.id) + '"><input type="hidden" name="version" value="' + escapeHtml(item.version) + '"><div class="marketing-form-grid">' +
      '<label><span>Título</span><input name="titulo" value="' + escapeHtml(item.titulo) + '" minlength="3" maxlength="160" required></label>' +
      '<label><span>Pilar</span><select name="pilar" required><option value="">Selecione</option>' + optionRows(CONTENT_PILLARS, item.pilar) + '</select></label>' +
      '<label><span>Formato</span><select name="formato" required><option value="">Selecione</option>' + optionRows(CONTENT_FORMATS, item.formato) + '</select></label>' +
      '<label><span>Canal</span><select name="canal" required><option value="">Selecione</option>' + optionRows(CHANNELS, item.canal) + '</select></label>' +
      '<label><span>Status</span><select name="status" required>' + optionRows(CONTENT_STATUS, item.status || 'ideia') + '</select></label>' +
      '<label><span>Campanha <small>opcional</small></span><select name="campanha_id"><option value="">Sem campanha</option>' + campaignOptions(item.campanha_id, false).replace('<option value="">Selecione</option>', '') + '</select></label>' +
      '<label><span>Data planejada <small>opcional</small></span><input name="agendado_em" type="datetime-local" value="' + escapeHtml(dateTimeLocal(item.agendado_em)) + '"></label>' +
      '<label><span>Publicado manualmente em <small>opcional</small></span><input name="publicado_em" type="datetime-local" value="' + escapeHtml(dateTimeLocal(item.publicado_em)) + '"></label>' +
      '<label class="wide"><span>Chamada para ação</span><input name="cta" value="' + escapeHtml(item.cta) + '" maxlength="240"></label>' +
      '<label class="wide"><span>Roteiro</span><textarea name="roteiro" maxlength="6000" rows="5">' + escapeHtml(item.roteiro) + '</textarea></label>' +
      '<label class="wide"><span>URL pública <small>somente após publicação manual</small></span><input name="url_publica" type="url" value="' + escapeHtml(item.url_publica) + '" maxlength="500"></label></div>' +
      '<p class="marketing-form-note">O calendário apenas registra o trabalho. Nada é publicado nem enviado pelo sistema. Não inclua dados clínicos ou identificáveis de pacientes.</p>' +
      '<div class="marketing-form-actions"><button type="button" class="marketing-button secondary" data-marketing-action="cancel-edit">Cancelar</button><button type="submit" class="marketing-button">Salvar conteúdo</button></div></form></details>';
  }
  function renderContent() {
    const editing = state.contents.find(function (item) { return text(item.id) === state.editingContent; });
    const rows = state.contents.slice().sort(function (a, b) { return text(a.agendado_em).localeCompare(text(b.agendado_em)); });
    return contentForm(editing) + '<section class="marketing-panel"><header><div><p>Calendário editorial</p><h3>Conteúdos</h3></div></header>' +
      (rows.length ? '<div class="marketing-timeline">' + rows.map(function (item) {
        return '<article class="marketing-content-card"><time>' + safeDateTime(item.agendado_em) + '</time><div><span>' + escapeHtml(item.formato || 'Conteúdo') + ' · ' + escapeHtml(item.pilar || 'Pilar') + '</span><h4>' + escapeHtml(item.titulo || 'Conteúdo') + '</h4>' +
          '<p>' + escapeHtml(item.status || 'ideia') + (item.campanha_nome ? ' · ' + escapeHtml(item.campanha_nome) : '') + '</p><small>Planejamento interno; nenhuma publicação automática.</small></div>' +
          (item.arquivado_em ? '<p class="marketing-muted">Arquivado: ' + escapeHtml(item.motivo_arquivamento || 'motivo protegido registrado') + '</p>' :
            '<div class="marketing-card-actions"><button type="button" class="marketing-button secondary" data-marketing-edit-content="' + escapeHtml(item.id) + '">Editar</button><button type="button" class="marketing-button danger" data-marketing-archive-content="' + escapeHtml(item.id) + '">Arquivar</button></div>') + '</article>';
      }).join('') + '</div>' : emptyState('Nenhum conteúdo planejado.', 'Registre uma ideia, roteiro ou publicação manual.')) + pageButton('contents') + '</section>';
  }
  function render() {
    const content = byId('marketing-content'); if (!content) return;
    if (state.view === 'campaigns') content.innerHTML = renderCampaigns();
    else if (state.view === 'links') content.innerHTML = renderLinks();
    else if (state.view === 'referrals') content.innerHTML = renderReferrals();
    else if (state.view === 'content') content.innerHTML = renderContent();
    else content.innerHTML = renderDashboard();
  }
  function arrayFrom(data, name) { return Array.isArray(data && data[name]) ? data[name] : []; }
  function itemsFrom(data, legacyName) {
    return arrayFrom(data, 'itens').length ? arrayFrom(data, 'itens') : arrayFrom(data, legacyName);
  }
  async function load(force) {
    if (state.loading) return;
    if (state.loaded && !force) { render(); return; }
    setBusy(true); status('Atualizando o Marketing…');
    const content = byId('marketing-content');
    if (content) content.innerHTML = '<div class="marketing-loading">Carregando campanhas e resultados…</div>';
    const period = monthWindow();
    try {
      const results = await Promise.all([
        request('painel', period), request('listar_campanhas'),
        request('listar_lancamentos_disponiveis', { tipo: 'investimento', limit: 50, offset: 0, query: '' }),
        request('listar_lancamentos_disponiveis', { tipo: 'receita', limit: 50, offset: 0, query: '' }),
        request('listar_vinculos'), request('listar_indicacoes'), request('listar_conteudos')
      ]);
      state.dashboard = Object.assign({ periodo: period }, results[0] || {});
      state.campaigns = arrayFrom(results[1], 'campanhas');
      state.availableInvestments = arrayFrom(results[2], 'itens');
      state.availableRevenues = arrayFrom(results[3], 'itens');
      state.launchPages = { investimento: results[2].paginacao || {}, receita: results[3].paginacao || {} };
      state.revenueLeads = arrayFrom(results[3], 'leads_elegiveis');
      state.links = itemsFrom(results[4], 'vinculos');
      state.referrals = itemsFrom(results[5], 'indicacoes');
      state.referralPatients = arrayFrom(results[5], 'pacientes_elegiveis');
      state.referralLeads = arrayFrom(results[5], 'leads_elegiveis');
      state.contents = itemsFrom(results[6], 'conteudos');
      state.pages = { campaigns: results[1].paginacao || {}, links: results[4].paginacao || {},
        referrals: results[5].paginacao || {}, contents: results[6].paginacao || {} };
      state.loaded = true; render(); status('Marketing atualizado.');
      window.dispatchEvent(new CustomEvent('amj:marketing-summary', { detail: Object.freeze({
        campanhas_ativas: state.campaigns.filter(function (item) { return item.status === 'ativa'; }).length,
        conteudos_planejados: state.contents.filter(function (item) { return !item.arquivado_em && !['publicado', 'arquivado'].includes(item.status); }).length
      }) }));
    } catch (error) {
      if (error.code !== 'stale_session' && content) {
        content.innerHTML = '<div class="marketing-error" role="alert"><strong>Não foi possível carregar o Marketing.</strong><span>' + escapeHtml(error.message) + '</span><button type="button" class="marketing-button secondary" data-marketing-action="retry">Tentar novamente</button></div>';
        status(error.message, true);
      }
    } finally { setBusy(false); }
  }
  async function loadMoreLaunches(form) {
    const type = form.elements.tipo.value;
    const page = state.launchPages[type] || {};
    if (page.has_more === false) { status('Todos os lançamentos disponíveis já foram carregados.'); return; }
    const current = type === 'receita' ? state.availableRevenues : state.availableInvestments;
    setBusy(true); status('Carregando mais lançamentos…');
    try {
      const data = await request('listar_lancamentos_disponiveis', { tipo: type, limit: 50, offset: current.length, query: page.query || '' });
      const incoming = itemsFrom(data, 'lancamentos');
      const known = new Set(current.map(function (item) { return text(item.id); }));
      incoming.forEach(function (item) { if (!known.has(text(item.id))) current.push(item); });
      state.launchPages[type] = data.paginacao || {};
      if (type === 'receita') {
        const knownLeads = new Set(state.revenueLeads.map(function (item) { return text(item.id || item.lead_id); }));
        arrayFrom(data, 'leads_elegiveis').forEach(function (item) {
          const id = text(item.id || item.lead_id);
          if (id && !knownLeads.has(id)) { knownLeads.add(id); state.revenueLeads.push(item); }
        });
      }
      syncLinkFields(form);
      status(incoming.length ? 'Mais lançamentos carregados.' : 'Não há outros lançamentos disponíveis.');
    } catch (error) { if (error.code !== 'stale_session') status(error.message, true); }
    finally { setBusy(false); }
  }
  async function loadMoreArea(area) {
    const config = { campaigns: ['listar_campanhas', 'campanhas'], links: ['listar_vinculos', 'vinculos'],
      referrals: ['listar_indicacoes', 'indicacoes'], contents: ['listar_conteudos', 'conteudos'] }[area];
    if (!config) return;
    const target = area === 'campaigns' ? state.campaigns : area === 'links' ? state.links : area === 'referrals' ? state.referrals : state.contents;
    const page = state.pages[area] || {};
    if (page.has_more === false) return status('Todos os registros desta área já foram carregados.');
    setBusy(true); status('Carregando mais registros…');
    try {
      const data = await request(config[0], { limit: 100, offset: target.length });
      const incoming = area === 'campaigns' ? arrayFrom(data, config[1]) : itemsFrom(data, config[1]);
      const known = new Set(target.map(function (item) { return text(item.id); }));
      incoming.forEach(function (item) { if (!known.has(text(item.id))) target.push(item); });
      state.pages[area] = data.paginacao || {};
      render(); status(incoming.length ? 'Mais registros carregados.' : 'Não há outros registros.');
    } catch (error) {
      if (error.code !== 'stale_session') status(error.message || 'Não foi possível carregar mais registros.', true);
    } finally { setBusy(false); }
  }
  function formObject(form) {
    const payload = {};
    new FormData(form).forEach(function (value, key) { payload[key] = text(value) || null; });
    return payload;
  }
  async function saveForm(form) {
    if (!form.reportValidity()) return;
    const kind = form.dataset.marketingForm; const raw = formObject(form);
    let action; let fields; let intent = kind + ':' + (raw.id || 'new'); let expected = raw.version || null;
    if (kind === 'campaign') {
      action = 'salvar_campanha'; fields = { id: raw.id || undefined, payload: { codigo: raw.codigo, nome: raw.nome,
        canal: raw.canal, objetivo: raw.objetivo, inicio: raw.inicio, fim: raw.fim,
        orcamento_planejado: raw.orcamento_planejado == null ? null : Number(raw.orcamento_planejado),
        janela_atribuicao_dias: Number(raw.janela_atribuicao_dias), status: raw.status } };
    } else if (kind === 'referral') {
      action = 'salvar_indicacao'; fields = { id: raw.id || undefined, payload: { indicadora_paciente_id: raw.indicadora_paciente_id,
        lead_indicado_id: raw.lead_indicado_id, origem: raw.origem } };
    } else if (kind === 'content') {
      if (raw.url_publica && !/^https:\/\//i.test(raw.url_publica)) throw new Error('A URL pública precisa começar com https://.');
      action = 'salvar_conteudo'; fields = { id: raw.id || undefined, payload: { titulo: raw.titulo, pilar: raw.pilar,
        formato: raw.formato, canal: raw.canal, status: raw.status, campanha_id: raw.campanha_id,
        agendado_em: saoPauloInputToIso(raw.agendado_em),
        publicado_em: saoPauloInputToIso(raw.publicado_em),
        cta: raw.cta, roteiro: raw.roteiro, url_publica: raw.url_publica } };
    } else return;
    setBusy(true); status('Salvando…');
    try {
      await request(action, fields, { idempotencyKey: intentKey(intent), expectedVersion: expected || 0 });
      clearIntent(intent); state.editingCampaign = ''; state.editingContent = ''; state.loaded = false;
      setBusy(false); await load(true); status('Registro salvo com sucesso.');
    } finally { setBusy(false); }
  }
  async function saveLink(form) {
    if (!form.reportValidity()) return;
    const raw = formObject(form); const name = 'link:' + raw.tipo + ':' + raw.lancamento_id;
    if (raw.tipo === 'receita' && !raw.lead_id) throw new Error('Selecione o lead convertido retornado pelo sistema.');
    setBusy(true); status('Aguardando confirmação segura…');
    try {
      await protectedRequest('vincular_lancamento', { campanha_id: raw.campanha_id,
        lancamento_id: raw.lancamento_id, tipo: raw.tipo, lead_id: raw.tipo === 'receita' ? raw.lead_id : null },
      { titulo: 'Vincular lançamento à campanha', motivo: 'Confirmar atribuição financeira manual', motivoObrigatorio: true,
        idempotencyKey: intentKey(name) });
      clearIntent(name); state.loaded = false; setBusy(false); await load(true); status('Lançamento atribuído com auditoria.');
    } finally { setBusy(false); }
  }
  async function protectedMutation(action, fields, expectedVersion, label) {
    const id = fields.id || fields.vinculo_id || fields.indicacao_id || fields.conteudo_id;
    const name = action + ':' + id; setBusy(true); status('Aguardando confirmação segura…');
    try {
      await protectedRequest(action, fields, { titulo: label, motivo: 'Registrar o motivo desta alteração no Marketing',
        motivoObrigatorio: true, idempotencyKey: intentKey(name), expectedVersion: expectedVersion });
      clearIntent(name); state.loaded = false; setBusy(false); await load(true); status('Alteração concluída e auditada.');
    } finally { setBusy(false); }
  }
  function findById(rows, id) { return rows.find(function (item) { return text(item.id) === text(id); }); }
  function syncLinkFields(form) {
    const type = form.elements.tipo.value;
    const launches = type === 'receita' ? state.availableRevenues : state.availableInvestments;
    const selectedLaunch = form.elements.lancamento_id.value;
    const selectedLead = form.elements.lead_id.value;
    form.elements.lancamento_id.innerHTML = availableLaunchOptions(launches);
    if (launches.some(function (item) { return text(item.id) === text(selectedLaunch); })) form.elements.lancamento_id.value = selectedLaunch;
    const leadField = form.querySelector('[data-marketing-lead-field]');
    leadField.hidden = type !== 'receita'; form.elements.lead_id.required = type === 'receita';
    if (type !== 'receita') form.elements.lead_id.value = '';
    else {
      const launch = findById(state.availableRevenues, form.elements.lancamento_id.value);
      const campaignId = text(form.elements.campanha_id.value);
      const eligible = state.revenueLeads.filter(function (lead) {
        return launch && text(lead.campaign_id) === campaignId && text(lead.patient_id) === text(launch.patient_id);
      });
      form.elements.lead_id.innerHTML = safeEntityOptions(eligible, selectedLead, eligible.length ? 'Selecione' : 'Nenhum lead elegível para esta combinação');
    }
    const more = form.querySelector('[data-marketing-more-launches]');
    if (more) more.hidden = (state.launchPages[type] || {}).has_more === false;
  }
  function bind() {
    if (state.bound || !state.root) return; state.bound = true;
    state.root.addEventListener('click', function (event) {
      const view = event.target.closest('[data-marketing-view]');
      if (view) {
        state.view = view.dataset.marketingView; state.editingCampaign = ''; state.editingContent = '';
        state.root.querySelectorAll('[data-marketing-view]').forEach(function (button) { button.setAttribute('aria-pressed', String(button === view)); });
        render(); const content = byId('marketing-content'); if (content) content.focus({ preventScroll: true }); return;
      }
      const action = event.target.closest('[data-marketing-action]');
      if (action) {
        if (['refresh', 'retry'].includes(action.dataset.marketingAction)) void load(true);
        else if (action.dataset.marketingAction === 'cancel-edit') { state.editingCampaign = ''; state.editingContent = ''; render(); }
        return;
      }
      const editCampaign = event.target.closest('[data-marketing-edit-campaign]');
      if (editCampaign) { state.editingCampaign = editCampaign.dataset.marketingEditCampaign; render(); return; }
      const editContent = event.target.closest('[data-marketing-edit-content]');
      if (editContent) { state.editingContent = editContent.dataset.marketingEditContent; render(); return; }
      const moreLaunches = event.target.closest('[data-marketing-more-launches]');
      if (moreLaunches) { const form = moreLaunches.closest('[data-marketing-form="link"]'); if (form) void loadMoreLaunches(form); return; }
      const moreArea = event.target.closest('[data-marketing-more-area]');
      if (moreArea) { void loadMoreArea(moreArea.dataset.marketingMoreArea); return; }
      const archiveCampaign = event.target.closest('[data-marketing-archive-campaign]');
      if (archiveCampaign) { const row = findById(state.campaigns, archiveCampaign.dataset.marketingArchiveCampaign); if (row) void protectedMutation('arquivar_campanha', { id: row.id }, row.version, 'Arquivar campanha'); return; }
      const cancelLink = event.target.closest('[data-marketing-cancel-link]');
      if (cancelLink) { const row = findById(state.links, cancelLink.dataset.marketingCancelLink); if (row) void protectedMutation('cancelar_vinculo', { vinculo_id: row.id }, row.version, 'Cancelar vínculo financeiro'); return; }
      const cancelReferral = event.target.closest('[data-marketing-cancel-referral]');
      if (cancelReferral) { const row = findById(state.referrals, cancelReferral.dataset.marketingCancelReferral); if (row) void protectedMutation('cancelar_indicacao', { indicacao_id: row.id }, row.version, 'Cancelar indicação'); return; }
      const archiveContent = event.target.closest('[data-marketing-archive-content]');
      if (archiveContent) { const row = findById(state.contents, archiveContent.dataset.marketingArchiveContent); if (row) void protectedMutation('arquivar_conteudo', { id: row.id }, row.version, 'Arquivar conteúdo'); }
    });
    state.root.addEventListener('change', function (event) {
      const form = event.target.closest('[data-marketing-form="link"]');
      if (form && ['tipo', 'campanha_id', 'lancamento_id'].includes(event.target.name)) syncLinkFields(form);
      const anyForm = event.target.closest('[data-marketing-form]'); if (anyForm) state.intents = Object.create(null);
    });
    state.root.addEventListener('input', function (event) {
      const form = event.target.closest('[data-marketing-form]'); if (form) state.intents = Object.create(null);
    });
    state.root.addEventListener('submit', function (event) {
      const form = event.target.closest('[data-marketing-form]'); if (!form) return;
      event.preventDefault(); const promise = form.dataset.marketingForm === 'link' ? saveLink(form) : saveForm(form);
      promise.catch(function (error) { if (error.code !== 'stale_session') status(error.message, true); setBusy(false); });
    });
  }
  function mount(target) {
    if (state.root) return true;
    state.root = typeof target === 'string' ? document.querySelector(target) : target;
    if (!state.root) state.root = byId('marketing-root');
    if (!state.root) return false;
    state.root.innerHTML = shellHtml(); bind(); updateAccess(); return true;
  }
  function updateAccess() {
    if (!state.root) return;
    state.root.hidden = !ownerAccess();
    if (ownerAccess() && !state.loaded) void load(false);
  }
  function activate() { mount(); updateAccess(); if (ownerAccess()) void load(false); }
  function reset() {
    state.generation += 1; state.controllers.forEach(function (controller) { controller.abort(); }); state.controllers.clear();
    state.loaded = false; state.loading = false; state.view = 'dashboard'; state.campaigns = []; state.links = [];
    state.availableInvestments = []; state.availableRevenues = []; state.revenueLeads = []; state.launchPages = {}; state.referrals = [];
    state.referralPatients = []; state.referralLeads = []; state.contents = []; state.dashboard = {}; state.pages = {};
    state.intents = Object.create(null); state.editingCampaign = ''; state.editingContent = '';
    if (state.root) { state.root.innerHTML = shellHtml(); state.root.hidden = true; }
  }

  window.AMJMarketing = Object.freeze({ montar: mount, ativar: activate, carregar: load,
    atualizarAcesso: updateAccess, reset: reset,
    contrato: Object.freeze({ endpoint: API, campanhaEstruturada: true, mensagensAutomaticas: false,
      publicacaoAutomatica: false, atribuicaoFinanceira: 'vinculo_manual' }),
    __test: Object.freeze({ money: money, count: count, ratio: ratio, parseMoney: parseMoney,
      monthWindow: monthWindow, dateTimeLocal: dateTimeLocal, safeDateTime: safeDateTime, saoPauloInputToIso: saoPauloInputToIso }) });
}());

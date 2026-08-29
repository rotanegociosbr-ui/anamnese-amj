(function () {
  'use strict';

  const API = 'https://rjxtxoqprnumouqakxbc.supabase.co/functions/v1/crm-fichas';
  const STAGES = Object.freeze([
    ['lead_novo', 'Lead novo'],
    ['primeiro_atendimento', 'Primeiro atendimento'],
    ['interessada', 'Interessada'],
    ['avaliacao_sugerida', 'Avaliação sugerida'],
    ['avaliacao_agendada', 'Avaliação agendada'],
    ['avaliacao_realizada', 'Avaliação realizada'],
    ['plano_apresentado', 'Plano apresentado'],
    ['proposta_enviada', 'Proposta enviada'],
    ['aguardando_decisao', 'Aguardando decisão'],
    ['procedimento_agendado', 'Procedimento agendado'],
    ['convertida', 'Convertida'],
    ['nao_convertida', 'Não convertida'],
    ['reativacao_futura', 'Reativação futura']
  ]);
  const CLOSED_STAGES = new Set(['convertida', 'nao_convertida', 'arquivada']);
  const ORIGINS = Object.freeze([
    ['instagram_organico', 'Instagram orgânico'], ['instagram_ads', 'Instagram Ads'],
    ['facebook', 'Facebook'], ['google', 'Google'], ['google_maps', 'Google Maps'],
    ['indicacao', 'Indicação'], ['paciente_atual', 'Paciente atual'], ['influenciadora', 'Influenciadora'],
    ['site', 'Site'], ['whatsapp', 'WhatsApp'], ['evento', 'Evento'], ['parceria', 'Parceria'], ['outro', 'Outro']
  ]);
  const NEXT_ACTION_TYPES = Object.freeze([
    ['whatsapp', 'Enviar WhatsApp'], ['ligacao', 'Fazer ligação'], ['email', 'Enviar e-mail'],
    ['agendar_avaliacao', 'Agendar avaliação'], ['confirmar_agendamento', 'Confirmar agendamento'],
    ['retorno_comercial', 'Fazer retorno comercial'], ['reativar', 'Reativar contato'], ['outro', 'Outra ação']
  ]);
  const SITE_REQUEST_STATUS = Object.freeze({
    pending: 'Novo', pendente: 'Novo', new: 'Novo', novo: 'Novo',
    accepted: 'Aceito', aceito: 'Aceito', converted: 'Aceito', convertido: 'Aceito',
    archived: 'Arquivado', arquivado: 'Arquivado'
  });
  const SITE_FIRST_VISIT = Object.freeze({
    primeira_avaliacao: 'Primeira avaliação', paciente_atual: 'Já é paciente'
  });
  const SITE_PERIODS = Object.freeze({
    manha: 'Manhã', tarde: 'Tarde', noite: 'Noite', a_combinar: 'A combinar'
  });
  const SITE_INTERESTS = Object.freeze({
    avaliacao_sem_procedimento: 'Avaliação sem procedimento definido', preenchimento_facial: 'Preenchimento facial',
    skinbooster: 'Skinbooster', toxina_botulinica: 'Toxina botulínica', fios_pdo: 'Fios de PDO',
    intradermoterapia_facial: 'Intradermoterapia facial', intradermoterapia_capilar: 'Intradermoterapia capilar',
    peeling: 'Peeling', microagulhamento_facial: 'Microagulhamento facial',
    microagulhamento_capilar: 'Microagulhamento capilar', harmonizacao_facial: 'Harmonização facial',
    aplicacao_intramuscular: 'Aplicação intramuscular com prescrição', retorno_acompanhamento: 'Retorno ou acompanhamento'
  });
  const CLINIC_TIME_ZONE = 'America/Sao_Paulo';
  const DATE_TIME = new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'short', timeStyle: 'short', timeZone: CLINIC_TIME_ZONE
  });
  const CLINIC_DATE_PARTS = new Intl.DateTimeFormat('en-CA', {
    timeZone: CLINIC_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  });
  const state = {
    root: null, loaded: false, loading: false, leads: [], owners: [], campaigns: [], summary: {},
    siteRequests: [], siteBusy: new Set(),
    view: 'list', generation: 0, controllers: new Set(), intentKeys: Object.create(null),
    conversion: null, conversionReturnFocus: null, specialFilter: '', editingId: '', bound: false,
    loadPromise: null, pagination: {}, loadingMore: false
  };

  function byId(id) { return document.getElementById(id); }
  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }
  function text(value) { return String(value == null ? '' : value).trim(); }
  function normalize(value) {
    return text(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
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
  function ownerAccess() {
    try {
      return typeof modoAcesso !== 'undefined' && modoAcesso === 'auth' &&
        typeof identidadeBackend !== 'undefined' && identidadeBackend &&
        String(identidadeBackend.role || '').toLowerCase() === 'owner';
    } catch (_) { return false; }
  }
  function staleError() {
    const error = new Error('Sessão do CRM encerrada.');
    error.code = 'stale_session';
    return error;
  }
  function stageLabel(value) {
    const found = STAGES.find(function (stage) { return stage[0] === value; });
    return found ? found[1] : (text(value) || 'Sem etapa');
  }
  function originLabel(value) {
    const found = ORIGINS.find(function (origin) { return origin[0] === value; });
    if (value === 'instagram') return 'Instagram (registro legado)';
    if (value === 'telefone') return 'Telefone (registro legado)';
    return found ? found[1] : (text(value) || 'Não informada');
  }
  function preserveLegacyOrigin(select, value) {
    if (!select) return;
    select.querySelectorAll('option[data-crm-legacy-origin]').forEach(function (option) { option.remove(); });
    if (!['instagram', 'telefone'].includes(text(value))) return;
    const option = document.createElement('option');
    option.value = text(value); option.textContent = originLabel(value); option.dataset.crmLegacyOrigin = '1';
    select.appendChild(option);
  }
  function safeDateTime(value) {
    const date = new Date(text(value));
    return Number.isFinite(date.getTime()) ? DATE_TIME.format(date) : '—';
  }
  function clinicParts(value) {
    const parts = {};
    CLINIC_DATE_PARTS.formatToParts(value).forEach(function (part) {
      if (part.type !== 'literal') parts[part.type] = part.value;
    });
    return parts;
  }
  function localNow() {
    const parts = clinicParts(new Date());
    return parts.year + '-' + parts.month + '-' + parts.day + 'T' + parts.hour + ':' + parts.minute;
  }
  function dateInput(value) {
    if (!value) return '';
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return text(value).slice(0, 16);
    const parts = clinicParts(date);
    return parts.year + '-' + parts.month + '-' + parts.day + 'T' + parts.hour + ':' + parts.minute;
  }
  function toClinicIso(value) {
    const raw = text(value);
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(raw);
    if (!match) return raw || null;
    const wanted = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]),
      Number(match[4]), Number(match[5]), Number(match[6] || 0));
    let instant = wanted;
    for (let pass = 0; pass < 3; pass += 1) {
      const parts = clinicParts(new Date(instant));
      const represented = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day),
        Number(parts.hour), Number(parts.minute), Number(parts.second));
      instant += wanted - represented;
    }
    const date = new Date(instant);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }
  function leadStage(lead) { return text(lead.estagio || lead.stage || lead.stage_code); }
  function recordStatus(lead) {
    const explicit = text(lead.record_status || lead.status).toLowerCase();
    if (['active', 'converted', 'lost', 'cancelled', 'archived'].includes(explicit)) return explicit;
    if (lead.arquivado === true || lead.archived === true || leadStage(lead) === 'arquivada') return 'archived';
    if (leadStage(lead) === 'convertida') return 'converted';
    if (leadStage(lead) === 'nao_convertida') return 'lost';
    return 'active';
  }
  function isOpen(lead) { return recordStatus(lead) === 'active' && !CLOSED_STAGES.has(leadStage(lead)); }
  function isOverdue(lead) {
    const value = lead.proxima_acao_em || lead.next_action_at;
    const due = new Date(value || '').getTime();
    return isOpen(lead) && Number.isFinite(due) && due < Date.now();
  }
  function leadId(lead) { return text(lead.id || lead.lead_id); }
  function leadVersion(lead) { return lead.version == null ? lead.versao : lead.version; }
  function ownerName(lead) {
    return text(lead.responsavel_nome || lead.owner_name || lead.responsavel && lead.responsavel.nome) || 'Não definido';
  }
  function contact(lead) {
    return text(lead.telefone || lead.phone || lead.email) || 'Contato não informado';
  }
  function nextActionTypeLabel(value) {
    const found = NEXT_ACTION_TYPES.find(function (item) { return item[0] === text(value); });
    return found ? found[1] : (text(value) || 'Não definida');
  }
  function siteRequestId(item) { return text(item && (item.id || item.solicitacao_id || item.request_id)); }
  function siteRequestVersion(item) {
    const value = item && (item.version == null ? item.versao : item.version);
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  }
  function siteRequestStatus(item) {
    return text(item && (item.status || item.record_status || item.estado)).toLowerCase() || 'pendente';
  }
  function siteRequestPending(item) {
    return ['pending', 'pendente', 'new', 'novo'].includes(siteRequestStatus(item));
  }
  function siteRequestPhone(item) {
    return text(item && (item.telefone || item.phone || item.whatsapp));
  }
  function siteWhatsAppNumber(value) {
    let digits = text(value).replace(/\D/g, '');
    if (digits.startsWith('55') && (digits.length === 12 || digits.length === 13)) digits = digits.slice(2);
    return digits.length === 10 || digits.length === 11 ? '55' + digits : '';
  }
  function siteDate(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text(value));
    return match ? match[3] + '/' + match[2] + '/' + match[1] : (text(value) || 'A combinar');
  }
  function siteWhatsAppUrl(item) {
    const number = siteWhatsAppNumber(siteRequestPhone(item));
    if (!number) return '';
    const name = text(item.nome || item.full_name || item.name);
    const firstName = name.split(/\s+/).filter(Boolean)[0] || '';
    const interestCode = text(item.interesse || item.interest);
    const interest = SITE_INTERESTS[interestCode] || interestCode || 'avaliação estética';
    const message = 'Olá' + (firstName ? ', ' + firstName : '') +
      '! Recebemos sua solicitação pelo site da Ana Maria Jacob Estética sobre ' + interest +
      '. Vamos conversar para confirmar a melhor disponibilidade?';
    return 'https://wa.me/' + number + '?text=' + encodeURIComponent(message);
  }

  async function request(action, payload, options) {
    const generation = state.generation;
    const controller = new AbortController();
    state.controllers.add(controller);
    options = options || {};
    try {
      if (!ownerAccess()) throw new Error('O CRM exige conta proprietária individual com MFA.');
      const headers = await cabecalhosAcesso(true, options.proof);
      if (generation !== state.generation || !ownerAccess()) throw staleError();
      const body = {
        action: action,
        payload: payload || {},
        idempotency_key: options.idempotencyKey || uuid(),
        expected_version: options.expectedVersion == null ? null : options.expectedVersion
      };
      const response = await fetch(API, {
        method: 'POST', headers: headers, cache: 'no-store', referrerPolicy: 'no-referrer',
        signal: controller.signal, body: JSON.stringify(body)
      });
      let data = {};
      try { data = await response.json(); } catch (_) { data = {}; }
      if (generation !== state.generation || !ownerAccess()) throw staleError();
      if (!response.ok || data.erro || data.error) {
        const error = new Error(data.erro || data.error || 'Não foi possível concluir a operação no CRM.');
        error.code = data.codigo || data.code || String(response.status);
        throw error;
      }
      if (data.identity && typeof atualizarIdentidade === 'function') atualizarIdentidade(data);
      return data;
    } catch (error) {
      if (generation !== state.generation || error.name === 'AbortError') throw staleError();
      throw error;
    } finally { state.controllers.delete(controller); }
  }

  async function protectedRequest(action, payload, options) {
    if (!window.AMJProtecao || typeof window.AMJProtecao.solicitarSenhaRecente !== 'function') {
      throw new Error('A confirmação segura por senha não está disponível. Atualize a página.');
    }
    let proof = null;
    try {
      proof = await window.AMJProtecao.solicitarSenhaRecente(options || {});
      return await request(action, Object.assign({}, payload || {}, {
        operation_id: proof.operation_id,
        motivo: proof.motivo || 'Alteração comercial confirmada pela gestão'
      }), { proof: proof, idempotencyKey: options && options.idempotencyKey,
        expectedVersion: options && options.expectedVersion });
    } finally {
      if (proof && typeof proof.encerrar === 'function') await proof.encerrar();
    }
  }

  function setStatus(message, error) {
    const node = byId('crm-status');
    if (!node) return;
    node.textContent = message || '';
    node.classList.toggle('erro', Boolean(error));
  }
  function setBusy(container, busy) {
    if (!container) return;
    container.setAttribute('aria-busy', String(Boolean(busy)));
    container.querySelectorAll('button,input,select,textarea').forEach(function (control) {
      if (busy && !control.disabled) { control.disabled = true; control.dataset.crmBusy = '1'; }
      else if (!busy && control.dataset.crmBusy === '1') { control.disabled = false; delete control.dataset.crmBusy; }
    });
  }
  function options(rows, selected) {
    return rows.map(function (row) {
      return '<option value="' + escapeHtml(row[0]) + '"' + (row[0] === selected ? ' selected' : '') + '>' +
        escapeHtml(row[1]) + '</option>';
    }).join('');
  }

  function shellHtml() {
    return '<section class="crm-shell" aria-labelledby="crm-title">' +
      '<header class="crm-header"><div><p>Relacionamento comercial</p><h2 id="crm-title">CRM Leads</h2>' +
      '<span>Cadastre apenas informações comerciais. Dados clínicos pertencem ao prontuário.</span></div>' +
      '<div class="crm-header-actions"><button type="button" class="crm-secondary" data-crm-action="refresh">Atualizar</button>' +
      '<button type="button" class="crm-primary" data-crm-action="new">Novo lead</button></div></header>' +
      '<p id="crm-status" class="crm-status" role="status" aria-live="polite"></p>' +
      '<div class="crm-kpis" aria-label="Resumo do CRM"><button type="button" data-crm-special="abertos"><span id="crm-kpi-open-label">Em andamento</span><strong id="crm-kpi-open">—</strong></button>' +
      '<button type="button" data-crm-special="vencidos"><span id="crm-kpi-overdue-label">Ações vencidas</span><strong id="crm-kpi-overdue">—</strong></button>' +
      '<div><span id="crm-kpi-unanswered-label">Sem primeira resposta</span><strong id="crm-kpi-unanswered">—</strong></div>' +
      '<div><span id="crm-kpi-total-label">Total visível</span><strong id="crm-kpi-total">—</strong></div></div>' +
      '<section class="crm-site-inbox" aria-labelledby="crm-site-title"><header><div><p>Captação interna do site</p>' +
      '<h3 id="crm-site-title">Pedidos de agendamento</h3><span>O pedido é salvo antes de a pessoa abrir o WhatsApp.</span></div>' +
      '<strong id="crm-site-count" role="status" aria-live="polite" aria-atomic="true">— pendentes</strong></header>' +
      '<div id="crm-site-content" class="crm-site-content"></div></section>' +
      '<details id="crm-editor" class="crm-editor"><summary>Novo cadastro comercial</summary>' + editorHtml() + '</details>' +
      '<section id="crm-conversion" class="crm-conversion" role="region" aria-label="Revisão de conversão" tabindex="-1" hidden></section>' +
      '<section class="crm-workspace" aria-labelledby="crm-workspace-title"><div class="crm-workspace-title"><div><p>Funil</p>' +
      '<h3 id="crm-workspace-title" tabindex="-1">Leads e próximas ações</h3></div><div class="crm-view-toggle" aria-label="Modo de visualização">' +
      '<button type="button" data-crm-view="list" aria-pressed="true">Lista</button><button type="button" data-crm-view="kanban" aria-pressed="false">Kanban</button></div></div>' +
      filtersHtml() + '<p id="crm-results-status" class="crm-visually-hidden" role="status" aria-live="polite" aria-atomic="true"></p>' +
      '<div id="crm-content" class="crm-content"></div></section></section>';
  }

  function editorHtml() {
    return '<form id="crm-form" novalidate><input type="hidden" name="lead_id"><input type="hidden" name="expected_version">' +
      '<div class="crm-quick-grid"><label><span>Nome</span><input name="nome" maxlength="120" autocomplete="name" required></label>' +
      '<label><span>Telefone</span><input name="telefone" maxlength="24" inputmode="tel" autocomplete="tel"></label>' +
      '<label><span>E-mail</span><input name="email" type="email" maxlength="160" autocomplete="email"></label>' +
      '<label><span>Origem</span><select name="origem" required><option value="">Selecione</option>' + options(ORIGINS, '') + '</select></label>' +
      '<label><span>Interesse</span><input name="interesse" maxlength="120" required placeholder="Ex.: avaliação estética"></label>' +
      '<label><span>Etapa</span><select name="estagio" required>' + options(STAGES.filter(function (stage) { return stage[0] !== 'convertida'; }), 'lead_novo') + '</select></label></div>' +
      '<details class="crm-progressive"><summary>Complementar cadastro e acompanhamento</summary><div class="crm-detail-grid">' +
      '<label><span>Suborigem</span><input name="suborigem" maxlength="100" placeholder="Ex.: story, formulário"></label>' +
      '<label><span>Campanha</span><select name="campanha_id" aria-describedby="crm-campaign-help"><option value="">Sem campanha</option></select><small id="crm-campaign-help">Selecione o cadastro canônico do Marketing. Não digite nomes livres.</small></label>' +
      '<label><span>Responsável</span><select name="responsavel_id" required><option value="">Selecione</option></select></label>' +
      '<label><span>Primeira resposta</span><span class="crm-inline"><input name="primeira_resposta_em" type="datetime-local" aria-describedby="crm-first-response-help"><button type="button" data-crm-action="responded-now">Agora</button></span>' +
      '<small id="crm-first-response-help" hidden>A primeira resposta já registrada é uma marca histórica e não pode ser alterada.</small></label>' +
      '<label id="crm-next-type-label"><span>Tipo da próxima ação</span><select name="next_action_type"><option value="">Selecione</option>' + options(NEXT_ACTION_TYPES, '') + '</select></label>' +
      '<label id="crm-next-label"><span>Próxima ação</span><input name="proxima_acao_em" type="datetime-local"></label>' +
      '<label id="crm-loss-label" hidden><span>Motivo de não conversão</span><input name="motivo_perda" maxlength="240"></label>' +
      '<label class="crm-wide"><span>Observações comerciais</span><textarea name="observacoes" maxlength="1000" rows="3" placeholder="Não registre anamnese, diagnóstico, fotos ou dados clínicos."></textarea></label>' +
      '</div></details><p class="crm-form-hint">Informe telefone ou e-mail. Leads em andamento precisam de responsável e próxima ação.</p>' +
      '<div class="crm-form-actions"><button type="button" class="crm-secondary" data-crm-action="cancel-edit">Cancelar</button>' +
      '<button type="submit" class="crm-primary">Salvar lead</button></div></form>';
  }

  function filtersHtml() {
    return '<div class="crm-filters"><label class="crm-search"><span>Buscar</span><input id="crm-search" type="search" placeholder="Nome, contato, campanha ou interesse"></label>' +
      '<label><span>Etapa</span><select id="crm-filter-stage"><option value="">Todas</option>' + options(STAGES, '') + '</select></label>' +
      '<label><span>Origem</span><select id="crm-filter-origin"><option value="">Todas</option>' + options(ORIGINS, '') + '</select></label>' +
      '<label><span>Responsável</span><select id="crm-filter-owner"><option value="">Todos</option></select></label>' +
      '<label class="crm-check"><input id="crm-filter-archived" type="checkbox"><span>Mostrar arquivados/cancelados</span></label>' +
      '<button type="button" class="crm-link" data-crm-action="clear-filters">Limpar filtros</button></div>';
  }

  function normalizeLead(raw) {
    const lead = raw && typeof raw === 'object' ? raw : {};
    if (!lead.estagio && (lead.stage || lead.stage_code)) lead.estagio = lead.stage || lead.stage_code;
    if (!lead.nome && (lead.name || lead.full_name)) lead.nome = lead.name || lead.full_name;
    return lead;
  }
  function responseRows(data) {
    const rows = data.leads || data.items || data.dados && (data.dados.leads || data.dados.items) || [];
    return Array.isArray(rows) ? rows.map(normalizeLead) : [];
  }
  function responseOwners(data) {
    const rows = data.responsaveis || data.owners || data.dados && (data.dados.responsaveis || data.dados.owners) || [];
    return Array.isArray(rows) ? rows : [];
  }
  function responseCampaigns(data) {
    const rows = data.campanhas_ativas || data.active_campaigns || data.dados && data.dados.campanhas_ativas || [];
    return Array.isArray(rows) ? rows : [];
  }
  function responseSiteRequests(data) {
    const rows = data.solicitacoes_site || data.site_requests ||
      data.dados && (data.dados.solicitacoes_site || data.dados.site_requests) || [];
    return Array.isArray(rows) ? rows.filter(function (item) { return siteRequestId(item); }) : [];
  }
  function responseSummary(data) {
    const summary = data.resumo || data.summary || data.dados && (data.dados.resumo || data.dados.summary) || {};
    return summary && typeof summary === 'object' ? summary : {};
  }
  function sitePendingCount() {
    const explicit = Number(state.summary.solicitacoes_site_pendentes == null
      ? state.summary.pending_site_requests : state.summary.solicitacoes_site_pendentes);
    return Number.isInteger(explicit) && explicit >= 0
      ? explicit : state.siteRequests.filter(siteRequestPending).length;
  }
  function mergeById(current, incoming, idResolver) {
    const result = current.slice();
    const known = new Set(result.map(idResolver).filter(Boolean));
    incoming.forEach(function (item) {
      const id = idResolver(item);
      if (id && !known.has(id)) { known.add(id); result.push(item); }
    });
    return result;
  }
  function fillOwners() {
    const rows = state.owners.map(function (owner) {
      return [text(owner.id || owner.user_id), text(owner.nome || owner.name || owner.email)];
    }).filter(function (row) { return row[0] && row[1]; });
    ['crm-filter-owner'].forEach(function (id) {
      const select = byId(id); if (select) select.innerHTML = '<option value="">Todos</option>' + options(rows, select.value);
    });
    const formSelect = state.root.querySelector('[name="responsavel_id"]');
    if (formSelect) formSelect.innerHTML = '<option value="">Selecione</option>' + options(rows, formSelect.value);
  }
  function fillCampaigns(selected) {
    const select = state.root && state.root.querySelector('[name="campanha_id"]');
    if (!select) return;
    const current = text(selected || select.value);
    select.innerHTML = '<option value="">Sem campanha</option>' + state.campaigns.map(function (campaign) {
      const id = text(campaign.id);
      if (!id) return '';
      const selectable = campaign.selecionavel !== false;
      const historical = !selectable ? ' · ' + text(campaign.status || 'histórica') : '';
      const label = (campaign.codigo ? text(campaign.codigo) + ' · ' : '') + text(campaign.nome || 'Campanha') + historical;
      return '<option value="' + escapeHtml(id) + '"' + (id === current ? ' selected' : '') +
        (!selectable && id !== current ? ' disabled' : '') + '>' + escapeHtml(label) + '</option>';
    }).join('');
  }

  function calculateSummary(visibleRows) {
    const operational = state.leads.filter(function (lead) {
      return !['archived', 'cancelled'].includes(recordStatus(lead));
    });
    const open = operational.filter(isOpen).length;
    const overdue = operational.filter(isOverdue).length;
    const unanswered = operational.filter(function (lead) {
      return isOpen(lead) && !text(lead.primeira_resposta_em || lead.first_response_at);
    }).length;
    return { open: open, overdue: overdue, unanswered: unanswered,
      total: Array.isArray(visibleRows) ? visibleRows.length : state.leads.length };
  }
  function updateSummary(visibleRows) {
    const summary = calculateSummary(visibleRows);
    const partial = state.pagination && state.pagination.has_more === true;
    byId('crm-kpi-open-label').textContent = partial ? 'Em andamento (carregados)' : 'Em andamento';
    byId('crm-kpi-overdue-label').textContent = partial ? 'Ações vencidas (carregadas)' : 'Ações vencidas';
    byId('crm-kpi-unanswered-label').textContent = partial ? 'Sem resposta (carregados)' : 'Sem primeira resposta';
    byId('crm-kpi-total-label').textContent = partial ? 'Total visível carregado' : 'Total visível';
    byId('crm-kpi-open').textContent = summary.open;
    byId('crm-kpi-overdue').textContent = summary.overdue;
    byId('crm-kpi-unanswered').textContent = summary.unanswered;
    byId('crm-kpi-total').textContent = summary.total;
    window.dispatchEvent(new CustomEvent('amj:crm-summary', { detail: Object.freeze(summary) }));
  }
  function filteredLeads() {
    const query = normalize(byId('crm-search').value);
    const stage = byId('crm-filter-stage').value;
    const origin = byId('crm-filter-origin').value;
    const owner = byId('crm-filter-owner').value;
    const archived = byId('crm-filter-archived').checked;
    return state.leads.filter(function (lead) {
      const stageValue = leadStage(lead);
      if (!archived && ['archived', 'cancelled'].includes(recordStatus(lead))) return false;
      if (stage && stageValue !== stage) return false;
      if (origin && text(lead.origem || lead.origin) !== origin) return false;
      if (owner && text(lead.responsavel_id || lead.owner_id) !== owner) return false;
      if (state.specialFilter === 'abertos' && !isOpen(lead)) return false;
      if (state.specialFilter === 'vencidos' && !isOverdue(lead)) return false;
      if (!query) return true;
      return normalize([lead.nome, lead.telefone, lead.email, lead.campanha_nome || lead.campaign_name || lead.campanha, lead.interesse,
        lead.suborigem, ownerName(lead)].join(' ')).includes(query);
    });
  }

  function historyHtml(lead) {
    const history = lead.historico || lead.history || [];
    if (!Array.isArray(history) || !history.length) return '<p>Sem eventos exibidos.</p>';
    return '<ol>' + history.map(function (event) {
      return '<li><strong>' + escapeHtml(event.descricao || event.description || event.acao || 'Atualização') + '</strong>' +
        '<span>' + escapeHtml(safeDateTime(event.criado_em || event.created_at)) + '</span></li>';
    }).join('') + '</ol>';
  }
  function leadCard(lead, compact) {
    const id = leadId(lead);
    const stage = leadStage(lead);
    const status = recordStatus(lead);
    const source = originLabel(lead.origem || lead.origin) + (text(lead.suborigem) ? ' · ' + text(lead.suborigem) : '');
    const nextType = lead.next_action_type || lead.proxima_acao_tipo;
    const lossReason = text(lead.motivo_perda || lead.loss_reason);
    const canEdit = status === 'active' || status === 'lost';
    const canArchive = status === 'active' || status === 'lost';
    const actions = (canEdit ? '<button type="button" data-crm-edit="' + escapeHtml(id) + '">Editar</button>' : '') +
      (isOpen(lead) ? '<button type="button" data-crm-convert="' + escapeHtml(id) + '">Converter</button>' : '') +
      (canArchive ? '<button type="button" class="crm-danger" data-crm-archive="' + escapeHtml(id) + '">Arquivar</button>' : '');
    return '<article class="crm-lead-card' + (isOverdue(lead) ? ' is-overdue' : '') + '"' +
      (compact ? '' : ' role="listitem"') + ' data-crm-lead-id="' + escapeHtml(id) + '">' +
      '<header><div><h4>' + escapeHtml(lead.nome || 'Lead sem nome') + '</h4><span>' + escapeHtml(contact(lead)) + '</span></div>' +
      '<span class="crm-stage">' + escapeHtml(stageLabel(stage)) + '</span></header>' +
      '<dl><div><dt>Origem</dt><dd>' + escapeHtml(source) + '</dd></div><div><dt>Interesse</dt><dd>' + escapeHtml(lead.interesse || 'Não informado') + '</dd></div>' +
      (compact ? '' : '<div><dt>Campanha</dt><dd>' + escapeHtml(lead.campanha_nome || lead.campaign_name || lead.campanha || '—') + '</dd></div>') +
      '<div><dt>Responsável</dt><dd>' + escapeHtml(ownerName(lead)) + '</dd></div><div><dt>Primeira resposta</dt><dd>' + escapeHtml(safeDateTime(lead.primeira_resposta_em || lead.first_response_at)) + '</dd></div>' +
      '<div><dt>Próxima ação</dt><dd>' + escapeHtml(nextActionTypeLabel(nextType)) + ' · ' +
      (isOverdue(lead) ? '<strong class="crm-overdue">Vencida · ' : '') + escapeHtml(safeDateTime(lead.proxima_acao_em || lead.next_action_at)) + (isOverdue(lead) ? '</strong>' : '') + '</dd></div>' +
      (status === 'lost' && lossReason ? '<div><dt>Motivo da não conversão</dt><dd>' + escapeHtml(lossReason) + '</dd></div>' : '') + '</dl>' +
      '<details class="crm-history"><summary>Histórico</summary>' + historyHtml(lead) + '</details>' +
      (actions ? '<div class="crm-card-actions">' + actions + '</div>' : '') + '</article>';
  }
  function renderList(rows) {
    return '<div class="crm-list" role="list">' + rows.map(function (lead) { return leadCard(lead, false); }).join('') + '</div>';
  }
  function renderKanban(rows) {
    return '<div class="crm-kanban" aria-label="Kanban com 13 etapas. A movimentação é feita somente pela edição do lead.">' +
      STAGES.map(function (stage) {
        const cards = rows.filter(function (lead) { return leadStage(lead) === stage[0]; });
        return '<section class="crm-kanban-column" aria-labelledby="crm-column-' + stage[0] + '"><header><h4 id="crm-column-' + stage[0] + '">' +
          escapeHtml(stage[1]) + '</h4><span>' + cards.length + '</span></header><div>' +
          (cards.length ? cards.map(function (lead) { return leadCard(lead, true); }).join('') : '<p class="crm-column-empty">Nenhum lead</p>') + '</div></section>';
      }).join('') + '</div>';
  }
  function paginationHtml() {
    const page = state.pagination || {};
    const total = Number(page.total);
    const totalLabel = Number.isFinite(total) ? total.toLocaleString('pt-BR') : 'mais registros';
    if (page.has_more !== true) return '';
    return '<div class="crm-pagination"><span>' + state.leads.length.toLocaleString('pt-BR') + ' de ' +
      escapeHtml(totalLabel) + ' leads carregados</span><button type="button" class="crm-secondary" data-crm-action="load-more"' +
      (state.loadingMore ? ' disabled aria-disabled="true"' : '') + '>' +
      (state.loadingMore ? 'Carregando…' : 'Carregar mais leads') + '</button></div>';
  }
  function siteRequestCard(item) {
    const id = siteRequestId(item);
    const version = siteRequestVersion(item);
    const status = siteRequestStatus(item);
    const pending = siteRequestPending(item);
    const busy = state.siteBusy.has(id);
    const name = text(item.nome || item.full_name || item.name) || 'Contato sem nome';
    const phone = siteRequestPhone(item) || 'WhatsApp não informado';
    const interestCode = text(item.interesse || item.interest);
    const interest = SITE_INTERESTS[interestCode] || interestCode || 'Não informado';
    const periodCode = text(item.periodo || item.preferred_period);
    const period = SITE_PERIODS[periodCode] || periodCode || 'A combinar';
    const firstVisitCode = text(item.primeira_visita || item.first_visit);
    const firstVisit = SITE_FIRST_VISIT[firstVisitCode] || firstVisitCode || 'Não informado';
    const preferredDate = siteDate(item.data_preferida || item.preferred_date);
    const received = safeDateTime(item.recebido_em || item.received_at || item.created_at);
    const code = text(item.codigo_solicitacao || item.codigo || item.public_code);
    const whatsappUrl = siteWhatsAppUrl(item);
    const statusLabel = SITE_REQUEST_STATUS[status] || status.replace(/_/g, ' ');
    let actions = whatsappUrl
      ? '<a class="crm-site-whatsapp" href="' + escapeHtml(whatsappUrl) + '" target="_blank" rel="noopener noreferrer">Abrir WhatsApp</a>'
      : '<span class="crm-site-phone-error">WhatsApp incompleto</span>';
    if (pending) {
      actions += '<button type="button" class="crm-primary" data-crm-site-accept="' + escapeHtml(id) + '"' +
        (version ? ' data-crm-site-version="' + version + '"' : '') + (busy ? ' disabled aria-disabled="true"' : '') +
        '>Aceitar no CRM</button><button type="button" class="crm-danger" data-crm-site-archive="' + escapeHtml(id) + '"' +
        (version ? ' data-crm-site-version="' + version + '"' : '') + (busy ? ' disabled aria-disabled="true"' : '') +
        '>Arquivar com senha</button>';
    }
    return '<article class="crm-site-card' + (pending ? ' is-pending' : '') + '" role="listitem" data-crm-site-id="' +
      escapeHtml(id) + '" aria-busy="' + String(busy) + '"><header><div><h4>' + escapeHtml(name) + '</h4><span>' +
      escapeHtml(phone) + '</span></div><span class="crm-site-status">' + escapeHtml(statusLabel) + '</span></header>' +
      '<dl><div><dt>Interesse</dt><dd>' + escapeHtml(interest) + '</dd></div><div><dt>Preferência</dt><dd>' +
      escapeHtml(preferredDate + ' · ' + period) + '</dd></div><div><dt>Atendimento</dt><dd>' + escapeHtml(firstVisit) +
      '</dd></div><div><dt>Recebido</dt><dd>' + escapeHtml(received) + '</dd></div>' +
      (code ? '<div><dt>Código</dt><dd>' + escapeHtml(code) + '</dd></div>' : '') + '</dl>' +
      '<div class="crm-site-actions">' + actions + '</div></article>';
  }
  function renderSiteInbox() {
    const content = byId('crm-site-content');
    const count = byId('crm-site-count');
    if (!content || !count) return;
    const pending = sitePendingCount();
    count.textContent = pending + (pending === 1 ? ' pendente' : ' pendentes');
    if (!state.siteRequests.length) {
      content.innerHTML = '<div class="crm-site-empty"><strong>Nenhum pedido aguardando</strong>' +
        '<span>Novas solicitações enviadas pelo site aparecerão aqui.</span></div>';
      return;
    }
    content.innerHTML = '<div class="crm-site-list" role="list">' + state.siteRequests.map(siteRequestCard).join('') + '</div>';
  }
  function render() {
    const content = byId('crm-content');
    if (!content) return;
    const rows = filteredLeads();
    renderSiteInbox();
    updateSummary(rows);
    const resultsStatus = byId('crm-results-status');
    if (resultsStatus) resultsStatus.textContent = rows.length === 1 ? '1 lead exibido.' : rows.length + ' leads exibidos.';
    if (!rows.length) {
      content.innerHTML = '<div class="crm-empty"><strong>Nenhum lead encontrado</strong><span>Ajuste os filtros ou faça um cadastro comercial.</span>' +
        '<button type="button" class="crm-primary" data-crm-action="new">Novo lead</button></div>' + paginationHtml();
      return;
    }
    content.innerHTML = (state.view === 'kanban' ? renderKanban(rows) : renderList(rows)) + paginationHtml();
  }

  async function load(force) {
    if (state.loadPromise) return state.loadPromise;
    if (state.loaded && !force) { render(); return; }
    state.loading = true;
    const content = byId('crm-content');
    const siteContent = byId('crm-site-content');
    if (content) { content.setAttribute('aria-busy', 'true'); content.innerHTML = '<div class="crm-loading">Carregando leads…</div>'; }
    if (siteContent) {
      siteContent.setAttribute('aria-busy', 'true');
      if (!state.loaded) siteContent.innerHTML = '<div class="crm-site-empty"><span>Carregando pedidos do site…</span></div>';
    }
    setStatus('Atualizando o CRM…', false);
    let promise = null;
    promise = (async function () {
      try {
        const data = await request('listar', { incluir_arquivados: true, limit: 100, offset: 0 });
        state.leads = responseRows(data);
        state.owners = responseOwners(data);
        state.campaigns = responseCampaigns(data);
        state.siteRequests = responseSiteRequests(data);
        state.summary = responseSummary(data);
        state.pagination = data.paginacao || data.pagination || {};
        state.loaded = true;
        fillOwners();
        fillCampaigns();
        render();
        setStatus('CRM atualizado.', false);
      } catch (error) {
        if (error.code !== 'stale_session' && content) {
          content.innerHTML = '<div class="crm-error"><strong>Não foi possível carregar os leads.</strong><span>' + escapeHtml(error.message) +
            '</span><button type="button" class="crm-secondary" data-crm-action="retry">Tentar novamente</button></div>';
          if (siteContent) siteContent.innerHTML = '<div class="crm-site-empty"><strong>Pedidos indisponíveis</strong>' +
            '<span>Use “Tentar novamente” para atualizar a caixa de entrada.</span></div>';
          setStatus(error.message, true);
        }
      } finally {
        state.loading = false;
        if (state.loadPromise === promise) state.loadPromise = null;
        if (content) content.setAttribute('aria-busy', 'false');
        if (siteContent) siteContent.setAttribute('aria-busy', 'false');
      }
    }());
    state.loadPromise = promise;
    return promise;
  }

  async function loadMore() {
    if (state.loadingMore || state.pagination.has_more !== true) return;
    state.loadingMore = true; render(); setStatus('Carregando mais leads…', false);
    try {
      const currentOffset = Number(state.pagination.offset) || 0;
      const currentLimit = Number(state.pagination.limit) || 100;
      const data = await request('listar', { incluir_arquivados: true, limit: 100, offset: currentOffset + currentLimit });
      const incoming = responseRows(data);
      state.leads = mergeById(state.leads, incoming, leadId);
      state.owners = mergeById(state.owners, responseOwners(data), function (owner) {
        return text(owner && (owner.id || owner.user_id));
      });
      state.campaigns = mergeById(state.campaigns, responseCampaigns(data), function (campaign) {
        return text(campaign && campaign.id);
      });
      state.siteRequests = mergeById(state.siteRequests, responseSiteRequests(data), siteRequestId);
      const incomingSummary = responseSummary(data);
      if (Object.keys(incomingSummary).length) state.summary = incomingSummary;
      state.pagination = data.paginacao || data.pagination || {};
      fillOwners(); fillCampaigns();
      setStatus(incoming.length ? 'Mais leads carregados.' : 'Não há outros leads disponíveis.', false);
    } catch (error) {
      if (error.code !== 'stale_session') setStatus(error.message || 'Não foi possível carregar mais leads.', true);
    } finally {
      state.loadingMore = false; render();
    }
  }

  function updateConditionalFields() {
    const form = byId('crm-form'); if (!form) return;
    const stage = form.elements.estagio.value;
    const nextType = form.elements.next_action_type;
    const next = form.elements.proxima_acao_em;
    const loss = form.elements.motivo_perda;
    const open = !CLOSED_STAGES.has(stage);
    nextType.required = open;
    next.required = open;
    byId('crm-next-type-label').hidden = !open;
    byId('crm-next-label').hidden = !open;
    loss.required = stage === 'nao_convertida';
    byId('crm-loss-label').hidden = stage !== 'nao_convertida';
  }
  function resetForm() {
    const form = byId('crm-form'); if (!form) return;
    form.reset(); form.elements.lead_id.value = ''; form.elements.expected_version.value = '';
    preserveLegacyOrigin(form.elements.origem, '');
    form.elements.primeira_resposta_em.readOnly = false;
    const respondedNow = form.querySelector('[data-crm-action="responded-now"]');
    if (respondedNow) respondedNow.disabled = false;
    const firstResponseHelp = byId('crm-first-response-help');
    if (firstResponseHelp) firstResponseHelp.hidden = true;
    form.elements.estagio.value = 'lead_novo'; state.editingId = ''; clearIntent('save');
    form.elements.campanha_id.disabled = false;
    byId('crm-campaign-help').textContent = 'Selecione o cadastro canônico do Marketing. Não digite nomes livres.';
    updateConditionalFields();
  }
  function novoLead() {
    resetForm();
    const editor = byId('crm-editor');
    editor.open = true; editor.scrollIntoView({ behavior: 'smooth', block: 'start' });
    window.setTimeout(function () { byId('crm-form').elements.nome.focus({ preventScroll: true }); }, 150);
  }
  function findLead(id) { return state.leads.find(function (lead) { return leadId(lead) === text(id); }); }
  function editLead(id) {
    const lead = findLead(id); if (!lead) return;
    const form = byId('crm-form'); resetForm();
    preserveLegacyOrigin(form.elements.origem, lead.origem);
    ['nome', 'telefone', 'email', 'origem', 'suborigem', 'interesse', 'responsavel_id', 'estagio', 'motivo_perda', 'observacoes'].forEach(function (name) {
      if (form.elements[name]) form.elements[name].value = lead[name] == null ? '' : lead[name];
    });
    form.elements.lead_id.value = leadId(lead);
    form.elements.expected_version.value = leadVersion(lead) == null ? '' : leadVersion(lead);
    fillCampaigns(text(lead.campanha_id || lead.campaign_id));
    form.elements.campanha_id.value = text(lead.campanha_id || lead.campaign_id);
    const campaignLocked = Boolean(lead.campanha_imutavel || lead.campaign_locked || lead.campanha_atribuida || text(lead.estagio) === 'convertida');
    form.elements.campanha_id.disabled = campaignLocked;
    byId('crm-campaign-help').textContent = campaignLocked
      ? 'Campanha preservada: leads convertidos ou já atribuídos não podem ter a origem reescrita.'
      : 'Selecione o cadastro canônico do Marketing. Não digite nomes livres.';
    const firstResponse = lead.primeira_resposta_em || lead.first_response_at;
    form.elements.primeira_resposta_em.value = dateInput(firstResponse);
    form.elements.primeira_resposta_em.readOnly = Boolean(firstResponse);
    const respondedNow = form.querySelector('[data-crm-action="responded-now"]');
    if (respondedNow) respondedNow.disabled = Boolean(firstResponse);
    const firstResponseHelp = byId('crm-first-response-help');
    if (firstResponseHelp) firstResponseHelp.hidden = !firstResponse;
    form.elements.next_action_type.value = text(lead.next_action_type || lead.proxima_acao_tipo);
    form.elements.proxima_acao_em.value = dateInput(lead.proxima_acao_em || lead.next_action_at);
    state.editingId = leadId(lead); updateConditionalFields();
    const editor = byId('crm-editor'); editor.open = true; editor.scrollIntoView({ behavior: 'smooth', block: 'start' });
    form.elements.nome.focus({ preventScroll: true });
  }
  function formPayload(form) {
    const payload = {};
    ['lead_id', 'nome', 'telefone', 'email', 'origem', 'suborigem', 'campanha_id', 'interesse', 'responsavel_id',
      'estagio', 'primeira_resposta_em', 'next_action_type', 'proxima_acao_em', 'motivo_perda', 'observacoes'].forEach(function (name) {
      payload[name] = text(form.elements[name].value) || null;
    });
    payload.primeira_resposta_em = form.elements.primeira_resposta_em.readOnly
      ? null : toClinicIso(payload.primeira_resposta_em);
    payload.proxima_acao_em = toClinicIso(payload.proxima_acao_em);
    if (CLOSED_STAGES.has(payload.estagio)) {
      payload.next_action_type = null;
      payload.proxima_acao_em = null;
    }
    return payload;
  }
  function validatePayload(payload, form) {
    updateConditionalFields();
    if (!form.checkValidity()) { form.reportValidity(); return false; }
    if (!payload.telefone && !payload.email) { setStatus('Informe telefone ou e-mail para o lead.', true); form.elements.telefone.focus(); return false; }
    if (!CLOSED_STAGES.has(payload.estagio) && !payload.next_action_type) {
      setStatus('Defina o tipo da próxima ação antes de salvar um lead em andamento.', true); form.elements.next_action_type.focus(); return false;
    }
    if (!CLOSED_STAGES.has(payload.estagio) && !payload.proxima_acao_em) {
      setStatus('Defina a data da próxima ação antes de salvar um lead em andamento.', true); form.elements.proxima_acao_em.focus(); return false;
    }
    if (payload.estagio === 'nao_convertida' && text(payload.motivo_perda).length < 3) {
      setStatus('Informe o motivo da não conversão.', true); form.elements.motivo_perda.focus(); return false;
    }
    return true;
  }
  async function saveLead(form) {
    const payload = formPayload(form); if (!validatePayload(payload, form)) return;
    const expected = form.elements.expected_version.value;
    setBusy(form, true); setStatus('Salvando lead…', false);
    try {
      await request('salvar_lead', payload, { idempotencyKey: intentKey('save'), expectedVersion: expected || null });
      clearIntent('save'); resetForm(); byId('crm-editor').open = false;
      await load(true); setStatus('Lead salvo com sucesso.', false);
    } catch (error) { if (error.code !== 'stale_session') setStatus(error.message, true); }
    finally { setBusy(form, false); }
  }
  function findSiteRequest(id) {
    return state.siteRequests.find(function (item) { return siteRequestId(item) === text(id); });
  }
  async function changeSiteRequest(action, id) {
    const item = findSiteRequest(id);
    if (!item || !siteRequestPending(item) || state.siteBusy.has(id)) return;
    const accepting = action === 'aceitar_solicitacao_site';
    const intent = (accepting ? 'site-accept:' : 'site-archive:') + id;
    state.siteBusy.add(id); renderSiteInbox();
    setStatus(accepting ? 'Aceitando pedido do site…' : 'Arquivando pedido do site…', false);
    try {
      const options = { idempotencyKey: intentKey(intent), expectedVersion: siteRequestVersion(item) };
      if (accepting) {
        await request(action, { solicitacao_id: id }, options);
      } else {
        await protectedRequest(action, { solicitacao_id: id }, Object.assign({}, options, {
          titulo: 'Arquivar pedido do site',
          motivo: 'Informe por que este pedido deve ser arquivado',
          motivoObrigatorio: true
        }));
      }
      clearIntent(intent);
      await load(true);
      setStatus(accepting ? 'Pedido aceito e vinculado ao CRM.' : 'Pedido do site arquivado.', false);
    } catch (error) {
      if (error.code !== 'stale_session') setStatus(error.message, true);
    } finally {
      state.siteBusy.delete(id); renderSiteInbox();
    }
  }
  async function archiveLead(id) {
    const lead = findLead(id); if (!lead) return;
    setStatus('Confirmando arquivamento…', false);
    try {
      await protectedRequest('arquivar_lead', { lead_id: id }, {
        titulo: 'Arquivar lead', motivo: 'Registrar o motivo do arquivamento comercial', motivoObrigatorio: true,
        idempotencyKey: intentKey('archive:' + id), expectedVersion: leadVersion(lead)
      });
      clearIntent('archive:' + id); await load(true); setStatus('Lead arquivado.', false);
    } catch (error) { if (error.code !== 'stale_session') setStatus(error.message, true); }
  }

  function conversionCandidates(data) {
    const detail = data.dados || data;
    const rows = detail.candidatos || detail.candidates || detail.possible_candidates || [];
    return Array.isArray(rows) ? rows.filter(function (candidate) {
      return text(candidate && (candidate.paciente_id || candidate.patient_id || candidate.id));
    }) : [];
  }
  function renderConversion(data, lead) {
    const container = byId('crm-conversion');
    const detail = data.dados || data;
    const candidates = conversionCandidates(data).slice();
    const exactId = text(detail.exact_patient_id || detail.paciente_exato_id);
    if (exactId && !candidates.some(function (candidate) {
      return text(candidate.paciente_id || candidate.patient_id || candidate.id) === exactId;
    })) candidates.unshift({ patient_id: exactId, safe_label: 'Cadastro exato encontrado' });
    const possibleCount = Number(detail.total_candidatos == null ?
      (detail.possible_count == null ? candidates.length : detail.possible_count) : detail.total_candidatos);
    const hasMore = detail.has_more === true;
    const candidateFingerprint = text(detail.candidate_fingerprint || detail.fingerprint_candidatos);
    const canCreate = !hasMore && (detail.pode_criar === true || detail.can_create_patient === true);
    const canConfirmDistinct = !hasMore && !exactId && possibleCount > 0 && candidates.length > 0;
    state.conversion = { leadId: leadId(lead), version: leadVersion(lead), candidates: candidates,
      candidateFingerprint: candidateFingerprint, canCreate: canCreate,
      canConfirmDistinct: canConfirmDistinct, hasMore: hasMore };
    container.hidden = false;
    container.innerHTML = '<header><div><p>Conversão protegida</p><h3 id="crm-conversion-title">Revise antes de vincular uma paciente</h3></div>' +
      '<button type="button" data-crm-action="cancel-conversion" aria-label="Fechar revisão">×</button></header>' +
      '<p>A interface não cria cadastros por conta própria. Escolha apenas uma opção autorizada pela API.</p>' +
      (candidates.length ? '<div class="crm-candidates"><h4>Cadastros possivelmente existentes</h4>' + candidates.map(function (candidate) {
        const id = text(candidate.paciente_id || candidate.patient_id || candidate.id);
        const alias = text(candidate.alias_opaco || candidate.safe_alias) || 'P-REVISAR';
        const label = text(candidate.rotulo_seguro || candidate.safe_label) || 'Cadastro existente retornado pela API';
        return '<button type="button" data-crm-link-patient="' + escapeHtml(id) + '"' +
          (hasMore ? ' disabled aria-disabled="true"' : '') + '><span><b>' + escapeHtml(alias) + '</b> · ' +
          escapeHtml(label) + '</span><strong>' + (hasMore ? 'Refine antes de vincular' : 'Vincular existente') + '</strong></button>';
      }).join('') + '</div>' : '<p class="crm-conversion-empty">Nenhum candidato seguro foi retornado.</p>') +
      (hasMore ? '<p class="crm-conversion-note" role="alert">Há ' + escapeHtml(String(possibleCount)) +
        ' candidatos. Refine telefone, e-mail ou nascimento e revise novamente; vínculo e criação distinta estão bloqueados.</p>' : '') +
      (canCreate === true ? '<button type="button" class="crm-primary" data-crm-create-patient>Criar paciente pela operação protegida</button>' :
        '<p class="crm-conversion-note">A criação comum não foi liberada. Revise os candidatos ou cancele.</p>') +
      (canConfirmDistinct ? '<details class="crm-distinct"><summary>Nenhum cadastro é desta pessoa?</summary>' +
        '<label for="crm-distinct-reason"><span>Por que é uma pessoa diferente?</span><textarea id="crm-distinct-reason" minlength="8" maxlength="240" rows="2" placeholder="Ex.: telefone compartilhado, nomes e demais dados conferidos"></textarea></label>' +
        '<button type="button" class="crm-primary" data-crm-create-distinct>Confirmar pessoa diferente e criar paciente</button></details>' : '');
    container.scrollIntoView({ behavior: 'smooth', block: 'start' });
    window.setTimeout(function () {
      if (!container.hidden) container.focus({ preventScroll: true });
    }, 100);
  }
  async function startConversion(id) {
    const lead = findLead(id); if (!lead) return;
    setStatus('Preparando revisão de conversão…', false);
    try {
      const data = await protectedRequest('converter_lead', { lead_id: id, modo: 'revisar' }, {
        titulo: 'Revisar conversão de lead', motivo: 'Confirmar a identidade antes de converter', motivoObrigatorio: true,
        idempotencyKey: intentKey('conversion-review:' + id), expectedVersion: leadVersion(lead)
      });
      clearIntent('conversion-review:' + id);
      if (data.convertido === true || data.converted === true) {
        state.conversionReturnFocus = null; await load(true); setStatus('Conversão concluída pela API.', false); return;
      }
      renderConversion(data, lead); setStatus('Confira os candidatos antes de continuar.', false);
    } catch (error) { if (error.code !== 'stale_session') setStatus(error.message, true); }
  }
  function conversionIntentName(mode, patientId) {
    const conversion = state.conversion;
    return conversion ? 'conversion-final:' + conversion.leadId + ':' + mode + ':' + (patientId || 'new') : '';
  }
  function closeConversion(restoreFocus) {
    const container = byId('crm-conversion');
    state.conversion = null;
    if (container) { container.hidden = true; container.innerHTML = ''; }
    if (restoreFocus && state.conversionReturnFocus && state.conversionReturnFocus.isConnected) {
      state.conversionReturnFocus.focus();
    }
    state.conversionReturnFocus = null;
  }
  async function finishConversion(mode, patientId) {
    const conversion = state.conversion;
    const distinct = mode === 'criar_paciente_distinto';
    if (!conversion || mode === 'criar_paciente' && conversion.canCreate !== true ||
        distinct && conversion.canConfirmDistinct !== true) return;
    if (conversion.hasMore === true) {
      setStatus('Refine os dados e revise novamente antes de vincular ou criar outra paciente.', true);
      return;
    }
    if (!conversion.candidateFingerprint) {
      closeConversion(true);
      setStatus('Os cadastros precisam ser revisados novamente antes da conversão.', true);
      return;
    }
    const payload = { lead_id: conversion.leadId, modo: distinct ? 'criar_paciente' : mode };
    payload.candidate_fingerprint = conversion.candidateFingerprint;
    if (mode === 'vincular_existente') payload.paciente_id = patientId;
    if (distinct) {
      const reasonNode = byId('crm-distinct-reason');
      const reason = text(reasonNode && reasonNode.value);
      if (reason.length < 8) {
        setStatus('Explique por que os cadastros encontrados são de outra pessoa.', true);
        if (reasonNode) reasonNode.focus();
        return;
      }
      payload.confirm_possible_distinct = true;
      payload.distinct_reason = reason;
    }
    setStatus('Concluindo conversão protegida…', false);
    try {
      await protectedRequest('converter_lead', payload, {
        titulo: mode === 'vincular_existente' ? 'Vincular paciente existente' :
          (distinct ? 'Confirmar que é outra pessoa' : 'Criar paciente a partir do lead'),
        motivo: 'Confirmar a conversão comercial', motivoObrigatorio: true,
        idempotencyKey: intentKey(conversionIntentName(mode, patientId)),
        expectedVersion: conversion.version
      });
      closeConversion(false); await load(true);
      setStatus('Lead convertido com segurança.', false);
      const title = byId('crm-workspace-title'); if (title) title.focus({ preventScroll: true });
    } catch (error) {
      if (error.code === 'candidate_fingerprint_required' || error.code === 'candidate_set_changed' ||
          error.code === 'candidate_set_too_large' ||
          error.code === 'reanalysis_required' || error.code === 'conversion_reanalysis_required') {
        closeConversion(true);
        setStatus('Os cadastros mudaram. Abra a conversão e revise novamente antes de decidir.', true);
      } else if (error.code !== 'stale_session') setStatus(error.message, true);
    }
  }

  function clearFilters() {
    byId('crm-search').value = ''; byId('crm-filter-stage').value = ''; byId('crm-filter-origin').value = '';
    byId('crm-filter-owner').value = ''; byId('crm-filter-archived').checked = false; state.specialFilter = ''; render();
  }
  function aplicarFiltro(name) {
    clearFilters(); state.specialFilter = name === 'vencidos' ? 'vencidos' : 'abertos'; render();
    byId('crm-workspace-title').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  function bind() {
    if (state.bound) return;
    state.bound = true;
    state.root.addEventListener('submit', function (event) {
      if (event.target.id === 'crm-form') { event.preventDefault(); void saveLead(event.target); }
    });
    state.root.addEventListener('input', function (event) {
      if (event.target.closest('#crm-form')) clearIntent('save');
      if (event.target.id === 'crm-distinct-reason' && state.conversion) {
        clearIntent(conversionIntentName('criar_paciente_distinto'));
      }
      if (event.target.id === 'crm-search') { state.specialFilter = ''; render(); }
    });
    state.root.addEventListener('change', function (event) {
      if (event.target.name === 'estagio') updateConditionalFields();
      if (event.target.closest('#crm-form')) clearIntent('save');
      if (event.target.closest('.crm-filters')) { state.specialFilter = ''; render(); }
    });
    state.root.addEventListener('click', function (event) {
      const action = event.target.closest('[data-crm-action]');
      if (action) {
        const name = action.dataset.crmAction;
        if (name === 'new') novoLead();
        else if (name === 'refresh' || name === 'retry') void load(true);
        else if (name === 'load-more') void loadMore();
        else if (name === 'cancel-edit') { resetForm(); byId('crm-editor').open = false; }
        else if (name === 'responded-now') {
          const input = byId('crm-form').elements.primeira_resposta_em;
          if (!input.readOnly) {
            input.value = localNow(); clearIntent('save'); input.dispatchEvent(new Event('input', { bubbles: true }));
          }
        }
        else if (name === 'clear-filters') clearFilters();
        else if (name === 'cancel-conversion') closeConversion(true);
      }
      const view = event.target.closest('[data-crm-view]');
      if (view) {
        state.view = view.dataset.crmView;
        state.root.querySelectorAll('[data-crm-view]').forEach(function (button) {
          button.setAttribute('aria-pressed', String(button === view));
        }); render();
      }
      const special = event.target.closest('[data-crm-special]'); if (special) aplicarFiltro(special.dataset.crmSpecial);
      const edit = event.target.closest('[data-crm-edit]'); if (edit) editLead(edit.dataset.crmEdit);
      const archive = event.target.closest('[data-crm-archive]'); if (archive) void archiveLead(archive.dataset.crmArchive);
      const siteAccept = event.target.closest('[data-crm-site-accept]');
      if (siteAccept) void changeSiteRequest('aceitar_solicitacao_site', siteAccept.dataset.crmSiteAccept);
      const siteArchive = event.target.closest('[data-crm-site-archive]');
      if (siteArchive) void changeSiteRequest('arquivar_solicitacao_site', siteArchive.dataset.crmSiteArchive);
      const convert = event.target.closest('[data-crm-convert]');
      if (convert) { state.conversionReturnFocus = convert; void startConversion(convert.dataset.crmConvert); }
      const link = event.target.closest('[data-crm-link-patient]'); if (link) void finishConversion('vincular_existente', link.dataset.crmLinkPatient);
      if (event.target.closest('[data-crm-create-patient]')) void finishConversion('criar_paciente');
      if (event.target.closest('[data-crm-create-distinct]')) void finishConversion('criar_paciente_distinto');
    });
    state.root.addEventListener('keydown', function (event) {
      const conversion = byId('crm-conversion');
      if (event.key === 'Escape' && conversion && !conversion.hidden) {
        event.preventDefault(); closeConversion(true);
      }
    });
  }
  function mount() {
    if (state.root) return;
    state.root = byId('crm-root'); if (!state.root) return;
    state.root.innerHTML = shellHtml(); bind(); updateConditionalFields(); renderSiteInbox();
  }
  function ativar() { mount(); if (ownerAccess()) void load(false); }
  async function abrirLead(id) { ativar(); await load(false); editLead(id); }
  function reset() {
    state.generation += 1; state.controllers.forEach(function (controller) { controller.abort(); }); state.controllers.clear();
    state.loaded = false; state.loading = false; state.leads = []; state.owners = []; state.campaigns = []; state.summary = {};
    state.siteRequests = []; state.siteBusy = new Set();
    state.pagination = {}; state.loadingMore = false;
    state.loadPromise = null; state.intentKeys = Object.create(null); state.conversion = null; state.conversionReturnFocus = null;
    state.specialFilter = ''; state.editingId = '';
    if (state.root) { state.root.innerHTML = shellHtml(); updateConditionalFields(); renderSiteInbox(); }
  }

  window.AMJCRMLeads = Object.freeze({ ativar: ativar, reset: reset, novoLead: novoLead,
    abrirLead: abrirLead, aplicarFiltro: aplicarFiltro,
    __test: Object.freeze({ toClinicIso: toClinicIso, dateInput: dateInput,
      recordStatus: recordStatus, isOpen: isOpen, isOverdue: isOverdue,
      responseSiteRequests: responseSiteRequests, siteRequestPending: siteRequestPending,
      siteWhatsAppNumber: siteWhatsAppNumber, siteDate: siteDate }) });
}());

(function () {
  'use strict';

  const API = 'https://rjxtxoqprnumouqakxbc.supabase.co/functions/v1/operacao-clinica-fichas';
  const DATE = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeZone: 'America/Sao_Paulo' });
  const state = { root: null, rows: [], responsaveis: [], credentials: [], consents: [], loading: false,
    loaded: false, generation: 0, intents: new Map() };

  function uuid() {
    return window.crypto && typeof window.crypto.randomUUID === 'function'
      ? window.crypto.randomUUID()
      : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (char) {
        const random = Math.random() * 16 | 0;
        return (char === 'x' ? random : (random & 3 | 8)).toString(16);
      });
  }
  function text(value) { return String(value == null ? '' : value).trim(); }
  function escapeHtml(value) {
    return text(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }
  function ownerAccess() {
    try {
      return typeof modoAcesso !== 'undefined' && modoAcesso === 'auth' &&
        typeof identidadeBackend !== 'undefined' && identidadeBackend &&
        text(identidadeBackend.role).toLowerCase() === 'owner';
    } catch (_) { return false; }
  }
  function safeDate(value) {
    const parsed = new Date(text(value));
    return Number.isFinite(parsed.getTime()) ? DATE.format(parsed) : '—';
  }
  function status(message, error) {
    const node = state.root && state.root.querySelector('[data-acomp-status]');
    if (!node) return;
    node.textContent = message || '';
    node.classList.toggle('erro', Boolean(error));
  }
  function setBusy(busy) {
    state.loading = busy;
    if (!state.root) return;
    state.root.setAttribute('aria-busy', String(busy));
    state.root.querySelectorAll('button,input,select,textarea').forEach(function (control) {
      if (busy) { control.dataset.acompWasDisabled = String(control.disabled); control.disabled = true; }
      else if (Object.prototype.hasOwnProperty.call(control.dataset, 'acompWasDisabled')) {
        control.disabled = control.dataset.acompWasDisabled === 'true'; delete control.dataset.acompWasDisabled;
      }
    });
  }
  function intent(name) {
    if (!state.intents.has(name)) state.intents.set(name, { activation: uuid(), idempotency: uuid() });
    return state.intents.get(name);
  }
  function clearIntent(name) { state.intents.delete(name); }
  async function request(action, payload, proof) {
    const generation = state.generation;
    if (!ownerAccess()) throw new Error('Esta área exige conta proprietária individual com MFA.');
    const response = await fetch(API, {
      method: 'POST', headers: await cabecalhosAcesso(true, proof), cache: 'no-store',
      referrerPolicy: 'no-referrer', body: JSON.stringify(Object.assign({ acao: action }, payload || {}))
    });
    let data = {};
    try { data = await response.json(); } catch (_) { data = {}; }
    if (generation !== state.generation) throw new Error('Sessão de acompanhamentos encerrada.');
    if (!response.ok || data.ok === false || data.erro) {
      const error = new Error(data.erro || 'Não foi possível concluir a operação.');
      error.code = data.codigo || String(response.status); throw error;
    }
    if (data.identity && typeof atualizarIdentidade === 'function') atualizarIdentidade(data);
    return data;
  }
  async function protectedRequest(action, payload, title, fallbackReason) {
    if (!window.AMJProtecao || typeof window.AMJProtecao.solicitarSenhaRecente !== 'function') {
      throw new Error('A confirmação segura por senha não está disponível. Atualize a página.');
    }
    let proof = null;
    try {
      proof = await window.AMJProtecao.solicitarSenhaRecente({ titulo: title,
        motivo: fallbackReason, motivoObrigatorio: true });
      return await request(action, Object.assign({}, payload, { operation_id: proof.operation_id,
        motivo: proof.motivo || fallbackReason }), proof);
    } finally { if (proof && typeof proof.encerrar === 'function') await proof.encerrar(); }
  }
  function responsibleOptions(selected) {
    return '<option value="">Selecione</option>' + state.responsaveis.map(function (item) {
      return '<option value="' + escapeHtml(item.user_id) + '"' +
        (text(item.user_id) === text(selected) ? ' selected' : '') + '>' +
        escapeHtml(item.nome || 'Responsável') + ' · ' + escapeHtml(item.papel || 'membro') + '</option>';
    }).join('');
  }
  function card(row) {
    const candidate = !row.activation_id;
    const allowed = row.elegivel === true && !row.bloqueio_codigo;
    const reactivation = row.tipo === 'reactivation';
    const actionAllowed = allowed && candidate && (!reactivation || Boolean(row.canal));
    const label = reactivation ? 'Reativação' : 'Pós-procedimento';
    const action = reactivation ? 'reativar' : 'sequencia';
    const activeAttempt = reactivation && !candidate && allowed && row.plano_id && row.fila_id &&
      row.versao_plano && row.versao_fila;
    return '<article class="acomp-card" data-acomp-row="' + escapeHtml(row.id) + '">' +
      '<div class="acomp-card-topo"><div><span class="acomp-tipo">' + label + '</span><h3>' +
      escapeHtml(row.patient_name || 'Paciente') + '</h3></div><span class="acomp-data">' +
      escapeHtml(safeDate(row.due_at || row.reference_at)) + '</span></div>' +
      '<p class="acomp-meta">' + escapeHtml(row.procedure_kind || 'Consulta') + ' · ' +
      escapeHtml(row.status || 'Pendente') + (row.canal ? ' · canal ' + escapeHtml(row.canal) : '') + '</p>' +
      (row.bloqueio_motivo ? '<p class="acomp-bloqueio" role="note">' + escapeHtml(row.bloqueio_motivo) + '</p>' : '') +
      '<p class="acomp-transparencia">Cria tarefas internas para revisão humana. Não envia mensagens e não toma decisão clínica.</p>' +
      (candidate ? '<button class="acomp-botao" type="button" data-acomp-abrir="' + action + '"' +
        (actionAllowed ? '' : ' disabled') + '>Ativar ' + label.toLowerCase() + '</button>' : '') +
      (activeAttempt ? '<button class="acomp-botao alt" type="button" data-acomp-abrir="tentativa">Registrar tentativa manual</button>' : '') +
      '<div class="acomp-form-area" hidden></div></article>';
  }
  function render() {
    if (!state.root) return;
    const list = state.root.querySelector('[data-acomp-lista]');
    if (!list) return;
    list.innerHTML = state.rows.length ? state.rows.map(card).join('') :
      '<div class="acomp-vazio"><strong>Nenhum acompanhamento disponível.</strong><span>As ativações aparecem após a validação dos pré-requisitos.</span></div>';
  }
  function shell() {
    return '<section class="acomp-shell" aria-labelledby="acomp-titulo"><header class="acomp-cabecalho">' +
      '<div><p>Acompanhamento humano</p><h2 id="acomp-titulo">Pós-procedimento e reativação</h2>' +
      '<span>Filas internas validadas. Nenhuma mensagem é enviada automaticamente.</span></div>' +
      '<button class="acomp-botao alt" type="button" data-acomp-recarregar>Atualizar</button></header>' +
      '<p class="acomp-status" data-acomp-status role="status" aria-live="polite"></p>' +
      '<div class="acomp-lista" data-acomp-lista></div></section>';
  }
  async function load(force) {
    if (state.loading && !force) return;
    setBusy(true); status('Carregando acompanhamentos…');
    try {
      const data = await request('listar_acompanhamentos_fase2', { limite: 100 });
      state.rows = Array.isArray(data.acompanhamentos) ? data.acompanhamentos : [];
      state.responsaveis = Array.isArray(data.responsaveis) ? data.responsaveis : [];
      state.credentials = Array.isArray(data.credenciais_profissionais) ? data.credenciais_profissionais : [];
      state.consents = Array.isArray(data.consentimentos_marketing_atuais) ? data.consentimentos_marketing_atuais : [];
      state.loaded = true; render(); status('Acompanhamentos atualizados.');
    } catch (error) { status(error.message, true); }
    finally { setBusy(false); }
  }
  function openForm(cardNode, kind) {
    const row = state.rows.find(function (item) { return text(item.id) === text(cardNode.dataset.acompRow); });
    if (!row) return;
    const area = cardNode.querySelector('.acomp-form-area');
    if (!area) return;
    let fields = '<label>Responsável<select name="responsavel_id" required>' + responsibleOptions(row.responsible_user_id) + '</select></label>';
    if (kind === 'sequencia') fields += '<label>Intervalos em dias<input name="intervalos" value="1,3,7" inputmode="numeric" required></label>';
    if (kind === 'tentativa') fields = '<label>Resultado<select name="resultado" required><option value="sem_resposta">Sem resposta</option><option value="respondeu">Respondeu</option><option value="agendou">Agendou</option><option value="recusou">Recusou</option><option value="canal_indisponivel">Canal indisponível</option></select></label>' +
      '<label>Próxima ação<select name="proxima_acao"><option value="recontatar">Recontatar</option><option value="aguardar_resposta">Aguardar resposta</option><option value="confirmar_agenda">Confirmar agenda</option><option value="nenhuma">Nenhuma</option></select></label>' +
      '<label>Quando<input name="proxima_acao_em" type="datetime-local"></label>';
    fields += '<label class="largo">Motivo<textarea name="motivo" minlength="3" maxlength="500" required></textarea></label>';
    area.innerHTML = '<form class="acomp-form" data-acomp-form="' + kind + '">' + fields +
      '<div class="acomp-form-acoes"><button class="acomp-botao" type="submit">Confirmar</button>' +
      '<button class="acomp-botao alt" type="button" data-acomp-cancelar>Cancelar</button></div></form>';
    area.hidden = false; area.querySelector('select,input,textarea').focus();
  }
  function intervals(value) {
    const parsed = text(value).split(',').map(function (item) { return Number(item.trim()); });
    if (!parsed.length || parsed.length > 12 || parsed.some(function (item) { return !Number.isInteger(item) || item < 1 || item > 3650; }) ||
      new Set(parsed).size !== parsed.length) throw new Error('Informe até 12 intervalos distintos, separados por vírgula.');
    return parsed;
  }
  async function submit(form) {
    const cardNode = form.closest('[data-acomp-row]');
    const row = state.rows.find(function (item) { return text(item.id) === text(cardNode.dataset.acompRow); });
    if (!row) return;
    const kind = form.dataset.acompForm;
    const reason = text(form.elements.motivo.value);
    if (reason.length < 3) throw new Error('Informe o motivo da operação.');
    const intentName = kind + ':' + row.id;
    const keys = intent(intentName);
    let action; let payload;
    if (kind === 'sequencia') {
      action = 'ativar_sequencia_pos_procedimento';
      payload = { atendimento_id: row.attendance_id, versao_atendimento: row.versao_atendimento || row.version,
        responsavel_id: text(form.elements.responsavel_id.value), intervalos_dias: intervals(form.elements.intervalos.value),
        activation_id: keys.activation, idempotency_key: keys.idempotency };
    } else if (kind === 'reativar') {
      action = 'ativar_reativacao';
      payload = { cliente_id: row.patient_id, ultimo_atendimento_id: row.attendance_id,
        versao_ultimo_atendimento: row.versao_atendimento || row.version, canal: row.canal,
        responsavel_id: text(form.elements.responsavel_id.value), activation_id: keys.activation,
        idempotency_key: keys.idempotency };
    } else {
      action = 'registrar_tentativa_reativacao';
      const result = text(form.elements.resultado.value);
      const nextAction = result === 'recusou' ? 'nenhuma' : result === 'respondeu'
        ? 'aguardar_resposta' : result === 'agendou' ? 'confirmar_agenda' : 'recontatar';
      const nextAt = text(form.elements.proxima_acao_em.value);
      if (nextAction !== 'nenhuma' && !nextAt) throw new Error('Informe uma data futura para a próxima ação.');
      payload = { plano_id: row.plano_id, versao_plano: row.versao_plano, fila_id: row.fila_id,
        versao_fila: row.versao_fila, resultado: result,
        proxima_acao: nextAction, proxima_acao_em: nextAction === 'nenhuma' ? null : (nextAt ? new Date(nextAt).toISOString() : null),
        tentativa_em: new Date().toISOString(), idempotency_key: keys.idempotency };
    }
    if (kind !== 'tentativa' && !payload.responsavel_id) throw new Error('Selecione a pessoa responsável.');
    setBusy(true); status('Confirmando operação protegida…');
    try {
      await protectedRequest(action, payload, 'Confirmar acompanhamento', reason);
      clearIntent(intentName); setBusy(false); await load(true);
      status('Acompanhamento atualizado. Nenhuma mensagem foi enviada.');
    } finally { setBusy(false); }
  }
  function bind() {
    if (!state.root || state.root.dataset.acompBound === '1') return;
    state.root.dataset.acompBound = '1';
    state.root.addEventListener('click', function (event) {
      const reload = event.target.closest('[data-acomp-recarregar]');
      const open = event.target.closest('[data-acomp-abrir]');
      const cancel = event.target.closest('[data-acomp-cancelar]');
      if (reload) load();
      else if (open) openForm(open.closest('[data-acomp-row]'), open.dataset.acompAbrir);
      else if (cancel) { const area = cancel.closest('.acomp-form-area'); area.hidden = true; area.innerHTML = ''; }
    });
    state.root.addEventListener('submit', function (event) {
      const form = event.target.closest('[data-acomp-form]');
      if (!form) return; event.preventDefault();
      submit(form).catch(function (error) { status(error.message, true); setBusy(false); });
    });
  }
  function mount(target) {
    const root = typeof target === 'string' ? document.querySelector(target) : target;
    if (!root) return false;
    state.root = root; state.root.innerHTML = shell(); bind(); updateAccess(); return true;
  }
  function updateAccess() {
    if (!state.root) return;
    state.root.hidden = !ownerAccess();
    if (ownerAccess() && !state.loaded) load();
  }
  function reset() {
    state.generation += 1;
    state.loaded = false;
    state.loading = false;
    state.rows = [];
    state.responsaveis = [];
    state.credentials = [];
    state.consents = [];
    state.intents.clear();
    if (state.root) {
      state.root.innerHTML = shell();
      state.root.hidden = true;
    }
  }

  window.AMJAcompanhamentos = { montar: mount, ativar: load, carregar: load,
    atualizarAcesso: updateAccess, reset: reset, contrato: { endpoint: API, mensagensAutomaticas: false } };
  if (window.__AMJ_TEST__) window.AMJAcompanhamentos.__test = { intervals: intervals, intent: intent,
    clearIntent: clearIntent, card: card };
})();

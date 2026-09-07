(function () {
  'use strict';

  const API = 'https://rjxtxoqprnumouqakxbc.supabase.co/functions/v1/operacao-clinica-fichas';
  const PRONTUARIO_API = 'https://rjxtxoqprnumouqakxbc.supabase.co/functions/v1/prontuario-fichas';
  const MONEY = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
  const DATE = new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Sao_Paulo'
  });
  const state = {
    root: null, loaded: false, loading: false, loadPromise: null, generation: 0,
    listLimit: 1000, pagination: null, data: emptyData(), attendanceBaseline: '', selectedAttendanceId: '',
    attendanceRevision: 0
  };
  const disabledBeforeBusy = new WeakMap();
  const photoUploadKeys = new WeakMap();
  const photoUploadContexts = new WeakMap();
  const photoUploadResults = new WeakMap();
  const photoUploadDuplicates = new WeakMap();
  const photoThumbnailPromises = new WeakMap();
  const photoMetadataKeys = new WeakMap();
  const photoMetadataContexts = new WeakMap();
  const formIntentKeys = new WeakMap();
  const protocolPrepareKeys = new Map();
  const protocolProductsById = new Map();
  const loadingProtocolProducts = new Map();
  const loadedPhotoAttendances = new Map();
  const loadingPhotoAttendances = new Map();
  const PHOTO_LINK_REFRESH_MS = 4 * 60 * 1000;
  let photoLoadEpoch = 0;

  function emptyData() {
    return { clientes: [], atendimentos: [], procedimentos_atendimento: [], perfis_operacionais: [], preferencias_contato: [],
      recomendacoes_retorno: [], fila_retorno: [], tentativas_retorno: [], fichas_custo: [],
      itens_ficha_custo: [], rentabilidade_atendimentos: [], rentabilidade_mensal: [],
      resumo_retornos: [], produtos: [], estoque_lotes: [], protocolos: [], lancamentos_receita: [],
      pagamentos: [], taxas_pagamento: [], fotos_atendimento: [], indice_fotos_atendimento: [],
      resumos_prontuario_atendimento: [], eventos_consumo: [],
      responsaveis: [], vinculos_agenda: [], agendamentos: [] };
  }
  function uuid() {
    return window.crypto && typeof window.crypto.randomUUID === 'function'
      ? window.crypto.randomUUID()
      : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (character) {
        const random = Math.random() * 16 | 0;
        return (character === 'x' ? random : (random & 3 | 8)).toString(16);
      });
  }
  function canonicalIntentValue(value) {
    if (Array.isArray(value)) return value.map(canonicalIntentValue);
    if (!value || typeof value !== 'object') return value;
    return Object.keys(value).sort().reduce(function (result, key) {
      if (key !== 'idempotency_key' && key !== 'operation_id') {
        result[key] = canonicalIntentValue(value[key]);
      }
      return result;
    }, {});
  }
  function intentKeyForForm(form, payload) {
    const fingerprint = JSON.stringify(canonicalIntentValue(payload || {}));
    const remembered = formIntentKeys.get(form);
    if (remembered && remembered.fingerprint === fingerprint) return remembered.key;
    const key = uuid();
    formIntentKeys.set(form, { fingerprint: fingerprint, key: key });
    return key;
  }
  function confirmFormIntent(form, key) {
    const remembered = formIntentKeys.get(form);
    if (remembered && remembered.key === key) formIntentKeys.delete(form);
  }
  function protocolPrepareKey(attendanceId) {
    const id = String(attendanceId || '');
    if (!protocolPrepareKeys.has(id)) protocolPrepareKeys.set(id, uuid());
    return protocolPrepareKeys.get(id);
  }
  function confirmProtocolPrepare(attendanceId, key) {
    const id = String(attendanceId || '');
    if (protocolPrepareKeys.get(id) === key) protocolPrepareKeys.delete(id);
  }
  function clinicalPhotoPending(summary) {
    return !summary || num(summary.active_clinical_count) < 1;
  }
  function attendancePhotosAreFresh(attendanceId) {
    const id = String(attendanceId || '');
    const loadedAt = loadedPhotoAttendances.get(id);
    if (Number.isFinite(loadedAt) && Date.now() - loadedAt < PHOTO_LINK_REFRESH_MS) return true;
    loadedPhotoAttendances.delete(id);
    return false;
  }
  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }
  function bySelector(selector) { return state.root ? state.root.querySelector(selector) : null; }
  function all(selector) { return state.root ? Array.from(state.root.querySelectorAll(selector)) : []; }
  function num(value) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : 0; }
  function money(value) { return MONEY.format(num(value)); }
  function dateTime(value) {
    const parsed = new Date(String(value || ''));
    return Number.isFinite(parsed.getTime()) ? DATE.format(parsed) : '—';
  }
  function localNow() {
    const value = new Date(Date.now() - new Date().getTimezoneOffset() * 60000);
    return value.toISOString().slice(0, 16);
  }
  function localTimestampToIso(value) {
    const parsed = new Date(String(value || ''));
    if (!Number.isFinite(parsed.getTime())) throw new Error('Informe a data e o horário corretamente.');
    return parsed.toISOString();
  }
  function timestampToLocalInput(value) {
    const parsed = new Date(String(value || ''));
    if (!Number.isFinite(parsed.getTime())) return '';
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).formatToParts(parsed).reduce(function (result, part) {
      if (part.type !== 'literal') result[part.type] = part.value;
      return result;
    }, {});
    return parts.year + '-' + parts.month + '-' + parts.day + 'T' + parts.hour + ':' + parts.minute;
  }
  function today() {
    const value = new Date(Date.now() - new Date().getTimezoneOffset() * 60000);
    return value.toISOString().slice(0, 10);
  }
  function ownerAccess() {
    try {
      return typeof modoAcesso !== 'undefined' && modoAcesso === 'auth' &&
        typeof identidadeBackend !== 'undefined' && identidadeBackend &&
        String(identidadeBackend.role || '').toLowerCase() === 'owner';
    } catch (_) { return false; }
  }
  function status(message, error) {
    const node = bySelector('[data-operacao-status]');
    if (!node) return;
    node.textContent = message || '';
    node.classList.toggle('erro', Boolean(error));
  }
  function setBusy(busy) {
    if (!state.root) return;
    state.root.setAttribute('aria-busy', String(Boolean(busy)));
    all('button,input,select,textarea').forEach(function (control) {
      if (busy) {
        if (!disabledBeforeBusy.has(control)) disabledBeforeBusy.set(control, control.disabled);
        control.disabled = true;
      } else if (disabledBeforeBusy.has(control)) {
        control.disabled = disabledBeforeBusy.get(control);
        disabledBeforeBusy.delete(control);
      }
    });
  }
  function formValue(form, name) {
    const field = form.elements && typeof form.elements.namedItem === 'function'
      ? form.elements.namedItem(name)
      : form.querySelector('[name="' + name + '"]');
    return field ? String(field.value || '').trim() : '';
  }
  function optional(value) { return value === '' ? null : value; }
  function selectedPatientName(id) {
    const row = state.data.clientes.find(function (item) { return item.id === id; });
    return row ? row.full_name : 'Paciente não carregada nesta listagem';
  }

  function assertSessionContext(generation) {
    if (generation !== state.generation || !ownerAccess()) {
      const error = new Error('Sessão operacional encerrada.');
      error.code = 'stale_session';
      throw error;
    }
  }

  async function jsonRequest(action, payload, proof) {
    const generation = state.generation;
    assertSessionContext(generation);
    const headers = await cabecalhosAcesso(true, proof);
    assertSessionContext(generation);
    const response = await fetch(API, {
      method: 'POST',
      headers: headers,
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      body: JSON.stringify(Object.assign({ acao: action }, payload || {}))
    });
    let data = {};
    try { data = await response.json(); } catch (_) { data = {}; }
    assertSessionContext(generation);
    if (!response.ok || data.ok === false || data.erro) {
      const error = new Error(data.erro || 'Não foi possível concluir a operação.');
      error.code = data.codigo || String(response.status);
      error.existingId = data.existing_id || null;
      throw error;
    }
    if (data.identity && typeof atualizarIdentidade === 'function') atualizarIdentidade(data);
    return data;
  }

  async function protectedRequest(action, payload, reason) {
    const generation = state.generation;
    assertSessionContext(generation);
    if (!window.AMJProtecao || typeof window.AMJProtecao.solicitarSenhaRecente !== 'function') {
      throw new Error('A confirmação administrativa não está disponível. Atualize a página.');
    }
    let proof = null;
    try {
      proof = await window.AMJProtecao.solicitarSenhaRecente({
        titulo: 'Confirmar operação clínica',
        motivo: reason || 'Alteração operacional confirmada pela gestão',
        motivoObrigatorio: true
      });
      assertSessionContext(generation);
      // Attendance updates replay by p_request_id in SQL. Reuse this payload's
      // intent ID after a lost response, but still obtain fresh confirmation and
      // validate the active session on every attempt. Other actions are unchanged.
      const operationId = action === 'salvar_atendimento' && payload &&
        payload.atendimento_id && payload.idempotency_key
        ? payload.idempotency_key : proof.operation_id;
      return await jsonRequest(action, Object.assign({}, payload || {}, {
        operation_id: operationId,
        motivo: proof.motivo || reason || 'Alteração operacional confirmada pela gestão'
      }), proof);
    } finally {
      if (proof && typeof proof.encerrar === 'function') await proof.encerrar();
    }
  }

  async function prontuarioJsonRequest(action, payload, proof) {
    const generation = state.generation;
    assertSessionContext(generation);
    const headers = await cabecalhosAcesso(true, proof);
    assertSessionContext(generation);
    const response = await fetch(PRONTUARIO_API, {
      method: 'POST',
      headers: headers,
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      body: JSON.stringify(Object.assign({ acao: action }, payload || {}))
    });
    let data = {};
    try { data = await response.json(); } catch (_) { data = {}; }
    assertSessionContext(generation);
    if (!response.ok || data.ok === false || data.erro) {
      const error = new Error(data.erro || 'Não foi possível atualizar o prontuário clínico.');
      error.code = data.codigo || String(response.status);
      throw error;
    }
    if (data.identity && typeof atualizarIdentidade === 'function') atualizarIdentidade(data);
    return data;
  }

  async function protectedProntuarioRequest(action, payload, options) {
    const generation = state.generation;
    assertSessionContext(generation);
    if (!window.AMJProtecao || typeof window.AMJProtecao.solicitarSenhaRecente !== 'function') {
      throw new Error('A confirmação administrativa não está disponível. Atualize a página.');
    }
    let proof = null;
    try {
      proof = await window.AMJProtecao.solicitarSenhaRecente(options || {});
      assertSessionContext(generation);
      return await prontuarioJsonRequest(action, Object.assign({}, payload || {}, {
        operation_id: proof.operation_id,
        motivo: proof.motivo || (options && options.motivo) ||
          'Alteração do prontuário clínico confirmada pela gestão'
      }), proof);
    } finally {
      if (proof && typeof proof.encerrar === 'function') await proof.encerrar();
    }
  }

  async function execute(action, payload, options) {
    const protectedAction = options && options.protected === true;
    return protectedAction
      ? protectedRequest(action, payload, options.reason)
      : jsonRequest(action, payload);
  }

  function options(rows, valueKey, label) {
    return '<option value="">Selecione</option>' + rows.map(function (row) {
      return '<option value="' + escapeHtml(row[valueKey]) + '">' + escapeHtml(label(row)) + '</option>';
    }).join('');
  }

  function shell() {
    return '' +
      '<section class="operacao-clinica" aria-labelledby="operacao-titulo">' +
        '<header class="operacao-cabecalho"><div><p class="operacao-supra">Gestão clínica</p>' +
          '<h2 id="operacao-titulo">Atendimentos e procedimentos</h2>' +
          '<p>Encontre a consulta da paciente. Abra o atendimento para consultar procedimentos, fotos, produtos e pagamentos.</p></div>' +
          '<div class="operacao-acoes"><button type="button" class="operacao-botao secundario" data-operacao-recarregar>Atualizar lista</button>' +
          '<button type="button" class="operacao-botao" data-atendimento-novo>Novo atendimento</button></div></header>' +
         '<p class="operacao-status" data-operacao-status role="status" aria-live="polite"></p>' +
         '<div data-operacao-paginacao></div>' +
         '<div class="operacao-resumo" data-operacao-resumo></div>' +
         '<details class="operacao-secundarios" data-operacao-guia><summary>Como trabalhar nesta tela — passo a passo</summary>' +
           '<ol><li><strong>Procure a paciente e a data</strong> nos atendimentos abaixo. Se já existe a consulta, abra esse registro.</li>' +
           '<li><strong>Novo dia de atendimento:</strong> use Novo atendimento, escolha a paciente, informe procedimento, data e responsável, e salve.</li>' +
           '<li><strong>Mais procedimentos no mesmo atendimento:</strong> abra a consulta e use Adicionar outro procedimento. Outro dia pede um novo atendimento.</li>' +
           '<li><strong>Prontuário, produtos e fotos:</strong> abra os botões da mesma consulta. Se não houver prontuário, use Preparar prontuário e fotos. O arquivo é privado; publicação depende de autorização específica.</li>' +
           '<li><strong>Valores e recebimentos:</strong> vincule a cobrança já cadastrada da paciente. A seleção não cria cobrança nem confirma recebimento.</li>' +
           '<li><strong>Retorno:</strong> abra Planejar retorno em Mais controles. Selecione a consulta e informe a data definida pela profissional.</li>' +
           '<li><strong>Arquivados:</strong> podem ser consultados. Restaurar é uma ação separada e só deve ser usada quando o arquivamento foi indevido.</li></ol>' +
           '<p class="operacao-nota">Agendamento, prontuário e cobrança são vínculos com registros existentes, não campos para digitar novamente. Ao salvar, espere a confirmação. Se houver erro, o preenchimento permanece na tela.</p></details>' +
         '<section class="operacao-card operacao-largo" data-atendimentos-historico><h3>Atendimentos cadastrados</h3>' +
           '<label>Buscar paciente ou procedimento<input type="search" data-operacao-busca placeholder="Digite o nome da paciente ou do procedimento"></label>' +
           '<p class="operacao-nota">Abra a consulta pela data. Cada atendimento reúne seus procedimentos e registros vinculados.</p>' +
           '<div data-operacao-atendimentos></div></section>' +
         '<section class="operacao-fotos-atalho" data-fotos-atalho aria-labelledby="operacao-fotos-atalho-titulo">' +
           '<div class="operacao-fotos-atalho-cabecalho"><div><p class="operacao-supra">Acesso direto</p>' +
             '<h3 id="operacao-fotos-atalho-titulo">Fotos da consulta selecionada</h3>' +
             '<p>A paciente, a data e o procedimento abaixo identificam onde as fotos serão guardadas.</p></div>' +
             '<span class="operacao-selo alerta" data-fotos-atalho-etapa>Escolha uma consulta</span></div>' +
           '<div class="operacao-fotos-atalho-controles"><label>Paciente e atendimento' +
             '<select data-fotos-atalho-atendimento aria-label="Paciente e atendimento para adicionar fotos"></select></label>' +
             '<button type="button" class="operacao-botao" data-fotos-atalho-abrir>Adicionar ou tirar fotos</button></div>' +
           '<p class="operacao-fotos-atalho-orientacao" data-fotos-atalho-orientacao role="status" aria-live="polite">' +
             'Selecione uma consulta para continuar.</p>' +
           '<p class="operacao-nota">As fotos ficam no prontuário desta consulta. Autorização para redes sociais é registrada separadamente.</p></section>' +
         '<details class="operacao-formulario-principal" data-atendimento-editor><summary>Novo atendimento ou edição selecionada</summary>' +
          '<form class="operacao-card" data-form-atendimento><h3 data-atendimento-form-titulo>Registrar visita e procedimento</h3>' +
            '<p class="operacao-contexto-atendimento" data-atendimento-contexto>Novo atendimento — selecione a paciente.</p>' +
            '<input name="atendimento_id" type="hidden"><input name="versao" type="hidden">' +
            '<label>Cliente<select name="cliente_id" required></select></label>' +
            '<label>Procedimento<input name="procedimento" maxlength="120" required></label>' +
            '<div class="operacao-dupla"><label>Realizado em<input name="realizado_em" type="datetime-local" required></label>' +
              '<label>Duração (min)<input name="duracao_minutos" type="number" min="1" max="720"></label></div>' +
            '<label>Responsável<select name="responsavel_id" required></select></label>' +
            '<label>Situação<select name="status" required><option value="realizado">Realizado</option>' +
              '<option value="concluido">Concluído</option><option value="interrompido">Interrompido</option></select></label>' +
            '<details data-atendimento-vinculos><summary>Agenda, prontuário e cobrança desta paciente</summary>' +
              '<p class="operacao-nota">Selecione registros já existentes da mesma paciente. É possível salvar o atendimento sem esses vínculos e completar depois.</p>' +
              '<label>Agendamento<select name="agendamento_id"></select></label><p class="operacao-nota" data-vinculo-ajuda="agendamento_id"></p>' +
              '<button type="button" class="operacao-botao secundario" data-vinculo-abrir="agenda">Abrir agenda</button>' +
              '<label>Prontuário<select name="protocolo_id"></select></label><p class="operacao-nota" data-vinculo-ajuda="protocolo_id"></p>' +
              '<button type="button" class="operacao-botao secundario" data-vinculo-abrir="prontuario">Abrir prontuário selecionado</button>' +
              '<label>Cobrança do procedimento<select name="lancamento_financeiro_id"></select></label><p class="operacao-nota" data-vinculo-ajuda="lancamento_financeiro_id"></p>' +
              '<button type="button" class="operacao-botao secundario" data-vinculo-abrir="cobranca">Abrir cobrança selecionada</button></details>' +
            '<p class="operacao-status" data-atendimento-status role="status" aria-live="polite"></p>' +
            '<div class="operacao-acoes"><button class="operacao-botao" type="submit" data-atendimento-salvar>Salvar atendimento</button>' +
              '<button class="operacao-botao secundario" type="button" data-atendimento-cancelar-edicao hidden>Fechar edição</button></div></form></details>' +
         '<details class="operacao-secundarios"><summary>Mais controles — retornos, preferências e custos</summary><div class="operacao-grade">' +
          '<form class="operacao-card" data-form-retorno><h3>Planejar retorno validado</h3>' +
            '<label>Atendimento<select name="atendimento_id" required></select></label>' +
            '<label>Recomendação<input name="recomendacao" maxlength="120" required></label>' +
            '<div class="operacao-dupla"><label>Data exata<input name="data_exata" type="date"></label>' +
              '<label>Próxima ação<input name="proxima_acao_em" type="datetime-local" required></label></div>' +
            '<details><summary>Usar janela em vez de data exata</summary><div class="operacao-dupla">' +
              '<label>Início<input name="janela_inicio" type="date"></label>' +
              '<label>Fim<input name="janela_fim" type="date"></label></div></details>' +
            '<label>Responsável<select name="responsavel_id" required></select></label>' +
            '<label>Orientação administrativa<textarea name="orientacao" maxlength="500"></textarea></label>' +
            '<button class="operacao-botao" type="submit">Criar retorno</button></form>' +
          '<form class="operacao-card" data-form-perfil><h3>Perfil operacional da paciente</h3>' +
            '<label>Cliente<select name="cliente_id" required></select></label>' +
            '<label>Nome preferido<input name="nome_preferido" maxlength="80"></label>' +
            '<label>Acessibilidade e apoio<textarea name="acessibilidade" maxlength="500"></textarea></label>' +
            '<label>Versão do aviso de privacidade<input name="aviso_privacidade_versao" maxlength="80"></label>' +
            '<label>Motivo da nova versão<textarea name="motivo" minlength="3" maxlength="500" required></textarea></label>' +
            '<button class="operacao-botao" type="submit">Registrar nova versão</button></form>' +
          '<form class="operacao-card" data-form-preferencia><h3>Preferência operacional</h3>' +
            '<label>Cliente<select name="cliente_id" required></select></label>' +
            '<div class="operacao-dupla"><label>Finalidade<select name="finalidade" required>' +
              '<option value="retorno">Retorno</option><option value="agenda">Agenda</option></select></label>' +
              '<label>Canal<select name="canal" required><option value="whatsapp">WhatsApp</option>' +
              '<option value="telefone">Telefone</option><option value="email">E-mail</option>' +
              '<option value="sms">SMS</option></select></label></div>' +
            '<label class="operacao-check"><input name="autorizado" type="checkbox"> Canal autorizado</label>' +
            '<label>Evidência<select name="tipo_evidencia" required><option value="solicitacao_paciente">Solicitação da paciente</option>' +
              '<option value="termo_assinado">Termo assinado</option><option value="revogacao_paciente">Revogação</option>' +
              '<option value="importacao_documentada">Importação documentada</option></select></label>' +
            '<label>Referência da evidência<input name="referencia_evidencia" maxlength="180"></label>' +
            '<button class="operacao-botao" type="submit">Registrar nova versão</button></form>' +
          '<form class="operacao-card" data-form-ajuste><h3>Perda, desperdício ou devolução</h3>' +
            '<label>Atendimento<select name="atendimento_id" required></select></label>' +
            '<label>Produto<select name="produto_id" required></select></label>' +
            '<label>Lote<select name="lote_id" required><option value="">Escolha primeiro o produto</option></select></label>' +
            '<div class="operacao-dupla"><label>Evento<select name="tipo_evento" required>' +
              '<option value="perda_tecnica">Perda técnica</option><option value="desperdicio">Desperdício</option>' +
              '<option value="devolucao_atendimento">Devolução</option></select></label>' +
              '<label>Quantidade<input name="quantidade" type="number" min="0.0001" step="0.0001" required></label></div>' +
            '<label>Ocorrido em<input name="ocorrido_em" type="datetime-local" required></label>' +
            '<label>Motivo<textarea name="motivo" minlength="3" maxlength="500" required></textarea></label>' +
            '<button class="operacao-botao" type="submit">Registrar evento auditado</button></form>' +
          '<form class="operacao-card" data-form-custo><h3>Ficha de custo esperado</h3>' +
            '<p class="operacao-nota">Informe as quantidades reais esperadas; o sistema não presume consumo.</p>' +
            '<label>Procedimento<input name="procedimento" maxlength="120" required></label>' +
            '<div class="operacao-dupla"><label>Situação<select name="status" required>' +
              '<option value="rascunho">Rascunho</option><option value="validada">Validada</option></select></label>' +
              '<label>Vigente desde<input name="vigente_desde" type="date" required></label></div>' +
            '<div data-custo-itens></div>' +
            '<button type="button" class="operacao-botao pequeno secundario" data-custo-adicionar>Adicionar produto</button>' +
            '<label>Motivo da nova versão<textarea name="motivo" minlength="3" maxlength="500" required></textarea></label>' +
            '<button class="operacao-botao" type="submit">Registrar versão da ficha</button></form>' +
          '<form class="operacao-card" data-form-taxa><h3>Taxa do recebimento</h3>' +
            '<p class="operacao-nota">Informe R$ 0,00 para declarar explicitamente que o pagamento não teve taxa.</p>' +
            '<label>Atendimento<select name="atendimento_id" required></select></label>' +
            '<label>Pagamento<select name="pagamento_id" required><option value="">Escolha o atendimento</option></select></label>' +
            '<div class="operacao-dupla"><label>Taxa (R$)<input name="valor" type="number" min="0" step="0.01" required></label>' +
              '<label>Fonte<select name="tipo_fonte" required><option value="informada">Informada</option>' +
                '<option value="comprovante">Comprovante</option><option value="operadora">Operadora</option></select></label></div>' +
            '<label>Referência da fonte<input name="referencia_fonte" maxlength="180"></label>' +
            '<button class="operacao-botao" type="submit">Declarar taxa</button></form>' +
        '</div></details>' +
        '<details class="operacao-secundarios"><summary>Históricos e relatórios — retornos, custos e rentabilidade</summary>' +
        '<section class="operacao-card operacao-largo"><h3>Preferências de contato vigentes</h3>' +
          '<p class="operacao-nota">Cada linha mostra a versão vigente já registrada para paciente, finalidade e canal.</p>' +
          '<div data-operacao-preferencias-contato></div></section>' +
        '<section class="operacao-card operacao-largo"><h3>Histórico de perdas, desperdícios e devoluções</h3>' +
          '<p class="operacao-nota">Eventos auditáveis ligados ao atendimento, produto e lote corretos.</p>' +
          '<div data-operacao-eventos-consumo></div></section>' +
        '<section class="operacao-card operacao-largo"><h3>Fila de retornos</h3><div data-operacao-retornos></div></section>' +
        '<section class="operacao-card operacao-largo"><h3>Versões das fichas de custo</h3>' +
          '<div data-operacao-fichas-custo></div></section>' +
        '<section class="operacao-card operacao-largo"><h3>Declarações de taxa</h3>' +
          '<div data-operacao-taxas></div></section>' +
        '<section class="operacao-card operacao-largo"><h3>Rentabilidade por atendimento</h3>' +
          '<p class="operacao-nota">A métrica é margem de contribuição gerencial. Linhas incompletas não recebem margem.</p>' +
          '<div class="operacao-tabela-wrap"><table><thead><tr><th>Data</th><th>Procedimento</th><th>Valor do procedimento</th>' +
          '<th>Recebido</th><th>Materiais</th><th>Taxas</th><th>Margem</th><th>Qualidade</th></tr></thead>' +
          '<tbody data-operacao-rentabilidade></tbody></table></div></section></details>' +
      '</section>';
  }

  function activeCostProducts() {
    return state.data.produtos.filter(function (row) {
      return row.active && row.stock_control && !row.archived_at;
    });
  }

  function addCostItem(productId, amount) {
    const container = bySelector('[data-custo-itens]');
    if (!container) return;
    const productOptions = options(activeCostProducts(), 'id', function (row) {
      return row.name + ' · ' + row.unit;
    });
    container.insertAdjacentHTML('beforeend', '<div class="operacao-item-custo" data-custo-item>' +
      '<label>Produto<select name="custo_produto_id" required>' + productOptions + '</select></label>' +
      '<label>Quantidade<input name="custo_quantidade" type="number" min="0.0001" step="0.0001" required></label>' +
      '<span data-custo-unidade>—</span>' +
      '<button type="button" class="operacao-botao pequeno perigo" data-custo-remover>Remover</button></div>');
    const row = container.lastElementChild;
    if (!row) return;
    row.querySelector('select').value = productId || '';
    row.querySelector('input').value = amount == null ? '' : amount;
    updateCostUnit(row);
  }

  function updateCostUnit(row) {
    if (!row) return;
    const select = row.querySelector('select[name="custo_produto_id"]');
    const product = state.data.produtos.find(function (item) { return item.id === (select ? select.value : ''); });
    const unit = row.querySelector('[data-custo-unidade]');
    if (unit) unit.textContent = product ? product.unit : '—';
  }

  function hydrateCostItems() {
    const container = bySelector('[data-custo-itens]');
    if (!container) return;
    if (!container.querySelector('[data-custo-item]')) addCostItem('', null);
    all('[data-custo-item]').forEach(function (row) {
      const select = row.querySelector('select[name="custo_produto_id"]');
      const current = select ? select.value : '';
      if (select) {
        select.innerHTML = options(activeCostProducts(), 'id', function (product) {
          return product.name + ' · ' + product.unit;
        });
        select.value = current;
      }
      updateCostUnit(row);
    });
  }

  function hydrateFeePayments() {
    const form = bySelector('[data-form-taxa]');
    if (!form) return;
    const attendance = state.data.atendimentos.find(function (row) {
      return row.id === formValue(form, 'atendimento_id');
    });
    const entryIds = [];
    if (attendance && attendance.financial_entry_id) entryIds.push(attendance.financial_entry_id);
    state.data.procedimentos_atendimento.forEach(function (item) {
      if (attendance && item.attendance_id === attendance.id && !item.archived_at && item.financial_entry_id) {
        entryIds.push(item.financial_entry_id);
      }
    });
    const current = formValue(form, 'pagamento_id');
    const rows = state.data.pagamentos.filter(function (row) {
      return entryIds.includes(row.entry_id) && row.movement_type === 'pagamento' && !row.reversed_payment_id;
    });
    form.elements.pagamento_id.innerHTML = options(rows, 'id', function (row) {
      return (row.payment_method || 'Pagamento') + ' · ' + money(row.amount) + ' · ' + dateTime(row.paid_at);
    });
    form.elements.pagamento_id.value = current;
  }

  function selectedPhotoShortcutVisit() {
    const select = bySelector('[data-fotos-atalho-atendimento]');
    if (!select || !select.value) return null;
    return state.data.atendimentos.find(function (row) {
      return row.id === select.value;
    }) || null;
  }

  function updatePhotoShortcut() {
    const visit = selectedPhotoShortcutVisit();
    const step = bySelector('[data-fotos-atalho-etapa]');
    const guidance = bySelector('[data-fotos-atalho-orientacao]');
    const button = bySelector('[data-fotos-atalho-abrir]');
    if (!step || !guidance || !button) return;
    button.disabled = !visit;
    if (!visit) {
      step.textContent = 'Escolha uma consulta';
      step.classList.add('alerta');
      guidance.textContent = state.data.atendimentos.some(function (row) { return !row.archived_at; })
        ? 'Selecione uma consulta para continuar.'
        : 'Cadastre primeiro o atendimento da paciente para guardar as fotos na consulta correta.';
      button.textContent = 'Adicionar ou tirar fotos';
      return;
    }
    const protocol = protocolForVisit(visit);
    if ((!visit.protocol_id || !protocol) && !visit.archived_at) {
      step.textContent = 'Prontuário pendente';
      step.classList.add('alerta');
      guidance.textContent = 'Primeiro prepare o prontuário desta consulta. Nenhum consentimento ou foto será criado automaticamente.';
      button.textContent = 'Preparar prontuário para fotos';
      return;
    }
    if (visit.archived_at || protocol && protocol.archived_at) {
      step.textContent = 'Somente leitura';
      step.classList.add('alerta');
      guidance.textContent = 'O prontuário está arquivado. Você pode abrir o histórico para leitura. Para anexar novas fotos, revise e restaure o registro pelo prontuário, se o arquivamento foi indevido.';
      button.textContent = 'Abrir prontuário arquivado';
      return;
    }
    step.textContent = 'Galeria liberada';
    step.classList.remove('alerta');
    guidance.textContent = 'Arquivo clínico privado — publicação exige autorização específica. Escolha imagens ou use a câmera; cada arquivo ficará nesta consulta.';
    button.textContent = 'Adicionar ou tirar fotos';
  }

  function hydratePhotoShortcut() {
    const select = bySelector('[data-fotos-atalho-atendimento]');
    if (!select) return;
    const current = state.selectedAttendanceId || select.value;
    const rows = state.data.atendimentos.slice()
      .sort(function (a, b) { return String(b.attended_at || '').localeCompare(String(a.attended_at || '')); });
    select.innerHTML = options(rows, 'id', function (row) {
      const protocol = protocolForVisit(row);
      return selectedPatientName(row.patient_id) + ' · ' + dateTime(row.attended_at) + ' · ' + row.procedure_kind +
        (row.archived_at || protocol && protocol.archived_at ? ' · arquivado / leitura' : '');
    });
    if (rows.some(function (row) { return row.id === current; })) select.value = current;
    updatePhotoShortcut();
  }

  function preserveOptions(node, html) {
    if (!node) return;
    const current = node.value;
    const old = Array.from(node.options || []).find(function (option) { return option.value === current; });
    node.innerHTML = html;
    if (current && !Array.from(node.options || []).some(function (option) { return option.value === current; })) {
      node.insertAdjacentHTML('beforeend', '<option value="' + escapeHtml(current) + '">' +
        escapeHtml(old && old.textContent || 'Vínculo atual preservado') + '</option>');
    }
    node.value = current || '';
  }
  function selectHistoricalValue(node, value, label) {
    if (value && !Array.from(node.options).some(function (option) { return option.value === value; })) {
      node.insertAdjacentHTML('beforeend', '<option value="' + escapeHtml(value) + '">' +
        escapeHtml(label) + ' · vínculo atual preservado</option>');
    }
    node.value = value || '';
  }
  function resetAttendanceIdentityOptions(form) {
    form.elements.cliente_id.innerHTML = options(state.data.clientes.filter(function (row) {
      return !row.archived_at;
    }), 'id', function (row) { return row.full_name; });
    form.elements.responsavel_id.innerHTML = options(state.data.responsaveis, 'user_id', function (row) {
      return row.display_name;
    });
  }
  function attendanceFingerprint() {
    const form = bySelector('[data-form-atendimento]');
    if (!form) return '';
    return JSON.stringify(['atendimento_id','cliente_id','procedimento','realizado_em','duracao_minutos',
      'responsavel_id','status','agendamento_id','protocolo_id','lancamento_financeiro_id'].map(function (name) { return formValue(form, name); }));
  }
  function attendanceDirty() { return Boolean(state.attendanceBaseline && state.attendanceBaseline !== attendanceFingerprint()); }
  function attendanceStatus(message, error) {
    const node = bySelector('[data-atendimento-status]');
    if (node) { node.textContent = message || ''; node.classList.toggle('erro', Boolean(error)); }
  }
  function attendanceContext() {
    const form = bySelector('[data-form-atendimento]');
    const node = bySelector('[data-atendimento-contexto]');
    if (!form || !node) return;
    node.textContent = (formValue(form, 'atendimento_id') ? 'Editando: ' : 'Novo atendimento: ') +
      (formValue(form, 'cliente_id') ? selectedPatientName(formValue(form, 'cliente_id')) : 'selecione a paciente') +
      (formValue(form, 'realizado_em') ? ' · ' + dateTime(formValue(form, 'realizado_em')) : '') +
      (formValue(form, 'procedimento') ? ' · ' + formValue(form, 'procedimento') : '');
  }
  function hydrateAttendanceLinks() {
    const form = bySelector('[data-form-atendimento]');
    if (!form) return;
    const patientId = formValue(form, 'cliente_id');
    const visitId = formValue(form, 'atendimento_id');
    const configs = [
      { name:'agendamento_id', rows:state.data.agendamentos.filter(function (row) {
        return state.data.vinculos_agenda.some(function (link) { return link.source_id === row.id && link.patient_id === patientId; });
      }), label:function (row) { return row.procedimento + ' · ' + dateTime(row.inicio_em); }, empty:'Nenhum agendamento vinculado a esta paciente. Cadastre ou vincule pela Agenda; este atendimento pode ser salvo sem agendamento.' },
      { name:'protocolo_id', rows:state.data.protocolos.filter(function (row) {
        return row.patient_id === patientId && (!row.archived_at || row.id === formValue(form, 'protocolo_id')) &&
          !state.data.atendimentos.some(function (visit) { return visit.id !== visitId && visit.protocol_id === row.id && !visit.archived_at; });
      }), label:function (row) { return row.procedure_kind + ' · ' + (row.procedure_date || 'sem data') + (row.archived_at ? ' · arquivado / vínculo preservado' : ''); }, empty:'Nenhum prontuário disponível desta paciente. Salve o atendimento e use Preparar prontuário e fotos na consulta.' },
      { name:'lancamento_financeiro_id', rows:state.data.lancamentos_receita.filter(function (row) {
        return row.patient_id === patientId && (row.state === 'ativo' || row.id === formValue(form, 'lancamento_financeiro_id')) &&
          !state.data.atendimentos.some(function (visit) { return visit.id !== visitId && visit.financial_entry_id === row.id && !visit.archived_at; }) &&
          !state.data.procedimentos_atendimento.some(function (item) { return item.attendance_id !== visitId && item.financial_entry_id === row.id && !item.archived_at; });
      }), label:function (row) { return row.description + ' · ' + money(row.total_amount); }, empty:'Nenhuma cobrança disponível desta paciente. Cadastre a cobrança no Financeiro e depois vincule aqui; não crie uma segunda cobrança para a mesma venda.' }
    ];
    configs.forEach(function (config) {
      const select = form.elements[config.name];
      preserveOptions(select, '<option value="">Sem vínculo — completar depois</option>' + config.rows.map(function (row) {
        return '<option value="' + escapeHtml(row.id) + '">' + escapeHtml(config.label(row)) + '</option>';
      }).join(''));
      const help = bySelector('[data-vinculo-ajuda="' + config.name + '"]');
      if (help) help.textContent = !patientId ? 'Escolha a paciente primeiro.' : config.rows.length
        ? 'Selecione o registro correspondente a esta consulta. O vínculo é salvo junto com o atendimento.' : config.empty;
    });
    attendanceContext();
  }

  function hydrateForms() {
    const patientOptions = options(state.data.clientes.filter(function (row) { return !row.archived_at; }), 'id', function (row) {
      return row.full_name;
    });
    const memberOptions = options(state.data.responsaveis, 'user_id', function (row) { return row.display_name; });
    all('select[name="cliente_id"]').forEach(function (node) { preserveOptions(node, patientOptions); });
    all('select[name="responsavel_id"]').forEach(function (node) { preserveOptions(node, memberOptions); });
    const attendanceOptions = options(state.data.atendimentos.filter(function (row) { return !row.archived_at; }), 'id', function (row) {
      return selectedPatientName(row.patient_id) + ' · ' + row.procedure_kind + ' · ' + dateTime(row.attended_at);
    });
    all('select[name="atendimento_id"]').forEach(function (node) { preserveOptions(node, attendanceOptions); });
    hydrateAttendanceLinks();
    const productSelect = bySelector('[data-form-ajuste] select[name="produto_id"]');
    if (productSelect) preserveOptions(productSelect, options(state.data.produtos.filter(function (row) {
      return row.active && row.stock_control && !row.archived_at;
    }), 'id', function (row) { return row.name + ' · ' + row.unit; }));
    hydratePhotoShortcut();
    hydrateCostItems();
    hydrateFeePayments();
    hydrateAdjustmentLots();
    const attendanceForm = bySelector('[data-form-atendimento]');
    const returnForm = bySelector('[data-form-retorno]');
    const adjustmentForm = bySelector('[data-form-ajuste]');
    if (attendanceForm && !attendanceForm.elements.realizado_em.value) attendanceForm.elements.realizado_em.value = localNow();
    if (returnForm) {
      if (!returnForm.elements.data_exata.value && !returnForm.elements.janela_inicio.value && !returnForm.elements.janela_fim.value) returnForm.elements.data_exata.value = today();
      if (!returnForm.elements.proxima_acao_em.value) returnForm.elements.proxima_acao_em.value = localNow();
    }
    if (adjustmentForm && !adjustmentForm.elements.ocorrido_em.value) adjustmentForm.elements.ocorrido_em.value = localNow();
    const costForm = bySelector('[data-form-custo]');
    if (costForm && !costForm.elements.vigente_desde.value) costForm.elements.vigente_desde.value = today();
    attendanceContext();
    if (!state.attendanceBaseline) state.attendanceBaseline = attendanceFingerprint();
  }

  function hydrateAdjustmentLots() {
    const form = bySelector('[data-form-ajuste]');
    if (!form) return;
    const productId = formValue(form, 'produto_id');
    const isReturn = formValue(form, 'tipo_evento') === 'devolucao_atendimento';
    const lots = state.data.estoque_lotes.filter(function (row) {
      return row.product_id === productId && (isReturn || num(row.quantity_balance) > 0);
    });
    preserveOptions(form.elements.lote_id, options(lots, 'lot_id', function (row) {
      return row.lot + ' · ' + row.quantity_balance + ' ' + row.unit + ' · vence ' + row.expiry;
    }));
  }

  function resetAttendanceEditor() {
    const form = bySelector('[data-form-atendimento]');
    if (!form) return;
    form.reset();
    resetAttendanceIdentityOptions(form);
    form.elements.atendimento_id.value = '';
    form.elements.versao.value = '';
    form.elements.realizado_em.value = localNow();
    form.elements.status.value = 'realizado';
    form.elements.procedimento.disabled = false;
    const title = bySelector('[data-atendimento-form-titulo]');
    const submitButton = bySelector('[data-atendimento-salvar]');
    const cancelButton = bySelector('[data-atendimento-cancelar-edicao]');
    if (title) title.textContent = 'Registrar visita e procedimento';
    if (submitButton) submitButton.textContent = 'Salvar atendimento';
    if (cancelButton) cancelButton.hidden = true;
    state.attendanceRevision += 1;
    state.selectedAttendanceId = '';
    const shortcut = bySelector('[data-fotos-atalho-atendimento]');
    if (shortcut) shortcut.value = '';
    hydrateAttendanceLinks();
    updatePhotoShortcut();
    attendanceStatus('');
    state.attendanceBaseline = attendanceFingerprint();
  }

  function editAttendance(id, skipConfirmation) {
    const row = state.data.atendimentos.find(function (item) { return item.id === id; });
    const form = bySelector('[data-form-atendimento]');
    if (!row || !form || row.archived_at) return false;
    if (!skipConfirmation && attendanceDirty() && !window.confirm('Há alterações não salvas. Deseja descartá-las e abrir este atendimento?')) return false;
    resetAttendanceIdentityOptions(form);
    state.attendanceRevision += 1;
    form.elements.atendimento_id.value = row.id;
    form.elements.versao.value = row.version;
    // A saved attendance can outlive an active-patient/member option or lie outside
    // the independently paginated catalogs. Keep its original IDs, never a default.
    selectHistoricalValue(form.elements.cliente_id, row.patient_id, selectedPatientName(row.patient_id));
    form.elements.procedimento.value = row.procedure_kind || '';
    form.elements.procedimento.disabled = true;
    form.elements.realizado_em.value = timestampToLocalInput(row.attended_at);
    form.elements.duracao_minutos.value = row.duration_minutes || '';
    selectHistoricalValue(form.elements.responsavel_id, row.responsible_user_id, 'Responsável do atendimento');
    form.elements.status.value = row.status || 'realizado';
    [['agendamento_id',row.appointment_id],['protocolo_id',row.protocol_id],['lancamento_financeiro_id',row.financial_entry_id]].forEach(function (pair) {
      const select = form.elements[pair[0]];
      select.value = '';
      if (pair[1] && !Array.from(select.options).some(function (option) { return option.value === pair[1]; })) {
        select.insertAdjacentHTML('beforeend', '<option value="' + escapeHtml(pair[1]) + '">Vínculo atual preservado</option>');
      }
      select.value = pair[1] || '';
    });
    hydrateAttendanceLinks();
    state.selectedAttendanceId = row.id;
    const shortcut = bySelector('[data-fotos-atalho-atendimento]');
    if (shortcut) shortcut.value = row.id;
    updatePhotoShortcut();
    state.attendanceBaseline = attendanceFingerprint();
    attendanceStatus('Você está editando este atendimento. Fotos e vínculos se referem à mesma consulta.');
    const title = bySelector('[data-atendimento-form-titulo]');
    const submitButton = bySelector('[data-atendimento-salvar]');
    const cancelButton = bySelector('[data-atendimento-cancelar-edicao]');
    if (title) title.textContent = 'Editar atendimento';
    if (submitButton) submitButton.textContent = 'Salvar alterações';
    if (cancelButton) cancelButton.hidden = false;
    const editor = bySelector('[data-atendimento-editor]');
    if (editor) editor.open = true;
    form.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return true;
  }

  function startAttendance() {
    if (attendanceDirty() && !window.confirm('Há alterações não salvas. Deseja descartá-las e iniciar outro atendimento?')) return false;
    resetAttendanceEditor();
    const editor = bySelector('[data-atendimento-editor]');
    if (editor) { editor.open = true; editor.scrollIntoView({behavior:'smooth',block:'start'}); }
    const form = bySelector('[data-form-atendimento]');
    if (form) form.elements.cliente_id.focus({preventScroll:true});
    return true;
  }
  function selectAttendanceFromPhotos() {
    const select = bySelector('[data-fotos-atalho-atendimento]');
    const previous = state.selectedAttendanceId;
    if (select.value === previous) { updatePhotoShortcut(); return; }
    if (attendanceDirty() && !window.confirm('Há alterações não salvas. Deseja descartá-las e trocar de atendimento?')) {
      select.value = previous; updatePhotoShortcut(); return;
    }
    const row = state.data.atendimentos.find(function (item) { return item.id === select.value; });
    if (row && !row.archived_at) { editAttendance(row.id, true); return; }
    const selectedId = select.value;
    resetAttendanceEditor();
    const editor = bySelector('[data-atendimento-editor]');
    if (editor) editor.open = false;
    select.value = selectedId;
    state.selectedAttendanceId = selectedId;
    updatePhotoShortcut();
  }

  function filterAttendances() {
    const search = bySelector('[data-operacao-busca]');
    const query = String(search && search.value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
    all('[data-atendimento-card]').forEach(function (card) {
      const row = state.data.atendimentos.find(function (item) { return item.id === card.dataset.atendimentoCard; });
      const text = row ? selectedPatientName(row.patient_id) + ' ' + row.procedure_kind + ' ' + dateTime(row.attended_at) : '';
      card.hidden = !text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().includes(query);
    });
    all('.operacao-paciente').forEach(function (group) {
      group.hidden = !Array.from(group.querySelectorAll('[data-atendimento-card]')).some(function (card) { return !card.hidden; });
    });
  }

  function resetProcedureEditor(form) {
    if (!form) return;
    form.reset();
    form.elements.procedimento_item_id.value = '';
    form.elements.versao.value = '';
    const submitButton = form.querySelector('[data-procedimento-submit]');
    const cancelButton = form.querySelector('[data-procedimento-cancelar]');
    if (submitButton) submitButton.textContent = 'Adicionar';
    if (cancelButton) cancelButton.hidden = true;
  }

  function editProcedureInline(itemId) {
    const item = state.data.procedimentos_atendimento.find(function (row) { return row.id === itemId; });
    if (!item || item.archived_at) throw new Error('Procedimento não encontrado. Atualize a tela.');
    const form = bySelector('[data-form-procedimento][data-atendimento-id="' + item.attendance_id + '"]');
    if (!form) throw new Error('O formulário desse procedimento não está disponível.');
    form.elements.procedimento_item_id.value = item.id;
    form.elements.versao.value = item.version;
    form.elements.procedimento.value = item.procedure_kind || '';
    form.elements.regiao_procedimento.value = item.procedure_region || '';
    form.elements.procedimento_em.value = timestampToLocalInput(item.performed_at);
    const financial = form.elements.lancamento_financeiro_id;
    if (item.financial_entry_id && !Array.from(financial.options).some(function (option) {
      return option.value === item.financial_entry_id;
    })) {
      const entry = state.data.lancamentos_receita.find(function (row) {
        return row.id === item.financial_entry_id;
      });
      const option = document.createElement('option');
      option.value = item.financial_entry_id;
      option.textContent = entry
        ? entry.description + ' · ' + money(entry.total_amount) + ' · vínculo atual'
        : 'Cobrança atualmente vinculada';
      financial.appendChild(option);
    }
    financial.value = item.financial_entry_id || '';
    form.elements.confirmar_repeticao_distinta.checked = Boolean(item.duplicate_of_id);
    form.elements.motivo_repeticao_distinta.value = item.distinct_duplicate_reason || '';
    const submitButton = form.querySelector('[data-procedimento-submit]');
    const cancelButton = form.querySelector('[data-procedimento-cancelar]');
    if (submitButton) submitButton.textContent = 'Salvar correção';
    if (cancelButton) cancelButton.hidden = false;
    form.scrollIntoView({ behavior: 'smooth', block: 'center' });
    form.elements.procedimento.focus();
  }

  function renderSummary() {
    const pending = state.data.fila_retorno.filter(function (row) {
      return !['concluido', 'cancelado', 'bloqueado'].includes(row.status);
    }).length;
    const complete = state.data.rentabilidade_atendimentos.filter(function (row) { return !row.is_incomplete; });
    const margin = complete.reduce(function (sum, row) { return sum + num(row.managerial_contribution_margin); }, 0);
    const incomplete = state.data.rentabilidade_atendimentos.length - complete.length;
    const node = bySelector('[data-operacao-resumo]');
    if (!node) return;
    node.innerHTML = '<article><span>Atendimentos</span><strong>' + state.data.atendimentos.length + '</strong></article>' +
      '<article><span>Retornos em aberto</span><strong>' + pending + '</strong></article>' +
      '<article><span>Margem completa</span><strong>' + escapeHtml(money(margin)) + '</strong></article>' +
      '<article><span>Dados incompletos</span><strong>' + incomplete + '</strong></article>';
  }

  function procedureOptionsForVisit(items, selected) {
    return '<option value="">Visita inteira</option>' + items.filter(function (item) {
      return !item.archived_at;
    }).map(function (item) {
      return '<option value="' + escapeHtml(item.id) + '"' +
        (item.id === selected ? ' selected' : '') + '>' + escapeHtml(item.procedure_kind) + '</option>';
    }).join('');
  }

  function consumptionOptionsForPhoto(visitId, productId, selected) {
    return '<option value="">Sem evento de consumo vinculado</option>' + state.data.eventos_consumo.filter(function (event) {
      return productId && event.attendance_id === visitId && event.product_id === productId;
    }).map(function (event) {
      return '<option value="' + escapeHtml(event.id) + '"' + (event.id === selected ? ' selected' : '') + '>' +
        escapeHtml(event.event_kind + ' · ' + event.amount + ' ' + event.unit + ' · ' + dateTime(event.occurred_at)) +
        '</option>';
    }).join('');
  }

  function productTypeLabel(value) {
    return ({
      bioestimulador: 'bioestimulador', toxina_botulinica: 'toxina botulínica',
      preenchedor: 'preenchedor', skinbooster: 'skinbooster', injetavel: 'injetável',
      medicamento: 'medicamento', dermocosmetico: 'dermocosmético', descartavel: 'descartável',
      epi: 'EPI', limpeza: 'limpeza', revenda: 'revenda', outro: 'outro'
    })[String(value || '')] || String(value || '').replace(/_/g, ' ');
  }

  function protocolProductRows(protocolId) {
    return protocolProductsById.get(String(protocolId || '')) || [];
  }

  function photoProductOptions(protocolId, selected) {
    const seen = new Set();
    const products = protocolProductRows(protocolId).filter(function (item) {
      const id = String(item.product_id || '');
      const lot = String(item.lot || '').trim();
      if (!id || !lot || seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    return '<option value="">Foto geral de produtos, ativos ou ampolas</option>' +
      products.map(function (item) {
        const catalog = state.data.produtos.find(function (row) { return row.id === item.product_id; });
        const label = [item.product_name_snapshot || (catalog && catalog.name) || 'Produto utilizado',
          item.brand_name_snapshot, productTypeLabel(catalog && catalog.product_type),
          item.unit || (catalog && catalog.unit)].filter(Boolean).join(' · ');
        return '<option value="' + escapeHtml(item.product_id) + '"' +
          (String(item.product_id) === String(selected) ? ' selected' : '') + '>' + escapeHtml(label) + '</option>';
      }).join('');
  }

  function photoLotOptions(protocolId, productId, selected) {
    const seen = new Set();
    const lots = protocolProductRows(protocolId).filter(function (item) {
      const lot = String(item.lot || '').trim();
      if (!productId || String(item.product_id || '') !== String(productId) || !lot || seen.has(lot)) return false;
      seen.add(lot);
      return true;
    });
    const prompt = productId ? 'Selecione o lote registrado no prontuário' : 'Selecione primeiro o produto';
    return '<option value="">' + prompt + '</option>' + lots.map(function (item) {
      const label = [item.lot, item.expiry ? 'validade ' + item.expiry : '',
        item.amount ? item.amount + ' ' + (item.unit || '') : ''].filter(Boolean).join(' · ');
      return '<option value="' + escapeHtml(item.lot) + '"' +
        (String(item.lot) === String(selected) ? ' selected' : '') + '>' + escapeHtml(label) + '</option>';
    }).join('');
  }

  function photoLotValue(form) {
    return formValue(form, 'lote_selecionado');
  }

  function photoCategoryCounts(rows) {
    const counts = { antes: 0, durante: 0, depois: 0, produtos: 0, arquivadas: 0 };
    (Array.isArray(rows) ? rows : []).forEach(function (photo) {
      if (photo.archived_at) { counts.arquivadas += 1; return; }
      if (photo.category === 'antes') counts.antes += 1;
      else if (photo.category === 'durante' || photo.category === 'durante_legado') counts.durante += 1;
      else if (photo.category === 'depois') counts.depois += 1;
      else if (photo.category === 'produtos_utilizados') counts.produtos += 1;
    });
    return counts;
  }

  function photoOverviewForVisit(visit, summary) {
    const indexed = state.data.indice_fotos_atendimento.filter(function (photo) {
      return photo.attendance_id === visit.id;
    });
    const loaded = state.data.fotos_atendimento.filter(function (photo) {
      return photo.attendance_id === visit.id;
    });
    const counts = photoCategoryCounts(indexed.length ? indexed : loaded);
    const countedActive = counts.antes + counts.durante + counts.depois + counts.produtos;
    return {
      counts: counts,
      active: summary ? num(summary.active_photo_count) : countedActive,
      archived: summary ? num(summary.archived_photo_count) : counts.arquivadas,
      clinical: summary ? num(summary.active_clinical_count) : counts.antes + counts.durante + counts.depois,
      products: summary ? num(summary.active_product_count) : counts.produtos
    };
  }

  function renderGalleryPhoto(photo, visit, items, visitArchived) {
    const product = state.data.produtos.find(function (row) { return row.id === photo.product_id; });
    const archived = Boolean(photo.archived_at);
    const preview = photo.miniatura_url || photo.url_assinada;
    const media = archived || !preview
      ? '<div class="operacao-foto-indisponivel">' + (archived ? 'Foto arquivada' : 'Prévia temporariamente indisponível') + '</div>'
      : '<a href="' + escapeHtml(photo.url_assinada || preview) + '" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">' +
        '<img src="' + escapeHtml(preview) + '" alt="Foto clínica ' + escapeHtml(photo.category) +
        '" loading="lazy" decoding="async" referrerpolicy="no-referrer"></a>';
    const details = [photo.caption, product && product.name, photo.lot_snapshot && 'Lote ' + photo.lot_snapshot]
      .filter(Boolean).map(escapeHtml).join(' · ');
    const archiveAction = visitArchived ? '' : archived
      ? '<button type="button" class="operacao-botao pequeno" data-foto-restaurar="' +
        escapeHtml(photo.photo_id) + '">Restaurar foto</button>'
      : '<button type="button" class="operacao-botao pequeno perigo" data-foto-arquivar="' +
        escapeHtml(photo.photo_id) + '">Apagar/Arquivar</button>';
    const metadataForm = archived || visitArchived ? '' :
      '<form class="operacao-foto-metadados" data-form-foto-metadados data-atendimento-id="' + escapeHtml(visit.id) + '" ' +
        'data-foto-id="' + escapeHtml(photo.photo_id) + '">' +
        '<input name="versao" type="hidden" value="' + escapeHtml(photo.version || 1) + '">' +
        '<label>Procedimento<select name="procedimento_item_id">' +
          procedureOptionsForVisit(items, photo.procedure_item_id) + '</select></label>' +
        '<label>Ordem<input name="ordem" type="number" min="1" value="' +
          escapeHtml(photo.display_order || 1) + '"></label>' +
        '<label>Legenda<input name="legenda" maxlength="300" value="' + escapeHtml(photo.caption || '') + '"></label>' +
        (photo.category === 'produtos_utilizados'
          ? '<label>Consumo estruturado<select name="evento_consumo_id">' +
            consumptionOptionsForPhoto(visit.id, photo.product_id, photo.consumption_event_id) + '</select></label>'
          : '<input name="evento_consumo_id" type="hidden">') +
        '<button class="operacao-botao pequeno secundario" type="submit">Salvar organização</button></form>';
    return '<article class="operacao-foto-card' + (archived ? ' arquivado' : '') + '" data-foto-card="' +
      escapeHtml(photo.photo_id) + '">' + media +
      '<div class="operacao-foto-info"><span>' + escapeHtml(dateTime(photo.captured_at)) +
      (details ? ' · ' + details : '') + '</span><div class="operacao-acoes">' + archiveAction + '</div></div>' +
      metadataForm + '</article>';
  }

  function protocolForVisit(visit) {
    return state.data.protocolos.find(function (protocol) {
      return protocol.id === visit.protocol_id;
    }) || null;
  }

  function protocolSummaryForVisit(visit) {
    return state.data.resumos_prontuario_atendimento.find(function (summary) {
      return summary.attendance_id === visit.id;
    }) || null;
  }

  function protocolStatusLabel(protocol) {
    if (!protocol) return 'não vinculado';
    if (protocol.archived_at) return 'arquivado';
    return ({ draft: 'rascunho', signed: 'finalizado' })[protocol.status] || protocol.status || 'desconhecido';
  }

  async function loadProtocolProducts(protocolId) {
    const id = String(protocolId || '');
    if (!id) return [];
    if (protocolProductsById.has(id)) return protocolProductsById.get(id);
    if (loadingProtocolProducts.has(id)) return await loadingProtocolProducts.get(id);
    const task = (async function () {
      const data = await prontuarioJsonRequest('listar', {
        protocolo_id: id, pagina: 1, por_pagina: 1, incluir_arquivados: true
      });
      const protocol = (Array.isArray(data.protocolos) ? data.protocolos : []).find(function (item) {
        return String(item.id || '') === id;
      });
      if (!protocol) throw new Error('Não foi possível conferir os produtos deste prontuário.');
      const products = Array.isArray(protocol.produtos_rascunho) ? protocol.produtos_rascunho :
        Array.isArray(protocol.produtos) ? protocol.produtos : [];
      protocolProductsById.set(id, products);
      return products;
    })().finally(function () {
      if (loadingProtocolProducts.get(id) === task) loadingProtocolProducts.delete(id);
    });
    loadingProtocolProducts.set(id, task);
    return await task;
  }

  async function loadAttendancePhotos(attendanceId) {
    const id = String(attendanceId || '');
    if (!id || attendancePhotosAreFresh(id)) return true;
    if (loadingPhotoAttendances.has(id)) return await loadingPhotoAttendances.get(id);
    const epoch = photoLoadEpoch;
    const task = (async function () {
      status('Carregando fotos clínicas privadas…');
      const visitBeforeLoad = state.data.atendimentos.find(function (item) { return item.id === id; });
      const results = await Promise.all([
        jsonRequest('listar_fotos_atendimento', { atendimento_id: id }),
        visitBeforeLoad && visitBeforeLoad.protocol_id
          ? loadProtocolProducts(visitBeforeLoad.protocol_id) : Promise.resolve([])
      ]);
      const data = results[0];
      if (epoch !== photoLoadEpoch) return false;
      const rows = Array.isArray(data.fotos_atendimento) ? data.fotos_atendimento : [];
      state.data.fotos_atendimento = state.data.fotos_atendimento.filter(function (photo) {
        return photo.attendance_id !== id;
      }).concat(rows);
      loadedPhotoAttendances.set(id, Date.now());
      const visit = state.data.atendimentos.find(function (item) { return item.id === id; });
      const currentGallery = bySelector('[data-galeria-atendimento="' + CSS.escape(id) + '"]');
      let restoreSummaryFocus = false;
      if (visit && currentGallery) {
        const currentPhotoSection = currentGallery.closest('[data-fotos-consulta]');
        const replaceTarget = currentPhotoSection || currentGallery;
        restoreSummaryFocus = replaceTarget.contains(document.activeElement);
        const items = state.data.procedimentos_atendimento.filter(function (item) {
          return item.attendance_id === id;
        });
        const holder = document.createElement('div');
        holder.innerHTML = renderAttendanceGallery(visit, items, Boolean(visit.archived_at));
        if (holder.firstElementChild) replaceTarget.replaceWith(holder.firstElementChild);
      }
      const gallery = bySelector('[data-galeria-atendimento="' + CSS.escape(id) + '"]');
      if (gallery) {
        gallery.open = true;
        if (restoreSummaryFocus) {
          const summary = gallery.querySelector('summary');
          if (summary) summary.focus({ preventScroll: true });
        }
      }
      status(rows.length ? 'Fotos clínicas carregadas com acesso temporário.' : 'Galeria pronta para receber fotos clínicas.');
      return true;
    })().catch(function (error) {
      status(error.message || 'Não foi possível carregar as fotos clínicas.', true);
      return false;
    }).finally(function () {
      if (loadingPhotoAttendances.get(id) === task) loadingPhotoAttendances.delete(id);
    });
    loadingPhotoAttendances.set(id, task);
    return await task;
  }

  function renderAttendanceGallery(visit, items, visitArchived) {
    const archivedProtocol = protocolForVisit(visit);
    if (archivedProtocol && archivedProtocol.archived_at) {
      return '<section class="operacao-fotos-consulta" data-fotos-consulta="' + escapeHtml(visit.id) + '"><h5>Prontuário arquivado — consulta disponível</h5>' +
        '<p class="operacao-nota">Os dados e fotos permanecem no histórico. Abra o prontuário para consultar. Restauração é uma ação separada, sem alterar automaticamente este atendimento.</p>' +
        '<button type="button" class="operacao-botao secundario" data-prontuario-abrir="' + escapeHtml(visit.protocol_id) + '">Abrir prontuário arquivado</button></section>';
    }
    const protocol = protocolForVisit(visit);
    const galleryReadOnly = visitArchived || Boolean(protocol && protocol.archived_at);
    const photos = state.data.fotos_atendimento.filter(function (photo) {
      return photo.attendance_id === visit.id;
    });
    const summary = protocolSummaryForVisit(visit);
    const overview = photoOverviewForVisit(visit, summary);
    const hasProtocol = Boolean(visit.protocol_id && protocol);
    const documentationStatus = !hasProtocol ? 'Prontuário não preparado' : galleryReadOnly
      ? 'Somente leitura' : overview.clinical < 1
      ? 'Foto clínica pendente' : 'Fotos clínicas registradas';
    const statusClass = !hasProtocol || overview.clinical < 1 ? ' alerta' : '';
    const countChip = function (label, count, className) {
      return '<span class="operacao-foto-contagem ' + className + '"><b>' + escapeHtml(count) + '</b>' +
        escapeHtml(label) + '</span>';
    };
    const overviewHeader = '<section class="operacao-fotos-consulta" data-fotos-consulta="' +
      escapeHtml(visit.id) + '"><div class="operacao-fotos-cabecalho"><div><span>Registro visual privado</span>' +
      '<h5>Fotos da consulta</h5><p>Antes, durante, depois e produtos usados ficam organizados no atendimento correto.</p></div>' +
      '<span class="operacao-selo' + statusClass + '">' + escapeHtml(documentationStatus) + '</span></div>' +
      '<div class="operacao-foto-contagens" aria-label="Contagem de fotos por categoria e arquivadas">' +
      countChip('Antes', overview.counts.antes, 'antes') + countChip('Durante', overview.counts.durante, 'durante') +
      countChip('Depois', overview.counts.depois, 'depois') +
      countChip('Produtos, ativos e ampolas', overview.counts.produtos, 'produtos') +
      countChip('Arquivadas', overview.archived, 'arquivadas') + '</div>';
    const directActions = '<div class="operacao-fotos-acoes">' + (!hasProtocol
      ? '<button type="button" class="operacao-botao pequeno" data-prontuario-preparar="' +
        escapeHtml(visit.id) + '" data-versao="' + escapeHtml(visit.version) + '">Preparar prontuário e fotos</button>'
      : '<button type="button" class="operacao-botao pequeno" data-fotos-abrir="' + escapeHtml(visit.id) +
        '">Ver ou adicionar fotos</button><button type="button" class="operacao-botao pequeno secundario" ' +
        'data-prontuario-abrir="' + escapeHtml(visit.protocol_id) + '">' +
        'Abrir prontuário completo</button>') +
      '<span>' + escapeHtml(overview.active) + ' ativa(s)' + (overview.archived
        ? ' · ' + escapeHtml(overview.archived) + ' arquivada(s)' : '') + '</span></div>';
    const galleryStart = '<details class="operacao-galeria" data-galeria-atendimento="' +
      escapeHtml(visit.id) + '"><summary><span>Galeria da consulta</span><small>' +
      escapeHtml(overview.active) + ' foto(s) ativa(s)</small></summary>' +
      '<p class="operacao-nota">Arquivo clínico privado — publicação exige autorização específica.</p>';
    if (!hasProtocol) {
      return overviewHeader + directActions +
        '<div class="operacao-fotos-fluxo"><b>1. Prepare o prontuário.</b>' +
        '<span>2. Envie uma ou várias fotos privadas por categoria. Publicação exige autorização específica.</span></div></section>';
    }
    if (!attendancePhotosAreFresh(visit.id)) {
      return overviewHeader + directActions + galleryStart +
        '<p class="operacao-galeria-carregando">Abra esta seção para carregar as fotos privadas sob demanda.</p></details></section>';
    }
    const renderCategory = function (categories, title) {
      const accepted = Array.isArray(categories) ? categories : [categories];
      const rows = photos.filter(function (photo) { return accepted.includes(photo.category); });
      return '<section class="operacao-galeria-coluna"><h6>' + escapeHtml(title) + ' <span>(' +
        escapeHtml(rows.filter(function (photo) { return !photo.archived_at; }).length) + ')</span></h6>' +
        '<div class="operacao-fotos-lista">' +
        (rows.length ? rows.map(function (photo) {
          return renderGalleryPhoto(photo, visit, items, galleryReadOnly);
        }).join('') : '<p class="operacao-vazio">Nenhuma foto.</p>') + '</div></section>';
    };
    const products = renderCategory('produtos_utilizados', 'Produtos, ativos e ampolas');
    const upload = galleryReadOnly
      ? '<p class="operacao-nota">Galeria somente leitura enquanto a visita ou o prontuário estiver arquivado.</p>'
      : '<form class="operacao-foto-upload" data-form-foto-upload data-atendimento-id="' + escapeHtml(visit.id) + '" ' +
          'data-protocolo-id="' + escapeHtml(visit.protocol_id) + '"><h6>Adicionar uma ou várias fotos</h6>' +
          '<p class="operacao-nota">Originais privados preservados. JPEG, PNG ou WebP, até 25 MB por arquivo. HEIC ainda não é aceito.</p>' +
          '<label>Categoria<select name="categoria" required><option value="antes">Antes</option>' +
            '<option value="durante">Durante</option><option value="depois">Depois</option>' +
            '<option value="produtos_utilizados">Produtos, ativos e ampolas</option></select></label>' +
          '<div class="operacao-foto-fontes"><label>Escolher fotos <small>Seleção múltipla permitida</small>' +
            '<input name="arquivos" type="file" accept="image/jpeg,image/png,image/webp" multiple ' +
            'aria-describedby="foto-arquivos-' + escapeHtml(visit.id) + '"></label>' +
            '<label>Tirar foto agora <small>Câmera traseira no celular</small><input name="camera" type="file" ' +
            'accept="image/jpeg,image/png,image/webp" capture="environment" aria-describedby="foto-arquivos-' +
            escapeHtml(visit.id) + '"></label></div><output id="foto-arquivos-' + escapeHtml(visit.id) +
            '" data-foto-arquivos-resumo>Selecione uma ou várias fotos.</output>' +
          '<p class="operacao-nota">Para categorias, produtos ou lotes diferentes, faça envios separados.</p>' +
          '<label>Capturadas em<input name="capturada_em" type="datetime-local" value="' + localNow() + '" required></label>' +
          '<label>Procedimento<select name="procedimento_item_id">' + procedureOptionsForVisit(items, '') + '</select></label>' +
          '<div data-foto-produto-campos hidden><div class="operacao-foto-produto-orientacao"><p>O produto e o lote precisam estar registrados no prontuário desta consulta.</p>' +
            '<button type="button" class="operacao-botao pequeno secundario" data-prontuario-abrir="' +
            escapeHtml(visit.protocol_id) + '">Revisar produtos e lotes no prontuário</button></div>' +
            '<label>Produto, ativo ou ampola<select name="produto_id">' + photoProductOptions(visit.protocol_id, '') + '</select></label>' +
            '<label>Lote do prontuário<select name="lote_selecionado" disabled>' +
              photoLotOptions(visit.protocol_id, '', '') + '</select></label>' +
            '<label>Consumo estruturado<select name="evento_consumo_id"><option value="">Sem evento de consumo vinculado</option></select></label></div>' +
          '<label>Legenda opcional<input name="legenda" maxlength="300"></label>' +
          '<div class="operacao-duplicidade-foto" data-foto-duplicidade hidden>' +
            '<p class="operacao-aviso-listagem">Este arquivo já existe neste prontuário. Abra a foto existente ou, apenas se for realmente outro arquivo clínico, confirme abaixo.</p>' +
            '<label class="operacao-check"><input name="confirmar_arquivo_distinto" type="checkbox"> Confirmo que é uma foto clinicamente distinta</label>' +
            '<label>Motivo obrigatório<input name="motivo_duplicidade" maxlength="500" placeholder="Explique por que a foto deve ser mantida separadamente"></label></div>' +
          '<button class="operacao-botao pequeno" type="submit">Enviar e organizar</button></form>';
    return overviewHeader + directActions + galleryStart + '<div class="operacao-antes-depois">' +
      renderCategory('antes', 'Antes') + renderCategory(['durante', 'durante_legado'], 'Durante') +
      renderCategory('depois', 'Depois') + '</div>' + products + upload + '</details></section>';
  }

  function renderAttendances() {
    const node = bySelector('[data-operacao-atendimentos]');
    if (!node) return;
    if (!state.data.atendimentos.length) {
      node.innerHTML = '<p class="operacao-vazio">Nenhum atendimento cadastrado.</p>';
      return;
    }
    const openIds = new Set(all('[data-atendimento-card][open]').map(function (card) { return card.dataset.atendimentoCard; }));
    const patients = state.data.clientes.slice();
    const patientIds = new Set(patients.map(function (patient) { return patient.id; }));
    state.data.atendimentos.forEach(function (visit) {
      if (!patientIds.has(visit.patient_id)) {
        patientIds.add(visit.patient_id);
        patients.push({ id: visit.patient_id, full_name: selectedPatientName(visit.patient_id) });
      }
    });
    patients.sort(function (a, b) {
      return String(a.full_name || '').localeCompare(String(b.full_name || ''), 'pt-BR');
    });
    node.innerHTML = patients.map(function (patient) {
      const visits = state.data.atendimentos.filter(function (row) { return row.patient_id === patient.id; })
        .sort(function (a, b) { return String(b.attended_at || '').localeCompare(String(a.attended_at || '')); });
      if (!visits.length) return '';
      const profile = state.data.perfis_operacionais.find(function (row) { return row.patient_id === patient.id; });
      return '<section class="operacao-paciente"><h4>' + escapeHtml(patient.full_name) + '</h4>' +
        (profile && (profile.preferred_name || profile.accessibility_note) ? '<p class="operacao-nota">' +
          escapeHtml((profile.preferred_name ? 'Nome preferido: ' + profile.preferred_name : '') +
            (profile.preferred_name && profile.accessibility_note ? ' · ' : '') +
            (profile.accessibility_note ? 'Apoio: ' + profile.accessibility_note : '')) + '</p>' : '') +
        visits.map(function (visit) {
          const archived = Boolean(visit.archived_at);
          const protocol = protocolForVisit(visit);
          const protocolSummary = protocolSummaryForVisit(visit);
          const photoOverview = photoOverviewForVisit(visit, protocolSummary);
          const photoPending = clinicalPhotoPending(protocolSummary);
          const items = state.data.procedimentos_atendimento.filter(function (item) {
            return item.attendance_id === visit.id;
          }).sort(function (a, b) {
            return Number(Boolean(b.is_primary)) - Number(Boolean(a.is_primary)) ||
              String(a.created_at || '').localeCompare(String(b.created_at || ''));
          });
          const activeItems = items.filter(function (item) { return !item.archived_at; });
          const entryIds = [];
          activeItems.forEach(function (item) {
            if (item.financial_entry_id && !entryIds.includes(item.financial_entry_id)) entryIds.push(item.financial_entry_id);
          });
          if (visit.financial_entry_id && !entryIds.includes(visit.financial_entry_id)) entryIds.push(visit.financial_entry_id);
          const entries = state.data.lancamentos_receita.filter(function (entry) { return entryIds.includes(entry.id); });
          const total = entries.reduce(function (sum, entry) { return sum + num(entry.total_amount); }, 0);
          const paid = entries.reduce(function (sum, entry) {
            const payments = state.data.pagamentos.filter(function (payment) {
              return payment.entry_id === entry.id;
            });
            return sum + payments.reduce(function (subtotal, payment) {
              return subtotal + (payment.movement_type === 'estorno' ? -num(payment.amount) : num(payment.amount));
            }, 0);
          }, 0);
          const recommendationIds = state.data.recomendacoes_retorno.filter(function (row) {
            return row.attendance_id === visit.id;
          }).map(function (row) { return row.id; });
          const returns = state.data.fila_retorno.filter(function (row) {
            return recommendationIds.includes(row.recommendation_id);
          });
          const linkedEntryIds = state.data.procedimentos_atendimento.filter(function (item) {
            return !item.archived_at && item.financial_entry_id;
          }).map(function (item) { return item.financial_entry_id; });
          const availableEntries = state.data.lancamentos_receita.filter(function (entry) {
            return entry.patient_id === visit.patient_id && entry.state === 'ativo' && !linkedEntryIds.includes(entry.id);
          });
          const itemHtml = items.map(function (item) {
            const entry = state.data.lancamentos_receita.find(function (row) { return row.id === item.financial_entry_id; });
            const itemActions = archived ? '' : item.archived_at
              ? '<button type="button" class="operacao-botao pequeno" data-procedimento-restaurar="' +
                escapeHtml(item.id) + '" data-versao="' + escapeHtml(item.version) + '">Restaurar</button>'
              : '<button type="button" class="operacao-botao pequeno secundario" data-procedimento-editar="' +
                escapeHtml(item.id) + '">Editar</button>' +
                '<button type="button" class="operacao-botao pequeno perigo" data-procedimento-arquivar="' +
                escapeHtml(item.id) + '" data-versao="' + escapeHtml(item.version) + '">Apagar/Arquivar</button>';
            return '<li class="' + (item.archived_at ? 'arquivado' : '') + '"><span><strong>' +
              escapeHtml(item.procedure_kind) + '</strong>' + (item.procedure_region
                ? ' · ' + escapeHtml(item.procedure_region) : '') + (item.performed_at
                ? ' · ' + escapeHtml(dateTime(item.performed_at)) : '') +
              (entry ? ' · ' + escapeHtml(money(entry.total_amount)) :
                ' · sem cobrança vinculada') + (item.duplicate_review_required ? ' · REVISAR DUPLICIDADE' : '') +
              (item.duplicate_of_id ? ' · repetição distinta confirmada' : '') +
              (item.archived_at ? ' · arquivado' : '') + '</span>' +
              '<span class="operacao-acoes">' + itemActions + '</span></li>';
          }).join('') || '<li>Nenhum procedimento vinculado.</li>';
          const visitActions = archived
            ? '<button type="button" class="operacao-botao pequeno" data-atendimento-restaurar="' +
              escapeHtml(visit.id) + '" data-versao="' + escapeHtml(visit.version) + '">Restaurar visita</button>'
            : '<button type="button" class="operacao-botao pequeno secundario" data-atendimento-editar="' +
              escapeHtml(visit.id) + '">Editar visita</button>' +
              '<button type="button" class="operacao-botao pequeno perigo" data-atendimento-arquivar="' +
              escapeHtml(visit.id) + '" data-versao="' + escapeHtml(visit.version) + '">Apagar/Arquivar visita</button>';
          const documentationActions = archived ? '' : !visit.protocol_id
            ? '<button type="button" class="operacao-botao pequeno" data-prontuario-preparar="' +
              escapeHtml(visit.id) + '" data-versao="' + escapeHtml(visit.version) +
              '">Preparar prontuário e fotos</button>'
            : '<button type="button" class="operacao-botao pequeno" data-fotos-abrir="' +
              escapeHtml(visit.id) + '">Fotos da consulta</button>' +
              '<button type="button" class="operacao-botao pequeno secundario" data-prontuario-abrir="' +
              escapeHtml(visit.protocol_id) + '">Abrir prontuário e consentimento</button>' +
              (protocol && protocol.status === 'draft' && !protocol.archived_at
                ? '<button type="button" class="operacao-botao pequeno" data-prontuario-finalizar="' +
                  escapeHtml(protocol.id) + '" data-versao="' + escapeHtml(protocol.version) +
                  '">Finalizar registro da consulta</button>' : '');
          const addForm = archived ? '' : '<form class="operacao-adicionar-procedimento" data-form-procedimento data-atendimento-id="' +
             escapeHtml(visit.id) + '"><input name="procedimento_item_id" type="hidden"><input name="versao" type="hidden">' +
             '<input name="procedimento" maxlength="120" placeholder="Adicionar outro procedimento" required>' +
             '<input name="regiao_procedimento" maxlength="120" placeholder="Região/local (opcional)">' +
             '<label>Horário do procedimento<input name="procedimento_em" type="datetime-local" value="' +
               escapeHtml(timestampToLocalInput(visit.attended_at)) + '" required></label>' +
             '<select name="lancamento_financeiro_id"><option value="">Sem cobrança vinculada</option>' +
            availableEntries.map(function (entry) { return '<option value="' + escapeHtml(entry.id) + '">' +
              escapeHtml(entry.description + ' · ' + money(entry.total_amount)) + '</option>'; }).join('') + '</select>' +
            '<label class="operacao-check pequeno"><input name="confirmar_repeticao_distinta" type="checkbox">' +
              'Confirmo que uma possível repetição é outro procedimento real</label>' +
            '<input name="motivo_repeticao_distinta" maxlength="500" placeholder="Motivo da repetição distinta, quando aplicável">' +
            '<button class="operacao-botao pequeno" type="submit" data-procedimento-submit>Adicionar</button>' +
            '<button class="operacao-botao pequeno secundario" type="button" data-procedimento-cancelar hidden>Cancelar edição</button></form>';
          return '<details class="operacao-visita' + (archived ? ' arquivado' : '') +
            '" data-atendimento-card="' + escapeHtml(visit.id) + '"' + (openIds.has(visit.id) ? ' open' : '') + '><summary><strong>' +
            escapeHtml(visit.procedure_kind) + '</strong> · ' + escapeHtml(dateTime(visit.attended_at)) +
            (archived ? ' · Arquivado' : '') + ' — Ver atendimento</summary>' +
            '<header><div><strong>' + escapeHtml(dateTime(visit.attended_at)) + '</strong><span>' +
              escapeHtml(visit.status) + ' · ID ' + escapeHtml(visit.id) + '</span></div>' +
              '<div class="operacao-acoes"><button type="button" class="operacao-botao pequeno secundario" data-resumo-procedimento="' +
                escapeHtml(visit.id) + '">Abrir/Imprimir resumo</button>' + documentationActions + visitActions + '</div></header>' +
            '<ul class="operacao-procedimentos-lista">' + itemHtml + '</ul>' + addForm +
            '<div class="operacao-vinculos"><span><b>Valor:</b> ' + escapeHtml(money(total)) + '</span>' +
              '<span><b>Pago:</b> ' + escapeHtml(money(paid)) + '</span><span><b>Saldo:</b> ' +
              escapeHtml(money(Math.max(total - paid, 0))) + '</span><span><b>Prontuário:</b> ' +
              escapeHtml(protocol ? protocolStatusLabel(protocol) : visit.protocol_id ? 'vinculado' : 'não vinculado') +
              (visit.protocol_id ? ' · ' + escapeHtml(visit.protocol_id) : '') +
              '</span><span><b>Retorno:</b> ' +
              escapeHtml(returns.length ? returns.map(function (row) { return row.status; }).join(', ') : 'não registrado') +
              '</span>' + (!visit.protocol_id
                ? '<span class="operacao-selo alerta">Fotos: prepare o prontuário</span>'
                : photoPending
                ? '<span class="operacao-selo alerta">Foto clínica pendente · ' +
                  escapeHtml(photoOverview.products) + ' de produtos</span>'
                : '<span class="operacao-selo">' + escapeHtml(photoOverview.clinical) +
                  ' foto(s) clínica(s) · ' + escapeHtml(photoOverview.products) + ' de produtos</span>') +
              '</div>' + (protocol && protocol.status === 'draft' && !protocol.archived_at
                ? '<p class="operacao-nota operacao-nota-documental">A finalização documental exige revisão do registro e ao menos uma foto clínica ativa em Antes, Durante ou Depois. Fotos de produtos não contam. O arquivo permanece privado; publicação exige autorização específica.</p>'
                : '') + renderAttendanceGallery(visit, items, archived) + '</details>';
        }).join('') + '</section>';
    }).join('');
    filterAttendances();
  }

  function openAdministrativeSummary(attendanceId) {
    const visit = state.data.atendimentos.find(function (row) { return row.id === attendanceId; });
    if (!visit) throw new Error('Procedimento não encontrado. Atualize a tela.');
    const items = state.data.procedimentos_atendimento.filter(function (item) {
      return item.attendance_id === visit.id && !item.archived_at;
    });
    const entryIds = [];
    items.forEach(function (item) {
      if (item.financial_entry_id && !entryIds.includes(item.financial_entry_id)) entryIds.push(item.financial_entry_id);
    });
    if (visit.financial_entry_id && !entryIds.includes(visit.financial_entry_id)) entryIds.push(visit.financial_entry_id);
    const entries = state.data.lancamentos_receita.filter(function (entry) { return entryIds.includes(entry.id); });
    const total = entries.reduce(function (sum, entry) { return sum + num(entry.total_amount); }, 0);
    const payments = state.data.pagamentos.filter(function (payment) { return entryIds.includes(payment.entry_id); });
    const paid = payments.reduce(function (sum, payment) {
      return sum + (payment.movement_type === 'estorno' ? -num(payment.amount) : num(payment.amount));
    }, 0);
    const popup = window.open('', '_blank');
    if (!popup) throw new Error('Permita a abertura da janela para gerar o resumo.');
    try { popup.opener = null; } catch (_) { /* navegador pode bloquear a atribuição */ }
    const proceduresHtml = items.map(function (item) {
      const entry = entries.find(function (row) { return row.id === item.financial_entry_id; });
      return '<tr><td>' + escapeHtml(item.procedure_kind) +
        (item.procedure_region ? '<br><small>' + escapeHtml(item.procedure_region) + '</small>' : '') +
        (item.performed_at ? '<br><small>' + escapeHtml(dateTime(item.performed_at)) + '</small>' : '') +
        '</td><td>' +
        escapeHtml(entry ? money(entry.total_amount) : 'Sem cobrança vinculada') + '</td></tr>';
    }).join('') || '<tr><td colspan="2">Nenhum procedimento ativo.</td></tr>';
    const paymentsHtml = payments.map(function (payment) {
      return '<tr><td>' + escapeHtml(payment.payment_method || 'Não informado') + '</td><td>' +
        escapeHtml(dateTime(payment.paid_at)) + '</td><td>' +
        escapeHtml((payment.movement_type === 'estorno' ? '− ' : '') + money(payment.amount)) + '</td></tr>';
    }).join('') || '<tr><td colspan="3">Nenhum pagamento registrado.</td></tr>';
    popup.document.open();
    popup.document.write('<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Resumo administrativo do procedimento</title>' +
      '<style>body{font:15px Arial,sans-serif;color:#2e2926;max-width:820px;margin:36px auto;padding:0 20px}h1{color:#8b6b4f}' +
      'table{width:100%;border-collapse:collapse;margin:18px 0}th,td{border:1px solid #d8c8bb;padding:9px;text-align:left}' +
      '.totais{display:flex;gap:24px;flex-wrap:wrap;padding:14px;background:#f7f0eb}.aviso{margin-top:30px;font-size:12px;color:#655}' +
      'button{padding:10px 16px;background:#8b6b4f;color:white;border:0;border-radius:6px}@media print{button{display:none}}</style></head><body>' +
      '<button type="button" onclick="window.print()">Imprimir / Salvar em PDF</button><h1>Ana Maria Jacob Estética</h1>' +
      '<h2>Resumo administrativo do procedimento</h2><p><b>Paciente:</b> ' + escapeHtml(selectedPatientName(visit.patient_id)) +
      '<br><b>Data:</b> ' + escapeHtml(dateTime(visit.attended_at)) + '<br><b>ID do atendimento:</b> ' + escapeHtml(visit.id) + '</p>' +
      '<h3>Procedimentos</h3><table><thead><tr><th>Item</th><th>Valor vinculado</th></tr></thead><tbody>' +
      proceduresHtml + '</tbody></table><h3>Pagamentos</h3><table><thead><tr><th>Forma</th><th>Data</th><th>Valor</th></tr></thead><tbody>' +
      paymentsHtml + '</tbody></table><div class="totais"><b>Valor: ' + escapeHtml(money(total)) + '</b><b>Pago: ' +
      escapeHtml(money(paid)) + '</b><b>Saldo: ' + escapeHtml(money(Math.max(total - paid, 0))) + '</b></div>' +
      '<p class="aviso">Documento administrativo, não fiscal. Não contém notas clínicas nem documento de identificação pessoal.</p>' +
      '</body></html>');
    popup.document.close();
    popup.focus();
  }

  function renderReturns() {
    const node = bySelector('[data-operacao-retornos]');
    if (!node) return;
    const rows = state.data.fila_retorno.slice().sort(function (a, b) {
      return String(a.next_action_at || '').localeCompare(String(b.next_action_at || ''));
    });
    if (!rows.length) { node.innerHTML = '<p class="operacao-vazio">Nenhum retorno registrado.</p>'; return; }
    node.innerHTML = rows.map(function (row) {
      const appointments = state.data.agendamentos.filter(function (appointment) {
        const link = state.data.vinculos_agenda.find(function (item) { return item.source_id === appointment.id; });
        return link && link.patient_id === row.patient_id && ['retorno', 'acompanhamento'].includes(appointment.categoria);
      });
      const closed = ['concluido', 'cancelado', 'bloqueado'].includes(row.status);
      const actions = closed ? '<span class="operacao-selo alerta">Encerrado</span>' :
        '<div class="operacao-acoes"><button type="button" class="operacao-botao pequeno secundario" data-tentativa="' +
          escapeHtml(row.id) + '" data-versao="' + escapeHtml(row.version) + '">Registrar tentativa</button>' +
        '<select data-agenda-fila="' + escapeHtml(row.id) + '"><option value="">Agendamento de retorno</option>' +
          appointments.map(function (appointment) { return '<option value="' + escapeHtml(appointment.id) + '">' +
            escapeHtml(appointment.procedimento + ' · ' + dateTime(appointment.inicio_em)) + '</option>'; }).join('') + '</select>' +
        '<button type="button" class="operacao-botao pequeno" data-vincular="' + escapeHtml(row.id) +
          '" data-versao="' + escapeHtml(row.version) + '">Vincular</button>' +
        '<button type="button" class="operacao-botao pequeno secundario" data-retorno-acao="reprogramar" data-fila="' +
          escapeHtml(row.id) + '" data-versao="' + escapeHtml(row.version) + '">Atualizar prazo</button>' +
        '<button type="button" class="operacao-botao pequeno" data-retorno-acao="concluir" data-fila="' +
          escapeHtml(row.id) + '" data-versao="' + escapeHtml(row.version) + '">Concluir</button>' +
        '<button type="button" class="operacao-botao pequeno perigo" data-retorno-acao="cancelar" data-fila="' +
          escapeHtml(row.id) + '" data-versao="' + escapeHtml(row.version) + '">Cancelar</button></div>';
      return '<article class="operacao-retorno"><div><strong>' + escapeHtml(selectedPatientName(row.patient_id)) + '</strong>' +
        '<span>' + escapeHtml(row.status) + ' · próxima ação ' + escapeHtml(dateTime(row.next_action_at)) + '</span></div>' +
        actions + '</article>';
    }).join('');
  }

  function renderContactPreferences() {
    const node = bySelector('[data-operacao-preferencias-contato]');
    if (!node) return;
    const purposeLabels = { retorno: 'Retorno', agenda: 'Agenda' };
    const channelLabels = { whatsapp: 'WhatsApp', telefone: 'Telefone', email: 'E-mail', sms: 'SMS' };
    const evidenceLabels = { solicitacao_paciente: 'Solicitação da paciente', termo_assinado: 'Termo assinado',
      revogacao_paciente: 'Revogação da paciente', importacao_documentada: 'Importação documentada' };
    const rows = state.data.preferencias_contato.slice().sort(function (a, b) {
      return String(b.recorded_at || b.effective_at || '').localeCompare(String(a.recorded_at || a.effective_at || ''));
    });
    if (!rows.length) {
      node.innerHTML = '<p class="operacao-vazio">Nenhuma preferência de contato registrada.</p>';
      return;
    }
    node.innerHTML = '<div class="operacao-tabela-wrap"><table><thead><tr><th>Paciente</th><th>Finalidade</th>' +
      '<th>Canal</th><th>Situação</th><th>Evidência</th><th>Vigência</th></tr></thead><tbody>' +
      rows.map(function (row) {
        const evidence = evidenceLabels[row.evidence_kind] || row.evidence_kind || 'Não informada';
        const reference = row.evidence_reference ? ' · ' + row.evidence_reference : '';
        const version = row.version ? ' · versão ' + row.version : '';
        return '<tr><td>' + escapeHtml(selectedPatientName(row.patient_id)) + '</td><td>' +
          escapeHtml(purposeLabels[row.purpose] || row.purpose || '—') + '</td><td>' +
          escapeHtml(channelLabels[row.channel] || row.channel || '—') + '</td><td><span class="operacao-selo' +
          (row.allowed ? '' : ' alerta') + '">' + (row.allowed ? 'Autorizado' : 'Não autorizado') + '</span></td><td>' +
          escapeHtml(evidence + reference) + '</td><td>' + escapeHtml(dateTime(row.effective_at || row.recorded_at) + version) + '</td></tr>';
      }).join('') + '</tbody></table></div>';
  }

  function renderConsumptionEvents() {
    const node = bySelector('[data-operacao-eventos-consumo]');
    if (!node) return;
    const kindLabels = { perda_tecnica: 'Perda técnica', desperdicio: 'Desperdício',
      devolucao_atendimento: 'Devolução do atendimento' };
    const rows = state.data.eventos_consumo.slice().sort(function (a, b) {
      return String(b.occurred_at || '').localeCompare(String(a.occurred_at || ''));
    });
    if (!rows.length) {
      node.innerHTML = '<p class="operacao-vazio">Nenhuma perda, desperdício ou devolução registrada.</p>';
      return;
    }
    node.innerHTML = '<div class="operacao-tabela-wrap"><table><thead><tr><th>Paciente e atendimento</th><th>Evento</th>' +
      '<th>Produto</th><th>Lote</th><th>Quantidade</th><th>Data</th></tr></thead><tbody>' +
      rows.map(function (row) {
        const visit = state.data.atendimentos.find(function (item) { return item.id === row.attendance_id; });
        const product = state.data.produtos.find(function (item) { return item.id === row.product_id; });
        const lot = state.data.estoque_lotes.find(function (item) { return item.lot_id === row.lot_id || item.id === row.lot_id; });
        const patient = visit ? selectedPatientName(visit.patient_id) : 'Atendimento não localizado';
        const visitDate = visit ? ' · ' + dateTime(visit.attended_at) : '';
        return '<tr><td>' + escapeHtml(patient + visitDate) + '</td><td>' +
          escapeHtml(kindLabels[row.event_kind] || row.event_kind || '—') + '</td><td>' +
          escapeHtml(product ? product.name : 'Produto não localizado') + '</td><td>' +
          escapeHtml(lot ? lot.lot : 'Lote não localizado') + '</td><td>' +
          escapeHtml(String(row.amount) + ' ' + String(row.unit || '')) + '</td><td>' +
          escapeHtml(dateTime(row.occurred_at)) + '</td></tr>';
      }).join('') + '</tbody></table></div>';
  }

  function renderCostSheets() {
    const node = bySelector('[data-operacao-fichas-custo]');
    if (!node) return;
    if (!state.data.fichas_custo.length) {
      node.innerHTML = '<p class="operacao-vazio">Nenhuma ficha de custo cadastrada.</p>';
      return;
    }
    node.innerHTML = state.data.fichas_custo.map(function (sheet) {
      const items = state.data.itens_ficha_custo.filter(function (item) { return item.cost_sheet_id === sheet.id; });
      const latest = !state.data.fichas_custo.some(function (candidate) {
        return candidate.procedure_kind === sheet.procedure_kind && Number(candidate.version) > Number(sheet.version);
      });
      const itemText = items.map(function (item) {
        const product = state.data.produtos.find(function (row) { return row.id === item.product_id; });
        return (product ? product.name : 'Produto') + ': ' + item.amount + ' ' + item.unit;
      }).join(' · ') || 'Sem itens (versão retirada)';
      const retire = latest && sheet.status !== 'retirada'
        ? '<button type="button" class="operacao-botao pequeno perigo" data-custo-retirar="' +
          escapeHtml(sheet.id) + '">Apagar/Arquivar versão</button>' : '';
      return '<article class="operacao-retorno' + (sheet.status === 'retirada' ? ' arquivado' : '') + '"><div><strong>' +
        escapeHtml(sheet.procedure_kind) + ' · versão ' + escapeHtml(sheet.version) + '</strong><span>' +
        escapeHtml(sheet.status + ' · desde ' + sheet.valid_from + ' · ' + itemText) + '</span></div>' +
        '<div class="operacao-acoes"><button type="button" class="operacao-botao pequeno secundario" data-custo-usar="' +
        escapeHtml(sheet.id) + '">' + (sheet.status === 'retirada' ? 'Restaurar como nova versão' : 'Usar como nova versão') +
        '</button>' + retire + '</div></article>';
    }).join('');
  }

  function populateCostSheet(sheetId) {
    let sheet = state.data.fichas_custo.find(function (row) { return row.id === sheetId; });
    if (!sheet) return;
    let items = state.data.itens_ficha_custo.filter(function (item) { return item.cost_sheet_id === sheet.id; });
    if (!items.length) {
      const source = state.data.fichas_custo.find(function (candidate) {
        return candidate.procedure_kind === sheet.procedure_kind && candidate.status !== 'retirada' &&
          state.data.itens_ficha_custo.some(function (item) { return item.cost_sheet_id === candidate.id; });
      });
      if (source) {
        sheet = source;
        items = state.data.itens_ficha_custo.filter(function (item) { return item.cost_sheet_id === source.id; });
      }
    }
    const form = bySelector('[data-form-custo]');
    const container = bySelector('[data-custo-itens]');
    if (!form || !container || !items.length) throw new Error('Não há itens informados para criar a nova versão.');
    form.elements.procedimento.value = sheet.procedure_kind;
    form.elements.status.value = 'validada';
    form.elements.vigente_desde.value = today();
    form.elements.motivo.value = 'Nova versão baseada na ficha ' + sheet.version;
    container.innerHTML = '';
    items.forEach(function (item) { addCostItem(item.product_id, item.amount); });
    form.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function renderFees() {
    const node = bySelector('[data-operacao-taxas]');
    if (!node) return;
    const declarations = state.data.taxas_pagamento.filter(function (row) { return row.event_kind === 'declaracao'; });
    if (!declarations.length) {
      node.innerHTML = '<p class="operacao-vazio">Nenhuma taxa declarada. Declare também pagamentos com taxa zero.</p>';
      return;
    }
    node.innerHTML = declarations.map(function (fee) {
      const reversed = state.data.taxas_pagamento.some(function (row) { return row.reversal_of_id === fee.id; });
      const visit = state.data.atendimentos.find(function (row) { return row.id === fee.attendance_id; });
      const payment = state.data.pagamentos.find(function (row) { return row.id === fee.payment_id; });
      return '<article class="operacao-retorno' + (reversed ? ' arquivado' : '') + '"><div><strong>' +
        escapeHtml(visit ? selectedPatientName(visit.patient_id) : 'Procedimento') + ' · ' + escapeHtml(money(fee.amount)) +
        '</strong><span>' + escapeHtml((payment ? payment.payment_method : 'Pagamento') + ' · ' +
          (Number(fee.amount) === 0 ? 'taxa zero declarada' : fee.source_kind) + (reversed ? ' · estornada' : '')) +
        '</span></div>' + (reversed ? '' : '<button type="button" class="operacao-botao pequeno perigo" data-taxa-estornar="' +
          escapeHtml(fee.id) + '">Estornar declaração</button>') + '</article>';
    }).join('');
  }

  function renderPagination() {
    const node = bySelector('[data-operacao-paginacao]');
    if (!node) return;
    if (!state.pagination || !state.pagination.possivelmente_truncado) {
      node.innerHTML = '';
      return;
    }
    const atMaximum = state.listLimit >= num(state.pagination.maximo || 5000);
    node.innerHTML = '<div class="operacao-aviso-listagem">A listagem atingiu o limite de ' +
      escapeHtml(state.pagination.limite || state.listLimit) + ' registros e pode estar incompleta. ' +
      (atMaximum ? 'Use filtros ou revise por período antes de concluir uma auditoria.' :
        '<button type="button" class="operacao-botao pequeno secundario" data-operacao-carregar-mais>Carregar mais</button>') + '</div>';
  }

  function renderProfitability() {
    const node = bySelector('[data-operacao-rentabilidade]');
    if (!node) return;
    node.innerHTML = state.data.rentabilidade_atendimentos.map(function (row) {
      const reasons = Array.isArray(row.incomplete_reasons) ? row.incomplete_reasons.join(', ') : '';
      return '<tr><td>' + escapeHtml(row.attendance_date || '—') + '</td><td>' + escapeHtml(row.procedure_kind) +
        '</td><td>' + escapeHtml(row.linked_revenue == null ? '—' : money(row.linked_revenue)) + '</td><td>' +
        escapeHtml(money(row.received_amount)) + '</td><td>' + escapeHtml(money(row.material_cost)) + '</td><td>' +
        escapeHtml(money(row.fee_amount)) + '</td><td>' +
        escapeHtml(row.managerial_contribution_margin == null ? '—' : money(row.managerial_contribution_margin)) + '</td><td>' +
        (row.is_incomplete ? '<span class="operacao-selo alerta" title="' + escapeHtml(reasons) + '">Incompleto</span>' :
          '<span class="operacao-selo">Completo</span>') + '</td></tr>';
    }).join('') || '<tr><td colspan="8">Nenhum atendimento para apurar.</td></tr>';
  }

  function render() {
    hydrateForms();
    renderPagination();
    renderSummary();
    renderAttendances();
    renderContactPreferences();
    renderConsumptionEvents();
    renderReturns();
    renderCostSheets();
    renderFees();
    renderProfitability();
  }

  async function load() {
    if (!state.root || !ownerAccess()) return false;
    if (state.loadPromise) return await state.loadPromise;
    const generation = state.generation;
    photoLoadEpoch += 1;
    state.loading = true; setBusy(true); status('Carregando operação clínica…');
    let task;
    task = (async function () {
      try {
        const data = await jsonRequest('listar', { limite: state.listLimit });
        if (generation !== state.generation) return false;
        loadedPhotoAttendances.clear();
        loadingPhotoAttendances.clear();
        protocolProductsById.clear();
        loadingProtocolProducts.clear();
        Object.keys(emptyData()).forEach(function (key) { state.data[key] = Array.isArray(data[key]) ? data[key] : []; });
        state.pagination = data.paginacao && typeof data.paginacao === 'object' ? data.paginacao : null;
        state.loaded = true; render(); status('Dados atualizados. Nenhuma mensagem foi enviada.');
        return true;
      } catch (error) {
        if (generation === state.generation) status(error.message || 'Falha ao carregar.', true);
        return false;
      } finally {
        if (state.loadPromise === task) {
          state.loadPromise = null;
          state.loading = false;
          setBusy(false);
        }
      }
    })();
    state.loadPromise = task;
    return await task;
  }

  async function submit(form, task) {
    if (!form.reportValidity()) return;
    const generation = state.generation;
    setBusy(true); status('Salvando…');
    try { await task(); if (generation === state.generation) await loadAfterMutation(); }
    catch (error) { if (generation === state.generation) status(error.message || 'Não foi possível salvar.', true); }
    finally { if (generation === state.generation) setBusy(false); }
  }
  function showDuplicate(form, saveButton, type, error) {
    if (!error || !error.existingId || !window.AMJShell ||
        typeof window.AMJShell.showDuplicateAlert !== 'function') return false;
    const possible = error.code === 'procedure_possible_duplicate_requires_review';
    window.AMJShell.showDuplicateAlert({
      container: form,
      saveButton: saveButton,
      level: possible ? 'possible' : 'exact',
      type: type,
      existingId: error.existingId,
      title: possible ? 'Confira possível repetição' :
        (type === 'procedimento' ? 'Procedimento já registrado' : 'Visita já registrada'),
      message: error.message + ' O registro existente não será duplicado.'
    });
    return true;
  }
  async function loadAfterMutation() {
    state.loading = false;
    await load();
  }

  function hydratePhotoUpload(form) {
    if (!form) return;
    const isProducts = formValue(form, 'categoria') === 'produtos_utilizados';
    const productFields = form.querySelector('[data-foto-produto-campos]');
    if (productFields) productFields.hidden = !isProducts;
    const consumption = form.elements.evento_consumo_id;
    const lotSelect = form.elements.lote_selecionado;
    if (isProducts && lotSelect) {
      const productId = formValue(form, 'produto_id');
      const selectedLot = lotSelect.value;
      lotSelect.innerHTML = photoLotOptions(form.dataset.protocoloId, productId, selectedLot);
      lotSelect.disabled = !productId;
      if (selectedLot && !Array.from(lotSelect.options).some(function (option) {
        return option.value === selectedLot;
      })) lotSelect.value = '';
    }
    if (consumption) {
      const selectedConsumption = consumption.value;
      consumption.innerHTML = consumptionOptionsForPhoto(
        form.dataset.atendimentoId,
        isProducts ? formValue(form, 'produto_id') : '',
        selectedConsumption
      );
    }
    if (!isProducts) {
      form.elements.produto_id.value = '';
      if (lotSelect) { lotSelect.value = ''; lotSelect.disabled = true; }
      if (consumption) consumption.value = '';
    }
  }

  function updatePhotoFileSummary(form) {
    if (!form) return;
    const files = selectedPhotoFiles(form);
    const output = form.querySelector('[data-foto-arquivos-resumo]');
    if (!output) return;
    output.textContent = files.length
      ? files.length + (files.length === 1 ? ' foto selecionada.' : ' fotos selecionadas para envio em conjunto.')
      : 'Selecione uma ou várias fotos.';
  }

  function selectedPhotoFiles(form) {
    if (!form) return [];
    const selected = form.elements.arquivos ? Array.from(form.elements.arquivos.files || []) : [];
    const captured = form.elements.camera ? Array.from(form.elements.camera.files || []) : [];
    return selected.concat(captured);
  }

  async function createPhotoThumbnail(file) {
    if (!window.createImageBitmap || !document.createElement('canvas').getContext) return null;
    let bitmap;
    try {
      bitmap = await window.createImageBitmap(file);
      const maxSide = 640;
      const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const context = canvas.getContext('2d', { alpha: false });
      if (!context) return null;
      context.fillStyle = '#fff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise(function (resolve) {
        canvas.toBlob(resolve, 'image/webp', 0.82);
      });
      if (!blob || blob.size < 1 || blob.size > 1024 * 1024) return null;
      const stem = String(file.name || 'foto').replace(/\.[^.]+$/, '').slice(0, 120) || 'foto';
      return new File([blob], stem + '.miniatura.webp', { type: blob.type, lastModified: Date.now() });
    } catch (_) {
      return null;
    } finally {
      if (bitmap && typeof bitmap.close === 'function') bitmap.close();
    }
  }

  async function thumbnailForPhoto(file) {
    if (!photoThumbnailPromises.has(file)) photoThumbnailPromises.set(file, createPhotoThumbnail(file));
    return await photoThumbnailPromises.get(file);
  }

  function photoUploadContext(form) {
    const category = formValue(form, 'categoria');
    return JSON.stringify({
      protocolId: String(form.dataset.protocoloId || ''),
      attendanceId: String(form.dataset.atendimentoId || ''),
      category: category,
      capturedAt: formValue(form, 'capturada_em'),
      procedureItemId: formValue(form, 'procedimento_item_id'),
      productId: category === 'produtos_utilizados' ? formValue(form, 'produto_id') : '',
      lot: category === 'produtos_utilizados' ? photoLotValue(form) : ''
    });
  }

  function rememberPhotoUploadContext(form, file) {
    const current = photoUploadContext(form);
    const remembered = photoUploadContexts.get(file);
    if (remembered && remembered !== current) {
      throw new Error(
        'Esta foto já iniciou um envio com outros dados. Mantenha a mesma consulta, categoria, data, procedimento, produto e lote para repetir com segurança; para corrigir, atualize a galeria e revise a foto já registrada.'
      );
    }
    photoUploadContexts.set(file, current);
    return current;
  }

  function metadataForUploadedPhoto(form, file, photo) {
    const metadata = {
      foto_id: photo.id,
      versao: Number(photo.operation_version || photo.version || 1),
      procedimento_item_id: optional(formValue(form, 'procedimento_item_id')),
      ordem: null,
      legenda: optional(formValue(form, 'legenda')),
      evento_consumo_id: optional(formValue(form, 'evento_consumo_id'))
    };
    const fingerprint = JSON.stringify(canonicalIntentValue(metadata));
    const remembered = photoMetadataContexts.get(file);
    if (remembered && remembered !== fingerprint) {
      throw new Error(
        'Uma ou mais fotos já foram guardadas com outra organização. Atualize a galeria para recuperar o que foi salvo e faça as correções na própria foto; o sistema não repetirá o vínculo com dados diferentes.'
      );
    }
    photoMetadataContexts.set(file, fingerprint);
    if (!photoMetadataKeys.has(file)) photoMetadataKeys.set(file, uuid());
    return Object.assign(metadata, { idempotency_key: photoMetadataKeys.get(file) });
  }

  async function uploadClinicalPhoto(form, file) {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size < 1 ||
        file.size > 25 * 1024 * 1024) {
      throw new Error('Use somente JPEG, PNG ou WebP de até 25 MB por arquivo.');
    }
    const generation = state.generation;
    const uploadContext = photoUploadContext(form);
    function assertCurrentContext() {
      if (generation !== state.generation || form.isConnected === false || photoUploadContext(form) !== uploadContext) {
        throw new Error('O contexto da foto ou a sessão mudou. Atualize a galeria da consulta original para conferir o envio.');
      }
    }
    const category = formValue(form, 'categoria');
    const phase = category === 'antes' ? 'before' : category === 'durante' ? 'during' :
      category === 'depois' ? 'after' : 'products_used';
    const thumbnail = await thumbnailForPhoto(file);
    assertCurrentContext();
    const data = new FormData();
    data.append('acao', 'adicionar_foto');
    data.append('protocolo_id', form.dataset.protocoloId);
    data.append('fase', phase);
    data.append('tirada_em', localTimestampToIso(formValue(form, 'capturada_em')));
    if (!photoUploadKeys.has(file)) photoUploadKeys.set(file, uuid());
    data.append('idempotency_key', photoUploadKeys.get(file));
    data.append('atendimento_id', form.dataset.atendimentoId);
    if (thumbnail) data.append('miniatura', thumbnail, thumbnail.name);
    const procedureItemId = formValue(form, 'procedimento_item_id');
    if (procedureItemId) data.append('item_procedimento_id', procedureItemId);
    if (category === 'produtos_utilizados') {
      const productId = formValue(form, 'produto_id');
      const lot = photoLotValue(form);
      if (Boolean(productId) !== Boolean(lot)) {
        throw new Error('Selecione produto e lote juntos, ou deixe ambos vazios para uma foto geral.');
      }
      if (productId && !protocolProductRows(form.dataset.protocoloId).some(function (item) {
        return String(item.product_id || '') === productId && String(item.lot || '').trim() === lot;
      })) {
        throw new Error('Escolha um par de produto e lote registrado neste prontuário.');
      }
      if (productId) data.append('produto_id', productId);
      if (lot) data.append('lote', lot);
    }
    rememberPhotoUploadContext(form, file);
    if (photoUploadResults.has(file)) return photoUploadResults.get(file);
    data.append('arquivo', file, file.name);
    let proof = null;
    const duplicate = photoUploadDuplicates.get(file);
    const confirmDistinct = Boolean(duplicate && form.elements.confirmar_arquivo_distinto &&
      form.elements.confirmar_arquivo_distinto.checked);
    try {
      if (confirmDistinct) {
        const reason = formValue(form, 'motivo_duplicidade');
        if (reason.length < 3) throw new Error('Explique por que esta foto é clinicamente distinta.');
        if (!window.AMJProtecao || typeof window.AMJProtecao.solicitarSenhaRecente !== 'function') {
          throw new Error('A confirmação administrativa não está disponível. Atualize a página.');
        }
        proof = await window.AMJProtecao.solicitarSenhaRecente({
          titulo: 'Confirmar foto clínica distinta',
          motivo: reason,
          motivoObrigatorio: true
        });
        data.append('confirmar_arquivo_distinto', 'true');
        data.append('motivo_duplicidade', proof.motivo || reason);
        data.append('operation_id', proof.operation_id);
      }
      const headers = await cabecalhosAcesso(false, proof);
      assertCurrentContext();
      const response = await fetch(PRONTUARIO_API, {
        method: 'POST', headers: headers, body: data,
        cache: 'no-store', referrerPolicy: 'no-referrer'
      });
      let result = {};
      try { result = await response.json(); } catch (_) { result = {}; }
      assertCurrentContext();
      if (!response.ok || result.ok === false || result.erro || !result.foto || !result.foto.id) {
        const error = new Error(result.erro || 'Não foi possível guardar uma das fotos.');
        error.code = result.codigo || String(response.status);
        const duplicateData = result.dados && typeof result.dados === 'object' ? result.dados : {};
        error.existingId = duplicateData.existing_id || result.existing_id || null;
        error.candidate = duplicateData.candidato || null;
        if (error.code === 'photo_exact_duplicate' && error.existingId) {
          photoUploadDuplicates.set(file, {
            existingId: error.existingId,
            candidate: error.candidate
          });
          const exception = form.querySelector('[data-foto-duplicidade]');
          if (exception) exception.hidden = false;
          if (window.AMJShell && typeof window.AMJShell.showDuplicateAlert === 'function') {
            window.AMJShell.showDuplicateAlert({
              container: form,
              saveButton: form.querySelector('button[type="submit"]'),
              level: 'exact',
              type: 'procedimento',
              existingId: error.existingId,
              title: 'Foto clínica já registrada',
              message: error.message + ' O original existente foi preservado e nenhum arquivo foi duplicado.',
              onOpen: function (id) { openPhoto(id); }
            });
          }
        }
        throw error;
      }
      photoUploadResults.set(file, result.foto);
      return result.foto;
    } finally {
      if (proof && typeof proof.encerrar === 'function') await proof.encerrar();
    }
  }

  async function prepareAttendanceProtocol(attendanceId, version) {
    const intentKey = protocolPrepareKey(attendanceId);
    await protectedRequest('preparar_prontuario_atendimento', {
      atendimento_id: attendanceId,
      versao: Number(version),
      idempotency_key: intentKey
    }, 'Preparação auditada do prontuário e da galeria clínica');
    confirmProtocolPrepare(attendanceId, intentKey);
  }

  function bind() {
    bySelector('[data-operacao-recarregar]').addEventListener('click', load);
    bySelector('[data-atendimento-novo]').addEventListener('click', startAttendance);
    bySelector('[data-operacao-busca]').addEventListener('input', filterAttendances);
    state.root.addEventListener('toggle', function (event) {
      const gallery = event.target.closest && event.target.closest('[data-galeria-atendimento]');
      if (!gallery || gallery !== event.target || !gallery.open) return;
      const visit = state.data.atendimentos.find(function (item) {
        return item.id === gallery.dataset.galeriaAtendimento;
      });
      if (visit && visit.protocol_id) loadAttendancePhotos(visit.id);
    }, true);
    const attendance = bySelector('[data-form-atendimento]');
    attendance.elements.cliente_id.addEventListener('change', function () {
      ['agendamento_id','protocolo_id','lancamento_financeiro_id'].forEach(function (name) { attendance.elements[name].value = ''; });
      hydrateAttendanceLinks();
    });
    attendance.addEventListener('input', attendanceContext);
    attendance.addEventListener('submit', function (event) {
      event.preventDefault(); submit(attendance, async function () {
        const attendanceId = formValue(attendance, 'atendimento_id');
        const payload = {
          atendimento_id: optional(attendanceId),
          versao: attendanceId ? Number(formValue(attendance, 'versao')) : null,
          cliente_id: formValue(attendance, 'cliente_id'), procedimento: formValue(attendance, 'procedimento'),
          realizado_em: localTimestampToIso(formValue(attendance, 'realizado_em')),
          duracao_minutos: optional(formValue(attendance, 'duracao_minutos')),
          responsavel_id: formValue(attendance, 'responsavel_id'), agendamento_id: optional(formValue(attendance, 'agendamento_id')),
          protocolo_id: optional(formValue(attendance, 'protocolo_id')),
          lancamento_financeiro_id: optional(formValue(attendance, 'lancamento_financeiro_id')),
          status: formValue(attendance, 'status')
        };
        const revision = state.attendanceRevision;
        const existing = attendanceId && state.data.atendimentos.find(function (row) { return row.id === attendanceId; });
        const removalFields = existing ? [
          ['agendamento_id', 'appointment_id', 'agendamento'],
          ['protocolo_id', 'protocol_id', 'prontuário'],
          ['lancamento_financeiro_id', 'financial_entry_id', 'cobrança']
        ].filter(function (pair) { return existing[pair[1]] && !payload[pair[0]]; }) : [];
        if (removalFields.length) {
          if (!window.confirm('Você retirou o vínculo de ' + removalFields.map(function (pair) { return pair[2]; }).join(', ') +
            '. Confirma desvincular esses registros do atendimento? Os registros originais não serão apagados.')) {
            throw new Error('Desvinculação cancelada. Confira os campos antes de salvar.');
          }
          payload.confirmar_remocao_vinculos = removalFields.map(function (pair) { return pair[0]; });
        }
        // A refreshed list may already reflect an unacknowledged unlink. The
        // confirmation still travels to the endpoint, but is not RPC data and
        // must not change the retry ID for the same fields and expected version.
        const intentPayload = Object.assign({}, payload);
        delete intentPayload.confirmar_remocao_vinculos;
        const intentKey = intentKeyForForm(attendance, intentPayload);
        payload.idempotency_key = intentKey;
        attendanceStatus('Salvando atendimento…');
        try {
          let result;
          if (attendanceId) {
            result = await protectedRequest('salvar_atendimento', payload, 'Edição auditada do atendimento');
          } else {
            result = await jsonRequest('salvar_atendimento', payload);
          }
          confirmFormIntent(attendance, intentKey);
          if (revision === state.attendanceRevision) {
            const saved = result && (result.resultado || result);
            if (saved && saved.id) attendance.elements.atendimento_id.value = saved.id;
            if (saved && saved.version) attendance.elements.versao.value = saved.version;
            state.selectedAttendanceId = formValue(attendance, 'atendimento_id');
            state.attendanceBaseline = attendanceFingerprint();
            attendanceStatus('Atendimento salvo. Continue neste registro ou abra suas fotos e prontuário.');
            if (bySelector('[data-atendimento-salvar]')) bySelector('[data-atendimento-salvar]').textContent = 'Salvar alterações';
            if (bySelector('[data-atendimento-cancelar-edicao]')) bySelector('[data-atendimento-cancelar-edicao]').hidden = false;
          }
        } catch (error) {
          if (revision === state.attendanceRevision) attendanceStatus((error.message || 'Não foi possível salvar.') + ' O preenchimento foi preservado.' + (error.code ? ' Código: ' + error.code + '.' : ''), true);
          showDuplicate(attendance, bySelector('[data-atendimento-salvar]'), 'atendimento', error);
          throw error;
        }
      });
    });
    bySelector('[data-atendimento-cancelar-edicao]').addEventListener('click', function () {
      if (attendanceDirty() && !window.confirm('Deseja fechar e descartar as alterações não salvas deste atendimento?')) return;
      resetAttendanceEditor();
      const editor = bySelector('[data-atendimento-editor]');
      if (editor) editor.open = false;
    });
    const returnForm = bySelector('[data-form-retorno]');
    returnForm.addEventListener('submit', function (event) {
      event.preventDefault(); submit(returnForm, async function () {
        const exact = formValue(returnForm, 'data_exata');
        const start = formValue(returnForm, 'janela_inicio');
        const end = formValue(returnForm, 'janela_fim');
        if ((exact && (start || end)) || (!exact && (!start || !end))) throw new Error('Use data exata ou uma janela completa.');
        const payload = {
          atendimento_id: formValue(returnForm, 'atendimento_id'), recomendacao: formValue(returnForm, 'recomendacao'),
          data_exata: optional(exact), janela_inicio: optional(start), janela_fim: optional(end),
          proxima_acao_em: localTimestampToIso(formValue(returnForm, 'proxima_acao_em')),
          responsavel_id: formValue(returnForm, 'responsavel_id'),
          orientacao: optional(formValue(returnForm, 'orientacao'))
        };
        const intentKey = intentKeyForForm(returnForm, payload);
        payload.idempotency_key = intentKey;
        await protectedRequest('criar_retorno', payload, 'Recomendação de retorno validada pela gestão');
        confirmFormIntent(returnForm, intentKey);
      });
    });
    const preference = bySelector('[data-form-preferencia]');
    preference.addEventListener('submit', function (event) {
      event.preventDefault(); submit(preference, async function () {
        const payload = {
          cliente_id: formValue(preference, 'cliente_id'), finalidade: formValue(preference, 'finalidade'),
          canal: formValue(preference, 'canal'), autorizado: preference.elements.autorizado.checked,
          tipo_evidencia: formValue(preference, 'tipo_evidencia'),
          referencia_evidencia: optional(formValue(preference, 'referencia_evidencia'))
        };
        const intentKey = intentKeyForForm(preference, payload);
        payload.idempotency_key = intentKey;
        await protectedRequest('registrar_preferencia_contato', payload, 'Nova versão da preferência de contato');
        confirmFormIntent(preference, intentKey);
      });
    });
    const profile = bySelector('[data-form-perfil]');
    profile.addEventListener('submit', function (event) {
      event.preventDefault(); submit(profile, async function () {
        const reason = formValue(profile, 'motivo');
        const payload = {
          cliente_id: formValue(profile, 'cliente_id'),
          nome_preferido: optional(formValue(profile, 'nome_preferido')),
          acessibilidade: optional(formValue(profile, 'acessibilidade')),
          aviso_privacidade_versao: optional(formValue(profile, 'aviso_privacidade_versao'))
        };
        const intentKey = intentKeyForForm(profile, payload);
        payload.idempotency_key = intentKey;
        await protectedRequest('registrar_perfil_paciente', payload, reason);
        confirmFormIntent(profile, intentKey);
      });
    });
    const adjustment = bySelector('[data-form-ajuste]');
    adjustment.elements.produto_id.addEventListener('change', hydrateAdjustmentLots);
    adjustment.elements.tipo_evento.addEventListener('change', hydrateAdjustmentLots);
    adjustment.addEventListener('reset', function () { formIntentKeys.delete(adjustment); });
    adjustment.addEventListener('submit', function (event) {
      event.preventDefault(); submit(adjustment, async function () {
        const lot = state.data.estoque_lotes.find(function (row) { return row.lot_id === formValue(adjustment, 'lote_id'); });
        const payload = {
          atendimento_id: formValue(adjustment, 'atendimento_id'), produto_id: formValue(adjustment, 'produto_id'),
          lote_id: formValue(adjustment, 'lote_id'), tipo_evento: formValue(adjustment, 'tipo_evento'),
          quantidade: Number(formValue(adjustment, 'quantidade')), unidade: lot ? lot.unit : '',
          ocorrido_em: localTimestampToIso(formValue(adjustment, 'ocorrido_em')),
          motivo: formValue(adjustment, 'motivo')
        };
        const intentKey = intentKeyForForm(adjustment, payload);
        payload.idempotency_key = intentKey;
        await protectedRequest('registrar_evento_consumo', payload, formValue(adjustment, 'motivo'));
        confirmFormIntent(adjustment, intentKey);
      });
    });
    const cost = bySelector('[data-form-custo]');
    bySelector('[data-custo-adicionar]').addEventListener('click', function () { addCostItem('', null); });
    cost.addEventListener('change', function (event) {
      if (event.target.matches('select[name="custo_produto_id"]')) updateCostUnit(event.target.closest('[data-custo-item]'));
    });
    cost.addEventListener('click', function (event) {
      const button = event.target.closest('[data-custo-remover]');
      if (!button) return;
      const rows = all('[data-custo-item]');
      if (rows.length <= 1) { status('A ficha precisa manter ao menos um produto.', true); return; }
      button.closest('[data-custo-item]').remove();
    });
    cost.addEventListener('submit', function (event) {
      event.preventDefault(); submit(cost, async function () {
        const seen = new Set();
        const items = all('[data-custo-item]').map(function (row) {
          const productId = formValue(row, 'custo_produto_id');
          const product = state.data.produtos.find(function (item) { return item.id === productId; });
          if (!product || seen.has(productId)) throw new Error('Selecione produtos diferentes e quantidades reais.');
          seen.add(productId);
          return { product_id: productId, amount: Number(formValue(row, 'custo_quantidade')), unit: product.unit };
        });
        const payload = {
          procedimento: formValue(cost, 'procedimento'), status: formValue(cost, 'status'),
          vigente_desde: formValue(cost, 'vigente_desde'), itens: items
        };
        const intentKey = intentKeyForForm(cost, payload);
        payload.idempotency_key = intentKey;
        await protectedRequest('registrar_ficha_custo', payload, formValue(cost, 'motivo'));
        confirmFormIntent(cost, intentKey);
      });
    });
    const fee = bySelector('[data-form-taxa]');
    fee.elements.atendimento_id.addEventListener('change', hydrateFeePayments);
    fee.addEventListener('submit', function (event) {
      event.preventDefault(); submit(fee, async function () {
        await protectedRequest('registrar_taxa_pagamento', {
          atendimento_id: formValue(fee, 'atendimento_id'), pagamento_id: formValue(fee, 'pagamento_id'),
          tipo_evento: 'declaracao', valor: Number(formValue(fee, 'valor')),
          tipo_fonte: formValue(fee, 'tipo_fonte'),
          referencia_fonte: optional(formValue(fee, 'referencia_fonte')),
          estorno_de_id: null, idempotency_key: uuid()
        }, Number(formValue(fee, 'valor')) === 0 ?
          'Declaração explícita de pagamento sem taxa' : 'Declaração auditada da taxa do pagamento');
      });
    });
    state.root.addEventListener('change', function (event) {
      if (event.target.matches('[data-fotos-atalho-atendimento]')) selectAttendanceFromPhotos();
      const uploadForm = event.target.closest('[data-form-foto-upload]');
      if (uploadForm && (event.target.matches('[name="categoria"]') || event.target.matches('[name="produto_id"]'))) {
        if (event.target.matches('[name="produto_id"]')) {
          if (uploadForm.elements.lote_selecionado) uploadForm.elements.lote_selecionado.value = '';
        }
        hydratePhotoUpload(uploadForm);
      }
      if (uploadForm && event.target.matches('[name="arquivos"], [name="camera"]')) {
        updatePhotoFileSummary(uploadForm);
        const exception = uploadForm.querySelector('[data-foto-duplicidade]');
        if (exception) exception.hidden = true;
        if (uploadForm.elements.confirmar_arquivo_distinto) {
          uploadForm.elements.confirmar_arquivo_distinto.checked = false;
        }
        if (uploadForm.elements.motivo_duplicidade) uploadForm.elements.motivo_duplicidade.value = '';
        if (window.AMJShell && typeof window.AMJShell.clearDuplicateAlert === 'function') {
          window.AMJShell.clearDuplicateAlert(uploadForm, uploadForm.querySelector('button[type="submit"]'));
        }
      }
      if (uploadForm && event.target.matches('[name="confirmar_arquivo_distinto"]') && event.target.checked &&
          window.AMJShell && typeof window.AMJShell.clearDuplicateAlert === 'function') {
        window.AMJShell.clearDuplicateAlert(uploadForm, uploadForm.querySelector('button[type="submit"]'));
      }
    });
    state.root.addEventListener('reset', function (event) {
      if (event.target && event.target.matches('form')) formIntentKeys.delete(event.target);
    });
    state.root.addEventListener('input', function (event) {
      const duplicateForm = event.target.closest('[data-form-atendimento], [data-form-procedimento]');
      if (!duplicateForm || !window.AMJShell ||
          typeof window.AMJShell.clearDuplicateAlert !== 'function') return;
      window.AMJShell.clearDuplicateAlert(
        duplicateForm,
        duplicateForm.querySelector('[data-atendimento-salvar], [data-procedimento-submit]')
      );
    });
    state.root.addEventListener('submit', function (event) {
      const procedureForm = event.target.closest('[data-form-procedimento]');
      const metadataForm = event.target.closest('[data-form-foto-metadados]');
      const uploadForm = event.target.closest('[data-form-foto-upload]');
      if (!procedureForm && !metadataForm && !uploadForm) return;
      event.preventDefault();
      if (procedureForm) {
        submit(procedureForm, async function () {
          const itemId = formValue(procedureForm, 'procedimento_item_id');
          const confirmDistinct = procedureForm.elements.confirmar_repeticao_distinta.checked;
          const distinctReason = formValue(procedureForm, 'motivo_repeticao_distinta');
          if (confirmDistinct && distinctReason.length < 3) {
            throw new Error('Explique por que a repetição corresponde a outro procedimento real.');
          }
          try {
            await protectedRequest('salvar_procedimento_atendimento', {
              atendimento_id: procedureForm.dataset.atendimentoId,
              procedimento_item_id: optional(itemId),
              versao: itemId ? Number(formValue(procedureForm, 'versao')) : null,
              procedimento: formValue(procedureForm, 'procedimento'),
              regiao_procedimento: optional(formValue(procedureForm, 'regiao_procedimento')),
              procedimento_em: localTimestampToIso(formValue(procedureForm, 'procedimento_em')),
              lancamento_financeiro_id: optional(formValue(procedureForm, 'lancamento_financeiro_id')),
              confirmar_repeticao_distinta: confirmDistinct,
              motivo_repeticao_distinta: optional(distinctReason),
              idempotency_key: uuid()
            }, itemId ? 'Correção auditada do procedimento' : 'Inclusão auditada de procedimento na visita da paciente');
          } catch (error) {
            showDuplicate(
              procedureForm,
              procedureForm.querySelector('[data-procedimento-submit]'),
              'procedimento',
              error
            );
            throw error;
          }
        });
      } else if (metadataForm) {
        submit(metadataForm, async function () {
          await protectedRequest('atualizar_foto_atendimento', {
            atendimento_id: metadataForm.dataset.atendimentoId,
            foto_id: metadataForm.dataset.fotoId,
            versao: Number(formValue(metadataForm, 'versao')),
            procedimento_item_id: optional(formValue(metadataForm, 'procedimento_item_id')),
            ordem: Number(formValue(metadataForm, 'ordem')),
            legenda: optional(formValue(metadataForm, 'legenda')),
            evento_consumo_id: optional(formValue(metadataForm, 'evento_consumo_id'))
          }, 'Correção auditada da organização da foto clínica');
        });
      } else {
        submit(uploadForm, async function () {
          const files = selectedPhotoFiles(uploadForm);
          if (!files.length) throw new Error('Selecione ao menos uma foto.');
          const uploaded = [];
          for (let index = 0; index < files.length; index += 1) {
            status('Guardando foto ' + (index + 1) + ' de ' + files.length + '…');
            uploaded.push(await uploadClinicalPhoto(uploadForm, files[index]));
          }
          const items = uploaded.map(function (photo, index) {
            return metadataForUploadedPhoto(uploadForm, files[index], photo);
          });
          await protectedRequest('vincular_fotos_atendimento', {
            atendimento_id: uploadForm.dataset.atendimentoId,
            fotos: items
          }, 'Inclusão auditada de fotos clínicas no atendimento');
        });
      }
    });
    state.root.addEventListener('click', async function (event) {
      const linked = event.target.closest('[data-vinculo-abrir]');
      if (linked) {
        try {
          const form = bySelector('[data-form-atendimento]');
          if (linked.dataset.vinculoAbrir === 'prontuario') {
            const protocolId = formValue(form, 'protocolo_id');
            if (!protocolId) { attendanceStatus('Ainda não há prontuário selecionado. Salve o atendimento e use Preparar prontuário e fotos na consulta.'); return; }
            if (!window.AMJProntuario || typeof window.AMJProntuario.abrirProtocolo !== 'function') throw new Error('A tela de prontuários não está disponível neste momento. Seu formulário foi preservado.');
            await window.AMJProntuario.abrirProtocolo(protocolId);
          } else if (linked.dataset.vinculoAbrir === 'cobranca') {
            const entryId = formValue(form, 'lancamento_financeiro_id');
            if (!entryId) { attendanceStatus('Selecione uma cobrança existente da paciente. Se ainda não existe, cadastre no Financeiro e depois vincule, sem repetir a mesma venda.'); return; }
            if (!window.AMJFinanceiro || typeof window.AMJFinanceiro.abrirLancamento !== 'function') throw new Error('Não foi possível abrir a cobrança. O atendimento não foi alterado.');
            if (!await window.AMJFinanceiro.abrirLancamento(entryId)) attendanceStatus('Não foi possível abrir a cobrança agora. O atendimento foi preservado; confira a mensagem na área financeira.', true);
          } else if (window.AMJShell) await window.AMJShell.navigate('agenda', {source:'vinculo-atendimento'});
        } catch (error) { attendanceStatus(error.message, true); status(error.message, true); }
        return;
      }
      const photoShortcut = event.target.closest('[data-fotos-atalho-abrir]');
      if (photoShortcut) {
        const visit = selectedPhotoShortcutVisit();
        if (!visit) {
          status('Selecione a paciente e o atendimento antes de continuar.', true);
          const select = bySelector('[data-fotos-atalho-atendimento]');
          if (select) select.focus();
          return;
        }
        try {
          await openPhotoShortcutFlow(visit.id);
        } catch (error) {
          status(error.message || 'Não foi possível abrir as fotos desta consulta.', true);
        }
        return;
      }
      const prepareProtocol = event.target.closest('[data-prontuario-preparar]');
      const openProtocol = event.target.closest('[data-prontuario-abrir]');
      const finalizeProtocol = event.target.closest('[data-prontuario-finalizar]');
      const openPhotosButton = event.target.closest('[data-fotos-abrir]');
      if (openPhotosButton) {
        try {
          await openAttendancePhotos(openPhotosButton.dataset.fotosAbrir);
        } catch (error) { status(error.message || 'Não foi possível abrir as fotos da consulta.', true); }
        return;
      }
      if (openProtocol) {
        try {
          if (!window.AMJProntuario || typeof window.AMJProntuario.abrirProtocolo !== 'function') {
            throw new Error('O módulo de prontuários ainda não está disponível. Atualize a página.');
          }
          await window.AMJProntuario.abrirProtocolo(openProtocol.dataset.prontuarioAbrir);
        } catch (error) { status(error.message || 'Não foi possível abrir o prontuário.', true); }
        return;
      }
      if (prepareProtocol || finalizeProtocol) {
        let photosAttendanceId = prepareProtocol ? prepareProtocol.dataset.prontuarioPreparar : null;
        if (!photosAttendanceId && finalizeProtocol) {
          const linkedVisit = state.data.atendimentos.find(function (visit) {
            return visit.protocol_id === finalizeProtocol.dataset.prontuarioFinalizar;
          });
          photosAttendanceId = linkedVisit && linkedVisit.id;
        }
        setBusy(true);
        try {
          if (prepareProtocol) {
            const attendanceId = prepareProtocol.dataset.prontuarioPreparar;
            await prepareAttendanceProtocol(attendanceId, prepareProtocol.dataset.versao);
            status('Prontuário em rascunho vinculado. Adicione fotos ao arquivo privado; nenhum consentimento será criado automaticamente.');
          } else {
            await protectedProntuarioRequest('finalizar', {
              protocolo_id: finalizeProtocol.dataset.prontuarioFinalizar,
              versao_esperada: Number(finalizeProtocol.dataset.versao)
            }, {
              titulo: 'Finalizar registro da consulta',
              explicacao: 'Confirme somente após revisar o registro e ao menos uma foto clínica ativa em Antes, Durante ou Depois. Fotos de produtos não contam. O arquivo é privado; publicação exige autorização específica.',
              motivo: 'Finalização do registro clínico confirmada pela gestão'
            });
            status('Registro documental da consulta finalizado. O status clínico do atendimento não foi alterado.');
          }
          await loadAfterMutation();
          if (photosAttendanceId) await openAttendancePhotos(photosAttendanceId);
        } catch (error) {
          const finalizationMessage = ({
            clinical_photography_consent_required: 'A versão atual do servidor não liberou esta finalização privada. Atualize a página e tente novamente; nenhum consentimento será presumido.',
            clinical_photo_required: 'Adicione ao menos uma foto clínica ativa em Antes, Durante ou Depois. Fotos de produtos não contam.',
            version_conflict: 'O registro mudou em outro acesso. Atualize e tente novamente.',
            protocol_archived: 'Restaure o prontuário antes de finalizar.',
            protocol_locked: 'Este registro documental já está finalizado.'
          })[error && error.code];
          status(finalizationMessage || error.message || 'Não foi possível concluir a ação documental.', true);
        } finally { setBusy(false); }
        return;
      }
      const cancelProcedure = event.target.closest('[data-procedimento-cancelar]');
      if (cancelProcedure) {
        resetProcedureEditor(cancelProcedure.closest('[data-form-procedimento]'));
        return;
      }
      const loadMore = event.target.closest('[data-operacao-carregar-mais]');
      if (loadMore) {
        state.listLimit = Math.min(state.listLimit * 2, 5000);
        await load();
        return;
      }
      const summaryButton = event.target.closest('[data-resumo-procedimento]');
      if (summaryButton) {
        try { openAdministrativeSummary(summaryButton.dataset.resumoProcedimento); }
        catch (error) { status(error.message || 'Não foi possível abrir o resumo.', true); }
        return;
      }
      const useCost = event.target.closest('[data-custo-usar]');
      if (useCost) {
        try { populateCostSheet(useCost.dataset.custoUsar); }
        catch (error) { status(error.message || 'Não foi possível carregar a ficha.', true); }
        return;
      }
      const editAttendanceButton = event.target.closest('[data-atendimento-editar]');
      if (editAttendanceButton) {
        editAttendance(editAttendanceButton.dataset.atendimentoEditar);
        return;
      }
      const archivePhoto = event.target.closest('[data-foto-arquivar]');
      const restorePhoto = event.target.closest('[data-foto-restaurar]');
      if (archivePhoto || restorePhoto) {
        const photoId = archivePhoto ? archivePhoto.dataset.fotoArquivar : restorePhoto.dataset.fotoRestaurar;
        const restoring = Boolean(restorePhoto);
        setBusy(true);
        try {
          await protectedProntuarioRequest(restoring ? 'restaurar_foto' : 'remover_foto', {
            foto_id: photoId
          }, {
            titulo: restoring ? 'Restaurar foto clínica' : 'Apagar/Arquivar foto clínica',
            explicacao: restoring
              ? 'A foto voltará à galeria privada e a restauração ficará registrada.'
              : 'O original privado será arquivado sem apagar o histórico e poderá ser restaurado.',
            motivo: restoring
              ? 'Restauração de foto clínica solicitada pela gestão'
              : 'Arquivamento de foto clínica solicitado pela gestão'
          });
          await loadAfterMutation();
        } catch (error) { status(error.message || 'Não foi possível atualizar a foto.', true); }
        finally { setBusy(false); }
        return;
      }
      const editProcedure = event.target.closest('[data-procedimento-editar]');
      if (editProcedure) {
        try { editProcedureInline(editProcedure.dataset.procedimentoEditar); }
        catch (error) { status(error.message || 'Não foi possível editar o procedimento.', true); }
        return;
      }
      const archiveProcedure = event.target.closest('[data-procedimento-arquivar]');
      const restoreProcedure = event.target.closest('[data-procedimento-restaurar]');
      const retireCost = event.target.closest('[data-custo-retirar]');
      const reverseFee = event.target.closest('[data-taxa-estornar]');
      if (archiveProcedure || restoreProcedure || retireCost || reverseFee) {
        setBusy(true);
        try {
          if (archiveProcedure || restoreProcedure) {
            const button = archiveProcedure || restoreProcedure;
            const archive = Boolean(archiveProcedure);
            const procedureItemId = archive ? button.dataset.procedimentoArquivar : button.dataset.procedimentoRestaurar;
            const procedureItem = state.data.procedimentos_atendimento.find(function (item) {
              return item.id === procedureItemId;
            });
            let confirmDistinct = false;
            let distinctReason = null;
            if (!archive && procedureItem) {
              const exactDuplicate = state.data.procedimentos_atendimento.find(function (item) {
                return item.id !== procedureItem.id && !item.archived_at &&
                  item.material_fingerprint === procedureItem.material_fingerprint;
              });
              if (exactDuplicate) {
                const duplicateError = new Error(
                  'Este procedimento já está ativo com o mesmo tipo, região e horário.'
                );
                duplicateError.code = 'procedure_duplicate_exists';
                duplicateError.existingId = exactDuplicate.id;
                showDuplicate(button.closest('.operacao-visita'), button, 'procedimento', duplicateError);
                return;
              }
              const activeDuplicate = state.data.procedimentos_atendimento.find(function (item) {
                return item.id !== procedureItem.id && !item.archived_at &&
                  String(item.procedure_kind || '').trim().toLocaleLowerCase('pt-BR') ===
                    String(procedureItem.procedure_kind || '').trim().toLocaleLowerCase('pt-BR');
              });
              if (activeDuplicate) {
                const answer = window.prompt(
                  'Já existe um procedimento igual nesta visita. Para restaurar como outro procedimento real, informe o motivo da repetição:',
                  procedureItem.distinct_duplicate_reason || ''
                );
                if (answer === null) return;
                distinctReason = answer.trim();
                if (distinctReason.length < 3) {
                  throw new Error('Explique por que este é outro procedimento real antes de restaurar.');
                }
                confirmDistinct = true;
              }
            }
            await protectedRequest(
              archive ? 'arquivar_procedimento_atendimento' : 'restaurar_procedimento_atendimento',
              {
                procedimento_item_id: procedureItemId,
                versao: Number(button.dataset.versao),
                confirmar_repeticao_distinta: confirmDistinct,
                motivo_repeticao_distinta: distinctReason
              },
              archive ? 'Procedimento apagado por arquivamento auditado' : 'Restauração auditada do procedimento'
            );
          } else if (retireCost) {
            const sheet = state.data.fichas_custo.find(function (row) { return row.id === retireCost.dataset.custoRetirar; });
            if (!sheet) throw new Error('Ficha não encontrada. Atualize a tela.');
            const payload = {
              procedimento: sheet.procedure_kind, status: 'retirada', vigente_desde: today(),
              itens: []
            };
            const intentKey = intentKeyForForm(retireCost, payload);
            payload.idempotency_key = intentKey;
            await protectedRequest('registrar_ficha_custo', payload, 'Retirada auditada da ficha de custo esperada');
            confirmFormIntent(retireCost, intentKey);
          } else {
            const declaration = state.data.taxas_pagamento.find(function (row) {
              return row.id === reverseFee.dataset.taxaEstornar;
            });
            if (!declaration) throw new Error('Declaração não encontrada. Atualize a tela.');
            await protectedRequest('registrar_taxa_pagamento', {
              atendimento_id: declaration.attendance_id, pagamento_id: declaration.payment_id,
              tipo_evento: 'estorno', valor: Number(declaration.amount),
              tipo_fonte: declaration.source_kind, referencia_fonte: declaration.source_reference || null,
              estorno_de_id: declaration.id, idempotency_key: uuid()
            }, 'Estorno auditado da declaração de taxa');
          }
          await loadAfterMutation();
        } catch (error) { status(error.message || 'Não foi possível concluir.', true); }
        finally { setBusy(false); }
        return;
      }
      const archiveAttendanceButton = event.target.closest('[data-atendimento-arquivar]');
      const restoreAttendanceButton = event.target.closest('[data-atendimento-restaurar]');
      const attempt = event.target.closest('[data-tentativa]');
      const link = event.target.closest('[data-vincular]');
      const returnAction = event.target.closest('[data-retorno-acao]');
      if (!archiveAttendanceButton && !restoreAttendanceButton && !attempt && !link && !returnAction) return;
      setBusy(true);
      try {
        if (archiveAttendanceButton || restoreAttendanceButton) {
          const button = archiveAttendanceButton || restoreAttendanceButton;
          const archive = Boolean(archiveAttendanceButton);
          await protectedRequest(archive ? 'arquivar_atendimento' : 'restaurar_atendimento', {
            atendimento_id: archive
              ? button.dataset.atendimentoArquivar
              : button.dataset.atendimentoRestaurar,
            versao: Number(button.dataset.versao)
          }, archive ? 'Atendimento apagado por arquivamento auditado' : 'Restauração auditada do atendimento');
        } else if (returnAction) {
          const row = state.data.fila_retorno.find(function (item) { return item.id === returnAction.dataset.fila; });
          if (!row) throw new Error('Retorno não encontrado. Atualize a tela.');
          let nextAction = 'nenhuma';
          let nextActionAt = null;
          let statusValue = row.status;
          let reason = '';
          if (returnAction.dataset.retornoAcao === 'reprogramar') {
            const localValue = window.prompt(
              'Nova data e horário da próxima ação (AAAA-MM-DDTHH:MM)',
              timestampToLocalInput(row.next_action_at || new Date(Date.now() + 86400000).toISOString())
            );
            if (!localValue) return;
            nextAction = row.status === 'agendado' ? 'confirmar_agenda' : 'recontatar';
            nextActionAt = localTimestampToIso(localValue);
            reason = 'Atualização auditada da próxima ação do retorno';
          } else if (returnAction.dataset.retornoAcao === 'concluir') {
            statusValue = 'concluido';
            reason = 'Conclusão auditada do acompanhamento de retorno';
          } else {
            statusValue = 'cancelado';
            reason = 'Cancelamento auditado do acompanhamento de retorno';
          }
          await protectedRequest('atualizar_retorno', {
            fila_id: row.id, versao: Number(row.version), status: statusValue,
            proxima_acao: nextAction, proxima_acao_em: nextActionAt,
            responsavel_id: row.responsible_user_id
          }, reason);
        } else if (attempt) {
          const channel = window.prompt('Canal: whatsapp, telefone, email ou sms', 'whatsapp');
          if (!channel) return;
          const result = window.prompt('Resultado: sem_resposta, respondeu, agendou, recusou, numero_invalido ou canal_indisponivel', 'sem_resposta');
          if (!result) return;
          const next = result === 'recusou' ? 'nenhuma' : 'recontatar';
          await protectedRequest('registrar_tentativa_retorno', {
            fila_id: attempt.dataset.tentativa, versao: Number(attempt.dataset.versao), canal: channel,
            finalidade: 'retorno', resultado: result, proxima_acao: next,
            proxima_acao_em: next === 'nenhuma' ? null : new Date(Date.now() + 86400000).toISOString(),
            tentado_em: new Date().toISOString(), idempotency_key: uuid()
          }, 'Registro manual de tentativa de retorno');
        } else {
          const select = bySelector('[data-agenda-fila="' + link.dataset.vincular + '"]');
          if (!select || !select.value) throw new Error('Selecione um agendamento de retorno.');
          await protectedRequest('vincular_retorno_agendamento', {
            fila_id: link.dataset.vincular, versao: Number(link.dataset.versao), agendamento_id: select.value
          }, 'Vínculo do retorno com a agenda');
        }
        await loadAfterMutation();
      } catch (error) { status(error.message || 'Não foi possível concluir.', true); }
      finally { setBusy(false); }
    });
  }

  async function openAttendance(id) {
    const requestedId = String(id || '');
    if (!requestedId || !ownerAccess()) return false;
    const generation = state.generation;
    if (state.loadPromise) await state.loadPromise;
    else if (!state.loaded) await load();
    if (generation !== state.generation || !ownerAccess()) return false;
    const procedure = state.data.procedimentos_atendimento.find(function (item) {
      return item.id === requestedId;
    });
    const photo = state.data.fotos_atendimento.find(function (item) {
      return item.photo_id === requestedId;
    });
    const photoIndex = state.data.indice_fotos_atendimento.find(function (item) {
      return item.photo_id === requestedId;
    });
    const attendanceId = procedure ? procedure.attendance_id : photo ? photo.attendance_id :
      photoIndex ? photoIndex.attendance_id : requestedId;
    const card = bySelector('[data-atendimento-card="' + CSS.escape(attendanceId) + '"]');
    if (!card) return false;
    card.hidden = false;
    if (card.closest('.operacao-paciente')) card.closest('.operacao-paciente').hidden = false;
    card.open = true;
    all('[data-atendimento-card]').forEach(function (item) { item.classList.remove('em-destaque'); });
    card.classList.add('em-destaque');
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const focusTarget = procedure
      ? card.querySelector('[data-procedimento-editar="' + CSS.escape(procedure.id) + '"], [data-procedimento-restaurar="' + CSS.escape(procedure.id) + '"]')
      : card.querySelector('[data-atendimento-editar], [data-atendimento-restaurar]');
    if (focusTarget) focusTarget.focus({ preventScroll: true });
    window.setTimeout(function () { card.classList.remove('em-destaque'); }, 5000);
    return true;
  }

  async function focusPhotoShortcut() {
    if (!ownerAccess()) return false;
    if (!state.loaded) await load();
    if (!state.loaded) return false;
    const shortcut = bySelector('[data-fotos-atalho]');
    const select = bySelector('[data-fotos-atalho-atendimento]');
    if (!shortcut || !select) return false;
    window.setTimeout(function () {
      shortcut.scrollIntoView({ behavior: 'smooth', block: 'start' });
      select.focus({ preventScroll: true });
    }, 120);
    return true;
  }

  async function openPhotoShortcutFlow(id) {
    if (!ownerAccess()) throw new Error('Esta área exige a conta proprietária com autenticação em duas etapas.');
    const attendanceId = String(id || '');
    if (!attendanceId) return false;
    if (!state.loaded && ownerAccess()) await load();
    let visit = state.data.atendimentos.find(function (item) { return item.id === attendanceId; });
    if (!visit) throw new Error('Atendimento não encontrado. O preenchimento atual foi preservado.');
    if (visit.archived_at) {
      if (visit.protocol_id && window.AMJProntuario && typeof window.AMJProntuario.abrirProtocolo === 'function') {
        await window.AMJProntuario.abrirProtocolo(visit.protocol_id);
        return true;
      }
      await openAttendance(attendanceId);
      status('Atendimento arquivado aberto para consulta. Restaurar é uma ação separada.');
      return true;
    }
    if (!visit.protocol_id) {
      setBusy(true);
      status('Preparando o prontuário seguro desta consulta…');
      try {
        await prepareAttendanceProtocol(visit.id, visit.version);
        await loadAfterMutation();
        visit = state.data.atendimentos.find(function (item) { return item.id === attendanceId; });
        if (!visit || !visit.protocol_id) throw new Error('O prontuário foi preparado, mas o vínculo ainda não apareceu. Atualize e tente novamente.');
        status('Prontuário preparado. Adicione fotos ao arquivo clínico privado; publicação exige autorização específica.');
      } finally {
        setBusy(false);
      }
    }
    const protocol = protocolForVisit(visit);
    if (!protocol) throw new Error('Não foi possível conferir este prontuário. Atualize a tela antes de adicionar fotos.');
    if (protocol && protocol.archived_at) {
      if (!window.AMJProntuario || typeof window.AMJProntuario.abrirProtocolo !== 'function') throw new Error('A tela de prontuários não está disponível neste momento.');
      await window.AMJProntuario.abrirProtocolo(protocol.id);
      return true;
    }
    if (!await openAttendancePhotos(attendanceId)) return false;
    const upload = bySelector('[data-form-foto-upload][data-atendimento-id="' + CSS.escape(attendanceId) + '"]');
    if (upload) {
      upload.scrollIntoView({ behavior: 'smooth', block: 'center' });
      const files = upload.elements.arquivos;
      if (files) window.setTimeout(function () { files.focus({ preventScroll: true }); }, 250);
      status('Galeria aberta. Escolha várias fotos ou use “Tirar foto agora” no celular.');
    }
    return true;
  }

  async function openAttendancePhotos(id) {
    const attendanceId = String(id || '');
    if (!attendanceId) return false;
    if (!state.loaded && ownerAccess()) await load();
    const visit = state.data.atendimentos.find(function (item) { return item.id === attendanceId; });
    if (!visit) return false;
    const protocol = protocolForVisit(visit);
    if (protocol && protocol.archived_at) {
      if (!window.AMJProntuario || typeof window.AMJProntuario.abrirProtocolo !== 'function') throw new Error('A tela de prontuários não está disponível neste momento.');
      await window.AMJProntuario.abrirProtocolo(protocol.id);
      return true;
    }
    const parentCard = bySelector('[data-atendimento-card="' + CSS.escape(attendanceId) + '"]');
    if (parentCard) {
      parentCard.open = true; parentCard.hidden = false;
      if (parentCard.closest('.operacao-paciente')) parentCard.closest('.operacao-paciente').hidden = false;
    }
    let section = bySelector('[data-fotos-consulta="' + CSS.escape(attendanceId) + '"]');
    if (!section) return false;
    let gallery = section.querySelector('[data-galeria-atendimento]');
    if (gallery) gallery.open = true;
    if (visit.protocol_id && !attendancePhotosAreFresh(attendanceId)) {
      if (!await loadAttendancePhotos(attendanceId)) return false;
      section = bySelector('[data-fotos-consulta="' + CSS.escape(attendanceId) + '"]');
      gallery = section && section.querySelector('[data-galeria-atendimento]');
      if (gallery) gallery.open = true;
    }
    const card = bySelector('[data-atendimento-card="' + CSS.escape(attendanceId) + '"]');
    if (card) {
      all('[data-atendimento-card]').forEach(function (item) { item.classList.remove('em-destaque'); });
      card.classList.add('em-destaque');
      window.setTimeout(function () { card.classList.remove('em-destaque'); }, 5000);
    }
    const focusTarget = gallery ? gallery.querySelector('summary') :
      section.querySelector('[data-prontuario-preparar], [data-prontuario-abrir]');
    section.scrollIntoView({ behavior: 'smooth', block: 'center' });
    if (focusTarget) focusTarget.focus({ preventScroll: true });
    return true;
  }

  async function openPhoto(id) {
    const requestedId = String(id || '');
    if (!requestedId) return false;
    if (!state.loaded && ownerAccess()) await load();
    let photo = state.data.fotos_atendimento.find(function (item) {
      return item.photo_id === requestedId;
    });
    const photoIndex = state.data.indice_fotos_atendimento.find(function (item) {
      return item.photo_id === requestedId;
    });
    const attendanceId = photo ? photo.attendance_id : photoIndex && photoIndex.attendance_id;
    if (attendanceId && !attendancePhotosAreFresh(attendanceId)) {
      if (!await loadAttendancePhotos(attendanceId)) return false;
      photo = state.data.fotos_atendimento.find(function (item) {
        return item.photo_id === requestedId;
      });
    }
    if (!photo || !await openAttendance(attendanceId)) return false;
    const card = bySelector('[data-foto-card="' + CSS.escape(requestedId) + '"]');
    if (!card) return false;
    const gallery = card.closest('details');
    if (gallery) gallery.open = true;
    all('[data-foto-card]').forEach(function (item) { item.classList.remove('em-destaque'); });
    card.classList.add('em-destaque');
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const focusTarget = card.querySelector('button,a[href],input,select');
    if (focusTarget) focusTarget.focus({ preventScroll: true });
    window.setTimeout(function () { card.classList.remove('em-destaque'); }, 5000);
    return true;
  }

  function mount(target) {
    const root = typeof target === 'string' ? document.querySelector(target) : target;
    if (!root) return false;
    state.root = root;
    state.root.innerHTML = shell();
    bind();
    if (ownerAccess()) load(); else status('Entre com a conta de responsável e confirme o autenticador.', true);
    return true;
  }
  function updateAccess() {
    if (!state.root) return;
    state.root.hidden = !ownerAccess();
    if (ownerAccess() && !state.loaded) load();
  }
  function reset() {
    state.generation += 1; state.loaded = false; state.loading = false;
    state.loadPromise = null;
    photoLoadEpoch += 1;
    loadedPhotoAttendances.clear(); loadingPhotoAttendances.clear(); protocolPrepareKeys.clear();
    protocolProductsById.clear(); loadingProtocolProducts.clear();
    state.listLimit = 1000; state.pagination = null; state.data = emptyData();
    state.attendanceBaseline = ''; state.selectedAttendanceId = ''; state.attendanceRevision += 1;
  }

  window.AMJOperacaoClinica = {
    montar: mount,
    novoAtendimento: startAttendance,
    ativar: load,
    abrirAtendimento: openAttendance,
    abrirAtalhoFotos: focusPhotoShortcut,
    iniciarFotos: openPhotoShortcutFlow,
    abrirFotos: openAttendancePhotos,
    abrirFoto: openPhoto,
    carregar: load,
    executar: execute,
    atualizarAcesso: updateAccess,
    reset: reset,
    contrato: {
      metrica: 'margem_de_contribuicao_gerencial',
      mensagensAutomaticas: false,
      endpoint: API
    }
  };
  if (window.__AMJ_TEST__) {
    window.AMJOperacaoClinica.__test = {
      intentKeyForForm: intentKeyForForm,
      confirmFormIntent: confirmFormIntent,
      protocolPrepareKey: protocolPrepareKey,
      confirmProtocolPrepare: confirmProtocolPrepare,
      clinicalPhotoPending: clinicalPhotoPending,
      photoCategoryCounts: photoCategoryCounts
    };
  }
  document.addEventListener('DOMContentLoaded', function () {
    const root = document.getElementById('operacao-clinica-root');
    if (root) mount(root);
  });
})();

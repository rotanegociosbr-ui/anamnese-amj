(function () {
  'use strict';

  const API = 'https://rjxtxoqprnumouqakxbc.supabase.co/functions/v1/gestao-administrativa-fichas';
  const MONEY = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
  const DATE = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeZone: 'America/Sao_Paulo' });
  const state = {
    root: null,
    loaded: false,
    loading: false,
    dashboard: {},
    accounts: [],
    cashAccounts: [],
    payments: [],
    liquidations: [],
    reconciliations: [],
    equipment: [],
    maintenance: [],
    closures: [],
    alerts: [],
    backups: [],
    sources: [],
    metrics: [],
    generation: 0,
    controllers: new Set()
  };
  const formIntentKeys = new WeakMap();

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
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
  function intentIdForForm(form, payload) {
    const fingerprint = JSON.stringify(canonicalIntentValue(payload || {}));
    const remembered = formIntentKeys.get(form);
    if (remembered && remembered.fingerprint === fingerprint) return remembered.id;
    const id = uuid();
    formIntentKeys.set(form, { fingerprint: fingerprint, id: id });
    return id;
  }
  function confirmFormIntent(form, id) {
    const remembered = formIntentKeys.get(form);
    if (remembered && remembered.id === id) formIntentKeys.delete(form);
  }
  function money(value) { return MONEY.format(Number(value) || 0); }
  function date(value) {
    const parsed = new Date(/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))
      ? String(value) + 'T12:00:00-03:00' : String(value || ''));
    return Number.isFinite(parsed.getTime()) ? DATE.format(parsed) : '—';
  }
  function today() {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(new Date());
    const map = Object.create(null);
    parts.forEach(function (part) { if (part.type !== 'literal') map[part.type] = part.value; });
    return map.year + '-' + map.month + '-' + map.day;
  }
  function monthStart() { return today().slice(0, 8) + '01'; }
  function clinicDateTimeValue(value) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).formatToParts(new Date(value));
    const map = Object.create(null);
    parts.forEach(function (part) { if (part.type !== 'literal') map[part.type] = part.value; });
    return map.year + '-' + map.month + '-' + map.day + 'T' + map.hour + ':' + map.minute;
  }
  function localDateTime() { return clinicDateTimeValue(new Date()); }
  function ownerAccess() {
    try {
      return typeof modoAcesso !== 'undefined' && modoAcesso === 'auth' &&
        typeof identidadeBackend !== 'undefined' && identidadeBackend &&
        String(identidadeBackend.role || '').toLowerCase() === 'owner';
    } catch (_) { return false; }
  }
  function byId(id) { return state.root && state.root.querySelector('#' + id); }
  function formObject(form) {
    const data = Object.create(null);
    new FormData(form).forEach(function (value, key) {
      data[key] = typeof value === 'string' ? value.trim() : value;
    });
    form.querySelectorAll('input[type="checkbox"]').forEach(function (input) {
      data[input.name] = input.checked;
    });
    return data;
  }
  function setStatus(message, error) {
    const node = byId('gestao-status');
    if (!node) return;
    node.textContent = message || '';
    node.classList.toggle('erro', Boolean(error));
  }
  function setBusy(busy) {
    if (!state.root) return;
    state.root.setAttribute('aria-busy', String(Boolean(busy)));
    state.root.querySelectorAll('button[type="submit"],button[data-gestao-recarregar]').forEach(function (button) {
      button.disabled = Boolean(busy);
    });
  }

  async function call(action, payload, proof) {
    if (!ownerAccess()) throw new Error('Esta área exige uma conta proprietária individual com MFA.');
    const generation = state.generation;
    const controller = new AbortController();
    state.controllers.add(controller);
    try {
      if (typeof cabecalhosAcesso !== 'function') throw new Error('O componente de acesso seguro não foi carregado.');
      const headers = await cabecalhosAcesso(true, proof);
      const response = await fetch(API, {
        method: 'POST', headers: headers, cache: 'no-store', referrerPolicy: 'no-referrer',
        signal: controller.signal,
        body: JSON.stringify(Object.assign({ acao: action }, payload || {}))
      });
      let data = {};
      try { data = await response.json(); } catch (_) { data = {}; }
      if (generation !== state.generation) throw new Error('Sessão administrativa encerrada.');
      if (!response.ok || data.erro) {
        const error = new Error(data.erro || 'Não foi possível concluir a operação.');
        error.code = data.codigo || String(response.status);
        throw error;
      }
      if (data.identity && typeof atualizarIdentidade === 'function') atualizarIdentidade(data);
      return data;
    } finally {
      state.controllers.delete(controller);
    }
  }

  async function protectedCall(action, payload, options) {
    if (!window.AMJProtecao || typeof window.AMJProtecao.solicitarSenhaRecente !== 'function') {
      throw new Error('A confirmação por senha não está disponível. Atualize a página.');
    }
    let proof = null;
    try {
      proof = await window.AMJProtecao.solicitarSenhaRecente(options || {});
      return await call(action, Object.assign({}, payload || {}, {
        operation_id: proof.operation_id,
        motivo: proof.motivo || 'Operação administrativa confirmada'
      }), proof);
    } finally {
      if (proof && typeof proof.encerrar === 'function') await proof.encerrar();
    }
  }

  function shell() {
    return '<section class="gestao-shell" aria-labelledby="gestao-titulo">' +
      '<header class="gestao-cabecalho"><div><p class="gestao-sobretitulo">AMJ · controle administrativo</p>' +
      '<h2 id="gestao-titulo">Gestão, caixa e ativos</h2>' +
      '<p>Dados gerenciais rastreáveis. Fluxo não é lucro; fechamento exige conciliação.</p></div>' +
      '<div class="gestao-filtros"><label>Início<input id="gestao-inicio" type="date" value="' + monthStart() + '"></label>' +
      '<label>Fim<input id="gestao-fim" type="date" value="' + today() + '"></label>' +
      '<button type="button" data-gestao-recarregar>Atualizar</button></div></header>' +
      '<p id="gestao-status" class="gestao-status" role="status" aria-live="polite"></p>' +
      '<div id="gestao-kpis" class="gestao-kpis"></div>' +
      '<nav class="gestao-nav" aria-label="Áreas administrativas">' +
      ['visao', 'tesouraria', 'ativos', 'fechamento', 'governanca'].map(function (key, index) {
        const labels = { visao: 'Visão geral', tesouraria: 'Tesouraria', ativos: 'Ativos', fechamento: 'Fechamento', governanca: 'Governança' };
        return '<button type="button" data-gestao-tab="' + key + '" aria-selected="' + String(index === 0) + '">' + labels[key] + '</button>';
      }).join('') + '</nav>' +
      '<div id="gestao-conteudo" class="gestao-conteudo"></div></section>';
  }

  function kpi(label, value, note, tone) {
    return '<article class="gestao-kpi ' + escapeHtml(tone || '') + '"><span>' + escapeHtml(label) + '</span>' +
      '<strong>' + escapeHtml(value) + '</strong><small>' + escapeHtml(note || '') + '</small></article>';
  }
  function renderKpis() {
    const node = byId('gestao-kpis');
    if (!node) return;
    const dashboard = state.dashboard || {};
    const finance = dashboard.financeiro || {};
    const accounts = dashboard.contas || {};
    const stock = dashboard.estoque || {};
    const assets = dashboard.ativos || {};
    node.innerHTML = [
      kpi('Entradas registradas', money(finance.entradas_caixa), 'Caixa realizado no período', 'positivo'),
      kpi('Saídas registradas', money(finance.saidas_caixa), 'Caixa realizado no período', 'negativo'),
      kpi('Fluxo líquido', money(finance.fluxo_liquido), 'Não representa lucro', Number(finance.fluxo_liquido) < 0 ? 'negativo' : 'positivo'),
      kpi('A receber em aberto', money(accounts.receber_aberto), money(accounts.receber_vencido) + ' vencido', Number(accounts.receber_vencido) > 0 ? 'alerta' : ''),
      kpi('A pagar em aberto', money(accounts.pagar_aberto), money(accounts.pagar_vencido) + ' vencido', Number(accounts.pagar_vencido) > 0 ? 'alerta' : ''),
      kpi('Estoque gerencial', money(stock.valor_gerencial), String(stock.saldos_negativos || 0) + ' saldo(s) negativo(s)', Number(stock.saldos_negativos) > 0 ? 'alerta' : ''),
      kpi('Conciliações pendentes', String(accounts.conciliacoes_pendentes || 0), 'Obrigatórias antes do fechamento', Number(accounts.conciliacoes_pendentes) > 0 ? 'alerta' : ''),
      kpi('Ativos indisponíveis', String(assets.indisponiveis || 0), String(assets.manutencoes_vencidas || 0) + ' manutenção(ões) vencida(s)', Number(assets.indisponiveis) > 0 ? 'alerta' : '')
    ].join('');
  }

  function table(headers, rowsHtml, empty) {
    return '<div class="gestao-tabela-wrap"><table><thead><tr>' + headers.map(function (header) {
      return '<th scope="col">' + escapeHtml(header) + '</th>';
    }).join('') + '</tr></thead><tbody>' + (rowsHtml || '<tr><td colspan="' + headers.length + '" class="gestao-vazio">' +
      escapeHtml(empty || 'Nenhum registro.') + '</td></tr>') + '</tbody></table></div>';
  }
  function section(title, subtitle, content, actions) {
    return '<section class="gestao-bloco"><header><div><h3>' + escapeHtml(title) + '</h3><p>' + escapeHtml(subtitle || '') +
      '</p></div>' + (actions || '') + '</header>' + content + '</section>';
  }

  function renderOverview() {
    const dashboard = state.dashboard || {};
    const returns = dashboard.retornos || {};
    const governance = dashboard.governanca || {};
    const alerts = state.alerts.map(function (item) {
      return '<tr><td>' + escapeHtml(item.severity) + '</td><td>' + escapeHtml(item.alert_kind) + '</td><td>' +
        escapeHtml(item.reason_code) + '</td><td>' + escapeHtml(date(item.due_date)) + '</td></tr>';
    }).join('');
    return section('Decisões do período', 'Indicadores agregados, sem nomes de pacientes.',
      '<div class="gestao-resumo-grid"><p><strong>' + escapeHtml(String(returns.previstos_periodo || 0)) +
      '</strong><span>ações de retorno previstas</span></p><p><strong>' + escapeHtml(String(returns.vencidos || 0)) +
      '</strong><span>ações de retorno vencidas</span></p><p><strong>' + escapeHtml(String(governance.eventos_auditoria_periodo || 0)) +
      '</strong><span>eventos auditados</span></p><p><strong>' + escapeHtml(governance.ultima_restauracao_testada_em ? date(governance.ultima_restauracao_testada_em) : 'Sem evidência') +
      '</strong><span>última restauração testada</span></p></div>') +
      section('Alertas acionáveis', 'Prazos técnicos só aparecem quando possuem fonte registrada.',
        table(['Severidade', 'Tipo', 'Motivo técnico', 'Data'], alerts, 'Nenhum alerta de ativo aberto.'));
  }

  function cashAccountForm() {
    return '<details class="gestao-editor"><summary>Nova conta operacional</summary><form id="gestao-form-conta" class="gestao-form">' +
      '<input type="hidden" name="conta_id"><input type="hidden" name="versao">' +
      '<label>Nome operacional<input name="nome" maxlength="100" required placeholder="Ex.: Caixa da clínica"></label>' +
      '<label>Tipo<select name="tipo" required><option value="banco">Banco</option><option value="caixa">Caixa físico</option><option value="carteira">Carteira</option><option value="gateway">Gateway</option><option value="outro">Outro</option></select></label>' +
      '<label>Instituição<input name="instituicao" maxlength="100"></label>' +
      '<label>Últimos 4 (opcional)<input name="ultimos_4" maxlength="4" pattern="[A-Za-z0-9]{4}"></label>' +
      '<label>Saldo inicial<input name="saldo_inicial" type="number" step="0.01" value="0" required></label>' +
      '<label>Data do saldo<input name="data_saldo_inicial" type="date" value="' + today() + '" required></label>' +
      '<div class="gestao-form-acoes"><button type="submit">Salvar conta</button><button type="reset">Limpar</button></div></form></details>';
  }

  function settlementForm() {
    const accounts = state.cashAccounts.filter(function (item) { return !item.archived_at; }).map(function (item) {
      return '<option value="' + escapeHtml(item.id) + '">' + escapeHtml(item.name) + '</option>';
    }).join('');
    const payments = state.payments.filter(function (item) { return Number(item.pending_gross) > 0; }).map(function (item) {
      return '<option value="' + escapeHtml(item.payment_id) + '" data-pending="' + escapeHtml(item.pending_gross) + '" data-type="' + escapeHtml(item.entry_type) + '">' +
        escapeHtml(date(item.paid_at) + ' · ' + money(item.pending_gross) + ' · ' + item.entry_type) + '</option>';
    }).join('');
    return '<details class="gestao-editor"><summary>Registrar liquidação</summary><form id="gestao-form-liquidacao" class="gestao-form">' +
      '<label>Conta<select name="conta_id" required><option value="">Selecione</option>' + accounts + '</select></label>' +
      '<label>Pagamento<select name="pagamento_id" required><option value="">Selecione</option>' + payments + '</select></label>' +
      '<label>Valor bruto<input name="valor_bruto" type="number" step="0.01" min="0.01" required></label>' +
      '<label>Taxa<input name="taxa" type="number" step="0.01" min="0" value="0" required></label>' +
      '<label>Valor líquido<input name="valor_liquido" type="number" step="0.01" min="0" required></label>' +
      '<label>Liquidado em<input name="liquidado_em" type="datetime-local" value="' + localDateTime() + '" required></label>' +
      '<label>Referência curta<input name="referencia" maxlength="80" placeholder="Nunca informe conta ou cartão completo"></label>' +
      '<div class="gestao-form-acoes"><button type="submit">Confirmar com senha</button></div></form></details>';
  }

  function reconciliationForm() {
    const accounts = state.cashAccounts.filter(function (item) { return !item.archived_at; }).map(function (item) {
      return '<option value="' + escapeHtml(item.id) + '">' + escapeHtml(item.name) + '</option>';
    }).join('');
    return '<details class="gestao-editor"><summary>Nova conciliação</summary><form id="gestao-form-conciliacao" class="gestao-form">' +
      '<label>Conta<select name="conta_id" required><option value="">Selecione</option>' + accounts + '</select></label>' +
      '<label>Início<input name="periodo_inicio" type="date" value="' + monthStart() + '" required></label>' +
      '<label>Fim<input name="periodo_fim" type="date" value="' + today() + '" required></label>' +
      '<label>Saldo externo confirmado<input name="saldo_externo" type="number" step="0.01" required></label>' +
      '<label class="gestao-form-largo">Referência da evidência<input name="evidencia" maxlength="300" required placeholder="Ex.: extrato conferido em DD/MM/AAAA"></label>' +
      '<label class="gestao-form-largo">Observações<textarea name="observacoes" maxlength="800"></textarea></label>' +
      '<div class="gestao-form-acoes"><button type="submit">Conciliar com senha</button></div></form></details>';
  }

  function renderTreasury() {
    const cashRows = state.cashAccounts.map(function (item) {
      return '<tr><td>' + escapeHtml(item.name) + '</td><td>' + escapeHtml(item.account_type) + '</td><td>' +
        escapeHtml(item.identifier_last4 ? '•••• ' + item.identifier_last4 : '—') + '</td><td>' + money(item.calculated_balance) +
        '</td><td>' + escapeHtml(item.archived_at ? 'Arquivada' : 'Ativa') + '</td><td class="gestao-acoes">' +
        '<button type="button" data-gestao-editar-conta="' + escapeHtml(item.id) + '">Editar</button>' +
        '<button type="button" data-gestao-arquivar-conta="' + escapeHtml(item.id) + '">' + (item.archived_at ? 'Restaurar' : 'Arquivar') + '</button></td></tr>';
    }).join('');
    const financialRows = state.accounts.map(function (item) {
      return '<tr><td>' + escapeHtml(item.nature) + '</td><td>' + escapeHtml(item.description) + '</td><td>' +
        escapeHtml(date(item.due_date)) + '</td><td>' + money(item.balance) + '</td><td>' + escapeHtml(item.status) + '</td></tr>';
    }).join('');
    const reconciliationRows = state.reconciliations.map(function (item) {
      return '<tr><td>' + escapeHtml(date(item.period_start) + ' a ' + date(item.period_end)) + '</td><td>' +
        money(item.internal_amount) + '</td><td>' + money(item.external_amount) + '</td><td>' + money(item.difference_amount) +
        '</td><td>' + escapeHtml(item.status) + '</td></tr>';
    }).join('');
    const reversed = new Set(state.liquidations.filter(function (item) {
      return item.movement_kind === 'estorno' && item.reversal_of_id;
    }).map(function (item) { return item.reversal_of_id; }));
    const liquidationRows = state.liquidations.map(function (item) {
      const final = item.movement_kind === 'estorno' || reversed.has(item.id);
      return '<tr><td>' + escapeHtml(date(item.settled_at)) + '</td><td>' + escapeHtml(item.movement_kind) +
        '</td><td>' + money(item.gross_amount) + '</td><td>' + money(item.fee_amount) + '</td><td>' +
        money(item.net_amount) + '</td><td>' + (final ? '<span>Histórico final</span>' :
          '<button type="button" data-gestao-estornar-liquidacao="' + escapeHtml(item.id) + '">Estornar com senha</button>') + '</td></tr>';
    }).join('');
    return section('Contas operacionais', 'Somente nome, tipo e últimos quatro opcionais; sem credenciais bancárias.',
      cashAccountForm() + table(['Conta', 'Tipo', 'Identificação', 'Saldo calculado', 'Status', 'Ações'], cashRows)) +
      section('Liquidação e taxas', 'Registre bruto, taxa, líquido e a conta em que o valor entrou ou saiu. Correções são feitas por estorno.',
        settlementForm() + table(['Data', 'Movimento', 'Bruto', 'Taxa', 'Líquido', 'Ação'], liquidationRows)) +
      section('Conciliação', 'O saldo externo é confrontado com o saldo interno; divergências permanecem visíveis.',
        reconciliationForm() + table(['Período', 'Interno', 'Externo', 'Diferença', 'Status'], reconciliationRows)) +
      section('Contas a pagar e receber', 'Derivadas dos lançamentos e parcelas já cadastrados.',
        table(['Natureza', 'Descrição', 'Vencimento', 'Saldo', 'Status'], financialRows));
  }

  function equipmentForm() {
    return '<details class="gestao-editor"><summary>Novo equipamento</summary><form id="gestao-form-equipamento" class="gestao-form">' +
      '<input type="hidden" name="equipamento_id"><input type="hidden" name="versao"><input type="hidden" name="fornecedor_id">' +
      '<label>Código patrimonial<input name="codigo_patrimonio" maxlength="40" required></label>' +
      '<label>Categoria<input name="categoria" maxlength="80" required></label>' +
      '<label>Nome<input name="nome" maxlength="120" required></label><label>Marca<input name="marca" maxlength="80"></label>' +
      '<label>Modelo<input name="modelo" maxlength="100"></label><label>Nº de série<input name="numero_serie" maxlength="100"></label>' +
      '<label>Nº patrimonial<input name="numero_patrimonial" maxlength="80"></label>' +
      '<label>Localização<input name="localizacao" maxlength="120"></label>' +
      '<label>Modalidade de posse<select name="modalidade_posse"><option value="proprio">Próprio</option><option value="locacao">Locação</option><option value="comodato">Comodato</option><option value="leasing">Leasing</option><option value="outro">Outro</option></select></label>' +
      '<label>Criticidade<select name="criticidade"><option value="baixa">Baixa</option><option value="media" selected>Média</option><option value="alta">Alta</option><option value="critica">Crítica</option></select></label>' +
      '<label>Status<select name="status"><option value="em_cadastro">Em cadastro</option><option value="ativo">Ativo</option><option value="disponivel">Disponível</option><option value="em_manutencao">Em manutenção</option><option value="quarentena">Quarentena</option><option value="indisponivel">Indisponível</option></select></label>' +
      '<label>Data de aquisição<input name="data_aquisicao" type="date"></label><label>Custo de aquisição<input name="custo_aquisicao" type="number" min="0" step="0.01"></label>' +
      '<label>Garantia desde<input name="garantia_inicio" type="date"></label><label>Garantia até<input name="garantia_fim" type="date"></label>' +
      '<label>Referência da garantia<input name="referencia_garantia" maxlength="200"></label><label>Referência do manual<input name="referencia_manual" maxlength="300"></label>' +
      '<label>Responsável pelo ativo<input name="responsavel" maxlength="120"></label>' +
      '<label class="gestao-form-largo">Fonte técnica<input name="fonte_tecnica" maxlength="300" placeholder="Manual/fabricante/assistência; não invente periodicidade"></label>' +
      '<label class="gestao-form-largo">Observações<textarea name="observacoes" maxlength="1000"></textarea></label>' +
      '<div class="gestao-form-acoes"><button type="submit">Salvar equipamento</button><button type="reset">Limpar</button></div></form></details>';
  }

  function maintenanceForm() {
    const equipment = state.equipment.filter(function (item) { return !item.archived_at; }).map(function (item) {
      return '<option value="' + escapeHtml(item.id) + '">' + escapeHtml(item.asset_code + ' · ' + item.name) + '</option>';
    }).join('');
    return '<details class="gestao-editor"><summary>Nova manutenção</summary><form id="gestao-form-manutencao" class="gestao-form">' +
      '<input type="hidden" name="manutencao_id"><input type="hidden" name="versao">' +
      '<label>Equipamento<select name="equipamento_id" required><option value="">Selecione</option>' + equipment + '</select></label>' +
      '<label>Tipo<select name="tipo"><option value="preventiva">Preventiva</option><option value="corretiva">Corretiva</option><option value="inspecao_visual">Inspeção visual</option><option value="verificacao_funcional">Verificação funcional</option><option value="calibracao">Calibração</option><option value="limpeza">Limpeza</option><option value="outro">Outro</option></select></label>' +
      '<label>Status<select name="status"><option value="planejada">Planejada</option><option value="agendada">Agendada</option><option value="em_andamento">Em andamento</option></select></label>' +
      '<label>Agendada para<input name="agendada_para" type="date"></label>' +
      '<label>Iniciada em<input name="iniciada_em" type="datetime-local"></label>' +
      '<label class="gestao-form-largo">Descrição<input name="descricao" maxlength="500" required></label>' +
      '<label class="gestao-form-largo">Sintoma/necessidade<input name="sintoma" maxlength="500"></label>' +
      '<label>Prestador<input name="prestador" maxlength="160"></label><label>Ordem de serviço<input name="ordem_servico" maxlength="120"></label>' +
      '<label>Tipo da fonte<select name="tipo_fonte_tecnica"><option value="pending_validation">Periodicidade a validar</option><option value="official_manual">Manual oficial</option><option value="manufacturer">Fabricante</option><option value="authorized_service">Assistência autorizada</option><option value="contract">Contrato</option><option value="responsible_technical">Responsável técnico</option></select></label>' +
      '<label>Próxima data<input name="proxima_data" type="date"></label>' +
      '<label class="gestao-form-largo">Fonte técnica<input name="fonte_tecnica" maxlength="300"></label>' +
      '<label>Custo<input name="custo" type="number" min="0" step="0.01"></label><label>Minutos indisponível<input name="minutos_indisponivel" type="number" min="0" step="1"></label><label>Evidência<input name="evidencia" maxlength="300"></label>' +
      '<div class="gestao-form-acoes"><button type="submit">Salvar manutenção</button><button type="reset">Limpar</button></div></form></details>';
  }

  function renderAssets() {
    const equipmentRows = state.equipment.map(function (item) {
      return '<tr><td>' + escapeHtml(item.asset_code) + '</td><td>' + escapeHtml(item.name) + '</td><td>' +
        escapeHtml(item.status) + '</td><td>' + escapeHtml(item.criticality) + '</td><td>' + escapeHtml(date(item.warranty_end)) +
        '</td><td class="gestao-acoes"><button type="button" data-gestao-editar-equip="' + escapeHtml(item.id) + '">Editar</button>' +
        '<button type="button" data-gestao-arquivar-equip="' + escapeHtml(item.id) + '">' + (item.archived_at ? 'Restaurar' : 'Arquivar') + '</button></td></tr>';
    }).join('');
    const maintenanceRows = state.maintenance.map(function (item) {
      return '<tr><td>' + escapeHtml(item.maintenance_kind) + '</td><td>' + escapeHtml(item.description) + '</td><td>' +
        escapeHtml(item.status) + '</td><td>' + escapeHtml(date(item.next_due_date)) + '</td><td>' + money(item.cost) +
        '</td><td class="gestao-acoes">' + (['concluida', 'cancelada'].indexOf(item.status) >= 0 ? '<span>Histórico final</span>' :
          '<button type="button" data-gestao-editar-manut="' + escapeHtml(item.id) + '">Editar</button>' +
          '<button type="button" data-gestao-concluir-manut="' + escapeHtml(item.id) + '">Concluir</button>' +
          '<button type="button" data-gestao-cancelar-manut="' + escapeHtml(item.id) + '">Cancelar</button>') + '</td></tr>';
    }).join('');
    return section('Equipamentos', 'Sem exclusão física; arquivamento e mudanças ficam auditados.',
      equipmentForm() + table(['Código', 'Equipamento', 'Status', 'Criticidade', 'Garantia', 'Ações'], equipmentRows)) +
      section('Manutenções', 'Manutenção finalizada é imutável; correções devem gerar novo histórico.',
        maintenanceForm() + table(['Tipo', 'Descrição', 'Status', 'Próxima data', 'Custo', 'Ações'], maintenanceRows));
  }

  function renderClosures() {
    const rows = state.closures.map(function (item) {
      return '<tr><td>' + escapeHtml(item.period_start ? item.period_start.slice(0, 7) : '—') + '</td><td>' + escapeHtml(String(item.version)) +
        '</td><td>' + escapeHtml(item.status) + '</td><td>' + money(item.net_cash_flow) + '</td><td>' + money(item.inventory_value) +
        '</td><td>' + (item.status === 'fechado' ? '<button type="button" data-gestao-reabrir="' + escapeHtml(item.id) + '">Reabrir com senha</button>' : '—') + '</td></tr>';
    }).join('');
    return section('Fechamento mensal', 'Cria snapshot imutável. Todas as contas ativas precisam estar conciliadas.',
      '<form id="gestao-form-fechamento" class="gestao-form gestao-form-inline"><label>Mês<input name="mes" type="month" required></label>' +
      '<button type="submit">Fechar mês com senha</button></form>' +
      table(['Mês', 'Versão', 'Status', 'Fluxo líquido', 'Estoque gerencial', 'Ação'], rows));
  }

  function renderGovernance() {
    const backupRows = state.backups.map(function (item) {
      return '<tr><td>' + escapeHtml(item.event_kind) + '</td><td>' + escapeHtml(item.system_scope) + '</td><td>' +
        escapeHtml(date(item.occurred_at)) + '</td><td>' + escapeHtml(item.result) + '</td><td>' + escapeHtml(item.evidence_reference) + '</td></tr>';
    }).join('');
    const metricRows = state.metrics.map(function (item) {
      return '<tr><td>' + escapeHtml(item.label) + '</td><td>' + escapeHtml(item.formula) + '</td><td>' +
        escapeHtml(item.owner_role) + '</td><td>' + escapeHtml(item.status) + '</td><td>' + escapeHtml(item.limitation) + '</td></tr>';
    }).join('');
    return section('Evidência de backup e restauração', 'Registrar evidência não executa nem valida backup automaticamente.',
      '<details class="gestao-editor"><summary>Registrar evidência</summary><form id="gestao-form-backup" class="gestao-form">' +
      '<label>Tipo<select name="tipo"><option value="backup_executado">Backup executado</option><option value="restauracao_testada">Restauração testada</option><option value="restauracao_falhou">Restauração falhou</option></select></label>' +
      '<label>Escopo<input name="escopo" maxlength="120" required placeholder="Ex.: banco do app Fichas"></label>' +
      '<label>Ocorrido em<input name="ocorrido_em" type="datetime-local" value="' + localDateTime() + '" required></label>' +
      '<label class="gestao-form-largo">Referência da evidência<input name="evidencia" maxlength="300" required></label>' +
      '<label class="gestao-form-largo">Observações<textarea name="observacoes" maxlength="800"></textarea></label>' +
      '<div class="gestao-form-acoes"><button type="submit">Registrar com senha</button></div></form></details>' +
      table(['Evento', 'Escopo', 'Data', 'Resultado', 'Evidência'], backupRows)) +
      section('Dicionário de métricas', 'Cada indicador declara fórmula, dono, status e limitação.',
        table(['Métrica', 'Fórmula', 'Dono', 'Status', 'Limitação'], metricRows));
  }

  function renderTab(tab) {
    if (!state.root) return;
    state.root.querySelectorAll('[data-gestao-tab]').forEach(function (button) {
      button.setAttribute('aria-selected', String(button.dataset.gestaoTab === tab));
    });
    const node = byId('gestao-conteudo');
    if (!node) return;
    node.innerHTML = tab === 'tesouraria' ? renderTreasury()
      : tab === 'ativos' ? renderAssets()
        : tab === 'fechamento' ? renderClosures()
          : tab === 'governanca' ? renderGovernance() : renderOverview();
  }

  async function load() {
    if (!state.root || !ownerAccess() || state.loading) return;
    state.loading = true;
    setBusy(true);
    setStatus('Atualizando indicadores…');
    const start = byId('gestao-inicio').value || monthStart();
    const end = byId('gestao-fim').value || today();
    try {
      const results = await Promise.all([
        call('dashboard', { inicio: start, fim: end }),
        call('listar_contas_financeiras', { inicio: start, fim: end, limite: 200 }),
        call('listar_contas_caixa', { incluir_arquivados: true, limite: 200 }),
        call('listar_pagamentos_liquidacao', { somente_pendentes: true, limite: 200 }),
        call('listar_liquidacoes', { limite: 200 }),
        call('listar_conciliacoes', { limite: 200 }),
        call('listar_equipamentos', { incluir_arquivados: true, limite: 200 }),
        call('listar_manutencoes', { limite: 200 }),
        call('listar_fechamentos', { limite: 100 }),
        call('listar_alertas', { limite: 200 }),
        call('listar_evidencias_backup', { limite: 100 }),
        call('listar_catalogo_metricas', {})
      ]);
      state.dashboard = results[0].dashboard || {};
      state.accounts = results[1].contas || [];
      state.cashAccounts = results[2].contas_caixa || [];
      state.payments = results[3].pagamentos || [];
      state.liquidations = results[4].liquidacoes || [];
      state.reconciliations = results[5].conciliacoes || [];
      state.equipment = results[6].equipamentos || [];
      state.maintenance = results[7].manutencoes || [];
      state.closures = results[8].fechamentos || [];
      state.alerts = results[9].alertas || [];
      state.backups = results[10].evidencias || [];
      state.sources = results[11].fontes || [];
      state.metrics = results[11].metricas || [];
      state.loaded = true;
      renderKpis();
      const selected = state.root.querySelector('[data-gestao-tab][aria-selected="true"]');
      renderTab(selected ? selected.dataset.gestaoTab : 'visao');
      setStatus('Atualizado agora.');
    } catch (error) {
      setStatus(error.message || 'Não foi possível carregar a gestão.', true);
    } finally {
      state.loading = false;
      setBusy(false);
    }
  }

  function proofOptions(title, explanation, reason) {
    return {
      titulo: title,
      explicacao: explanation,
      motivoPadrao: reason,
      motivoObrigatorio: true
    };
  }

  async function runMutation(action, payload, options) {
    if (state.loading) return;
    state.loading = true;
    setBusy(true);
    setStatus('Salvando com auditoria…');
    try {
      const result = options && options.protected
        ? await protectedCall(action, payload, proofOptions(options.title, options.explanation, options.reason))
        : await call(action, payload);
      setStatus(options && options.success ? options.success : 'Registro salvo.');
      state.loading = false;
      setBusy(false);
      await load();
      return result;
    } catch (error) {
      setStatus(error.message || 'Não foi possível concluir a operação.', true);
      return null;
    } finally {
      state.loading = false;
      setBusy(false);
    }
  }

  function optionalValue(value) { return value === '' ? null : value; }
  function accountPayload(data) {
    return {
      nome: data.nome,
      tipo: data.tipo,
      instituicao: optionalValue(data.instituicao),
      ultimos_4: optionalValue(data.ultimos_4),
      saldo_inicial: Number(data.saldo_inicial),
      data_saldo_inicial: data.data_saldo_inicial
    };
  }
  function equipmentPayload(data) {
    return {
      codigo_patrimonio: data.codigo_patrimonio,
      categoria: data.categoria,
      nome: data.nome,
      marca: optionalValue(data.marca),
      modelo: optionalValue(data.modelo),
      numero_serie: optionalValue(data.numero_serie),
      numero_patrimonial: optionalValue(data.numero_patrimonial),
      localizacao: optionalValue(data.localizacao),
      modalidade_posse: data.modalidade_posse || 'proprio',
      fornecedor_id: optionalValue(data.fornecedor_id),
      criticidade: data.criticidade,
      status: data.status,
      data_aquisicao: optionalValue(data.data_aquisicao),
      custo_aquisicao: optionalValue(data.custo_aquisicao),
      garantia_inicio: optionalValue(data.garantia_inicio),
      garantia_fim: optionalValue(data.garantia_fim),
      referencia_garantia: optionalValue(data.referencia_garantia),
      referencia_manual: optionalValue(data.referencia_manual),
      fonte_tecnica: optionalValue(data.fonte_tecnica),
      responsavel: optionalValue(data.responsavel),
      observacoes: optionalValue(data.observacoes)
    };
  }
  function maintenancePayload(data) {
    return {
      equipamento_id: data.equipamento_id,
      tipo: data.tipo,
      status: data.status,
      agendada_para: optionalValue(data.agendada_para),
      iniciada_em: optionalValue(data.iniciada_em),
      descricao: data.descricao,
      sintoma: optionalValue(data.sintoma),
      prestador: optionalValue(data.prestador),
      ordem_servico: optionalValue(data.ordem_servico),
      tipo_fonte_tecnica: data.tipo_fonte_tecnica,
      proxima_data: optionalValue(data.proxima_data),
      fonte_tecnica: optionalValue(data.fonte_tecnica),
      custo: optionalValue(data.custo),
      minutos_indisponivel: optionalValue(data.minutos_indisponivel),
      evidencia: optionalValue(data.evidencia)
    };
  }

  async function submitForm(form) {
    const data = formObject(form);
    switch (form.id) {
      case 'gestao-form-conta': {
        const editing = Boolean(data.conta_id);
        const payload = accountPayload(data);
        payload.conta_id = editing ? data.conta_id : uuid();
        if (editing) payload.versao = Number(data.versao);
        else payload.idempotency_key = uuid();
        await runMutation(editing ? 'editar_conta_caixa' : 'criar_conta_caixa', payload, editing ? {
          protected: true,
          title: 'Confirmar edição da conta',
          explanation: 'A alteração ficará versionada e auditada.',
          reason: 'Atualização da conta operacional',
          success: 'Conta operacional atualizada.'
        } : { success: 'Conta operacional criada.' });
        break;
      }
      case 'gestao-form-liquidacao': {
        const payload = {
          conta_id: data.conta_id, pagamento_id: data.pagamento_id,
          valor_bruto: Number(data.valor_bruto), taxa: Number(data.taxa),
          valor_liquido: Number(data.valor_liquido), liquidado_em: data.liquidado_em,
          referencia: optionalValue(data.referencia)
        };
        const intentId = intentIdForForm(form, payload);
        payload.liquidacao_id = intentId;
        const result = await runMutation('registrar_liquidacao', payload, {
          protected: true,
          title: 'Confirmar liquidação',
          explanation: 'O evento financeiro será append-only. Um erro deverá ser corrigido por estorno.',
          reason: 'Registro de liquidação financeira',
          success: 'Liquidação registrada.'
        });
        if (result !== null) confirmFormIntent(form, intentId);
        break;
      }
      case 'gestao-form-conciliacao':
      {
        const payload = {
          conta_id: data.conta_id, periodo_inicio: data.periodo_inicio,
          periodo_fim: data.periodo_fim, saldo_externo: Number(data.saldo_externo),
          evidencia: data.evidencia, observacoes: optionalValue(data.observacoes)
        };
        const intentId = intentIdForForm(form, payload);
        payload.conciliacao_id = intentId;
        const result = await runMutation('registrar_conciliacao', payload, {
          protected: true,
          title: 'Confirmar conciliação',
          explanation: 'O saldo informado será comparado ao saldo interno e qualquer diferença permanecerá visível.',
          reason: 'Conciliação da conta operacional',
          success: 'Conciliação registrada.'
        });
        if (result !== null) confirmFormIntent(form, intentId);
        break;
      }
      case 'gestao-form-equipamento': {
        const editing = Boolean(data.equipamento_id);
        const payload = equipmentPayload(data);
        payload.equipamento_id = editing ? data.equipamento_id : uuid();
        if (editing) payload.versao = Number(data.versao);
        else payload.idempotency_key = uuid();
        await runMutation(editing ? 'editar_equipamento' : 'criar_equipamento', payload, editing ? {
          protected: true,
          title: 'Confirmar edição do equipamento',
          explanation: 'A versão anterior continuará rastreável na auditoria.',
          reason: 'Atualização do cadastro do equipamento',
          success: 'Equipamento atualizado.'
        } : { success: 'Equipamento criado.' });
        break;
      }
      case 'gestao-form-manutencao': {
        const editing = Boolean(data.manutencao_id);
        const payload = maintenancePayload(data);
        const intentId = editing ? null : intentIdForForm(form, payload);
        payload.manutencao_id = editing ? data.manutencao_id : intentId;
        if (editing) payload.versao = Number(data.versao);
        else payload.idempotency_key = intentId;
        const result = await runMutation(editing ? 'editar_manutencao' : 'criar_manutencao', payload, editing ? {
          protected: true,
          title: 'Confirmar edição da manutenção',
          explanation: 'Somente manutenções abertas podem ser editadas.',
          reason: 'Atualização do planejamento de manutenção',
          success: 'Manutenção atualizada.'
        } : { success: 'Manutenção criada.' });
        if (!editing && result !== null) confirmFormIntent(form, intentId);
        break;
      }
      case 'gestao-form-fechamento': {
        if (!/^\d{4}-\d{2}$/.test(data.mes)) throw new Error('Selecione o mês do fechamento.');
        await runMutation('fechar_mes', { fechamento_id: uuid(), mes: data.mes + '-01' }, {
          protected: true,
          title: 'Fechar o mês ' + data.mes,
          explanation: 'O fechamento cria um snapshot imutável e bloqueia alterações no período. Todas as contas ativas devem estar conciliadas.',
          reason: 'Fechamento mensal após conciliação',
          success: 'Mês fechado com snapshot imutável.'
        });
        break;
      }
      case 'gestao-form-backup': {
        const payload = {
          tipo: data.tipo, escopo: data.escopo,
          ocorrido_em: data.ocorrido_em, evidencia: data.evidencia,
          observacoes: optionalValue(data.observacoes)
        };
        const intentId = intentIdForForm(form, payload);
        payload.evidencia_id = intentId;
        const result = await runMutation('registrar_evidencia_backup', payload, {
          protected: true,
          title: 'Registrar evidência operacional',
          explanation: 'Este registro não executa backup nem prova restauração por si só. Informe apenas evidência realmente verificada.',
          reason: 'Registro manual de evidência de backup ou restauração',
          success: 'Evidência registrada sem declarar automação.'
        });
        if (result !== null) confirmFormIntent(form, intentId);
        break;
      }
      default:
        return;
    }
  }

  function setFormValue(form, name, value) {
    if (form && form.elements[name]) form.elements[name].value = value == null ? '' : value;
  }
  function openEditor(form) {
    const details = form && form.closest('details');
    if (details) details.open = true;
    if (form) form.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  function editAccount(id) {
    const item = state.cashAccounts.find(function (row) { return row.id === id; });
    const form = byId('gestao-form-conta');
    if (!item || !form) return;
    setFormValue(form, 'conta_id', item.id); setFormValue(form, 'versao', item.version);
    setFormValue(form, 'nome', item.name); setFormValue(form, 'tipo', item.account_type);
    setFormValue(form, 'instituicao', item.institution_label); setFormValue(form, 'ultimos_4', item.identifier_last4);
    setFormValue(form, 'saldo_inicial', item.opening_balance); setFormValue(form, 'data_saldo_inicial', item.opening_balance_date);
    openEditor(form);
  }
  function editEquipment(id) {
    const item = state.equipment.find(function (row) { return row.id === id; });
    const form = byId('gestao-form-equipamento');
    if (!item || !form) return;
    const fields = {
      equipamento_id: item.id, versao: item.version, codigo_patrimonio: item.asset_code,
      categoria: item.category, nome: item.name, marca: item.brand, modelo: item.model,
      numero_serie: item.serial_number, numero_patrimonial: item.patrimonial_number,
      localizacao: item.location, modalidade_posse: item.possession_mode, fornecedor_id: item.supplier_id,
      criticidade: item.criticality,
      status: item.status, data_aquisicao: item.acquisition_date, custo_aquisicao: item.acquisition_cost,
      garantia_inicio: item.warranty_start, garantia_fim: item.warranty_end,
      referencia_garantia: item.warranty_reference, referencia_manual: item.manual_reference,
      fonte_tecnica: item.technical_source_reference, responsavel: item.responsible_label,
      observacoes: item.notes
    };
    Object.keys(fields).forEach(function (key) { setFormValue(form, key, fields[key]); });
    openEditor(form);
  }
  function editMaintenance(id) {
    const item = state.maintenance.find(function (row) { return row.id === id; });
    const form = byId('gestao-form-manutencao');
    if (!item || !form) return;
    const fields = {
      manutencao_id: item.id, versao: item.version, equipamento_id: item.equipment_id,
      tipo: item.maintenance_kind, status: item.status, agendada_para: item.scheduled_for,
      iniciada_em: item.started_at ? clinicDateTimeValue(item.started_at) : '',
      descricao: item.description, sintoma: item.symptom, prestador: item.service_provider,
      ordem_servico: item.service_order_reference, tipo_fonte_tecnica: item.technical_source_type,
      proxima_data: item.next_due_date, fonte_tecnica: item.technical_source_reference,
      custo: item.cost, minutos_indisponivel: item.downtime_minutes, evidencia: item.evidence_reference
    };
    Object.keys(fields).forEach(function (key) { setFormValue(form, key, fields[key]); });
    openEditor(form);
  }

  async function clickAction(button) {
    const accountId = button.dataset.gestaoEditarConta;
    if (accountId) { editAccount(accountId); return; }
    const accountArchiveId = button.dataset.gestaoArquivarConta;
    if (accountArchiveId) {
      const item = state.cashAccounts.find(function (row) { return row.id === accountArchiveId; });
      if (!item) return;
      const restoring = Boolean(item.archived_at);
      await runMutation(restoring ? 'restaurar_conta_caixa' : 'arquivar_conta_caixa', {
        conta_id: item.id, versao: item.version
      }, {
        protected: true,
        title: restoring ? 'Restaurar conta operacional' : 'Arquivar conta operacional',
        explanation: restoring ? 'A conta voltará aos registros ativos.' : 'A conta sairá da seleção ativa, sem apagar histórico.',
        reason: (restoring ? 'Restauração' : 'Arquivamento') + ' da conta operacional',
        success: restoring ? 'Conta restaurada.' : 'Conta arquivada.'
      });
      return;
    }
    const equipmentId = button.dataset.gestaoEditarEquip;
    if (equipmentId) { editEquipment(equipmentId); return; }
    const equipmentArchiveId = button.dataset.gestaoArquivarEquip;
    if (equipmentArchiveId) {
      const item = state.equipment.find(function (row) { return row.id === equipmentArchiveId; });
      if (!item) return;
      const restoring = Boolean(item.archived_at);
      await runMutation(restoring ? 'restaurar_equipamento' : 'arquivar_equipamento', {
        equipamento_id: item.id, versao: item.version
      }, {
        protected: true,
        title: restoring ? 'Restaurar equipamento' : 'Arquivar equipamento',
        explanation: 'O histórico patrimonial e as manutenções permanecerão preservados.',
        reason: (restoring ? 'Restauração' : 'Arquivamento') + ' do equipamento',
        success: restoring ? 'Equipamento restaurado.' : 'Equipamento arquivado.'
      });
      return;
    }
    const maintenanceEditId = button.dataset.gestaoEditarManut;
    if (maintenanceEditId) { editMaintenance(maintenanceEditId); return; }
    const maintenanceCompleteId = button.dataset.gestaoConcluirManut;
    if (maintenanceCompleteId) {
      const item = state.maintenance.find(function (row) { return row.id === maintenanceCompleteId; });
      if (!item) return;
      const result = window.prompt('Descreva o resultado da manutenção:', item.description || 'Manutenção concluída');
      if (!result) return;
      await runMutation('concluir_manutencao', {
        manutencao_id: item.id, versao: item.version, concluida_em: new Date().toISOString(),
        resultado: result, custo: item.cost, minutos_indisponivel: item.downtime_minutes,
        proxima_data: item.next_due_date, tipo_fonte_tecnica: item.technical_source_type || 'pending_validation',
        fonte_tecnica: item.technical_source_reference, evidencia: item.evidence_reference
      }, {
        protected: true,
        title: 'Concluir manutenção',
        explanation: 'Após concluída, a manutenção vira histórico imutável.',
        reason: 'Conclusão da manutenção com resultado registrado',
        success: 'Manutenção concluída.'
      });
      return;
    }
    const liquidationId = button.dataset.gestaoEstornarLiquidacao;
    if (liquidationId) {
      const item = state.liquidations.find(function (row) { return row.id === liquidationId; });
      if (!item || item.movement_kind !== 'liquidacao') return;
      await runMutation('estornar_liquidacao', {
        liquidacao_id: item.id, estorno_id: uuid(), liquidado_em: new Date().toISOString()
      }, {
        protected: true,
        title: 'Estornar liquidação',
        explanation: 'A liquidação original não será apagada. Um evento inverso ficará registrado na trilha financeira.',
        reason: 'Correção de liquidação por estorno integral',
        success: 'Liquidação estornada com histórico preservado.'
      });
      return;
    }
    const maintenanceCancelId = button.dataset.gestaoCancelarManut;
    if (maintenanceCancelId) {
      const item = state.maintenance.find(function (row) { return row.id === maintenanceCancelId; });
      if (!item) return;
      await runMutation('cancelar_manutencao', { manutencao_id: item.id, versao: item.version }, {
        protected: true,
        title: 'Cancelar manutenção',
        explanation: 'O cancelamento será final e permanecerá no histórico.',
        reason: 'Cancelamento da manutenção pela gestão',
        success: 'Manutenção cancelada.'
      });
      return;
    }
    const closureId = button.dataset.gestaoReabrir;
    if (closureId) {
      await runMutation('reabrir_mes', { fechamento_id: closureId }, {
        protected: true,
        title: 'Reabrir período fechado',
        explanation: 'A reabertura não apaga o snapshot; cria um evento auditável e uma nova versão será necessária no próximo fechamento.',
        reason: 'Reabertura excepcional do período para correção',
        success: 'Período reaberto com auditoria.'
      });
    }
  }

  function syncSettlement(form) {
    if (!form) return;
    const payment = form.elements.pagamento_id;
    const option = payment && payment.options[payment.selectedIndex];
    if (option && option.dataset.pending && !form.elements.valor_bruto.value) {
      form.elements.valor_bruto.value = Number(option.dataset.pending).toFixed(2);
    }
    const gross = Number(form.elements.valor_bruto.value);
    const fee = Number(form.elements.taxa.value || 0);
    if (!Number.isFinite(gross) || !Number.isFinite(fee)) return;
    form.elements.valor_liquido.value = (option && option.dataset.type === 'despesa' ? gross + fee : gross - fee).toFixed(2);
  }

  function bind() {
    if (!state.root || state.root.dataset.gestaoBound === 'true') return;
    state.root.dataset.gestaoBound = 'true';
    state.root.addEventListener('click', function (event) {
      const tab = event.target.closest('[data-gestao-tab]');
      if (tab) { renderTab(tab.dataset.gestaoTab); return; }
      if (event.target.closest('[data-gestao-recarregar]')) { load(); return; }
      const action = event.target.closest('[data-gestao-editar-conta],[data-gestao-arquivar-conta],[data-gestao-estornar-liquidacao],[data-gestao-editar-equip],[data-gestao-arquivar-equip],[data-gestao-editar-manut],[data-gestao-concluir-manut],[data-gestao-cancelar-manut],[data-gestao-reabrir]');
      if (action) clickAction(action);
    });
    state.root.addEventListener('submit', function (event) {
      if (!event.target.closest('.gestao-form')) return;
      event.preventDefault();
      submitForm(event.target).catch(function (error) { setStatus(error.message || 'Confira os dados informados.', true); });
    });
    state.root.addEventListener('reset', function (event) {
      if (event.target && event.target.matches('.gestao-form')) formIntentKeys.delete(event.target);
    });
    state.root.addEventListener('input', function (event) {
      const form = event.target.closest('#gestao-form-liquidacao');
      if (form && ['pagamento_id', 'valor_bruto', 'taxa'].indexOf(event.target.name) >= 0) syncSettlement(form);
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
    if (ownerAccess() && !state.loaded) load();
  }
  function updateAccess() {
    if (!state.root) return;
    const allowed = ownerAccess();
    state.root.hidden = !allowed;
    if (allowed && !state.loaded && !state.loading) load();
    if (!allowed) setStatus('Entre com uma conta proprietária individual e confirme o autenticador.', true);
  }
  function reset() {
    state.generation += 1;
    state.controllers.forEach(function (controller) { controller.abort(); });
    state.controllers.clear();
    state.loaded = false;
    state.loading = false;
    state.dashboard = {};
    state.accounts = [];
    state.cashAccounts = [];
    state.payments = [];
    state.liquidations = [];
    state.reconciliations = [];
    state.equipment = [];
    state.maintenance = [];
    state.closures = [];
    state.alerts = [];
    state.backups = [];
    state.sources = [];
    state.metrics = [];
    if (state.root) {
      state.root.innerHTML = shell();
      delete state.root.dataset.gestaoBound;
      bind();
      updateAccess();
    }
  }

  const publicApi = {
    montar: mount,
    ativar: activate,
    carregar: load,
    atualizarAcesso: updateAccess,
    reset: reset,
    contrato: Object.freeze({ endpoint: API, exigeOwner: true, exigeAal2: true, exclusaoFisica: false })
  };
  if (window.__AMJ_TEST__) {
    publicApi.__test = {
      intentIdForForm: intentIdForForm,
      confirmFormIntent: confirmFormIntent
    };
  }
  window.AMJGestaoAdministrativa = Object.freeze(publicApi);
  document.addEventListener('DOMContentLoaded', function () {
    const root = document.getElementById('gestao-administrativa-root');
    if (root) mount(root);
  }, { once: true });
})();

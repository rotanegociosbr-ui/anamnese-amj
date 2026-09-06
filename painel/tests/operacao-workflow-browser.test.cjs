'use strict';
// Real application DOM, synthetic clinic/session, and intercepted local assets.
// Every external request is blocked or fulfilled in memory; no real data is read.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE ||
  'C:/Users/NERI/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');

const root = fs.realpathSync(path.resolve(__dirname, '../..'));
const origin = 'https://127.0.0.1:8768';
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'amj-operacao-workflow-'));
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ttf': 'font/ttf', '.woff2': 'font/woff2' };
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ids = { patientA: id(1), patientB: id(2), member: id(3), visitA: id(11), visitB: id(12),
  protocolA: id(21), protocolB: id(22), protocolOtherA: id(23), appointmentA: id(31),
  appointmentB: id(32), entryA: id(41), entryB: id(42), entryOtherA: id(43),
  archivedVisit: id(13), archivedProtocol: id(24) };
const dateEdit = '2026-09-03T09:35';
const readActions = new Set(['listar', 'listar_clientes', 'listar_catalogos', 'listar_estoque', 'listar_fotos', 'painel']);
const writeCalls = calls => calls.filter(call => !readActions.has(call.acao));

function fixture() {
  const data = Object.fromEntries([
    'clientes', 'atendimentos', 'procedimentos_atendimento', 'perfis_operacionais',
    'preferencias_contato', 'recomendacoes_retorno', 'fila_retorno', 'tentativas_retorno',
    'fichas_custo', 'itens_ficha_custo', 'rentabilidade_atendimentos', 'rentabilidade_mensal',
    'resumo_retornos', 'produtos', 'estoque_lotes', 'protocolos', 'lancamentos_receita',
    'pagamentos', 'taxas_pagamento', 'fotos_atendimento', 'indice_fotos_atendimento',
    'resumos_prontuario_atendimento', 'eventos_consumo', 'responsaveis', 'vinculos_agenda',
    'agendamentos'
  ].map(key => [key, []]));
  data.ok = true;
  data.clientes = [
    { id: ids.patientA, full_name: 'Paciente sintética A', status: 'active', archived_at: null },
    { id: ids.patientB, full_name: 'Paciente sintética B', status: 'active', archived_at: null }
  ];
  data.responsaveis = [{ user_id: ids.member, display_name: 'Responsável fixture', status: 'active' }];
  data.atendimentos = ['A', 'B'].map((letter, i) => ({
    id: ids['visit' + letter], patient_id: ids['patient' + letter], version: i + 3,
    procedure_kind: 'Procedimento sintético ' + letter, attended_at: `2026-09-0${i + 1}T13:00:00Z`,
    duration_minutes: 40 + i * 10, responsible_user_id: ids.member, status: 'realizado',
    appointment_id: ids['appointment' + letter], protocol_id: ids['protocol' + letter],
    financial_entry_id: ids['entry' + letter], archived_at: null
  }));
  data.atendimentos.push({ ...data.atendimentos[0], id: ids.archivedVisit, version: 9,
    procedure_kind: 'Procedimento arquivado fixture', protocol_id: ids.archivedProtocol,
    appointment_id: null, financial_entry_id: null, archived_at: '2026-09-02T13:00:00Z' });
  data.protocolos = [
    { id: ids.protocolA, patient_id: ids.patientA, appointment_id: ids.appointmentA,
      procedure_kind: 'toxina_botulinica', procedure_date: '2026-09-01', status: 'draft',
      archived_at: '2026-09-02T13:00:00Z', version: 7 },
    { id: ids.protocolB, patient_id: ids.patientB, appointment_id: ids.appointmentB,
      procedure_kind: 'bioestimulador', procedure_date: '2026-09-02', status: 'draft',
      archived_at: null, version: 8 },
    { id: ids.protocolOtherA, patient_id: ids.patientA, appointment_id: null,
      procedure_kind: 'preenchimento', procedure_date: '2026-09-04', status: 'draft',
      archived_at: null, version: 1 },
    { id: ids.archivedProtocol, patient_id: ids.patientA, appointment_id: null,
      procedure_kind: 'toxina_botulinica', procedure_date: '2026-09-01', status: 'signed',
      archived_at: '2026-09-02T13:00:00Z', version: 9 }
  ];
  data.agendamentos = ['A', 'B'].map(letter => ({ id: ids['appointment' + letter],
    categoria: 'procedimento', procedimento: 'Agenda sintética ' + letter,
    inicio_em: '2026-09-01T13:00:00Z', fim_em: '2026-09-01T14:00:00Z',
    status: 'confirmado', retorno_de_id: null }));
  data.vinculos_agenda = ['A', 'B'].map(letter => ({ source_id: ids['appointment' + letter],
    patient_id: ids['patient' + letter], status: 'confirmado' }));
  data.lancamentos_receita = [
    { id: ids.entryA, patient_id: ids.patientA, state: 'cancelado', description: 'Cobrança histórica A', total_amount: 100 },
    { id: ids.entryB, patient_id: ids.patientB, state: 'ativo', description: 'Cobrança B', total_amount: 200 },
    { id: ids.entryOtherA, patient_id: ids.patientA, state: 'ativo', description: 'Outra cobrança A', total_amount: 50 }
  ].map(row => ({ ...row, entry_type: 'receita', origin: 'atendimento', competence_date: '2026-09-01' }));
  const protocols = data.protocolos.map(p => ({ ...p, professional_id: ids.member,
    complaint: 'Queixa apenas sintética', anamnesis: {}, technique_notes: 'Anotação histórica ' + p.id,
    care_notes: 'Orientação fixture', return_date: null, draft_products: [], produtos_rascunho: [],
    paciente: { id: p.patient_id, nome: data.clientes.find(c => c.id === p.patient_id).full_name,
      status: 'active', arquivado_em: null },
    produtos: [], fotos: [], fotos_resumo: { total: 0, ativas: 0, arquivadas: 0, produtos_utilizados: 0 },
    consentimentos_atuais: { data_processing: true, clinical_photography: false }, consentimentos: [],
    archive_reason: p.archived_at ? 'Arquivamento fixture' : null,
    archived_by: p.archived_at ? ids.member : null,
    created_at: '2026-09-01T13:00:00Z', updated_at: '2026-09-02T13:00:00Z'
  }));
  return { data, protocols };
}

let browser;
before(async () => {
  const executablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH ||
    (fs.existsSync(chromium.executablePath()) ? chromium.executablePath() :
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe');
  browser = await chromium.launch({ headless: true, executablePath,
    args: ['--disable-background-networking', '--disable-component-update', '--disable-default-apps'] });
  console.log('Operation workflow evidence: ' + output);
});
after(async () => { await browser?.close(); });

for (const mobile of [false, true]) test(
  'one consultation context, preserved edits and read-only archived photos — ' + (mobile ? 'mobile' : 'desktop'),
  { timeout: 60000 }, async () => {
    const context = await browser.newContext({
      viewport: mobile ? { width: 390, height: 844 } : { width: 1365, height: 1000 },
      isMobile: mobile, hasTouch: mobile, serviceWorkers: 'block', locale: 'pt-BR',
      timezoneId: 'America/Sao_Paulo'
    });
    const page = await context.newPage();
    const calls = [], errors = [], blocked = [], unexpected = [];
    const { data, protocols } = fixture();
    page.setDefaultTimeout(7000);
    page.on('pageerror', error => errors.push(error.message));
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.hostname === 'rjxtxoqprnumouqakxbc.supabase.co' && url.pathname.startsWith('/functions/v1/')) {
        const body = route.request().postDataJSON() || {};
        calls.push({ ...body, endpoint: url.pathname });
        let result;
        if (body.acao === 'painel' && url.pathname.endsWith('/ia-copiloto-fichas')) result = { ok: true };
        else if (body.acao === 'listar' && url.pathname.endsWith('/operacao-clinica-fichas')) result = data;
        else if (body.acao === 'salvar_atendimento' && url.pathname.endsWith('/operacao-clinica-fichas')) {
          const visit = data.atendimentos.find(v => v.id === body.atendimento_id);
          if (visit) Object.assign(visit, { version: visit.version + 1, attended_at: body.realizado_em,
            duration_minutes: body.duracao_minutos, appointment_id: body.agendamento_id,
            protocol_id: body.protocolo_id, financial_entry_id: body.lancamento_financeiro_id });
          result = { ok: true, resultado: { id: visit?.id, version: visit?.version } };
        } else if (body.acao === 'listar_clientes') result = { clientes: data.clientes.map(p => ({
          id: p.id, nome: p.full_name, ativo: true, status: 'active', archived_at: null })) };
        else if (body.acao === 'listar_catalogos') result = { produtos: [], produtos_rascunho: [], marcas: [], fornecedores: [] };
        else if (body.acao === 'listar_estoque') result = { estoque: [] };
        else if (body.acao === 'listar' && url.pathname.endsWith('/prontuario-fichas')) result = {
          ok: true, protocolos: protocols, paginacao: { pagina: 1, por_pagina: 100, tem_mais: false } };
        else if (body.acao === 'listar_fotos') result = { ok: true, fotos: [], paginacao: { pagina: 1, tem_mais: false } };
        else { unexpected.push({ endpoint: url.pathname, acao: body.acao }); result = { ok: false, erro: 'Not allowed by synthetic fixture' }; }
        await route.fulfill({ status: result.ok === false ? 422 : 200, json: result });
        return;
      }
      if (url.origin !== origin) { blocked.push(url.origin); await route.abort('blockedbyclient'); return; }
      const file = path.resolve(root, decodeURIComponent(url.pathname).replace(/^\/+/, ''));
      const type = types[path.extname(file)];
      if (!file.startsWith(root + path.sep) || !type || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
        await route.fulfill({ status: 404, body: 'Fixture only' }); return;
      }
      await route.fulfill({ contentType: type, body: fs.readFileSync(file) });
    });
    const form = page.locator('[data-form-atendimento]');
    const field = name => form.locator('[name="' + name + '"]');
    const photoSelect = page.locator('[data-fotos-atalho-atendimento]');
    const formSnapshot = () => form.evaluate(node => Object.fromEntries(
      [...node.elements].filter(e => e.name).map(e => [e.name, e.value])));
    const edit = async visitId => {
      const card = page.locator('[data-atendimento-card="' + visitId + '"]');
      if (!(await card.evaluate(node => node.open))) await card.locator(':scope > summary').click();
      await card.locator('[data-atendimento-editar="' + visitId + '"]').click();
      await page.waitForFunction(id => document.querySelector('[data-form-atendimento] [name="atendimento_id"]').value === id, visitId);
    };
    const changePhotoSelection = async (visitId, accept) => {
      const dialog = page.waitForEvent('dialog');
      const selected = photoSelect.selectOption(visitId);
      const confirmation = await dialog;
      assert.equal(confirmation.type(), 'confirm');
      assert.match(confirmation.message(), /alter|salv|descart|trocar/i);
      await (accept ? confirmation.accept() : confirmation.dismiss());
      await selected;
    };
    try {
      await page.goto(origin + '/painel/index.html', { waitUntil: 'load' });
      await page.waitForFunction(() => window.AMJProntuario && window.AMJShell &&
        typeof authInicioConcluido !== 'undefined' && authInicioConcluido);
      await page.evaluate(() => {
        modoAcesso = 'auth'; identidadeBackend = { role: 'owner' };
        cabecalhosAcesso = async () => ({ 'Content-Type': 'application/json' });
        window.__fixtureConfirmations = [];
        window.AMJProtecao = {
          solicitarSenhaRecente: async options => {
            window.__fixtureConfirmations.push(options);
            return { operation_id: crypto.randomUUID(), motivo: 'Edição sintética confirmada', encerrar: async () => {} };
          }
        };
        document.querySelector('#tela-login').classList.add('oculto');
        document.querySelector('#tela-login').hidden = true;
        document.querySelector('#tela-lista').classList.remove('oculto');
        document.querySelector('#tela-lista').hidden = false;
        AMJProntuario.atualizarAcesso();
      });
      await page.waitForFunction(() => document.body.classList.contains('app-shell-authenticated'));
      if (mobile) await page.locator('.app-shell-menu-button').click();
      await page.locator('[data-shell-route="procedimentos"]:visible').first().click();
      await page.waitForFunction(() => AMJShell.currentRoute() === 'procedimentos' &&
        document.querySelectorAll('[data-atendimento-card]').length === 3);
      assert.equal(await page.locator('[data-atendimento-editor]').evaluate(node => node.open), false);
      assert.equal(await page.locator('[data-atendimento-card][open]').count(), 0);
      assert.equal(await page.locator('[data-operacao-guia]').isVisible(), true);
      assert.equal(await page.locator('details.operacao-secundarios[open]').count(), 0);
      assert.equal(await form.evaluate(node => Boolean(document.querySelector('[data-operacao-atendimentos]')
        .compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING)), true, 'saved history precedes editor');
      assert.equal(await page.locator('[data-form-retorno]').evaluate(node => Boolean(node.closest('details.operacao-secundarios'))), true);
      await page.screenshot({ path: path.join(output, (mobile ? 'mobile' : 'desktop') + '-workflow-entry.png'), fullPage: true, animations: 'disabled' });

      await page.locator('[data-app-action="new-procedure"]:visible').click();
      assert.equal(await page.locator('[data-atendimento-editor]').evaluate(node => node.open), true);
      assert.equal(await field('atendimento_id').inputValue(), '', 'new opens an empty editor, not a saved consultation');
      assert.equal(writeCalls(calls).length, 0, 'new editor does not auto-create a record');

      await edit(ids.visitA);
      assert.equal(await photoSelect.inputValue(), ids.visitA, 'editing A synchronizes the photo target');
      assert.equal(await page.locator('[data-atendimento-editor]').evaluate(node => node.open), true);
      assert.equal(await field('cliente_id').inputValue(), ids.patientA);
      assert.equal(await field('procedimento').isDisabled(), true, 'existing procedure identity is not silently renamed');
      await form.locator('[data-atendimento-vinculos] > summary').click();
      for (const [name, retained, excluded, allowed] of [
        ['agendamento_id', ids.appointmentA, ids.appointmentB, ids.appointmentA],
        ['protocolo_id', ids.protocolA, ids.protocolB, ids.protocolOtherA],
        ['lancamento_financeiro_id', ids.entryA, ids.entryB, ids.entryOtherA]
      ]) {
        assert.equal(await field(name).inputValue(), retained, 'retain current historic link ' + name);
        const values = await field(name).locator('option').evaluateAll(nodes => nodes.map(node => node.value));
        assert(!values.includes(excluded), 'exclude another patient relation ' + name);
        assert(values.includes(allowed), 'allow same-patient relation ' + name);
      }
      await field('realizado_em').fill(dateEdit);
      await field('duracao_minutos').fill('63');
      await page.evaluate(id => {
        window.__fixtureAttendanceCard = document.querySelector('[data-atendimento-card="' + id + '"]');
      }, ids.visitA);
      await page.locator('[data-operacao-busca]').fill('Paciente sintética B');
      assert.equal(await page.locator('[data-atendimento-card="' + ids.visitA + '"]').isVisible(), false);
      assert.equal(await page.evaluate(id => window.__fixtureAttendanceCard ===
        document.querySelector('[data-atendimento-card="' + id + '"]'), ids.visitA), true,
      'search only filters visibility; it does not replace cards or their forms');
      assert.equal(await field('atendimento_id').inputValue(), ids.visitA);
      assert.equal(await field('realizado_em').inputValue(), dateEdit);
      await page.locator('[data-operacao-busca]').fill('');
      await page.locator('details.operacao-secundarios:has([data-form-retorno]) > summary').click();
      const returnForm = page.locator('[data-form-retorno]');
      await returnForm.locator('[name="atendimento_id"]').selectOption(ids.visitA);
      await returnForm.locator('[name="recomendacao"]').fill('Texto local ainda não salvo');
      await returnForm.locator('[name="proxima_acao_em"]').fill('2026-09-15T10:20');
      const snapshot = await formSnapshot();
      const listCount = calls.filter(call => call.acao === 'listar' && call.endpoint.endsWith('/operacao-clinica-fichas')).length;
      await page.locator('[data-app-action="refresh-procedures"]:visible').click();
      await page.waitForFunction(() => !document.querySelector('[data-operacao-recarregar]').disabled);
      assert.equal(calls.filter(call => call.acao === 'listar' && call.endpoint.endsWith('/operacao-clinica-fichas')).length, listCount + 1);
      assert.deepEqual(await formSnapshot(), snapshot, 'refresh preserves exact field values, IDs, versions and historic links');
      assert.equal(await photoSelect.inputValue(), ids.visitA);
      assert.equal(await returnForm.locator('[name="recomendacao"]').inputValue(), 'Texto local ainda não salvo');
      assert.equal(await returnForm.locator('[name="atendimento_id"]').inputValue(), ids.visitA);
      assert.equal(await returnForm.locator('[name="proxima_acao_em"]').inputValue(), '2026-09-15T10:20');
      await page.locator('details.operacao-secundarios:has([data-form-retorno]) > summary').click();

      await changePhotoSelection(ids.visitB, false);
      assert.deepEqual(await formSnapshot(), snapshot, 'cancel preserves unsaved A');
      assert.equal(await photoSelect.inputValue(), ids.visitA, 'cancel also rolls photo selector back to A');
      await changePhotoSelection(ids.visitB, true);
      await page.waitForFunction(id => document.querySelector('[data-form-atendimento] [name="atendimento_id"]').value === id, ids.visitB);
      assert.equal(await photoSelect.inputValue(), ids.visitB);
      assert.equal(await field('cliente_id').inputValue(), ids.patientB);
      assert.equal(await field('protocolo_id').inputValue(), ids.protocolB);
      assert.equal(writeCalls(calls).length, 0, 'selection and refresh never save or create records');

      await edit(ids.visitA);
      await field('realizado_em').fill(dateEdit);
      await field('duracao_minutos').fill('63');
      const beforeSave = await formSnapshot();
      await page.locator('[data-atendimento-salvar]').click();
      await page.waitForFunction(() => !document.querySelector('[data-operacao-recarregar]').disabled);
      const saves = calls.filter(call => call.acao === 'salvar_atendimento');
      assert.equal(saves.length, 1);
      assert.equal(saves[0].atendimento_id, ids.visitA);
      assert.equal(saves[0].versao, Number(beforeSave.versao));
      assert.equal(saves[0].cliente_id, ids.patientA);
      assert.equal(saves[0].procedimento, beforeSave.procedimento);
      assert.equal(saves[0].responsavel_id, ids.member);
      assert.equal(saves[0].agendamento_id, ids.appointmentA);
      assert.equal(saves[0].protocolo_id, ids.protocolA);
      assert.equal(saves[0].lancamento_financeiro_id, ids.entryA);
      assert.equal(Number(saves[0].duracao_minutos), 63);
      assert.equal(new Date(saves[0].realizado_em).toISOString(), '2026-09-03T12:35:00.000Z');
      assert.match(saves[0].operation_id, /^[0-9a-f-]{36}$/i);
      assert.equal(saves[0].password, undefined);

      await edit(ids.visitA);
      await form.screenshot({ path: path.join(output, (mobile ? 'mobile' : 'desktop') + '-editor-context.png'), animations: 'disabled' });
      await page.screenshot({ path: path.join(output, (mobile ? 'mobile' : 'desktop') + '-single-context.png'), fullPage: true, animations: 'disabled' });
      const beforeArchived = calls.length;
      await page.locator('[data-fotos-atalho-abrir]').click();
      await page.waitForFunction(id => AMJShell.currentRoute() === 'prontuarios' &&
        document.querySelector('#prontuario-id').value === id, ids.protocolA);
      assert.equal(await page.locator('#prontuario-notas').isDisabled(), true);
      assert.equal(await page.locator('#prontuario-foto-form').isVisible(), false);
      assert.equal(await page.locator('#prontuario-salvar').isVisible(), false);
      assert.equal(calls.slice(beforeArchived).filter(call => ![
        'listar', 'listar_clientes', 'listar_catalogos', 'listar_estoque', 'listar_fotos'
      ].includes(call.acao)).length, 0, 'archived photos open read-only, never prepare a protocol or write');
      await page.screenshot({ path: path.join(output, (mobile ? 'mobile' : 'desktop') + '-archived-read-only.png'), fullPage: true, animations: 'disabled' });
      if (mobile) await page.locator('.app-shell-menu-button').click();
      await page.locator('[data-shell-route="procedimentos"]:visible').first().click();
      await photoSelect.selectOption(ids.archivedVisit);
      assert.equal(await field('atendimento_id').inputValue(), '', 'an archived selection cannot leave another consultation editable below it');
      assert.equal(await page.locator('[data-atendimento-editor]').evaluate(node => node.open), false);
      await page.locator('[data-fotos-atalho-abrir]').click();
      await page.waitForFunction(id => AMJShell.currentRoute() === 'prontuarios' &&
        document.querySelector('#prontuario-id').value === id, ids.archivedProtocol);
      assert.equal(await page.locator('#prontuario-notas').isDisabled(), true);
      assert.equal(await page.locator('#prontuario-foto-form').isVisible(), false);
      assert.equal(calls.slice(beforeArchived).filter(call => ![
        'listar', 'listar_clientes', 'listar_catalogos', 'listar_estoque', 'listar_fotos'
      ].includes(call.acao)).length, 0, 'neither archived protocol nor archived attendance triggers a write');
      assert.deepEqual(unexpected, [], 'only explicitly mocked endpoint actions were used');
      assert.deepEqual(errors, []);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2));
    } catch (error) {
      await page.screenshot({ path: path.join(output, (mobile ? 'mobile' : 'desktop') + '-failure.png'), fullPage: true });
      console.error('Operation workflow failure', JSON.stringify({ errors, unexpected,
        blocked: [...new Set(blocked)], route: await page.evaluate(() => window.AMJShell?.currentRoute()),
        status: await page.locator('[data-operacao-status]').allTextContents() }));
      throw error;
    } finally { await context.close(); }
  });

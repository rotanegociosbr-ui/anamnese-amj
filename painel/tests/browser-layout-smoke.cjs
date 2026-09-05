'use strict';

// Manual, offline Chromium smoke. Run with node painel/tests/browser-layout-smoke.cjs.
// Uses the real HTML/CSS/JS, synthetic in-memory responses and no real session.
// This is layout verification, not validation of authentication, database or camera.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE ||
  'C:/Users/NERI/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');

const root = fs.realpathSync(path.resolve(__dirname, '..', '..'));
const origin = 'https://127.0.0.1:8765';
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'amj-layout-smoke-'));
const widths = [360, 390, 430, 1366];
const routes = ['cotacoes', 'prontuarios', 'procedimentos', 'clientes', 'receitas', 'despesas', 'estoque'];
const patient = { id: 'synthetic-client', nome: 'Cliente Sintética de Verificação de Layout',
  full_name: 'Cliente Sintética de Verificação de Layout', version: 1, ativo: true };
const product = { id: 'synthetic-product', nome: 'Produto Sintético de Apresentação Longa 10 mL',
  name: 'Produto Sintético de Apresentação Longa 10 mL', marca_id: 'synthetic-brand',
  unidade: 'mL', controla_estoque: true, custo_referencia: 100, ativo: true, version: 1 };
const protocol = { id: 'synthetic-protocol', patient_id: patient.id, paciente: patient,
  procedure_kind: 'toxina_botulinica', procedure_date: '2026-09-05', status: 'draft', version: 1,
  consentimentos_atuais: { clinical_photography: true }, produtos: [],
  photo_counts: { before: 1, after: 1, products_used: 1 } };
const photos = ['before', 'after', 'products_used'].map((phase, index) => ({
  id: 'synthetic-photo-' + index, protocol_id: protocol.id, attendance_id: 'synthetic-attendance',
  phase, category: ['antes', 'depois', 'produtos_utilizados'][index],
  miniatura_url: origin + '/__fixture/media.svg', url_assinada: origin + '/__fixture/media.svg',
  created_at: '2026-09-05T15:00:00Z', version: 1
}));
const revenue = { id: 'synthetic-entry', tipo: 'receita', origem: 'manual', estado: 'ativo',
  descricao: 'Receita sintética com entrada Pix e três parcelas de saldo',
  patient_id: patient.id, patient_name: patient.nome, valor_total: 1800, valor_pago: 600, saldo: 1200,
  status: 'parcial', competencia: '2026-09-05', vencimento: '2026-10-05',
  parcelas_previstas: [10, 11, 12].map((month, index) => ({ id: 'synthetic-installment-' + index,
    numero: index + 1, vencimento: '2026-' + month + '-05', valor: 400, saldo: 400,
    valor_pago: 0, forma_pagamento: 'boleto', estado: 'ativo' })) };
const expense = { id: 'synthetic-expense', tipo: 'despesa', origem: 'compra', estado: 'ativo',
  descricao: 'Compra sintética de dois produtos e frete', supplier_name: 'Fornecedor Sintético',
  valor_total: 330, valor_pago: 0, saldo: 330, status: 'pendente', competencia: '2026-09-05',
  vencimento: '2026-10-05', compra: { id: 'synthetic-purchase', subtotal_itens: 300, valor_frete: 30,
    total: 330, itens: [{ produto: product.nome, quantidade: 1, valor_unitario: 100, frete_rateado: 10 },
      { produto: 'Outro produto sintético', quantidade: 1, valor_unitario: 200, frete_rateado: 20 }] } };

function fixture(endpoint, action) {
  if (endpoint === 'ia-copiloto-fichas' && action === 'painel') {
    return { painel: { resumo: 'Estado sintético de layout. Nenhuma análise de IA foi executada.',
      acoes: [], limitacoes: ['Dados exclusivamente sintéticos.'] } };
  }
  if (endpoint === 'financeiro-fichas') {
    const responses = {
      resumo: { resumo: { receita_recebida: 600, contas_receber: 1200, contas_pagar: 330 }, fluxo_mensal: [] },
      listar_catalogos: { formas_pagamento: [{ codigo: 'pix', nome: 'Pix' }, { codigo: 'boleto', nome: 'Boleto' }],
        fornecedores: [{ id: 'synthetic-supplier', nome: 'Fornecedor Sintético de Teste', ativo: true }],
        marcas: [{ id: 'synthetic-brand', nome: 'Marca Sintética', ativo: true }], produtos: [product] },
      listar_clientes: { clientes: [patient], paginacao: { tem_mais: false } },
      listar_lancamentos: { lancamentos: [revenue, expense] }, listar_auditoria: { auditoria: [] },
      listar_estoque: { estoque: [{ id: 'synthetic-lot', produto_id: product.id, lote: 'LOTE-TESTE',
        saldo: 3, unidade: 'mL', validade: '2027-09-05' }] },
      listar_pendencias_estoque: { pendencias: [] }, listar_revisoes_duplicidade: { revisoes: [] }
    };
    return responses[action];
  }
  if (endpoint === 'prontuario-fichas') {
    if (action === 'listar') return { protocolos: [protocol], paginacao: { pagina: 1, tem_mais: false } };
    if (action === 'listar_fotos') return { fotos: photos, paginacao: { tem_mais: false } };
  }
  if (endpoint === 'operacao-clinica-fichas') {
    if (action === 'listar_fotos_atendimento') return { fotos_atendimento: photos };
    if (action === 'listar') return {
      clientes: [patient], produtos: [product], protocolos: [protocol],
      atendimentos: [{ id: 'synthetic-attendance', patient_id: patient.id, protocol_id: protocol.id,
        status: 'em_andamento', attended_at: '2026-09-05T15:00:00Z', version: 1 }],
      procedimentos_atendimento: [{ id: 'synthetic-procedure', attendance_id: 'synthetic-attendance',
        procedure_kind: 'Procedimento sintético para verificação de layout', is_primary: true, version: 1 }],
      resumos_prontuario_atendimento: [{ attendance_id: 'synthetic-attendance', protocol_id: protocol.id,
        active_clinical_count: 2, active_product_count: 1, clinical_photography_consented: true }],
      fotos_atendimento: photos, paginacao: { tem_mais: false }
    };
  }
  if (endpoint === 'cotacoes-fichas' && action === 'listar_cotacoes') {
    const quote = { source_name: 'Tabela Sintética de Verificação', supplier_name: 'Fornecedor Sintético',
      source_date: '2026-09-05', quote_date: '2026-09-05', page_number: 1, line_reference: 'Linha sintética',
      brand: 'Marca Sintética', item_name: product.nome, presentation: 'Caixa com 10 unidades',
      package_quantity: 10, package_unit: 'mL', commercial_condition: 'Pagamento à vista com frete separado',
      price: 300, currency: 'BRL', review_status: 'pendente_revisao', review_version: 1 };
    return { cotacoes: [1, 2, 3].map(id => ({ ...quote, item_id: 'synthetic-quote-' + id })),
      fontes: [], paginacao: { pagina: 1, total: 3, paginas: 1 }, estatisticas: [{
        ...quote, quote_count: 3, source_count: 2, minimum_price: 280, maximum_price: 320,
        average_price: 300, median_price: 300, latest_price: 300, latest_date: '2026-09-05',
        period_start: '2026-09-01', period_end: '2026-09-05', reference_average_unit_price: 30
      }] };
  }
  return undefined;
}

const report = { output, browser: '', simulatedBackend: true, actualAuthenticationTested: false,
  endpointOriginRemappedInMemory: true,
  realCameraTested: false, remoteFontsBlocked: true, widths, observations: [], errors: [],
  blocked: [], fixtureCalls: [], servedLocal: 0, unexpectedFixtureCalls: [] };
const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };

async function blockAllNetwork(context) {
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) {
      report.blocked.push({ host: url.host, path: url.pathname });
      if (url.hostname === 'fonts.googleapis.com') {
        await route.fulfill({ status: 200, contentType: 'text/css', body: '/* remote font blocked */' });
      } else await route.abort('blockedbyclient');
      return;
    }
    if (url.pathname.startsWith('/__api/')) {
      const endpoint = url.pathname.slice('/__api/'.length);
      let payload = {};
      try { payload = request.postDataJSON() || {}; } catch (_) {}
      const action = payload.acao;
      const data = fixture(endpoint, action);
      report.fixtureCalls.push({ endpoint, action });
      if (data === undefined) report.unexpectedFixtureCalls.push({ endpoint, action });
      await route.fulfill({ status: data === undefined ? 501 : 200, contentType: 'application/json',
        body: JSON.stringify(data === undefined ? { erro: 'Ação fora das fixtures de layout.' } : data) });
      return;
    }
    if (url.pathname === '/__fixture/media.svg') {
      await route.fulfill({ contentType: 'image/svg+xml', body:
        '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><rect width="800" height="600" fill="#ede5da"/><circle cx="400" cy="260" r="110" fill="#b9a38e"/><text x="400" y="460" text-anchor="middle" font-size="32">IMAGEM SINTÉTICA DE TESTE</text></svg>' });
      return;
    }
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '') + (url.pathname.endsWith('/') ? 'index.html' : '');
    const parts = relative.split(/[\\/]/);
    const file = path.resolve(root, relative);
    const extension = path.extname(file).toLowerCase();
    const allowed = ['painel', 'assets'].includes(parts[0]) &&
      !parts.some(part => part.startsWith('.') || part === '..') && Boolean(types[extension]) &&
      file.startsWith(root + path.sep) && fs.existsSync(file) &&
      fs.realpathSync(file).startsWith(root + path.sep);
    if (!allowed) { report.blocked.push({ host: url.host, path: url.pathname }); await route.abort('blockedbyclient'); return; }
    report.servedLocal += 1;
    let body = fs.readFileSync(file);
    // Remap endpoint configuration only in the served test copy, so signed URL
    // host checks run unchanged against HTTPS fixtures and no production URL is requested.
    if (extension === '.js' || extension === '.html') {
      body = Buffer.from(body.toString('utf8').replace(/https:\/\/[a-z0-9]+\.supabase\.co/g, origin));
    }
    await route.fulfill({ status: 200, contentType: types[extension], body });
  });
  if (typeof context.routeWebSocket === 'function') {
    await context.routeWebSocket('**/*', socket => socket.close());
  }
  await context.addInitScript(({ localOrigin }) => {
    const nativeFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input.url, location.href);
      // Rewrite API destinations before a request is created; no real token is supplied.
      if (url.pathname.startsWith('/functions/v1/')) {
        return nativeFetch(localOrigin + '/__api/' + url.pathname.split('/').pop(), init);
      }
      return nativeFetch(input, init);
    };
    window.WebSocket = class { constructor() { throw new Error('WebSocket blocked in offline smoke'); } };
  }, { localOrigin: origin });
}

async function measure(page, width, route, state) {
  await page.evaluate(() => window.scrollTo({ top: window.scrollY, left: 0, behavior: 'instant' }));
  const value = await page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    const nodes = Array.from(document.querySelectorAll('#app-shell-content *'));
    const clipped = nodes.filter(node => {
      const rect = node.getBoundingClientRect();
      if (!rect.width || !rect.height || getComputedStyle(node).visibility === 'hidden') return false;
      if (rect.left >= -1 && rect.right <= width + 1) return false;
      // Wide tables inside their own horizontal scrolling region are supported.
      let parent = node.parentElement;
      while (parent && parent !== document.body) {
        const style = getComputedStyle(parent);
        if (style.visibility === 'hidden' || style.clip !== 'auto' || style.clipPath !== 'none') return false;
        if (['auto', 'scroll'].includes(style.overflowX) && parent.scrollWidth > parent.clientWidth + 1) return false;
        parent = parent.parentElement;
      }
      return true;
    }).sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right)
      .slice(0, 12).map(node => ({ tag: node.tagName, id: node.id, className: String(node.className),
      text: node.textContent.trim().slice(0, 100), left: Math.round(node.getBoundingClientRect().left),
      right: Math.round(node.getBoundingClientRect().right), elementWidth: Math.round(node.getBoundingClientRect().width) }));
    return { viewport: width, documentWidth: document.documentElement.scrollWidth,
      bodyWidth: document.body.scrollWidth, clipped };
  });
  const screenshot = path.join(output, `${width}-${route}-${state}.png`);
  await page.screenshot({ path: screenshot, fullPage: true });
  report.observations.push({ width, route, state, ...value, screenshot });
}

async function trial(page, selector, label) {
  const button = page.locator(selector).first();
  try { await button.click({ trial: true, timeout: 2500 }); return { label, reachable: true }; }
  catch (error) { return { label, reachable: false, reason: error.message.split('\n')[0] }; }
}

(async () => {
  const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
  const executable = process.env.PLAYWRIGHT_EXECUTABLE_PATH ||
    (fs.existsSync(chromium.executablePath()) ? chromium.executablePath() : fs.existsSync(edge) ? edge : undefined);
  const browser = await chromium.launch({ headless: true,
    executablePath: executable,
    args: ['--disable-background-networking', '--disable-component-update', '--disable-default-apps'] });
  report.browser = browser.version();
  console.log('Browser ' + report.browser + '; evidence directory: ' + output);
  try {
    for (const width of widths) {
      const context = await browser.newContext({ viewport: { width, height: width < 800 ? 850 : 900 },
        serviceWorkers: 'block', locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' });
      await blockAllNetwork(context);
      const page = await context.newPage();
      page.setDefaultTimeout(7000);
      console.log(width + ': opening local HTML');
      page.on('pageerror', error => report.errors.push({ width, route: 'browser', message: error.message }));
      await page.goto(origin + '/painel/', { waitUntil: 'load', timeout: 15000 });
      console.log(width + ': HTML loaded');
      await page.waitForFunction(() => typeof authInicioConcluido !== 'undefined' && authInicioConcluido);
      console.log(width + ': preparing synthetic view');
      await page.evaluate(() => {
        modoAcesso = 'auth';
        identidadeBackend = { role: 'owner', display_name: 'SIMULAÇÃO LOCAL — SEM SESSÃO REAL' };
        cabecalhosAcesso = async () => ({ 'Content-Type': 'application/json' });
        for (const id of TELAS_AUTENTICACAO) {
          document.getElementById(id).hidden = true;
          document.getElementById(id).classList.add('oculto');
        }
        document.getElementById('usuario-detalhes').textContent = 'DADOS SINTÉTICOS DE TESTE';
        document.getElementById('tela-lista').hidden = false;
        document.getElementById('tela-lista').classList.remove('oculto');
      });
      await page.waitForFunction(() => document.body.classList.contains('app-shell-authenticated'));
      console.log(width + ': synthetic view ready');
      for (const route of routes) {
        try {
          console.log(width + ': route ' + route);
          await page.evaluate(async target => { await window.AMJShell.navigate(target, { focus: false }); }, route);
          const rootSelector = route === 'cotacoes' ? '#cotacoes-root' : route === 'prontuarios' ? '#aba-prontuarios' :
            route === 'procedimentos' ? '#operacao-clinica-root' : '#aba-financeiro';
          await page.locator(rootSelector).waitFor({ state: 'visible', timeout: 8000 });
          await page.waitForFunction(selector => !Array.from(document.querySelectorAll(selector + ' [aria-busy="true"], ' + selector + '[aria-busy="true"]')).length, rootSelector);
          await page.evaluate(() => window.scrollTo(0, 0));
          if (route === 'prontuarios') {
            await page.locator('.prontuario-consulta > summary').first().click();
            await page.locator('.prontuario-foto-card img').first().waitFor({ state: 'visible' });
          }
          if (route === 'procedimentos') {
            await page.locator('[data-fotos-abrir]').first().click();
            await page.locator('input[name="camera"]').first().waitFor({ state: 'visible' });
          }
          await measure(page, width, route, 'overview');
          const checks = route === 'cotacoes' ? [
            ['#cotacoes-filtros button[type="submit"]', 'Aplicar filtros'],
            ['[data-cotacoes-revisar]', 'Revisar cotação']
          ] : route === 'prontuarios' ? [
            ['[data-prontuario-adicionar-fotos]', 'Adicionar fotos'],
            ['.prontuario-foto-card a', 'Abrir original']
          ] : route === 'procedimentos' ? [
            ['input[name="camera"]', 'Tirar foto'],
            ['input[name="arquivos"]', 'Adicionar fotos']
          ] : [['#app-finance-context button', 'Ação financeira contextual']];
          const actions = [];
          for (const [selector, label] of checks) actions.push(await trial(page, selector, label));
          report.observations[report.observations.length - 1].actions = actions;
          if (route === 'estoque') {
            await page.locator('[data-app-action="new-purchase"]').click();
            await measure(page, width, route, 'purchase-form');
            report.observations[report.observations.length - 1].actions = [
              await trial(page, '#financeiro-form-compra button[type="submit"]', 'Salvar compra')
            ];
          }
        } catch (error) {
          report.errors.push({ width, route, message: error.message.split('\n')[0] });
          await page.screenshot({ path: path.join(output, `${width}-${route}-error.png`), fullPage: true });
        }
      }
      await context.close();
    }
  } finally {
    await browser.close();
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    const issues = report.observations.filter(row => row.documentWidth > row.viewport + 1 || row.clipped.length ||
      (row.actions || []).some(action => !action.reachable));
    console.log(JSON.stringify({ output, browser: report.browser, checks: report.observations.length,
      servedLocal: report.servedLocal, fixtureCalls: report.fixtureCalls.length,
      unexpectedFixtureCalls: report.unexpectedFixtureCalls, errors: report.errors,
      issues: issues.map(row => ({ width: row.width, route: row.route, state: row.state,
        documentWidth: row.documentWidth, clippedElements: row.clipped.length,
        unreachable: (row.actions || []).filter(action => !action.reachable) })) }, null, 2));
    process.exitCode = report.errors.length || issues.length || report.unexpectedFixtureCalls.length ? 1 : 0;
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

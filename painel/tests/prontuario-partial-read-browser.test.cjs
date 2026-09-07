'use strict';
// Local pages and synthetic intercepted responses only; no service or patient writes.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'C:/Users/NERI/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const root = path.resolve(__dirname, '../..'), origin = 'https://127.0.0.1:8767';
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'amj-partial-reads-'));
const patientId = '11111111-1111-4111-8111-111111111111', protocolId = '22222222-2222-4222-8222-222222222222', productId = '33333333-3333-4333-8333-333333333333';
const photoUrl = 'https://rjxtxoqprnumouqakxbc.supabase.co/storage/v1/object/sign/clinical-images/synthetic.png?token=synthetic';
const protocol = { id: protocolId, patient_id: patientId, version: 7, status: 'draft', paciente: { nome: 'Paciente sintética QA' }, procedure_kind: 'toxina_botulinica', procedure_date: '2026-09-01',
  technique_notes: 'Notas históricas sintéticas', produtos_rascunho: [{ product_id: productId, product_name_snapshot: 'Produto histórico sintético', lot: 'LOTE HISTÓRICO', expiry: '2027-01-31', amount: 1, unit: 'U' }],
  consentimentos_atuais: { clinical_photography: false }, fotos_resumo: { total: 1, ativas: 1 } };
let browser;
before(async () => {
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || (fs.existsSync(chromium.executablePath()) ? chromium.executablePath() : 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'), args: ['--disable-background-networking', '--disable-component-update', '--disable-default-apps'] });
  console.log('Synthetic partial read evidence: ' + output);
});
after(async () => { await browser?.close(); });
for (const mobile of [false, true]) test('history, unsaved notes and photos survive auxiliary/refresh failures — ' + (mobile ? 'mobile' : 'desktop'), { timeout: 45000 }, async () => {
  const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1365, height: 1000 }, isMobile: mobile, hasTouch: mobile, locale: 'pt-BR', serviceWorkers: 'block' });
  const page = await context.newPage(), calls = [], errors = [];
  let auxiliaryFailure = true, stockFailure = false, photoFailure = false;
  page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.message));
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.href === photoUrl) { await route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nKcAAAAASUVORK5CYII=', 'base64') }); return; }
    if (url.hostname === 'rjxtxoqprnumouqakxbc.supabase.co' && url.pathname.startsWith('/functions/v1/')) {
      const body = route.request().postDataJSON() || {}; calls.push(body); let result = {};
      if ((auxiliaryFailure && ['listar_clientes', 'listar_catalogos', 'listar_estoque'].includes(body.acao)) || (stockFailure && body.acao === 'listar_estoque') || (photoFailure && body.acao === 'listar_fotos')) {
        await route.fulfill({ status: 503, json: { erro: 'Falha temporária sintética' } }); return;
      }
      if (body.acao === 'listar_clientes') result = { clientes: [{ id: patientId, nome: 'Paciente sintética QA', ativo: true }] };
      else if (body.acao === 'listar_catalogos') result = { marcas: [], produtos: [{ id: productId, nome: 'Produto sintético', unidade: 'U', controla_estoque: true, ativo: true }] };
      else if (body.acao === 'listar_estoque') result = { estoque: [{ produto_id: productId, lote: 'LOTE ATUAL', validade: '2028-01-31', saldo: 9, unidade: 'U' }] };
      else if (body.acao === 'listar') result = { protocolos: [protocol], paginacao: { pagina: body.pagina, tem_mais: false } };
      else if (body.acao === 'listar_fotos') result = { fotos: [{ id: 'synthetic-photo', phase: 'before', url_assinada: photoUrl, miniatura_url: photoUrl }], paginacao: { pagina: 1, tem_mais: false } };
      await route.fulfill({ json: result }); return;
    }
    if (url.origin !== origin) { await route.abort('blockedbyclient'); return; }
    const file = path.resolve(root, decodeURIComponent(url.pathname).replace(/^\/+/, ''));
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { await route.fulfill({ status: 404, body: 'Synthetic fixture only' }); return; }
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' };
    await route.fulfill({ contentType: types[path.extname(file)] || 'application/octet-stream', body: fs.readFileSync(file) });
  });
  try {
    await page.goto(origin + '/painel/index.html');
    await page.waitForFunction(() => window.AMJProntuario && window.AMJShell && typeof authInicioConcluido !== 'undefined' && authInicioConcluido);
    await page.evaluate(() => {
      modoAcesso = 'auth'; identidadeBackend = { role: 'owner' }; cabecalhosAcesso = async () => ({ 'Content-Type': 'application/json' });
      document.querySelector('#tela-login').hidden = true; document.querySelector('#tela-login').classList.add('oculto');
      document.querySelector('#tela-lista').hidden = false; document.querySelector('#tela-lista').classList.remove('oculto');
      AMJProntuario.atualizarAcesso();
    });
    await page.evaluate(() => AMJShell.navigate('prontuarios', { focus: false }));
    await page.locator('[data-prontuario-consulta]').waitFor();
    assert.match(await page.locator('#prontuario-status').textContent(), /Histórico carregado/);
    const card = page.locator('[data-prontuario-consulta="' + protocolId + '"]');
    await card.locator(':scope > summary').click(); await card.locator('.prontuario-foto-card').waitFor();
    assert.equal(await card.locator('.prontuario-foto-card').count(), 1);
    await card.locator('[data-prontuario-editar]').click();
    assert.equal(await page.locator('#prontuario-paciente').inputValue(), patientId, 'the historical patient binding works without a client catalog');
    assert.equal(await page.locator('.prontuario-produto-lote').inputValue(), 'LOTE HISTÓRICO');
    assert.equal(await page.locator('.prontuario-produto-validade').inputValue(), '2027-01-31');
    await page.locator('#prontuario-notas').fill('Complemento local ainda não salvo');
    photoFailure = true; await card.locator('[data-prontuario-recarregar-fotos]').click();
    await card.locator('.prontuario-fotos-controles .erro').waitFor();
    assert.equal(await card.locator('.prontuario-foto-card').count(), 1, '503 keeps the currently visible gallery');
    assert.equal(await page.locator('#prontuario-notas').inputValue(), 'Complemento local ainda não salvo');
    auxiliaryFailure = false; await page.evaluate(() => AMJProntuario.carregar());
    assert.equal(await page.locator('.prontuario-produto-lote').inputValue(), 'LOTE HISTÓRICO', 'refresh keeps historical/manual fields');
    assert.equal(await page.locator('.prontuario-produto-validade').inputValue(), '2027-01-31');
    stockFailure = true; await page.evaluate(() => AMJProntuario.carregar());
    assert.match(await page.locator('.prontuario-produto-lote-select').textContent(), /Estoque não atualizado/);
    assert.doesNotMatch(await page.locator('.prontuario-produto-lote-select').textContent(), /LOTE ATUAL/);
    assert.doesNotMatch(await page.locator('.prontuario-produto-estoque').textContent(), /Saldo total: 0|Sem lote disponível/);
    await page.locator('.prontuario-produto-select').selectOption(''); await page.locator('.prontuario-produto-select').selectOption(productId);
    assert.equal(await page.locator('.prontuario-produto-lote').inputValue(), '', 'a failed stock refresh never autofills a stale lot');
    photoFailure = false; await card.locator('[data-prontuario-recarregar-fotos]').click();
    await page.waitForFunction(() => !document.querySelector('.prontuario-fotos-controles .erro'));
    assert.equal(await card.locator('.prontuario-foto-card').count(), 1);
    assert.equal(await page.locator('#prontuario-notas').inputValue(), 'Complemento local ainda não salvo');
    assert(calls.every(call => ['listar', 'listar_fotos', 'listar_clientes', 'listar_catalogos', 'listar_estoque'].includes(call.acao)), 'no writes are needed to recover reads');
    assert.deepEqual(errors, []);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2));
    await page.screenshot({ path: path.join(output, (mobile ? 'mobile' : 'desktop') + '-partial-read.png'), fullPage: true });
  } finally { await context.close(); }
});

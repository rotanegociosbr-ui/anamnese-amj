'use strict';

// Real contextual markup and CSS, offline layout only. No app initialization,
// clinical records, authenticated session or external service is used.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE ||
  'C:/Users/NERI/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const globalCss = html.match(/<style>([\s\S]*?)<\/style>/)[1];
const shellCss = fs.readFileSync(path.join(root, 'app-shell.css'), 'utf8');
const operationCss = fs.readFileSync(path.join(root, 'operacao.css'), 'utf8');
const source = fs.readFileSync(path.join(root, 'app-shell.js'), 'utf8');
const start = source.indexOf('  function decorateProcedures() {');
const end = source.indexOf('\n  function ', start + 20);
assert(start >= 0 && end > start);
let markup;
const fakeRoot = { classList: { add() {} }, insertBefore(node) { markup = node.innerHTML; } };
vm.runInNewContext(source.slice(start, end) + '\ndecorateProcedures();', {
  byId: id => id === 'operacao-clinica-root' ? fakeRoot : null,
  document: { createElement: () => ({}) }
});
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'amj-operacao-contexto-'));
let browser;
before(async () => {
  const executablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH || (fs.existsSync(chromium.executablePath())
    ? chromium.executablePath() : 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe');
  browser = await chromium.launch({ headless: true, executablePath });
  console.log('Procedure context evidence: ' + output);
});
after(async () => { await browser?.close(); });

for (const width of [1366, 1024, 390]) test('procedure context stays readable and isolated at ' + width + 'px', { timeout: 12000 }, async () => {
  const context = await browser.newContext({ viewport: { width, height: 1000 }, isMobile: width < 600, hasTouch: width < 600 });
  const page = await context.newPage(); await context.route('**/*', route => route.abort());
  try {
    await page.setContent('<!doctype html><html lang="pt-BR"><head><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<style>' + globalCss + '\n' + shellCss + '\n' + operationCss + '</style></head><body class="app-shell-mounted app-shell-authenticated">' +
      '<div class="app-shell-layout"><aside class="app-shell-sidebar"></aside><div class="app-shell-workspace"><main class="app-shell-content">' +
      '<div id="operacao-clinica-root" class="app-shell-procedure-view"><section id="app-procedure-context" class="app-procedure-context">' + markup + '</section>' +
      '<div class="operacao-clinica"><p class="operacao-status">Dados atualizados. Nenhuma mensagem foi enviada.</p>' +
      '<section class="operacao-resumo"><article><span>Atendimentos</span><strong>3</strong></article>' +
      '<article><span>Retornos em aberto</span><strong>0</strong></article></section>' +
      '<section class="operacao-card"><section class="operacao-paciente"><h4>Paciente sintética</h4>' +
      '<details class="operacao-visita"><summary>Atendimento sintético — Ver atendimento</summary><p>Contexto sintético.</p></details>' +
      '<details class="operacao-visita arquivado"><summary>Atendimento arquivado — Ver atendimento</summary><p>Somente leitura.</p></details>' +
      '</section></section></div></div>' +
      '<section id="finance-context-control" class="app-route-context"><div><h2>Controle de outra tela</h2><p>Ajuda existente</p></div>' +
      '<div class="app-context-actions"><button type="button">Controle</button></div></section>' +
      '</main></div></div></body></html>');
    const metrics = await page.evaluate(() => {
      const box = document.querySelector('#app-procedure-context');
      const style = node => getComputedStyle(node);
      const rect = node => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
      return { title: parseFloat(style(box.querySelector('h2')).fontSize), help: parseFloat(style(box.querySelector('p')).fontSize),
        helpWeight: Number(style(box.querySelector('p')).fontWeight), helpLine: parseFloat(style(box.querySelector('p')).lineHeight),
        buttons: [...box.querySelectorAll('button')].map(n => ({ size: parseFloat(style(n).fontSize), rect: rect(n), clipped: n.scrollWidth > n.clientWidth + 1 })),
        box: rect(box), overflow: document.documentElement.scrollWidth > innerWidth + 1,
        columns: style(box.querySelector('.app-context-actions')).gridTemplateColumns.split(' ').length,
        metadata: [...document.querySelectorAll('.operacao-status,.operacao-resumo span')].map(n => ({ size: parseFloat(style(n).fontSize), weight: Number(style(n).fontWeight) })),
        control: { help: style(document.querySelector('#finance-context-control p')).fontSize,
          button: style(document.querySelector('#finance-context-control button')).fontSize }
      };
    });
    assert(metrics.title >= 28); assert(metrics.help >= 15); assert(metrics.helpWeight >= 400); assert(metrics.helpLine >= 23);
    assert.equal(metrics.buttons.length, 4);
    for (const button of metrics.buttons) {
      assert(button.size >= 15 && button.rect.height >= 48 && button.rect.width >= 44, JSON.stringify(button));
      assert.equal(button.clipped, false); assert(button.rect.x >= metrics.box.x && button.rect.right <= metrics.box.right + 1);
    }
    assert.equal(metrics.columns, width <= 600 ? 1 : width <= 1180 ? 2 : 4);
    assert(metrics.metadata.every(n => n.size >= 14 && n.weight >= 400));
    assert.equal(metrics.overflow, false);
    assert.deepEqual(metrics.control, { help: '10.5px', button: '10.5px' }, 'shared financial context remains unchanged');
    const contrast = await page.evaluate(() => {
      // Use the darker page surface as a conservative bound for the light cards.
      const background = [244, 240, 233];
      const luminance = rgb => rgb.map(c => c / 255).map(c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4)
        .reduce((sum, c, i) => sum + c * [.2126, .7152, .0722][i], 0);
      return [...document.querySelectorAll('.operacao-paciente h4,.operacao-visita > summary')].map(node => {
        const color = getComputedStyle(node).color.match(/[\d.]+/g).slice(0, 3).map(Number);
        let opacity = 1;
        for (let parent = node; parent; parent = parent.parentElement) opacity *= Number(getComputedStyle(parent).opacity);
        const composite = color.map((c, i) => c * opacity + background[i] * (1 - opacity));
        return (luminance(background) + .05) / (luminance(composite) + .05);
      });
    });
    assert.equal(contrast.length, 3); assert(contrast.every(ratio => ratio >= 4.5), JSON.stringify(contrast));
    const buttons = page.locator('#app-procedure-context button'); await buttons.first().focus();
    assert.equal(await buttons.first().evaluate(n => parseFloat(getComputedStyle(n).outlineWidth)), 3);
    await page.keyboard.press('Tab'); assert.equal(await buttons.nth(1).evaluate(n => n === document.activeElement), true);
    await page.locator('#operacao-clinica-root').screenshot({ path: path.join(output, width + '-contexto.png'), animations: 'disabled' });
  } finally { await context.close(); }
});

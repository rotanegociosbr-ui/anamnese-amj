'use strict';

// Real v2 DOM/WebGL, synthetic same-origin host and fresh browser contexts only.
// Run: node --test painel/tests/rosto3d-browser.test.cjs
// No production host, authentication, password validation, backend or patient data.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE ||
  'C:/Users/NERI/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');

const root = fs.realpathSync(path.resolve(__dirname, '..', '..'));
const viewerPath = '/painel/rosto3d/v2/';
const origin = 'https://127.0.0.1:8766';
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'amj-rosto3d-browser-'));
const label = 'Ponto sintético — avaliação visual';
const pointNotes = 'Observação fictícia com acentos. Sem paciente, dose ou orientação clínica.';
const atlasLabel = 'Ponto sintético do atlas — camada muscular';
const atlasNotes = 'Marca ilustrativa no atlas. Base independente do rosto; sem interpretação clínica.';
const studyNotes = 'Estudo de QA inteiramente sintético; não é um prontuário real.';
const sourceFiles = ['index.html', 'preview.js', 'annotations.mjs', 'study.mjs', 'gesture.mjs',
  'layer-state.mjs', 'style.css', 'points.css'];
const sourceHashes = () => Object.fromEntries(sourceFiles.map(file => [file,
  crypto.createHash('sha256').update(fs.readFileSync(path.join(root, viewerPath, file))).digest('hex')]));
const report = { output, browser: '', syntheticOnly: true, hostMock: true,
  productionAuthenticationTested: false, productionBackendTested: false,
  productionPasswordProofTested: false, productionHostScriptTested: false,
  browserContexts: 'fresh non-persistent; no imported storage or user profile',
  sourcesBefore: sourceHashes(), sourcesAfter: null, runs: [] };
let browser;

const hostHTML = `<!doctype html><html lang="pt-BR"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>QA sintético — rosto 3D</title>
<style>body{margin:0;font:14px Arial;background:#fffdf9;color:#32251f}header{padding:10px;display:flex;gap:8px;align-items:center;flex-wrap:wrap}button{padding:10px;min-height:44px}iframe{display:block;width:100%;height:calc(100vh - 96px);min-height:650px;border:0}p{margin:0}</style>
<header><p>TESTE LOCAL · consulta fictícia · sem sessão real</p><button id="bind">Vincular consulta sintética</button><button id="reload">Recarregar o mesmo estudo</button></header>
<div id="frame-root"></div>
<script>
(() => {
  const protocolId = '11111111-1111-4111-8111-111111111111';
  let frame, bound = false, readyCount = 0, activityCount = 0;
  const records = new Map(), calls = [];
  const belongs = source => Boolean(frame && source === frame.contentWindow);
  function load(source) {
    if (!belongs(source) || !bound) return;
    calls.push({action:'open', protocolId});
    source.AMJRostoViewer.loadStudy(structuredClone(records.get(protocolId) || null),
      'CONSULTA SINTÉTICA · QA isolado');
  }
  window.AMJRosto3D = Object.freeze({
    frameAttached: belongs,
    frameAllowed: belongs,
    frameReady(source) { if (!belongs(source)) return; readyCount++; load(source); },
    activity(source) { if (belongs(source)) activityCount++; },
    async saveStudy(source, document, expectedVersion) {
      if (!belongs(source) || !bound) throw Error('Consulta sintética não vinculada.');
      const previous = records.get(protocolId);
      if (expectedVersion !== (previous?.version || 0)) throw Error('Conflito sintético de versão.');
      const saved = {version: expectedVersion + 1, document: structuredClone(document)};
      records.set(protocolId, saved);
      calls.push({action:'save', protocolId, expectedVersion, document: structuredClone(document)});
      return structuredClone(saved);
    }
  });
  function mount() {
    if (frame) frame.contentWindow.AMJRostoViewer?.dispose();
    const next = document.createElement('iframe');
    next.title = 'Viewer real v2 em host sintético';
    frame = next;
    next.src = '${viewerPath}index.html';
    document.getElementById('frame-root').replaceChildren(next);
  }
  document.getElementById('bind').onclick = () => { bound = true; if(frame.contentWindow.AMJRostoViewer?.ready()) load(frame.contentWindow); };
  document.getElementById('reload').onclick = mount;
  window.__qa = {snapshot: () => ({bound, readyCount, activityCount,
    calls: structuredClone(calls), stored: structuredClone(records.get(protocolId) || null)})};
  mount();
})();
</script></html>`;

const types = { '.html':'text/html', '.js':'text/javascript', '.mjs':'text/javascript',
  '.css':'text/css', '.json':'application/json', '.png':'image/png', '.ttf':'font/ttf', '.ico':'image/x-icon' };

async function isolate(context, run) {
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) {
      run.blockedExternal.push(url.origin + url.pathname);
      await route.abort('blockedbyclient');
      return;
    }
    if (url.pathname === '/__qa__/') {
      await route.fulfill({contentType:'text/html', body:hostHTML});
      return;
    }
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const file = path.resolve(root, relative), ext = path.extname(file).toLowerCase();
    const underRoot = file.startsWith(root + path.sep);
    const allowed = (url.pathname.startsWith(viewerPath) ||
      ['/Poppins-Regular.ttf', '/CormorantGaramond-Variable.ttf'].includes(url.pathname)) &&
      !relative.split(/[\\/]/).some(part => part.startsWith('.')) && underRoot && types[ext];
    if (!allowed || !fs.existsSync(file) || !fs.statSync(file).isFile() ||
        !fs.realpathSync(file).startsWith(root + path.sep)) {
      run.missingAssets.push(url.pathname);
      await route.fulfill({status:404, contentType:'text/plain', body:'Not present in isolated fixture'});
      return;
    }
    run.servedLocal++;
    await route.fulfill({contentType:types[ext], body:fs.readFileSync(file)});
  });
  if (typeof context.routeWebSocket === 'function') {
    await context.routeWebSocket('**/*', socket => socket.close());
  }
}

async function realViewer(page) {
  await page.waitForFunction(() => {
    const child = document.querySelector('iframe')?.contentWindow;
    return child?.AMJRostoViewer?.ready() || child?.AMJRostoFailed;
  }, null, {timeout:45000});
  const frame = page.frames().find(item => item.url().includes(viewerPath));
  assert.ok(frame, 'real viewer iframe is mounted');
  const state = await frame.evaluate(() => ({ready:window.AMJRostoViewer?.ready(),
    failed:window.AMJRostoFailed, loading:document.querySelector('#loading').textContent}));
  assert.equal(state.ready, true, JSON.stringify(state));
  assert.ok(!state.failed, JSON.stringify(state));
  return frame;
}

async function measure(frame) {
  return frame.evaluate(() => ({viewport:innerWidth,
    documentWidth:document.documentElement.scrollWidth,
    canvas: (() => { const c=document.querySelector('#viewer canvas'); return {width:c.width,height:c.height}; })(),
    pointNameDisabled:document.querySelector('#point-name').disabled,
    saveDisabled:document.querySelector('#study-save').disabled,
    localStorageKeys:Object.keys(localStorage), sessionStorageKeys:Object.keys(sessionStorage)}));
}

async function tapCanvas(page, frame, profile, xRatio, yRatio) {
  const canvas = frame.locator('#viewer canvas');
  await canvas.scrollIntoViewIfNeeded();
  const box = await canvas.boundingBox();
  assert.ok(box && box.width > 200 && box.height > 200);
  const x = box.x + box.width * xRatio, y = box.y + box.height * yRatio;
  if (profile.hasTouch) await page.touchscreen.tap(x, y);
  else await page.mouse.click(x, y);
}

async function selectSavedPoint(frame, point) {
  await frame.locator('#point-list').selectOption(point.id);
  await frame.waitForFunction(({id, mode}) =>
    document.querySelector('#point-list').value === id &&
    document.getElementById(mode === 'anatomy' ? 'anatomy' : 'appearance').getAttribute('aria-pressed') === 'true' &&
    document.querySelector('#point-status').textContent.startsWith(mode === 'anatomy' ? 'Ponto no atlas.' : 'Ponto no rosto com pele.'),
  {id:point.id, mode:point.mode}, {timeout:45000});
  // The production reveal animation lasts 320 ms; allow it to settle for evidence.
  await frame.waitForTimeout(400);
}

before(async () => {
  const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
  const executablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH ||
    (fs.existsSync(chromium.executablePath()) ? chromium.executablePath() : edge);
  assert.ok(fs.existsSync(executablePath), 'No browser installed; do not download automatically.');
  browser = await chromium.launch({headless:true, executablePath,
    args:['--disable-background-networking','--disable-component-update','--disable-default-apps',
      '--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  report.browser = browser.version();
  console.log('Synthetic-only browser evidence: ' + output);
});

after(async () => {
  await browser?.close();
  report.sourcesAfter = sourceHashes();
  report.sourcesChangedDuringRun = JSON.stringify(report.sourcesBefore) !== JSON.stringify(report.sourcesAfter);
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({output, browser:report.browser, sourcesChangedDuringRun:report.sourcesChangedDuringRun,
    runs:report.runs.map(({name,status,error,screenshots,missingAssets,blockedExternal,fontResponses}) =>
      ({name,status,error,screenshots,missingAssets,blockedExternal,fontResponses}))}, null, 2));
});

for (const profile of [
  {name:'desktop', viewport:{width:1440,height:1000}, isMobile:false, hasTouch:false},
  {name:'mobile', viewport:{width:390,height:844}, isMobile:true, hasTouch:true}
]) {
  test(`${profile.name}: skin/atlas points, save, reload and automatic layer reveal`, {timeout:120000}, async () => {
    const run = {name:profile.name, status:'running', screenshots:[], missingAssets:[],
      blockedExternal:[], pageErrors:[], fontResponses:[], servedLocal:0};
    report.runs.push(run);
    const context = await browser.newContext({viewport:profile.viewport, isMobile:profile.isMobile,
      hasTouch:profile.hasTouch, serviceWorkers:'block',
      locale:'pt-BR', timezoneId:'America/Sao_Paulo', deviceScaleFactor:1});
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    page.on('pageerror', error => run.pageErrors.push(error.message));
    page.on('response', response => { if(new URL(response.url()).pathname.endsWith('.ttf')) {
      run.fontResponses.push({path:new URL(response.url()).pathname, status:response.status()});
    }});
    page.on('dialog', dialog => dialog.type() === 'beforeunload' ? dialog.accept() : dialog.dismiss());
    await isolate(context, run);
    try {
      await page.goto(origin + '/__qa__/', {waitUntil:'load', timeout:45000});
      let frame = await realViewer(page);
      assert.equal(await frame.locator('#study-save').isDisabled(), true, 'free study cannot save');
      await page.locator('#bind').click();
      await frame.waitForFunction(() => document.querySelector('#point-context').textContent.includes('CONSULTA SINTÉTICA'));
      assert.equal(await frame.locator('#study-save').isDisabled(), false);
      await frame.locator('[data-tool="mark"]').click();
      await tapCanvas(page, frame, profile, .5, .42);
      await frame.waitForFunction(() => window.AMJRostoViewer.getStudy().points.length === 1);
      await frame.locator('#point-name').fill(label);
      await frame.locator('#point-notes').fill(pointNotes);
      await frame.locator('#study-notes').fill(studyNotes);
      assert.equal(await frame.evaluate(() => window.AMJRostoViewer.hasChanges()), true);
      await frame.locator('#anatomy').click();
      await frame.waitForFunction(() => document.querySelector('#loading').hidden &&
        document.querySelector('#anatomy').getAttribute('aria-pressed') === 'true', null, {timeout:45000});
      await frame.locator('[data-preset="muscles"]').click();
      await frame.locator('[data-tool="mark"]').click();
      for (const [x,y] of [[.5,.42], [.45,.35], [.55,.35], [.4,.5], [.6,.5]]) {
        await tapCanvas(page, frame, profile, x, y);
        if (await frame.evaluate(() => window.AMJRostoViewer.getStudy().points.length === 2)) break;
      }
      await frame.waitForFunction(() => window.AMJRostoViewer.getStudy().points.length === 2);
      await frame.locator('#point-name').fill(atlasLabel);
      await frame.locator('#point-notes').fill(atlasNotes);
      const beforeSave = await frame.evaluate(() => window.AMJRostoViewer.getStudy());
      assert.equal(beforeSave.points.length, 2);
      assert.equal(beforeSave.points[0].mode, 'appearance');
      assert.equal(beforeSave.points[0].label, label);
      const atlasPoint = beforeSave.points[1];
      assert.equal(atlasPoint.mode, 'anatomy');
      const atlasData = JSON.parse(fs.readFileSync(path.join(root, viewerPath, 'assets/anatomy.json'), 'utf8'));
      assert.equal(atlasData.meshes.find(mesh => mesh.id === atlasPoint.meshId)?.layer, 'muscles');
      await frame.locator('#study-save').click();
      await frame.waitForFunction(() => document.querySelector('#point-status').textContent.includes('Salvo no prontuário'));
      const saved = await page.evaluate(() => window.__qa.snapshot());
      assert.equal(saved.calls.filter(call => call.action === 'save').length, 1);
      assert.deepEqual(saved.stored.document, beforeSave);
      assert.equal(saved.stored.version, 1);
      assert.equal(saved.calls.find(call => call.action === 'save').expectedVersion, 0);
      assert.equal(await frame.evaluate(() => window.AMJRostoViewer.hasChanges()), false);
      const firstReadyCount = saved.readyCount;
      await page.locator('#reload').click();
      await page.waitForFunction(previous => window.__qa.snapshot().readyCount > previous, firstReadyCount, {timeout:45000});
      frame = await realViewer(page);
      const reloaded = await frame.evaluate(() => window.AMJRostoViewer.getStudy());
      assert.deepEqual(reloaded, beforeSave, 'same mesh anchor, id, point text and general notes restored');
      assert.equal(await frame.locator('#appearance').getAttribute('aria-pressed'), 'true');
      await selectSavedPoint(frame, atlasPoint);
      assert.equal(await frame.locator('#muscles').isChecked(), true);
      assert.equal(await frame.locator('#muscle-select').inputValue(), atlasPoint.meshId);
      assert.ok(Number(await frame.locator('#opacity').inputValue()) <= 23);
      assert.equal(await frame.locator('#isolate').textContent(), 'Mostrar camadas');
      assert.equal(await frame.locator('#point-name').inputValue(), atlasLabel);
      assert.equal(await frame.locator('#point-notes').inputValue(), atlasNotes);
      assert.deepEqual(await frame.evaluate(() => window.AMJRostoViewer.getStudy()), beforeSave,
        'revealing the saved atlas point must not modify any mesh anchor or text');
      const atlasScreenshot = path.join(output, `${profile.name}-atlas-point-revealed.png`);
      await frame.locator('#viewer').screenshot({path:atlasScreenshot});
      run.screenshots.push(atlasScreenshot);
      run.atlasLayout = await frame.evaluate(() => {
        const label = document.querySelector('#selection').getBoundingClientRect();
        const views = document.querySelector('.views').getBoundingClientRect();
        return {labelTop:label.top, labelBottom:label.bottom, viewsTop:views.top, viewsBottom:views.bottom,
          overlaps:label.left < views.right && label.right > views.left && label.top < views.bottom && label.bottom > views.top};
      });
      assert.equal(run.atlasLayout.overlaps, false, 'selected structure label must not overlap camera-angle buttons');
      // Explicitly leave the atlas, then select its saved point again from appearance.
      await frame.locator('#appearance').click();
      await frame.waitForFunction(() => document.querySelector('#loading').hidden &&
        document.querySelector('#appearance').getAttribute('aria-pressed') === 'true');
      await selectSavedPoint(frame, atlasPoint);
      assert.equal(await frame.locator('#muscle-select').inputValue(), atlasPoint.meshId);
      assert.deepEqual(await frame.evaluate(() => window.AMJRostoViewer.getStudy()), beforeSave);
      await selectSavedPoint(frame, reloaded.points[0]);
      assert.equal(await frame.locator('#point-name').inputValue(), label);
      assert.equal(await frame.locator('#point-notes').inputValue(), pointNotes);
      assert.equal(await frame.locator('#study-notes').inputValue(), studyNotes);
      assert.equal(await frame.evaluate(() => window.AMJRostoViewer.hasChanges()), false);
      await frame.locator('#study-save').click();
      await frame.waitForFunction(() => document.querySelector('#point-status').textContent.includes('já está salvo'));
      const final = await page.evaluate(() => window.__qa.snapshot());
      assert.equal(final.calls.filter(call => call.action === 'save').length, 1, 'unchanged save does not call host twice');
      assert.equal(final.calls.filter(call => call.action === 'open').length, 2);
      assert.ok(final.activityCount > 0, 'real browser interactions reached activity callback');
      run.measurements = await measure(frame);
      assert.ok(run.measurements.canvas.width > 0 && run.measurements.canvas.height > 0);
      assert.ok(run.measurements.documentWidth <= run.measurements.viewport + 1, 'no horizontal document overflow');
      assert.deepEqual(run.measurements.localStorageKeys, []);
      assert.deepEqual(run.measurements.sessionStorageKeys, []);
      assert.deepEqual(run.blockedExternal, [], 'viewer must not request external destinations');
      assert.deepEqual(run.pageErrors, []);
      await frame.evaluate(() => document.fonts.ready);
      assert.deepEqual(run.missingAssets, [], 'all production viewer resources must resolve without remapping');
      for (const font of ['Poppins-Regular.ttf', 'CormorantGaramond-Variable.ttf']) {
        assert.ok(run.fontResponses.some(item => item.path === viewerPath + font && item.status === 200), font + ' served locally with HTTP 200');
      }
      assert.ok(run.fontResponses.every(item => item.status === 200));
      run.atlasReveal = {point:atlasPoint, layer:'muscles', automaticModeAndLayer:true, unchangedSerialization:true};
      run.saved = final;
      for (const [name, selector] of [['face-reloaded','#viewer'], ['point-editor-reloaded','.point-editor'],
        ['saved-status-reloaded','#point-status']]) {
        const screenshot = path.join(output, `${profile.name}-${name}.png`);
        await frame.locator(selector).screenshot({path:screenshot});
        run.screenshots.push(screenshot);
      }
      run.status = 'passed';
    } catch (error) {
      run.status = 'failed'; run.error = error.stack;
      const screenshot = path.join(output, `${profile.name}-failure.png`);
      try { await page.screenshot({path:screenshot, fullPage:true}); run.screenshots.push(screenshot); } catch (_) {}
      throw error;
    } finally { await context.close(); }
  });
}

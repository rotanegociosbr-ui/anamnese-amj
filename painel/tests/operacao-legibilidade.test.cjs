'use strict';
// CSS-only visual regression: actual shell markup/styles, synthetic text, no app
// initialization, clinical data, sessions or network calls.
const {test,before,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm');
const {chromium}=require(process.env.PLAYWRIGHT_PACKAGE||'C:/Users/NERI/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const root=path.resolve(__dirname,'..'),css=fs.readFileSync(path.join(root,'operacao.css'),'utf8'),source=fs.readFileSync(path.join(root,'operacao.js'),'utf8');
const html=fs.readFileSync(path.join(root,'index.html'),'utf8'),globalCss=html.match(/<style>([\s\S]*?)<\/style>/)[1],shellCss=fs.readFileSync(path.join(root,'app-shell.css'),'utf8');
const start=source.indexOf('  function shell() {'),end=source.indexOf('\n  function ',start+20);
assert(start>=0&&end>start,'actual presentation shell must be found');
const markup=vm.runInNewContext(source.slice(start,end)+'\nshell()');
const output=fs.mkdtempSync(path.join(os.tmpdir(),'amj-operacao-legibilidade-'));let browser;
before(async()=>{const executablePath=process.env.PLAYWRIGHT_EXECUTABLE_PATH||(fs.existsSync(chromium.executablePath())?chromium.executablePath():'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe');browser=await chromium.launch({headless:true,executablePath});console.log('Procedure typography evidence: '+output);});
after(async()=>{await browser?.close();});
for(const width of [1366,1024,390])test('procedures readable without horizontal clipping at '+width+'px',{timeout:12000},async()=>{
 const context=await browser.newContext({viewport:{width,height:1000},isMobile:width<600,hasTouch:width<600}),page=await context.newPage();await context.route('**/*',r=>r.abort());
 try{
  await page.setContent('<!doctype html><html lang="pt-BR"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>'+globalCss+'\n'+shellCss+'\n'+css+'\nhtml{font-size:16px}body{margin:0;font-family:Poppins,Arial,sans-serif}.css-preview{box-sizing:border-box;max-width:1080px;margin:auto;padding:20px}@media(min-width:940px) and (max-width:1180px){.css-preview{max-width:760px}}@media(max-width:600px){.css-preview{padding:14px}}</style></head><body><main class="app-shell-content css-preview">'+markup+'</main></body></html>');
  const primary=page.locator('.operacao-formulario-principal');await primary.locator(':scope > summary').click();
  await page.evaluate(()=>{
   const form=document.querySelector('[data-form-atendimento]');
   form.querySelector('[name="cliente_id"]').innerHTML='<option>Paciente sintética — verificação de legibilidade</option>';
   form.querySelector('[name="responsavel_id"]').innerHTML='<option>Profissional responsável sintética</option>';
   form.querySelector('[name="procedimento"]').value='Procedimento sintético registrado';form.querySelector('[name="realizado_em"]').value='2026-09-06T14:30';
   document.querySelector('[data-atendimento-contexto]').textContent='Atendimento selecionado: Paciente sintética · 06/09/2026 às14:30 · Procedimento sintético';
   document.querySelector('[data-fotos-atalho-atendimento]').innerHTML='<option>Paciente sintética · 06/09/2026 · Procedimento sintético</option>';
  });
  const metrics=await page.evaluate(()=>{
   const visible=n=>n.getClientRects().length>0;
   const fields=[...document.querySelectorAll('.operacao-clinica input:not([type="hidden"]):not([type="checkbox"]),.operacao-clinica select,.operacao-clinica textarea')].filter(visible);
   return {fields:fields.map(n=>({size:parseFloat(getComputedStyle(n).fontSize),height:n.getBoundingClientRect().height,weight:Number(getComputedStyle(n).fontWeight)})),labels:[...document.querySelectorAll('.operacao-clinica label')].filter(visible).map(n=>parseFloat(getComputedStyle(n).fontSize)),buttons:[...document.querySelectorAll('.operacao-botao')].filter(visible).map(n=>({size:parseFloat(getComputedStyle(n).fontSize),height:n.getBoundingClientRect().height})),overflow:document.documentElement.scrollWidth>innerWidth+1};
  });
  assert(metrics.fields.length>=7);assert(metrics.fields.every(f=>f.size>=16&&f.height>=44&&f.weight<=600),JSON.stringify(metrics.fields));
  assert(metrics.labels.every(size=>size>=14),JSON.stringify(metrics.labels));assert(metrics.buttons.every(b=>b.size>=14&&b.height>=44),JSON.stringify(metrics.buttons));assert.equal(metrics.overflow,false);
  const input=primary.locator('[name="procedimento"]');await input.focus();assert.equal(await input.evaluate(n=>parseFloat(getComputedStyle(n).outlineWidth)),3);
  await primary.screenshot({path:path.join(output,width+'-principal.png'),animations:'disabled'});
  await primary.locator('[data-atendimento-vinculos] > summary').click();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,'expanded link fields remain within the page');
  await primary.screenshot({path:path.join(output,width+'-vinculos.png'),animations:'disabled'});
  const secondary=page.locator('.operacao-secundarios').filter({has:page.locator('[data-form-retorno]')});
  await secondary.locator(':scope > summary').click();
  const grid=await secondary.locator('.operacao-grade').evaluate(n=>getComputedStyle(n).gridTemplateColumns.split(' ').length);
  assert.equal(grid,width<=1180?1:2);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,'expanded secondary forms do not clip');
  const summaries=page.locator('.operacao-secundarios > summary, [data-atendimento-editor] > summary');
  assert(await summaries.count()>=3);
  for(let index=0;index<await summaries.count();index++){
   const summary=summaries.nth(index);await summary.evaluate(node=>{node.parentElement.open=false;});
   await summary.focus();assert.equal(await summary.evaluate(node=>parseFloat(getComputedStyle(node).outlineWidth)),3);
   await page.keyboard.press('Enter');assert.equal(await summary.evaluate(node=>node.parentElement.open),true);
   await page.keyboard.press('Space');assert.equal(await summary.evaluate(node=>node.parentElement.open),false);
  }
  const errorMetrics=await page.evaluate(()=>{
   const node=document.querySelector('[data-operacao-status]');node.classList.add('erro');
   node.textContent='Não foi possível salvar agora. O preenchimento foi mantido. Confira a conexão e tente novamente.';
   const style=getComputedStyle(node);return {fontSize:parseFloat(style.fontSize),lineHeight:parseFloat(style.lineHeight),color:style.color,clipped:node.scrollWidth>node.clientWidth+1};
  });
  assert.equal(errorMetrics.fontSize,16,'a global .erro rule must not shrink operational recovery messages');
  assert(errorMetrics.lineHeight>=24);assert.equal(errorMetrics.color,'rgb(161, 45, 45)');assert.equal(errorMetrics.clipped,false);
  await page.locator('[data-operacao-status]').screenshot({path:path.join(output,width+'-erro.png'),animations:'disabled'});
 }finally{await context.close();}
});

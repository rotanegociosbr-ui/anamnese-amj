'use strict';
// Fresh page, server-shaped historical records, actual navigation/card clicks.
// No real sessions, patient data or outgoing service requests are used.
const {test,before,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {chromium}=require(process.env.PLAYWRIGHT_PACKAGE||'C:/Users/NERI/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const root=fs.realpathSync(path.resolve(__dirname,'../..')),origin='https://127.0.0.1:8767',output=fs.mkdtempSync(path.join(os.tmpdir(),'amj-existing-cards-'));
const types={'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.json':'application/json','.png':'image/png','.jpg':'image/jpeg','.svg':'image/svg+xml','.ttf':'font/ttf','.woff2':'font/woff2'};
const patientId='11111111-1111-4111-8111-111111111111',productId='22222222-2222-4222-8222-222222222222';
const protocols=['draft','signed'].map((status,i)=>({
 id:`33333333-3333-4333-8333-33333333333${i}`,patient_id:patientId,professional_id:'44444444-4444-4444-8444-444444444444',appointment_id:null,
 procedure_kind:'toxina_botulinica',complaint:'Queixa sintética '+status,anamnesis:{allergies:'Somente fixture'},technique_notes:'Anotação existente '+status,
 procedure_date:'2026-09-01',return_date:'2026-09-15',care_notes:'Orientação sintética',draft_products:status==='draft'?[{product_id:productId,lot:'LOTE EXISTENTE',expiry:'2027-01-31',amount:2,unit:'U',position:1}]:null,
 status,version:i+5,archived_at:null,archive_reason:null,archived_by:null,created_at:'2026-09-01T13:00:00+00:00',updated_at:'2026-09-01T13:00:00+00:00',
 produtos_rascunho:status==='draft'?[{product_id:productId,lot:'LOTE EXISTENTE',expiry:'2027-01-31',amount:2,unit:'U',position:1}]:null,
 paciente:{id:patientId,nome:'Paciente fixture existente',status:'active',arquivado_em:null},
 produtos:status==='signed'?[{id:'55555555-5555-4555-8555-555555555555',protocol_id:`33333333-3333-4333-8333-33333333333${i}`,product_id:productId,brand_id:null,product_name_snapshot:'Produto histórico fixture',brand_name_snapshot:null,anvisa_registration_snapshot:null,lot:'LOTE EXISTENTE',expiry:'2027-01-31',amount:2,unit:'U',cost_snapshot:'5.0000',position:1,created_at:'2026-09-01T13:00:00+00:00'}]:[],
 fotos:[],fotos_resumo:{total:0,ativas:0,arquivadas:0,produtos_utilizados:0},consentimentos_atuais:{data_processing:true,clinical_photography:false},consentimentos:[]
}));
protocols.push(...protocols.map((p,i)=>({...p,id:`66666666-6666-4666-8666-66666666666${i}`,archived_at:'2026-09-02T13:00:00+00:00',archive_reason:'Arquivamento sintético',archived_by:'44444444-4444-4444-8444-444444444444',technique_notes:'Anotação arquivada '+p.status})));
const otherPatientId='88888888-8888-4888-8888-888888888888';
protocols.push({...protocols[0],id:'77777777-7777-4777-8777-777777777777',patient_id:otherPatientId,paciente:{...protocols[0].paciente,id:otherPatientId}});
const archivedOnly=Array.from({length:3},(_,i)=>({...protocols[2],id:`99999999-9999-4999-8999-99999999999${i}`,technique_notes:'Histórico somente arquivado '+i,status:'draft'}));
let browser;
before(async()=>{const executablePath=process.env.PLAYWRIGHT_EXECUTABLE_PATH||(fs.existsSync(chromium.executablePath())?chromium.executablePath():'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe');browser=await chromium.launch({headless:true,executablePath,args:['--disable-background-networking','--disable-component-update','--disable-default-apps']});console.log('Existing cards evidence: '+output);});
after(async()=>{await browser?.close();});
for(const mobile of [false,true])test('existing SQL-shaped draft and signed consultations open by real card clicks — '+(mobile?'mobile':'desktop'),{timeout:40000},async()=>{
 const context=await browser.newContext({viewport:mobile?{width:390,height:844}:{width:1365,height:1000},isMobile:mobile,hasTouch:mobile,serviceWorkers:'block',locale:'pt-BR'}),page=await context.newPage(),calls=[],errors=[];
 let onlyArchived=false;
 page.setDefaultTimeout(6000);page.on('pageerror',e=>errors.push(e.message));
 await context.route('**/*',async route=>{
  const url=new URL(route.request().url());
  if(url.hostname==='rjxtxoqprnumouqakxbc.supabase.co'&&url.pathname.startsWith('/functions/v1/')){
   const body=route.request().postDataJSON()||{};calls.push({...body,endpoint:url.pathname});let result={};
   if(body.acao==='listar_clientes')result={clientes:[patientId,otherPatientId].map(id=>({id,nome:'Paciente fixture existente',ativo:id===patientId,status:id===patientId?'active':'archived',archived_at:id===patientId?null:'2026-09-02T13:00:00+00:00'}))};
   else if(body.acao==='listar_catalogos')result={produtos:[{id:productId,nome:'Produto fixture',tipo:'toxina',unidade:'U',apresentacao:'Frasco',ativo:true}],produtos_rascunho:[],marcas:[],fornecedores:[]};
   else if(body.acao==='listar_estoque')result={estoque:[{produto_id:productId,lote:'LOTE EXISTENTE',validade:'2027-01-31',saldo:20,unidade:'U'}]};
   else if(body.acao==='listar'&&url.pathname.endsWith('/prontuario-fichas'))result={ok:true,protocolos:onlyArchived?archivedOnly:protocols,paginacao:{pagina:1,por_pagina:100,tem_mais:false}};
   else if(body.acao==='listar_fotos')result={ok:true,fotos:[],paginacao:{pagina:1,tem_mais:false}};
   await route.fulfill({json:result});return;
  }
  if(url.origin!==origin){await route.abort('blockedbyclient');return;}
  const file=path.resolve(root,decodeURIComponent(url.pathname).replace(/^\/+/,'')),type=types[path.extname(file)];
  if(!file.startsWith(root+path.sep)||!type||!fs.existsSync(file)||!fs.statSync(file).isFile()){await route.fulfill({status:404,body:'Fixture only'});return;}
  await route.fulfill({contentType:type,body:fs.readFileSync(file)});
 });
 const boot=async()=>{
  await page.waitForFunction(()=>window.AMJProntuario&&window.AMJShell&&typeof authInicioConcluido!=='undefined'&&authInicioConcluido);
  await page.evaluate(()=>{
   modoAcesso='auth';identidadeBackend={role:'owner'};cabecalhosAcesso=async()=>({'Content-Type':'application/json'});
   sessionStorage.setItem('amj.app-shell.route','prontuarios');
   document.querySelector('#tela-login').classList.add('oculto');document.querySelector('#tela-login').hidden=true;document.querySelector('#tela-lista').classList.remove('oculto');document.querySelector('#tela-lista').hidden=false;
   AMJProntuario.atualizarAcesso();
  });
  await page.waitForFunction(()=>document.body.classList.contains('app-shell-authenticated'));
  if(mobile)await page.locator('.app-shell-menu-button').click();
  await page.locator('[data-shell-route="prontuarios"]:visible').first().click();
 };
 try{
  await page.goto(origin+'/painel/index.html',{waitUntil:'load'});await boot();
  await page.waitForFunction(()=>AMJShell.currentRoute()==='prontuarios'&&document.querySelectorAll('[data-prontuario-consulta]').length>=3);
  assert.equal(await page.locator('[data-prontuario-atualizar-pendentes]').count(),0,'newly loaded existing records are never incorrectly stale');
  assert.equal(await page.locator('#prontuario-mostrar-arquivados').isChecked(),true,'saved archived history is visible by default');
  await page.waitForFunction(()=>document.querySelectorAll('[data-prontuario-consulta]').length===5);
  assert.equal(await page.locator('#prontuario-editor').evaluate(n=>n.open),false,'entry opens saved history instead of an empty editor');
  await page.screenshot({path:path.join(output,(mobile?'mobile':'desktop')+'-history-list.png'),fullPage:true,animations:'disabled'});
  let unexpectedDialogs=0;const rejectUnexpectedDialog=dialog=>{unexpectedDialogs++;void dialog.dismiss();};page.on('dialog',rejectUnexpectedDialog);
  await page.locator('#prontuario-novo').click();assert.equal(await page.locator('#prontuario-editor').evaluate(n=>n.open),true);assert.equal(unexpectedDialogs,0,'a genuinely empty new form needs no discard confirmation');page.off('dialog',rejectUnexpectedDialog);
  await page.locator('#prontuario-editor > summary').click();
  for(const protocol of protocols){
   const card=page.locator('[data-prontuario-consulta="'+protocol.id+'"]');
   await card.locator(':scope > summary').click();await page.waitForFunction(id=>document.querySelector('[data-prontuario-consulta="'+id+'"]')?.open,protocol.id);
   await card.locator('[data-prontuario-editar="'+protocol.id+'"]').click();
   await page.waitForFunction(id=>document.querySelector('#prontuario-id').value===id,protocol.id);
   assert.equal(await page.locator('#prontuario-editor').evaluate(n=>n.open),true);
   assert.equal(await page.locator('#prontuario-paciente').inputValue(),protocol.patient_id);assert.equal(await page.locator('#prontuario-versao').inputValue(),String(protocol.version));
   if(protocol.patient_id===otherPatientId)assert.equal(await page.locator('#prontuario-paciente [data-prontuario-paciente-historico]').count(),1,'an inactive historical patient keeps the exact existing binding');
   assert.equal(await page.locator('#prontuario-notas').inputValue(),protocol.technique_notes);assert.equal(await page.locator('.prontuario-produto-lote').inputValue(),'LOTE EXISTENTE');
   assert.equal(await page.locator('#prontuario-notas').isDisabled(),protocol.status==='signed'||Boolean(protocol.archived_at));
   assert.equal(await page.locator('.prontuario-rascunho-nota').isVisible(),protocol.status!=='signed'&&!protocol.archived_at,'read-only history never invites editing or saving');
   assert.equal(await page.locator('#prontuario-foto-arquivo').isEnabled(),!protocol.archived_at,'archived consultation cannot attach photos; active signed consultation still can');
   if(protocol.archived_at){
    assert.doesNotMatch(await card.locator(':scope > summary').textContent(),/Em andamento|Completar:|Foto pendente/);
    assert.equal(await page.locator('#prontuario-foto-form').isVisible(),false);
    assert.equal(await page.locator('#prontuario-salvar').isVisible(),false);
    assert.equal(await card.locator('[data-prontuario-finalizar],[data-prontuario-adicionar-fotos],[data-prontuario-consentimento-fotos],[data-prontuario-remover-foto],[data-prontuario-restaurar-foto]').count(),0);
    await page.evaluate(()=>{document.querySelector('#prontuario-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));document.querySelector('#prontuario-foto-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));});
    assert.match(await page.locator('#prontuario-form-status').textContent(),/arquivada.*somente para leitura/i);assert.match(await page.locator('#prontuario-foto-status').textContent(),/arquivada.*somente para leitura/i);
   }
   assert(await page.locator('#prontuario-form-titulo').isVisible());
   await page.locator('#prontuario-editor').screenshot({path:path.join(output,(mobile?'mobile':'desktop')+'-'+protocol.status+(protocol.archived_at?'-archived':'')+'.png'),animations:'disabled'});
   if(protocol.archived_at&&protocol.status==='draft')await page.screenshot({path:path.join(output,(mobile?'mobile':'desktop')+'-archived-open-full.png'),fullPage:true,animations:'disabled'});
   await page.locator('#prontuario-cancelar-edicao').click();
   assert.equal(await page.locator('#prontuario-editor').evaluate(n=>n.open),false,'closing historical data does not silently start a new draft');
   assert.equal(await page.locator('#prontuario-paciente [data-prontuario-paciente-historico]').count(),0,'historical patient options cannot leak into new consultations');
  }
  const editFirst=page.locator('[data-prontuario-editar="'+protocols[0].id+'"]');await editFirst.click();await page.locator('#prontuario-notas').fill('Anotação local ainda não salva.');
  if(mobile)await page.locator('.app-shell-menu-button').click();await page.locator('[data-shell-route="clientes"]:visible').first().click();
  await page.locator('[data-financeiro-prontuario="'+patientId+'"]').click();
  await page.waitForFunction(()=>AMJShell.currentRoute()==='prontuarios'&&document.querySelectorAll('[data-prontuario-consulta]').length===4);
  assert.equal(await page.locator('[data-prontuario-consulta="77777777-7777-4777-8777-777777777777"]').count(),0,'history is scoped by exact patient ID, even for equal names');
  assert.equal(await page.locator('#prontuario-notas').inputValue(),'Anotação local ainda não salva.');assert.equal(await page.locator('#prontuario-id').inputValue(),protocols[0].id);
  assert(await page.locator('#prontuario-contexto-paciente').isVisible());await page.locator('#prontuario-limpar-paciente').click();
  assert.equal(await page.locator('[data-prontuario-consulta]').count(),5);assert.equal(await page.locator('#prontuario-notas').inputValue(),'Anotação local ainda não salva.');
  page.once('dialog',dialog=>dialog.dismiss());await page.locator('#prontuario-novo').click();
  assert.equal(await page.locator('#prontuario-notas').inputValue(),'Anotação local ainda não salva.','cancelling new consultation preserves the existing editor');
  onlyArchived=true;await page.reload({waitUntil:'load'});await boot();
  await page.waitForFunction(()=>AMJShell.currentRoute()==='prontuarios'&&document.querySelectorAll('[data-prontuario-consulta]').length===3);
  assert.equal(await page.locator('#prontuario-mostrar-arquivados').isChecked(),true);
  assert.doesNotMatch(await page.locator('#prontuario-lista').textContent(),/Nenhuma consulta encontrada|Em andamento|Foto pendente/);
  await page.screenshot({path:path.join(output,(mobile?'mobile':'desktop')+'-only-three-archived-list.png'),fullPage:true,animations:'disabled'});
  for(const protocol of archivedOnly){
   const card=page.locator('[data-prontuario-consulta="'+protocol.id+'"]');await card.locator(':scope > summary').click();await card.locator('[data-prontuario-editar]').click();
   assert.equal(await page.locator('#prontuario-id').inputValue(),protocol.id);assert.equal(await page.locator('#prontuario-notas').inputValue(),protocol.technique_notes);assert.equal(await page.locator('#prontuario-notas').isDisabled(),true);
   assert.equal(await page.locator('#prontuario-foto-form').isVisible(),false);assert.equal(await page.locator('#prontuario-salvar').isVisible(),false);
   await page.locator('#prontuario-cancelar-edicao').click();
  }
  assert.deepEqual(errors,[]);assert.equal(calls.filter(c=>c.endpoint.endsWith('/prontuario-fichas')&&!['listar','listar_fotos'].includes(c.acao)).length,0,'opening and blocked submits must not issue clinical writes');
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2));
 }catch(error){await page.screenshot({path:path.join(output,(mobile?'mobile':'desktop')+'-failure.png'),fullPage:true});console.error('Existing card failure',JSON.stringify({errors,route:await page.evaluate(()=>window.AMJShell?.currentRoute()),status:await page.locator('#prontuario-status').textContent(),formStatus:await page.locator('#prontuario-form-status').textContent()}));throw error;}finally{await context.close();}
});

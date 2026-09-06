'use strict';
// Actual page/modules, fresh browser contexts, wholly synthetic intercepted APIs.
const {test,before,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {chromium}=require(process.env.PLAYWRIGHT_PACKAGE||'C:/Users/NERI/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const root=fs.realpathSync(path.resolve(__dirname,'../..')),origin='https://127.0.0.1:8767',output=fs.mkdtempSync(path.join(os.tmpdir(),'amj-draft-forms-'));
const types={'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.json':'application/json','.png':'image/png','.jpg':'image/jpeg','.svg':'image/svg+xml','.ttf':'font/ttf','.woff2':'font/woff2'};
let browser;
before(async()=>{const executablePath=process.env.PLAYWRIGHT_EXECUTABLE_PATH||(fs.existsSync(chromium.executablePath())?chromium.executablePath():'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe');browser=await chromium.launch({headless:true,executablePath,args:['--disable-background-networking','--disable-component-update','--disable-default-apps']});console.log('Synthetic draft UI evidence: '+output);});
after(async()=>{await browser?.close();});
for(const mobile of [false,true])test('actual forms draft save/reopen without duplication — '+(mobile?'mobile':'desktop'),{timeout:60000},async()=>{
 const context=await browser.newContext({viewport:mobile?{width:390,height:844}:{width:1365,height:1000},isMobile:mobile,hasTouch:mobile,serviceWorkers:'block',locale:'pt-BR'}),page=await context.newPage(),calls=[],errors=[];
 const patientId='11111111-1111-4111-8111-111111111111',clients=[{id:patientId,nome:'Paciente sintética QA',ativo:true}],suppliers=[],products=[],protocols=[],inventory=[];let serial=1,photoFailure=true,protocolReadFailure=false;
 const nextId=()=> '22222222-2222-4222-8222-'+String(++serial).padStart(12,'0');
 page.setDefaultTimeout(10000);
 page.on('pageerror',error=>errors.push(error.message));page.on('dialog',dialog=>dialog.dismiss());
 await context.route('**/*',async route=>{
  const url=new URL(route.request().url());
  if(url.hostname==='rjxtxoqprnumouqakxbc.supabase.co'&&url.pathname.startsWith('/functions/v1/')){
   const contentType=route.request().headers()['content-type']||'';let body={};
   if(contentType.includes('multipart/form-data')){
    const form=await new Response(route.request().postDataBuffer(),{headers:{'Content-Type':contentType}}).formData();
    for(const [key,value] of form.entries())body[key]=typeof value==='string'?value:{name:value.name,type:value.type,size:value.size};
   }else body=route.request().postDataJSON()||{};
   calls.push(body);let result={};const action=body.acao;
   if(action==='listar_catalogos')result={formas_pagamento:[],fornecedores:suppliers,marcas:[],produtos:products.filter(p=>p.status_cadastro==='completo'),produtos_rascunho:products.filter(p=>p.status_cadastro==='rascunho')};
   else if(action==='listar_clientes')result={clientes:clients};
   else if(action==='listar'&&url.pathname.endsWith('/prontuario-fichas')){if(protocolReadFailure){await route.fulfill({status:503,json:{erro:'Leitura sintética indisponível'}});return;}result={protocolos:protocols,paginacao:{pagina:body.pagina||1,tem_mais:false}};}
   else if(action==='listar_fotos'){if(photoFailure){await route.fulfill({status:403,json:{erro:'Consentimento necessário',codigo:'clinical_photography_consent_required'}});return;}result={fotos:[],paginacao:{tem_mais:false}};}
   else if(action==='adicionar_foto')result={foto_id:nextId()};
   else if(['criar_cliente','criar_fornecedor','criar_produto','editar_produto'].includes(action)){
    const kind=action.split('_')[1],list=kind==='cliente'?clients:kind==='fornecedor'?suppliers:products,old=list.find(p=>p.id===body.id),record=Object.assign({},old||{},body,{id:body.id||nextId(),versao:(old?.versao||0)+1,ativo:true});
    if(kind==='produto'){record.pendencias=['tipo','unidade','apresentacao'].filter(k=>!record[k]);record.status_cadastro=record.pendencias.length?'rascunho':'completo';record.ativo=!record.pendencias.length;}
    if(old)list.splice(list.indexOf(old),1,record);else list.push(record);result={[kind]:record};
   }else if(action==='criar_atualizar'){
    const old=protocols.find(p=>p.id===body.protocolo_id),record={...(old||{}),id:body.protocolo_id||nextId(),patient_id:body.paciente_id,paciente:clients.find(c=>c.id===body.paciente_id),procedure_kind:body.tipo_procedimento,procedure_date:body.data_procedimento,technique_notes:body.notas_tecnica,complaint:body.queixa,care_notes:body.orientacoes,status:'draft',version:(old?.version||0)+1,produtos:[],produtos_rascunho:body.produtos===undefined?old?.produtos_rascunho:body.produtos,consentimentos_atuais:body.consentimentos||old?.consentimentos_atuais||{},fotos_resumo:{ativas:0,total:0}};
    if(old)protocols.splice(protocols.indexOf(old),1,record);else protocols.push(record);result={protocolo_id:record.id,version:record.version};
   }else if(action==='listar_estoque')result={estoque:inventory};else if(action==='listar_lancamentos')result={lancamentos:[]};else if(action==='listar_auditoria')result={auditoria:[]};else if(action==='listar_pendencias_estoque')result={pendencias:[]};else if(action==='listar_revisoes_duplicidade')result={revisoes:[]};
   await route.fulfill({json:result});return;
  }
  if(url.origin!==origin){await route.abort('blockedbyclient');return;}
  const file=path.resolve(root,decodeURIComponent(url.pathname).replace(/^\/+/,'')),type=types[path.extname(file)];
  if(!file.startsWith(root+path.sep)||!type||!fs.existsSync(file)||!fs.statSync(file).isFile()){await route.fulfill({status:404,body:'Fixture only'});return;}
  await route.fulfill({contentType:type,body:fs.readFileSync(file)});
 });
 try{
  await page.goto(origin+'/painel/index.html',{waitUntil:'load'});await page.waitForFunction(()=>window.AMJFinanceiro&&window.AMJProntuario&&typeof authInicioConcluido!=='undefined'&&authInicioConcluido);
  await page.evaluate(async()=>{
   modoAcesso='auth';identidadeBackend={role:'owner'};cabecalhosAcesso=async(json=true)=>json?{'Content-Type':'application/json'}:{};
   window.__draftProofs={routine:0,critical:0};window.AMJProtecao={async solicitarSenhaRecente(){window.__draftProofs.critical++;return {operation_id:crypto.randomUUID(),motivo:'Confirmação sintética',encerrar(){}};},async solicitarEdicaoRotineira(){window.__draftProofs.routine++;return {operation_id:crypto.randomUUID(),motivo:'Rotina sintética',encerrar(){}};}};
   document.querySelector('#tela-login').classList.add('oculto');document.querySelector('#tela-login').hidden=true;document.querySelector('#tela-lista').classList.remove('oculto');document.querySelector('#tela-lista').hidden=false;
   AMJFinanceiro.atualizarAcesso();AMJProntuario.atualizarAcesso();
   await AMJFinanceiro.carregar();await AMJProntuario.carregar();
  });
  const show=async id=>page.evaluate(id=>{document.querySelectorAll('.painel-aba').forEach(p=>{p.hidden=p.id!==id;p.classList.toggle('oculto',p.id!==id);});const pane=document.getElementById(id);pane.removeAttribute('data-app-finance-view');pane.querySelectorAll('details.financeiro-editor,details#prontuario-editor').forEach(d=>d.open=true);},id);
  await show('aba-financeiro');
  await page.locator('#financeiro-cliente-nome').fill('Cliente apenas nome QA');await page.locator('#financeiro-cliente-salvar').click();await page.waitForFunction(()=>document.querySelector('#financeiro-cliente-status').textContent.includes('Cliente salvo'));
  assert.equal(clients.length,2);assert.equal(clients[1].telefone,null);
  await page.locator('#financeiro-fornecedor-nome').fill('Fornecedor apenas nome QA');await page.locator('#financeiro-fornecedor-salvar').click();await page.waitForFunction(()=>document.querySelector('#financeiro-fornecedor-status').textContent.includes('Fornecedor salvo'));assert.equal(suppliers.length,1);
  await page.locator('#financeiro-produto-nome').fill('Produto nome-only QA');await page.locator('#financeiro-produto-salvar').click();await page.waitForFunction(()=>document.querySelector('#financeiro-produto-status').textContent.includes('Rascunho salvo'));
  assert.equal(products.length,1);const productId=products[0].id;assert.equal(products[0].tipo,null);assert.equal(products[0].unidade,null);assert.equal(products[0].status_cadastro,'rascunho');assert.equal(await page.locator('#financeiro-produto-id').inputValue(),productId);
  await page.locator('#financeiro-produto-cancelar-edicao').click();await page.locator('[data-financeiro-editar="produto"]').click();assert.equal(await page.locator('#financeiro-produto-id').inputValue(),productId);
  await page.locator('#financeiro-produto-tipo').selectOption('outro');await page.locator('#financeiro-produto-unidade').selectOption('un');await page.locator('#financeiro-produto-apresentacao').fill('Unidade sintética');await page.locator('#financeiro-produto-completar').click();await page.waitForFunction(()=>document.querySelector('#financeiro-produto-status').textContent.includes('Cadastro atualizado'));
  assert.equal(products.length,1);assert.equal(products[0].id,productId);assert.equal(products[0].status_cadastro,'completo');
  inventory.push({produto_id:productId,lote:'LOTE CADASTRADO QA',validade:'2027-12-31',saldo:10,unidade:'un'});
  await page.evaluate(()=>AMJProntuario.carregar());await show('aba-prontuarios');
  await page.locator('#prontuario-paciente').selectOption(patientId);await page.locator('#prontuario-notas').fill('Anotação sintética, continuar depois.');await page.locator('#prontuario-data').fill('');await page.locator('.prontuario-produto-select').selectOption(productId);
  assert.equal(await page.locator('.prontuario-produto-lote').inputValue(),'LOTE CADASTRADO QA');assert.equal(await page.locator('.prontuario-produto-validade').inputValue(),'2027-12-31');assert.equal(await page.locator('.prontuario-produto-lote-select').inputValue(),'0');
  inventory.push({produto_id:productId,lote:'SEGUNDO LOTE QA',validade:'2028-03-31',saldo:5,unidade:'un'});await page.evaluate(()=>AMJProntuario.carregar());await page.locator('.prontuario-produto-select').selectOption('');await page.locator('.prontuario-produto-select').selectOption(productId);assert.equal(await page.locator('.prontuario-produto-lote-select').inputValue(),'');assert.equal(await page.locator('.prontuario-produto-lote').inputValue(),'');
  await page.locator('.prontuario-produto-lote-select').selectOption('1');assert.equal(await page.locator('.prontuario-produto-lote').inputValue(),'SEGUNDO LOTE QA');assert.equal(await page.locator('.prontuario-produto-validade').inputValue(),'2028-03-31');
  await page.locator('.prontuario-produto-lote-select').selectOption('manual');assert.equal(await page.locator('.prontuario-produto-lote').inputValue(),'');assert.equal(await page.locator('.prontuario-produto-validade').inputValue(),'','manual lot cannot inherit another lot expiry');await page.locator('.prontuario-produto-lote').fill('PARCIAL QA');await page.locator('#prontuario-salvar').click();await page.waitForFunction(()=>document.querySelector('#prontuario-form-status').textContent.includes('Rascunho salvo'));
  assert.equal(protocols.length,1);const protocolId=protocols[0].id;assert.equal(protocols[0].procedure_kind,null);assert.equal(protocols[0].procedure_date,null);assert.equal(protocols[0].produtos_rascunho[0].amount,null);assert.equal(await page.locator('.prontuario-produto-lote').inputValue(),'PARCIAL QA');assert.equal(await page.locator('#prontuario-fotos-editor').evaluate(n=>n.classList.contains('etapa-obrigatoria')),false);
  await page.locator('#prontuario-notas').fill('Anotação sintética complementada.');await page.locator('#prontuario-salvar').click();await page.waitForFunction(()=>document.querySelector('#prontuario-versao').value==='2');assert.equal(protocols.length,1);assert.equal(protocols[0].id,protocolId);assert.equal(protocols[0].produtos_rascunho[0].lot,'PARCIAL QA');
  assert.deepEqual(await page.evaluate(()=>window.__draftProofs),{routine:2,critical:0});assert.deepEqual(errors,[]);
  await page.locator('[data-prontuario-consulta] > summary').click();await page.waitForFunction(()=>document.querySelector('.prontuario-fotos-controles .erro')?.textContent.includes('rascunho pode ser salvo sem fotos'));
  await page.waitForTimeout(700);assert.equal(calls.filter(c=>c.acao==='listar_fotos').length,1,'403 is cached across rerender/toggle instead of looping');
  await page.locator('[data-prontuario-recarregar-fotos]').click();await page.waitForTimeout(300);assert.equal(calls.filter(c=>c.acao==='listar_fotos').length,2,'retry is explicit and occurs exactly once');
  await page.locator('#prontuario-cancelar-edicao').click();await page.locator('[data-prontuario-editar]').click();
  assert(await page.locator('.prontuario-produto-lote-select').isVisible(),'editing exposes the registered-lot selector');
  assert.equal(await page.locator('.prontuario-produto-lote').inputValue(),'PARCIAL QA','saved lot survives reopening via the edit button');
  assert.equal(await page.locator('.prontuario-produto-validade').inputValue(),'','unknown manual expiry remains empty after reopening');
  assert.equal(await page.locator('.prontuario-produto-lote-select option').count(),4,'edit includes both existing registered lots and manual option');
  assert.equal(await page.locator('#prontuario-consentimento-fotos').isChecked(),false);
  photoFailure=false;
  await page.locator('#prontuario-foto-fase').selectOption('products_used');await page.locator('#prontuario-foto-produto').selectOption(productId);await page.locator('#prontuario-foto-lote').fill('PARCIAL QA');
  await page.locator('#prontuario-foto-arquivo').setInputFiles({name:'synthetic-private-qa.png',mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nKcAAAAASUVORK5CYII=','base64')});
  await page.locator('#prontuario-foto-form button[type=submit]').click();await page.waitForFunction(()=>document.querySelector('#prontuario-foto-status').textContent.includes('Foto adicionada ao armazenamento clínico privado'));
  const uploads=calls.filter(c=>c.acao==='adicionar_foto');assert.equal(uploads.length,1,'one explicit upload, no automatic duplicates');
  assert.equal(uploads[0].protocolo_id,protocolId);assert.equal(uploads[0].produto_id,productId);assert.equal(uploads[0].lote,'PARCIAL QA');assert.equal(uploads[0].arquivo.type,'image/png');assert(uploads[0].idempotency_key);
  assert.equal(await page.locator('#prontuario-consentimento-fotos').isChecked(),false,'private upload never changes consent');assert(calls.filter(c=>c.acao==='criar_atualizar').every(c=>!Object.hasOwn(c,'consentimentos')));assert.equal(calls.filter(c=>c.acao==='alterar_consentimento_fotografia').length,0);
  assert.deepEqual(await page.evaluate(()=>window.__draftProofs),{routine:2,critical:0});assert.deepEqual(errors,[]);
  await page.waitForFunction(()=>!document.querySelector('#prontuario-foto-form button[type=submit]').disabled);
  await page.locator('#prontuario-notas').fill('Complemento sintético ainda não salvo.');
  await page.evaluate(()=>AMJShell.navigate('produtos',{focus:false}));await page.evaluate(()=>AMJShell.navigate('prontuarios',{focus:false}));
  assert.equal(await page.locator('#prontuario-id').inputValue(),protocolId);assert.equal(await page.locator('#prontuario-notas').inputValue(),'Complemento sintético ainda não salvo.','ordinary route changes preserve the open draft');
  await page.locator('#prontuario-cancelar-edicao').click();await page.locator('#prontuario-busca').fill('Filtro sintético sem resultados');
  assert.equal(await page.locator('[data-prontuario-editar]').count(),0);
  assert.equal(await page.evaluate(id=>AMJShell.openExisting({type:'protocolo',id}),protocolId),true);
  await page.waitForFunction(id=>document.querySelector('#prontuario-id').value===id,protocolId);
  assert.equal(await page.locator('.prontuario-produto-lote').inputValue(),'PARCIAL QA','filtered consultation opens through its authoritative ID');
  assert.equal(await page.locator('#prontuario-busca').inputValue(),'Filtro sintético sem resultados','opening a linked record does not reset the search');
  await page.locator('#prontuario-busca').fill('');protocolReadFailure=true;
  await page.locator('#prontuario-notas').fill('Complemento confirmado antes da falha de leitura.');
  const savesBeforeFailure=calls.filter(c=>c.acao==='criar_atualizar').length;
  await page.locator('#prontuario-salvar').click();await page.waitForFunction(()=>document.querySelector('#prontuario-form-status').textContent.includes('salvo no servidor'));
  assert.equal(calls.filter(c=>c.acao==='criar_atualizar').length,savesBeforeFailure+1);
  assert.equal(await page.locator('#prontuario-id').inputValue(),protocolId);assert.equal(await page.locator('#prontuario-versao').inputValue(),'3');
  assert.equal(await page.locator('[data-prontuario-editar]').count(),0,'stale clinical snapshot cannot be reopened');
  assert(await page.locator('[data-prontuario-atualizar-pendentes]').isVisible(),'confirmed write exposes an explicit recovery action');
  await page.locator('#prontuario-notas').fill('Próximo complemento ainda não salvo.');
  await page.evaluate(()=>AMJShell.navigate('produtos',{focus:false}));await page.evaluate(()=>AMJShell.navigate('prontuarios',{focus:false}));
  assert.equal(await page.locator('#prontuario-notas').inputValue(),'Próximo complemento ainda não salvo.');
  protocolReadFailure=false;await page.locator('[data-prontuario-atualizar-pendentes]').click();await page.waitForFunction(()=>!document.querySelector('[data-prontuario-atualizar-pendentes]'));
  assert.equal(await page.locator('#prontuario-notas').inputValue(),'Próximo complemento ainda não salvo.','list recovery preserves subsequent unsaved input');
  assert.equal(calls.filter(c=>c.acao==='criar_atualizar').length,savesBeforeFailure+1,'list recovery never repeats the write');
  await page.locator('#prontuario-cancelar-edicao').click();await page.locator('[data-prontuario-editar]').click();
  assert.equal(await page.locator('#prontuario-versao').inputValue(),'3');assert.equal(await page.locator('#prontuario-notas').inputValue(),'Complemento confirmado antes da falha de leitura.');
  assert.equal(await page.locator('.prontuario-produto-lote').inputValue(),'PARCIAL QA');
  assert.deepEqual(errors,[]);
  await page.locator('#prontuario-editor').screenshot({path:path.join(output,(mobile?'mobile':'desktop')+'-draft.png')});
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2),'page must fit the viewport');
  }catch(error){console.error('Synthetic failure diagnostics',JSON.stringify({photoStatus:await page.locator('#prontuario-foto-status').textContent(),uploadCalls:calls.filter(c=>c.acao==='adicionar_foto'),errors}));throw error;}finally{await context.close();}
});

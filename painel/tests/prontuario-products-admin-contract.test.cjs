'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..'),html=fs.readFileSync(path.join(root,'index.html'),'utf8'),source=fs.readFileSync(path.join(root,'prontuario.js'),'utf8');
const ids={protocol:'11111111-1111-4111-8111-111111111111',patient:'22222222-2222-4222-8222-222222222222',product:'33333333-3333-4333-8333-333333333333'};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function harness(moduleSource=source){
 const nodes=new Map(),calls=[];
 const node=id=>{if(!nodes.has(id))nodes.set(id,{value:'',checked:false,dataset:{},textContent:'',classList:{toggle(){},add(){},remove(){}},querySelectorAll:()=>[],setAttribute(){}});return nodes.get(id);};
 const sandbox={window:{__AMJ_TEST__:true,crypto},document:{readyState:'loading',addEventListener(){},getElementById:node},el:node,modoAcesso:'auth',identidadeBackend:{role:'owner'},sessaoAplicativoAtiva:()=>true,sessaoAindaValida:()=>true,authSession:{user:{id:'owner-synthetic'},access_token:'x.'+Buffer.from(JSON.stringify({session_id:'session-synthetic'})).toString('base64')+'.x'},atob:s=>Buffer.from(s,'base64').toString(),cabecalhosAcesso:async()=>({'Content-Type':'application/json'}),Intl,Date,URL,AbortController,console,
  fetch:async(url,options)=>{const body=JSON.parse(options.body);calls.push(body);return {ok:true,json:async()=>({protocolo_id:ids.protocol,versao:8})};}};
 vm.createContext(sandbox);
 vm.runInContext(html.slice(html.indexOf('function operacaoId()'),html.indexOf('async function acessoNegado()')),sandbox);
 vm.runInContext(moduleSource.replace('  window.AMJProntuario = {','  window.productsHarness = {state,submitProtocol};\n  window.AMJProntuario = {'),sandbox);
 const api=sandbox.window.productsHarness;api.state.loading=true; // Keep this contract test from performing unrelated list refreshes.
 api.state.protocols=[{id:ids.protocol,patient_id:ids.patient,version:7,status:'draft',anamnesis:{synthetic:true},produtos_rascunho:[]}];
 node('prontuario-id').value=ids.protocol;node('prontuario-versao').value='7';node('prontuario-paciente').value=ids.patient;
 const values={select:ids.product,lote:'LOTE SINTÉTICO',validade:'2028-01-31',quantidade:'1',unidade:'un'};
 node('prontuario-produtos-lista').querySelectorAll=()=>[{querySelector:selector=>({value:values[selector.replace('.prontuario-produto-','')]||''})}];
 return {node,calls,sandbox,api,save:()=>api.submitProtocol({preventDefault(){},currentTarget:node('prontuario-form')})};
}
test('actual admin API + product draft save sends a valid operation UUID and authoritative version',async()=>{
 const h=harness();await h.save();assert.equal(h.calls.length,1);const p=h.calls[0];
 assert.equal(p.acao,'criar_atualizar');assert.match(p.operation_id,uuid);assert.match(p.idempotency_key,uuid);assert.notEqual(p.operation_id,p.idempotency_key);
 assert.equal(p.protocolo_id,ids.protocol);assert.equal(p.paciente_id,ids.patient);assert.equal(p.versao_esperada,7);assert.equal(p.produtos[0].product_id,ids.product);assert.equal(p.produtos[0].lot,'LOTE SINTÉTICO');assert.equal(p.produtos[0].expiry,'2028-01-31');assert.equal(p.produtos[0].amount,1);
 assert.equal(Object.hasOwn(p,'consentimentos'),false);assert.equal(h.node('prontuario-versao').value,8);assert.match(h.node('prontuario-form-status').textContent,/Rascunho salvo/);
});
test('server operation/version errors remain visible and cannot erase entered products',async()=>{
 const h=harness();h.sandbox.fetch=async()=>({ok:false,status:422,json:async()=>({codigo:'operation_id_required',erro:'Atualize a tela e tente novamente.'})});await h.save();
 assert.equal(h.node('prontuario-form-status').textContent,'Atualize a tela e tente novamente.');assert.equal(h.node('prontuario-id').value,ids.protocol);assert.equal(h.node('prontuario-versao').value,'7');assert.equal(h.node('prontuario-produtos-lista').querySelectorAll()[0].querySelector('.prontuario-produto-lote').value,'LOTE SINTÉTICO');
});
test('dedicated legacy create fixture retains explicit false consent without inventing an operation ID',()=>{
 // The earlier client sent this request shape for new consultations. This is a
 // compatibility case, not evidence that the reported user had a cached page.
 // Historical Git objects are not needed to run this regression fixture.
 const payload=JSON.parse(fs.readFileSync(path.join(__dirname,'fixtures/prontuario-products-legacy-create.json'),'utf8'));
 assert.equal(payload.acao,'criar_atualizar');assert.equal(payload.protocolo_id,null);assert.match(payload.idempotency_key,uuid);
 assert.equal(Object.hasOwn(payload,'operation_id'),false);assert.deepEqual(payload.consentimentos,{clinical_photography:false});
 assert.equal(payload.produtos[0].product_id,ids.product);assert.equal(payload.produtos[0].lot,'LOTE SINTÉTICO');assert.equal(payload.produtos[0].amount,1);
});

'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.resolve(__dirname,'..'),html=fs.readFileSync(path.join(root,'index.html'),'utf8');
function runtime(file,extra=''){
 const nodes=new Map(),node=id=>{if(!nodes.has(id))nodes.set(id,{value:'',checked:false,textContent:'',dataset:{},classList:{toggle(){},add(){},remove(){}},querySelectorAll(){return [];},setAttribute(){},focus(){},scrollIntoView(){}});return nodes.get(id);};
 const sandbox={window:{__AMJ_TEST__:true,crypto:{randomUUID:()=> '11111111-1111-4111-8111-111111111111'}},document:{readyState:'loading',addEventListener(){},getElementById:node},modoAcesso:'auth',identidadeBackend:{role:'owner'},Intl,Date,URL,console,AbortController};
 let source=fs.readFileSync(path.join(root,file),'utf8');if(extra)source=source.replace('  window.AMJFinanceiro = {',extra+'\n  window.AMJFinanceiro = {');vm.runInNewContext(source,sandbox);return {node,sandbox,ui:sandbox.window.AMJProntuario?.__test||sandbox.window.testDraft};
}
function row(fields={}){return {querySelector(selector){const key=selector.replace('.prontuario-produto-','');return {value:fields[key]||''};}};}
test('only names/patient are mandatory at draft entry; final actions remain separate',()=>{
 for(const [form,required] of [['financeiro-form-cliente','financeiro-cliente-nome'],['financeiro-form-fornecedor','financeiro-fornecedor-nome'],['financeiro-form-produto','financeiro-produto-nome'],['prontuario-form','prontuario-paciente']]){
  const body=html.slice(html.indexOf('id="'+form+'"'),html.indexOf('</form>',html.indexOf('id="'+form+'"')));
  const ids=[...body.matchAll(/<(?:input|select|textarea)\b[^>]*\bid="([^"]+)"[^>]*\brequired\b[^>]*>/g)].map(m=>m[1]);assert.deepEqual(ids,[required],form);
 }
 assert.match(html,/id="financeiro-produto-completar"[^>]+data-completar="true"/);
});
test('every partially entered product row is preserved while empty rows are ignored',()=>{
 const {node,ui}=runtime('prontuario.js');node('prontuario-produtos-lista').querySelectorAll=()=>[row(),row({lote:'LOTE SINTÉTICO'}),row({select:'produto-sintetico'}),row({unidade:'mL'})];
 const collected=JSON.parse(JSON.stringify(ui.collectProducts()));assert.equal(collected.length,3);assert.equal(collected[0].lot,'LOTE SINTÉTICO');assert.equal(collected[0].product_id,null);assert.equal(collected[1].amount,null);assert.equal(collected[2].unit,'mL');assert.deepEqual(collected.map(p=>p.position),[1,2,3]);
});
test('draft storage cannot silently change invalid quantities to zero or discard them',()=>{
 const {node,ui}=runtime('prontuario.js');for(const quantidade of ['-1','1000001','NaN','0']){node('prontuario-produtos-lista').querySelectorAll=()=>[row({select:'produto-sintetico',quantidade})];assert.throws(()=>ui.collectProducts(),/quantidade/);}
});
test('reopened draft rows override legacy consumed products even when the draft list is empty',()=>{
 const {ui}=runtime('prontuario.js'),legacy=[{product_id:'antigo'}],draft=[{lot:'PARCIAL'}];assert.equal(ui.protocolProducts({produtos:legacy,produtos_rascunho:draft}),draft);assert.deepEqual(Array.from(ui.protocolProducts({produtos:legacy,produtos_rascunho:[]})),[]);assert.equal(ui.protocolProducts({produtos:legacy,produtos_rascunho:null}),legacy);
 assert.deepEqual(Array.from(ui.protocolPending({produtos_rascunho:draft})),['procedimento','data','dados dos produtos']);
});
test('name-only products stay manageable but outside financial operations',()=>{
 const {ui}=runtime('financeiro.js','  window.testDraft={state,productRegistry,productOptions,isProductDraft};');ui.state.catalogs.produtos=[{id:'completo',nome:'Produto sintético completo',ativo:true}];ui.state.catalogs.produtos_rascunho=[{id:'rascunho',nome:'Produto sintético parcial',ativo:false,status_cadastro:'rascunho'}];assert.equal(ui.productRegistry().length,2);assert.match(ui.productOptions(),/completo/);assert.doesNotMatch(ui.productOptions(),/rascunho|parcial/);
});
test('draft save retains ID before refresh and never forces photo upload; critical finalization remains confirmed',()=>{
 const source=fs.readFileSync(path.join(root,'prontuario.js'),'utf8'),save=source.slice(source.indexOf('async function submitProtocol('),source.indexOf('async function submitPhoto('));
 assert(save.indexOf("byId('prontuario-id').value = savedId")<save.indexOf('const refreshed = await load'));assert.doesNotMatch(save,/focusPhotos: true|requiredPhoto: true/);assert.match(source,/protectedRequest\('finalizar'/);assert.match(save,/if \(!consentChanged\) delete payload.consentimentos/);assert.match(save,/rotina: routine/);assert.match(save,/anamnese: current && current.anamnesis/,'campos clínicos fora deste formulário não são zerados ao complementar a anotação');
});
test('failed gallery requests never automatically retry on rerender or stale timestamp',()=>{
 const {ui}=runtime('prontuario.js');for(const error of ['Falha de rede','Consentimento necessário']){ui.setPhotoPage('consulta-sintetica',{items:[],loading:false,error,loadedAt:0});for(let i=0;i<10;i++)assert.equal(ui.photoPageNeedsRefresh('consulta-sintetica'),false);}
 ui.setPhotoPage('consulta-sintetica',{items:[],loading:false,error:'',loadedAt:0});assert.equal(ui.photoPageNeedsRefresh('consulta-sintetica'),true);
});

test('private archive upload preserves owner check, traceability and explicit consent values',()=>{
 const source=fs.readFileSync(path.join(root,'prontuario.js'),'utf8'),upload=source.slice(source.indexOf('async function submitPhoto('),source.indexOf('async function changeState('));
 assert.match(upload,/if \(!ownerAccess\(\)\)/);assert.doesNotMatch(upload,/prontuario-consentimento-fotos|clinical_photography/);
 assert.match(upload,/file\.size > 25 \* 1024 \* 1024/);for(const key of ['protocolo_id','produto_id','lote','idempotency_key'])assert(upload.includes("data.append('"+key+"'"));
 assert.match(source,/Arquivo clínico privado — publicação exige autorização específica/);assert.match(source,/function changePhotographyConsent\(/);assert.match(source,/if \(!consentChanged\) delete payload.consentimentos/);
});

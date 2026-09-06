'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const source=fs.readFileSync(path.resolve(__dirname,'../prontuario.js'),'utf8');
const ids={protocol:'11111111-1111-4111-8111-111111111111',patient:'22222222-2222-4222-8222-222222222222',product:'33333333-3333-4333-8333-333333333333',other:'44444444-4444-4444-8444-444444444444'};
const old={id:ids.protocol,patient_id:ids.patient,version:7,status:'draft',anamnesis:{existing:'preserved by server'},technique_notes:'Versão anterior sintética',produtos_rascunho:[],consentimentos_atuais:{clinical_photography:false}};
const canonical={...old,version:8,procedure_kind:'outro',technique_notes:'Texto canônico sintético',produtos_rascunho:[{product_id:ids.product,lot:'LOTE CANÔNICO',amount:1,unit:'un'}],consentimentos_atuais:{clinical_photography:false},server_metadata:{only:'server'}};
function deferred(){let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};}
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function response(data,ok=true){return {ok,status:ok?200:503,json:async()=>data};}
function harness(){
 const nodes=new Map(),calls=[];
 function node(id){if(!nodes.has(id))nodes.set(id,{value:'',checked:false,dataset:{},textContent:'',options:[],classList:{toggle(){},add(){},remove(){}},attributes:{},querySelectorAll:()=>[],setAttribute(k,v){this.attributes[k]=String(v);},getAttribute(k){return this.attributes[k];}});return nodes.get(id);}
 const sandbox={window:{crypto,AMJProtecao:{solicitarSenhaRecente:async()=>{throw Error('No critical prompt expected');},solicitarEdicaoRotineira:async()=>({operation_id:crypto.randomUUID()})}},document:{readyState:'loading',addEventListener(){},getElementById:node,querySelectorAll:()=>[]},modoAcesso:'auth',identidadeBackend:{role:'owner'},cabecalhosAcesso:async()=>({}),Intl,Date,URL,console,
  fetch:async(url,options)=>{const body=JSON.parse(options.body);calls.push(body);return body.acao==='criar_atualizar'?response({protocolo_id:ids.protocol,versao:8}):response({erro:'Leitura sintética indisponível'},false);}};
 vm.runInNewContext(source.replace('  window.AMJProntuario = {','  window.recovery={state,submitProtocol,load,beginEdit,protocolNeedsRefresh,openPatientHistory};\n  window.AMJProntuario = {'),sandbox);
 const api=sandbox.window.recovery;api.state.protocols=[JSON.parse(JSON.stringify(old))];api.state.loaded=true;
 node('prontuario-id').value=ids.protocol;node('prontuario-versao').value='7';node('prontuario-paciente').value=ids.patient;node('prontuario-notas').value='Complemento sintético digitado';
 const values={select:ids.product,lote:'LOTE DIGITADO',validade:'2028-01-31',quantidade:'1',unidade:'un'};
 node('prontuario-produtos-lista').querySelectorAll=()=>[{querySelector:selector=>({value:values[selector.replace('.prontuario-produto-','')]||''})}];
 function serveCanonical(rows=[canonical]){sandbox.fetch=async(url,options)=>{const body=JSON.parse(options.body);calls.push(body);return response(body.acao==='listar'?{protocolos:rows,paginacao:{pagina:1,tem_mais:false}}:body.acao==='listar_clientes'?{clientes:[{id:ids.patient,nome:'Paciente sintética'}]}:{});};}
 return {api,sandbox,node,calls,serveCanonical,save:()=>api.submitProtocol({preventDefault(){},currentTarget:node('prontuario-form')})};
}

test('confirmed draft + failed refresh preserves fields and blocks stale reopen/repeated writes until explicit canonical recovery',{timeout:2000},async()=>{
 const h=harness();await h.save();
 assert.equal(h.node('prontuario-versao').value,8);assert.equal(h.node('prontuario-notas').value,'Complemento sintético digitado');
 assert.equal(h.api.protocolNeedsRefresh(ids.protocol),true);assert.equal(h.api.state.protocols[0].version,7,'never invent a clinical snapshot from the write payload');
 assert.match(h.node('prontuario-lista').innerHTML,/data-prontuario-atualizar-pendentes/);assert.doesNotMatch(h.node('prontuario-lista').innerHTML,/data-prontuario-editar/);
 assert.match(h.node('prontuario-form-status').textContent,/salvo no servidor.*Atualizar consultas/);
 assert.equal(h.api.beginEdit(ids.protocol),false);assert.equal(h.node('prontuario-versao').value,8);
 await h.save();assert.equal(h.calls.filter(c=>c.acao==='criar_atualizar').length,1,'acknowledged writes are not retried to repair reads');assert.equal(h.calls.length,5);
 h.node('prontuario-notas').value='Mais texto ainda não salvo';h.serveCanonical();assert.equal(await h.api.load(),true);
 assert.equal(h.api.protocolNeedsRefresh(ids.protocol),false);assert.deepEqual(JSON.parse(JSON.stringify(h.api.state.protocols[0])),canonical);
 assert.equal(h.node('prontuario-notas').value,'Mais texto ainda não salvo','explicit list retry does not replace the open form');
});

test('new draft stays bound to its acknowledged ID and shows pending recovery instead of an empty list',{timeout:2000},async()=>{
 const h=harness();h.api.state.protocols=[];h.node('prontuario-id').value='';h.node('prontuario-versao').value='';
 await h.save();assert.equal(h.node('prontuario-id').value,ids.protocol);assert.equal(h.api.protocolNeedsRefresh(ids.protocol),true);
 assert.match(h.node('prontuario-lista').innerHTML,/Atualizar consultas/);assert.doesNotMatch(h.node('prontuario-lista').innerHTML,/Nenhuma consulta encontrada/);
 await h.save();assert.equal(h.calls.filter(c=>c.acao==='criar_atualizar').length,1);
});

test('read started before draft acknowledgement cannot restore its old snapshot',{timeout:2000},async()=>{
 const h=harness(),reads=[];
 h.sandbox.fetch=async(url,options)=>{const body=JSON.parse(options.body);h.calls.push(body);if(body.acao==='criar_atualizar')return response({protocolo_id:ids.protocol,versao:8});const pending=deferred();reads.push({body,pending});return pending.promise;};
 const loading=h.api.load();await flush();assert.equal(reads.length,4);await h.save();assert.equal(h.api.protocolNeedsRefresh(ids.protocol),true);
 reads.forEach(({body,pending})=>pending.resolve(response(body.acao==='listar'?{protocolos:[old],paginacao:{pagina:1,tem_mais:false}}:{})));
 assert.equal(await loading,false);assert.equal(h.api.protocolNeedsRefresh(ids.protocol),true);assert.equal(h.node('prontuario-versao').value,8);
 assert.equal(h.api.beginEdit(ids.protocol),false);assert.equal(h.calls.length,5,'no automatic read loop');
 h.serveCanonical();assert.equal(await h.api.load(),true);assert.equal(h.api.protocolNeedsRefresh(ids.protocol),false);
});

test('acknowledged save A invalidates only A after switching the editor to B',{timeout:2000},async()=>{
 const h=harness(),write=deferred();h.sandbox.fetch=async()=>write.promise;
 const saving=h.save();await flush();h.api.state.editorGeneration++;h.node('prontuario-id').value=ids.other;h.node('prontuario-versao').value='3';h.node('prontuario-notas').value='Rascunho B ainda não salvo';h.node('prontuario-form-status').textContent='Editando B';
 write.resolve(response({protocolo_id:ids.protocol,versao:8}));await saving;
 assert.equal(h.api.protocolNeedsRefresh(ids.protocol),true);assert.equal(h.api.protocolNeedsRefresh(ids.other),false);
 assert.equal(h.node('prontuario-id').value,ids.other);assert.equal(h.node('prontuario-versao').value,'3');assert.equal(h.node('prontuario-notas').value,'Rascunho B ainda não salvo');assert.equal(h.node('prontuario-form-status').textContent,'Editando B');
});

test('even a successful read cannot unlock an acknowledged version if the result is still older',{timeout:2000},async()=>{
 const h=harness();await h.save();h.serveCanonical([old]);assert.equal(await h.api.load(),false);assert.equal(h.api.protocolNeedsRefresh(ids.protocol),true);assert.equal(h.api.beginEdit(ids.protocol),false);
 h.serveCanonical();assert.equal(await h.api.load(),true);assert.equal(h.api.protocolNeedsRefresh(ids.protocol),false);
});

test('history shortcut queued during loading keeps the latest exact patient filter without resetting an open editor',{timeout:2000},async()=>{
 const h=harness();h.api.state.loaded=false;h.api.state.loading=true;h.api.state.pendingPatientId='older-new-draft';h.api.state.pendingProtocolId='older-editor-target';
 await h.api.openPatientHistory(ids.patient);await h.api.openPatientHistory(ids.other);
 assert.equal(h.api.state.filterPatientId,ids.other);assert.equal(h.api.state.pendingHistoryPatientId,ids.other);
 assert.equal(h.api.state.pendingPatientId,null);assert.equal(h.api.state.pendingProtocolId,null);
 assert.equal(h.node('prontuario-id').value,ids.protocol);assert.equal(h.node('prontuario-notas').value,'Complemento sintético digitado');assert.equal(h.calls.length,0);
 h.api.state.loading=false;h.serveCanonical();assert.equal(await h.api.load(),true);
 assert.equal(h.api.state.pendingHistoryPatientId,null);assert.equal(h.api.state.filterPatientId,ids.other);
 assert.equal(h.node('prontuario-id').value,ids.protocol);assert.equal(h.node('prontuario-notas').value,'Complemento sintético digitado');
 assert(h.calls.every(c=>c.acao!=='criar_atualizar'));
});

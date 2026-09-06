'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.resolve(__dirname,'../prontuario.js'),'utf8');
function deferred(){let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};}
function harness(){
 const nodes=new Map(),requests=[];
 const node=id=>{if(!nodes.has(id))nodes.set(id,{value:'',textContent:'',attributes:{},classList:{toggle(){}},setAttribute(k,v){this.attributes[k]=String(v);}});return nodes.get(id);};
 const sandbox={window:{},document:{readyState:'loading',addEventListener(){},getElementById:node},Intl,Date,URL,console,
  modoAcesso:'auth',identidadeBackend:{role:'owner'},cabecalhosAcesso:async()=>({Authorization:'synthetic-test-only'}),
  fetch:async(url,options)=>{const response=deferred();requests.push({url,options,response});return response.promise;}};
 vm.runInNewContext(source.replace('  window.AMJProntuario = {','  window.raceHarness={state,jsonRequest,load,newForPatient,openProtocol};\n  window.AMJProntuario = {'),sandbox);
 return {...sandbox.window.raceHarness,sandbox,node,requests};
}
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function fail(request,message='Falha temporária sintética'){request.response.resolve({ok:false,status:503,json:async()=>({erro:message,codigo:'database_unavailable'})});}

test('logout/session switch while waiting for headers prevents a late clinical request',{timeout:2000},async()=>{
 const h=harness(),headers=deferred();h.sandbox.cabecalhosAcesso=()=>headers.promise;
 const request=h.jsonRequest('https://synthetic.invalid','criar_atualizar',{notas_tecnica:'somente sintético'});
 const rejected=assert.rejects(request,/Sessão do prontuário encerrada/);
 h.state.generation++;headers.resolve({Authorization:'new-session-synthetic'});await flush();
 // Resolve a wrongly emitted request on the old implementation so failure is bounded.
 for(const sent of h.requests)fail(sent);
 await rejected;assert.equal(h.requests.length,0);
});

test('old load completion cannot overwrite status or unlock a newer session load',{timeout:2000},async()=>{
 const h=harness(),old=h.load();await flush();assert.equal(h.requests.length,4);
 h.state.generation++;h.state.loading=false;
 const current=h.load();await flush();assert.equal(h.requests.length,8);
 h.node('prontuario-status').textContent='Carregamento da sessão atual';
 h.requests.slice(0,4).forEach(request=>fail(request));await old;
 const snapshot={loading:h.state.loading,busy:h.node('prontuario-lista').attributes['aria-busy'],status:h.node('prontuario-status').textContent};
 h.requests.slice(4).forEach(request=>fail(request,'Falha atual'));await current;
 assert.deepEqual(snapshot,{loading:true,busy:'true',status:'Carregamento da sessão atual'});
 assert.equal(h.state.loading,false);assert.equal(h.node('prontuario-status').textContent,'Falha atual');
});

test('temporary read failure preserves existing consultation snapshot and entered notes',{timeout:2000},async()=>{
 const h=harness();h.state.protocols=[{id:'synthetic-record',version:4}];h.node('prontuario-notas').value='Anotação ainda não salva';
 const loading=h.load();await flush();h.requests.forEach(request=>fail(request));assert.equal(await loading,false);
 assert.equal(h.state.protocols[0].id,'synthetic-record');assert.equal(h.node('prontuario-notas').value,'Anotação ainda não salva');
 assert.equal(h.state.loading,false);
});

test('latest patient or consultation shortcut supersedes the previous pending target',()=>{
 const h=harness();h.state.loading=true;
 h.openProtocol('old-consultation');h.newForPatient('current-patient');
 assert.equal(h.state.pendingProtocolId,null);assert.equal(h.state.pendingPatientId,'current-patient');
 h.openProtocol('current-consultation');
 assert.equal(h.state.pendingPatientId,null);assert.equal(h.state.pendingProtocolId,'current-consultation');
});

'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.resolve(__dirname,'../financeiro.js'),'utf8');
const A={id:'11111111-1111-4111-8111-111111111111',nome:'Produto sintético A',versao:1,ativo:true,status_cadastro:'completo',tipo:'descartavel',unidade:'un',apresentacao:'Unidade'};
const B={...A,id:'22222222-2222-4222-8222-222222222222',nome:'Produto sintético B',versao:4};
function deferred(){let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};}
function harness(){
 const nodes=new Map(),requests=[];let serial=0;
 function node(id){if(!nodes.has(id))nodes.set(id,{value:'',textContent:'',dataset:{},options:[],checked:false,attributes:{},classList:{add(){},remove(){},toggle(){}},
  set innerHTML(value){this.html=value;this.options=[...value.matchAll(/<option value="([^"]*)"/g)].map(m=>({value:m[1]}));if(this.options.length)this.value=this.options[0].value;},get innerHTML(){return this.html||'';},
  setAttribute(k,v){this.attributes[k]=String(v);},getAttribute(k){return this.attributes[k];},removeAttribute(k){delete this.attributes[k];},querySelector(){return null;},querySelectorAll(){return [];},reset(){},focus(){},scrollIntoView(){},addEventListener(){}});return nodes.get(id);}
 const env={AbortController,Intl,Date,console,clearTimeout,setTimeout,modoAcesso:'auth',identidadeBackend:{role:'owner'},cabecalhosAcesso:async()=>({}),
  document:{readyState:'loading',addEventListener(){},getElementById:id=>id==='aba-financeiro'?null:node(id),querySelectorAll(){return [];}},
  window:{crypto:{randomUUID:()=> '33333333-3333-4333-8333-'+String(++serial).padStart(12,'0')},AMJProtecao:{solicitarSenhaRecente:async()=>{throw Error('No critical dialog expected');},solicitarEdicaoRotineira:async()=>({operation_id:'44444444-4444-4444-8444-444444444444'})}},
  fetch:async(url,options)=>{const response=deferred();requests.push({body:JSON.parse(options.body),response});return response.promise;}};
 vm.runInNewContext(source.replace('  window.AMJFinanceiro = {','  window.reviewContext={state,saveRegistry,beginRegistryEdit,productRegistry,resetCatalogEdit};\n  window.AMJFinanceiro = {'),env);
 const api=env.window.reviewContext;api.state.catalogs.produtos=[{...A},{...B}];api.state.loaded=true;
 // An existing background refresh makes saveRegistry skip another broad load;
 // the regression concerns the acknowledged write and open editor, not the API.
 api.state.loading=true;
 const submit=node('financeiro-produto-salvar');submit.disabled=false;
 node('financeiro-form-produto').querySelectorAll=selector=>selector==='button,input,select,textarea'?[submit]:[];
 return {node,requests,api};
}
test('late save of product A cannot bind its ID/version to the fields of product B',{timeout:2000},async()=>{
 const h=harness();await h.api.beginRegistryEdit('produto',A.id);
 const pending=h.api.saveRegistry(h.node('financeiro-form-produto'),'produto',{nome:'Produto sintético A salvo'},'financeiro-produto-status','Produto salvo.');
 await new Promise(resolve=>setImmediate(resolve));assert.equal(h.requests.length,1);assert.equal(h.requests[0].body.id,A.id);
 await h.api.beginRegistryEdit('produto',B.id);h.node('financeiro-produto-apresentacao').value='Complemento de B ainda não salvo';
 const saved={...A,nome:'Produto sintético A salvo',versao:2};
 h.requests[0].response.resolve({ok:true,status:200,json:async()=>({produto:saved})});await pending;
 assert.equal(h.node('financeiro-produto-id').value,B.id,'the editor remains attached to B');
 assert.equal(Number(h.node('financeiro-produto-versao').value),B.versao);
 assert.equal(h.node('financeiro-produto-nome').value,B.nome);
 assert.equal(h.node('financeiro-produto-apresentacao').value,'Complemento de B ainda não salvo');
 assert.equal(h.api.productRegistry().find(p=>p.id===A.id).versao,2,'the acknowledged product still enters the catalog');
});

for (const type of ['marca','fornecedor']) {
 test('late save cannot reset a different '+type+' editor',{timeout:2000},async()=>{
  const h=harness(),form=h.node('financeiro-form-'+type);
  h.api.resetCatalogEdit(type);
  h.node('financeiro-'+type+'-id').value=A.id;
  h.node('financeiro-'+type+'-versao').value='1';
  h.node('financeiro-'+type+'-nome').value='Cadastro A';
  const pending=h.api.saveRegistry(form,type,{nome:'Cadastro A'},'financeiro-'+type+'-status','Cadastro salvo.');
  await new Promise(resolve=>setImmediate(resolve));assert.equal(h.requests.length,1);
  h.api.resetCatalogEdit(type);
  h.node('financeiro-'+type+'-id').value=B.id;
  h.node('financeiro-'+type+'-versao').value='4';
  h.node('financeiro-'+type+'-nome').value='Alteração ainda não salva de B';
  h.node('financeiro-'+type+'-status').textContent='Editando B';
  h.requests[0].response.resolve({ok:true,status:200,json:async()=>({[type]:{...A,versao:2}})});await pending;
  assert.equal(h.node('financeiro-'+type+'-id').value,B.id);
  assert.equal(h.node('financeiro-'+type+'-versao').value,'4');
  assert.equal(h.node('financeiro-'+type+'-nome').value,'Alteração ainda não salva de B');
  assert.equal(h.node('financeiro-'+type+'-status').textContent,'Editando B');
 });
}

test('late failure of product A cannot replace the status or fields of product B',{timeout:2000},async()=>{
 const h=harness();await h.api.beginRegistryEdit('produto',A.id);
 const pending=h.api.saveRegistry(h.node('financeiro-form-produto'),'produto',{nome:'Produto sintético A salvo'},'financeiro-produto-status','Produto salvo.');
 await new Promise(resolve=>setImmediate(resolve));assert.equal(h.requests.length,1);
 await h.api.beginRegistryEdit('produto',B.id);
 h.node('financeiro-produto-status').textContent='Editando o produto B; alterações ainda não salvas.';
 h.node('financeiro-produto-apresentacao').value='Complemento de B ainda não salvo';
 h.requests[0].response.resolve({ok:false,status:503,json:async()=>({error:'Falha sintética tardia'})});await pending;
 assert.equal(h.node('financeiro-produto-id').value,B.id);
 assert.equal(Number(h.node('financeiro-produto-versao').value),B.versao);
 assert.equal(h.node('financeiro-produto-apresentacao').value,'Complemento de B ainda não salvo');
 assert.equal(h.node('financeiro-produto-status').textContent,'Editando o produto B; alterações ainda não salvas.');
 assert.equal(h.api.productRegistry().find(p=>p.id===A.id).versao,A.versao,'an unacknowledged save cannot enter the catalog');
});

test('late completion of product A cannot unlock the form while product B is saving',{timeout:2000},async()=>{
 const h=harness(),form=h.node('financeiro-form-produto'),submit=h.node('financeiro-produto-salvar');
 await h.api.beginRegistryEdit('produto',A.id);
 const pendingA=h.api.saveRegistry(form,'produto',{nome:'Produto sintético A salvo'},'financeiro-produto-status','Produto salvo.');
 await new Promise(resolve=>setImmediate(resolve));assert.equal(h.requests.length,1);assert.equal(submit.disabled,true);
 await h.api.beginRegistryEdit('produto',B.id);assert.equal(submit.disabled,false,'switching editor releases the previous editor controls');
 const pendingB=h.api.saveRegistry(form,'produto',{nome:'Produto sintético B salvo'},'financeiro-produto-status','Produto salvo.');
 await new Promise(resolve=>setImmediate(resolve));assert.equal(h.requests.length,2);assert.equal(h.requests[1].body.id,B.id);
 assert.equal(form.getAttribute('aria-busy'),'true');assert.equal(submit.disabled,true);
 h.requests[0].response.resolve({ok:true,status:200,json:async()=>({produto:{...A,nome:'Produto sintético A salvo',versao:2}})});await pendingA;
 assert.equal(h.node('financeiro-produto-id').value,B.id);
 assert.equal(form.getAttribute('aria-busy'),'true','A finally must not clear B busy state');
 assert.equal(submit.disabled,true,'A finally must not permit another submission of B');
 h.requests[1].response.resolve({ok:true,status:200,json:async()=>({produto:{...B,nome:'Produto sintético B salvo',versao:5}})});await pendingB;
 assert.equal(form.getAttribute('aria-busy'),'false');assert.equal(submit.disabled,false);
 assert.equal(h.node('financeiro-produto-id').value,B.id);assert.equal(Number(h.node('financeiro-produto-versao').value),5);
 assert.equal(h.api.productRegistry().find(p=>p.id===A.id).versao,2);
 assert.equal(h.api.productRegistry().find(p=>p.id===B.id).versao,5);
});

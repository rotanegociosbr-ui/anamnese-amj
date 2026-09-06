const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
function harness(){
 const nodes=new Map();function el(id){if(!nodes.has(id))nodes.set(id,{value:'',textContent:'',disabled:false,open:false,events:new Map(),addEventListener(n,f){this.events.set(n,f);},removeEventListener(n){this.events.delete(n);},showModal(){this.open=true;},close(){this.open=false;}});return nodes.get(id);}
 let seq=0;
 const env={window:{},el,atob:s=>Buffer.from(s,'base64').toString(),authSession:{user:{id:'owner-a'},access_token:'x.'+Buffer.from(JSON.stringify({session_id:'session-a'})).toString('base64')+'.x'},identidadeBackend:{role:'owner'},sessaoAplicativoAtiva:()=>true,sessaoAindaValida:()=>true,operacaoId:()=>String(++seq)};
 vm.createContext(env); vm.runInContext(html.slice(html.indexOf('let cancelarConfirmacaoAdmin'),html.indexOf('async function acessoNegado()')),env);
 return {env,el,api:env.window.AMJProtecao,fire:(id,name)=>el(id).events.get(name)({preventDefault(){}})};
}
test('ordinary administrator edit has no password, dialog or credential and uses a unique operation',async()=>{
 const h=harness(),a=await h.api.solicitarEdicaoRotineira({motivo:'Editar cadastro'}),b=await h.api.solicitarEdicaoRotineira({motivo:'Editar cadastro'});
 assert.notEqual(a.operation_id,b.operation_id);assert.equal(a.token,undefined);assert.equal(h.el('reauth-dialog').open,false);
});
test('critical action waits for explicit confirmation without any password field',async()=>{
 const h=harness(),p=h.api.solicitarSenhaRecente({titulo:'Arquivar produto',motivo:'Correção de cadastro'});
 assert.equal(h.el('reauth-dialog').open,true);h.fire('reauth-form','submit');
 const action=await p;assert.equal(action.motivo,'Correção de cadastro');assert.equal(action.token,undefined);
 assert.equal(h.el('reauth-dialog').open,false);
 assert.doesNotMatch(html,/id="reauth-senha"|grant_type=password|edicao-autorizada\.js/);
});
test('cancel never emits an operation',async()=>{
 const h=harness(),p=h.api.solicitarSenhaRecente({});h.fire('reauth-cancelar','click');await assert.rejects(p,{code:'operation_cancelled'});
});
test('another session cannot confirm a dialog opened by the previous session',async()=>{
 const h=harness(),p=h.api.solicitarSenhaRecente({motivo:'Teste'});h.env.authSession.user.id='other-owner';h.fire('reauth-form','submit');await assert.rejects(p,/sessão mudou/);
});
test('logout cancels pending confirmation and nonowners/expired sessions cannot request actions',async()=>{
 const h=harness(),p=h.api.solicitarSenhaRecente({});vm.runInContext('cancelarConfirmacaoAdmin()',h.env);await assert.rejects(p,{code:'operation_cancelled'});
 h.env.identidadeBackend.role='assistant';await assert.rejects(h.api.solicitarEdicaoRotineira({}),/administrador/);
 h.env.identidadeBackend.role='owner';h.env.sessaoAindaValida=()=>false;await assert.rejects(h.api.solicitarEdicaoRotineira({}),/administrador/);
});

'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const html=fs.readFileSync(path.resolve(__dirname,'../index.html'),'utf8');
const read=(from,to)=>html.slice(html.indexOf(from),html.indexOf(to,html.indexOf(from)));
function pending(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}
function fixture(){
 const nodes=new Map(),state={active:true,denials:0,renders:0};
 const el=id=>{if(!nodes.has(id))nodes.set(id,{innerHTML:'',textContent:'',className:'',setAttribute(k,v){this[k]=v;},classList:{toggle(){},add(){}}});return nodes.get(id);};
 const context={console,Date,performance,Response,el,API:'https://synthetic.invalid',dadosGeracao:0,fichasRequisicao:0,fichasCarregadas:false,agendaRequisicao:0,
 cachePainel:{fichas:[],documentos:[],totais:{}},sessaoAplicativoAtiva:()=>state.active,cabecalhosAcesso:async()=>({}),atualizarIdentidade(){},
 renderizarPainel(){state.renders++;el('lista').innerHTML='saved:'+context.cachePainel.fichas.map(x=>x.id).join(',');},
 acessoNegado:async()=>{state.denials++;state.active=false;context.dadosGeracao++;context.cachePainel={fichas:[],documentos:[]};el('lista').innerHTML='';},
 fetch:async()=>Response.json({fichas:[{id:'existing'}],documentos:[]}),
 agendaCarregando:false,agendaCarregada:false,agendaCache:[],agendaLembretes:[],agendaAutomacao:null,
 agendaNormalizar:x=>x,agendaNormalizarLembrete:x=>x,agendaAtualizarEstadoCentral(){},renderizarAgenda(){state.renders++;},
 agendaRequest:async()=>({agendamentos:[{id:'saved-appointment'}],lembretes_pendentes:[]})};
 vm.createContext(context);vm.runInContext(read('async function carregar()','async function alterarArquivamentoFicha'),context);
 vm.runInContext(read('async function carregarAgenda(opcoes)','function agendaPararPolling()'),context);
 return {context,state,el};
}
test('documents remain visible after network failure and malformed refresh',async()=>{
 const h=fixture();await h.context.carregar();const previous=h.context.cachePainel;
 for(const fetch of [async()=>{throw Error('offline');},async()=>Response.json({}),async()=>Response.json({fichas:[],documentos:[]},{status:503})]){
 h.context.fetch=fetch;await h.context.carregar();assert.equal(h.context.cachePainel,previous);assert.equal(h.el('lista').innerHTML,'saved:existing');assert.match(h.el('fichas-status').textContent,/continuam visíveis/);assert.equal(h.el('lista')['aria-busy'],'false');
 }
});
test('a genuinely empty successful result is distinguished from failed loading',async()=>{
 const h=fixture();await h.context.carregar();h.context.fetch=async()=>Response.json({fichas:[],documentos:[]});await h.context.carregar();
 assert.equal(h.context.cachePainel.fichas.length,0);assert.equal(h.el('lista').innerHTML,'saved:');assert.equal(h.context.fichasCarregadas,true);
});
test('late documents cannot replace a newer refresh',async()=>{
 const h=fixture(),old=pending();h.context.fetch=()=>old.promise;const loading=h.context.carregar();
 h.context.fetch=async()=>Response.json({fichas:[{id:'newer'}],documentos:[]});await h.context.carregar();old.resolve(Response.json({fichas:[{id:'older'}],documentos:[]}));await loading;
 assert.equal(h.el('lista').innerHTML,'saved:newer');
});
test('late document denial from previous login never logs out new session',async()=>{
 const h=fixture(),old=pending();h.context.fetch=()=>old.promise;const loading=h.context.carregar();h.context.dadosGeracao++;h.context.fichasRequisicao++;
 old.resolve(new Response(null,{status:401}));await loading;assert.equal(h.state.denials,0);assert.equal(h.state.renders,0);
});
test('current unauthorized documents close access instead of preserving private data',async()=>{
 const h=fixture();await h.context.carregar();h.context.fetch=async()=>new Response(null,{status:403});await h.context.carregar();
 assert.equal(h.state.denials,1);assert.equal(h.el('lista').innerHTML,'');
});
test('late agenda cannot repopulate after logout or release a newer loading flag',async()=>{
 const h=fixture(),old=pending();h.context.agendaRequest=()=>old.promise;const loading=h.context.carregarAgenda();h.context.dadosGeracao++;h.context.agendaRequisicao++;
 h.context.agendaCarregando=true;old.resolve({agendamentos:[{id:'old'}]});await loading;assert.equal(h.context.agendaCache.length,0);assert.equal(h.context.agendaCarregando,true);assert.equal(h.state.renders,0);
});
test('agenda malformed refresh does not erase saved appointments',async()=>{
 const h=fixture();await h.context.carregarAgenda();const previous=h.context.agendaCache;h.context.agendaRequest=async()=>({});await h.context.carregarAgenda();
 assert.equal(h.context.agendaCache,previous);assert.equal(h.context.agendaCache[0].id,'saved-appointment');assert.equal(h.context.agendaCarregando,false);
});
test('logout explicitly clears document data and invalidates pending reads',()=>{
 const source=read('function limparEstadoAplicativo()','function finalizarSaidaInterface');
 assert.match(source,/dadosGeracao \+= 1/);assert.match(source,/cachePainel = \{ fichas: \[\], documentos: \[\]/);
 assert.match(source,/el\('lista'\)\.innerHTML = ''/);assert.match(source,/fichasCarregadas = false/);
});

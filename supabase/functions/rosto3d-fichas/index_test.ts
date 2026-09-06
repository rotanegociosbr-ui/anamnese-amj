import {emptyStudy} from '../_shared/facial-study.mjs';
const C='22222222-2222-4222-8222-222222222222',U='11111111-1111-4111-8111-111111111111';
const P='33333333-3333-4333-8333-333333333333',Q='44444444-4444-4444-8444-444444444444';
const OP='55555555-5555-4555-8555-555555555555',SESSION='66666666-6666-4666-8666-666666666666';
const SECONDARY='77777777-7777-4777-8777-777777777777',PROOF='88888888-8888-4888-8888-888888888888';
Deno.env.set('SUPABASE_URL','https://facial-test.invalid');
Deno.env.set('SUPABASE_SERVICE_ROLE_KEY','test-only-not-a-real-key');
// Preserve the production entrypoint; intercept only its listener during import.
const originalServe=Deno.serve;
let registeredHandler:unknown;
Deno.serve=((callback:unknown)=>{registeredHandler=callback;return {};}) as typeof Deno.serve;
const {handler}=await import('./index.ts').finally(()=>{Deno.serve=originalServe;});
if(registeredHandler!==handler)throw Error('Production entrypoint did not register its handler');
function assert(ok:unknown,message='assertion failed'):asserts ok{if(!ok)throw Error(message);}
function token(aal='aal2',secondary=false){return ['header',btoa(JSON.stringify({sub:U,role:'authenticated',aal,iss:'https://facial-test.invalid/auth/v1',exp:Math.floor(Date.now()/1000)+600,session_id:secondary?SECONDARY:SESSION,amr:[{method:'password',timestamp:Math.floor(Date.now()/1000)}]})),'signature'].join('.');}
const protocol=()=>({id:Q,patient_id:P,version:3,archived_at:null});
const payload=()=>({acao:'salvar',protocolo_id:Q,operation_id:OP,expected_version:0,expected_patient_id:P,expected_protocol_version:3,document:emptyStudy(),motivo:'Teste sintético'});
type Options={role?:string;aal?:string;active?:boolean;archived?:boolean;missing?:boolean;prior?:Record<string,unknown>;rpcError?:Record<string,unknown>;proof?:boolean;protocolRecheck?:Record<string,unknown>|null};
async function run(body:unknown,options:Options={}){
 const calls:{url:string;body:Record<string,unknown>|undefined}[]=[],original=globalThis.fetch;
 let protocolReads=0;
 globalThis.fetch=async(input,init)=>{
  const url=String(input),data=init?.body?JSON.parse(String(init.body)):undefined;calls.push({url,body:data});
  if(url.endsWith('/auth/v1/user'))return Response.json({id:U,is_anonymous:false});
  if(url.endsWith('/rpc/clinic_validate_auth_session'))return Response.json(options.active!==false);
  if(url.includes('/clinic_members?'))return Response.json([{clinic_id:C,user_id:U,role:options.role||'owner',status:'active'}]);
  if(url.includes('/protocols?')){
   protocolReads++;
   if(protocolReads>1&&options.protocolRecheck!==undefined)return Response.json(options.protocolRecheck===null?[]:[{...protocol(),...options.protocolRecheck}]);
   return Response.json(options.missing?[]:[{...protocol(),archived_at:options.archived?'2026-01-01':null}]);
  }
  if(url.includes('/facial_studies?'))return Response.json(options.prior?[options.prior]:[]);
  if(url.endsWith('/rpc/clinic_register_password_proof')||url.endsWith('/rpc/clinic_consume_password_proof'))return Response.json({ok:true,proof_id:PROOF});
  if(url.endsWith('/rpc/facial_study_save'))return options.rpcError?Response.json(options.rpcError,{status:400}):Response.json({id:OP,version:1,document:data.p_document});
  if(url.endsWith('/clinic_audit_log'))return new Response(null,{status:201});
  throw Error('Unmocked request: '+url);
 };
 try{
  const headers:Record<string,string>={'content-type':'application/json','authorization':'Bearer '+token(options.aal)};
  if(options.proof)headers['x-amj-reauthentication']='Bearer '+token('aal1',true);
  const response=await handler(new Request('https://facial-test.invalid/function',{method:'POST',headers,body:JSON.stringify(body)}));
  return {status:response.status,body:await response.json(),calls};
 }finally{globalThis.fetch=original;}
}
Deno.test('open returns authoritative binding and filters clinic',async()=>{
 const r=await run({acao:'abrir',protocolo_id:Q});assert(r.status===200);
 assert(JSON.stringify(r.body.binding)===JSON.stringify({protocol_id:Q,patient_id:P,protocol_version:3}));
 assert(r.calls.filter(c=>/\/(protocols|facial_studies)\?/.test(c.url)).every(c=>c.url.includes('clinic_id=eq.'+C)));
 assert(r.calls.filter(c=>/\/(protocols|facial_studies)\?/.test(c.url)).map(c=>c.url.includes('/protocols?')?'protocol':'study').join(',')==='protocol,study,protocol');
});
for(const [change,protocolRecheck]of [['patient',{patient_id:OP}],['version',{version:4}],['archive',{archived_at:'2026-09-06'}],['missing or another clinic',null]] as const)Deno.test('open refuses '+change+' changed between separate REST reads without returning clinical data',async()=>{
 const prior={id:OP,version:1,document:{...emptyStudy(),notes:'Synthetic new patient record'}};
 const r=await run({acao:'abrir',protocolo_id:Q},{prior,protocolRecheck});
 assert(r.status===409);assert(r.body.codigo==='protocol_context_conflict');assert(!('study'in r.body));assert(!('binding'in r.body));
 assert(r.calls.filter(c=>c.url.includes('/protocols?')).length===2);
 assert(!r.calls.some(c=>c.url.includes('password_proof')||c.url.endsWith('/rpc/facial_study_save')));
});
for(const [name,options]of [['AAL1',{aal:'aal1'}],['professional',{role:'professional'}],['revoked',{active:false}]] as const)Deno.test('denies '+name+' before clinical reads',async()=>{
 const r=await run(payload(),options);assert([401,403].includes(r.status));assert(!r.calls.some(c=>c.url.includes('/protocols?')));
});
Deno.test('save requires an opened patient and consultation version',async()=>{
 const body=payload();delete (body as Partial<typeof body>).expected_patient_id;const r=await run(body);assert(r.status===422);assert(r.body.codigo==='invalid_context');
});
for(const field of ['expected_patient_id','expected_protocol_version'] as const)Deno.test('stale '+field+' conflicts before password consumption',async()=>{
 const body=payload();if(field==='expected_patient_id')body[field]=OP;else body[field]=2;
 const r=await run(body);assert(r.status===409);assert(r.body.codigo==='protocol_context_conflict');assert(!r.calls.some(c=>c.url.includes('password_proof')));
});
Deno.test('archived or another-clinic consultation does not expose a study',async()=>{
 for(const o of [{archived:true},{missing:true}]){const r=await run(payload(),o);assert(r.status===404);assert(!r.calls.some(c=>c.url.includes('/facial_studies?')));}
});
Deno.test('save without secondary password proof cannot call write RPC',async()=>{
 const r=await run(payload());assert(r.status===403);assert(!r.calls.some(c=>c.url.endsWith('/rpc/facial_study_save')));
});
Deno.test('save passes binding to RPC after password proof consumption',async()=>{
 const r=await run(payload(),{proof:true});assert(r.status===200);
 const call=r.calls.find(c=>c.url.endsWith('/rpc/facial_study_save'));assert(call?.body?.p_expected_patient_id===P);assert(call.body.p_expected_protocol_version===3);
 assert(r.calls.findIndex(c=>c.url.endsWith('/rpc/clinic_consume_password_proof'))<r.calls.indexOf(call));
});
Deno.test('same successful operation recovers dropped response without consumed proof',async()=>{
 const prior={id:OP,version:1,clinic_id:C,protocol_id:Q,created_by:U,document:emptyStudy()};
 const r=await run(payload(),{prior});assert(r.status===200);assert(r.body.study.id===OP);assert(!r.calls.some(c=>c.url.includes('password_proof')||c.url.endsWith('/rpc/facial_study_save')));
 const changed=payload();changed.document.notes='Different';assert((await run(changed,{prior})).status===409);
});
Deno.test('RPC context conflict after initial protocol read retains its HTTP409 code',async()=>{
 const r=await run(payload(),{proof:true,rpcError:{code:'40001',message:'facial_protocol_context_conflict'}});assert(r.status===409);assert(r.body.codigo==='protocol_context_conflict');
});

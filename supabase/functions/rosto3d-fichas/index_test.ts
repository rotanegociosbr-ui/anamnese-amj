import {emptyStudy} from '../_shared/facial-study.mjs';
const C='22222222-2222-4222-8222-222222222222',U='11111111-1111-4111-8111-111111111111';
const P='33333333-3333-4333-8333-333333333333',Q='44444444-4444-4444-8444-444444444444';
const OP='55555555-5555-4555-8555-555555555555',SESSION='66666666-6666-4666-8666-666666666666';
Deno.env.set('SUPABASE_URL','https://facial-test.invalid');
Deno.env.set('SUPABASE_SERVICE_ROLE_KEY','test-only-not-a-real-key');
// Preserve the production entrypoint; intercept only its listener during import.
const originalServe=Object.getOwnPropertyDescriptor(Deno,'serve');
if(!originalServe?.configurable)throw Error('Test runtime must permit interception of its server listener');
let registeredHandler:unknown;
Object.defineProperty(Deno,'serve',{configurable:true,value:(callback:unknown)=>{registeredHandler=callback;return {};}});
const {handler}=await import('./index.ts').finally(()=>{Object.defineProperty(Deno,'serve',originalServe);});
if(registeredHandler!==handler)throw Error('Production entrypoint did not register its handler');
function assert(ok:unknown,message='assertion failed'):asserts ok{if(!ok)throw Error(message);}
function token(aal='aal2'){return ['header',btoa(JSON.stringify({sub:U,role:'authenticated',aal,iss:'https://facial-test.invalid/auth/v1',exp:Math.floor(Date.now()/1000)+600,session_id:SESSION,amr:[{method:'password',timestamp:Math.floor(Date.now()/1000)}]})),'signature'].join('.');}
const protocol=()=>({id:Q,patient_id:P,version:3,archived_at:null});
const payload=()=>({acao:'salvar',protocolo_id:Q,operation_id:OP,expected_version:0,expected_patient_id:P,expected_protocol_version:3,document:emptyStudy(),motivo:'Teste sintético'});
type Options={role?:string;aal?:string;active?:boolean;activeRecheck?:boolean;roleRecheck?:string;clinicRecheck?:string;archived?:boolean;missing?:boolean;prior?:Record<string,unknown>;rpcError?:Record<string,unknown>;protocolRecheck?:Record<string,unknown>|null};
async function run(body:unknown,options:Options={}){
 const calls:{url:string;body:Record<string,unknown>|undefined}[]=[],original=globalThis.fetch;
 let protocolReads=0,sessionReads=0,membershipReads=0;
 globalThis.fetch=async(input,init)=>{
  const requestBody=init&&'body'in init?init.body:undefined;
  const url=String(input),data=requestBody?JSON.parse(String(requestBody)):undefined;calls.push({url,body:data});
  if(url.endsWith('/auth/v1/user'))return Response.json({id:U,is_anonymous:false});
  if(url.endsWith('/rpc/clinic_validate_auth_session'))return Response.json(++sessionReads>1?options.activeRecheck!==false:options.active!==false);
  if(url.includes('/clinic_members?')){
   membershipReads++;
   return Response.json([{clinic_id:membershipReads>1?(options.clinicRecheck||C):C,user_id:U,
    role:membershipReads>1?(options.roleRecheck||options.role||'owner'):(options.role||'owner'),status:'active'}]);
  }
  if(url.includes('/protocols?')){
   protocolReads++;
   if(protocolReads>1&&options.protocolRecheck!==undefined)return Response.json(options.protocolRecheck===null?[]:[{...protocol(),...options.protocolRecheck}]);
   return Response.json(options.missing?[]:[{...protocol(),archived_at:options.archived?'2026-01-01':null}]);
  }
  if(url.includes('/facial_studies?'))return Response.json(options.prior?[options.prior]:[]);
  if(url.endsWith('/rpc/facial_study_save'))return options.rpcError?Response.json(options.rpcError,{status:400}):Response.json({id:OP,version:1,document:data.p_document});
  if(url.endsWith('/clinic_audit_log'))return new Response(null,{status:201});
  throw Error('Unmocked request: '+url);
 };
 try{
  const headers:Record<string,string>={'content-type':'application/json','authorization':'Bearer '+token(options.aal)};
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
for(const field of ['expected_patient_id','expected_protocol_version'] as const)Deno.test('stale '+field+' conflicts before write RPC',async()=>{
 const body=payload();if(field==='expected_patient_id')body[field]=OP;else body[field]=2;
 const r=await run(body);assert(r.status===409);assert(r.body.codigo==='protocol_context_conflict');assert(!r.calls.some(c=>c.url.endsWith('/rpc/facial_study_save')));
});
Deno.test('archived or another-clinic consultation does not expose a study',async()=>{
 for(const o of [{archived:true},{missing:true}]){const r=await run(payload(),o);assert(r.status===404);assert(!r.calls.some(c=>c.url.includes('/facial_studies?')));}
});
Deno.test('owner save uses the current MFA session without a secondary password or edit window',async()=>{
 const r=await run(payload());assert(r.status===200);
 const validations=r.calls.filter(c=>c.url.endsWith('/rpc/clinic_validate_auth_session'));
 assert(validations.length===2,'Both initial authentication and pre-write authorization must validate the live session');
 assert(validations.every(c=>c.body?.p_session_id===SESSION));
 assert(!r.calls.some(c=>/password_proof|routine_edit_authorization/.test(c.url)));
 const write=r.calls.findIndex(c=>c.url.endsWith('/rpc/facial_study_save'));
 assert(write>r.calls.indexOf(validations[1]),'Revalidation must precede persistence');
});
Deno.test('save passes authoritative actor, tenant and optimistic binding to the write RPC',async()=>{
 const r=await run(payload());assert(r.status===200);
 const call=r.calls.find(c=>c.url.endsWith('/rpc/facial_study_save'));assert(call?.body?.p_expected_patient_id===P);assert(call.body.p_expected_protocol_version===3);
 assert(call.body.p_clinic_id===C&&call.body.p_actor_id===U&&call.body.p_protocol_id===Q);
 assert(call.body.p_expected_version===0&&call.body.p_operation_id===OP);
 assert(r.calls.some(c=>c.url.endsWith('/clinic_audit_log')),'Successful save must retain audit');
});
for(const [change,options] of [['revoked session',{activeRecheck:false}],['lost owner role',{roleRecheck:'professional'}],['changed clinic',{clinicRecheck:OP}]] as const)Deno.test('save denies '+change+' during authorization recheck before persistence',async()=>{
 const r=await run(payload(),options);assert([401,403].includes(r.status));
 assert(!r.calls.some(c=>c.url.endsWith('/rpc/facial_study_save')));
 assert(!r.calls.some(c=>/password_proof|routine_edit_authorization/.test(c.url)));
});
Deno.test('same successful operation recovers dropped response without duplicate persistence',async()=>{
 const prior={id:OP,version:1,clinic_id:C,protocol_id:Q,created_by:U,document:emptyStudy()};
 const r=await run(payload(),{prior});assert(r.status===200);assert(r.body.study.id===OP);assert(!r.calls.some(c=>c.url.includes('password_proof')||c.url.endsWith('/rpc/facial_study_save')));
 const changed=payload();changed.document.notes='Different';assert((await run(changed,{prior})).status===409);
});
Deno.test('RPC context conflict after initial protocol read retains its HTTP409 code',async()=>{
 const r=await run(payload(),{rpcError:{code:'40001',message:'facial_protocol_context_conflict'}});assert(r.status===409);assert(r.body.codigo==='protocol_context_conflict');
});

// Exercise the real deployed-style listener with synthetic requests/transports.
import assert from 'node:assert/strict';
const BASE='https://draft-operation.invalid';
const U='11111111-1111-4111-8111-111111111111',C='22222222-2222-4222-8222-222222222222';
const P='33333333-3333-4333-8333-333333333333',Q='44444444-4444-4444-8444-444444444444';
const KEY='55555555-5555-4555-8555-555555555555',S='66666666-6666-4666-8666-666666666666';
const OP='77777777-7777-4777-8777-777777777777';
Deno.env.set('SUPABASE_URL',BASE);Deno.env.set('SUPABASE_SERVICE_ROLE_KEY','synthetic-test-only');
const descriptor=Object.getOwnPropertyDescriptor(Deno,'serve');
if(!descriptor?.configurable)throw Error('Listener interception unavailable');
let listener:(request:Request)=>Promise<Response>;
Object.defineProperty(Deno,'serve',{configurable:true,value:(fn:typeof listener)=>{listener=fn;return {};}});
await import('./index.ts').finally(()=>{Object.defineProperty(Deno,'serve',descriptor);});
function token(aal='aal2'){return ['header',btoa(JSON.stringify({sub:U,role:'authenticated',aal,
 iss:BASE+'/auth/v1',exp:Math.floor(Date.now()/1000)+600,session_id:S})),'signature'].join('.');}
const draft=()=>({acao:'criar_atualizar',protocolo_id:Q,versao_esperada:3,paciente_id:P,
 idempotency_key:KEY,produtos:[{lot:'LOTE SINTÉTICO'}]});
type Options={aal?:string;revokedRecheck?:boolean;roleRecheck?:string;version?:number;missing?:boolean};
async function run(body:Record<string,unknown>,options:Options={}){
 const original=fetch,calls:{url:string;body:Record<string,unknown>|undefined}[]=[];
 let sessions=0,members=0;
 globalThis.fetch=async(input,init)=>{
  const url=String(input),data=init?.body?JSON.parse(String(init.body)):undefined;calls.push({url,body:data});
  if(url.endsWith('/auth/v1/user'))return Response.json({id:U,is_anonymous:false});
  if(url.endsWith('/rpc/clinic_validate_auth_session'))return Response.json(++sessions===1||!options.revokedRecheck);
  if(url.includes('/clinic_members?'))return Response.json([{clinic_id:C,user_id:U,status:'active',role:++members>1?(options.roleRecheck||'owner'):'owner'}]);
  if(url.includes('/protocols?'))return Response.json(options.missing?[]:[{id:Q,patient_id:P,appointment_id:null,version:options.version||3}]);
  if(url.endsWith('/rpc/prontuario_salvar_rascunho_com_estoque'))return Response.json({id:Q,version:4,created:data.p_protocol_id===null,product_count:1});
  if(url.endsWith('/clinic_audit_log'))return new Response(null,{status:201});
  throw Error('Unexpected transport '+url);
 };
 try{
  const response=await listener(new Request(BASE,{method:'POST',headers:{authorization:'Bearer '+token(options.aal),'content-type':'application/json'},body:JSON.stringify(body)}));
  return {status:response.status,body:await response.json(),calls};
 }finally{globalThis.fetch=original;}
}
const writes=(r:Awaited<ReturnType<typeof run>>)=>r.calls.filter(c=>c.url.endsWith('/rpc/prontuario_salvar_rascunho_com_estoque'));
Deno.test('existing explicit operation ID remains authoritative and edits the same consultation',async()=>{
 const r=await run({...draft(),operation_id:OP});assert.equal(r.status,200);
 assert.equal(writes(r).length,1);assert.equal(writes(r)[0].body?.p_protocol_id,Q);assert.equal(writes(r)[0].body?.p_request_id,OP);
});
Deno.test('missing operation ID falls back to the already-required idempotency key, not a new record',async()=>{
 const r=await run(draft());assert.equal(r.status,200);
 const body=writes(r)[0].body!;assert.equal(body.p_request_id,KEY);assert.equal(body.p_idempotency_key,KEY);
 assert.equal(body.p_protocol_id,Q);assert.equal(body.p_expected_version,3);assert.equal(body.p_patient_id,P);
 assert.equal(r.calls.filter(c=>c.url.endsWith('/rpc/clinic_validate_auth_session')).length,2);
});
Deno.test('creation with explicit consent uses the same request/idempotency key when operation ID is absent',async()=>{
 const r=await run({...draft(),protocolo_id:null,versao_esperada:undefined,consentimentos:{clinical_photography:false}});
 assert.equal(r.status,200);assert.equal(writes(r)[0].body?.p_protocol_id,null);
 assert.equal(writes(r)[0].body?.p_request_id,KEY);assert.deepEqual(writes(r)[0].body?.p_consents,{clinical_photography:false});
 assert.equal(r.calls.filter(c=>c.url.endsWith('/rpc/clinic_validate_auth_session')).length,2);
});
Deno.test('creation without consent still needs only its normal idempotency key',async()=>{
 const r=await run({...draft(),protocolo_id:null,versao_esperada:undefined});assert.equal(r.status,200);
 assert.equal(writes(r)[0].body?.p_request_id,KEY);
});
Deno.test('legacy complete-product creation with photography false and only primary login is accepted',async()=>{
 const legacy={acao:'criar_atualizar',protocolo_id:null,paciente_id:P,agendamento_id:null,
  tipo_procedimento:'toxina_botulinica',queixa:'Anotação sintética',anamnese:{},notas_tecnica:null,
  data_procedimento:'2026-09-06',data_retorno:null,orientacoes:null,idempotency_key:KEY,
  produtos:[{product_id:OP,lot:'LOTE SINTÉTICO',expiry:'2027-09-06',amount:'1',unit:'mL',position:1}],
  consentimentos:{clinical_photography:false}};
 const r=await run(legacy);assert.equal(r.status,200);assert.equal(writes(r).length,1);
 const body=writes(r)[0].body!;assert.equal(body.p_protocol_id,null);assert.equal(body.p_request_id,KEY);
 assert.deepEqual(body.p_products,legacy.produtos);assert.deepEqual(body.p_consents,legacy.consentimentos);
 assert(!r.calls.some(c=>/password_proof|routine_edit_authorization/.test(c.url)));
});
Deno.test('explicit malformed/null/empty operation IDs never fall back',async()=>{
 for(const operation_id of [null,'','not-a-uuid',42])for(const create of [false,true]){
  const r=await run({...draft(),operation_id,...(create?{protocolo_id:null,consentimentos:{clinical_photography:false}}:{})});
  assert.equal(r.status,422);assert.equal(r.body.codigo,'operation_id_required');assert.equal(writes(r).length,0);}
});
Deno.test('fallback never bypasses stale version or missing clinic-scoped protocol',async()=>{
 const stale=await run(draft(),{version:4});assert.equal(stale.status,409);assert.equal(stale.body.codigo,'version_conflict');assert.equal(writes(stale).length,0);
 const missing=await run(draft(),{missing:true});assert.equal(missing.status,404);assert.equal(writes(missing).length,0);
});
Deno.test('replayed product update after committed version cannot write a second time',async()=>{
 const first=await run(draft());assert.equal(first.status,200);assert.equal(writes(first).length,1);
 // The authoritative protocol read now reflects the committed version. The
 // request keeps its original key/version, so it fails before another RPC.
 const replay=await run(draft(),{version:4});assert.equal(replay.status,409);
 assert.equal(replay.body.codigo,'version_conflict');assert.equal(writes(replay).length,0);
});
Deno.test('fallback still rejects AAL1, revocation and lost owner membership before persistence',async()=>{
 for(const options of [{aal:'aal1'},{revokedRecheck:true},{roleRecheck:'professional'}]){
  const r=await run(draft(),options);assert([401,403].includes(r.status));assert.equal(writes(r).length,0);}
});

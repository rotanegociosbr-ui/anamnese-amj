// Actual Edge handler, synthetic transport only: no auth tokens, server or real records.
import assert from 'node:assert/strict';
const source=await Deno.readTextFile(new URL('./index.ts',import.meta.url));
const take=(from:string,to:string)=>{const start=source.indexOf(from),end=source.indexOf(to,start);if(start<0||end<0)throw Error('Missing boundary');return source.slice(start,end);};
const constants=source.split('\n').filter(line=>/^const (UUID_PATTERN|DATE_PATTERN) =/.test(line)).join('\n');
const moduleSource=`type JsonRecord=Record<string,any>;type DualAuthContext=JsonRecord;
${take('class ApiError','function cors(')}
${constants}
${take('function safeText(','function tenant(')}
let current:JsonRecord|null;let mode:string;let reads:string[];let calls:JsonRecord[];
function tenant(_context:DualAuthContext){return {clinicId:'11111111-1111-4111-8111-111111111111',userId:'22222222-2222-4222-8222-222222222222'};}
function baseRpc(context:DualAuthContext){return {p_clinic_id:tenant(context).clinicId};}
async function requestId(_req:Request,_context:DualAuthContext,payload:JsonRecord){return payload.operation_id;}
async function rest(path:string){reads.push(path);return current?[current]:[];}
async function rpc(name:string,body:JsonRecord){calls.push({name,...body});if(mode==='replay')return {id:body.p_attendance_id,version:current.version,idempotent:true};if(mode==='conflict')throw new ApiError(409,'version_conflict','Atualize o registro.');return {id:body.p_attendance_id,version:(body.p_expected_version||0)+1,idempotent:false};}
function response(_req:Request,result:JsonRecord){return new Response(JSON.stringify(result));}
${take('async function handleSaveAttendance(','async function handleArchive(')}
export async function run(payload:JsonRecord,row:JsonRecord|null,behavior='ok'){
current=row;mode=behavior;reads=[];calls=[];try{const result=await handleSaveAttendance(new Request('https://synthetic.invalid'),{},payload);return {data:await result.json(),reads,calls};}
catch(error){return {error:{code:error.code,status:error.status,message:error.message},reads,calls};}}
`;
const {run}=await import('data:application/typescript,'+encodeURIComponent(moduleSource));
const id='33333333-3333-4333-8333-333333333333',patient='44444444-4444-4444-8444-444444444444',appointment='55555555-5555-4555-8555-555555555555',protocol='66666666-6666-4666-8666-666666666666',entry='77777777-7777-4777-8777-777777777777';
const row={id,version:5,appointment_id:appointment,protocol_id:protocol,financial_entry_id:entry};
const payload={atendimento_id:id,versao:5,cliente_id:patient,responsavel_id:'22222222-2222-4222-8222-222222222222',
agendamento_id:appointment,protocolo_id:protocol,lancamento_financeiro_id:entry,procedimento:'Teste sintético',
realizado_em:'2026-09-06T12:00:00Z',duracao_minutos:30,status:'realizado',
idempotency_key:'88888888-8888-4888-8888-888888888888',operation_id:'99999999-9999-4999-8999-999999999999'};
Deno.test('unchanged attendance links reach the RPC with exact scope and version',async()=>{
 const r=await run(payload,row);assert.equal(r.error,undefined);assert.equal(r.calls.length,1);assert.equal(r.calls[0].p_protocol_id,protocol);assert.equal(r.calls[0].p_expected_version,5);
 assert.equal(r.reads.length,1);assert(r.reads[0].includes('clinic_id=eq.11111111-1111-4111-8111-111111111111'));assert(r.reads[0].includes('id=eq.'+id));
});
for(const field of ['agendamento_id','protocolo_id','lancamento_financeiro_id'])Deno.test('old UI cannot silently remove '+field,async()=>{
 const r=await run({...payload,[field]:null},row);assert.equal(r.error?.code,'attendance_link_removal_confirmation_required');assert.equal(r.calls.length,0);assert(!r.error.message.includes(id));
 const accepted=await run({...payload,[field]:null,confirmar_remocao_vinculos:[field]},row);assert.equal(accepted.error,undefined);assert.equal(accepted.calls.length,1);
});
Deno.test('confirmation is per exact removed link; malformed/partial confirmations cannot bypass it',async()=>{
 for(const confirmation of [true,'protocolo_id',['protocol_id'],['protocolo_id',7],['protocolo_id']]){
  const r=await run({...payload,protocolo_id:null,lancamento_financeiro_id:null,confirmar_remocao_vinculos:confirmation},row);assert(r.error);assert.equal(r.calls.length,0);
 }
 const r=await run({...payload,agendamento_id:null,protocolo_id:null,lancamento_financeiro_id:null,confirmar_remocao_vinculos:['agendamento_id','protocolo_id','lancamento_financeiro_id']},row);assert.equal(r.error,undefined);assert.equal(r.calls.length,1);
});
Deno.test('new attendance and already empty links need no removal confirmation',async()=>{
 const r=await run({...payload,atendimento_id:null,versao:null,agendamento_id:null,protocolo_id:null,lancamento_financeiro_id:null},null);assert.equal(r.error,undefined);assert.equal(r.reads.length,0);assert.equal(r.calls.length,1);
 const empty=await run({...payload,agendamento_id:null,protocolo_id:null,lancamento_financeiro_id:null},{...row,appointment_id:null,protocol_id:null,financial_entry_id:null});assert.equal(empty.error,undefined);
});
Deno.test('lost-response retry delegates stale version to canonical RPC replay, not a premature rejection',async()=>{
 const r=await run({...payload,versao:4,protocolo_id:null},row,'replay');assert.equal(r.error,undefined);assert.equal(r.data.idempotent,true);assert.equal(r.calls.length,1);assert.equal(r.calls[0].p_request_id,payload.operation_id);
});
Deno.test('unconfirmed stale request is still rejected by the canonical version guard',async()=>{
 const r=await run({...payload,versao:4,protocolo_id:null},row,'conflict');assert.equal(r.error?.code,'version_conflict');assert.equal(r.calls.length,1);
});
Deno.test('future version and missing scoped attendance cannot bypass preflight',async()=>{
 const future=await run({...payload,versao:6,protocolo_id:null},row);assert.equal(future.error?.code,'version_conflict');assert.equal(future.calls.length,0);
 const missing=await run(payload,null);assert.equal(missing.error?.code,'attendance_not_found');assert.equal(missing.calls.length,0);
});
Deno.test('main-session authorization is retained in the actual Edge request path',()=>{
 assert.match(take('async function requireProof(','function response('),/requireAdminSessionAction/);
 assert.match(take('async function handleSaveAttendance(','async function handleArchive('),/await requestId\(req, context, payload, "salvar_atendimento", targetId\)/);
});

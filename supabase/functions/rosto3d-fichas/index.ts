import {authenticateDual,authResponseFields,DualAuthError,requireAdminSessionAction,writeClinicAudit,type DualAuthContext} from '../_shared/dual-auth.ts';
import {validateStudy} from '../_shared/facial-study.mjs';
import registry from '../_shared/facial-registry.json' with {type:'json'};
const base=(Deno.env.get('SUPABASE_URL')||'').replace(/\/+$/,'');
const key=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')||'';
const config={supabaseUrl:base,serviceRoleKey:key,allowedRoles:['owner'] as const,requireAal2:true};
const origins=new Set(['https://anamariajacob.com.br','https://www.anamariajacob.com.br','http://127.0.0.1:8765','http://localhost:8765']);
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
class Failure extends Error {constructor(public status:number,public code:string,message:string){super(message);}}
async function service(path:string,method='GET',body?:unknown){
 const r=await fetch(base+'/rest/v1/'+path,{method,headers:{apikey:key,Authorization:'Bearer '+key,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
 const data=await r.json();
 if(!r.ok){
  if(data?.message==='facial_protocol_context_conflict'||data?.code==='23503')throw new Failure(409,'protocol_context_conflict','A consulta ou paciente foi alterado. Reabra a consulta antes de salvar.');
  if(data?.message==='facial_protocol_unavailable')throw new Failure(404,'protocol_not_found','Consulta indisponível ou arquivada.');
  if(data?.code==='40001'||data?.code==='23505')throw new Failure(409,'version_conflict','Outra versão já foi salva. Reabra o estudo antes de gravar novamente.');
  throw new Failure(503,'storage_unavailable','Não foi possível acessar o estudo agora.');
 }
 return data;
}
async function limitedJSON(req:Request){
 if(!req.headers.get('content-type')?.includes('application/json'))throw new Failure(415,'invalid_type','Conteúdo inválido.');
 const reader=req.body?.getReader();if(!reader)throw new Failure(422,'invalid_body','Conteúdo ausente.');
 const chunks:Uint8Array[]=[];let size=0;
 while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>262144){await reader.cancel();throw new Failure(413,'too_large','O estudo excedeu o limite permitido.');}chunks.push(value);}
 const bytes=new Uint8Array(size);let i=0;for(const chunk of chunks){bytes.set(chunk,i);i+=chunk.length;}
 try{return JSON.parse(new TextDecoder().decode(bytes));}catch{throw new Failure(422,'invalid_json','Conteúdo inválido.');}
}
export async function handler(req:Request){
 const origin=req.headers.get('origin')||'';
 const headers={'Access-Control-Allow-Origin':origins.has(origin)?origin:'https://anamariajacob.com.br','Access-Control-Allow-Headers':'authorization, apikey, content-type, x-client-info, x-amj-reauthentication','Access-Control-Allow-Methods':'POST, OPTIONS','Vary':'Origin','Cache-Control':'no-store','Content-Type':'application/json; charset=utf-8','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'};
 const reply=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers});
 if(origin&&!origins.has(origin))return reply({ok:false,erro:'Origem não permitida.'},403);
 if(req.method==='OPTIONS')return new Response(null,{status:204,headers});
 if(req.method!=='POST')return reply({ok:false,erro:'Método não permitido.'},405);
 let ctx:DualAuthContext|undefined;
 try{
  ctx=await authenticateDual(req,config);
  if(ctx.authMethod!=='supabase_auth'||ctx.aal!=='aal2'||ctx.role!=='owner'||!ctx.userId||!ctx.clinicId)throw new Failure(403,'owner_mfa_required','Confirme seu acesso individual com autenticador.');
  const body=await limitedJSON(req);
  if(!body||typeof body.protocolo_id!=='string'||!uuid.test(body.protocolo_id)||!['abrir','salvar'].includes(body.acao))throw new Failure(422,'invalid_request','Consulta inválida.');
  const protocolPath='protocols?select=id,patient_id,version,procedure_date,procedure_kind,archived_at&clinic_id=eq.'+ctx.clinicId+'&id=eq.'+body.protocolo_id+'&limit=1';
  const protocols=await service(protocolPath);
  const protocol=protocols[0];if(!protocol||protocol.archived_at)throw new Failure(404,'protocol_not_found','Consulta indisponível ou arquivada.');
  const binding={protocol_id:protocol.id,patient_id:protocol.patient_id,protocol_version:protocol.version};
  let study;
  if(body.acao==='abrir'){
   const rows=await service('facial_studies?select=id,version,document,created_at,created_by&clinic_id=eq.'+ctx.clinicId+'&protocol_id=eq.'+protocol.id+'&order=version.desc&limit=1');
   // REST reads have separate snapshots. Before the first study exists, the
   // consultation can move to another patient between these reads. Never pair
   // that patient's new study with the binding captured before the move.
   const latestProtocols=await service(protocolPath),latestProtocol=latestProtocols[0];
   if(!latestProtocol||latestProtocol.archived_at||latestProtocol.id!==binding.protocol_id||latestProtocol.patient_id!==binding.patient_id||latestProtocol.version!==binding.protocol_version)throw new Failure(409,'protocol_context_conflict','A consulta ou paciente foi alterado. Reabra a consulta antes de continuar.');
   study=rows[0]||null;
  }else{
   if(typeof body.operation_id!=='string'||!uuid.test(body.operation_id)||!Number.isInteger(body.expected_version)||body.expected_version<0)throw new Failure(422,'invalid_version','Versão de estudo inválida.');
   if(typeof body.expected_patient_id!=='string'||!uuid.test(body.expected_patient_id)||!Number.isInteger(body.expected_protocol_version)||body.expected_protocol_version<1)throw new Failure(422,'invalid_context','Reabra a consulta para confirmar o vínculo do estudo.');
   if(body.expected_patient_id!==protocol.patient_id||body.expected_protocol_version!==protocol.version)throw new Failure(409,'protocol_context_conflict','A consulta ou paciente foi alterado. Reabra a consulta antes de salvar.');
   let document;
   try{document=validateStudy(body.document,registry);}catch(e){throw new Failure(422,'invalid_study',(e as Error).message);}
   const reason=typeof body.motivo==='string'?body.motivo.trim().slice(0,500):'';
   if(reason.length<3)throw new Failure(422,'reason_required','Informe o motivo do registro.');
   // A successful operation can be read again after a dropped response without
   // reusing its consumed password proof. This branch never performs a write.
   const prior=await service('facial_studies?select=*&clinic_id=eq.'+ctx.clinicId+'&operation_id=eq.'+body.operation_id+'&limit=1');
   if(prior[0]){
    const previous=prior[0];
    if(previous.protocol_id!==protocol.id||previous.created_by!==ctx.userId||JSON.stringify(validateStudy(previous.document,registry))!==JSON.stringify(document))throw new Failure(409,'version_conflict','Esta operação já foi usada para outro registro. Reabra o estudo.');
    study=previous;
   }else{
    await requireAdminSessionAction(req,config,ctx,{operationId:body.operation_id,action:'rosto3d.study.save',targetId:protocol.id});
    study=await service('rpc/facial_study_save','POST',{p_clinic_id:ctx.clinicId,p_actor_id:ctx.userId,p_protocol_id:protocol.id,p_operation_id:body.operation_id,p_expected_version:body.expected_version,p_document:document,p_reason:reason,p_expected_patient_id:body.expected_patient_id,p_expected_protocol_version:body.expected_protocol_version});
   }
  }
  await writeClinicAudit(config,ctx,{entity:'facial_study',entityId:protocol.id,action:body.acao==='abrir'?'read':'save',outcome:'success',details:{endpoint:'rosto3d-fichas',result_count:study?1:0}});
  return reply({ok:true,study,protocolo_id:protocol.id,binding,...authResponseFields(ctx)});
 }catch(error){
  const e=error instanceof DualAuthError?{status:error.status,code:error.code,message:error.publicMessage}:error instanceof Failure?error:{status:500,code:'unavailable',message:'Não foi possível concluir. Suas alterações ainda não foram confirmadas.'};
  if(ctx)await writeClinicAudit(config,ctx,{entity:'facial_study',action:'request',outcome:e.status===401||e.status===403?'denied':'error',details:{endpoint:'rosto3d-fichas',reason_code:e.code}});
  return reply({ok:false,erro:e.message,codigo:e.code},e.status);
 }
}
Deno.serve(handler);

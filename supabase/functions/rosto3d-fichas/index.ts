import {authenticateDual,authResponseFields,DualAuthError,requireRecentPasswordProof,writeClinicAudit,type DualAuthContext} from '../_shared/dual-auth.ts';
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
 if(!r.ok){if(data?.code==='40001'||data?.code==='23505')throw new Failure(409,'version_conflict','Outra versão já foi salva. Reabra o estudo antes de gravar novamente.');throw new Failure(503,'storage_unavailable','Não foi possível acessar o estudo agora.');}
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
  if(!body||!uuid.test(body.protocolo_id)||!['abrir','salvar'].includes(body.acao))throw new Failure(422,'invalid_request','Consulta inválida.');
  const protocols=await service('protocols?select=id,patient_id,procedure_date,procedure_kind,archived_at&clinic_id=eq.'+ctx.clinicId+'&id=eq.'+body.protocolo_id+'&limit=1');
  const protocol=protocols[0];if(!protocol||protocol.archived_at)throw new Failure(404,'protocol_not_found','Consulta indisponível ou arquivada.');
  let study;
  if(body.acao==='abrir'){
   const rows=await service('facial_studies?select=id,version,document,created_at,created_by&clinic_id=eq.'+ctx.clinicId+'&protocol_id=eq.'+protocol.id+'&order=version.desc&limit=1');study=rows[0]||null;
  }else{
   if(!uuid.test(body.operation_id)||!Number.isInteger(body.expected_version)||body.expected_version<0)throw new Failure(422,'invalid_version','Versão de estudo inválida.');
   let document;
   try{document=validateStudy(body.document,registry);}catch(e){throw new Failure(422,'invalid_study',(e as Error).message);}
   await requireRecentPasswordProof(req,config,ctx,{operationId:body.operation_id,action:'rosto3d.study.save',targetId:protocol.id});
   const reason=typeof body.motivo==='string'?body.motivo.trim().slice(0,500):'';
   if(reason.length<3)throw new Failure(422,'reason_required','Informe o motivo do registro.');
   study=await service('rpc/facial_study_save','POST',{p_clinic_id:ctx.clinicId,p_actor_id:ctx.userId,p_protocol_id:protocol.id,p_operation_id:body.operation_id,p_expected_version:body.expected_version,p_document:document,p_reason:reason});
  }
  await writeClinicAudit(config,ctx,{entity:'facial_study',entityId:protocol.id,action:body.acao==='abrir'?'read':'save',outcome:'success',details:{endpoint:'rosto3d-fichas',result_count:study?1:0}});
  return reply({ok:true,study,protocolo_id:protocol.id,...authResponseFields(ctx)});
 }catch(error){
  const e=error instanceof DualAuthError?{status:error.status,code:error.code,message:error.publicMessage}:error instanceof Failure?error:{status:500,code:'unavailable',message:'Não foi possível concluir. Suas alterações ainda não foram confirmadas.'};
  if(ctx)await writeClinicAudit(config,ctx,{entity:'facial_study',action:'request',outcome:e.status===401||e.status===403?'denied':'error',details:{endpoint:'rosto3d-fichas',reason_code:e.code}});
  return reply({ok:false,erro:e.message,codigo:e.code},e.status);
 }
}
Deno.serve(handler);

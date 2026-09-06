import {authenticateDual,authResponseFields,DualAuthError} from '../_shared/dual-auth.ts';
const config={supabaseUrl:(Deno.env.get('SUPABASE_URL')||'').replace(/\/+$/,''),
 serviceRoleKey:Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')||'',allowedRoles:['owner'] as const,requireAal2:true};
const origins=new Set(['https://anamariajacob.com.br','https://www.anamariajacob.com.br','http://127.0.0.1:8765','http://localhost:8765']);

// Retired by the administrator's session-only policy. Never grants or renews a
// password window; existing database evidence remains intact for audit.
export async function handler(req:Request){
 const origin=req.headers.get('origin')||'';
 const headers={'Access-Control-Allow-Origin':origins.has(origin)?origin:'https://anamariajacob.com.br',
  'Access-Control-Allow-Headers':'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods':'POST, OPTIONS','Vary':'Origin','Cache-Control':'no-store',
  'Content-Type':'application/json; charset=utf-8','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'};
 const reply=(body:unknown,status:number)=>new Response(JSON.stringify(body),{status,headers});
 if(origin&&!origins.has(origin))return reply({ok:false,codigo:'origin_denied',erro:'Origem não permitida.'},403);
 if(req.method==='OPTIONS')return new Response(null,{status:204,headers});
 if(req.method!=='POST')return reply({ok:false,codigo:'method_denied',erro:'Método não permitido.'},405);
 try{
  const ctx=await authenticateDual(req,config);
  return reply({ok:false,codigo:'editing_window_retired',erro:'A edição agora usa sua sessão administradora com MFA.',
   authorization_mode:'admin_session',editing_authorization:{active:false,expires_at:null,allowed_actions:[]},
   ...authResponseFields(ctx)},410);
 }catch(error){
  const e=error instanceof DualAuthError?error:new DualAuthError(503,'auth_unavailable','Não foi possível validar sua sessão.');
  return reply({ok:false,codigo:e.code,erro:e.publicMessage},e.status);
 }
}
Deno.serve(handler);

// Execute the shipped Edge handler with synthetic responses only. No real user,
// clinic, image, credential, Storage request or database write is involved.
import assert from "node:assert/strict";
const C="22222222-2222-4222-8222-222222222222",U="11111111-1111-4111-8111-111111111111";
const P="33333333-3333-4333-8333-333333333333",F="44444444-4444-4444-8444-444444444444";
const SESSION="55555555-5555-4555-8555-555555555555",OTHER="66666666-6666-4666-8666-666666666666";
const BASE="https://archived-photo-test.invalid",PATH=C+"/"+P+"/synthetic.png",THUMB=C+"/"+P+"/synthetic.thumb.png";
Deno.env.set("SUPABASE_URL",BASE);Deno.env.set("SUPABASE_SERVICE_ROLE_KEY","synthetic-key-not-real");
type Handler=(request:Request)=>Promise<Response>;
let handler:Handler|undefined;
const originalServe=Object.getOwnPropertyDescriptor(Deno,"serve");
if(!originalServe?.configurable)throw Error("Deno listener must be interceptable");
Object.defineProperty(Deno,"serve",{configurable:true,value:(callback:Handler)=>{handler=callback;return {};}});
await import("./index.ts").finally(()=>Object.defineProperty(Deno,"serve",originalServe));
if(!handler)throw Error("Production handler was not registered");
const registered=handler;
function token(aal="aal2"){
 return ["header",btoa(JSON.stringify({sub:U,role:"authenticated",aal,iss:BASE+"/auth/v1",exp:Math.floor(Date.now()/1000)+600,session_id:SESSION})),"signature"].join(".");
}
interface Options {unauthenticated?:boolean;aal?:string;role?:string;wrongTenant?:boolean;photoArchived?:boolean;upload?:boolean;activeSession?:boolean;}
async function run(options:Options={}){
 const calls:{url:string;method:string;body:Record<string,unknown>|undefined}[]=[],originalFetch=globalThis.fetch;
 globalThis.fetch=async(input,init)=>{
  const url=String(input),method=init?.method||"GET",body=init?.body?JSON.parse(String(init.body)):undefined;
  calls.push({url,method,body});
  if(url.endsWith("/auth/v1/user"))return Response.json({id:U,is_anonymous:false});
  if(url.endsWith("/rpc/clinic_validate_auth_session"))return Response.json(options.activeSession!==false);
  if(url.includes("/clinic_members?"))return Response.json([{clinic_id:options.wrongTenant?OTHER:C,user_id:U,role:options.role||"owner",status:"active"}]);
  if(url.includes("/protocols?")){
   assert(url.includes("clinic_id=eq."+(options.wrongTenant?OTHER:C))&&url.includes("id=eq."+P));
   return Response.json(options.wrongTenant?[]:[{id:P,status:"draft",archived_at:"2026-09-06T00:00:00Z"}]);
  }
  if(url.includes("/protocol_photos?")){
   assert(url.includes("protocols.clinic_id=eq."+C)&&url.includes("protocol_id=eq."+P));
   return Response.json([{id:F,protocol_id:P,phase:"before",storage_path:PATH,thumbnail_storage_path:THUMB,mime_type:"image/png",taken_at:"2026-01-01T00:00:00Z",archived_at:options.photoArchived?"2026-09-06T00:00:00Z":null}]);
  }
  if(url.endsWith("/storage/v1/object/sign/clinic-media"))return Response.json((body?.paths as string[]).map(path=>({path,signedURL:"/object/sign/clinic-media/"+path+"?token=synthetic"})));
  if(url.endsWith("/clinic_audit_log"))return new Response(null,{status:201});
  throw Error("Unexpected synthetic request: "+url);
 };
 try{
  const headers:Record<string,string>={};if(!options.unauthenticated)headers.authorization="Bearer "+token(options.aal);
  let body:string|FormData;
  if(options.upload){
   body=new FormData();body.set("acao","adicionar_foto");body.set("protocolo_id",P);body.set("fase","before");body.set("idempotency_key",F);
   body.set("arquivo",new File([new Uint8Array([137,80,78,71,13,10,26,10])],"synthetic.png",{type:"image/png"}));
  }else{headers["content-type"]="application/json";body=JSON.stringify({acao:"listar_fotos",protocolo_id:P,incluir_arquivadas:options.photoArchived===true});}
  const response=await registered(new Request(BASE+"/functions/v1/prontuario-fichas",{method:"POST",headers,body}));
  return {status:response.status,body:await response.json(),headers:response.headers,calls};
 }finally{globalThis.fetch=originalFetch;}
}
Deno.test("owner AAL2 reads active photos under archived consultation without restoring or writing",async()=>{
 const r=await run();assert.equal(r.status,200);assert.equal(r.body.fotos.length,1);assert.match(r.body.fotos[0].url_assinada,/token=synthetic/);assert.match(r.body.fotos[0].miniatura_url,/synthetic.thumb.png/);
 assert.match(r.headers.get("cache-control")||"",/no-store/);
 assert(r.calls.some(call=>call.url.includes("archived_at=is.null")));
 const signing=r.calls.find(call=>call.url.endsWith("/storage/v1/object/sign/clinic-media"));assert.deepEqual(signing?.body?.paths,[PATH,THUMB]);
 assert(!r.calls.some(call=>/consent|restaurar|photo_annotation|adicionar_foto/.test(call.url)));
 assert(r.calls.filter(call=>call.method!=="GET").every(call=>/clinic_validate_auth_session|object\/sign\/clinic-media|clinic_audit_log/.test(call.url)));
});
Deno.test("another tenant cannot read or sign photos from an archived consultation",async()=>{
 const r=await run({wrongTenant:true});assert.equal(r.status,404);assert(!("fotos"in r.body));assert(!r.calls.some(call=>/protocol_photos|\/storage\//.test(call.url)));
});
for(const [label,options]of [["unauthenticated",{unauthenticated:true}],["without MFA",{aal:"aal1"}],["professional",{role:"professional"}],["revoked session",{activeSession:false}]] as const)Deno.test(label+" cannot load or sign archived consultation photos",async()=>{
 const r=await run(options);assert([401,403].includes(r.status));assert(!r.calls.some(call=>/\/protocols\?|protocol_photos|\/storage\//.test(call.url)));
});
Deno.test("individually archived photo has no original or thumbnail URL, even when explicitly included",async()=>{
 const r=await run({photoArchived:true});assert.equal(r.status,200);assert.equal(r.body.fotos[0].url_assinada,null);assert.equal(r.body.fotos[0].miniatura_url,null);assert.equal(r.body.fotos[0].expira_em_segundos,null);
 assert(!r.calls.some(call=>call.url.includes("/storage/")));
 const query=r.calls.find(call=>call.url.includes("/protocol_photos?"));assert(query&&!query.url.includes("archived_at=is.null"));
});
Deno.test("upload to archived consultation still fails 403 before any Storage upload or mutation RPC",async()=>{
 const r=await run({upload:true});assert.equal(r.status,403);assert.equal(r.body.codigo,"protocol_archived");
 assert(!r.calls.some(call=>/\/storage\/|\/protocol_photos\?|prontuario_adicionar_foto/.test(call.url)));
});

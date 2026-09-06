import assert from "node:assert/strict";
const source=await Deno.readTextFile(new URL("./index.ts",import.meta.url));
const operation=await Deno.readTextFile(new URL("../operacao-clinica-fichas/index.ts",import.meta.url));
const migration=await Deno.readTextFile(new URL("../../migrations/20260906212532_private_clinical_photo_authorization.sql",import.meta.url));
function between(a:string,b:string):string {
 const start=source.indexOf(a),end=source.indexOf(b,start+a.length);
 assert(start>=0&&end>start);return source.slice(start,end);
}
const constants=source.split("\n").filter(line=>/^const (UUID_PATTERN|DATE_PATTERN) =/.test(line)).join("\n");
const moduleSource=[
 "type JsonRecord=Record<string,unknown>;",
 "type DualAuthContext={authMethod:string;aal:string;role:string;clinicId:unknown;userId:unknown};",
 "class ApiError extends Error { constructor(public status:number,public code:string,message:string){super(message);} }",
 "const DATABASE_ERROR_MESSAGES:Record<string,string>={};",
 "let replies:JsonRecord[][]=[]; const paths:string[]=[];",
 "function setup(values:JsonRecord[][]){replies=values;paths.length=0;}",
 "async function serviceJson(path:string){paths.push(path);return replies.shift()||[];}",
 constants,
 between("function safeText(","function encodePath("),
 between("function tenant(","async function serviceFetch("),
 between("async function assertPhotoUploadPreflight(","async function assertPhotoProductContextPreflight("),
 "export {tenant,assertPhotoUploadPreflight,setup,paths};",
].join("\n");
const api=await import("data:application/typescript,"+encodeURIComponent(moduleSource));
const C="22222222-2222-4222-8222-222222222222",U="11111111-1111-4111-8111-111111111111",P="33333333-3333-4333-8333-333333333333";
Deno.test("private owner access still requires individual MFA and valid tenant",()=>{
 assert.deepEqual(api.tenant({authMethod:"supabase_auth",aal:"aal2",role:"owner",clinicId:C,userId:U}),{clinicId:C,userId:U});
 for(const override of [{aal:"aal1"},{authMethod:"legacy"},{clinicId:"invalid"}]){
  assert.throws(()=>api.tenant({authMethod:"supabase_auth",aal:"aal2",role:"owner",clinicId:C,userId:U,...override}));
 }
});
Deno.test("owner can read/upload private file without querying or manufacturing patient consent",async()=>{
 api.setup([[{id:P,status:"draft",archived_at:null}]]);
 await api.assertPhotoUploadPreflight(C,P,null,null,true);
 assert.equal(api.paths.length,1);
 assert.match(api.paths[0],new RegExp("clinic_id=eq."+C));
 assert(api.paths.every((path:string)=>!path.includes("consent")));
});
Deno.test("private authorization never bypasses missing/archived protocol or malformed product pair",async()=>{
 api.setup([[]]);await assert.rejects(api.assertPhotoUploadPreflight(C,P,null,null,true));
 api.setup([[{id:P,status:"draft",archived_at:"2026-09-06"}]]);
 await assert.rejects(api.assertPhotoUploadPreflight(C,P,null,null,true));
 api.setup([[{id:P,status:"draft",archived_at:null}]]);
 await assert.rejects(api.assertPhotoUploadPreflight(C,P,U,null,true));
});
Deno.test("non-owner retains previous consent gate; owner scope comes from authenticated context",async()=>{
 api.setup([[{id:P,status:"draft",archived_at:null}],[]]);
 await assert.rejects(api.assertPhotoUploadPreflight(C,P,null,null,false));
 assert.match(api.paths[1],/protocol_consent_current/);
 assert.match(source,/assertPhotoUploadPreflight\(clinicId, protocolId, null, null, context.role === "owner"\)/);
 assert.match(source,/lotSnapshot,\s*context.role === "owner",/);
});
Deno.test("private migration neither creates consent nor opens browser RPC access",()=>{
 assert.doesNotMatch(migration,/(insert\s+into|update)\s+public\.protocol_consents/i);
 assert.equal((migration.match(/p_actor_role is distinct from 'owner' and coalesce/g)||[]).length,3);
 assert.match(migration,/private_owner_upload/);
 assert.match(migration,/protocol_essentials_required/);
 assert.match(migration,/clinical_photo_required/);
 assert.match(migration,/version_conflict/);
 assert.match(migration,/from public,anon,authenticated/);
});
Deno.test("consultation gallery checks owner/MFA and same-clinic protocol; marketing workflow remains separate",()=>{
 const gallery=operation.slice(operation.indexOf("async function handleAttendancePhotos("),operation.indexOf("async function ",operation.indexOf("async function handleAttendancePhotos(")+20));
 assert.match(gallery,/tenant\(context\)/);
 assert.match(gallery,/protocols\?select=id&clinic_id=eq/);
 assert.doesNotMatch(gallery,/protocol_consent_current/);
 assert.match(operation,/"operacao.registrar_consentimento_marketing"/);
 assert.match(operation,/rpc\("operacao_registrar_consentimento_marketing"/);
});

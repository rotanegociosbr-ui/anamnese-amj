// Executes the actual draft validators without starting an Edge server or reading credentials.
import assert from "node:assert/strict";
const assertEquals: typeof assert.deepEqual = assert.deepEqual;
const assertThrows: typeof assert.throws = assert.throws;
const assertMatch: typeof assert.match = assert.match;
const source=await Deno.readTextFile(new URL("./index.ts",import.meta.url));
const finance=await Deno.readTextFile(new URL("../financeiro-fichas/index.ts",import.meta.url));
function between(a:string,b:string):string {
 const start=source.indexOf(a),end=source.indexOf(b,start+a.length);
 if(start<0||end<0)throw new Error("Missing source boundary");
 return source.slice(start,end);
}
const constants=source.split("\n").filter(line=>/^const (UUID_PATTERN|DATE_PATTERN) =/.test(line)).join("\n");
const testModule=[
 "type JsonRecord=Record<string,unknown>;",
 "class ApiError extends Error { constructor(public status:number,public code:string,message:string){super(message);} }",
 constants,
 between("function safeText(","function encodePath("),
 between("function draftText(","function normalizeProducts("),
 "export {normalizeDraftProducts,draftText};",
].join("\n");
const {normalizeDraftProducts,draftText}=await import(
 "data:application/typescript,"+encodeURIComponent(testModule)
);
Deno.test("draft preserves row with lot only and row with product only",()=>{
 const rows=normalizeDraftProducts([{lot:"Partial lot"},{product_id:"33333333-3333-4333-8333-333333333333"}]);
 assertEquals(rows[0],{product_id:null,lot:"Partial lot",expiry:null,amount:null,unit:null,position:1});
 assertEquals(rows[1].product_id,"33333333-3333-4333-8333-333333333333");
 assertEquals(rows[1].amount,null);
});
Deno.test("draft saves empty list and optional notes without fabricated values",()=>{
 assertEquals(normalizeDraftProducts([]),[]);
 assertEquals(draftText(null,2000),null);
 assertEquals(draftText(" Note ",2000),"Note");
});
Deno.test("filled invalid values reject rather than truncate or disappear",()=>{
 for(const row of [{lot:"x".repeat(101)},{lot:{unsafe:true}},{amount:"invalid"},{amount:0},{expiry:"2026-02-30"},{product_id:"bad"},{unexpected:"hidden"}]){
  assertThrows(()=>normalizeDraftProducts([row]));
 }
 assertThrows(()=>draftText("x".repeat(2001),2000));
 assertThrows(()=>normalizeDraftProducts(Array.from({length:51},()=>({lot:"a"}))));
});
Deno.test("decimal representation and missing fields survive partial draft",()=>{
 assertEquals(normalizeDraftProducts([{amount:"1.50",unit:"mL"}])[0].amount,"1.50");
});
Deno.test("draft edits revalidate the admin session and preserve binding, consent scope and version guards",()=>{
 assertMatch(source,/Number\(current\[0\]\.version\) !== expectedVersion/);
 assertMatch(source,/changesBinding \|\| Object\.keys\(consents\)\.length > 0/);
 assertMatch(source,/requireProtectedOperation\(req, context, payload, "prontuario\.update", protocolId\)/);
 assertMatch(source,/requireAdminSessionAction\(req, AUTH_CONFIG, context/);
 assert.doesNotMatch(source,/requireRoutineEditAuthorization|requireRecentPasswordProof/);
 const protectedOperation=between("async function requireProtectedOperation(","async function handleSaveDraft(");
 assertMatch(protectedOperation,/validUuid\(operationId\)/);
 assertMatch(protectedOperation,/await requireAdminSessionAction\(req, AUTH_CONFIG, context, \{[\s\S]*operationId,[\s\S]*action,[\s\S]*targetId/);
 assertMatch(source,/requireProtectedOperation\(req, context, payload, "prontuario\.consent", idempotencyKey\)/);
});
Deno.test("catalog API separates drafts and accepts missing essentials",()=>{
 assertMatch(finance,/produtos_rascunho: rows\(products\.data\)\.filter/);
 assertMatch(finance,/const type = optionalText\(payload\.tipo/);
 assertMatch(finance,/const unit = optionalText\(payload\.unidade/);
 assertMatch(finance,/p_presentation: optionalText\(payload\.apresentacao/);
 assertMatch(finance,/status_cadastro: row\.registration_status === "draft"/);
});

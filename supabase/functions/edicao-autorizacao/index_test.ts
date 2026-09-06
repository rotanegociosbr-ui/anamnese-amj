const base='https://retired-window.invalid';
Deno.env.set('SUPABASE_URL',base);Deno.env.set('SUPABASE_SERVICE_ROLE_KEY','test-only');
const serve=Deno.serve;let registered:unknown;
Deno.serve=((handler:unknown)=>{registered=handler;return {};}) as typeof Deno.serve;
const {handler}=await import('./index.ts').finally(()=>{Deno.serve=serve;});
if(registered!==handler)throw Error('Handler was not registered');
const U='11111111-1111-4111-8111-111111111111',C='22222222-2222-4222-8222-222222222222',S='33333333-3333-4333-8333-333333333333';
function token(aal='aal2'){return ['header',btoa(JSON.stringify({sub:U,role:'authenticated',aal,iss:base+'/auth/v1',exp:Date.now()/1000+600,session_id:S})),'signature'].join('.');}
async function run(action:string,options:{anonymous?:boolean;aal?:string;role?:string;revoked?:boolean;origin?:string;method?:string}={}){
 const original=fetch,calls:string[]=[];
 globalThis.fetch=async(input)=>{
  const url=String(input);calls.push(url);
  if(url.endsWith('/auth/v1/user'))return Response.json({id:U});
  if(url.endsWith('/rpc/clinic_validate_auth_session'))return Response.json(!options.revoked);
  if(url.includes('/clinic_members?'))return Response.json([{user_id:U,clinic_id:C,role:options.role||'owner',status:'active'}]);
  throw Error('Retired endpoint must never use grants or password proofs');
 };
 try{
  const headers:Record<string,string>={'content-type':'application/json'};
  if(!options.anonymous)headers.authorization='Bearer '+token(options.aal);
  if(options.origin)headers.origin=options.origin;
  const method=options.method||'POST';
  const r=await handler(new Request(base,{method,headers,body:method==='POST'?JSON.stringify({acao:action}):undefined}));
  return {status:r.status,body:r.status===204?{}:await r.json(),calls,headers:r.headers};
 }finally{globalThis.fetch=original;}
}
for(const action of ['status','liberar','revogar'])Deno.test('retired window '+action+' is 410/no-store and never grants',async()=>{
 const r=await run(action);
 if(r.status!==410||r.body.codigo!=='editing_window_retired'||r.body.editing_authorization.active||r.headers.get('cache-control')!=='no-store')throw Error('Window was not retired');
 if(r.calls.length!==3||/proof_id|session_id|access_token|refresh_token/.test(JSON.stringify(r.body)))throw Error('Unexpected grant or credential');
});
for(const options of [{anonymous:true},{aal:'aal1'},{role:'professional'},{revoked:true}])Deno.test('retired endpoint still rejects '+JSON.stringify(options),async()=>{
 const r=await run('status',options);if(![401,403].includes(r.status))throw Error('Unauthorized access');
});
Deno.test('retired window CORS refuses foreign origin and supports preflight',async()=>{
 const denied=await run('status',{origin:'https://evil.invalid'});if(denied.status!==403||denied.calls.length)throw Error('CORS failed');
 const preflight=await run('status',{method:'OPTIONS',origin:'https://anamariajacob.com.br'});if(preflight.status!==204||preflight.calls.length)throw Error('Preflight failed');
});

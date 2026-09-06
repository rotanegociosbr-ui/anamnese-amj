'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.resolve(__dirname,'../auth-mfa.js'),'utf8');
const KEY='amj-auth-v1',CLOSED='amj_auth_local_signed_out';
const oldSession={access_token:'synthetic-expired',refresh_token:'synthetic-refresh',expires_at:1,user:{id:'synthetic-user'}};
function memory(){const values=new Map();return {getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,String(v)),removeItem:k=>values.delete(k)};}
function deferred(){let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};}
function fixture(storage=memory(),behavior={}){
 const events=[],calls=[];let sdkStorage,callback,current=oldSession;
 const client={auth:{
  onAuthStateChange(fn){callback=fn;return {data:{subscription:{unsubscribe(){}}}};},
  async getSession(){return behavior.getSession?behavior.getSession():{data:{session:current},error:null};},
  async signOut(){calls.push({operation:'signOut',hadSession:!!sdkStorage.getItem(KEY)});if(behavior.signOut)return behavior.signOut();return {error:{name:'AuthRetryableFetchError',status:503}};},
  async signInWithPassword(){const result=behavior.signIn?await behavior.signIn():{data:{session:{...oldSession,access_token:'synthetic-new'}},error:null};if(result.data&&result.data.session){current=result.data.session;sdkStorage.setItem(KEY,JSON.stringify(current));callback('SIGNED_IN',current);}return result;},
  mfa:{async getAuthenticatorAssuranceLevel(){return behavior.aal?behavior.aal():{data:{currentLevel:'aal2',nextLevel:'aal2'},error:null};}}
 }};
 const window={location:{href:'https://synthetic.invalid/painel/',search:'',hash:''}};
 vm.runInNewContext(source,{window,URL,URLSearchParams,Date,console});
 const controller=window.AMJAuth.createController({storage,windowLike:window,supabaseUrl:'https://synthetic.invalid',publishableKey:'test-only',onAuthEvent:(e,s)=>events.push({e,s}),supabaseGlobal:{createClient(_url,_key,options){sdkStorage=options.auth.storage;return client;}}});
 return {controller,events,calls,storage,lateRefresh(){sdkStorage.setItem(KEY,JSON.stringify(oldSession));callback('TOKEN_REFRESHED',oldSession);}};
}
test('offline logout clears only auth storage and blocks stale refresh restoration',async()=>{
 const h=fixture();h.storage.setItem(KEY,JSON.stringify(oldSession));h.storage.setItem('unrelated','preserve');
 await assert.rejects(h.controller.signOut(),e=>e.code==='signout_failed');
 assert.equal(h.calls[0].hadSession,true,'SDK still has the token for its revocation attempt');
 assert.equal(h.storage.getItem(KEY),null);assert.equal(h.storage.getItem('unrelated'),'preserve');assert.equal(await h.controller.getSession(),null);
 h.lateRefresh();assert.equal(h.storage.getItem(KEY),null);assert.equal(h.events.length,0);
});
test('thrown transport failure also closes local session',async()=>{
 const h=fixture(memory(),{signOut:async()=>{throw new Error('synthetic network failure');}});h.storage.setItem(KEY,'synthetic');
 await assert.rejects(h.controller.signOut());assert.equal(h.storage.getItem(KEY),null);assert.equal(await h.controller.getSession(),null);
});
test('reload during a pending logout cannot restore the session that the user closed',async()=>{
 const pending=deferred(),h=fixture(memory(),{signOut:()=>pending.promise});h.storage.setItem(KEY,JSON.stringify(oldSession));
 const exiting=h.controller.signOut();assert.equal(h.storage.getItem(CLOSED),'1');
 const reloaded=fixture(h.storage);assert.equal((await reloaded.controller.initialize()).session,null);assert.equal(h.storage.getItem(KEY),null);
 pending.resolve({error:null});await exiting;
});
test('only a fresh explicit sign-in re-enables local session persistence',async()=>{
 const h=fixture();await assert.rejects(h.controller.signOut());
 const fresh=await h.controller.signIn('test@example.invalid','test-only-not-real');
 assert.equal(fresh.access_token,'synthetic-new');assert.equal(h.storage.getItem(CLOSED),null);assert(h.storage.getItem(KEY));assert.equal((await h.controller.getSession()).access_token,'synthetic-new');
});
test('an old session lookup cannot return a session after sign-out began',async()=>{
 const lookup=deferred(),h=fixture(memory(),{getSession:()=>lookup.promise});
 const result=h.controller.getSession();await assert.rejects(h.controller.signOut());lookup.resolve({data:{session:oldSession},error:null});assert.equal(await result,null);
});
test('an in-flight initialization cannot restore a session after sign-out began',async()=>{
 const lookup=deferred(),h=fixture(memory(),{getSession:()=>lookup.promise});
 const result=h.controller.initialize();await assert.rejects(h.controller.signOut());
 lookup.resolve({data:{session:oldSession},error:null});
 assert.equal((await result).session,null,'initialize must apply the same epoch guard as getSession');
});
test('a completed password request cannot return a session after sign-out began',async()=>{
 const login=deferred(),h=fixture(memory(),{signIn:()=>login.promise});
 const signingIn=h.controller.signIn('test@example.invalid','test-only-not-real');
 await assert.rejects(h.controller.signOut());
 const canceled=assert.rejects(signingIn,'A late login response must not be handed to processarEtapaAuth');
 login.resolve({data:{session:oldSession},error:null});await canceled;
 assert.equal(h.storage.getItem(KEY),null);assert.equal(h.events.length,0);
});
test('an AAL response received after sign-out cannot release the application',async()=>{
 const assurance=deferred(),entered=deferred(),h=fixture(memory(),{aal:()=>{entered.resolve();return assurance.promise;}});
 const nextStep=h.controller.getNextStep();await entered.promise;
 await assert.rejects(h.controller.signOut());
 assurance.resolve({data:{currentLevel:'aal2',nextLevel:'aal2'},error:null});
 const result=await nextStep;
 assert.equal(result.step,'login','A stale AAL2 result cannot be returned as ready');
 assert.equal(result.session,null);
});
test('an older password response cannot overwrite a new session after logout and another login',async()=>{
 const first=deferred();let attempts=0;
 const newer={...oldSession,access_token:'synthetic-account-B'};
 const h=fixture(memory(),{signIn:()=>++attempts===1?first.promise:Promise.resolve({data:{session:newer},error:null})});
 const oldLogin=h.controller.signIn('account-A@example.invalid','test-only-not-real');
 const oldRejected=assert.rejects(oldLogin,e=>e.code==='session_cancelled');
 await assert.rejects(h.controller.signOut());
 // A safe implementation can either reject the new request until the old one ends,
 // or isolate their storage writes. Both outcomes must preserve the final new account.
 let fresh,blocked=false;
 try{fresh=await h.controller.signIn('account-B@example.invalid','test-only-not-real');}
 catch(error){assert.equal(error.code,'signin_pending');blocked=true;}
 first.resolve({data:{session:oldSession},error:null});await oldRejected;
 if(blocked)fresh=await h.controller.signIn('account-B@example.invalid','test-only-not-real');
 assert.equal(fresh.access_token,newer.access_token);
 assert.equal(JSON.parse(h.storage.getItem(KEY)).access_token,newer.access_token,
  'The canceled login must not replace the session of the new explicit login');
 assert.equal((await h.controller.getSession()).access_token,newer.access_token);
});
test('real bundled SDK retryable-refresh failure cannot retain auth storage through the wrapper',{timeout:5000},async()=>{
 const context={console,URL,URLSearchParams,Headers,Request,Response,TextEncoder,TextDecoder,AbortController,crypto:globalThis.crypto,setTimeout,clearTimeout,setInterval,clearInterval};
 vm.createContext(context);vm.runInContext(fs.readFileSync(path.resolve(__dirname,'../vendor/supabase-js-2.112.3.min.js'),'utf8'),context);
 const sdk=context.supabase,storage=memory();storage.setItem(KEY,JSON.stringify(oldSession));let auth;
 const window={location:{href:'https://synthetic.invalid/painel/',search:'',hash:''}};vm.runInNewContext(source,{window,URL,URLSearchParams,Date,console});
 const controller=window.AMJAuth.createController({storage,windowLike:window,supabaseUrl:'https://synthetic.invalid',publishableKey:'test-only',supabaseGlobal:{createClient(_url,_key,options){
  auth=new sdk.AuthClient({...options.auth,url:'https://synthetic.invalid/auth/v1',autoRefreshToken:false,fetch:async()=>{throw new Error('Unexpected live networking');}});
  auth._refreshAccessToken=async()=>({data:{session:null},error:new sdk.AuthRetryableFetchError('synthetic offline',503)});return {auth};
 }}});
 try{await auth.initializePromise;await assert.rejects(controller.signOut());assert.equal(storage.getItem(KEY),null);assert.equal(await controller.getSession(),null);}
 finally{controller.destroy();await auth.stopAutoRefresh();}
});

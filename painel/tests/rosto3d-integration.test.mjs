import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import * as THREE from '../rosto3d/v1/vendor/three.module.js';
const panel=path.resolve(import.meta.dirname,'..'),base=path.join(panel,'rosto3d/v1');
const read=p=>fs.readFileSync(p,'utf8');
const hostSource=read(path.join(panel,'rosto3d.js')),source=read(path.join(base,'app-v3.js'));
function harness(){
 const status={textContent:''},buttons={},frames=[],listeners={};
 const root={firstElementChild:null,innerHTML:'',querySelector(s){
  return s==='[data-rosto3d-status]'?status:s==='[data-rosto3d-contexto]'?{textContent:''}:s==='[data-rosto3d-frame]'?{appendChild(f){frames.push(f);}}:(buttons[s]??={addEventListener(type,fn){this[type]=fn;}});
 }};
 let activeCalls=[],disposed=0;
 const sandbox={
  modoAcesso:'auth',aplicativoLiberado:true,identidadeBackend:{role:'owner'},authSession:{access_token:'TEST_ONLY',user:{id:'test-owner'}},
  authController:{async getNextStep(){return {step:'ready',aal:{currentLevel:'aal2'},session:{access_token:'TEST_ONLY',user:{id:'test-owner'}}};}},
  registrarAtividadeSessao(){sandbox.activityCount++;},activityCount:0,
  document:{hidden:false,getElementById(){return sandbox.panel;},addEventListener(k,f){listeners[k]=f;},
   createElement(){return {contentWindow:{},remove(){this.removed=true;}};}},
  panel:{hidden:false,classList:{contains(){return false;}}},window:{},Boolean,String,Object
 };
 vm.runInNewContext(hostSource,sandbox);const api=sandbox.window.AMJRosto3D;api.montar(root);
 function renderer(){frames.at(-1).contentWindow.AMJRostoViewer={setActive(v){activeCalls.push(v);},dispose(){disposed++;}};}
 return {sandbox,api,frames,status,renderer,activeCalls,disposed:()=>disposed,listeners,buttons};
}
test('lazy mount is inert, no viewer before verified activation',async()=>{
 const h=harness();assert.equal(h.frames.length,0);h.api.atualizarAcesso();assert.equal(h.frames.length,0);
 assert.equal(await h.api.ativar(),true);assert.equal(h.frames.length,1);
 assert.equal(h.frames[0].src,'./rosto3d/v2/index.html?v=20260906-3');assert.equal(h.frames[0].src.includes('TEST_ONLY'),false);
 assert.equal(h.api.frameAllowed({}),false);assert.equal(h.api.frameAllowed(h.frames[0].contentWindow),true);
});
test('non-owner and signed-out activation never creates iframe',async()=>{
 for(const change of [s=>s.identidadeBackend.role='reception',s=>s.modoAcesso=null,s=>s.aplicativoLiberado=false,s=>s.authSession=null]){
  const h=harness();change(h.sandbox);assert.equal(await h.api.ativar(),false);assert.equal(h.frames.length,0);
 }
});
test('MFA ready/current aal2 and matching identity are required',async()=>{
 for(const next of [{step:'challenge'}, {step:'ready',aal:{currentLevel:'aal1'},session:{access_token:'x',user:{id:'test-owner'}}},
  {step:'ready',aal:{currentLevel:'aal2'},session:{access_token:'x',user:{id:'other'}}}]){
  const h=harness();h.sandbox.authController.getNextStep=async()=>next;assert.equal(await h.api.ativar(),false);assert.equal(h.frames.length,0);
 }
});
test('pending activation cannot reopen after logout, route exit or permission change',async()=>{
 for(const cancel of [h=>h.api.reset(),h=>h.api.pausar(),h=>h.sandbox.identidadeBackend.role='marketing',h=>h.sandbox.panel.hidden=true]){
  const h=harness();let resolve;const value=await h.sandbox.authController.getNextStep();
  h.sandbox.authController.getNextStep=()=>new Promise(r=>{resolve=r;});
  const opening=h.api.ativar();cancel(h);resolve(value);assert.equal(await opening,false);assert.equal(h.frames.length,0);
 }
});
test('switching away pauses and preserves frame; return rechecks MFA; logout disposes',async()=>{
 const h=harness();await h.api.ativar();h.renderer();h.api.pausar();assert.deepEqual(h.activeCalls,[false]);
 assert.equal(h.frames.length,1);assert.equal(h.api.frameAllowed(h.frames[0].contentWindow),false);
 assert.equal(await h.api.ativar(),true);assert.equal(h.frames.length,1);assert.deepEqual(h.activeCalls,[false,true]);
 h.api.reset();assert.equal(h.disposed(),1);assert.equal(h.frames[0].removed,true);assert.equal(h.api.frameAllowed(h.frames[0].contentWindow),false);
 h.api.reset();assert.equal(h.disposed(),1);
});
test('activity requires the exact active embedded window',async()=>{
 const h=harness();await h.api.ativar();h.api.activity({});assert.equal(h.sandbox.activityCount,0);
 h.api.activity(h.frames[0].contentWindow);assert.equal(h.sandbox.activityCount,1);
 h.api.pausar();h.api.activity(h.frames[0].contentWindow);assert.equal(h.sandbox.activityCount,1);
});
test('failed startup can be retried explicitly without deleting unsaved work silently',async()=>{
 const h=harness();await h.api.ativar();const first=h.frames[0];h.renderer();
 first.contentWindow.AMJRostoFailed=true;
 assert.equal(await h.api.ativar(),false);assert.equal(h.frames.length,1);
 first.contentWindow.AMJRostoViewer.hasChanges=()=>true;
 h.sandbox.window.confirm=()=>false;
 assert.equal(await h.api.ativar(true),false);assert.equal(h.frames.length,1);
 h.sandbox.window.confirm=()=>true;
 assert.equal(await h.api.ativar(true),true);assert.equal(first.removed,true);assert.equal(h.frames.length,2);
 assert.equal(h.disposed(),1);
});
test('late startup must recheck attached frame before creating WebGL',()=>{
 assert.ok(source.indexOf("if(!attached())throw Error")<source.indexOf('renderer=new THREE.WebGLRenderer'));
 assert.match(source,/if\(disposed\|\|!attached\(\)\)/);
});
test('app routing, lazy load, reset and no privileged key added',()=>{
 const html=read(path.join(panel,'index.html')),shell=read(path.join(panel,'app-shell.js'));
 assert.match(html,/id="aba-bt-rosto3d"/);assert.match(html,/id="aba-rosto3d"/);assert.match(html,/AMJRosto3D\.reset\(\)/);
 assert.match(shell,/rosto3d: Object.freeze\(\{ title: 'Rosto 3D'.*owner: true/);
 assert.match(shell,/SECONDARY_ORDER = \['rosto3d'\]/);
 assert.match(shell,/PRIMARY_ORDER = \[[^;]*'clientes', 'prontuarios'/);
 assert.doesNotMatch(html,/<iframe/);assert.doesNotMatch(hostSource,/localStorage|sessionStorage|postMessage|service_role/);
 assert.match(hostSource,/functions\/v1\/rosto3d-fichas/);
 assert.match(read(path.join(base,'entry.js')),/app\.frameAllowed\(window\)/);
 assert.match(read(path.join(base,'entry.js')),/event\.isTrusted/);
});
test('all generic runtime assets and import dependencies exist; no absolute root fetches',()=>{
 const manifest=JSON.parse(read(path.join(base,'assets/manifest.json')));
 assert.equal(manifest.objects.filter(m=>m.layer==='muscles').length,36);
 for(const file of ['rosto-amj-v1.json','study.mjs','deform.mjs','gesture.mjs','vendor/three.module.js','vendor/three.core.js','vendor/OrbitControls.js',
  'logo.png','Poppins-Regular.ttf','CormorantGaramond-Variable.ttf','CormorantGaramond-Italic-Variable.ttf','licencas/Z-Anatomy-LICENSE-models.txt']){
  assert.ok(fs.statSync(path.join(base,file)).size>0,file);
 }
 for(const m of manifest.objects){
  const model=JSON.parse(read(path.join(base,'assets',m.file)));
  assert.ok(model.positions.length%3===0);assert.ok(model.positions.every(Number.isFinite));
  assert.ok(model.indices.every(i=>Number.isInteger(i)&&i>=0&&i<model.positions.length/3));
  if(m.texture)assert.ok(fs.statSync(path.join(base,'assets',m.texture)).size>0);
 }
 assert.doesNotMatch(source,/json\('\//);assert.doesNotMatch(source,/loadAsync\('\//);
 const html=read(path.join(base,'studio.html'));assert.match(html,/id="studio-content" hidden/);
 assert.match(html,/src=".\/entry.js"/);assert.match(html,/id="muscle-label"/);
 assert.match(read(path.join(base,'studio.css')),/pointer-events:none/);
});
test('actual Three raycast identifies nearest visible muscle, not skin or hidden muscle',()=>{
 const models=new Map(),scene=new THREE.Scene(),ray=new THREE.Raycaster(),messages=[];let chosen=null;
 function add(id,z,layer,on=true){
  const mesh=new THREE.Mesh(new THREE.PlaneGeometry(2,2),new THREE.MeshBasicMaterial({side:THREE.DoubleSide}));
  mesh.position.z=z;mesh.name=id;scene.add(mesh);models.set(id,{mesh,name:id,layer,on});
 }
 add('hidden',3,'muscles',false);add('skin',2,'skin');add('near',1,'muscles');add('far',0,'muscles');
 scene.updateMatrixWorld(true);ray.set(new THREE.Vector3(0,0,5),new THREE.Vector3(0,0,-1));
 const code=source.slice(source.indexOf('function identifyMuscle(){'),source.indexOf('function applyMove(e){'));
 const context={models,ray,visible:m=>m.on,chooseTarget:id=>{chosen=id;},say:t=>messages.push(t)};
 vm.createContext(context);vm.runInContext(code,context);
 assert.equal(context.identifyMuscle(),'near');assert.equal(chosen,'near');
 models.get('near').on=false;assert.equal(context.identifyMuscle(),'far');
 models.get('far').on=false;assert.equal(context.identifyMuscle(),null);
 assert.equal(messages.length,2);
 for(const m of models.values()){m.mesh.geometry.dispose();m.mesh.material.dispose();}
});
test('tap identify is rotation-only, not a duplicate marking gesture',()=>{
 const identify=source.indexOf("if(tool==='rotate'&&settings.view==='anatomy'){aim(e);identifyMuscle();return;}");
 assert.ok(identify>0);assert.ok(source.indexOf("if(!tap||showOriginal||contextLost)return;")<identify);
 assert.ok(source.indexOf("if(tool!=='mark'||!target)return;")>identify);
 assert.match(source,/setAnimationLoop\(null\)/);assert.match(source,/resizeObserver\?\.disconnect/);
 assert.match(source,/label\.textContent=label\.hidden/);
});

async function clinicalHarness(){
 const h=harness();await h.api.ativar();h.renderer();h.requests=[];h.loads=[];
 const open=h.api.abrirProtocolo;h.api={...h.api,abrirProtocolo:(id,label,patientId='33333333-3333-4333-8333-333333333333')=>open(id,label,patientId)};
 h.sandbox.cabecalhosAcesso=async()=>({'Content-Type':'application/json'});
 h.binding={protocol_id:testProtocol,patient_id:'33333333-3333-4333-8333-333333333333',protocol_version:1};
 h.sandbox.fetch=async(url,init)=>{const body=JSON.parse(init.body);h.requests.push({url,body});return {ok:true,json:async()=>({ok:true,protocolo_id:body.protocolo_id,binding:{...h.binding,protocol_id:body.protocolo_id},study:body.acao==='salvar'?{version:1,document:body.document}:null})};};
 h.sandbox.window.AMJProtecao={solicitarEdicaoRotineira:async()=>({operation_id:'22222222-2222-4222-8222-222222222222',motivo:'Teste',encerrar:async()=>{}})};
 Object.assign(h.frames[0].contentWindow.AMJRostoViewer,{ready:()=>true,unbind(){},loadStudy(study,label){h.loads.push({study,label});},hasChanges:()=>false,isBusy:()=>false});return h;
}
const testProtocol='11111111-1111-4111-8111-111111111111';
test('study is loaded and saved under the selected consultation, not a caller-provided patient',async()=>{
 const h=await clinicalHarness();await h.api.abrirProtocolo(testProtocol,'Paciente de teste · consulta');
 const d={modelVersion:'test'};const result=await h.api.saveStudy(h.frames[0].contentWindow,d,0);
 assert.equal(h.loads.length,1);assert.equal(result.version,1);assert.equal(h.requests.at(-1).body.protocolo_id,testProtocol);assert.equal(h.requests.at(-1).body.expected_version,0);assert(!('patient_id'in h.requests.at(-1).body));
 assert.equal(h.requests.at(-1).body.expected_patient_id,h.binding.patient_id);assert.equal(h.requests.at(-1).body.expected_protocol_version,1);
});
test('unrelated window cannot save and no consultation means no save',async()=>{
 const h=await clinicalHarness();await assert.rejects(h.api.saveStudy(h.frames[0].contentWindow,{},0));await h.api.abrirProtocolo(testProtocol,'Teste');const count=h.requests.length;await assert.rejects(h.api.saveStudy({}, {},0));assert.equal(h.requests.length,count);
});
test('late context response after logout never restores clinical notes',async()=>{
 const h=await clinicalHarness();let resolve;h.sandbox.fetch=()=>new Promise(r=>resolve=r);
 const opening=h.api.abrirProtocolo(testProtocol,'Teste');await new Promise(r=>setTimeout(r,0));h.api.reset();resolve({ok:true,json:async()=>({ok:true,study:{version:1,document:{notes:'synthetic'}}})});await opening;assert.equal(h.loads.length,0);
});
test('logout while password prompt is pending prevents the save request',async()=>{
 const h=await clinicalHarness();await h.api.abrirProtocolo(testProtocol,'Teste');let resolve;h.sandbox.window.AMJProtecao.solicitarEdicaoRotineira=()=>new Promise(r=>resolve=r);
 const saving=h.api.saveStudy(h.frames[0].contentWindow,{},0);h.api.reset();resolve({operation_id:testProtocol,encerrar:async()=>{}});await assert.rejects(saving);assert.equal(h.requests.filter(r=>r.body.acao==='salvar').length,0);
});
test('switching consultation with unsaved points requires confirmation',async()=>{
 const h=await clinicalHarness();h.frames[0].contentWindow.AMJRostoViewer.hasChanges=()=>true;h.sandbox.window.confirm=()=>false;
 assert.equal(await h.api.abrirProtocolo(testProtocol,'Teste'),false);assert.equal(h.requests.length,0);
});
test('duplicate readiness does not overwrite edits or fetch the consultation twice',async()=>{
 const h=await clinicalHarness();await h.api.abrirProtocolo(testProtocol,'Teste');const count=h.requests.length,source=h.frames[0].contentWindow;
 await Promise.all([h.api.frameReady(source),h.api.frameReady(source)]);assert.equal(h.requests.length,count);
});

test('no save is allowed without an authoritative matching consultation binding',async()=>{
 for(const binding of [null,{protocol_id:testProtocol,patient_id:'invalid',protocol_version:1},{protocol_id:testProtocol,patient_id:'33333333-3333-4333-8333-333333333333',protocol_version:0}]){
  const h=await clinicalHarness();h.sandbox.fetch=async()=>({ok:true,json:async()=>({ok:true,protocolo_id:testProtocol,binding,study:null})});
  await h.api.abrirProtocolo(testProtocol,'Teste');assert.equal(h.loads.length,0);
  await assert.rejects(h.api.saveStudy(h.frames[0].contentWindow,{},0),/recarregue/);
 }
});

test('a consultation reassigned before opening cannot load under the old patient label',async()=>{
 const h=await clinicalHarness();h.binding.patient_id='44444444-4444-4444-8444-444444444444';
 await h.api.abrirProtocolo(testProtocol,'Paciente anterior');assert.equal(h.loads.length,0);assert.match(h.status.textContent,/paciente desta consulta mudou/);
 await assert.rejects(h.api.saveStudy(h.frames[0].contentWindow,{},0),/recarregue/);
});

test('explicit retry loads again after a transient server failure without recreating viewer',async()=>{
 const h=await clinicalHarness(),fetch=h.sandbox.fetch;
 h.sandbox.fetch=async()=>{throw Error('Rede indisponível');};await h.api.abrirProtocolo(testProtocol,'Teste');assert.equal(h.loads.length,0);
 h.sandbox.fetch=fetch;await h.api.ativar(true);assert.equal(h.loads.length,1);assert.equal(h.frames.length,1);
});

test('reload prompts before replacing unsaved edits and updates the consultation binding',async()=>{
 const h=await clinicalHarness();await h.api.abrirProtocolo(testProtocol,'Teste');const count=h.requests.length;
 h.frames[0].contentWindow.AMJRostoViewer.hasChanges=()=>true;h.sandbox.window.confirm=()=>false;
 assert.equal(await h.api.recarregar(),false);assert.equal(h.requests.length,count);
 h.sandbox.window.confirm=()=>true;h.binding.protocol_version=4;
 assert.equal(await h.api.recarregar(),true);assert.equal(h.loads.length,2);
 await h.api.saveStudy(h.frames[0].contentWindow,{},0);assert.equal(h.requests.at(-1).body.expected_protocol_version,4);
});

test('conflict preserves points in the viewer and blocks resaving against stale binding until explicit reload',async()=>{
 const h=await clinicalHarness();await h.api.abrirProtocolo(testProtocol,'Teste');let unbound=0;
 h.frames[0].contentWindow.AMJRostoViewer.unbind=()=>unbound++;
 const fetch=h.sandbox.fetch;h.sandbox.fetch=async()=>({ok:false,status:409,json:async()=>({ok:false,codigo:'protocol_context_conflict',erro:'Consulta alterada.'})});
 await assert.rejects(h.api.saveStudy(h.frames[0].contentWindow,{},0),/Consulta alterada/);
 assert.equal(unbound,0);assert.equal(h.loads.length,1);assert.match(h.status.textContent,/continuam na tela/);
 await assert.rejects(h.api.saveStudy(h.frames[0].contentWindow,{},0),/recarregue/);
 h.sandbox.fetch=fetch;await h.api.recarregar();assert.equal(unbound,1);
 await h.api.saveStudy(h.frames[0].contentWindow,{},0);
});

test('return opens the exact consultation and cannot continue after logout during navigation',async()=>{
 for(const logout of [false,true]){
  const h=await clinicalHarness();await h.api.abrirProtocolo(testProtocol,'Teste');let resolve;const opened=[];
  h.sandbox.window.AMJShell={navigate:()=>new Promise(r=>resolve=r)};h.sandbox.window.AMJProntuario={abrirProtocolo:async id=>opened.push(id)};
  const returning=h.api.voltarConsulta();if(logout)h.api.reset();resolve(true);await returning;
  assert.deepEqual(opened,logout?[]:[testProtocol]);
 }
});

test('return and reload are blocked while a password/save operation is pending',async()=>{
 const h=await clinicalHarness();await h.api.abrirProtocolo(testProtocol,'Teste');let resolve;
 h.sandbox.window.AMJProtecao.solicitarEdicaoRotineira=()=>new Promise(r=>resolve=r);
 const saving=h.api.saveStudy(h.frames[0].contentWindow,{},0);
 assert.equal(await h.api.recarregar(),false);assert.equal(await h.api.voltarConsulta(),false);
 resolve({operation_id:testProtocol,encerrar:async()=>{}});await saving;
});

test('return does not reopen consultation when shell navigation is canceled',async()=>{
 const h=await clinicalHarness();await h.api.abrirProtocolo(testProtocol,'Teste');let opened=false;
 h.sandbox.window.AMJShell={navigate:async()=>false};h.sandbox.window.AMJProntuario={abrirProtocolo:async()=>opened=true};
 assert.equal(await h.api.voltarConsulta(),false);assert.equal(opened,false);
});

test('edits made during loading or retry are never silently overwritten',async()=>{
 for(const outcome of ['success','error','pause']){
  const h=await clinicalHarness();const fetch=h.sandbox.fetch;let resolve;let dirty=false,unbinds=0,confirms=0;
  h.frames[0].contentWindow.AMJRostoViewer.hasChanges=()=>dirty;
  h.frames[0].contentWindow.AMJRostoViewer.unbind=()=>{unbinds++;dirty=false;};
  h.sandbox.window.confirm=()=>{confirms++;return false;};
  h.sandbox.fetch=()=>new Promise(r=>resolve=r);const opening=h.api.abrirProtocolo(testProtocol,'Teste');
  await new Promise(r=>setTimeout(r,0));dirty=true;if(outcome==='pause')h.api.pausar();
  resolve({ok:outcome!=='error',json:async()=>({ok:outcome!=='error',erro:'Falha',protocolo_id:testProtocol,binding:h.binding,study:null})});
  await opening;assert.equal(h.loads.length,0);assert.equal(dirty,true);assert.equal(unbinds,1);assert.equal(confirms,outcome==='success'?1:0);
  h.sandbox.fetch=fetch;await h.api.ativar(true);assert.equal(h.loads.length,0);assert.equal(dirty,true);
 }
});

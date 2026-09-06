import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import * as THREE from '../rosto3d/v2/vendor/three.module.js';
import {annotations} from '../rosto3d/v2/annotations.mjs';
import {pointPosition} from '../rosto3d/v2/study.mjs';
function setup(save=async(_source,document,version)=>({document,version:version+1}),specs=[{id:'test-skin',layer:'skin',mode:'appearance'}],revealPoint){
 const ids=new Map(),buttons=['rotate','mark','move'].map(tool=>({dataset:{tool},setAttribute(){}}));
 function element(){return {dataset:{},value:'',children:[],setAttribute(){},append(v){this.children.push(v);},prepend(v){this.children.unshift(v);},replaceChildren(...v){this.children=v;},get options(){return this.children;},focus(){},remove(){},getContext(){return {beginPath(){},arc(){},fill(){},fillText(){}};}};}
 const section=element();section.querySelector=q=>{if(!ids.has(q))ids.set(q,element());return ids.get(q);};section.querySelectorAll=()=>buttons;
 const aside=element();globalThis.document={querySelector:()=>aside,createElement:tag=>tag==='section'?section:element()};globalThis.window={};globalThis.confirm=()=>true;
 const scene=new THREE.Scene(),registry={},models=specs.map(spec=>{
  const geometry=new THREE.PlaneGeometry(2,2);geometry.translate(0,0,spec.z||0);
  const mat=new THREE.MeshBasicMaterial({side:THREE.DoubleSide,transparent:spec.transparent||false,opacity:spec.opacity??1,alphaTest:spec.alphaTest||0,map:spec.map||null});
  if(spec.grouped)geometry.addGroup(0,geometry.index.count,0);
  const mesh=new THREE.Mesh(geometry,spec.grouped?[mat]:mat);mesh.name=spec.id;mesh.userData={positions:Array.from(geometry.attributes.position.array),indices:Array.from(geometry.index.array),layer:spec.layer,mode:spec.mode};scene.add(mesh);
  if(spec.registered!==false)registry[spec.id]={mode:spec.mode,triangles:2};return mesh;
 });let mode=specs[0].mode;const mesh=models[0];scene.updateMatrixWorld();
 const api=annotations({THREE,scene,models,registry,getMode:()=>mode,render(){scene.updateMatrixWorld();},host:()=>({saveStudy:save}),revealPoint});
 return {api,scene,mesh,models,field:id=>section.querySelector('#'+id),tool:name=>buttons.find(b=>b.dataset.tool===name).onclick(),mode(value){mode=value;for(const m of models)m.visible=m.userData.mode===value;api.refresh();},tap:(x=0,y=0)=>api.tap(new THREE.Raycaster(new THREE.Vector3(x,y,2),new THREE.Vector3(0,0,-1)))};
}
test('mark, name, note, save and reopen reconstruct the same surface anchor',async()=>{
 let stored;const h=setup(async(_,document,version)=>{stored={document,version:version+1};return stored;});
 assert.equal(h.field('study-save').disabled,true);
 h.api.loadStudy(null,'Consulta sintética');h.tool('mark');assert.equal(h.tap(.3,.2),true);
 h.field('point-name').value='Avaliação frontal';h.field('point-name').oninput();h.field('point-notes').value='Observação escrita pela profissional';h.field('point-notes').oninput();
 h.field('study-notes').value='Estudo genérico';h.field('study-notes').oninput();
 const original=h.api.getStudy(),anchor=pointPosition(original.points[0],h.mesh.userData);assert.equal(h.api.hasChanges(),true);
 await h.field('study-save').onclick();assert.equal(h.api.hasChanges(),false);assert.equal(stored.version,1);
 h.api.unbind();assert.equal(h.api.getStudy().points.length,0);assert.equal(h.field('study-save').disabled,true);
 h.api.loadStudy(stored,'Mesma consulta');assert.deepEqual(h.api.getStudy(),original);assert.deepEqual(pointPosition(h.api.getStudy().points[0],h.mesh.userData),anchor);h.api.dispose();
});
test('move preserves text; point deletion requires confirmation and another save',()=>{
 const h=setup();h.api.loadStudy(null,'Teste');h.tool('mark');h.tap(.4,.4);
 const original=h.api.getStudy().points[0];h.tool('move');h.tap(-.4,-.4);
 const moved=h.api.getStudy().points[0];assert.equal(moved.id,original.id);assert.equal(moved.label,original.label);assert.notDeepEqual(moved.barycentric,original.barycentric);
 globalThis.confirm=()=>false;h.field('point-delete').onclick();assert.equal(h.api.getStudy().points.length,1);
 globalThis.confirm=()=>true;h.field('point-delete').onclick();assert.equal(h.api.getStudy().points.length,0);h.api.dispose();
});
test('failed save preserves unsaved work and late save after unbind cannot restore it',async()=>{
 let fail=true,resolve;const h=setup(async(_,document)=>{if(fail)throw Error('Teste de falha');return new Promise(r=>resolve=()=>r({document,version:1}));});
 h.api.loadStudy(null,'Teste');h.tool('mark');h.tap();
 await h.field('study-save').onclick();assert.equal(h.api.hasChanges(),true);assert.equal(h.field('point-status').textContent,'Teste de falha');
 fail=false;const saving=h.field('study-save').onclick();assert.equal(h.api.isBusy(),true);h.api.unbind();resolve();await saving;assert.equal(h.api.getStudy().points.length,0);assert.equal(h.field('study-save').disabled,true);h.api.dispose();
});
test('unloaded or hidden surfaces cannot acquire a point',()=>{
 const h=setup();h.tool('mark');h.mesh.visible=false;h.tap();assert.equal(h.api.getStudy().points.length,0);h.api.dispose();
});

const layered=opacity=>[{id:'atlas-surface',layer:'surface',mode:'anatomy',z:1,grouped:true,transparent:opacity<1,opacity},{id:'atlas-muscle',layer:'muscles',mode:'anatomy'}];
test('grouped translucent atlas skin does not steal a muscle anchor',()=>{
 const h=setup(undefined,layered(.23));h.tool('mark');h.tap(.3,.2);
 const p=h.api.getStudy().points[0];assert.equal(p.meshId,'atlas-muscle');const at=pointPosition(p,h.models[1].userData);assert(Math.abs(at[0]-.3)<1e-12&&Math.abs(at[1]-.2)<1e-12&&at[2]===0);h.api.dispose();
});
test('opaque grouped atlas skin is markable and translucent skin remains markable without visible tissues',()=>{
 for(const opacity of [1,.23]){const h=setup(undefined,layered(opacity));if(opacity<1)h.models[1].visible=false;h.tool('mark');h.tap();assert.equal(h.api.getStudy().points[0].meshId,'atlas-surface');h.api.dispose();}
});
test('raycast honors each face material index, not the first material of the mesh',()=>{
 const h=setup(undefined,layered(.23)),skin=h.models[0];skin.material.push(new THREE.MeshBasicMaterial({side:THREE.DoubleSide}));skin.geometry.clearGroups();skin.geometry.addGroup(0,3,0);skin.geometry.addGroup(3,3,1);
 h.tool('mark');h.tap(-.5,.5);h.tap(.5,-.5);assert.deepEqual(h.api.getStudy().points.map(p=>p.meshId),['atlas-muscle','atlas-surface']);h.api.dispose();
});
test('markers on a muscle can be selected through grouped translucent skin',()=>{
 const h=setup(undefined,layered(.23));h.models[0].visible=false;h.tool('mark');h.tap(-.4,.2);const first=h.api.getStudy().points[0];h.tap(.4,.2);assert.notEqual(h.field('point-list').value,first.id);h.models[0].visible=true;h.api.refresh();
 h.tool('rotate');assert.equal(h.tap(-.4,.2),true);assert.equal(h.field('point-list').value,first.id);h.api.dispose();
});
test('transparent hair texture texels do not block skin marking; opaque texels do',()=>{
 for(const alpha of [0,255]){const map=new THREE.DataTexture(new Uint8Array([255,255,255,alpha]),1,1);map.needsUpdate=true;
  const h=setup(undefined,[{id:'hair',layer:'hair',mode:'appearance',z:1,registered:false,map,alphaTest:.35},{id:'skin',layer:'skin',mode:'appearance'}]);h.tool('mark');h.tap();
  assert.equal(h.api.getStudy().points.length,alpha===0?1:0);if(alpha===0)assert.equal(h.api.getStudy().points[0].meshId,'skin');h.api.dispose();map.dispose();
 }
});
test('move cannot silently transfer a point between the independent face and atlas bases',()=>{
 const h=setup(undefined,[{id:'face',layer:'skin',mode:'appearance'},{id:'atlas',layer:'surface',mode:'anatomy'}]);h.mode('appearance');h.tool('mark');h.tap(.3,.2);const before=h.api.getStudy();
 h.mode('anatomy');h.tool('move');h.tap(-.3,-.2);assert.deepEqual(h.api.getStudy(),before);assert.match(h.field('point-status').textContent,/base|rosto/i);h.api.dispose();
});
test('selecting a saved point reveals its base/layer without changing any study data',async()=>{
 const revealed=[];let h;h=setup(undefined,[{id:'face',layer:'skin',mode:'appearance'},{id:'atlas',layer:'muscles',mode:'anatomy'}],async(point,isCurrent)=>{assert.equal(isCurrent(),true);revealed.push(point);h.mode(point.mode);return true;});
 h.mode('anatomy');h.tool('mark');h.tap(.3,.2);const original=h.api.getStudy(),point=original.points[0],position=pointPosition(point,h.models[1].userData);
 h.api.loadStudy({document:original,version:3},'Consulta sintética');h.mode('appearance');h.field('point-list').value=point.id;await h.field('point-list').onchange();
 assert.equal(revealed[0].meshId,'atlas');assert.equal(h.models[1].visible,true);assert.equal(h.field('point-list').value,point.id);assert.match(h.field('point-status').textContent,/atlas.*independente/i);assert.equal(h.api.hasChanges(),false);assert.deepEqual(h.api.getStudy(),original);assert.deepEqual(pointPosition(h.api.getStudy().points[0],h.models[1].userData),position);h.api.dispose();
});
test('a stale list reveal cannot apply after a newer selection or consultation reset',async()=>{
 const pending=[];const h=setup(undefined,undefined,(point,isCurrent)=>new Promise(resolve=>pending.push({point,isCurrent,resolve})));
 h.tool('mark');h.tap(-.4,.2);h.tap(.4,.2);const [first,second]=h.api.getStudy().points;
 h.field('point-list').value=first.id;const a=h.field('point-list').onchange();h.field('point-list').value=second.id;const b=h.field('point-list').onchange();
 assert.equal(pending[0].isCurrent(),false);assert.equal(pending[1].isCurrent(),true);pending[1].resolve(true);await b;pending[0].resolve(true);await a;assert.equal(h.field('point-list').value,second.id);
 h.field('point-list').value=first.id;const c=h.field('point-list').onchange();h.api.loadStudy(null,'Nova consulta sintética');const status=h.field('point-status').textContent;assert.equal(pending[2].isCurrent(),false);pending[2].resolve(true);await c;assert.equal(h.field('point-status').textContent,status);assert.equal(h.api.getStudy().points.length,0);h.api.dispose();
});

// Exercise the actual preview callbacks without WebGL or loading a patient's data.
const previewSource=readFileSync(new URL('../rosto3d/v2/preview.js',import.meta.url),'utf8');
test('preview reveal opens a hidden atlas tissue, restores skin, and preserves current mode when possible',async()=>{
 const state={mode:'appearance',surface:true,opacity:1,muscles:false,arteries:false,nerves:false,bones:true,atlasEyes:true,atlasHair:true,selected:'other',isolated:true},models=[{name:'muscle',userData:{mode:'anatomy',layer:'muscles'}},{name:'surface',userData:{mode:'anatomy',layer:'surface'}},{name:'face',userData:{mode:'appearance',layer:'skin'}}],switched=[],focused=[];
 const context={state,models,tissueLayers:new Set(['muscles','arteries','nerves']),gesture:{clear(){}},stopFocus(){},disposed:false,lost:false,async setMode(mode,options){switched.push([mode,options.reframe]);state.mode=mode;},sync(){},focusPoint(point,mesh,baseChanged){focused.push([point.meshId,mesh.name,baseChanged]);}};
 vm.runInNewContext(previewSource.slice(previewSource.indexOf('async function revealPoint('),previewSource.indexOf('\ntry{\n scene=')),context);
 const muscle={mode:'anatomy',meshId:'muscle'};await context.revealPoint(muscle,()=>true);assert.equal(state.mode,'anatomy');assert.equal(state.muscles,true);assert.equal(state.opacity,.23);assert.equal(state.isolated,true);assert.equal(state.selected,'muscle');assert.equal(state.bones,false);assert.deepEqual(switched,[['anatomy',false]]);
 await context.revealPoint(muscle,()=>true);assert.equal(switched.length,1);assert.equal(focused.at(-1)[2],false);
 state.surface=false;await context.revealPoint({mode:'anatomy',meshId:'surface'},()=>true);assert.equal(state.surface,true);assert.equal(state.opacity,1);assert.equal(state.isolated,false);
 await context.revealPoint({mode:'appearance',meshId:'face'},()=>true);assert.equal(state.mode,'appearance');assert.deepEqual(switched,[['anatomy',false],['appearance',false]]);
 const before=JSON.stringify(state),count=focused.length;await context.revealPoint({mode:'appearance',meshId:'face'},()=>false);assert.equal(JSON.stringify(state),before);assert.equal(focused.length,count);
});
test('point framing is unchanged when already visible and otherwise moves smoothly without editing geometry',()=>{
 const camera=new THREE.PerspectiveCamera(34,1,.05,100);camera.position.set(0,0,6);camera.lookAt(0,0,0);camera.updateMatrixWorld();
 const mesh=new THREE.Mesh(new THREE.BoxGeometry(2,2,2),new THREE.MeshBasicMaterial());mesh.userData={mode:'appearance',layer:'skin'};
 const controls={target:new THREE.Vector3(),minDistance:2.4,update(){camera.lookAt(this.target);camera.updateMatrixWorld();}},frames=new Map();let frameId=0,now=0,position=[0,.2,1];
 const context={THREE,models:[mesh],camera,controls,pointPosition:()=>position,cameraFrame:0,disposed:false,active:true,lost:false,performance:{now:()=>now},matchMedia:()=>({matches:false}),render(){},requestAnimationFrame(fn){frames.set(++frameId,fn);return frameId;},cancelAnimationFrame(id){frames.delete(id);}};
 vm.runInNewContext(previewSource.slice(previewSource.indexOf('function stopFocus('),previewSource.indexOf('function selectOptions('))+previewSource.slice(previewSource.indexOf('function focusPoint('),previewSource.indexOf('async function revealPoint(')),context);
 const geometry=Array.from(mesh.geometry.attributes.position.array),before=camera.position.toArray(),point={mode:'appearance'};context.focusPoint(point,mesh,false);assert.deepEqual(camera.position.toArray(),before);assert.equal(frames.size,0);
 position=[0,.2,-1];context.focusPoint(point,mesh,false);assert.deepEqual(camera.position.toArray(),before);assert.equal(frames.size,1);
 for(now=0;now<=320;now+=80){const jobs=[...frames.values()];frames.clear();for(const fn of jobs)fn(now);}
 assert.deepEqual(controls.target.toArray(),position);assert(camera.position.z<-1);assert.deepEqual(Array.from(mesh.geometry.attributes.position.array),geometry);assert.equal(frames.size,0);
 context.focusPoint(point,mesh,true);assert.equal(frames.size,1);context.stopFocus();assert.equal(frames.size,0);mesh.geometry.dispose();mesh.material.dispose();
});

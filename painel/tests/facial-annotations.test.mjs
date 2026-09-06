import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../rosto3d/v2/vendor/three.module.js';
import {annotations} from '../rosto3d/v2/annotations.mjs';
import {pointPosition} from '../rosto3d/v2/study.mjs';
function setup(save=async(_source,document,version)=>({document,version:version+1})){
 const ids=new Map(),buttons=['rotate','mark','move'].map(tool=>({dataset:{tool},setAttribute(){}}));
 function element(){return {dataset:{},value:'',children:[],setAttribute(){},append(v){this.children.push(v);},prepend(v){this.children.unshift(v);},replaceChildren(...v){this.children=v;},get options(){return this.children;},focus(){},remove(){},getContext(){return {beginPath(){},arc(){},fill(){},fillText(){}};}};}
 const section=element();section.querySelector=q=>{if(!ids.has(q))ids.set(q,element());return ids.get(q);};section.querySelectorAll=()=>buttons;
 const aside=element();globalThis.document={querySelector:()=>aside,createElement:tag=>tag==='section'?section:element()};globalThis.window={};globalThis.confirm=()=>true;
 const mesh=new THREE.Mesh(new THREE.PlaneGeometry(2,2),new THREE.MeshBasicMaterial({side:THREE.DoubleSide}));mesh.name='test-skin';mesh.userData={positions:Array.from(mesh.geometry.attributes.position.array),indices:Array.from(mesh.geometry.index.array),layer:'skin'};mesh.updateMatrixWorld();
 const scene=new THREE.Scene();scene.add(mesh);const registry={'test-skin':{mode:'appearance',triangles:2}};
 const api=annotations({THREE,scene,models:[mesh],registry,getMode:()=> 'appearance',render(){scene.updateMatrixWorld();},host:()=>({saveStudy:save})});
 return {api,scene,mesh,field:id=>section.querySelector('#'+id),tool:name=>buttons.find(b=>b.dataset.tool===name).onclick(),tap:(x=0,y=0)=>api.tap(new THREE.Raycaster(new THREE.Vector3(x,y,2),new THREE.Vector3(0,0,-1)))};
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

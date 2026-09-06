import * as THREE from 'three';
import {OrbitControls} from './vendor/OrbitControls.js';
import {initial,preset,visible,tissueLayers} from './layer-state.mjs';
import {annotations} from './annotations.mjs';
const embedded=window.parent!==window;
const host=()=>{try{return embedded&&window.parent.location.origin===location.origin&&window.parent.AMJRosto3D?.frameAttached(window)?window.parent.AMJRosto3D:null;}catch{return null;}};
if(embedded&&!host())throw Error('Abra este visor pelo app Fichas.');
const $=id=>document.getElementById(id),viewer=$('viewer'),models=[],textures=new Map(),requests=new Map();
let state={...initial},scene,camera,renderer,controls,editor,resizeObserver,disposed=false,ready=false,active=!document.hidden&&(!embedded||Boolean(host()?.frameAllowed(window))),lost=false,requestId=0,down=null;
const ray=new THREE.Raycaster(),pointer=new THREE.Vector2();
const mats=m=>[].concat(m.material);
async function loadJSON(path){const r=await fetch(path);if(!r.ok)throw Error('Arquivo indisponível: '+path);return r.json();}
async function loadTexture(path){path=path.replace(/^\/assets\//,'./assets/');if(!textures.has(path)){const t=await new THREE.TextureLoader().loadAsync(path);t.colorSpace=THREE.SRGBColorSpace;t.anisotropy=Math.min(8,renderer.capabilities.getMaxAnisotropy());textures.set(path,t);}return textures.get(path);}
function add(meta){
 const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(meta.positions,3));g.setAttribute('normal',new THREE.Float32BufferAttribute(meta.normals,3));g.setIndex(meta.indices);
 if(meta.uvs)g.setAttribute('uv',new THREE.Float32BufferAttribute(meta.uvs,2));
 const palette={muscles:'#AD796E',arteries:'#B4443D',nerves:'#D4AA39',bones:'#E4D8C2',surface:'#D5B69F',eyes:'#E8E1D6',iris:'#66513D','atlas-hair':'#4C3328',skin:'#ffffff',hair:'#ffffff'};
 const make=spec=>{const lip=meta.layer==='surface'&&/Oral_region|Tubercle_of_upper_lip|Labial_commissure/.test(meta.sourceName||'');const color=meta.texture?'#ffffff':/tendon/i.test(spec?.name||'')?'#DFCFB9':meta.color||(lip?'#B98578':palette[meta.layer])||'#C5AD95';
 const mat=new THREE.MeshPhysicalMaterial({color,roughness:meta.layer==='eyes'?.16:meta.layer==='skin'?.65:.78,clearcoat:meta.layer==='eyes'?1:0,clearcoatRoughness:.04,metalness:0,side:THREE.DoubleSide});
 if(meta.texture){mat.map=textures.get(meta.texture.replace(/^\/assets\//,'./assets/'));if(['hair','eyes','eyebrows','eyelashes'].includes(meta.layer)){mat.alphaTest=.35;mat.alphaToCoverage=true;}}return mat;};
 let material;if(meta.groups?.length&&meta.materials?.length){material=meta.materials.map(make);for(const group of meta.groups)g.addGroup(group.start,group.count,group.materialIndex);}else material=make();
 const mesh=new THREE.Mesh(g,material);mesh.name=meta.id;mesh.userData=meta;mesh.visible=false;scene.add(mesh);models.push(mesh);
}
function render(){if(!disposed&&active&&!lost&&renderer)renderer.render(scene,camera);}
function selectOptions(){
 const list=models.filter(m=>m.userData.mode==='anatomy'&&tissueLayers.has(m.userData.layer)&&state[m.userData.layer]).sort((a,b)=>a.userData.labelPt.localeCompare(b.userData.labelPt,'pt-BR'));
 if(!list.some(m=>m.name===state.selected)){state.selected='';state.isolated=false;}
 const options=$('muscle-select'),empty=document.createElement('option');empty.value='';empty.textContent=list.length?'Escolha uma estrutura':'Ative músculos, artérias ou nervos';
 options.replaceChildren(empty);for(const mesh of list){const o=document.createElement('option');o.value=mesh.name;o.textContent=mesh.userData.labelPt;options.append(o);}options.value=state.selected;
}
function sync(){
 for(const id of ['surface','muscles','arteries','nerves','bones'])$(id).checked=state[id];
 $('atlas-eyes').checked=state.atlasEyes;$('atlas-hair').checked=state.atlasHair;$('opacity').value=Math.round(state.opacity*100);
 selectOptions();
 for(const mesh of models){const meta=mesh.userData;mesh.visible=visible(meta,state);
  if(state.mode==='appearance'){if(meta.layer==='hair')mesh.visible&&=$('hair').checked&&(meta.hairStyle||'tied')===$('hair-style').value;if(['eyes','eyelashes','eyebrows'].includes(meta.layer))mesh.visible&&=$('appearance-eyes').checked;
   if(meta.layer==='skin'){const mat=mesh.material,map=$('texture').checked?textures.get(meta.texture.replace(/^\/assets\//,'./assets/')):null;if(mat.map!==map){mat.map=map;mat.needsUpdate=true;}mat.color.set(map?'#ffffff':'#C5AD95');}}
  for(const mat of mats(mesh)){if(meta.layer==='surface'){mat.opacity=state.opacity;mat.transparent=state.opacity<1;mat.depthWrite=state.opacity===1;}
   mat.emissive.set(meta.id===state.selected&&state.mode==='anatomy'?'#281908':'#000000');}
 }
 $('anatomy-controls').hidden=state.mode!=='anatomy';$('appearance-controls').hidden=state.mode!=='appearance';
 $('anatomy').setAttribute('aria-pressed',String(state.mode==='anatomy'));$('appearance').setAttribute('aria-pressed',String(state.mode==='appearance'));
 $('tag').textContent=state.mode==='appearance'?'Rosto genérico · estudo de aparência externa':'Atlas genérico · pele, músculos, artérias e nervos da mesma base';
 $('opacity-value').textContent=Math.round(state.opacity*100)+'%';$('visibility-note').textContent=state.surface&&state.opacity>=.8?'Pele opaca: reduza a opacidade ou use os botões de camadas para ver o interior.':'Transparência didática. Não representa profundidades ou trajetos individuais.';
 $('isolate').disabled=!state.selected;$('isolate').textContent=state.isolated?'Mostrar camadas':'Isolar';
 const chosen=models.find(m=>m.name===state.selected);$('selection').hidden=!chosen||state.mode!=='anatomy';$('selection').textContent=chosen?.userData.labelPt||'';
 editor?.refresh();render();
}
function view(angle=0){
 const a=angle*Math.PI/180,box=new THREE.Box3();
 const frame=models.filter(m=>m.userData.mode===state.mode&&(state.mode==='appearance'?(m.userData.layer==='skin'||m.userData.layer==='hair'&&m.visible):m.userData.layer==='surface'));
 for(const mesh of frame){
  if(state.mode==='appearance'){const p=mesh.geometry.getAttribute('position');for(let i=0;i<p.count;i++)if(p.getY(i)>=-1.85)box.expandByPoint(new THREE.Vector3(p.getX(i),p.getY(i),p.getZ(i)));}
  else box.expandByObject(mesh);
 }if(box.isEmpty())return;
 const target=box.getCenter(new THREE.Vector3()),size=box.getSize(new THREE.Vector3()),width=Math.abs(Math.cos(a))*size.x+Math.abs(Math.sin(a))*size.z;
 const distance=1.12*Math.max(size.y,width/camera.aspect)/(2*Math.tan(camera.fov*Math.PI/360))+size.z*.3;
 controls.target.copy(target);camera.position.copy(target).add(new THREE.Vector3(Math.sin(a)*distance,.10,Math.cos(a)*distance));controls.maxDistance=Math.max(14,distance*1.6);controls.update();render();
}
async function setMode(value){
 const token=++requestId;state.mode=value;state.selected='';state.isolated=false;$('loading').hidden=false;$('loading').textContent=value==='appearance'?'Preparando o rosto…':'Preparando as camadas anatômicas…';
 for(const mesh of models)mesh.visible=false;editor?.refresh();render();
 try{if(!requests.has(value))requests.set(value,(async()=>{const data=await loadJSON('./assets/'+value+'.json');await Promise.all([...new Set(data.meshes.map(m=>m.texture).filter(Boolean))].map(loadTexture));if(disposed||embedded&&!host())return;for(const meta of data.meshes)add({...meta,mode:value});})());
 await requests.get(value);if(disposed||token!==requestId)return;sync();view();$('loading').hidden=true;
 }catch(error){if(token!==requestId)return;requests.delete(value);lost=true;window.AMJRostoFailed=true;$('loading').textContent=error.message+' Use Abrir / tentar novamente no app.';throw error;}
}
try{
 scene=new THREE.Scene();scene.background=new THREE.Color('#FBF6F0');camera=new THREE.PerspectiveCamera(34,1,.05,100);
 renderer=new THREE.WebGLRenderer({antialias:true});renderer.setPixelRatio(Math.min(devicePixelRatio,2));renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1;
 viewer.append(renderer.domElement);controls=new OrbitControls(camera,renderer.domElement);controls.enableDamping=false;controls.enablePan=false;controls.minDistance=2.4;controls.addEventListener('change',render);
 scene.add(new THREE.HemisphereLight('#FFF8EE','#76685E',1.3));for(const [power,pos]of [[2.4,[-3,4,5]],[1,[4,2,3]],[1.5,[0,3,-4]]]){const light=new THREE.DirectionalLight('#FFF9F3',power);light.position.set(...pos);scene.add(light);}
 resizeObserver=new ResizeObserver(()=>{camera.aspect=viewer.clientWidth/viewer.clientHeight;camera.updateProjectionMatrix();renderer.setSize(viewer.clientWidth,viewer.clientHeight,false);render();});resizeObserver.observe(viewer);
 $('appearance').onclick=()=>setMode('appearance');$('anatomy').onclick=()=>setMode('anatomy');$('home').onclick=()=>view();
 for(const b of document.querySelectorAll('[data-angle]'))b.onclick=()=>view(Number(b.dataset.angle));
 for(const b of document.querySelectorAll('[data-preset]'))b.onclick=()=>{state=preset(state,b.dataset.preset);sync();};
 for(const id of ['surface','muscles','arteries','nerves','bones'])$(id).onchange=()=>{state[id]=$(id).checked;state.isolated=false;if(tissueLayers.has(id)&&state[id]&&state.surface&&state.opacity>=.8){state.opacity=.23;state.atlasEyes=false;}sync();};
 $('atlas-eyes').onchange=()=>{state.atlasEyes=$('atlas-eyes').checked;sync();};$('atlas-hair').onchange=()=>{state.atlasHair=$('atlas-hair').checked;sync();};$('opacity').oninput=()=>{state.opacity=Number($('opacity').value)/100;sync();};
 for(const id of ['appearance-eyes','hair','texture','hair-style'])$(id).onchange=sync;
 $('muscle-select').onchange=()=>{state.selected=$('muscle-select').value;state.isolated=false;sync();};$('isolate').onclick=()=>{state.isolated=!state.isolated;sync();};$('context').onclick=()=>{state.isolated=false;sync();};
 const target=renderer.domElement,contacts=new Set();let multi=false;
 target.addEventListener('pointerdown',e=>{contacts.add(e.pointerId);if(contacts.size>1){multi=true;down=null;}else if(e.isPrimary){multi=false;down={x:e.clientX,y:e.clientY,time:performance.now(),id:e.pointerId};}});
 target.addEventListener('pointercancel',e=>{contacts.delete(e.pointerId);down=null;});
 target.addEventListener('pointerup',e=>{contacts.delete(e.pointerId);const start=down;down=null;if(!active||disposed||multi||!start||start.id!==e.pointerId||Math.hypot(start.x-e.clientX,start.y-e.clientY)>6||performance.now()-start.time>550)return;
 const rect=target.getBoundingClientRect();pointer.set((e.clientX-rect.left)/rect.width*2-1,-(e.clientY-rect.top)/rect.height*2+1);ray.setFromCamera(pointer,camera);
 if(editor?.tap(ray))return;if(state.mode!=='anatomy')return;
 const hit=ray.intersectObjects(models.filter(m=>m.visible&&(m.userData.layer!=='surface'||state.opacity>=.8)))[0];
 if(hit&&tissueLayers.has(hit.object.userData.layer)){state.selected=hit.object.name;sync();}});
 target.addEventListener('webglcontextlost',e=>{e.preventDefault();lost=true;$('loading').hidden=false;$('loading').textContent='O visor foi interrompido. Recarregue para continuar.';});
 document.addEventListener('visibilitychange',()=>{active=!document.hidden&&(!embedded||Boolean(host()?.frameAllowed(window)));render();});
 const registry=await loadJSON('./assets/point-registry.json');if(disposed||embedded&&!host())throw Error('Sessão encerrada.');
 editor=annotations({THREE,scene,models,registry,getMode:()=>state.mode,render,host});
 window.AMJRostoViewer={ready:()=>ready,hasChanges:()=>editor.hasChanges(),isBusy:()=>editor.isBusy(),getStudy:()=>editor.getStudy(),loadStudy:(study,label)=>editor.loadStudy(study,label),unbind:()=>editor.unbind(),failed:()=>lost,setActive(v){active=Boolean(v)&&!disposed;render();},dispose(){disposed=true;requestId++;editor.dispose();resizeObserver?.disconnect();controls?.dispose();for(const m of models){m.geometry.dispose();for(const mat of mats(m))mat.dispose();}for(const t of textures.values())t.dispose();models.length=0;renderer.dispose();renderer.domElement.remove();}};
 window.addEventListener('beforeunload',e=>{if(editor.hasChanges()){e.preventDefault();e.returnValue='';}});
 await setMode('appearance');ready=true;if(embedded&&host())void host().frameReady(window);
 for(const type of ['pointerdown','keydown','input','wheel'])document.addEventListener(type,e=>{if(e.isTrusted)host()?.activity(window);},{passive:true,capture:true});
}catch(error){lost=true;window.AMJRostoFailed=true;$('loading').textContent='Não foi possível iniciar o visor. '+error.message;}

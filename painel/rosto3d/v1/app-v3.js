import * as THREE from 'three';
import {OrbitControls} from './vendor/OrbitControls.js';
import {selection,deform} from './deform.mjs';
import {defaults,validateStudy,FORMAT,VERSION,layerVisible} from './study.mjs';
import {Gesture} from './gesture.mjs';
const el=id=>document.getElementById(id),viewer=el('viewer'),say=t=>el('feedback').textContent=t;
const models=new Map(),points=[],history=[],ray=new THREE.Raycaster(),pointer=new THREE.Vector2(),gesture=new Gesture();
let scene,camera,renderer,controls,head,original,working,settings=defaults(),target='skin',tool='rotate',nextId=1;
let stroke=null,pendingMove=null,showOriginal=false,shapeDirty=false,changed=false,contextLost=false,selected=null,ready=false;
let disposed=false,failed=false,resizeObserver=null,animation=null;
function attached(){try{return window.parent.AMJRosto3D.frameAttached(window);}catch(_){return false;}}
function mayRender(){try{return !disposed&&!document.hidden&&window.parent.AMJRosto3D.frameAllowed(window);}catch(_){return false;}}
function setActive(active){
 if(!renderer||disposed)return;
 if(!active){const interrupted=gesture.active.size;gesture.clear();if(ready){finish(true);if(interrupted)resetControlsAfterLostPointer();}renderer.setAnimationLoop(null);}
 else if(ready&&!contextLost&&mayRender())renderer.setAnimationLoop(animation);
}
function dispose(){
 if(disposed)return;disposed=true;
 stroke=null;pendingMove=null;gesture.clear();renderer?.setAnimationLoop(null);controls?.dispose();resizeObserver?.disconnect();
 for(const m of models.values()){m.mesh.geometry.dispose();m.mesh.material.map?.dispose();m.mesh.material.dispose();}
 for(const p of points)releasePoint(p);points.length=0;history.length=0;models.clear();
 working=null;original=null;renderer?.dispose();renderer?.forceContextLoss();
}
window.AMJRostoViewer=Object.freeze({setActive,dispose,failed:()=>failed||contextLost,hasChanges:()=>changed||points.length>0||shapeDirty});
window.addEventListener('pagehide',dispose);
const modified=()=>{changed=true;el('save-status').textContent='Há alterações nesta sessão. Exporte para guardar um arquivo.';};
const visible=m=>layerVisible(m.layer,settings);
const metadata=()=>new Map([...models].map(([id,m])=>[id,{triangles:m.mesh.geometry.index.count/3}]));
async function json(path){const r=await fetch(path);if(!r.ok)throw Error('Arquivo indisponível: '+path);return r.json();}
function addModel(meta,data){
 if(disposed||!attached()){dispose();throw Error('Estudo encerrado.');}
 if(!data.positions?.length||data.positions.length%3||!data.positions.every(Number.isFinite)||!data.indices?.length||data.indices.length%3||data.indices.some(i=>!Number.isInteger(i)||i<0||i>=data.positions.length/3))throw Error('Malha inválida: '+meta.id);
 const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(data.positions,3));g.setIndex(data.indices);
 if(data.normals?.length===data.positions.length&&data.normals.every(Number.isFinite))g.setAttribute('normal',new THREE.Float32BufferAttribute(data.normals,3));else g.computeVertexNormals();
 g.computeBoundingSphere();g.computeBoundingBox();
 const color=meta.color||(meta.layer==='muscles'?'#9F4B45':meta.layer==='hair'?settings.hairColor:meta.layer==='eyes'?'#F6EDE4':settings.skinColor);
 if(data.uvs?.length===data.positions.length/3*2)g.setAttribute('uv',new THREE.Float32BufferAttribute(data.uvs,2));
 const mat=new THREE.MeshStandardMaterial({color:meta.eyeUV?'#ffffff':color,roughness:meta.layer==='eyes'?.3:.66,metalness:0,side:THREE.DoubleSide,vertexColors:!!meta.eyeUV});
 const mesh=new THREE.Mesh(g,mat);mesh.name=meta.id;scene.add(mesh);models.set(meta.id,{...meta,mesh});
 if(meta.id==='skin'){head=mesh;original=g.attributes.position.array.slice();working=original.slice();}
}
function colorEyes(m){
 const g=m.mesh.geometry,uv=g.attributes.uv;if(!uv)return;
 const colors=new Float32Array(uv.count*3),iris=new THREE.Color(settings.eyeColor),white=new THREE.Color('#F6EDE4'),black=new THREE.Color('#110E0C');
 for(let i=0;i<uv.count;i++){
  const u=uv.getX(i),v=uv.getY(i),d=Math.min(Math.hypot(u-.708,v-.702),Math.hypot(u-.291,v-.290));
  const c=white.clone();
  if(d<.114){c.copy(iris);if(d>.100)c.lerp(black,(d-.100)/.014*.55);if(d<.040)c.lerp(black,THREE.MathUtils.clamp((.040-d)/.007,0,1));}
  colors.set([c.r,c.g,c.b],i*3);
 }
 g.setAttribute('color',new THREE.Float32BufferAttribute(colors,3));
}
function makeDot(id){
 const c=document.createElement('canvas');c.width=c.height=96;const ctx=c.getContext('2d');
 ctx.fillStyle='#8B6420';ctx.beginPath();ctx.arc(48,48,42,0,Math.PI*2);ctx.fill();ctx.strokeStyle='#FFFDF9';ctx.lineWidth=5;ctx.stroke();ctx.fillStyle='#FFFDF9';ctx.font='500 42px Poppins, Arial';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(String(id),48,49);
 const tex=new THREE.CanvasTexture(c);tex.colorSpace=THREE.SRGBColorSpace;
 const dot=new THREE.Sprite(new THREE.SpriteMaterial({map:tex,depthTest:true,depthWrite:false}));dot.scale.set(.115,.115,1);return dot;
}
function releasePoint(p){scene.remove(p.dot);p.dot.material.map.dispose();p.dot.material.dispose();}
function pointPose(p){
 const g=models.get(p.model).mesh.geometry,ix=g.index.array,pos=g.attributes.position;
 const verts=[0,1,2].map(j=>new THREE.Vector3().fromBufferAttribute(pos,ix[p.triangle*3+j]));
 const n=new THREE.Vector3().crossVectors(verts[1].clone().sub(verts[0]),verts[2].clone().sub(verts[0])).normalize().multiplyScalar(p.side);
 const at=new THREE.Vector3();verts.forEach((v,j)=>at.addScaledVector(v,p.bary[j]));return {at,n};
}
function updatePoints(){
 for(const p of points){const {at,n}=pointPose(p);p.dot.position.copy(at).addScaledVector(n,.025);p.dot.visible=settings.labels&&visible(models.get(p.model));}
}
function listPoints(){
 el('points').replaceChildren();el('empty').hidden=points.length>0;
 for(const p of points){
  const m=models.get(p.model),li=document.createElement('li');li.className='point-card';li.id='point-'+p.id;li.setAttribute('aria-current',String(p.id===selected));
  const title=document.createElement('strong');title.textContent='Ponto '+p.id;
  const source=document.createElement('p');source.className='small';source.textContent=m.name+(visible(m)?'':' · camada oculta');
  const nameLabel=document.createElement('label');nameLabel.textContent='Nome';nameLabel.htmlFor='name-'+p.id;
  const name=document.createElement('input');name.id=nameLabel.htmlFor;name.value=p.name;name.maxLength=80;name.autocomplete='off';name.placeholder='Nome informado pela profissional';name.oninput=()=>{p.name=name.value;modified();};
  const noteLabel=document.createElement('label');noteLabel.textContent='Observações';noteLabel.htmlFor='note-'+p.id;
  const note=document.createElement('textarea');note.id=noteLabel.htmlFor;note.value=p.note;note.maxLength=1000;note.rows=3;note.placeholder='Anotações do estudo genérico';note.oninput=()=>{p.note=note.value;modified();};
  const actions=document.createElement('div');actions.className='point-actions';
  const locate=document.createElement('button');locate.textContent='Localizar';locate.onclick=()=>locatePoint(p);
  const remove=document.createElement('button');remove.textContent='Remover';remove.setAttribute('aria-label','Remover ponto '+p.id);remove.onclick=()=>{if(!confirm('Remover o ponto '+p.id+' e suas observações?'))return;releasePoint(p);points.splice(points.indexOf(p),1);modified();listPoints();say('Ponto removido. Outros pontos mantidos.');};
  actions.append(locate,remove);li.append(title,source,nameLabel,name,noteLabel,note,actions);el('points').append(li);
 }
}
function chooseTarget(id){
 target=id;el('target').value=id;
 for(const [key,m]of models)m.mesh.material.emissive.set(key===target&&m.layer==='muscles'?'#361712':'#000000');
 const m=models.get(id);el('structure-info').textContent=m?(m.name+(m.layer==='muscles'?' · referência genérica, nome sujeito à revisão profissional.':' · marcação manual nesta superfície.')):'Nenhuma camada visível. Ative uma camada para marcar.';
 const label=el('muscle-label');label.hidden=!(m&&m.layer==='muscles'&&visible(m));
 label.textContent=label.hidden?'':'Músculo selecionado: '+m.name;
 state();
}
function layers(){
 for(const [id,m]of models){
  m.mesh.visible=visible(m);
  if(m.layer==='skin'){m.mesh.material.color.set(settings.skinColor);m.mesh.material.opacity=settings.opacity;m.mesh.material.transparent=settings.opacity<1;m.mesh.material.depthWrite=settings.opacity===1;}
  if(m.layer==='hair')m.mesh.material.color.set(settings.hairColor);
  if(m.layer==='eyes'&&m.eyeUV)colorEyes(m);
  else if(m.layer==='eyes'&&m.tintable)m.mesh.material.color.set(settings.eyeColor);
 }
 const available=[...models].filter(([,m])=>visible(m)).sort((a,b)=>a[1].name.localeCompare(b[1].name,'pt-BR'));el('target').replaceChildren();
 for(const [id,m]of available){const option=document.createElement('option');option.value=id;option.textContent=m.name;el('target').append(option);}
 if(!available.some(([id])=>id===target))target=available[0]?.[0]||'';
 for(const k of ['skin','hair','eyes','muscles','labels'])el(k).checked=settings[k];
 for(const k of ['skinColor','hairColor','eyeColor'])el(k).value=settings[k];
 el('opacity').value=settings.opacity*100;el('opacity-value').textContent=Math.round(settings.opacity*100)+'%';
 el('appearance').setAttribute('aria-pressed',String(settings.view==='appearance'));el('anatomy').setAttribute('aria-pressed',String(settings.view==='anatomy'));
 chooseTarget(target);updatePoints();listPoints();
}
function state(){
 if(!ready)return;
 const canShape=settings.view==='appearance'&&settings.skin&&!showOriginal&&!contextLost;
 el('sculpt').disabled=!canShape;el('mark').disabled=!target||showOriginal||contextLost;
 el('undo-shape').disabled=!history.length||showOriginal||settings.view!=='appearance'||contextLost;
 el('restore').disabled=!shapeDirty||contextLost;el('compare').disabled=!shapeDirty||settings.view!=='appearance'||contextLost;
 el('compare').setAttribute('aria-pressed',String(showOriginal));el('compare').textContent=showOriginal?'Voltar à simulação':'Ver original';
 el('mark').setAttribute('aria-pressed',String(tool==='mark'));el('sculpt').setAttribute('aria-pressed',String(tool==='sculpt'));
 el('mark').textContent=tool==='mark'?'Concluir marcação':'Marcar na camada ativa';
 el('sculpt').textContent=tool==='sculpt'?'Concluir modelagem':'Remodelar manualmente';
 el('simulation-label').textContent=settings.view==='anatomy'?'REFERÊNCIA ANATÔMICA GENÉRICA · BASE SEPARADA':showOriginal?'FORMA ORIGINAL · MODELO GENÉRICO':shapeDirty?'SIMULAÇÃO ILUSTRATIVA · SEM GARANTIA DE RESULTADO':'Modelo genérico · não representa uma paciente';
 el('hint').textContent=tool==='sculpt'?'Arraste a pele · use os botões para mudar o ângulo':tool==='mark'?'Toque para marcar na camada ativa · sem sugestões automáticas':settings.view==='anatomy'?'Toque no músculo para ver o nome · arraste para girar':'Arraste para girar · dois dedos ou +/− para aproximar';
 el('target').disabled=!target||contextLost;
}
function display(){
 head.geometry.attributes.position.array.set(showOriginal?original:working);head.geometry.attributes.position.needsUpdate=true;head.geometry.computeVertexNormals();head.geometry.computeBoundingSphere();head.geometry.computeBoundingBox();updatePoints();
}
function finish(cancel=false){
 if(pendingMove&&!cancel)applyMove(pendingMove);pendingMove=null;
 if(!stroke)return;
 if(cancel){working=stroke.before;display();}else if(stroke.changed){history.push(stroke.before);if(history.length>20)history.shift();modified();}
 stroke=null;shapeDirty=working.some((v,i)=>Math.abs(v-original[i])>1e-7);state();
}
function setTool(next){finish();gesture.clear();tool=next;controls.enabled=next!=='sculpt';controls.enableRotate=next==='rotate';state();}
function resetControlsAfterLostPointer(){
 const at=controls.target.clone();controls.dispose();controls=new OrbitControls(camera,renderer.domElement);
 controls.target.copy(at);controls.enableDamping=true;controls.enablePan=false;controls.minDistance=2.1;controls.maxDistance=9;controls.minPolarAngle=.2;controls.maxPolarAngle=Math.PI-.2;
 controls.enabled=tool!=='sculpt';controls.enableRotate=tool==='rotate';controls.update();
}
function aim(e){const r=renderer.domElement.getBoundingClientRect();pointer.set((e.clientX-r.left)/r.width*2-1,-(e.clientY-r.top)/r.height*2+1);camera.updateMatrixWorld();scene.updateMatrixWorld(true);ray.setFromCamera(pointer,camera);}
function hitActive(m){
 return ray.intersectObject(m.mesh,false).find(hit=>{
  if(!m.alpha||!hit.uv)return true;
  const x=THREE.MathUtils.clamp(Math.floor(hit.uv.x*m.alpha.width),0,m.alpha.width-1),y=THREE.MathUtils.clamp(Math.floor((1-hit.uv.y)*m.alpha.height),0,m.alpha.height-1);
  return m.alpha.values[y*m.alpha.width+x]>=Math.ceil(.35*255);
 });
}
function identifyMuscle(){
 const meshes=[...models.values()].filter(m=>m.layer==='muscles'&&visible(m)).map(m=>m.mesh);
 const hit=ray.intersectObjects(meshes,false)[0];
 if(!hit)return null;
 chooseTarget(hit.object.name);say(models.get(hit.object.name).name+' selecionado. Você pode marcar pontos nesta estrutura.');
 return hit.object.name;
}
function applyMove(e){
 if(!stroke||contextLost)return;aim(e);const at=ray.ray.intersectPlane(stroke.plane,new THREE.Vector3());if(!at)return;
 working=deform(stroke.before,original,stroke.chosen,at.sub(stroke.hit).toArray());stroke.changed=working.some((v,i)=>Math.abs(v-stroke.before[i])>1e-7);display();
 if(stroke.changed)el('simulation-label').textContent='SIMULAÇÃO ILUSTRATIVA · SEM GARANTIA DE RESULTADO';
}
function front(){finish();camera.position.set(0,.15,5.6);controls.target.set(0,0,.05);controls.update();}
function rotate(t=0,p=0){finish();const s=new THREE.Spherical().setFromVector3(camera.position.clone().sub(controls.target));s.theta+=t;s.phi=THREE.MathUtils.clamp(s.phi+p,.2,Math.PI-.2);camera.position.copy(controls.target).add(new THREE.Vector3().setFromSpherical(s));controls.update();}
function zoom(f){finish();const d=camera.position.clone().sub(controls.target);d.setLength(THREE.MathUtils.clamp(d.length()*f,2.1,9));camera.position.copy(controls.target).add(d);controls.update();}
function changeView(view){setTool('rotate');showOriginal=false;display();settings.view=view;layers();front();modified();say(view==='anatomy'?'Musculatura em referência separada. Não há correspondência individual com a superfície.':'Superfície externa. Pontos e notas de todas as camadas foram preservados.');}
function locatePoint(p){
 if(contextLost)return;const m=models.get(p.model);setTool('rotate');settings.view=m.layer==='muscles'?'anatomy':'appearance';settings[m.layer]=true;settings.labels=true;showOriginal=false;display();target=p.model;selected=p.id;layers();
 const {at,n}=pointPose(p);controls.target.copy(at);camera.position.copy(at).addScaledVector(n,3.5);controls.update();el('point-'+p.id)?.scrollIntoView({block:'nearest'});say('Ponto '+p.id+' · '+m.name);
}
function exportStudy(){
 finish();const data={format:FORMAT,version:VERSION,base:'makehuman-amj-v1',shape:Array.from(working),settings:{...settings},points:points.map(({id,model,triangle,bary,side,name,note})=>({id,model,triangle,bary,side,name,note}))};
 validateStudy(data,metadata(),original);
 const blob=new Blob([JSON.stringify(data)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='AMJ-estudo-3D-'+new Date().toISOString().replace(/[:.]/g,'-')+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),60000);
 el('save-status').textContent='Download solicitado. Confira o arquivo na pasta Downloads e guarde-o na pasta do projeto.';say('Arquivo preparado com a simulação, pontos e notas. Confirme que o navegador concluiu o download.');
}
async function importStudy(file){
 if(!file)return;if(file.size>20*1024*1024){say('Arquivo muito grande. Limite: 20 MB. Estudo atual preservado.');return;}
 try{
  const checked=validateStudy(JSON.parse(await file.text()),metadata(),original);
  if(checked.settings.view==='anatomy'&&![...models.values()].some(m=>m.layer==='muscles'))throw Error('Referência muscular não carregada.');
  if((points.length||changed)&&!confirm('Abrir este arquivo substitui o estudo atual. Exporte antes se quiser guardá-lo. Continuar?'))return;
  // Validation is complete before mutation; imported strings only go into input values/textContent.
  const staged=checked.points.map(p=>({...p,dot:makeDot(p.id)}));
  setTool('rotate');points.forEach(releasePoint);points.splice(0,points.length,...staged);staged.forEach(p=>scene.add(p.dot));
  settings=checked.settings;working=Float32Array.from(checked.shape);history.length=0;showOriginal=false;shapeDirty=working.some((v,i)=>Math.abs(v-original[i])>1e-7);nextId=Math.max(0,...points.map(p=>p.id))+1;selected=null;display();layers();front();changed=true;
  el('save-status').textContent='Estudo aberto do arquivo. Alterações seguintes precisam de nova exportação.';say('Estudo reaberto: '+points.length+' pontos, observações, cores e forma preservados.');
 }catch(error){say('Não foi possível importar: '+error.message+' O estudo atual foi preservado.');}
}
try{
 if(!attached())throw Error('Abra o visor pelo app Fichas.');
 scene=new THREE.Scene();scene.background=new THREE.Color('#FFFDF9');camera=new THREE.PerspectiveCamera(35,1,.01,100);camera.position.set(0,.15,5.6);
 renderer=new THREE.WebGLRenderer({antialias:true});renderer.setPixelRatio(Math.min(devicePixelRatio,2));renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.05;viewer.append(renderer.domElement);
 controls=new OrbitControls(camera,renderer.domElement);controls.target.set(0,0,.05);controls.enableDamping=true;controls.enablePan=false;controls.minDistance=2.1;controls.maxDistance=9;controls.minPolarAngle=.2;controls.maxPolarAngle=Math.PI-.2;
 scene.add(new THREE.HemisphereLight('#fffdf9','#b4a091',1.8));for(const [color,intensity,x,y,z]of [['#ffffff',2.2,-3,4,5],['#f3e6d8',1,3,1,2],['#ffffff',1.5,0,2,-4]]){const light=new THREE.DirectionalLight(color,intensity);light.position.set(x,y,z);scene.add(light);}
 addModel({id:'skin',name:'Pele · superfície externa',layer:'skin'},await json('./rosto-amj-v1.json'));
 const manifest=await json('./assets/manifest.json'),failures=[];
 await Promise.all(manifest.objects.map(async m=>{try{
  const data=await json('./assets/'+m.file);
  let texture=null;if(m.texture){texture=await new THREE.TextureLoader().loadAsync('./assets/'+m.texture);if(disposed){texture.dispose();return;}texture.colorSpace=THREE.SRGBColorSpace;texture.flipY=true;texture.anisotropy=Math.min(4,renderer.capabilities.getMaxAnisotropy());}
  addModel(m,data);if(texture){
   const model=models.get(m.id),mat=model.mesh.material;mat.map=texture;mat.alphaTest=.35;mat.needsUpdate=true;
   const c=document.createElement('canvas');c.width=texture.image.width;c.height=texture.image.height;const ctx=c.getContext('2d',{willReadFrequently:true});ctx.drawImage(texture.image,0,0);
   const rgba=ctx.getImageData(0,0,c.width,c.height).data,alpha=new Uint8Array(c.width*c.height);for(let i=0;i<alpha.length;i++)alpha[i]=rgba[i*4+3];
   model.alpha={width:c.width,height:c.height,values:alpha};c.width=c.height=1;
  }
 }catch(e){failures.push(m.name);console.error(e);}}));
 if(disposed)throw Error('Estudo encerrado.');ready=true;el('loading').hidden=true;
 for(const button of document.querySelectorAll('.toolbar button'))button.disabled=false;
 for(const k of ['appearance','mark','sculpt','skin','skinColor','opacity','labels','reset-view','save','import','target'])el(k).disabled=false;
 for(const [layer,color]of [['hair','hairColor'],['eyes','eyeColor'],['muscles',null]]){const has=[...models.values()].some(m=>m.layer===layer);el(layer).disabled=!has;if(color)el(color).disabled=!has;if(layer==='muscles')el('anatomy').disabled=!has;}
 layers();
 say(failures.length?'Não carregaram: '+failures.join(', ')+'. Os demais recursos estão disponíveis.':'Pronto. Escolha uma camada para marcar, ou gire o rosto para explorar.');
 const resize=()=>{if(disposed||!viewer.clientWidth||!viewer.clientHeight)return;renderer.setSize(viewer.clientWidth,viewer.clientHeight,false);camera.aspect=viewer.clientWidth/viewer.clientHeight;camera.updateProjectionMatrix();};resizeObserver=new ResizeObserver(resize);resizeObserver.observe(viewer);resize();
 animation=()=>{if(!mayRender()){renderer.setAnimationLoop(null);return;}if(pendingMove){applyMove(pendingMove);pendingMove=null;}if(controls.enabled)controls.update();renderer.render(scene,camera);};setActive(true);
 el('appearance').onclick=()=>changeView('appearance');el('anatomy').onclick=()=>changeView('anatomy');
 for(const k of ['skin','hair','eyes','muscles','labels'])el(k).onchange=()=>{setTool('rotate');settings[k]=el(k).checked;layers();modified();};
 for(const k of ['skinColor','hairColor','eyeColor'])el(k).oninput=()=>{settings[k]=el(k).value;layers();modified();};
 el('opacity').oninput=()=>{settings.opacity=Number(el('opacity').value)/100;layers();modified();};
 el('target').onchange=()=>{setTool('rotate');chooseTarget(el('target').value);};
 el('reset-view').onclick=()=>{setTool('rotate');settings=defaults();showOriginal=false;display();layers();front();modified();say('Câmera, cores e camadas restauradas. Forma e anotações mantidas.');};
 el('mark').onclick=()=>setTool(tool==='mark'?'rotate':'mark');
 el('sculpt').onclick=()=>{if(settings.view!=='appearance'||!settings.skin)return;target='skin';chooseTarget('skin');setTool(tool==='sculpt'?'rotate':'sculpt');};
 el('radius').oninput=()=>{const n=Number(el('radius').value);el('radius-value').textContent=n<25?'Pequena':n<45?'Média':'Ampla';};
 el('undo-shape').onclick=()=>{finish();if(!history.length)return;working=history.pop();shapeDirty=working.some((v,i)=>Math.abs(v-original[i])>1e-7);display();state();modified();};
 el('compare').onclick=()=>{setTool('rotate');showOriginal=!showOriginal;display();state();};
 el('restore').onclick=()=>{if(!confirm('Restaurar a forma original? Os pontos e suas observações serão mantidos.'))return;setTool('rotate');working=original.slice();history.length=0;shapeDirty=false;showOriginal=false;display();state();modified();};
 el('left').onclick=()=>rotate(-Math.PI/6);el('right').onclick=()=>rotate(Math.PI/6);el('up').onclick=()=>rotate(0,-Math.PI/12);el('down').onclick=()=>rotate(0,Math.PI/12);el('front').onclick=front;el('plus').onclick=()=>zoom(.85);el('minus').onclick=()=>zoom(1/.85);
 el('save').onclick=exportStudy;el('import').onclick=()=>el('study-file').click();el('study-file').onchange=async()=>{await importStudy(el('study-file').files[0]);el('study-file').value='';};
 const dom=renderer.domElement;dom.addEventListener('contextmenu',e=>e.preventDefault());
 dom.addEventListener('pointerdown',e=>{
  if(contextLost)return;const accepted=gesture.down(e);if(gesture.multi){finish(true);return;}if(!accepted)return;
  if(tool!=='rotate')dom.setPointerCapture(e.pointerId);
  if(tool!=='sculpt'||showOriginal||!visible(models.get('skin')))return;
  aim(e);const hit=ray.intersectObject(head,false)[0];if(!hit)return;
  const ns=head.geometry.attributes.normal,ps=head.geometry.attributes.position,vertices=[hit.face.a,hit.face.b,hit.face.c];
  const tri=new THREE.Triangle(...vertices.map(i=>new THREE.Vector3().fromBufferAttribute(ps,i))),bary=tri.getBarycoord(hit.point,new THREE.Vector3());if(!bary)return;
  const n=new THREE.Vector3();vertices.forEach((v,j)=>n.addScaledVector(new THREE.Vector3().fromBufferAttribute(ns,v),bary.getComponent(j)));n.normalize();
  stroke={id:e.pointerId,before:working.slice(),hit:hit.point.clone(),plane:new THREE.Plane().setFromNormalAndCoplanarPoint(camera.getWorldDirection(new THREE.Vector3()),hit.point),chosen:selection(working,ns.array,hit.point.toArray(),n.toArray(),Number(el('radius').value)/100),changed:false};
 });
 dom.addEventListener('pointermove',e=>{gesture.move(e);if(stroke?.id===e.pointerId&&!gesture.multi)pendingMove={clientX:e.clientX,clientY:e.clientY};});
 dom.addEventListener('pointercancel',e=>{gesture.cancel(e);finish(true);});
 dom.addEventListener('lostpointercapture',e=>{const interrupted=gesture.active.has(e.pointerId);gesture.cancel(e);if(stroke?.id===e.pointerId)finish(true);if(interrupted){gesture.clear();resetControlsAfterLostPointer();}});
 dom.addEventListener('pointerup',e=>{
  const tap=gesture.up(e);if(stroke?.id===e.pointerId){pendingMove={clientX:e.clientX,clientY:e.clientY};finish();}
  if(!tap||showOriginal||contextLost)return;
  if(tool==='rotate'&&settings.view==='anatomy'){aim(e);identifyMuscle();return;}
  if(tool!=='mark'||!target)return;
  if(points.length>=100){say('Limite de 100 pontos por estudo.');return;}
  const m=models.get(target);if(!visible(m))return;aim(e);
  // Only active visible mesh is eligible; transparent skin cannot steal muscle clicks.
  const hit=hitActive(m);if(!hit){say('Toque na estrutura ativa: '+m.name);return;}
  const pos=m.mesh.geometry.attributes.position,vertices=[hit.face.a,hit.face.b,hit.face.c],tri=new THREE.Triangle(...vertices.map(i=>new THREE.Vector3().fromBufferAttribute(pos,i))),bary=tri.getBarycoord(hit.point,new THREE.Vector3());if(!bary)return;
  if(nextId>100000)nextId=1;while(points.some(p=>p.id===nextId))nextId++;
  const id=nextId++,dot=makeDot(id),p={id,model:target,triangle:hit.faceIndex,bary:bary.toArray(),side:hit.face.normal.dot(ray.ray.direction)>0?-1:1,name:'',note:'',dot};points.push(p);scene.add(dot);selected=id;updatePoints();listPoints();modified();el('name-'+id)?.focus({preventScroll:true});say('Ponto '+id+' marcado em '+m.name+'. Preencha nome e observações.');
 });
 window.addEventListener('keydown',e=>{if(e.key==='Escape'){finish(true);setTool('rotate');}});
 window.addEventListener('blur',()=>{const active=gesture.active.size;gesture.clear();finish(true);if(active)resetControlsAfterLostPointer();});
 window.addEventListener('beforeunload',e=>{if(!disposed&&(changed||points.length||shapeDirty)){e.preventDefault();e.returnValue='';}});
 dom.addEventListener('webglcontextlost',e=>{if(disposed)return;e.preventDefault();contextLost=true;finish(true);gesture.clear();renderer.setAnimationLoop(null);for(const control of document.querySelectorAll('button,input,select'))control.disabled=true;el('save').disabled=false;el('loading').hidden=false;el('loading').textContent='Visualização interrompida. Exporte o estudo antes de recarregar.';say('Os dados continuam na memória. Use Exportar estudo para guardá-los.');});
}catch(error){if(!disposed){failed=true;setActive(false);el('loading').hidden=false;el('loading').textContent='Não foi possível carregar o estúdio. Confira a conexão e use Abrir / tentar novamente no Fichas.';el('loading').setAttribute('role','alert');say('Falha ao abrir o 3D; nenhum dado foi enviado.');console.error(error);}}

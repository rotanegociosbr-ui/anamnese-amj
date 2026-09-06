import {emptyStudy,validateStudy,pointPosition,replacePoint} from './study.mjs';
export function annotations({THREE,scene,models,registry,getMode,render,host}){
 let doc=emptyStudy(),baseline=JSON.stringify(doc),selected='',tool='rotate',version=0,busy=false,contextNonce=0;
 const group=new THREE.Group();scene.add(group);
 const section=document.createElement('section');section.className='point-editor';
 section.innerHTML='<h2>Pontos e observações</h2><p id="point-context" class="small">Estudo livre. Abra uma consulta no app para salvar no prontuário.</p><div class="point-tools"><button data-tool="rotate" aria-pressed="true">Girar</button><button data-tool="mark" aria-pressed="false">Marcar ponto</button><button data-tool="move" aria-pressed="false">Mover ponto</button></div><p class="small">Em Marcar ponto, toque na superfície desejada. Cada base tem suas próprias marcações.</p><label class="stack">Pontos deste estudo<select id="point-list"><option value="">Nenhum ponto</option></select></label><label class="stack">Nome do ponto<input id="point-name" maxlength="100" placeholder="Ex.: observação da avaliação"></label><label class="stack">Observações do ponto<textarea id="point-notes" maxlength="2000" rows="3"></textarea></label><button id="point-delete">Excluir ponto selecionado</button><label class="stack">Observações gerais<textarea id="study-notes" maxlength="4000" rows="3"></textarea></label><button id="study-save" class="primary" disabled>Salvar no prontuário</button><p id="point-status" role="status" class="small">Sem alterações.</p>';
 document.querySelector('aside').prepend(section);const $=id=>section.querySelector('#'+id);
 function status(msg){$('point-status').textContent=msg;}
 function changed(){return JSON.stringify(doc)!==baseline;}
 function clearMarkers(){for(const obj of [...group.children]){obj.geometry?.dispose();if(obj.material){obj.material.map?.dispose();obj.material.dispose();}group.remove(obj);}}
 function redraw(){clearMarkers();doc.points.forEach((p,i)=>{const model=models.find(m=>m.name===p.meshId);if(!model||!model.visible||p.mode!==getMode())return;
  const pos=pointPosition(p,model.userData),g=model.geometry,index=g.index.array,points=[0,1,2].map(c=>new THREE.Vector3().fromBufferAttribute(g.attributes.position,index[p.triangle*3+c]));
  const normal=new THREE.Vector3().crossVectors(points[1].clone().sub(points[0]),points[2].clone().sub(points[0])).normalize();
  const ball=new THREE.Mesh(new THREE.SphereGeometry(.026,14,10),new THREE.MeshStandardMaterial({color:p.id===selected?'#33261D':'#B18431',roughness:.55}));ball.position.fromArray(pos).addScaledVector(normal,.022);ball.userData.pointId=p.id;group.add(ball);
  const canvas=document.createElement('canvas');canvas.width=64;canvas.height=64;const c=canvas.getContext('2d');c.fillStyle=p.id===selected?'#33261D':'#8B6420';c.beginPath();c.arc(32,32,27,0,Math.PI*2);c.fill();c.font='bold 30px sans-serif';c.textAlign='center';c.textBaseline='middle';c.fillStyle='#FFFFFF';c.fillText(String(i+1),32,33);
  const map=new THREE.CanvasTexture(canvas);map.colorSpace=THREE.SRGBColorSpace;const sprite=new THREE.Sprite(new THREE.SpriteMaterial({map,depthTest:true}));sprite.position.copy(ball.position).add(new THREE.Vector3(.045,.055,0));sprite.scale.set(.10,.10,1);group.add(sprite);
 });render();}
 function syncFields(){
  const select=$('point-list');select.replaceChildren();const blank=document.createElement('option');blank.value='';blank.textContent=doc.points.length?'Escolha um ponto':'Nenhum ponto';select.append(blank);
  doc.points.forEach((p,i)=>{const option=document.createElement('option');option.value=p.id;option.textContent=(i+1)+'. '+p.label+' · '+(p.mode==='appearance'?'rosto':'atlas');select.append(option);});select.value=selected;
  const p=doc.points.find(p=>p.id===selected);$('point-name').value=p?.label||'';$('point-notes').value=p?.notes||'';$('study-notes').value=doc.notes;
  for(const id of ['point-name','point-notes','point-delete'])$(id).disabled=busy||!p;
  for(const b of section.querySelectorAll('[data-tool]')){b.disabled=busy;b.setAttribute('aria-pressed',String(b.dataset.tool===tool));}
  $('study-save').disabled=busy||!host()||!section.dataset.bound;$('study-notes').disabled=busy;$('point-list').disabled=busy;redraw();
 }
 function dirty(){status('Alterações não salvas no prontuário.');}
 for(const b of section.querySelectorAll('[data-tool]'))b.onclick=()=>{if(b.dataset.tool==='move'&&!selected){status('Selecione primeiro o ponto que deseja mover.');return;}tool=b.dataset.tool;syncFields();};
 $('point-list').onchange=()=>{selected=$('point-list').value;syncFields();};
 $('point-name').oninput=()=>{if(selected){doc=replacePoint(doc,selected,{label:$('point-name').value});const o=[...$('point-list').options].find(o=>o.value===selected);if(o)o.textContent=$('point-name').value;dirty();}};
 $('point-notes').oninput=()=>{if(selected){doc=replacePoint(doc,selected,{notes:$('point-notes').value});dirty();}};
 $('study-notes').oninput=()=>{doc={...doc,notes:$('study-notes').value};dirty();};
 $('point-delete').onclick=()=>{if(!selected||!confirm('Excluir este ponto do estudo? A alteração só será gravada após salvar com sua senha.'))return;doc={...doc,points:doc.points.filter(p=>p.id!==selected)};selected='';tool='rotate';syncFields();dirty();};
 $('study-save').onclick=async()=>{let snapshot;try{snapshot=validateStudy(doc,registry);}catch(e){status(e.message);return;}
  if(!changed()){status('Este estudo já está salvo.');return;}const parent=host();if(!parent)return;const nonce=contextNonce;busy=true;syncFields();status('Confirme sua senha para salvar nesta consulta…');
  try{const result=await parent.saveStudy(window,snapshot,version);if(nonce!==contextNonce)return;version=result.version;baseline=JSON.stringify(snapshot);doc=snapshot;status('Salvo no prontuário · versão '+version+'.');}
  catch(e){if(nonce===contextNonce)status(e.message||'Não foi salvo. Tente novamente.');}finally{if(nonce===contextNonce){busy=false;syncFields();}}
 };
 function tap(ray){if(busy)return true;
  const marker=ray.intersectObjects(group.children.filter(obj=>obj.userData.pointId),false)[0];
  const front=ray.intersectObjects(models.filter(m=>m.visible&&(m.userData.layer!=='surface'||!m.material.transparent)))[0];
  if(marker&&(!front||marker.distance<=front.distance+.09)){selected=marker.object.userData.pointId;syncFields();return true;}
  if(tool==='rotate')return false;
  if(tool==='move'&&!selected){status('Selecione um ponto para mover.');return true;}
  const visibleMeshes=models.filter(m=>m.visible&&(m.userData.layer!=='surface'||!m.material.transparent||m.material.opacity>=.8||models.every(n=>!n.visible||!['muscles','arteries','nerves'].includes(n.userData.layer))));
  const hit=ray.intersectObjects(visibleMeshes)[0];if(!hit||!registry[hit.object.name]){status('Toque na pele ou em uma estrutura anatômica visível.');return true;}
  const g=hit.object.geometry,idx=g.index.array,t=hit.faceIndex,vertices=[0,1,2].map(c=>new THREE.Vector3().fromBufferAttribute(g.attributes.position,idx[t*3+c]));
  const bary=THREE.Triangle.getBarycoord(hit.point,vertices[0],vertices[1],vertices[2],new THREE.Vector3());if(!bary)return true;
  const anchor={mode:getMode(),meshId:hit.object.name,triangle:t,barycentric:bary.toArray()};
  if(tool==='move'){doc=replacePoint(doc,selected,anchor);tool='rotate';}else{if(doc.points.length>=200){status('Limite de 200 pontos por estudo.');return true;}const p={...anchor,id:crypto.randomUUID(),label:'Ponto '+(doc.points.length+1),notes:''};doc={...doc,points:[...doc.points,p]};selected=p.id;}
  syncFields();dirty();$('point-name').focus();return true;
 }
 syncFields();
 return {tap,refresh:redraw,hasChanges:changed,isBusy:()=>busy,getStudy:()=>validateStudy(doc,registry),
  loadStudy(study,label){contextNonce++;doc=study?validateStudy(study.document,registry):emptyStudy();baseline=JSON.stringify(doc);selected='';version=study?.version||0;busy=false;section.dataset.bound='true';$('point-context').textContent=label;tool='rotate';syncFields();status(study?'Estudo carregado · versão '+version+'.':'Consulta vinculada. Marque os pontos e salve.');},
  unbind(){contextNonce++;delete section.dataset.bound;doc=emptyStudy();baseline=JSON.stringify(doc);selected='';busy=false;syncFields();},
  dispose(){contextNonce++;doc=emptyStudy();baseline='';clearMarkers();scene.remove(group);section.remove();}
 };
}

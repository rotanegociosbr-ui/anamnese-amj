// Portable local study. No patient identification, external calls or browser storage.
export const FORMAT='amj-3d-study', VERSION=3;
export const defaults=()=>({view:'appearance',skin:true,hair:true,eyes:true,muscles:true,skinColor:'#E9D9C8',hairColor:'#33251F',eyeColor:'#755338',opacity:1,labels:true});
const fail=message=>{throw Error(message);};
const finiteArray=(a,n)=>Array.isArray(a)&&a.length===n&&a.every(Number.isFinite);
export function validateStudy(data,models,original){
  if(!data||data.format!==FORMAT||data.version!==VERSION)fail('Formato de estudo incompatível.');
  if(data.base!=='makehuman-amj-v1')fail('Modelo-base diferente.');
  if(!finiteArray(data.shape,original.length))fail('Geometria incompleta ou inválida.');
  for(let i=0;i<original.length;i+=3)if(Math.hypot(...[0,1,2].map(j=>data.shape[i+j]-original[i+j]))>.20001)fail('Deformação fora do limite ilustrativo.');
  const settings=data.settings;if(!settings||!['appearance','anatomy'].includes(settings.view))fail('Visualização inválida.');
  for(const key of ['skin','hair','eyes','muscles','labels'])if(typeof settings[key]!=='boolean')fail('Visibilidade inválida.');
  for(const key of ['skinColor','hairColor','eyeColor'])if(typeof settings[key]!=='string'||!/^#[0-9a-f]{6}$/i.test(settings[key]))fail('Cor inválida.');
  if(!Number.isFinite(settings.opacity)||settings.opacity<.1||settings.opacity>1)fail('Transparência inválida.');
  if(!Array.isArray(data.points)||data.points.length>100)fail('Lista de pontos inválida.');
  const ids=new Set(),points=[];
  for(const p of data.points){
    const model=models.get(p.model);
    if(!model||!Number.isSafeInteger(p.id)||p.id<1||p.id>100000||ids.has(p.id))fail('Identificador de ponto/modelo inválido.');
    ids.add(p.id);
    if(!Number.isInteger(p.triangle)||p.triangle<0||p.triangle>=model.triangles)fail('Triângulo de origem inválido.');
    if(!finiteArray(p.bary,3)||p.bary.some(v=>v<-.00001||v>1.00001)||Math.abs(p.bary.reduce((a,b)=>a+b,0)-1)>.00001)fail('Posição de ponto inválida.');
    if(![-1,1].includes(p.side)||typeof p.name!=='string'||p.name.length>80||typeof p.note!=='string'||p.note.length>1000)fail('Anotação inválida.');
    points.push({id:p.id,model:p.model,triangle:p.triangle,bary:[...p.bary],side:p.side,name:p.name,note:p.note});
  }
  return {format:FORMAT,version:VERSION,base:data.base,shape:[...data.shape],settings:Object.fromEntries(Object.keys(defaults()).map(k=>[k,settings[k]])),points};
}
export function markerPosition(positions,indices,triangle,bary){
  const out=[0,0,0];
  for(let v=0;v<3;v++)for(let axis=0;axis<3;axis++)out[axis]+=positions[indices[triangle*3+v]*3+axis]*bary[v];
  return out;
}
export function layerVisible(layer,settings){return settings.view==='anatomy'?layer==='muscles'&&settings.muscles:layer!=='muscles'&&settings[layer]===true;}

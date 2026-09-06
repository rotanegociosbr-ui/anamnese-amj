export const MODEL_VERSION='amj-facial-20260906-v2';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const plain=v=>v&&typeof v==='object'&&!Array.isArray(v);
function text(v,max){if(typeof v!=='string'||v.length>max||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v))throw Error('Texto inválido ou muito longo.');return v.trim();}
export function validateStudy(value,registry){
 if(!plain(value)||value.schemaVersion!==1||value.modelVersion!==MODEL_VERSION||!Array.isArray(value.points)||value.points.length>200)throw Error('Estudo incompatível com esta versão do modelo.');
 const ids=new Set();
 const points=value.points.map(p=>{
  if(!plain(p)||typeof p.id!=='string'||!uuid.test(p.id)||ids.has(p.id))throw Error('Identificador de ponto inválido ou repetido.');ids.add(p.id);
  if(typeof p.meshId!=='string'||!Object.hasOwn(registry,p.meshId)||!['appearance','anatomy'].includes(p.mode))throw Error('Superfície inválida.');
  const mesh=registry[p.meshId];
  if(!mesh||mesh.mode!==p.mode||!Number.isInteger(p.triangle)||p.triangle<0||p.triangle>=mesh.triangles)throw Error('Superfície do ponto incompatível.');
  if(!Array.isArray(p.barycentric)||p.barycentric.length!==3||!p.barycentric.every(n=>typeof n==='number'&&Number.isFinite(n)&&n>=-1e-6&&n<=1.000001)||Math.abs(p.barycentric.reduce((a,b)=>a+b,0)-1)>1e-5)throw Error('Coordenadas do ponto inválidas.');
  const label=text(p.label,100);if(!label)throw Error('Escreva o nome do ponto.');
  return {id:p.id,mode:p.mode,meshId:p.meshId,triangle:p.triangle,barycentric:[...p.barycentric],label,notes:text(p.notes,2000)};
 });
 return {schemaVersion:1,modelVersion:MODEL_VERSION,points,notes:text(value.notes,4000)};
}
export const emptyStudy=()=>({schemaVersion:1,modelVersion:MODEL_VERSION,points:[],notes:''});
export function pointPosition(p,mesh){const out=[0,0,0];for(let c=0;c<3;c++){const i=mesh.indices[p.triangle*3+c]*3;for(let d=0;d<3;d++)out[d]+=mesh.positions[i+d]*p.barycentric[c];}return out;}
export function replacePoint(doc,id,patch){if(!doc.points.some(p=>p.id===id))throw Error('Ponto não encontrado.');return {...doc,points:doc.points.map(p=>p.id===id?{...p,...patch,id}:p)};}

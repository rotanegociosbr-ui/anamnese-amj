// Manual, unitless geometric illustration. No patient prediction or clinical rules.
export function selection(positions,normals,center,normal,radius){
  if(!Number.isFinite(radius)||radius<=0)throw Error('Raio inválido');
  if(positions.length%3||positions.length!==normals.length||center.length!==3||normal.length!==3||![...center,...normal].every(Number.isFinite))throw Error('Seleção inválida');
  const out=[];
  for(let i=0;i<positions.length;i+=3){
    const d=Math.hypot(positions[i]-center[0],positions[i+1]-center[1],positions[i+2]-center[2]);
    const facing=normals[i]*normal[0]+normals[i+1]*normal[1]+normals[i+2]*normal[2];
    if(d<radius&&facing>.15){const t=1-d/radius;out.push([i,t*t*(3-2*t)]);}
  }
  return out;
}
export function deform(start,original,chosen,delta,maxStep=.12,maxTotal=.2){
  if(start.length%3||start.length!==original.length||delta.length!==3||![...delta,maxStep,maxTotal].every(Number.isFinite)||maxStep<=0||maxTotal<=0)throw Error('Deslocamento inválido');
  const out=start.slice(),length=Math.hypot(...delta),step=length>maxStep?maxStep/length:1;
  for(const [i,w]of chosen){
    if(!Number.isInteger(i)||i<0||i%3||i+2>=start.length||!Number.isFinite(w)||w<0||w>1)throw Error('Vértice/peso inválido');
    let v=[0,1,2].map(j=>start[i+j]+delta[j]*step*w-original[i+j]);
    const total=Math.hypot(...v);if(total>maxTotal)v=v.map(x=>x*maxTotal/total);
    for(let j=0;j<3;j++)out[i+j]=original[i+j]+v[j];
  }
  return out;
}

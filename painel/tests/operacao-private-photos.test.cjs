'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.resolve(__dirname,'../operacao.js'),'utf8');
function runtime(){
 const sandbox={window:{__AMJ_TEST__:true,crypto:{randomUUID:()=> 'synthetic-intent'}},document:{addEventListener(){},getElementById(){return null;}},Intl,Date,console};
 vm.runInNewContext(source.replace('photoCategoryCounts: photoCategoryCounts','photoCategoryCounts: photoCategoryCounts,state,renderAttendanceGallery,updatePhotoShortcut,loadedPhotoAttendances'),sandbox);
 const ui=sandbox.window.AMJOperacaoClinica.__test;
 const visit={id:'visit-synthetic',protocol_id:'protocol-synthetic',patient_id:'patient-synthetic',version:1};
 ui.state.data.atendimentos=[visit];ui.state.data.protocolos=[{id:visit.protocol_id,status:'draft'}];
 ui.state.data.resumos_prontuario_atendimento=[{attendance_id:visit.id,clinical_photography_consented:false,active_clinical_count:0}];
 ui.loadedPhotoAttendances.set(visit.id,Date.now());return {ui,visit};
}
test('active private gallery exposes upload without inventing photographic consent',()=>{
 const {ui,visit}=runtime(),before=JSON.stringify(ui.state.data);
 const html=ui.renderAttendanceGallery(visit,[],false);
 assert.match(html,/data-form-foto-upload/);assert.match(html,/data-protocolo-id="protocol-synthetic"/);
 assert.match(html,/Arquivo clínico privado — publicação exige autorização específica/);
 assert.doesNotMatch(html,/Autorização pendente|registrar autorização|Registre a autorização/);
 assert.equal(JSON.stringify(ui.state.data),before,'render must never create or modify consent');
});
test('archived or missing protocol never offers private upload',()=>{
 const {ui,visit}=runtime();assert.doesNotMatch(ui.renderAttendanceGallery(visit,[],true),/data-form-foto-upload/);
 ui.state.data.protocolos[0].archived_at='2026-09-06T00:00:00Z';assert.doesNotMatch(ui.renderAttendanceGallery(visit,[],false),/data-form-foto-upload/);
 ui.state.data.protocolos=[];assert.doesNotMatch(ui.renderAttendanceGallery(visit,[],false),/data-form-foto-upload/);
});
test('private shortcut proceeds to photos with current context, not a consent checkbox',()=>{
 const {ui,visit}=runtime(),nodes=new Map();
 for(const key of ['atendimento','etapa','orientacao','abrir'])nodes.set('[data-fotos-atalho-'+key+']',{value:key==='atendimento'?visit.id:'',textContent:'',classList:{add(){},remove(){}}});
 ui.state.root={querySelector:key=>nodes.get(key)||null};ui.updatePhotoShortcut();
 assert.equal(nodes.get('[data-fotos-atalho-abrir]').textContent,'Adicionar ou tirar fotos');assert.equal(nodes.get('[data-fotos-atalho-abrir]').disabled,false);
 assert.match(nodes.get('[data-fotos-atalho-orientacao]').textContent,/publicação exige autorização específica/);
 const flow=source.slice(source.indexOf('async function openPhotoShortcutFlow('),source.indexOf('async function openAttendancePhotos('));
 assert.match(flow,/if \(!ownerAccess\(\)\)/);assert.match(flow,/if \(!protocol\)/);assert.match(flow,/protocol\.archived_at/);assert.match(flow,/openAttendancePhotos\(attendanceId\)/);assert.doesNotMatch(flow,/clinical_photography_consented/);
});
test('photo lots read partial draft pairs from the same protocol before legacy rows',()=>{
 const load=source.slice(source.indexOf('async function loadProtocolProducts('),source.indexOf('async function loadAttendancePhotos('));
 assert.match(load,/protocolo_id: id/);assert.match(load,/Array\.isArray\(protocol\.produtos_rascunho\) \? protocol\.produtos_rascunho/);
 assert(load.indexOf('protocol.produtos_rascunho')<load.indexOf('Array.isArray(protocol.produtos)'));
 assert.match(source,/Boolean\(productId\) !== Boolean\(lot\)/);
});

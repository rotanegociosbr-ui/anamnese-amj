// Offline: real RPC + real auth/audit helpers + real trigger over minimal synthetic tables.
// No network. Does not model the complete schema or simultaneous sessions.
// node supabase/tests/operacao_reactivation_version_local_test.mjs <existing-pglite-package>
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
const require=createRequire(import.meta.url), {PGlite}=require(resolve(process.argv[2]));
const db=new PGlite();
const migration=name=>readFile(new URL('../migrations/'+name,import.meta.url),'utf8');
function extract(source,name){
 const start=source.search(new RegExp('create (?:or replace )?function '+name.replaceAll('.','\\.')+'\\('));
 assert(start>=0,'Missing '+name);const body=source.slice(start),match=/as\s+(\$[a-z_]*\$)/i.exec(body);
 assert(match);const end=body.indexOf(match[1]+';',match.index+match[0].length);return body.slice(0,end+match[1].length+1);
}
const sqlError=code=>error=>error.code===code;
try{
 await db.exec(`
 create role anon; create role authenticated; create role service_role bypassrls;
 create schema private;create schema auth;
 create table clinic_members(clinic_id uuid,user_id uuid,role text,status text);
 create table patients(id uuid primary key,clinic_id uuid,full_name text,created_by uuid,dedup_exact_key text,archived_at timestamptz);
 create table agendamentos_clinica(id uuid primary key);
 create table patient_source_links(clinic_id uuid,patient_id uuid,source_kind text,source_id uuid,status text);
 create table protocols(id uuid primary key,clinic_id uuid,patient_id uuid,archived_at timestamptz);
 create table financeiro_lancamentos(id uuid primary key,clinic_id uuid,patient_id uuid,entry_type text,state text);
 create table atendimentos_realizados(id uuid primary key default gen_random_uuid(),clinic_id uuid,patient_id uuid,appointment_id uuid,protocol_id uuid,
 financial_entry_id uuid,procedure_kind text,attended_at timestamptz,duration_minutes smallint,status text,responsible_user_id uuid,
 idempotency_key uuid,payload_fingerprint text,version integer default 1,archived_at timestamptz,created_by uuid,updated_by uuid,
 created_at timestamptz default now(),updated_at timestamptz default now());
 create table atendimento_procedimentos(id uuid primary key,clinic_id uuid,attendance_id uuid,financial_entry_id uuid,procedure_kind text,
 performed_at timestamptz,is_primary boolean,created_by uuid,idempotency_key uuid,payload_fingerprint text,archived_at timestamptz,
 version integer default 1,created_at timestamptz default now(),updated_at timestamptz default now(),updated_by uuid);
 create table acompanhamento_planos(id uuid primary key,clinic_id uuid,patient_id uuid,attendance_id uuid,plan_kind text,anchor_date date,
 status text,version integer,invalidated_by_attendance_id uuid,invalidated_at timestamptz,invalidation_reason text,updated_at timestamptz);
 create table retorno_recomendacoes(id uuid primary key,clinic_id uuid,attendance_id uuid,plan_id uuid,status text,version integer,
 cancelled_by uuid,cancelled_at timestamptz,cancellation_reason text,updated_at timestamptz);
 create table retorno_fila(id uuid primary key,clinic_id uuid,recommendation_id uuid,status text,next_action text,next_action_at timestamptz,
 closure_reason text,version integer,updated_by uuid,updated_at timestamptz);
 create table operacao_consumo_eventos(clinic_id uuid,attendance_id uuid);
 create table financeiro_estoque_movimentos(clinic_id uuid,protocol_id uuid);
 create table atendimento_pagamento_taxas(clinic_id uuid,attendance_id uuid);
 create table clinic_audit_log(id uuid default gen_random_uuid(),clinic_id uuid,actor uuid,entity text,entity_id uuid,action text,details jsonb,
 actor_role text,auth_method text,outcome text,request_id uuid,unique(clinic_id,request_id));
 grant usage on schema public,private to service_role;grant select on all tables in schema public to service_role;
 `);
 const base=await migration('20260824035000_atendimentos_retornos_rentabilidade.sql');
 const clinical=await migration('20260824010000_prontuario_fotos_produtos_seguros.sql');
 const phase2=await migration('20260826085707_fase2_acompanhamentos_operacionais.sql');
 for(const name of ['private.prontuario_assert_actor','private.prontuario_log_event'])await db.exec(extract(clinical,name));
 for(const name of ['private.operacao_assert_owner','private.operacao_log','private.operacao_replay_guard','public.operacao_salvar_atendimento'])await db.exec(extract(base,name));
 await db.exec(extract(phase2,'private.fase2_invalidate_reactivation'));
 await db.exec(`create trigger atendimentos_realizados_invalidate_reactivation after insert or update of patient_id,attended_at,status,archived_at
 on public.atendimentos_realizados for each row execute function private.fase2_invalidate_reactivation();
 revoke all on function private.fase2_invalidate_reactivation() from public,anon,authenticated,service_role;
 revoke all on function public.operacao_salvar_atendimento(uuid,uuid,text,text,text,uuid,integer,uuid,uuid,uuid,uuid,text,timestamptz,smallint,text,uuid,uuid,uuid) from public,anon,authenticated;
 grant execute on function public.operacao_salvar_atendimento(uuid,uuid,text,text,text,uuid,integer,uuid,uuid,uuid,uuid,text,timestamptz,smallint,text,uuid,uuid,uuid) to service_role;`);
 const c=randomUUID(),u=randomUUID(),p=randomUUID(),key=randomUUID(),protocol=randomUUID(),appointment=randomUUID(),entry=randomUUID();
 await db.query("insert into clinic_members values($1,$2,'owner','active')",[c,u]);
 await db.query("insert into patients(id,clinic_id,full_name)values($1,$2,'Synthetic offline')",[p,c]);
 await db.query('insert into protocols values($1,$2,$3,null)',[protocol,c,p]);
 await db.query('insert into agendamentos_clinica values($1)',[appointment]);
 await db.query("insert into patient_source_links values($1,$2,'agendamento',$3,'confirmado')",[c,p,appointment]);
 await db.query("insert into financeiro_lancamentos values($1,$2,$3,'receita','ativo')",[entry,c,p]);
 const at=new Date(Date.now()-3600000).toISOString();
 const save=async({id=null,version=null,status='realizado',request=randomUUID(),aal='aal2',protocolId=protocol,patientId=p,clinicId=c,appointmentId=appointment,entryId=entry}={})=>(await db.query(
  `select public.operacao_salvar_atendimento($1,$2,'owner','supabase_auth',$3,$4,$5,$6,$7,$8,$9,'Teste sintético',$10::timestamptz,30::smallint,$11,$2,$12,$13) as result`,
  [clinicId,u,aal,id,version,patientId,appointmentId,protocolId,entryId,at,status,key,request])).rows[0].result;
 await db.exec('set role service_role');
 await assert.rejects(save(),e=>e.code==='42702'&&/version/.test(e.message));
 assert.equal((await db.query('select count(*)::int as n from atendimentos_realizados')).rows[0].n,0);
 const initial=await save({status:'interrompido'});
 await assert.rejects(save({id:initial.id,version:1}),sqlError('42702'));
 assert.equal((await db.query('select version,status from atendimentos_realizados')).rows[0].version,1);
 console.log('RED confirmed: real RPC create/update fail 42702; interrupted attendance and version remain intact');
 await db.exec('reset role');
 const original=extract(phase2,'private.fase2_invalidate_reactivation');
 const fix=await migration('20260906233239_operacao_reactivation_version_qualification_fix.sql');
 const fixed=extract(fix,'private.fase2_invalidate_reactivation');
 assert.equal(fixed,original.replace('version = version + 1, updated_by = new.updated_by','version = queue.version + 1, updated_by = new.updated_by')
  .replace('version = version + 1, updated_at = pg_catalog.now()','version = recommendation.version + 1, updated_at = pg_catalog.now()'));
 await db.exec(fix);
 assert.equal((await db.query("select prosecdef from pg_proc where oid='private.fase2_invalidate_reactivation()'::regprocedure")).rows[0].prosecdef,false);
 for(const role of ['anon','authenticated','service_role'])assert.equal((await db.query("select has_function_privilege($1,'private.fase2_invalidate_reactivation()','EXECUTE') as allowed",[role])).rows[0].allowed,false);
 const plan=randomUUID(),recommendation=randomUUID(),queue=randomUUID();
 await db.query("insert into acompanhamento_planos(id,clinic_id,patient_id,attendance_id,plan_kind,anchor_date,status,version) values($1,$2,$3,$4,'reactivation',current_date-60,'active',7)",[plan,c,p,randomUUID()]);
 await db.query("insert into retorno_recomendacoes(id,clinic_id,attendance_id,plan_id,status,version)values($1,$2,$3,$4,'ativa',11)",[recommendation,c,randomUUID(),plan]);
 await db.query("insert into retorno_fila(id,clinic_id,recommendation_id,status,next_action,next_action_at,version)values($1,$2,$3,'pendente','contatar',now(),13)",[queue,c,recommendation]);
 for(const [clinic,patient,kind] of [[c,randomUUID(),'reactivation'],[randomUUID(),p,'reactivation'],[c,p,'post_procedure']])
  await db.query("insert into acompanhamento_planos(id,clinic_id,patient_id,attendance_id,plan_kind,anchor_date,status,version)values($1,$2,$3,$4,$5,current_date-60,'active',29)",[randomUUID(),clinic,patient,randomUUID(),kind]);
 await db.exec('set role service_role');
 const request=randomUUID(),updated=await save({id:initial.id,version:1,request});
 assert.equal(updated.id,initial.id);assert.equal(updated.version,2);
 const replay=await save({id:initial.id,version:1,request});assert.equal(replay.idempotent,true);assert.equal(replay.version,2);
 const actual=(await db.query('select * from atendimentos_realizados where id=$1',[initial.id])).rows[0];
 assert.equal(actual.patient_id,p);assert.equal(actual.protocol_id,protocol);assert.equal(actual.appointment_id,appointment);assert.equal(actual.financial_entry_id,entry);
 assert.deepEqual((await db.query('select status,version from acompanhamento_planos where id=$1',[plan])).rows[0],{status:'invalidated',version:8});
 assert.deepEqual((await db.query('select status,version from retorno_recomendacoes where id=$1',[recommendation])).rows[0],{status:'cancelada',version:12});
 assert.deepEqual((await db.query('select status,version,next_action,next_action_at from retorno_fila where id=$1',[queue])).rows[0],{status:'cancelado',version:14,next_action:'nenhuma',next_action_at:null});
 assert.equal((await db.query("select count(*)::int as n from acompanhamento_planos where status='active' and version=29")).rows[0].n,3);
 await assert.rejects(save({id:initial.id,version:1}),sqlError('40001'));
 await assert.rejects(save({id:initial.id,version:2,aal:'aal1'}),sqlError('42501'));
 console.log('GREEN: real update/replay preserves all three links, correct target versions, tenant/patient/kind scope, stale-version and MFA guards, and ACLs');
 await db.exec('reset role');
 const result=await db.exec(await readFile(new URL('./operacao_reactivation_version_smoke.sql',import.meta.url),'utf8'));
 assert.deepEqual(result.at(-1).rows[0].smoke_result,{result:'PASS',synthetic_patients_remaining:0});
 console.log('PASS synthetic BEGIN/ROLLBACK smoke: create, update, retries and no residual patient');
 // Second regression: the same historical archived link must survive an unrelated update.
 await db.query('update protocols set archived_at=now() where id=$1',[protocol]);
 await db.exec('set role service_role');
 await assert.rejects(save({id:initial.id,version:2,status:'concluido'}),e=>e.code==='23514'&&e.message==='protocol_patient_mismatch');
 console.log('RED confirmed: unchanged archived protocol rejects unrelated attendance update');
 await db.exec('reset role');
 const rpcOid="'public.operacao_salvar_atendimento(uuid,uuid,text,text,text,uuid,integer,uuid,uuid,uuid,uuid,text,timestamptz,smallint,text,uuid,uuid,uuid)'::regprocedure";
 const previousDefinition=(await db.query('select pg_get_functiondef('+rpcOid+') as definition')).rows[0].definition;
 await db.exec(await migration('20260906234141_operacao_preserve_current_archived_protocol_link.sql'));
 const newDefinition=(await db.query('select pg_get_functiondef('+rpcOid+') as definition')).rows[0].definition;
 assert.equal(newDefinition.slice(newDefinition.indexOf('  if p_financial_entry_id is not null then')),previousDefinition.slice(previousDefinition.indexOf('  if p_financial_entry_id is not null then')),'The lock/version/update/audit/financial branch must remain byte-identical');
 const otherArchived=randomUUID(),otherPatient=randomUUID(),otherClinic=randomUUID();
 await db.query('insert into protocols values($1,$2,$3,now())',[otherArchived,c,p]);
 await db.query("insert into patients(id,clinic_id,full_name)values($1,$2,'Other synthetic offline')",[otherPatient,c]);
 await db.query("insert into clinic_members values($1,$2,'owner','active')",[otherClinic,u]);
 await db.exec('set role service_role');
 const archivedRequest=randomUUID(),retained=await save({id:initial.id,version:2,status:'concluido',request:archivedRequest});
 assert.equal(retained.id,initial.id);assert.equal(retained.version,3);
 assert.equal((await save({id:initial.id,version:2,status:'concluido',request:archivedRequest})).idempotent,true);
 for(const args of [{},{id:initial.id,version:3,protocolId:otherArchived},{id:initial.id,version:3,patientId:otherPatient}])
  await assert.rejects(save(args),e=>e.code==='23514'&&['protocol_patient_mismatch','appointment_patient_link_required'].includes(e.message));
 // A different tenant is rejected before any historical exception can be reached.
 await assert.rejects(save({id:initial.id,version:3,clinicId:otherClinic}),e=>e.code==='P0002'&&e.message==='patient_not_found');
 await assert.rejects(save({id:initial.id,version:2}),sqlError('40001'));
 const historical=(await db.query('select a.protocol_id,a.patient_id,a.appointment_id,a.financial_entry_id,p.archived_at from atendimentos_realizados a join protocols p on p.id=a.protocol_id where a.id=$1',[initial.id])).rows[0];
 assert.equal(historical.protocol_id,protocol);assert.equal(historical.patient_id,p);assert.equal(historical.appointment_id,appointment);assert.equal(historical.financial_entry_id,entry);assert(historical.archived_at);
 for(const role of ['anon','authenticated'])assert.equal((await db.query('select has_function_privilege($1,'+rpcOid+',\'EXECUTE\') as allowed',[role])).rows[0].allowed,false);
 console.log('GREEN: unchanged archived link retained; new/changed/cross-patient/cross-tenant links and stale versions denied; no restore or ACL change');
 await db.exec('reset role');
 await db.exec('alter table protocols add column professional_id uuid,add column procedure_kind text,add column procedure_date date,add column status text,add column archived_by uuid,add column archive_reason text,add column version int default 1,add column updated_by uuid,add column updated_at timestamptz;');
 await db.exec(extract(clinical,'private.prontuario_guard_protocol_mutation'));
 await db.exec('create trigger protocols_guard_mutation before update or delete on protocols for each row execute function private.prontuario_guard_protocol_mutation();');
 const archivedSmoke=await db.exec(await readFile(new URL('./operacao_archived_protocol_link_smoke.sql',import.meta.url),'utf8'));
 assert.deepEqual(archivedSmoke.at(-1).rows[0].smoke_result,{result:'PASS',synthetic_patients_remaining:0});
 console.log('PASS archived link synthetic BEGIN/ROLLBACK smoke and zero residual patients');
 // Third regression: editing an attendance must not reactivate or discard its cancelled revenue.
 await db.query("update financeiro_lancamentos set state='cancelado' where id=$1",[entry]);
 await db.query('insert into atendimento_pagamento_taxas values($1,$2)',[c,initial.id]);
 await db.exec('set role service_role');
 await assert.rejects(save({id:initial.id,version:3}),e=>e.code==='23514'&&e.message==='financial_entry_patient_mismatch');
 console.log('RED confirmed: unchanged cancelled revenue rejects unrelated attendance update');
 await db.exec('reset role');
 const beforeFinancial=(await db.query('select pg_get_functiondef('+rpcOid+') as definition')).rows[0].definition;
 await db.exec(await migration('20260906234851_operacao_preserve_current_cancelled_financial_link.sql'));
 const afterFinancial=(await db.query('select pg_get_functiondef('+rpcOid+') as definition')).rows[0].definition;
 assert.equal(afterFinancial.slice(afterFinancial.indexOf('  if v_is_create then')),beforeFinancial.slice(beforeFinancial.indexOf('  if v_is_create then')),'All locks, version, mutation, audit and replay logic stays byte-identical');
 const otherEntry=randomUUID(),foreignEntry=randomUUID(),expense=randomUUID();
 for(const [id,clinic,patient,kind] of [[otherEntry,c,p,'receita'],[foreignEntry,otherClinic,p,'receita'],[expense,c,p,'despesa']])
  await db.query("insert into financeiro_lancamentos values($1,$2,$3,$4,'cancelado')",[id,clinic,patient,kind]);
 await db.exec('set role service_role');
 const financialRequest=randomUUID(),savedFinancial=await save({id:initial.id,version:3,request:financialRequest});
 assert.equal(savedFinancial.version,4);
 assert.equal((await save({id:initial.id,version:3,request:financialRequest})).idempotent,true);
 for(const args of [{protocolId:null,appointmentId:null},{id:initial.id,version:4,entryId:otherEntry},{id:initial.id,version:4,entryId:foreignEntry},{id:initial.id,version:4,entryId:expense},{id:initial.id,version:4,patientId:otherPatient,protocolId:null,appointmentId:null}])
  await assert.rejects(save(args),e=>e.code==='23514'&&e.message==='financial_entry_patient_mismatch');
 await assert.rejects(save({id:initial.id,version:3}),sqlError('40001'));
 await assert.rejects(save({id:initial.id,version:4,entryId:null}),e=>e.code==='42501'&&e.message==='attendance_financial_locked_by_fee');
 const financialState=(await db.query('select a.financial_entry_id,a.version,e.state from atendimentos_realizados a join financeiro_lancamentos e on e.id=a.financial_entry_id where a.id=$1',[initial.id])).rows[0];
 assert.deepEqual(financialState,{financial_entry_id:entry,version:4,state:'cancelado'});
 for(const role of ['anon','authenticated'])assert.equal((await db.query('select has_function_privilege($1,'+rpcOid+',\'EXECUTE\') as allowed',[role])).rows[0].allowed,false);
 console.log('GREEN: current cancelled revenue retained without reactivation; different/new/cross-patient/cross-tenant/expense links denied, stale versions and fee lock retained');
 await db.exec('reset role');
 await db.exec('alter table financeiro_lancamentos add column origin text,add column description text,add column category text,add column competence_date date,add column due_date date,add column total_amount numeric,add column payment_condition text,add column idempotency_key uuid,add column created_by uuid,add column cancelled_by uuid,add column cancelled_at timestamptz,add column cancellation_reason text,add column updated_by uuid,add column version integer default 1;');
 const cancelledSmoke=await db.exec(await readFile(new URL('./operacao_cancelled_financial_link_smoke.sql',import.meta.url),'utf8'));
 assert.deepEqual(cancelledSmoke.at(-1).rows[0].smoke_result,{result:'PASS',synthetic_patients_remaining:0,synthetic_entries_remaining:0});
 console.log('PASS cancelled financial link synthetic BEGIN/ROLLBACK smoke and zero residual patients/entries');
}finally{await db.close();}

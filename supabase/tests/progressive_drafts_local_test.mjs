// Offline regression: actual migration/RPCs, synthetic schema and records only.
// node supabase/tests/progressive_drafts_local_test.mjs <existing-pglite-package-path>
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
const require=createRequire(import.meta.url);
const {PGlite}=require(resolve(process.argv[2]));
const db=new PGlite();
const migration=async n=>readFile(new URL('../migrations/'+n,import.meta.url),'utf8');
const sql=async(q,p=[])=>db.query(q,p);
const one=async(q,p=[]) => (await sql(q,p)).rows[0];
function extract(source,name) {
 const start=source.search(new RegExp('create (?:or replace )?function '+name.replaceAll('.','\\.')+'\\('));
 assert(start>=0,'Missing function '+name);
 const body=source.slice(start), match=/as\s+(\$[a-z_]*\$)/i.exec(body);
 assert(match,'Missing dollar quote '+name);
 const end=body.indexOf(match[1]+';',match.index+match[0].length);
 return body.slice(0,end+match[1].length+1);
}
const C=randomUUID(),U=randomUUID(),P=randomUUID(),OTHER=randomUUID();
let checks=0;
async function check(name,fn){await fn();console.log('PASS '+name);checks++;}
try {
 await db.exec(`
 create role anon; create role authenticated; create role service_role bypassrls;
 create schema private; create schema auth; create schema storage;
 create table clinics(id uuid primary key);
 create table auth.users(id uuid primary key);
 create table clinic_members(clinic_id uuid,user_id uuid,role text,status text);
 create table patients(id uuid primary key,clinic_id uuid,status text default 'active',archived_at timestamptz,full_name text,created_by uuid,dedup_exact_key text);
 create table agendamentos_clinica(id uuid primary key,clinic_id uuid);
 create table financeiro_marcas(id uuid primary key,clinic_id uuid,name text,active boolean default true,archived_at timestamptz);
 create table financeiro_produtos(
 id uuid primary key default gen_random_uuid(),clinic_id uuid not null,brand_id uuid,name text not null check(length(btrim(name)) between 2 and 160),
 product_type text not null,unit text not null,presentation text,ean text,reference_cost numeric,sale_price numeric,
 anvisa_registration text,stock_control boolean not null default false,active boolean not null default true,
 archived_at timestamptz,created_by uuid,updated_by uuid,created_at timestamptz default now(),updated_at timestamptz default now(),version int default 1,
 dedup_exact_key text not null,dedup_possible_key text,dedup_enforced boolean default true);
 create unique index product_exact on financeiro_produtos(clinic_id,dedup_exact_key) where dedup_enforced;
 create table clinic_duplicate_reviews(clinic_id uuid,entity_kind text,primary_id uuid,candidate_id uuid,match_kind text,match_key_hash text,reason_code text);
 create table financeiro_auditoria(clinic_id uuid,actor_id uuid,entity text,entity_id uuid,action text,details jsonb,request_id uuid);
 create table protocols(id uuid primary key default gen_random_uuid(),clinic_id uuid,patient_id uuid,professional_id uuid,appointment_id uuid,
 procedure_kind text not null,complaint text,anamnesis jsonb,technique_notes text,procedure_date date,return_date date,care_notes text,
 status text default 'draft',version int default 1,updated_by uuid,idempotency_key uuid,archived_at timestamptz,archive_reason text,archived_by uuid,
 created_at timestamptz default now(),updated_at timestamptz default now(),unique(clinic_id,idempotency_key),
 constraint protocols_procedure_kind_check check(procedure_kind is not null));
 create table clinic_audit_log(id uuid default gen_random_uuid(),clinic_id uuid,actor uuid,entity text,entity_id uuid,action text,details jsonb,
 actor_role text,auth_method text,outcome text,request_id uuid,unique(clinic_id,request_id));
 create table protocol_products(id uuid primary key default gen_random_uuid(),protocol_id uuid,product_id uuid,brand_id uuid,
 product_name_snapshot text,brand_name_snapshot text,anvisa_registration_snapshot text,lot text,expiry date,amount numeric,unit text,cost_snapshot numeric,position smallint);
 create table protocol_consents(id uuid primary key default gen_random_uuid(),protocol_id uuid,kind text,term_id uuid,accepted boolean,evidence jsonb,
 recorded_by uuid,supersedes_id uuid,recorded_at timestamptz default now(),revoked_at timestamptz);
 create table protocol_photos(id uuid default gen_random_uuid(),protocol_id uuid,archived_at timestamptz,phase text,storage_path text,
 product_id uuid,lot_snapshot text,taken_at timestamptz,mime_type text,size_bytes bigint,sha256 text,original_name text,
 thumbnail_storage_path text,thumbnail_mime_type text,thumbnail_size_bytes bigint,thumbnail_sha256 text,attendance_id uuid,
 procedure_item_id uuid,duplicate_of_photo_id uuid,duplicate_reason text,duplicate_confirmed_by uuid,duplicate_confirmed_at timestamptz,
 duplicate_operation_id uuid,idempotency_key uuid);
 create table storage.objects(bucket_id text,name text,metadata jsonb);
 create table financeiro_estoque_lotes(id uuid primary key default gen_random_uuid(),clinic_id uuid,product_id uuid,lot text,expiry date,unit text);
 create table financeiro_estoque_movimentos(id uuid primary key default gen_random_uuid(),clinic_id uuid,product_id uuid,lot_id uuid,movement_kind text,
 quantity_delta numeric,unit text,unit_cost_effective numeric,protocol_id uuid,source_line_id uuid,reversal_of_id uuid,actor_id uuid,request_id uuid,created_at timestamptz default now());
 create table financeiro_compra_itens(id uuid default gen_random_uuid(),product_id uuid);
 create table operacao_consumo_eventos(id uuid default gen_random_uuid(),product_id uuid);
 create table atendimentos_realizados(id uuid default gen_random_uuid(),protocol_id uuid);
 create table financeiro_lancamentos(id uuid default gen_random_uuid());
 `);
 const base=await migration('20260824010000_prontuario_fotos_produtos_seguros.sql');
 const integration=await migration('20260824063000_integracao_consulta_prontuario_fotos.sql');
 const stock=await migration('20260824030000_estoque_integrado_lotes_frete.sql');
 const dedup=await migration('20260824025000_fonte_unica_deduplicacao_financeira.sql');
 const final=await migration('20260824064000_finalizacao_prontuario_exige_foto.sql');
 const lock=await migration('20260826085738_fase2_hardening_fotos_estoque.sql');
 for(const name of ['private.prontuario_assert_actor','private.prontuario_log_event','private.prontuario_append_consents']) await db.exec(extract(base,name));
 for(const name of ['private.prontuario_normalize_procedure_kind','private.prontuario_replace_products']) await db.exec(extract(integration,name));
 for(const name of ['private.financeiro_normalize_identity','private.financeiro_product_exact_key']) await db.exec(extract(dedup,name));
 for(const name of ['private.financeiro_unidade_canonica','private.financeiro_estoque_request_id','public.prontuario_substituir_produtos']) await db.exec(extract(stock,name));
 await db.exec(extract(lock,'private.fase2_lock_stock_ledger'));
 await db.exec(extract(final,'private.prontuario_guard_protocol_mutation'));
 await db.exec(extract(await migration('20260823234710_financeiro_crud_seguro_custos_cancelamento.sql'),'private.financeiro_operation_reason'));
 await db.exec(extract(await migration('20260819135410_gestao_financeira_mvp.sql'),'private.financeiro_touch_row'));
 // Existing wrappers/triggers remain present when our migration replaces implementations.
 await db.exec(extract(lock,'public.financeiro_editar_produto'));
 await db.exec(`
 create trigger protocols_guard_mutation before update or delete on protocols for each row execute function private.prontuario_guard_protocol_mutation();
 create trigger financeiro_produtos_touch before update on financeiro_produtos for each row execute function private.financeiro_touch_row();
 `);
 // A genuine legacy complete row with unknown presentation must remain
 // archivable/restorable. Do not invent presentation or reclassify old records.
 const legacyProduct=randomUUID();
 await sql("insert into financeiro_produtos(id,clinic_id,name,product_type,unit,presentation,dedup_exact_key) values($1,$2,'Synthetic legacy','descartavel','un',null,$1::uuid::text)",[legacyProduct,C]);
 await db.exec(await migration('20260906211159_cadastros_rascunhos_progressivos.sql'));
 await db.exec(`create constraint trigger protocol_products_preserve_active_photo_context after delete or update on protocol_products
 deferrable initially deferred for each row execute function private.prontuario_enforce_active_photo_product_context();
 create constraint trigger protocol_photos_require_active_product_context after insert or update on protocol_photos
 deferrable initially deferred for each row execute function private.prontuario_enforce_active_photo_product_context();`);
 await db.exec(`create trigger financeiro_produtos_00_dedup before insert or update of brand_id,name,presentation,unit,ean,anvisa_registration
 on financeiro_produtos for each row execute function private.financeiro_sync_product_dedup();
 grant usage on schema public,private to service_role;
 grant select,insert,update on all tables in schema public to service_role;
 grant execute on function private.financeiro_normalize_identity(text),private.financeiro_product_exact_key(uuid,uuid,text,text,text,text,text) to service_role;
 grant execute on function public.financeiro_editar_produto(uuid,uuid,uuid,integer,uuid,text,text,text,text,text,numeric,numeric,text,boolean,text,uuid) to service_role;
 revoke all on function private.prontuario_assert_actor(uuid,uuid,text,text,text[]),private.prontuario_log_event(uuid,uuid,text,text,text,uuid,text,jsonb,uuid),private.prontuario_append_consents(uuid,uuid,jsonb) from public,anon,authenticated,service_role;
 `);
 await sql('insert into clinics values($1),($2)',[C,OTHER]);
 await sql('insert into auth.users values($1)',[U]);
 await sql("insert into clinic_members values($1,$2,'owner','active')",[C,U]);
 await sql('insert into patients(id,clinic_id) values($1,$2)',[P,C]);
 const prod=randomUUID(),otherProd=randomUUID();
 await check('name-only product has real NULLs, inactive draft, no name-only merge',async()=>{
  await db.exec('set role service_role');
  await sql('insert into financeiro_produtos(id,clinic_id,name,created_by) values($1,$2,$3,$4)',[prod,C,'Synthetic draft product',U]);
  await sql('insert into financeiro_produtos(id,clinic_id,name,created_by) values($1,$2,$3,$4)',[otherProd,C,'Synthetic draft product',U]);
  const row=await one('select product_type,unit,presentation,registration_status,active from financeiro_produtos where id=$1',[prod]);
  assert.deepEqual(row,{product_type:null,unit:null,presentation:null,registration_status:'draft',active:false});
 });
 await check('legacy product archive/restore preserves unknown presentation',async()=>{
  await sql("update financeiro_produtos set archived_at=now(),active=false where id=$1",[legacyProduct]);
  await sql("update financeiro_produtos set archived_at=null,active=true where id=$1",[legacyProduct]);
  assert.equal((await one('select presentation from financeiro_produtos where id=$1',[legacyProduct])).presentation,null);
 });
 await check('draft product cannot reach purchase/stock/consumption ledgers',async()=>{
  for(const table of ['financeiro_compra_itens','financeiro_estoque_lotes','financeiro_estoque_movimentos','protocol_products','operacao_consumo_eventos']){
   await assert.rejects(sql('insert into '+table+'(product_id) values($1)',[prod]),/catalog_product_incomplete/);
  }
 });
 async function editProduct(id,version,type,unit,presentation,stockControl=false) {
  return (await one("select financeiro_editar_produto($1,$2,$3,$4,null,'Synthetic draft product',$5,$6,$7,null,null,null,null,$8,'Synthetic completion',$9) as result",
   [C,U,id,version,type,unit,presentation,stockControl,randomUUID()])).result;
 }
 await check('same product ID resumes partially then completes; stale version is rejected',async()=>{
  let row=await editProduct(prod,1,'descartavel',null,null);
  assert.equal(row.id,prod);assert.equal(row.registration_status,'draft');assert.equal(row.version,2);
  row=await editProduct(prod,2,'descartavel','un','Caixa teste',true);
  assert.equal(row.id,prod);assert.equal(row.registration_status,'complete');assert.equal(row.active,true);assert.equal(row.version,3);
  await assert.rejects(editProduct(prod,2,'descartavel','un','Caixa teste'),/version_conflict/);
 });
 const key=randomUUID();
 async function save({id=null,version=null,kind=null,date=null,products=null,request= id ? randomUUID():key,consents={},patient=P,complaint='Synthetic note only'}={}) {
  return (await one("select prontuario_salvar_rascunho_com_estoque($1,$2,'owner','supabase_auth',$3,$4,$5,$6,null,$7,$8,'{}'::jsonb,null,$9,null,null,$10::jsonb,$11::jsonb,$12) as result",
   [C,U,id,version,key,patient,kind,complaint,date,products===null?null:JSON.stringify(products),JSON.stringify(consents),request])).result;
 }
 let protocol;
 await check('patient + note draft persists without clinical procedure/date or side effects',async()=>{
  protocol=await save();
  const row=await one('select procedure_kind,procedure_date,complaint,draft_products,created_at from protocols where id=$1',[protocol.id]);
  assert.equal(row.procedure_kind,null);assert.equal(row.procedure_date,null);assert.equal(row.complaint,'Synthetic note only');assert.deepEqual(row.draft_products,[]);
  assert(row.created_at);
  for(const table of ['protocol_products','financeiro_estoque_movimentos','financeiro_lancamentos','atendimentos_realizados']) assert.equal((await one('select count(*)::int n from '+table)).n,0);
  const retry=await save();assert.equal(retry.id,protocol.id);assert.equal(retry.idempotent,true);
 });
 const partial=[{product_id:prod,lot:'LOTE PARCIAL',expiry:null,amount:null,unit:null,position:1}];
 await check('partial product survives reopen and versioned update; no stock movement',async()=>{
  protocol=await save({id:protocol.id,version:protocol.version,products:partial});
  assert.deepEqual((await one('select draft_products from protocols where id=$1',[protocol.id])).draft_products,partial);
  assert.equal((await one('select count(*)::int n from financeiro_estoque_movimentos')).n,0);
  await assert.rejects(save({id:protocol.id,version:protocol.version-1}),/version_conflict/);
  await assert.rejects(save({id:protocol.id,version:protocol.version,products:[{product_id:otherProd}]}),/catalog_product_not_found/);
  await assert.rejects(save({id:protocol.id,version:protocol.version,patient:randomUUID()}),/patient_not_found/);
 });
 await check('an undated draft can be archived/restored; NULL procedure cannot be signed',async()=>{
  await db.exec('reset role');
  await sql('update protocols set archived_at=now(),updated_by=$2,version=version+1 where id=$1',[protocol.id,U]);
  await sql('update protocols set archived_at=null,updated_by=$2,version=version+1 where id=$1',[protocol.id,U]);
  protocol.version=(await one('select version from protocols where id=$1',[protocol.id])).version;
  await assert.rejects(sql("insert into protocols(clinic_id,patient_id,status,procedure_kind,procedure_date) values($1,$2,'signed',null,'2026-09-06')",[C,P]),/protocols_procedure_kind_check|protocols_complete_essentials/);
  await db.exec('set role service_role');
 });
 async function finalize(request=randomUUID()){return (await one("select prontuario_finalizar($1,$2,'owner','supabase_auth',$3,$4,$5) as result",[C,U,protocol.id,protocol.version,request])).result;}
 await check('finalization still rejects missing essentials and missing consent/photo',async()=>{
  await assert.rejects(finalize(),/protocol_essentials_required/);
  protocol=await save({id:protocol.id,version:protocol.version,kind:'avaliacao_facial',date:'2026-09-06',products:partial});
  await assert.rejects(finalize(),/clinical_photography_consent_required/);
  protocol=await save({id:protocol.id,version:protocol.version,kind:'avaliacao_facial',date:'2026-09-06',consents:{clinical_photography:true}});
  await assert.rejects(finalize(),/clinical_photo_required/);
  await db.exec('reset role');
  await sql("insert into protocol_photos(protocol_id,phase,storage_path) values($1,'before','synthetic-only')",[protocol.id]);
  await db.exec("insert into storage.objects(bucket_id,name) values('clinic-media','synthetic-only');set role service_role");
  await assert.rejects(finalize(),/product_item_invalid/);
  assert.equal((await one('select status from protocols where id=$1',[protocol.id])).status,'draft');
 });
 await check('actual photo RPC links a partial draft row without consumption; active link cannot disappear',async()=>{
  const photo=randomUUID(),path=C+'/'+protocol.id+'/'+photo+'.jpg';
  await db.exec('reset role');
  await sql("insert into storage.objects(bucket_id,name,metadata) values('clinic-media',$1,'{\"mimetype\":\"image/jpeg\",\"size\":1}')",[path]);
  await db.exec('set role service_role');
  const result=await one("select prontuario_registrar_foto($1,$2,'owner','supabase_auth',$3,$4,'products_used',$5,now(),'image/jpeg',1,repeat('a',64),'synthetic.jpg',null,null,null,null,$6,'LOTE PARCIAL',null,null,false,null,null,$7,$8) result",
   [C,U,photo,protocol.id,path,prod,randomUUID(),randomUUID()]);
  assert.equal(result.result.id,photo);
  assert.equal((await one('select count(*)::int n from protocol_products')).n,0);
  assert.equal((await one('select count(*)::int n from financeiro_estoque_movimentos')).n,0);
  await assert.rejects(save({id:protocol.id,version:protocol.version,products:[]}),/protocol_product_referenced_by_active_photo/);
  assert.equal((await one('select draft_products from protocols where id=$1',[protocol.id])).draft_products[0].lot,'LOTE PARCIAL');
 });
 const complete=[{product_id:prod,lot:'LOTE PARCIAL',expiry:'2027-01-01',amount:2,unit:'un',position:1}];
 await check('save complete product row still has no stock effect; failed finalization rolls back',async()=>{
  protocol=await save({id:protocol.id,version:protocol.version,kind:'avaliacao_facial',date:'2026-09-06',products:complete});
  assert.equal((await one('select count(*)::int n from protocol_products')).n,0);
  await assert.rejects(finalize(),/stock_lot_not_found/);
  assert.equal((await one('select count(*)::int n from protocol_products')).n,0);
 });
 await check('explicit finalization materializes products and consumes exactly once',async()=>{
  const lot=randomUUID();
  await sql("insert into financeiro_estoque_lotes(id,clinic_id,product_id,lot,expiry,unit) values($1,$2,$3,'LOTE PARCIAL','2027-01-01','un')",[lot,C,prod]);
  await sql("insert into financeiro_estoque_movimentos(clinic_id,product_id,lot_id,movement_kind,quantity_delta,unit,unit_cost_effective) values($1,$2,$3,'entrada_compra',10,'un',2)",[C,prod,lot]);
  const request=randomUUID(),result=await finalize(request);
  assert.equal(result.status,'signed');
  const retry=await finalize(request);assert.equal(retry.version,result.version);assert.equal(retry.idempotent,true);
  assert.equal((await one("select count(*)::int n from financeiro_estoque_movimentos where movement_kind='saida_procedimento'")).n,1);
  assert.equal(Number((await one('select sum(quantity_delta) n from financeiro_estoque_movimentos')).n),8);
  assert.equal((await one('select count(*)::int n from protocol_products')).n,1);
  await assert.rejects(save({id:protocol.id,version:result.version}),/protocol_locked/);
 });
 await check('new RPCs remain inaccessible to browser roles',async()=>{
  await db.exec('reset role');
  for(const role of ['anon','authenticated']){
   assert.equal((await one("select has_function_privilege($1,'public.prontuario_finalizar(uuid,uuid,text,text,uuid,integer,uuid)','execute') ok",[role])).ok,false);
   assert.equal((await one("select has_function_privilege($1,'public.prontuario_salvar_rascunho_com_estoque(uuid,uuid,text,text,uuid,integer,uuid,uuid,uuid,text,text,jsonb,text,date,date,text,jsonb,jsonb,uuid)','execute') ok",[role])).ok,false);
  }
 });
 await check('production-style BEGIN/ROLLBACK smoke succeeds and leaves no fixture',async()=>{
  await db.exec('revoke update,insert,delete on public.protocols from service_role');
  const before=await one('select count(*)::int patients from patients');
  await db.exec(await readFile(new URL('./progressive_drafts_smoke.sql',import.meta.url),'utf8'));
  assert.deepEqual(await one('select count(*)::int patients from patients'),before);
 });
 await check('private owner photo/signature authorization does not create patient consent',async()=>{
  await db.exec(await migration('20260906212532_private_clinical_photo_authorization.sql'));
  const before=await one('select count(*)::int patients from patients');
  await db.exec(await readFile(new URL('./private_clinical_photo_smoke.sql',import.meta.url),'utf8'));
  assert.deepEqual(await one('select count(*)::int patients from patients'),before);
 });
 console.log(checks+' offline regression groups passed; no remote database used.');
} catch(error) {
 console.error('FAIL', error.message, error.code || '', error.where || '');
 process.exitCode=1;
} finally { await db.close(); }

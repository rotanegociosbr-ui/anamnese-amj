// Offline PostgreSQL regression using a synthetic, minimal schema only.
// npm install --prefix <temporary-dir> --no-save --package-lock=false @electric-sql/pglite@0.5.8
// node supabase/tests/facial_studies_local_test.mjs <temporary-dir>/node_modules/@electric-sql/pglite
// No connection string, network, credentials, or real clinical records are used.
// PGlite has one backend: this checks SQL/privileges, not simultaneous sessions.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
const require=createRequire(import.meta.url);
const {PGlite}=require(process.argv[2]?resolve(process.argv[2]):'@electric-sql/pglite');
const db=new PGlite();
const migration=async(name)=>readFile(new URL('../migrations/'+name,import.meta.url),'utf8');
const C='22222222-2222-4222-8222-222222222222',U='11111111-1111-4111-8111-111111111111';
const P='33333333-3333-4333-8333-333333333333',Q='44444444-4444-4444-8444-444444444444';
try{
 await db.exec(`
  create role anon; create role authenticated; create role service_role bypassrls;
  create schema auth; create schema private;
  create table auth.users(id uuid primary key);
  create table public.clinics(id uuid primary key);
  create table public.clinic_members(clinic_id uuid,user_id uuid,role text,status text);
  create table public.patients(id uuid primary key,clinic_id uuid,full_name text,created_by uuid,dedup_exact_key text);
  create table public.protocols(id uuid primary key,clinic_id uuid references public.clinics(id),
   patient_id uuid references public.patients(id),professional_id uuid,procedure_kind text,procedure_date date,
   version integer not null default 1,status text not null default 'draft',archived_at timestamptz,
   archive_reason text,archived_by uuid,updated_by uuid,updated_at timestamptz);
  grant usage on schema public,auth to service_role;
  grant select on public.protocols,public.clinic_members to service_role;
  insert into auth.users values('${U}'); insert into public.clinics values('${C}');
  insert into public.clinic_members values('${C}','${U}','owner','active');
 `);
 // Include the actual existing mutation trigger, not an invented substitute.
 const legacy=await migration('20260824010000_prontuario_fotos_produtos_seguros.sql');
 const guard=legacy.slice(legacy.indexOf('create or replace function private.prontuario_guard_protocol_mutation()'),legacy.indexOf('create or replace function private.prontuario_guard_product_mutation()'));
 assert(guard.includes('create trigger protocols_guard_mutation'));
 await db.exec(guard);
 await db.exec(await migration('20260906170538_facial_studies_prontuario.sql'));
 // Demonstrate why the original admin-only smoke did not catch the real failure.
 await db.exec(`begin;
  insert into public.patients(id,clinic_id,full_name,created_by,dedup_exact_key) values('${P}','${C}','Synthetic SQL fixture','${U}','${P}');
  insert into public.protocols(id,clinic_id,patient_id,professional_id) values('${Q}','${C}','${P}','${U}');
  set local role service_role;`);
 await assert.rejects(db.query(`select public.facial_study_save('${C}','${U}','${Q}',gen_random_uuid(),0,
  '{"schemaVersion":1,"modelVersion":"amj-facial-20260906-v2","points":[],"notes":""}','Synthetic regression')`),
  e=>e.code==='42501'&&e.message.includes('permission denied for table protocols'));
 await db.exec('rollback;');
 console.log('PASS: original invoker RPC reproduces 42501 under service_role');
 await db.exec(await migration('20260906195510_facial_studies_context_lock.sql'));
 await db.exec(await readFile(new URL('./facial_studies_smoke.sql',import.meta.url),'utf8'));
 const remaining=await db.query('select (select count(*) from public.patients)::int patients,(select count(*) from public.protocols)::int protocols,(select count(*) from public.facial_studies)::int studies');
 assert.deepEqual(remaining.rows,[{patients:0,protocols:0,studies:0}]);
 console.log('PASS: patched SQL smoke (service_role, binding, idempotency, history, reassignment, archive) and fixture rollback');
 const defs=await db.query("select proname,prosrc,prosecdef from pg_proc where proname in ('facial_study_save','facial_protocol_context_guard')");
 const save=defs.rows.find(r=>r.proname==='facial_study_save'),update=defs.rows.find(r=>r.proname==='facial_protocol_context_guard');
 assert(!save.prosecdef&&!update.prosecdef);
 assert.match(save.prosrc,/pg_advisory_xact_lock/);assert.doesNotMatch(save.prosrc,/for\s+update/i);
 assert.match(update.prosrc,/pg_try_advisory_xact_lock/);assert.doesNotMatch(update.prosrc,/\bpg_advisory_xact_lock\(/);
 console.log('PASS: lock-order structure uses blocking save / nonblocking row-update guard, both invoker');
}finally{await db.close();}

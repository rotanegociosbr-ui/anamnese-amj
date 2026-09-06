// Offline, synthetic PostgreSQL test. No production URL, records or credentials.
// node supabase/tests/routine_edit_authorization_local_test.mjs <path-to-@electric-sql/pglite>
// Pinned test runtime: PGlite 0.5.8. Multi-session concurrency is not simulated.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
const require=createRequire(import.meta.url);
const modulePath=process.argv[2]?resolve(process.argv[2]):'@electric-sql/pglite';
const {PGlite}=require(modulePath),{pgcrypto}=require(resolve(modulePath,'dist/contrib/pgcrypto.cjs'));
const db=new PGlite({extensions:{pgcrypto}});
const sql=async(name)=>readFile(new URL(name,import.meta.url),'utf8');
try{
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
  create schema auth;create schema extensions;create extension pgcrypto with schema extensions;
  create table auth.users(id uuid primary key);
  create table auth.sessions(id uuid primary key,user_id uuid references auth.users(id),created_at timestamptz,updated_at timestamptz);
  create table public.clinics(id uuid primary key);
  create table public.clinic_members(clinic_id uuid,user_id uuid,role text,status text);
  create table public.clinic_audit_log(clinic_id uuid,actor uuid,entity text,entity_id uuid,action text,details jsonb,
   actor_role text,auth_method text,outcome text,request_id uuid,unique(clinic_id,request_id));
  insert into auth.users values('11111111-1111-4111-8111-111111111111');
  insert into public.clinics values('22222222-2222-4222-8222-222222222222');
  insert into public.clinic_members values('22222222-2222-4222-8222-222222222222','11111111-1111-4111-8111-111111111111','owner','active');`);
 await db.exec(await sql('../migrations/20260824002702_password_proof_consumption.sql'));
 await db.exec(await sql('../migrations/20260906211135_routine_edit_authorization_window.sql'));
 await db.exec(await sql('./routine_edit_authorization_smoke.sql'));
 const remaining=await db.query(`select (select count(*) from auth.sessions)::int sessions,
  (select count(*) from private.clinic_password_proofs)::int proofs,
  (select count(*) from private.clinic_routine_edit_grants)::int grants,
  (select count(*) from private.clinic_routine_edit_revocations)::int revocations,
  (select count(*) from public.clinic_audit_log)::int audits`);
 assert.deepEqual(remaining.rows,[{sessions:0,proofs:0,grants:0,revocations:0,audits:0}]);
 console.log('PASS: service-role SQL smoke, actual pgcrypto/HMAC and one-time proof RPCs, 30-minute absolute expiry, no extension, action allowlist, session/clinic/user isolation, revoke/replay/logout, full rollback');
 const definition=(await db.query("select prosrc,proconfig from pg_proc where oid='public.clinic_routine_edit_authorization(uuid,uuid,uuid,text,uuid,text)'::regprocedure")).rows[0];
 assert(definition.proconfig.includes('search_path=""'));
 assert.match(definition.prosrc,/pg_advisory_xact_lock/);
 const fields=(await db.query("select column_name from information_schema.columns where table_schema='private' and table_name in ('clinic_routine_edit_grants','clinic_routine_edit_revocations')")).rows.map(r=>r.column_name);
 assert(!fields.some(f=>/^(password|access_token|refresh_token|main_session_id|secondary_session_id)$/.test(f)));
 console.log('PASS: fixed search_path, serialized grant/revoke and no raw credentials/session IDs in new tables');
}catch(error){
 console.error('FAIL:',error.code||'',error.message,error.where||'');process.exitCode=1;
}finally{await db.close();}

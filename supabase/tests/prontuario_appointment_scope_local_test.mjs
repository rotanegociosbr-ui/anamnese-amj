// Offline 42703 regression. The real agenda intentionally has NO clinic_id.
// node supabase/tests/prontuario_appointment_scope_local_test.mjs <pglite-package>
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
const require=createRequire(import.meta.url);
const {PGlite}=require(resolve(process.argv[2]));
const db=new PGlite();
const migration=async name=>readFile(new URL('../migrations/'+name,import.meta.url),'utf8');
function extract(source,name) {
 const start=source.search(new RegExp('create (?:or replace )?function '+name.replaceAll('.','\\.')+'\\('));
 assert(start>=0,'Missing '+name);
 const body=source.slice(start),match=/as\s+(\$[a-z_]*\$)/i.exec(body);
 assert(match);const end=body.indexOf(match[1]+';',match.index+match[0].length);
 return body.slice(0,end+match[1].length+1);
}
try {
 await db.exec(`
 create role anon;create role authenticated;create role service_role bypassrls;
 create schema private;create schema auth;
 create table clinics(id uuid primary key);
 create table auth.users(id uuid primary key);
 create table clinic_members(clinic_id uuid,user_id uuid,role text,status text);
 create table patients(id uuid primary key,clinic_id uuid,status text default 'active',archived_at timestamptz,full_name text,created_by uuid,dedup_exact_key text);
 create table agendamentos_clinica(id uuid primary key,idempotency_key uuid,nome text,telefone text,categoria text,procedimento text,inicio_em timestamptz,fim_em timestamptz,status text);
 create table patient_source_links(clinic_id uuid,patient_id uuid,source_kind text,source_id uuid,match_method text,status text,confirmed_by uuid,confirmed_at timestamptz);
 create table financeiro_produtos(id uuid primary key,clinic_id uuid,name text,product_type text,unit text,presentation text,created_by uuid,updated_by uuid,
 stock_control boolean,active boolean default true,archived_at timestamptz,registration_status text default 'complete');
 create table protocols(id uuid primary key default gen_random_uuid(),clinic_id uuid,patient_id uuid,professional_id uuid,appointment_id uuid,
 procedure_kind text,complaint text,anamnesis jsonb,technique_notes text,procedure_date date,return_date date,care_notes text,
 status text default 'draft',version int default 1,updated_by uuid,idempotency_key uuid,archived_at timestamptz,
 created_at timestamptz default now(),updated_at timestamptz default now(),draft_products jsonb,unique(clinic_id,idempotency_key));
 create table clinic_audit_log(id uuid default gen_random_uuid(),clinic_id uuid,actor uuid,entity text,entity_id uuid,action text,details jsonb,
 actor_role text,auth_method text,outcome text,request_id uuid,unique(clinic_id,request_id));
 create table protocol_consents(id uuid primary key default gen_random_uuid(),protocol_id uuid,kind text,term_id uuid,accepted boolean,evidence jsonb,
 recorded_by uuid,supersedes_id uuid,recorded_at timestamptz default now(),revoked_at timestamptz);
 create table financeiro_estoque_movimentos(id uuid default gen_random_uuid(),protocol_id uuid);
 grant usage on schema public,private to service_role;
 grant select on all tables in schema public to service_role;
 `);
 const base=await migration('20260824010000_prontuario_fotos_produtos_seguros.sql');
 const integration=await migration('20260824063000_integracao_consulta_prontuario_fotos.sql');
 const draft=await migration('20260906211159_cadastros_rascunhos_progressivos.sql');
 for(const name of ['private.prontuario_assert_actor','private.prontuario_log_event','private.prontuario_append_consents']) await db.exec(extract(base,name));
 await db.exec(extract(integration,'private.prontuario_normalize_procedure_kind'));
 for(const name of ['private.prontuario_validate_draft_products','public.prontuario_salvar_rascunho','public.prontuario_salvar_rascunho_com_estoque']) await db.exec(extract(draft,name));
 await db.exec(`revoke all on function public.prontuario_salvar_rascunho(uuid,uuid,text,text,uuid,integer,uuid,uuid,uuid,text,text,jsonb,text,date,date,text,jsonb,jsonb,uuid),
 public.prontuario_salvar_rascunho_com_estoque(uuid,uuid,text,text,uuid,integer,uuid,uuid,uuid,text,text,jsonb,text,date,date,text,jsonb,jsonb,uuid) from public,anon,authenticated;
 grant execute on function public.prontuario_salvar_rascunho(uuid,uuid,text,text,uuid,integer,uuid,uuid,uuid,text,text,jsonb,text,date,date,text,jsonb,jsonb,uuid),
 public.prontuario_salvar_rascunho_com_estoque(uuid,uuid,text,text,uuid,integer,uuid,uuid,uuid,text,text,jsonb,text,date,date,text,jsonb,jsonb,uuid) to service_role;`);
 const C=randomUUID(),U=randomUUID(),P=randomUUID();
 await db.query('insert into clinics values($1)',[C]);
 await db.query('insert into auth.users values($1)',[U]);
 await db.query("insert into clinic_members values($1,$2,'owner','active')",[C,U]);
 await db.query("insert into patients(id,clinic_id,full_name) values($1,$2,'Synthetic baseline')",[P,C]);
 await db.exec('set role service_role');
 await assert.rejects(db.query("select prontuario_salvar_rascunho_com_estoque($1,$2,'owner','supabase_auth',null,null,$3,$4,null,null,null,'{}',null,null,null,null,'[]','{}',$3)",
  [C,U,randomUUID(),P]),error=>error.code==='42703' && /clinic_id/.test(error.message));
 console.log('PASS reproduces original 42703 with NULL appointment and actual agenda schema');
 await db.exec('reset role');
 await db.exec(await migration('20260906212526_prontuario_appointment_patient_scope_fix.sql'));
 const result=await db.exec(await readFile(new URL('./prontuario_appointment_scope_smoke.sql',import.meta.url),'utf8'));
 const summary=result.at(-1).rows[0].smoke_result;
 assert.deepEqual(summary,{result:'PASS',synthetic_patients_remaining:0,synthetic_products_remaining:0,synthetic_appointments_remaining:0});
 console.log('PASS fixed RPC: no appointment, product preservation, confirmed patient binding, missing/unlinked/candidate/wrong-patient rejection, idempotency, version conflict, ACLs and rollback');
} finally {await db.close();}

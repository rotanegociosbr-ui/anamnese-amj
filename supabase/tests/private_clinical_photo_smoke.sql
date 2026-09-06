-- Private clinical upload/signature smoke: no patient consent is inferred.
-- Explicit, synthetic database smoke only. No binary upload or real patient data.
-- ALL rows and storage metadata created below are rolled back. Never remove ROLLBACK.
begin;
create temporary table private_photo_context(
 clinic_id uuid,actor_id uuid,patient_id uuid,product_id uuid,protocol_id uuid,
 version integer,photo_id uuid,clinical_photo_id uuid
) on commit drop;
grant select,update on private_photo_context to service_role;
do $fixture$
declare c uuid;u uuid;p uuid:=gen_random_uuid();product uuid:=gen_random_uuid();
begin
 select clinic_id,user_id into c,u from public.clinic_members
 where role='owner' and status='active' order by clinic_id,user_id limit 1;
 if c is null then raise exception 'no_owner_fixture_context';end if;
 insert into public.patients(id,clinic_id,full_name,created_by,dedup_exact_key)
 values(p,c,'TESTE ARQUIVO PRIVADO '||p::text,u,p::text);
 insert into public.financeiro_produtos(id,clinic_id,name,created_by,updated_by)
 values(product,c,'TESTE RASCUNHO '||product::text,u,u);
 insert into private_photo_context values(c,u,p,product,null,null,gen_random_uuid(),gen_random_uuid());
end;$fixture$;

set local role service_role;
do $draft$
declare f record; a jsonb;b jsonb;key uuid:=gen_random_uuid();r public.financeiro_produtos%rowtype;
begin
 select * into f from private_photo_context;
 if has_table_privilege('service_role','public.protocols','UPDATE') then
  raise exception 'protocol_update_privilege_expanded';end if;
 if has_function_privilege('authenticated','public.prontuario_salvar_rascunho_com_estoque(uuid,uuid,text,text,uuid,integer,uuid,uuid,uuid,text,text,jsonb,text,date,date,text,jsonb,jsonb,uuid)','EXECUTE') then
  raise exception 'browser_draft_rpc_exposed';end if;
 select * into r from public.financeiro_produtos where id=f.product_id;
 if r.registration_status<>'draft' or r.active or r.product_type is not null
   or r.unit is not null or r.presentation is not null then raise exception 'product_not_true_draft';end if;
 b:=public.financeiro_editar_produto(f.clinic_id,f.actor_id,f.product_id,r.version,
  null,r.name,'descartavel','un','Unidade sintética',null,null,null,null,false,'Teste transacional',gen_random_uuid());
 if b->>'id'<>f.product_id::text or b->>'registration_status'<>'complete'
    or (b->>'active')::boolean is not true then raise exception 'same_product_completion_failed';end if;
 a:=public.prontuario_salvar_rascunho_com_estoque(f.clinic_id,f.actor_id,'owner','supabase_auth',
  null,null,key,f.patient_id,null,null,'Anotação sintética sem procedimento','{}',null,null,null,null,
  '[{"lot":"LOTE PARCIAL"}]','{}',key);
 b:=public.prontuario_salvar_rascunho_com_estoque(f.clinic_id,f.actor_id,'owner','supabase_auth',
  null,null,key,f.patient_id,null,null,'Anotação sintética sem procedimento','{}',null,null,null,null,
  '[{"lot":"LOTE PARCIAL"}]','{}',key);
 if a->>'id'<>b->>'id' or (b->>'idempotent')::boolean is not true then raise exception 'draft_retry_duplicate';end if;
 update private_photo_context set protocol_id=(a->>'id')::uuid,version=(a->>'version')::integer;
 select * into f from private_photo_context;
 if not exists(select 1 from public.protocols where id=f.protocol_id and procedure_kind is null
    and procedure_date is null and status='draft' and complaint='Anotação sintética sem procedimento'
    and draft_products='[{"lot":"LOTE PARCIAL"}]'::jsonb) then raise exception 'draft_data_lost';end if;
 if exists(select 1 from public.protocol_products where protocol_id=f.protocol_id)
 or exists(select 1 from public.financeiro_estoque_movimentos where protocol_id=f.protocol_id)
 or exists(select 1 from public.atendimentos_realizados where protocol_id=f.protocol_id)
 then raise exception 'draft_created_operational_effect';end if;
 begin
  perform public.prontuario_finalizar(f.clinic_id,f.actor_id,'owner','supabase_auth',f.protocol_id,f.version,gen_random_uuid());
  raise exception 'incomplete_finalization_allowed';
 exception when check_violation then if sqlerrm<>'protocol_essentials_required' then raise;end if;end;
 -- Save real product+lot as a pending row, still without amount/expiry/unit.
 a:=public.prontuario_salvar_rascunho_com_estoque(f.clinic_id,f.actor_id,'owner','supabase_auth',
  f.protocol_id,f.version,key,f.patient_id,null,'avaliacao_facial','Anotação sintética','{}',null,current_date,null,null,
  jsonb_build_array(jsonb_build_object('product_id',f.product_id,'lot','LOTE PARCIAL')),
  '{}',gen_random_uuid());
 update private_photo_context set version=(a->>'version')::integer;
end;$draft$;
reset role;

-- Metadata fixtures only; no object contents are uploaded, downloaded or copied.
insert into storage.objects(bucket_id,name,metadata)
select 'clinic-media',clinic_id::text||'/'||protocol_id::text||'/'||photo_id::text||'.jpg',
 '{"mimetype":"image/jpeg","size":1}'::jsonb from private_photo_context
union all
select 'clinic-media',clinic_id::text||'/'||protocol_id::text||'/'||clinical_photo_id::text||'.jpg',
 '{"mimetype":"image/jpeg","size":1}'::jsonb from private_photo_context;

set local role service_role;
do $photos_and_finalization$
declare f record;a jsonb;b jsonb;final_request uuid:=gen_random_uuid();
begin
 select * into f from private_photo_context;
 a:=public.prontuario_registrar_foto(f.clinic_id,f.actor_id,'owner','supabase_auth',
  f.photo_id,f.protocol_id,'products_used',f.clinic_id::text||'/'||f.protocol_id::text||'/'||f.photo_id::text||'.jpg',
  now(),'image/jpeg',1,repeat('a',64),'teste-produto.jpg',null,null,null,null,
  f.product_id,'LOTE PARCIAL',null,null,false,null,null,gen_random_uuid(),gen_random_uuid());
 if a->>'id'<>f.photo_id::text then raise exception 'draft_product_photo_failed';end if;
 if exists(select 1 from public.protocol_products where protocol_id=f.protocol_id)
 or exists(select 1 from public.financeiro_estoque_movimentos where protocol_id=f.protocol_id)
 then raise exception 'photo_materialized_draft_products';end if;
 set constraints all immediate;
 begin
  perform public.prontuario_salvar_rascunho_com_estoque(f.clinic_id,f.actor_id,'owner','supabase_auth',
   f.protocol_id,f.version,gen_random_uuid(),f.patient_id,null,'avaliacao_facial',null,'{}',null,current_date,null,null,
   '[]','{}',gen_random_uuid());
  raise exception 'active_photo_link_removed';
 exception when foreign_key_violation then
  if sqlerrm<>'protocol_product_referenced_by_active_photo' then raise;end if;
 end;
 set constraints all deferred;
 perform public.prontuario_registrar_foto(f.clinic_id,f.actor_id,'owner','supabase_auth',
  f.clinical_photo_id,f.protocol_id,'before',f.clinic_id::text||'/'||f.protocol_id::text||'/'||f.clinical_photo_id::text||'.jpg',
  now(),'image/jpeg',1,repeat('b',64),'teste-clinico.jpg',null,null,null,null,
  null,null,null,null,false,null,null,gen_random_uuid(),gen_random_uuid());
 begin
  perform public.prontuario_finalizar(f.clinic_id,f.actor_id,'owner','supabase_auth',f.protocol_id,f.version,gen_random_uuid());
  raise exception 'partial_product_finalization_allowed';
 exception when invalid_parameter_value then if sqlerrm<>'product_item_invalid' then raise;end if;end;
 a:=public.prontuario_salvar_rascunho_com_estoque(f.clinic_id,f.actor_id,'owner','supabase_auth',
  f.protocol_id,f.version,gen_random_uuid(),f.patient_id,null,'avaliacao_facial','Anotação sintética','{}',null,current_date,null,null,
  jsonb_build_array(jsonb_build_object('product_id',f.product_id,'lot','LOTE PARCIAL',
    'expiry',(current_date+365)::text,'amount',1,'unit','un','position',1)),
  '{}',gen_random_uuid());
 a:=public.prontuario_finalizar(f.clinic_id,f.actor_id,'owner','supabase_auth',
   f.protocol_id,(a->>'version')::integer,final_request);
 b:=public.prontuario_finalizar(f.clinic_id,f.actor_id,'owner','supabase_auth',
   f.protocol_id,(a->>'version')::integer,final_request);
 if a->>'status'<>'signed' or b->>'version'<>a->>'version' or (b->>'idempotent')::boolean is not true
 then raise exception 'finalization_retry_failed';end if;
 if (select count(*) from public.protocol_products where protocol_id=f.protocol_id)<>1
 then raise exception 'final_products_not_materialized';end if;
 -- This product was explicitly non-stock-controlled; finalization cannot invent a ledger event.
 if exists(select 1 from public.financeiro_estoque_movimentos where protocol_id=f.protocol_id)
 then raise exception 'nonstock_product_consumed';end if;
if exists(select 1 from public.protocol_consents where protocol_id=f.protocol_id) then
 raise exception 'private_archive_created_patient_consent';end if;
if not exists(select 1 from public.clinic_audit_log where entity_id=f.photo_id
  and actor=f.actor_id and action='photo.add' and details->>'reason_code'='private_owner_upload') then
 raise exception 'private_upload_actor_audit_missing';end if;
end;$photos_and_finalization$;
set constraints all immediate;
reset role;
rollback;

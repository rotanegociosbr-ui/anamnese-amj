-- Fase 2B: lock global antes de qualquer fluxo de estoque e GC auditavel de
-- objetos clinicos orfaos. Nenhum objeto e removido por esta migration.
begin;

create or replace function private.fase2_lock_stock_ledger(p_clinic_id uuid)
returns void language sql set search_path=''
as $function$
  select pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('clinic:stock-ledger:'||p_clinic_id::text,0)
  );
$function$;

create or replace function private.financeiro_lock_stock_product()
returns trigger language plpgsql set search_path=''
as $function$
declare
  v_clinic_id uuid:=coalesce(new.clinic_id,old.clinic_id);
  v_product_id uuid;
begin
  if tg_table_name='financeiro_produtos' then
    v_product_id:=coalesce(new.id,old.id);
  elsif tg_table_name='financeiro_estoque_movimentos' then
    v_product_id:=coalesce(new.product_id,old.product_id);
  else
    raise exception 'stock_lock_table_invalid' using errcode='55000';
  end if;
  perform private.fase2_lock_stock_ledger(v_clinic_id);
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'clinic:stock-product:'||v_clinic_id::text||':'||v_product_id::text,0));
  return new;
end;
$function$;

create trigger financeiro_estoque_movimentos_product_lock
before insert on public.financeiro_estoque_movimentos
for each row execute function private.financeiro_lock_stock_product();
create trigger financeiro_produtos_archive_product_lock
before update of active,archived_at on public.financeiro_produtos
for each row when (old.active is distinct from new.active
  or old.archived_at is distinct from new.archived_at)
execute function private.financeiro_lock_stock_product();

-- Os wrappers adquirem o lock antes de a implementacao canonica tocar lotes,
-- saldos, compras ou produtos. As implementacoes renomeadas ficam inacessiveis
-- ao service_role; somente os wrappers preservam a API publica existente.
alter function public.prontuario_substituir_produtos(uuid,uuid,text,text,uuid,integer,jsonb,uuid)
  rename to fase2_prontuario_substituir_produtos_locked_impl;
create function public.prontuario_substituir_produtos(
  p_clinic_id uuid,p_user_id uuid,p_actor_role text,p_auth_method text,
  p_protocol_id uuid,p_expected_version integer,p_products jsonb,p_request_id uuid
) returns jsonb language plpgsql security definer set search_path=''
as $function$ begin
  perform private.fase2_lock_stock_ledger(p_clinic_id);
  return public.fase2_prontuario_substituir_produtos_locked_impl(
    p_clinic_id,p_user_id,p_actor_role,p_auth_method,p_protocol_id,
    p_expected_version,p_products,p_request_id);
end; $function$;

alter function public.financeiro_criar_compra(uuid,uuid,uuid,date,text,text,smallint,text,text,jsonb,uuid,uuid,numeric,boolean,text,uuid)
  rename to fase2_financeiro_criar_compra_locked_impl;
create function public.financeiro_criar_compra(
  p_clinic_id uuid,p_user_id uuid,p_supplier_id uuid,p_purchase_date date,
  p_invoice_number text,p_payment_condition text,p_installments smallint,
  p_category text,p_notes text,p_items jsonb,p_idempotency_key uuid,p_request_id uuid,
  p_freight_amount numeric default 0,p_confirm_distinct boolean default false,
  p_duplicate_reason text default null,p_duplicate_operation_id uuid default null
) returns jsonb language plpgsql security definer set search_path=''
as $function$ begin
  perform private.fase2_lock_stock_ledger(p_clinic_id);
  return public.fase2_financeiro_criar_compra_locked_impl(
    p_clinic_id,p_user_id,p_supplier_id,p_purchase_date,p_invoice_number,
    p_payment_condition,p_installments,p_category,p_notes,p_items,p_idempotency_key,
    p_request_id,p_freight_amount,p_confirm_distinct,p_duplicate_reason,p_duplicate_operation_id);
end; $function$;

alter function public.financeiro_cancelar_compra(uuid,uuid,uuid,integer,text,uuid,uuid)
  rename to fase2_financeiro_cancelar_compra_locked_impl;
create function public.financeiro_cancelar_compra(
  p_clinic_id uuid,p_user_id uuid,p_purchase_id uuid,p_expected_version integer,
  p_reason text,p_operation_id uuid,p_request_id uuid
) returns jsonb language plpgsql security definer set search_path=''
as $function$ begin
  perform private.fase2_lock_stock_ledger(p_clinic_id);
  return public.fase2_financeiro_cancelar_compra_locked_impl(p_clinic_id,p_user_id,
    p_purchase_id,p_expected_version,p_reason,p_operation_id,p_request_id);
end; $function$;

alter function public.financeiro_regularizar_item_compra_estoque(uuid,uuid,uuid,text,date,boolean,uuid,text,uuid)
  rename to fase2_financeiro_regularizar_item_compra_estoque_locked_impl;
create function public.financeiro_regularizar_item_compra_estoque(
  p_clinic_id uuid,p_user_id uuid,p_purchase_item_id uuid,p_lot text,p_expiry date,
  p_use_as_current_cost boolean,p_operation_id uuid,p_reason text,p_request_id uuid
) returns jsonb language plpgsql security definer set search_path=''
as $function$ begin
  perform private.fase2_lock_stock_ledger(p_clinic_id);
  return public.fase2_financeiro_regularizar_item_compra_estoque_locked_impl(
    p_clinic_id,p_user_id,p_purchase_item_id,p_lot,p_expiry,p_use_as_current_cost,
    p_operation_id,p_reason,p_request_id);
end; $function$;

alter function public.operacao_registrar_evento_consumo(uuid,uuid,text,text,text,uuid,uuid,uuid,text,numeric,text,text,text,timestamptz,uuid,uuid)
  rename to fase2_operacao_registrar_evento_consumo_locked_impl;
create function public.operacao_registrar_evento_consumo(
  p_clinic_id uuid,p_user_id uuid,p_actor_role text,p_auth_method text,p_aal text,
  p_attendance_id uuid,p_product_id uuid,p_lot_id uuid,p_event_kind text,
  p_amount numeric,p_unit text,p_reason text,p_evidence_reference text,
  p_occurred_at timestamptz,p_idempotency_key uuid,p_request_id uuid
) returns jsonb language plpgsql security definer set search_path=''
as $function$ begin
  perform private.fase2_lock_stock_ledger(p_clinic_id);
  return public.fase2_operacao_registrar_evento_consumo_locked_impl(
    p_clinic_id,p_user_id,p_actor_role,p_auth_method,p_aal,p_attendance_id,p_product_id,
    p_lot_id,p_event_kind,p_amount,p_unit,p_reason,p_evidence_reference,p_occurred_at,
    p_idempotency_key,p_request_id);
end; $function$;

alter function public.financeiro_editar_produto(uuid,uuid,uuid,integer,uuid,text,text,text,text,text,numeric,numeric,text,boolean,text,uuid)
  rename to fase2_financeiro_editar_produto_locked_impl;
create function public.financeiro_editar_produto(
  p_clinic_id uuid,p_user_id uuid,p_product_id uuid,p_expected_version integer,
  p_brand_id uuid,p_name text,p_product_type text,p_unit text,p_presentation text,
  p_ean text,p_reference_cost numeric,p_sale_price numeric,p_anvisa_registration text,
  p_stock_control boolean,p_reason text,p_request_id uuid
) returns jsonb language plpgsql security definer set search_path=''
as $function$ begin
  perform private.fase2_lock_stock_ledger(p_clinic_id);
  return public.fase2_financeiro_editar_produto_locked_impl(
    p_clinic_id,p_user_id,p_product_id,p_expected_version,p_brand_id,p_name,p_product_type,
    p_unit,p_presentation,p_ean,p_reference_cost,p_sale_price,p_anvisa_registration,
    p_stock_control,p_reason,p_request_id);
end; $function$;

alter function public.financeiro_arquivar_produto(uuid,uuid,uuid,integer,text,uuid)
  rename to fase2_financeiro_arquivar_produto_locked_impl;
create function public.financeiro_arquivar_produto(
  p_clinic_id uuid,p_user_id uuid,p_product_id uuid,p_expected_version integer,
  p_reason text,p_request_id uuid
) returns jsonb language plpgsql security definer set search_path=''
as $function$ begin
  perform private.fase2_lock_stock_ledger(p_clinic_id);
  return public.fase2_financeiro_arquivar_produto_locked_impl(
    p_clinic_id,p_user_id,p_product_id,p_expected_version,p_reason,p_request_id);
end; $function$;

alter function public.financeiro_restaurar_produto(uuid,uuid,uuid,integer,text,uuid)
  rename to fase2_financeiro_restaurar_produto_locked_impl;
create function public.financeiro_restaurar_produto(
  p_clinic_id uuid,p_user_id uuid,p_product_id uuid,p_expected_version integer,
  p_reason text,p_request_id uuid
) returns jsonb language plpgsql security definer set search_path=''
as $function$ begin
  perform private.fase2_lock_stock_ledger(p_clinic_id);
  return public.fase2_financeiro_restaurar_produto_locked_impl(
    p_clinic_id,p_user_id,p_product_id,p_expected_version,p_reason,p_request_id);
end; $function$;

create table public.clinical_photo_object_gc_queue(
  id uuid primary key default pg_catalog.gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete restrict,
  protocol_id uuid not null,
  photo_id uuid not null,
  storage_path text not null,
  thumbnail_storage_path text,
  reason_code text not null,
  status text not null default 'pending',
  not_before timestamptz not null default pg_catalog.now()+interval '24 hours',
  queued_by uuid not null references auth.users(id) on delete restrict,
  request_id uuid not null,
  created_at timestamptz not null default pg_catalog.now(),
  constraint clinical_photo_object_gc_queue_protocol_fk foreign key(protocol_id)
    references public.protocols(id) on delete restrict,
  constraint clinical_photo_object_gc_queue_status_check check(status in ('pending','retained','removed')),
  constraint clinical_photo_object_gc_queue_reason_check check(reason_code in ('metadata_rejected','thumbnail_failed')),
  constraint clinical_photo_object_gc_queue_path_check check(
    storage_path=clinic_id::text||'/'||protocol_id::text||'/'||photo_id::text||
      substring(storage_path from '\\.[a-z0-9]+$')
    and storage_path !~ '[[:cntrl:]\\]'
    and storage_path !~ '(^|/)\.\.(/|$)'
    and (thumbnail_storage_path is null or (
      thumbnail_storage_path like clinic_id::text||'/'||protocol_id::text||'/'||photo_id::text||'.thumb.%'
      and thumbnail_storage_path !~ '[[:cntrl:]\\]'
      and thumbnail_storage_path !~ '(^|/)\.\.(/|$)'))
  ),
  constraint clinical_photo_object_gc_queue_request_unique unique(clinic_id,request_id)
);
create index clinical_photo_object_gc_queue_pending_idx
  on public.clinical_photo_object_gc_queue(not_before,clinic_id)
  where status='pending';

create function public.prontuario_enfileirar_gc_foto_orfa(
  p_clinic_id uuid,p_user_id uuid,p_actor_role text,p_auth_method text,
  p_protocol_id uuid,p_photo_id uuid,p_storage_path text,p_thumbnail_storage_path text,
  p_reason_code text,p_request_id uuid
) returns jsonb language plpgsql security definer set search_path=''
as $function$
declare v_queue public.clinical_photo_object_gc_queue%rowtype;
begin
  perform private.prontuario_assert_actor(p_clinic_id,p_user_id,p_actor_role,p_auth_method,array['owner']);
  if p_protocol_id is null or p_photo_id is null or p_request_id is null
     or p_reason_code not in ('metadata_rejected','thumbnail_failed')
     or p_storage_path !~ ('^'||p_clinic_id::text||'/'||p_protocol_id::text||'/'||p_photo_id::text||'\\.[a-z0-9]+$')
     or p_storage_path ~ '[[:cntrl:]\\]' or p_storage_path ~ '(^|/)\.\.(/|$)'
     or (p_thumbnail_storage_path is not null and
       (p_thumbnail_storage_path !~ ('^'||p_clinic_id::text||'/'||p_protocol_id::text||'/'||p_photo_id::text||'\\.thumb\\.[a-z0-9]+$')
        or p_thumbnail_storage_path ~ '[[:cntrl:]\\]' or p_thumbnail_storage_path ~ '(^|/)\.\.(/|$)')) then
    raise exception 'photo_gc_request_invalid' using errcode='22023';
  end if;
  if not exists(select 1 from public.protocols protocol where protocol.clinic_id=p_clinic_id
    and protocol.id=p_protocol_id) then raise exception 'protocol_not_found' using errcode='P0002'; end if;
  if exists(select 1 from public.protocol_photos photo
    join public.protocols protocol on protocol.id=photo.protocol_id
    where protocol.clinic_id=p_clinic_id
    and (photo.storage_path=p_storage_path or photo.thumbnail_storage_path=p_storage_path
      or (p_thumbnail_storage_path is not null and
        (photo.storage_path=p_thumbnail_storage_path or photo.thumbnail_storage_path=p_thumbnail_storage_path)))) then
    return pg_catalog.jsonb_build_object('enfileirado',false,'retido_por_referencia',true);
  end if;
  insert into public.clinical_photo_object_gc_queue(
    clinic_id,protocol_id,photo_id,storage_path,thumbnail_storage_path,reason_code,
    queued_by,request_id
  ) values (
    p_clinic_id,p_protocol_id,p_photo_id,p_storage_path,p_thumbnail_storage_path,
    p_reason_code,p_user_id,p_request_id
  ) on conflict(clinic_id,request_id) do nothing returning * into v_queue;
  if not found then select * into v_queue from public.clinical_photo_object_gc_queue
    where clinic_id=p_clinic_id and request_id=p_request_id; end if;
  perform private.prontuario_log_event(p_clinic_id,p_user_id,p_actor_role,p_auth_method,
    'photo_object_gc',v_queue.id,'photo_object_gc.queued',
    pg_catalog.jsonb_build_object('reason_code',v_queue.reason_code,'status_code',v_queue.status),p_request_id);
  return pg_catalog.jsonb_build_object('enfileirado',true,'fila_id',v_queue.id,
    'not_before',v_queue.not_before);
end;
$function$;

alter table public.clinical_photo_object_gc_queue enable row level security;
revoke all on public.clinical_photo_object_gc_queue from public,anon,authenticated,service_role;
grant select on public.clinical_photo_object_gc_queue to service_role;
revoke all on function private.fase2_lock_stock_ledger(uuid) from public,anon,authenticated,service_role;
revoke all on function private.financeiro_lock_stock_product() from public,anon,authenticated,service_role;

revoke all on function public.fase2_prontuario_substituir_produtos_locked_impl(uuid,uuid,text,text,uuid,integer,jsonb,uuid) from public,anon,authenticated,service_role;
revoke all on function public.fase2_financeiro_criar_compra_locked_impl(uuid,uuid,uuid,date,text,text,smallint,text,text,jsonb,uuid,uuid,numeric,boolean,text,uuid) from public,anon,authenticated,service_role;
revoke all on function public.fase2_financeiro_cancelar_compra_locked_impl(uuid,uuid,uuid,integer,text,uuid,uuid) from public,anon,authenticated,service_role;
revoke all on function public.fase2_financeiro_regularizar_item_compra_estoque_locked_impl(uuid,uuid,uuid,text,date,boolean,uuid,text,uuid) from public,anon,authenticated,service_role;
revoke all on function public.fase2_operacao_registrar_evento_consumo_locked_impl(uuid,uuid,text,text,text,uuid,uuid,uuid,text,numeric,text,text,text,timestamptz,uuid,uuid) from public,anon,authenticated,service_role;
revoke all on function public.fase2_financeiro_editar_produto_locked_impl(uuid,uuid,uuid,integer,uuid,text,text,text,text,text,numeric,numeric,text,boolean,text,uuid) from public,anon,authenticated,service_role;
revoke all on function public.fase2_financeiro_arquivar_produto_locked_impl(uuid,uuid,uuid,integer,text,uuid) from public,anon,authenticated,service_role;
revoke all on function public.fase2_financeiro_restaurar_produto_locked_impl(uuid,uuid,uuid,integer,text,uuid) from public,anon,authenticated,service_role;

revoke all on function public.prontuario_substituir_produtos(uuid,uuid,text,text,uuid,integer,jsonb,uuid) from public,anon,authenticated,service_role;
revoke all on function public.financeiro_criar_compra(uuid,uuid,uuid,date,text,text,smallint,text,text,jsonb,uuid,uuid,numeric,boolean,text,uuid) from public,anon,authenticated,service_role;
revoke all on function public.financeiro_cancelar_compra(uuid,uuid,uuid,integer,text,uuid,uuid) from public,anon,authenticated,service_role;
revoke all on function public.financeiro_regularizar_item_compra_estoque(uuid,uuid,uuid,text,date,boolean,uuid,text,uuid) from public,anon,authenticated,service_role;
revoke all on function public.operacao_registrar_evento_consumo(uuid,uuid,text,text,text,uuid,uuid,uuid,text,numeric,text,text,text,timestamptz,uuid,uuid) from public,anon,authenticated,service_role;
revoke all on function public.financeiro_editar_produto(uuid,uuid,uuid,integer,uuid,text,text,text,text,text,numeric,numeric,text,boolean,text,uuid) from public,anon,authenticated,service_role;
revoke all on function public.financeiro_arquivar_produto(uuid,uuid,uuid,integer,text,uuid) from public,anon,authenticated,service_role;
revoke all on function public.financeiro_restaurar_produto(uuid,uuid,uuid,integer,text,uuid) from public,anon,authenticated,service_role;
revoke all on function public.prontuario_enfileirar_gc_foto_orfa(uuid,uuid,text,text,uuid,uuid,text,text,text,uuid) from public,anon,authenticated,service_role;

grant execute on function public.prontuario_substituir_produtos(uuid,uuid,text,text,uuid,integer,jsonb,uuid) to service_role;
grant execute on function public.financeiro_criar_compra(uuid,uuid,uuid,date,text,text,smallint,text,text,jsonb,uuid,uuid,numeric,boolean,text,uuid) to service_role;
grant execute on function public.financeiro_cancelar_compra(uuid,uuid,uuid,integer,text,uuid,uuid) to service_role;
grant execute on function public.financeiro_regularizar_item_compra_estoque(uuid,uuid,uuid,text,date,boolean,uuid,text,uuid) to service_role;
grant execute on function public.operacao_registrar_evento_consumo(uuid,uuid,text,text,text,uuid,uuid,uuid,text,numeric,text,text,text,timestamptz,uuid,uuid) to service_role;
grant execute on function public.financeiro_editar_produto(uuid,uuid,uuid,integer,uuid,text,text,text,text,text,numeric,numeric,text,boolean,text,uuid) to service_role;
grant execute on function public.financeiro_arquivar_produto(uuid,uuid,uuid,integer,text,uuid) to service_role;
grant execute on function public.financeiro_restaurar_produto(uuid,uuid,uuid,integer,text,uuid) to service_role;
grant execute on function public.prontuario_enfileirar_gc_foto_orfa(uuid,uuid,text,text,uuid,uuid,text,text,text,uuid) to service_role;

comment on table public.clinical_photo_object_gc_queue is
  'Fila auditavel, com espera minima, para revisar objetos clinicos sem referencia; nenhum delete automatico.';
commit;

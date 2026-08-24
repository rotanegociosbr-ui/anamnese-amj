begin;

-- Serializa a manutencao do par produto/lote com a ativacao ou restauracao de
-- fotos. Sem o lock compartilhado, duas transacoes concorrentes poderiam
-- validar snapshots diferentes e confirmar um estado final incoerente.
create or replace function private.prontuario_enforce_active_photo_product_context()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_protocol_id uuid;
begin
  if tg_table_schema = 'public' and tg_table_name = 'protocol_products' then
    v_protocol_id := old.protocol_id;
  elsif tg_table_schema = 'public' and tg_table_name = 'protocol_photos' then
    v_protocol_id := new.protocol_id;
  else
    raise exception 'active_photo_product_context_trigger_invalid'
      using errcode = '55000';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'amj-prontuario-product-photo:' || v_protocol_id::text,
      0
    )
  );

  if tg_table_name = 'protocol_products' then
    if exists (
      select 1
      from public.protocol_photos photo
      where photo.protocol_id = old.protocol_id
        and photo.phase = 'products_used'
        and photo.archived_at is null
        and photo.product_id = old.product_id
        and photo.lot_snapshot = old.lot
    ) and not exists (
      select 1
      from public.protocol_products item
      where item.protocol_id = old.protocol_id
        and item.product_id = old.product_id
        and item.lot = old.lot
    ) then
      raise exception 'protocol_product_referenced_by_active_photo'
        using errcode = '23503',
              hint = 'Archive ou corrija a foto de produto antes de alterar o produto ou lote.';
    end if;
    return null;
  end if;

  if new.phase = 'products_used'
     and new.archived_at is null
     and new.product_id is not null
     and new.lot_snapshot is not null
     and not exists (
       select 1
       from public.protocol_products item
       where item.protocol_id = new.protocol_id
         and item.product_id = new.product_id
         and item.lot = new.lot_snapshot
     ) then
    raise exception 'photo_product_context_invalid' using errcode = '23503';
  end if;
  return null;
end;
$function$;

revoke all on function private.prontuario_enforce_active_photo_product_context()
  from public, anon, authenticated, service_role;

commit;

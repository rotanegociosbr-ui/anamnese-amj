begin;

-- Uma foto geral da bandeja continua valida sem vinculo. Quando houver vinculo,
-- produto e lote formam uma unica referencia documental e nao podem ser
-- gravados parcialmente. A correspondencia exata com protocol_products segue
-- validada pelo RPC prontuario_registrar_foto, unica rota de escrita concedida.
alter table public.protocol_photos
  add constraint protocol_photos_product_lot_pair_check check (
    (
      phase = 'products_used'
      and (
        (product_id is null and lot_snapshot is null)
        or (product_id is not null and lot_snapshot is not null)
      )
    )
    or (
      phase <> 'products_used'
      and product_id is null
      and lot_snapshot is null
    )
  ) not valid;

-- Falha fechado se houver legado ambiguo; a migration nunca corrige ou inventa
-- produto/lote de uma imagem existente.
alter table public.protocol_photos
  validate constraint protocol_photos_product_lot_pair_check;

alter table public.protocol_photos
  drop constraint protocol_photos_product_context_check;

alter table public.protocol_photos
  rename constraint protocol_photos_product_lot_pair_check
  to protocol_photos_product_context_check;

comment on constraint protocol_photos_product_context_check
  on public.protocol_photos is
  'Foto de produto pode ser geral (sem vinculo) ou referenciar produto e lote juntos; o RPC valida o par no protocolo.';

-- Nao instala a invariante sobre um estado legado ja incoerente e nao tenta
-- escolher silenciosamente qual produto/lote uma foto deveria referenciar.
do $migration$
begin
  if exists (
    select 1
    from public.protocol_photos photo
    where photo.phase = 'products_used'
      and photo.archived_at is null
      and photo.product_id is not null
      and photo.lot_snapshot is not null
      and not exists (
        select 1
        from public.protocol_products item
        where item.protocol_id = photo.protocol_id
          and item.product_id = photo.product_id
          and item.lot = photo.lot_snapshot
      )
  ) then
    raise exception 'active_photo_product_context_preflight_failed'
      using errcode = '23514',
            hint = 'Arquive ou corrija as fotos de produto inconsistentes antes de aplicar esta migration.';
  end if;
end;
$migration$;

-- Mantem a referencia valida tambem depois do upload. A funcao e compartilhada
-- pelos dois lados da relacao para cobrir tanto a manutencao da lista quanto a
-- restauracao de uma foto anteriormente arquivada.
create or replace function private.prontuario_enforce_active_photo_product_context()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if tg_table_schema = 'public' and tg_table_name = 'protocol_products' then
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

  if tg_table_schema = 'public' and tg_table_name = 'protocol_photos' then
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
  end if;

  raise exception 'active_photo_product_context_trigger_invalid'
    using errcode = '55000';
end;
$function$;

revoke all on function private.prontuario_enforce_active_photo_product_context()
  from public, anon, authenticated, service_role;

-- O replace canonico apaga e reinsere os itens na mesma transacao. Por ser
-- diferido, o trigger enxerga o estado final e permite a mesma associacao.
create constraint trigger protocol_products_preserve_active_photo_context
after delete or update on public.protocol_products
deferrable initially deferred
for each row
execute function private.prontuario_enforce_active_photo_product_context();

-- Garante a mesma invariante ao inserir ou restaurar uma foto. Fotos gerais e
-- fotos arquivadas nao exigem uma linha atual em protocol_products.
create constraint trigger protocol_photos_require_active_product_context
after insert or update on public.protocol_photos
deferrable initially deferred
for each row
execute function private.prontuario_enforce_active_photo_product_context();

commit;

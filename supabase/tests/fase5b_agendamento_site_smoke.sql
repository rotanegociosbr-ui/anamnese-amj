begin;

do $test$
declare
  v_private_columns text[];
  v_receive_oid regprocedure;
  v_list_oid regprocedure;
begin
  if pg_catalog.to_regclass('private.crm_site_booking_requests') is null
     or pg_catalog.to_regclass('private.crm_site_booking_replays') is null
     or pg_catalog.to_regclass('private.crm_site_booking_operations') is null then
    raise exception 'fase5b_private_tables_missing';
  end if;

  select pg_catalog.array_agg(column_name order by ordinal_position)
  into v_private_columns
  from information_schema.columns
  where table_schema = 'private' and table_name = 'crm_site_booking_requests';
  if 'objetivo' = any(v_private_columns) or 'objective' = any(v_private_columns) then
    raise exception 'fase5b_free_text_must_not_be_persisted';
  end if;

  v_receive_oid := pg_catalog.to_regprocedure(
    'public.crm_site_booking_receive(uuid,text,text,text,text,date,text,boolean,text,timestamp with time zone,uuid,text,text)'
  );
  v_list_oid := pg_catalog.to_regprocedure(
    'public.crm_site_booking_list(uuid,uuid,text,integer,integer)'
  );
  if v_receive_oid is null or v_list_oid is null then
    raise exception 'fase5b_rpc_missing';
  end if;
  if pg_catalog.has_function_privilege('anon', v_receive_oid, 'EXECUTE')
     or pg_catalog.has_function_privilege('authenticated', v_receive_oid, 'EXECUTE')
     or not pg_catalog.has_function_privilege('service_role', v_receive_oid, 'EXECUTE') then
    raise exception 'fase5b_receive_privileges_invalid';
  end if;
  if pg_catalog.has_function_privilege('authenticated', v_list_oid, 'EXECUTE')
     or not pg_catalog.has_function_privilege('service_role', v_list_oid, 'EXECUTE') then
    raise exception 'fase5b_list_privileges_invalid';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_indexes index_row
    where index_row.schemaname = 'private'
      and index_row.indexname = 'crm_site_booking_requests_pending_exact_unique'
      and index_row.indexdef ilike '%unique%'
      and index_row.indexdef ilike '%where (status = ''pending''%'
  ) then
    raise exception 'fase5b_pending_dedup_index_missing';
  end if;

  if exists (
    select 1
    from information_schema.role_table_grants grant_row
    where grant_row.table_schema = 'private'
      and grant_row.table_name like 'crm_site_booking%'
      and grant_row.grantee in ('anon', 'authenticated')
  ) then
    raise exception 'fase5b_private_table_exposed';
  end if;
end;
$test$;

rollback;

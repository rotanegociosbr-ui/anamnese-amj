begin;

do $test$
declare
  v_table text;
  v_policy_count integer;
begin
  foreach v_table in array array['protocol_points', 'protocol_signatures']
  loop
    if not exists (
      select 1
      from pg_catalog.pg_class as relation
      join pg_catalog.pg_namespace as namespace
        on namespace.oid = relation.relnamespace
      where namespace.nspname = 'public'
        and relation.relname = v_table
        and relation.relkind = 'r'
        and relation.relrowsecurity
    ) then
      raise exception 'rls_disabled:%', v_table;
    end if;

    if not pg_catalog.has_table_privilege(
      'authenticated', 'public.' || v_table, 'SELECT'
    ) then
      raise exception 'authenticated_select_missing:%', v_table;
    end if;

    if pg_catalog.has_table_privilege(
      'authenticated', 'public.' || v_table, 'INSERT'
    ) or pg_catalog.has_table_privilege(
      'authenticated', 'public.' || v_table, 'UPDATE'
    ) or pg_catalog.has_table_privilege(
      'authenticated', 'public.' || v_table, 'DELETE'
    ) then
      raise exception 'authenticated_direct_write_found:%', v_table;
    end if;

    if pg_catalog.has_table_privilege('anon', 'public.' || v_table, 'INSERT')
       or pg_catalog.has_table_privilege('anon', 'public.' || v_table, 'UPDATE')
       or pg_catalog.has_table_privilege('anon', 'public.' || v_table, 'DELETE') then
      raise exception 'anon_direct_write_found:%', v_table;
    end if;

    -- Edge Functions usam service_role; o hardening nao pode quebrar essa via.
    if not pg_catalog.has_table_privilege(
      'service_role', 'public.' || v_table, 'SELECT'
    ) or not pg_catalog.has_table_privilege(
      'service_role', 'public.' || v_table, 'INSERT'
    ) or not pg_catalog.has_table_privilege(
      'service_role', 'public.' || v_table, 'UPDATE'
    ) or not pg_catalog.has_table_privilege(
      'service_role', 'public.' || v_table, 'DELETE'
    ) then
      raise exception 'service_role_backend_privilege_missing:%', v_table;
    end if;

    select pg_catalog.count(*)::integer
      into v_policy_count
    from pg_catalog.pg_policies
    where schemaname = 'public'
      and tablename = v_table
      and cmd <> 'SELECT';

    if v_policy_count <> 0 then
      raise exception 'direct_write_policy_found:%', v_table;
    end if;
  end loop;

  if not exists (
    select 1
    from pg_catalog.pg_policies
    where schemaname = 'public'
      and tablename = 'protocol_points'
      and policyname = 'protocol_points_select_active_member'
      and cmd = 'SELECT'
      and roles = array['authenticated']::name[]
  ) then
    raise exception 'protocol_points_select_policy_missing';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_policies
    where schemaname = 'public'
      and tablename = 'protocol_signatures'
      and policyname = 'protocol_signatures_select'
      and cmd = 'SELECT'
      and roles = array['authenticated']::name[]
  ) then
    raise exception 'protocol_signatures_select_policy_missing';
  end if;
end;
$test$;

rollback;

\set ON_ERROR_STOP on

-- Teste destrutivo somente para banco local/descartavel com dados sinteticos.

insert into auth.users (id) values
  ('11111111-1111-4111-8111-111111111111'),
  ('22222222-2222-4222-8222-222222222222'),
  ('33333333-3333-4333-8333-333333333333'),
  ('44444444-4444-4444-8444-444444444444');

insert into auth.sessions (id, user_id) values
  (
    '91111111-1111-4111-8111-111111111111',
    '11111111-1111-4111-8111-111111111111'
  );

insert into public.clinics (
  id, slug, name, city, created_by
) values
  (
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'clinica-a',
    'Clinica A',
    'Cidade A',
    '11111111-1111-4111-8111-111111111111'
  ),
  (
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    'clinica-b',
    'Clinica B',
    'Cidade B',
    '22222222-2222-4222-8222-222222222222'
  );

insert into public.clinic_members (
  clinic_id, user_id, role, status, display_name
) values
  (
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '11111111-1111-4111-8111-111111111111',
    'owner',
    'active',
    'Owner Um'
  ),
  (
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '33333333-3333-4333-8333-333333333333',
    'viewer',
    'active',
    'Viewer Tres'
  ),
  (
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    '22222222-2222-4222-8222-222222222222',
    'owner',
    'active',
    'Owner Dois'
  );

do $test$
declare
  policy_count integer;
  unsafe_count integer;
begin
  select count(*) into policy_count
  from pg_policies
  where schemaname = 'public'
    and tablename in ('clinics', 'clinic_members', 'clinic_audit_log');

  if policy_count <> 9 then
    raise exception 'esperado 9 policies RBAC; obtido %', policy_count;
  end if;

  select count(*) into unsafe_count
  from pg_policies
  where schemaname = 'public'
    and tablename in ('clinics', 'clinic_members')
    and cmd = 'UPDATE'
    and with_check is null;

  if unsafe_count <> 0 then
    raise exception 'UPDATE policy sem WITH CHECK encontrada';
  end if;

  if exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'clinic_audit_log'
      and cmd = 'INSERT'
      and 'authenticated' = any(roles)
  ) then
    raise exception 'authenticated ainda possui policy INSERT na auditoria';
  end if;

  if (
    select count(*)
    from pg_policies
    where schemaname = 'public'
      and tablename in ('clinics', 'clinic_members', 'clinic_audit_log')
      and policyname like '%require_aal2'
      and permissive = 'RESTRICTIVE'
  ) <> 3 then
    raise exception 'as tres policies restritivas AAL2 nao foram criadas';
  end if;

  if has_table_privilege('anon', 'public.clinics', 'SELECT')
     or has_table_privilege('anon', 'public.clinic_members', 'SELECT')
     or has_table_privilege('anon', 'public.clinic_audit_log', 'SELECT') then
    raise exception 'anon recebeu acesso RBAC';
  end if;

  if has_table_privilege(
    'authenticated', 'public.clinic_audit_log', 'INSERT'
  ) then
    raise exception 'authenticated recebeu INSERT direto na auditoria';
  end if;

  if not has_table_privilege(
    'service_role', 'public.clinic_audit_log', 'INSERT'
  ) or has_table_privilege(
    'service_role', 'public.clinic_audit_log', 'UPDATE'
  ) or has_table_privilege(
    'service_role', 'public.clinic_audit_log', 'DELETE'
  ) then
    raise exception 'grants append-only do service_role estao incorretos';
  end if;

  if has_column_privilege(
    'authenticated', 'public.clinics', 'slug', 'UPDATE'
  ) or not has_column_privilege(
    'authenticated', 'public.clinics', 'name', 'UPDATE'
  ) then
    raise exception 'grants por coluna de clinics estao incorretos';
  end if;

  if has_function_privilege(
    'authenticated',
    'public.clinic_validate_auth_session(uuid,uuid)',
    'EXECUTE'
  ) or not has_function_privilege(
    'service_role',
    'public.clinic_validate_auth_session(uuid,uuid)',
    'EXECUTE'
  ) then
    raise exception 'EXECUTE da RPC de sessao esta incorreto';
  end if;

  if not has_function_privilege(
    'authenticated', 'private.is_clinic_member(uuid)', 'EXECUTE'
  ) or has_function_privilege(
    'service_role', 'private.is_clinic_member(uuid)', 'EXECUTE'
  ) then
    raise exception 'EXECUTE do helper privado para RLS esta incorreto';
  end if;

  if has_schema_privilege('authenticated', 'private', 'USAGE')
     or has_schema_privilege('anon', 'private', 'USAGE')
     or has_schema_privilege('service_role', 'private', 'USAGE') then
    raise exception 'schema private ficou acessivel diretamente';
  end if;

  if exists (
    select 1
    from pg_proc as procedure
    join pg_namespace as namespace
      on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'private'
      and procedure.proname in (
        'is_clinic_member',
        'is_clinic_owner',
        'can_write_clinic',
        'protect_last_active_clinic_owner',
        'reject_clinic_audit_mutation'
      )
      and not ('search_path=""' = any(procedure.proconfig))
  ) then
    raise exception 'SECURITY DEFINER privado sem search_path vazio';
  end if;
end
$test$;

-- AAL1 deve falhar fechado mesmo para owner ativo.
set role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '11111111-1111-4111-8111-111111111111',
  false
);
select set_config(
  'request.jwt.claims',
  '{"sub":"11111111-1111-4111-8111-111111111111","aal":"aal1"}',
  false
);

do $test$
declare
  visible_count integer;
begin
  select count(*) into visible_count from public.clinics;
  if visible_count <> 0 then
    raise exception 'AAL1 enxergou clinics';
  end if;
end
$test$;

-- AAL2 enxerga somente o tenant do usuario.
select set_config(
  'request.jwt.claims',
  '{"sub":"11111111-1111-4111-8111-111111111111","aal":"aal2"}',
  false
);

do $test$
declare
  affected integer;
  visible_count integer;
  denied boolean := false;
begin
  select count(*) into visible_count from public.clinics;
  if visible_count <> 1 then
    raise exception 'owner AAL2 deveria enxergar exatamente uma clinica';
  end if;

  update public.clinics
  set city = 'Cidade A Atualizada'
  where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  get diagnostics affected = row_count;
  if affected <> 1 then
    raise exception 'owner nao atualizou a propria clinica';
  end if;

  update public.clinics
  set city = 'Ataque Cruzado'
  where id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  get diagnostics affected = row_count;
  if affected <> 0 then
    raise exception 'owner alterou outra clinica';
  end if;

  begin
    update public.clinics
    set slug = 'slug-adulterado'
    where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  exception when insufficient_privilege then
    denied := true;
  end;
  if not denied then
    raise exception 'owner conseguiu alterar slug protegido';
  end if;

  denied := false;
  begin
    insert into public.clinic_members (
      clinic_id, user_id, role, status, display_name
    ) values (
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      '44444444-4444-4444-8444-444444444444',
      'viewer',
      'active',
      'Cross Tenant'
    );
  exception when insufficient_privilege then
    denied := true;
  end;
  if not denied then
    raise exception 'owner inseriu membro em outra clinica';
  end if;

  insert into public.clinic_members (
    clinic_id, user_id, role, status, display_name
  ) values (
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '44444444-4444-4444-8444-444444444444',
    'owner',
    'active',
    'Owner Quatro'
  );

  denied := false;
  begin
    insert into public.clinic_audit_log (
      clinic_id, actor, entity, action, details,
      actor_role, auth_method, outcome, request_id
    ) values (
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      '11111111-1111-4111-8111-111111111111',
      'clinic',
      'forbidden.client.insert',
      '{}'::jsonb,
      'owner',
      'supabase_auth',
      'success',
      gen_random_uuid()
    );
  exception when insufficient_privilege then
    denied := true;
  end;
  if not denied then
    raise exception 'authenticated inseriu auditoria diretamente';
  end if;
end
$test$;

reset role;

-- Viewer AAL2 pode ler o tenant, mas nao administrar.
set role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '33333333-3333-4333-8333-333333333333',
  false
);
select set_config(
  'request.jwt.claims',
  '{"sub":"33333333-3333-4333-8333-333333333333","aal":"aal2"}',
  false
);

do $test$
declare
  affected integer;
begin
  update public.clinics
  set city = 'Viewer Nao Pode'
  where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  get diagnostics affected = row_count;
  if affected <> 0 then
    raise exception 'viewer administrou clinica';
  end if;

  update public.clinic_members
  set display_name = 'Viewer Alterou'
  where clinic_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    and user_id = '33333333-3333-4333-8333-333333333333';
  get diagnostics affected = row_count;
  if affected <> 0 then
    raise exception 'viewer administrou membership';
  end if;
end
$test$;

reset role;

-- Somente o servidor grava a trilha, usando metadados tecnicos permitidos.
set role service_role;

insert into public.clinic_audit_log (
  clinic_id, actor, entity, entity_id, action, details,
  actor_role, auth_method, outcome, request_id
) values (
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  '11111111-1111-4111-8111-111111111111',
  'clinic',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'clinic.read',
  '{"source":"painel-fichas","endpoint":"painel-fichas","status_code":200,"target_kind":"clinic","result_count":1,"idempotent":false}'::jsonb,
  'owner',
  'supabase_auth',
  'success',
  '81111111-1111-4111-8111-111111111111'
);

insert into public.clinic_audit_log (
  clinic_id, actor, entity, entity_id, action, details,
  actor_role, auth_method, outcome, request_id
) values (
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  '22222222-2222-4222-8222-222222222222',
  'clinic',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  'clinic.read',
  '{"source":"painel-fichas","http_status":200}'::jsonb,
  'owner',
  'supabase_auth',
  'success',
  '83333333-3333-4333-8333-333333333333'
);

do $test$
declare
  denied boolean := false;
begin
  if not public.clinic_validate_auth_session(
    '11111111-1111-4111-8111-111111111111',
    '91111111-1111-4111-8111-111111111111'
  ) then
    raise exception 'sessao valida foi recusada';
  end if;

  if public.clinic_validate_auth_session(
    '11111111-1111-4111-8111-111111111111',
    '92222222-2222-4222-8222-222222222222'
  ) then
    raise exception 'sessao inexistente foi aceita';
  end if;

  begin
    insert into public.clinic_audit_log (
      clinic_id, actor, entity, action, details,
      actor_role, auth_method, outcome, request_id
    ) values (
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      '11111111-1111-4111-8111-111111111111',
      'clinic',
      'clinic.read',
      '{"patient_name":"Nao Pode"}'::jsonb,
      'owner',
      'supabase_auth',
      'success',
      gen_random_uuid()
    );
  exception when check_violation then
    denied := true;
  end;
  if not denied then
    raise exception 'details aceitou chave com PHI';
  end if;
end
$test$;

reset role;

-- A leitura da auditoria tambem respeita o tenant.
set role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '11111111-1111-4111-8111-111111111111',
  false
);
select set_config(
  'request.jwt.claims',
  '{"sub":"11111111-1111-4111-8111-111111111111","aal":"aal2"}',
  false
);

do $test$
declare
  visible_count integer;
begin
  select count(*) into visible_count from public.clinic_audit_log;
  if visible_count <> 1 then
    raise exception 'auditoria vazou entre clinicas';
  end if;
end
$test$;

reset role;

-- Trigger protege a imutabilidade mesmo contra o owner da tabela.
do $test$
declare
  denied boolean := false;
begin
  begin
    update public.clinic_audit_log
    set outcome = 'error'
    where request_id = '81111111-1111-4111-8111-111111111111';
  exception when insufficient_privilege then
    denied := true;
  end;
  if not denied then
    raise exception 'auditoria foi alterada';
  end if;

  denied := false;
  begin
    update public.clinic_members
    set status = 'suspended'
    where clinic_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
      and user_id = '22222222-2222-4222-8222-222222222222';
  exception when check_violation then
    denied := true;
  end;
  if not denied then
    raise exception 'ultimo owner ativo foi suspenso';
  end if;
end
$test$;

select 'auth_mfa_rbac_hardening_smoke: PASS' as result;

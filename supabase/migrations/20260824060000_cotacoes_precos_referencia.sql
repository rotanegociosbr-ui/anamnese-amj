-- Cotações históricas e preços de referência.
--
-- Este módulo é deliberadamente separado do livro autoritativo de custos reais
-- (`financeiro_produto_custos`), dos lotes e do frete. Importar uma tabela de
-- fornecedor nunca altera custo corrente, estoque, preço de venda ou produto.

begin;

create or replace function private.cotacoes_normalizar_identidade(p_value text)
returns text
language sql
immutable
strict
set search_path = ''
as $$
  select pg_catalog.btrim(
    pg_catalog.regexp_replace(
      pg_catalog.translate(
        pg_catalog.lower(p_value),
        'áàâãäéèêëíìîïóòôõöúùûüçñ',
        'aaaaaeeeeiiiiooooouuuucn'
      ),
      '[^a-z0-9]+',
      '',
      'g'
    )
  );
$$;

create or replace function private.cotacoes_sha256(p_value text)
returns text
language sql
immutable
strict
set search_path = ''
as $$
  select pg_catalog.encode(
    extensions.digest(pg_catalog.convert_to(p_value, 'UTF8'), 'sha256'),
    'hex'
  );
$$;

revoke all on function private.cotacoes_normalizar_identidade(text)
  from public, anon, authenticated, service_role;
revoke all on function private.cotacoes_sha256(text)
  from public, anon, authenticated, service_role;
grant execute on function private.cotacoes_normalizar_identidade(text) to service_role;
grant execute on function private.cotacoes_sha256(text) to service_role;

create table public.cotacao_fontes (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete restrict,
  source_name text not null check (
    pg_catalog.char_length(pg_catalog.btrim(source_name)) between 2 and 200
    and source_name !~ '[[:cntrl:]]'
  ),
  supplier_name text check (
    supplier_name is null or (
      pg_catalog.char_length(pg_catalog.btrim(supplier_name)) between 2 and 160
      and supplier_name !~ '[[:cntrl:]]'
    )
  ),
  source_type text not null check (
    source_type in ('pdf', 'imagem', 'texto_fornecido', 'planilha', 'outro')
  ),
  file_name text not null check (
    pg_catalog.char_length(pg_catalog.btrim(file_name)) between 1 and 255
    and file_name !~ '[[:cntrl:]]'
  ),
  file_sha256 text not null check (file_sha256 ~ '^[0-9a-f]{64}$'),
  source_date date not null,
  revision text check (
    revision is null or (
      pg_catalog.char_length(pg_catalog.btrim(revision)) between 1 and 80
      and revision !~ '[[:cntrl:]]'
    )
  ),
  page_count integer check (page_count is null or page_count between 1 and 10000),
  project_relative_path text check (
    project_relative_path is null or (
      pg_catalog.char_length(project_relative_path) between 1 and 600
      and project_relative_path !~ '[[:cntrl:]]'
      and project_relative_path !~ '(^|[\\/])\.\.([\\/]|$)'
      and project_relative_path !~ '^[A-Za-z]:'
    )
  ),
  status text not null default 'pendente_revisao' check (
    status in ('importada', 'parcial', 'pendente_revisao', 'rejeitada')
  ),
  notes text check (
    notes is null or (
      pg_catalog.char_length(notes) <= 2000 and notes !~ '[[:cntrl:]]'
    )
  ),
  created_at timestamptz not null default now(),
  last_imported_at timestamptz,
  constraint cotacao_fontes_clinic_id_id_key unique (clinic_id, id),
  constraint cotacao_fontes_sha_unique unique (clinic_id, file_sha256)
);

create table public.cotacao_importacoes (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete restrict,
  source_id uuid not null,
  import_fingerprint text not null check (import_fingerprint ~ '^[0-9a-f]{64}$'),
  parser_version text not null check (
    pg_catalog.char_length(pg_catalog.btrim(parser_version)) between 1 and 80
    and parser_version !~ '[[:cntrl:]]'
  ),
  status text not null check (
    status in ('processando', 'concluida', 'parcial', 'falha')
  ),
  attempt_count integer not null default 1 check (attempt_count > 0),
  source_line_count integer not null default 0 check (source_line_count >= 0),
  inserted_evidence_count integer not null default 0 check (inserted_evidence_count >= 0),
  idempotent_evidence_count integer not null default 0 check (idempotent_evidence_count >= 0),
  consolidated_duplicate_count integer not null default 0 check (
    consolidated_duplicate_count >= 0
  ),
  conflict_count integer not null default 0 check (conflict_count >= 0),
  report jsonb not null default '{}'::jsonb check (
    pg_catalog.jsonb_typeof(report) = 'object'
    and pg_catalog.pg_column_size(report) <= 65536
  ),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint cotacao_importacoes_clinic_id_id_key unique (clinic_id, id),
  constraint cotacao_importacoes_source_fk
    foreign key (clinic_id, source_id)
    references public.cotacao_fontes (clinic_id, id) on delete restrict,
  constraint cotacao_importacoes_fingerprint_unique
    unique (clinic_id, import_fingerprint)
);

-- Um item é a identidade canônica dentro de uma fonte. Quando a fonte traz um
-- código, ele prevalece para consolidar repetições do mesmo item em páginas
-- diferentes. A identidade completa do SKU continua guardada separadamente.
create table public.cotacao_itens (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete restrict,
  source_id uuid not null,
  source_code text check (
    source_code is null or (
      pg_catalog.char_length(pg_catalog.btrim(source_code)) between 1 and 80
      and source_code !~ '[[:cntrl:]]'
    )
  ),
  brand text,
  item_name text not null check (
    pg_catalog.char_length(pg_catalog.btrim(item_name)) between 1 and 300
    and item_name !~ '[[:cntrl:]]'
  ),
  composition text,
  concentration text,
  presentation text,
  package_quantity numeric(14,4) check (
    package_quantity is null or package_quantity > 0
  ),
  package_unit text,
  canonical_item_key text not null check (canonical_item_key ~ '^[0-9a-f]{64}$'),
  exact_sku_key text check (exact_sku_key is null or exact_sku_key ~ '^[0-9a-f]{64}$'),
  exact_match_eligible boolean not null default false,
  review_status text not null default 'pendente_revisao' check (
    review_status in ('pendente_revisao', 'aprovado_exato', 'conflito', 'rejeitado')
  ),
  review_reason text check (
    review_reason is null or (
      pg_catalog.char_length(review_reason) <= 1000
      and review_reason !~ '[[:cntrl:]]'
    )
  ),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  constraint cotacao_itens_clinic_id_id_key unique (clinic_id, id),
  constraint cotacao_itens_source_fk
    foreign key (clinic_id, source_id)
    references public.cotacao_fontes (clinic_id, id) on delete restrict,
  constraint cotacao_itens_canonical_unique
    unique (clinic_id, source_id, canonical_item_key),
  constraint cotacao_itens_exact_fields_check check (
    not exact_match_eligible
    or (
      exact_sku_key is not null
      and brand is not null and pg_catalog.btrim(brand) <> ''
      and pg_catalog.btrim(item_name) <> ''
      and composition is not null and pg_catalog.btrim(composition) <> ''
      and concentration is not null and pg_catalog.btrim(concentration) <> ''
      and presentation is not null and pg_catalog.btrim(presentation) <> ''
      and package_quantity is not null
      and package_unit is not null and pg_catalog.btrim(package_unit) <> ''
    )
  )
);

-- Cada linha/página é uma evidência imutável. O fingerprint inclui arquivo,
-- página/linha, código, identidade/presentação, condição e data. O preço não
-- faz parte da chave: o mesmo arquivo não pode reescrever silenciosamente uma
-- evidência já importada com outro valor.
create table public.cotacao_precos (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete restrict,
  source_id uuid not null,
  import_id uuid not null,
  item_id uuid not null,
  page_number integer check (page_number is null or page_number between 1 and 10000),
  line_reference text not null check (
    pg_catalog.char_length(pg_catalog.btrim(line_reference)) between 1 and 100
    and line_reference !~ '[[:cntrl:]]'
  ),
  quote_date date not null,
  commercial_condition text not null default 'preco_tabela' check (
    pg_catalog.char_length(pg_catalog.btrim(commercial_condition)) between 1 and 160
    and commercial_condition !~ '[[:cntrl:]]'
  ),
  price numeric(14,2) not null check (price > 0 and price <= 999999999999.99),
  currency text not null default 'BRL' check (currency = 'BRL'),
  evidence_fingerprint text not null check (evidence_fingerprint ~ '^[0-9a-f]{64}$'),
  extraction_status text not null default 'verificado_fonte' check (
    extraction_status in ('verificado_fonte', 'pendente_revisao', 'conflito', 'rejeitado')
  ),
  raw_evidence jsonb not null default '{}'::jsonb check (
    pg_catalog.jsonb_typeof(raw_evidence) = 'object'
    and pg_catalog.pg_column_size(raw_evidence) <= 65536
  ),
  imported_at timestamptz not null default now(),
  constraint cotacao_precos_clinic_id_id_key unique (clinic_id, id),
  constraint cotacao_precos_source_fk
    foreign key (clinic_id, source_id)
    references public.cotacao_fontes (clinic_id, id) on delete restrict,
  constraint cotacao_precos_import_fk
    foreign key (clinic_id, import_id)
    references public.cotacao_importacoes (clinic_id, id) on delete restrict,
  constraint cotacao_precos_item_fk
    foreign key (clinic_id, item_id)
    references public.cotacao_itens (clinic_id, id) on delete restrict,
  constraint cotacao_precos_evidence_unique
    unique (clinic_id, evidence_fingerprint)
);

-- O vínculo é sempre confirmação manual de identidade completa. Ele nunca cria
-- produto nem ativa cadastro. O snapshot torna a revisão auditável.
create table public.cotacao_sku_vinculos (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete restrict,
  exact_sku_key text not null check (exact_sku_key ~ '^[0-9a-f]{64}$'),
  product_id uuid not null,
  identity_snapshot jsonb not null check (
    pg_catalog.jsonb_typeof(identity_snapshot) = 'object'
    and pg_catalog.pg_column_size(identity_snapshot) <= 16384
  ),
  confirmed_by uuid not null references auth.users(id) on delete restrict,
  confirmed_at timestamptz not null default now(),
  notes text check (
    notes is null or (
      pg_catalog.char_length(notes) <= 1000 and notes !~ '[[:cntrl:]]'
    )
  ),
  constraint cotacao_sku_vinculos_clinic_id_id_key unique (clinic_id, id),
  constraint cotacao_sku_vinculos_product_fk
    foreign key (clinic_id, product_id)
    references public.financeiro_produtos (clinic_id, id) on delete restrict,
  constraint cotacao_sku_vinculos_sku_unique unique (clinic_id, exact_sku_key),
  constraint cotacao_sku_vinculos_product_unique unique (clinic_id, product_id)
);

create or replace function private.cotacoes_validar_vinculo_exato()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_snapshot_key text;
  v_product_name text;
  v_product_presentation text;
  v_product_unit text;
  v_product_brand text;
  v_quantity numeric(14,4);
begin
  if not exists (
    select 1
    from public.clinic_members member
    where member.clinic_id = new.clinic_id
      and member.user_id = new.confirmed_by
      and member.role = 'owner'
      and member.status = 'active'
  ) then
    raise exception 'confirmador_nao_e_proprietario_ativo' using errcode = '42501';
  end if;

  v_quantity := nullif(new.identity_snapshot->>'package_quantity', '')::numeric;
  if new.identity_snapshot->>'brand' is null
     or new.identity_snapshot->>'name' is null
     or new.identity_snapshot->>'composition' is null
     or new.identity_snapshot->>'concentration' is null
     or new.identity_snapshot->>'presentation' is null
     or v_quantity is null or v_quantity <= 0
     or new.identity_snapshot->>'package_unit' is null then
    raise exception 'snapshot_sku_incompleto' using errcode = '22023';
  end if;

  v_snapshot_key := private.cotacoes_sha256(
    private.cotacoes_normalizar_identidade(new.identity_snapshot->>'brand') || '|'
    || private.cotacoes_normalizar_identidade(new.identity_snapshot->>'name') || '|'
    || private.cotacoes_normalizar_identidade(new.identity_snapshot->>'composition') || '|'
    || private.cotacoes_normalizar_identidade(new.identity_snapshot->>'concentration') || '|'
    || private.cotacoes_normalizar_identidade(new.identity_snapshot->>'presentation') || '|'
    || private.cotacoes_normalizar_identidade(v_quantity::numeric(14,4)::text) || '|'
    || private.cotacoes_normalizar_identidade(new.identity_snapshot->>'package_unit')
  );

  if v_snapshot_key <> new.exact_sku_key or not exists (
    select 1
    from public.cotacao_itens item
    where item.clinic_id = new.clinic_id
      and item.exact_sku_key = new.exact_sku_key
      and item.exact_match_eligible
      and item.review_status not in ('conflito', 'rejeitado')
  ) then
    raise exception 'sku_exato_nao_confirmado' using errcode = '22023';
  end if;

  select
    product.name,
    product.presentation,
    product.unit,
    brand.name
  into
    v_product_name,
    v_product_presentation,
    v_product_unit,
    v_product_brand
  from public.financeiro_produtos product
  left join public.financeiro_marcas brand
    on brand.clinic_id = product.clinic_id and brand.id = product.brand_id
  where product.clinic_id = new.clinic_id
    and product.id = new.product_id
    and product.active
    and product.archived_at is null;

  if v_product_name is null
     or v_product_presentation is null
     or v_product_brand is null
     or private.cotacoes_normalizar_identidade(v_product_name)
          <> private.cotacoes_normalizar_identidade(new.identity_snapshot->>'name')
     or private.cotacoes_normalizar_identidade(v_product_presentation)
          <> private.cotacoes_normalizar_identidade(new.identity_snapshot->>'presentation')
     or private.cotacoes_normalizar_identidade(v_product_unit)
          <> private.cotacoes_normalizar_identidade(new.identity_snapshot->>'package_unit')
     or private.cotacoes_normalizar_identidade(v_product_brand)
          <> private.cotacoes_normalizar_identidade(new.identity_snapshot->>'brand') then
    raise exception 'produto_nao_corresponde_ao_sku_exato' using errcode = '22023';
  end if;

  return new;
end;
$$;

revoke all on function private.cotacoes_validar_vinculo_exato()
  from public, anon, authenticated, service_role;

create trigger cotacao_sku_vinculos_validar_exato
before insert or update on public.cotacao_sku_vinculos
for each row execute function private.cotacoes_validar_vinculo_exato();

create index cotacao_fontes_status_date_idx
  on public.cotacao_fontes (clinic_id, status, source_date desc);
create index cotacao_importacoes_source_started_idx
  on public.cotacao_importacoes (clinic_id, source_id, started_at desc);
create index cotacao_itens_review_name_idx
  on public.cotacao_itens (clinic_id, review_status, item_name);
create index cotacao_itens_exact_sku_idx
  on public.cotacao_itens (clinic_id, exact_sku_key)
  where exact_sku_key is not null;
create index cotacao_precos_item_date_idx
  on public.cotacao_precos (
    clinic_id, item_id, commercial_condition, quote_date desc, imported_at desc
  );
create index cotacao_precos_source_page_idx
  on public.cotacao_precos (clinic_id, source_id, page_number, line_reference);
create index cotacao_precos_import_id_idx
  on public.cotacao_precos (clinic_id, import_id);
create index cotacao_sku_vinculos_product_idx
  on public.cotacao_sku_vinculos (clinic_id, product_id);

alter table public.cotacao_fontes enable row level security;
alter table public.cotacao_importacoes enable row level security;
alter table public.cotacao_itens enable row level security;
alter table public.cotacao_precos enable row level security;
alter table public.cotacao_sku_vinculos enable row level security;

revoke all on public.cotacao_fontes from public, anon, authenticated, service_role;
revoke all on public.cotacao_importacoes from public, anon, authenticated, service_role;
revoke all on public.cotacao_itens from public, anon, authenticated, service_role;
revoke all on public.cotacao_precos from public, anon, authenticated, service_role;
revoke all on public.cotacao_sku_vinculos from public, anon, authenticated, service_role;

grant select, insert, update on public.cotacao_fontes to service_role;
grant select, insert, update on public.cotacao_importacoes to service_role;
grant select, insert, update on public.cotacao_itens to service_role;
grant select, insert, update on public.cotacao_precos to service_role;
grant select, insert, update on public.cotacao_sku_vinculos to service_role;

create or replace function public.cotacoes_importar_lote(
  p_clinic_id uuid,
  p_source jsonb,
  p_records jsonb,
  p_parser_version text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_source_id uuid;
  v_import_id uuid;
  v_source_sha text;
  v_source_date date;
  v_import_fingerprint text;
  v_record jsonb;
  v_item_id uuid;
  v_item_key text;
  v_exact_sku_key text;
  v_evidence_key text;
  v_code text;
  v_brand text;
  v_name text;
  v_composition text;
  v_concentration text;
  v_presentation text;
  v_package_quantity numeric(14,4);
  v_package_unit text;
  v_condition text;
  v_quote_date date;
  v_price numeric(14,2);
  v_page integer;
  v_line text;
  v_exact_eligible boolean;
  v_inserted integer := 0;
  v_idempotent integer := 0;
  v_duplicates integer := 0;
  v_conflicts integer := 0;
  v_total integer := 0;
  v_existing_price numeric(14,2);
begin
  if p_clinic_id is null or not exists (
    select 1 from public.clinics where id = p_clinic_id
  ) then
    raise exception 'clinica_invalida' using errcode = '22023';
  end if;
  if pg_catalog.jsonb_typeof(p_source) <> 'object'
     or pg_catalog.jsonb_typeof(p_records) <> 'array'
     or pg_catalog.jsonb_array_length(p_records) > 20000 then
    raise exception 'lote_invalido' using errcode = '22023';
  end if;

  v_source_sha := pg_catalog.lower(pg_catalog.btrim(p_source->>'file_sha256'));
  if v_source_sha is null or v_source_sha !~ '^[0-9a-f]{64}$' then
    raise exception 'hash_fonte_invalido' using errcode = '22023';
  end if;
  v_source_date := (p_source->>'source_date')::date;
  if pg_catalog.btrim(p_parser_version) = ''
     or pg_catalog.char_length(pg_catalog.btrim(p_parser_version)) > 80 then
    raise exception 'versao_parser_invalida' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_clinic_id::text || ':cotacao:' || v_source_sha, 0)
  );

  insert into public.cotacao_fontes (
    clinic_id, source_name, supplier_name, source_type, file_name,
    file_sha256, source_date, revision, page_count, project_relative_path,
    status, notes, last_imported_at
  ) values (
    p_clinic_id,
    pg_catalog.btrim(p_source->>'source_name'),
    nullif(pg_catalog.btrim(p_source->>'supplier_name'), ''),
    coalesce(nullif(pg_catalog.btrim(p_source->>'source_type'), ''), 'outro'),
    pg_catalog.btrim(p_source->>'file_name'),
    v_source_sha,
    v_source_date,
    nullif(pg_catalog.btrim(p_source->>'revision'), ''),
    nullif(p_source->>'page_count', '')::integer,
    nullif(pg_catalog.btrim(p_source->>'project_relative_path'), ''),
    coalesce(nullif(pg_catalog.btrim(p_source->>'status'), ''), 'pendente_revisao'),
    nullif(p_source->>'notes', ''),
    now()
  )
  on conflict (clinic_id, file_sha256) do update
    set last_imported_at = excluded.last_imported_at
  returning id into v_source_id;

  v_import_fingerprint := private.cotacoes_sha256(
    p_clinic_id::text || '|' || v_source_sha || '|' || pg_catalog.btrim(p_parser_version)
  );

  insert into public.cotacao_importacoes (
    clinic_id, source_id, import_fingerprint, parser_version, status,
    source_line_count, started_at
  ) values (
    p_clinic_id, v_source_id, v_import_fingerprint,
    pg_catalog.btrim(p_parser_version), 'processando',
    pg_catalog.jsonb_array_length(p_records), now()
  )
  on conflict (clinic_id, import_fingerprint) do update
    set attempt_count = public.cotacao_importacoes.attempt_count + 1,
        status = 'processando',
        source_line_count = excluded.source_line_count,
        started_at = now(),
        completed_at = null
  returning id into v_import_id;

  for v_record in
    select value from pg_catalog.jsonb_array_elements(p_records)
  loop
    v_total := v_total + 1;
    v_code := nullif(pg_catalog.btrim(v_record->>'supplier_code'), '');
    v_brand := nullif(pg_catalog.btrim(v_record->>'brand'), '');
    v_name := pg_catalog.btrim(v_record->>'name');
    v_composition := nullif(pg_catalog.btrim(v_record->>'composition'), '');
    v_concentration := nullif(pg_catalog.btrim(v_record->>'concentration'), '');
    v_presentation := nullif(pg_catalog.btrim(v_record->>'presentation'), '');
    v_package_quantity := nullif(v_record->>'package_quantity', '')::numeric;
    v_package_unit := nullif(pg_catalog.btrim(v_record->>'package_unit'), '');
    v_condition := coalesce(
      nullif(pg_catalog.btrim(v_record->>'commercial_condition'), ''),
      'preco_tabela'
    );
    v_quote_date := coalesce(nullif(v_record->>'quote_date', '')::date, v_source_date);
    v_price := (v_record->>'price_brl')::numeric;
    v_page := nullif(v_record->>'page', '')::integer;
    v_line := pg_catalog.btrim(v_record->>'line');

    if v_name is null or v_name = '' or v_line is null or v_line = ''
       or v_price is null or v_price <= 0 then
      raise exception 'linha_cotacao_invalida_%', v_total using errcode = '22023';
    end if;

    v_exact_eligible := v_brand is not null and v_composition is not null
      and v_concentration is not null and v_presentation is not null
      and v_package_quantity is not null and v_package_unit is not null;

    if v_exact_eligible then
      v_exact_sku_key := private.cotacoes_sha256(
        private.cotacoes_normalizar_identidade(v_brand) || '|'
        || private.cotacoes_normalizar_identidade(v_name) || '|'
        || private.cotacoes_normalizar_identidade(v_composition) || '|'
        || private.cotacoes_normalizar_identidade(v_concentration) || '|'
        || private.cotacoes_normalizar_identidade(v_presentation) || '|'
        || private.cotacoes_normalizar_identidade(v_package_quantity::text) || '|'
        || private.cotacoes_normalizar_identidade(v_package_unit)
      );
    else
      v_exact_sku_key := null;
    end if;

    v_item_key := private.cotacoes_sha256(
      v_source_sha || '|'
      || case
        when v_code is not null then
          'codigo|' || private.cotacoes_normalizar_identidade(v_code)
        else
          'sem-codigo|'
          || private.cotacoes_normalizar_identidade(coalesce(v_brand, '')) || '|'
          || private.cotacoes_normalizar_identidade(v_name) || '|'
          || private.cotacoes_normalizar_identidade(coalesce(v_presentation, ''))
      end
    );

    insert into public.cotacao_itens (
      clinic_id, source_id, source_code, brand, item_name, composition,
      concentration, presentation, package_quantity, package_unit,
      canonical_item_key, exact_sku_key, exact_match_eligible,
      review_status, review_reason, last_seen_at
    ) values (
      p_clinic_id, v_source_id, v_code, v_brand, v_name, v_composition,
      v_concentration, v_presentation, v_package_quantity, v_package_unit,
      v_item_key, v_exact_sku_key, v_exact_eligible,
      'pendente_revisao',
      case when v_exact_eligible then 'Aguardando confirmação humana do vínculo exato.'
           else 'SKU incompleto; nenhuma associação automática foi criada.' end,
      now()
    )
    on conflict (clinic_id, source_id, canonical_item_key) do update
      set last_seen_at = now()
    returning id into v_item_id;

    -- A mesma fonte pode imprimir o mesmo produto com descrições abreviadas em
    -- páginas diferentes (ex.: Biometil 501). Preservamos ambas as evidências e
    -- pedimos revisão, mas só preço divergente torna o item conflito.
    if exists (
      select 1
      from public.cotacao_itens item
      where item.id = v_item_id
        and (
          private.cotacoes_normalizar_identidade(item.item_name)
            is distinct from private.cotacoes_normalizar_identidade(v_name)
          or private.cotacoes_normalizar_identidade(coalesce(item.presentation, ''))
            is distinct from private.cotacoes_normalizar_identidade(coalesce(v_presentation, ''))
        )
    ) then
      update public.cotacao_itens
      set review_status = case
            when review_status = 'conflito' then review_status
            else 'pendente_revisao'
          end,
          review_reason = 'Descrições diferentes sob o mesmo código; evidências preservadas.'
      where id = v_item_id;
    end if;

    v_evidence_key := private.cotacoes_sha256(
      v_source_sha || '|pagina|' || coalesce(v_page::text, '')
      || '|linha|' || v_line
      || '|codigo|' || coalesce(private.cotacoes_normalizar_identidade(v_code), '')
      || '|sku|' || coalesce(v_exact_sku_key, v_item_key)
      || '|apresentacao|'
      || private.cotacoes_normalizar_identidade(coalesce(v_presentation, ''))
      || '|condicao|' || private.cotacoes_normalizar_identidade(v_condition)
      || '|data|' || v_quote_date::text
    );

    select quote.price into v_existing_price
    from public.cotacao_precos quote
    where quote.clinic_id = p_clinic_id
      and quote.evidence_fingerprint = v_evidence_key;

    if v_existing_price is not null then
      if v_existing_price is distinct from v_price then
        update public.cotacao_itens
        set review_status = 'conflito',
            review_reason = 'A mesma evidência possui preços divergentes; revisão obrigatória.'
        where id = v_item_id;
        update public.cotacao_precos
        set extraction_status = 'conflito'
        where clinic_id = p_clinic_id and evidence_fingerprint = v_evidence_key;
      end if;
      v_idempotent := v_idempotent + 1;
    else
      insert into public.cotacao_precos (
        clinic_id, source_id, import_id, item_id, page_number, line_reference,
        quote_date, commercial_condition, price, evidence_fingerprint,
        extraction_status, raw_evidence
      ) values (
        p_clinic_id, v_source_id, v_import_id, v_item_id, v_page, v_line,
        v_quote_date, v_condition, v_price, v_evidence_key,
        case when v_record->>'review_status' in (
          'verificado_fonte', 'pendente_revisao', 'conflito', 'rejeitado'
        ) then v_record->>'review_status' else 'pendente_revisao' end,
        v_record
      );
      v_inserted := v_inserted + 1;
    end if;
  end loop;

  -- Repetição idêntica no mesmo arquivo vira várias evidências de uma cotação.
  select coalesce(pg_catalog.sum(grouped.evidence_count - 1), 0)::integer
    into v_duplicates
  from (
    select quote.item_id, quote.commercial_condition, quote.quote_date, quote.price,
           pg_catalog.count(*)::integer as evidence_count
    from public.cotacao_precos quote
    where quote.clinic_id = p_clinic_id and quote.source_id = v_source_id
      and quote.extraction_status <> 'rejeitado'
    group by quote.item_id, quote.commercial_condition, quote.quote_date, quote.price
    having pg_catalog.count(*) > 1
  ) grouped;

  -- Valores diferentes para o mesmo item/condição/data dentro do mesmo arquivo
  -- são mantidos como evidência, marcados conflito e excluídos das estatísticas.
  with conflicted as (
    select quote.item_id, quote.commercial_condition, quote.quote_date
    from public.cotacao_precos quote
    where quote.clinic_id = p_clinic_id and quote.source_id = v_source_id
      and quote.extraction_status <> 'rejeitado'
    group by quote.item_id, quote.commercial_condition, quote.quote_date
    having pg_catalog.count(distinct quote.price) > 1
  )
  update public.cotacao_itens item
  set review_status = 'conflito',
      review_reason = 'Preços divergentes no mesmo arquivo para item, condição e data.'
  from conflicted
  where item.id = conflicted.item_id;

  update public.cotacao_precos quote
  set extraction_status = 'conflito'
  where quote.clinic_id = p_clinic_id and quote.source_id = v_source_id
    and exists (
      select 1
      from public.cotacao_precos peer
      where peer.clinic_id = quote.clinic_id
        and peer.source_id = quote.source_id
        and peer.item_id = quote.item_id
        and peer.commercial_condition = quote.commercial_condition
        and peer.quote_date = quote.quote_date
        and peer.price is distinct from quote.price
        and peer.extraction_status <> 'rejeitado'
    );

  select pg_catalog.count(*)::integer into v_conflicts
  from public.cotacao_itens item
  where item.clinic_id = p_clinic_id and item.source_id = v_source_id
    and item.review_status = 'conflito';

  update public.cotacao_importacoes
  set status = case
        when v_total = 0 then 'parcial'
        when v_conflicts > 0 then 'parcial'
        else 'concluida'
      end,
      source_line_count = v_total,
      inserted_evidence_count = v_inserted,
      idempotent_evidence_count = v_idempotent,
      consolidated_duplicate_count = v_duplicates,
      conflict_count = v_conflicts,
      report = pg_catalog.jsonb_build_object(
        'source_sha256', v_source_sha,
        'source_lines', v_total,
        'inserted_evidences', v_inserted,
        'idempotent_evidences', v_idempotent,
        'consolidated_duplicates', v_duplicates,
        'conflicts', v_conflicts,
        'authoritative_cost_changed', false,
        'active_product_created', false
      ),
      completed_at = now()
  where id = v_import_id;

  update public.cotacao_fontes
  set status = case
        when v_total = 0 then 'pendente_revisao'
        when v_conflicts > 0 then 'parcial'
        else 'importada'
      end,
      last_imported_at = now()
  where id = v_source_id;

  return pg_catalog.jsonb_build_object(
    'source_id', v_source_id,
    'import_id', v_import_id,
    'source_lines', v_total,
    'inserted_evidences', v_inserted,
    'idempotent_evidences', v_idempotent,
    'consolidated_duplicates', v_duplicates,
    'conflicts', v_conflicts,
    'authoritative_cost_changed', false,
    'active_product_created', false
  );
end;
$$;

revoke all on function public.cotacoes_importar_lote(uuid, jsonb, jsonb, text)
  from public, anon, authenticated;
grant execute on function public.cotacoes_importar_lote(uuid, jsonb, jsonb, text)
  to service_role;

create or replace view public.cotacoes_referencia_consolidadas
with (security_invoker = true)
as
select
  quote.clinic_id,
  quote.source_id,
  quote.item_id,
  quote.commercial_condition,
  quote.quote_date,
  quote.currency,
  case when pg_catalog.count(distinct quote.price) = 1
       then pg_catalog.min(quote.price) end as reference_price,
  pg_catalog.count(distinct quote.price)::integer as distinct_price_count,
  pg_catalog.count(*)::integer as evidence_count,
  pg_catalog.array_agg(distinct quote.page_number order by quote.page_number)
    filter (where quote.page_number is not null) as evidence_pages,
  pg_catalog.array_agg(distinct quote.line_reference order by quote.line_reference)
    as evidence_lines,
  pg_catalog.count(distinct quote.price) > 1 as has_conflict
from public.cotacao_precos quote
where quote.extraction_status <> 'rejeitado'
group by
  quote.clinic_id, quote.source_id, quote.item_id,
  quote.commercial_condition, quote.quote_date, quote.currency;

create or replace view public.cotacoes_referencia_estatisticas
with (security_invoker = true)
as
with valid_quotes as (
  select
    item.clinic_id,
    item.exact_sku_key,
    item.brand,
    item.item_name,
    item.composition,
    item.concentration,
    item.presentation,
    item.package_quantity,
    item.package_unit,
    consolidated.source_id,
    consolidated.commercial_condition,
    consolidated.quote_date,
    consolidated.reference_price
  from public.cotacao_itens item
  join public.cotacoes_referencia_consolidadas consolidated
    on consolidated.clinic_id = item.clinic_id and consolidated.item_id = item.id
  where item.exact_match_eligible
    and item.exact_sku_key is not null
    and item.review_status <> 'conflito'
    and not consolidated.has_conflict
), latest_values as (
  select distinct on (clinic_id, exact_sku_key, commercial_condition)
    clinic_id, exact_sku_key, commercial_condition,
    reference_price as latest_price, quote_date as latest_date
  from valid_quotes
  order by clinic_id, exact_sku_key, commercial_condition,
           quote_date desc, source_id desc
), aggregate_values as (
  select
    quote.clinic_id,
    quote.exact_sku_key,
    pg_catalog.min(quote.brand) as brand,
    pg_catalog.min(quote.item_name) as item_name,
    pg_catalog.min(quote.composition) as composition,
    pg_catalog.min(quote.concentration) as concentration,
    pg_catalog.min(quote.presentation) as presentation,
    pg_catalog.min(quote.package_quantity) as package_quantity,
    pg_catalog.min(quote.package_unit) as package_unit,
    quote.commercial_condition,
    pg_catalog.count(*)::integer as quote_count,
    pg_catalog.count(distinct quote.source_id)::integer as source_count,
    pg_catalog.min(quote.reference_price) as minimum_price,
    pg_catalog.max(quote.reference_price) as maximum_price,
    pg_catalog.round(pg_catalog.avg(quote.reference_price), 2) as average_price,
    pg_catalog.percentile_cont(0.5) within group (
      order by quote.reference_price
    )::numeric(14,2) as median_price,
    pg_catalog.min(quote.quote_date) as period_start,
    pg_catalog.max(quote.quote_date) as period_end
  from valid_quotes quote
  group by quote.clinic_id, quote.exact_sku_key, quote.commercial_condition
)
select
  aggregate_values.*,
  latest_values.latest_price,
  latest_values.latest_date,
  link.product_id,
  actual.unit_cost as authoritative_unit_cost,
  actual.cost_date as authoritative_cost_date,
  actual.package_unit as authoritative_cost_package_unit,
  pg_catalog.round(
    aggregate_values.average_price / aggregate_values.package_quantity, 4
  ) as reference_average_unit_price,
  (
    actual.unit_cost is not null
    and private.cotacoes_normalizar_identidade(actual.package_unit)
      = private.cotacoes_normalizar_identidade(aggregate_values.package_unit)
  ) as unit_comparison_compatible,
  case
    when link.product_id is null then 'sku_nao_vinculado'
    when actual.unit_cost is null then 'sem_custo_real_corrente'
    when private.cotacoes_normalizar_identidade(actual.package_unit)
           <> private.cotacoes_normalizar_identidade(aggregate_values.package_unit)
      then 'unidade_incompativel'
    else 'comparavel'
  end as comparison_status,
  case when actual.unit_cost is not null
         and private.cotacoes_normalizar_identidade(actual.package_unit)
           = private.cotacoes_normalizar_identidade(aggregate_values.package_unit)
       then pg_catalog.round(
         (aggregate_values.average_price / aggregate_values.package_quantity)
           - actual.unit_cost,
         4
       ) end as average_minus_authoritative_cost,
  case when actual.unit_cost is not null and actual.unit_cost <> 0
         and private.cotacoes_normalizar_identidade(actual.package_unit)
           = private.cotacoes_normalizar_identidade(aggregate_values.package_unit)
       then pg_catalog.round(
         (
           (
             (aggregate_values.average_price / aggregate_values.package_quantity)
               - actual.unit_cost
           ) / actual.unit_cost
         ) * 100,
         2
       ) end as difference_percent
from aggregate_values
join latest_values
  using (clinic_id, exact_sku_key, commercial_condition)
left join public.cotacao_sku_vinculos link
  on link.clinic_id = aggregate_values.clinic_id
  and link.exact_sku_key = aggregate_values.exact_sku_key
left join public.financeiro_produto_custos actual
  on actual.clinic_id = link.clinic_id
  and actual.product_id = link.product_id
  and actual.is_current
  and not exists (
    select 1
    from public.financeiro_produto_custo_cancelamentos cancelled
    where cancelled.clinic_id = actual.clinic_id and cancelled.cost_id = actual.id
  );

-- Visão de painel: mantém cada página/linha pesquisável (inclusive as 199
-- evidências Biometil), mas indica explicitamente quais repetições não podem
-- entrar duas vezes nos cálculos.
create or replace view public.cotacoes_painel_evidencias
with (security_invoker = true)
as
select
  quote.id as evidence_id,
  quote.clinic_id,
  quote.source_id,
  source.source_name,
  source.supplier_name,
  source.file_name,
  source.file_sha256,
  source.source_date,
  source.revision,
  quote.item_id,
  item.source_code,
  item.brand,
  item.item_name,
  item.composition,
  item.concentration,
  item.presentation,
  item.package_quantity,
  item.package_unit,
  item.exact_sku_key,
  item.exact_match_eligible,
  item.review_status,
  item.review_reason,
  quote.page_number,
  quote.line_reference,
  quote.quote_date,
  quote.commercial_condition,
  quote.price,
  quote.currency,
  quote.extraction_status,
  pg_catalog.count(*) over (
    partition by quote.clinic_id, quote.source_id, quote.item_id,
      quote.commercial_condition, quote.quote_date, quote.price
  )::integer as same_price_evidence_count,
  pg_catalog.row_number() over (
    partition by quote.clinic_id, quote.source_id, quote.item_id,
      quote.commercial_condition, quote.quote_date, quote.price
    order by quote.page_number nulls last, quote.line_reference, quote.id
  )::integer as same_price_evidence_ordinal,
  exists (
    select 1
    from public.cotacao_precos peer
    where peer.clinic_id = quote.clinic_id
      and peer.source_id = quote.source_id
      and peer.item_id = quote.item_id
      and peer.commercial_condition = quote.commercial_condition
      and peer.quote_date = quote.quote_date
      and peer.price is distinct from quote.price
      and peer.extraction_status <> 'rejeitado'
  ) as has_source_conflict,
  (
    item.exact_match_eligible
    and item.review_status <> 'conflito'
    and quote.extraction_status = 'verificado_fonte'
    and not exists (
      select 1
      from public.cotacao_precos peer
      where peer.clinic_id = quote.clinic_id
        and peer.source_id = quote.source_id
        and peer.item_id = quote.item_id
        and peer.commercial_condition = quote.commercial_condition
        and peer.quote_date = quote.quote_date
        and peer.price is distinct from quote.price
        and peer.extraction_status <> 'rejeitado'
    )
    and pg_catalog.row_number() over (
      partition by quote.clinic_id, quote.source_id, quote.item_id,
        quote.commercial_condition, quote.quote_date, quote.price
      order by quote.page_number nulls last, quote.line_reference, quote.id
    ) = 1
  ) as counts_in_statistics
from public.cotacao_precos quote
join public.cotacao_fontes source
  on source.clinic_id = quote.clinic_id and source.id = quote.source_id
join public.cotacao_itens item
  on item.clinic_id = quote.clinic_id and item.id = quote.item_id;

revoke all on public.cotacoes_referencia_consolidadas
  from public, anon, authenticated, service_role;
revoke all on public.cotacoes_referencia_estatisticas
  from public, anon, authenticated, service_role;
revoke all on public.cotacoes_painel_evidencias
  from public, anon, authenticated, service_role;
grant select on public.cotacoes_referencia_consolidadas to service_role;
grant select on public.cotacoes_referencia_estatisticas to service_role;
grant select on public.cotacoes_painel_evidencias to service_role;

create or replace function public.cotacoes_resumo_referencia(
  p_clinic_id uuid,
  p_search text default null,
  p_limit integer default 100,
  p_offset integer default 0
)
returns table (
  exact_sku_key text,
  brand text,
  item_name text,
  composition text,
  concentration text,
  presentation text,
  package_quantity numeric,
  package_unit text,
  commercial_condition text,
  quote_count integer,
  source_count integer,
  minimum_price numeric,
  maximum_price numeric,
  average_price numeric,
  median_price numeric,
  latest_price numeric,
  latest_date date,
  period_start date,
  period_end date,
  product_id uuid,
  authoritative_unit_cost numeric,
  authoritative_cost_date date,
  authoritative_cost_package_unit text,
  reference_average_unit_price numeric,
  unit_comparison_compatible boolean,
  comparison_status text,
  average_minus_authoritative_cost numeric,
  difference_percent numeric
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    stats.exact_sku_key,
    stats.brand,
    stats.item_name,
    stats.composition,
    stats.concentration,
    stats.presentation,
    stats.package_quantity,
    stats.package_unit,
    stats.commercial_condition,
    stats.quote_count,
    stats.source_count,
    stats.minimum_price,
    stats.maximum_price,
    stats.average_price,
    stats.median_price,
    stats.latest_price,
    stats.latest_date,
    stats.period_start,
    stats.period_end,
    stats.product_id,
    stats.authoritative_unit_cost,
    stats.authoritative_cost_date,
    stats.authoritative_cost_package_unit,
    stats.reference_average_unit_price,
    stats.unit_comparison_compatible,
    stats.comparison_status,
    stats.average_minus_authoritative_cost,
    stats.difference_percent
  from public.cotacoes_referencia_estatisticas stats
  where stats.clinic_id = p_clinic_id
    and (
      nullif(pg_catalog.btrim(p_search), '') is null
      or private.cotacoes_normalizar_identidade(
        coalesce(stats.brand, '') || ' ' || stats.item_name || ' '
        || coalesce(stats.presentation, '')
      ) like '%' || private.cotacoes_normalizar_identidade(p_search) || '%'
    )
  order by stats.item_name, stats.commercial_condition
  limit least(greatest(coalesce(p_limit, 100), 1), 500)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

revoke all on function public.cotacoes_resumo_referencia(uuid, text, integer, integer)
  from public, anon, authenticated;
grant execute on function public.cotacoes_resumo_referencia(uuid, text, integer, integer)
  to service_role;

comment on table public.cotacao_fontes is
  'Fontes históricas de cotação, identificadas pelo SHA-256 do arquivo.';
comment on table public.cotacao_precos is
  'Evidências imutáveis; nunca substituem custo real, lote, frete ou preço de venda.';
comment on view public.cotacoes_referencia_consolidadas is
  'Consolida páginas repetidas da mesma fonte e sinaliza preços conflitantes.';
comment on view public.cotacoes_referencia_estatisticas is
  'Estatísticas apenas de SKU completo/exato; conflitos são excluídos.';
comment on view public.cotacoes_painel_evidencias is
  'Cada linha/página pesquisável, com repetição e conflito explicitamente sinalizados.';

commit;

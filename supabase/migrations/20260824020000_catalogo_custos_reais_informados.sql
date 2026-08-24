-- Custos reais informados pela gestao em 23/08/2026.
-- As cotacoes anexadas permanecem historicas e nao substituem estes valores.

alter table public.financeiro_produtos
  drop constraint if exists financeiro_produtos_unit_check;

alter table public.financeiro_produtos
  add constraint financeiro_produtos_unit_check check (
    unit in (
      'un', 'u', 'cx', 'frasco', 'seringa', 'ampola', 'aplicacao',
      'canula', 'dose', 'ml', 'mg', 'g', 'kit'
    )
  );

do $migration$
declare
  v_clinic_id uuid;
  v_actor_id uuid;
  v_galderma_id uuid;
  v_typo_brand_id uuid;
  v_rennova_id uuid;
  v_restylane_brand_id uuid;
  v_item jsonb;
  v_product_id uuid;
  v_brand_id uuid;
  v_name text;
  v_type text;
  v_unit text;
  v_total numeric(14,2);
  v_quantity numeric(14,4);
  v_unit_cost numeric(14,4);
  v_notes text;
  v_seed_exists boolean;
begin
  select clinic.id into v_clinic_id
  from public.clinics as clinic
  where clinic.name = 'Ana Maria Jacob Estética'
  order by clinic.created_at
  limit 1;

  if v_clinic_id is null then
    raise exception 'Clinica Ana Maria Jacob Estetica nao encontrada';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      v_clinic_id::text || ':catalogo-custos-reais-20260823', 0
    )
  );

  select member.user_id into v_actor_id
  from public.clinic_members as member
  where member.clinic_id = v_clinic_id
    and member.role = 'owner'
    and member.status = 'active'
  order by member.created_at
  limit 1;

  if v_actor_id is null then
    raise exception 'Proprietario ativo nao encontrado';
  end if;

  -- Corrige a marca sem apagar o identificador ja usado.
  select id into v_galderma_id
  from public.financeiro_marcas
  where clinic_id = v_clinic_id and upper(name) = 'GALDERMA'
  order by created_at limit 1;

  select id into v_typo_brand_id
  from public.financeiro_marcas
  where clinic_id = v_clinic_id and upper(name) = 'GALDEMA'
  order by created_at limit 1;

  if v_galderma_id is null and v_typo_brand_id is not null then
    update public.financeiro_marcas
    set name = 'GALDERMA', active = true, archived_at = null, updated_by = v_actor_id
    where id = v_typo_brand_id
    returning id into v_galderma_id;
  elsif v_galderma_id is not null and v_typo_brand_id is not null
        and v_galderma_id <> v_typo_brand_id then
    update public.financeiro_produtos
    set brand_id = v_galderma_id, updated_by = v_actor_id
    where clinic_id = v_clinic_id and brand_id = v_typo_brand_id;
    update public.financeiro_marcas
    set active = false, archived_at = coalesce(archived_at, now()), updated_by = v_actor_id
    where id = v_typo_brand_id;
  end if;

  select id into v_rennova_id from public.financeiro_marcas
  where clinic_id = v_clinic_id and upper(name) = 'RENNOVA'
  order by created_at limit 1;

  select id into v_restylane_brand_id from public.financeiro_marcas
  where clinic_id = v_clinic_id and upper(name) = 'RESTYLANE'
  order by created_at limit 1;

  for v_item in
    select value from jsonb_array_elements($costs$[
      {"name":"NABOTA 100U","aliases":["NABOTA 1OOUI","NABOTA 100UI","NABOTA 100U"],"brand":"RENNOVA","type":"toxina_botulinica","unit":"u","total":537.00,"quantity":100,"package_unit":"U","notes":"Frasco de 100U; custo por unidade calculado em R$ 5,37."},
      {"name":"ELLEVA 150MG","aliases":["ELLEVA 150MG"],"brand":"RENNOVA","type":"bioestimulador","unit":"frasco","total":594.00,"quantity":1,"package_unit":"frasco","notes":"Frasco de 150 mg."},
      {"name":"ELLEVA 210MG","aliases":["ELLEVA 210MG"],"brand":"RENNOVA","type":"bioestimulador","unit":"frasco","total":807.00,"quantity":1,"package_unit":"frasco","notes":"Frasco de 210 mg."},
      {"name":"RESTYLANE GEL 1ML","aliases":["RESTYLANE","RESTYLANE GEL 1ML"],"brand":"GALDERMA","type":"preenchedor","unit":"seringa","total":197.90,"quantity":1,"package_unit":"seringa","notes":"Seringa de 1 ml."},
      {"name":"RENNOVA DEEP LINE LIDO 1ML","aliases":["RENNOVA DEEP LINE LIDO","RENNOVA DEEP LINE LIDO 1ML"],"brand":"RENNOVA","type":"preenchedor","unit":"seringa","total":232.00,"quantity":1,"package_unit":"seringa","notes":"Seringa de 1 ml."},
      {"name":"SERINGA DE INSULINA PARA TOXINA","aliases":["SERINGA DE INSULINA PARA TOXINA","SERINGA PARA TOXINA"],"brand":null,"type":"descartavel","unit":"seringa","total":2.00,"quantity":1,"package_unit":"seringa","notes":"Custo por seringa informado pela clinica."},
      {"name":"CÂNULA RENNOVA PARA BIOESTIMULADOR","aliases":["CÂNULA RENNOVA PARA BIOESTIMULADOR"],"brand":"RENNOVA","type":"descartavel","unit":"canula","total":10.00,"quantity":1,"package_unit":"canula","notes":"Custo por canula informado pela clinica."},
      {"name":"SORO FISIOLÓGICO PARA TOXINA","aliases":["SORO FISIOLÓGICO PARA TOXINA","FLACONETE DE SORO ESTÉRIL INJETAVEL","FLACONETE DE SORO ESTÉRIL INJETÁVEL"],"brand":null,"type":"medicamento","unit":"frasco","total":2.00,"quantity":1,"package_unit":"frasco","notes":"Insumo para diluicao de toxina."},
      {"name":"ÁGUA PARA INJEÇÃO PARA BIOESTIMULADOR","aliases":["ÁGUA PARA INJEÇÃO PARA BIOESTIMULADOR","ÁGUA PARA INJEÇÃO ESTÉRIL"],"brand":null,"type":"medicamento","unit":"ampola","total":2.00,"quantity":1,"package_unit":"ampola","notes":"Insumo para reconstituicao de bioestimulador."},
      {"name":"SILÍCIO PARA MICROAGULHAMENTO","aliases":["SILÍCIO PARA MICROAGULHAMENTO"],"brand":null,"type":"injetavel","unit":"ampola","total":56.90,"quantity":10,"package_unit":"ampola","notes":"Caixa com 10 ampolas; R$ 5,69 por ampola."},
      {"name":"ÁCIDO HIALURÔNICO EM AMPOLA PARA MICROAGULHAMENTO","aliases":["ÁCIDO HIALURÔNICO EM AMPOLA PARA MICROAGULHAMENTO"],"brand":null,"type":"injetavel","unit":"ampola","total":74.90,"quantity":10,"package_unit":"ampola","notes":"Caixa com 10 ampolas; R$ 7,49 por ampola."},
      {"name":"TRICOLOGIA CAPILAR PARA MICROAGULHAMENTO","aliases":["TRICOLOGIA CAPILAR PARA MICROAGULHAMENTO"],"brand":null,"type":"injetavel","unit":"ampola","total":198.23,"quantity":5,"package_unit":"ampola","notes":"Cinco ampolas; custo unitario exato R$ 39,6460."},
      {"name":"BOOSTER FACIAL 2ML POR PACIENTE","aliases":["BOOSTER FACIAL 2ML POR PACIENTE","BOOSTER FACIAL"],"brand":null,"type":"skinbooster","unit":"aplicacao","total":167.00,"quantity":5,"package_unit":"aplicacao","notes":"Frasco de 10 ml para cinco pacientes; R$ 33,40 por aplicacao de 2 ml."},
      {"name":"VITAMINA C PARA MICROAGULHAMENTO","aliases":["VITAMINA C PARA MICROAGULHAMENTO"],"brand":null,"type":"injetavel","unit":"ampola","total":68.00,"quantity":10,"package_unit":"ampola","notes":"Caixa com 10 ampolas; R$ 6,80 por ampola."},
      {"name":"HIALURONIDASE","aliases":["HIALURONIDASE"],"brand":null,"type":"medicamento","unit":"ampola","total":73.00,"quantity":1,"package_unit":"ampola","notes":"Uso em intercorrencia. Apresentacao deve ser confirmada no proximo registro de compra."},
      {"name":"ANESTÉSICO SEM VASOCONSTRITOR","aliases":["ANESTÉSICO SEM VASOCONSTRITOR"],"brand":null,"type":"medicamento","unit":"frasco","total":20.00,"quantity":1,"package_unit":"frasco","notes":"Apresentacao deve ser confirmada no proximo registro de compra."},
      {"name":"ANESTÉSICO COM VASOCONSTRITOR","aliases":["ANESTÉSICO COM VASOCONSTRITOR"],"brand":null,"type":"medicamento","unit":"frasco","total":20.00,"quantity":1,"package_unit":"frasco","notes":"Usado conforme avaliacao profissional. Apresentacao deve ser confirmada."},
      {"name":"CARDIO PLUS","aliases":["CARDIO PLUS"],"brand":null,"type":"injetavel","unit":"ampola","total":85.20,"quantity":5,"package_unit":"ampola","notes":"Cinco ampolas para cinco pacientes; R$ 17,04 por paciente."},
      {"name":"SONO RELAX","aliases":["SONO RELAX"],"brand":null,"type":"injetavel","unit":"ampola","total":75.20,"quantity":5,"package_unit":"ampola","notes":"Cinco ampolas para cinco pacientes; R$ 15,04 por paciente."},
      {"name":"MEMÓRIA MAX","aliases":["MEMÓRIA MAX"],"brand":null,"type":"injetavel","unit":"ampola","total":85.00,"quantity":5,"package_unit":"ampola","notes":"Cinco ampolas para cinco pacientes; R$ 17,00 por paciente."}
    ]$costs$::jsonb)
  loop
    v_name := v_item->>'name';
    v_type := v_item->>'type';
    v_unit := v_item->>'unit';
    v_total := (v_item->>'total')::numeric;
    v_quantity := (v_item->>'quantity')::numeric;
    v_unit_cost := round(v_total / v_quantity, 4);
    v_notes := v_item->>'notes';
    v_brand_id := null;

    if v_item->>'brand' = 'RENNOVA' then v_brand_id := v_rennova_id; end if;
    if v_item->>'brand' = 'GALDERMA' then v_brand_id := v_galderma_id; end if;

    select product.id into v_product_id
    from public.financeiro_produtos as product
    where product.clinic_id = v_clinic_id
      and upper(product.name) in (
        select upper(alias.value)
        from jsonb_array_elements_text(v_item->'aliases') as alias(value)
      )
    order by product.created_at
    limit 1;

    -- Uma nova execucao da migration nao deve repor silenciosamente o valor de
    -- 23/08 depois que a gestao cadastrou um custo mais recente ou cancelou o
    -- custo inicial. A existencia do evento-semente torna o item concluido.
    v_seed_exists := false;
    if v_product_id is not null then
      select exists (
        select 1 from public.financeiro_produto_custos as cost
        where cost.clinic_id = v_clinic_id
          and cost.product_id = v_product_id
          and cost.source = 'Valor real informado pela clínica em 23/08/2026'
          and cost.cost_date = date '2026-08-23'
          and cost.package_quantity = v_quantity
          and cost.total_cost = v_total
          and cost.unit_cost = v_unit_cost
      ) into v_seed_exists;
    end if;

    if v_product_id is null then
      insert into public.financeiro_produtos (
        clinic_id, brand_id, name, product_type, unit, reference_cost,
        sale_price, anvisa_registration, stock_control, active,
        created_by, updated_by
      ) values (
        v_clinic_id, v_brand_id, v_name, v_type, v_unit, round(v_unit_cost, 2),
        null, null, true, true, v_actor_id, v_actor_id
      ) returning id into v_product_id;
    else
      update public.financeiro_produtos
      set brand_id = v_brand_id,
          name = v_name,
          product_type = v_type,
          unit = v_unit,
          reference_cost = round(v_unit_cost, 2),
          stock_control = true,
          active = true,
          archived_at = null,
          updated_by = v_actor_id
      where id = v_product_id
        and not v_seed_exists
        and (
          brand_id is distinct from v_brand_id
          or name is distinct from v_name
          or product_type is distinct from v_type
          or unit is distinct from v_unit
          or reference_cost is distinct from round(v_unit_cost, 2)
          or stock_control is distinct from true
          or active is distinct from true
          or archived_at is not null
        );
    end if;

    if not v_seed_exists then
      update public.financeiro_produto_custos
      set is_current = false
      where clinic_id = v_clinic_id and product_id = v_product_id and is_current;

      insert into public.financeiro_produto_custos (
        clinic_id, product_id, supplier_id, source, cost_date,
        payment_condition, package_quantity, package_unit,
        total_cost, unit_cost, notes, sets_current, is_current,
        operation_id, created_by
      ) values (
        v_clinic_id, v_product_id, null,
        'Valor real informado pela clínica em 23/08/2026', date '2026-08-23',
        null, v_quantity, v_item->>'package_unit',
        v_total, v_unit_cost, v_notes, true, true,
        pg_catalog.md5(
          v_clinic_id::text || ':seed-cost-20260823:' || v_name
        )::uuid,
        v_actor_id
      );
    end if;
  end loop;

  -- RESTYLANE e BOTOX 100 UI eram produtos cadastrados como marcas.
  update public.financeiro_marcas
  set active = false, archived_at = coalesce(archived_at, now()), updated_by = v_actor_id
  where clinic_id = v_clinic_id
    and upper(name) in ('RESTYLANE', 'BOTOX 100 UI')
    and not exists (
      select 1 from public.financeiro_produtos as product
      where product.clinic_id = v_clinic_id
        and product.brand_id = financeiro_marcas.id
        and product.active and product.archived_at is null
    );

  insert into public.financeiro_auditoria (
    clinic_id, actor_id, entity, entity_id, action, details, request_id
  )
  select
    v_clinic_id, v_actor_id, 'catalogo_produtos', null, 'custos_iniciais_importados',
    pg_catalog.jsonb_build_object(
      'source', 'valores_reais_informados_pela_clinica',
      'mode', 'custos_atuais_20260823',
      'item_count', 20
    ),
    pg_catalog.md5(v_clinic_id::text || ':seed-audit-20260823')::uuid
  where not exists (
    select 1
    from public.financeiro_auditoria audit
    where audit.clinic_id = v_clinic_id
      and audit.entity = 'catalogo_produtos'
      and audit.action = 'custos_iniciais_importados'
      and audit.details ->> 'mode' = 'custos_atuais_20260823'
  );
end;
$migration$;

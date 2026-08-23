-- Amplia o catálogo de tipos de produtos estéticos sem regravar registros.

alter table public.financeiro_produtos
  drop constraint if exists financeiro_produtos_product_type_check;

alter table public.financeiro_produtos
  add constraint financeiro_produtos_product_type_check
  check (
    product_type in (
      'bioestimulador',
      'toxina_botulinica',
      'preenchedor',
      'skinbooster',
      'injetavel',
      'medicamento',
      'dermocosmetico',
      'descartavel',
      'epi',
      'limpeza',
      'revenda',
      'outro'
    )
  );

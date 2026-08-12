begin;

alter table public.documentos_clinicos
  drop constraint if exists documentos_clinicos_tipo_check;

alter table public.documentos_clinicos
  add constraint documentos_clinicos_tipo_check
  check (
    tipo in (
      'tcle_toxina_botulinica',
      'tcle_preenchimento_facial'
    )
  );

commit;

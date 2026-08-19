-- Fase PREPARE do envio seguro da anamnese.
-- Esta migration e aditiva: mantem os nove registros e os objetos legados,
-- prepara o novo endpoint server-side e nao corta o formulario antigo ainda.

alter table public.anamneses
  add column if not exists idempotency_key uuid,
  add column if not exists formulario_versao text,
  add column if not exists formulario_sha256 text,
  add column if not exists recebido_em timestamptz,
  add column if not exists origem_hash text,
  add column if not exists assinatura_path text,
  add column if not exists assinatura_sha256 text,
  add column if not exists pdf_path text,
  add column if not exists pdf_sha256 text,
  add column if not exists registro_sha256 text,
  add column if not exists status text,
  add column if not exists updated_at timestamptz;

-- Registros anteriores continuam identificados como legados e nunca sao
-- reescritos para fingir que passaram pelo novo pipeline.
update public.anamneses
set
  status = coalesce(status, 'legado'),
  recebido_em = coalesce(recebido_em, criado_em),
  updated_at = coalesce(updated_at, criado_em, now())
where status is null
   or recebido_em is null
   or updated_at is null;

alter table public.anamneses
  alter column status set default 'processando',
  alter column status set not null,
  alter column recebido_em set default now(),
  alter column recebido_em set not null,
  alter column updated_at set default now(),
  alter column updated_at set not null;

-- Associa o PDF legado exato sem mover, renomear ou apagar objetos. O objeto
-- orfao conhecido permanece intocado para revisao administrativa posterior.
update public.anamneses as a
set pdf_path = (
  select o.name
  from storage.objects as o
  where o.bucket_id = 'fichas-pdf'
    and a.codigo_verificacao is not null
    and position(left(a.codigo_verificacao, 8) in o.name) > 0
  order by o.created_at desc nulls last, o.name
  limit 1
)
where a.pdf_path is null
  and exists (
    select 1
    from storage.objects as o
    where o.bucket_id = 'fichas-pdf'
      and a.codigo_verificacao is not null
      and position(left(a.codigo_verificacao, 8) in o.name) > 0
  );

create unique index if not exists anamneses_idempotency_key_uidx
  on public.anamneses (idempotency_key)
  where idempotency_key is not null;

create unique index if not exists anamneses_codigo_verificacao_uidx
  on public.anamneses (codigo_verificacao)
  where codigo_verificacao is not null;

create unique index if not exists anamneses_pdf_path_uidx
  on public.anamneses (pdf_path)
  where pdf_path is not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'anamneses_status_check'
      and conrelid = 'public.anamneses'::regclass
  ) then
    alter table public.anamneses
      add constraint anamneses_status_check
      check (status in ('legado', 'processando', 'recebido', 'erro'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'anamneses_codigo_sha256_check'
      and conrelid = 'public.anamneses'::regclass
  ) then
    alter table public.anamneses
      add constraint anamneses_codigo_sha256_check
      check (
        codigo_verificacao is null
        or codigo_verificacao ~ '^[0-9a-f]{64}$'
      );
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'anamneses_pipeline_seguro_check'
      and conrelid = 'public.anamneses'::regclass
  ) then
    alter table public.anamneses
      add constraint anamneses_pipeline_seguro_check
      check (
        idempotency_key is null
        or (
          formulario_versao is not null
          and char_length(formulario_versao) between 5 and 80
          and formulario_sha256 ~ '^[0-9a-f]{64}$'
          and origem_hash ~ '^[0-9a-f]{64}$'
          and assinatura_path ~ '^anamneses/[0-9a-f-]{36}/assinatura[.]png$'
          and assinatura_sha256 ~ '^[0-9a-f]{64}$'
          and pdf_path ~ '^anamneses/[0-9a-f-]{36}/ficha[.]pdf$'
          and pdf_sha256 ~ '^[0-9a-f]{64}$'
          and registro_sha256 ~ '^[0-9a-f]{64}$'
          and codigo_verificacao ~ '^[0-9a-f]{64}$'
        )
      );
  end if;
end
$$;

comment on column public.anamneses.origem_hash is
  'HMAC nao reversivel da origem, usado somente para controle de abuso.';
comment on column public.anamneses.status is
  'Estado do pipeline server-side. legado identifica registros anteriores ao endpoint seguro.';
comment on column public.anamneses.pdf_path is
  'Caminho privado exato do PDF no bucket fichas-pdf.';

alter table public.anamneses enable row level security;

-- A Edge Function usa service_role no servidor. Nenhum privilegio de remocao
-- definitiva e necessario no fluxo clinico normal.
revoke delete, truncate, references, trigger
  on table public.anamneses from service_role;
grant select, insert, update
  on table public.anamneses to service_role;

-- Limites de defesa em profundidade. O bucket continua privado.
update storage.buckets
set
  public = false,
  file_size_limit = 5242880,
  allowed_mime_types = array['application/pdf', 'image/png']::text[]
where id = 'fichas-pdf';

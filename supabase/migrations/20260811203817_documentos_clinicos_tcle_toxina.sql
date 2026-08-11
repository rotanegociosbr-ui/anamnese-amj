-- Migration dos documentos clínicos digitais da Ana Maria Jacob Estética.
-- A anamnese existente permanece intocada; esta estrutura recebe o TCLE atual
-- e poderá ser ampliada por migrations específicas para os próximos termos.

create table if not exists public.documentos_clinicos (
  id uuid primary key default gen_random_uuid(),
  idempotency_key uuid not null unique,
  tipo text not null,
  versao_termo text not null,
  termo_sha256 text not null,
  nome text not null,
  cpf text not null,
  telefone text not null,
  email text,
  assinado_em_cliente timestamptz not null,
  recebido_em timestamptz not null default now(),
  dispositivo text,
  origem_hash text,
  assinatura_path text not null unique,
  assinatura_sha256 text not null,
  pdf_path text not null unique,
  pdf_sha256 text not null,
  registro_sha256 text not null,
  codigo_verificacao text not null unique,
  dados jsonb not null,
  status text not null default 'processando',
  revisado boolean not null default false,
  revisado_em timestamptz,
  observacoes_internas text,
  consentimento_retirado_em timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint documentos_clinicos_tipo_check
    check (tipo in ('tcle_toxina_botulinica')),
  constraint documentos_clinicos_status_check
    check (status in ('processando', 'recebido', 'erro')),
  constraint documentos_clinicos_termo_hash_check
    check (termo_sha256 ~ '^[0-9a-f]{64}$'),
  constraint documentos_clinicos_assinatura_hash_check
    check (assinatura_sha256 ~ '^[0-9a-f]{64}$'),
  constraint documentos_clinicos_pdf_hash_check
    check (pdf_sha256 ~ '^[0-9a-f]{64}$'),
  constraint documentos_clinicos_registro_hash_check
    check (registro_sha256 ~ '^[0-9a-f]{64}$'),
  constraint documentos_clinicos_codigo_check
    check (codigo_verificacao ~ '^[0-9a-f]{64}$'),
  constraint documentos_clinicos_nome_check
    check (char_length(btrim(nome)) between 5 and 120),
  constraint documentos_clinicos_cpf_check
    check (cpf ~ '^[0-9]{11}$'),
  constraint documentos_clinicos_telefone_check
    check (telefone ~ '^[0-9]{10,11}$'),
  constraint documentos_clinicos_dados_check
    check (jsonb_typeof(dados) = 'object')
);

comment on table public.documentos_clinicos is
  'Documentos clínicos enviados por pacientes, armazenados somente por Edge Functions com service_role.';
comment on column public.documentos_clinicos.registro_sha256 is
  'Hash SHA-256 do payload canônico, incluindo termo, respostas, assinatura e PDF.';
comment on column public.documentos_clinicos.origem_hash is
  'Hash não reversível da origem de rede usado somente para limitação de abuso.';

create index if not exists documentos_clinicos_tipo_data_idx
  on public.documentos_clinicos (tipo, recebido_em desc);
create index if not exists documentos_clinicos_nome_idx
  on public.documentos_clinicos (lower(nome));
create index if not exists documentos_clinicos_origem_data_idx
  on public.documentos_clinicos (origem_hash, recebido_em desc)
  where origem_hash is not null;

alter table public.documentos_clinicos enable row level security;

revoke all on table public.documentos_clinicos from public, anon, authenticated;
grant select, insert, update on table public.documentos_clinicos to service_role;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'documentos-clinicos',
  'documentos-clinicos',
  false,
  5242880,
  array['application/pdf', 'image/png']::text[]
)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

-- Nenhuma policy pública é criada para o bucket novo. Somente a service_role
-- utilizada pelas Edge Functions pode gravar, listar ou assinar objetos.

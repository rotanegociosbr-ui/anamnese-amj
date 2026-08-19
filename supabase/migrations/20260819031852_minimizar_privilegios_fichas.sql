begin;

-- Limita a credencial interna das Edge Functions ao mínimo necessário.
-- Operações destrutivas não fazem parte do fluxo do app Fichas.
revoke all on table public.anamneses from service_role;
grant select, insert, update on table public.anamneses to service_role;

revoke all on table public.anamneses_resumo from service_role;
grant select on table public.anamneses_resumo to service_role;

revoke all on table public.documentos_clinicos from service_role;
grant select, insert, update on table public.documentos_clinicos to service_role;

revoke all on table public.fichas_acoes_auditoria from service_role;
grant select on table public.fichas_acoes_auditoria to service_role;

revoke all on sequence public.fichas_acoes_auditoria_id_seq
  from public, anon, authenticated, service_role;

commit;

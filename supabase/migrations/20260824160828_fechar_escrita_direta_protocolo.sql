begin;

-- O painel e as Edge Functions sao a fronteira canonica de escrita clinica.
-- Mantemos a leitura autenticada existente, mas removemos a escrita direta
-- pelo Data API para que exclusoes e assinaturas nao contornem MFA, senha
-- recente, auditoria e validacao de tenant executadas no backend.
alter table public.protocol_points enable row level security;
alter table public.protocol_signatures enable row level security;

revoke insert, update, delete on table public.protocol_points
  from public, anon, authenticated;
revoke insert, update, delete on table public.protocol_signatures
  from public, anon, authenticated;

-- A policy antiga FOR ALL permitia DELETE a qualquer membro ativo porque
-- WITH CHECK nao participa da autorizacao de DELETE. Ela e substituida por
-- uma policy exclusivamente de leitura com o mesmo escopo de tenant.
drop policy if exists protocol_points_all on public.protocol_points;
drop policy if exists protocol_points_select_active_member on public.protocol_points;

create policy protocol_points_select_active_member
on public.protocol_points
for select
to authenticated
using (
  exists (
    select 1
    from public.protocols as protocol
    where protocol.id = protocol_points.protocol_id
      and private.is_clinic_member(protocol.clinic_id)
  )
);

-- Assinaturas continuam legiveis pela policy SELECT existente. Novas
-- assinaturas devem passar exclusivamente pela Edge Function/service_role.
drop policy if exists protocol_signatures_insert on public.protocol_signatures;

-- Explicita a preservacao da leitura; nenhum GRANT de escrita e reintroduzido.
grant select on table public.protocol_points to authenticated;
grant select on table public.protocol_signatures to authenticated;

comment on policy protocol_points_select_active_member
  on public.protocol_points is
  'Leitura por membro ativo da clinica; escrita direta bloqueada e reservada ao backend Edge.';

commit;

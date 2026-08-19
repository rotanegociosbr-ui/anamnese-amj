-- Corte definitivo do envio legado da anamnese.
-- O formulário público passa a gravar exclusivamente pela Edge Function
-- anamnese-submit, que valida os dados e usa a service role no servidor.

drop policy if exists "formulario pode inserir" on public.anamneses;
revoke insert on table public.anamneses from anon, authenticated;

drop policy if exists "formulario deposita pdf" on storage.objects;

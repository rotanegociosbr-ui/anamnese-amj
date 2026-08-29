-- Fase 4: indices de apoio para as FKs compostas de ator por clinica.

create index if not exists ia_operations_clinic_actor_fk_idx
  on public.ia_operations (clinic_id, actor_id);

create index if not exists ia_feedback_clinic_actor_fk_idx
  on public.ia_feedback (clinic_id, actor_id);

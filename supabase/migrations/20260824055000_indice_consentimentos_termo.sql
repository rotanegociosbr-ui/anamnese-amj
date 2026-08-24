begin;

-- Recomendação confirmada pelo Database Advisor: o vínculo entre o aceite e
-- seu termo precisa de índice para não provocar varredura completa ao abrir,
-- arquivar ou validar documentos clínicos. A alteração é somente estrutural;
-- nenhum dado clínico é copiado ou modificado.
create index if not exists protocol_consents_term_id_idx
  on public.protocol_consents (term_id);

commit;

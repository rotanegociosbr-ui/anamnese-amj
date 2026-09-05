-- Read-only regression: synthetic paths only; does not invoke the enqueue RPC.
WITH base AS (
  SELECT '11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/33333333-3333-4333-8333-333333333333'::text AS stem
), samples(label, thumbnail, suffix, expected) AS (VALUES
  ('original_jpg', false, '.jpg', true),
  ('original_png', false, '.png', true),
  ('original_webp', false, '.webp', true),
  ('thumbnail_jpg', true, '.thumb.jpg', true),
  ('thumbnail_webp', true, '.thumb.webp', true),
  ('wrong_separator', false, 'Xjpg', false),
  ('trailing_directory', false, '.jpg/extra', false),
  ('parent_segment', false, '/../other.jpg', false),
  ('bad_thumbnail_separator', true, '.thumbXjpg', false),
  ('backslash', false, E'\\x.jpg', false),
  ('control_character', false, E'.jpg\n', false),
  ('no_extension', false, '', false)
), checks AS (
  SELECT label, expected,
    ((stem || suffix) ~ ('^' || stem || CASE WHEN thumbnail
      THEN '[.]thumb[.][a-z0-9]+$' ELSE '[.][a-z0-9]+$' END)
     AND (stem || suffix) !~ '[[:cntrl:]\\]'
     AND (stem || suffix) !~ '(^|/)\.\.(/|$)') AS actual
  FROM base CROSS JOIN samples
), metadata AS (
  SELECT pg_get_functiondef(
    'public.prontuario_enfileirar_gc_foto_orfa(uuid,uuid,text,text,uuid,uuid,text,text,text,uuid)'::regprocedure
  ) AS definition,
  (SELECT pg_get_constraintdef(oid) FROM pg_constraint
    WHERE conrelid='public.clinical_photo_object_gc_queue'::regclass
      AND conname='clinical_photo_object_gc_queue_path_check') AS path_check
)
SELECT current_setting('standard_conforming_strings') AS string_mode,
  (SELECT count(*) FROM checks) AS synthetic_cases,
  (SELECT count(*) FROM checks WHERE actual IS NOT DISTINCT FROM expected) AS synthetic_passed,
  position(quote_literal('[.][a-z0-9]+$') in definition) > 0 AS function_original_pattern,
  position(quote_literal('[.]thumb[.][a-z0-9]+$') in definition) > 0 AS function_thumbnail_pattern,
  position(quote_literal('[.][a-z0-9]+$') in path_check) > 0 AS constraint_pattern,
  NOT has_function_privilege('anon',
    'public.prontuario_enfileirar_gc_foto_orfa(uuid,uuid,text,text,uuid,uuid,text,text,text,uuid)', 'EXECUTE') AS anon_denied,
  NOT has_function_privilege('authenticated',
    'public.prontuario_enfileirar_gc_foto_orfa(uuid,uuid,text,text,uuid,uuid,text,text,text,uuid)', 'EXECUTE') AS authenticated_denied,
  has_function_privilege('service_role',
    'public.prontuario_enfileirar_gc_foto_orfa(uuid,uuid,text,text,uuid,uuid,text,text,text,uuid)', 'EXECUTE') AS service_role_allowed
FROM metadata;

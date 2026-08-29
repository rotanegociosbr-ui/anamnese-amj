const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..', '..');
const migrationName = '20260829144846_fase5b_solicitacoes_site_privadas.sql';
const migration = fs.readFileSync(path.join(root, 'supabase', 'migrations', migrationName), 'utf8');
const edge = fs.readFileSync(path.join(root, 'supabase', 'functions', 'agendamento-submit', 'index.ts'), 'utf8');
const logic = fs.readFileSync(path.join(root, 'supabase', 'functions', 'agendamento-submit', 'logic.ts'), 'utf8');
const crm = fs.readFileSync(path.join(root, 'supabase', 'functions', 'crm-fichas', 'index.ts'), 'utf8');
const config = fs.readFileSync(path.join(root, 'supabase', 'config.toml'), 'utf8');

test('fase 5B usa caixa privada, replay e dedup pendente exata', () => {
  assert.match(migration, /create table private\.crm_site_booking_requests/i);
  assert.doesNotMatch(migration, /create table public\.crm_site_booking_requests/i);
  assert.match(migration, /create table private\.crm_site_booking_replays/i);
  assert.match(migration, /crm_site_booking_requests_pending_exact_unique[\s\S]*where status = 'pending'/i);
  assert.match(migration, /normalized_name[\s\S]*phone[\s\S]*preferred_date[\s\S]*preferred_period[\s\S]*interest/i);
  assert.doesNotMatch(migration, /p_(?:objective|objetivo)\b|\b(?:objective|objetivo)\s+text\b/i);
  assert.match(migration, /revoke all on table private\.crm_site_booking_requests[\s\S]*service_role/i);
  assert.match(migration, /grant execute on function public\.crm_site_booking_receive[\s\S]*to service_role/i);
});

test('aceite só mescla nome+telefone únicos e usa wrapper de marketing com owner real', () => {
  assert.match(migration, /lead\.record_status = 'active'[\s\S]*lead\.phone = v_request\.phone/i);
  assert.match(migration, /v_phone_count = 1 and v_exact_count = 1/i);
  assert.match(migration, /private\.crm_normalize_identity\(lead\.full_name\) = v_request\.normalized_name/i);
  assert.match(migration, /v_phone_count = 0[\s\S]*public\.marketing_crm_salvar_lead\([\s\S]*'create'/i);
  assert.match(migration, /public\.marketing_crm_salvar_lead\([\s\S]*'add_interaction'/i);
  assert.match(migration, /raise exception 'site_booking_review_required'/i);
  assert.match(migration, /'next_action_type', 'agendar_avaliacao'/i);
  assert.match(
    migration,
    /site-booking:lead-identity:' \|\| p_clinic_id::text \|\| ':' \|\| v_request\.phone/i,
  );
});

test('Edge pública aplica contrato fechado, três rate limits e timeout sem PII em logs', () => {
  assert.match(logic, /MAX_BODY_BYTES = 8 \* 1024/);
  for (const origin of [
    'https://anamariajacob.com.br', 'https://www.anamariajacob.com.br'
  ]) assert.ok(logic.includes(origin), `origem oficial ausente: ${origin}`);
  assert.match(
    logic,
    /LOCAL_ORIGINS[\s\S]*http:\/\/127\.0\.0\.1:8765[\s\S]*http:\/\/localhost:8765/,
  );
  assert.match(edge, /env\("ALLOW_LOCAL_ORIGINS"\) === "true"/);
  assert.match(logic, /MIN_FILL_MS = 3_000/);
  assert.match(logic, /MAX_FILL_MS = 12 \* 60 \* 60_000/);
  assert.match(edge, /scope: "agendamento-submit"/);
  assert.match(edge, /scope: "agendamento-global"/);
  assert.match(edge, /scope: "agendamento-contact"/);
  assert.match(edge, /new Request\(req\.url, \{ headers: \{ "x-forwarded-for": submission\.phone \} \}\)/);
  assert.match(edge, /new AbortController\(\)[\s\S]*setTimeout\(\(\) => controller\.abort\(\), 8_000\)/);
  assert.match(edge, /return json\(origin, \{ ok: true, recebido: true \}, 202, allowLocalOrigins\)/);
  assert.doesNotMatch(edge, /console\.(?:log|error|warn)\([^)]*(?:submission|body|phone|nome|headers)/i);
  assert.doesNotMatch(logic, /"objetivo"/);
});

test('crm-fichas lista, aceita e arquiva com owner+AAL2 e proteção adicional no arquivo', () => {
  assert.match(crm, /allowedRoles: \["owner"\][\s\S]*requireAal2: true/);
  assert.match(crm, /case "listar_solicitacoes_site"/);
  assert.match(crm, /case "aceitar_solicitacao_site"/);
  assert.match(crm, /case "arquivar_solicitacao_site"/);
  assert.match(crm, /solicitacoes_site: siteInbox\.items/);
  assert.match(crm, /solicitacoes_site_pendentes: siteInbox\.pending/);
  assert.match(crm, /p_responsible_user_id: userId/);
  assert.match(crm, /requireProtected\(req, context, payload, "archive_site_request", siteRequestId\)/);
});

test('configuração publica somente a Edge necessária com verify_jwt=false', () => {
  assert.match(
    config,
    /\[functions\.agendamento-submit\][\s\S]*?enabled = true[\s\S]*?verify_jwt = false[\s\S]*?entrypoint = "\.\/functions\/agendamento-submit\/index\.ts"/,
  );
});

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const project = path.resolve(__dirname, '..', '..');
const read = (...parts) => fs.readFileSync(path.join(project, ...parts), 'utf8');
const privateFunctions = [
  'painel-fichas',
  'agenda-fichas',
  'financeiro-fichas',
  'prontuario-fichas',
  'operacao-clinica-fichas',
  'gestao-administrativa-fichas',
  'cotacoes-fichas',
  'integracoes-fichas'
];

const shared = read('supabase', 'functions', '_shared', 'dual-auth.ts');
assert.doesNotMatch(shared, /legacy_shared_secret|legacyHash|legacyClinicId/,
  'O helper privado não pode oferecer autenticação por segredo compartilhado.');
assert.match(shared, /"authorization_required"/,
  'A ausência de Bearer precisa falhar fechada.');

for (const name of privateFunctions) {
  const source = read('supabase', 'functions', name, 'index.ts');
  assert.doesNotMatch(source,
    /legacy_shared_secret|legacyHash|legacyClinicId|PAINEL_HASH_SENHA|["']x-senha["']/,
    `${name} não pode aceitar ou configurar senha compartilhada.`);
  assert.match(source, /(?:authenticateDual\s*\(|authenticate:\s*authenticateDual[\s\S]*?deps\.authenticate\s*\()/,
    `${name} precisa validar a sessão individual no servidor.`);
  assert.match(source, /allowedRoles:\s*\["owner"\]/,
    `${name} precisa restringir dados privados aos proprietários.`);
  assert.match(source, /requireAal2:\s*true/,
    `${name} precisa exigir MFA AAL2.`);
}

const configToml = read('supabase', 'config.toml');
for (const name of privateFunctions) {
  assert.match(configToml,
    new RegExp(`\\[functions\\.${name.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\][\\s\\S]*?verify_jwt\\s*=\\s*false`),
    `${name} precisa estar declarada e documentar sua validação JWT interna.`);
}

const panel = read('painel', 'index.html');
assert.doesNotMatch(panel,
  /x-senha|hashSenha|amj_s|entrarTemporariamente|Acesso temporário|Senha temporária/,
  'A interface privada não pode oferecer ou persistir o login compartilhado.');
assert.match(panel, /Authorization = 'Bearer ' \+ session\.access_token/,
  'A interface precisa enviar o token individual validado.');

const allowedMatch = shared.match(/const AUDIT_DETAIL_KEYS = new Set\(\[([\s\S]*?)\]\);/);
assert(allowedMatch, 'A lista permitida de detalhes da auditoria precisa ser explícita.');
const allowed = new Set([...allowedMatch[1].matchAll(/["']([a-z0-9_]+)["']/g)].map(match => match[1]));
const forbidden = [
  'name', 'nome', 'patient_name', 'cpf', 'phone', 'telefone', 'email',
  'ip', 'token', 'payload', 'notes', 'reason', 'motivo', 'storage_path'
];
for (const key of forbidden) assert(!allowed.has(key), `Chave sensível proibida na auditoria: ${key}`);

for (const name of privateFunctions) {
  const source = read('supabase', 'functions', name, 'index.ts');
  for (const match of source.matchAll(/details\s*:\s*\{([^{}]*)\}/g)) {
    const keys = [...match[1].matchAll(/(?:^|,|\n)\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/g)]
      .map(item => item[1]);
    for (const key of keys) {
      assert(allowed.has(key), `${name} tentou auditar a chave fora da whitelist: ${key}`);
    }
  }
}

const hardening = read('supabase', 'migrations', '20260819111026_auth_mfa_rbac_hardening.sql');
const safeFunction = hardening.match(/create or replace function private\.audit_details_are_safe[\s\S]*?\$function\$;/i);
assert(safeFunction, 'O banco precisa manter o contrato de detalhes técnicos da auditoria.');
for (const key of forbidden) {
  assert.doesNotMatch(safeFunction[0], new RegExp(`'${key}'`, 'i'),
    `O contrato do banco não pode liberar a chave sensível ${key}.`);
}

const duplicateMigration = read('supabase', 'migrations', '20260824062000_fechar_fila_duplicatas_owner_mfa.sql');
assert.match(duplicateMigration,
  /'target_kind'[\s\S]*'status_code'[\s\S]*'version'[\s\S]*'idempotent'/,
  'A decisão de duplicidade deve auditar somente metadados técnicos permitidos.');
assert.doesNotMatch(duplicateMigration,
  /jsonb_build_object\([\s\S]{0,500}'(?:name|nome|cpf|phone|telefone|email|motivo|reason|payload)'/i,
  'A auditoria de duplicidade não pode copiar PII nem o motivo em texto livre.');

const proofMigration = read('supabase', 'migrations', '20260824002702_password_proof_consumption.sql');
assert.match(proofMigration,
  /private\.clinic_password_proof_audit_request_id\([\s\S]*p_request_id, p_event_action, p_entity_id[\s\S]*\)/,
  'A auditoria da prova deve derivar um request_id técnico separado da mutação de domínio.');
assert.doesNotMatch(proofMigration,
  /p_outcome,\s*p_request_id\s*\)\s*on conflict/i,
  'A prova não pode ocupar diretamente o request_id reservado ao evento de domínio.');

// Contrato global das migrations financeiras/clínicas deste bloco. A extração
// considera somente jsonb_build_object usado em trilhas de auditoria; os dados
// livres continuam nas tabelas de domínio e nunca entram nesses detalhes.
const migrationDir = path.join(project, 'supabase', 'migrations');
const migrationFiles = fs.readdirSync(migrationDir)
  .filter(name => name.endsWith('.sql') && name >= '20260823234710');
const clinicAuditKeys = new Set([
  'source', 'mode', 'route', 'endpoint', 'operation', 'target_kind',
  'reason_code', 'error_code', 'http_status', 'status_code', 'item_count',
  'result_count', 'duration_ms', 'idempotent', 'version', 'previous_status',
  'new_status', 'previous_role', 'new_role', 'legacy_event_id'
]);
const financialAuditKeys = new Set([
  'source', 'mode', 'operation', 'target_kind', 'reason_code', 'error_code',
  'status_code', 'item_count', 'result_count', 'idempotent', 'version',
  'previous_status', 'new_status', 'reason'
]);

function auditStatements(sql, marker) {
  const results = [];
  let cursor = 0;
  while ((cursor = sql.indexOf(marker, cursor)) !== -1) {
    const end = sql.indexOf(';', cursor);
    results.push(sql.slice(cursor, end === -1 ? sql.length : end + 1));
    cursor = end === -1 ? sql.length : end + 1;
  }
  return results;
}

function jsonObjectKeyLists(fragment) {
  const lists = [];
  const needle = 'jsonb_build_object(';
  let cursor = 0;
  while ((cursor = fragment.indexOf(needle, cursor)) !== -1) {
    const start = cursor + needle.length;
    let depth = 1;
    let quote = false;
    let end = start;
    for (; end < fragment.length && depth > 0; end += 1) {
      const char = fragment[end];
      if (quote) {
        if (char === "'" && fragment[end + 1] === "'") end += 1;
        else if (char === "'") quote = false;
        continue;
      }
      if (char === "'") quote = true;
      else if (char === '(') depth += 1;
      else if (char === ')') depth -= 1;
    }
    const body = fragment.slice(start, end - 1);
    const args = [];
    let argStart = 0;
    let nested = 0;
    quote = false;
    for (let index = 0; index <= body.length; index += 1) {
      const char = body[index];
      if (quote) {
        if (char === "'" && body[index + 1] === "'") index += 1;
        else if (char === "'") quote = false;
        continue;
      }
      if (char === "'") quote = true;
      else if (char === '(' || char === '[') nested += 1;
      else if (char === ')' || char === ']') nested -= 1;
      else if ((char === ',' && nested === 0) || index === body.length) {
        args.push(body.slice(argStart, index).trim());
        argStart = index + 1;
      }
    }
    const keys = [];
    for (let index = 0; index < args.length; index += 2) {
      const literal = /^'([a-z0-9_]+)'$/i.exec(args[index]);
      assert(literal, `Chave dinâmica não permitida em audit details: ${args[index]}`);
      keys.push(literal[1]);
    }
    lists.push(keys);
    cursor = end;
  }
  return lists;
}

for (const file of migrationFiles) {
  const sql = fs.readFileSync(path.join(migrationDir, file), 'utf8');
  const groups = [
    [auditStatements(sql, 'insert into public.clinic_audit_log'), clinicAuditKeys],
    [auditStatements(sql, 'perform private.prontuario_log_event'), clinicAuditKeys],
    [auditStatements(sql, 'insert into public.financeiro_auditoria'), financialAuditKeys]
  ];
  for (const [statements, keysAllowed] of groups) {
    for (const statement of statements) {
      for (const keys of jsonObjectKeyLists(statement)) {
        for (const key of keys) {
          assert(keysAllowed.has(key), `${file}: chave de auditoria fora da allowlist: ${key}`);
        }
      }
    }
  }
}

console.log('OK: áreas privadas são Bearer-only e audit details seguem whitelist sem PII.');

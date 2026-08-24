'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const project = path.resolve(__dirname, '..', '..');
const read = (...parts) => fs.readFileSync(path.join(project, ...parts), 'utf8');
const migration = read('supabase', 'migrations', '20260824062000_fechar_fila_duplicatas_owner_mfa.sql');
const edge = read('supabase', 'functions', 'financeiro-fichas', 'index.ts');
const ui = read('painel', 'financeiro.js');

assert.match(migration, /add column if not exists version integer not null default 1/);
assert.match(migration, /new\.version <> old\.version \+ 1/);
assert.match(migration, /for update/);
assert.match(migration, /pg_advisory_xact_lock/);
assert.match(migration, /duplicate_review_operation_reused/);
assert.match(migration, /duplicate_review_version_conflict/);
assert.match(migration, /security definer/);
assert.match(migration, /grant execute on function public\.financeiro_resolver_revisao_duplicidade/);
assert.doesNotMatch(migration, /grant\s+(?:all|delete)\s+on\s+(?:table\s+)?public\.clinic_duplicate_reviews/i);
assert.match(migration, /duplicate_review_delete_forbidden/);
assert.match(migration, /nao une, apaga ou altera nenhuma entidade/i);

assert.match(edge, /"resolver_revisao_duplicidade"[\s\S]*RECENT_PASSWORD_ACTIONS|RECENT_PASSWORD_ACTIONS[\s\S]*"resolver_revisao_duplicidade"/);
assert.match(edge, /requireProtectedOperation\(/);
assert.match(edge, /case "listar_revisoes_duplicidade"/);
assert.match(edge, /case "resolver_revisao_duplicidade"/);
assert.match(edge, /handleListDuplicateReviews/);
assert.match(edge, /handleResolveDuplicateReview/);
assert.match(edge,
  /const domainOperationId = operationId\(payload\)[\s\S]*p_operation_id: domainOperationId[\s\S]*p_request_id: domainOperationId/,
  'A auditoria da decisão deve usar a chave de domínio, separada do request da prova one-time.');
assert.doesNotMatch(edge,
  /financeiro_resolver_revisao_duplicidade[\s\S]{0,600}p_request_id:\s*context\.requestId/,
  'A decisão não pode colidir com o audit request já consumido pela prova one-time.');
assert.match(edge, /duplicateDescriptors/);
assert.match(edge, /principal:/);
assert.match(edge, /candidato:/);

assert.match(ui, /Revisão de possíveis duplicidades/);
assert.match(ui, /Confirmar que são distintos/);
assert.match(ui, /Marcar como já existente/);
assert.match(ui, /Descartar alerta/);
assert.match(ui, /protectedCall\('resolver_revisao_duplicidade'/);
assert.match(ui, /Nenhum cadastro será unido ou apagado automaticamente/);

console.log('OK: fila de duplicidades é revisável, versionada, auditável e não faz merge/delete.');

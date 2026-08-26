'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const panel = path.resolve(__dirname, '..');
const js = fs.readFileSync(path.join(panel, 'crm.js'), 'utf8');
const css = fs.readFileSync(path.join(panel, 'crm.css'), 'utf8');
const shell = fs.readFileSync(path.join(panel, 'app-shell.js'), 'utf8');
const html = fs.readFileSync(path.join(panel, 'index.html'), 'utf8');

assert.match(js, /functions\/v1\/crm-fichas/,
  'CRM deve usar somente a Edge Function dedicada');
assert.match(js, /const body = \{\s*action: action,\s*payload: payload \|\| \{\},\s*idempotency_key:[\s\S]*?expected_version:/,
  'envelope deve respeitar action, payload, idempotência e versão esperada');
assert.doesNotMatch(js, /acao:\s*action/,
  'o módulo deve usar exatamente o campo action previsto no contrato da Fase 1');
assert.match(js, /cabecalhosAcesso\(true, options\.proof\)/,
  'CRM exige autenticação individual com MFA');
assert.match(js, /cache: 'no-store', referrerPolicy: 'no-referrer'/,
  'requisições do CRM não podem usar cache nem enviar referrer');
assert.match(js, /new AbortController\(\)[\s\S]*?state\.generation/,
  'logout deve invalidar e cancelar requisições em andamento');
assert.match(js, /intentKey\('save'\)[\s\S]*?clearIntent\('save'\)/,
  'salvar deve reutilizar idempotência durante a mesma intenção');

for (const action of ['listar', 'salvar_lead', 'arquivar_lead', 'converter_lead']) {
  assert.match(js, new RegExp("'" + action + "'"), 'ação CRM ausente: ' + action);
}
for (const field of ['origem', 'suborigem', 'campanha', 'interesse', 'responsavel_id', 'estagio',
  'primeira_resposta_em', 'next_action_type', 'proxima_acao_em', 'motivo_perda']) {
  assert.match(js, new RegExp(field), 'campo comercial ausente: ' + field);
}

const masterStages = [
  'Lead novo', 'Primeiro atendimento', 'Interessada', 'Avaliação sugerida', 'Avaliação agendada',
  'Avaliação realizada', 'Plano apresentado', 'Proposta enviada', 'Aguardando decisão',
  'Procedimento agendado', 'Convertida', 'Não convertida', 'Reativação futura'
];
for (const label of masterStages) assert.ok(js.includes(label), 'etapa Master ausente: ' + label);
assert.equal((js.match(/^    \['[^']+', '[^']+'\],?$/gm) || []).length >= 13, true,
  'funil deve declarar pelo menos as 13 etapas do Master');
assert.doesNotMatch(js, /draggable|dragstart|drop\s*\(/i,
  'Kanban não deve criar efeitos automáticos por arrastar');

assert.match(js, /const rows = filteredLeads\(\);[\s\S]*?state\.view === 'kanban' \? renderKanban\(rows\) : renderList\(rows\)/,
  'lista e Kanban devem representar o mesmo conjunto filtrado');
assert.match(js, /Defina o tipo da próxima ação antes de salvar um lead em andamento/,
  'lead aberto deve exigir tipo da próxima ação');
assert.match(js, /payload\.proxima_acao_em = toClinicIso\(payload\.proxima_acao_em\)/,
  'datetime-local deve virar instante ISO da clínica antes do envio');
assert.match(js, /payload\.estagio === 'nao_convertida'[\s\S]*?motivo da não conversão/,
  'não conversão deve exigir motivo');
assert.match(js, /class="crm-loading"[\s\S]*?class="crm-error"[\s\S]*?class="crm-empty"|class="crm-empty"[\s\S]*?class="crm-error"/,
  'módulo deve oferecer estados de loading, erro e vazio');
for (const marker of ['Histórico', 'data-crm-edit', 'data-crm-convert', 'data-crm-archive']) {
  assert.ok(js.includes(marker), 'ação ou detalhe de lead ausente: ' + marker);
}
assert.match(js, /const canEdit = status === 'active' \|\| status === 'lost'[\s\S]*?const canArchive = status === 'active' \|\| status === 'lost'/,
  'ações mutáveis devem desaparecer dos registros imutáveis');

assert.match(js, /protectedRequest\('converter_lead',[\s\S]*?modo: 'revisar'/,
  'conversão deve começar com revisão protegida');
assert.match(js, /detail\.pode_criar === true \|\| detail\.can_create_patient === true/,
  'criação só pode aparecer quando a API liberar explicitamente');
assert.match(js, /'vincular_existente'[\s\S]*?'criar_paciente'/,
  'revisão deve separar vínculo existente de criação protegida');
assert.match(js, /confirm_possible_distinct = true[\s\S]*?distinct_reason/,
  'falso positivo deve ter confirmação explícita e motivo auditável');
assert.match(js, /record_status[\s\S]*?\['archived', 'cancelled'\]/,
  'visibilidade e ações devem respeitar o status canônico');
assert.match(js, /state\.loadPromise[\s\S]*?return state\.loadPromise/,
  'abertura por ID deve compartilhar a carga em andamento');
assert.match(js, /Motivo da não conversão[\s\S]*?escapeHtml\(lossReason\)/,
  'motivo de perda deve ficar visível e escapado');
assert.doesNotMatch(js, /id="crm-content" class="crm-content" aria-live/,
  'busca não deve anunciar novamente toda a lista');
assert.match(js, /id="crm-results-status"[\s\S]*?aria-live="polite"/,
  'uma região pequena deve anunciar somente a contagem filtrada');
assert.match(js, /responded-now'[\s\S]*?clearIntent\('save'\)/,
  'atalho Agora deve invalidar a intenção se alterar o payload');
assert.match(js, /primeira_resposta_em\.readOnly = Boolean\(firstResponse\)/,
  'primeira resposta já registrada deve ficar somente leitura');
assert.match(js, /primeira_resposta_em\.readOnly[\s\S]*?\? null : toClinicIso/,
  'edição comum não deve reenviar primeira resposta truncada pelo datetime-local');
assert.match(js, /candidate_fingerprint[\s\S]*?conversion\.candidateFingerprint/,
  'decisão final deve devolver o fingerprint do conjunto revisado');
assert.match(js, /const exactId = text\(detail\.exact_patient_id \|\| detail\.paciente_exato_id\)/,
  'correspondência exata deve vir na raiz e impedir a opção de nenhum cadastro');
assert.match(js, /const canConfirmDistinct = !hasMore && !exactId/,
  'correspondência exata nunca pode liberar confirmação distinta');
assert.match(js, /const hasMore = detail\.has_more === true[\s\S]*?canCreate = !hasMore[\s\S]*?canConfirmDistinct = !hasMore/,
  'snapshot truncado deve bloquear vínculo/criação distinta no estado da UI');
assert.match(js, /hasMore \? ' disabled aria-disabled="true"'/,
  'candidatos truncados devem ficar sem ação de vínculo');
assert.match(js, /Refine telefone, e-mail ou nascimento e revise novamente/,
  'snapshot truncado deve orientar refinamento antes da decisão');
assert.match(js, /candidate\.alias_opaco \|\| candidate\.safe_alias/,
  'cada candidato deve mostrar alias opaco sem expor UUID');
assert.match(js, /candidate_set_changed[\s\S]*?revise novamente antes de decidir/,
  'mudança de candidatos deve exigir nova revisão explícita');
assert.doesNotMatch(js, /criar_cliente|financeiro-fichas|pacientes\.push|leads\.push/i,
  'frontend do CRM nunca pode criar paciente diretamente nem escrever em módulo financeiro');
assert.match(js, /Dados clínicos pertencem ao prontuário/,
  'tela deve orientar separação entre CRM e prontuário');

assert.match(css, /\.crm-kanban\{[^}]*overflow-x:auto/,
  'Kanban com 13 colunas precisa de rolagem contida');
assert.match(css, /@media \(max-width:700px\)/,
  'CRM deve ter composição específica para celular');
assert.match(shell, /global: 'AMJCRMLeads'[\s\S]*?root: 'crm-root'/,
  'shell deve registrar o módulo CRM lazy');
assert.match(html, /app-shell\.js\?v=20260826-1/,
  'asset do shell deve ser versionado após integrar o CRM');
assert.doesNotMatch(html, /<script[^>]+crm\.js|<link[^>]+crm\.css/i,
  'CRM não deve aumentar o carregamento inicial');

const sandbox = { window: { crypto: require('node:crypto').webcrypto }, document: {},
  Intl, Date, Set, AbortController, console };
vm.runInNewContext(js, sandbox, { filename: 'crm.js' });
const runtime = sandbox.window.AMJCRMLeads.__test;
assert.equal(runtime.toClinicIso('2026-08-26T14:30'), '2026-08-26T17:30:00.000Z',
  'horário de Brasília deve ser armazenado como ISO UTC correto');
assert.equal(runtime.dateInput('2026-08-26T17:30:00.000Z'), '2026-08-26T14:30',
  'ISO UTC deve voltar ao horário local da clínica');
assert.equal(runtime.recordStatus({ stage_code: 'interessada', record_status: 'archived' }), 'archived');
assert.equal(runtime.isOpen({ stage_code: 'interessada', record_status: 'archived' }), false,
  'arquivado não pode contar como aberto só porque preservou a etapa');

console.log('crm-ui.test.cjs: contrato, funil, conversão e responsividade OK');

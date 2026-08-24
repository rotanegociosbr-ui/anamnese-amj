const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..', '..');
const ui = fs.readFileSync(path.join(root, 'painel', 'operacao.js'), 'utf8');
const migration = fs.readFileSync(
  path.join(root, 'supabase', 'migrations', '20260824035000_atendimentos_retornos_rentabilidade.sql'),
  'utf8'
);

assert.match(ui, /regiao_procedimento/, 'procedimento deve expor região/local estruturado');
assert.match(ui, /procedimento_em/, 'procedimento deve expor horário estruturado');
assert.match(ui, /showDuplicateAlert/, 'duplicata deve usar o alerta compartilhado');
assert.match(ui, /abrirAtendimento:\s*openAttendance/, 'Abrir existente deve chegar ao atendimento');
assert.match(ui, /abrirFoto:\s*openPhoto/, 'Abrir existente deve chegar à foto clínica');
assert.match(ui, /data\.append\('atendimento_id', form\.dataset\.atendimentoId\)/,
  'upload deve gravar diretamente o vínculo canônico do atendimento');
assert.match(ui, /data\.append\('item_procedimento_id', procedureItemId\)/,
  'upload deve aceitar vínculo direto ao item de procedimento');
assert.match(ui, /photoUploadKeys\.get\(file\)/,
  'retry de upload deve reutilizar a chave de idempotência do mesmo arquivo');
assert.match(ui, /photoMetadataKeys\.get\(files\[index\]\)/,
  'retry parcial da organização deve reutilizar a chave de cada foto já processada');
assert.match(ui, /photo_exact_duplicate/, 'SHA exato deve abrir o fluxo explícito de duplicidade');
assert.match(ui, /confirmar_arquivo_distinto/, 'exceção de foto distinta deve ser visível e protegida');
assert.match(ui, /data-procedimento-arquivar/, 'procedimento deve ter Apagar\/Arquivar visível');
assert.match(ui, /data-procedimento-restaurar/, 'procedimento arquivado deve ser restaurável');

// Simula timeout depois do commit: a segunda tentativa materialmente idêntica
// precisa reutilizar a chave do formulário, independentemente da nova prova.
let uuidCounter = 0;
const sandbox = {
  window: {
    __AMJ_TEST__: true,
    crypto: { randomUUID: () => `00000000-0000-4000-8000-${String(++uuidCounter).padStart(12, '0')}` }
  },
  document: { addEventListener() {}, getElementById() { return null; } },
  Intl, Date, Math, Number, String, Array, Object, Set, WeakMap, JSON, console
};
vm.runInNewContext(ui, sandbox, { filename: 'operacao.js' });
const intent = sandbox.window.AMJOperacaoClinica.__test;
const form = {};
const payload = {
  atendimento_id: 'a', produto_id: 'p', lote_id: 'l', tipo_evento: 'desperdicio',
  quantidade: 1, unidade: 'ml', ocorrido_em: '2026-08-24T12:00:00.000Z', motivo: 'teste'
};
const firstAttempt = intent.intentKeyForForm(form, payload);
const retryWithNewProof = intent.intentKeyForForm(form, Object.assign({ operation_id: 'nova-prova' }, payload));
assert.equal(retryWithNewProof, firstAttempt,
  'retry do mesmo consumo deve reutilizar a chave, sem depender da nova prova');
assert.notEqual(intent.intentKeyForForm(form, Object.assign({}, payload, { quantidade: 2 })), firstAttempt,
  'alteração material deve iniciar outro intento');
const confirmedKey = intent.intentKeyForForm(form, payload);
intent.confirmFormIntent(form, confirmedKey);
assert.notEqual(intent.intentKeyForForm(form, payload), confirmedKey,
  'sucesso confirmado deve liberar uma nova operação futura');
for (const action of [
  'registrar_preferencia_contato', 'registrar_perfil_paciente', 'registrar_ficha_custo'
]) {
  const position = ui.indexOf("protectedRequest('" + action + "'");
  assert(position >= 0, 'ação operacional ausente: ' + action);
  const context = ui.slice(Math.max(0, position - 700), position + 500);
  assert.match(context, /intentKeyForForm\(/, action + ' deve preservar a chave no retry');
  assert.match(context, /confirmFormIntent\(/, action + ' deve limpar a chave somente após sucesso');
}
const withdrawalIntent = ui.indexOf('intentKeyForForm(retireCost, payload)');
assert(withdrawalIntent >= 0, 'retirada da ficha de custo deve persistir a chave');
assert.match(ui.slice(withdrawalIntent, withdrawalIntent + 600),
  /protectedRequest\('registrar_ficha_custo'[\s\S]*confirmFormIntent\(retireCost, intentKey\)/,
  'retirada da ficha de custo deve limpar a chave somente após sucesso');

assert.match(migration, /atendimentos_realizados_patient_day_unique/, 'visita deve ser única por paciente e dia');
assert.match(migration, /:attendance-day:/,
  'concorrência de paciente/dia deve ser serializada antes de devolver o existente');
assert.match(migration, /:attendance-appointment:/,
  'duplo vínculo do agendamento deve ser serializado');
assert.match(migration, /procedure_region text/, 'região deve pertencer ao item canônico');
assert.match(migration, /performed_at timestamptz not null/, 'horário deve pertencer ao item canônico');
assert.match(migration, /procedure_duplicate_exists[\s\S]*detail = v_exact_duplicate_id::text/,
  'duplicata exata deve devolver o ID existente');
assert.match(migration, /procedure_possible_duplicate_requires_review/,
  'possível repetição deve exigir conferência explícita');
assert.match(migration, /retorno_recomendacoes_material_active_unique[\s\S]*status in \('ativa', 'convertida'\)/,
  'retorno convertido não deve poder ser recriado como duplicata exata');
assert.match(migration, /p_status in \('concluido', 'cancelado', 'bloqueado'\)[\s\S]*p_next_action <> 'nenhuma'/,
  'retorno fechado não deve manter próxima ação pendente');
assert.match(migration, /private\.operacao_replay_guard/,
  'atualizações mutáveis devem comparar operation_id e payload material');
assert.doesNotMatch(migration, /atendimento_foto_vinculos/,
  'protocol_photos deve ser a única fonte das fotos');
assert.doesNotMatch(migration, /pg_catalog\.(?:coalesce|nullif|greatest|least)\s*\(/i,
  'expressões condicionais especiais do PostgreSQL não aceitam qualificação de schema');

console.log('operacao-ui.test.cjs: ok');

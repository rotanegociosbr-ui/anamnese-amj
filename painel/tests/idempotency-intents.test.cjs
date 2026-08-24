'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const project = path.resolve(__dirname, '..', '..');
const managementSource = fs.readFileSync(path.join(project, 'painel', 'gestao.js'), 'utf8');

function loadUi(file, apiName) {
  const source = fs.readFileSync(path.join(project, 'painel', file), 'utf8');
  let counter = 0;
  const sandbox = {
    window: {
      __AMJ_TEST__: true,
      crypto: {
        randomUUID: () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`
      }
    },
    document: {
      readyState: 'loading',
      addEventListener() {},
      getElementById() { return null; }
    },
    Intl, Date, Math, Number, String, Array, Object, Set, Map, WeakMap, JSON,
    AbortController, FormData, console
  };
  vm.runInNewContext(source, sandbox, { filename: file });
  return sandbox.window[apiName].__test;
}

const protocol = loadUi('prontuario.js', 'AMJProntuario');
const protocolForm = {};
const protocolPayload = {
  protocolo_id: null,
  paciente_id: 'paciente-1',
  tipo_procedimento: 'toxina_botulinica',
  data_procedimento: '2026-08-24',
  produtos: [{ product_id: 'produto-1', lot: 'L1', amount: 1, unit: 'un' }],
  consentimentos: { clinical_photography: false }
};
const protocolFirst = protocol.protocolIntentKey(protocolForm, protocolPayload);
const protocolRetry = protocol.protocolIntentKey(
  protocolForm,
  Object.assign({ operation_id: 'nova-prova-nao-material' }, protocolPayload)
);
assert.equal(protocolRetry, protocolFirst,
  'retry do mesmo prontuário deve reutilizar a chave após timeout');
assert.notEqual(protocol.protocolIntentKey(protocolForm, Object.assign({}, protocolPayload, {
  produtos: [{ product_id: 'produto-1', lot: 'L1', amount: 2, unit: 'un' }]
})), protocolFirst, 'mudança de consumo deve iniciar outro intento de prontuário');
const protocolConfirmed = protocol.protocolIntentKey(protocolForm, protocolPayload);
protocol.confirmProtocolIntent(protocolForm, protocolConfirmed);
assert.notEqual(protocol.protocolIntentKey(protocolForm, protocolPayload), protocolConfirmed,
  'sucesso confirmado deve liberar um novo prontuário futuro');

const management = loadUi('gestao.js', 'AMJGestaoAdministrativa');
const settlementForm = {};
const settlementPayload = {
  conta_id: 'conta-1', pagamento_id: 'pagamento-1', valor_bruto: 600,
  taxa: 0, valor_liquido: 600, liquidado_em: '2026-08-24T12:00', referencia: 'PIX'
};
const settlementFirst = management.intentIdForForm(settlementForm, settlementPayload);
const settlementRetry = management.intentIdForForm(
  settlementForm,
  Object.assign({ operation_id: 'outra-prova-nao-material' }, settlementPayload)
);
assert.equal(settlementRetry, settlementFirst,
  'retry da mesma liquidação deve reutilizar liquidacao_id após timeout');
assert.notEqual(management.intentIdForForm(settlementForm, Object.assign({}, settlementPayload, {
  valor_bruto: 300, valor_liquido: 300
})), settlementFirst, 'liquidação parcial materialmente diferente deve receber outro ID');
const settlementConfirmed = management.intentIdForForm(settlementForm, settlementPayload);
management.confirmFormIntent(settlementForm, settlementConfirmed);
assert.notEqual(management.intentIdForForm(settlementForm, settlementPayload), settlementConfirmed,
  'sucesso confirmado deve liberar outra liquidação legítima');

for (const action of ['registrar_conciliacao', 'criar_manutencao', 'registrar_evidencia_backup']) {
  const position = managementSource.indexOf("'" + action + "'");
  assert(position >= 0, 'ação administrativa ausente: ' + action);
  const context = managementSource.slice(Math.max(0, position - 900), position + 700);
  assert.match(context, /intentIdForForm\(/, action + ' deve persistir o ID do intento');
  assert.match(context, /confirmFormIntent\(/, action + ' deve limpar o intento somente após sucesso');
}

console.log('OK: retries de prontuário e liquidação preservam o intento idempotente.');

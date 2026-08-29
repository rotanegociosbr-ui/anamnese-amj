'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..', '..');
const html = fs.readFileSync(path.join(root, 'agendar', 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(root, 'agendar', 'agendar.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'agendar', 'agendar.css'), 'utf8');

assert.match(js, /functions\/v1\/agendamento-submit/,
  'formulário público deve usar somente a Edge Function dedicada');
assert.match(html, /agendar\.css\?v=20260829-2/,
  'CSS do agendamento deve usar a versão atual para evitar cache antigo');
assert.match(html, /agendar\.js\?v=20260829-2/,
  'JavaScript do agendamento deve usar a versão atual para evitar cache antigo');
assert.match(js, /apikey: CONFIG\.PUBLISHABLE_KEY[\s\S]*?Authorization: `Bearer \$\{CONFIG\.PUBLISHABLE_KEY\}`/,
  'cliente público deve enviar apenas a chave publicável');
assert.match(js, /cache: "no-store"[\s\S]*?referrerPolicy: "no-referrer"/,
  'solicitação pública não pode usar cache nem enviar referrer');
assert.match(js, /response\.status !== 202[\s\S]*?form\.hidden = true[\s\S]*?success\.hidden = false/,
  'sucesso só pode aparecer depois da confirmação HTTP 202');
assert.match(js, /state\.lastSignature[\s\S]*?state\.lastSignature !== signature[\s\S]*?idempotency\.value = uuid\(\)/,
  'tentativa igual deve preservar a chave e edição do payload deve gerar nova intenção');
assert.match(js, /new AbortController\(\)[\s\S]*?CONFIG\.TIMEOUT_MS/,
  'envio deve ter cancelamento por tempo limite');
assert.doesNotMatch(js, /window\.location|form\.reset\(/,
  'falha não pode apagar os dados nem redirecionar automaticamente');

for (const marker of ['agendamento-idempotency', 'agendamento-started-at', 'agendamento-website',
  'agendamento-sucesso', 'agendamento-whatsapp']) {
  assert.ok(html.includes(marker), 'marcador de captura segura ausente: ' + marker);
}
assert.match(html, /name="website"[^>]*tabindex="-1"[^>]*autocomplete="off"/,
  'honeypot deve ficar fora da navegação e do preenchimento automático');
assert.match(html, /id="agendamento-whatsapp"[\s\S]*?target="_blank"[\s\S]*?Abrir WhatsApp para avisar a clínica/,
  'WhatsApp deve ser oferecido somente como ação manual após sucesso');
assert.match(html, /Este texto não é salvo no pedido[\s\S]*?decidir enviar pelo WhatsApp[\s\S]*?Não informe doenças/,
  'campo objetivo deve explicar com transparência que não é persistido nem deve receber dados de saúde');
assert.match(html, /role="status" aria-live="polite" aria-atomic="true"/,
  'mudanças de estado devem ser anunciadas sem repetir o formulário');
assert.match(css, /\.booking-honeypot\s*\{[\s\S]*?clip-path: inset\(50%\)/,
  'honeypot deve ficar invisível sem usar type=hidden');
assert.match(css, /\.field-help,[\s\S]*?font-size: 13px/,
  'ajuda do formulário precisa permanecer legível no celular');
assert.match(css, /\.booking-success \.button[\s\S]*?min-height: 52px/,
  'ação manual após sucesso deve ter alvo de toque adequado');
assert.match(css, /\.consent-field input:focus-visible[\s\S]*?outline:/,
  'consentimento precisa de foco visível para navegação por teclado');
assert.match(css, /@media \(max-width: 650px\)/,
  'página deve preservar a composição específica para celular');

const sandbox = {
  window: { crypto: crypto.webcrypto },
  document: { querySelector: () => null },
  Uint8Array, Math, Date, Object, String, JSON, encodeURIComponent, console
};
vm.runInNewContext(js, sandbox, { filename: 'agendar.js' });
const runtime = sandbox.window.AMJAgendamentoSite.__test;
const values = new Map([
  ['website', ''], ['nome', '  Maria Teste  '], ['telefone', '(31) 99999-0000'],
  ['primeira_visita', 'primeira_avaliacao'], ['interesse', 'toxina_botulinica'],
  ['data_preferida', '2026-09-05'], ['periodo', 'tarde'], ['consentimento_contato', 'on'],
  ['objetivo', 'Quero conversar sobre linhas de expressão']
]);
const data = { get: (name) => values.get(name) };
const payload = runtime.requestPayload(data, {
  idempotencyKey: '00000000-0000-4000-8000-000000000001',
  startedAt: '2026-08-29T12:00:00.000Z'
});

assert.deepEqual(Object.keys(payload), [
  'idempotency_key', 'started_at', 'website', 'nome', 'telefone', 'primeira_visita',
  'interesse', 'data_preferida', 'periodo', 'consentimento_contato'
]);
assert.equal(payload.telefone, '31999990000');
assert.equal(payload.nome, 'Maria Teste');
assert.equal(payload.consentimento_contato, true);
assert.equal(Object.hasOwn(payload, 'objetivo'), false,
  'objetivo livre nunca pode ser enviado à API');

const whatsappUrl = runtime.buildWhatsAppUrl(data, 'AMJ-TESTE');
assert.match(whatsappUrl, /^https:\/\/wa\.me\/5531995844803\?text=/);
const whatsappText = decodeURIComponent(whatsappUrl.split('?text=')[1]);
assert.match(whatsappText, /Código da solicitação: AMJ-TESTE/);
assert.match(whatsappText, /Quero conversar sobre linhas de expressão/,
  'objetivo pode permanecer somente na mensagem manual revisada pela pessoa');
assert.equal(runtime.formatDate('2026-09-05'), '05/09/2026');

console.log('fase5b-agendamento-site-ui.test.cjs: captura, privacidade, idempotência e mobile OK');

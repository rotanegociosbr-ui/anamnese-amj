'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const panel = path.resolve(__dirname, '..');
const shellSource = fs.readFileSync(path.join(panel, 'app-shell.js'), 'utf8');
const html = fs.readFileSync(path.join(panel, 'index.html'), 'utf8');
const crm = fs.readFileSync(path.join(panel, 'crm.js'), 'utf8');
const integrations = fs.readFileSync(path.join(panel, 'integracoes.js'), 'utf8');

function loadWhatsApp(navigatorValue) {
  const sandbox = {
    window: {},
    document: { readyState: 'loading', addEventListener() {} },
    navigator: navigatorValue,
    Intl, Date, Set, Map, Object, String, encodeURIComponent, console
  };
  vm.runInNewContext(shellSource, sandbox, { filename: 'app-shell.js' });
  return sandbox.window.AMJWhatsApp;
}

const desktop = loadWhatsApp({ userAgentData: { mobile: false }, userAgent: 'Windows' });
assert.equal(desktop.mode(), 'web');
assert.equal(desktop.label(), 'WhatsApp Web');
assert.equal(
  desktop.url('(31) 99999-0000', 'Olá, Ana!'),
  'https://web.whatsapp.com/send?phone=31999990000&text=Ol%C3%A1%2C%20Ana!'
);

const mobile = loadWhatsApp({ userAgentData: { mobile: true }, userAgent: 'Android' });
assert.equal(mobile.mode(), 'mobile');
assert.equal(mobile.label(), 'WhatsApp');
assert.equal(
  mobile.url('5531999990000', 'Confirmar presença'),
  'https://wa.me/5531999990000?text=Confirmar%20presen%C3%A7a'
);

const ipadDesktopUa = loadWhatsApp({
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)',
  platform: 'MacIntel', maxTouchPoints: 5
});
assert.equal(ipadDesktopUa.mode(), 'mobile', 'iPad com UA de desktop deve abrir o aplicativo');

assert.equal(desktop.contract.assisted, true);
assert.equal(desktop.contract.automaticSend, false);
assert.equal(desktop.contract.externalApi, false);
assert.match(html, /urlWhatsAppAssistido\(numero, agendaMensagemWhatsApp/,
  'lembretes da agenda devem usar o destino assistido');
assert.match(html, /rotuloWhatsAppAssistido\(\)/,
  'a interface deve informar se abrirá WhatsApp Web ou aplicativo');
assert.match(html, /No computador, abre o WhatsApp Web conectado[\s\S]*?nunca marca a mensagem como enviada automaticamente/,
  'a agenda deve explicar que abrir a conversa não comprova o envio');
assert.match(html, /id="cv-enviar">Abrir mensagem no WhatsApp/,
  'o convite não pode prometer envio antes do clique humano no WhatsApp');
assert.match(crm, /window\.AMJWhatsApp\.url\(number, message\)/,
  'pedidos do CRM devem compartilhar o mesmo seletor seguro');
assert.match(integrations, /WhatsApp Web assistido[\s\S]*?envia manualmente/,
  'a Central deve deixar claro que o envio final continua humano');
assert.doesNotMatch(integrations, /data-integracoes-(?:enviar|automatizar|conectar-whatsapp)/,
  'a Central não pode prometer envio automático ou conexão por scraping');

console.log('whatsapp-web-assisted.test.cjs: desktop, celular e envio manual OK');

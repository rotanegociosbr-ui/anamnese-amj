'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
test('existing history appears before the closed new-record editor', () => {
  const panel = html.slice(html.indexOf('id="aba-prontuarios"'), html.indexOf('id="aba-financeiro"'));
  assert(panel.indexOf('id="prontuario-lista-card"') < panel.indexOf('id="prontuario-editor"'));
  assert.match(panel, /<details[^>]*id="prontuario-editor">/);
  assert.match(panel, /id="prontuario-mostrar-arquivados"[^>]*checked/);
  assert.match(panel, /id="prontuario-novo"[^>]*>Novo registro</);
  assert.match(panel, /id="prontuario-limpar-paciente"/);
  for (const id of ['prontuario-lista', 'prontuario-busca', 'prontuario-form', 'prontuario-editor']) {
    assert.equal((html.match(new RegExp('id="' + id + '"', 'g')) || []).length, 1, id + ' remains unique');
  }
});
test('home links to saved clinical history, with intake documents separately named', () => {
  const home = html.slice(html.indexOf('id="aba-inicio"'), html.indexOf('id="aba-crm"'));
  assert.match(home, /data-shell-route="prontuarios"[\s\S]*?<strong>Prontuários e fotos<\/strong>/);
  assert.match(home, /<strong>Fichas e termos<\/strong>/);
  assert.match(html, /<h2>Prontuários e fotos<\/h2>/);
  assert.match(html, /<h2>Fichas e termos<\/h2>/);
});

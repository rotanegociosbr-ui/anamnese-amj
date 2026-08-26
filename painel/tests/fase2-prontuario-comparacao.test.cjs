const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');
const js = fs.readFileSync(path.join(root, 'painel', 'prontuario.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'painel', 'prontuario.css'), 'utf8');

assert.match(js, /function renderPhotoComparison\(protocol, photos\)/);
assert.match(js, /consent\(protocol, 'clinical_photography'\)/);
assert.match(js, /function comparablePhoto\(photo, phase\)[\s\S]+photo\.archived_at/);
assert.match(js, /safeSignedPhotoUrl\(photo\.miniatura_url\)[\s\S]+safeSignedPhotoUrl\(photo\.url_assinada\)/);
assert.match(js, /comparisonTimestamp[\s\S]+taken_at[\s\S]+captured_at[\s\S]+created_at/);
assert.match(js, /safeDate\(rawDate\)/);
assert.match(js, /A autorização para marketing é independente/);
assert.match(js, /alt="Foto clínica privada para comparação /);
assert.doesNotMatch(js, /alt="[^\n"]*(patient_name|full_name|nome_paciente)/i);
assert.match(js, /prontuario-comparacao-pendente/);
assert.match(js, /renderPhotoComparison\(protocol, photos\)[\s\S]+prontuario-galerias/);
assert.match(js, /__test[\s\S]+renderPhotoComparison/);
assert.match(css, /\.prontuario-comparacao-grade\s*\{[\s\S]+grid-template-columns:\s*repeat\(2,/);
assert.match(css, /@media\s*\(max-width:\s*430\.98px\)[\s\S]+\.prontuario-comparacao-grade/);

console.log('fase2-prontuario-comparacao: ok');

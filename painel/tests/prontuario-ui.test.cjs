'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const panelDir = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(panelDir, 'prontuario.js'), 'utf8');
const html = fs.readFileSync(path.join(panelDir, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(panelDir, 'prontuario.css'), 'utf8');
const sandbox = {
  window: { __AMJ_TEST__: true, crypto: { randomUUID: () => '00000000-0000-4000-8000-000000000001' } },
  document: {
    readyState: 'loading',
    addEventListener() {},
    getElementById() { return null; }
  },
  Intl, Date, Math, Number, String, Array, Object, Set, Map, WeakMap, JSON, URL,
  AbortController, FormData, console
};
vm.runInNewContext(source, sandbox, { filename: 'prontuario.js' });
const ui = sandbox.window.AMJProntuario.__test;

const consultation = {
  id: 'consulta-1',
  patient_id: 'paciente-1',
  paciente: { id: 'paciente-1', nome: 'Ana Maria' },
  procedure_kind: 'toxina_botulinica',
  procedure_date: '2026-08-24',
  return_date: '2026-09-07',
  status: 'draft',
  version: 3,
  produtos: [{
    product_id: 'produto-1',
    product_name_snapshot: 'Toxina A',
    brand_name_snapshot: 'Marca Segura',
    lot: 'LOTE-9',
    amount: 1.5,
    unit: 'mL',
    expiry: '2027-01-30'
  }],
  fotos_resumo: { ativas: 0, total: 0, produtos_utilizados: 0 },
  consentimentos_atuais: { clinical_photography: true }
};

const pendingHtml = ui.renderConsultation(consultation, false);
assert.match(pendingHtml, /Foto pendente/);
assert.match(pendingHtml, /Em andamento/);
assert.match(pendingHtml, /data-prontuario-finalizar="consulta-1"/);
assert.match(pendingHtml, /Finalizar consulta/);
assert.match(pendingHtml, /Adicionar fotos/);
assert.match(pendingHtml, /Quantidade 1,5 mL/);
assert.match(pendingHtml, /Lote LOTE-9/);
assert.match(pendingHtml, /Carregar galeria \(0\)/);

ui.setPhotoPage('consulta-1', {
  items: [
    { id: 'foto-1', phase: 'before', url_assinada: 'https://rjxtxoqprnumouqakxbc.supabase.co/original?token=abc&x=1', miniatura_url: 'https://rjxtxoqprnumouqakxbc.supabase.co/thumb?token=def' },
    { id: 'foto-2', phase: 'during', url_assinada: 'https://rjxtxoqprnumouqakxbc.supabase.co/during?token=ghi' },
    { id: 'foto-3', phase: 'after', url_assinada: 'https://rjxtxoqprnumouqakxbc.supabase.co/after?token=jkl' },
    { id: 'foto-4', phase: 'products_used', url_assinada: 'https://rjxtxoqprnumouqakxbc.supabase.co/product?token=mno', lot_snapshot: 'LOTE-9' }
  ],
  page: 1,
  hasMore: false,
  loading: false,
  error: ''
});
const galleryHtml = ui.renderConsultation(Object.assign({}, consultation, {
  fotos_resumo: { ativas: 4, total: 4, produtos_utilizados: 1 }
}), false);
for (const label of ['Antes', 'Durante', 'Depois', 'Produtos utilizados']) {
  assert.match(galleryHtml, new RegExp(`Fotos: ${label}`), `galeria ausente: ${label}`);
}
assert.match(galleryHtml, /Foto registrada/);
assert.match(galleryHtml, />Abrir original<\/a>/);
assert.match(galleryHtml, /rel="noopener noreferrer" referrerpolicy="no-referrer"/);
assert.match(galleryHtml, /loading="lazy" decoding="async" referrerpolicy="no-referrer"/);
assert.match(galleryHtml, /token=abc&amp;x=1/);
assert.match(galleryHtml, />Arquivar<\/button>/);

const completedHtml = ui.renderConsultation(Object.assign({}, consultation, { status: 'signed' }), false);
assert.match(completedHtml, /Consulta concluída/);
assert.match(completedHtml, /Abrir dados e fotos/);
assert.match(completedHtml, /Fotos clínicas autorizadas/);
assert.match(completedHtml, /Revogar autorização de fotos/);
assert.doesNotMatch(completedHtml, /data-prontuario-finalizar=/);
const revokedCompletedHtml = ui.renderConsultation(Object.assign({}, consultation, {
  status: 'signed', consentimentos_atuais: { clinical_photography: false }
}), false);
assert.match(revokedCompletedHtml, /Fotos clínicas não autorizadas/);
assert.match(revokedCompletedHtml, /Registrar autorização de fotos/);
assert.doesNotMatch(revokedCompletedHtml, /data-prontuario-adicionar-fotos=/);
assert.equal(ui.isCompleted({ status: 'signed' }), true);
assert.equal(ui.procedureLabel('toxina_botulinica'), 'Toxina botulínica');
assert.equal(ui.procedureLabel('preenchimento'), 'Preenchimento');
assert.equal(ui.procedureLabel('bioestimulador'), 'Bioestimulador');
assert.equal(ui.procedureLabel('avaliacao_facial'), 'Avaliação facial');
assert.equal(ui.procedureLabel('procedimento_especial'), 'procedimento_especial');
assert.equal(ui.clinicalPhotoCount({ fotos_resumo: { ativas: 1, produtos_utilizados: 1 } }), 0);
assert.equal(ui.clinicalPhotoCount({ fotos_resumo: { ativas: 2, produtos_utilizados: 1 } }), 1);
assert.match(ui.renderConsultation(Object.assign({}, consultation, {
  fotos_resumo: { ativas: 1, total: 1, produtos_utilizados: 1 }
}), false), /Foto pendente/);
assert.equal(ui.phaseLabel('during'), 'Durante');
assert.equal(ui.phaseLabel('products_used'), 'Produtos utilizados');

const archivedPhoto = ui.renderPhotoCard({ id: 'foto-x', phase: 'after', archived_at: '2026-08-24T12:00:00Z' }, consultation, true);
assert.match(archivedPhoto, />Restaurar<\/button>/);
assert.doesNotMatch(archivedPhoto, /Abrir original/);
assert.doesNotMatch(ui.renderPhotoCard({
  id: 'foto-insegura', phase: 'before', url_assinada: 'javascript:alert(1)'
}, consultation, false), /javascript:/);
assert.doesNotMatch(ui.renderPhotoCard({
  id: 'foto-outro-tenant', phase: 'before', url_assinada: 'https://outro-projeto.supabase.co/foto'
}, consultation, false), /Abrir original/);

const groups = ui.groupProtocols([
  consultation,
  Object.assign({}, consultation, { id: 'consulta-2', procedure_date: '2026-08-25' }),
  Object.assign({}, consultation, { id: 'consulta-3', patient_id: 'paciente-2', paciente: { nome: 'Beatriz' } })
]);
assert.equal(groups.length, 2);
assert.equal(groups[0].name, 'Ana Maria');
assert.deepEqual(Array.from(groups[0].consultations, item => item.id), ['consulta-2', 'consulta-1']);

assert.match(source, /protectedRequest\('finalizar',[\s\S]*?protocolo_id: item\.id,[\s\S]*?versao_esperada: expectedVersion\(item\)/);
assert.match(source, /protectedRequest\('alterar_consentimento_fotografia',[\s\S]*?protocolo_id: item\.id,[\s\S]*?aceito: accepted/,
  'consentimento em signed deve usar ação protegida separada');
assert.match(source, /requiredPhoto: true/);
assert.match(source, /photoMessage: 'Etapa obrigatória:/);
assert.match(source, /prontuario-produto-quantidade[^>]+max="1000000"/,
  'quantidade máxima exibida deve coincidir com Edge e banco');
assert.match(source, /Number\.isFinite\(amount\)[\s\S]{0,100}amount > 1000000/,
  'coleta deve rejeitar quantidade não finita ou acima de 1.000.000');
assert.doesNotMatch(source, /max="999999999"/,
  'editor não pode prometer valor que o backend rejeita');
assert.match(source, /addEventListener\('toggle',[\s\S]*?if \(photoPageNeedsRefresh\(protocolId\)\) loadPhotos\(protocolId, false\)/);
assert.match(source, /loadedAt: Date\.now\(\)/);
assert.match(source, /function renderPhotoState\(\)[\s\S]*?render\(\);[\s\S]*?focusConsultationSummary\(key\)/,
  'renderização assíncrona da galeria deve restaurar o foco no resumo da consulta');
assert.match(source, /const requestToken = uuid\(\)/);
assert.match(source, /latest\.requestToken === requestToken/);
assert.match(source, /byId\('prontuario-mostrar-arquivados'\)\.checked === showArchived/);
assert.match(source, /const groups = groupProtocols\(rows\)/);
assert.match(source, /prontuario-paciente-grupo/);
assert.match(source, /abrirProtocolo: openProtocol, editar: openProtocol/);
assert.match(source, /option\.dataset\.protocolGenerated = 'true'/);
assert.match(source, /setProtocolReadOnly\(completed\)/);
assert.match(source, /prontuario-somente-leitura/);
assert.match(html, /<h2>Pacientes e consultas<\/h2>/);
assert.match(html, /<option value="during">Durante<\/option>/);
assert.match(html, /Limite de 25 MB/);
assert.match(html, /prontuario\.js\?v=20260826-1/);
assert.match(html, /prontuario\.css\?v=20260826-1/);
assert.match(css, /\.prontuario-paciente-grupo/);
assert.match(css, /\.prontuario-galerias/);
assert.match(css, /scroll-margin-top:88px/,
  'editor deve parar abaixo da barra superior fixa');
assert.match(source, /prontuario-editor'\)\.querySelector\('summary'\)[\s\S]*?focus\(\{ preventScroll: true \}\)/,
  'navegação externa deve mover o foco para o editor aberto');
const openProtocolBody = source.slice(
  source.indexOf('function openProtocol(protocolId)'),
  source.indexOf('\n  function reset()', source.indexOf('function openProtocol(protocolId)'))
);
assert.match(openProtocolBody, /load\(\{ silent: true \}\)/,
  'abertura vinda da Operação deve atualizar o protocolo autoritativo');
assert.doesNotMatch(openProtocolBody, /if \(state\.loaded\)/,
  'cache loaded não pode abrir draft antigo ou omitir protocolo recém-criado');
assert.match(css, /@media\(max-width:640px\)/);

console.log('OK: prontuário organiza Paciente → Consultas com galerias privadas sob demanda e finalização protegida.');

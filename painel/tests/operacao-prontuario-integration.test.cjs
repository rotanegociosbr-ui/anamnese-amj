const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..', '..');
const ui = fs.readFileSync(path.join(root, 'painel', 'operacao.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'painel', 'operacao.css'), 'utf8');
const edge = fs.readFileSync(
  path.join(root, 'supabase', 'functions', 'operacao-clinica-fichas', 'index.ts'),
  'utf8'
);
const medicalRecordEdge = fs.readFileSync(
  path.join(root, 'supabase', 'functions', 'prontuario-fichas', 'index.ts'),
  'utf8'
);
const finalizeMigration = fs.readFileSync(
  path.join(root, 'supabase', 'migrations', '20260824064000_finalizacao_prontuario_exige_foto.sql'),
  'utf8'
);
const shell = fs.readFileSync(path.join(root, 'painel', 'app-shell.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'painel', 'index.html'), 'utf8');
const migration = fs.readFileSync(
  path.join(root, 'supabase', 'migrations', '20260824063000_integracao_consulta_prontuario_fotos.sql'),
  'utf8'
);

assert.match(ui, /Preparar prontuário e fotos/);
assert.match(ui, /data-fotos-atalho[^>]*aria-labelledby="operacao-fotos-atalho-titulo"/,
  'atalho direto deve ficar no topo de Procedimentos e possuir nome acessível');
assert.match(ui, /data-fotos-atalho-atendimento[^>]*aria-label="Paciente e atendimento para adicionar fotos"/,
  'atalho deve exigir a consulta exata antes de abrir a galeria');
assert.match(ui, /function updatePhotoShortcut\(\)[\s\S]*?clinical_photography_consented === true/,
  'atalho deve explicar prontuário, consentimento e galeria sem pular etapas');
assert.match(ui, /function openPhotoShortcutFlow\(id\)[\s\S]*?prepareAttendanceProtocol\(visit\.id, visit\.version\)/,
  'preparo iniciado pelo atalho deve usar a versão e proteção canônicas');
assert.match(ui, /function openPhotoShortcutFlow\(id\)[\s\S]*?AMJProntuario\.abrirProtocolo\(visit\.protocol_id\)/,
  'sem autorização, o atalho deve conduzir ao prontuário correto');
assert.match(ui, /function openPhotoShortcutFlow\(id\)[\s\S]*?openAttendancePhotos\(attendanceId\)/,
  'com autorização, o atalho deve abrir a única galeria canônica da consulta');
assert.match(ui, /Fotos da consulta/,
  'cada atendimento deve expor o acesso direto às fotos da consulta');
assert.match(ui, /data-fotos-abrir/);
assert.match(ui, /abrirFotos:\s*openAttendancePhotos/);
assert.match(ui, /Finalizar registro da consulta/);
assert.match(ui, /protectedRequest\('preparar_prontuario_atendimento'/,
  'preparação deve pedir prova recente pelo fluxo protegido');
assert.match(ui, /protectedProntuarioRequest\('finalizar'/,
  'finalização documental deve usar o backend do prontuário e prova recente');
assert.match(ui, /jsonRequest\('listar_fotos_atendimento'/,
  'originais e URLs assinadas devem ser carregados somente ao abrir a galeria');
assert.match(ui, /<option value="durante">Durante<\/option>/,
  'upload operacional deve expor a fase clínica Durante');
assert.match(ui, /Produtos, ativos e ampolas/,
  'categoria de materiais deve mencionar explicitamente ativos e ampolas');
for (const category of ['Antes', 'Durante', 'Depois', 'Produtos, ativos e ampolas', 'Arquivadas']) {
  assert.match(ui, new RegExp("countChip\\('" + category.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + "'"),
    'contagem separada ausente: ' + category);
}
assert.match(ui, /name="arquivos"[^>]+multiple/,
  'seleção múltipla deve permanecer disponível');
assert.match(ui, /name="camera"[^>]+capture="environment"/,
  'captura traseira deve ser uma opção separada no celular');
assert.match(ui, /selectedPhotoFiles\(uploadForm\)/,
  'envio deve combinar câmera e seleção múltipla');
assert.match(ui, /createPhotoThumbnail\(file\)/);
assert.match(ui, /data\.append\('miniatura', thumbnail, thumbnail\.name\)/,
  'Operação deve enviar miniatura WebP separada do original');
assert.match(ui, /Para categorias, produtos ou lotes diferentes, faça envios separados/,
  'metadados compartilhados pelo lote de arquivos devem ser explicados');
assert.match(ui, /const photoUploadContexts = new WeakMap\(\)/,
  'retry parcial deve guardar o contexto imutável de cada arquivo');
assert.match(ui, /rememberPhotoUploadContext\(form, file\)[\s\S]*photoUploadResults\.has\(file\)/,
  'resultado já enviado só pode ser reutilizado depois de conferir o mesmo contexto');
assert.match(ui, /Esta foto já iniciou um envio com outros dados/,
  'mudança de consulta, categoria, data, procedimento, produto ou lote deve falhar de forma clara');
assert.match(ui, /const photoMetadataContexts = new WeakMap\(\)/,
  'retry parcial do vínculo deve guardar o fingerprint dos metadados');
assert.match(ui, /metadataForUploadedPhoto\(uploadForm, files\[index\], photo\)/,
  'cada item do lote deve reutilizar sua chave somente com metadados idênticos');
assert.match(ui, /Atualize a galeria para recuperar o que foi salvo/,
  'mudança após falha parcial deve orientar recuperação sem duplicar o vínculo');
assert.match(ui, /referrerpolicy="no-referrer"/,
  'abertura do original não deve enviar referer');
assert.match(ui, /clinical_photography_consented === true/,
  'formulário de upload deve depender da autorização fotográfica atual');
assert.match(ui, /Abrir prontuário e registrar autorização/,
  'sem autorização, a galeria deve orientar a regularização sem enviar arquivo');
assert.match(ui, /prontuarioJsonRequest\('listar',[\s\S]{0,220}protocolo_id: id/,
  'produto/lote deve vir do protocolo específico, não do catálogo inteiro');
assert.match(ui, /protocolProductsById\.set\(id, products\)/);
assert.match(ui, /protocolProductRows\(form\.dataset\.protocoloId\)/);
assert.match(ui, /Boolean\(productId\) !== Boolean\(lot\)/,
  'produto e lote devem ser informados juntos ou ambos vazios');
assert.match(ui, /item\.product_name_snapshot[\s\S]{0,240}item\.brand_name_snapshot[\s\S]{0,240}productTypeLabel/,
  'seletor deve identificar nome, marca, tipo e unidade quando disponíveis');
assert.doesNotMatch(ui, /Informar outro lote/,
  'lote livre não pode escapar dos produtos registrados no prontuário');
const galleryStart = ui.indexOf('function renderAttendanceGallery');
const galleryEnd = ui.indexOf('\n  function renderAttendances', galleryStart);
const gallerySource = ui.slice(galleryStart, galleryEnd);
const consentGate = gallerySource.indexOf(': !photographyConsent');
const uploadForm = gallerySource.indexOf('data-form-foto-upload');
assert(consentGate >= 0 && uploadForm > consentGate,
  'gate de consentimento deve preceder o formulário de upload operacional');
assert.match(css, /operacao-antes-depois[\s\S]*repeat\(3,/,
  'Antes, Durante e Depois devem ter colunas próprias');
assert.match(css, /\.operacao-foto-contagens[^{]*\{[^}]*repeat\(5,/,
  'desktop deve exibir as cinco contagens da galeria');
assert.match(css, /@media \(max-width: 430\.98px\)[\s\S]*operacao-foto-contagens[\s\S]*grid-template-columns: 1fr/,
  'contagens devem empilhar em celular estreito');
assert.match(css, /\.operacao-fotos-consulta[^{]*\{[^}]*scroll-margin-top: 88px/,
  'atalho de fotos não deve parar sob a barra fixa');
assert.match(css,
  /\.operacao-card input:not\(\[type="checkbox"\]\):not\(\[type="file"\]\)[^{]*\{[^}]*letter-spacing: normal;[^}]*text-align: left;[^}]*text-transform: none;/,
  'inputs operacionais devem neutralizar o estilo tipográfico do login');

assert.match(edge, /"operacao\.preparar_prontuario_atendimento"[\s\S]*attendanceId/,
  'prova recente deve estar vinculada à action e ao atendimento');
assert.match(edge, /rpc\("operacao_preparar_prontuario_atendimento"/);
assert.match(edge, /case "listar_fotos_atendimento":/);
assert.match(edge, /case "preparar_prontuario_atendimento":/);
assert.match(edge, /status_clinico_alterado: false/);
assert.match(edge, /summaryAttendanceIds[\s\S]*attendance_id=\$\{filter\}/,
  'resumos devem ser buscados pelos IDs dos atendimentos efetivamente exibidos');
assert.doesNotMatch(edge,
  /operacao_consulta_prontuario_resumo\?select=\*&clinic_id=eq\.\$\{clinic\}&order=attendance_id\.asc&limit=\$\{limit\}/,
  'LIMIT independente não pode gerar falsas pendências de prontuário');

assert.match(migration, /private\.operacao_assert_owner\(/,
  'RPC deve revalidar owner, tenant e AAL2 no banco');
assert.match(migration, /member\.clinic_id = p_clinic_id[\s\S]*member\.user_id = v_attendance\.responsible_user_id/,
  'profissional deve vir do mesmo atendimento e tenant');
assert.match(migration, /member\.status = 'active'[\s\S]{0,120}member\.role in \('owner', 'professional'\)/,
  'assistente ou visualizador não pode ocupar o papel clínico do protocolo');
assert.match(migration, /p_appointment_id[\s\S]*clinic_id = p_clinic_id/,
  'agenda do editor de prontuário deve validar a clínica');
assert.match(migration, /v_attendance\.attended_at at time zone 'America\/Sao_Paulo'/,
  'data documental deve derivar da data local do atendimento');
assert.match(migration, /private\.prontuario_normalize_procedure_kind/);
assert.match(migration,
  /drop constraint if exists protocols_procedure_kind_check;[\s\S]*?\) not valid;[\s\S]*?validate constraint protocols_procedure_kind_check;/,
  'troca do domínio deve ser nominal, staged e validada');
assert.match(migration, /raise exception 'protocol_procedure_kind_noncanonical'/,
  'dados legados não canônicos devem falhar antes da troca, sem reclassificação');
assert.doesNotMatch(migration,
  /pg_get_constraintdef\(constraint_row\.oid\)[\s\S]*?procedure_kind/,
  'migration não pode apagar checks arbitrários por busca textual');
assert.match(migration, /protocol_products_unit_check[\s\S]*'aplicacao'/,
  'constraint de produtos deve aceitar a unidade oferecida pela UI');
assert.match(migration, /private\.prontuario_replace_products\([\s\S]*v_unit not in \([\s\S]*'aplicacao'/,
  'validação transacional de produtos deve usar o mesmo domínio de unidades');
assert.match(migration, /item\.phase in \('before', 'during', 'after'\)/);
assert.match(migration, /item\.phase = 'products_used'/);
assert.match(migration, /where item\.protocol_id = protocol\.id/,
  'contagem de fotos deve usar somente o protocolo confirmado no tenant');
assert.match(migration, /where current_consent\.protocol_id = protocol\.id/,
  'consentimento deve usar somente o protocolo confirmado no tenant');
assert.doesNotMatch(migration,
  /where (?:item|current_consent)\.protocol_id = attendance\.protocol_id/,
  'vínculo legado corrompido não pode atravessar tenant nas laterais da view');
assert.match(migration, /:attendance-protocol-prepare:/,
  'criação concorrente deve ser serializada por atendimento');
assert.match(migration, /private\.operacao_replay_guard/);
assert.doesNotMatch(migration, /select candidate\.\*[\s\S]*candidate\.patient_id/,
  'coincidência material não pode unir duas consultas reais');
assert.match(medicalRecordEdge, /procedureKind\.length > 120/,
  'Edge deve rejeitar tipo de procedimento acima do domínio de 120 caracteres');
assert.doesNotMatch(medicalRecordEdge, /safeText\(payload\.tipo_procedimento,\s*60\)/,
  'Edge não pode truncar silenciosamente o tipo de procedimento');
assert.match(medicalRecordEdge, /"aplicacao"/,
  'unidade oferecida pela UI deve ser aceita pelo Edge do prontuário');
assert.match(medicalRecordEdge,
  /const page = positiveInteger\(payload\.pagina,[\s\S]*?"limit=" \+ \(pageSize \+ 1\)[\s\S]*?"offset=" \+ offset/,
  'listagem de prontuários deve buscar pageSize+1 com offset explícito');
assert.match(medicalRecordEdge,
  /paginacao: \{ pagina: page, por_pagina: pageSize, tem_mais: hasMore \}/,
  'Edge deve expor se há outra página sem chamar o tamanho da página de total');
assert.doesNotMatch(medicalRecordEdge,
  /protocolos: result, total: result\.length/,
  'quantidade retornada não pode se passar por total do acervo');
const addPhotoStart = medicalRecordEdge.indexOf('async function handleAddPhoto(');
const addPhotoEnd = medicalRecordEdge.indexOf('\nasync function handleRemovePhoto(', addPhotoStart);
const addPhoto = medicalRecordEdge.slice(addPhotoStart, addPhotoEnd);
const preflight = addPhoto.indexOf('await assertPhotoUploadPreflight(');
const storageUpload = addPhoto.indexOf('await uploadPrivateImage(storagePath, file)');
assert(preflight >= 0 && storageUpload > preflight,
  'Edge deve confirmar tenant, protocolo ativo e consentimento antes do Storage');
assert.match(medicalRecordEdge,
  /protocols\?select=id,status,archived_at[\s\S]*clinic_id=eq\.[\s\S]*protocol_consent_current\?select=accepted,revoked_at/,
  'preflight deve validar protocolo no tenant antes do consentimento atual');
const finalizeArchivedCheck = finalizeMigration.indexOf('if v_protocol.archived_at is not null then');
const finalizeSignedCheck = finalizeMigration.indexOf("if v_protocol.status = 'signed' then");
assert(finalizeArchivedCheck >= 0 && finalizeArchivedCheck < finalizeSignedCheck,
  'protocolo arquivado deve ser rejeitado antes do retorno signed idempotente');
assert.match(shell, /operacao\.js\?v=20260824-5/,
  'cache-bust deve entregar o JavaScript atualizado da Operação');
assert.match(html, /operacao\.css\?v=20260824-5/,
  'cache-bust deve entregar o CSS atualizado da Operação');
assert.match(html, /app-shell\.js\?v=[^"']+/,
  'cache-bust do shell deve entregar a referência atualizada da Operação');
assert.match(html, /id="prontuario-busca"[^>]+aria-label="[^"]+"/,
  'busca do prontuário deve ter nome acessível');

const prepareStart = migration.indexOf('create or replace function public.operacao_preparar_prontuario_atendimento');
const prepareEnd = migration.indexOf('\n$function$;', prepareStart);
assert(prepareStart >= 0 && prepareEnd > prepareStart);
const prepareRpc = migration.slice(prepareStart, prepareEnd);
const foreignAttendanceGuardStart = prepareRpc.indexOf(
  'select 1 from public.atendimentos_realizados other_attendance'
);
assert(foreignAttendanceGuardStart >= 0,
  'reuso da chave deve verificar se o protocolo já pertence a outro atendimento');
const foreignAttendanceGuard = prepareRpc.slice(
  foreignAttendanceGuardStart,
  foreignAttendanceGuardStart + 420
);
assert.match(foreignAttendanceGuard, /other_attendance\.id <> p_attendance_id/,
  'chave de idempotência deve permanecer vinculada ao atendimento original');
assert.doesNotMatch(foreignAttendanceGuard, /other_attendance\.archived_at/,
  'atendimento arquivado continua reservando permanentemente a chave/protocolo');
assert.doesNotMatch(prepareRpc, /insert into public\.protocol_consents|insert into public\.protocol_photos/,
  'preparação não pode fabricar consentimento nem foto');
assert.doesNotMatch(prepareRpc, /set[\s\S]{0,100}\bstatus\s*=/i,
  'preparação não pode alterar status clínico ou assinar o protocolo');

let uuidCounter = 0;
const sandbox = {
  window: {
    __AMJ_TEST__: true,
    crypto: { randomUUID: () => `00000000-0000-4000-8000-${String(++uuidCounter).padStart(12, '0')}` }
  },
  document: { addEventListener() {}, getElementById() { return null; } },
  Intl, Date, Math, Number, String, Array, Object, Set, Map, WeakMap, JSON, console
};
vm.runInNewContext(ui, sandbox, { filename: 'operacao.js' });
const contract = sandbox.window.AMJOperacaoClinica.__test;
const first = contract.protocolPrepareKey('attendance-1');
assert.equal(contract.protocolPrepareKey('attendance-1'), first,
  'retry deve manter a chave de idempotência do preparo');
contract.confirmProtocolPrepare('attendance-1', first);
assert.notEqual(contract.protocolPrepareKey('attendance-1'), first,
  'sucesso confirmado deve liberar novo intento');
assert.equal(contract.clinicalPhotoPending({ active_clinical_count: 0, active_product_count: 4 }), true,
  'fotos de produtos não removem a pendência clínica');
assert.equal(contract.clinicalPhotoPending({ active_clinical_count: 1, active_product_count: 0 }), false);
assert.deepEqual(JSON.parse(JSON.stringify(contract.photoCategoryCounts([
  { category: 'antes', archived_at: null },
  { category: 'durante', archived_at: null },
  { category: 'durante_legado', archived_at: null },
  { category: 'depois', archived_at: null },
  { category: 'produtos_utilizados', archived_at: null },
  { category: 'antes', archived_at: '2026-08-24T12:00:00Z' }
]))), { antes: 1, durante: 2, depois: 1, produtos: 1, arquivadas: 1 },
  'contagens devem separar fases, produtos e arquivadas; Durante agrega apenas o legado compatível');

console.log('operacao-prontuario-integration.test.cjs: ok');

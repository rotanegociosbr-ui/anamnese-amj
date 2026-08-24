const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..', '..');
const edge = fs.readFileSync(
  path.join(root, 'supabase', 'functions', 'prontuario-fichas', 'index.ts'),
  'utf8',
);
const migration = fs.readFileSync(
  path.join(
    root,
    'supabase',
    'migrations',
    '20260824124550_fotos_produtos_vinculo_produto_lote.sql',
  ),
  'utf8',
);
const baseMigration = fs.readFileSync(
  path.join(
    root,
    'supabase',
    'migrations',
    '20260824010000_prontuario_fotos_produtos_seguros.sql',
  ),
  'utf8',
);
const concurrencyMigration = fs.readFileSync(
  path.join(
    root,
    'supabase',
    'migrations',
    '20260824131500_fotos_consulta_concorrencia.sql',
  ),
  'utf8',
);

test('foto de produto e geral ou possui produto e lote juntos', () => {
  assert.match(
    migration,
    /\(product_id is null and lot_snapshot is null\)[\s\S]*or \(product_id is not null and lot_snapshot is not null\)/,
  );
  assert.match(migration, /validate constraint protocol_photos_product_lot_pair_check/);
  assert.match(migration, /drop constraint protocol_photos_product_context_check/);
});

test('manutencao preserva o par de toda foto ativa no estado final', () => {
  assert.match(
    migration,
    /active_photo_product_context_preflight_failed[\s\S]*Arquive ou corrija as fotos de produto inconsistentes/,
  );
  assert.match(
    migration,
    /create constraint trigger protocol_products_preserve_active_photo_context[\s\S]*deferrable initially deferred/,
  );
  assert.match(
    migration,
    /photo\.archived_at is null[\s\S]*photo\.product_id = old\.product_id[\s\S]*photo\.lot_snapshot = old\.lot/,
  );
  assert.match(
    migration,
    /not exists \([\s\S]*from public\.protocol_products item[\s\S]*item\.protocol_id = old\.protocol_id[\s\S]*item\.product_id = old\.product_id[\s\S]*item\.lot = old\.lot/,
  );
  assert.match(migration, /protocol_product_referenced_by_active_photo/);
  assert.match(edge, /Arquive ou corrija a foto de produto antes de alterar o produto ou lote/);
});

test('insercao e restauracao nao reativam foto com contexto removido', () => {
  assert.match(
    migration,
    /create constraint trigger protocol_photos_require_active_product_context[\s\S]*after insert or update[\s\S]*deferrable initially deferred/,
  );
  assert.match(
    migration,
    /new\.phase = 'products_used'[\s\S]*new\.archived_at is null[\s\S]*item\.product_id = new\.product_id[\s\S]*item\.lot = new\.lot_snapshot/,
  );
});

test('RPC continua sendo a fonte canonica da correspondencia produto-lote', () => {
  assert.match(
    baseMigration,
    /from public\.protocol_products item[\s\S]*item\.protocol_id = p_protocol_id[\s\S]*item\.product_id = p_product_id[\s\S]*item\.lot = v_lot_snapshot/,
  );
  assert.match(baseMigration, /raise exception 'photo_product_context_invalid'/);
  assert.match(baseMigration, /grant execute on function public\.prontuario_registrar_foto/);
});

test('Edge rejeita par parcial e par inexistente antes de enviar ao Storage', () => {
  const preflightStart = edge.indexOf('async function assertPhotoUploadPreflight');
  const preflightCall = edge.indexOf('await assertPhotoUploadPreflight(', preflightStart);
  const productPreflight = edge.indexOf(
    'await assertPhotoProductContextPreflight(',
    preflightCall,
  );
  const uploadCall = edge.indexOf('await uploadPrivateImage(storagePath, file)', preflightCall);

  assert.ok(preflightStart >= 0);
  assert.match(
    edge.slice(preflightStart, preflightCall),
    /\(productId === null\) !== \(lotSnapshot === null\)/,
  );
  assert.match(edge, /protocol_products\?select=lot[\s\S]*product_id=eq\.[\s\S]*linkedProductLot/);
  assert.ok(preflightCall >= 0 && productPreflight > preflightCall && uploadCall > productPreflight);
});

test('retry idempotente e resolvido antes de revalidar o catalogo mutavel', () => {
  const existingLookup = edge.indexOf('const existing = await findExistingPhoto');
  const existingReturn = edge.indexOf('idempotente: true', existingLookup);
  const productPreflight = edge.indexOf(
    'await assertPhotoProductContextPreflight(',
    existingReturn,
  );

  assert.ok(existingLookup >= 0 && existingReturn > existingLookup);
  assert.ok(productPreflight > existingReturn);
  assert.match(edge, /takenAt: string/);
  assert.match(edge, /existingTakenAt !== Date\.parse\(expected\.takenAt\)/,
    'a mesma chave não pode aceitar silenciosamente outra data de captura');
  assert.match(
    edge,
    /if \(result\.idempotent === true\)[\s\S]*findExistingPhoto[\s\S]*assertPhotoIdempotencyMatch/,
    'resultado idempotente do RPC deve ser relido e comparado após uma corrida de registro',
  );
});

test('foto ativa e manutencao de produto usam o mesmo lock por prontuario', () => {
  assert.match(
    concurrencyMigration,
    /pg_advisory_xact_lock[\s\S]*amj-prontuario-product-photo:[\s\S]*v_protocol_id/,
  );
  assert.match(
    concurrencyMigration,
    /tg_table_name = 'protocol_products'[\s\S]*v_protocol_id := old\.protocol_id/,
  );
  assert.match(
    concurrencyMigration,
    /tg_table_name = 'protocol_photos'[\s\S]*v_protocol_id := new\.protocol_id/,
  );
});

test('lote acima do limite e rejeitado sem truncamento silencioso', () => {
  assert.match(edge, /const lotValue = form\.get\("lote"\)/);
  assert.match(edge, /lotSnapshot\.length > 100/);
  assert.doesNotMatch(edge, /safeText\(form\.get\("lote"\), 100\)/);
});

test('contrato preserva multiplas fotos e foto geral sem segunda fonte', () => {
  assert.match(baseMigration, /Nao existe unicidade por[\s\S]*categoria:[\s\S]*quantas fotos/);
  assert.doesNotMatch(migration, /create table/i);
  assert.match(edge, /productId: string \| null/);
  assert.match(edge, /lotSnapshot: string \| null/);
});

test('prontuario assinado continua bloqueando manutencao comum de produtos', () => {
  assert.match(
    baseMigration,
    /create or replace function public\.prontuario_substituir_produtos[\s\S]*status = 'draft'[\s\S]*protocol_not_found_or_locked/,
  );
  assert.match(baseMigration, /signed_protocol_is_immutable/);
});

const test=require('node:test'), assert=require('node:assert/strict'), fs=require('node:fs'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../financeiro.js'),'utf8');
test('zero-balance stock offers an optional existing protected archive, never automatic deletion',()=>{
 const section=source.slice(source.indexOf('function renderInventory()'),source.indexOf('function renderPendingStock()'));
 assert.match(section,/balance === 0/);
 assert.match(section,/data-financeiro-registro-acao="arquivar"/);
 assert.match(section,/data-financeiro-entidade="produto"/);
 assert.match(section,/Arquivar produto sem saldo/);
 assert.match(section,/confirmar ou cancelar/);
 assert.doesNotMatch(section,/protectedCall\(|fetch\(|\.remove\(/);
});

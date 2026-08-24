const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const panelDir = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(panelDir, 'prontuario.js'), 'utf8');
const sandbox = {
  window: { __AMJ_TEST__: true, crypto: { randomUUID: () => '00000000-0000-4000-8000-000000000001' } },
  document: { readyState: 'loading', addEventListener() {}, getElementById() { return null; } },
  Intl, Date, Math, Number, String, Array, Object, Set, Map, WeakMap, JSON, URL,
  AbortController, FormData, console
};
vm.runInNewContext(source, sandbox, { filename: 'prontuario.js' });
const collect = sandbox.window.AMJProntuario.__test.collectProtocolPages;

async function main() {
  const requestedPages = [];
  const rows = await collect(async function (page) {
    requestedPages.push(page);
    if (page === 1) {
      return {
        protocolos: Array.from({ length: 100 }, (_, index) => ({ id: `p-${index + 1}` })),
        paginacao: { pagina: 1, por_pagina: 100, tem_mais: true }
      };
    }
    return {
      protocolos: [{ id: 'p-101' }],
      paginacao: { pagina: 2, por_pagina: 100, tem_mais: false }
    };
  }, 10);
  assert.equal(rows.length, 101, '101º prontuário não pode ser truncado');
  assert.deepEqual(requestedPages, [1, 2], 'frontend deve avançar sequencialmente até tem_mais=false');

  await assert.rejects(
    () => collect(async function (page) {
      return { protocolos: [{ id: `x-${page}` }], paginacao: { pagina: page, por_pagina: 100, tem_mais: true } };
    }, 2),
    /limite defensivo/,
    'teto defensivo deve falhar de modo explícito, nunca truncar silenciosamente'
  );
  console.log('prontuario-pagination.test.cjs: ok');
}

main().catch(function (error) {
  console.error(error);
  process.exitCode = 1;
});

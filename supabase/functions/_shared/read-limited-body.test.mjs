import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
import { readLimitedBody, RequestBodyTooLargeError } from './read-limited-body.ts';

const encoder = new TextEncoder();
function streamed(parts, headers = {}) {
  let read = 0;
  let cancelled = false;
  const body = new ReadableStream({
    pull(controller) {
      if (read < parts.length) controller.enqueue(parts[read++]);
      else controller.close();
    },
    cancel() { cancelled = true; }
  }, { highWaterMark: 0 });
  return {
    req: new Request('http://unit.invalid/', { method: 'POST', body, duplex: 'half', headers }),
    read: () => read, cancelled: () => cancelled
  };
}

test('reader accepts exact byte limit and split Unicode without corruption', async () => {
  const bytes = encoder.encode('ação 🧪');
  const sample = streamed([bytes.slice(0, 2), bytes.slice(2)]);
  assert.deepEqual(await readLimitedBody(sample.req, bytes.length), bytes);
});

for (const headers of [{}, { 'content-length': '1' }]) {
  test('overflow cancels without reading remaining chunks: ' + JSON.stringify(headers), async () => {
    const sample = streamed([new Uint8Array(8), new Uint8Array(3), new Uint8Array(20)], headers);
    await assert.rejects(readLimitedBody(sample.req, 10), RequestBodyTooLargeError);
    assert.equal(sample.read(), 2);
    assert.equal(sample.cancelled(), true);
    assert.equal(sample.req.body.locked, false);
  });
}

test('declared excess rejects before reading and empty body remains empty', async () => {
  const sample = streamed([new Uint8Array(4)], { 'content-length': '999' });
  await assert.rejects(readLimitedBody(sample.req, 10), RequestBodyTooLargeError);
  assert.equal(sample.read(), 0);
  assert.equal((await readLimitedBody(new Request('http://unit.invalid/'), 10)).length, 0);
});

test('failed or stalled producer cancellation cannot mask or delay size rejection', async () => {
  for (const cancel of [() => Promise.reject(new Error('cancel failed')), () => new Promise(() => {})]) {
    const body = new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array(11)); }, cancel
    }, { highWaterMark: 0 });
    const req = new Request('http://unit.invalid/', { method: 'POST', body, duplex: 'half' });
    let timer;
    try {
      await assert.rejects(Promise.race([
        readLimitedBody(req, 10),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('rejection delayed')), 1000); })
      ]), RequestBodyTooLargeError);
      assert.equal(body.locked, false);
    } finally { clearTimeout(timer); }
  }
});

// Actual handler source runs in an isolated VM. Only imports/runtime services are
// mocked; no Supabase, provider, network, PDF generation or patient data is used.
function handler(name, options = {}) {
  let handle;
  let authCalls = 0;
  let rateCalls = 0;
  class DualAuthError extends Error {
    status = 401; code = 'individual_auth_required'; publicMessage = 'Entre com sua conta.';
  }
  const sandbox = {
    Request, Response, Headers, TextEncoder, TextDecoder, Uint8Array, crypto,
    console: { error() {}, log() {} }, readLimitedBody, RequestBodyTooLargeError, DualAuthError,
    authenticateDual: async () => { authCalls++; if (!options.authenticated) throw new DualAuthError(); return { role: 'owner', aal: 'aal2' }; },
    consumePublicFormRateLimit: async () => { rateCalls++; return { allowed: true }; },
    Deno: { env: { get() { return ''; } }, serve(callback) { handle = callback; } },
    fetch: async () => { throw new Error('Network forbidden in unit test'); }
  };
  let source = fs.readFileSync(new URL('../' + name + '/index.ts', import.meta.url), 'utf8');
  source = stripTypeScriptTypes(source, { mode: 'transform' })
    .replace(/^import[\s\S]*?;\s*$/gm, '')
    .replace(/\bexport (?=(?:async )?function|class|const)/g, '')
    .replaceAll('import.meta.main', 'false');
  if (name === 'marketing-fichas') {
    source += '\nroute = async (req, context, payload) => new Response(JSON.stringify(payload));\nDeno.serve(handleRequest);';
  }
  vm.runInNewContext(source, sandbox, { filename: name + '/index.ts' });
  assert.equal(typeof handle, 'function');
  return { handle, authCalls: () => authCalls, rateCalls: () => rateCalls };
}

test('anonymous marketing request is rejected without consuming its body', async () => {
  const h = handler('marketing-fichas');
  const sample = streamed([encoder.encode('{}')]);
  const response = await h.handle(sample.req);
  assert.equal(response.status, 401);
  assert.equal(sample.read(), 0);
  assert.equal(h.authCalls(), 1);
});

test('authenticated marketing preserves valid Unicode JSON and rejects oversized stream', async () => {
  const h = handler('marketing-fichas', { authenticated: true });
  // The established 65,536 UTF-16-unit policy accepts this valid payload.
  const payload = { text: '漢'.repeat(50000) };
  const valid = new Request('http://unit.invalid/', { method: 'POST', body: JSON.stringify(payload) });
  assert.deepEqual(await (await h.handle(valid)).json(), payload);
  const sample = streamed([new Uint8Array(196611), new Uint8Array(1), new Uint8Array(1024)]);
  assert.equal((await h.handle(sample.req)).status, 413);
  assert.equal(sample.cancelled(), true);
  assert.equal(sample.read(), 2);
});

const tcles = ['tcle-submit', 'tcle-preenchimento-submit', 'tcle-intradermoterapia-submit',
  'tcle-bioestimulador-submit', 'tcle-peeling-quimico-submit', 'tcle-fios-pdo-submit'];
for (const name of tcles) {
  test(name + ': cancel excessive body and preserve invalid-JSON/domain validation', async () => {
    const h = handler(name);
    const headers = { origin: 'https://anamariajacob.com.br', 'content-type': 'application/json' };
    const sample = streamed([new Uint8Array(1500000), new Uint8Array(1), new Uint8Array(1024)], headers);
    const response = await h.handle(sample.req);
    assert.equal(response.status, 413);
    assert.equal(sample.read(), 2);
    assert.equal(sample.cancelled(), true);
    assert.equal(h.rateCalls(), 1);
    const invalid = await h.handle(new Request('http://unit.invalid/', { method: 'POST', headers, body: '{' }));
    assert.equal((await invalid.json()).codigo_erro, 'invalid_json');
    const parsed = await h.handle(new Request('http://unit.invalid/', { method: 'POST', headers, body: '{"website":"synthetic"}' }));
    assert.equal((await parsed.json()).codigo_erro, 'invalid_submission');
  });
}

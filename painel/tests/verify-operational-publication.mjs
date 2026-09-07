import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const files = ['index.html', 'app-shell.js', 'app-shell.css', 'financeiro.js',
  'prontuario.js', 'prontuario.css', 'operacao.js', 'crm.js'];
const sha256 = text => createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex');
const results = await Promise.all(files.map(async name => {
  const response = await fetch('https://anamariajacob.com.br/painel/' + name + '?verify=' + revision,
    { cache: 'no-store', signal: AbortSignal.timeout(30000) });
  const localHash = sha256(readFileSync(new URL('../' + name, import.meta.url), 'utf8'));
  const remoteHash = sha256(await response.text());
  return { file: 'painel/' + name, status: response.status, localHash, remoteHash,
    matches: response.ok && localHash === remoteHash };
}));
const report = { revision, checkedAt: new Date().toISOString(), results,
  passed: results.every(result => result.matches) };
console.log(JSON.stringify(report, null, 2));
if (!report.passed) process.exitCode = 1;

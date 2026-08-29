'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const panel = path.resolve(__dirname, '..');
const js = fs.readFileSync(path.join(panel, 'marketing.js'), 'utf8');
const css = fs.readFileSync(path.join(panel, 'marketing.css'), 'utf8');
const shell = fs.readFileSync(path.join(panel, 'app-shell.js'), 'utf8');
const html = fs.readFileSync(path.join(panel, 'index.html'), 'utf8');

assert.match(js, /functions\/v1\/marketing-fichas/);
for (const action of ['painel', 'listar_campanhas', 'listar_lancamentos_disponiveis', 'listar_vinculos',
  'listar_indicacoes', 'listar_conteudos', 'salvar_campanha', 'vincular_lancamento', 'cancelar_vinculo',
  'salvar_indicacao', 'cancelar_indicacao', 'salvar_conteudo', 'arquivar_conteudo']) {
  assert.ok(js.includes("'" + action + "'"), 'ação ausente: ' + action);
}
assert.match(js, /const totals = dashboard\.totais \|\| \{\}/,
  'totais devem vir do backend para não duplicar pacientes entre campanhas');
assert.doesNotMatch(js, /campaigns\.reduce/,
  'frontend não pode recomputar CAC/ROI global somando campanhas');
assert.match(js, /Receita recebida líquida/);
assert.match(js, /name="orcamento_planejado" type="number" min="0" step="0\.01"/,
  'campanha deve aceitar orçamento planejado opcional e não negativo');
assert.match(js, /Orçamento planejado[\s\S]*?money\(item\.orcamento_planejado\)/,
  'orçamento planejado deve aparecer separado do investimento pago');
assert.match(js, /orcamento_planejado: raw\.orcamento_planejado == null \? null : Number\(raw\.orcamento_planejado\)/,
  'payload deve enviar número ou nulo sem calcular investimento no cliente');
assert.match(js, /Valores não atribuídos/);
assert.match(js, /Não calculável/);
assert.match(js, /cancelar_vinculo[\s\S]*row\.version/,
  'cancelamento deve enviar versão do vínculo');
assert.match(js, /limit: 50, offset: 0, query: ''/,
  'lançamentos devem usar paginação do servidor');
assert.match(js, /!activeOnly \|\| text\(campaign\.status\) === 'ativa'/,
  'novo vínculo financeiro deve aceitar somente campanha ativa');
assert.match(js, /data-marketing-more-launches[\s\S]*loadMoreLaunches/,
  'itens antigos devem ser carregáveis progressivamente');
assert.match(js, /data-marketing-more-area[\s\S]*loadMoreArea/,
  'todos os cadastros devem ter paginação progressiva');
const loadMoreLaunchesSource = js.slice(js.indexOf('async function loadMoreLaunches'), js.indexOf('async function loadMoreArea'));
assert.doesNotMatch(loadMoreLaunchesSource, /render\(\)/,
  'carregar lançamentos não pode reconstruir e zerar o formulário em andamento');
assert.match(loadMoreLaunchesSource, /syncLinkFields\(form\)/,
  'seleções do vínculo devem ser preservadas ao carregar mais lançamentos');
assert.match(loadMoreLaunchesSource, /knownLeads[\s\S]*?state\.revenueLeads\.push/,
  'novas páginas de receita devem acumular os leads elegíveis sem apagar os anteriores');
assert.match(js, /const selectedLead = form\.elements\.lead_id\.value[\s\S]*?safeEntityOptions\(eligible, selectedLead/,
  'lead já escolhido deve permanecer selecionado após atualizar opções');
const loadMoreAreaSource = js.slice(js.indexOf('async function loadMoreArea'), js.indexOf('function formObject'));
assert.match(loadMoreAreaSource, /catch \(error\)[\s\S]*?status\(error\.message/,
  'erro de paginação deve ser informado na própria tela');
assert.ok(js.includes('valor_comprometido') && js.includes('liquido_pago'),
  'valor comprometido e caixa pago devem aparecer separadamente');
assert.match(js, /Lançamento:<\/strong>[^\n]*item\.descricao[\s\S]*Motivo do cancelamento:<\/strong>[^\n]*item\.motivo_cancelamento/,
  'vínculo financeiro precisa ser identificável e explicar o cancelamento');
assert.match(js, /lead\.campaign_id[\s\S]*lead\.patient_id[\s\S]*launch\.patient_id/,
  'receita deve oferecer apenas lead da mesma campanha e paciente');
assert.doesNotMatch(js, /\['arquivada', 'Arquivada'\]|\['arquivado', 'Arquivado'\]/,
  'arquivamento não pode contornar a confirmação protegida');
assert.match(js, /solicitarSenhaRecente/,
  'cancelamentos e arquivamentos devem exigir proteção por senha');
assert.doesNotMatch(js, /wa\.me|window\.open\(|publish|autodisparo/i,
  'Marketing não pode enviar mensagens ou publicar externamente');
assert.match(js, /A indicação não autoriza marketing, não envia mensagem/);
assert.match(js, /Nada é publicado nem enviado pelo sistema/);
assert.match(shell, /marketing: Object\.freeze\(\{ title: 'Marketing', legacy: 'marketing', owner: true/);
assert.match(shell, /global: 'AMJMarketing'[\s\S]*?src: '\.\/marketing\.js\?v=/);
assert.doesNotMatch(html, /<script[^>]+marketing\.js|<link[^>]+marketing\.css/i);
assert.match(css, /@media\(max-width:840px\)/);
assert.match(css, /@media\(max-width:430\.98px\)/);
assert.match(css, /min-height:44px/);
assert.match(css, /marketing-content-card>\.marketing-muted\{grid-column:2\/-1\}/,
  'motivo de arquivamento não pode ficar espremido na coluna de ações');
assert.doesNotMatch(css, /min-width:820px|outline:none/,
  'mobile não pode depender de tabela larga nem remover foco');

const sandbox = { window: { crypto: require('node:crypto').webcrypto }, document: {}, Intl, Date,
  Set, AbortController, console };
vm.runInNewContext(js, sandbox, { filename: 'marketing.js' });
const runtime = sandbox.window.AMJMarketing.__test;
assert.equal(runtime.money(0), 'R$ 0,00');
assert.equal(runtime.money(null), 'Não calculável');
assert.equal(runtime.ratio(null), 'Não calculável');
assert.equal(runtime.dateTimeLocal('2026-08-29T12:00:00.000Z'), '2026-08-29T09:00');
assert.equal(runtime.saoPauloInputToIso('2026-08-29T09:00'), '2026-08-29T12:00:00.000Z');
assert.ok(runtime.monthWindow().fim <= new Date().toISOString().slice(0, 10),
  'painel nunca deve pedir o fim futuro do mês');

console.log('marketing-ui.test.cjs: contrato, métricas, segurança e mobile OK');

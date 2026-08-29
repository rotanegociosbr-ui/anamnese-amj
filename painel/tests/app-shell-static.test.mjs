import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const panel = path.resolve(here, '..');
const html = fs.readFileSync(path.join(panel, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(panel, 'app-shell.css'), 'utf8');
const js = fs.readFileSync(path.join(panel, 'app-shell.js'), 'utf8');

const ids = Array.from(html.matchAll(/\sid=["']([^"']+)["']/g), match => match[1]);
const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
assert.deepEqual([...new Set(duplicates)], [], 'index.html não pode conter IDs duplicados');

assert.match(html, /app-shell\.css\?v=/, 'index.html deve carregar o CSS do shell');
assert.match(html, /app-shell\.js\?v=/, 'index.html deve carregar o JavaScript do shell');
assert.doesNotMatch(html, /<script[^>]+src=["']\.\/operacao\.js/i,
  'Operação deve ser carregada sob demanda pelo shell');
assert.doesNotMatch(html, /<script[^>]+src=["']\.\/gestao\.js/i,
  'Gestão deve ser carregada sob demanda pelo shell');
assert.doesNotMatch(html, /<script[^>]+src=["']\.\/crm\.js/i,
  'CRM deve ser carregado sob demanda pelo shell');
assert.doesNotMatch(html, /<link[^>]+href=["']\.\/crm\.css/i,
  'CSS do CRM deve ser carregado sob demanda pelo shell');
assert.doesNotMatch(html, /<script[^>]+src=["']\.\/marketing\.js/i,
  'Marketing deve ser carregado sob demanda pelo shell');

for (const route of ['inicio', 'crm', 'marketing', 'procedimentos', 'clientes', 'produtos', 'marcas', 'fornecedores', 'agenda',
  'receitas', 'despesas', 'estoque', 'fichas', 'gestao']) {
  assert.match(js, new RegExp('\\b' + route + ': Object\\.freeze'), 'rota principal ausente: ' + route);
}
for (const route of ['produtos', 'marcas', 'fornecedores']) {
  assert.match(js, new RegExp(route + ": Object\\.freeze\\(\\{[^}]*financeView: '" + route + "'"),
    'rota de catálogo deve reutilizar a visão financeira canônica: ' + route);
  assert.match(css, new RegExp('data-app-finance-view="' + route + '"'),
    'CSS deve isolar a área visível do catálogo: ' + route);
  assert.match(html, new RegExp('data-financeiro-cadastro-tipo="' + route + '"'),
    'lista própria deve existir sem duplicar a fonte: ' + route);
}
assert.match(js, /fornecedor: 'fornecedores', marca: 'marcas', produto: 'produtos'/,
  'Abrir existente deve levar cada catálogo à sua área própria');
assert.match(js, /navigateEvent:\s*'amj:navigate'/, 'contrato de navegação deve ser público');
assert.match(js, /routeEvent:\s*'amj:shell-route'/, 'evento de rota deve ser documentado');
assert.match(js, /openExistingEvent:\s*'amj:open-existing'/, 'contrato Abrir existente deve existir');
assert.match(js, /duplicateLevels:\s*Object\.freeze\(\['exact', 'possible'\]\)/,
  'alertas devem distinguir duplicata exata e possível');
assert.match(js, /level === 'exact'[\s\S]*?saveButton\.disabled = true/,
  'somente uma correspondência exata deve bloquear o botão de salvar na camada visual');
assert.match(js, /showDuplicateAlert:[\s\S]*?clearDuplicateAlert:/,
  'módulos devem poder exibir e limpar o estado compartilhado de duplicidade');
assert.match(js, /addEventListener\('amj:open-existing'[\s\S]*?openExisting\(event\.detail/,
  'Abrir existente precisa ter consumidor real no shell');
assert.match(js, /function setControlAccess\(button, allowed\)[\s\S]*?button\.hidden !== blocked[\s\S]*?button\.disabled !== blocked/,
  'controle observado deve alterar hidden/disabled apenas quando o valor realmente mudar');
assert.doesNotMatch(js, /button\.hidden = !allowed;\s*button\.disabled = !allowed;/,
  'syncAccess não pode realimentar o próprio MutationObserver');
assert.match(js, /AMJFinanceiro\.abrirCadastro\(type, id\)/,
  'cadastros existentes devem abrir pela fonte financeira canônica');
assert.match(js, /AMJOperacaoClinica\.abrirAtendimento\(id\)/,
  'atendimentos existentes devem abrir pela fonte operacional canônica');
assert.match(js, /src: '\.\/crm\.js\?v=20260826-1'[\s\S]*?css: '\.\/crm\.css\?v=20260826-1'/,
  'CRM deve versionar e carregar JS/CSS sob demanda');
assert.match(js, /AMJCRMLeads\.abrirLead\(id\)/,
  'Abrir existente deve encaminhar lead à fonte canônica do CRM');
assert.match(js, /app-procedure-photo-shortcut[^>]*data-app-action="fotos-atendimento"[^>]*>Adicionar ou tirar fotos/,
  'Procedimentos deve destacar a ação direta de fotos');
assert.match(js, /AMJOperacaoClinica\.abrirAtalhoFotos\(\)/,
  'o shell deve levar o atalho à seleção canônica da consulta');
assert.match(js, /new-revenue[\s\S]*?financeiro-lancamento-tipo', 'receita'[\s\S]*?financeiro-lancamento-origem', 'operacional'/,
  'receita avulsa nunca pode nascer com origem atendimento');

assert.match(css, /grid-template-columns:\s*var\(--app-sidebar-width\)\s+minmax\(0,\s*1fr\)/,
  'desktop deve usar sidebar e workspace fluido');
assert.match(css, /@media\s*\(max-width:\s*840px\)/,
  'deve existir composição específica para celular');
assert.match(css, /\.app-shell-mobile-bar\s*\{[\s\S]*?position:\s*fixed/,
  'celular deve ter navegação compacta fixa');
assert.match(css, /\.app-shell-content\s*\{[\s\S]*?width:\s*min\(100%,\s*1580px\)/,
  'workspace não pode continuar preso ao limite legado de 760px');

assert.match(html, /const abas = \['inicio', 'crm', 'marketing', 'fichas', 'agenda'/,
  'ativador legado deve reconhecer Início');
assert.match(html, /id="aba-inicio"/, 'painel Início deve existir no HTML');
assert.match(html, /id="aba-crm"[\s\S]*?id="crm-root"/,
  'painel CRM deve fornecer somente a raiz do módulo lazy');
assert.match(html, /id="aba-marketing"[\s\S]*?id="marketing-root"/,
  'painel Marketing deve fornecer somente a raiz do módulo lazy');
assert.match(html, /data-shell-metric="crm-abertos"[\s\S]*?data-shell-metric="crm-vencidos"/,
  'Início deve mostrar contadores reais do CRM após o módulo carregar');
assert.match(html, /data-shell-route="crm" data-shell-action="novo-lead"/,
  'Início deve oferecer cadastro rápido de lead');
assert.match(html, /data-shell-route="estoque" data-shell-action="nova-compra"/,
  'atalho de compra/frete deve abrir Estoque');
assert.match(html, /data-shell-route="procedimentos" data-shell-action="fotos-atendimento"[^>]*><strong>Adicionar ou tirar fotos<\/strong>/,
  'Início deve oferecer acesso direto às fotos do atendimento');
assert.match(html, /app-fluxo-etapas[\s\S]*?Paciente[\s\S]*?Procedimento[\s\S]*?Fotos[\s\S]*?Cobrança[\s\S]*?Retorno/,
  'Início deve conectar visualmente a jornada operacional completa');
assert.doesNotMatch(html, /app-fluxo-etapas[\s\S]*?data-shell-route="receitas"[\s\S]*?Recebimento/,
  'jornada da paciente não pode transformar pagamento de procedimento em receita avulsa');

console.log('app-shell static: OK');

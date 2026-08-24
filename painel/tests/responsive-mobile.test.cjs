'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const panel = path.resolve(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(panel, name), 'utf8');
const shellJs = read('app-shell.js');
const shellCss = read('app-shell.css');
const quotesCss = read('cotacoes.css');
const financeCss = read('financeiro.css');
const operationCss = read('operacao.css');
const recordCss = read('prontuario.css');
const managementCss = read('gestao.css');

assert.match(shellJs,
  /mobileMedia\.addEventListener\('change',[\s\S]*?if \(!state\.mobileMedia\.matches\) closeDrawer\(false\);[\s\S]*?else updateDrawerAccessibility\(\)/,
  'ao sair do layout móvel, o drawer deve fechar e sincronizar aria-expanded/inert');
assert.doesNotMatch(shellJs,
  /if \(!state\.mobileMedia\.matches\) document\.body\.classList\.remove\('app-shell-drawer-open'\)/,
  'trocar de breakpoint não pode deixar aria-expanded preso em true');
assert.match(shellJs,
  /data-shell-open-menu aria-expanded="false" aria-controls="app-shell-sidebar"/,
  'o atalho Mais deve declarar relação e estado do drawer móvel');
assert.match(shellJs,
  /function setDrawerTriggersExpanded\(expanded\)[\s\S]*?querySelectorAll\('\.app-shell-menu-button,\[data-shell-open-menu\]'\)[\s\S]*?setAttribute\('aria-expanded'/,
  'todos os gatilhos do drawer devem compartilhar o mesmo estado ARIA');
assert.match(shellJs, /function openDrawer\(\)[\s\S]*?setDrawerTriggersExpanded\(true\)/,
  'abrir o drawer deve anunciar o estado nos dois gatilhos');
assert.match(shellJs, /function closeDrawer\(restoreFocus\)[\s\S]*?setDrawerTriggersExpanded\(false\)/,
  'fechar o drawer deve anunciar o estado nos dois gatilhos');

assert.match(shellCss, /@media \(max-width: 840px\)[\s\S]*?\.app-shell-mobile-bar[\s\S]*?min-height: 54px/,
  'shell deve manter navegação móvel tocável até o breakpoint do tablet');
assert.match(shellCss, /\.financeiro-tabela-wrap,[\s\S]*?\.gestao-tabela-wrap[\s\S]*?overflow-x: auto/,
  'tabelas largas devem permanecer contidas em rolagem horizontal');
assert.match(shellCss, /\.app-shell-content table\s*\{[^}]*min-width:\s*720px/,
  'o teste deve cobrir a largura mínima global aplicada pelo shell autenticado');
assert.match(quotesCss,
  /@media \(max-width: 900px\)[\s\S]*?\.app-shell-content \.cotacoes-shell table[^}]*min-width: 0/,
  'cards de cotações devem vencer a largura mínima global do shell no celular');
assert.match(quotesCss,
  /@container cotacoes \(max-width: 900px\)[\s\S]*?\.app-shell-content \.cotacoes-shell table[^}]*min-width: 0/,
  'cards de cotações também devem vencer o shell quando o módulo, e não a tela, estiver estreito');
assert.match(quotesCss,
  /@container cotacoes \(max-width: 1180px\)[\s\S]*?\.cotacoes-filtros\s*\{\s*grid-template-columns:\s*repeat\(3, minmax\(0, 1fr\)\)/,
  'filtros de cotações devem responder à área útil reduzida pela barra lateral em notebooks');
assert.match(quotesCss,
  /@container cotacoes \(max-width: 900px\)[\s\S]*?\.cotacoes-filtros, \.cotacoes-resumo, \.cotacoes-estatisticas\s*\{\s*grid-template-columns:\s*1fr 1fr/,
  'resumos e filtros de cotações devem responder à largura real do módulo estreito');

assert.match(financeCss,
  /@media\(max-width:840px\)\{[\s\S]*?\.financeiro-cadastro-item button,[\s\S]*?\.financeiro-duplicidade-acoes button\{min-height:44px\}/,
  'ações financeiras secundárias devem ter alvo de toque de 44 px no celular e tablet');
assert.match(financeCss,
  /@media\(max-width:840px\)\{[\s\S]*?\.financeiro-busca input,[\s\S]*?\.financeiro-filtros select\{font-size:16px;min-height:44px\}/,
  'busca e filtros financeiros devem evitar zoom automático no celular');
assert.match(financeCss,
  /@media\(max-width:840px\)\{[\s\S]*?\.financeiro-item,[\s\S]*?\.financeiro-pendencia-estoque\{grid-template-columns:1fr 1fr\}/,
  'itens de compra e pendências de estoque devem caber na área útil de tablets de 768 px');
assert.match(financeCss,
  /@media\(max-width:840px\)\{[\s\S]*?\.financeiro-item-estoque,[\s\S]*?\.financeiro-pendencia-descricao,[\s\S]*?grid-column:1\/-1/,
  'descrições financeiras largas devem ocupar a linha inteira no tablet');
assert.match(financeCss,
  /@media\(max-width:430\.98px\)\{[\s\S]*?\.financeiro-cadastro-item,[\s\S]*?flex-direction:column[\s\S]*?\.financeiro-cadastro-acoes,[\s\S]*?grid-template-columns:1fr/,
  'cadastros e ações financeiras devem empilhar sem comprimir o texto em 430 px');
assert.match(financeCss, /@media\(max-width:390\.98px\)[\s\S]*?\.financeiro-kpis\{grid-template-columns:1fr\}/,
  'o breakpoint de 390 px deve aceitar larguras fracionárias do navegador');

assert.match(operationCss,
  /@media \(max-width: 840px\)[\s\S]*?\.operacao-card select,[\s\S]*?font-size: 16px; min-height: 44px[\s\S]*?\.operacao-botao\.pequeno,[\s\S]*?min-height: 44px/,
  'formulários e ações operacionais devem evitar zoom e manter alvo tocável');
assert.match(operationCss,
  /@media \(max-width: 560px\)[\s\S]*?\.operacao-acoes \{[\s\S]*?display: grid; grid-template-columns: 1fr[\s\S]*?max-width: none; width: 100%/,
  'ações operacionais devem ocupar a largura disponível no celular');
assert.match(operationCss, /@media \(max-width: 430\.98px\)[\s\S]*?\.operacao-foto-contagens \{ grid-template-columns: 1fr; \}/,
  'contadores da galeria devem respeitar 430 px exatos');

assert.match(recordCss,
  /@media\(max-width:840px\)\{[\s\S]*?\.prontuario-form select,[\s\S]*?min-height:44px;font-size:16px[\s\S]*?\.prontuario-foto-original,[\s\S]*?min-height:44px/,
  'campos e ações do prontuário devem ser tocáveis e não provocar zoom no celular');
assert.match(recordCss,
  /@media\(max-width:430\.98px\)\{[\s\S]*?\.prontuario-fotos-grade\{grid-template-columns:1fr\}[\s\S]*?\.prontuario-foto-acoes\{display:grid;grid-template-columns:1fr\}/,
  'fotos clínicas e suas ações não devem ficar espremidas em duas colunas no celular');

assert.match(managementCss,
  /@media \(max-width: 840px\)[\s\S]*?\.gestao-shell textarea \{ font-size: 16px; min-height: 44px; \}[\s\S]*?\.gestao-shell button \{ min-height: 44px; \}/,
  'gestão deve usar campos sem zoom e botões tocáveis até 840 px');
assert.match(managementCss,
  /@media \(max-width: 640px\)[\s\S]*?\.gestao-form-inline \{ align-items: stretch; display: grid; grid-template-columns: 1fr; \}/,
  'fechamento mensal deve empilhar em uma coluna no celular');

console.log('responsive-mobile.test.cjs: breakpoints, toque, galerias, tabelas e drawer OK');

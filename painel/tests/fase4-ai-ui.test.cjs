'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const panel = path.resolve(__dirname, '..');
const js = fs.readFileSync(path.join(panel, 'copiloto.js'), 'utf8');
const css = fs.readFileSync(path.join(panel, 'copiloto.css'), 'utf8');
const shell = fs.readFileSync(path.join(panel, 'app-shell.js'), 'utf8');
const html = fs.readFileSync(path.join(panel, 'index.html'), 'utf8');

assert.match(js, /functions\/v1\/ia-copiloto-fichas/,
  'Copiloto deve usar somente a Edge Function privada da Fase 4');
assert.match(js, /cabecalhosAcesso\(true\)/,
  'Copiloto exige autenticação individual com MFA');
assert.match(js, /cache: 'no-store', referrerPolicy: 'no-referrer'/,
  'requisições de IA não podem usar cache nem enviar referrer');
assert.match(js, /new AbortController\(\)[\s\S]*?state\.generation/,
  'logout deve invalidar e cancelar requisições em andamento');
assert.match(js, /state\.controllers\.forEach[\s\S]*?controller\.abort\(\)/,
  'reset deve abortar todas as cargas e análises');

for (const action of ['painel', 'analisar', 'feedback']) {
  assert.match(js, new RegExp("acao: '" + action + "'"), 'ação ausente: ' + action);
}
for (const key of ['atencao_hoje', 'leads_prioritarios', 'mudancas_marketing', 'previsao_caixa']) {
  assert.ok(js.includes(key), 'pergunta allowlisted ausente: ' + key);
}
assert.match(js, /pergunta_chave: key, idempotency_key: intent\.idempotencyKey/,
  'análise deve enviar pergunta allowlisted e idempotência da intenção');
assert.match(js, /retry && state\.analysisIntent && state\.analysisIntent\.signature === signature/,
  'retry deve reutilizar a mesma chave estável');
assert.match(js, /retry && error\.code === 'ai_previous_attempt_failed'\) return analyze\(key, false\)/,
  'falha terminal confirmada deve abrir uma única operação nova após o replay seguro');
assert.match(js, /signature: signature,[\s\S]*?idempotencyKey: uuid\(\)/,
  'nova pergunta, período ou foco deve criar nova intenção');
assert.match(js, /acao: 'feedback', operation_id: state\.analysis\.operationId,[\s\S]*?idempotency_key: uuid\(\), avaliacao: value/,
  'feedback deve enviar operation_id e uma nova idempotency_key');
assert.match(js, /\['util', 'nao_util'\]\.includes\(value\)/,
  'avaliação deve aceitar somente os dois valores do contrato');

assert.match(js, /envelope\.snapshot[\s\S]*?snapshot\.painel_privado/,
  'parser deve ler snapshot.painel_privado e ignorar dados agregados não destinados à UI');
for (const field of ['codigo_acao', 'tipo_alvo', 'alvo_id', 'nome_seguro', 'vencido_em', 'metrica', 'codigo_motivo']) {
  assert.ok(js.includes('raw.' + field), 'parser do painel não mapeia o campo SQL: ' + field);
}
assert.match(js, /acao: 'painel',[\s\S]*?foco: 'geral'/,
  'painel deve usar um foco aceito pelo contrato Edge');
assert.match(js, /FOCUS_BY_QUESTION\[key\] \|\| 'geral'[\s\S]*?foco: focus/,
  'a pergunta deve selecionar o menor contexto agregado necessário para a Edge');
for (const pair of ["atencao_hoje: 'geral'", "leads_prioritarios: 'crm'",
  "mudancas_marketing: 'marketing'", "previsao_caixa: 'financeiro'"]) {
  assert.ok(js.includes(pair), 'foco mínimo por pergunta ausente: ' + pair);
}
assert.match(js, /questionKey === 'previsao_caixa'[\s\S]*?monthIndex[\s\S]*?- 5/,
  'previsão de caixa deve consultar seis meses inclusivos, não somente o mês atual');
assert.doesNotMatch(js, /updatedAt: firstText\([^)]*proxima_verificacao/,
  'instrução textual de próxima verificação não pode fingir ser timestamp de atualização');
assert.match(js, /envelope\.analise[\s\S]*?analysis\.prioridades/,
  'parser deve aceitar o schema estrito de análise');
assert.match(js, /forecastRaw\.leitura[\s\S]*?forecastRaw\.horizonte[\s\S]*?forecastRaw\.confiabilidade/,
  'previsão deve expor leitura, horizonte e confiabilidade');
assert.match(js, /Estimativa gerencial[\s\S]*?Horizonte[\s\S]*?Limitações da estimativa/,
  'qualquer previsão precisa estar rotulada e mostrar limitações');
assert.match(js, /Sugestão gerencial — confirme antes de agir/,
  'todas as respostas precisam lembrar que a decisão é humana');
assert.match(js, /\.slice\(0, 3\)/,
  'briefing deve limitar Next Best Actions a três');
assert.match(js, /PRIORITY_RANK[\s\S]*?return left\.index - right\.index/,
  'ordenação das ações deve ser determinística');
assert.match(js, /new CustomEvent\('amj:navigate'[\s\S]*?source: 'copiloto'/,
  'CTA do Copiloto deve somente navegar pelo contrato do shell');

for (const stateName of ['loading', 'sucesso', 'parcial', 'vazio', 'erro']) {
  assert.ok(js.includes(stateName), 'estado de UI ausente: ' + stateName);
}
assert.match(js, /data-copiloto-retry-panel/,
  'erro do painel deve permitir retry independente');
assert.match(js, /data-copiloto-retry-analysis/,
  'erro da análise deve permitir retry com a mesma intenção');
assert.match(js, /aria-busy="false"[\s\S]*?copiloto-analysis-status[\s\S]*?aria-live="polite"/,
  'análise deve usar busy e uma região pequena de anúncio');
assert.doesNotMatch(js, /id="copiloto-analysis"[^>]*aria-live/,
  'a resposta inteira não deve ser anunciada repetidamente');
assert.match(js, /role="dialog" aria-modal="true"[\s\S]*?aria-labelledby="copiloto-title"/,
  'drawer deve declarar semântica de diálogo');
assert.match(js, /\.app-shell-sidebar,\.app-shell-workspace,\.app-shell-mobile-bar[\s\S]*?node\.inert = true/,
  'fundo deve ficar inerte enquanto o Copiloto está aberto');
assert.match(js, /event\.key === 'Escape'[\s\S]*?close\(true\)/,
  'Escape deve fechar e devolver foco');

assert.doesNotMatch(js, /api\.openai\.com|OPENAI_API_KEY|\bsk-[A-Za-z0-9_-]+/i,
  'frontend nunca pode conter endpoint ou segredo do provedor');
assert.doesNotMatch(js, /wa\.me|window\.open\(|salvar_lead|converter_lead|publicar|autodisparo/i,
  'Copiloto não pode enviar, salvar, converter ou publicar');
assert.doesNotMatch(html, /<script[^>]+copiloto\.js/i,
  'JavaScript do Copiloto deve permanecer lazy');
assert.match(shell, /global: 'AMJCopiloto'[\s\S]*?src: '\.\/copiloto\.js\?v=/,
  'shell deve registrar o módulo lazy');
assert.doesNotMatch(shell, /navButton\('copiloto', true\)/,
  'barra inferior deve continuar com cinco ações');
assert.match(html, /id="ai-home-root"[^>]*hidden/,
  'briefing deve usar progressive enhancement no Início');

assert.match(css, /width: min\(420px, calc\(100vw - 28px\)\)/,
  'drawer desktop deve ter até 420 px');
assert.match(css, /@media \(max-width: 840px\)[\s\S]*?\.copiloto-drawer \{ inset: 0; width: 100vw/,
  'Copiloto deve virar folha de tela cheia no celular');
assert.match(css, /env\(safe-area-inset-bottom\)/,
  'folha móvel deve respeitar a área segura');
assert.match(css, /min-height: 44px/,
  'ações devem manter alvo de toque acessível');
assert.match(css, /@media \(prefers-reduced-motion: reduce\)/,
  'animações devem respeitar movimento reduzido');

const sandbox = {
  window: { crypto: crypto.webcrypto },
  document: {}, Intl, Date, Set, Map, AbortController, CustomEvent: function CustomEvent() {}, console
};
vm.runInNewContext(js, sandbox, { filename: 'copiloto.js' });
const runtime = sandbox.window.AMJCopiloto.__test;

const panelData = runtime.normalizePanel({ ok: true, snapshot: { painel_privado: {
  resumo: 'Três frentes pedem atenção.', atualizado_em: '2026-08-29T12:00:00.000Z',
  acoes: [
    { titulo: 'Baixa prioridade', prioridade: 'baixa', rota: 'agenda', evidencias: ['Agenda'] },
    { titulo: 'Alta prioridade', prioridade: 'alta', rota: 'crm', evidencias: ['CRM'] },
    { titulo: 'Média prioridade', prioridade: 'media', rota: 'marketing', evidencias: ['Marketing'] },
    { titulo: 'Quarta ação', prioridade: 'normal', rota: 'estoque', evidencias: ['Estoque'] }
  ]
} } });
assert.equal(panelData.actions.length, 3);
assert.equal(panelData.actions[0].title, 'Alta prioridade');
assert.equal(panelData.actions[0].route, 'crm');

const operationId = '123e4567-e89b-42d3-a456-426614174000';
const sqlPanel = runtime.normalizePanel({ ok: true, snapshot: { painel_privado: {
  acoes: [
    { prioridade: 40, codigo_acao: 'financeiro_parcela_revisar', tipo_alvo: 'parcela',
      alvo_id: operationId, vencido_em: '2026-08-28T12:00:00.000Z', metrica: 600,
      codigo_motivo: 'installment_overdue' },
    { prioridade: 5, codigo_acao: 'estoque_saldo_revisar', tipo_alvo: 'produto',
      alvo_id: '223e4567-e89b-42d3-a456-426614174000', nome_seguro: 'Produto teste', metrica: -2,
      codigo_motivo: 'stock_negative' },
    { prioridade: 30, codigo_acao: 'retorno_revisar', tipo_alvo: 'retorno',
      alvo_id: '323e4567-e89b-42d3-a456-426614174000', nome_seguro: 'Paciente teste',
      vencido_em: '2026-08-27T12:00:00.000Z', metrica: 2, codigo_motivo: 'return_overdue' }
  ]
} } });
assert.equal(sqlPanel.actions[0].actionCode, 'estoque_saldo_revisar');
assert.equal(sqlPanel.actions[0].title, 'Revisar saldo de estoque: Produto teste');
assert.equal(sqlPanel.actions[0].route, 'estoque');
assert.equal(sqlPanel.actions[0].reasonCode, 'stock_negative');
assert.equal(sqlPanel.actions[0].targetType, 'produto');
assert.equal(sqlPanel.actions[0].metric, -2);
assert.equal(sqlPanel.actions[1].route, 'acompanhamentos');
assert.equal(sqlPanel.actions[1].dueLabel, 'Vencido em');
assert.equal(sqlPanel.actions[2].route, 'receitas');
assert.match(sqlPanel.actions[2].detail, /R\$\s*600,00/);

const analysis = runtime.normalizeAnalysis({ ok: true, operation_id: operationId, analise: {
  titulo: 'Estimativa de caixa', resumo: 'Há variação esperada.',
  prioridades: [{ categoria: 'crm', titulo: 'Revisar contatos', justificativa: 'Ações vencidas',
    proxima_verificacao: '2026-08-30T12:00:00.000Z' }],
  previsao: { leitura: 'Tendência estável', horizonte: '30 dias', confiabilidade: 'média',
    limitacoes: ['Depende dos recebimentos registrados.'] },
  limitacoes: ['Base pequena.']
} }, 'previsao_caixa');
assert.equal(analysis.operationId, operationId);
assert.equal(analysis.actions[0].route, 'crm');
assert.equal(analysis.forecast.horizon, '30 dias');
assert.equal(runtime.normalizeRoute('estoque_baixo'), 'estoque');
assert.equal(runtime.normalizeFocus('inicio'), 'geral');
assert.equal(runtime.normalizeFocus('procedimentos'), 'geral');
assert.equal(runtime.normalizeFocus('estoque'), 'financeiro');
assert.equal(runtime.normalizeFocus('agenda'), 'agenda');
assert.equal(runtime.validUuid(operationId), true);
const forecastWindow = runtime.analysisWindow('previsao_caixa');
const forecastStart = forecastWindow.inicio.split('-').map(Number);
const forecastEnd = forecastWindow.fim.split('-').map(Number);
assert.equal((forecastEnd[0] * 12 + forecastEnd[1]) - (forecastStart[0] * 12 + forecastStart[1]), 5);
const currentWindow = runtime.analysisWindow('leads_prioritarios');
assert.equal(currentWindow.inicio.slice(0, 7), currentWindow.fim.slice(0, 7));

console.log('fase4-ai-ui.test.cjs: briefing, NBA, drawer, contrato e acessibilidade OK');

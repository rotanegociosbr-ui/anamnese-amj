const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');
const ui = fs.readFileSync(path.join(root, 'painel', 'cotacoes.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'painel', 'cotacoes.css'), 'utf8');
const html = fs.readFileSync(path.join(root, 'painel', 'index.html'), 'utf8');
const shell = fs.readFileSync(path.join(root, 'painel', 'app-shell.js'), 'utf8');
const edge = fs.readFileSync(path.join(root, 'supabase', 'functions', 'cotacoes-fichas', 'index.ts'), 'utf8');
const reviewMigration = fs.readFileSync(path.join(root, 'supabase', 'migrations',
  '20260824061000_cotacoes_revisao_sku_exato.sql'), 'utf8');
const adminMigration = fs.readFileSync(path.join(root, 'supabase', 'migrations',
  '20260906212911_cotacoes_admin_session_authorization.sql'), 'utf8');

assert.match(ui, /listar_cotacoes/, 'UI deve consultar as cotações');
assert.match(ui, /revisar_sku_exato/, 'UI deve oferecer a revisão administrativa explícita');
assert.match(ui, /Média indisponível até aprovar manualmente a identidade exata/,
  'SKU pendente deve explicar por que não entra na média');
assert.match(ui, /AMJProtecao\.solicitarSenhaRecente/, 'revisão deve confirmar a decisão pela API administrativa compatível');
assert.match(ui, /expected_version/, 'revisão deve usar concorrência otimista');
assert.match(ui, /Aprovar identidade exata/);
assert.match(ui, /Rejeitar identidade/);
assert.match(ui, /minimum_price/);
assert.match(ui, /maximum_price/);
assert.match(ui, /average_price/);
assert.match(ui, /median_price/);
assert.match(ui, /latest_price/);
assert.match(ui, /source_count/);
assert.match(ui, /reference_average_unit_price/, 'deve separar referência unitária do total da embalagem');
assert.match(ui, /authoritative_cost_package_unit/, 'custo real precisa informar a unidade cadastrada');
assert.match(ui, /comparison_status === 'comparavel'/, 'diferença só pode aparecer quando as unidades forem comparáveis');
assert.match(ui, /não é margem de venda/, 'diferença matemática não pode ser rotulada como margem');
assert.match(ui, /row\.page_number/);
assert.match(ui, /row\.source_code/);
assert.match(ui, /row\.presentation/);
assert.match(ui, /alteraCustoReal:\s*false/);
assert.match(ui, /alteraPrecoVenda:\s*false/);
assert.match(ui, /alteraEstoque:\s*false/);
assert.match(ui, /aceitaLegacy:\s*false/);
assert.match(ui, /const payload = filterPayload\(\);[\s\S]{0,120}setBusy\(true\)/,
  'filtros devem ser lidos antes de desabilitar os controles');
assert.match(css, /@media \(max-width: 900px\)/, 'layout deve se adaptar a celular e tablet estreito');
assert.match(css, /@media \(max-width: 520px\)[\s\S]*\.cotacoes-estatisticas\s*\{\s*grid-template-columns:\s*1fr/,
  'cards estatísticos devem usar uma coluna em telefones estreitos');
assert.match(css, /@media \(max-width: 520px\)[\s\S]*\.cotacoes-estatistica dl\s*\{\s*grid-template-columns:\s*1fr/,
  'métricas de cada cotação devem usar uma coluna em telefones estreitos');
assert.match(css, /\.cotacoes-shell input, \.cotacoes-shell select[^}]*font-size:\s*0\.875rem[^}]*min-height:\s*44px/,
  'campos devem ser legíveis e ter alvo de toque suficiente');
assert.match(css, /@media \(max-width: 520px\)[\s\S]*\.cotacoes-shell input, \.cotacoes-shell select\s*\{\s*font-size:\s*1rem/,
  'campos não devem provocar zoom automático em telefones');
assert.match(css, /button\.cotacoes-revisao[^}]*min-height:\s*44px/,
  'ações administrativas devem manter alvo de toque mínimo');
assert.match(css, /@container cotacoes \(max-width: 900px\)[\s\S]*\.cotacoes-shell table[^}]*display:\s*block/,
  'tabela deve virar cartões quando a área útil do módulo ficar estreita');
assert.match(css, /\.cotacoes-shell td\s*\{[^}]*overflow-wrap:\s*anywhere/,
  'códigos e descrições extensos não podem criar overflow horizontal');

assert.match(html, /id="aba-bt-cotacoes"/);
assert.match(html, /id="cotacoes-root"/);
assert.match(html, /cotacoes\.css\?v=\d{8}-\d+/);
assert.match(shell, /title: 'Cotações e preços'/);
assert.match(shell, /\.\/cotacoes\.js\?v=\d{8}-\d+/);

assert.match(edge, /cotacoes_painel_evidencias/, 'Edge deve listar a view de evidências');
assert.match(edge, /cotacoes_resumo_referencia/, 'estatística deve vir da RPC exata');
assert.match(edge, /cotacoes_revisar_sku_exato/, 'revisão deve usar a RPC transacional');
assert.match(edge, /await requireAdminSessionAction\(req, AUTH_CONFIG, context,/, 'revisão deve revalidar a sessão administrativa atual');
assert.doesNotMatch(edge, /requireRecentPasswordProof|requireRoutineEditAuthorization|clinic_consume_password_proof/,
  'revisão não pode exigir senha secundária nem janela de edição');
assert.match(edge, /rpc\/cotacoes_revisar_sku_exato_admin_session/, 'Edge deve usar a RPC atual de sessão administrativa');
assert.match(edge, /clinic_id.*eq\.\$\{clinicId\}/s, 'toda listagem deve filtrar o tenant autenticado');
assert.match(edge, /allowedRoles:\s*\["owner"\]/);
assert.match(edge, /requireAal2:\s*true/);
assert.match(edge, /authorization_required/, 'senha compartilhada não pode acessar cotações');
assert.doesNotMatch(edge, /x-senha/, 'CORS não deve aceitar autenticação legada');
assert.doesNotMatch(edge, /raw_evidence/, 'evidência bruta não pode sair pelo endpoint');
assert.doesNotMatch(edge, /console\.(log|error|warn)/, 'endpoint não deve registrar dados em log');

assert.match(reviewMigration, /item\.review_status\s*=\s*'aprovado_exato'/,
  'estatística deve exigir aprovação humana exata');
assert.match(reviewMigration, /item\.review_status\s*=\s*'aprovado_exato'[\s\S]*counts_in_statistics/,
  'flag de contagem deve exigir a mesma aprovação');
assert.match(adminMigration, /member\.clinic_id = p_clinic_id[\s\S]*member\.user_id = p_actor_id[\s\S]*member\.role = 'owner'[\s\S]*member\.status = 'active'/,
  'RPC atual deve exigir administradora ativa da clínica');
assert.match(adminMigration, /session\.id = p_main_session_id and session\.user_id = p_actor_id[\s\S]*session\.aal = 'aal2'[\s\S]*session\.not_after > clock_timestamp\(\)/,
  'RPC atual deve validar sessão exata, MFA e expiração');
assert.match(adminMigration, /authorization_mode='admin_session' and proof_id is null and octet_length\(main_session_hmac\)=32/,
  'auditoria administrativa deve preservar a origem real sem fabricar prova de senha');
assert.match(adminMigration, /revoke all on function public\.cotacoes_revisar_sku_exato_admin_session[^\n]+from public,anon,authenticated,service_role/,
  'RPC administrativa não pode ser chamada diretamente por clientes');
assert.match(adminMigration, /grant execute on function public\.cotacoes_revisar_sku_exato_admin_session[^\n]+to service_role/);
assert(adminMigration.indexOf('session.id = p_main_session_id') < adminMigration.indexOf('into v_existing'),
  'revalidação de sessão deve ocorrer antes da recuperação idempotente');
assert.match(adminMigration, /v_item\.review_version <> p_expected_version/, 'revisão atual deve manter concorrência otimista');
assert.match(adminMigration, /insert into public\.financeiro_auditoria/, 'revisão atual deve manter trilha de auditoria');
for (const flag of ['cost_changed', 'stock_changed', 'sale_price_changed', 'product_linked']) {
  assert.match(adminMigration, new RegExp("'" + flag + "', false"), 'revisão não deve alterar custo, estoque, venda ou vínculo');
}
assert.doesNotMatch(adminMigration, /update\s+public\.financeiro_(produto_custos|produtos|estoque_\w+)/i,
  'autorização nova não pode ampliar os efeitos da revisão');
assert.match(reviewMigration, /cotacao_item_identity_immutable/, 'fonte e identidade devem ser imutáveis');
assert.match(reviewMigration, /cotacao_source_identity_immutable/, 'metadados que identificam a fonte devem ser imutáveis');
assert.match(reviewMigration, /cotacao_evidence_identity_immutable/, 'preço e evidência originais devem ser imutáveis');
assert.match(reviewMigration, /financeiro_auditoria/, 'decisão deve ser auditada pela whitelist financeira');
assert.match(reviewMigration, /'product_linked', false/, 'revisão não pode vincular produto automaticamente');
assert.doesNotMatch(reviewMigration, /update\s+public\.financeiro_produto_custos/i,
  'revisão não pode alterar custo real');
assert.doesNotMatch(reviewMigration, /update\s+public\.financeiro_produtos/i,
  'revisão não pode alterar produto');

console.log('cotacoes-ui.test.cjs: ok');

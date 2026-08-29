const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');
const migration = fs.readFileSync(path.join(root, 'supabase', 'migrations',
  '20260826085707_fase2_acompanhamentos_operacionais.sql'), 'utf8');
const hardening = fs.readFileSync(path.join(root, 'supabase', 'migrations',
  '20260826085738_fase2_hardening_fotos_estoque.sql'), 'utf8');
const reporting = fs.readFileSync(path.join(root, 'supabase', 'migrations',
  '20260826085809_fase2_relatorio_agregado.sql'), 'utf8');
const edge = fs.readFileSync(path.join(root, 'supabase', 'functions',
  'operacao-clinica-fichas', 'index.ts'), 'utf8');
const ui = fs.readFileSync(path.join(root, 'painel', 'acompanhamentos.js'), 'utf8');
const record = fs.readFileSync(path.join(root, 'painel', 'prontuario.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'painel', 'prontuario.css'), 'utf8');
const recordEdge = fs.readFileSync(path.join(root, 'supabase', 'functions',
  'prontuario-fichas', 'index.ts'), 'utf8');
const managementEdge = fs.readFileSync(path.join(root, 'supabase', 'functions',
  'gestao-administrativa-fichas', 'index.ts'), 'utf8');
const html = fs.readFileSync(path.join(root, 'painel', 'index.html'), 'utf8');
const shell = fs.readFileSync(path.join(root, 'painel', 'app-shell.js'), 'utf8');

assert.match(migration, /create table public\.clinic_professional_verification_evidence/);
assert.match(migration, /status in \('pending', 'verified', 'revoked'\)/);
assert.match(migration, /independent_credential_verifier_required/);
assert.match(migration, /fase2_revisar_credencial_profissional_tecnica/);
assert.match(migration, /grant execute on function public\.fase2_revisar_credencial_profissional_tecnica[\s\S]+to service_role/);
assert.doesNotMatch(edge, /fase2_revisar_credencial_profissional_tecnica/,
  'revisao tecnica de credencial nao pode ser exposta na Edge');

assert.match(migration, /create table public\.patient_marketing_signature_evidence/);
assert.match(migration, /term\.procedure_kind='marketing_reactivation' and term\.active/);
assert.match(migration, /p_signature_evidence_id uuid/);
assert.match(migration, /case when p_accepted then pg_catalog\.lower\(v_term\.content_sha256\)/i);
assert.match(edge, /payload\.evidencia_assinatura_id/);
assert.doesNotMatch(edge, /payload\.(termo_sha256|assinatura_sha256|termo_versao)/,
  'Edge nao pode aceitar hashes ou snapshot do termo do cliente');

for (const table of ['clinic_professional_verification_evidence',
  'patient_marketing_signature_evidence', 'patient_marketing_consent_events',
  'acompanhamento_planos', 'reactivation_contact_attempts']) {
  assert.match(migration, new RegExp('alter table public\\.' + table + ' enable row level security'));
  assert.match(migration, new RegExp('revoke all on public\\.' + table + ' from public,anon,authenticated,service_role'));
}

assert.match(migration, /create function public\.operacao_listar_acompanhamentos_fase2/);
assert.match(migration, /latest_attendance as materialized[\s\S]+status in \('realizado','concluido'\)/);
assert.match(migration, /page_plus_one as materialized[\s\S]+limit p_limit\+1/);
assert.match(migration, /'has_more',[\s\S]+page_plus_one/);
assert.match(migration, /'plano_id',plan\.id[\s\S]+'versao_plano',plan\.version[\s\S]+'versao_fila',queue\.version/);
assert.match(migration, /'responsaveis'[\s\S]+'user_id',member\.user_id/);
assert.match(edge, /rpc\("operacao_listar_acompanhamentos_fase2"/);
assert.doesNotMatch(edge.slice(edge.indexOf('async function handleListPhase2Followups'),
  edge.indexOf('async function handleConfigureProfessionalCredential')), /\/rest\/v1\//,
  'LIST fase 2 deve ser uma unica RPC atomica');

assert.match(migration, /clinic_professional_credential_current[\s\S]+credential\.user_id=p_user_id/,
  'validacao pos deve derivar o profissional do ator');
assert.doesNotMatch(edge, /validated_by|validado_por_id/);
assert.match(migration, /patient\.archived_at is null for share/);
assert.match(migration, /patients_cancel_phase2_followups_after_archive/);
assert.match(migration, /recorded_at<=v_attempted_at/);
assert.match(migration, /reactivation_attempt_transition_invalid/);
assert.match(migration, /'fila_versao',v_queue\.version\+1[\s\S]+'mensagem_enviada',false/);

assert.match(ui, /async function load\(force\)/);
assert.match(ui, /setBusy\(false\); await load\(true\)/,
  'sucesso precisa recarregar mesmo depois de bloquear a tela');
assert.match(ui, /limite: 100/);
assert.match(ui, /row\.plano_id[\s\S]+row\.versao_plano[\s\S]+row\.versao_fila/);
assert.match(ui, /row\.elegivel === true[\s\S]+row\.canal/);
assert.match(ui, /Não envia mensagens/);

const tabNames = ['inicio', 'crm', 'marketing', 'fichas', 'agenda', 'prontuarios', 'financeiro',
  'operacao', 'acompanhamentos', 'gestao', 'cotacoes'];
const elements = new Map();
function classListMock() {
  const values = new Set(['oculto']);
  return {
    contains: (name) => values.has(name),
    toggle: (name, force) => force ? values.add(name) : values.delete(name)
  };
}
for (const name of tabNames) {
  elements.set('aba-bt-' + name, {
    hidden: false,
    disabled: false,
    attributes: {},
    tabIndex: -1,
    focused: false,
    setAttribute(name, value) { this.attributes[name] = value; },
    focus() { this.focused = true; }
  });
  elements.set('aba-' + name, { hidden: true, classList: classListMock() });
}
let followupsActivated = 0;
const functionStart = html.indexOf('function agendaAtivarAba(');
const functionEnd = html.indexOf('\nfunction agendaAtualizarEstadoCentral', functionStart);
assert.ok(functionStart >= 0 && functionEnd > functionStart,
  'função de ativação das abas deve existir no HTML');
const activateTab = Function('el', 'window',
  html.slice(functionStart, functionEnd) + '; return agendaAtivarAba;')(
  (id) => elements.get(id),
  { AMJAcompanhamentos: { ativar() { followupsActivated += 1; } } }
);
activateTab('acompanhamentos', true);
assert.equal(elements.get('aba-acompanhamentos').hidden, false,
  'rota Acompanhamentos deve revelar o painel legado');
assert.equal(elements.get('aba-acompanhamentos').classList.contains('oculto'), false,
  'rota Acompanhamentos deve retirar a classe visual oculta');
assert.equal(elements.get('aba-bt-acompanhamentos').attributes['aria-selected'], 'true',
  'aba Acompanhamentos deve anunciar seleção por ARIA');
assert.equal(elements.get('aba-bt-acompanhamentos').tabIndex, 0,
  'aba Acompanhamentos selecionada deve participar da ordem de foco');
assert.equal(elements.get('aba-bt-acompanhamentos').focused, true,
  'ativação direta com moverFoco deve focar Acompanhamentos');
assert.equal(followupsActivated, 1,
  'ativação da aba deve atualizar o módulo de Acompanhamentos');
assert.match(ui, /state\.responsaveis = \[\][\s\S]*state\.credentials = \[\][\s\S]*state\.consents = \[\][\s\S]*state\.root\.innerHTML = shell\(\)[\s\S]*state\.root\.hidden = true/,
  'logout deve remover credenciais, consentimentos, responsáveis e nomes renderizados');
assert.match(html, /AMJAcompanhamentos\) window\.AMJAcompanhamentos\.reset\(\)/,
  'limpeza central deve resetar Acompanhamentos');
assert.match(shell, /!authenticated[\s\S]*AMJAcompanhamentos\.reset\(\)[\s\S]*AMJMarketing\.reset\(\)/,
  'observer do shell deve limpar dados sensíveis de Acompanhamentos e Marketing');
assert.match(shell,
  /if \(mobile\)[\s\S]*?class="app-mobile-action"[\s\S]*?data-shell-route="[\s\S]*?class="app-shell-nav-button"[\s\S]*?data-shell-route="/,
  'atalhos mobile e desktop devem compartilhar o contrato data-shell-route');
assert.match(shell,
  /querySelectorAll\('\[data-shell-route\]'\)[\s\S]*?setAttribute\('aria-current', 'page'\)/,
  'navegação deve anunciar a rota atual nos atalhos desktop e mobile');
assert.match(shell,
  /const routeButton = event\.target\.closest\('\[data-shell-route\]'\)[\s\S]*?navigate\(routeButton\.dataset\.shellRoute/,
  'o mesmo manipulador deve encaminhar cliques desktop e mobile');
assert.match(shell,
  /if \(settings\.focus !== false\)[\s\S]*?byId\('app-shell-current-title'\)[\s\S]*?title\.focus\(\{ preventScroll: true \}\)/,
  'navegação pelo shell deve transferir foco ao título da área');

assert.match(record, /function renderPhotoComparison\(/);
assert.match(record, /consent\(protocol, 'clinical_photography'\)/);
assert.match(record, /safeSignedPhotoUrl\(photo\.miniatura_url\)[\s\S]+safeSignedPhotoUrl\(photo\.url_assinada\)/);
assert.match(record, /A autorização para marketing é independente/);
assert.match(css, /\.prontuario-comparacao-grade\s*\{[\s\S]*grid-template-columns:\s*repeat\(2,/);

for (const rpcName of ['prontuario_substituir_produtos', 'financeiro_criar_compra', 'financeiro_cancelar_compra',
  'financeiro_regularizar_item_compra_estoque', 'operacao_registrar_evento_consumo',
  'financeiro_editar_produto', 'financeiro_arquivar_produto', 'financeiro_restaurar_produto']) {
  const start = hardening.indexOf('create function public.' + rpcName + '(');
  assert.ok(start >= 0, 'wrapper ausente: ' + rpcName);
  const body = hardening.slice(start, hardening.indexOf('$function$;', start) + 11);
  assert.match(body, /perform private\.fase2_lock_stock_ledger\(p_clinic_id\)/,
    'lock global deve preceder implementação: ' + rpcName);
  assert.ok(body.indexOf('fase2_lock_stock_ledger') < body.indexOf('_locked_impl('),
    'ordem do lock global inválida: ' + rpcName);
}
assert.match(hardening, /if tg_table_name='financeiro_produtos'[\s\S]+new\.id/);
assert.match(hardening, /elsif tg_table_name='financeiro_estoque_movimentos'[\s\S]+new\.product_id/);
assert.match(hardening, /create table public\.clinical_photo_object_gc_queue/);
assert.match(hardening, /foreign key\(protocol_id\)[\s\S]+references public\.protocols\(id\)/,
  'fila GC deve usar a PK real de protocols e revalidar tenant no RPC');
assert.doesNotMatch(hardening, /foreign key\(clinic_id,protocol_id\)[\s\S]+protocols\(clinic_id,id\)/,
  'protocols não possui chave única composta clinic_id,id');
assert.match(hardening, /not_before timestamptz not null default pg_catalog\.now\(\)\+interval '24 hours'/);
assert.match(hardening, /exists\(select 1 from public\.protocol_photos[\s\S]+retido_por_referencia/);
assert.match(recordEdge, /queueOrphanPhotoObjects[\s\S]+prontuario_enfileirar_gc_foto_orfa/);
assert.match(recordEdge, /"thumbnail_failed"/);
assert.match(recordEdge, /"metadata_rejected"/);

assert.match(reporting, /create function public\.gestao_relatorio_acompanhamentos_fase2/);
assert.match(reporting, /p_end_date>\(pg_catalog\.now\(\) at time zone 'America\/Sao_Paulo'\)::date/);
assert.match(reporting, /p_end_date-p_start_date>365/);
assert.match(reporting, /p_value between 1 and 4[\s\S]+'valor',null,'suprimido',true/);
assert.match(reporting, /photo\.phase='before'[\s\S]+photo\.phase='after'[\s\S]+clinical_photography/);
assert.match(reporting, /public\.retorno_tentativas[\s\S]+union all[\s\S]+public\.reactivation_contact_attempts/);
assert.match(reporting, /atendimentos_com_antes_depois_e_consentimento/);
assert.match(reporting, /attendance\.status in \('realizado','concluido'\)/);
assert.match(reporting, /count\(distinct attendance\.id\)/,
  'joins 1:N não podem inflar células agregadas');
for (const forbidden of ['patient_id', 'patient_name', 'full_name', 'storage_path',
  'url_assinada', 'signature_sha256', 'responsible_user_id', 'lot_snapshot']) {
  const reportBody = reporting.slice(reporting.indexOf('create function public.gestao_relatorio'));
  assert.doesNotMatch(reportBody, new RegExp("'" + forbidden + "'"),
    'DTO agregado não pode expor ' + forbidden);
}
assert.match(managementEdge, /case "relatorio_acompanhamentos_fase2"/);
assert.match(managementEdge, /rpc\("gestao_relatorio_acompanhamentos_fase2"/);
assert.doesNotMatch(edge, /relatorio_acompanhamentos_fase2|operacao_relatorio_fase2/,
  'relatório não pode compartilhar a Edge clínica ampla');

console.log('fase2-acompanhamentos: ok');

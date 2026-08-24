(function () {
  'use strict';

  const API = 'https://rjxtxoqprnumouqakxbc.supabase.co/functions/v1/prontuario-fichas';
  const FINANCE_API = 'https://rjxtxoqprnumouqakxbc.supabase.co/functions/v1/financeiro-fichas';
  const state = { loaded: false, loading: false, patients: [], brands: [], products: [], inventory: [], protocols: [], generation: 0,
    pendingPatientId: null, originalProductsSignature: null, photosByProtocol: new Map() };
  const DATE = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeZone: 'America/Sao_Paulo' });
  const protocolIntentKeys = new WeakMap();

  function byId(id) { return document.getElementById(id); }
  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }
  function normalize(value) {
    return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
  }
  function uuid() {
    return window.crypto && typeof window.crypto.randomUUID === 'function' ? window.crypto.randomUUID() :
      'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (char) {
        const random = Math.random() * 16 | 0;
        return (char === 'x' ? random : (random & 3 | 8)).toString(16);
      });
  }
  function canonicalIntentValue(value) {
    if (Array.isArray(value)) return value.map(canonicalIntentValue);
    if (!value || typeof value !== 'object') return value;
    return Object.keys(value).sort().reduce(function (result, key) {
      if (key !== 'idempotency_key' && key !== 'operation_id') {
        result[key] = canonicalIntentValue(value[key]);
      }
      return result;
    }, {});
  }
  function protocolIntentKey(form, payload) {
    const fingerprint = JSON.stringify(canonicalIntentValue(payload || {}));
    const remembered = protocolIntentKeys.get(form);
    if (remembered && remembered.fingerprint === fingerprint) return remembered.key;
    const key = uuid();
    protocolIntentKeys.set(form, { fingerprint: fingerprint, key: key });
    return key;
  }
  function confirmProtocolIntent(form, key) {
    const remembered = protocolIntentKeys.get(form);
    if (remembered && remembered.key === key) protocolIntentKeys.delete(form);
  }
  function today() {
    const value = new Date(Date.now() - new Date().getTimezoneOffset() * 60000);
    return value.toISOString().slice(0, 10);
  }
  function localNow() {
    const value = new Date(Date.now() - new Date().getTimezoneOffset() * 60000);
    return value.toISOString().slice(0, 16);
  }
  function safeDate(value) {
    const raw = String(value || '');
    const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw + 'T12:00:00-03:00' : raw);
    return Number.isFinite(date.getTime()) ? DATE.format(date) : 'Sem data';
  }
  function ownerAccess() {
    try {
      return typeof modoAcesso !== 'undefined' && modoAcesso === 'auth' &&
        typeof identidadeBackend !== 'undefined' && identidadeBackend &&
        String(identidadeBackend.role || '').toLowerCase() === 'owner';
    } catch (_) { return false; }
  }
  function isArchived(item) { return Boolean(item && (item.archived_at || item.arquivado_em)); }
  function status(id, message, error) {
    const node = byId(id);
    if (!node) return;
    node.textContent = message || '';
    node.classList.toggle('erro', Boolean(error));
  }
  function setBusy(form, busy) {
    form.querySelectorAll('button,input,select,textarea').forEach(function (control) {
      if (busy) {
        if (!control.disabled) {
          control.dataset.amjBusyDisabled = '1';
          control.disabled = true;
        }
      } else if (control.dataset.amjBusyDisabled === '1') {
        control.disabled = false;
        delete control.dataset.amjBusyDisabled;
      }
    });
    form.setAttribute('aria-busy', String(Boolean(busy)));
  }
  function clearDuplicatePhotoChoice() {
    const current = byId('prontuario-foto-duplicada');
    if (current) current.remove();
  }
  function showDuplicatePhotoChoice(candidate, onConfirmDistinct) {
    clearDuplicatePhotoChoice();
    const statusNode = byId('prontuario-foto-status');
    if (!statusNode) return;
    const box = document.createElement('div');
    box.id = 'prontuario-foto-duplicada';
    box.className = 'prontuario-foto-duplicada';
    const archived = Boolean(candidate && (candidate.arquivada || candidate.archived_at));
    box.innerHTML = '<strong>Arquivo já cadastrado</strong><p>' +
      escapeHtml(archived ? 'A foto existente está arquivada. Abra a lista para restaurá-la.' :
        'Use a foto existente para evitar duplicidade. Só confirme outra cópia quando houver motivo real.') +
      '</p><div class="prontuario-fotos-controles">' +
      (candidate && candidate.url_assinada ? '<a class="botao" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer" href="' +
        escapeHtml(candidate.url_assinada) + '">Abrir existente</a>' :
        '<button type="button" data-abrir-foto-existente>Abrir existente na lista</button>') +
      '<button type="button" class="perigo" data-confirmar-foto-distinta>Confirmar cópia distinta com senha</button></div>';
    statusNode.insertAdjacentElement('afterend', box);
    const openList = box.querySelector('[data-abrir-foto-existente]');
    if (openList) openList.addEventListener('click', function () {
      const protocolId = byId('prontuario-id').value;
      if (protocolId) loadPhotos(protocolId, false);
    });
    box.querySelector('[data-confirmar-foto-distinta]').addEventListener('click', onConfirmDistinct);
  }
  function validForm(form) {
    const invalid = Array.from(form.querySelectorAll('[required]')).find(function (control) {
      return !control.checkValidity();
    });
    if (!invalid) return true;
    invalid.reportValidity();
    invalid.focus();
    return false;
  }

  async function jsonRequest(url, action, payload, proof) {
    const generation = state.generation;
    const response = await fetch(url, {
      method: 'POST',
      headers: await cabecalhosAcesso(true, proof),
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      body: JSON.stringify(Object.assign({ acao: action }, payload || {}))
    });
    let data = {};
    try { data = await response.json(); } catch (_) { data = {}; }
    if (generation !== state.generation) throw new Error('Sessão do prontuário encerrada.');
    if (!response.ok || data.erro || data.ok === false) {
      const error = new Error(data.erro || 'Não foi possível concluir a operação clínica.');
      error.status = response.status;
      error.code = data.codigo || String(response.status);
      error.data = data.dados || null;
      throw error;
    }
    if (data.identity && typeof atualizarIdentidade === 'function') atualizarIdentidade(data);
    return data;
  }

  async function protectedRequest(action, payload, options) {
    if (!window.AMJProtecao || typeof window.AMJProtecao.solicitarSenhaRecente !== 'function') {
      throw new Error('A confirmação segura por senha não está disponível. Atualize a página.');
    }
    let proof = null;
    try {
      proof = await window.AMJProtecao.solicitarSenhaRecente(options || {});
      return await jsonRequest(API, action, Object.assign({}, payload || {}, {
        operation_id: proof.operation_id,
        motivo: proof.motivo || 'Alteração clínica confirmada pela gestão'
      }), proof);
    } finally {
      if (proof && typeof proof.encerrar === 'function') await proof.encerrar();
    }
  }

  function updateAccess() {
    const button = byId('aba-bt-prontuarios');
    const block = byId('prontuario-bloqueio');
    const content = byId('prontuario-conteudo');
    if (!button || !block || !content) return;
    const allowed = ownerAccess();
    button.hidden = !allowed;
    button.disabled = !allowed;
    block.classList.toggle('oculto', allowed);
    content.classList.toggle('oculto', !allowed);
    if (!allowed && button.getAttribute('aria-selected') === 'true' && typeof agendaAtivarAba === 'function') {
      agendaAtivarAba('fichas', false);
    }
  }

  function replaceOptions(select, html) {
    const current = select.value;
    select.innerHTML = html;
    if (current && Array.from(select.options).some(function (option) { return option.value === current; })) {
      select.value = current;
    }
  }
  function productName(item) {
    const brand = state.brands.find(function (row) { return row.id === item.marca_id; });
    const lots = inventoryForProduct(item.id);
    const balance = lots.reduce(function (sum, lot) { return sum + Number(lot.saldo || 0); }, 0);
    const stock = item.controla_estoque ? 'estoque ' + balance + ' ' + (item.unidade || '') : '';
    return [item.nome, brand && brand.nome, stock].filter(Boolean).join(' · ') + (isArchived(item) ? ' · arquivado' : '');
  }
  function inventoryForProduct(productId) {
    return state.inventory.filter(function (item) {
      return String(item.produto_id) === String(productId) && Number(item.saldo || 0) > 0;
    });
  }
  function displayUnit(value) {
    return ({ u: 'U', ml: 'mL', un: 'un' })[String(value || '').toLowerCase()] || String(value || 'un');
  }
  function populateOptions() {
    const patients = state.patients.filter(function (item) { return !isArchived(item) && item.ativo !== false; });
    const products = state.products.filter(function (item) { return !isArchived(item) && item.ativo !== false; });
    replaceOptions(byId('prontuario-paciente'), '<option value="">Selecione</option>' + patients.map(function (item) {
      return '<option value="' + escapeHtml(item.id) + '">' + escapeHtml(item.nome) + '</option>';
    }).join(''));
    document.querySelectorAll('.prontuario-produto-select').forEach(function (select) {
      const selectedId = select.value || select.dataset.selectedId || '';
      const available = state.products.filter(function (item) {
        return (!isArchived(item) && item.ativo !== false) || item.id === selectedId;
      });
      replaceOptions(select, '<option value="">Selecione</option>' + available.map(function (item) {
        return '<option value="' + escapeHtml(item.id) + '">' + escapeHtml(productName(item)) + '</option>';
      }).join(''));
      if (selectedId) select.value = selectedId;
    });
    populatePhotoProductOptions();
  }

  function currentProtocol() {
    const protocolId = byId('prontuario-id') ? byId('prontuario-id').value : '';
    return state.protocols.find(function (item) { return String(item.id) === String(protocolId); }) || null;
  }
  function populatePhotoProductOptions() {
    const select = byId('prontuario-foto-produto');
    const lotInput = byId('prontuario-foto-lote');
    const lotList = byId('prontuario-foto-lotes');
    if (!select || !lotInput || !lotList) return;
    const protocol = currentProtocol();
    const used = protocol && Array.isArray(protocol.produtos) ? protocol.produtos : [];
    const selectedId = select.value;
    const unique = [];
    const seen = new Set();
    used.forEach(function (item) {
      const id = String(item.product_id || '');
      if (!id || seen.has(id)) return;
      seen.add(id);
      unique.push(item);
    });
    replaceOptions(select, '<option value="">Foto geral, sem produto específico</option>' + unique.map(function (item) {
      const label = [item.product_name_snapshot || productLabel(item.product_id), item.brand_name_snapshot].filter(Boolean).join(' · ');
      return '<option value="' + escapeHtml(item.product_id) + '">' + escapeHtml(label || 'Produto utilizado') + '</option>';
    }).join(''));
    if (selectedId && seen.has(String(selectedId))) select.value = selectedId;
    const lots = used.filter(function (item) {
      return !select.value || String(item.product_id) === String(select.value);
    }).map(function (item) { return String(item.lot || '').trim(); }).filter(Boolean);
    lotList.innerHTML = Array.from(new Set(lots)).map(function (lot) {
      return '<option value="' + escapeHtml(lot) + '"></option>';
    }).join('');
    if (lotInput.value && !lots.includes(lotInput.value)) lotInput.value = '';
  }
  function syncPhotoProductContext() {
    const context = byId('prontuario-foto-produto-contexto');
    const phase = byId('prontuario-foto-fase');
    if (!context || !phase) return;
    const visible = phase.value === 'products_used';
    context.classList.toggle('oculto', !visible);
    context.setAttribute('aria-hidden', String(!visible));
    if (!visible) {
      byId('prontuario-foto-produto').value = '';
      byId('prontuario-foto-lote').value = '';
    }
    populatePhotoProductOptions();
  }
  function ensurePhotoControls() {
    const editor = byId('prontuario-fotos-editor');
    const form = byId('prontuario-foto-form');
    const phase = byId('prontuario-foto-fase');
    if (!editor || !form || !phase) return;
    const phaseLabelNode = phase.closest('label');
    if (phaseLabelNode && phaseLabelNode.querySelector('span')) {
      phaseLabelNode.querySelector('span').textContent = 'Categoria';
    }
    phase.innerHTML = '<option value="before">Antes</option><option value="after">Depois</option>' +
      '<option value="products_used">Produtos utilizados</option>';
    const hint = editor.querySelector(':scope > div > p');
    if (hint) hint.textContent = 'O original em alta qualidade será preservado no armazenamento privado (até 25 MB). Uma miniatura separada agiliza a visualização.';
    if (!byId('prontuario-foto-produto-contexto')) {
      const context = document.createElement('div');
      context.id = 'prontuario-foto-produto-contexto';
      context.className = 'prontuario-foto-produto-contexto largo oculto';
      context.innerHTML = '<label><span>Produto da foto (opcional)</span><select id="prontuario-foto-produto"><option value="">Foto geral, sem produto específico</option></select></label>' +
        '<label><span>Lote da foto (opcional)</span><input id="prontuario-foto-lote" type="text" maxlength="100" list="prontuario-foto-lotes"><datalist id="prontuario-foto-lotes"></datalist></label>' +
        '<small>O produto e o lote, quando informados, precisam constar nos produtos utilizados neste procedimento.</small>';
      const fileLabel = byId('prontuario-foto-arquivo').closest('label');
      form.insertBefore(context, fileLabel || form.querySelector('button'));
      byId('prontuario-foto-produto').addEventListener('change', populatePhotoProductOptions);
    }
    phase.addEventListener('change', syncPhotoProductContext);
    syncPhotoProductContext();
  }

  async function createPhotoThumbnail(file) {
    if (!window.createImageBitmap || !document.createElement('canvas').getContext) return null;
    let bitmap;
    try {
      bitmap = await window.createImageBitmap(file);
      const maxSide = 640;
      const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const context = canvas.getContext('2d', { alpha: false });
      if (!context) return null;
      context.fillStyle = '#fff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise(function (resolve) {
        canvas.toBlob(resolve, 'image/webp', 0.82);
      });
      if (!blob || blob.size < 1 || blob.size > 1024 * 1024) return null;
      const stem = String(file.name || 'foto').replace(/\.[^.]+$/, '').slice(0, 120) || 'foto';
      return new File([blob], stem + '.miniatura.webp', { type: blob.type, lastModified: Date.now() });
    } catch (_) {
      return null;
    } finally {
      if (bitmap && typeof bitmap.close === 'function') bitmap.close();
    }
  }

  function unitOptions(selected) {
    return ['un', 'U', 'mL', 'mg', 'g', 'frasco', 'seringa', 'ampola', 'aplicacao', 'canula', 'dose', 'kit', 'cx'].map(function (unit) {
      return '<option value="' + unit + '"' + (String(selected || '') === unit ? ' selected' : '') + '>' + unit + '</option>';
    }).join('');
  }
  function addProductRow(data) {
    const item = data || {};
    const row = document.createElement('div');
    row.className = 'prontuario-produto-linha';
    row.innerHTML = '<label><span>Produto</span><select class="prontuario-produto-select"><option value="">Selecione</option></select></label>' +
      '<label><span>Lote</span><input class="prontuario-produto-lote" type="text" maxlength="100"><datalist></datalist></label>' +
      '<label><span>Validade</span><input class="prontuario-produto-validade" type="date"></label>' +
      '<label><span>Quantidade</span><input class="prontuario-produto-quantidade" type="number" min="0.0001" max="999999999" step="0.0001"></label>' +
      '<label><span>Unidade</span><select class="prontuario-produto-unidade">' + unitOptions(item.unit || 'un') + '</select></label>' +
      '<p class="prontuario-produto-estoque"></p>' +
      '<button class="prontuario-botao perigo" type="button">Remover</button>';
    byId('prontuario-produtos-lista').appendChild(row);
    row.querySelector('.prontuario-produto-select').dataset.selectedId = item.product_id || '';
    populateOptions();
    row.querySelector('.prontuario-produto-select').value = item.product_id || '';
    row.querySelector('.prontuario-produto-select').addEventListener('change', function (event) {
      event.currentTarget.dataset.selectedId = event.currentTarget.value;
      syncProductStock(row, true);
    });
    row.querySelector('.prontuario-produto-lote').value = item.lot || '';
    row.querySelector('.prontuario-produto-validade').value = item.expiry || '';
    row.querySelector('.prontuario-produto-quantidade').value = item.amount == null ? '' : item.amount;
    row.querySelector('.prontuario-produto-lote').addEventListener('change', function () {
      const productId = row.querySelector('.prontuario-produto-select').value;
      const selectedLot = inventoryForProduct(productId).find(function (lot) {
        return normalize(lot.lote) === normalize(row.querySelector('.prontuario-produto-lote').value);
      });
      if (selectedLot) row.querySelector('.prontuario-produto-validade').value = selectedLot.validade || '';
    });
    syncProductStock(row, false);
    row.querySelector('button').addEventListener('click', function () {
      row.remove();
      if (!byId('prontuario-produtos-lista').children.length) addProductRow();
    });
  }
  function syncProductStock(row, changedProduct) {
    const productId = row.querySelector('.prontuario-produto-select').value;
    const product = state.products.find(function (item) { return String(item.id) === String(productId); });
    const lots = inventoryForProduct(productId);
    const lotInput = row.querySelector('.prontuario-produto-lote');
    const datalist = row.querySelector('datalist');
    const hint = row.querySelector('.prontuario-produto-estoque');
    const listId = 'prontuario-lotes-' + uuid();
    datalist.id = listId;
    lotInput.setAttribute('list', listId);
    datalist.innerHTML = lots.map(function (lot) {
      return '<option value="' + escapeHtml(lot.lote) + '">' + escapeHtml(String(lot.saldo)) +
        ' ' + escapeHtml(lot.unidade) + ' · validade ' + escapeHtml(lot.validade) + '</option>';
    }).join('');
    if (!product) { hint.textContent = ''; return; }
    if (changedProduct) row.querySelector('.prontuario-produto-unidade').value = displayUnit(product.unidade);
    const balance = lots.reduce(function (sum, lot) { return sum + Number(lot.saldo || 0); }, 0);
    hint.textContent = product.controla_estoque
      ? 'Disponível: ' + balance + ' ' + (product.unidade || '') + ' em ' + lots.length + ' lote(s). Selecione um lote existente.'
      : 'Este produto não baixa estoque automaticamente.';
  }
  function collectProducts() {
    const rows = Array.from(byId('prontuario-produtos-lista').querySelectorAll('.prontuario-produto-linha'));
    const products = [];
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const productId = row.querySelector('.prontuario-produto-select').value;
      const lot = row.querySelector('.prontuario-produto-lote').value.trim();
      const expiry = row.querySelector('.prontuario-produto-validade').value;
      const rawAmount = row.querySelector('.prontuario-produto-quantidade').value;
      if (!productId && !lot && !expiry && !rawAmount) continue;
      const amount = Number(rawAmount);
      if (!productId || !lot || !expiry || !(amount > 0)) {
        throw new Error('Complete produto, lote, validade e quantidade em cada item utilizado.');
      }
      products.push({ product_id: productId, lot: lot, expiry: expiry, amount: amount,
        unit: row.querySelector('.prontuario-produto-unidade').value, position: products.length + 1 });
    }
    return products;
  }
  function productSignature(products) {
    return JSON.stringify((products || []).map(function (item, index) {
      return { product_id: item.product_id, lot: item.lot, expiry: item.expiry,
        amount: Number(item.amount), unit: item.unit, position: Number(item.position) || index + 1 };
    }));
  }

  function procedureLabel(value) {
    return ({ toxina_terco_superior: 'Toxina botulínica · terço superior', toxina_full_face: 'Toxina botulínica · full face',
      preenchimento_facial: 'Preenchimento facial', bioestimulador_colageno: 'Bioestimulador de colágeno',
      fios_pdo: 'Fios de PDO', peeling_quimico: 'Peeling químico', skinbooster: 'Skinbooster',
      microagulhamento: 'Microagulhamento', intradermoterapia: 'Intradermoterapia', outro: 'Outro procedimento' })[value] || value || 'Procedimento';
  }
  function phaseLabel(value) {
    return ({ before: 'Antes', during: 'Durante (legado)', after: 'Depois',
      products_used: 'Produtos utilizados' })[value] || value;
  }
  function productLabel(productId) {
    const product = state.products.find(function (item) { return String(item.id) === String(productId); });
    return product ? productName(product) : '';
  }
  function photoPage(protocolId) {
    return state.photosByProtocol.get(String(protocolId)) || null;
  }
  function renderPhotoCard(photo, protocol, showArchived) {
    const photoArchived = Boolean(photo.archived_at);
    if (photoArchived && !showArchived) return '';
    const preview = photoArchived
      ? '<div class="prontuario-foto-arquivada">Foto privada arquivada</div>'
      : '<a class="prontuario-foto-preview" href="' + escapeHtml(photo.url_assinada || '#') +
        '" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer" aria-label="Abrir foto original em alta qualidade">' +
        '<img src="' + escapeHtml(photo.miniatura_url || photo.url_assinada || '') + '" alt="Foto clínica privada · ' +
        escapeHtml(phaseLabel(photo.phase)) + '" loading="lazy" decoding="async"></a>';
    const product = photo.product_id ? productLabel(photo.product_id) : '';
    const context = [product, photo.lot_snapshot ? 'lote ' + photo.lot_snapshot : ''].filter(Boolean).join(' · ');
    const action = isArchived(protocol) ? '<small>Restaure o prontuário para alterar a foto.</small>' :
      (photoArchived ? '<button type="button" data-prontuario-restaurar-foto="' + escapeHtml(photo.id) +
        '" data-prontuario-protocolo="' + escapeHtml(protocol.id) + '">Restaurar foto</button>' :
        '<button class="perigo" type="button" data-prontuario-remover-foto="' + escapeHtml(photo.id) +
        '" data-prontuario-protocolo="' + escapeHtml(protocol.id) + '">Apagar/Arquivar</button>');
    return '<article class="prontuario-foto-card' + (photoArchived ? ' arquivado' : '') + '">' + preview +
      '<div><span>' + escapeHtml(phaseLabel(photo.phase)) + (photoArchived ? ' · Arquivada' : '') +
      (context ? '<small>' + escapeHtml(context) + '</small>' : '') + '</span>' + action + '</div></article>';
  }
  function renderPhotoSection(protocol, showArchived) {
    const summary = protocol.fotos_resumo || {};
    const count = showArchived ? Number(summary.total || 0) : Number(summary.ativas || 0);
    const page = photoPage(protocol.id);
    if (!page) {
      return '<div class="prontuario-fotos-controles"><button type="button" data-prontuario-carregar-fotos="' +
        escapeHtml(protocol.id) + '">Ver fotos (' + count + ')</button></div>';
    }
    const photos = Array.isArray(page.items) ? page.items : [];
    const cards = photos.map(function (photo) { return renderPhotoCard(photo, protocol, showArchived); }).filter(Boolean);
    const grid = cards.length ? '<div class="prontuario-fotos-grade">' + cards.join('') + '</div>' :
      (!page.loading ? '<p class="prontuario-fotos-vazio">Nenhuma foto nesta seleção.</p>' : '');
    const controls = '<div class="prontuario-fotos-controles">' +
      (page.error ? '<span class="erro">' + escapeHtml(page.error) + '</span>' : '') +
      (page.loading ? '<span>Carregando fotos privadas…</span>' : '') +
      (page.hasMore && !page.loading ? '<button type="button" data-prontuario-mais-fotos="' +
        escapeHtml(protocol.id) + '">Carregar mais</button>' : '') +
      (!page.loading ? '<button type="button" data-prontuario-recarregar-fotos="' + escapeHtml(protocol.id) +
        '">Atualizar fotos (' + count + ')</button>' : '') + '</div>';
    return grid + controls;
  }
  function consent(protocol, kind) {
    const current = protocol && protocol.consentimentos_atuais;
    if (Array.isArray(current)) {
      const item = current.find(function (row) { return row && row.kind === kind; });
      return Boolean(item && item.accepted === true && !item.revoked_at);
    }
    if (current && typeof current === 'object' &&
        Object.prototype.hasOwnProperty.call(current, kind)) {
      const value = current[kind];
      if (typeof value === 'boolean') return value;
      return Boolean(value && typeof value === 'object' && value.accepted === true && !value.revoked_at);
    }

    const events = (protocol && Array.isArray(protocol.consentimentos) ? protocol.consentimentos : [])
      .filter(function (item) { return item && item.kind === kind; })
      .map(function (item) {
        const recordedAt = item.recorded_at || item.accepted_at || item.revoked_at || '';
        const timestamp = Date.parse(recordedAt);
        return { item: item, timestamp: Number.isFinite(timestamp) ? timestamp : 0 };
      })
      .filter(function (event) { return event.timestamp > 0; })
      .sort(function (left, right) {
        if (right.timestamp !== left.timestamp) return right.timestamp - left.timestamp;
        return String(right.item.id || '').localeCompare(String(left.item.id || ''));
      });
    const latest = events.length ? events[0].item : null;
    return Boolean(latest && latest.accepted === true && !latest.revoked_at);
  }
  function render() {
    const query = normalize(byId('prontuario-busca').value);
    const showArchived = byId('prontuario-mostrar-arquivados').checked;
    const rows = state.protocols.filter(function (item) {
      const text = normalize([(item.paciente && item.paciente.nome) || '', procedureLabel(item.procedure_kind), item.complaint].join(' '));
      return (showArchived || !isArchived(item)) && text.includes(query);
    });
    byId('prontuario-contagem').textContent = rows.length + (rows.length === 1 ? ' registro exibido' : ' registros exibidos');
    byId('prontuario-lista').innerHTML = rows.length ? rows.map(function (item) {
      const archived = isArchived(item);
      const products = (item.produtos || []).map(function (product) {
        return [product.product_name_snapshot, product.brand_name_snapshot, product.lot ? 'lote ' + product.lot : ''].filter(Boolean).join(' · ');
      });
      const photoHtml = renderPhotoSection(item, showArchived);
      return '<article class="prontuario-card' + (archived ? ' arquivado' : '') + '"><div class="prontuario-card-topo"><div><h4>' +
        escapeHtml((item.paciente && item.paciente.nome) || 'Paciente') + (archived ? ' · Arquivado' : '') + '</h4><small>' +
        escapeHtml(procedureLabel(item.procedure_kind) + ' · ' + safeDate(item.procedure_date) +
          (item.return_date ? ' · retorno ' + safeDate(item.return_date) : '')) + '</small></div><div class="prontuario-card-acoes">' +
        '<button type="button" data-prontuario-editar="' + escapeHtml(item.id) + '">Editar</button><button class="' +
        (archived ? '' : 'perigo') + '" type="button" data-prontuario-estado="' + (archived ? 'restaurar' : 'arquivar') +
        '" data-prontuario-id="' + escapeHtml(item.id) + '">' + (archived ? 'Restaurar' : 'Apagar/Arquivar') + '</button></div></div>' +
        (products.length ? '<div class="prontuario-produtos-resumo"><strong>Produtos:</strong> ' + escapeHtml(products.join(' | ')) + '</div>' : '') +
        photoHtml + '</article>';
    }).join('') : '<p class="prontuario-vazio">Nenhum prontuário encontrado.</p>';
  }

  async function loadPhotos(protocolId, append) {
    const key = String(protocolId || '');
    if (!key || !ownerAccess()) return;
    const current = photoPage(key);
    if (current && current.loading) return;
    const showArchived = byId('prontuario-mostrar-arquivados').checked;
    const pageNumber = append && current ? Number(current.page || 0) + 1 : 1;
    const loadingPage = {
      items: append && current ? current.items.slice() : [],
      page: append && current ? current.page : 0,
      hasMore: append && current ? current.hasMore : false,
      includeArchived: showArchived,
      loading: true,
      error: ''
    };
    state.photosByProtocol.set(key, loadingPage);
    render();
    try {
      const result = await jsonRequest(API, 'listar_fotos', {
        protocolo_id: key,
        pagina: pageNumber,
        por_pagina: 12,
        incluir_arquivadas: showArchived
      });
      const incoming = Array.isArray(result.fotos) ? result.fotos : [];
      const combined = append ? loadingPage.items.concat(incoming) : incoming;
      const seen = new Set();
      const items = combined.filter(function (photo) {
        const id = String(photo && photo.id || '');
        if (!id || seen.has(id)) return false;
        seen.add(id);
        return true;
      });
      state.photosByProtocol.set(key, {
        items: items,
        page: pageNumber,
        hasMore: Boolean(result.paginacao && result.paginacao.tem_mais),
        includeArchived: showArchived,
        loading: false,
        error: ''
      });
    } catch (error) {
      state.photosByProtocol.set(key, Object.assign({}, loadingPage, {
        loading: false,
        error: error.message || 'Não foi possível carregar as fotos privadas.'
      }));
    }
    render();
  }

  async function load(options) {
    if (state.loading || !ownerAccess()) return;
    state.loading = true;
    byId('prontuario-lista').setAttribute('aria-busy', 'true');
    status('prontuario-status', options && options.silent ? '' : 'Atualizando prontuários…', false);
    try {
      const result = await Promise.all([
        jsonRequest(FINANCE_API, 'listar_clientes', { por_pagina: 100, incluir_arquivados: true }),
        jsonRequest(FINANCE_API, 'listar_catalogos', { incluir_arquivados: true }),
        jsonRequest(FINANCE_API, 'listar_estoque', { limite: 500 }),
        jsonRequest(API, 'listar', { incluir_arquivados: true, limite: 100 })
      ]);
      state.patients = Array.isArray(result[0].clientes) ? result[0].clientes : [];
      state.brands = Array.isArray(result[1].marcas) ? result[1].marcas : [];
      state.products = Array.isArray(result[1].produtos) ? result[1].produtos : [];
      state.inventory = Array.isArray(result[2].estoque) ? result[2].estoque : [];
      state.protocols = Array.isArray(result[3].protocolos) ? result[3].protocolos : [];
      populateOptions();
      render();
      state.loaded = true;
      status('prontuario-status', 'Prontuários atualizados com dados privados do servidor.', false);
      if (state.pendingPatientId) {
        const patientId = state.pendingPatientId;
        state.pendingPatientId = null;
        resetForm();
        byId('prontuario-paciente').value = patientId;
        byId('prontuario-editor').open = true;
        byId('prontuario-editor').scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    } catch (error) {
      status('prontuario-status', error.message, true);
    } finally {
      state.loading = false;
      byId('prontuario-lista').setAttribute('aria-busy', 'false');
    }
  }

  function resetForm() {
    const form = byId('prontuario-form');
    protocolIntentKeys.delete(form);
    form.reset();
    if (byId('prontuario-foto-form')) {
      byId('prontuario-foto-form').reset();
      byId('prontuario-foto-data').value = localNow();
      syncPhotoProductContext();
    }
    status('prontuario-foto-status', '', false);
    byId('prontuario-id').value = '';
    byId('prontuario-versao').value = '';
    byId('prontuario-data').value = today();
    byId('prontuario-form-titulo').textContent = 'Novo registro de procedimento';
    byId('prontuario-salvar').textContent = 'Salvar prontuário';
    byId('prontuario-cancelar-edicao').classList.add('oculto');
    byId('prontuario-fotos-editor').classList.add('oculto');
    byId('prontuario-produtos-lista').innerHTML = '';
    addProductRow();
    state.originalProductsSignature = null;
    status('prontuario-form-status', '', false);
  }
  function beginEdit(id) {
    const item = state.protocols.find(function (row) { return row.id === id; });
    if (!item) return;
    resetForm();
    byId('prontuario-id').value = item.id;
    byId('prontuario-versao').value = item.version || item.versao || 1;
    byId('prontuario-paciente').value = item.patient_id || '';
    byId('prontuario-tipo').value = item.procedure_kind || '';
    byId('prontuario-data').value = item.procedure_date || today();
    byId('prontuario-retorno').value = item.return_date || '';
    byId('prontuario-queixa').value = item.complaint || '';
    byId('prontuario-notas').value = item.technique_notes || '';
    byId('prontuario-orientacoes').value = item.care_notes || '';
    byId('prontuario-consentimento-dados').checked = consent(item, 'data_processing');
    byId('prontuario-consentimento-fotos').checked = consent(item, 'clinical_photography');
    byId('prontuario-consentimento-marketing').checked = false;
    byId('prontuario-produtos-lista').innerHTML = '';
    (item.produtos || []).forEach(addProductRow);
    if (!(item.produtos || []).length) addProductRow();
    state.originalProductsSignature = productSignature(item.produtos || []);
    byId('prontuario-form-titulo').textContent = 'Editar registro de ' + ((item.paciente && item.paciente.nome) || 'paciente');
    byId('prontuario-salvar').textContent = 'Salvar alterações';
    byId('prontuario-cancelar-edicao').classList.remove('oculto');
    byId('prontuario-fotos-editor').classList.remove('oculto');
    byId('prontuario-foto-data').value = localNow();
    populatePhotoProductOptions();
    byId('prontuario-editor').open = true;
    byId('prontuario-editor').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  async function submitProtocol(event) {
    event.preventDefault();
    const form = event.currentTarget;
    if (!validForm(form)) return;
    if (byId('prontuario-consentimento-marketing').checked && !byId('prontuario-consentimento-fotos').checked) {
      status('prontuario-form-status', 'A autorização de marketing exige também a autorização de fotografia clínica.', true);
      return;
    }
    let products;
    try { products = collectProducts(); } catch (error) { status('prontuario-form-status', error.message, true); return; }
    const protocolId = byId('prontuario-id').value;
    const payload = {
      protocolo_id: protocolId || null,
      versao_esperada: protocolId ? Number(byId('prontuario-versao').value) : undefined,
      paciente_id: byId('prontuario-paciente').value,
      agendamento_id: null,
      tipo_procedimento: byId('prontuario-tipo').value,
      queixa: byId('prontuario-queixa').value.trim() || null,
      anamnese: {},
      notas_tecnica: byId('prontuario-notas').value.trim() || null,
      data_procedimento: byId('prontuario-data').value || null,
      data_retorno: byId('prontuario-retorno').value || null,
      orientacoes: byId('prontuario-orientacoes').value.trim() || null,
      produtos: products,
      consentimentos: {
        clinical_photography: byId('prontuario-consentimento-fotos').checked
      }
    };
    if (protocolId && productSignature(products) === state.originalProductsSignature) delete payload.produtos;
    const intentKey = protocolId ? uuid() : protocolIntentKey(form, payload);
    payload.idempotency_key = intentKey;
    setBusy(form, true);
    try {
      const result = protocolId ? await protectedRequest('criar_atualizar', payload, {
        titulo: 'Editar prontuário',
        explicacao: 'A alteração clínica ficará registrada na auditoria e exige sua senha atual.',
        motivo: 'Correção ou complementação de prontuário pela gestão'
      }) : await jsonRequest(API, 'criar_atualizar', payload);
      status('prontuario-form-status', protocolId ? 'Prontuário atualizado com auditoria.' :
        'Prontuário criado. Agora você pode adicionar as fotos autorizadas.', false);
      if (!protocolId) confirmProtocolIntent(form, intentKey);
      await load({ silent: true });
      beginEdit(result.protocolo_id);
    } catch (error) {
      status('prontuario-form-status', error.message, true);
    } finally { setBusy(form, false); }
  }

  async function submitPhoto(event) {
    event.preventDefault();
    const form = event.currentTarget;
    clearDuplicatePhotoChoice();
    const protocolId = byId('prontuario-id').value;
    const file = byId('prontuario-foto-arquivo').files[0];
    if (!protocolId || !file) { status('prontuario-foto-status', 'Selecione uma foto.', true); return; }
    if (!byId('prontuario-consentimento-fotos').checked) {
      status('prontuario-foto-status', 'Confirme e salve primeiro a autorização de fotografia clínica.', true);
      return;
    }
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size < 1 || file.size > 25 * 1024 * 1024) {
      status('prontuario-foto-status', 'Use uma imagem JPEG, PNG ou WebP de até 25 MB.', true);
      return;
    }
    setBusy(form, true);
    let thumbnail = null;
    const idempotencyKey = uuid();
    const phase = byId('prontuario-foto-fase').value;
    const takenAtLocal = byId('prontuario-foto-data').value;
    const takenAt = takenAtLocal ? new Date(takenAtLocal) : new Date();
    const productId = phase === 'products_used' ? byId('prontuario-foto-produto').value : '';
    const lot = phase === 'products_used' ? byId('prontuario-foto-lote').value.trim() : '';
    function makeData(extra) {
      const data = new FormData();
      data.append('acao', 'adicionar_foto');
      data.append('protocolo_id', protocolId);
      data.append('fase', phase);
      data.append('tirada_em', takenAt.toISOString());
      data.append('idempotency_key', idempotencyKey);
      data.append('arquivo', file, file.name);
      if (thumbnail) data.append('miniatura', thumbnail, thumbnail.name);
      if (productId) data.append('produto_id', productId);
      if (lot) data.append('lote', lot);
      Object.keys(extra || {}).forEach(function (key) {
        if (extra[key] !== undefined && extra[key] !== null && extra[key] !== '') {
          data.append(key, String(extra[key]));
        }
      });
      return data;
    }
    async function sendPhoto(extra, proof) {
      const response = await fetch(API, {
        method: 'POST',
        headers: await cabecalhosAcesso(false, proof),
        body: makeData(extra),
        cache: 'no-store',
        referrerPolicy: 'no-referrer'
      });
      let result = {};
      try { result = await response.json(); } catch (_) { result = {}; }
      if (!response.ok || result.erro || result.ok === false) {
        const error = new Error(result.erro || 'Não foi possível enviar a foto.');
        error.status = response.status;
        error.code = result.codigo || String(response.status);
        error.data = result.dados || null;
        throw error;
      }
      return result;
    }
    async function finishPhoto(message) {
      clearDuplicatePhotoChoice();
      form.reset();
      byId('prontuario-foto-data').value = localNow();
      syncPhotoProductContext();
      status('prontuario-foto-status', message, false);
      await load({ silent: true });
      beginEdit(protocolId);
      await loadPhotos(protocolId, false);
    }
    try {
      if (!Number.isFinite(takenAt.getTime())) throw new Error('Informe corretamente a data da foto.');
      thumbnail = await createPhotoThumbnail(file);
      await sendPhoto(null, null);
      await finishPhoto('Foto adicionada ao armazenamento clínico privado.');
    } catch (error) {
      if (error.code === 'photo_exact_duplicate' && error.data && error.data.candidato) {
        status('prontuario-foto-status', error.message, true);
        showDuplicatePhotoChoice(error.data.candidato, async function () {
          if (!window.AMJProtecao || typeof window.AMJProtecao.solicitarSenhaRecente !== 'function') {
            status('prontuario-foto-status', 'A confirmação por senha não está disponível. Atualize a página.', true);
            return;
          }
          let proof = null;
          setBusy(form, true);
          try {
            proof = await window.AMJProtecao.solicitarSenhaRecente({
              titulo: 'Confirmar foto realmente distinta',
              explicacao: 'O arquivo é idêntico a uma foto já guardada. Informe o motivo real para manter outra cópia; a decisão ficará auditada.',
              motivo: 'Arquivo idêntico mantido como registro clínico distinto'
            });
            await sendPhoto({
              confirmar_arquivo_distinto: true,
              motivo_duplicidade: proof.motivo || 'Arquivo idêntico mantido como registro clínico distinto',
              operation_id: proof.operation_id
            }, proof);
            await finishPhoto('Foto distinta confirmada com senha e motivo auditável.');
          } catch (confirmError) {
            status('prontuario-foto-status', confirmError.message || 'Não foi possível confirmar a foto distinta.', true);
          } finally {
            if (proof && typeof proof.encerrar === 'function') await proof.encerrar();
            setBusy(form, false);
          }
        });
      } else {
        status('prontuario-foto-status', error.message, true);
      }
    }
    finally { setBusy(form, false); }
  }

  async function changeState(id, action) {
    const item = state.protocols.find(function (row) { return row.id === id; });
    if (!item) return;
    const restoring = action === 'restaurar';
    try {
      await protectedRequest(action, { protocolo_id: id, versao_esperada: item.version || item.versao || 1 }, {
        titulo: restoring ? 'Restaurar prontuário' : 'Apagar/Arquivar prontuário',
        explicacao: restoring ? 'O registro voltará aos prontuários ativos.' :
          'O registro sairá da lista ativa, mas o histórico clínico e a auditoria serão preservados.',
        motivo: (restoring ? 'Restauração' : 'Arquivamento') + ' de prontuário solicitado pela gestão'
      });
      status('prontuario-status', restoring ? 'Prontuário restaurado.' : 'Prontuário arquivado com auditoria.', false);
      if (byId('prontuario-id').value === id) resetForm();
      await load({ silent: true });
    } catch (error) { status('prontuario-status', error.message, true); }
  }

  async function removePhoto(photoId, protocolId) {
    try {
      await protectedRequest('remover_foto', { foto_id: photoId }, {
        titulo: 'Remover foto clínica',
        explicacao: 'A foto e o arquivo privado serão arquivados sem apagar o histórico e poderão ser restaurados com senha.',
        motivo: 'Remoção de foto clínica solicitada pela gestão'
      });
      status('prontuario-status', 'Foto removida do prontuário com auditoria.', false);
      await load({ silent: true });
      if (byId('prontuario-id').value === protocolId) beginEdit(protocolId);
      await loadPhotos(protocolId, false);
    } catch (error) { status('prontuario-status', error.message, true); }
  }

  async function restorePhoto(photoId, protocolId) {
    try {
      await protectedRequest('restaurar_foto', { foto_id: photoId }, {
        titulo: 'Restaurar foto clínica',
        explicacao: 'A imagem privada voltará ao prontuário e a restauração ficará registrada na auditoria.',
        motivo: 'Restauração de foto clínica solicitada pela gestão'
      });
      status('prontuario-status', 'Foto restaurada com auditoria.', false);
      await load({ silent: true });
      if (byId('prontuario-id').value === protocolId) beginEdit(protocolId);
      await loadPhotos(protocolId, false);
    } catch (error) { status('prontuario-status', error.message, true); }
  }

  async function linkPhotoOperation(photoId, attendanceId, procedureItemId) {
    const result = await protectedRequest('vincular_foto_operacao', {
      foto_id: photoId,
      atendimento_id: attendanceId,
      item_procedimento_id: procedureItemId || null
    }, {
      titulo: 'Vincular foto ao atendimento',
      explicacao: 'O vínculo entre a foto privada e o atendimento ficará registrado na auditoria e exige sua senha atual.',
      motivo: 'Vínculo de foto clínica ao atendimento confirmado pela gestão'
    });
    const photo = Array.from(state.photosByProtocol.values()).reduce(function (found, page) {
      return found || (page.items || []).find(function (item) { return String(item.id) === String(photoId); });
    }, null);
    if (photo) {
      photo.attendance_id = result.atendimento_id || attendanceId;
      photo.procedure_item_id = result.item_procedimento_id || null;
    }
    return result;
  }

  function activate() {
    updateAccess();
    if (ownerAccess() && !state.loaded) load();
  }
  function newForPatient(patientId) {
    state.pendingPatientId = patientId;
    if (typeof agendaAtivarAba === 'function') agendaAtivarAba('prontuarios', false);
    if (state.loaded) {
      state.pendingPatientId = null;
      resetForm();
      byId('prontuario-paciente').value = patientId;
      byId('prontuario-editor').open = true;
      byId('prontuario-editor').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else if (!state.loading) load();
  }
  function reset() {
    state.generation += 1;
    state.loaded = false;
    state.loading = false;
    state.patients = [];
    state.brands = [];
    state.products = [];
    state.inventory = [];
    state.protocols = [];
    state.photosByProtocol.clear();
    state.pendingPatientId = null;
    state.originalProductsSignature = null;
    resetForm();
    render();
  }
  function bind() {
    ensurePhotoControls();
    byId('prontuario-data').value = today();
    byId('prontuario-foto-data').value = localNow();
    addProductRow();
    byId('prontuario-atualizar').addEventListener('click', function () { load(); });
    byId('prontuario-adicionar-produto').addEventListener('click', function () { addProductRow(); });
    byId('prontuario-form').addEventListener('submit', submitProtocol);
    byId('prontuario-form').addEventListener('reset', function (event) {
      protocolIntentKeys.delete(event.currentTarget);
    });
    byId('prontuario-foto-form').addEventListener('submit', submitPhoto);
    byId('prontuario-cancelar-edicao').addEventListener('click', resetForm);
    byId('prontuario-busca').addEventListener('input', render);
    byId('prontuario-mostrar-arquivados').addEventListener('change', function () {
      state.photosByProtocol.clear();
      render();
    });
    byId('prontuario-lista').addEventListener('click', function (event) {
      const edit = event.target.closest('[data-prontuario-editar]');
      const stateButton = event.target.closest('[data-prontuario-estado]');
      const photo = event.target.closest('[data-prontuario-remover-foto]');
      const restore = event.target.closest('[data-prontuario-restaurar-foto]');
      const loadPhoto = event.target.closest('[data-prontuario-carregar-fotos]');
      const morePhotos = event.target.closest('[data-prontuario-mais-fotos]');
      const reloadPhotos = event.target.closest('[data-prontuario-recarregar-fotos]');
      if (edit) beginEdit(edit.dataset.prontuarioEditar);
      else if (stateButton) changeState(stateButton.dataset.prontuarioId, stateButton.dataset.prontuarioEstado);
      else if (photo) removePhoto(photo.dataset.prontuarioRemoverFoto, photo.dataset.prontuarioProtocolo);
      else if (restore) restorePhoto(restore.dataset.prontuarioRestaurarFoto, restore.dataset.prontuarioProtocolo);
      else if (loadPhoto) loadPhotos(loadPhoto.dataset.prontuarioCarregarFotos, false);
      else if (morePhotos) loadPhotos(morePhotos.dataset.prontuarioMaisFotos, true);
      else if (reloadPhotos) loadPhotos(reloadPhotos.dataset.prontuarioRecarregarFotos, false);
    });
    updateAccess();
  }

  window.AMJProntuario = { ativar: activate, atualizarAcesso: updateAccess, reset: reset, carregar: load,
    carregarFotos: loadPhotos, vincularFotoOperacao: linkPhotoOperation, novoParaPaciente: newForPatient };
  if (window.__AMJ_TEST__) {
    window.AMJProntuario.__test = {
      protocolIntentKey: protocolIntentKey,
      confirmProtocolIntent: confirmProtocolIntent
    };
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind, { once: true });
  else setTimeout(bind, 0);
})();

'use strict';

const CONFIG = Object.freeze({
  API_URL: 'https://rjxtxoqprnumouqakxbc.supabase.co/functions/v1/tcle-bioestimulador-submit',
  PUBLISHABLE_KEY: 'sb_publishable_Ip14p4tUfYFjwUYaWinMlw_Gf9v0YwT',
  TYPE: 'tcle_bioestimulador_colageno',
  TERM_VERSION: '2026-08-18-v1',
  TERM_SHA256: 'cf2c0958cc679441b99849ded246d12ee1b9f7aaa102604a441dda1720a66213',
  RELEASED: true,
  WHATSAPP: '5531995844803',
  MAX_SIGNATURE_BYTES: 500_000
});

const HEALTH_QUESTIONS = Object.freeze([
  'Você tem alguma alergia',
  'Você usa algum medicamento',
  'Você tem alguma doença ou condição clínica',
  'Há infecção ou inflamação na região que poderá ser tratada',
  'Você realizou algum procedimento estético recentemente',
  'Você está gestante ou amamentando',
  'Você já teve alguma reação a produto injetável',
  'Há outra informação de saúde relevante que a profissional deve saber'
]);

const form = document.getElementById('formulario');
const canvas = document.getElementById('assinatura-canvas');
const ctx = canvas.getContext('2d');
const state = {
  startedAt: new Date().toISOString(),
  idempotencyKey: crypto.randomUUID(),
  signed: false,
  signatureMethod: '',
  termText: '',
  termReady: false,
  pdfUrl: '',
  pdfFilename: ''
};

function normalizeNewlines(value) {
  return String(value || '').replace(/\r\n?/g, '\n');
}

async function sha256Hex(value) {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function renderTerm(text) {
  const blocks = normalizeNewlines(text).split(/\n{2,}/).map((item) => item.trim()).filter(Boolean);
  const target = document.getElementById('texto-integral');
  target.innerHTML = blocks.map((block, index) => {
    if (/^\d+\.\s+[A-ZÁÉÍÓÚÃÕÇ]/.test(block)) return '<h3>' + esc(block) + '</h3>';
    if (index === 0) return '<p class="term-title">' + esc(block) + '</p>';
    if (/^Versão do documento:/.test(block) || /^Vigência:/.test(block)) return '<p class="term-version">' + esc(block) + '</p>';
    if (/^ATENÇÃO:/.test(block)) return '<p class="urgent-text">' + esc(block) + '</p>';
    return '<p>' + esc(block).replace(/\n/g, '<br>') + '</p>';
  }).join('');
}

async function loadTerm() {
  const target = document.getElementById('texto-integral');
  try {
    const response = await fetch('termo-v1.txt', { cache: 'no-store' });
    if (!response.ok) throw new Error('Não foi possível carregar o texto do termo.');
    const text = normalizeNewlines(await response.text()).trim();
    const hash = await sha256Hex(text);
    if (hash !== CONFIG.TERM_SHA256) throw new Error('A versão do termo não passou na verificação de integridade.');
    state.termText = text;
    state.termReady = true;
    target.setAttribute('role', 'region');
    renderTerm(text);
  } catch (error) {
    target.setAttribute('role', 'alert');
    target.innerHTML = '<p class="urgent-text">' + esc(error.message) + ' Atualize a página antes de preencher.</p>';
    document.getElementById('enviar').disabled = true;
  }
}

function renderHealthQuestions() {
  const target = document.getElementById('perguntas-saude');
  target.innerHTML = HEALTH_QUESTIONS.map((question, index) => {
    const number = index + 1;
    return '<fieldset class="health-question" data-question="' + number + '">' +
      '<legend class="sr-only">Pergunta ' + number + ': ' + esc(question) + '</legend>' +
      '<div class="health-top"><p><strong>' + number + '.</strong> ' + esc(question) + '</p>' +
      '<div class="radio-row">' +
      '<label><input type="radio" name="saude_' + number + '" value="sim" required><span>Sim</span></label>' +
      '<label><input type="radio" name="saude_' + number + '" value="nao" required><span>Não</span></label>' +
      '<label><input type="radio" name="saude_' + number + '" value="nao_sei" required><span>Não sei</span></label>' +
      '</div></div>' +
      '<label class="field health-detail"><span>Explique esta resposta *</span>' +
      '<textarea name="saude_' + number + '_detalhe" rows="3" minlength="3" maxlength="600" disabled></textarea></label>' +
      '</fieldset>';
  }).join('');

  target.addEventListener('change', (event) => {
    if (!event.target.matches('input[type="radio"]')) return;
    const card = event.target.closest('.health-question');
    const detail = card.querySelector('textarea');
    const requiresReview = event.target.value !== 'nao' && event.target.checked;
    card.classList.toggle('attention', requiresReview);
    detail.disabled = !requiresReview;
    detail.required = requiresReview;
    if (!requiresReview) {
      detail.value = '';
      detail.removeAttribute('aria-invalid');
    }
  });
}

function maskCpf(value) {
  const digits = value.replace(/\D/g, '').slice(0, 11);
  return digits
    .replace(/(\d{3})(\d)/, '$1.$2')
    .replace(/(\d{3})(\d)/, '$1.$2')
    .replace(/(\d{3})(\d{1,2})$/, '$1-$2');
}

function maskPhone(value) {
  const digits = value.replace(/\D/g, '').slice(0, 11);
  if (digits.length <= 10) return digits.replace(/(\d{2})(\d{0,4})(\d{0,4})/, (_, a, b, c) => '(' + a + ')' + (b ? ' ' + b : '') + (c ? '-' + c : ''));
  return digits.replace(/(\d{2})(\d{0,5})(\d{0,4})/, (_, a, b, c) => '(' + a + ')' + (b ? ' ' + b : '') + (c ? '-' + c : ''));
}

function validCpf(value) {
  const cpf = value.replace(/\D/g, '');
  if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false;
  const digit = (base, factor) => {
    let total = 0;
    for (const char of base) total += Number(char) * factor--;
    const result = (total * 10) % 11;
    return result === 10 ? 0 : result;
  };
  return digit(cpf.slice(0, 9), 10) === Number(cpf[9]) && digit(cpf.slice(0, 10), 11) === Number(cpf[10]);
}

function isAdult(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const birth = new Date(year, month - 1, day);
  if (birth.getFullYear() !== year || birth.getMonth() !== month - 1 || birth.getDate() !== day) return false;
  const today = new Date();
  let age = today.getFullYear() - year;
  if (today.getMonth() < month - 1 || (today.getMonth() === month - 1 && today.getDate() < day)) age--;
  return age >= 18 && age < 120;
}

function normalizeName(value) {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function setupInputs() {
  const cpf = form.elements.cpf;
  cpf.addEventListener('input', () => { cpf.value = maskCpf(cpf.value); });
  [form.elements.telefone, form.elements.emergencia_telefone].forEach((input) => {
    input.addEventListener('input', () => { input.value = maskPhone(input.value); });
  });

  const birth = form.elements.nascimento;
  const limit = new Date();
  limit.setFullYear(limit.getFullYear() - 18);
  birth.max = limit.toISOString().slice(0, 10);
  birth.min = '1906-01-01';

  form.addEventListener('input', (event) => {
    if (event.target.matches('input, textarea')) event.target.removeAttribute('aria-invalid');
    document.getElementById('form-status').textContent = '';
  });
}

function setupImagePermissions() {
  const container = document.getElementById('opcoes-divulgacao');
  const radios = [...container.querySelectorAll('input')];

  function update() {
    const allowed = form.elements.divulgacao.value === 'sim';
    container.classList.toggle('enabled', allowed);
    container.setAttribute('aria-disabled', String(!allowed));
    radios.forEach((radio) => {
      radio.disabled = !allowed;
      radio.required = allowed;
    });

    if (!allowed) {
      radios.forEach((radio) => { radio.checked = false; });
    } else {
      [...form.querySelectorAll('input[name="forma_imagem"]')].forEach((radio) => {
        radio.checked = false;
      });
    }
  }

  form.querySelectorAll('input[name="divulgacao"]').forEach((radio) => radio.addEventListener('change', update));
  update();
}

function setupSignature() {
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = '#2c221e';
  ctx.lineWidth = 4;

  let drawing = false;
  let previous = null;

  function clearSignature() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    state.signed = false;
    state.signatureMethod = '';
    const status = document.getElementById('status-assinatura');
    status.textContent = 'Ainda não assinada';
    status.classList.remove('signed');
  }

  function point(event) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) * (canvas.width / rect.width),
      y: (event.clientY - rect.top) * (canvas.height / rect.height)
    };
  }

  canvas.addEventListener('pointerdown', (event) => {
    drawing = true;
    previous = point(event);
    canvas.setPointerCapture(event.pointerId);
    event.preventDefault();
  });

  canvas.addEventListener('pointermove', (event) => {
    if (!drawing) return;
    const current = point(event);
    ctx.beginPath();
    ctx.moveTo(previous.x, previous.y);
    ctx.lineTo(current.x, current.y);
    ctx.stroke();
    previous = current;
    state.signed = true;
    state.signatureMethod = 'desenhada';
    const status = document.getElementById('status-assinatura');
    status.textContent = 'Assinatura registrada';
    status.classList.add('signed');
    event.preventDefault();
  });

  function end(event) {
    if (!drawing) return;
    drawing = false;
    previous = null;
    if (event && canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  }

  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('pointerleave', end);

  document.getElementById('assinar-digitado').addEventListener('click', () => {
    const name = form.elements.assinatura_digitada.value.trim();
    if (name.length < 5 || normalizeName(name) !== normalizeName(form.elements.nome.value)) {
      showError('Digite o mesmo nome completo informado na identificação antes de usar esta assinatura.', form.elements.assinatura_digitada);
      return;
    }
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.fillStyle = '#2c221e';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '26px Arial, sans-serif';
    ctx.fillText('Assinado eletronicamente pelo nome digitado:', canvas.width / 2, 105);
    let fontSize = 54;
    do {
      ctx.font = 'italic ' + fontSize + 'px Georgia, serif';
      fontSize -= 2;
    } while (fontSize > 26 && ctx.measureText(name).width > canvas.width - 90);
    ctx.fillText(name, canvas.width / 2, 185);
    ctx.restore();
    state.signed = true;
    state.signatureMethod = 'nome_digitado';
    const status = document.getElementById('status-assinatura');
    status.textContent = 'Assinatura pelo nome digitado registrada';
    status.classList.add('signed');
  });

  document.getElementById('limpar-assinatura').addEventListener('click', clearSignature);

  [form.elements.nome, form.elements.assinatura_digitada].forEach((input) => {
    input.addEventListener('input', () => {
      if (state.signatureMethod === 'nome_digitado') clearSignature();
    });
  });
}

function showError(message, element) {
  const status = document.getElementById('form-status');
  status.textContent = message;
  if (element) {
    const invalidTarget = element.matches('input[type="radio"], input[type="checkbox"]')
      ? element.closest('fieldset') || element
      : element;
    invalidTarget.setAttribute('aria-invalid', 'true');
    const describedBy = new Set((invalidTarget.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean));
    describedBy.add('form-status');
    invalidTarget.setAttribute('aria-describedby', [...describedBy].join(' '));
    element.focus({ preventScroll: true });
    element.scrollIntoView({ behavior: 'smooth', block: 'center' });
  } else {
    status.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

function validateForm() {
  [...form.querySelectorAll('[aria-invalid="true"]')].forEach((element) => {
    element.removeAttribute('aria-invalid');
    const describedBy = (element.getAttribute('aria-describedby') || '')
      .split(/\s+/).filter((id) => id && id !== 'form-status');
    if (describedBy.length) element.setAttribute('aria-describedby', describedBy.join(' '));
    else element.removeAttribute('aria-describedby');
  });

  if (!CONFIG.RELEASED) return { ok: false, message: 'Este documento ainda não está liberado para receber dados de pacientes.' };
  if (!state.termReady) return { ok: false, message: 'Aguarde o carregamento e a verificação do texto do termo.' };
  if (!form.checkValidity()) {
    const invalid = form.querySelector(':invalid');
    const group = invalid.closest('fieldset');
    const label = group?.querySelector('legend')?.textContent?.trim() ||
      invalid.closest('label')?.querySelector('span')?.textContent?.trim() ||
      invalid.name.replace(/_/g, ' ');
    const message = invalid.validity.valueMissing
      ? 'Preencha ou selecione o campo obrigatório: ' + label + '.'
      : invalid.validity.tooShort
      ? 'Complete o campo “' + label + '” com mais detalhes.'
      : 'Revise o campo “' + label + '” antes de enviar.';
    return { ok: false, message, element: invalid };
  }
  if (!validCpf(form.elements.cpf.value)) return { ok: false, message: 'Informe um CPF válido.', element: form.elements.cpf };
  if (!isAdult(form.elements.nascimento.value)) return { ok: false, message: 'O formulário online está disponível somente para maiores de 18 anos. Fale com a clínica para uma avaliação específica.', element: form.elements.nascimento };

  const phone = form.elements.telefone.value.replace(/\D/g, '');
  const emergencyPhone = form.elements.emergencia_telefone.value.replace(/\D/g, '');
  if (phone.length < 10 || phone.length > 11) return { ok: false, message: 'Informe um WhatsApp válido com DDD.', element: form.elements.telefone };
  if (emergencyPhone.length < 10 || emergencyPhone.length > 11) return { ok: false, message: 'Informe um telefone de emergência válido com DDD.', element: form.elements.emergencia_telefone };

  if (normalizeName(form.elements.nome.value) !== normalizeName(form.elements.assinatura_digitada.value)) {
    return { ok: false, message: 'O nome digitado na confirmação deve ser igual ao nome completo informado.', element: form.elements.assinatura_digitada };
  }
  if (!state.signed) return { ok: false, message: 'Assine antes de enviar: desenhe na área ou use o botão com o nome digitado.', element: document.getElementById('assinar-digitado') };
  if (form.elements.website.value) return { ok: false, message: 'Não foi possível validar o envio. Atualize a página.' };
  if (Date.now() - new Date(state.startedAt).getTime() < 8_000) return { ok: false, message: 'Leia o termo antes de enviar. Aguarde alguns segundos e tente novamente.' };
  return { ok: true };
}

function selected(name) {
  const field = form.elements[name];
  return field ? field.value : '';
}

function collectData(signedAt) {
  const modalities = ['Bioestimulador de colágeno'];

  const health = HEALTH_QUESTIONS.map((question, index) => {
    const number = index + 1;
    return {
      numero: number,
      pergunta: question,
      resposta: selected('saude_' + number),
      detalhe: form.elements['saude_' + number + '_detalhe'].value.trim()
    };
  });

  return {
    identificacao: {
      nome: form.elements.nome.value.trim(),
      nascimento: form.elements.nascimento.value,
      cpf: form.elements.cpf.value,
      telefone: form.elements.telefone.value,
      email: form.elements.email.value.trim(),
      local_assinatura: form.elements.local_assinatura.value.trim(),
      emergencia: {
        nome: form.elements.emergencia_nome.value.trim(),
        relacao: form.elements.emergencia_relacao.value.trim(),
        telefone: form.elements.emergencia_telefone.value
      }
    },
    procedimento: {
      finalidade: 'exclusivamente estética',
      modalidades: modalities,
      regioes: form.elements.regioes.value.trim(),
      objetivo: form.elements.objetivo.value.trim(),
      detalhamento_plano_previsto: form.elements.detalhamento_plano_previsto.value.trim(),
      status_anamnese: selected('status_anamnese')
    },
    confirmacoes_saude: health,
    observacoes_saude: form.elements.observacoes_saude.value.trim(),
    imagem: {
      foto_prontuario: selected('foto_prontuario'),
      divulgacao: selected('divulgacao'),
      antes_depois: selected('divulgacao') === 'sim' ? selected('antes_depois') : 'nao',
      forma_imagem: selected('divulgacao') === 'sim' ? selected('forma_imagem') : 'nao_aplicavel',
      primeiro_nome: selected('divulgacao') === 'sim' ? selected('primeiro_nome') : 'nao',
      depoimento: selected('divulgacao') === 'sim' ? selected('depoimento') : 'nao'
    },
    duvidas: form.elements.duvidas.value.trim(),
    declaracoes: {
      leitura: form.elements.aceite_leitura.checked,
      riscos_especificos: form.elements.aceite_riscos_especificos.checked,
      informacoes_verdadeiras: form.elements.aceite_informacoes.checked,
      decisao_voluntaria: form.elements.aceite_voluntario.checked,
      revisao_profissional: form.elements.aceite_revisao.checked,
      tratamento_dados: form.elements.aceite_dados.checked
    },
    assinatura_digitada: form.elements.assinatura_digitada.value.trim(),
    assinatura_metodo: state.signatureMethod,
    assinado_em_cliente: signedAt,
    fuso_horario: Intl.DateTimeFormat().resolvedOptions().timeZone || '',
    status_profissional: 'aguardando_revisao_profissional',
    registro_material: 'a_preencher_pela_profissional'
  };
}

function formatDateTime(value) {
  return new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'short',
    timeStyle: 'medium',
    timeZone: 'America/Sao_Paulo'
  }).format(new Date(value)) + ' (horário de Brasília)';
}

function safeFilename(value) {
  return normalizeName(value).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 55) || 'paciente';
}

function dataUrlBytes(dataUrl) {
  const base64 = dataUrl.split(',')[1] || '';
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return { base64, bytes };
}

async function submitDocument(payload) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45_000);
  try {
    const response = await fetch(CONFIG.API_URL, {
      method: 'POST',
      headers: {
        apikey: CONFIG.PUBLISHABLE_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    let body = {};
    try { body = await response.json(); } catch (_) { /* mensagem genérica abaixo */ }
    if (!response.ok || !body.ok) throw new Error(body.erro || 'O servidor não confirmou o recebimento.');
    return body;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('O envio demorou mais que o esperado. Verifique sua conexão e tente novamente; o sistema evita duplicidade.');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function safePdfUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !url.hostname.endsWith('.supabase.co')) return '';
    if (!url.pathname.includes('/storage/v1/object/sign/documentos-clinicos/')) return '';
    return url.href;
  } catch (_) {
    return '';
  }
}

async function downloadPdf() {
  if (!state.pdfUrl) return;
  const button = document.getElementById('baixar-pdf');
  const original = button.textContent;
  button.disabled = true;
  button.textContent = 'Preparando download…';
  try {
    const response = await fetch(state.pdfUrl, { cache: 'no-store' });
    if (!response.ok) throw new Error('A cópia temporária expirou. Avise a clínica para receber um novo link.');
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length < 5 || String.fromCharCode(...bytes.slice(0, 5)) !== '%PDF-') throw new Error('A cópia recebida não é um PDF válido.');
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = state.pdfFilename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2_000);
  } catch (error) {
    document.getElementById('copia-status').textContent = error.message;
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

function showSuccess(response, data) {
  form.hidden = true;
  document.getElementById('leitura').hidden = true;
  const success = document.getElementById('sucesso');
  success.hidden = false;
  document.getElementById('codigo-sucesso').textContent = response.codigo;
  document.getElementById('hora-sucesso').textContent = 'Recebido pelo servidor em ' + formatDateTime(response.recebido_em);
  state.pdfUrl = safePdfUrl(response.pdf_url);
  state.pdfFilename = String(response.pdf_nome || '').replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 100) ||
    'Pre-Avaliacao-Bioestimulador-Colageno-' + safeFilename(data.identificacao.nome) + '-' + response.codigo.slice(0, 8) + '.pdf';
  const downloadButton = document.getElementById('baixar-pdf');
  downloadButton.hidden = !state.pdfUrl;
  document.getElementById('copia-status').textContent = state.pdfUrl
    ? 'A cópia abaixo foi gerada e armazenada pelo servidor da clínica.'
    : 'O envio foi recebido, mas o link da cópia não ficou disponível. Avise a clínica pelo botão abaixo.';

  const whatsappText = 'Olá, Ana! Concluí a pré-avaliação do TCLE de bioestimulador de colágeno pelo site. Nome: ' + data.identificacao.nome + '. Código: ' + response.codigo.slice(0, 16) + '.';
  document.getElementById('avisar-whatsapp').href = 'https://wa.me/' + CONFIG.WHATSAPP + '?text=' + encodeURIComponent(whatsappText);
  if (data.procedimento.status_anamnese === 'Já preenchi') document.getElementById('abrir-anamnese').hidden = true;
  success.scrollIntoView({ behavior: 'smooth', block: 'start' });
  document.getElementById('sucesso-titulo').focus({ preventScroll: true });
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!CONFIG.RELEASED) {
    showError('Este documento ainda não está liberado para receber dados de pacientes.');
    return;
  }
  const validation = validateForm();
  if (!validation.ok) {
    showError(validation.message, validation.element);
    return;
  }

  const button = document.getElementById('enviar');
  const original = button.textContent;
  button.disabled = true;
  button.textContent = 'Enviando com segurança…';
  document.getElementById('form-status').textContent = '';

  try {
    const signedAt = new Date().toISOString();
    const data = collectData(signedAt);
    const signatureDataUrl = canvas.toDataURL('image/png');
    const signature = dataUrlBytes(signatureDataUrl);
    if (signature.bytes.byteLength > CONFIG.MAX_SIGNATURE_BYTES) throw new Error('A assinatura ficou maior que o limite permitido. Limpe e assine novamente.');

    const code = await sha256Hex(state.idempotencyKey + '|' + CONFIG.TYPE + '|' + CONFIG.TERM_VERSION + '|' + CONFIG.TERM_SHA256);
    const signatureHash = await sha256Hex(signature.bytes);

    button.textContent = 'Validando e preparando a cópia…';
    const payload = {
      idempotency_key: state.idempotencyKey,
      website: form.elements.website.value,
      started_at: state.startedAt,
      tipo: CONFIG.TYPE,
      versao_termo: CONFIG.TERM_VERSION,
      termo_sha256: CONFIG.TERM_SHA256,
      termo_texto: state.termText,
      codigo_verificacao: code,
      nome: data.identificacao.nome,
      cpf: data.identificacao.cpf,
      telefone: data.identificacao.telefone,
      email: data.identificacao.email,
      assinado_em_cliente: signedAt,
      dispositivo: navigator.userAgent.slice(0, 500),
      assinatura_png_base64: signature.base64,
      assinatura_sha256: signatureHash,
      dados: data
    };

    const response = await submitDocument(payload);
    showSuccess(response, data);
  } catch (error) {
    console.error(error);
    showError(error.message || 'Não foi possível enviar agora. Seus dados permanecem nesta tela; tente novamente.');
  } finally {
    button.disabled = !CONFIG.RELEASED;
    button.textContent = original;
  }
});

document.getElementById('baixar-pdf').addEventListener('click', downloadPdf);

renderHealthQuestions();
setupInputs();
setupImagePermissions();
setupSignature();
loadTerm();
if (!CONFIG.RELEASED) {
  const button = document.getElementById('enviar');
  button.disabled = true;
  button.setAttribute('aria-disabled', 'true');
  document.getElementById('form-status').textContent = 'Documento ainda não liberado para coleta.';
}

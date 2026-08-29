(() => {
  "use strict";

  const CONFIG = Object.freeze({
    API_URL: "https://rjxtxoqprnumouqakxbc.supabase.co/functions/v1/agendamento-submit",
    PUBLISHABLE_KEY: "sb_publishable_Ip14p4tUfYFjwUYaWinMlw_Gf9v0YwT",
    WHATSAPP: "5531995844803",
    TIMEOUT_MS: 20_000,
  });
  const FIRST_VISIT_LABELS = Object.freeze({
    primeira_avaliacao: "É minha primeira avaliação",
    paciente_atual: "Já sou paciente",
  });
  const INTEREST_LABELS = Object.freeze({
    avaliacao_sem_procedimento: "Quero uma avaliação e ainda não sei o procedimento",
    preenchimento_facial: "Preenchimento facial",
    skinbooster: "Skinbooster",
    toxina_botulinica: "Toxina botulínica",
    fios_pdo: "Fios de PDO",
    intradermoterapia_facial: "Intradermoterapia facial",
    intradermoterapia_capilar: "Intradermoterapia capilar",
    peeling: "Peeling",
    microagulhamento_facial: "Microagulhamento facial",
    microagulhamento_capilar: "Microagulhamento capilar",
    harmonizacao_facial: "Harmonização facial",
    aplicacao_intramuscular: "Aplicação intramuscular com prescrição",
    retorno_acompanhamento: "Retorno ou acompanhamento",
  });
  const PERIOD_LABELS = Object.freeze({
    manha: "Manhã",
    tarde: "Tarde",
    noite: "Noite",
    a_combinar: "Posso combinar",
  });

  const clean = (value) => String(value == null ? "" : value).trim();
  const phoneDigits = (value) => clean(value).replace(/\D/g, "").replace(/^55(?=\d{10,11}$)/, "").slice(0, 11);
  const uuid = () => {
    if (window.crypto && typeof window.crypto.randomUUID === "function") return window.crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (character) => {
      const random = window.crypto && typeof window.crypto.getRandomValues === "function"
        ? window.crypto.getRandomValues(new Uint8Array(1))[0] % 16
        : Math.random() * 16 | 0;
      return (character === "x" ? random : (random & 3 | 8)).toString(16);
    });
  };
  const maskPhone = (value) => {
    const digits = phoneDigits(value);
    if (digits.length <= 2) return digits.replace(/^(\d{0,2})/, "($1");
    if (digits.length <= 7) return digits.replace(/^(\d{2})(\d+)/, "($1) $2");
    if (digits.length <= 10) return digits.replace(/^(\d{2})(\d{4})(\d+)/, "($1) $2-$3");
    return digits.replace(/^(\d{2})(\d{5})(\d+)/, "($1) $2-$3");
  };
  const formatDate = (value) => {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(clean(value));
    return match ? `${match[3]}/${match[2]}/${match[1]}` : clean(value);
  };
  const requestPayload = (data, metadata) => ({
    idempotency_key: clean(metadata.idempotencyKey),
    started_at: clean(metadata.startedAt),
    website: clean(data.get("website")),
    nome: clean(data.get("nome")),
    telefone: phoneDigits(data.get("telefone")),
    primeira_visita: clean(data.get("primeira_visita")),
    interesse: clean(data.get("interesse")),
    data_preferida: clean(data.get("data_preferida")),
    periodo: clean(data.get("periodo")),
    consentimento_contato: data.get("consentimento_contato") === "on" ||
      data.get("consentimento_contato") === true,
  });
  const requestSignature = (payload) => JSON.stringify(Object.assign({}, payload, { idempotency_key: null }));
  const buildWhatsAppUrl = (data, protocol) => {
    const objective = clean(data.get("objetivo"));
    const firstVisit = clean(data.get("primeira_visita"));
    const interest = clean(data.get("interesse"));
    const period = clean(data.get("periodo"));
    const lines = [
      "Olá! Enviei uma solicitação pelo site da Ana Maria Jacob Estética.",
      clean(protocol) ? `Código da solicitação: ${clean(protocol)}` : "",
      "",
      `Meu nome: ${clean(data.get("nome"))}`,
      `Meu WhatsApp: ${maskPhone(data.get("telefone"))}`,
      `Atendimento: ${FIRST_VISIT_LABELS[firstVisit] || firstVisit}`,
      `Interesse inicial: ${INTEREST_LABELS[interest] || interest}`,
      `Preferência: ${formatDate(data.get("data_preferida"))} — ${PERIOD_LABELS[period] || period}`,
    ].filter(Boolean);
    if (objective) lines.push(`O que gostaria de conversar: ${objective}`);
    lines.push("", "Entendi que o horário depende da confirmação da clínica.");
    return `https://wa.me/${CONFIG.WHATSAPP}?text=${encodeURIComponent(lines.join("\n"))}`;
  };

  window.AMJAgendamentoSite = Object.freeze({
    __test: Object.freeze({ requestPayload, requestSignature, buildWhatsAppUrl, maskPhone, formatDate, phoneDigits }),
  });

  const form = document.querySelector("#form-agendamento");
  if (!form) return;

  const phone = form.querySelector("#telefone");
  const date = form.querySelector("#data-preferida");
  const status = form.querySelector("#form-status");
  const submit = form.querySelector(".booking-submit");
  const idempotency = form.querySelector("#agendamento-idempotency");
  const startedAt = form.querySelector("#agendamento-started-at");
  const success = document.querySelector("#agendamento-sucesso");
  const successTitle = document.querySelector("#agendamento-sucesso-titulo");
  const protocolNode = document.querySelector("#agendamento-protocolo");
  const whatsapp = document.querySelector("#agendamento-whatsapp");
  const state = { submitting: false, lastSignature: "" };

  idempotency.value = uuid();
  startedAt.value = new Date().toISOString();

  const localToday = new Date();
  localToday.setMinutes(localToday.getMinutes() - localToday.getTimezoneOffset());
  date.min = localToday.toISOString().slice(0, 10);
  const lastAvailableDate = new Date(localToday);
  lastAvailableDate.setDate(lastAvailableDate.getDate() + 180);
  date.max = lastAvailableDate.toISOString().slice(0, 10);

  const setStatus = (message, type) => {
    status.textContent = message || "";
    status.classList.toggle("is-error", type === "error");
    status.classList.toggle("is-progress", type === "progress");
    status.setAttribute("role", type === "error" ? "alert" : "status");
  };
  const setBusy = (busy) => {
    state.submitting = busy;
    form.setAttribute("aria-busy", String(busy));
    submit.disabled = busy;
    submit.textContent = busy ? "Enviando solicitação…" : "Enviar solicitação";
  };
  const safeErrorMessage = (response, body) => {
    if (response.status === 429) return "Muitas tentativas foram feitas. Aguarde alguns minutos e tente novamente.";
    if (response.status >= 500) return "O sistema não confirmou o recebimento. Seus dados continuam aqui; tente novamente.";
    return clean(body && (body.erro || body.error)) || "Confira os campos e tente novamente.";
  };
  const submitRequest = async (payload) => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), CONFIG.TIMEOUT_MS);
    try {
      const response = await fetch(CONFIG.API_URL, {
        method: "POST",
        headers: {
          apikey: CONFIG.PUBLISHABLE_KEY,
          Authorization: `Bearer ${CONFIG.PUBLISHABLE_KEY}`,
          "Content-Type": "application/json",
        },
        cache: "no-store",
        referrerPolicy: "no-referrer",
        signal: controller.signal,
        body: JSON.stringify(payload),
      });
      let body = {};
      try { body = await response.json(); } catch (_) { /* resposta segura abaixo */ }
      if (response.status !== 202 || body.ok === false || body.erro || body.error) {
        throw new Error(safeErrorMessage(response, body));
      }
      return body;
    } catch (error) {
      if (error.name === "AbortError") {
        throw new Error("O envio demorou mais que o esperado. Seus dados continuam aqui; tente novamente.");
      }
      throw error;
    } finally {
      window.clearTimeout(timeout);
    }
  };

  phone.addEventListener("input", () => {
    phone.value = maskPhone(phone.value);
  });

  form.addEventListener("input", (event) => {
    if (event.target.matches("input, select, textarea")) {
      event.target.removeAttribute("aria-invalid");
      setStatus("", "");
    }
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (state.submitting) return;

    const controls = [...form.querySelectorAll("input, select, textarea")];
    controls.forEach((control) => control.removeAttribute("aria-invalid"));

    const digits = phoneDigits(phone.value);
    phone.setCustomValidity(digits.length >= 10 && digits.length <= 11
      ? "" : "Informe um número de WhatsApp com DDD.");

    if (!form.checkValidity()) {
      const invalid = controls.find((control) => !control.validity.valid);
      if (invalid) {
        invalid.setAttribute("aria-invalid", "true");
        invalid.focus();
        setStatus(invalid.validationMessage || "Confira os campos indicados antes de continuar.", "error");
      }
      return;
    }

    const data = new FormData(form);
    let payload = requestPayload(data, {
      idempotencyKey: idempotency.value,
      startedAt: startedAt.value,
    });
    const signature = requestSignature(payload);
    if (state.lastSignature && state.lastSignature !== signature) {
      idempotency.value = uuid();
      payload = requestPayload(data, { idempotencyKey: idempotency.value, startedAt: startedAt.value });
    }
    state.lastSignature = requestSignature(payload);

    setBusy(true);
    setStatus("Registrando sua solicitação com segurança…", "progress");
    try {
      const result = await submitRequest(payload);
      const protocol = clean(result.codigo_solicitacao || result.codigo || result.protocolo);
      whatsapp.href = buildWhatsAppUrl(data, protocol);
      if (protocol) {
        protocolNode.hidden = false;
        protocolNode.textContent = `Código da solicitação: ${protocol}`;
      }
      form.hidden = true;
      success.hidden = false;
      setStatus("", "");
      successTitle.focus({ preventScroll: true });
      success.scrollIntoView({ behavior: "smooth", block: "center" });
    } catch (error) {
      setStatus(error.message || "Não foi possível confirmar o recebimento. Tente novamente.", "error");
    } finally {
      setBusy(false);
    }
  });
})();

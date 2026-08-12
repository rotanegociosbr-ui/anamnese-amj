(() => {
  "use strict";

  const form = document.querySelector("#form-agendamento");
  if (!form) return;

  const phone = form.querySelector("#telefone");
  const date = form.querySelector("#data-preferida");
  const status = form.querySelector("#form-status");
  const whatsappNumber = "5531995844803";

  const localToday = new Date();
  localToday.setMinutes(localToday.getMinutes() - localToday.getTimezoneOffset());
  date.min = localToday.toISOString().slice(0, 10);

  const maskPhone = (value) => {
    const digits = value.replace(/\D/g, "").slice(0, 11);
    if (digits.length <= 2) return digits.replace(/^(\d{0,2})/, "($1");
    if (digits.length <= 7) return digits.replace(/^(\d{2})(\d+)/, "($1) $2");
    if (digits.length <= 10) return digits.replace(/^(\d{2})(\d{4})(\d+)/, "($1) $2-$3");
    return digits.replace(/^(\d{2})(\d{5})(\d+)/, "($1) $2-$3");
  };

  phone.addEventListener("input", () => {
    phone.value = maskPhone(phone.value);
  });

  form.addEventListener("input", (event) => {
    if (event.target.matches("input, select, textarea")) {
      event.target.removeAttribute("aria-invalid");
      status.textContent = "";
    }
  });

  const formatDate = (value) => {
    const [year, month, day] = value.split("-");
    return `${day}/${month}/${year}`;
  };

  form.addEventListener("submit", (event) => {
    event.preventDefault();

    const controls = [...form.querySelectorAll("input, select, textarea")];
    controls.forEach((control) => control.removeAttribute("aria-invalid"));

    const phoneDigits = phone.value.replace(/\D/g, "");
    if (phoneDigits.length < 10 || phoneDigits.length > 11) {
      phone.setCustomValidity("Informe um número de WhatsApp com DDD.");
    } else {
      phone.setCustomValidity("");
    }

    if (!form.checkValidity()) {
      const invalid = controls.find((control) => !control.validity.valid);
      if (invalid) {
        invalid.setAttribute("aria-invalid", "true");
        invalid.focus();
        status.textContent = invalid.validationMessage || "Confira os campos indicados antes de continuar.";
      }
      return;
    }

    const data = new FormData(form);
    const objective = String(data.get("objetivo") || "").trim();
    const lines = [
      "Olá! Vim pelo site da Ana Maria Jacob Estética.",
      "",
      `Meu nome: ${String(data.get("nome")).trim()}`,
      `Meu WhatsApp: ${phone.value}`,
      `Atendimento: ${data.get("primeira_visita")}`,
      `Interesse inicial: ${data.get("interesse")}`,
      `Preferência: ${formatDate(String(data.get("data_preferida")))} — ${data.get("periodo")}`,
    ];

    if (objective) lines.push(`O que gostaria de conversar: ${objective}`);

    lines.push("", "Entendi que o horário depende da confirmação da clínica.");
    const whatsappUrl = `https://wa.me/${whatsappNumber}?text=${encodeURIComponent(lines.join("\n"))}`;

    status.textContent = "Abrindo o WhatsApp com sua mensagem pronta…";
    window.location.href = whatsappUrl;
  });
})();

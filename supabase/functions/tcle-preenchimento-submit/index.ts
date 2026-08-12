import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { PDFDocument, rgb, StandardFonts } from "pdf-lib";
import type { PDFFont, PDFPage } from "pdf-lib";

const TYPE = "tcle_preenchimento_facial";
const TERM_VERSION = "2026-08-11-v1";
const TERM_SHA256 = "b8069d21e1560a4445d424c0f998836e276655dc70ddf095ad557d7f7d3145b0";
const BUCKET = "documentos-clinicos";
const MAX_BODY_BYTES = 1_500_000;
const MAX_PDF_BYTES = 4_000_000;
const MAX_SIGNATURE_BYTES = 500_000;
const MAX_TERM_BYTES = 30_000;
const LOGO_URL = "https://anamariajacob.com.br/assets/identidade-visual-transparente-v1.png";
const LOGO_SHA256 = "6dd5a16fa082b9875882ad795f975eff3a1423fc4198937a1fc4f955584d33ff";
const ALLOWED_ORIGINS = new Set([
  "https://anamariajacob.com.br",
  "https://www.anamariajacob.com.br",
  "http://127.0.0.1:8765",
  "http://localhost:8765",
]);

const URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

type JsonRecord = Record<string, unknown>;

type HealthAnswer = {
  numero: number;
  pergunta: string;
  resposta: "sim" | "nao";
  detalhe: string;
};

type ClinicalData = {
  identificacao: {
    nome: string;
    nascimento: string;
    cpf: string;
    telefone: string;
    email: string;
    local_assinatura: string;
    emergencia: { nome: string; relacao: string; telefone: string };
  };
  procedimento: {
    finalidade: string;
    regioes: string[];
    objetivo: string;
    detalhamento_volume_previsto: string;
    status_anamnese: string;
  };
  confirmacoes_saude: HealthAnswer[];
  observacoes_saude: string;
  imagem: {
    foto_prontuario: "sim" | "nao";
    divulgacao: "sim" | "nao";
    antes_depois: "sim" | "nao";
    forma_imagem: "rosto_inteiro" | "parcial" | "nao_aplicavel";
    primeiro_nome: "sim" | "nao";
    depoimento: "sim" | "nao";
  };
  duvidas: string;
  declaracoes: {
    leitura: true;
    risco_vascular: true;
    ciencia_hialuronidase_urgencia: true;
    informacoes_verdadeiras: true;
    decisao_voluntaria: true;
    revisao_profissional: true;
    tratamento_dados: true;
  };
  assinatura_digitada: string;
  assinatura_metodo: "desenhada" | "nome_digitado";
  assinado_em_cliente: string;
  fuso_horario: string;
  status_profissional: "aguardando_revisao_profissional";
  registro_material: "a_preencher_pela_profissional";
};

const HEALTH_QUESTIONS = Object.freeze([
  "Está grávida, com suspeita de gravidez ou amamentando?",
  "Já aplicou preenchedor permanente, como PMMA, silicone líquido ou bioplastia, em qualquer região do rosto?",
  "Já aplicou preenchedor absorvível anteriormente? Em qual região e há quanto tempo?",
  "Teve alguma reação, nódulo ou complicação em aplicação anterior?",
  "Tem alergia a ácido hialurônico, lidocaína ou anestésicos locais?",
  "Tem alguma doença autoimune ou inflamatória, como lúpus, artrite reumatoide, esclerodermia ou outra?",
  "Apresenta infecção, inflamação, ferida, acne inflamada ou herpes ativo na área a ser tratada?",
  "Tem histórico de herpes labial recorrente?",
  "Usa anticoagulante ou antiagregante, como AAS, varfarina, clopidogrel, rivaroxabana ou semelhante?",
  "Tem distúrbio de coagulação ou sangra com facilidade?",
  "Realizou ou fará procedimento odontológico nas últimas ou nas próximas duas semanas?",
  "Tomou alguma vacina nas últimas duas semanas ou pretende tomar nas próximas duas semanas?",
  "Usa ou usou isotretinoína oral nos últimos seis meses?",
  "Tem doença crônica em tratamento, como diabetes, hipertensão, doença da tireoide, imunossupressão ou outra?",
  "Faz uso contínuo de medicamento, vitamina, fitoterápico ou suplemento?",
  "Tem histórico de queloide ou cicatrização anormal?",
  "Fez laser, peeling ou outro procedimento na região nos últimos 30 dias?",
]);

const ALLOWED_REGIONS = new Set([
  "Lábios",
  "Sulco nasogeniano",
  "Olheiras / região infraorbital",
  "Malar / maçã do rosto",
  "Mento / queixo",
  "Mandíbula / contorno",
  "Têmporas",
  "Sulco labiomentual",
]);

function cors(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") || "";
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.has(origin)
      ? origin
      : "https://anamariajacob.com.br",
    "Access-Control-Allow-Headers": "apikey, authorization, content-type, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

function json(req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...cors(req),
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function fail(req: Request, code: string, message: string, status = 400): Response {
  return json(req, { ok: false, codigo_erro: code, erro: message }, status);
}

async function admin(path: string, init: RequestInit = {}): Promise<Response> {
  return await fetch(URL + path, {
    ...init,
    headers: {
      apikey: SERVICE,
      Authorization: "Bearer " + SERVICE,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
}

async function sha256(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function decodeBase64(value: unknown, maxBytes: number): Uint8Array | null {
  if (typeof value !== "string" || !value || value.length > Math.ceil(maxBytes * 4 / 3) + 16) {
    return null;
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  try {
    const binary = atob(value);
    if (!binary.length || binary.length > maxBytes) return null;
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return null;
  }
}

function isPdf(bytes: Uint8Array): boolean {
  return bytes.length > 5 && String.fromCharCode(...bytes.subarray(0, 5)) === "%PDF-";
}

function isPng(bytes: Uint8Array): boolean {
  const magic = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 24 || !magic.every((byte, index) => bytes[index] === byte)) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  return width > 0 && height > 0 && width <= 2_000 && height <= 1_000;
}

function text(value: unknown, max: number): string {
  return typeof value === "string"
    ? value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim().slice(0, max)
    : "";
}

function digits(value: unknown): string {
  return typeof value === "string" ? value.replace(/\D/g, "") : "";
}

function normalizeName(value: string): string {
  return value.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, " ").trim();
}

function matchesExistingOwner(previous: JsonRecord, payload: JsonRecord): boolean {
  return normalizeName(text(previous.nome, 120)) === normalizeName(text(payload.nome, 120)) &&
    digits(previous.cpf) === digits(payload.cpf) &&
    digits(previous.telefone) === digits(payload.telefone);
}

function normalizeTerm(value: unknown): string {
  if (typeof value !== "string" || value.length > MAX_TERM_BYTES) return "";
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value)) return "";
  return value.replace(/\r\n?/g, "\n");
}

function validCpf(cpf: string): boolean {
  if (!/^\d{11}$/.test(cpf) || /^(\d)\1{10}$/.test(cpf)) return false;
  const calculate = (base: string, factor: number) => {
    let total = 0;
    for (const char of base) total += Number(char) * factor--;
    const result = (total * 10) % 11;
    return result === 10 ? 0 : result;
  };
  return calculate(cpf.slice(0, 9), 10) === Number(cpf[9]) &&
    calculate(cpf.slice(0, 10), 11) === Number(cpf[10]);
}

function isAdult(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const birth = new Date(value + "T12:00:00Z");
  if (
    !Number.isFinite(birth.getTime()) ||
    birth.getUTCFullYear() !== year ||
    birth.getUTCMonth() !== month - 1 ||
    birth.getUTCDate() !== day
  ) return false;
  const now = new Date();
  let age = now.getUTCFullYear() - birth.getUTCFullYear();
  const beforeBirthday = now.getUTCMonth() < birth.getUTCMonth() ||
    (now.getUTCMonth() === birth.getUTCMonth() && now.getUTCDate() < birth.getUTCDate());
  if (beforeBirthday) age--;
  return age >= 18 && age < 120;
}

function validUuid(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function validHash(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function safeData(
  payload: JsonRecord,
  nome: string,
  cpf: string,
  telefone: string,
  email: string,
  signedAt: string,
): ClinicalData | null {
  const raw = payload.dados;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const source = raw as JsonRecord;
  const identification = source.identificacao as JsonRecord | undefined;
  const procedure = source.procedimento as JsonRecord | undefined;
  const health = source.confirmacoes_saude;
  const image = source.imagem as JsonRecord | undefined;
  const declarations = source.declaracoes as JsonRecord | undefined;
  if (!identification || !procedure || !image || !declarations || !Array.isArray(health)) return null;

  const birth = text(identification.nascimento, 10);
  const innerEmail = text(identification.email, 160).toLowerCase();
  const local = text(identification.local_assinatura, 100);
  const emergency = identification.emergencia as JsonRecord | undefined;
  if (!isAdult(birth) || !emergency || local.length < 2 || innerEmail !== email) return null;
  if (
    text(identification.nome, 120) !== nome ||
    digits(identification.cpf) !== cpf ||
    digits(identification.telefone) !== telefone
  ) return null;

  const emergencyName = text(emergency.nome, 120);
  const emergencyRelation = text(emergency.relacao, 60);
  const emergencyPhone = digits(emergency.telefone).slice(0, 11);
  if (emergencyName.length < 2 || emergencyRelation.length < 2 || !/^\d{10,11}$/.test(emergencyPhone)) return null;

  if (!Array.isArray(procedure.regioes) || procedure.regioes.length < 1 || procedure.regioes.length > 10) return null;
  const regions = procedure.regioes.map((item) => text(item, 100));
  const validRegions = regions.every((region) =>
    ALLOWED_REGIONS.has(region) || /^Outra: \S.{1,88}$/.test(region)
  );
  if (!validRegions || new Set(regions).size !== regions.length) return null;

  const objective = text(procedure.objetivo, 600);
  const expectedVolume = text(procedure.detalhamento_volume_previsto, 600);
  const anamnesisStatus = text(procedure.status_anamnese, 40);
  if (
    objective.length < 5 ||
    expectedVolume.length < 3 ||
    !["Já preenchi", "Ainda vou preencher"].includes(anamnesisStatus)
  ) return null;

  if (health.length !== HEALTH_QUESTIONS.length) return null;
  const cleanedHealth: HealthAnswer[] = [];
  for (let index = 0; index < HEALTH_QUESTIONS.length; index++) {
    const item = health[index];
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const row = item as JsonRecord;
    const answer = row.resposta === "sim" ? "sim" : row.resposta === "nao" ? "nao" : "";
    const detail = text(row.detalhe, 600);
    if (
      Number(row.numero) !== index + 1 ||
      text(row.pergunta, 300) !== HEALTH_QUESTIONS[index] ||
      !answer ||
      (answer === "sim" && detail.length < 3)
    ) return null;
    cleanedHealth.push({
      numero: index + 1,
      pergunta: HEALTH_QUESTIONS[index],
      resposta: answer,
      detalhe: answer === "sim" ? detail : "",
    });
  }

  if (![
    declarations.leitura,
    declarations.risco_vascular,
    declarations.ciencia_hialuronidase_urgencia,
    declarations.informacoes_verdadeiras,
    declarations.decisao_voluntaria,
    declarations.revisao_profissional,
    declarations.tratamento_dados,
  ].every((value) => value === true)) return null;

  const yesNoStrict = (value: unknown): "sim" | "nao" | null =>
    value === "sim" ? "sim" : value === "nao" ? "nao" : null;
  const photo = yesNoStrict(image.foto_prontuario);
  const disclosure = yesNoStrict(image.divulgacao);
  const beforeAfter = yesNoStrict(image.antes_depois);
  const firstName = yesNoStrict(image.primeiro_nome);
  const testimonial = yesNoStrict(image.depoimento);
  const display = String(image.forma_imagem || "");
  if (!photo || !disclosure || !beforeAfter || !firstName || !testimonial) return null;
  if (disclosure === "nao") {
    if (beforeAfter !== "nao" || firstName !== "nao" || testimonial !== "nao" || display !== "nao_aplicavel") return null;
  } else if (!["rosto_inteiro", "parcial"].includes(display)) {
    return null;
  }

  const typedSignature = text(source.assinatura_digitada, 120);
  const signatureMethod = source.assinatura_metodo === "desenhada"
    ? "desenhada"
    : source.assinatura_metodo === "nome_digitado"
    ? "nome_digitado"
    : "";
  const clientSignedAt = text(source.assinado_em_cliente, 40);
  const timezone = text(source.fuso_horario, 80);
  if (
    typedSignature.length < 5 ||
    normalizeName(typedSignature) !== normalizeName(nome) ||
    !signatureMethod ||
    clientSignedAt !== signedAt ||
    timezone.length < 2
  ) return null;

  return {
    identificacao: {
      nome,
      nascimento: birth,
      cpf,
      telefone,
      email,
      local_assinatura: local,
      emergencia: {
        nome: emergencyName,
        relacao: emergencyRelation,
        telefone: emergencyPhone,
      },
    },
    procedimento: {
      finalidade: "exclusivamente estética",
      regioes: regions,
      objetivo: objective,
      detalhamento_volume_previsto: expectedVolume,
      status_anamnese: anamnesisStatus,
    },
    confirmacoes_saude: cleanedHealth,
    observacoes_saude: text(source.observacoes_saude, 1200),
    imagem: {
      foto_prontuario: photo,
      divulgacao: disclosure,
      antes_depois: disclosure === "sim" ? beforeAfter : "nao",
      forma_imagem: disclosure === "sim"
        ? display as "rosto_inteiro" | "parcial"
        : "nao_aplicavel",
      primeiro_nome: disclosure === "sim" ? firstName : "nao",
      depoimento: disclosure === "sim" ? testimonial : "nao",
    },
    duvidas: text(source.duvidas, 1200),
    declaracoes: {
      leitura: true,
      risco_vascular: true,
      ciencia_hialuronidase_urgencia: true,
      informacoes_verdadeiras: true,
      decisao_voluntaria: true,
      revisao_profissional: true,
      tratamento_dados: true,
    },
    assinatura_digitada: typedSignature,
    assinatura_metodo: signatureMethod,
    assinado_em_cliente: clientSignedAt,
    fuso_horario: timezone,
    status_profissional: "aguardando_revisao_profissional",
    registro_material: "a_preencher_pela_profissional",
  };
}

let officialLogoPromise: Promise<Uint8Array> | null = null;

async function officialLogo(): Promise<Uint8Array> {
  if (!officialLogoPromise) {
    officialLogoPromise = (async () => {
      const response = await fetch(LOGO_URL, { cache: "force-cache" });
      if (!response.ok) throw new Error("official_logo_unavailable_" + response.status);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > 500_000 || !isPng(bytes) || await sha256(bytes) !== LOGO_SHA256) {
        throw new Error("official_logo_integrity_failed");
      }
      return bytes;
    })().catch((error) => {
      officialLogoPromise = null;
      throw error;
    });
  }
  return await officialLogoPromise;
}

function formatServerDate(value: string): string {
  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "medium",
    timeZone: "America/Sao_Paulo",
  }).format(new Date(value)) + " (horário de Brasília)";
}

async function buildCanonicalPdf(
  data: ClinicalData,
  signatureBytes: Uint8Array,
  code: string,
  receivedAt: string,
  termText: string,
): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle("TCLE - Preenchimento Facial com Ácido Hialurônico - " + data.identificacao.nome);
  pdf.setSubject("Manifestação eletrônica do paciente - aguardando revisão profissional");
  pdf.setAuthor("Ana Maria Costa Jacob Estética");
  pdf.setCreator("anamariajacob.com.br - geração canônica no servidor");
  pdf.setCreationDate(new Date(receivedAt));
  pdf.setModificationDate(new Date(receivedAt));

  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const italic = await pdf.embedFont(StandardFonts.HelveticaOblique);
  const logo = await pdf.embedPng(await officialLogo());
  const signature = data.assinatura_metodo === "desenhada"
    ? await pdf.embedPng(signatureBytes)
    : null;
  const supported = new Set(regular.getCharacterSet());
  const pageWidth = 595.28;
  const pageHeight = 841.89;
  const margin = 52;
  const contentWidth = pageWidth - margin * 2;
  const bottom = 55;
  const colorText = rgb(55 / 255, 45 / 255, 40 / 255);
  const colorMuted = rgb(112 / 255, 102 / 255, 96 / 255);
  const colorGold = rgb(134 / 255, 96 / 255, 31 / 255);
  const colorRed = rgb(158 / 255, 59 / 255, 55 / 255);
  const colorLine = rgb(219 / 255, 195 / 255, 154 / 255);

  let page: PDFPage = pdf.addPage([pageWidth, pageHeight]);
  let y = pageHeight - 52;

  const pdfText = (value: unknown): string => Array.from(String(value == null ? "" : value))
    .map((character) => supported.has(character.codePointAt(0) || 0) ? character : "?")
    .join("");

  const newPage = (): void => {
    page = pdf.addPage([pageWidth, pageHeight]);
    y = pageHeight - 52;
  };

  const ensure = (height: number): void => {
    if (y - height >= bottom) return;
    newPage();
  };

  const wrap = (value: unknown, font: PDFFont, size: number, width: number): string[] => {
    const output: string[] = [];
    for (const rawParagraph of pdfText(value).replace(/\r\n?/g, "\n").split("\n")) {
      const words = rawParagraph.trim().split(/\s+/).filter(Boolean);
      if (!words.length) {
        output.push("");
        continue;
      }
      let line = "";
      for (const word of words) {
        const candidate = line ? line + " " + word : word;
        if (font.widthOfTextAtSize(candidate, size) <= width) {
          line = candidate;
          continue;
        }
        if (line) output.push(line);
        if (font.widthOfTextAtSize(word, size) <= width) {
          line = word;
          continue;
        }
        let fragment = "";
        for (const character of Array.from(word)) {
          const candidateFragment = fragment + character;
          if (fragment && font.widthOfTextAtSize(candidateFragment, size) > width) {
            output.push(fragment);
            fragment = character;
          } else {
            fragment = candidateFragment;
          }
        }
        line = fragment;
      }
      if (line) output.push(line);
    }
    return output;
  };

  const textBlock = (
    value: unknown,
    options: {
      font?: PDFFont;
      size?: number;
      lineHeight?: number;
      after?: number;
      color?: ReturnType<typeof rgb>;
      align?: "left" | "center";
      width?: number;
    } = {},
  ): void => {
    const font = options.font || regular;
    const size = options.size || 9.2;
    const lineHeight = options.lineHeight || 12.5;
    const after = options.after == null ? 8 : options.after;
    const width = options.width || contentWidth;
    const lines = wrap(value, font, size, width);
    ensure(Math.max(lineHeight, lines.length * lineHeight) + after);
    for (const line of lines) {
      if (y - lineHeight < bottom) newPage();
      if (line) {
        const x = options.align === "center"
          ? (pageWidth - font.widthOfTextAtSize(line, size)) / 2
          : margin;
        page.drawText(line, { x, y, size, font, color: options.color || colorText });
      }
      y -= lineHeight;
    }
    y -= after;
  };

  const heading = (value: string): void => {
    ensure(38);
    page.drawLine({
      start: { x: margin, y: y + 3 },
      end: { x: pageWidth - margin, y: y + 3 },
      thickness: 0.7,
      color: colorLine,
    });
    y -= 10;
    textBlock(value, { font: bold, size: 11, lineHeight: 14, after: 8, color: colorGold });
  };

  const logoSize = logo.scaleToFit(185, 105);
  page.drawImage(logo, {
    x: (pageWidth - logoSize.width) / 2,
    y: y - logoSize.height,
    width: logoSize.width,
    height: logoSize.height,
  });
  y -= logoSize.height + 15;
  textBlock("TERMO DE CONSENTIMENTO LIVRE E ESCLARECIDO", {
    font: bold, size: 14, lineHeight: 18, after: 3, color: colorGold, align: "center",
  });
  textBlock("PREENCHIMENTO FACIAL COM ÁCIDO HIALURÔNICO", {
    font: bold, size: 11, lineHeight: 15, after: 4, align: "center",
  });
  textBlock("Versão " + TERM_VERSION + " · Código " + code, {
    size: 7.7, lineHeight: 10, after: 12, color: colorMuted, align: "center",
  });
  textBlock("CÓPIA DO ENVIO DO PACIENTE — AGUARDANDO REVISÃO E ASSINATURA PROFISSIONAL", {
    font: bold, size: 8.2, lineHeight: 11, after: 14, color: colorRed, align: "center",
  });

  const termBlocks = termText.split(/\n{2,}/).map((item) => item.trim()).filter(Boolean);
  for (let index = 1; index < termBlocks.length; index++) {
    const block = termBlocks[index];
    if (/^\d+\.\s+[A-ZÁÉÍÓÚÃÕÇ]/.test(block)) {
      heading(block);
    } else if (/^ATENÇÃO:/.test(block)) {
      textBlock(block.replace(/\n/g, " "), {
        font: bold, size: 8.8, lineHeight: 12, after: 11, color: colorRed,
      });
    } else {
      textBlock(block.replace(/\n/g, " "), { size: 8.8, lineHeight: 12, after: 8 });
    }
  }

  newPage();
  textBlock("SEÇÃO INDIVIDUAL DO PACIENTE", {
    font: bold, size: 14, lineHeight: 18, after: 7, color: colorGold,
  });
  textBlock(
    "Documento gerado no servidor e vinculado ao termo " + TERM_VERSION +
      " (SHA-256 " + TERM_SHA256 + "). Recebido em " + formatServerDate(receivedAt) + ".",
    { size: 7.7, lineHeight: 10.5, after: 10, color: colorMuted },
  );

  heading("IDENTIFICAÇÃO");
  textBlock("Nome: " + data.identificacao.nome);
  textBlock("Data de nascimento: " + data.identificacao.nascimento + "   ·   CPF: " + data.identificacao.cpf);
  textBlock("Telefone: " + data.identificacao.telefone + (data.identificacao.email ? "   ·   E-mail: " + data.identificacao.email : ""));
  textBlock(
    "Contato de emergência: " + data.identificacao.emergencia.nome + " (" +
      data.identificacao.emergencia.relacao + ") · " + data.identificacao.emergencia.telefone,
  );
  textBlock(
    "Local: " + data.identificacao.local_assinatura + "   ·   Assinado no dispositivo em: " +
      formatServerDate(data.assinado_em_cliente),
  );

  heading("PROCEDIMENTO PRETENDIDO");
  textBlock("Finalidade: exclusivamente estética.");
  textBlock("Regiões de interesse: " + data.procedimento.regioes.join("; "));
  textBlock("Objetivo informado: " + data.procedimento.objetivo);
  textBlock("Detalhes e volume inicialmente esperado pela paciente: " + data.procedimento.detalhamento_volume_previsto);
  textBlock("Anamnese geral: " + data.procedimento.status_anamnese + ".");
  textBlock("A definição final de produto, volume, plano, pontos e regiões depende de avaliação profissional e das indicações de uso do produto registrado.", { font: bold });

  heading("CONFIRMAÇÃO DE SEGURANÇA ESPECÍFICA");
  for (const item of data.confirmacoes_saude) {
    const affirmative = item.resposta === "sim";
    textBlock(
      item.numero + ". " + item.pergunta + " — " + (affirmative ? "SIM" : "NÃO") +
        (item.detalhe ? " · Detalhe: " + item.detalhe : ""),
      { font: affirmative ? bold : regular, color: affirmative ? colorRed : colorText, after: 5 },
    );
  }
  if (data.observacoes_saude) textBlock("Outras informações: " + data.observacoes_saude, { font: bold });

  heading("AUTORIZAÇÕES DE IMAGEM");
  textBlock("Fotografia para prontuário interno: " + (data.imagem.foto_prontuario === "sim" ? "AUTORIZADA" : "NÃO AUTORIZADA"));
  textBlock("Divulgação em redes sociais/materiais: " + (data.imagem.divulgacao === "sim" ? "AUTORIZADA" : "NÃO AUTORIZADA"));
  textBlock("Antes e depois: " + (data.imagem.antes_depois === "sim" ? "AUTORIZADO" : "NÃO AUTORIZADO"));
  textBlock("Forma de exibição: " + data.imagem.forma_imagem.replace(/_/g, " ") + ".");
  textBlock("Uso do primeiro nome: " + (data.imagem.primeiro_nome === "sim" ? "AUTORIZADO" : "NÃO AUTORIZADO"));
  textBlock("Depoimento: " + (data.imagem.depoimento === "sim" ? "AUTORIZADO" : "NÃO AUTORIZADO"));
  textBlock("As autorizações opcionais podem ser revogadas para o futuro pelo contato da clínica.", { size: 8.2, color: colorMuted });

  heading("DÚVIDAS REGISTRADAS");
  textBlock(data.duvidas || "Nenhuma dúvida foi registrada neste envio.");

  heading("DECLARAÇÕES E MANIFESTAÇÃO");
  textBlock("[CONFIRMADO] Leu integralmente e compreendeu finalidade, limitações, alternativas, riscos e sinais de urgência.");
  textBlock("[CONFIRMADO] Compreendeu especificamente o risco vascular, inclusive necrose, cicatriz, perda visual e evento neurológico.");
  textBlock("[CONFIRMADO] Compreendeu que uma complicação pode exigir avaliação imediata, encaminhamento e hialuronidase quando clinicamente indicada.");
  textBlock("[CONFIRMADO] Declarou que as informações são verdadeiras e que comunicará alterações antes da aplicação.");
  textBlock("[CONFIRMADO] Declarou decisão livre e ciência do direito de recusar ou desistir antes do procedimento.");
  textBlock("[CONFIRMADO] Compreendeu que o documento aguarda revisão e assinatura profissional.");
  textBlock("[CONFIRMADO] Está ciente do tratamento de dados para as finalidades clínicas e legais descritas.");

  ensure(145);
  textBlock("Nome digitado como confirmação: " + data.assinatura_digitada, { font: bold, after: 5 });
  if (signature) {
    const signatureSize = signature.scaleToFit(235, 78);
    page.drawImage(signature, {
      x: margin,
      y: y - signatureSize.height,
      width: signatureSize.width,
      height: signatureSize.height,
    });
    y -= signatureSize.height + 4;
  } else {
    const typedName = pdfText(data.assinatura_digitada);
    let typedSize = 18;
    while (typedSize > 11 && italic.widthOfTextAtSize(typedName, typedSize) > 225) typedSize--;
    const typedWidth = italic.widthOfTextAtSize(typedName, typedSize);
    page.drawText(typedName, {
      x: margin + Math.max(0, (235 - typedWidth) / 2),
      y: y - 30,
      size: typedSize,
      font: italic,
      color: colorText,
    });
    y -= 46;
  }
  page.drawLine({
    start: { x: margin, y }, end: { x: margin + 235, y }, thickness: 0.7, color: colorLine,
  });
  y -= 12;
  textBlock(
    data.assinatura_metodo === "nome_digitado"
      ? "Manifestação registrada pelo nome digitado (alternativa acessível)"
      : "Assinatura desenhada pelo paciente",
    { size: 7.6, color: colorMuted, after: 6 },
  );

  newPage();
  ensure(610);
  heading("REGISTRO E ASSINATURA PROFISSIONAL");
  textBlock(
    "Área exclusiva da profissional. Esta cópia permanece aguardando revisão, esclarecimento das dúvidas e assinatura antes do procedimento.",
    { size: 8.7, lineHeight: 12, after: 14 },
  );
  textBlock("STATUS: AGUARDANDO REVISÃO PROFISSIONAL", { font: bold, color: colorRed, after: 14 });
  textBlock("Data e hora da revisão: ___________________________________________________________", { after: 13 });
  textBlock("Produto/marca: __________________________________________________________________", { after: 13 });
  textBlock("Fabricante/importador: ____________________________________________________________", { after: 13 });
  textBlock("Lote: __________________  Validade: __________  Registro Anvisa: __________________", { after: 13 });
  textBlock("Registro consultado em: __________  Etiqueta/cartão de rastreabilidade: ___________", { after: 13 });
  textBlock("Região e plano anatômico: _________________________________________________________", { after: 13 });
  textBlock("Volume aplicado: __________ mL   Agulha/cânula: ___________________________________", { after: 13 });
  textBlock("Hialuronidase (se utilizada) — marca/lote/validade/volume: _________________________", { after: 13 });
  textBlock("________________________________________________________________________________", { after: 13 });
  textBlock("Dúvidas esclarecidas e orientação individual: ____________________________________", { after: 13 });
  textBlock("________________________________________________________________________________", { after: 13 });
  textBlock("Intercorrências/observações: _____________________________________________________", { after: 13 });
  textBlock("________________________________________________________________________________", { after: 18 });
  textBlock("Via/cartão de rastreabilidade entregue ao paciente:  [  ] Sim  [  ] Não", { after: 18 });
  textBlock("Ana Maria Costa Jacob · Farmacêutica · CRF/MG 40880", { font: bold, after: 22 });
  textBlock("Assinatura profissional: _________________________________________________________", { after: 5 });

  const pages = pdf.getPages();
  for (let index = 0; index < pages.length; index++) {
    const current = pages[index];
    current.drawLine({
      start: { x: margin, y: 36 }, end: { x: pageWidth - margin, y: 36 },
      thickness: 0.5, color: rgb(232 / 255, 220 / 255, 205 / 255),
    });
    current.drawText(pdfText("Ana Maria Jacob Estética · " + TERM_VERSION + " · " + code.slice(0, 16)), {
      x: margin, y: 22, size: 6.8, font: regular, color: colorMuted,
    });
    const label = "Página " + (index + 1) + " de " + pages.length;
    current.drawText(label, {
      x: pageWidth - margin - regular.widthOfTextAtSize(label, 6.8),
      y: 22, size: 6.8, font: regular, color: colorMuted,
    });
  }

  return await pdf.save({ useObjectStreams: true });
}

async function signedPdfUrl(path: string): Promise<string | null> {
  const response = await admin("/storage/v1/object/sign/" + BUCKET, {
    method: "POST",
    body: JSON.stringify({ expiresIn: 7_200, paths: [path] }),
  });
  if (!response.ok) return null;
  const items = await response.json();
  const signed = Array.isArray(items) ? items[0]?.signedURL : null;
  return typeof signed === "string" ? URL + "/storage/v1" + signed : null;
}

async function existing(idempotencyKey: string): Promise<JsonRecord | null> {
  const response = await admin(
    "/rest/v1/documentos_clinicos?select=id,tipo,versao_termo,nome,cpf,telefone,status,codigo_verificacao,recebido_em,updated_at,pdf_path,assinatura_path&idempotency_key=eq." +
      encodeURIComponent(idempotencyKey) + "&limit=1",
  );
  if (!response.ok) throw new Error("idempotency_lookup_failed");
  const rows = await response.json();
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

async function upload(path: string, bytes: Uint8Array, contentType: string): Promise<void> {
  const response = await fetch(URL + "/storage/v1/object/" + BUCKET + "/" + path, {
    method: "POST",
    headers: {
      apikey: SERVICE,
      Authorization: "Bearer " + SERVICE,
      "Content-Type": contentType,
      "x-upsert": "false",
    },
    body: bytes,
  });
  if (!response.ok) throw new Error("storage_upload_failed_" + response.status);
}

async function cleanup(paths: string[]): Promise<boolean> {
  try {
    const response = await admin("/storage/v1/object/" + BUCKET, {
      method: "DELETE",
      body: JSON.stringify({ prefixes: paths }),
    });
    return response.ok;
  } catch {
    // A linha permanece como erro e o log permite limpeza posterior.
    return false;
  }
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin") || "";
  if (req.method === "OPTIONS") {
    if (origin && !ALLOWED_ORIGINS.has(origin)) return new Response(null, { status: 403 });
    return new Response(null, { status: 204, headers: cors(req) });
  }
  if (req.method !== "POST") return fail(req, "method_not_allowed", "Método não permitido.", 405);
  if (origin && !ALLOWED_ORIGINS.has(origin)) return fail(req, "origin_not_allowed", "Origem não permitida.", 403);
  if (!(req.headers.get("content-type") || "").toLowerCase().startsWith("application/json")) {
    return fail(req, "invalid_content_type", "Formato de envio inválido.", 415);
  }
  const length = Number(req.headers.get("content-length") || "0");
  if (length > MAX_BODY_BYTES) return fail(req, "payload_too_large", "O documento excedeu o limite permitido.", 413);

  let payload: JsonRecord;
  try {
    const body = new Uint8Array(await req.arrayBuffer());
    if (body.byteLength > MAX_BODY_BYTES) {
      return fail(req, "payload_too_large", "O documento excedeu o limite permitido.", 413);
    }
    const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid_payload");
    payload = parsed as JsonRecord;
  } catch {
    return fail(req, "invalid_json", "Não foi possível ler o envio.");
  }

  if (text(payload.website, 100)) return fail(req, "invalid_submission", "Não foi possível validar o envio.");
  if (!validUuid(payload.idempotency_key)) return fail(req, "invalid_idempotency", "Atualize a página e tente novamente.");
  const idempotencyKey = payload.idempotency_key;

  let recovery: JsonRecord | null = null;
  try {
    const previous = await existing(idempotencyKey);
    if (previous && (previous.tipo !== TYPE || previous.versao_termo !== TERM_VERSION)) {
      return fail(req, "invalid_idempotency", "Atualize a página e tente novamente.", 409);
    }
    if (previous && !matchesExistingOwner(previous, payload)) {
      return fail(req, "invalid_idempotency", "Atualize a página e tente novamente.", 409);
    }
    if (previous?.status === "recebido") {
      const pdfPath = text(previous.pdf_path, 500);
      return json(req, {
        ok: true,
        id: previous.id,
        codigo: previous.codigo_verificacao,
        recebido_em: previous.recebido_em,
        pdf_url: pdfPath ? await signedPdfUrl(pdfPath) : null,
        pdf_nome: "TCLE-Preenchimento-Facial-" + text(previous.codigo_verificacao, 8) + ".pdf",
        idempotente: true,
      });
    }
    if (previous?.status === "processando") {
      const updatedAt = Date.parse(text(previous.updated_at, 40));
      if (Number.isFinite(updatedAt) && Date.now() - updatedAt < 2 * 60_000) {
        return fail(req, "already_processing", "Este envio ainda está sendo processado. Aguarde alguns segundos e tente novamente.", 409);
      }
      recovery = previous;
    } else if (previous?.status === "erro") {
      recovery = previous;
    }
  } catch (error) {
    console.error("TCLE idempotency lookup", error);
    return fail(req, "temporary_error", "O serviço está temporariamente indisponível. Tente novamente.", 503);
  }

  if (payload.tipo !== TYPE || payload.versao_termo !== TERM_VERSION || payload.termo_sha256 !== TERM_SHA256) {
    return fail(req, "term_version_mismatch", "A versão do termo mudou. Atualize a página e leia novamente.", 409);
  }
  const termText = normalizeTerm(payload.termo_texto);
  if (!termText || await sha256(termText) !== TERM_SHA256) {
    return fail(req, "term_integrity_failed", "O texto integral do termo não pôde ser validado. Atualize a página.", 409);
  }

  const startedAt = Date.parse(text(payload.started_at, 40));
  const signedAt = Date.parse(text(payload.assinado_em_cliente, 40));
  const now = Date.now();
  if (!Number.isFinite(startedAt) || !Number.isFinite(signedAt) || now - startedAt < 5_000 || now - startedAt > 86_400_000 || signedAt > now + 300_000 || now - signedAt > 86_400_000) {
    return fail(req, "invalid_timestamps", "A data do envio não pôde ser validada. Atualize a página.");
  }

  const nome = text(payload.nome, 120);
  const cpf = digits(payload.cpf);
  const telefone = digits(payload.telefone);
  const email = text(payload.email, 160).toLowerCase();
  if (nome.length < 5 || !validCpf(cpf) || !/^\d{10,11}$/.test(telefone) || (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
    return fail(req, "invalid_identity", "Revise os dados de identificação e tente novamente.");
  }

  const signedAtIso = new Date(signedAt).toISOString();
  const data = safeData(payload, nome, cpf, telefone, email, signedAtIso);
  if (!data) return fail(req, "invalid_answers", "Revise as respostas obrigatórias e tente novamente.");

  const signature = decodeBase64(payload.assinatura_png_base64, MAX_SIGNATURE_BYTES);
  if (!signature || !isPng(signature)) return fail(req, "invalid_signature", "A assinatura não pôde ser validada.");

  const signatureHash = await sha256(signature);
  if (!validHash(payload.assinatura_sha256) || payload.assinatura_sha256 !== signatureHash) {
    return fail(req, "hash_mismatch", "A integridade da assinatura não pôde ser confirmada.");
  }

  const expectedCode = await sha256(idempotencyKey + "|" + TYPE + "|" + TERM_VERSION + "|" + TERM_SHA256);
  if (!validHash(payload.codigo_verificacao) || payload.codigo_verificacao !== expectedCode) {
    return fail(req, "invalid_code", "O código do documento não pôde ser validado.");
  }

  const ip = req.headers.get("cf-connecting-ip") || req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const originHash = await sha256(ip + "|" + SERVICE.slice(-24));
  const since = new Date(now - 15 * 60_000).toISOString();
  try {
    const rate = await admin(
      "/rest/v1/documentos_clinicos?select=id&origem_hash=eq." + originHash +
        "&status=eq.recebido&recebido_em=gte." + encodeURIComponent(since) + "&limit=6",
    );
    if (rate.ok) {
      const rows = await rate.json();
      if (Array.isArray(rows) && rows.length >= 5) {
        return fail(req, "rate_limited", "Muitos envios foram feitos desta conexão. Aguarde 15 minutos e tente novamente.", 429);
      }
    }
  } catch {
    // A validação principal continua; falha do limitador é registrada pela plataforma.
  }

  const signaturePath = "tcle-preenchimento/" + idempotencyKey + "/assinatura.png";
  const pdfPath = "tcle-preenchimento/" + idempotencyKey + "/documento.pdf";
  const serverReceivedAt = new Date().toISOString();
  let pdf: Uint8Array;
  try {
    pdf = await buildCanonicalPdf(data, signature, expectedCode, serverReceivedAt, termText);
  } catch (error) {
    console.error("TCLE canonical PDF generation failed", String(error));
    return fail(req, "pdf_generation_failed", "Não foi possível preparar a cópia digital agora. Tente novamente.", 503);
  }
  if (!pdf.byteLength || pdf.byteLength > MAX_PDF_BYTES || !isPdf(pdf)) {
    return fail(req, "pdf_generation_failed", "A cópia digital não pôde ser validada. Tente novamente.", 503);
  }
  const pdfHash = await sha256(pdf);
  const canonical = JSON.stringify({
    idempotency_key: idempotencyKey,
    tipo: TYPE,
    versao_termo: TERM_VERSION,
    termo_sha256: TERM_SHA256,
    nome,
    cpf,
    telefone,
    email,
    assinado_em_cliente: signedAtIso,
    recebido_em: serverReceivedAt,
    assinatura_sha256: signatureHash,
    pdf_sha256: pdfHash,
    codigo_verificacao: expectedCode,
    dados: data,
  });
  const recordHash = await sha256(canonical);

  const row = {
    idempotency_key: idempotencyKey,
    tipo: TYPE,
    versao_termo: TERM_VERSION,
    termo_sha256: TERM_SHA256,
    nome,
    cpf,
    telefone,
    email: email || null,
    assinado_em_cliente: signedAtIso,
    recebido_em: serverReceivedAt,
    dispositivo: text(payload.dispositivo, 500),
    origem_hash: originHash,
    assinatura_path: signaturePath,
    assinatura_sha256: signatureHash,
    pdf_path: pdfPath,
    pdf_sha256: pdfHash,
    registro_sha256: recordHash,
    codigo_verificacao: expectedCode,
    dados: data,
    status: "processando",
    updated_at: serverReceivedAt,
  };

  let recordId = recovery ? text(recovery.id, 80) : "";
  try {
    if (recovery) {
      const oldSignaturePath = text(recovery.assinatura_path, 500) || signaturePath;
      const oldPdfPath = text(recovery.pdf_path, 500) || pdfPath;
      const recoveryStatus = text(recovery.status, 20);
      const recoveryUpdatedAt = text(recovery.updated_at, 40);
      if (!recoveryStatus || !recoveryUpdatedAt) throw new Error("recovery_state_missing");
      const recovered = await admin(
        "/rest/v1/documentos_clinicos?id=eq." + encodeURIComponent(recordId) +
          "&status=eq." + encodeURIComponent(recoveryStatus) +
          "&updated_at=eq." + encodeURIComponent(recoveryUpdatedAt), {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify(row),
      });
      if (!recovered.ok) throw new Error("database_recovery_failed_" + recovered.status);
      const records = await recovered.json();
      if (!Array.isArray(records) || !records.length) {
        return fail(req, "already_processing", "Este envio foi retomado em outra solicitação. Aguarde alguns segundos e tente novamente.", 409);
      }
      recordId = records[0]?.id || recordId;
      if (!await cleanup([oldSignaturePath, oldPdfPath])) {
        throw new Error("recovery_cleanup_failed");
      }
    } else {
      const inserted = await admin("/rest/v1/documentos_clinicos", {
        method: "POST",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify(row),
      });
      if (!inserted.ok) {
        if (inserted.status === 409) {
          const previous = await existing(idempotencyKey);
          if (previous && (previous.tipo !== TYPE || previous.versao_termo !== TERM_VERSION)) {
            return fail(req, "invalid_idempotency", "Atualize a página e tente novamente.", 409);
          }
          if (previous && !matchesExistingOwner(previous, payload)) {
            return fail(req, "invalid_idempotency", "Atualize a página e tente novamente.", 409);
          }
          if (previous?.status === "recebido") {
            const previousPdfPath = text(previous.pdf_path, 500);
            return json(req, {
              ok: true,
              id: previous.id,
              codigo: previous.codigo_verificacao,
              recebido_em: previous.recebido_em,
              pdf_url: previousPdfPath ? await signedPdfUrl(previousPdfPath) : null,
              pdf_nome: "TCLE-Preenchimento-Facial-" + text(previous.codigo_verificacao, 8) + ".pdf",
              idempotente: true,
            });
          }
          if (previous?.status === "processando") {
            return fail(req, "already_processing", "Este envio ainda está sendo processado. Aguarde alguns segundos e tente novamente.", 409);
          }
        }
        throw new Error("database_insert_failed_" + inserted.status);
      }
      const records = await inserted.json();
      recordId = records[0]?.id || "";
    }
    if (!recordId) throw new Error("database_record_missing_id");

    await upload(signaturePath, signature, "image/png");
    await upload(pdfPath, pdf, "application/pdf");

    const finalizedAt = new Date().toISOString();
    const updated = await admin("/rest/v1/documentos_clinicos?id=eq." + encodeURIComponent(recordId), {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({ status: "recebido", updated_at: finalizedAt }),
    });
    if (!updated.ok) throw new Error("database_finalize_failed_" + updated.status);
    const finalized = await updated.json();
    const receivedAt = finalized[0]?.recebido_em || serverReceivedAt;
    const pdfUrl = await signedPdfUrl(pdfPath);

    return json(req, {
      ok: true,
      id: recordId,
      codigo: expectedCode,
      recebido_em: receivedAt,
      status: "aguardando_revisao_profissional",
      pdf_url: pdfUrl,
      pdf_nome: "TCLE-Preenchimento-Facial-" + expectedCode.slice(0, 8) + ".pdf",
    }, recovery ? 200 : 201);
  } catch (error) {
    console.error("TCLE submission failed", { recordId, error: String(error) });
    if (recordId) {
      await admin("/rest/v1/documentos_clinicos?id=eq." + encodeURIComponent(recordId), {
        method: "PATCH",
        body: JSON.stringify({ status: "erro", updated_at: new Date().toISOString() }),
      }).catch(() => undefined);
      await cleanup([signaturePath, pdfPath]);
    }
    return fail(req, "temporary_error", "Não foi possível concluir o envio agora. Seus dados continuam na tela; tente novamente.", 503);
  }
});

import "@supabase/functions-js/edge-runtime.d.ts";
import { PDFDocument, rgb, StandardFonts } from "pdf-lib";
import type { PDFFont, PDFImage, PDFPage } from "pdf-lib";

const FORM_VERSION = "2026-08-19-v1";
const FORM_SHA256 =
  "50177b1a892781a1bc321bb15759742d81ab17b03ad981fa0c0cf700edfdf3d3";
const BUCKET = "fichas-pdf";
const MAX_BODY_BYTES = 1_200_000;
const MAX_SIGNATURE_BYTES = 500_000;
const MAX_PDF_BYTES = 4_500_000;
const SIGNED_URL_SECONDS = 600;
const MIN_FILL_MS = 3_000;
const MAX_FILL_MS = 12 * 60 * 60_000;
const MAX_SUCCESSFUL_SUBMITS = 5;
const RATE_WINDOW_MS = 15 * 60_000;

const ALLOWED_ORIGINS = new Set([
  "https://anamariajacob.com.br",
  "https://www.anamariajacob.com.br",
  "http://127.0.0.1:8765",
  "http://localhost:8765",
]);

const LOCAL_TEST_ORIGINS = new Set([
  "http://127.0.0.1:8765",
  "http://localhost:8765",
]);

const HEALTH_QUESTIONS = Object.freeze([
  "Está grávida, com suspeita de gravidez ou amamentando?",
  "Tem doença crônica em tratamento (diabetes, hipertensão, tireoide)?",
  "Tem doença cardíaca, renal ou hepática?",
  "Tem doença autoimune ou inflamatória?",
  "Tem doença neuromuscular (miastenia, ELA, outras)?",
  "Tem epilepsia ou já teve convulsões?",
  "Tem ou teve câncer? Está em tratamento oncológico?",
  "Tem imunossupressão de qualquer causa?",
  "Tem distúrbio de coagulação ou sangra com facilidade?",
  "Usa marca-passo ou tem prótese ou implante metálico?",
  "Tem histórico de queloide ou cicatrização anormal?",
  "Tem herpes labial ou genital recorrente?",
  "Tem doença de pele em atividade (acne, dermatite, rosácea)?",
  "Fez alguma cirurgia nos últimos 6 meses?",
  "Fez ou fará procedimento odontológico em até 2 semanas?",
  "Tomou vacina nas últimas 2 semanas?",
  "Fuma?",
  "Consome bebida alcoólica com frequência?",
]);

const MEDICATION_QUESTIONS = Object.freeze([
  "Usa anticoagulante ou antiagregante (AAS, varfarina, clopidogrel)?",
  "Usou isotretinoína oral nos últimos 6 meses?",
  "Usa corticoide de forma contínua?",
  "Usa anticoncepcional ou faz reposição hormonal?",
  "Tem alergia a anestésico local (lidocaína e semelhantes)?",
  "Tem alergia a látex?",
]);

const PROCEDURES = Object.freeze([
  "Toxina botulínica",
  "Preenchimento com ácido hialurônico",
  "Preenchedor PERMANENTE (PMMA, silicone líquido, bioplastia)",
  "Bioestimulador de colágeno",
  "Fios de sustentação (PDO e outros)",
  "Microagulhamento",
  "Peeling químico",
  "Laser, luz pulsada ou radiofrequência",
  "Depilação a laser",
  "Cirurgia plástica facial",
]);

const LASER_QUESTIONS = Object.freeze([
  "Tomou sol, foi à praia ou fez bronzeamento artificial nos últimos 15 dias?",
  "Usou autobronzeador nos últimos 15 dias?",
  "Depilou com cera, pinça ou linha nos últimos 30 dias?",
  "Tem tatuagem na área que quer tratar?",
  "Tem melasma, manchas escuras ou cicatriz escura na área?",
  "Já fez depilação a laser antes?",
  "Alguma vez teve queimadura, bolha ou mancha após laser?",
  "Usa medicamento fotossensibilizante (antibiótico, diurético, erva de São João)?",
  "Está usando ácido na área (retinoico, glicólico, salicílico)?",
  "Tem foliculite ou pelos encravados com frequência?",
  "Tem ovário policístico, hirsutismo ou alteração hormonal?",
  "Tem alguma lesão, ferida ou irritação na área agora?",
]);

const ATTENDANCE = new Set([
  "Depilação a laser",
  "Procedimento facial",
  "Limpeza de pele",
  "Ainda não sei",
]);

const PHOTOTYPES = new Set([
  "Sempre queima, nunca bronzeia",
  "Queima fácil, bronzeia pouco",
  "Queima às vezes, bronzeia aos poucos",
  "Queima pouco, bronzeia fácil",
  "Raramente queima, bronzeia muito",
  "Nunca queima, pele negra",
]);

const LASER_AREAS = new Set([
  "Axilas",
  "Virilha",
  "Pernas",
  "Buço",
  "Rosto",
  "Barba / pescoço",
  "Braços",
  "Tórax",
  "Costas",
  "Glúteos",
]);

const HAIR_METHODS = new Set([
  "Lâmina",
  "Cera",
  "Pinça",
  "Linha",
  "Creme depilatório",
  "Máquina / epilador",
]);

const SKIN_TYPES = new Set([
  "",
  "Oleosa",
  "Mista",
  "Seca",
  "Normal",
  "Sensível",
]);
const SUN_LEVELS = new Set(["", "Baixa", "Média", "Alta"]);
const SUNSCREEN = new Set(["", "Sim", "Às vezes", "Não"]);

const URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

type JsonRecord = Record<string, unknown>;
type YesNo = "sim" | "nao";
type Answer = { pergunta: string; resposta: YesNo };
type PreviousProcedure = {
  procedimento: string;
  fez: YesNo;
  quando: string;
  regiao: string;
  intercorrencia: string;
};
type LaserData = {
  fototipo: string;
  areas: string[];
  metodo_pelo: string;
  respostas: Answer[];
  detalhe: string;
};
type SafeData = {
  nome: string;
  nascimento: string;
  cpf: string;
  telefone: string;
  email: string;
  profissao: string;
  conheceu: string;
  emergencia: string;
  saude: Answer[];
  saude_detalhe: string;
  medicamentos: Answer[];
  uso_continuo: string;
  suplementos: string;
  alergia_medicamentos: string;
  alergia_outras: string;
  procedimentos: PreviousProcedure[];
  atendimento: string[];
  laser: LaserData | null;
  tipo_pele: string;
  exposicao_sol: string;
  protetor_solar: string;
  rotina: string;
  objetivo: string;
  assinatura_nome: string;
  aceites: { declaracao: true; lgpd: true; eletronica: true };
  assinado_em: string;
  fuso: string;
};

type ExistingSubmission = {
  id: string;
  nome: string;
  cpf: string | null;
  telefone: string | null;
  codigo_verificacao: string;
  recebido_em: string;
  pdf_path: string;
  registro_sha256: string;
  status: string;
  updated_at: string;
};

const failureRate = new Map<string, { count: number; startedAt: number }>();

function cors(origin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.has(origin)
      ? origin
      : "https://anamariajacob.com.br",
    "Access-Control-Allow-Headers": "apikey, content-type, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "600",
    "Vary": "Origin",
  };
}

function json(origin: string, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...cors(origin),
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store, max-age=0",
      "Pragma": "no-cache",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Cross-Origin-Resource-Policy": "same-site",
    },
  });
}

function fail(
  origin: string,
  code: string,
  message: string,
  status = 400,
): Response {
  return json(origin, { ok: false, codigo_erro: code, erro: message }, status);
}

function registerFailure(key: string): boolean {
  const now = Date.now();
  const current = failureRate.get(key);
  if (!current || now - current.startedAt > RATE_WINDOW_MS) {
    failureRate.set(key, { count: 1, startedAt: now });
    return false;
  }
  current.count++;
  return current.count > 20;
}

function clearFailures(key: string): void {
  failureRate.delete(key);
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

async function readBody(req: Request): Promise<Uint8Array | null> {
  const declared = Number(req.headers.get("content-length") || 0);
  if (declared > MAX_BODY_BYTES) return null;
  if (!req.body) return new Uint8Array();
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

async function sha256(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === "string"
    ? new TextEncoder().encode(value)
    : value;
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function originHmac(value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SERVICE),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function decodeBase64(value: unknown, maxBytes: number): Uint8Array | null {
  if (
    typeof value !== "string" || !value ||
    value.length > Math.ceil(maxBytes * 4 / 3) + 16 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
  ) return null;
  try {
    const binary = atob(value);
    if (!binary.length || binary.length > maxBytes) return null;
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return null;
  }
}

function isPng(bytes: Uint8Array): boolean {
  const magic = [137, 80, 78, 71, 13, 10, 26, 10];
  if (
    bytes.length < 24 || !magic.every((byte, index) => bytes[index] === byte)
  ) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  return width > 0 && height > 0 && width <= 2_500 && height <= 1_000;
}

function text(value: unknown, max: number): string {
  return typeof value === "string"
    ? value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
      .trim().slice(0, max)
    : "";
}

function digits(value: unknown): string {
  return typeof value === "string" ? value.replace(/\D/g, "") : "";
}

function validUuid(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(value);
}

function validHash(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
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

function validAdultDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const birth = new Date(value + "T12:00:00Z");
  if (
    !Number.isFinite(birth.getTime()) || birth.getUTCFullYear() !== year ||
    birth.getUTCMonth() !== month - 1 || birth.getUTCDate() !== day
  ) return false;
  const now = new Date();
  let age = now.getUTCFullYear() - birth.getUTCFullYear();
  const beforeBirthday = now.getUTCMonth() < birth.getUTCMonth() ||
    (now.getUTCMonth() === birth.getUTCMonth() &&
      now.getUTCDate() < birth.getUTCDate());
  if (beforeBirthday) age--;
  return age >= 18 && age < 120;
}

function normalizeName(value: string): string {
  return value.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, " ").trim();
}

function exactAnswers(
  value: unknown,
  expected: readonly string[],
): Answer[] | null {
  if (!Array.isArray(value) || value.length !== expected.length) return null;
  const result: Answer[] = [];
  for (let index = 0; index < expected.length; index++) {
    const item = value[index];
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const row = item as JsonRecord;
    const question = text(row.pergunta, 300);
    const answer = row.resposta;
    if (
      question !== expected[index] || (answer !== "sim" && answer !== "nao")
    ) return null;
    result.push({ pergunta: question, resposta: answer });
  }
  return result;
}

function allowedList(
  value: unknown,
  allowed: Set<string>,
  min: number,
  max: number,
): string[] | null {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    return null;
  }
  const result = value.map((item) => text(item, 100));
  if (
    new Set(result).size !== result.length ||
    result.some((item) => !allowed.has(item))
  ) return null;
  return result;
}

function safeData(payload: JsonRecord): SafeData | null {
  const raw = payload.dados;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const data = raw as JsonRecord;
  const nome = text(data.nome, 120);
  const nascimento = text(data.nascimento, 10);
  const cpf = digits(data.cpf);
  const telefone = digits(data.telefone);
  const email = text(data.email, 254).toLowerCase();
  const assinaturaNome = text(data.assinatura_nome, 120);
  const objetivo = text(data.objetivo, 2_000);
  const assinadoEm = text(data.assinado_em, 40);
  const signedDate = new Date(assinadoEm);
  const now = Date.now();

  if (
    nome.length < 5 || nome.length > 120 || !nome.includes(" ") ||
    !validAdultDate(nascimento) || !validCpf(cpf) ||
    !/^\d{10,11}$/.test(telefone) ||
    (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) ||
    objetivo.length < 5 ||
    normalizeName(assinaturaNome) !== normalizeName(nome) ||
    !Number.isFinite(signedDate.getTime()) ||
    signedDate.getTime() > now + 5 * 60_000 ||
    signedDate.getTime() < now - 2 * 60 * 60_000
  ) return null;

  const health = exactAnswers(data.saude, HEALTH_QUESTIONS);
  const medication = exactAnswers(data.medicamentos, MEDICATION_QUESTIONS);
  const attendance = allowedList(
    data.atendimento,
    ATTENDANCE,
    1,
    ATTENDANCE.size,
  );
  if (!health || !medication || !attendance) return null;

  if (
    !Array.isArray(data.procedimentos) ||
    data.procedimentos.length !== PROCEDURES.length
  ) return null;
  const procedures: PreviousProcedure[] = [];
  for (let index = 0; index < PROCEDURES.length; index++) {
    const item = data.procedimentos[index];
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const row = item as JsonRecord;
    const procedure = text(row.procedimento, 100);
    if (
      procedure !== PROCEDURES[index] ||
      (row.fez !== "sim" && row.fez !== "nao")
    ) return null;
    procedures.push({
      procedimento: procedure,
      fez: row.fez,
      quando: text(row.quando, 40),
      regiao: text(row.regiao, 200),
      intercorrencia: text(row.intercorrencia, 600),
    });
  }

  let laser: LaserData | null = null;
  if (attendance.includes("Depilação a laser")) {
    if (
      !data.laser || typeof data.laser !== "object" || Array.isArray(data.laser)
    ) return null;
    const rawLaser = data.laser as JsonRecord;
    const fototipo = text(rawLaser.fototipo, 100);
    const metodo = text(rawLaser.metodo_pelo, 100);
    const areas = allowedList(rawLaser.areas, LASER_AREAS, 1, LASER_AREAS.size);
    const answers = exactAnswers(rawLaser.respostas, LASER_QUESTIONS);
    if (
      !PHOTOTYPES.has(fototipo) || !HAIR_METHODS.has(metodo) || !areas ||
      !answers
    ) return null;
    laser = {
      fototipo,
      areas,
      metodo_pelo: metodo,
      respostas: answers,
      detalhe: text(rawLaser.detalhe, 1_500),
    };
  } else if (data.laser !== null) {
    return null;
  }

  const aceites = data.aceites;
  if (!aceites || typeof aceites !== "object" || Array.isArray(aceites)) {
    return null;
  }
  const accept = aceites as JsonRecord;
  if (
    accept.declaracao !== true || accept.lgpd !== true ||
    accept.eletronica !== true
  ) return null;

  const tipoPele = text(data.tipo_pele, 30);
  const exposicaoSol = text(data.exposicao_sol, 20);
  const protetorSolar = text(data.protetor_solar, 20);
  if (
    !SKIN_TYPES.has(tipoPele) || !SUN_LEVELS.has(exposicaoSol) ||
    !SUNSCREEN.has(protetorSolar)
  ) return null;

  return {
    nome,
    nascimento,
    cpf,
    telefone,
    email,
    profissao: text(data.profissao, 120),
    conheceu: text(data.conheceu, 200),
    emergencia: text(data.emergencia, 240),
    saude: health,
    saude_detalhe: text(data.saude_detalhe, 2_000),
    medicamentos: medication,
    uso_continuo: text(data.uso_continuo, 2_000),
    suplementos: text(data.suplementos, 1_000),
    alergia_medicamentos: text(data.alergia_medicamentos, 1_000),
    alergia_outras: text(data.alergia_outras, 1_000),
    procedimentos: procedures,
    atendimento: attendance,
    laser,
    tipo_pele: tipoPele,
    exposicao_sol: exposicaoSol,
    protetor_solar: protetorSolar,
    rotina: text(data.rotina, 2_000),
    objetivo,
    assinatura_nome: assinaturaNome,
    aceites: { declaracao: true, lgpd: true, eletronica: true },
    assinado_em: signedDate.toISOString(),
    fuso: text(data.fuso, 80),
  };
}

function pdfSafe(value: string): string {
  return value.replace(/[\u2010-\u2015]/g, "-")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\u2026/g, "...")
    .replace(/\u00A0/g, " ")
    .replace(/[^\u000A\u000D\u0020-\u007E\u00A0-\u00FF]/g, "");
}

function wrap(
  font: PDFFont,
  value: string,
  size: number,
  maxWidth: number,
): string[] {
  const paragraphs = pdfSafe(value).replace(/\r\n?/g, "\n").split("\n");
  const lines: string[] = [];
  for (const paragraph of paragraphs) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (!words.length) {
      lines.push("");
      continue;
    }
    let line = "";
    for (const word of words) {
      const candidate = line ? line + " " + word : word;
      if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
        line = candidate;
      } else if (line) {
        lines.push(line);
        line = word;
      } else {
        lines.push(word.slice(0, 80));
      }
    }
    if (line) lines.push(line);
  }
  return lines;
}

async function generatePdf(
  data: SafeData,
  signatureBytes: Uint8Array,
  code: string,
  receivedAt: string,
): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle("Ficha de Anamnese - Ana Maria Jacob Estética");
  pdf.setAuthor("Ana Maria Costa Jacob - CRF/MG 40880");
  pdf.setSubject("Ficha clínica privada");
  const fixedDate = new Date(receivedAt);
  pdf.setCreationDate(fixedDate);
  pdf.setModificationDate(fixedDate);
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const serif = await pdf.embedFont(StandardFonts.TimesRomanBold);
  let signature: PDFImage | null = null;
  try {
    signature = await pdf.embedPng(signatureBytes);
  } catch {
    throw new Error("signature_embed_failed");
  }

  const pageWidth = 595.28;
  const pageHeight = 841.89;
  const margin = 42;
  const contentWidth = pageWidth - margin * 2;
  const gold = rgb(0.69, 0.51, 0.20);
  const ink = rgb(0.15, 0.12, 0.10);
  const muted = rgb(0.38, 0.35, 0.33);
  let page!: PDFPage;
  let y!: number;

  const newPage = () => {
    page = pdf.addPage([pageWidth, pageHeight]);
    y = pageHeight - 48;
    page.drawText("Ana Maria Jacob", {
      x: margin,
      y,
      size: 18,
      font: serif,
      color: gold,
    });
    page.drawText("ESTÉTICA", {
      x: margin,
      y: y - 14,
      size: 7,
      font: regular,
      color: muted,
    });
    page.drawLine({
      start: { x: margin, y: y - 23 },
      end: { x: pageWidth - margin, y: y - 23 },
      thickness: 0.7,
      color: rgb(0.90, 0.84, 0.72),
    });
    y -= 45;
  };

  const ensure = (height: number) => {
    if (y - height < 58) newPage();
  };

  const paragraph = (
    value: string,
    options: {
      font?: PDFFont;
      size?: number;
      color?: ReturnType<typeof rgb>;
      indent?: number;
    } = {},
  ) => {
    const font = options.font || regular;
    const size = options.size || 8.5;
    const indent = options.indent || 0;
    const lines = wrap(font, value || "-", size, contentWidth - indent);
    const lineHeight = size + 3;
    ensure(lines.length * lineHeight + 2);
    for (const line of lines) {
      page.drawText(line || " ", {
        x: margin + indent,
        y,
        size,
        font,
        color: options.color || ink,
      });
      y -= lineHeight;
    }
    y -= 2;
  };

  const heading = (value: string) => {
    ensure(28);
    y -= 4;
    page.drawRectangle({
      x: margin,
      y: y - 5,
      width: contentWidth,
      height: 17,
      color: rgb(0.985, 0.975, 0.955),
    });
    page.drawText(pdfSafe(value.toUpperCase()), {
      x: margin + 6,
      y,
      size: 8.5,
      font: bold,
      color: gold,
    });
    y -= 23;
  };

  const field = (label: string, value: string) => {
    if (!value) return;
    paragraph(label + ": " + value);
  };

  const answers = (items: Answer[]) => {
    for (const item of items) {
      paragraph(item.pergunta + " — " + item.resposta.toUpperCase(), {
        size: 8,
        color: item.resposta === "sim" ? rgb(0.63, 0.18, 0.18) : ink,
      });
    }
  };

  newPage();
  page.drawText("FICHA DE ANAMNESE", {
    x: margin,
    y,
    size: 14,
    font: bold,
    color: ink,
  });
  y -= 22;
  paragraph(
    "Versão " + FORM_VERSION + " · recebida em " +
      new Date(receivedAt).toLocaleString("pt-BR", {
        timeZone: "America/Sao_Paulo",
      }),
    { size: 7.5, color: muted },
  );

  heading("Identificação");
  field("Nome", data.nome);
  field("Nascimento", data.nascimento);
  field("CPF", data.cpf);
  field("Telefone", data.telefone);
  field("E-mail", data.email);
  field("Profissão", data.profissao);
  field("Como conheceu", data.conheceu);
  field("Contato de emergência", data.emergencia);
  field("Finalidade informada", data.atendimento.join(", "));

  heading("Saúde geral");
  answers(data.saude);
  field("Detalhes", data.saude_detalhe);

  heading("Medicamentos e alergias");
  answers(data.medicamentos);
  field("Uso contínuo", data.uso_continuo);
  field("Suplementos", data.suplementos);
  field("Alergias a medicamentos", data.alergia_medicamentos);
  field("Outras alergias", data.alergia_outras);

  heading("Procedimentos anteriores");
  const previous = data.procedimentos.filter((item) => item.fez === "sim");
  if (!previous.length) {
    paragraph("Nenhum procedimento anterior informado.", { color: muted });
  }
  for (const item of previous) {
    const details = [item.quando, item.regiao, item.intercorrencia].filter(
      Boolean,
    ).join(" · ");
    paragraph(item.procedimento + (details ? " — " + details : ""));
  }

  if (data.laser) {
    heading("Depilação a laser");
    field("Fototipo percebido", data.laser.fototipo);
    field("Áreas", data.laser.areas.join(", "));
    field("Método atual", data.laser.metodo_pelo);
    answers(data.laser.respostas);
    field("Detalhes", data.laser.detalhe);
  }

  heading("Pele e objetivo");
  field("Tipo de pele", data.tipo_pele);
  field("Exposição ao sol", data.exposicao_sol);
  field("Protetor solar", data.protetor_solar);
  field("Rotina", data.rotina);
  field("Objetivo", data.objetivo);

  heading("Declarações e aceites");
  paragraph(
    "A paciente declarou ter respondido com sinceridade e não ter omitido informações de saúde, medicamentos, alergias ou procedimentos anteriores; comprometeu-se a comunicar alterações antes do atendimento.",
  );
  paragraph(
    "Autorizou o tratamento dos dados pessoais e de saúde para prestação do atendimento, cumprimento de obrigações legais e defesa de direitos, com guarda informada por 20 anos. Esta ficha não autoriza uso de imagem.",
  );
  paragraph(
    "Aceitou a assinatura eletrônica nos termos apresentados no formulário. Os três aceites obrigatórios foram registrados como SIM.",
  );

  heading("Assinatura");
  ensure(115);
  if (!signature) throw new Error("signature_missing");
  const scale = Math.min(210 / signature.width, 70 / signature.height, 1);
  page.drawImage(signature, {
    x: margin,
    y: y - signature.height * scale,
    width: signature.width * scale,
    height: signature.height * scale,
  });
  y -= Math.max(78, signature.height * scale + 8);
  page.drawLine({
    start: { x: margin, y },
    end: { x: margin + 230, y },
    thickness: 0.6,
    color: muted,
  });
  y -= 14;
  paragraph(data.assinatura_nome + " · assinatura da paciente", { size: 8 });
  paragraph(
    "Assinado em: " +
      new Date(data.assinado_em).toLocaleString("pt-BR", {
        timeZone: "America/Sao_Paulo",
      }) + " · Fuso informado: " + (data.fuso || "não informado"),
    { size: 7, color: muted },
  );
  paragraph("Código de verificação SHA-256: " + code, {
    size: 6.5,
    color: muted,
  });
  paragraph("Formulário: " + FORM_VERSION + " · " + FORM_SHA256, {
    size: 6.5,
    color: muted,
  });

  const pages = pdf.getPages();
  for (let index = 0; index < pages.length; index++) {
    const current = pages[index];
    current.drawText(
      "Ana Maria Costa Jacob · Farmacêutica · CRF/MG 40880 · Documento clínico privado",
      {
        x: margin,
        y: 32,
        size: 6.5,
        font: regular,
        color: muted,
      },
    );
    current.drawText(String(index + 1) + "/" + String(pages.length), {
      x: pageWidth - margin - 20,
      y: 32,
      size: 6.5,
      font: regular,
      color: muted,
    });
  }

  const bytes = await pdf.save({ useObjectStreams: true });
  if (!bytes.length || bytes.length > MAX_PDF_BYTES) {
    throw new Error("pdf_size_invalid");
  }
  return bytes;
}

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

async function upload(
  path: string,
  bytes: Uint8Array,
  contentType: string,
): Promise<void> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const response = await fetch(
    URL + "/storage/v1/object/" + BUCKET + "/" + encodePath(path),
    {
      method: "POST",
      headers: {
        apikey: SERVICE,
        Authorization: "Bearer " + SERVICE,
        "Content-Type": contentType,
        "x-upsert": "true",
      },
      body: new Blob([copy], { type: contentType }),
    },
  );
  if (!response.ok) throw new Error("storage_upload_failed_" + response.status);
}

async function removeObjects(paths: string[]): Promise<void> {
  try {
    await admin("/storage/v1/object/" + BUCKET, {
      method: "DELETE",
      body: JSON.stringify({ prefixes: paths }),
    });
  } catch {
    // A limpeza e melhor esforco; o registro permanece como erro para auditoria.
  }
}

async function signedPdf(path: string): Promise<string | null> {
  const response = await admin(
    "/storage/v1/object/sign/" + BUCKET + "/" + encodePath(path),
    {
      method: "POST",
      body: JSON.stringify({ expiresIn: SIGNED_URL_SECONDS }),
    },
  );
  if (!response.ok) return null;
  const body = await response.json();
  const signed = body.signedURL || body.signedUrl;
  return typeof signed === "string" ? URL + "/storage/v1" + signed : null;
}

async function findExisting(
  idempotencyKey: string,
): Promise<ExistingSubmission | null> {
  const response = await admin(
    "/rest/v1/anamneses?select=id,nome,cpf,telefone,codigo_verificacao,recebido_em,pdf_path,registro_sha256,status,updated_at" +
      "&idempotency_key=eq." + encodeURIComponent(idempotencyKey) + "&limit=1",
  );
  if (!response.ok) {
    throw new Error("idempotency_read_failed_" + response.status);
  }
  const rows = await response.json();
  return Array.isArray(rows) && rows.length
    ? rows[0] as ExistingSubmission
    : null;
}

function sameOwner(existing: ExistingSubmission, data: SafeData): boolean {
  return normalizeName(existing.nome) === normalizeName(data.nome) &&
    digits(existing.cpf) === data.cpf &&
    digits(existing.telefone) === data.telefone;
}

async function successfulRateCount(originHash: string): Promise<number> {
  const since = new Date(Date.now() - RATE_WINDOW_MS).toISOString();
  const response = await admin(
    "/rest/v1/anamneses?select=id&origem_hash=eq." + originHash +
      "&recebido_em=gte." + encodeURIComponent(since) + "&limit=6",
  );
  if (!response.ok) {
    throw new Error("rate_limit_read_failed_" + response.status);
  }
  const rows = await response.json();
  return Array.isArray(rows) ? rows.length : MAX_SUCCESSFUL_SUBMITS;
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin") || "";
  if (req.method === "OPTIONS") {
    if (!ALLOWED_ORIGINS.has(origin)) {
      return new Response(null, { status: 403 });
    }
    return new Response(null, { status: 204, headers: cors(origin) });
  }
  if (!ALLOWED_ORIGINS.has(origin)) {
    return fail(origin, "origin_not_allowed", "Origem não permitida.", 403);
  }
  if (req.method !== "POST") {
    return fail(origin, "method_not_allowed", "Método não permitido.", 405);
  }
  const contentType = (req.headers.get("content-type") || "").toLowerCase();
  if (!contentType.startsWith("application/json")) {
    return fail(
      origin,
      "unsupported_media_type",
      "Envie os dados em JSON.",
      415,
    );
  }

  const ip = text(
    req.headers.get("cf-connecting-ip") ||
      (req.headers.get("x-forwarded-for") || "").split(",")[0] ||
      "origem-indisponivel",
    100,
  );
  const originHash = await originHmac(ip);
  if (registerFailure(originHash)) {
    return fail(
      origin,
      "rate_limited",
      "Muitas tentativas foram feitas. Aguarde e tente novamente.",
      429,
    );
  }

  try {
    const rawBody = await readBody(req);
    if (!rawBody) {
      return fail(
        origin,
        "payload_too_large",
        "O formulário ultrapassou o limite permitido.",
        413,
      );
    }
    let payload: JsonRecord;
    try {
      const decoded = new TextDecoder("utf-8", { fatal: true }).decode(rawBody);
      const parsed = JSON.parse(decoded);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("invalid_json_object");
      }
      payload = parsed as JsonRecord;
    } catch {
      return fail(
        origin,
        "invalid_json",
        "Não foi possível ler o formulário.",
        400,
      );
    }

    if (text(payload.website, 200)) {
      return fail(
        origin,
        "invalid_submission",
        "Não foi possível validar o envio.",
        400,
      );
    }
    const startedAt = new Date(text(payload.started_at, 40));
    const elapsed = Date.now() - startedAt.getTime();
    if (
      !Number.isFinite(startedAt.getTime()) || elapsed < MIN_FILL_MS ||
      elapsed > MAX_FILL_MS
    ) {
      return fail(
        origin,
        "invalid_submission_time",
        "Atualize a página e tente novamente.",
        400,
      );
    }
    if (
      payload.formulario_versao !== FORM_VERSION ||
      payload.formulario_sha256 !== FORM_SHA256
    ) {
      return fail(
        origin,
        "form_version_mismatch",
        "Esta ficha foi atualizada. Recarregue a página.",
        409,
      );
    }
    if (
      !validUuid(payload.idempotency_key) ||
      !validHash(payload.assinatura_sha256)
    ) {
      return fail(
        origin,
        "invalid_integrity_data",
        "Não foi possível validar a integridade do envio.",
        400,
      );
    }

    const data = safeData(payload);
    const signature = decodeBase64(
      payload.assinatura_png_base64,
      MAX_SIGNATURE_BYTES,
    );
    if (!data || !signature || !isPng(signature)) {
      return fail(
        origin,
        "invalid_form",
        "Revise os campos e a assinatura antes de enviar.",
        422,
      );
    }
    const signatureHash = await sha256(signature);
    if (signatureHash !== payload.assinatura_sha256) {
      return fail(
        origin,
        "signature_integrity_failed",
        "A assinatura não passou na verificação de integridade.",
        422,
      );
    }

    const registryHash = await sha256(JSON.stringify({
      formulario_versao: FORM_VERSION,
      formulario_sha256: FORM_SHA256,
      dados: data,
      assinatura_sha256: signatureHash,
    }));

    const existing = await findExisting(payload.idempotency_key);
    if (existing) {
      if (
        !sameOwner(existing, data) || existing.registro_sha256 !== registryHash
      ) {
        return fail(
          origin,
          "idempotency_conflict",
          "Este identificador já pertence a outro envio.",
          409,
        );
      }
      if (existing.status === "recebido") {
        clearFailures(originHash);
        return json(origin, {
          ok: true,
          id: existing.id,
          codigo: existing.codigo_verificacao,
          recebido_em: existing.recebido_em,
          pdf_url: await signedPdf(existing.pdf_path),
          pdf_nome: "Ficha-de-Anamnese-" +
            existing.codigo_verificacao.slice(0, 8) + ".pdf",
          idempotente: true,
        });
      }
      const age = Date.now() - new Date(existing.updated_at).getTime();
      if (existing.status === "processando" && age < 120_000) {
        return fail(
          origin,
          "submission_processing",
          "O envio ainda está sendo processado. Aguarde alguns segundos.",
          409,
        );
      }
    }

    const successful = await successfulRateCount(originHash);
    if (successful >= MAX_SUCCESSFUL_SUBMITS) {
      return fail(
        origin,
        "rate_limited",
        "Muitos envios foram feitos desta conexão. Aguarde 15 minutos.",
        429,
      );
    }

    const recordId = existing?.id || crypto.randomUUID();
    const receivedAt = existing?.recebido_em || new Date().toISOString();
    const code = existing?.codigo_verificacao || await sha256(
      registryHash + "|" + recordId + "|" + receivedAt,
    );
    const signaturePath = "anamneses/" + recordId + "/assinatura.png";
    const pdfPath = "anamneses/" + recordId + "/ficha.pdf";
    const pdf = await generatePdf(data, signature, code, receivedAt);
    const pdfHash = await sha256(pdf);

    if (payload.dry_run === true) {
      if (!LOCAL_TEST_ORIGINS.has(origin)) {
        return fail(
          origin,
          "dry_run_not_allowed",
          "Modo de teste não permitido nesta origem.",
          403,
        );
      }
      clearFailures(originHash);
      return json(origin, {
        ok: true,
        teste: true,
        codigo: code,
        registro_sha256: registryHash,
        pdf_sha256: pdfHash,
      });
    }

    if (!existing) {
      const insert = await admin("/rest/v1/anamneses", {
        method: "POST",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({
          id: recordId,
          idempotency_key: payload.idempotency_key,
          formulario_versao: FORM_VERSION,
          formulario_sha256: FORM_SHA256,
          nome: data.nome,
          cpf: data.cpf,
          telefone: data.telefone,
          assinado_em: data.assinado_em,
          recebido_em: receivedAt,
          codigo_verificacao: code,
          dispositivo: null,
          assinatura_png: null,
          assinatura_path: signaturePath,
          assinatura_sha256: signatureHash,
          pdf_path: pdfPath,
          pdf_sha256: pdfHash,
          registro_sha256: registryHash,
          origem_hash: originHash,
          dados: data,
          status: "processando",
          updated_at: receivedAt,
        }),
      });
      if (!insert.ok) {
        if (insert.status === 409) {
          return fail(
            origin,
            "submission_conflict",
            "O envio já foi recebido ou está em processamento.",
            409,
          );
        }
        throw new Error("database_insert_failed_" + insert.status);
      }
    } else {
      const resume = await admin(
        "/rest/v1/anamneses?id=eq." + encodeURIComponent(recordId),
        {
          method: "PATCH",
          headers: { Prefer: "return=minimal" },
          body: JSON.stringify({
            status: "processando",
            updated_at: new Date().toISOString(),
          }),
        },
      );
      if (!resume.ok) {
        throw new Error("database_resume_failed_" + resume.status);
      }
    }

    try {
      await upload(signaturePath, signature, "image/png");
      await upload(pdfPath, pdf, "application/pdf");
      const complete = await admin(
        "/rest/v1/anamneses?id=eq." + encodeURIComponent(recordId),
        {
          method: "PATCH",
          headers: { Prefer: "return=minimal" },
          body: JSON.stringify({
            status: "recebido",
            updated_at: new Date().toISOString(),
          }),
        },
      );
      if (!complete.ok) {
        throw new Error("database_finalize_failed_" + complete.status);
      }
    } catch (error) {
      await removeObjects([signaturePath, pdfPath]);
      await admin(
        "/rest/v1/anamneses?id=eq." + encodeURIComponent(recordId),
        {
          method: "PATCH",
          headers: { Prefer: "return=minimal" },
          body: JSON.stringify({
            status: "erro",
            updated_at: new Date().toISOString(),
          }),
        },
      );
      throw error;
    }

    clearFailures(originHash);
    return json(origin, {
      ok: true,
      id: recordId,
      codigo: code,
      recebido_em: receivedAt,
      pdf_url: await signedPdf(pdfPath),
      pdf_nome: "Ficha-de-Anamnese-" + code.slice(0, 8) + ".pdf",
      idempotente: false,
    }, 201);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unexpected_error";
    console.error("anamnese-submit", message.slice(0, 160));
    return fail(
      origin,
      "temporary_failure",
      "Não foi possível concluir agora. Tente novamente em instantes.",
      503,
    );
  }
});

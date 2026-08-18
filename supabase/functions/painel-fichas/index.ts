import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// Compatível com o painel atual. A senha em hash permanece durante esta etapa;
// uma migração futura para Supabase Auth não deve ser misturada ao primeiro TCLE.
const HASH_SENHA = (Deno.env.get("PAINEL_HASH_SENHA") || "").toLowerCase();
const HASH_SENHA_CONFIGURADO = /^[0-9a-f]{64}$/.test(HASH_SENHA);
const URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ALLOWED_ORIGINS = new Set([
  "https://anamariajacob.com.br",
  "https://www.anamariajacob.com.br",
  "http://127.0.0.1:8765",
  "http://localhost:8765",
]);

const DOCUMENT_TYPES: Record<string, { label: string; filename: string }> = {
  tcle_toxina_botulinica: {
    label: "TCLE · Toxina botulínica",
    filename: "TCLE-Toxina",
  },
  tcle_preenchimento_facial: {
    label: "TCLE · Preenchimento facial",
    filename: "TCLE-Preenchimento-Facial",
  },
  tcle_intradermoterapia_estetica: {
    label: "Pré-avaliação · Intradermoterapia estética",
    filename: "Pre-Avaliacao-Intradermoterapia",
  },
  tcle_bioestimulador_colageno: {
    label: "Pré-avaliação · Bioestimulador de colágeno",
    filename: "Pre-Avaliacao-Bioestimulador-Colageno",
  },
  tcle_peeling_quimico: {
    label: "Pré-avaliação · Peeling químico superficial",
    filename: "Pre-Avaliacao-Peeling-Quimico-Superficial",
  },
  tcle_fios_pdo: {
    label: "Pré-avaliação · Fios absorvíveis de PDO",
    filename: "Pre-Avaliacao-Fios-PDO",
  },
};

const attempts = new Map<string, { count: number; resetAt: number }>();

function cors(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") || "";
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.has(origin)
      ? origin
      : "https://anamariajacob.com.br",
    "Access-Control-Allow-Headers": "content-type, x-senha",
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
      "Pragma": "no-cache",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function equalConstantTime(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index++) {
    difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return difference === 0;
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

async function signedLinks(bucket: string, paths: string[]): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  if (!paths.length) return result;
  const response = await admin("/storage/v1/object/sign/" + bucket, {
    method: "POST",
    body: JSON.stringify({ expiresIn: 7200, paths }),
  });
  if (!response.ok) return result;
  for (const item of await response.json()) {
    if (item.signedURL && item.path) result[item.path] = URL + "/storage/v1" + item.signedURL;
  }
  return result;
}

function safeText(value: unknown, max = 300): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin") || "";
  if (req.method === "OPTIONS") {
    if (origin && !ALLOWED_ORIGINS.has(origin)) return new Response(null, { status: 403 });
    return new Response(null, { status: 204, headers: cors(req) });
  }
  if (req.method !== "POST") return json(req, { erro: "Método não permitido" }, 405);
  if (origin && !ALLOWED_ORIGINS.has(origin)) return json(req, { erro: "Origem não permitida" }, 403);
  if (!HASH_SENHA_CONFIGURADO) {
    console.error("PAINEL_HASH_SENHA ausente ou inválido");
    return json(req, { erro: "Acesso temporariamente indisponível" }, 503);
  }

  const ip = req.headers.get("cf-connecting-ip") || req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const now = Date.now();
  const record = attempts.get(ip);
  if (record && record.resetAt > now && record.count >= 12) {
    return json(req, { erro: "Muitas tentativas. Aguarde alguns minutos." }, 429);
  }

  const sent = (req.headers.get("x-senha") || "").toLowerCase();
  if (!equalConstantTime(sent, HASH_SENHA)) {
    const current = record && record.resetAt > now ? record : { count: 0, resetAt: now + 10 * 60_000 };
    current.count++;
    attempts.set(ip, current);
    await new Promise((resolve) => setTimeout(resolve, 700));
    return json(req, { erro: "Senha incorreta" }, 401);
  }
  attempts.delete(ip);

  try {
    // Resposta original da anamnese, preservada integralmente.
    const formsResponse = await admin("/rest/v1/anamneses_resumo?select=*");
    if (!formsResponse.ok) throw new Error("anamneses_read_" + formsResponse.status);
    const forms = await formsResponse.json();

    const filesResponse = await admin("/storage/v1/object/list/fichas-pdf", {
      method: "POST",
      body: JSON.stringify({ prefix: "", limit: 500, sortBy: { column: "name", order: "desc" } }),
    });
    const files = filesResponse.ok ? await filesResponse.json() : [];
    const names = files.map((item: { name?: string }) => item.name).filter(Boolean);
    const formLinks = await signedLinks("fichas-pdf", names);

    const codesResponse = await admin("/rest/v1/anamneses?select=id,codigo_verificacao");
    const codes = codesResponse.ok ? await codesResponse.json() : [];
    const codeById: Record<string, string> = {};
    for (const item of codes) codeById[item.id] = (item.codigo_verificacao || "").slice(0, 8);

    for (const form of forms) {
      const marker = codeById[form.id];
      const filename = marker ? names.find((name: string) => name.includes(marker)) : null;
      form.pdf = filename ? formLinks[filename] || null : null;
      form.pdf_nome = filename || null;
    }

    // Nova coleção: apenas resumo do TCLE, nunca o JSON clínico completo.
    const documentsResponse = await admin(
      "/rest/v1/documentos_clinicos?select=id,tipo,versao_termo,nome,telefone,recebido_em,codigo_verificacao,pdf_path,revisado,dados,status" +
        "&status=eq.recebido&order=recebido_em.desc",
    );
    if (!documentsResponse.ok) throw new Error("documents_read_" + documentsResponse.status);
    const documentRows = await documentsResponse.json();
    const documentPaths = documentRows.map((item: { pdf_path?: string }) => item.pdf_path).filter(Boolean);
    const documentLinks = await signedLinks("documentos-clinicos", documentPaths);

    const documents = documentRows.map((row: Record<string, unknown>) => {
      const data = row.dados && typeof row.dados === "object" ? row.dados as Record<string, unknown> : {};
      const procedure = data.procedimento && typeof data.procedimento === "object"
        ? data.procedimento as Record<string, unknown>
        : {};
      const health = Array.isArray(data.confirmacoes_saude) ? data.confirmacoes_saude : [];
      const alerts = health
        .filter((item) => {
          if (!item || typeof item !== "object") return false;
          const answer = (item as Record<string, unknown>).resposta;
          return answer === "sim" || answer === "nao_sei";
        })
        .map((item) => ({
          pergunta: safeText((item as Record<string, unknown>).pergunta),
          resposta: safeText((item as Record<string, unknown>).resposta, 20),
          detalhe: safeText((item as Record<string, unknown>).detalhe, 600),
        }));
      const path = safeText(row.pdf_path, 500);
      const type = safeText(row.tipo, 80);
      const typeMeta = DOCUMENT_TYPES[type] || {
        label: "Documento clínico",
        filename: "Documento-Clinico",
      };
      return {
        id: row.id,
        tipo: type,
        tipo_label: typeMeta.label,
        versao_termo: row.versao_termo,
        nome: row.nome,
        telefone: row.telefone,
        recebido_em: row.recebido_em,
        codigo_verificacao: row.codigo_verificacao,
        revisado: row.revisado === true,
        status_profissional: "aguardando_revisao_profissional",
        modalidades: Array.isArray(procedure.modalidades) ? procedure.modalidades.slice(0, 3) : [],
        regioes: Array.isArray(procedure.regioes)
          ? procedure.regioes.slice(0, 10)
          : safeText(procedure.regioes, 600),
        objetivo: safeText(procedure.objetivo, 600),
        detalhamento_volume_previsto: safeText(procedure.detalhamento_volume_previsto, 600),
        detalhamento_plano_previsto: safeText(procedure.detalhamento_plano_previsto, 600),
        status_anamnese: safeText(procedure.status_anamnese, 40),
        alertas_saude: alerts,
        duvidas: safeText(data.duvidas, 1200),
        pdf: documentLinks[path] || null,
        pdf_nome: path ? typeMeta.filename + "-" + safeText(row.codigo_verificacao, 8) + ".pdf" : null,
      };
    });

    return json(req, {
      fichas: forms,
      total: forms.length,
      pdfs: names.length,
      documentos: documents,
      totais: {
        anamneses: forms.length,
        tcles: documents.length,
        geral: forms.length + documents.length,
      },
    });
  } catch (error) {
    console.error("Painel loading failed", String(error));
    return json(req, { erro: "Não foi possível carregar os documentos agora." }, 500);
  }
});

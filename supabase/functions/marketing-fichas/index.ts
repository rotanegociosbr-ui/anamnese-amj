import "@supabase/functions-js/edge-runtime.d.ts";
import { readLimitedBody, RequestBodyTooLargeError } from "../_shared/read-limited-body.ts";
import {
  authenticateDual,
  authResponseFields,
  DualAuthConfig,
  DualAuthContext,
  DualAuthError,
  requireRecentPasswordProof,
} from "../_shared/dual-auth.ts";

type J = Record<string, unknown>;
const URL_BASE = (Deno.env.get("SUPABASE_URL") || "").replace(/\/+$/, "");
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const CFG: DualAuthConfig = {
  supabaseUrl: URL_BASE,
  serviceRoleKey: KEY,
  allowedRoles: ["owner"],
  requireAal2: true,
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROTECTED = new Set([
  "arquivar_campanha",
  "vincular_lancamento",
  "cancelar_vinculo",
  "cancelar_indicacao",
  "arquivar_conteudo",
]);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, readonly publicMessage: string) {
    super(publicMessage);
  }
}
const obj = (v: unknown): v is J => !!v && typeof v === "object" && !Array.isArray(v);
const uuid = (v: unknown, n: string) => {
  if (typeof v !== "string" || !UUID.test(v)) {
    throw new ApiError(422, `invalid_${n}`, "Identificador inválido.");
  }
  return v.toLowerCase();
};
const optUuid = (v: unknown, n: string) =>
  v === null || v === undefined || v === "" ? null : uuid(v, n);
const num = (v: unknown, n: string, min: number, max: number, d: number) => {
  const x = v === undefined ? d : Number(v);
  if (!Number.isInteger(x) || x < min || x > max) {
    throw new ApiError(422, `invalid_${n}`, `Confira ${n}.`);
  }
  return x;
};
const text = (v: unknown, n: string, min = 1, max = 500) => {
  if (typeof v !== "string") throw new ApiError(422, `invalid_${n}`, `Confira ${n}.`);
  const x = v.trim();
  const unsafe = Array.from(x).some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
  if (x.length < min || x.length > max || unsafe) {
    throw new ApiError(422, `invalid_${n}`, `Confira ${n}.`);
  }
  return x;
};
function cors(origin: string | null) {
  return origin === null || origin === "https://anamariajacob.com.br" ||
    origin === "https://www.anamariajacob.com.br" ||
    /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/.test(origin);
}
function headers(req: Request) {
  const h = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Vary": "Origin",
  });
  const o = req.headers.get("origin");
  if (o && cors(o)) h.set("Access-Control-Allow-Origin", o);
  return h;
}
const json = (req: Request, b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: headers(req) });
async function rpc(name: string, body: J): Promise<unknown> {
  const r = await fetch(`${URL_BASE}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(12000),
  });
  let d: unknown = null;
  try {
    d = await r.json();
  } catch { /* fail closed */ }
  if (!r.ok) {
    const m = obj(d) ? String(d.message || "") : "";
    if (m.includes("version_conflict")) {
      throw new ApiError(409, "version_conflict", "O registro mudou. Recarregue.");
    }
    if (m.includes("not_found")) throw new ApiError(404, "not_found", "Registro não encontrado.");
    if (m.includes("already_linked") || m.includes("duplicate")) {
      throw new ApiError(409, "conflict", "Já existe um vínculo ativo.");
    }
    if (m.includes("owner_required")) {
      throw new ApiError(403, "owner_required", "Somente proprietários podem acessar.");
    }
    throw new ApiError(422, "operation_failed", "Não foi possível concluir a operação.");
  }
  return d;
}
function tenant(c: DualAuthContext) {
  if (
    c.authMethod !== "supabase_auth" || c.role !== "owner" || c.aal !== "aal2" || !c.clinicId ||
    !c.userId
  ) throw new ApiError(403, "owner_mfa_required", "Entre como proprietária com MFA.");
  return { clinicId: c.clinicId, userId: c.userId };
}
async function proof(req: Request, c: DualAuthContext, p: J, action: string, target: string) {
  await requireRecentPasswordProof(req, CFG, c, {
    operationId: uuid(p.operation_id, "operation_id"),
    action: `marketing.${action}`,
    targetId: target,
  });
}
function mutationBase(p: J, c: DualAuthContext) {
  const t = tenant(c);
  return {
    p_clinic_id: t.clinicId,
    p_actor_id: t.userId,
    p_idempotency_key: uuid(p.idempotency_key, "idempotency_key"),
    p_request_id: c.requestId,
  };
}
function date(v: unknown, n: string) {
  const value = text(v, n, 10, 10);
  if (!DATE.test(value) || Number.isNaN(Date.parse(`${value}T12:00:00Z`))) {
    throw new ApiError(422, `invalid_${n}`, `Confira ${n}.`);
  }
  return value;
}
async function route(req: Request, c: DualAuthContext, p: J) {
  const action = text(p.acao || p.action, "acao", 2, 80);
  const t = tenant(c);
  if (PROTECTED.has(action)) {
    const target = action === "vincular_lancamento"
      ? uuid(p.lancamento_id, "lancamento_id")
      : uuid(p.id || p.vinculo_id || p.indicacao_id || p.campanha_id, "id");
    await proof(req, c, p, action, target);
  }
  let data: unknown;
  switch (action) {
    case "painel":
      data = await rpc("marketing_painel", {
        p_clinic_id: t.clinicId,
        p_actor_id: t.userId,
        p_start: date(p.inicio, "inicio"),
        p_end: date(p.fim, "fim"),
      });
      break;
    case "listar_lancamentos_disponiveis":
      data = await rpc("marketing_listar_lancamentos_disponiveis", {
        p_clinic_id: t.clinicId,
        p_actor_id: t.userId,
        p_kind: text(p.tipo, "tipo", 6, 12),
        p_query: typeof p.query === "string" ? p.query.trim().slice(0, 120) : "",
        p_limit: num(p.limit, "limit", 1, 100, 50),
        p_offset: num(p.offset, "offset", 0, 100000, 0),
      });
      break;
    case "listar_campanhas":
      data = await rpc("marketing_listar", {
        p_clinic_id: t.clinicId,
        p_actor_id: t.userId,
        p_kind: "campanhas",
        p_limit: num(p.limit, "limit", 1, 200, 100),
        p_offset: num(p.offset, "offset", 0, 100000, 0),
      });
      break;
    case "listar_vinculos":
    case "listar_indicacoes":
    case "listar_conteudos":
      data = await rpc("marketing_listar", {
        p_clinic_id: t.clinicId,
        p_actor_id: t.userId,
        p_kind: action.replace("listar_", ""),
        p_limit: num(p.limit, "limit", 1, 200, 100),
        p_offset: num(p.offset, "offset", 0, 100000, 0),
      });
      break;
    case "salvar_campanha":
      data = await rpc("marketing_salvar_campanha", {
        ...mutationBase(p, c),
        p_id: optUuid(p.id, "id"),
        p_expected_version: num(p.expected_version, "expected_version", 0, 2147483647, 0),
        p_payload: obj(p.payload) ? p.payload : {},
      });
      break;
    case "arquivar_campanha":
      data = await rpc("marketing_arquivar_campanha", {
        ...mutationBase(p, c),
        p_id: uuid(p.id, "id"),
        p_expected_version: num(p.expected_version, "expected_version", 1, 2147483647, 1),
        p_reason: text(p.motivo, "motivo", 3, 500),
      });
      break;
    case "vincular_lancamento":
      data = await rpc("marketing_vincular_lancamento", {
        ...mutationBase(p, c),
        p_campaign_id: uuid(p.campanha_id, "campanha_id"),
        p_entry_id: uuid(p.lancamento_id, "lancamento_id"),
        p_link_kind: text(p.tipo, "tipo", 6, 12),
        p_lead_id: optUuid(p.lead_id, "lead_id"),
        p_reason: text(p.motivo, "motivo", 3, 500),
      });
      break;
    case "cancelar_vinculo":
      data = await rpc("marketing_cancelar_vinculo", {
        ...mutationBase(p, c),
        p_id: uuid(p.vinculo_id, "vinculo_id"),
        p_expected_version: num(p.expected_version, "expected_version", 1, 2147483647, 1),
        p_reason: text(p.motivo, "motivo", 3, 500),
      });
      break;
    case "salvar_indicacao":
      data = await rpc("marketing_salvar_indicacao", {
        ...mutationBase(p, c),
        p_id: optUuid(p.id, "id"),
        p_expected_version: num(p.expected_version, "expected_version", 0, 2147483647, 0),
        p_payload: obj(p.payload) ? p.payload : {},
      });
      break;
    case "cancelar_indicacao":
      data = await rpc("marketing_cancelar_indicacao", {
        ...mutationBase(p, c),
        p_id: uuid(p.id || p.indicacao_id, "indicacao_id"),
        p_expected_version: num(p.expected_version, "expected_version", 1, 2147483647, 1),
        p_reason: text(p.motivo, "motivo", 3, 500),
      });
      break;
    case "salvar_conteudo":
      data = await rpc("marketing_salvar_conteudo", {
        ...mutationBase(p, c),
        p_id: optUuid(p.id, "id"),
        p_expected_version: num(p.expected_version, "expected_version", 0, 2147483647, 0),
        p_payload: obj(p.payload) ? p.payload : {},
      });
      break;
    case "arquivar_conteudo":
      data = await rpc("marketing_arquivar_conteudo", {
        ...mutationBase(p, c),
        p_id: uuid(p.id, "id"),
        p_expected_version: num(p.expected_version, "expected_version", 1, 2147483647, 1),
        p_reason: text(p.motivo, "motivo", 3, 500),
      });
      break;
    default:
      throw new ApiError(422, "invalid_action", "Ação inválida.");
  }
  let result = obj(data) ? data : { itens: Array.isArray(data) ? data : [] };
  if (action === "listar_lancamentos_disponiveis") {
    const pagination = obj(result.paginacao) ? result.paginacao : {};
    result = {
      ...result,
      leads_elegiveis: Array.isArray(result.leads_elegiveis) ? result.leads_elegiveis : [],
      paginacao: { ...pagination, has_more: pagination.has_more === true },
    };
  }
  return json(req, {
    ...authResponseFields(c),
    ...result,
    mensagens_automaticas: false,
    publicacao_automatica: false,
  });
}
export async function handleRequest(req: Request): Promise<Response> {
  try {
    if (!cors(req.headers.get("origin"))) {
      return json(req, { erro: "Origem não permitida.", codigo: "origin_forbidden" }, 403);
    }
    if (req.method === "OPTIONS") {
      const h = headers(req);
      h.set("Access-Control-Allow-Methods", "POST, OPTIONS");
      h.set("Access-Control-Allow-Headers", "authorization, content-type, x-amj-reauthentication");
      return new Response(null, { status: 204, headers: h });
    }
    if (req.method !== "POST") {
      throw new ApiError(405, "method_not_allowed", "Método não permitido.");
    }
    const c = await authenticateDual(req, CFG);
    // Preserve the existing UTF-16 text limit, including its valid Unicode/BOM
    // inputs, while bounding the UTF-8 representation before decoding.
    const raw = new TextDecoder().decode(await readLimitedBody(req, 3 * 65536 + 3));
    if (raw.length > 65536) throw new ApiError(413, "body_too_large", "Solicitação muito grande.");
    const p = JSON.parse(raw);
    if (!obj(p)) throw new Error();
    return await route(req, c, p);
  } catch (e) {
    if (e instanceof RequestBodyTooLargeError) {
      return json(req, { erro: "Solicitação muito grande.", codigo: "body_too_large" }, 413);
    }
    if (e instanceof ApiError) {
      return json(req, { erro: e.publicMessage, codigo: e.code }, e.status);
    }
    if (e instanceof DualAuthError) {
      return json(req, { erro: e.publicMessage, codigo: e.code }, e.status);
    }
    return json(req, { erro: "Solicitação inválida.", codigo: "invalid_request" }, 400);
  }
}
if (import.meta.main) Deno.serve(handleRequest);

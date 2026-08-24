import "@supabase/functions-js/edge-runtime.d.ts";
import {
  authenticateDual,
  authResponseFields,
  DualAuthConfig,
  DualAuthContext,
  DualAuthError,
  requireRecentPasswordProof,
  writeClinicAudit,
} from "../_shared/dual-auth.ts";

const URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const AUTH_CONFIG: DualAuthConfig = {
  supabaseUrl: URL,
  serviceRoleKey: SERVICE,
  allowedRoles: ["owner"],
  requireAal2: true,
};
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

const DELETION_CATEGORIES = new Set([
  "teste",
  "duplicada",
  "erro_cadastral",
  "solicitacao_validada",
]);

interface StorageDeletionTarget {
  bucket: "fichas-pdf" | "documentos-clinicos";
  path: string;
}

interface DeletionBlocker {
  codigo: string;
  descricao: string;
  quantidade: number;
}

class StorageDeletionError extends Error {
  constructor(readonly status: number) {
    super("storage_deletion_failed");
    this.name = "StorageDeletionError";
  }
}

const attempts = new Map<string, { count: number; resetAt: number }>();
const requestAuth = new WeakMap<Request, DualAuthContext>();

function cors(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") || "";
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.has(origin)
      ? origin
      : "https://anamariajacob.com.br",
    "Access-Control-Allow-Headers":
      "authorization, apikey, content-type, x-client-info, x-amj-reauthentication",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

function json(req: Request, body: unknown, status = 200): Response {
  const context = requestAuth.get(req);
  const responseBody = context && body && typeof body === "object" && !Array.isArray(body)
    ? { ...(body as Record<string, unknown>), ...authResponseFields(context) }
    : body;
  return new Response(JSON.stringify(responseBody), {
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

async function signedLinks(
  bucket: string,
  paths: string[],
): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  if (!paths.length) return result;
  const response = await admin("/storage/v1/object/sign/" + bucket, {
    method: "POST",
    body: JSON.stringify({ expiresIn: 900, paths }),
  });
  if (!response.ok) return result;
  for (const item of await response.json()) {
    if (item.signedURL && item.path) {
      result[item.path] = URL + "/storage/v1" + item.signedURL;
    }
  }
  return result;
}

function safeText(value: unknown, max = 300): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function validUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(value);
}

function safePdfPath(value: unknown): string {
  const path = safeText(value, 500).trim();
  if (
    !path || path.startsWith("/") || path.includes("..") ||
    !path.toLowerCase().endsWith(".pdf")
  ) return "";
  return path;
}

function deletionBlockers(value: unknown): DeletionBlocker[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 20).flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const row = item as Record<string, unknown>;
    const codigo = safeText(row.codigo, 80).replace(/[^a-z0-9_]/g, "");
    const descricao = safeText(row.descricao, 240).trim();
    const rawQuantity = typeof row.quantidade === "number"
      ? row.quantidade
      : Number(row.quantidade);
    if (!codigo || !descricao || !Number.isFinite(rawQuantity)) return [];
    return [{
      codigo,
      descricao,
      quantidade: Math.max(1, Math.min(1_000_000, Math.trunc(rawQuantity))),
    }];
  });
}

function storageDeletionTargets(
  value: unknown,
  source: string,
): StorageDeletionTarget[] | null {
  if (!Array.isArray(value) || value.length > 4) return null;
  const expectedBucket = source === "anamnese" ? "fichas-pdf" : "documentos-clinicos";
  const seen = new Set<string>();
  const targets: StorageDeletionTarget[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const row = item as Record<string, unknown>;
    const bucket = safeText(row.bucket, 40);
    const path = safeText(row.path, 500).trim();
    const segments = path.split("/");
    if (
      bucket !== expectedBucket || !path || path.startsWith("/") ||
      path.includes("\\") || [...path].some((character) => {
        const code = character.charCodeAt(0);
        return code < 32 || code === 127;
      }) ||
      segments.some((segment) => !segment || segment === "." || segment === "..") ||
      !/\.(pdf|png)$/i.test(path)
    ) return null;
    const key = bucket + "\n" + path;
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push({
      bucket: bucket as StorageDeletionTarget["bucket"],
      path,
    });
  }
  return targets;
}

async function removeStorageTargets(
  targets: StorageDeletionTarget[],
): Promise<number> {
  const grouped = new Map<StorageDeletionTarget["bucket"], string[]>();
  for (const target of targets) {
    const paths = grouped.get(target.bucket) || [];
    paths.push(target.path);
    grouped.set(target.bucket, paths);
  }
  for (const [bucket, paths] of grouped.entries()) {
    // Endpoint usado por supabase-js storage.from(bucket).remove(paths).
    const response = await admin(
      "/storage/v1/object/" + encodeURIComponent(bucket),
      {
        method: "DELETE",
        body: JSON.stringify({ prefixes: paths }),
      },
    );
    if (!response.ok) throw new StorageDeletionError(response.status);
  }
  return targets.length;
}

function legacyNameKey(value: unknown): string {
  return safeText(value, 300)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function findLegacyPdf(
  names: string[],
  marker: string,
  patientName: unknown,
): string | null {
  if (!marker) return null;
  const matches = names.filter((name) =>
    name.toLowerCase().endsWith(".pdf") && name.includes(marker)
  );
  if (matches.length <= 1) return matches[0] || null;

  const patientKey = legacyNameKey(patientName);
  return matches.find((name) => patientKey && legacyNameKey(name).includes(patientKey)) ||
    matches[0];
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin") || "";
  if (req.method === "OPTIONS") {
    if (origin && !ALLOWED_ORIGINS.has(origin)) {
      return new Response(null, { status: 403 });
    }
    return new Response(null, { status: 204, headers: cors(req) });
  }
  if (req.method !== "POST") {
    return json(req, { erro: "Método não permitido" }, 405);
  }
  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    return json(req, { erro: "Origem não permitida" }, 403);
  }
  if (!URL || !SERVICE) {
    console.error("Painel backend environment is not configured");
    return json(req, { erro: "Acesso temporariamente indisponível" }, 503);
  }

  const bearerPresent = Boolean(
    (req.headers.get("authorization") || "").trim(),
  );
  const ip = req.headers.get("cf-connecting-ip") ||
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const now = Date.now();
  const record = attempts.get(ip);
  if (!bearerPresent && record && record.resetAt > now && record.count >= 12) {
    return json(
      req,
      { erro: "Muitas tentativas. Aguarde alguns minutos." },
      429,
    );
  }

  let authContext: DualAuthContext;
  try {
    authContext = await authenticateDual(req, AUTH_CONFIG);
  } catch (error) {
    if (error instanceof DualAuthError) {
      if (!bearerPresent && error.code === "invalid_password") {
        const current = record && record.resetAt > now
          ? record
          : { count: 0, resetAt: now + 10 * 60_000 };
        current.count++;
        attempts.set(ip, current);
        await new Promise((resolve) => setTimeout(resolve, 700));
      }
      if (error.auditContext) {
        requestAuth.set(req, error.auditContext);
        await writeClinicAudit(AUTH_CONFIG, error.auditContext, {
          entity: "access",
          action: "authenticate",
          outcome: "denied",
          details: { endpoint: "painel-fichas", reason_code: error.code },
        });
      }
      return json(
        req,
        { erro: error.publicMessage, codigo: error.code },
        error.status,
      );
    }
    console.error("Painel authentication failed");
    return json(req, { erro: "Acesso temporariamente indisponível" }, 503);
  }
  requestAuth.set(req, authContext);
  if (!bearerPresent) attempts.delete(ip);

  try {
    const rawBody = await req.text();
    if (rawBody.length > 8192) {
      return json(req, { erro: "Requisição muito grande" }, 413);
    }
    if (
      rawBody &&
      !(req.headers.get("content-type") || "").toLowerCase().includes(
        "application/json",
      )
    ) {
      return json(req, { erro: "Conteúdo inválido" }, 415);
    }

    let payload: Record<string, unknown> = {};
    if (rawBody) {
      try {
        const parsed = JSON.parse(rawBody);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          return json(req, { erro: "Dados inválidos" }, 400);
        }
        payload = parsed;
      } catch {
        return json(req, { erro: "JSON inválido" }, 400);
      }
    }

    const action = safeText(payload.acao, 30);
    if (action === "arquivar" || action === "restaurar") {
      const source = safeText(payload.origem, 30);
      const documentId = safeText(payload.documento_id, 40);
      const operationId = safeText(payload.operation_id, 40);
      const reason = safeText(payload.motivo, 500).trim();
      if (
        !["anamnese", "documento_clinico"].includes(source) ||
        !validUuid(documentId) ||
        !validUuid(operationId) ||
        reason.length < 3
      ) {
        await writeClinicAudit(AUTH_CONFIG, authContext, {
          entity: "clinical_records",
          action: "validate_request",
          outcome: "error",
          details: {
            endpoint: "painel-fichas",
            reason_code: "invalid_archive_request",
          },
        });
        return json(
          req,
          { erro: "Informe a ficha e o motivo corretamente." },
          422,
        );
      }
      const operationAuditContext: DualAuthContext = {
        ...authContext,
        requestId: operationId,
      };
      try {
        await requireRecentPasswordProof(req, AUTH_CONFIG, authContext, {
          operationId,
          action: `painel.${source}.${action}`,
          targetId: documentId,
        });
      } catch (error) {
        if (!(error instanceof DualAuthError)) throw error;
        await writeClinicAudit(AUTH_CONFIG, operationAuditContext, {
          entity: source === "anamnese" ? "anamnese" : "documento_clinico",
          entityId: documentId,
          action,
          outcome: "denied",
          details: { endpoint: "painel-fichas", reason_code: error.code },
        });
        return json(
          req,
          {
            erro: error.publicMessage,
            codigo: error.code,
          },
          error.status,
        );
      }

      const archiveResponse = await admin(
        "/rest/v1/rpc/painel_arquivar_ficha",
        {
          method: "POST",
          body: JSON.stringify({
            p_origem: source,
            p_documento_id: documentId,
            p_acao: action,
            p_motivo: reason,
          }),
        },
      );
      if (!archiveResponse.ok) {
        console.error("Painel archive action failed", archiveResponse.status);
        await writeClinicAudit(AUTH_CONFIG, operationAuditContext, {
          entity: source === "anamnese" ? "anamnese" : "documento_clinico",
          entityId: documentId,
          action,
          outcome: "error",
          details: {
            endpoint: "painel-fichas",
            status_code: archiveResponse.status,
          },
        });
        return json(
          req,
          {
            erro: archiveResponse.status === 404
              ? "Ficha não encontrada."
              : "Não foi possível atualizar a ficha agora.",
          },
          archiveResponse.status === 404 ? 404 : 409,
        );
      }
      const result = await archiveResponse.json();
      await writeClinicAudit(AUTH_CONFIG, operationAuditContext, {
        entity: source === "anamnese" ? "anamnese" : "documento_clinico",
        entityId: documentId,
        action,
        outcome: "success",
        details: { endpoint: "painel-fichas", target_kind: source },
      });
      return json(req, {
        ok: true,
        alterado: result?.alterado === true,
        arquivado: result?.arquivado === true,
      });
    }
    if (action === "excluir_definitivamente") {
      const source = safeText(payload.origem, 30);
      const documentId = safeText(payload.documento_id, 40);
      const operationId = safeText(payload.operation_id, 40);
      const category = safeText(payload.categoria, 40);
      const rawReason = typeof payload.motivo === "string" ? payload.motivo : "";
      const reason = rawReason.trim();
      const confirmation = safeText(payload.confirmacao, 20);
      if (
        !["anamnese", "documento_clinico"].includes(source) ||
        !validUuid(documentId) || !validUuid(operationId) ||
        !DELETION_CATEGORIES.has(category) ||
        rawReason.length > 500 || reason.length < 10 || reason.length > 500 ||
        confirmation !== "EXCLUIR"
      ) {
        await writeClinicAudit(AUTH_CONFIG, authContext, {
          entity: "clinical_record_deletion",
          action: "validate_request",
          outcome: "error",
          details: {
            endpoint: "painel-fichas",
            reason_code: "invalid_permanent_deletion_request",
          },
        });
        return json(req, {
          erro:
            "Escolha a categoria, informe um motivo com pelo menos 10 caracteres e digite EXCLUIR.",
          codigo: "invalid_permanent_deletion_request",
        }, 422);
      }
      if (
        authContext.authMethod !== "supabase_auth" ||
        authContext.role !== "owner" || authContext.aal !== "aal2" ||
        !authContext.userId || !authContext.clinicId
      ) {
        return json(req, {
          erro: "A exclusão definitiva exige conta de proprietário com MFA confirmado.",
          codigo: "owner_aal2_required",
        }, 403);
      }

      const operationAuditContext: DualAuthContext = {
        ...authContext,
        requestId: operationId,
      };
      try {
        await requireRecentPasswordProof(req, AUTH_CONFIG, authContext, {
          operationId,
          action: `painel.${source}.excluir_definitivamente`,
          targetId: documentId,
        });
      } catch (error) {
        if (!(error instanceof DualAuthError)) throw error;
        await writeClinicAudit(AUTH_CONFIG, operationAuditContext, {
          entity: "clinical_record_deletion",
          action: "delete_permanently",
          outcome: "denied",
          details: { endpoint: "painel-fichas", reason_code: error.code },
        });
        return json(req, {
          erro: error.publicMessage,
          codigo: error.code,
        }, error.status);
      }

      const prepareResponse = await admin(
        "/rest/v1/rpc/painel_preparar_exclusao_ficha",
        {
          method: "POST",
          body: JSON.stringify({
            p_clinic_id: authContext.clinicId,
            p_actor_user_id: authContext.userId,
            p_origem: source,
            p_documento_id: documentId,
            p_categoria: category,
            p_motivo: reason,
            p_confirmacao: confirmation,
            p_operation_id: operationId,
            p_request_id: authContext.requestId,
          }),
        },
      );
      if (!prepareResponse.ok) {
        const errorBody = await prepareResponse.json().catch(() => ({})) as Record<string, unknown>;
        const databaseCode = safeText(errorBody.code, 20);
        const notFound = databaseCode === "P0002";
        console.error(
          "Permanent clinical record deletion prepare failed",
          prepareResponse.status,
          databaseCode || "unknown",
        );
        await writeClinicAudit(AUTH_CONFIG, operationAuditContext, {
          entity: "clinical_record_deletion",
          action: "prepare",
          outcome: "error",
          details: {
            endpoint: "painel-fichas",
            reason_code: notFound ? "record_not_found" : "prepare_failed",
            status_code: prepareResponse.status,
          },
        });
        return json(req, {
          erro: notFound
            ? "Ficha não encontrada. Atualize a lista e confira novamente."
            : "Não foi possível verificar a elegibilidade da ficha agora.",
          codigo: notFound ? "record_not_found" : "deletion_prepare_failed",
        }, notFound ? 404 : 409);
      }

      const prepared = await prepareResponse.json() as Record<string, unknown>;
      if (prepared.deleted === true) {
        await writeClinicAudit(AUTH_CONFIG, operationAuditContext, {
          entity: "clinical_record_deletion",
          action: "delete_permanently",
          outcome: "success",
          details: {
            endpoint: "painel-fichas",
            target_kind: source,
            idempotent: true,
          },
        });
        return json(req, { ok: true, excluido: true, idempotente: true });
      }
      if (prepared.eligible !== true) {
        const blockers = deletionBlockers(prepared.blockers);
        await writeClinicAudit(AUTH_CONFIG, operationAuditContext, {
          entity: "clinical_record_deletion",
          action: "delete_permanently",
          outcome: "denied",
          details: {
            endpoint: "painel-fichas",
            reason_code: "retention_links_present",
            result_count: blockers.length,
          },
        });
        return json(req, {
          erro:
            "Esta ficha não pode ser excluída porque possui vínculos que precisam ser preservados.",
          codigo: "record_not_eligible",
          vinculos_impeditivos: blockers,
        }, 409);
      }

      const storageTargets = storageDeletionTargets(prepared.storage, source);
      if (!storageTargets) {
        await writeClinicAudit(AUTH_CONFIG, operationAuditContext, {
          entity: "clinical_record_deletion",
          action: "delete_permanently",
          outcome: "error",
          details: {
            endpoint: "painel-fichas",
            reason_code: "invalid_storage_metadata",
          },
        });
        return json(req, {
          erro:
            "Os arquivos da ficha não passaram na validação de segurança. Nenhum registro foi excluído.",
          codigo: "invalid_storage_metadata",
        }, 409);
      }

      let removedCount: number;
      try {
        removedCount = await removeStorageTargets(storageTargets);
      } catch (error) {
        const status = error instanceof StorageDeletionError ? error.status : 500;
        console.error("Permanent clinical record storage cleanup failed", status);
        await writeClinicAudit(AUTH_CONFIG, operationAuditContext, {
          entity: "clinical_record_deletion",
          action: "delete_storage",
          outcome: "error",
          details: {
            endpoint: "painel-fichas",
            reason_code: "storage_cleanup_failed",
            status_code: status,
          },
        });
        return json(req, {
          erro:
            "Não foi possível remover todos os arquivos privados. A ficha não foi excluída do cadastro; tente novamente.",
          codigo: "storage_cleanup_failed",
        }, 503);
      }

      const finishResponse = await admin(
        "/rest/v1/rpc/painel_concluir_exclusao_ficha",
        {
          method: "POST",
          body: JSON.stringify({
            p_clinic_id: authContext.clinicId,
            p_actor_user_id: authContext.userId,
            p_origem: source,
            p_documento_id: documentId,
            p_categoria: category,
            p_operation_id: operationId,
            p_request_id: authContext.requestId,
            p_objetos_storage_removidos: removedCount,
          }),
        },
      );
      if (!finishResponse.ok) {
        const errorBody = await finishResponse.json().catch(() => ({})) as Record<string, unknown>;
        const databaseCode = safeText(errorBody.code, 20);
        console.error(
          "Permanent clinical record deletion finish failed",
          finishResponse.status,
          databaseCode || "unknown",
        );
        await writeClinicAudit(AUTH_CONFIG, operationAuditContext, {
          entity: "clinical_record_deletion",
          action: "finish",
          outcome: "error",
          details: {
            endpoint: "painel-fichas",
            reason_code: "finish_failed",
            status_code: finishResponse.status,
          },
        });
        return json(req, {
          erro:
            "Os arquivos foram removidos, mas a conclusão no cadastro precisa ser repetida. Não restaure nem altere esta ficha; tente excluir novamente.",
          codigo: "deletion_finish_retry_required",
        }, 503);
      }

      const finished = await finishResponse.json() as Record<string, unknown>;
      await writeClinicAudit(AUTH_CONFIG, operationAuditContext, {
        entity: "clinical_record_deletion",
        action: "delete_permanently",
        outcome: "success",
        details: {
          endpoint: "painel-fichas",
          target_kind: source,
          idempotent: finished.idempotent === true,
          result_count: removedCount,
        },
      });
      return json(req, {
        ok: true,
        excluido: finished.deleted === true,
        idempotente: finished.idempotent === true,
      });
    }
    if (action && action !== "listar") {
      await writeClinicAudit(AUTH_CONFIG, authContext, {
        entity: "clinical_records",
        action: "validate_request",
        outcome: "error",
        details: { endpoint: "painel-fichas", reason_code: "invalid_action" },
      });
      return json(req, { erro: "Ação inválida" }, 422);
    }

    // Resposta original da anamnese, preservada integralmente.
    const formsResponse = await admin("/rest/v1/anamneses_resumo?select=*");
    if (!formsResponse.ok) {
      throw new Error("anamneses_read_" + formsResponse.status);
    }
    const rawForms = await formsResponse.json();

    const filesResponse = await admin("/storage/v1/object/list/fichas-pdf", {
      method: "POST",
      body: JSON.stringify({
        prefix: "",
        limit: 500,
        sortBy: { column: "name", order: "desc" },
      }),
    });
    const files = filesResponse.ok ? await filesResponse.json() : [];
    const names = files.map((item: { name?: string }) => item.name).filter(
      Boolean,
    );
    const codesResponse = await admin(
      "/rest/v1/anamneses?select=id,codigo_verificacao,arquivado_em,arquivado_motivo,pdf_path,status" +
        "&status=in.(legado,recebido)",
    );
    if (!codesResponse.ok) {
      throw new Error("anamneses_meta_read_" + codesResponse.status);
    }
    const codes = codesResponse.ok ? await codesResponse.json() : [];
    const formMetaById: Record<string, {
      marker: string;
      archivedAt: string | null;
      archiveReason: string | null;
      pdfPath: string;
      status: "legado" | "recebido";
    }> = {};
    for (const item of codes as Array<Record<string, unknown>>) {
      const id = safeText(item.id, 40);
      const status = safeText(item.status, 20);
      if (!id || (status !== "legado" && status !== "recebido")) continue;
      formMetaById[id] = {
        marker: safeText(item.codigo_verificacao, 64).slice(0, 8),
        archivedAt: safeText(item.arquivado_em, 40) || null,
        archiveReason: safeText(item.arquivado_motivo, 500) || null,
        pdfPath: safePdfPath(item.pdf_path),
        status,
      };
    }

    const forms = (rawForms as Array<Record<string, unknown>>).filter((form) =>
      Boolean(formMetaById[safeText(form.id, 40)])
    );
    const formPdfPaths: Record<string, string> = {};
    for (const form of forms) {
      const id = safeText(form.id, 40);
      const metadata = formMetaById[id];
      const marker = metadata?.marker;
      const legacyPath = metadata?.status === "legado"
        ? findLegacyPdf(names, marker, form.nome)
        : null;
      const pdfPath = metadata?.pdfPath || legacyPath || "";
      if (pdfPath) formPdfPaths[id] = pdfPath;
      form.status = metadata.status;
      form.pdf_nome = pdfPath || null;
      form.arquivado_em = metadata?.archivedAt || null;
      form.arquivado_motivo = metadata?.archiveReason || null;
    }
    const formLinks = await signedLinks(
      "fichas-pdf",
      [...new Set(Object.values(formPdfPaths))],
    );
    for (const form of forms) {
      const path = formPdfPaths[safeText(form.id, 40)] || "";
      form.pdf = path ? formLinks[path] || null : null;
    }

    // Nova coleção: apenas resumo do TCLE, nunca o JSON clínico completo.
    const documentsResponse = await admin(
      "/rest/v1/documentos_clinicos?select=id,tipo,versao_termo,nome,telefone,recebido_em,codigo_verificacao,pdf_path,revisado,dados,status,arquivado_em,arquivado_motivo" +
        "&status=eq.recebido&order=recebido_em.desc",
    );
    if (!documentsResponse.ok) {
      throw new Error("documents_read_" + documentsResponse.status);
    }
    const documentRows = await documentsResponse.json();
    const documentPaths = documentRows.map((item: { pdf_path?: string }) => item.pdf_path).filter(
      Boolean,
    );
    const documentLinks = await signedLinks(
      "documentos-clinicos",
      documentPaths,
    );

    const documents = documentRows.map((row: Record<string, unknown>) => {
      const data = row.dados && typeof row.dados === "object"
        ? row.dados as Record<string, unknown>
        : {};
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
        detalhamento_volume_previsto: safeText(
          procedure.detalhamento_volume_previsto,
          600,
        ),
        detalhamento_plano_previsto: safeText(
          procedure.detalhamento_plano_previsto,
          600,
        ),
        status_anamnese: safeText(procedure.status_anamnese, 40),
        alertas_saude: alerts,
        duvidas: safeText(data.duvidas, 1200),
        arquivado_em: safeText(row.arquivado_em, 40) || null,
        arquivado_motivo: safeText(row.arquivado_motivo, 500) || null,
        pdf: documentLinks[path] || null,
        pdf_nome: path
          ? typeMeta.filename + "-" + safeText(row.codigo_verificacao, 8) +
            ".pdf"
          : null,
      };
    });

    const activeForms = forms.filter((item: { arquivado_em?: string | null }) =>
      !item.arquivado_em
    ).length;
    const activeDocuments = documents.filter((item: { arquivado_em?: string | null }) =>
      !item.arquivado_em
    ).length;
    const archivedForms = forms.length - activeForms;
    const archivedDocuments = documents.length - activeDocuments;

    await writeClinicAudit(AUTH_CONFIG, authContext, {
      entity: "clinical_records",
      action: "list",
      outcome: "success",
      details: {
        endpoint: "painel-fichas",
        result_count: activeForms + activeDocuments,
      },
    });
    return json(req, {
      fichas: forms,
      total: forms.length,
      pdfs: names.length,
      documentos: documents,
      totais: {
        anamneses: activeForms,
        tcles: activeDocuments,
        geral: activeForms + activeDocuments,
        arquivados: archivedForms + archivedDocuments,
      },
    });
  } catch (error) {
    console.error("Painel loading failed", String(error));
    await writeClinicAudit(AUTH_CONFIG, authContext, {
      entity: "clinical_records",
      action: "request",
      outcome: "error",
      details: { endpoint: "painel-fichas", reason_code: "unhandled_error" },
    });
    return json(
      req,
      { erro: "Não foi possível carregar os documentos agora." },
      500,
    );
  }
});

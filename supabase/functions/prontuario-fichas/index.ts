import "jsr:@supabase/functions-js@2.112.3/edge-runtime.d.ts";
import {
  authenticateDual,
  authResponseFields,
  DualAuthConfig,
  DualAuthContext,
  DualAuthError,
  requireRecentPasswordProof,
  writeClinicAudit,
} from "../_shared/dual-auth.ts";

const URL = (Deno.env.get("SUPABASE_URL") || "").replace(/\/+$/, "");
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const AUTH_CONFIG: DualAuthConfig = {
  supabaseUrl: URL,
  serviceRoleKey: SERVICE,
  allowedRoles: ["owner"],
  requireAal2: true,
};

const BUCKET = "clinic-media";
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_THUMBNAIL_BYTES = 1024 * 1024;
const SIGNED_URL_SECONDS = 300;
const MAX_JSON_BYTES = 256 * 1024;
const MAX_MULTIPART_BYTES = MAX_IMAGE_BYTES + MAX_THUMBNAIL_BYTES + 1024 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ALLOWED_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);
const EXTENSION_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};
const ALLOWED_ORIGINS = new Set([
  "https://anamariajacob.com.br",
  "https://www.anamariajacob.com.br",
  "http://127.0.0.1:8765",
  "http://localhost:8765",
]);

type JsonRecord = Record<string, unknown>;

const requestAuth = new WeakMap<Request, DualAuthContext>();

class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly publicMessage: string,
    readonly details: JsonRecord | null = null,
  ) {
    super(publicMessage);
    this.name = "ApiError";
  }
}

function cors(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") || "";
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.has(origin)
      ? origin
      : "https://anamariajacob.com.br",
    "Access-Control-Allow-Headers":
      "authorization, apikey, content-type, x-client-info, x-amj-reauthentication",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "600",
    "Vary": "Origin",
  };
}

function json(req: Request, body: unknown, status = 200): Response {
  const context = requestAuth.get(req);
  const payload = context && body && typeof body === "object" && !Array.isArray(body)
    ? { ...(body as JsonRecord), ...authResponseFields(context) }
    : body;
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...cors(req),
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store, max-age=0",
      "Pragma": "no-cache",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
    },
  });
}

function safeText(value: unknown, max = 500): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function optionalText(value: unknown, max: number): string | null {
  const text = safeText(value, max);
  return text || null;
}

function containsControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
  });
}

function validUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !DATE_PATTERN.test(value)) return false;
  const date = new Date(value + "T00:00:00Z");
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function optionalDate(value: unknown, field: string): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (!validDate(value)) {
    throw new ApiError(422, "invalid_date", `Informe ${field} corretamente.`);
  }
  return value;
}

function positiveInteger(value: unknown, fallback: number, max: number): number {
  if (value === undefined || value === null || value === "") return fallback;
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(number) || number < 1 || number > max) {
    throw new ApiError(422, "invalid_number", "Informe um número válido.");
  }
  return number;
}

function encodePath(path: string): string {
  return path.split("/").map((segment) => encodeURIComponent(segment)).join("/");
}

function sanitizeOriginalName(name: string): string {
  const normalized = [...name.normalize("NFKC")]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f || character === "/" || character === "\\"
        ? "_"
        : character;
    })
    .join("")
    .trim()
    .slice(0, 180);
  return normalized || "imagem-clinica";
}

function tenant(context: DualAuthContext): { clinicId: string; userId: string } {
  if (
    context.authMethod !== "supabase_auth" || context.aal !== "aal2" ||
    !validUuid(context.clinicId) || !validUuid(context.userId) ||
    !["owner", "professional"].includes(context.role)
  ) {
    throw new ApiError(
      403,
      "individual_mfa_required",
      "Entre com sua conta individual e confirme o autenticador.",
    );
  }
  return { clinicId: context.clinicId, userId: context.userId };
}

async function serviceFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers || {});
  headers.set("apikey", SERVICE);
  headers.set("Authorization", "Bearer " + SERVICE);
  return await fetch(URL + path, { ...init, headers });
}

async function readErrorCode(response: Response): Promise<string> {
  try {
    const body = await response.json();
    const message = safeText(body?.message, 160);
    if (/^[a-z0-9_]+$/.test(message)) return message;
    const code = safeText(body?.code, 40);
    return code || "backend_error";
  } catch {
    return "backend_error";
  }
}

const DATABASE_ERROR_MESSAGES: Record<string, string> = {
  actor_or_tenant_missing: "Não foi possível identificar o acesso.",
  tenant_or_actor_missing: "Não foi possível identificar o acesso.",
  individual_auth_required: "Confirme sua conta individual para continuar.",
  role_forbidden: "Seu perfil não permite esta operação.",
  required_parameter_missing: "Preencha os campos obrigatórios.",
  procedure_kind_invalid: "Selecione um procedimento válido.",
  anamnesis_invalid: "Revise os dados clínicos informados.",
  complaint_too_long: "A queixa informada está muito longa.",
  technique_notes_too_long: "As notas técnicas estão muito longas.",
  care_notes_too_long: "As orientações estão muito longas.",
  return_date_invalid: "A data de retorno não pode ser anterior ao procedimento.",
  patient_not_found: "Cliente não encontrado ou arquivado.",
  appointment_not_found: "Agendamento não encontrado.",
  protocol_not_found: "Prontuário não encontrado.",
  protocol_not_found_or_locked: "Prontuário não encontrado ou já finalizado.",
  protocol_locked: "Este prontuário não pode mais ser alterado.",
  version_conflict: "O prontuário foi alterado em outro acesso. Atualize a tela.",
  idempotency_key_reused: "Esta operação já foi usada com dados diferentes.",
  operation_id_reused: "Esta confirmação já foi usada em outra operação.",
  products_invalid: "Revise a lista de produtos utilizados.",
  product_item_invalid: "Revise lote, validade, quantidade e unidade dos produtos.",
  catalog_product_not_found: "Um produto não existe mais no catálogo ativo.",
  catalog_brand_not_found: "A marca vinculada ao produto está indisponível.",
  consents_invalid: "Revise os consentimentos.",
  consent_item_invalid: "Revise os consentimentos.",
  patient_consent_requires_signed_term:
    "Esse consentimento deve vir de um termo assinado pela paciente.",
  marketing_requires_clinical_photography_consent:
    "Uso em divulgação exige também o consentimento de fotografia clínica.",
  clinical_photography_consent_required:
    "Registre o consentimento atual de fotografia clínica para continuar.",
  clinical_photo_required:
    "Adicione ao menos uma foto clínica de antes, durante ou depois para finalizar.",
  last_clinical_photo_required:
    "O prontuário finalizado deve manter ao menos uma foto clínica ativa.",
  archive_reason_invalid: "Informe o motivo do arquivamento.",
  restore_reason_invalid: "Informe o motivo da restauração.",
  photo_removal_reason_invalid: "Informe o motivo da remoção da foto.",
  photo_restore_reason_invalid: "Informe o motivo da restauração da foto.",
  photo_metadata_invalid: "A imagem possui dados inválidos.",
  photo_object_not_found: "O arquivo da imagem não foi confirmado.",
  photo_object_metadata_mismatch: "O arquivo enviado não corresponde aos dados da imagem.",
  photo_thumbnail_object_not_found: "A miniatura privada não foi confirmada.",
  photo_thumbnail_metadata_mismatch: "A miniatura não corresponde aos dados enviados.",
  photo_product_context_invalid: "O produto ou lote não pertence a este procedimento.",
  protocol_product_referenced_by_active_photo:
    "Arquive ou corrija a foto de produto antes de alterar o produto ou lote.",
  photo_attendance_context_invalid: "A foto não pertence a este atendimento.",
  photo_procedure_item_context_invalid: "A foto não pertence a este item de procedimento.",
  photo_operation_link_invalid: "Revise o vínculo da foto com o atendimento.",
  photo_exact_duplicate:
    "Este mesmo arquivo já está neste prontuário. Abra a foto existente ou confirme, com senha e motivo, que este registro é distinto.",
  photo_duplicate_confirmation_stale:
    "A foto existente mudou. Atualize as fotos e tente novamente.",
  photo_not_found: "Foto não encontrada.",
  protocol_archived: "Restaure o prontuário antes de alterar suas fotos.",
};

function statusForDatabaseError(code: string): number {
  if (
    code === "P0002" || code.endsWith("_not_found") ||
    code === "protocol_not_found_or_locked"
  ) return 404;
  if (code === "40001" || code === "23505" || code === "version_conflict") {
    return 409;
  }
  if (
    code === "42501" || code.includes("forbidden") || code.endsWith("_locked") ||
    [
      "individual_auth_required",
      "clinical_photography_consent_required",
      "protocol_archived",
      "signed_protocol_is_immutable",
      "signed_protocol_photo_is_immutable",
      "signed_protocol_consent_is_immutable",
    ].includes(code)
  ) {
    return 403;
  }
  if (
    code === "22023" || code === "23514" || code.includes("invalid") ||
    code === "required_parameter_missing" ||
    code === "patient_consent_requires_signed_term" ||
    code === "marketing_requires_clinical_photography_consent" ||
    code === "clinical_photo_required" ||
    code === "last_clinical_photo_required"
  ) return 422;
  return 409;
}

async function rpc(name: string, body: JsonRecord): Promise<unknown> {
  const response = await serviceFetch("/rest/v1/rpc/" + name, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Prefer": "return=representation",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const code = await readErrorCode(response);
    console.error("Prontuario RPC failed", name, response.status, code);
    throw new ApiError(
      statusForDatabaseError(code),
      code,
      DATABASE_ERROR_MESSAGES[code] || "Não foi possível concluir a operação.",
    );
  }
  return await response.json();
}

async function serviceJson(path: string): Promise<JsonRecord[]> {
  const response = await serviceFetch(path, {
    headers: { "Accept": "application/json" },
  });
  if (!response.ok) {
    console.error("Prontuario query failed", response.status, path.slice(0, 160));
    throw new ApiError(503, "data_unavailable", "Não foi possível carregar os dados agora.");
  }
  const data = await response.json();
  return Array.isArray(data) ? data : [];
}

async function assertPhotoUploadPreflight(
  clinicId: string,
  protocolId: string,
  productId: string | null,
  lotSnapshot: string | null,
): Promise<void> {
  if ((productId === null) !== (lotSnapshot === null)) {
    throw new ApiError(
      422,
      "photo_product_context_invalid",
      DATABASE_ERROR_MESSAGES.photo_product_context_invalid,
    );
  }

  const protocols = await serviceJson(
    "/rest/v1/protocols?select=id,status,archived_at" +
      "&clinic_id=eq." + encodeURIComponent(clinicId) +
      "&id=eq." + encodeURIComponent(protocolId) +
      "&limit=1",
  );
  const protocol = protocols[0];
  if (!protocol) {
    throw new ApiError(
      404,
      "protocol_not_found_or_locked",
      DATABASE_ERROR_MESSAGES.protocol_not_found_or_locked,
    );
  }
  if (protocol.archived_at) {
    throw new ApiError(403, "protocol_archived", DATABASE_ERROR_MESSAGES.protocol_archived);
  }
  if (!["draft", "signed"].includes(safeText(protocol.status, 20))) {
    throw new ApiError(403, "protocol_locked", DATABASE_ERROR_MESSAGES.protocol_locked);
  }

  // O protocolo foi confirmado no tenant antes de consultar a view por ID.
  const currentConsent = await serviceJson(
    "/rest/v1/protocol_consent_current?select=accepted,revoked_at" +
      "&protocol_id=eq." + encodeURIComponent(protocolId) +
      "&kind=eq.clinical_photography&limit=1",
  );
  const consent = currentConsent[0];
  if (!consent || consent.accepted !== true || Boolean(consent.revoked_at)) {
    throw new ApiError(
      403,
      "clinical_photography_consent_required",
      DATABASE_ERROR_MESSAGES.clinical_photography_consent_required,
    );
  }
}

async function assertPhotoProductContextPreflight(
  protocolId: string,
  productId: string | null,
  lotSnapshot: string | null,
): Promise<void> {
  if (productId === null || lotSnapshot === null) return;
  const protocolProducts = await serviceJson(
    "/rest/v1/protocol_products?select=lot" +
      "&protocol_id=eq." + encodeURIComponent(protocolId) +
      "&product_id=eq." + encodeURIComponent(productId) +
      "&limit=101",
  );
  const linkedProductLot = protocolProducts.some((item) => safeText(item.lot, 100) === lotSnapshot);
  if (!linkedProductLot) {
    throw new ApiError(
      422,
      "photo_product_context_invalid",
      DATABASE_ERROR_MESSAGES.photo_product_context_invalid,
    );
  }
}

function validClinicalPhotoPath(path: string, clinicId: string, protocolId: string): boolean {
  const prefix = `${clinicId}/${protocolId}/`;
  return path.startsWith(prefix) && path.length > prefix.length &&
    !path.includes("\\") && !path.split("/").includes("..") &&
    !path.includes("//") && !containsControlCharacter(path);
}

async function signedLinks(
  paths: string[],
  clinicId: string,
  protocolId: string,
): Promise<Record<string, string>> {
  const uniquePaths = [
    ...new Set(paths.filter((path) => validClinicalPhotoPath(path, clinicId, protocolId))),
  ];
  if (!uniquePaths.length) return {};
  const response = await serviceFetch("/storage/v1/object/sign/" + BUCKET, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expiresIn: SIGNED_URL_SECONDS, paths: uniquePaths }),
  });
  if (!response.ok) {
    console.error("Clinical photo signing failed", response.status);
    return {};
  }
  const rows = await response.json();
  const result: Record<string, string> = {};
  if (Array.isArray(rows)) {
    for (const row of rows) {
      const path = safeText(row?.path, 600);
      const signedURL = safeText(row?.signedURL, 2000);
      if (path && signedURL) result[path] = URL + "/storage/v1" + signedURL;
    }
  }
  return result;
}

function mapBy<T extends JsonRecord>(rows: T[], field: string): Map<string, T[]> {
  const result = new Map<string, T[]>();
  for (const row of rows) {
    const key = safeText(row[field], 40);
    if (!key) continue;
    const items = result.get(key) || [];
    items.push(row);
    result.set(key, items);
  }
  return result;
}

async function handleList(
  req: Request,
  context: DualAuthContext,
  payload: JsonRecord,
): Promise<Response> {
  const { clinicId } = tenant(context);
  const protocolId = payload.protocolo_id === undefined ? null : safeText(payload.protocolo_id, 40);
  const patientId = payload.paciente_id === undefined ? null : safeText(payload.paciente_id, 40);
  if (protocolId !== null && !validUuid(protocolId)) {
    throw new ApiError(422, "invalid_protocol", "Prontuário inválido.");
  }
  if (patientId !== null && !validUuid(patientId)) {
    throw new ApiError(422, "invalid_patient", "Cliente inválido.");
  }
  const includeArchived = payload.incluir_arquivados === true;
  const page = positiveInteger(payload.pagina, 1, 100_000);
  const pageSize = positiveInteger(
    payload.por_pagina === undefined ? payload.limite : payload.por_pagina,
    100,
    100,
  );
  const offset = (page - 1) * pageSize;

  const filters = [
    "clinic_id=eq." + clinicId,
    "order=updated_at.desc,id.desc",
    "limit=" + (pageSize + 1),
    "offset=" + offset,
  ];
  if (!includeArchived) filters.push("archived_at=is.null");
  if (protocolId) filters.push("id=eq." + protocolId);
  if (patientId) filters.push("patient_id=eq." + patientId);
  const select = [
    "id",
    "patient_id",
    "professional_id",
    "appointment_id",
    "procedure_kind",
    "complaint",
    "anamnesis",
    "technique_notes",
    "procedure_date",
    "return_date",
    "care_notes",
    "status",
    "version",
    "archived_at",
    "archive_reason",
    "archived_by",
    "created_at",
    "updated_at",
  ].join(",");
  const protocolRows = await serviceJson(
    "/rest/v1/protocols?select=" + select + "&" + filters.join("&"),
  );
  const hasMore = protocolRows.length > pageSize;
  const protocols = protocolRows.slice(0, pageSize);
  const ids = protocols.map((item) => safeText(item.id, 40)).filter(validUuid);
  if (!ids.length) {
    await writeClinicAudit(AUTH_CONFIG, context, {
      entity: "protocol",
      action: "list",
      outcome: "success",
      details: { endpoint: "prontuario-fichas", result_count: 0 },
    });
    return json(req, {
      ok: true,
      protocolos: [],
      paginacao: { pagina: page, por_pagina: pageSize, tem_mais: false },
    });
  }

  const protocolFilter = encodeURIComponent("in.(" + ids.join(",") + ")");
  const patientIds = [
    ...new Set(
      protocols.map((item) => safeText(item.patient_id, 40)).filter(validUuid),
    ),
  ];
  const patientFilter = encodeURIComponent("in.(" + patientIds.join(",") + ")");

  const [products, photoCounts, consents, patients] = await Promise.all([
    serviceJson(
      "/rest/v1/protocol_products?select=id,protocol_id,product_id,brand_id," +
        "product_name_snapshot,brand_name_snapshot,anvisa_registration_snapshot," +
        "lot,expiry,amount,unit,cost_snapshot,position,created_at" +
        "&protocol_id=" + protocolFilter + "&order=position.asc&limit=5000",
    ),
    serviceJson(
      "/rest/v1/protocol_photo_counts?select=protocol_id,total_count,active_count," +
        "archived_count,active_product_count&protocol_id=" + protocolFilter,
    ),
    serviceJson(
      "/rest/v1/protocol_consent_current?select=event_id,protocol_id,kind,term_id," +
        "accepted,accepted_at,revoked_at,recorded_at,recorded_by," +
        "term_version_snapshot,term_sha256_snapshot,supersedes_id" +
        "&protocol_id=" + protocolFilter +
        "&order=protocol_id.asc,kind.asc",
    ),
    serviceJson(
      "/rest/v1/patients?select=id,full_name,status,archived_at" +
        "&clinic_id=eq." + clinicId + "&id=" + patientFilter + "&limit=100",
    ),
  ]);

  const productsByProtocol = mapBy(products, "protocol_id");
  const consentsByProtocol = mapBy(consents, "protocol_id");
  const photoCountByProtocol = new Map(
    photoCounts.map((item) => [safeText(item.protocol_id, 40), item]),
  );
  const patientById = new Map(
    patients.map((patient) => [safeText(patient.id, 40), patient]),
  );

  const result = protocols.map((protocol) => {
    const id = safeText(protocol.id, 40);
    const patient = patientById.get(safeText(protocol.patient_id, 40));
    const photoSummary = photoCountByProtocol.get(id) || {};
    const effectiveConsents = consentsByProtocol.get(id) || [];
    const currentConsents = Object.fromEntries(
      effectiveConsents.map((consent) => [
        safeText(consent.kind, 60),
        consent.accepted === true && !consent.revoked_at,
      ]).filter(([kind]) => Boolean(kind)),
    );
    return {
      ...protocol,
      paciente: patient
        ? {
          id: patient.id,
          nome: patient.full_name,
          status: patient.status,
          arquivado_em: patient.archived_at,
        }
        : null,
      produtos: productsByProtocol.get(id) || [],
      // Imagens e URLs assinadas sao intencionalmente paginadas no endpoint
      // listar_fotos. A listagem principal nunca carrega todos os originais.
      fotos: [],
      fotos_resumo: {
        total: Number(photoSummary.total_count || 0),
        ativas: Number(photoSummary.active_count || 0),
        arquivadas: Number(photoSummary.archived_count || 0),
        produtos_utilizados: Number(photoSummary.active_product_count || 0),
      },
      // Compatibilidade: este array contem somente o evento efetivo de cada
      // tipo. O historico append-only deve ser consultado por endpoint paginado
      // proprio; ele nunca e usado para inferir o estado atual.
      consentimentos: effectiveConsents,
      consentimentos_atuais: currentConsents,
    };
  });

  await writeClinicAudit(AUTH_CONFIG, context, {
    entity: "protocol",
    action: "list",
    outcome: "success",
    details: { endpoint: "prontuario-fichas", result_count: result.length },
  });
  return json(req, {
    ok: true,
    protocolos: result,
    paginacao: { pagina: page, por_pagina: pageSize, tem_mais: hasMore },
  });
}

async function handleListPhotos(
  req: Request,
  context: DualAuthContext,
  payload: JsonRecord,
): Promise<Response> {
  const { clinicId } = tenant(context);
  const protocolId = safeText(payload.protocolo_id, 40);
  if (!validUuid(protocolId)) {
    throw new ApiError(422, "invalid_protocol", "Prontuário inválido.");
  }
  await assertPhotoUploadPreflight(clinicId, protocolId, null, null);
  const page = positiveInteger(payload.pagina, 1, 100_000);
  const pageSize = positiveInteger(payload.por_pagina, 12, 24);
  const includeArchived = payload.incluir_arquivadas === true;
  const offset = (page - 1) * pageSize;
  const archiveFilter = includeArchived ? "" : "&archived_at=is.null";
  const photoRows = await serviceJson(
    "/rest/v1/protocol_photos?select=id,protocol_id,phase,storage_path,taken_at," +
      "mime_type,size_bytes,sha256,original_name,thumbnail_storage_path," +
      "thumbnail_mime_type,thumbnail_size_bytes,thumbnail_sha256,product_id," +
      "lot_snapshot,attendance_id,procedure_item_id,archived_at," +
      "protocols!inner(clinic_id)&protocol_id=eq." + protocolId +
      "&protocols.clinic_id=eq." + clinicId + archiveFilter +
      "&order=taken_at.desc,id.desc&limit=" + (pageSize + 1) + "&offset=" + offset,
  );
  const hasMore = photoRows.length > pageSize;
  const pageRows = photoRows.slice(0, pageSize);
  const paths: string[] = [];
  for (const photo of pageRows) {
    if (photo.archived_at) continue;
    const originalPath = safeText(photo.storage_path, 600);
    const thumbnailPath = safeText(photo.thumbnail_storage_path, 600);
    if (originalPath) paths.push(originalPath);
    if (thumbnailPath) paths.push(thumbnailPath);
  }
  const links = await signedLinks(paths, clinicId, protocolId);
  const photos = pageRows.map((raw) => {
    const photo = { ...raw };
    delete photo.protocols;
    const archived = Boolean(photo.archived_at);
    const originalPath = safeText(photo.storage_path, 600);
    const thumbnailPath = safeText(photo.thumbnail_storage_path, 600);
    return {
      ...photo,
      url_assinada: archived ? null : links[originalPath] || null,
      miniatura_url: archived ? null : links[thumbnailPath] || links[originalPath] || null,
      expira_em_segundos: archived ? null : SIGNED_URL_SECONDS,
    };
  });
  await writeClinicAudit(AUTH_CONFIG, context, {
    entity: "protocol_photo",
    action: "list",
    outcome: "success",
    details: { endpoint: "prontuario-fichas", result_count: photos.length },
  });
  return json(req, {
    ok: true,
    fotos: photos,
    paginacao: { pagina: page, por_pagina: pageSize, tem_mais: hasMore },
  });
}

function normalizeProducts(value: unknown): JsonRecord[] {
  if (!Array.isArray(value) || value.length > 50) {
    throw new ApiError(422, "products_invalid", "Revise os produtos utilizados.");
  }
  const allowedUnits = new Set([
    "U",
    "mL",
    "mg",
    "g",
    "un.",
    "un",
    "cx",
    "frasco",
    "ampola",
    "seringa",
    "canula",
    "kit",
    "dose",
    "aplicacao",
  ]);
  return value.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new ApiError(422, "product_item_invalid", "Revise os produtos utilizados.");
    }
    const item = raw as JsonRecord;
    const productId = safeText(item.product_id, 40);
    const lot = safeText(item.lot, 100);
    const expiry = safeText(item.expiry, 10);
    const amount = typeof item.amount === "number" ? item.amount : Number(item.amount);
    const unit = safeText(item.unit, 20);
    const position = item.position === undefined
      ? index + 1
      : positiveInteger(item.position, index + 1, 100);
    if (
      !validUuid(productId) || !lot || !validDate(expiry) ||
      !Number.isFinite(amount) || amount <= 0 || amount > 1_000_000 ||
      !allowedUnits.has(unit)
    ) {
      throw new ApiError(
        422,
        "product_item_invalid",
        "Revise produto, lote, validade, quantidade e unidade.",
      );
    }
    return {
      product_id: productId,
      lot,
      expiry,
      amount,
      unit,
      position,
    };
  });
}

function normalizeConsents(value: unknown): JsonRecord {
  if (value === undefined || value === null) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(422, "consents_invalid", "Revise os consentimentos.");
  }
  const signedTermOnly = new Set([
    "term_read",
    "data_processing",
    "marketing_use",
  ]);
  const result: JsonRecord = {};
  for (const [key, raw] of Object.entries(value as JsonRecord)) {
    if (typeof raw !== "boolean") {
      throw new ApiError(422, "consent_item_invalid", "Revise os consentimentos.");
    }
    if (key === "clinical_photography") {
      result[key] = raw;
      continue;
    }
    if (signedTermOnly.has(key)) {
      if (raw === true) {
        throw new ApiError(
          422,
          "patient_consent_requires_signed_term",
          DATABASE_ERROR_MESSAGES.patient_consent_requires_signed_term,
        );
      }
      continue;
    }
    throw new ApiError(422, "consent_item_invalid", "Revise os consentimentos.");
  }
  return result;
}

function requiredVersion(value: unknown): number {
  if (value === undefined || value === null || value === "") {
    throw new ApiError(
      422,
      "expected_version_required",
      "Atualize o prontuário e tente novamente.",
    );
  }
  return positiveInteger(value, 1, 2_147_483_647);
}

async function requireProtectedOperation(
  req: Request,
  context: DualAuthContext,
  payload: JsonRecord,
  action: string,
  targetId: string,
): Promise<string> {
  const operationId = safeText(payload.operation_id, 40);
  if (!validUuid(operationId) || !validUuid(targetId)) {
    throw new ApiError(
      422,
      "operation_id_required",
      "Atualize a tela e tente novamente.",
    );
  }
  await requireRecentPasswordProof(req, AUTH_CONFIG, context, {
    operationId,
    action,
    targetId,
  });
  return operationId;
}

async function handleSaveDraft(
  req: Request,
  context: DualAuthContext,
  payload: JsonRecord,
): Promise<Response> {
  const { clinicId, userId } = tenant(context);
  const protocolId = payload.protocolo_id === undefined || payload.protocolo_id === null ||
      payload.protocolo_id === ""
    ? null
    : safeText(payload.protocolo_id, 40);
  if (protocolId !== null && !validUuid(protocolId)) {
    throw new ApiError(422, "invalid_protocol", "Prontuário inválido.");
  }
  const patientId = safeText(payload.paciente_id, 40);
  const appointmentId = payload.agendamento_id === undefined ||
      payload.agendamento_id === null || payload.agendamento_id === ""
    ? null
    : safeText(payload.agendamento_id, 40);
  const idempotencyKey = safeText(payload.idempotency_key, 40);
  if (!validUuid(patientId) || !validUuid(idempotencyKey)) {
    throw new ApiError(422, "required_parameter_missing", "Selecione o cliente.");
  }
  if (appointmentId !== null && !validUuid(appointmentId)) {
    throw new ApiError(422, "invalid_appointment", "Agendamento inválido.");
  }
  const procedureKind = typeof payload.tipo_procedimento === "string"
    ? payload.tipo_procedimento.trim()
    : "";
  if (!procedureKind || procedureKind.length > 120) {
    throw new ApiError(
      422,
      "procedure_kind_invalid",
      DATABASE_ERROR_MESSAGES.procedure_kind_invalid,
    );
  }
  const anamnesis = payload.anamnese === undefined ? {} : payload.anamnese;
  if (!anamnesis || typeof anamnesis !== "object" || Array.isArray(anamnesis)) {
    throw new ApiError(422, "anamnesis_invalid", "Revise os dados clínicos.");
  }
  const products = payload.produtos === undefined && protocolId
    ? null
    : normalizeProducts(payload.produtos ?? []);
  const consents = normalizeConsents(payload.consentimentos);
  const expectedVersion = protocolId ? requiredVersion(payload.versao_esperada) : null;
  const operationId = protocolId
    ? await requireProtectedOperation(
      req,
      context,
      payload,
      "prontuario.update",
      protocolId,
    )
    : idempotencyKey;

  const result = await rpc("prontuario_salvar_rascunho_com_estoque", {
    p_clinic_id: clinicId,
    p_user_id: userId,
    p_actor_role: context.role,
    p_auth_method: context.authMethod,
    p_protocol_id: protocolId,
    p_expected_version: expectedVersion,
    p_idempotency_key: idempotencyKey,
    p_patient_id: patientId,
    p_appointment_id: appointmentId,
    p_procedure_kind: procedureKind,
    p_complaint: optionalText(payload.queixa, 2000),
    p_anamnesis: anamnesis,
    p_technique_notes: optionalText(payload.notas_tecnica, 5000),
    p_procedure_date: optionalDate(payload.data_procedimento, "a data do procedimento"),
    p_return_date: optionalDate(payload.data_retorno, "a data de retorno"),
    p_care_notes: optionalText(payload.orientacoes, 5000),
    p_products: products,
    p_consents: consents,
    p_request_id: operationId,
  }) as JsonRecord;

  return json(req, {
    ok: true,
    protocolo_id: result.id,
    versao: result.version,
    criado: result.created === true,
    idempotente: result.idempotent === true,
    quantidade_produtos: result.product_count || 0,
    quantidade_consentimentos: result.consent_count || 0,
  });
}

async function handleReplaceProducts(
  req: Request,
  context: DualAuthContext,
  payload: JsonRecord,
): Promise<Response> {
  const { clinicId, userId } = tenant(context);
  const protocolId = safeText(payload.protocolo_id, 40);
  if (!validUuid(protocolId)) {
    throw new ApiError(422, "invalid_protocol", "Prontuário inválido.");
  }
  const expectedVersion = requiredVersion(payload.versao_esperada);
  const products = normalizeProducts(payload.produtos);
  const operationId = await requireProtectedOperation(
    req,
    context,
    payload,
    "prontuario.products.replace",
    protocolId,
  );
  const result = await rpc("prontuario_substituir_produtos", {
    p_clinic_id: clinicId,
    p_user_id: userId,
    p_actor_role: context.role,
    p_auth_method: context.authMethod,
    p_protocol_id: protocolId,
    p_expected_version: expectedVersion,
    p_products: products,
    p_request_id: operationId,
  }) as JsonRecord;
  return json(req, {
    ok: true,
    protocolo_id: result.id,
    versao: result.version,
    quantidade_produtos: result.product_count || 0,
  });
}

async function handleFinalize(
  req: Request,
  context: DualAuthContext,
  payload: JsonRecord,
): Promise<Response> {
  const { clinicId, userId } = tenant(context);
  const protocolId = safeText(payload.protocolo_id, 40);
  if (!validUuid(protocolId)) {
    throw new ApiError(422, "invalid_protocol", "Prontuário inválido.");
  }
  const expectedVersion = requiredVersion(payload.versao_esperada);
  const operationId = await requireProtectedOperation(
    req,
    context,
    payload,
    "prontuario.finalize",
    protocolId,
  );
  const result = await rpc("prontuario_finalizar", {
    p_clinic_id: clinicId,
    p_user_id: userId,
    p_actor_role: context.role,
    p_auth_method: context.authMethod,
    p_protocol_id: protocolId,
    p_expected_version: expectedVersion,
    p_request_id: operationId,
  }) as JsonRecord;

  return json(req, {
    ok: true,
    protocolo_id: result.id,
    status: "signed",
    versao: result.version,
    finalizado: true,
    idempotente: result.idempotent === true,
  });
}

async function handlePhotographyConsent(
  req: Request,
  context: DualAuthContext,
  payload: JsonRecord,
): Promise<Response> {
  const { clinicId, userId } = tenant(context);
  const protocolId = safeText(payload.protocolo_id, 40);
  if (!validUuid(protocolId)) {
    throw new ApiError(422, "invalid_protocol", "Prontuário inválido.");
  }
  if (typeof payload.aceito !== "boolean") {
    throw new ApiError(422, "consent_item_invalid", "Informe a decisão sobre as fotografias.");
  }
  const operationId = await requireProtectedOperation(
    req,
    context,
    payload,
    "prontuario.consent.clinical_photography",
    protocolId,
  );
  const result = await rpc("prontuario_alterar_consentimento_fotografia", {
    p_clinic_id: clinicId,
    p_user_id: userId,
    p_actor_role: context.role,
    p_auth_method: context.authMethod,
    p_protocol_id: protocolId,
    p_accepted: payload.aceito,
    p_request_id: operationId,
  }) as JsonRecord;

  return json(req, {
    ok: true,
    protocolo_id: result.id || protocolId,
    consentimento: "clinical_photography",
    aceito: result.accepted === true,
    alterado: result.changed === true,
    versao: result.version,
    idempotente: result.idempotent === true,
  });
}

async function handleArchiveRestore(
  req: Request,
  context: DualAuthContext,
  payload: JsonRecord,
  action: "arquivar" | "restaurar",
): Promise<Response> {
  const { clinicId, userId } = tenant(context);
  if (context.role !== "owner") {
    throw new ApiError(403, "role_forbidden", "Somente os responsáveis podem fazer isso.");
  }
  const protocolId = safeText(payload.protocolo_id, 40);
  const reason = safeText(payload.motivo, 500);
  if (!validUuid(protocolId) || reason.length < 3) {
    throw new ApiError(422, "invalid_archive_request", "Informe prontuário e motivo.");
  }
  const expectedVersion = requiredVersion(payload.versao_esperada);
  const operationId = await requireProtectedOperation(
    req,
    context,
    payload,
    action === "arquivar" ? "prontuario.archive" : "prontuario.restore",
    protocolId,
  );
  const result = await rpc(
    action === "arquivar" ? "prontuario_arquivar" : "prontuario_restaurar",
    {
      p_clinic_id: clinicId,
      p_user_id: userId,
      p_actor_role: context.role,
      p_auth_method: context.authMethod,
      p_protocol_id: protocolId,
      p_expected_version: expectedVersion,
      p_reason: reason,
      p_request_id: operationId,
    },
  ) as JsonRecord;
  return json(req, {
    ok: true,
    protocolo_id: result.id,
    versao: result.version,
    arquivado: result.archived === true,
    idempotente: result.idempotent === true,
  });
}

function validImageMagic(bytes: Uint8Array, mime: string): boolean {
  if (mime === "image/jpeg") {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 &&
      bytes[2] === 0xff;
  }
  if (mime === "image/png") {
    const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    return bytes.length >= signature.length &&
      signature.every((value, index) => bytes[index] === value);
  }
  if (mime === "image/webp") {
    return bytes.length >= 12 &&
      String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
      String.fromCharCode(...bytes.slice(8, 12)) === "WEBP";
  }
  return false;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const exactBytes = new Uint8Array(bytes.byteLength);
  exactBytes.set(bytes);
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", exactBytes.buffer),
  );
  return [...digest].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function findExistingPhoto(
  clinicId: string,
  protocolId: string,
  idempotencyKey: string,
): Promise<JsonRecord | null> {
  const rows = await serviceJson(
    "/rest/v1/protocol_photos?select=id,protocol_id,phase,storage_path,taken_at," +
      "mime_type,size_bytes,sha256,original_name,thumbnail_storage_path," +
      "thumbnail_mime_type,thumbnail_size_bytes,thumbnail_sha256,product_id," +
      "lot_snapshot,attendance_id,procedure_item_id,duplicate_of_photo_id," +
      "duplicate_reason,duplicate_confirmed_at,duplicate_operation_id,archived_at," +
      "protocols!inner(clinic_id)" +
      "&protocol_id=eq." + protocolId +
      "&idempotency_key=eq." + idempotencyKey +
      "&protocols.clinic_id=eq." + clinicId + "&limit=1",
  );
  if (!rows[0]) return null;
  const photo = { ...rows[0] };
  delete photo.protocols;
  return photo;
}

async function findDuplicatePhoto(
  clinicId: string,
  protocolId: string,
  sha256: string,
): Promise<JsonRecord | null> {
  const rows = await serviceJson(
    "/rest/v1/protocol_photos?select=id,protocol_id,phase,storage_path,taken_at," +
      "mime_type,size_bytes,sha256,original_name,thumbnail_storage_path," +
      "thumbnail_mime_type,thumbnail_size_bytes,product_id,lot_snapshot," +
      "attendance_id,procedure_item_id,archived_at,protocols!inner(clinic_id)" +
      "&protocol_id=eq." + protocolId +
      "&sha256=eq." + sha256 +
      "&protocols.clinic_id=eq." + clinicId +
      "&order=taken_at.asc,id.asc&limit=1",
  );
  if (!rows[0]) return null;
  const photo = { ...rows[0] };
  delete photo.protocols;
  return photo;
}

async function presentStoredPhoto(photo: JsonRecord, clinicId: string): Promise<JsonRecord> {
  const originalPath = safeText(photo.storage_path, 600);
  const thumbnailPath = safeText(photo.thumbnail_storage_path, 600);
  const archived = Boolean(photo.archived_at);
  const protocolId = safeText(photo.protocol_id, 40);
  const links = archived || !validUuid(protocolId)
    ? {}
    : await signedLinks([originalPath, thumbnailPath], clinicId, protocolId);
  return {
    id: photo.id,
    protocolo_id: photo.protocol_id,
    fase: photo.phase,
    tirada_em: photo.taken_at,
    mime_type: photo.mime_type,
    size_bytes: photo.size_bytes,
    sha256: photo.sha256,
    original_name: photo.original_name,
    produto_id: photo.product_id,
    lote: photo.lot_snapshot,
    atendimento_id: photo.attendance_id,
    item_procedimento_id: photo.procedure_item_id,
    duplicate_of_photo_id: photo.duplicate_of_photo_id || null,
    duplicidade_confirmada: photo.duplicate_confirmed === true ||
      Boolean(photo.duplicate_confirmed_at),
    arquivada: archived,
    url_assinada: archived ? null : links[originalPath] || null,
    miniatura_url: archived ? null : links[thumbnailPath] || links[originalPath] || null,
    expira_em_segundos: archived ? null : SIGNED_URL_SECONDS,
  };
}

async function uploadPrivateImage(path: string, file: File): Promise<Response> {
  return await serviceFetch("/storage/v1/object/" + BUCKET + "/" + encodePath(path), {
    method: "POST",
    headers: {
      "Content-Type": file.type,
      "Cache-Control": "private, max-age=0, no-store",
      "x-upsert": "false",
    },
    body: file,
  });
}

async function queueOrphanPhotoObjects(
  context: DualAuthContext,
  protocolId: string,
  photoId: string,
  storagePath: string,
  thumbnailPath: string | null,
  reasonCode: "metadata_rejected" | "thumbnail_failed",
): Promise<void> {
  const { clinicId, userId } = tenant(context);
  try {
    await rpc("prontuario_enfileirar_gc_foto_orfa", {
      p_clinic_id: clinicId,
      p_user_id: userId,
      p_actor_role: context.role,
      p_auth_method: context.authMethod,
      p_protocol_id: protocolId,
      p_photo_id: photoId,
      p_storage_path: storagePath,
      p_thumbnail_storage_path: thumbnailPath,
      p_reason_code: reasonCode,
      p_request_id: photoId,
    });
  } catch (error) {
    console.error(
      "Clinical photo GC enqueue failed",
      error instanceof Error ? error.name : "error",
    );
  }
}

async function privateImageMatches(
  path: string,
  file: File,
  sha256: string,
): Promise<"match" | "missing" | "mismatch"> {
  const response = await serviceFetch(
    "/storage/v1/object/authenticated/" + BUCKET + "/" + encodePath(path),
    { method: "GET", headers: { Accept: file.type } },
  );
  if (response.status === 404) return "missing";
  if (!response.ok) {
    console.error("Clinical photo reconciliation read failed", response.status);
    throw new ApiError(
      503,
      "photo_reconciliation_unavailable",
      "Não foi possível confirmar uma imagem já enviada. Tente novamente.",
    );
  }
  const storedType = (response.headers.get("content-type") || "").split(";", 1)[0].trim();
  const storedBytes = new Uint8Array(await response.arrayBuffer());
  if (storedType !== file.type || storedBytes.byteLength !== file.size) return "mismatch";
  return await sha256Hex(storedBytes) === sha256 ? "match" : "mismatch";
}

type PhotoIdempotencyExpectation = {
  phase: string;
  takenAt: string;
  storagePath: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  thumbnailStoragePath: string | null;
  thumbnailMimeType: string | null;
  thumbnailSizeBytes: number | null;
  thumbnailSha256: string | null;
  productId: string | null;
  lotSnapshot: string | null;
  attendanceId: string | null;
  procedureItemId: string | null;
  confirmDistinct: boolean;
  duplicateReason: string | null;
  duplicateOperationId: string | null;
};

function assertPhotoIdempotencyMatch(
  existing: JsonRecord,
  expected: PhotoIdempotencyExpectation,
): void {
  const existingThumbnailSize = existing.thumbnail_size_bytes == null
    ? null
    : Number(existing.thumbnail_size_bytes);
  const existingTakenAt = new Date(safeText(existing.taken_at, 40)).getTime();
  if (
    safeText(existing.phase, 20) !== expected.phase ||
    existingTakenAt !== Date.parse(expected.takenAt) ||
    safeText(existing.storage_path, 600) !== expected.storagePath ||
    safeText(existing.mime_type, 80) !== expected.mimeType ||
    Number(existing.size_bytes) !== expected.sizeBytes ||
    safeText(existing.sha256, 64).toLowerCase() !== expected.sha256 ||
    (safeText(existing.thumbnail_storage_path, 600) || null) !==
      expected.thumbnailStoragePath ||
    (safeText(existing.thumbnail_mime_type, 80) || null) !== expected.thumbnailMimeType ||
    existingThumbnailSize !== expected.thumbnailSizeBytes ||
    (safeText(existing.thumbnail_sha256, 64).toLowerCase() || null) !==
      expected.thumbnailSha256 ||
    (safeText(existing.product_id, 40) || null) !== expected.productId ||
    (safeText(existing.lot_snapshot, 100) || null) !== expected.lotSnapshot ||
    (safeText(existing.attendance_id, 40) || null) !== expected.attendanceId ||
    (safeText(existing.procedure_item_id, 40) || null) !== expected.procedureItemId ||
    Boolean(existing.duplicate_confirmed_at) !== expected.confirmDistinct ||
    (safeText(existing.duplicate_reason, 500) || null) !== expected.duplicateReason ||
    (safeText(existing.duplicate_operation_id, 40) || null) !== expected.duplicateOperationId
  ) {
    throw new ApiError(
      409,
      "idempotency_key_reused",
      DATABASE_ERROR_MESSAGES.idempotency_key_reused,
    );
  }
}

async function handleAddPhoto(
  req: Request,
  context: DualAuthContext,
  form: FormData,
): Promise<Response> {
  const { clinicId, userId } = tenant(context);
  const protocolId = safeText(form.get("protocolo_id"), 40);
  const phase = safeText(form.get("fase"), 20);
  const idempotencyKey = safeText(form.get("idempotency_key"), 40);
  const takenAtRaw = safeText(form.get("tirada_em"), 40);
  const productRaw = safeText(form.get("produto_id"), 40);
  const productId = productRaw || null;
  const lotValue = form.get("lote");
  const lotRaw = typeof lotValue === "string" ? lotValue.trim() : "";
  const lotSnapshot = lotRaw || null;
  const attendanceRaw = safeText(form.get("atendimento_id"), 40);
  const attendanceId = attendanceRaw || null;
  const procedureItemRaw = safeText(form.get("item_procedimento_id"), 40);
  const procedureItemId = procedureItemRaw || null;
  const confirmDistinct = ["1", "true", "sim"].includes(
    safeText(form.get("confirmar_arquivo_distinto"), 10).toLowerCase(),
  );
  const duplicateReason = optionalText(
    form.get("motivo_duplicidade") ?? form.get("motivo"),
    500,
  );
  const duplicateOperationRaw = safeText(form.get("operation_id"), 40);
  const duplicateOperationId = duplicateOperationRaw || null;
  const fileValue = form.get("arquivo");
  const thumbnailValue = form.get("miniatura");
  if (
    !validUuid(protocolId) || !validUuid(idempotencyKey) ||
    !["before", "during", "after", "products_used"].includes(phase) ||
    !(fileValue instanceof File) ||
    (productId !== null && !validUuid(productId)) ||
    (attendanceId !== null && !validUuid(attendanceId)) ||
    (procedureItemId !== null && !validUuid(procedureItemId)) ||
    (procedureItemId !== null && attendanceId === null) ||
    (lotSnapshot !== null &&
      (lotSnapshot.length > 100 || containsControlCharacter(lotSnapshot))) ||
    (phase !== "products_used" && (productId !== null || lotSnapshot !== null))
  ) {
    throw new ApiError(
      422,
      "invalid_photo_request",
      "Revise a imagem, a categoria e o produto/lote.",
    );
  }
  const file = fileValue;
  if (!ALLOWED_MIME_TYPES.has(file.type)) {
    throw new ApiError(415, "invalid_mime", "Use uma imagem JPEG, PNG ou WebP.");
  }
  if (file.size < 1 || file.size > MAX_IMAGE_BYTES) {
    throw new ApiError(413, "image_too_large", "A imagem original deve ter no máximo 25 MB.");
  }
  const thumbnail = thumbnailValue instanceof File && thumbnailValue.size > 0
    ? thumbnailValue
    : null;
  if (
    thumbnail &&
    (!ALLOWED_MIME_TYPES.has(thumbnail.type) || thumbnail.size > MAX_THUMBNAIL_BYTES)
  ) {
    throw new ApiError(
      422,
      "invalid_thumbnail",
      "A miniatura deve ser JPEG, PNG ou WebP de até 1 MB.",
    );
  }
  const takenAt = takenAtRaw ? new Date(takenAtRaw) : new Date();
  if (Number.isNaN(takenAt.getTime()) || takenAt.getTime() > Date.now() + 86_400_000) {
    throw new ApiError(422, "invalid_taken_at", "Informe a data da foto corretamente.");
  }

  // Evita gravar até 25 MB no Storage quando o protocolo não está ativo ou a
  // autorização atual foi revogada. O RPC repete a validação sob concorrência.
  await assertPhotoUploadPreflight(
    clinicId,
    protocolId,
    productId,
    lotSnapshot,
  );

  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!validImageMagic(bytes, file.type)) {
    throw new ApiError(415, "invalid_image_signature", "O arquivo não é uma imagem válida.");
  }
  const hash = await sha256Hex(bytes);
  let thumbnailHash: string | null = null;
  if (thumbnail) {
    const thumbnailBytes = new Uint8Array(await thumbnail.arrayBuffer());
    if (!validImageMagic(thumbnailBytes, thumbnail.type)) {
      throw new ApiError(415, "invalid_thumbnail", "A miniatura não é uma imagem válida.");
    }
    thumbnailHash = await sha256Hex(thumbnailBytes);
  }

  const extension = EXTENSION_BY_MIME[file.type];
  const photoId = idempotencyKey;
  const storagePath = `${clinicId}/${protocolId}/${photoId}.${extension}`;
  const thumbnailPath = thumbnail
    ? `${clinicId}/${protocolId}/${photoId}.thumb.${EXTENSION_BY_MIME[thumbnail.type]}`
    : null;
  const originalName = sanitizeOriginalName(file.name);
  const idempotencyExpectation: PhotoIdempotencyExpectation = {
    phase,
    takenAt: takenAt.toISOString(),
    storagePath,
    mimeType: file.type,
    sizeBytes: file.size,
    sha256: hash,
    thumbnailStoragePath: thumbnailPath,
    thumbnailMimeType: thumbnail?.type || null,
    thumbnailSizeBytes: thumbnail?.size || null,
    thumbnailSha256: thumbnailHash,
    productId,
    lotSnapshot,
    attendanceId,
    procedureItemId,
    confirmDistinct,
    duplicateReason: confirmDistinct ? duplicateReason : null,
    duplicateOperationId: confirmDistinct ? duplicateOperationId : null,
  };

  const existing = await findExistingPhoto(clinicId, protocolId, idempotencyKey);
  if (existing) {
    assertPhotoIdempotencyMatch(existing, idempotencyExpectation);
    return json(req, {
      ok: true,
      foto: await presentStoredPhoto(existing, clinicId),
      idempotente: true,
    });
  }

  // O retry idempotente acima deve continuar reconhecivel mesmo se o rascunho
  // tiver mudado depois do commit original. Somente uma nova foto exige que o
  // par produto/lote ainda exista no protocolo antes de enviar bytes.
  await assertPhotoProductContextPreflight(protocolId, productId, lotSnapshot);

  const duplicate = await findDuplicatePhoto(clinicId, protocolId, hash);
  if (duplicate && !confirmDistinct) {
    throw new ApiError(
      409,
      "photo_exact_duplicate",
      DATABASE_ERROR_MESSAGES.photo_exact_duplicate,
      {
        correspondencia: "exata",
        existing_id: duplicate.id,
        candidato: await presentStoredPhoto(duplicate, clinicId),
      },
    );
  }
  if (confirmDistinct && !duplicate) {
    throw new ApiError(
      409,
      "photo_duplicate_confirmation_stale",
      DATABASE_ERROR_MESSAGES.photo_duplicate_confirmation_stale,
    );
  }
  if (confirmDistinct) {
    if (
      !duplicateReason || duplicateReason.length < 3 ||
      !validUuid(duplicateOperationId)
    ) {
      throw new ApiError(
        422,
        "duplicate_confirmation_required",
        "Informe o motivo e confirme sua senha para registrar a foto como distinta.",
      );
    }
    await requireProtectedOperation(
      req,
      context,
      { operation_id: duplicateOperationId },
      "prontuario.photo.duplicate.confirm",
      safeText(duplicate?.id, 40),
    );
  }

  const uploadResponse = await uploadPrivateImage(storagePath, file);
  if (!uploadResponse.ok) {
    const concurrent = uploadResponse.status === 400 || uploadResponse.status === 409
      ? await findExistingPhoto(clinicId, protocolId, idempotencyKey)
      : null;
    if (concurrent) {
      assertPhotoIdempotencyMatch(concurrent, idempotencyExpectation);
      return json(req, {
        ok: true,
        foto: await presentStoredPhoto(concurrent, clinicId),
        idempotente: true,
      });
    }
    if (uploadResponse.status === 400 || uploadResponse.status === 409) {
      const objectState = await privateImageMatches(storagePath, file, hash);
      if (objectState === "match") {
        // Queda anterior entre Storage e RPC: o objeto exato e adotado e o
        // mesmo RPC idempotente conclui o registro sem sobrescrever bytes.
      } else if (objectState === "mismatch") {
        throw new ApiError(
          409,
          "idempotency_key_reused",
          DATABASE_ERROR_MESSAGES.idempotency_key_reused,
        );
      } else {
        console.error("Clinical photo upload conflict without stored object");
        throw new ApiError(503, "photo_upload_failed", "Não foi possível guardar a imagem agora.");
      }
    } else {
      console.error("Clinical photo upload failed", uploadResponse.status);
      throw new ApiError(503, "photo_upload_failed", "Não foi possível guardar a imagem agora.");
    }
  }

  if (thumbnail && thumbnailPath) {
    const thumbnailUpload = await uploadPrivateImage(thumbnailPath, thumbnail);
    if (!thumbnailUpload.ok) {
      const thumbnailState = thumbnailUpload.status === 400 || thumbnailUpload.status === 409
        ? await privateImageMatches(thumbnailPath, thumbnail, thumbnailHash || "")
        : "missing";
      if (thumbnailState !== "match") {
        if (thumbnailState === "mismatch") {
          throw new ApiError(
            409,
            "idempotency_key_reused",
            DATABASE_ERROR_MESSAGES.idempotency_key_reused,
          );
        }
        await queueOrphanPhotoObjects(
          context,
          protocolId,
          photoId,
          storagePath,
          thumbnailPath,
          "thumbnail_failed",
        );
        throw new ApiError(
          503,
          "photo_upload_failed",
          "Não foi possível guardar a miniatura agora.",
        );
      }
    }
  }

  let result: JsonRecord;
  try {
    result = await rpc("prontuario_registrar_foto", {
      p_clinic_id: clinicId,
      p_user_id: userId,
      p_actor_role: context.role,
      p_auth_method: context.authMethod,
      p_photo_id: photoId,
      p_protocol_id: protocolId,
      p_phase: phase,
      p_storage_path: storagePath,
      p_taken_at: takenAt.toISOString(),
      p_mime_type: file.type,
      p_size_bytes: file.size,
      p_sha256: hash,
      p_original_name: originalName,
      p_thumbnail_storage_path: thumbnailPath,
      p_thumbnail_mime_type: thumbnail?.type || null,
      p_thumbnail_size_bytes: thumbnail?.size || null,
      p_thumbnail_sha256: thumbnailHash,
      p_product_id: productId,
      p_lot_snapshot: lotSnapshot,
      p_attendance_id: attendanceId,
      p_procedure_item_id: procedureItemId,
      p_confirm_distinct: confirmDistinct,
      p_duplicate_reason: confirmDistinct ? duplicateReason : null,
      p_duplicate_operation_id: confirmDistinct ? duplicateOperationId : null,
      p_idempotency_key: idempotencyKey,
      p_request_id: idempotencyKey,
    }) as JsonRecord;
  } catch (error) {
    const uncertainResult = !(error instanceof ApiError) ||
      error.code === "backend_error" || error.status >= 500;
    const retryDelays = uncertainResult ? [0, 100, 300, 700] : [0];
    let committedPhoto: JsonRecord | null = null;
    let lookupConclusive = false;
    for (const delay of retryDelays) {
      if (delay > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, delay));
      }
      try {
        committedPhoto = await findExistingPhoto(clinicId, protocolId, idempotencyKey);
        lookupConclusive = true;
        if (committedPhoto) break;
      } catch {
        lookupConclusive = false;
      }
    }
    if (committedPhoto) {
      assertPhotoIdempotencyMatch(committedPhoto, idempotencyExpectation);
      return json(req, {
        ok: true,
        foto: await presentStoredPhoto(committedPhoto, clinicId),
        idempotente: true,
      });
    }

    if (uncertainResult || !lookupConclusive) {
      // Falha de transporte/parse não prova rollback: a transação pode ainda
      // confirmar. Preserva os objetos; o próximo retry valida bytes+SHA e
      // conclui o mesmo RPC idempotente.
      console.error("Clinical photo registration result is uncertain");
      throw new ApiError(
        503,
        "photo_registration_uncertain",
        "A confirmação da imagem está em andamento. Tente novamente.",
      );
    }

    // Erro SQL definitivo: a fila tem espera minima e o RPC relê referencias.
    // Nenhum objeto e apagado no caminho da consulta ou sem nova verificacao.
    await queueOrphanPhotoObjects(
      context,
      protocolId,
      photoId,
      storagePath,
      thumbnailPath,
      "metadata_rejected",
    );
    throw error;
  }

  if (result.idempotent === true) {
    const committedPhoto = await findExistingPhoto(clinicId, protocolId, idempotencyKey);
    if (!committedPhoto) {
      throw new ApiError(
        503,
        "photo_registration_uncertain",
        "A confirmação da imagem está em andamento. Tente novamente.",
      );
    }
    assertPhotoIdempotencyMatch(committedPhoto, idempotencyExpectation);
    return json(req, {
      ok: true,
      foto: await presentStoredPhoto(committedPhoto, clinicId),
      idempotente: true,
    });
  }

  const registeredPhoto: JsonRecord = {
    id: result.id,
    protocol_id: protocolId,
    phase,
    storage_path: result.storage_path || storagePath,
    taken_at: takenAt.toISOString(),
    mime_type: file.type,
    size_bytes: file.size,
    sha256: hash,
    original_name: originalName,
    thumbnail_storage_path: result.thumbnail_storage_path || thumbnailPath,
    thumbnail_mime_type: thumbnail?.type || null,
    thumbnail_size_bytes: thumbnail?.size || null,
    thumbnail_sha256: thumbnailHash,
    product_id: productId,
    lot_snapshot: lotSnapshot,
    attendance_id: attendanceId,
    procedure_item_id: procedureItemId,
    duplicate_of_photo_id: confirmDistinct ? duplicate?.id || null : null,
    duplicate_confirmed: confirmDistinct,
    duplicate_confirmed_at: null,
    archived_at: null,
  };
  return json(req, {
    ok: true,
    foto: await presentStoredPhoto(registeredPhoto, clinicId),
    idempotente: false,
  });
}

async function handleRemovePhoto(
  req: Request,
  context: DualAuthContext,
  payload: JsonRecord,
): Promise<Response> {
  const { clinicId, userId } = tenant(context);
  if (context.role !== "owner") {
    throw new ApiError(403, "role_forbidden", "Somente os responsáveis podem fazer isso.");
  }
  const photoId = safeText(payload.foto_id, 40);
  const reason = safeText(payload.motivo, 500);
  if (!validUuid(photoId) || reason.length < 3) {
    throw new ApiError(422, "invalid_photo_removal", "Informe a foto e o motivo.");
  }
  const operationId = await requireProtectedOperation(
    req,
    context,
    payload,
    "prontuario.photo.remove",
    photoId,
  );
  const result = await rpc("prontuario_remover_foto", {
    p_clinic_id: clinicId,
    p_user_id: userId,
    p_actor_role: context.role,
    p_auth_method: context.authMethod,
    p_photo_id: photoId,
    p_reason: reason,
    p_request_id: operationId,
  }) as JsonRecord;

  return json(req, {
    ok: true,
    foto_id: result.id || photoId,
    arquivada: result.archived === true,
    idempotente: result.idempotent === true,
  });
}

async function handleRestorePhoto(
  req: Request,
  context: DualAuthContext,
  payload: JsonRecord,
): Promise<Response> {
  const { clinicId, userId } = tenant(context);
  if (context.role !== "owner") {
    throw new ApiError(403, "role_forbidden", "Somente os responsáveis podem fazer isso.");
  }
  const photoId = safeText(payload.foto_id, 40);
  const reason = safeText(payload.motivo, 500);
  if (!validUuid(photoId) || reason.length < 3) {
    throw new ApiError(422, "invalid_photo_restore", "Informe a foto e o motivo.");
  }
  const operationId = await requireProtectedOperation(
    req,
    context,
    payload,
    "prontuario.photo.restore",
    photoId,
  );
  const result = await rpc("prontuario_restaurar_foto", {
    p_clinic_id: clinicId,
    p_user_id: userId,
    p_actor_role: context.role,
    p_auth_method: context.authMethod,
    p_photo_id: photoId,
    p_reason: reason,
    p_request_id: operationId,
  }) as JsonRecord;
  return json(req, {
    ok: true,
    foto_id: result.id || photoId,
    restaurada: result.restored === true,
    idempotente: result.idempotent === true,
  });
}

async function handleLinkPhotoOperation(
  req: Request,
  context: DualAuthContext,
  payload: JsonRecord,
): Promise<Response> {
  const { clinicId, userId } = tenant(context);
  if (context.role !== "owner") {
    throw new ApiError(403, "role_forbidden", "Somente os responsáveis podem fazer isso.");
  }
  const photoId = safeText(payload.foto_id, 40);
  const attendanceId = safeText(payload.atendimento_id, 40);
  const procedureItemRaw = safeText(payload.item_procedimento_id, 40);
  const procedureItemId = procedureItemRaw || null;
  const reason = safeText(payload.motivo, 500);
  if (
    !validUuid(photoId) || !validUuid(attendanceId) ||
    (procedureItemId !== null && !validUuid(procedureItemId)) || reason.length < 3
  ) {
    throw new ApiError(422, "photo_operation_link_invalid", "Revise o vínculo da foto.");
  }
  const operationId = await requireProtectedOperation(
    req,
    context,
    payload,
    "prontuario.photo.operation_link",
    photoId,
  );
  const result = await rpc("prontuario_vincular_foto_operacao", {
    p_clinic_id: clinicId,
    p_user_id: userId,
    p_actor_role: context.role,
    p_auth_method: context.authMethod,
    p_photo_id: photoId,
    p_attendance_id: attendanceId,
    p_procedure_item_id: procedureItemId,
    p_reason: reason,
    p_request_id: operationId,
  }) as JsonRecord;
  return json(req, {
    ok: true,
    foto_id: result.id || photoId,
    atendimento_id: result.attendance_id || attendanceId,
    item_procedimento_id: result.procedure_item_id || null,
    idempotente: result.idempotent === true,
  });
}

async function parseJsonBody(req: Request): Promise<JsonRecord> {
  const length = Number(req.headers.get("content-length") || 0);
  if (Number.isFinite(length) && length > MAX_JSON_BYTES) {
    throw new ApiError(413, "request_too_large", "Requisição muito grande.");
  }
  const raw = await req.text();
  if (new TextEncoder().encode(raw).length > MAX_JSON_BYTES) {
    throw new ApiError(413, "request_too_large", "Requisição muito grande.");
  }
  try {
    const parsed = JSON.parse(raw || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("invalid");
    }
    return parsed as JsonRecord;
  } catch {
    throw new ApiError(400, "invalid_json", "Dados inválidos.");
  }
}

async function auditFailure(
  context: DualAuthContext,
  code: string,
  outcome: "denied" | "error",
): Promise<void> {
  await writeClinicAudit(AUTH_CONFIG, context, {
    entity: "protocol",
    action: "request",
    outcome,
    details: { endpoint: "prontuario-fichas", reason_code: code },
  });
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
    return json(
      req,
      { ok: false, erro: "Método não permitido", codigo: "method_not_allowed" },
      405,
    );
  }
  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    return json(req, { ok: false, erro: "Origem não permitida", codigo: "origin_forbidden" }, 403);
  }
  if (!URL || !SERVICE) {
    console.error("Prontuario backend environment is not configured");
    return json(
      req,
      { ok: false, erro: "Acesso temporariamente indisponível", codigo: "backend_unavailable" },
      503,
    );
  }

  const authorization = (req.headers.get("authorization") || "").trim();
  if (!/^Bearer\s+\S+$/i.test(authorization)) {
    return json(
      req,
      {
        ok: false,
        erro: "Entre com sua conta individual para acessar o prontuário.",
        codigo: "individual_auth_required",
      },
      401,
    );
  }

  let context: DualAuthContext;
  try {
    context = await authenticateDual(req, AUTH_CONFIG);
    requestAuth.set(req, context);
    tenant(context);
  } catch (error) {
    if (error instanceof DualAuthError) {
      if (error.auditContext) {
        requestAuth.set(req, error.auditContext);
        await auditFailure(error.auditContext, error.code, "denied");
      }
      return json(
        req,
        { ok: false, erro: error.publicMessage, codigo: error.code },
        error.status,
      );
    }
    if (error instanceof ApiError) {
      return json(
        req,
        { ok: false, erro: error.publicMessage, codigo: error.code },
        error.status,
      );
    }
    console.error("Prontuario authentication failed");
    return json(
      req,
      { ok: false, erro: "Acesso temporariamente indisponível", codigo: "auth_unavailable" },
      503,
    );
  }

  try {
    const contentType = (req.headers.get("content-type") || "").toLowerCase();
    if (contentType.includes("multipart/form-data")) {
      const length = Number(req.headers.get("content-length") || 0);
      if (Number.isFinite(length) && length > MAX_MULTIPART_BYTES) {
        throw new ApiError(413, "image_too_large", "A imagem original deve ter no máximo 25 MB.");
      }
      const form = await req.formData();
      const action = safeText(form.get("acao"), 40);
      if (action !== "adicionar_foto") {
        throw new ApiError(422, "invalid_action", "Ação inválida.");
      }
      return await handleAddPhoto(req, context, form);
    }

    if (!contentType.includes("application/json")) {
      throw new ApiError(415, "invalid_content_type", "Conteúdo inválido.");
    }
    const payload = await parseJsonBody(req);
    const action = safeText(payload.acao, 40);
    switch (action) {
      case "listar":
        return await handleList(req, context, payload);
      case "listar_fotos":
        return await handleListPhotos(req, context, payload);
      case "criar_atualizar":
        return await handleSaveDraft(req, context, payload);
      case "substituir_produtos":
        return await handleReplaceProducts(req, context, payload);
      case "finalizar":
        return await handleFinalize(req, context, payload);
      case "alterar_consentimento_fotografia":
        return await handlePhotographyConsent(req, context, payload);
      case "remover_foto":
        return await handleRemovePhoto(req, context, payload);
      case "restaurar_foto":
        return await handleRestorePhoto(req, context, payload);
      case "vincular_foto_operacao":
        return await handleLinkPhotoOperation(req, context, payload);
      case "arquivar":
      case "restaurar":
        return await handleArchiveRestore(req, context, payload, action);
      default:
        throw new ApiError(422, "invalid_action", "Ação inválida.");
    }
  } catch (error) {
    if (error instanceof DualAuthError) {
      await auditFailure(context, error.code, "denied");
      return json(
        req,
        { ok: false, erro: error.publicMessage, codigo: error.code },
        error.status,
      );
    }
    if (error instanceof ApiError) {
      await auditFailure(
        context,
        error.code,
        error.status === 401 || error.status === 403 ? "denied" : "error",
      );
      return json(
        req,
        { ok: false, erro: error.publicMessage, codigo: error.code, dados: error.details },
        error.status,
      );
    }
    console.error("Prontuario request failed", String(error));
    await auditFailure(context, "unhandled_error", "error");
    return json(
      req,
      { ok: false, erro: "Não foi possível concluir a operação.", codigo: "unhandled_error" },
      500,
    );
  }
});

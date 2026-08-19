export type ClinicRole = "owner" | "professional" | "assistant" | "viewer";
export type AuthMethod = "supabase_auth" | "legacy_shared_secret";
export type ResponseRole = ClinicRole | "legacy";
export type AuditOutcome = "success" | "denied" | "error";

type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface DualAuthConfig {
  supabaseUrl: string;
  serviceRoleKey: string;
  legacyHash: string;
  legacyClinicId?: string;
  allowedRoles: readonly ClinicRole[];
  requireAal2?: boolean;
  fetchImpl?: FetchLike;
}

export interface DualAuthContext {
  authMethod: AuthMethod;
  role: ResponseRole;
  userId: string | null;
  clinicId: string | null;
  displayName: string | null;
  aal: "aal1" | "aal2" | null;
  requestId: string;
}

export interface AuditEvent {
  entity: string;
  entityId?: string | null;
  action: string;
  outcome: AuditOutcome;
  details?: Record<string, unknown>;
}

export class DualAuthError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly publicMessage: string,
    readonly auditContext: DualAuthContext | null = null,
  ) {
    super(publicMessage);
    this.name = "DualAuthError";
  }
}

interface JwtPayload {
  sub?: unknown;
  role?: unknown;
  aal?: unknown;
  exp?: unknown;
  iss?: unknown;
  is_anonymous?: unknown;
  session_id?: unknown;
}

interface AuthUser {
  id?: unknown;
  is_anonymous?: unknown;
}

interface ClinicMembership {
  clinic_id?: unknown;
  user_id?: unknown;
  role?: unknown;
  status?: unknown;
  display_name?: unknown;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const SAFE_AUDIT_NAME = /^[a-z0-9][a-z0-9_.-]{0,79}$/;
const CLINIC_ROLES = new Set<ClinicRole>([
  "owner",
  "professional",
  "assistant",
  "viewer",
]);
const AUDIT_DETAIL_KEYS = new Set([
  "endpoint",
  "reason_code",
  "status_code",
  "target_kind",
  "result_count",
  "idempotent",
]);

function validUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function equalConstantTime(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index++) {
    difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return difference === 0;
}

function decodeJwtPayload(token: string): JwtPayload {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) {
    throw new DualAuthError(
      401,
      "invalid_token",
      "Sessão inválida ou expirada.",
    );
  }
  try {
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    const bytes = Uint8Array.from(
      atob(padded),
      (character) => character.charCodeAt(0),
    );
    const parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error();
    }
    return parsed as JwtPayload;
  } catch {
    throw new DualAuthError(
      401,
      "invalid_token",
      "Sessão inválida ou expirada.",
    );
  }
}

function roleFrom(value: unknown): ClinicRole | null {
  return typeof value === "string" && CLINIC_ROLES.has(value as ClinicRole)
    ? value as ClinicRole
    : null;
}

function partialAuthContext(
  requestId: string,
  userId: string,
  membership: ClinicMembership,
  aal: "aal1" | "aal2",
): DualAuthContext | null {
  const clinicId = validUuid(membership.clinic_id)
    ? membership.clinic_id
    : null;
  const role = roleFrom(membership.role);
  if (!clinicId || !role) return null;
  const displayName = typeof membership.display_name === "string"
    ? membership.display_name.trim().slice(0, 120) || null
    : null;
  return {
    authMethod: "supabase_auth",
    role,
    userId,
    clinicId,
    displayName,
    aal,
    requestId,
  };
}

function sanitizeAuditDetails(
  details: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  if (!details) return safe;
  for (const [key, value] of Object.entries(details)) {
    if (!AUDIT_DETAIL_KEYS.has(key)) continue;
    if (typeof value === "boolean") {
      safe[key] = value;
    } else if (typeof value === "number" && Number.isFinite(value)) {
      safe[key] = Math.max(-1_000_000, Math.min(1_000_000, Math.trunc(value)));
    } else if (typeof value === "string") {
      safe[key] = value.replace(/[^a-zA-Z0-9_.:-]/g, "_").slice(0, 80);
    }
  }
  return safe;
}

async function fetchWithTimeout(
  fetchImpl: FetchLike,
  input: RequestInfo | URL,
  init: RequestInit,
): Promise<Response> {
  return await fetchImpl(input, {
    ...init,
    signal: AbortSignal.timeout(10_000),
  });
}

async function authenticateBearer(
  token: string,
  config: DualAuthConfig,
  requestId: string,
): Promise<DualAuthContext> {
  const baseUrl = normalizeBaseUrl(config.supabaseUrl);
  if (!baseUrl || !config.serviceRoleKey) {
    throw new DualAuthError(
      503,
      "auth_unavailable",
      "Autenticação temporariamente indisponível.",
    );
  }
  if (token.length > 8192) {
    throw new DualAuthError(
      401,
      "invalid_token",
      "Sessão inválida ou expirada.",
    );
  }

  const fetchImpl = config.fetchImpl || fetch;
  let authResponse: Response;
  try {
    authResponse = await fetchWithTimeout(
      fetchImpl,
      baseUrl + "/auth/v1/user",
      {
        method: "GET",
        headers: {
          apikey: config.serviceRoleKey,
          Authorization: "Bearer " + token,
          Accept: "application/json",
        },
      },
    );
  } catch {
    throw new DualAuthError(
      503,
      "auth_unavailable",
      "Autenticação temporariamente indisponível.",
    );
  }
  if (!authResponse.ok) {
    if (authResponse.status >= 500) {
      throw new DualAuthError(
        503,
        "auth_unavailable",
        "Autenticação temporariamente indisponível.",
      );
    }
    throw new DualAuthError(
      401,
      "invalid_token",
      "Sessão inválida ou expirada.",
    );
  }

  let user: AuthUser;
  try {
    user = await authResponse.json() as AuthUser;
  } catch {
    throw new DualAuthError(
      503,
      "auth_unavailable",
      "Autenticação temporariamente indisponível.",
    );
  }
  if (!validUuid(user.id) || user.is_anonymous === true) {
    throw new DualAuthError(
      401,
      "invalid_token",
      "Sessão inválida ou expirada.",
    );
  }

  // Os claims só são usados após o Auth server validar integralmente o JWT acima.
  const claims = decodeJwtPayload(token);
  const expectedIssuer = baseUrl + "/auth/v1";
  const expiration = typeof claims.exp === "number" ? claims.exp : 0;
  if (
    claims.sub !== user.id || claims.role !== "authenticated" ||
    claims.is_anonymous === true || claims.iss !== expectedIssuer ||
    expiration <= Math.floor(Date.now() / 1000) || !validUuid(claims.session_id)
  ) {
    throw new DualAuthError(
      401,
      "invalid_token",
      "Sessão inválida ou expirada.",
    );
  }
  const aal: "aal1" | "aal2" = claims.aal === "aal2" ? "aal2" : "aal1";

  // getUser valida o JWT; esta checagem adicional elimina imediatamente sessões
  // removidas por logout, correlacionando o claim com auth.sessions no servidor.
  let sessionResponse: Response;
  try {
    sessionResponse = await fetchWithTimeout(
      fetchImpl,
      baseUrl + "/rest/v1/rpc/clinic_validate_auth_session",
      {
        method: "POST",
        headers: {
          apikey: config.serviceRoleKey,
          Authorization: "Bearer " + config.serviceRoleKey,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          p_user_id: user.id,
          p_session_id: claims.session_id,
        }),
      },
    );
  } catch {
    throw new DualAuthError(
      503,
      "session_validation_unavailable",
      "Não foi possível validar a sessão agora.",
    );
  }
  if (!sessionResponse.ok) {
    throw new DualAuthError(
      503,
      "session_validation_unavailable",
      "Não foi possível validar a sessão agora.",
    );
  }
  let activeSession = false;
  try {
    activeSession = await sessionResponse.json() === true;
  } catch {
    throw new DualAuthError(
      503,
      "session_validation_unavailable",
      "Não foi possível validar a sessão agora.",
    );
  }
  if (!activeSession) {
    throw new DualAuthError(
      401,
      "session_revoked",
      "Sessão encerrada. Entre novamente.",
    );
  }

  let membershipResponse: Response;
  try {
    membershipResponse = await fetchWithTimeout(
      fetchImpl,
      baseUrl +
        "/rest/v1/clinic_members?select=clinic_id,user_id,role,status,display_name" +
        "&user_id=eq." + encodeURIComponent(user.id) + "&limit=20",
      {
        method: "GET",
        headers: {
          apikey: config.serviceRoleKey,
          Authorization: "Bearer " + config.serviceRoleKey,
          Accept: "application/json",
        },
      },
    );
  } catch {
    throw new DualAuthError(
      503,
      "membership_unavailable",
      "Não foi possível validar o acesso agora.",
    );
  }
  if (!membershipResponse.ok) {
    throw new DualAuthError(
      503,
      "membership_unavailable",
      "Não foi possível validar o acesso agora.",
    );
  }

  let memberships: ClinicMembership[];
  try {
    const parsed = await membershipResponse.json();
    memberships = Array.isArray(parsed) ? parsed as ClinicMembership[] : [];
  } catch {
    throw new DualAuthError(
      503,
      "membership_unavailable",
      "Não foi possível validar o acesso agora.",
    );
  }
  const ownedRows = memberships.filter((row) => row.user_id === user.id);
  const activeRows = ownedRows.filter((row) => row.status === "active");
  if (!activeRows.length) {
    const auditContext = ownedRows.length
      ? partialAuthContext(requestId, user.id, ownedRows[0], aal)
      : null;
    throw new DualAuthError(
      403,
      ownedRows.length ? "membership_inactive" : "membership_required",
      ownedRows.length
        ? "Seu acesso está suspenso."
        : "Usuário sem acesso à clínica.",
      auditContext,
    );
  }

  // Os endpoints atuais ainda não recebem clinic_id e os dados clínicos não são
  // multi-tenant. Mais de uma clínica ativa deve falhar fechado, sem escolher uma.
  if (activeRows.length !== 1) {
    throw new DualAuthError(
      403,
      "ambiguous_membership",
      "Selecione uma clínica antes de continuar.",
      partialAuthContext(requestId, user.id, activeRows[0], aal),
    );
  }

  const allowedRoles = new Set(config.allowedRoles);
  const allowedRows = activeRows.filter((row) => {
    const role = roleFrom(row.role);
    return role !== null && allowedRoles.has(role);
  });
  if (!allowedRows.length) {
    throw new DualAuthError(
      403,
      "role_forbidden",
      "Seu perfil não permite esta operação.",
      partialAuthContext(requestId, user.id, activeRows[0], aal),
    );
  }
  const membership = allowedRows[0];
  const context = partialAuthContext(requestId, user.id, membership, aal);
  if (!context || context.role === "legacy") {
    throw new DualAuthError(
      503,
      "membership_unavailable",
      "Não foi possível validar o acesso agora.",
    );
  }
  if (config.requireAal2 !== false && aal !== "aal2") {
    throw new DualAuthError(
      403,
      "mfa_required",
      "Confirme o código do autenticador para continuar.",
      context,
    );
  }
  return context;
}

export async function authenticateDual(
  req: Request,
  config: DualAuthConfig,
): Promise<DualAuthContext> {
  const requestId = crypto.randomUUID();
  const authorization = req.headers.get("authorization");
  if (authorization !== null && authorization.trim()) {
    const match = /^Bearer\s+([^\s]+)$/i.exec(authorization.trim());
    if (!match) {
      throw new DualAuthError(
        401,
        "invalid_token",
        "Sessão inválida ou expirada.",
      );
    }
    // Presença de Bearer sempre escolhe Auth: falhas nunca caem na senha legada.
    return await authenticateBearer(match[1], config, requestId);
  }

  const expectedHash = config.legacyHash.trim().toLowerCase();
  if (!HASH_PATTERN.test(expectedHash)) {
    throw new DualAuthError(
      503,
      "legacy_auth_unavailable",
      "Acesso temporariamente indisponível.",
    );
  }
  const sentHash = (req.headers.get("x-senha") || "").trim().toLowerCase();
  if (
    !HASH_PATTERN.test(sentHash) || !equalConstantTime(sentHash, expectedHash)
  ) {
    throw new DualAuthError(401, "invalid_password", "Senha incorreta.");
  }
  return {
    authMethod: "legacy_shared_secret",
    role: "legacy",
    userId: null,
    clinicId: validUuid(config.legacyClinicId) ? config.legacyClinicId : null,
    displayName: null,
    aal: null,
    requestId,
  };
}

export function authResponseFields(
  context: DualAuthContext,
): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    auth_method: context.authMethod,
    role: context.role,
  };
  if (context.authMethod === "supabase_auth" && context.role !== "legacy") {
    fields.identity = {
      display_name: context.displayName,
      role: context.role,
    };
  }
  return fields;
}

export async function writeClinicAudit(
  config: DualAuthConfig,
  context: DualAuthContext,
  event: AuditEvent,
): Promise<boolean> {
  const baseUrl = normalizeBaseUrl(config.supabaseUrl);
  if (!baseUrl || !config.serviceRoleKey || !validUuid(context.clinicId)) {
    console.warn("Clinic audit skipped: tenant or backend unavailable");
    return false;
  }
  if (
    !SAFE_AUDIT_NAME.test(event.entity) || !SAFE_AUDIT_NAME.test(event.action)
  ) {
    console.warn("Clinic audit skipped: invalid technical event name");
    return false;
  }

  const actorRole = context.authMethod === "legacy_shared_secret"
    ? "legacy"
    : context.role;
  const body = {
    clinic_id: context.clinicId,
    actor: validUuid(context.userId) ? context.userId : null,
    entity: event.entity,
    entity_id: validUuid(event.entityId) ? event.entityId : null,
    action: event.action,
    details: sanitizeAuditDetails(event.details),
    actor_role: actorRole,
    auth_method: context.authMethod,
    outcome: event.outcome,
    request_id: context.requestId,
  };

  try {
    const response = await fetchWithTimeout(
      config.fetchImpl || fetch,
      baseUrl + "/rest/v1/clinic_audit_log",
      {
        method: "POST",
        headers: {
          apikey: config.serviceRoleKey,
          Authorization: "Bearer " + config.serviceRoleKey,
          "Content-Type": "application/json",
          Prefer: "return=minimal",
        },
        body: JSON.stringify(body),
      },
    );
    if (!response.ok) {
      console.error("Clinic audit write failed", response.status);
      return false;
    }
    return true;
  } catch {
    console.error("Clinic audit write failed: backend unavailable");
    return false;
  }
}

export type ClinicRole = "owner" | "professional" | "assistant" | "viewer";
export type AuthMethod = "supabase_auth";
export type ResponseRole = ClinicRole;
export type AuditOutcome = "success" | "denied" | "error";

type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface DualAuthConfig {
  supabaseUrl: string;
  serviceRoleKey: string;
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
  /** Presente nos contextos produzidos por Supabase Auth; opcional por compatibilidade. */
  sessionId?: string | null;
  requestId: string;
}

export interface RecentPasswordProof {
  userId: string;
  clinicId: string;
  sessionId: string;
  proofId: string;
  operationId: string;
  action: string;
  targetId: string;
  /** Instante do AMR password, em segundos Unix. */
  passwordAuthenticatedAt: number;
}

export interface RecentPasswordProofScope {
  /** UUID de idempotencia gerado pela interface para esta operacao. */
  operationId: string;
  /** Constante definida no servidor, nunca nome de tabela recebido do cliente. */
  action: string;
  /** UUID do registro resolvido e validado pelo servidor. */
  targetId: string;
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
  amr?: unknown;
  exp?: unknown;
  iss?: unknown;
  is_anonymous?: unknown;
  session_id?: unknown;
}

interface AmrEntry {
  method?: unknown;
  timestamp?: unknown;
}

interface PasswordProofRpcResponse {
  ok?: unknown;
  code?: unknown;
  proof_id?: unknown;
  retry_after_seconds?: unknown;
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
const SAFE_AUDIT_NAME = /^[a-z0-9][a-z0-9_.-]{0,79}$/;
const SAFE_PROOF_ACTION = /^[a-z][a-z0-9_.:-]{1,79}$/;
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
const RECENT_PASSWORD_MAX_AGE_SECONDS = 120;
const AUTH_CLOCK_SKEW_SECONDS = 30;

function validUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
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
  sessionId: string,
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
    sessionId,
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
      ? partialAuthContext(
        requestId,
        user.id,
        ownedRows[0],
        aal,
        claims.session_id,
      )
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
      partialAuthContext(
        requestId,
        user.id,
        activeRows[0],
        aal,
        claims.session_id,
      ),
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
      partialAuthContext(
        requestId,
        user.id,
        activeRows[0],
        aal,
        claims.session_id,
      ),
    );
  }
  const membership = allowedRows[0];
  const context = partialAuthContext(
    requestId,
    user.id,
    membership,
    aal,
    claims.session_id,
  );
  if (!context) {
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
  if (authorization === null || !authorization.trim()) {
    // Senhas compartilhadas foram definitivamente desativadas. Cabeçalhos
    // antigos (inclusive x-senha) nunca autenticam nem revelam dados privados.
    throw new DualAuthError(
      401,
      "authorization_required",
      "Entre com sua conta individual e confirme o MFA.",
    );
  }
  const match = /^Bearer\s+([^\s]+)$/i.exec(authorization.trim());
  if (!match) {
    throw new DualAuthError(
      401,
      "invalid_token",
      "Sessão inválida ou expirada.",
    );
  }
  return await authenticateBearer(match[1], config, requestId);
}

/**
 * Exige uma nova autenticacao por senha sem substituir a sessao AAL2 principal.
 *
 * O navegador deve criar uma sessao Supabase isolada, nao persistente, e enviar
 * somente o access_token secundario em:
 *   X-AMJ-Reauthentication: Bearer <token>
 *
 * Endpoints que usam este helper precisam permitir `x-amj-reauthentication` em
 * Access-Control-Allow-Headers. Senha, access token e refresh token nunca devem
 * ser persistidos ou enviados a logs.
 */
export async function requireRecentPasswordProof(
  req: Request,
  config: DualAuthConfig,
  context: DualAuthContext,
  scope: RecentPasswordProofScope,
): Promise<RecentPasswordProof> {
  if (
    context.authMethod !== "supabase_auth" || !validUuid(context.userId) ||
    !validUuid(context.clinicId)
  ) {
    throw new DualAuthError(
      403,
      "individual_auth_required",
      "Entre com sua conta individual para confirmar esta operacao.",
      context,
    );
  }
  if (context.role !== "owner") {
    throw new DualAuthError(
      403,
      "owner_required",
      "Somente um proprietario pode confirmar esta operacao.",
      context,
    );
  }
  if (context.aal !== "aal2") {
    throw new DualAuthError(
      403,
      "mfa_required",
      "Confirme o codigo do autenticador para continuar.",
      context,
    );
  }
  if (!validUuid(context.sessionId)) {
    throw new DualAuthError(
      403,
      "reauthentication_required",
      "Confirme sua senha para continuar.",
      context,
    );
  }
  if (
    !scope || !validUuid(scope.operationId) || !validUuid(scope.targetId) ||
    typeof scope.action !== "string" ||
    !SAFE_PROOF_ACTION.test(scope.action)
  ) {
    throw new DualAuthError(
      400,
      "invalid_reauthentication_scope",
      "A operacao protegida e invalida.",
      context,
    );
  }

  const reauthentication = req.headers.get("x-amj-reauthentication");
  const match = reauthentication === null
    ? null
    : /^Bearer\s+([^\s]+)$/i.exec(reauthentication.trim());
  if (!match || !match[1] || match[1].length > 8192) {
    throw new DualAuthError(
      403,
      "reauthentication_required",
      "Confirme sua senha para continuar.",
      context,
    );
  }

  const baseUrl = normalizeBaseUrl(config.supabaseUrl);
  if (!baseUrl || !config.serviceRoleKey) {
    throw new DualAuthError(
      503,
      "reauthentication_unavailable",
      "Nao foi possivel confirmar sua senha agora.",
      context,
    );
  }

  const proofToken = match[1];
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
          Authorization: "Bearer " + proofToken,
          Accept: "application/json",
        },
      },
    );
  } catch {
    throw new DualAuthError(
      503,
      "reauthentication_unavailable",
      "Nao foi possivel confirmar sua senha agora.",
      context,
    );
  }
  if (!authResponse.ok) {
    if (authResponse.status >= 500) {
      throw new DualAuthError(
        503,
        "reauthentication_unavailable",
        "Nao foi possivel confirmar sua senha agora.",
        context,
      );
    }
    throw new DualAuthError(
      403,
      "reauthentication_invalid",
      "Senha nao confirmada. Tente novamente.",
      context,
    );
  }

  let user: AuthUser;
  try {
    user = await authResponse.json() as AuthUser;
  } catch {
    throw new DualAuthError(
      503,
      "reauthentication_unavailable",
      "Nao foi possivel confirmar sua senha agora.",
      context,
    );
  }
  if (
    !validUuid(user.id) || user.id !== context.userId ||
    user.is_anonymous === true
  ) {
    throw new DualAuthError(
      403,
      "reauthentication_invalid",
      "A confirmacao nao pertence ao usuario atual.",
      context,
    );
  }

  // Claims sao considerados somente depois de /auth/v1/user validar o token.
  let claims: JwtPayload;
  try {
    claims = decodeJwtPayload(proofToken);
  } catch (error) {
    if (error instanceof DualAuthError) {
      throw new DualAuthError(
        403,
        "reauthentication_invalid",
        "Senha nao confirmada. Tente novamente.",
        context,
      );
    }
    throw error;
  }
  const nowSeconds = Math.floor(Date.now() / 1000);
  const expiration = typeof claims.exp === "number" ? claims.exp : 0;
  if (
    claims.sub !== context.userId || claims.role !== "authenticated" ||
    claims.is_anonymous === true || claims.iss !== baseUrl + "/auth/v1" ||
    expiration <= nowSeconds || !validUuid(claims.session_id) ||
    claims.session_id === context.sessionId
  ) {
    throw new DualAuthError(
      403,
      "reauthentication_invalid",
      "Senha nao confirmada. Tente novamente.",
      context,
    );
  }

  const amr = Array.isArray(claims.amr) ? claims.amr as AmrEntry[] : [];
  const passwordAuthenticatedAt = amr.reduce((latest, entry) => {
    if (
      entry?.method !== "password" || typeof entry.timestamp !== "number" ||
      !Number.isInteger(entry.timestamp)
    ) return latest;
    return Math.max(latest, entry.timestamp);
  }, 0);
  if (
    passwordAuthenticatedAt <= 0 ||
    passwordAuthenticatedAt > nowSeconds + AUTH_CLOCK_SKEW_SECONDS
  ) {
    throw new DualAuthError(
      403,
      "reauthentication_invalid",
      "Confirme novamente usando sua senha.",
      context,
    );
  }
  if (nowSeconds - passwordAuthenticatedAt > RECENT_PASSWORD_MAX_AGE_SECONDS) {
    throw new DualAuthError(
      403,
      "reauthentication_expired",
      "A confirmacao expirou. Digite sua senha novamente.",
      context,
    );
  }

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
          p_user_id: context.userId,
          p_session_id: claims.session_id,
        }),
      },
    );
  } catch {
    throw new DualAuthError(
      503,
      "reauthentication_unavailable",
      "Nao foi possivel confirmar sua senha agora.",
      context,
    );
  }
  if (!sessionResponse.ok) {
    throw new DualAuthError(
      503,
      "reauthentication_unavailable",
      "Nao foi possivel confirmar sua senha agora.",
      context,
    );
  }
  let activeSession = false;
  try {
    activeSession = await sessionResponse.json() === true;
  } catch {
    throw new DualAuthError(
      503,
      "reauthentication_unavailable",
      "Nao foi possivel confirmar sua senha agora.",
      context,
    );
  }
  if (!activeSession) {
    throw new DualAuthError(
      403,
      "reauthentication_revoked",
      "A confirmacao foi encerrada. Digite sua senha novamente.",
      context,
    );
  }

  // Registra e consome a prova antes da mutacao. O HMAC da sessao secundaria
  // e unico no banco, portanto o mesmo login por senha nao autoriza outra
  // operacao/alvo durante os 120 s de validade.
  let registerResponse: Response;
  try {
    registerResponse = await fetchWithTimeout(
      fetchImpl,
      baseUrl + "/rest/v1/rpc/clinic_register_password_proof",
      {
        method: "POST",
        headers: {
          apikey: config.serviceRoleKey,
          Authorization: "Bearer " + config.serviceRoleKey,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          p_clinic_id: context.clinicId,
          p_actor_user_id: context.userId,
          p_main_session_id: context.sessionId,
          p_secondary_session_id: claims.session_id,
          p_operation_id: scope.operationId,
          p_action: scope.action,
          p_target_id: scope.targetId,
          p_password_authenticated_at: new Date(
            passwordAuthenticatedAt * 1000,
          ).toISOString(),
          p_request_id: context.requestId,
        }),
      },
    );
  } catch {
    throw new DualAuthError(
      503,
      "reauthentication_unavailable",
      "Nao foi possivel registrar a confirmacao agora.",
      context,
    );
  }
  if (!registerResponse.ok) {
    throw new DualAuthError(
      503,
      "reauthentication_unavailable",
      "Nao foi possivel registrar a confirmacao agora.",
      context,
    );
  }

  let registered: PasswordProofRpcResponse;
  try {
    registered = await registerResponse.json() as PasswordProofRpcResponse;
  } catch {
    throw new DualAuthError(
      503,
      "reauthentication_unavailable",
      "Nao foi possivel registrar a confirmacao agora.",
      context,
    );
  }
  if (registered.ok !== true || !validUuid(registered.proof_id)) {
    const code = typeof registered.code === "string" ? registered.code : "";
    if (code === "rate_limited") {
      throw new DualAuthError(
        429,
        "reauthentication_rate_limited",
        "Muitas confirmacoes seguidas. Aguarde e tente novamente.",
        context,
      );
    }
    throw new DualAuthError(
      403,
      code === "proof_reused" || code === "proof_conflict"
        ? "reauthentication_reused"
        : "reauthentication_invalid",
      "Esta confirmacao nao pode ser reutilizada. Digite sua senha novamente.",
      context,
    );
  }

  let consumeResponse: Response;
  try {
    consumeResponse = await fetchWithTimeout(
      fetchImpl,
      baseUrl + "/rest/v1/rpc/clinic_consume_password_proof",
      {
        method: "POST",
        headers: {
          apikey: config.serviceRoleKey,
          Authorization: "Bearer " + config.serviceRoleKey,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          p_clinic_id: context.clinicId,
          p_actor_user_id: context.userId,
          p_main_session_id: context.sessionId,
          p_secondary_session_id: claims.session_id,
          p_operation_id: scope.operationId,
          p_action: scope.action,
          p_target_id: scope.targetId,
          p_request_id: context.requestId,
        }),
      },
    );
  } catch {
    throw new DualAuthError(
      503,
      "reauthentication_unavailable",
      "Nao foi possivel consumir a confirmacao agora.",
      context,
    );
  }
  if (!consumeResponse.ok) {
    throw new DualAuthError(
      503,
      "reauthentication_unavailable",
      "Nao foi possivel consumir a confirmacao agora.",
      context,
    );
  }

  let consumed: PasswordProofRpcResponse;
  try {
    consumed = await consumeResponse.json() as PasswordProofRpcResponse;
  } catch {
    throw new DualAuthError(
      503,
      "reauthentication_unavailable",
      "Nao foi possivel consumir a confirmacao agora.",
      context,
    );
  }
  if (
    consumed.ok !== true || !validUuid(consumed.proof_id) ||
    consumed.proof_id !== registered.proof_id
  ) {
    throw new DualAuthError(
      403,
      "reauthentication_consumed_or_invalid",
      "A confirmacao expirou ou ja foi usada. Digite sua senha novamente.",
      context,
    );
  }

  return {
    userId: context.userId,
    clinicId: context.clinicId,
    sessionId: claims.session_id,
    proofId: consumed.proof_id,
    operationId: scope.operationId,
    action: scope.action,
    targetId: scope.targetId,
    passwordAuthenticatedAt,
  };
}

export function authResponseFields(
  context: DualAuthContext,
): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    auth_method: context.authMethod,
    role: context.role,
  };
  fields.identity = {
    display_name: context.displayName,
    role: context.role,
  };
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

  const body = {
    clinic_id: context.clinicId,
    actor: validUuid(context.userId) ? context.userId : null,
    entity: event.entity,
    entity_id: validUuid(event.entityId) ? event.entityId : null,
    action: event.action,
    details: sanitizeAuditDetails(event.details),
    actor_role: context.role,
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

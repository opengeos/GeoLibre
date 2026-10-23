import { getShareFetch } from "./share-fetch";
import { shareAuthorizedFetch } from "./share-gallery";
import {
  authorizeShareManagement,
  getShareAccessToken,
  oauthEndpointUrl,
  resolveShareIssuer,
  shareOAuthClientId,
  signOutOfShare,
  useShareOAuthStore,
  type ShareManagementGrant,
} from "./share-oauth";

export interface ShareAccountIdentity {
  id: string;
  username: string | null;
  email: string | null;
  sessionId: string;
  scopes: string[];
  clientId: "geolibre-web" | "geolibre-desktop";
  issuer: string;
}

export interface ManagedSession {
  id: string;
  kind: "oauth" | "personal-token";
  clientId: string | null;
  label: string;
  scopes: string[];
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  current: boolean;
  legacy: boolean;
}

export interface SessionPage {
  sessions: ManagedSession[];
  limit: number;
  offset: number;
  total: number;
}

export type SessionManagementErrorCode =
  | "no-project-session"
  | "reauthorize"
  | "account-mismatch"
  | "request-failed";

export class SessionManagementError extends Error {
  constructor(readonly code: SessionManagementErrorCode) {
    super(code);
  }
}

type IdentityResponse = {
  user?: { id?: unknown; username?: unknown; email?: unknown };
  sessionId?: unknown;
  scopes?: unknown;
};
interface ParsedIdentity {
  id: string;
  username: string | null;
  email: string | null;
  sessionId: string;
  scopes: string[];
}

type ActiveManagement = { grant: ShareManagementGrant; project: ShareAccountIdentity };
let management: ActiveManagement | null = null;
let lifecycle = 0;

async function authorizedRequest(
  issuer: string,
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  return shareAuthorizedFetch(
    token,
    issuer,
    getShareFetch(),
  )(new URL(path, `${issuer}/`), {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(30_000),
  });
}

function readIdentity(value: unknown): ParsedIdentity {
  const data = value as IdentityResponse | null;
  if (
    typeof data?.user?.id !== "string" ||
    !data.user.id ||
    typeof data.sessionId !== "string" ||
    !data.sessionId ||
    !Array.isArray(data.scopes) ||
    !data.scopes.every((scope) => typeof scope === "string")
  )
    throw new SessionManagementError("request-failed");
  return {
    id: data.user.id,
    username: typeof data.user.username === "string" ? data.user.username : null,
    email: typeof data.user.email === "string" ? data.user.email : null,
    sessionId: data.sessionId,
    scopes: data.scopes,
  };
}

/** The project OAuth session, not a pasted PAT, is the only account anchor. */
export async function getShareAccountIdentity(): Promise<ShareAccountIdentity> {
  const issuer = resolveShareIssuer();
  const revision = useShareOAuthStore.getState().sessionRevision;
  if (!issuer || useShareOAuthStore.getState().issuer !== issuer) {
    throw new SessionManagementError("no-project-session");
  }
  const accessToken = await getShareAccessToken();
  if (!accessToken) throw new SessionManagementError("no-project-session");
  let response: Response;
  try {
    response = await authorizedRequest(issuer, accessToken, "api/users/me");
  } catch {
    throw new SessionManagementError("request-failed");
  }
  if (response.status === 401) {
    // A failed keychain delete is already shown through the credential warning.
    void signOutOfShare().catch(() => {});
    throw new SessionManagementError("no-project-session");
  }
  if (!response.ok) throw new SessionManagementError("request-failed");
  let identity: ParsedIdentity;
  try {
    identity = readIdentity(await response.json());
  } catch {
    throw new SessionManagementError("request-failed");
  }
  if (
    identity.scopes.includes("manage:sessions") ||
    useShareOAuthStore.getState().sessionRevision !== revision
  )
    throw new SessionManagementError("no-project-session");
  return { ...identity, issuer, clientId: shareOAuthClientId() };
}

async function revokeManagerGrant(grant: ShareManagementGrant): Promise<void> {
  try {
    await getShareFetch()(oauthEndpointUrl(grant.issuer, "revoke"), {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: shareOAuthClientId(),
        token: grant.accessToken,
        token_type_hint: "access_token",
      }),
    });
  } catch {
    // Best effort; the access-only manager family expires after five minutes.
  }
}

/** Always forget the management credential, including on failed revocation. */
export async function closeShareSessionManagement(): Promise<void> {
  lifecycle += 1;
  const old = management;
  management = null;
  if (old) await revokeManagerGrant(old.grant);
}

// Project sign-out and same-issuer account switches both end step-up access.
useShareOAuthStore.subscribe((state, previous) => {
  if (management && state.sessionRevision !== previous.sessionRevision) {
    void closeShareSessionManagement();
  }
});

/** Require a fresh consent, then compare stable account IDs before any listing. */
export async function authorizeShareSessionManagement(): Promise<ShareAccountIdentity> {
  await closeShareSessionManagement();
  const attempt = lifecycle;
  const projectRevision = useShareOAuthStore.getState().sessionRevision;
  const project = await getShareAccountIdentity();
  if (attempt !== lifecycle) throw new SessionManagementError("no-project-session");
  const grant = await authorizeShareManagement(project.issuer);
  try {
    const response = await authorizedRequest(grant.issuer, grant.accessToken, "api/users/me");
    if (!response.ok) throw new SessionManagementError("reauthorize");
    const manager = readIdentity(await response.json());
    if (manager.id !== project.id) throw new SessionManagementError("account-mismatch");
    if (!manager.scopes.includes("manage:sessions"))
      throw new SessionManagementError("request-failed");
    if (
      attempt !== lifecycle ||
      useShareOAuthStore.getState().issuer !== project.issuer ||
      useShareOAuthStore.getState().sessionRevision !== projectRevision
    )
      throw new SessionManagementError("no-project-session");
    management = { grant, project };
    return project;
  } catch (error) {
    await revokeManagerGrant(grant);
    if (error instanceof SessionManagementError) throw error;
    throw new SessionManagementError("request-failed");
  }
}

async function managerRequest(path: string, init?: RequestInit): Promise<Response> {
  const active = management;
  if (
    !active ||
    Date.now() >= active.grant.expiresAt ||
    active.grant.issuer !== resolveShareIssuer()
  ) {
    void closeShareSessionManagement();
    throw new SessionManagementError("reauthorize");
  }
  let response: Response;
  try {
    response = await authorizedRequest(active.grant.issuer, active.grant.accessToken, path, init);
  } catch {
    throw new SessionManagementError("request-failed");
  }
  if (active !== management) throw new SessionManagementError("reauthorize");
  if (response.status === 401) {
    void closeShareSessionManagement();
    throw new SessionManagementError("reauthorize");
  }
  if (!response.ok) throw new SessionManagementError("request-failed");
  return response;
}

export async function listShareSessions(limit = 50, offset = 0): Promise<SessionPage> {
  if (!management) throw new SessionManagementError("reauthorize");
  const params = new URLSearchParams({
    limit: String(limit),
    offset: String(offset),
    currentSessionId: management.project.sessionId,
  });
  const response = await managerRequest(`api/auth/sessions?${params}`);
  try {
    const page = (await response.json()) as Partial<SessionPage> | null;
    if (
      !page ||
      !Array.isArray(page.sessions) ||
      !Number.isInteger(page.total) ||
      !Number.isInteger(page.limit) ||
      !Number.isInteger(page.offset) ||
      !page.sessions.every(
        (row) =>
          row &&
          typeof row.id === "string" &&
          (row.kind === "oauth" || row.kind === "personal-token") &&
          (row.clientId === null || typeof row.clientId === "string") &&
          typeof row.label === "string" &&
          Array.isArray(row.scopes) &&
          row.scopes.every((scope) => typeof scope === "string") &&
          typeof row.createdAt === "string" &&
          (row.lastUsedAt === null || typeof row.lastUsedAt === "string") &&
          (row.expiresAt === null || typeof row.expiresAt === "string") &&
          typeof row.current === "boolean" &&
          typeof row.legacy === "boolean",
      )
    )
      throw new SessionManagementError("request-failed");
    return page as SessionPage;
  } catch {
    throw new SessionManagementError("request-failed");
  }
}

export async function revokeShareSession(id: string): Promise<{ current: boolean }> {
  const active = management;
  if (!active) throw new SessionManagementError("reauthorize");
  const current = id === active.project.sessionId;
  await managerRequest(`api/auth/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (current) await signOutOfShare(active.project.issuer);
  return { current };
}

export async function revokeOtherShareSessions(): Promise<void> {
  if (!management) throw new SessionManagementError("reauthorize");
  await managerRequest("api/auth/sessions/revoke-others", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ currentSessionId: management.project.sessionId }),
  });
}

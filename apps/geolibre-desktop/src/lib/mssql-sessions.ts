import {
  connectMssql,
  disconnectMssql,
  MssqlSessionExpiredError,
  type ConnectMssqlRequest,
  type MssqlAuthMethod,
} from "@geolibre/processing";
import { ignoreSidecarStartError, startGeoLibreSidecar } from "./sidecar";
import {
  readSavedMssqlConnections,
  savedMssqlSecret,
  type MssqlConnectionProfile,
  type MssqlStoredSecret,
  forgetMssqlConnection,
} from "./saved-mssql-connections";

export type MssqlSessionSecret = MssqlStoredSecret & { accessToken?: string };
export class MssqlReconnectRequiredError extends Error {
  override readonly name = "MssqlReconnectRequiredError";
  constructor(
    message: string,
    readonly reason: "profile-missing" | "secret-missing" = "profile-missing",
  ) {
    super(message);
  }
}
export interface MssqlSessionClient {
  connect: typeof connectMssql;
  disconnect: typeof disconnectMssql;
  startSidecar: () => Promise<unknown>;
}
export const defaultMssqlSessionClient: MssqlSessionClient = {
  connect: connectMssql,
  disconnect: disconnectMssql,
  startSidecar: startGeoLibreSidecar,
};
const sessionByProfileId = new Map<string, string>();
const memorySecrets = new Map<string, MssqlSessionSecret>();
// One in-flight recovery per profile: concurrent callers (a save-back, the
// Browser listing, an import) share it instead of each opening a session that
// would disconnect the one another caller is still using.
const restoringByProfileId = new Map<string, Promise<string>>();
export function requiredMssqlSecret(
  method: MssqlAuthMethod,
): "password" | "clientSecret" | "accessToken" | null {
  if (method === "sql" || method === "entra_password") return "password";
  if (method === "entra_sp") return "clientSecret";
  if (method === "token") return "accessToken";
  return null;
}
export function resolveMssqlSecret(
  profileId: string,
  typed: MssqlSessionSecret,
): MssqlSessionSecret {
  const memory = memorySecrets.get(profileId) ?? {};
  const saved = savedMssqlSecret(profileId) ?? {};
  return {
    ...(typed.password || memory.password || saved.password
      ? { password: typed.password || memory.password || saved.password }
      : {}),
    ...(typed.clientSecret || memory.clientSecret || saved.clientSecret
      ? { clientSecret: typed.clientSecret || memory.clientSecret || saved.clientSecret }
      : {}),
    ...(typed.accessToken || memory.accessToken
      ? { accessToken: typed.accessToken || memory.accessToken }
      : {}),
  };
}
function connectRequest(
  profile: MssqlConnectionProfile,
  secret: MssqlSessionSecret,
): ConnectMssqlRequest {
  return {
    server: profile.server,
    port: profile.port,
    database: profile.database,
    encrypt: profile.encrypt,
    trust_server_certificate: profile.trustServerCertificate,
    auth: {
      method: profile.authMethod,
      username:
        profile.authMethod === "sql" || profile.authMethod === "entra_password"
          ? profile.username
          : undefined,
      tenant_id: profile.tenantId,
      client_id: profile.clientId,
      ...(secret.password ? { password: secret.password } : {}),
      ...(secret.clientSecret ? { client_secret: secret.clientSecret } : {}),
      ...(secret.accessToken ? { access_token: secret.accessToken } : {}),
    },
  };
}
export async function openMssqlSession(
  profile: MssqlConnectionProfile,
  secret: MssqlSessionSecret,
  client = defaultMssqlSessionClient,
): Promise<string> {
  const result = await client.connect(connectRequest(profile, secret));
  const previous = sessionByProfileId.get(profile.id);
  if (previous && previous !== result.session_id) void client.disconnect(previous).catch(() => {});
  sessionByProfileId.set(profile.id, result.session_id);
  memorySecrets.set(profile.id, { ...secret });
  return result.session_id;
}
async function restoreSession(profileId: string, client: MssqlSessionClient): Promise<string> {
  await client.startSidecar().catch(ignoreSidecarStartError);
  const profile = readSavedMssqlConnections().find((item) => item.id === profileId);
  if (!profile) throw new MssqlReconnectRequiredError("Reconnect to SQL Server in Add Data.");
  const secret = resolveMssqlSecret(profileId, {});
  const required = requiredMssqlSecret(profile.authMethod);
  if (required && !secret[required]) {
    throw new MssqlReconnectRequiredError("Reconnect to SQL Server in Add Data.", "secret-missing");
  }
  const sessionId = await openMssqlSession(profile, secret, client);
  if (!readSavedMssqlConnections().some((item) => item.id === profileId)) {
    releaseMssqlSession(profileId, sessionId, client);
    throw new MssqlReconnectRequiredError("Reconnect to SQL Server in Add Data.");
  }
  return sessionId;
}
function restoreSessionOnce(profileId: string, client: MssqlSessionClient): Promise<string> {
  let pending = restoringByProfileId.get(profileId);
  if (!pending) {
    pending = restoreSession(profileId, client).finally(() =>
      restoringByProfileId.delete(profileId),
    );
    restoringByProfileId.set(profileId, pending);
  }
  return pending;
}
export async function withMssqlSession<T>(
  profileId: string,
  run: (sessionId: string) => Promise<T>,
  client = defaultMssqlSessionClient,
): Promise<T> {
  let sessionId =
    sessionByProfileId.get(profileId) ?? (await restoreSessionOnce(profileId, client));
  try {
    return await run(sessionId);
  } catch (error) {
    if (!(error instanceof MssqlSessionExpiredError)) throw error;
    // Drop only the session that expired: another caller may already have
    // replaced it, and that newer session is the one to retry on.
    if (sessionByProfileId.get(profileId) === sessionId) sessionByProfileId.delete(profileId);
    sessionId = sessionByProfileId.get(profileId) ?? (await restoreSessionOnce(profileId, client));
    return run(sessionId);
  }
}
/** Drop and disconnect a session that an abandoned connect attempt opened. */
export function releaseMssqlSession(
  profileId: string,
  sessionId: string,
  client = defaultMssqlSessionClient,
): void {
  if (sessionByProfileId.get(profileId) === sessionId) {
    sessionByProfileId.delete(profileId);
    memorySecrets.delete(profileId);
  }
  void client.disconnect(sessionId).catch(() => {});
}

/** Disconnect a live profile session but retain memory-only credentials for recovery. */
export function disconnectMssqlProfileSession(
  profileId: string,
  client = defaultMssqlSessionClient,
): void {
  const sessionId = sessionByProfileId.get(profileId);
  if (!sessionId) return;
  sessionByProfileId.delete(profileId);
  void client.disconnect(sessionId).catch(() => {});
}

/** Disconnect and clear secrets for a removed or evicted saved profile. */
export function discardMssqlProfileSession(
  profileId: string,
  client = defaultMssqlSessionClient,
): void {
  const sessionId = sessionByProfileId.get(profileId);
  sessionByProfileId.delete(profileId);
  memorySecrets.delete(profileId);
  restoringByProfileId.delete(profileId);
  if (sessionId) void client.disconnect(sessionId).catch(() => {});
}

/** Forget a profile, its live session, and all session-only credentials. */
export function forgetMssqlProfile(
  profileId: string,
  client = defaultMssqlSessionClient,
): MssqlConnectionProfile[] {
  discardMssqlProfileSession(profileId, client);
  return forgetMssqlConnection(profileId);
}
export function resetMssqlSessions(): void {
  sessionByProfileId.clear();
  memorySecrets.clear();
  restoringByProfileId.clear();
}

/**
 * The app's {@link S3UrlSigner}: resolves a connection's credentials (access
 * keys, AWS profiles including SSO, or the environment), finds each bucket's
 * region, and presigns with `@geolibre/core`. Installed once at startup by
 * {@link installS3Signer}; every reader then gets signed URLs through
 * `resolveReadableUrl`.
 */
import {
  parseS3Error,
  presignS3Url,
  registerS3UrlSigner,
  s3ObjectHttpsUrl,
  type S3Credentials,
  type S3PresignRequest,
  type S3SignedUrl,
  type S3UrlSigner,
} from "@geolibre/core";
import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./is-tauri";
import {
  isS3ConnectionComplete,
  matchS3Connection,
  needsDesktopResolution,
  type S3Connection,
} from "./s3-connections";

/** How long a presigned read URL lives when the credentials do not expire sooner. */
const PRESIGN_SECONDS = 12 * 60 * 60;
/** Signed URLs and credentials this close to expiry are minted again. */
const EXPIRY_MARGIN_MS = 10 * 60 * 1000;
/** Non-expiring profile/environment credentials are re-read after this long. */
const STATIC_CREDENTIAL_TTL_MS = 15 * 60 * 1000;
const DEFAULT_REGION = "us-east-1";
const SIGNED_URL_CACHE_LIMIT = 500;

interface ResolvedCredentials extends S3Credentials {
  region?: string;
}

interface CachedCredentials {
  /** The connection fields the credentials were resolved from. */
  fingerprint: string;
  credentials: Promise<ResolvedCredentials>;
  /** Epoch ms after which the entry is resolved again. */
  refreshAt: number;
}

const credentialCache = new Map<string, CachedCredentials>();
const signedUrlCache = new Map<string, S3SignedUrl>();
/** Bucket → region, learned from S3's wrong-region errors. */
const bucketRegions = new Map<string, string>();
const pendingRegionProbes = new Map<string, Promise<string | null>>();

function connectionFingerprint(connection: S3Connection): string {
  return [
    connection.source,
    connection.profile,
    connection.accessKeyId,
    connection.secretAccessKey,
    connection.sessionToken,
    connection.endpoint,
    connection.pathStyle,
    connection.region,
    connection.roleArn,
    connection.externalId,
  ].join("\u0000");
}

interface NativeCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  expiration?: number;
  region?: string;
}

async function resolveUncached(connection: S3Connection): Promise<ResolvedCredentials> {
  if (!isS3ConnectionComplete(connection)) {
    throw new Error(
      connection.source === "keys" && !connection.secretAccessKey
        ? `S3 connection "${connection.name}" has no access key.`
        : `S3 connection "${connection.name}" has an invalid role ARN.`,
    );
  }
  if (!needsDesktopResolution(connection)) {
    return {
      accessKeyId: connection.accessKeyId,
      secretAccessKey: connection.secretAccessKey,
      ...(connection.sessionToken ? { sessionToken: connection.sessionToken } : {}),
    };
  }
  if (!isTauri()) {
    throw new Error(
      `S3 connection "${connection.name}" uses an AWS profile, the environment, an instance role, or assumes an IAM role, which only the desktop app can do.`,
    );
  }
  const resolved = await invoke<NativeCredentials>("aws_resolve_credentials", {
    source: connection.source,
    profile: connection.profile || null,
    keys:
      connection.source === "keys"
        ? {
            accessKeyId: connection.accessKeyId,
            secretAccessKey: connection.secretAccessKey,
            sessionToken: connection.sessionToken || null,
          }
        : null,
    role: connection.roleArn
      ? { roleArn: connection.roleArn, externalId: connection.externalId || null }
      : null,
    region: connection.region || null,
  });
  return {
    accessKeyId: resolved.accessKeyId,
    secretAccessKey: resolved.secretAccessKey,
    ...(resolved.sessionToken ? { sessionToken: resolved.sessionToken } : {}),
    ...(resolved.expiration ? { expiresAt: resolved.expiration } : {}),
    ...(resolved.region ? { region: resolved.region } : {}),
  };
}

/**
 * The connection's credentials, resolved once and shared until they near
 * expiry. A failed resolution is not cached, so signing in (or fixing the
 * profile) takes effect on the next read.
 */
export function resolveS3ConnectionCredentials(
  connection: S3Connection,
): Promise<ResolvedCredentials> {
  const fingerprint = connectionFingerprint(connection);
  const cached = credentialCache.get(connection.id);
  if (cached && cached.fingerprint === fingerprint && cached.refreshAt > Date.now()) {
    return cached.credentials;
  }
  const credentials = resolveUncached(connection);
  const entry: CachedCredentials = {
    fingerprint,
    credentials,
    // Provisional until the credentials resolve and say when they expire.
    refreshAt: Date.now() + STATIC_CREDENTIAL_TTL_MS,
  };
  credentialCache.set(connection.id, entry);
  credentials.then(
    (resolved) => {
      if (resolved.expiresAt) entry.refreshAt = resolved.expiresAt - EXPIRY_MARGIN_MS;
      else if (connection.source === "keys") entry.refreshAt = Number.POSITIVE_INFINITY;
    },
    () => {
      if (credentialCache.get(connection.id) === entry) credentialCache.delete(connection.id);
    },
  );
  return credentials;
}

/** Forgets cached credentials and signed URLs (after a sign-in or a settings change). */
export function clearS3SignerCaches(): void {
  credentialCache.clear();
  signedUrlCache.clear();
}

async function fetchText(
  url: string,
  signal?: AbortSignal,
): Promise<{ status: number; body: string }> {
  if (isTauri()) {
    const { fetchUrlResponse } = await import("./native-http");
    const response = await fetchUrlResponse(url, { context: "S3", timeoutSecs: 30 });
    return { status: response.status, body: new TextDecoder().decode(response.body) };
  }
  const response = await fetch(url, { signal });
  return { status: response.status, body: await response.text() };
}

function presignFor(
  connection: S3Connection,
  credentials: ResolvedCredentials,
  request: S3PresignRequest,
  region: string,
  expiresIn: number,
): Promise<string> {
  const unsigned = new URL(
    s3ObjectHttpsUrl(
      { bucket: request.bucket, key: request.key },
      { region, endpoint: connection.endpoint, pathStyle: connection.pathStyle },
    ),
  );
  for (const [name, value] of Object.entries(request.query ?? {})) {
    unsigned.searchParams.set(name, value);
  }
  return presignS3Url({ url: unsigned.href, region, credentials, expiresIn });
}

/**
 * Learns an AWS bucket's region with one signed, empty listing: S3 answers a
 * request signed for the wrong region with an error naming the right one.
 * Resolves null when S3 does not say (no list permission, no network), and the
 * caller falls back to its default.
 */
function probeBucketRegion(
  connection: S3Connection,
  credentials: ResolvedCredentials,
  bucket: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const known = bucketRegions.get(bucket);
  if (known) return Promise.resolve(known);
  const pending = pendingRegionProbes.get(bucket);
  if (pending) return pending;
  const probe = (async () => {
    const url = await presignFor(
      connection,
      credentials,
      { bucket, key: "", query: { "list-type": "2", "max-keys": "0" } },
      DEFAULT_REGION,
      300,
    );
    const response = await fetchText(url, signal);
    if (response.status === 200) return DEFAULT_REGION;
    return parseS3Error(response.body)?.region ?? null;
  })()
    .catch(() => null)
    .then((region) => {
      if (region) bucketRegions.set(bucket, region);
      return region;
    })
    .finally(() => pendingRegionProbes.delete(bucket));
  pendingRegionProbes.set(bucket, probe);
  return probe;
}

/** Records a bucket's region, e.g. from an error body the S3 browser read. */
export function rememberS3BucketRegion(bucket: string, region: string): void {
  bucketRegions.set(bucket, region);
}

async function regionFor(
  connection: S3Connection,
  credentials: ResolvedCredentials,
  request: S3PresignRequest,
  signal?: AbortSignal,
): Promise<string> {
  if (connection.region) return connection.region;
  if (request.region) return request.region;
  // ListBuckets is answered by the global endpoint, signed for us-east-1.
  if (!request.bucket) return DEFAULT_REGION;
  const known = bucketRegions.get(request.bucket);
  if (known) return known;
  // A custom endpoint has no region errors to learn from; `us-east-1` is what
  // MinIO and most S3-compatible stores expect by default.
  if (connection.endpoint) return credentials.region || DEFAULT_REGION;
  return (
    (await probeBucketRegion(connection, credentials, request.bucket, signal)) ??
    credentials.region ??
    DEFAULT_REGION
  );
}

function cacheKey(connection: S3Connection, request: S3PresignRequest): string | null {
  // Listings carry continuation tokens and are signed per call.
  if (!request.bucket || (request.query && Object.keys(request.query).length > 0)) return null;
  return `${connection.id}\u0000${request.bucket}\u0000${request.key}`;
}

function rememberSignedUrl(key: string, signed: S3SignedUrl): void {
  if (signedUrlCache.size >= SIGNED_URL_CACHE_LIMIT) {
    const oldest = signedUrlCache.keys().next().value;
    if (oldest !== undefined) signedUrlCache.delete(oldest);
  }
  signedUrlCache.set(key, signed);
}

/**
 * Builds the signer over a live view of the configured connections.
 *
 * @param getConnections Returns the current connections (read on every call,
 *   so settings edits apply without reinstalling).
 */
export function createS3Signer(
  getConnections: () => readonly S3Connection[],
  defaultLocation?: { get(): string; set(location: string): void },
): S3UrlSigner {
  return {
    ...(defaultLocation
      ? {
          defaultLocation: () => defaultLocation.get(),
          setDefaultLocation: (location: string) => defaultLocation.set(location),
        }
      : {}),
    covers: (bucket) => matchS3Connection(getConnections(), bucket) !== null,
    connections: () =>
      getConnections().map(({ id, name, buckets }) => ({ id, name, buckets: [...buckets] })),
    fetchText,
    async presign(request, signal) {
      const connection = request.connectionId
        ? (getConnections().find((candidate) => candidate.id === request.connectionId) ?? null)
        : matchS3Connection(getConnections(), request.bucket);
      if (!connection) return null;
      if (connection.source === "anonymous") {
        const href = s3ObjectHttpsUrl(
          { bucket: request.bucket, key: request.key },
          {
            region: connection.region || request.region,
            endpoint: connection.endpoint,
            pathStyle: connection.pathStyle,
          },
        );
        const url = new URL(href);
        for (const [name, value] of Object.entries(request.query ?? {})) {
          url.searchParams.set(name, value);
        }
        return { href: url.href, expiresAt: Number.POSITIVE_INFINITY };
      }
      const key = cacheKey(connection, request);
      const cached = key ? signedUrlCache.get(key) : undefined;
      if (cached && cached.expiresAt - EXPIRY_MARGIN_MS > Date.now()) return cached;

      const credentials = await resolveS3ConnectionCredentials(connection);
      const region = await regionFor(connection, credentials, request, signal);
      const lifetimeMs = credentials.expiresAt
        ? Math.min(PRESIGN_SECONDS * 1000, credentials.expiresAt - Date.now())
        : PRESIGN_SECONDS * 1000;
      const expiresIn = Math.max(60, Math.floor(lifetimeMs / 1000));
      const href = await presignFor(connection, credentials, request, region, expiresIn);
      const signed = { href, expiresAt: Date.now() + expiresIn * 1000 };
      if (key) rememberSignedUrl(key, signed);
      return signed;
    },
  };
}

/**
 * Installs the signer for the app's lifetime. Connection edits change what it
 * signs with immediately; cached credentials and URLs are dropped whenever the
 * connection list changes.
 *
 * @param getConnections Returns the current connections.
 * @param subscribe Registers a listener for connection changes; returns an unsubscribe.
 * @param defaultLocation Reads and persists the S3 browser's default location.
 * @returns A function that uninstalls the signer.
 */
export function installS3Signer(
  getConnections: () => readonly S3Connection[],
  subscribe: (listener: () => void) => () => void,
  defaultLocation?: { get(): string; set(location: string): void },
): () => void {
  registerS3UrlSigner(createS3Signer(getConnections, defaultLocation));
  const unsubscribe = subscribe(clearS3SignerCaches);
  return () => {
    unsubscribe();
    registerS3UrlSigner(null);
  };
}

/** What {@link testS3Connection} found. */
export type S3ConnectionTestResult =
  | { kind: "listed"; bucket: string; objectCount: number }
  | { kind: "credentials"; accessKeyHint: string };

/**
 * Checks a (possibly unsaved) connection: resolves its credentials and, when
 * it names a concrete bucket, lists one key from it.
 *
 * @param connection The connection as edited in Settings.
 * @returns What worked.
 * @throws With S3's own error message when the listing is refused.
 */
export async function testS3Connection(connection: S3Connection): Promise<S3ConnectionTestResult> {
  const probe = { ...connection, id: `test-${connection.id}` };
  credentialCache.delete(probe.id);
  const bucket = connection.buckets.find((pattern) => !pattern.includes("*"));
  if (!bucket) {
    if (connection.source === "anonymous") return { kind: "credentials", accessKeyHint: "" };
    const credentials = await resolveS3ConnectionCredentials(probe);
    return { kind: "credentials", accessKeyHint: credentials.accessKeyId.slice(-4) };
  }
  const signer = createS3Signer(() => [{ ...probe, buckets: [] }]);
  const signed = await signer.presign({
    bucket,
    key: "",
    query: { "list-type": "2", "max-keys": "1" },
  });
  if (!signed) throw new Error("The connection does not cover this bucket.");
  const response = await fetchText(signed.href);
  if (response.status !== 200) {
    const error = parseS3Error(response.body);
    throw new Error(
      error ? `${error.code}: ${error.message}` : `S3 answered HTTP ${response.status}.`,
    );
  }
  const count = Number(response.body.match(/<KeyCount>(\d+)<\/KeyCount>/)?.[1] ?? 0);
  return { kind: "listed", bucket, objectCount: count };
}

/** A profile from the shared AWS config files. */
export interface AwsProfileSummary {
  name: string;
  kind: "static" | "sso" | "process" | "role" | "other";
  region?: string;
}

/** The profiles in `~/.aws/config` and `~/.aws/credentials` (desktop only). */
export async function listAwsProfiles(): Promise<AwsProfileSummary[]> {
  if (!isTauri()) return [];
  return invoke<AwsProfileSummary[]>("aws_list_profiles");
}

interface SsoLoginStart {
  loginId: string;
  verificationUri: string;
  userCode: string;
  interval: number;
  expiresIn: number;
}

/**
 * Signs in to IAM Identity Center for an SSO profile with the device flow,
 * the same way `aws sso login` does, and caches the token where the AWS CLI
 * keeps it.
 *
 * @param profile The SSO profile name.
 * @param onCode Called with the page to open and the code the user confirms there.
 * @param signal Stops polling.
 */
export async function signInWithAwsSso(
  profile: string,
  onCode: (verificationUri: string, userCode: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  const start = await invoke<SsoLoginStart>("aws_sso_login_start", { profile });
  onCode(start.verificationUri, start.userCode);
  let interval = Math.max(1, start.interval) * 1000;
  const deadline = Date.now() + start.expiresIn * 1000;
  while (Date.now() < deadline) {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, interval);
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(signal.reason ?? new DOMException("Sign-in cancelled", "AbortError"));
        },
        { once: true },
      );
    });
    const status = await invoke<string>("aws_sso_login_poll", { loginId: start.loginId });
    if (status === "complete") {
      clearS3SignerCaches();
      return;
    }
    if (status === "slow_down") interval += 5000;
  }
  throw new Error("The AWS sign-in code expired. Start the sign-in again.");
}

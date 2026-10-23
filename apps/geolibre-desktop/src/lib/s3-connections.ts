/**
 * S3 connections: the device-local settings that say which credentials read
 * which buckets. Stored in {@link DesktopSettings}; the secret key and session
 * token of an access-key connection live in the OS credential store on desktop
 * (see `desktop-settings-secrets.ts`), never in a project file.
 */

/**
 * Where a connection's credentials come from.
 *
 * - `keys`: an access key pasted into Settings (web and desktop).
 * - `profile`: a named profile in `~/.aws/config` / `~/.aws/credentials`,
 *   including IAM Identity Center (SSO) profiles (desktop only).
 * - `environment`: `AWS_ACCESS_KEY_ID` and friends in GeoLibre's own process
 *   environment (desktop only).
 * - `instance`: the IAM role of the machine GeoLibre runs on: web identity
 *   (EKS IRSA), ECS/EKS container credentials, or the EC2 instance profile
 *   (desktop only).
 * - `anonymous`: no signing, for public buckets on a custom endpoint.
 */
export type S3CredentialSource = "keys" | "profile" | "environment" | "instance" | "anonymous";

export const S3_CREDENTIAL_SOURCES: readonly S3CredentialSource[] = [
  "keys",
  "profile",
  "environment",
  "instance",
  "anonymous",
];

/** Whether resolving the connection needs the desktop app (Rust side). */
export function needsDesktopResolution(connection: S3Connection): boolean {
  return (
    DESKTOP_ONLY_S3_SOURCES.has(connection.source) ||
    (connection.source !== "anonymous" && Boolean(connection.roleArn))
  );
}

/** Sources that need the desktop app to read local files, the environment, or instance metadata. */
export const DESKTOP_ONLY_S3_SOURCES: ReadonlySet<S3CredentialSource> = new Set([
  "profile",
  "environment",
  "instance",
]);

export interface S3Connection {
  id: string;
  name: string;
  source: S3CredentialSource;
  /**
   * Bucket name patterns (`*` wildcard) this connection signs for. Empty means
   * every bucket not claimed by a more specific connection.
   */
  buckets: string[];
  /** Default signing region; empty auto-detects per bucket. */
  region: string;
  /** Custom endpoint for S3-compatible stores; empty for AWS. */
  endpoint: string;
  /** Path-style addressing, which most S3-compatible stores need. */
  pathStyle: boolean;
  /** Profile name for `profile`; empty uses `AWS_PROFILE`, else `default`. */
  profile: string;
  /** Access key id for `keys`. Not a secret on its own. */
  accessKeyId: string;
  /** Secret access key for `keys`. Kept in the OS credential store on desktop. */
  secretAccessKey: string;
  /** Optional session token for `keys`. Kept like the secret key. */
  sessionToken: string;
  /**
   * IAM role to assume on top of the source's credentials (STS AssumeRole),
   * e.g. a cross-account read role. Empty for none. Desktop only: STS does
   * not answer browser (CORS) requests.
   */
  roleArn: string;
  /** External ID the role's trust policy requires, if any. */
  externalId: string;
}

/** Fields of {@link S3Connection} that hold secrets. */
export const S3_CONNECTION_SECRET_FIELDS = ["secretAccessKey", "sessionToken"] as const;
export type S3ConnectionSecretField = (typeof S3_CONNECTION_SECRET_FIELDS)[number];

/** A fresh connection with defaults; `id` must be unique among connections. */
export function createS3Connection(id: string, name: string): S3Connection {
  return {
    id,
    name,
    source: "keys",
    buckets: [],
    region: "",
    endpoint: "",
    pathStyle: false,
    profile: "",
    accessKeyId: "",
    secretAccessKey: "",
    sessionToken: "",
    roleArn: "",
    externalId: "",
  };
}

const MAX_CONNECTIONS = 50;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Splits a free-text bucket list (commas, spaces, or new lines) into
 * patterns, accepting `s3://bucket/…` forms and dropping duplicates.
 */
export function parseBucketPatterns(value: string | readonly unknown[]): string[] {
  const parts = typeof value === "string" ? value.split(/[\s,]+/) : value.map(text);
  const patterns = parts
    .map((part) =>
      String(part)
        .trim()
        .replace(/^s3a?:\/\//i, "")
        .replace(/\/.*$/, ""),
    )
    .filter((part) => /^[A-Za-z0-9.*_-]{1,255}$/.test(part));
  return Array.from(new Set(patterns));
}

/** Validates stored connections (localStorage can hold anything). */
export function normalizeS3Connections(value: unknown): S3Connection[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const connections: S3Connection[] = [];
  for (const item of value.slice(0, MAX_CONNECTIONS)) {
    if (!item || typeof item !== "object") continue;
    const candidate = item as Record<string, unknown>;
    const id = text(candidate.id);
    if (!ID_PATTERN.test(id) || seen.has(id)) continue;
    seen.add(id);
    const source = S3_CREDENTIAL_SOURCES.includes(candidate.source as S3CredentialSource)
      ? (candidate.source as S3CredentialSource)
      : "keys";
    connections.push({
      id,
      name: text(candidate.name) || id,
      source,
      buckets: Array.isArray(candidate.buckets) ? parseBucketPatterns(candidate.buckets) : [],
      region: text(candidate.region).toLowerCase(),
      endpoint: text(candidate.endpoint),
      pathStyle: candidate.pathStyle === true,
      profile: text(candidate.profile),
      accessKeyId: text(candidate.accessKeyId),
      secretAccessKey: text(candidate.secretAccessKey),
      sessionToken: text(candidate.sessionToken),
      roleArn: text(candidate.roleArn),
      externalId: text(candidate.externalId),
    });
  }
  return connections;
}

function patternMatches(pattern: string, bucket: string): boolean {
  if (!pattern.includes("*")) return pattern.toLowerCase() === bucket.toLowerCase();
  const escaped = pattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`, "i").test(bucket);
}

/**
 * The connection that signs for `bucket`: the first whose patterns name it,
 * else the first catch-all (no patterns). A pattern without a wildcard wins
 * over a wildcard one, so `data-prod` can be pinned while `data-*` covers the
 * rest.
 */
export function matchS3Connection(
  connections: readonly S3Connection[],
  bucket: string,
): S3Connection | null {
  const exact = connections.find((connection) =>
    connection.buckets.some((pattern) => !pattern.includes("*") && patternMatches(pattern, bucket)),
  );
  if (exact) return exact;
  const wildcard = connections.find((connection) =>
    connection.buckets.some((pattern) => pattern.includes("*") && patternMatches(pattern, bucket)),
  );
  return wildcard ?? connections.find((connection) => connection.buckets.length === 0) ?? null;
}

/** Whether a connection has what it needs to sign, without resolving anything. */
export function isS3ConnectionComplete(connection: S3Connection): boolean {
  if (connection.roleArn && !/^arn:aws[a-z-]*:iam::\d{12}:role\/.+/.test(connection.roleArn)) {
    return false;
  }
  if (connection.source === "keys") {
    return Boolean(connection.accessKeyId && connection.secretAccessKey);
  }
  return true;
}

/**
 * Validates the S3 Browser's default location, keeping it in the
 * `s3://bucket/prefix/` form (a trailing slash, since it names a folder).
 *
 * @returns The normalized location, or "" when the value names no bucket.
 */
export function normalizeS3DefaultLocation(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim().replace(/^s3a?:\/\//i, "");
  if (!trimmed) return "";
  const [bucket, ...rest] = trimmed.split("/");
  if (!/^[a-z0-9][a-z0-9.-]{1,254}$/i.test(bucket)) return "";
  const prefix = rest.join("/");
  return `s3://${bucket}/${prefix && !prefix.endsWith("/") ? `${prefix}/` : prefix}`;
}

/**
 * How long a presigned URL may live, in seconds: `maxSeconds`, cut short by
 * the credentials' expiry, never under a minute.
 *
 * @param expiresAt When the credentials stop working (epoch ms), if they do.
 * @param now The current time (epoch ms).
 * @param maxSeconds The longest lifetime wanted.
 * @returns The lifetime, or null when the credentials have already expired.
 */
export function presignLifetimeSeconds(
  expiresAt: number | undefined,
  now: number,
  maxSeconds: number,
): number | null {
  if (expiresAt === undefined) return maxSeconds;
  const remainingMs = expiresAt - now;
  if (remainingMs <= 0) return null;
  return Math.max(60, Math.floor(Math.min(maxSeconds * 1000, remainingMs) / 1000));
}

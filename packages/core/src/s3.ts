/**
 * Amazon S3 (and S3-compatible) object URLs: parsing, public HTTPS mapping,
 * SigV4 query-string presigning, and the registry the app uses to plug
 * credentialed signing into every reader.
 *
 * Readers in GeoLibre take a plain HTTPS URL (geotiff.js, cog-tiler-wasm,
 * pmtiles, DuckDB-WASM's HTTP reader, the vector control). A presigned URL is
 * the one form of authenticated S3 access all of them accept without a custom
 * fetch hook, so private objects are read by signing the URL first and handing
 * the reader the result. Layers keep the unsigned source URL (`s3://…` or the
 * plain object URL); the signed one is minted again on every load, so a saved
 * project never carries a signature or a session token.
 */

/** A bucket and object key, with the endpoint the URL named, if any. */
export interface S3ObjectLocation {
  bucket: string;
  /** The raw (decoded) object key, without a leading slash. */
  key: string;
  /** The region an AWS HTTPS URL named in its host, when it named one. */
  region?: string;
}

/** Where and how a bucket is addressed. */
export interface S3EndpointConfig {
  /** Signing region, e.g. `us-east-1`. S3-compatible stores often accept `auto`. */
  region: string;
  /**
   * Custom endpoint origin for S3-compatible stores (MinIO, Cloudflare R2,
   * Wasabi, Ceph), e.g. `https://minio.example.com:9000`. Empty for AWS.
   */
  endpoint?: string;
  /** Address the bucket in the path instead of the host name. */
  pathStyle?: boolean;
}

/** AWS credentials used to sign a request. */
export interface S3Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  /** Epoch milliseconds at which temporary credentials stop working. */
  expiresAt?: number;
}

/** A presigned URL and the moment it stops working. */
export interface S3SignedUrl {
  href: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

/** SigV4 allows a presigned URL to live at most seven days. */
export const S3_MAX_PRESIGN_SECONDS = 7 * 24 * 60 * 60;

const S3_SCHEME = /^s3a?:\/\//i;
// bucket.s3.amazonaws.com, bucket.s3.us-west-2.amazonaws.com,
// bucket.s3-us-west-2.amazonaws.com, bucket.s3.dualstack.us-west-2.amazonaws.com
const VIRTUAL_HOST = /^(.+)\.s3(?:[.-](?:dualstack\.)?([a-z0-9-]+))?\.amazonaws\.com(?:\.cn)?$/i;
// s3.amazonaws.com, s3.us-west-2.amazonaws.com, s3-us-west-2.amazonaws.com
const PATH_HOST = /^s3(?:[.-](?:dualstack\.)?([a-z0-9-]+))?\.amazonaws\.com(?:\.cn)?$/i;

function regionFromHost(value: string | undefined): string | undefined {
  // `s3-external-1` and `s3.dualstack` carry no region of their own.
  if (!value || value === "external-1" || value === "dualstack") return undefined;
  return value.toLowerCase();
}

/** Static-website endpoints serve HTML, not the REST API a signature targets. */
function isWebsiteRegion(value: string | undefined): boolean {
  return Boolean(value && /^website/i.test(value));
}

function decodeKey(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

/**
 * Parses an `s3://bucket/key` URI or an AWS S3 HTTPS object URL
 * (virtual-hosted or path-style, any region) into its bucket and key.
 * Query strings and fragments are ignored, so a presigned URL parses to the
 * object it signs.
 *
 * @param url The URL to parse.
 * @returns The bucket and key, or null when the URL is not an S3 object URL.
 */
export function parseS3Url(url: string): S3ObjectLocation | null {
  const trimmed = url.trim();
  if (S3_SCHEME.test(trimmed)) {
    const rest = trimmed.replace(S3_SCHEME, "").split(/[?#]/)[0];
    const slash = rest.indexOf("/");
    const bucket = slash === -1 ? rest : rest.slice(0, slash);
    const key = slash === -1 ? "" : rest.slice(slash + 1);
    return isSafeBucketName(bucket) ? { bucket, key } : null;
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname.replace(/^\//, "");
  const virtual = host.match(VIRTUAL_HOST);
  if (virtual && !PATH_HOST.test(host)) {
    if (isWebsiteRegion(virtual[2])) return null;
    const region = regionFromHost(virtual[2]);
    return { bucket: virtual[1], key: decodeKey(path), ...(region ? { region } : {}) };
  }
  const pathStyle = host.match(PATH_HOST);
  if (pathStyle) {
    if (isWebsiteRegion(pathStyle[1])) return null;
    const slash = path.indexOf("/");
    const bucket = slash === -1 ? path : path.slice(0, slash);
    if (!bucket) return null;
    const region = regionFromHost(pathStyle[1]);
    return {
      bucket: decodeKey(bucket),
      key: slash === -1 ? "" : decodeKey(path.slice(slash + 1)),
      ...(region ? { region } : {}),
    };
  }
  return null;
}

/**
 * Bucket names are letters, digits, dots, dashes, and underscores (the last
 * two outside AWS's own rules, for S3-compatible stores). Anything else, a
 * backslash or `@` say, could move a virtual-hosted URL's authority to
 * another host before a signature is attached, so it is refused outright.
 */
const SAFE_BUCKET_NAME = /^[A-Za-z0-9._-]{1,255}$/;

function isSafeBucketName(bucket: string): boolean {
  return SAFE_BUCKET_NAME.test(bucket);
}

/** Whether `url` is an `s3://` URI (as opposed to an HTTPS object URL). */
export function isS3Uri(url: string): boolean {
  return S3_SCHEME.test(url.trim());
}

/** Formats a location as an `s3://bucket/key` URI. */
export function formatS3Uri(location: S3ObjectLocation): string {
  return `s3://${location.bucket}/${location.key}`;
}

/**
 * URI-encodes a key the way SigV4 canonicalizes an S3 path: every byte except
 * the unreserved set and `/` is percent-encoded, once.
 */
export function encodeS3Key(key: string): string {
  return key
    .split("/")
    .map((segment) =>
      encodeURIComponent(segment).replace(
        /[!'()*]/g,
        (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
      ),
    )
    .join("/");
}

/** A custom endpoint's path, without a trailing slash ("" for none). */
function endpointPathPrefix(base: URL): string {
  return base.pathname.replace(/\/+$/, "");
}

/**
 * Builds the HTTPS URL of an object.
 *
 * AWS buckets whose name contains a dot are addressed path-style, since the
 * `*.s3.amazonaws.com` wildcard certificate covers one label only.
 *
 * @param location The bucket and key.
 * @param config The endpoint; without one the global AWS endpoint is used.
 * @returns The unsigned object URL.
 */
export function s3ObjectHttpsUrl(
  location: S3ObjectLocation,
  config: Partial<S3EndpointConfig> = {},
): string {
  if (location.bucket && !isSafeBucketName(location.bucket)) {
    throw new Error(`Invalid S3 bucket name: ${location.bucket}`);
  }
  const key = encodeS3Key(location.key);
  const endpoint = config.endpoint?.trim().replace(/\/+$/, "");
  // No bucket addresses the service itself (ListBuckets).
  if (!location.bucket) {
    if (endpoint) {
      const base = new URL(endpoint.includes("://") ? endpoint : `https://${endpoint}`);
      return `${base.protocol}//${base.host}${endpointPathPrefix(base)}/`;
    }
    const serviceRegion = config.region || location.region;
    return serviceRegion && serviceRegion !== "us-east-1"
      ? `https://s3.${serviceRegion}.amazonaws.com/`
      : "https://s3.amazonaws.com/";
  }
  if (endpoint) {
    const base = new URL(endpoint.includes("://") ? endpoint : `https://${endpoint}`);
    // An S3-compatible gateway may sit under a path (`https://host/s3`).
    const prefix = endpointPathPrefix(base);
    return config.pathStyle
      ? `${base.protocol}//${base.host}${prefix}/${encodeS3Key(location.bucket)}/${key}`
      : `${base.protocol}//${location.bucket}.${base.host}${prefix}/${key}`;
  }
  const region = config.region || location.region;
  const host = region && region !== "us-east-1" ? `s3.${region}.amazonaws.com` : "s3.amazonaws.com";
  if (config.pathStyle || location.bucket.includes(".")) {
    return `https://${host}/${encodeS3Key(location.bucket)}/${key}`;
  }
  return `https://${location.bucket}.${host}/${key}`;
}

// ---------------------------------------------------------------------------
// SigV4 query-string signing
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(value: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

async function hmac(key: ArrayBuffer | Uint8Array, value: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(value));
}

/** RFC 3986 encoding, as SigV4 requires for query names and values. */
function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function amzDate(date: Date): { stamp: string; day: string } {
  const stamp = date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
  return { stamp, day: stamp.slice(0, 8) };
}

export interface PresignS3Options {
  /** The unsigned HTTPS object URL (see {@link s3ObjectHttpsUrl}). */
  url: string;
  region: string;
  credentials: S3Credentials;
  /** Lifetime in seconds, clamped to 1…{@link S3_MAX_PRESIGN_SECONDS}. */
  expiresIn: number;
  /** HTTP method the URL authorizes. Defaults to GET. */
  method?: string;
  /** Signing time; defaults to now. Exposed for tests. */
  now?: Date;
}

/**
 * Presigns an S3 request with AWS Signature Version 4 in the query string.
 * Runs on WebCrypto, so it works in the browser, the Tauri webview, and Node.
 *
 * The URL authorizes exactly one method: a GET URL cannot answer a HEAD, so
 * readers that probe with HEAD need a GET range request instead.
 *
 * @param options The object URL, region, credentials, and lifetime.
 * @returns The presigned URL.
 */
export async function presignS3Url(options: PresignS3Options): Promise<string> {
  const { credentials, region } = options;
  const method = (options.method ?? "GET").toUpperCase();
  const url = new URL(options.url);
  const { stamp, day } = amzDate(options.now ?? new Date());
  const scope = `${day}/${region}/s3/aws4_request`;
  const expiresIn = Math.max(1, Math.min(S3_MAX_PRESIGN_SECONDS, Math.floor(options.expiresIn)));

  const params: Array<[string, string]> = [];
  url.searchParams.forEach((value, name) => {
    if (!name.toLowerCase().startsWith("x-amz-")) params.push([name, value]);
  });
  params.push(
    ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
    ["X-Amz-Credential", `${credentials.accessKeyId}/${scope}`],
    ["X-Amz-Date", stamp],
    ["X-Amz-Expires", String(expiresIn)],
    ["X-Amz-SignedHeaders", "host"],
  );
  if (credentials.sessionToken) params.push(["X-Amz-Security-Token", credentials.sessionToken]);
  const canonicalQuery = params
    .map(([name, value]) => [encodeRfc3986(name), encodeRfc3986(value)] as const)
    .sort(([a, av], [b, bv]) => (a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`)
    .join("&");

  // The URL constructor already percent-encoded the path; S3 signs it as sent.
  const canonicalPath = url.pathname || "/";
  const canonicalRequest = [
    method,
    canonicalPath,
    canonicalQuery,
    `host:${url.host}\n`,
    "host",
    "UNSIGNED-PAYLOAD",
  ].join("\n");
  const stringToSign = ["AWS4-HMAC-SHA256", stamp, scope, await sha256Hex(canonicalRequest)].join(
    "\n",
  );

  const dateKey = await hmac(encoder.encode(`AWS4${credentials.secretAccessKey}`), day);
  const regionKey = await hmac(dateKey, region);
  const serviceKey = await hmac(regionKey, "s3");
  const signingKey = await hmac(serviceKey, "aws4_request");
  const signature = toHex(await hmac(signingKey, stringToSign));

  return `${url.origin}${canonicalPath}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

// ---------------------------------------------------------------------------
// Signer registry
// ---------------------------------------------------------------------------

/** One signed S3 GET: an object read, or a bucket-level call such as ListObjectsV2. */
export interface S3PresignRequest {
  bucket: string;
  /** Object key; empty for a bucket-level request. */
  key: string;
  /** Extra query parameters to sign (e.g. `list-type=2`). */
  query?: Record<string, string>;
  /** Region an AWS URL named, used ahead of the connection's default. */
  region?: string;
  /**
   * Sign with this connection instead of the one matched by bucket name (the
   * S3 browser listing a chosen connection's buckets, where `bucket` is empty).
   */
  connectionId?: string;
}

/** A configured connection, as the S3 browser lists it. No secrets. */
export interface S3ConnectionSummary {
  id: string;
  name: string;
  /** Bucket patterns the connection covers; empty means every bucket. */
  buckets: string[];
}

/**
 * Presigns S3 requests with the app's configured credentials. `presign`
 * resolves to null when no configured connection covers the bucket, in which
 * case the object is read anonymously.
 */
export interface S3UrlSigner {
  /** Whether a configured connection covers `bucket`. Must be synchronous. */
  covers(bucket: string): boolean;
  /** Presigns a GET; rejects when the connection's credentials cannot be resolved. */
  presign(request: S3PresignRequest, signal?: AbortSignal): Promise<S3SignedUrl | null>;
  /** The configured connections, for pickers. */
  connections(): S3ConnectionSummary[];
  /**
   * Fetches a presigned bucket-level URL (listing). The desktop app routes it
   * through its native HTTP client, which needs no bucket CORS rule.
   */
  fetchText?(url: string, signal?: AbortSignal): Promise<{ status: number; body: string }>;
  /**
   * Drops the cached credentials and signed URLs of the connection that
   * serves `target`, so the next `presign` resolves them afresh. Called when S3
   * refuses a request as expired.
   */
  invalidateCredentials?(target: { bucket?: string; connectionId?: string }): void;
  /** The persisted location (`s3://bucket/prefix/`) the S3 browser opens at, or "". */
  defaultLocation?(): string;
  /** Persists the S3 browser's default location; "" clears it. */
  setDefaultLocation?(location: string): void;
}

let activeSigner: S3UrlSigner | null = null;
/** Presigned URL → the unsigned URL it was minted for. Bounded. */
const sourceBySignedHref = new Map<string, string>();
const SIGNED_SOURCE_LIMIT = 500;

/** Installs (or with null, removes) the app's S3 signer. */
export function registerS3UrlSigner(signer: S3UrlSigner | null): void {
  activeSigner = signer;
}

/**
 * Whether reading `url` needs the S3 signer: it names an S3 object in a bucket
 * a configured connection covers.
 */
export function isCredentialedS3Url(url: string): boolean {
  if (!activeSigner) return false;
  const location = parseS3Url(url);
  return Boolean(location && activeSigner.covers(location.bucket));
}

/** Records that `signedHref` reads `sourceUrl`, so a layer can keep the latter. */
function rememberSignedSource(signedHref: string, sourceUrl: string): void {
  // Least recently used goes first: deleting before setting moves a URL that
  // is signed (handed out) again to the back of the eviction order.
  sourceBySignedHref.delete(signedHref);
  if (sourceBySignedHref.size >= SIGNED_SOURCE_LIMIT) {
    const oldest = sourceBySignedHref.keys().next().value;
    if (oldest !== undefined) sourceBySignedHref.delete(oldest);
  }
  sourceBySignedHref.set(signedHref, sourceUrl);
}

/** Removes the SigV4 query parameters (credential, token, signature) from a URL. */
function stripPresignParameters(url: string): string {
  try {
    const parsed = new URL(url);
    for (const name of [...parsed.searchParams.keys()]) {
      if (name.toLowerCase().startsWith("x-amz-")) parsed.searchParams.delete(name);
    }
    return parsed.href;
  } catch {
    return url;
  }
}

/**
 * The unsigned URL a presigned one was minted for by
 * {@link resolveReadableUrl}, or `url` itself. Layer sync runs every URL a
 * control reports through this, so the store (and a saved project) keeps the
 * `s3://` source rather than an expiring signature.
 */
export function unsignedSourceUrl(url: string): string;
export function unsignedSourceUrl(url: string | undefined): string | undefined;
export function unsignedSourceUrl(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  const known = sourceBySignedHref.get(url);
  if (known !== undefined) return known;
  // A presigned URL whose mapping was evicted must still never reach a saved
  // project: fall back to the object it signs, without the signature.
  if (!/[?&]x-amz-signature=/i.test(url)) return url;
  const location = parseS3Url(url);
  // An `s3://` URI cannot carry a key with `?` or `#` (they would be read as a
  // query or fragment), so such keys keep the object URL form.
  return location && !/[?#]/.test(location.key)
    ? formatS3Uri(location)
    : stripPresignParameters(url);
}

/**
 * Resolves a data URL into one a plain HTTP reader can fetch:
 *
 * - an S3 object in a bucket a configured connection covers → a presigned URL;
 * - any other `s3://` URI → the public HTTPS object URL (anonymous read);
 * - anything else → unchanged.
 *
 * @param url The URL a layer or query names.
 * @param signal Aborts a pending credential lookup.
 * @returns The URL to hand the reader.
 * @throws When the bucket is covered but its credentials cannot be resolved.
 */
export async function resolveReadableUrl(url: string, signal?: AbortSignal): Promise<string> {
  const location = parseS3Url(url);
  if (!location) return url;
  if (activeSigner?.covers(location.bucket)) {
    const signed = await activeSigner.presign(
      { bucket: location.bucket, key: location.key, region: location.region },
      signal,
    );
    if (signed) {
      rememberSignedSource(signed.href, url);
      return signed.href;
    }
  }
  return isS3Uri(url) ? s3ObjectHttpsUrl(location) : url;
}

/** The installed signer, for the S3 browser. */
export function getS3UrlSigner(): S3UrlSigner | null {
  return activeSigner;
}

// ---------------------------------------------------------------------------
// ListObjectsV2
// ---------------------------------------------------------------------------

/** One page of a ListObjectsV2 response. */
export interface S3ListPage {
  /** Common prefixes ("folders") under the requested prefix. */
  prefixes: string[];
  objects: Array<{ key: string; size: number; lastModified?: string }>;
  /** Present when more results follow. */
  nextContinuationToken?: string;
}

function decodeXmlText(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&amp;/g, "&");
}

function xmlTag(block: string, tag: string): string | undefined {
  const match = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return match ? decodeXmlText(match[1]) : undefined;
}

function xmlBlocks(xml: string, tag: string): string[] {
  return Array.from(xml.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g")), (m) => m[1]);
}

/**
 * Parses a ListObjectsV2 XML body. S3's listing XML is flat and predictable,
 * so this reads it with patterns rather than an XML DOM, which keeps it usable
 * in workers and Node tests.
 */
export function parseS3ListObjects(xml: string): S3ListPage {
  const prefixes = xmlBlocks(xml, "CommonPrefixes")
    .map((block) => xmlTag(block, "Prefix"))
    .filter((value): value is string => Boolean(value));
  const objects = xmlBlocks(xml, "Contents").flatMap((block) => {
    const key = xmlTag(block, "Key");
    if (key === undefined) return [];
    const lastModified = xmlTag(block, "LastModified");
    return [
      { key, size: Number(xmlTag(block, "Size") ?? 0), ...(lastModified ? { lastModified } : {}) },
    ];
  });
  const truncated = xmlTag(xml, "IsTruncated") === "true";
  const token = xmlTag(xml, "NextContinuationToken");
  return { prefixes, objects, ...(truncated && token ? { nextContinuationToken: token } : {}) };
}

/** The error code and message of an S3 XML error body, when it is one. */
export function parseS3Error(
  xml: string,
): { code: string; message: string; region?: string } | null {
  const block = xmlBlocks(xml, "Error")[0];
  if (block === undefined) return null;
  // A wrong-region signature names the region; an unsigned request to the
  // wrong endpoint (301 PermanentRedirect) names the right endpoint instead.
  const endpoint = xmlTag(block, "Endpoint");
  const region =
    xmlTag(block, "Region") ?? (endpoint ? parseS3Url(`https://${endpoint}/`)?.region : undefined);
  return {
    code: xmlTag(block, "Code") ?? "Error",
    message: xmlTag(block, "Message") ?? "",
    ...(region ? { region } : {}),
  };
}

/** Bucket names from a ListBuckets (`GET /` on the service) XML body. */
export function parseS3BucketList(xml: string): string[] {
  return xmlBlocks(xml, "Bucket")
    .map((block) => xmlTag(block, "Name"))
    .filter((name): name is string => Boolean(name));
}

// ---------------------------------------------------------------------------
// CORS diagnosis
// ---------------------------------------------------------------------------

/**
 * How browsers word a request they blocked or could not complete, plus the
 * readers that already guess at CORS themselves (maplibre-gl-lidar's message
 * tells the user to use a file picker, which is wrong for a bucket).
 */
const NETWORK_FAILURE =
  /failed to fetch|networkerror|load failed|network request failed|err_failed|cross-origin|\bcors\b/i;

function errorText(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current && depth < 4; depth += 1) {
    parts.push(current instanceof Error ? `${current.name}: ${current.message}` : String(current));
    current = current instanceof Error ? (current as Error & { cause?: unknown }).cause : null;
  }
  return parts.join(" | ");
}

/** A read the bucket's CORS configuration blocked. */
export class S3CorsError extends Error {
  readonly bucket: string;
  readonly origin: string;

  constructor(message: string, bucket: string, origin: string, cause: unknown) {
    super(message, { cause });
    this.name = "S3CorsError";
    this.bucket = bucket;
    this.origin = origin;
  }
}

/** Translates `key`, falling back to `defaultValue` (an app API's `translate`). */
export type S3ErrorTranslate = (
  key: string,
  defaultValue: string,
  params?: Record<string, string | number>,
) => string;

/**
 * Explains why reading an S3 object failed when the browser only said
 * "Failed to fetch". A browser reports a request the bucket's CORS rules
 * blocked exactly like a network outage, so this repeats the request twice:
 * normally, where success means the failure was transient; then in `no-cors`
 * mode, which CORS cannot block. Only when the first fails and the second gets
 * an answer is the bucket's CORS configuration the cause.
 *
 * @param url The `s3://` URI or object URL that was being read.
 * @param error What the reader threw.
 * @param translate Turns the message into the UI language.
 * @returns An {@link S3CorsError} naming the bucket and the origin to allow,
 *   or `error` unchanged when it is not a CORS refusal of an S3 read.
 */
export async function explainS3ReadError(
  url: string,
  error: unknown,
  translate?: S3ErrorTranslate,
): Promise<unknown> {
  const location = parseS3Url(url);
  if (!location || error instanceof S3CorsError) return error;
  if (!NETWORK_FAILURE.test(errorText(error))) return error;
  if (typeof fetch !== "function" || typeof window === "undefined") return error;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const href = await resolveReadableUrl(url);
    const probe = { signal: controller.signal, cache: "no-store" as const };
    // A normal (CORS) read first: if that works now, the failure was transient
    // and CORS is not the cause. The body is never needed, so each request is
    // cut off once its headers arrive.
    const corsAllowed = await fetch(href, probe).then(
      () => true,
      () => false,
    );
    if (corsAllowed) return error;
    // Blocked under CORS, yet S3 answers a no-cors request, which CORS cannot
    // block: the bucket's CORS configuration is what refuses this origin.
    await fetch(href, { ...probe, mode: "no-cors" });
  } catch {
    // Unreachable under no-cors too: a real network failure, not CORS.
    return error;
  } finally {
    controller.abort();
    clearTimeout(timer);
  }
  const origin = window.location.origin;
  const fallback =
    `The bucket "${location.bucket}" does not allow reads from ${origin}: its CORS configuration ` +
    "is missing or does not list this origin. Add a CORS rule that allows GET and HEAD from this " +
    "origin and exposes Content-Length, Content-Range, and ETag (see Settings > Cloud Storage).";
  const message = translate
    ? translate("s3Browser.corsError", fallback, { bucket: location.bucket, origin })
    : fallback;
  return new S3CorsError(message, location.bucket, origin, error);
}

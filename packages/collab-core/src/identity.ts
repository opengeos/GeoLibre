// Verification of the `identityToken` a client presents on join.
//
// The token is an HMAC-SHA256 credential minted by whoever operates the relay's
// identity issuer (a sign-in service, an embedding host's backend, ...):
//
//   <base64url(payloadJSON)>.<base64url(hmacSha256(base64url(payloadJSON)))>
//
// The signature is computed over the *encoded* payload segment rather than the
// decoded object, so verification never has to re-serialize JSON and cannot be
// defeated by key reordering or whitespace.
//
// Identity is opt-in per deployment: with no signing secret configured
// `verifyIdentityToken` returns null for every token, so a relay that has not
// been wired to an issuer treats all joiners as anonymous instead of trusting
// self-reported JSON. `isIdentityConfigured` lets the transports refuse to turn
// on "require a signed-in account" in that state rather than stranding a host
// behind a gate nobody can pass.

import type { ParticipantIdentity } from "./protocol";
import { sanitizeDisplayName } from "./session";

/** Claims carried by an identity token. */
export interface IdentityTokenPayload {
  /** Issuing provider, e.g. "geolibre". Defaults to "geolibre" when omitted. */
  provider?: string;
  userId: string;
  username: string;
  /** Optional expiry, epoch seconds. A token past it is rejected. */
  exp?: number;
}

// The package's tsconfig narrows `lib` to ES2022 on purpose (see index.ts) so
// this code cannot reach for a browser-only global by accident. Web Crypto and
// the base64 helpers below are present in both a Worker and Node 22, but not in
// that lib, so declare the exact surface used and nothing more.
interface HmacSubtleCrypto {
  importKey(
    format: "raw",
    keyData: Uint8Array,
    algorithm: { name: "HMAC"; hash: "SHA-256" },
    extractable: boolean,
    keyUsages: "sign"[],
  ): Promise<unknown>;
  sign(algorithm: "HMAC", key: unknown, data: Uint8Array): Promise<ArrayBuffer>;
}

interface CryptoGlobals {
  crypto?: { subtle?: HmacSubtleCrypto };
  atob?: (data: string) => string;
  btoa?: (data: string) => string;
  TextEncoder?: new () => { encode(input: string): Uint8Array };
}

function globals(): CryptoGlobals {
  return globalThis as unknown as CryptoGlobals;
}

function encodeUtf8(value: string): Uint8Array {
  const Encoder = globals().TextEncoder;
  if (!Encoder) throw new Error("TextEncoder is unavailable");
  return new Encoder().encode(value);
}

function base64UrlEncodeBytes(bytes: Uint8Array): string {
  const btoa = globals().btoa;
  if (!btoa) throw new Error("btoa is unavailable");
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecodeToString(segment: string): string | null {
  const atob = globals().atob;
  if (!atob) return null;
  // Reject anything outside the base64url alphabet up front: atob is lenient
  // about some invalid input, and a token that only *nearly* decodes must not
  // reach the signature comparison.
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) return null;
  const padded = segment.replace(/-/g, "+").replace(/_/g, "/");
  try {
    const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
    // atob yields one char per byte; decode those bytes as UTF-8 so a non-ASCII
    // username survives the round trip.
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return utf8Decode(bytes);
  } catch {
    return null;
  }
}

/** Minimal UTF-8 decode, since TextDecoder is likewise outside the ES2022 lib. */
function utf8Decode(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length;) {
    const b0 = bytes[i];
    if (b0 < 0x80) {
      out += String.fromCharCode(b0);
      i += 1;
    } else if (b0 >= 0xc0 && b0 < 0xe0) {
      out += String.fromCharCode(((b0 & 0x1f) << 6) | (bytes[i + 1] & 0x3f));
      i += 2;
    } else if (b0 >= 0xe0 && b0 < 0xf0) {
      out += String.fromCharCode(
        ((b0 & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f),
      );
      i += 3;
    } else {
      const cp =
        ((b0 & 0x07) << 18) |
        ((bytes[i + 1] & 0x3f) << 12) |
        ((bytes[i + 2] & 0x3f) << 6) |
        (bytes[i + 3] & 0x3f);
      out += String.fromCodePoint(cp);
      i += 4;
    }
  }
  return out;
}

async function hmacSha256(secret: string, message: string): Promise<Uint8Array> {
  const subtle = globals().crypto?.subtle;
  if (!subtle) throw new Error("Web Crypto is unavailable");
  const key = await subtle.importKey(
    "raw",
    encodeUtf8(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await subtle.sign("HMAC", key, encodeUtf8(message)));
}

/**
 * Length-independent, content-constant-time comparison of two base64url
 * signatures. Compared as strings rather than bytes so a malformed signature
 * segment (which never decodes) still takes the same path.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** True when this relay has been given a signing secret and can accept identity. */
export function isIdentityConfigured(secret: string | undefined | null): secret is string {
  return typeof secret === "string" && secret.length > 0;
}

/**
 * Mint an identity token. Exercised by the relay test suites and usable by an
 * issuer that runs in the same runtime; a separate issuer only has to reproduce
 * the two-segment format documented at the top of this file.
 */
export async function signIdentityToken(
  payload: IdentityTokenPayload,
  secret: string,
): Promise<string> {
  const encodedPayload = base64UrlEncodeBytes(encodeUtf8(JSON.stringify(payload)));
  const signature = base64UrlEncodeBytes(await hmacSha256(secret, encodedPayload));
  return `${encodedPayload}.${signature}`;
}

/**
 * Verify a client-presented identity token and project it onto the wire shape.
 *
 * Returns null for every failure mode — no secret configured, malformed token,
 * bad signature, expired, or missing/mistyped claims — so a caller can treat a
 * null as "this joiner is anonymous" without distinguishing them. The relays
 * deliberately do not report *why* a token failed, since that would let a
 * caller probe for a valid secret.
 *
 * @param token The raw `identityToken` field from the join message.
 * @param secret The relay's configured signing secret, if any.
 * @param nowMs Current time in epoch ms; injectable so tests can pin expiry.
 */
export async function verifyIdentityToken(
  token: unknown,
  secret: string | undefined | null,
  nowMs: number = Date.now(),
): Promise<ParticipantIdentity | null> {
  if (!isIdentityConfigured(secret)) return null;
  if (typeof token !== "string" || !token) return null;

  const dot = token.indexOf(".");
  if (dot <= 0 || dot !== token.lastIndexOf(".") || dot === token.length - 1) return null;
  const encodedPayload = token.slice(0, dot);
  const signature = token.slice(dot + 1);

  let expected: string;
  try {
    expected = base64UrlEncodeBytes(await hmacSha256(secret, encodedPayload));
  } catch {
    return null;
  }
  if (!timingSafeEqual(signature, expected)) return null;

  const json = base64UrlDecodeToString(encodedPayload);
  if (json === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;

  const claims = parsed as Record<string, unknown>;
  if (typeof claims.userId !== "string" || !claims.userId) return null;
  if (typeof claims.username !== "string" || !claims.username) return null;
  if (claims.exp !== undefined) {
    if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp)) return null;
    if (claims.exp * 1000 <= nowMs) return null;
  }

  return {
    provider: typeof claims.provider === "string" && claims.provider ? claims.provider : "geolibre",
    userId: claims.userId,
    username: sanitizeDisplayName(claims.username),
  };
}

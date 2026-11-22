import { fetchAllowlistedUpstream } from "../allowlisted-fetch";
import { CORS_HEADERS } from "./shared";

export const PMTILES_PATH = /^\/pmtiles\/([A-Za-z0-9._-]+\.pmtiles)$/;
const PMTILES_UPSTREAM = "https://build.protomaps.com";
const PMTILES_MAX_RANGE_BYTES = 32 * 1024 * 1024;

const LATEST_NAME = "latest.pmtiles";
const LATEST_TTL_MS = 60 * 60 * 1000;
const LATEST_MAX_LOOKBACK_DAYS = 7;
let latestCache: { date: string; at: number } | null = null;

function pmtilesRangeSpan(range: string): number | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (!match) return null;
  const [, startStr, endStr] = match;
  if (startStr === "") {
    if (endStr === "") return null;
    const suffix = Number(endStr);
    return Number.isSafeInteger(suffix) ? suffix : null;
  }
  if (endStr === "") return null;
  const start = Number(startStr);
  const end = Number(endStr);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return null;
  if (end < start) return null;
  return end - start + 1;
}

function utcYmd(msSinceEpoch: number): string {
  return new Date(msSinceEpoch).toISOString().slice(0, 10).replace(/-/g, "");
}

async function resolveLatestBuildDate(): Promise<string> {
  const now = Date.now();
  if (latestCache && now - latestCache.at < LATEST_TTL_MS) {
    return latestCache.date;
  }
  for (let i = 0; i <= LATEST_MAX_LOOKBACK_DAYS; i++) {
    const ymd = utcYmd(now - i * 86_400_000);
    // Deliberately NOT edge-cached: `cacheEverything` would cache this 1-byte
    // 206 under the URL-only cache key for `<ymd>.pmtiles` (the very URL
    // handlePmtilesRange fetches next), so a later real range read could be
    // served this 1-byte body instead of its bytes. The resolved date is
    // memoized in `latestCache` already.
    const probe = await (async () => {
      try {
        return await fetchAllowlistedUpstream(`${PMTILES_UPSTREAM}/${ymd}.pmtiles`, {
          headers: { range: "bytes=0-0" },
        });
      } catch (err) {
        console.warn(`Protomaps build probe failed for ${ymd}: ${String(err)}`);
        return null;
      }
    })();
    if (probe?.status === 206) {
      latestCache = { date: ymd, at: now };
      return ymd;
    }
  }
  throw new Error("no recent Protomaps build found");
}

/**
 * Range-proxy a bounded byte span from Protomaps daily planet builds.
 *
 * Deliberately not origin-gated: Jupyter and embed builds run on arbitrary
 * origins and legitimately extract offline basemaps through this route. Abuse
 * is instead bounded by the per-request 32 MiB range cap above.
 */
export async function handlePmtilesRange(request: Request, name: string): Promise<Response> {
  const range = request.headers.get("range");
  if (!range) {
    return new Response("This endpoint only serves HTTP range requests (send a Range header).", {
      status: 400,
      headers: CORS_HEADERS,
    });
  }
  const span = pmtilesRangeSpan(range);
  if (span === null || span > PMTILES_MAX_RANGE_BYTES) {
    return new Response(
      "This endpoint only serves bounded byte-range reads; the requested range is open-ended or too large.",
      { status: 416, headers: CORS_HEADERS },
    );
  }
  let target = name;
  if (name === LATEST_NAME) {
    try {
      target = `${await resolveLatestBuildDate()}.pmtiles`;
    } catch {
      return new Response("No recent Protomaps build available", {
        status: 502,
        headers: CORS_HEADERS,
      });
    }
  }
  let originResponse: Response;
  try {
    // Deliberately no `cf.cacheEverything`: Cloudflare's default cache key is
    // URL-only and ignores `Range`, so a cached 206 for one range could be
    // served for another range of the same file, corrupting the bytes a PMTiles
    // reader assembles.
    originResponse = await fetchAllowlistedUpstream(`${PMTILES_UPSTREAM}/${target}`, {
      headers: { range },
    });
  } catch {
    return new Response("Bad Gateway", { status: 502, headers: CORS_HEADERS });
  }
  if (originResponse.status === 200) {
    return new Response("Upstream did not honor the range request.", {
      status: 502,
      headers: CORS_HEADERS,
    });
  }
  const headers = new Headers(CORS_HEADERS);
  for (const key of [
    "content-type",
    "content-length",
    "content-range",
    "accept-ranges",
    "etag",
    "last-modified",
    "cache-control",
  ]) {
    const value = originResponse.headers.get(key);
    if (value) headers.set(key, value);
  }
  return new Response(originResponse.body, {
    status: originResponse.status,
    headers,
  });
}

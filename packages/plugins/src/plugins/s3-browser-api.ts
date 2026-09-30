/**
 * Listing for the S3 Browser (Plugins > Web Services): buckets, prefixes, and
 * objects, signed with the app's configured S3 connections when one covers the
 * bucket and read anonymously otherwise.
 *
 * DOM-free so it runs under `node --test`; the panel lives in
 * `maplibre-s3-browser.ts`. What GeoLibre can do with a listed file comes from
 * `remote-file-formats.ts`, shared with the Source Cooperative and Hugging Face
 * browsers.
 */

import {
  parseS3BucketList,
  parseS3Error,
  parseS3ListObjects,
  parseS3Url,
  s3ObjectHttpsUrl,
  type S3ListPage,
  type S3UrlSigner,
} from "@geolibre/core";
import { classifyPath, type RemoteFileFormat } from "./remote-file-formats";

/** Keys per ListObjectsV2 page. */
export const S3_LIST_PAGE_SIZE = 200;

/** A place in the S3 namespace: a bucket and a prefix ending in `/` (or empty). */
export interface S3BrowseLocation {
  bucket: string;
  prefix: string;
}

/** Fetches a URL as text, keeping the status of an error answer. */
export type S3TextFetch = (
  url: string,
  signal?: AbortSignal,
) => Promise<{ status: number; body: string }>;

/** One listed file, with what the browser can do with it. */
export interface S3BrowserObject {
  key: string;
  /** The last path segment. */
  name: string;
  size: number;
  lastModified?: string;
  format: RemoteFileFormat;
  /** `s3://bucket/key`, which layers keep as their source. */
  uri: string;
}

/**
 * Parses what the user typed into the location box: `s3://bucket/prefix`,
 * `bucket/prefix`, or an S3 HTTPS URL. A prefix that names a folder keeps its
 * trailing slash; a bare bucket lists its root.
 *
 * @returns The location, or null when the text names no bucket.
 */
export function parseS3BrowseLocation(input: string): S3BrowseLocation | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const location = parseS3Url(/^[a-z0-9+.-]+:\/\//i.test(trimmed) ? trimmed : `s3://${trimmed}`);
  if (!location || !/^[a-z0-9][a-z0-9.-]{1,254}$/i.test(location.bucket)) return null;
  return { bucket: location.bucket, prefix: location.key };
}

/** Formats a location back into the `s3://` form the location box shows. */
export function formatS3BrowseLocation(location: S3BrowseLocation): string {
  return `s3://${location.bucket}/${location.prefix}`;
}

/** The parent folder of a prefix (`a/b/` → `a/`, `a/` → ``). */
export function parentPrefix(prefix: string): string {
  const trimmed = prefix.replace(/\/$/, "");
  const slash = trimmed.lastIndexOf("/");
  return slash === -1 ? "" : trimmed.slice(0, slash + 1);
}

/** Lists S3 data through the app's signer, or anonymously without one. */
export interface S3BrowserClient {
  listBuckets(connectionId: string, signal?: AbortSignal): Promise<string[]>;
  list(
    location: S3BrowseLocation,
    continuationToken?: string,
    signal?: AbortSignal,
  ): Promise<S3ListPage>;
}

function errorFrom(status: number, body: string): Error {
  const parsed = parseS3Error(body);
  return new Error(
    parsed
      ? `${parsed.code}: ${parsed.message || `HTTP ${status}`}`
      : `S3 answered HTTP ${status}.`,
  );
}

/**
 * Builds the listing client.
 *
 * @param signer The app's S3 signer, or null in a host without one.
 * @param fallbackFetch Used when the signer offers no `fetchText` (tests, web).
 */
export function createS3BrowserClient(
  signer: S3UrlSigner | null,
  fallbackFetch: S3TextFetch,
): S3BrowserClient {
  const fetchText: S3TextFetch = signer?.fetchText ?? fallbackFetch;
  /** Regions learned from anonymous redirects, per bucket. */
  const anonymousRegions = new Map<string, string>();

  async function listUrl(
    location: S3BrowseLocation,
    query: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<string> {
    if (signer?.covers(location.bucket)) {
      const signed = await signer.presign({ bucket: location.bucket, key: "", query }, signal);
      if (signed) return signed.href;
    }
    const url = new URL(
      s3ObjectHttpsUrl(
        { bucket: location.bucket, key: "" },
        { region: anonymousRegions.get(location.bucket) },
      ),
    );
    for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
    return url.href;
  }

  return {
    async listBuckets(connectionId, signal) {
      if (!signer) throw new Error("No S3 connection is configured.");
      const signed = await signer.presign({ bucket: "", key: "", connectionId }, signal);
      if (!signed) throw new Error("No S3 connection is configured.");
      const response = await fetchText(signed.href, signal);
      if (response.status !== 200) throw errorFrom(response.status, response.body);
      return parseS3BucketList(response.body).sort((a, b) => a.localeCompare(b));
    },

    async list(location, continuationToken, signal) {
      const query: Record<string, string> = {
        "list-type": "2",
        delimiter: "/",
        "max-keys": String(S3_LIST_PAGE_SIZE),
        prefix: location.prefix,
        ...(continuationToken ? { "continuation-token": continuationToken } : {}),
      };
      let response = await fetchText(await listUrl(location, query, signal), signal);
      if (response.status !== 200 && !signer?.covers(location.bucket)) {
        // An anonymous request to the wrong regional endpoint is answered with
        // the right one; retry there once.
        const region = parseS3Error(response.body)?.region;
        if (region && region !== anonymousRegions.get(location.bucket)) {
          anonymousRegions.set(location.bucket, region);
          response = await fetchText(await listUrl(location, query, signal), signal);
        }
      }
      if (response.status !== 200) throw errorFrom(response.status, response.body);
      return parseS3ListObjects(response.body);
    },
  };
}

/** Pairs listed keys with their format, dropping the folder placeholder itself. */
export function describeObjects(location: S3BrowseLocation, page: S3ListPage): S3BrowserObject[] {
  return page.objects
    .filter((object) => object.key !== location.prefix && !object.key.endsWith("/"))
    .map((object) => {
      const name = object.key.slice(object.key.lastIndexOf("/") + 1);
      return {
        key: object.key,
        name,
        size: object.size,
        ...(object.lastModified ? { lastModified: object.lastModified } : {}),
        format: classifyPath(object.key),
        uri: `s3://${location.bucket}/${object.key}`,
      };
    });
}

/** The folder name a common prefix shows (`a/b/` → `b`). */
export function prefixLabel(prefix: string): string {
  return prefix.replace(/\/$/, "").split("/").pop() ?? prefix;
}

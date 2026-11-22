/**
 * Convert a GCS URI to its public HTTPS URL, preserving query and fragment.
 * Literal ? and # delimit URL suffixes; encode them as %3F/%23 in object keys.
 */
export function gcsUriToHttps(url: string): string {
  const trimmed = url.trim();
  if (!/^gs:\/\//i.test(trimmed)) return url;
  const rest = trimmed.slice(5);
  const path = rest.split(/[?#]/)[0];
  const bucket = path.split("/")[0];
  if (!bucket) throw new Error("GCS URL requires a bucket name.");
  // A loose subset of GCS bucket naming; uppercase is allowed for legacy buckets.
  if (!/^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/i.test(bucket)) {
    throw new Error("GCS URL requires a valid bucket name: " + bucket);
  }
  if (path.split("/").some((segment) => /^(?:\.|%2e){1,2}$/i.test(segment))) {
    throw new Error('GCS object key has a "." or ".." segment a URL cannot address: ' + path);
  }
  return `https://storage.googleapis.com/${path.replaceAll("\\", "%5C")}${rest.slice(path.length)}`;
}

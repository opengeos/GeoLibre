/**
 * Convert a GCS URI to its public HTTPS URL, preserving query and fragment.
 * Literal ? and # delimit URL suffixes; encode them as %3F/%23 in object keys.
 */
export function gcsUriToHttps(url: string): string {
  const trimmed = url.trim();
  if (!/^gs:\/\//i.test(trimmed)) return url;
  const rest = trimmed.slice(5);
  const path = rest.split(/[?#]/)[0];
  if (!path.split("/")[0]) throw new Error("GCS URL requires a bucket name.");
  if (path.split("/").some((segment) => /^(?:\.|%2e){1,2}$/i.test(segment))) {
    throw new Error('GCS object key has a "." or ".." segment a URL cannot address: ' + path);
  }
  return `https://storage.googleapis.com/${path.replaceAll("\\", "%5C")}${rest.slice(path.length)}`;
}

/** Convert a GCS URI to its public HTTPS URL, preserving query and fragment. */
export function gcsUriToHttps(url: string): string {
  const trimmed = url.trim();
  if (!/^gs:\/\//i.test(trimmed)) return url;
  const rest = trimmed.slice(5);
  const path = rest.split(/[?#]/)[0];
  if (path.split("/").some((segment) => /^(?:\.|%2e){1,2}$/i.test(segment))) {
    throw new Error('GCS object key has a "." or ".." segment a URL cannot address: ' + path);
  }
  return `https://storage.googleapis.com/${path.replaceAll("\\", "%5C")}${rest.slice(path.length)}`;
}

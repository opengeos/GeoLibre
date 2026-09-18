/**
 * A bare Android SAF document ID, as the browser `File.name` carries after a
 * native import: a known volume prefix (`primary:`, `home:`, `raw:`, `msf:`, or a
 * removable `XXXX-XXXX:` volume), or any provider prefix followed by a folder
 * separator. Ordinary encoded filenames such as `Report%3AQ1.geojson` do not match.
 */
const SAF_DOCUMENT_ID =
  /^(?:(?:primary|home|raw|msf|[0-9a-f]{4}-[0-9a-f]{4})%3a|[^%/\\:]+%3a.*%2f)/i;

/** Extract a display filename without changing the source used for file access. */
export function localFileName(path: string): string {
  const isUri = /^(?:content|file):\/\//i.test(path);
  const value = isUri ? path.split(/[?#]/)[0] : path;
  const segment = value.split(/[/\\]/).pop() ?? value;
  // Do not decode ordinary filenames: percent escapes can be literal text.
  if (!isUri && (!SAF_DOCUMENT_ID.test(segment) || /[/\\]/.test(path))) {
    return segment;
  }
  let decoded = segment;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    return segment;
  }
  // Strip the provider's volume prefix before taking the final path component.
  return (
    decoded
      .replace(/^[^/\\:]+:/, "")
      .split(/[/\\]/)
      .pop() ?? decoded
  );
}

/**
 * Whether a layer name was derived from its local source filename (with or
 * without the extension) rather than supplied explicitly by a caller.
 */
export function isSourceDerivedLayerName(name: string, sourcePath: string): boolean {
  const fileName = localFileName(sourcePath);
  return name === fileName || name === fileName.replace(/\.[^.]+$/, "");
}

/** Keep imported layers distinguishable, including within a multi-file import. */
export function uniqueImportedLayerName(name: string, names: Iterable<string>): string {
  const existing = new Set(names);
  let candidate = name;
  let suffix = 2;
  while (existing.has(candidate)) candidate = `${name}_${suffix++}`;
  return candidate;
}

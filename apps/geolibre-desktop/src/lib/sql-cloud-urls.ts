/**
 * SQL text helpers that need no DuckDB: the literal-aware mask, and the
 * translation of cloud object-store URLs (`s3://`, `gs://`, `az://`) into the
 * HTTPS URLs DuckDB-WASM's HTTP reader fetches. Split from `sql-workspace.ts`
 * so the node test runner can load them.
 */
import { isCredentialedS3Url, resolveReadableUrl } from "@geolibre/core";

/**
 * Return a copy of `sql` in which every character inside a string literal,
 * quoted identifier, line/block comment, or dollar-quoted string (`$$…$$`,
 * `$tag$…$tag$`) is replaced with a space, while newlines and all "code"
 * characters keep their original position.
 *
 * Running regexes against this mask makes them literal-aware without a full
 * parser: a match's indices are valid against the original string, but the
 * regex can never match text that lives inside a literal or comment.
 *
 * The scanner always parses literals and comments (so a `--` inside a string is
 * not mistaken for a comment), but `blankLiterals` controls whether literal
 * content is blanked. Callers that need to find the end of the real statement
 * (e.g. `cleanStatement`) pass `false` so a trailing string literal is not
 * mistaken for trailing whitespace. `blankIdentifiers` does the same for
 * `"…"` identifiers and follows `blankLiterals` unless given: the cloud-URL
 * rewrite keeps `'…'` literals (reader arguments) but blanks identifiers.
 */
export function maskSqlLiterals(
  sql: string,
  blankLiterals = true,
  blankIdentifiers = blankLiterals,
): string {
  const out = sql.split("");
  const blank = (start: number, end: number): void => {
    for (let k = start; k < end && k < out.length; k += 1) {
      if (out[k] !== "\n") out[k] = " ";
    }
  };
  let i = 0;
  while (i < sql.length) {
    const char = sql[i];
    if (char === "'" || char === '"') {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === char) {
          // A doubled quote is an escaped quote, not the end of the literal.
          if (sql[j + 1] === char) {
            j += 2;
            continue;
          }
          break;
        }
        j += 1;
      }
      if (char === '"' ? blankIdentifiers : blankLiterals) blank(i, j + 1);
      i = j + 1;
    } else if (char === "-" && sql[i + 1] === "-") {
      let j = i;
      while (j < sql.length && sql[j] !== "\n") j += 1;
      blank(i, j);
      i = j;
    } else if (char === "/" && sql[i + 1] === "*") {
      let j = i + 2;
      while (j < sql.length && !(sql[j] === "*" && sql[j + 1] === "/")) j += 1;
      blank(i, j + 2);
      i = j + 2;
    } else if (char === "$") {
      // Dollar-quote tag: $tag$ where tag is empty or [A-Za-z0-9_]+.
      const tagMatch = /^\$[A-Za-z0-9_]*\$/.exec(sql.slice(i));
      if (tagMatch) {
        const tag = tagMatch[0];
        const closeAt = sql.indexOf(tag, i + tag.length);
        const end = closeAt === -1 ? sql.length : closeAt + tag.length;
        if (blankLiterals) blank(i, end);
        i = end;
      } else {
        i += 1;
      }
    } else {
      i += 1;
    }
  }
  return out.join("");
}

// ---------------------------------------------------------------------------
// Cloud object-store URL translation
// ---------------------------------------------------------------------------
// s3://, gs://, and az:// URLs are transparently rewritten to their public
// HTTPS gateway equivalents so they flow through the existing HTTP range reader
// pipeline without requiring the (unreliable in WASM) httpfs extension or
// CREATE SECRET. Only anonymous / public access is supported.
const CLOUD_URL_PATTERN = /\b(s3|gs|az):\/\/([^\s'"`,;)]+)/gi;

/** Map a single cloud URL to its public HTTPS equivalent. */
function cloudUrlToHttps(scheme: string, path: string): string {
  const lower = scheme.toLowerCase();
  const slashIndex = path.indexOf("/");
  if (lower === "s3") {
    // s3://bucket/key → https://bucket.s3.amazonaws.com/key
    const bucket = slashIndex >= 0 ? path.slice(0, slashIndex) : path;
    const key = slashIndex >= 0 ? path.slice(slashIndex) : "";
    return `https://${bucket}.s3.amazonaws.com${key}`;
  }
  if (lower === "gs") {
    // gs://bucket/key → https://storage.googleapis.com/bucket/key
    return `https://storage.googleapis.com/${path}`;
  }
  // az://account/container/key → https://account.blob.core.windows.net/container/key
  const account = slashIndex >= 0 ? path.slice(0, slashIndex) : path;
  const rest = slashIndex >= 0 ? path.slice(slashIndex) : "";
  return `https://${account}.blob.core.windows.net${rest}`;
}

/**
 * Replace every `s3://`, `gs://`, and `az://` URL in the SQL text with its
 * public HTTPS equivalent. Operates via {@link maskSqlLiterals} so URLs inside
 * comments and quoted identifiers are left untouched, but URLs inside string
 * literals (reader-function arguments) ARE translated since the user intends
 * those to be data sources.
 */
export function rewriteCloudUrls(sql: string): string {
  return replaceCloudUrls(sql, (match) => cloudUrlToHttps(match[1], match[2]));
}

/**
 * Replaces each cloud URL in code or string literals (not comments or quoted
 * identifiers) with `replacement(match)`.
 */
function replaceCloudUrls(sql: string, replacement: (match: RegExpMatchArray) => string): string {
  // Mask only comments and quoted identifiers (keep string literals intact) —
  // cloud URLs inside reader args like read_parquet('s3://…') must be rewritten.
  const masked = maskSqlLiterals(sql, false, true);
  let result = "";
  let lastIndex = 0;
  // Run the pattern against the original SQL (not the mask) to capture the real
  // URL text; check the mask only to skip URLs inside comments/identifiers.
  for (const match of sql.matchAll(CLOUD_URL_PATTERN)) {
    const index = match.index ?? 0;
    // If the position is blanked in the mask, it is inside a comment or quoted
    // identifier — skip it.
    if (masked[index] === " ") continue;
    result += sql.slice(lastIndex, index);
    result += replacement(match);
    lastIndex = index + match[0].length;
  }
  result += sql.slice(lastIndex);
  return result;
}

/**
 * {@link rewriteCloudUrls}, except that an `s3://` object in a bucket a
 * configured S3 connection covers becomes a presigned URL, so private data
 * reads through the same HTTP range reader as public data.
 *
 * @throws When a covered bucket's credentials cannot be resolved.
 */
export async function resolveCloudUrls(sql: string): Promise<string> {
  const signed = new Map<string, string>();
  replaceCloudUrls(sql, (match) => {
    if (isCredentialedS3Url(match[0])) signed.set(match[0], "");
    return match[0];
  });
  await Promise.all(
    [...signed.keys()].map(async (url) => signed.set(url, await resolveReadableUrl(url))),
  );
  return replaceCloudUrls(
    sql,
    (match) => signed.get(match[0]) || cloudUrlToHttps(match[1], match[2]),
  );
}

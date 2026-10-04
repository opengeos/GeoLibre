/**
 * Builds the pre-filled GitHub "new issue" link behind the "Report issue"
 * action on error notifications and in the Diagnostics dialog (issue #2858).
 *
 * Pure (no DOM, no store) so it can be tested directly. The link fills the
 * repository's bug-report issue form (`.github/ISSUE_TEMPLATE/bug_report.yml`)
 * by field id; GitHub leaves the fields it cannot match empty.
 *
 * Everything that leaves the app here is scrubbed first: URL query strings,
 * fragments and userinfo are dropped, credential-named `key=value` pairs and
 * well-known token shapes are masked, and home-directory user names are
 * replaced with `~`. The link opens in the user's browser, where they review it
 * before submitting, but a token must never reach even the draft.
 */
import { isCredentialFieldName, isCredentialUrlParam } from "@geolibre/core";
import type { DiagnosticRecord } from "./diagnostics";

export const ISSUE_REPOSITORY_URL = "https://github.com/opengeos/GeoLibre";
export const ISSUE_TEMPLATE = "bug_report.yml";

/**
 * GitHub (and some proxies) reject request lines past ~8 KB with a 414, so the
 * link stays well under that. The diagnostics entry is what gets trimmed.
 */
export const MAX_ISSUE_URL_LENGTH = 7000;
const MAX_TITLE_LENGTH = 120;
const REDACTED = "[REDACTED]";
const TRUNCATED = "…[truncated]";

export interface IssueReportContext {
  /** The running app version, e.g. `3.2.0`. */
  appVersion: string;
  /** How the app runs: `Desktop app`, `Web`, … */
  runtime: string;
  /** OS and browser, typically the user agent. */
  platform: string;
  /** The active map renderer (`maplibre`, `cesium`, …). */
  renderer: string;
}

export type IssueReportEntry = Pick<
  DiagnosticRecord,
  "category" | "level" | "message" | "timestamp"
> &
  Partial<Pick<DiagnosticRecord, "detail" | "method" | "source" | "status" | "url">>;

// URL-ish runs in free text: web and object-store schemes plus the desktop
// OAuth callback. Stops at whitespace and closing delimiters so surrounding
// punctuation survives.
const EMBEDDED_URL =
  /\b(?:https?|wss?|ftp|s3|gs|az|abfss?):\/\/[^\s)"'<>\]]+|\borg\.geolibre\.desktop:\/[^\s)"'<>\]]+/gi;

// `name=value`, `name: value`, `"name": "value"` with an optional quote around
// either side. The name is checked against the app's credential registries.
const KEY_VALUE_PAIR = /(["']?)([A-Za-z][\w-]{0,63})\1(\s*[:=]\s*)(["']?)([^\s"'&,;}\]]+)\4/g;

// Token shapes that are secrets wherever they appear.
const TOKEN_PATTERNS: RegExp[] = [
  /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b[ps]k\.eyJ[\w-]+(?:\.[\w-]+)*/g, // Mapbox
  /\beyJ[\w-]{5,}\.[\w-]{5,}(?:\.[\w-]*)?/g, // JWT
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, // GitHub
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g, // OpenAI-style
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bAIza[0-9A-Za-z_-]{35}\b/g, // Google API key
];

const HOME_DIRECTORY = /(\/home\/|\/Users\/|[A-Za-z]:\\Users\\)[^/\\\s"'<>]+/g;

function scrubUrl(raw: string): string {
  // Already scrubbed (the match stops before the marker's closing bracket).
  const marker = REDACTED.slice(0, -1);
  if (raw.endsWith(`?${marker}`) || raw.endsWith(`#${marker}`)) return raw;
  let url = raw;
  const fragment = url.indexOf("#");
  const query = url.indexOf("?");
  const cut = [fragment, query].filter((index) => index !== -1);
  // Keep the URL's shape: a fragment-only URL is marked with `#`, not `?`.
  const separator = query !== -1 && (fragment === -1 || query < fragment) ? "?" : "#";
  const hadSuffix = cut.length > 0;
  if (hadSuffix) url = url.slice(0, Math.min(...cut));
  // userinfo (`user:password@host`)
  url = url.replace(/^([a-z][\w+.-]*:\/\/)[^/@]*@/i, "$1");
  return hadSuffix ? `${url}${separator}${REDACTED}` : url;
}

/**
 * Removes credentials and personal paths from free text bound for a public
 * issue: URL query strings/fragments/userinfo, credential-named key/value
 * pairs, known token shapes, and home-directory user names.
 *
 * @param text - Any text that may embed URLs, headers, or JSON.
 * @returns The scrubbed text.
 */
export function scrubForIssueReport(text: string): string {
  let result = text.replace(EMBEDDED_URL, scrubUrl);
  for (const pattern of TOKEN_PATTERNS) {
    result = result.replace(pattern, (match, scheme?: string) =>
      typeof scheme === "string" && /^(Bearer|Basic|Token)$/i.test(scheme)
        ? `${scheme} ${REDACTED}`
        : REDACTED,
    );
  }
  result = result.replace(
    KEY_VALUE_PAIR,
    (match, quote: string, name: string, separator: string, valueQuote: string, value: string) =>
      !value.startsWith("[REDACTED") && (isCredentialUrlParam(name) || isCredentialFieldName(name))
        ? `${quote}${name}${quote}${separator}${valueQuote}${REDACTED}${valueQuote}`
        : match,
  );
  return result.replace(HOME_DIRECTORY, "~");
}

function truncateText(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit))}${TRUNCATED}`;
}

function scrubEntry(entry: IssueReportEntry): IssueReportEntry {
  const scrubbed: IssueReportEntry = {
    timestamp: entry.timestamp,
    level: entry.level,
    category: entry.category,
    message: scrubForIssueReport(entry.message),
  };
  if (entry.method) scrubbed.method = entry.method;
  if (entry.status !== undefined) scrubbed.status = entry.status;
  if (entry.url) scrubbed.url = scrubForIssueReport(entry.url);
  if (entry.source) scrubbed.source = scrubForIssueReport(entry.source);
  if (entry.detail) scrubbed.detail = scrubForIssueReport(entry.detail);
  return scrubbed;
}

function buildUrl(fields: Record<string, string>): string {
  const params = new URLSearchParams({ template: ISSUE_TEMPLATE, ...fields });
  return `${ISSUE_REPOSITORY_URL}/issues/new?${params.toString()}`;
}

/**
 * Builds a GitHub new-issue URL pre-filled with the app version, platform,
 * renderer, and (when given) one scrubbed diagnostics entry. The entry's
 * `detail`, then its `message`, is shortened until the URL fits `maxLength`.
 *
 * @param entry - The diagnostics record being reported, or `null` for a
 *   general report.
 * @param context - Version, runtime, platform, and renderer.
 * @param maxLength - Upper bound for the returned URL's length.
 * @returns The `https://github.com/opengeos/GeoLibre/issues/new?...` link.
 */
export function buildIssueReportUrl(
  entry: IssueReportEntry | null,
  context: IssueReportContext,
  maxLength: number = MAX_ISSUE_URL_LENGTH,
): string {
  const scrubbed = entry ? scrubEntry(entry) : null;
  const titleText = scrubbed ? scrubbed.message.split("\n", 1)[0].trim() : "";
  const fixed: Record<string, string> = {
    title: `[Bug]: ${truncateText(titleText, MAX_TITLE_LENGTH)}`,
    app: `${context.runtime} v${context.appVersion}`,
    os: truncateText(scrubForIssueReport(context.platform), 300),
  };

  const compose = (detailLimit: number, messageLimit: number): string => {
    const lines = [`Renderer: ${context.renderer}`];
    let whatHappened = "";
    if (scrubbed) {
      const reported: IssueReportEntry = {
        ...scrubbed,
        message: truncateText(scrubbed.message, messageLimit),
      };
      if (scrubbed.detail !== undefined) {
        reported.detail = truncateText(scrubbed.detail, detailLimit);
      }
      whatHappened = `GeoLibre reported: ${truncateText(titleText, messageLimit)}`;
      lines.push("", "Diagnostics entry:", "```json", JSON.stringify(reported, null, 2), "```");
    }
    return buildUrl({
      ...fixed,
      ...(whatHappened ? { "what-happened": whatHappened } : {}),
      screenshots: lines.join("\n"),
    });
  };

  let detailLimit = scrubbed?.detail?.length ?? 0;
  let messageLimit = scrubbed?.message.length ?? 0;
  let url = compose(detailLimit, messageLimit);
  // Encoding expands characters unevenly (one CJK character is nine bytes), so
  // shrink by at least the overshoot and re-measure until the link fits.
  while (url.length > maxLength && (detailLimit > 0 || messageLimit > 0)) {
    const overshoot = url.length - maxLength;
    if (detailLimit > 0) detailLimit = Math.max(0, detailLimit - Math.max(overshoot, 32));
    else messageLimit = Math.max(0, messageLimit - Math.max(overshoot, 32));
    url = compose(detailLimit, messageLimit);
  }
  return url;
}

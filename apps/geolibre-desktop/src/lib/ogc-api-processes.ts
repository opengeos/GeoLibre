import { processHttp, processHttpUrl, type ProcessHttpResponse } from "./ogc-process-http";
import { MAX_PROCESS_INPUT_BYTES, MAX_PROCESS_RESULT_BYTES } from "./ogc-process-limits";

type JsonObject = Record<string, unknown>;
interface ProcessLink {
  href: string;
  rel: string;
  type?: string;
}
const REL = "http://www.opengis.net/def/rel/ogc/1.0/";
export interface OgcProcess {
  id: string;
  title: string;
  description: string;
  url: string;
  links: ProcessLink[];
  inputs: Record<string, JsonObject>;
  outputs: Record<string, JsonObject>;
  jobControlOptions: string[];
}
export type OgcProcessJobStatus = "accepted" | "running" | "successful" | "failed" | "dismissed";
export interface OgcProcessJob {
  id: string;
  url: string;
  status: OgcProcessJobStatus;
  message: string;
  progress?: number;
  resultsUrl: string;
  retryAfterMs: number;
}
export interface OgcProcessOutput {
  id: string;
  value?: unknown;
  href?: string;
  mediaType?: string;
  encoding?: string;
  bytes?: Uint8Array<ArrayBuffer>;
}
export type OgcProcessExecution =
  | { kind: "job"; job: OgcProcessJob }
  | { kind: "results"; outputs: OgcProcessOutput[]; jobUrl?: string };

const object = (value: unknown): JsonObject => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("The service returned an invalid OGC process document.");
  return value as JsonObject;
};
function links(value: unknown): ProcessLink[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const item = raw as JsonObject;
    return typeof item.href === "string" && typeof item.rel === "string"
      ? [
          {
            href: item.href,
            rel: item.rel,
            ...(typeof item.type === "string" ? { type: item.type } : {}),
          },
        ]
      : [];
  });
}

/** Resolve hypermedia without copying endpoint query credentials to another origin. */
export function ogcProcessLink(href: string, base: string): string {
  const url = processHttpUrl(href, base),
    parent = processHttpUrl(base);
  if (url.origin === parent.origin)
    for (const [key, value] of parent.searchParams)
      if (
        !["f", "limit", "offset", "page", "startindex"].includes(key.toLowerCase()) &&
        !url.searchParams.has(key)
      )
        url.searchParams.append(key, value);
  return url.href;
}
function linked(items: ProcessLink[], rel: string, base: string): string | undefined {
  for (const item of items
    .filter((l) => l.rel === rel)
    .sort((a, b) => Number(/json/.test(b.type ?? "")) - Number(/json/.test(a.type ?? "")))) {
    try {
      return ogcProcessLink(item.href, base);
    } catch {
      /* Ignore unusable advertised links. */
    }
  }
  return undefined;
}
function append(url: string, suffix: string): string {
  const next = processHttpUrl(url);
  next.pathname = next.pathname.replace(/\/$/, "") + suffix;
  return next.href;
}
function jsonUrl(url: string): string {
  const next = processHttpUrl(url);
  next.searchParams.set("f", "json");
  return next.href;
}
function decode(response: ProcessHttpResponse): unknown {
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(response.body));
}
function successful(response: ProcessHttpResponse): void {
  if (response.status >= 200 && response.status < 300) return;
  let detail = "";
  try {
    const document = object(decode(response));
    const value = [
      document.detail,
      document.description,
      document.message,
      document.title,
      document.code,
    ].find((v) => typeof v === "string" && v.trim());
    if (typeof value === "string") detail = `: ${value.slice(0, 400)}`;
  } catch {
    /* Preserve HTTP status when an error body is missing or not JSON. */
  }
  throw new Error(`OGC process HTTP ${response.status}${detail}`);
}
function processDocument(raw: unknown, base: string): OgcProcess {
  const value = object(raw);
  if (typeof value.id !== "string" || !value.id) throw new Error("The process has no identifier.");
  const items = links(value.links);
  const url = linked(items, "self", base) ?? base;
  const definitions = (fields: unknown): Record<string, JsonObject> => {
    if (fields === undefined) return {};
    return Object.fromEntries(
      Object.entries(object(fields)).map(([key, value]) => [key, object(value)]),
    );
  };
  return {
    id: value.id,
    title: typeof value.title === "string" ? value.title : value.id,
    description: typeof value.description === "string" ? value.description : "",
    url,
    links: items,
    inputs: definitions(value.inputs),
    outputs: definitions(value.outputs),
    jobControlOptions: Array.isArray(value.jobControlOptions)
      ? value.jobControlOptions.filter((v): v is string => typeof v === "string")
      : [],
  };
}

/** Discover from a landing page, process list, or individual process URL. */
export async function discoverOgcProcesses(
  input: string,
  signal: AbortSignal,
): Promise<OgcProcess[]> {
  const abort = AbortSignal.any([signal, AbortSignal.timeout(60_000)]);
  let url = jsonUrl(input.trim());
  const seen = new Set<string>(),
    result = new Map<string, OgcProcess>();
  for (let page = 0; page < 50; page++) {
    if (seen.has(url)) throw new Error("The OGC process catalog contains a pagination cycle.");
    seen.add(url);
    const response = await processHttp(url, abort);
    successful(response);
    const doc = object(decode(response)),
      base = response.url;
    const items = links(doc.links);
    const individual =
      typeof doc.id === "string" &&
      (doc.inputs !== undefined ||
        doc.outputs !== undefined ||
        linked(items, REL + "execute", base));
    if (!Array.isArray(doc.processes) && !individual) {
      const catalog = linked(items, REL + "processes", base);
      if (!catalog) throw new Error("This service does not advertise OGC API Processes.");
      url = jsonUrl(catalog);
      continue;
    }
    for (const raw of Array.isArray(doc.processes) ? doc.processes : [doc]) {
      const value = object(raw);
      if (typeof value.id !== "string" || !value.id) continue;
      const fallback = Array.isArray(doc.processes)
        ? append(base, `/${encodeURIComponent(value.id)}`)
        : base;
      const process = processDocument(value, fallback);
      result.set(process.id, process);
      if (result.size > 5000) throw new Error("The OGC process catalog exceeds 5,000 processes.");
    }
    const next = linked(items, "next", base);
    if (!next) {
      if (!result.size) throw new Error("No OGC processes were found.");
      return [...result.values()];
    }
    url = next;
  }
  throw new Error("The OGC process catalog exceeds 50 pages.");
}

/** Fetch input/output schemas without resolving remote JSON Schema references. */
export async function describeOgcProcess(
  process: OgcProcess,
  signal: AbortSignal,
): Promise<OgcProcess> {
  const response = await processHttp(jsonUrl(process.url), signal);
  successful(response);
  return processDocument(decode(response), response.url);
}

/** Honor Retry-After seconds or dates while keeping interactive polling bounded. */
export function ogcProcessRetryDelay(value: string | null, now = Date.now()): number {
  const seconds = value === null || !value.trim() ? NaN : Number(value);
  const milliseconds = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value ?? "") - now;
  return Number.isFinite(milliseconds) ? Math.max(500, Math.min(30_000, milliseconds)) : 1000;
}
function job(response: ProcessHttpResponse, fallback: string): OgcProcessJob {
  const doc = object(decode(response));
  const status = doc.status;
  if (!["accepted", "running", "successful", "failed", "dismissed"].includes(String(status)))
    throw new Error("The service returned an unknown OGC job status.");
  const items = links(doc.links);
  const url = response.location
    ? ogcProcessLink(response.location, response.url)
    : (linked(items, "status", response.url) ?? linked(items, "self", response.url) ?? fallback);
  return {
    id:
      typeof doc.jobID === "string"
        ? doc.jobID
        : decodeURIComponent(processHttpUrl(url).pathname.split("/").pop() ?? ""),
    url,
    status: status as OgcProcessJobStatus,
    message: typeof doc.message === "string" ? doc.message : "",
    ...(typeof doc.progress === "number" && Number.isFinite(doc.progress)
      ? { progress: Math.max(0, Math.min(100, doc.progress)) }
      : {}),
    resultsUrl:
      linked(items, REL + "results", url) ??
      linked(items, "results", url) ??
      append(url, "/results"),
    retryAfterMs: ogcProcessRetryDelay(response.retryAfter),
  };
}
function outputs(response: ProcessHttpResponse): OgcProcessOutput[] {
  if (!response.body.length) return [];
  if (!/json/i.test(response.contentType ?? ""))
    return [
      {
        id: "result",
        bytes: response.body,
        mediaType: response.contentType ?? "application/octet-stream",
      },
    ];
  const document = decode(response);
  if (!document || typeof document !== "object" || Array.isArray(document))
    return [{ id: "result", value: document, mediaType: "application/json" }];
  const doc = document as JsonObject;
  if (
    typeof doc.type === "string" &&
    (doc.type === "FeatureCollection" || doc.type === "Feature" || Array.isArray(doc.coordinates))
  )
    return [{ id: "result", value: doc, mediaType: "application/geo+json" }];
  const entries = Array.isArray(doc.outputs)
    ? doc.outputs.map((raw) => {
        const value = object(raw);
        return [String(value.id ?? "result"), value] as const;
      })
    : Object.entries(Object.hasOwn(doc, "outputs") ? object(doc.outputs) : doc);
  return entries.map(([id, raw]) => {
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const value = raw as JsonObject;
      if (typeof value.href === "string")
        return {
          id,
          href: ogcProcessLink(value.href, response.url),
          ...(typeof value.type === "string" ? { mediaType: value.type } : {}),
          ...(typeof value.mediaType === "string" ? { mediaType: value.mediaType } : {}),
        };
      if (Object.hasOwn(value, "value"))
        return {
          id,
          value: value.value,
          ...(typeof value.mediaType === "string" ? { mediaType: value.mediaType } : {}),
          ...(typeof value.encoding === "string" ? { encoding: value.encoding } : {}),
        };
    }
    return { id, value: raw };
  });
}

/** Submit exactly once, accepting synchronous outputs and 201/202 job responses. */
export async function executeOgcProcess(
  process: OgcProcess,
  inputs: JsonObject,
  signal: AbortSignal,
  asynchronous = false,
): Promise<OgcProcessExecution> {
  object(inputs);
  const body = JSON.stringify({ inputs, response: "document" });
  if (new TextEncoder().encode(body).length > MAX_PROCESS_INPUT_BYTES)
    throw new Error("OGC process inputs exceed 1 MiB.");
  const endpoint =
    linked(process.links, REL + "execute", process.url) ?? append(process.url, "/execution");
  const response = await processHttp(endpoint, signal, {
    method: "POST",
    body,
    preferAsync: asynchronous,
    maxBytes: MAX_PROCESS_RESULT_BYTES,
  });
  successful(response);
  if (response.status === 201 || response.status === 202) {
    let fallback = response.location ? ogcProcessLink(response.location, response.url) : undefined;
    if (!fallback) {
      const document = object(decode(response));
      const jobs = linked(process.links, REL + "job-list", process.url);
      if (jobs && typeof document.jobID === "string")
        fallback = append(jobs, `/${encodeURIComponent(document.jobID)}`);
      else
        fallback =
          linked(links(document.links), "status", response.url) ??
          linked(links(document.links), "self", response.url);
    }
    if (!fallback) throw new Error("The service accepted the job but did not return a status URL.");
    if (!response.body.length)
      return { kind: "job", job: await readOgcProcessJob(fallback, signal) };
    return { kind: "job", job: job(response, fallback) };
  }
  return {
    kind: "results",
    outputs: outputs(response),
    ...(response.location ? { jobUrl: ogcProcessLink(response.location, response.url) } : {}),
  };
}

/** Read a submitted or explicitly resumed job without modifying it. */
export async function readOgcProcessJob(url: string, signal: AbortSignal): Promise<OgcProcessJob> {
  const response = await processHttp(jsonUrl(url), signal);
  successful(response);
  return job(response, response.url);
}

/** Retrieve the numerical/structured result document after a job succeeds. */
export async function readOgcProcessResults(
  job: OgcProcessJob,
  signal: AbortSignal,
): Promise<OgcProcessOutput[]> {
  const response = await processHttp(job.resultsUrl, signal, {
    maxBytes: MAX_PROCESS_RESULT_BYTES,
  });
  successful(response);
  return outputs(response);
}

/** Dismiss only the particular job the caller selected. */
export async function dismissOgcProcessJob(url: string, signal: AbortSignal): Promise<void> {
  const response = await processHttp(url, signal, { method: "DELETE" });
  successful(response);
}

/** Download an explicitly selected result reference through the same guarded transport. */
export async function downloadOgcProcessOutput(
  output: OgcProcessOutput,
  signal: AbortSignal,
): Promise<Blob> {
  if (output.href) {
    const response = await processHttp(output.href, signal, {
      maxBytes: MAX_PROCESS_RESULT_BYTES,
      accept: output.mediaType ?? "*/*",
    });
    successful(response);
    return new Blob([response.body], { type: response.contentType ?? output.mediaType });
  }
  if (output.bytes) return new Blob([output.bytes], { type: output.mediaType });
  if (output.encoding === "base64" && typeof output.value === "string") {
    const value = atob(output.value);
    if (value.length > MAX_PROCESS_RESULT_BYTES)
      throw new Error("OGC process result exceeds its download limit.");
    return new Blob([Uint8Array.from(value, (c) => c.charCodeAt(0))], { type: output.mediaType });
  }
  return new Blob(
    [typeof output.value === "string" ? output.value : (JSON.stringify(output.value) ?? "null")],
    {
      type:
        output.mediaType ?? (typeof output.value === "string" ? "text/plain" : "application/json"),
    },
  );
}

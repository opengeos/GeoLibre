import { OgcProcessError } from "./ogc-process-errors";
import { processHttp, processHttpUrl, type ProcessHttpResponse } from "./ogc-process-http";
import { ogcProcessMonitorLinks } from "./ogc-process-link-header";
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
  resultsUrlAdvertised?: boolean;
  retryAfterMs: number;
  /** Advertised identifiers disambiguate legacy pygeoapi result envelopes. */
  outputIds?: string[];
  outputDefinitions?: OgcProcess["outputs"];
  processId?: string;
  processUrl?: string;
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
  | { kind: "results"; outputs: OgcProcessOutput[]; job?: OgcProcessJob };

const object = (value: unknown): JsonObject => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new OgcProcessError("invalidDocument");
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

/** Optional routing headers must not discard successful outputs or body links. */
function optionalLink(href: string | null, base: string): string | undefined {
  if (!href) return undefined;
  try {
    return ogcProcessLink(href, base);
  } catch {
    return undefined;
  }
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

/** Compare status request identities while preserving service-specific query values. */
export function sameOgcProcessJob(first: string, second: string): boolean {
  try {
    const key = (value: string) => {
      const url = processHttpUrl(jsonUrl(value));
      url.searchParams.sort();
      return url.href;
    };
    return key(first) === key(second);
  } catch {
    return false;
  }
}

function pathIdentifier(url: string): string {
  const value = processHttpUrl(url).pathname.split("/").pop() ?? "";
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
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
  throw new OgcProcessError("http", { status: response.status, detail });
}
function processDocument(raw: unknown, base: string, fallback = base): OgcProcess {
  const value = object(raw);
  if (typeof value.id !== "string" || !value.id) throw new OgcProcessError("noIdentifier");
  const items = links(value.links).flatMap((link) => {
    try {
      return [{ ...link, href: ogcProcessLink(link.href, base) }];
    } catch {
      return [];
    }
  });
  const url = linked(items, "self", base) ?? fallback;
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
    if (seen.has(url)) throw new OgcProcessError("catalogCycle");
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
      if (!catalog) throw new OgcProcessError("noService");
      url = jsonUrl(catalog);
      continue;
    }
    for (const raw of Array.isArray(doc.processes) ? doc.processes : [doc]) {
      const value = object(raw);
      if (typeof value.id !== "string" || !value.id) continue;
      const fallback = Array.isArray(doc.processes)
        ? append(base, `/${encodeURIComponent(value.id)}`)
        : base;
      const synthetic = new URL(fallback);
      for (const key of [...synthetic.searchParams.keys()])
        if (["limit", "offset", "page", "startindex"].includes(key.toLowerCase()))
          synthetic.searchParams.delete(key);
      const process = processDocument(value, base, synthetic.href);
      result.set(process.id, process);
      if (result.size > 5000) throw new OgcProcessError("catalogLimit");
    }
    const next = linked(items, "next", base);
    if (!next) {
      if (!result.size) throw new OgcProcessError("noProcesses");
      return [...result.values()];
    }
    url = jsonUrl(next);
  }
  throw new OgcProcessError("pageLimit");
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
  if (
    typeof status !== "string" ||
    !["accepted", "running", "successful", "failed", "dismissed"].includes(status)
  )
    throw new OgcProcessError("unknownJobStatus");
  const items = links(doc.links);
  const processUrl =
    linked(items, REL + "process", response.url) ?? linked(items, "process", response.url);
  const url =
    optionalLink(response.location, response.url) ??
    linked(items, "status", response.url) ??
    linked(items, "self", response.url) ??
    fallback;
  const resultsUrl =
    linked(items, REL + "results", response.url) ?? linked(items, "results", response.url);
  return {
    id: typeof doc.jobID === "string" ? doc.jobID : pathIdentifier(url),
    url,
    status: status as OgcProcessJobStatus,
    message: typeof doc.message === "string" ? doc.message : "",
    ...(typeof doc.progress === "number" && Number.isFinite(doc.progress)
      ? { progress: Math.max(0, Math.min(100, doc.progress)) }
      : {}),
    resultsUrl: resultsUrl ?? append(url, "/results"),
    ...(resultsUrl ? { resultsUrlAdvertised: true } : {}),
    retryAfterMs: ogcProcessRetryDelay(response.retryAfter),
    ...(typeof doc.processID === "string" ? { processId: doc.processID } : {}),
    ...(processUrl ? { processUrl } : {}),
  };
}

/** Resolve advertised job context; unavailable descriptions leave normative Core results usable. */
export async function resolveOgcProcessJobContext(
  current: OgcProcessJob,
  signal: AbortSignal,
): Promise<OgcProcessJob> {
  if (current.outputDefinitions) return current;
  let url = current.processUrl;
  if (!url && current.processId) {
    const target = processHttpUrl(current.url);
    if (/\/jobs\/[^/]+\/?$/.test(target.pathname)) {
      target.pathname = target.pathname.replace(
        /\/jobs\/[^/]+\/?$/,
        `/processes/${encodeURIComponent(current.processId)}`,
      );
      url = target.href;
    }
  }
  if (!url) return current;
  try {
    const response = await processHttp(jsonUrl(url), signal);
    successful(response);
    const description = processDocument(decode(response), response.url);
    return {
      ...current,
      processUrl: description.url,
      outputDefinitions: description.outputs,
      outputIds: Object.keys(description.outputs),
    };
  } catch (error) {
    if (signal.aborted) throw error;
    return current;
  }
}

function outputFormat(
  definition: JsonObject | undefined,
  depth = 0,
  selectedMediaType?: string,
): { encoding?: string; mediaType?: string } {
  const schema = definition?.schema;
  if (!schema || typeof schema !== "object" || Array.isArray(schema) || depth > 8) return {};
  const value = schema as JsonObject;
  const mediaType = typeof value.contentMediaType === "string" ? value.contentMediaType : undefined;
  if (
    value.contentEncoding === "binary" ||
    value.contentEncoding === "base64" ||
    value.format === "byte"
  )
    return { encoding: "base64", mediaType };
  const alternatives = value.oneOf ?? value.anyOf;
  if (Array.isArray(alternatives) && alternatives.length) {
    const formats = alternatives.map((schema) =>
      outputFormat({ schema }, depth + 1, selectedMediaType),
    );
    if (selectedMediaType) {
      const exact = formats.find((format) => format.mediaType === selectedMediaType);
      const matches = formats.filter(
        (format) =>
          format.mediaType?.split(";", 1)[0].trim().toLowerCase() ===
          selectedMediaType.split(";", 1)[0].trim().toLowerCase(),
      );
      if (exact) return exact;
      if (matches.length === 1) return matches[0];
    }
    // OGC Processes Core Requirement 54 makes the first oneOf format the default.
    if (Array.isArray(value.oneOf) && !selectedMediaType)
      return formats[0].mediaType || !mediaType ? formats[0] : { ...formats[0], mediaType };
    if (formats.every((format) => format.encoding === "base64"))
      return {
        encoding: "base64",
        mediaType: formats.every((format) => format.mediaType === formats[0].mediaType)
          ? formats[0].mediaType
          : undefined,
      };
  }
  return mediaType ? { mediaType } : {};
}

function outputs(
  response: ProcessHttpResponse,
  outputIds?: readonly string[],
  definitions?: OgcProcess["outputs"],
): OgcProcessOutput[] {
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
  const geoJson =
    typeof doc.type === "string" &&
    ((doc.type === "FeatureCollection" && Array.isArray(doc.features)) ||
      doc.type === "Feature" ||
      (doc.type === "GeometryCollection" && Array.isArray(doc.geometries)) ||
      (["Point", "MultiPoint", "LineString", "MultiLineString", "Polygon", "MultiPolygon"].includes(
        doc.type,
      ) &&
        Array.isArray(doc.coordinates)));
  if (
    geoJson &&
    (/geo\+json/i.test(response.contentType ?? "") ||
      (outputIds !== undefined && !Object.keys(doc).some((key) => outputIds.includes(key))))
  )
    return [{ id: "result", value: doc, mediaType: "application/geo+json" }];
  const legacyArray =
    outputIds !== undefined &&
    !outputIds.includes("outputs") &&
    Object.keys(doc).length === 1 &&
    Array.isArray(doc.outputs);
  const entries = legacyArray
    ? (doc.outputs as unknown[]).map((raw) => {
        const value = object(raw);
        return [String(value.id ?? "result"), value] as const;
      })
    : Object.entries(doc);
  return entries.map(([id, raw]): OgcProcessOutput => {
    const format = outputFormat(definitions?.[id]);
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const value = raw as JsonObject;
      if (typeof value.href === "string")
        return {
          id,
          href: ogcProcessLink(value.href, response.url),
          ...(format.mediaType ? { mediaType: format.mediaType } : {}),
          ...(typeof value.type === "string" ? { mediaType: value.type } : {}),
          ...(typeof value.mediaType === "string" ? { mediaType: value.mediaType } : {}),
        };
      if (Object.hasOwn(value, "value")) {
        const explicitMediaType = typeof value.mediaType === "string" ? value.mediaType : undefined;
        const selectedFormat = explicitMediaType
          ? outputFormat(definitions?.[id], 0, explicitMediaType)
          : format;
        const mediaType = explicitMediaType ?? selectedFormat.mediaType;
        const encoding =
          typeof value.encoding === "string"
            ? value.encoding
            : typeof value.value === "string"
              ? selectedFormat.encoding
              : undefined;
        return {
          id,
          value: value.value,
          ...(mediaType ? { mediaType } : {}),
          ...(encoding ? { encoding } : {}),
        };
      }
    }
    return { id, value: raw, ...(typeof raw === "string" ? format : {}) };
  });
}

/** Resolve the advertised destination for display and for the execution POST. */
export function ogcProcessExecutionUrl(process: OgcProcess): string {
  return linked(process.links, REL + "execute", process.url) ?? append(process.url, "/execution");
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
    throw new OgcProcessError("inputLimit");
  const endpoint = ogcProcessExecutionUrl(process);
  const response = await processHttp(endpoint, signal, {
    method: "POST",
    body,
    preferAsync: asynchronous,
    maxBytes: MAX_PROCESS_RESULT_BYTES,
  });
  successful(response);
  const retainedUrl =
    optionalLink(response.location, response.url) ??
    ogcProcessMonitorLinks(response.link).flatMap((href) => {
      try {
        return [ogcProcessLink(href, response.url)];
      } catch {
        return [];
      }
    })[0];
  const retainedJob = (url: string, status: "accepted" | "successful"): OgcProcessJob => ({
    id: pathIdentifier(url),
    url,
    status,
    message: "",
    resultsUrl: append(url, "/results"),
    retryAfterMs: ogcProcessRetryDelay(response.retryAfter),
    outputIds: Object.keys(process.outputs),
    outputDefinitions: process.outputs,
    processUrl: process.url,
  });
  if (response.bodyReadFailed) {
    if (!retainedUrl) throw new OgcProcessError("executionUncertain", { detail: "" });
    return { kind: "job", job: retainedJob(retainedUrl, "accepted") };
  }
  if (response.status === 201 || response.status === 202) {
    let fallback: string | undefined = retainedUrl;
    if (!fallback && response.body.length) {
      let document: JsonObject = {};
      try {
        document = object(decode(response));
      } catch {
        /* Missing routing is reported below, without exposing a JSON parser error. */
      }
      const jobs = linked(process.links, REL + "job-list", process.url);
      if (jobs && typeof document.jobID === "string")
        fallback = append(jobs, `/${encodeURIComponent(document.jobID)}`);
      else
        fallback =
          linked(links(document.links), "status", response.url) ??
          linked(links(document.links), "self", response.url);
    }
    if (!fallback) throw new OgcProcessError("noStatusUrl");
    if (response.body.length) {
      try {
        return {
          kind: "job",
          job: {
            ...job(response, fallback),
            outputIds: Object.keys(process.outputs),
            outputDefinitions: process.outputs,
            processUrl: process.url,
          },
        };
      } catch {
        /* An accepted status URL remains recoverable despite a malformed optional body. */
      }
    }
    return {
      kind: "job",
      job: retainedJob(fallback, "accepted"),
    };
  }
  try {
    return {
      kind: "results",
      outputs: outputs(response, Object.keys(process.outputs), process.outputs),
      ...(retainedUrl ? { job: retainedJob(retainedUrl, "successful") } : {}),
    };
  } catch (error) {
    if (!retainedUrl) throw error;
    return { kind: "job", job: retainedJob(retainedUrl, "accepted") };
  }
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
  return outputs(response, job.outputIds, job.outputDefinitions);
}

/** Dismiss only the particular job the caller selected. */
export async function dismissOgcProcessJob(url: string, signal: AbortSignal): Promise<void> {
  const response = await processHttp(url, signal, { method: "DELETE" });
  if (response.status === 404 || response.status === 410) return;
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
    if (value.length > MAX_PROCESS_RESULT_BYTES) throw new OgcProcessError("resultTooLarge");
    const bytes = new Uint8Array(value.length);
    for (let index = 0; index < value.length; index++) bytes[index] = value.charCodeAt(index);
    return new Blob([bytes], { type: output.mediaType });
  }
  return new Blob(
    [typeof output.value === "string" ? output.value : (JSON.stringify(output.value) ?? "null")],
    {
      type:
        output.mediaType ?? (typeof output.value === "string" ? "text/plain" : "application/json"),
    },
  );
}

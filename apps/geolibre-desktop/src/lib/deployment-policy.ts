// Typed, lenient parser for deployment.json (policy format v1).
//
// Each section is validated independently; a section with any invalid field is
// dropped whole (with a console warning) and the others still apply. Delivery
// reads the desktop config directory first, then the optional web file.
// See docs/deployment-policy.md and schema/deployment.schema.json.

import { isDeploymentCapability, type DeploymentCapability } from "@geolibre/core";
import { invoke } from "@tauri-apps/api/core";
import {
  SERVICE_KINDS,
  type ServiceFieldValue,
  type ServiceLibraryKind,
} from "../components/layout/add-data/service-library";
import { EXPERIENCE_LEVELS, type ExperienceLevel } from "../hooks/useDesktopSettings";
import { setDeploymentPolicy } from "./deployment-env";
import { OPTIONAL_RESOURCE_HEADER } from "./diagnostics";
import { isTauri } from "./is-tauri";
import { normalizeStringList } from "./string-lists";

/** The only deployment.json format version this build understands. */
export const DEPLOYMENT_POLICY_VERSION = 1;

/** UI profile filtering. */
export interface InterfacePolicy {
  enabled?: boolean;
  level?: ExperienceLevel;
  lock?: boolean;
  hiddenDataSources?: string[];
  hiddenPlugins?: string[];
  hiddenMenus?: string[];
  hiddenMenuItems?: string[];
}

/** External plugin loading policy. */
export interface PluginsPolicy {
  registryUrl?: string;
  allowed?: string[];
  blocked?: string[];
  sideload?: boolean;
  defaultActive?: string[];
}

/** One curated web-service library entry. */
export interface DeploymentServiceEntry {
  id: string;
  name: string;
  kind: ServiceLibraryKind;
  category?: string;
  fields: Record<string, ServiceFieldValue>;
}

/** Web-service library policy. */
export interface ServicesPolicy {
  builtins?: boolean;
  catalog?: DeploymentServiceEntry[];
}

/** Sharing and collaboration endpoints. */
export interface SharingPolicy {
  shareUrl?: string;
  collabUrl?: string;
  embedOrigins?: string[];
}

/** GeoLens integration. */
export interface GeoLensPolicy {
  url?: string;
}

/** AI assistant settings. */
export interface AiPolicy {
  enabled?: boolean;
  model?: string;
}

/** Application branding. */
export interface BrandingPolicy {
  appName?: string;
  welcome?: boolean;
}

/** A validated deployment policy. An absent section means "not specified". */
export interface DeploymentPolicy {
  version: 1;
  capabilities?: DeploymentCapability[];
  interface?: InterfacePolicy;
  plugins?: PluginsPolicy;
  services?: ServicesPolicy;
  sharing?: SharingPolicy;
  geolens?: GeoLensPolicy;
  ai?: AiPolicy;
  branding?: BrandingPolicy;
}

type Result<T> = { value: T } | { error: string };

const SHARE_URL = /^(off|https?:\/\/\S+)$/;
const COLLAB_URL = /^wss?:\/\/\S+$/;
const EMBED_ORIGIN = /^(\*|https?:\/\/[^/\s]+)$/;
const GEOLENS_URL = /^(off|same-origin|https?:\/\/\S+)$/;
const APP_NAME_MAX = 60;

const TOP_LEVEL_KEYS = new Set([
  "$schema",
  "version",
  "capabilities",
  "interface",
  "plugins",
  "services",
  "sharing",
  "geolens",
  "ai",
  "branding",
]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function err(error: string): { error: string } {
  return { error };
}

/** Returns an object view of `v` limited to `allowed` keys, or an error. */
function readObject(v: unknown, allowed: readonly string[]): Result<Record<string, unknown>> {
  if (!isPlainObject(v)) return err("must be an object");
  for (const key of Object.keys(v)) {
    if (!allowed.includes(key)) return err(`unknown key '${key}'`);
  }
  return { value: v };
}

function readBoolean(v: unknown, field: string): Result<boolean> {
  return typeof v === "boolean" ? { value: v } : err(`'${field}' must be a boolean`);
}

function readNonBlank(v: unknown, field: string): Result<string> {
  return typeof v === "string" && v.trim() !== ""
    ? { value: v }
    : err(`'${field}' must be a non-blank string`);
}

function readPattern(v: unknown, field: string, pattern: RegExp): Result<string> {
  return typeof v === "string" && pattern.test(v)
    ? { value: v }
    : err(`'${field}' has an invalid value`);
}

function readIdList(v: unknown, field: string, itemPattern?: RegExp): Result<string[]> {
  const bad = err(`'${field}' must be a list of unique non-blank strings`);
  if (!Array.isArray(v) || !v.every((item) => typeof item === "string")) return bad;
  const normalized = normalizeStringList(v);
  if (normalized.length !== v.length) return bad;
  if (itemPattern && !normalized.every((item) => itemPattern.test(item))) {
    return err(`'${field}' has an invalid entry`);
  }
  return { value: normalized };
}

/**
 * Applies `read` to each present key of `obj` and assigns the result to `out`.
 * Returns the first error, prefixed with nothing (field names are in messages).
 */
function readFields(
  obj: Record<string, unknown>,
  readers: Record<string, (v: unknown) => Result<unknown>>,
): Result<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const [key, read] of Object.entries(readers)) {
    if (obj[key] === undefined) continue;
    const r = read(obj[key]);
    if ("error" in r) return r;
    out[key] = r.value;
  }
  return { value: out };
}

function readCapabilities(v: unknown): Result<DeploymentCapability[]> {
  if (!Array.isArray(v)) return err("must be an array");
  const seen = new Set<string>();
  const out: DeploymentCapability[] = [];
  for (const item of v) {
    if (typeof item !== "string" || !isDeploymentCapability(item)) {
      return err(`unknown capability '${String(item)}'`);
    }
    if (seen.has(item)) return err(`duplicate capability '${item}'`);
    seen.add(item);
    out.push(item);
  }
  return { value: out };
}

function readInterface(v: unknown): Result<InterfacePolicy> {
  const keys = [
    "enabled",
    "level",
    "lock",
    "hiddenDataSources",
    "hiddenPlugins",
    "hiddenMenus",
    "hiddenMenuItems",
  ];
  const obj = readObject(v, keys);
  if ("error" in obj) return obj;
  const r = readFields(obj.value, {
    enabled: (x) => readBoolean(x, "enabled"),
    level: (x) =>
      EXPERIENCE_LEVELS.includes(x as ExperienceLevel)
        ? { value: x }
        : err("'level' must be one of " + EXPERIENCE_LEVELS.join(", ")),
    lock: (x) => readBoolean(x, "lock"),
    hiddenDataSources: (x) => readIdList(x, "hiddenDataSources"),
    hiddenPlugins: (x) => readIdList(x, "hiddenPlugins"),
    hiddenMenus: (x) => readIdList(x, "hiddenMenus"),
    hiddenMenuItems: (x) => readIdList(x, "hiddenMenuItems"),
  });
  return "error" in r ? r : { value: r.value as InterfacePolicy };
}

function readPlugins(v: unknown): Result<PluginsPolicy> {
  const obj = readObject(v, ["registryUrl", "allowed", "blocked", "sideload", "defaultActive"]);
  if ("error" in obj) return obj;
  const r = readFields(obj.value, {
    registryUrl: (x) => readNonBlank(x, "registryUrl"),
    allowed: (x) => readIdList(x, "allowed"),
    blocked: (x) => readIdList(x, "blocked"),
    sideload: (x) => readBoolean(x, "sideload"),
    defaultActive: (x) => readIdList(x, "defaultActive"),
  });
  return "error" in r ? r : { value: r.value as PluginsPolicy };
}

function isValidFieldValue(v: unknown): v is ServiceFieldValue {
  if (typeof v === "string" || typeof v === "boolean") return true;
  return (
    typeof v === "number" && Number.isFinite(v) && (!Number.isInteger(v) || Number.isSafeInteger(v))
  );
}

function readCatalogEntry(v: unknown, index: number): Result<DeploymentServiceEntry> {
  const at = `catalog[${index}]`;
  const obj = readObject(v, ["id", "name", "kind", "category", "fields"]);
  if ("error" in obj) return err(`${at}: ${obj.error}`);
  const e = obj.value;
  const id = readNonBlank(e.id, "id");
  if ("error" in id) return err(`${at}: ${id.error}`);
  const name = readNonBlank(e.name, "name");
  if ("error" in name) return err(`${at}: ${name.error}`);
  if (typeof e.kind !== "string" || !(SERVICE_KINDS as readonly string[]).includes(e.kind)) {
    return err(`${at}.kind must be one of ${SERVICE_KINDS.join(", ")}`);
  }
  if (e.category !== undefined && typeof e.category !== "string") {
    return err(`${at}.category must be a string`);
  }
  if (!isPlainObject(e.fields) || Object.keys(e.fields).length === 0) {
    return err(`${at}.fields must be a non-empty object`);
  }
  for (const [key, value] of Object.entries(e.fields)) {
    if (!isValidFieldValue(value)) return err(`${at}.fields.${key} has an invalid value`);
  }
  const entry: DeploymentServiceEntry = {
    id: id.value.trim(),
    name: name.value.trim(),
    kind: e.kind as ServiceLibraryKind,
    fields: e.fields as Record<string, ServiceFieldValue>,
  };
  if (e.category !== undefined) entry.category = e.category as string;
  return { value: entry };
}

function readServices(v: unknown): Result<ServicesPolicy> {
  const obj = readObject(v, ["builtins", "catalog"]);
  if ("error" in obj) return obj;
  const out: ServicesPolicy = {};
  if (obj.value.builtins !== undefined) {
    const b = readBoolean(obj.value.builtins, "builtins");
    if ("error" in b) return b;
    out.builtins = b.value;
  }
  if (obj.value.catalog !== undefined) {
    if (!Array.isArray(obj.value.catalog)) return err("'catalog' must be an array");
    const seen = new Set<string>();
    const catalog: DeploymentServiceEntry[] = [];
    for (const [i, raw] of obj.value.catalog.entries()) {
      const entry = readCatalogEntry(raw, i);
      if ("error" in entry) return entry;
      const key = entry.value.id.trim();
      if (seen.has(key)) return err(`duplicate service id '${key}'`);
      seen.add(key);
      catalog.push(entry.value);
    }
    out.catalog = catalog;
  }
  return { value: out };
}

function readSharing(v: unknown): Result<SharingPolicy> {
  const obj = readObject(v, ["shareUrl", "collabUrl", "embedOrigins"]);
  if ("error" in obj) return obj;
  const r = readFields(obj.value, {
    shareUrl: (x) => readPattern(x, "shareUrl", SHARE_URL),
    collabUrl: (x) => readPattern(x, "collabUrl", COLLAB_URL),
    embedOrigins: (x) => readIdList(x, "embedOrigins", EMBED_ORIGIN),
  });
  return "error" in r ? r : { value: r.value as SharingPolicy };
}

function readGeoLens(v: unknown): Result<GeoLensPolicy> {
  const obj = readObject(v, ["url"]);
  if ("error" in obj) return obj;
  const r = readFields(obj.value, { url: (x) => readPattern(x, "url", GEOLENS_URL) });
  return "error" in r ? r : { value: r.value as GeoLensPolicy };
}

function readAi(v: unknown): Result<AiPolicy> {
  const obj = readObject(v, ["enabled", "model"]);
  if ("error" in obj) return obj;
  const r = readFields(obj.value, {
    enabled: (x) => readBoolean(x, "enabled"),
    model: (x) => readNonBlank(x, "model"),
  });
  return "error" in r ? r : { value: r.value as AiPolicy };
}

function readBranding(v: unknown): Result<BrandingPolicy> {
  const obj = readObject(v, ["appName", "welcome"]);
  if ("error" in obj) return obj;
  const r = readFields(obj.value, {
    appName: (x) => {
      const name = readNonBlank(x, "appName");
      if ("error" in name) return name;
      return Array.from(name.value).length <= APP_NAME_MAX
        ? name
        : err(`'appName' must be at most ${APP_NAME_MAX} characters`);
    },
    welcome: (x) => readBoolean(x, "welcome"),
  });
  return "error" in r ? r : { value: r.value as BrandingPolicy };
}

const SECTION_READERS: Record<string, (v: unknown) => Result<unknown>> = {
  capabilities: readCapabilities,
  interface: readInterface,
  plugins: readPlugins,
  services: readServices,
  sharing: readSharing,
  geolens: readGeoLens,
  ai: readAi,
  branding: readBranding,
};

/**
 * Validates an already-parsed deployment.json value.
 *
 * Returns `null` when the value is not an object or its `version` is not 1
 * (the latter with a warning). Otherwise each section is validated on its own:
 * an invalid section is omitted with a warning and the rest are kept. Unknown
 * top-level keys are ignored with one warning.
 */
export function resolveDeploymentPolicy(raw: unknown): DeploymentPolicy | null {
  if (!isPlainObject(raw)) return null;
  if (raw.version !== DEPLOYMENT_POLICY_VERSION) {
    const shown = raw.version === undefined ? "(missing)" : JSON.stringify(raw.version);
    console.warn(`[deployment-policy] unsupported version ${shown}; ignoring deployment.json`);
    return null;
  }

  const unknownKeys = Object.keys(raw).filter((key) => !TOP_LEVEL_KEYS.has(key));
  if (unknownKeys.length > 0) {
    console.warn(`[deployment-policy] ignoring unknown keys: ${unknownKeys.join(", ")}`);
  }

  const policy: Record<string, unknown> = { version: DEPLOYMENT_POLICY_VERSION };
  for (const [section, read] of Object.entries(SECTION_READERS)) {
    if (raw[section] === undefined) continue;
    const r = read(raw[section]);
    if ("error" in r) {
      console.warn(`[deployment-policy] ignoring invalid '${section}': ${r.error}`);
      continue;
    }
    policy[section] = r.value;
  }
  return policy as unknown as DeploymentPolicy;
}

/**
 * Parses deployment.json text. Returns `null` silently for null/empty input,
 * non-JSON (a web fetch can legitimately return an HTML fallback page) or a
 * non-object; see {@link resolveDeploymentPolicy} for the rest.
 */
export function parseDeploymentPolicy(contents: string | null): DeploymentPolicy | null {
  if (!contents) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents.replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
  return resolveDeploymentPolicy(parsed);
}

/** How long startup waits for deployment.json before rendering without it. */
export const DEPLOYMENT_POLICY_TIMEOUT_MS = 3000;

export interface FetchDeploymentPolicyOptions {
  url?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

function defaultPolicyUrl(): string {
  // Read `import.meta.env` inline: Vite only rewrites that exact expression, so
  // an alias (`const meta = import.meta`) reaches the browser unreplaced and
  // every subpath deployment fetched the policy from the site root.
  const base = (import.meta as ImportMeta & { env?: { BASE_URL?: string } }).env?.BASE_URL;
  return `${base ?? "/"}deployment.json`;
}

/**
 * Fetches and parses deployment.json. Resolves `null` — never rejects — when the
 * file is absent (404, HTML fallback), unreachable, malformed or too slow: no
 * policy is the normal case and must leave the app's behavior unchanged.
 */
export async function fetchDeploymentPolicy(
  options: FetchDeploymentPolicyOptions = {},
): Promise<DeploymentPolicy | null> {
  const url = options.url ?? defaultPolicyUrl();
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? DEPLOYMENT_POLICY_TIMEOUT_MS,
  );
  try {
    const response = await fetchImpl(url, {
      headers: { [OPTIONAL_RESOURCE_HEADER]: "1" },
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) return null;
    return parseDeploymentPolicy(await response.text());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function readDeploymentPolicy(): Promise<DeploymentPolicy | null> {
  if (isTauri()) {
    try {
      const contents = await invoke<string | null>("read_deployment_policy");
      // An existing config-dir file owns the whole policy, even when invalid.
      // Only absence or a failed read permits the bundled web-file fallback.
      if (contents !== null) return parseDeploymentPolicy(contents);
    } catch (error) {
      console.warn("[deployment-policy] read_deployment_policy failed:", error);
    }
  }
  return fetchDeploymentPolicy();
}

let loading: Promise<DeploymentPolicy | null> | null = null;

/** Loads deployment.json once and installs it before the first render. */
export function loadDeploymentPolicy(): Promise<DeploymentPolicy | null> {
  loading ??= readDeploymentPolicy().then((policy) => {
    setDeploymentPolicy(policy);
    return policy;
  });
  return loading;
}

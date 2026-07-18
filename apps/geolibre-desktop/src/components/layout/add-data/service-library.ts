/**
 * Saved service library: a cross-project, localStorage-backed catalog of
 * reusable web-service layer definitions (WMS / WFS / WMTS / XYZ / ArcGIS).
 *
 * The Add Data dialog's web-service sources let users save the current form as
 * a named, categorised entry and reload it later — including across projects —
 * so they don't have to keep a separate database of service URLs (issue #417).
 *
 * Entries are plain `string | number | boolean` field bags so they serialise
 * cleanly to JSON (localStorage + import/export) and repopulate the source
 * forms directly. Built-in presets seed the library: they are always listed but
 * never persisted, so they stay fresh across releases and can't be deleted.
 */

import {
  DEFAULT_ARCGIS_FEATURE_URL,
  DEFAULT_WFS_ENDPOINT,
  DEFAULT_WFS_TYPE_NAME,
  DEFAULT_WMS_ENDPOINT,
  DEFAULT_WMS_LAYERS,
  DEFAULT_WMTS_URL,
  DEFAULT_XYZ_URL,
  GEBCO_WMS_ENDPOINT,
  GEBCO_WMS_LAYERS,
  MAX_SAVED_SERVICES,
  SERVICE_LIBRARY_STORAGE_KEY,
} from "./constants";

/** The web-service source kinds that participate in the saved library. */
export type ServiceLibraryKind = "wms" | "wfs" | "wmts" | "xyz" | "arcgis";

export type ServiceFieldValue = string | number | boolean;

export type ServiceFields = Record<string, ServiceFieldValue>;

export interface ServiceLibraryEntry {
  /** Stable unique id. */
  id: string;
  /** User-facing name; also offered as the layer name when applied. */
  name: string;
  /** User-defined group (country, theme, …). Empty string = uncategorised. */
  category: string;
  /** Which web-service source this entry belongs to. */
  kind: ServiceLibraryKind;
  /** Source-form field values, applied verbatim when the entry is loaded. */
  fields: ServiceFields;
  /** True for built-in presets: always listed, read-only, never persisted. */
  builtin?: boolean;
}

const SERVICE_KINDS: readonly ServiceLibraryKind[] = ["wms", "wfs", "wmts", "xyz", "arcgis"];

/** Label used for entries that have no category set. */
export const UNCATEGORIZED_LABEL = "Uncategorized";

/** The wrapped JSON shape produced by {@link serializeUserServices}. */
const EXPORT_FORMAT = "geolibre-service-library";

function createServiceId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Reads a string field, coercing numbers/booleans, with a fallback. */
export function serviceFieldString(fields: ServiceFields, key: string, fallback = ""): string {
  const value = fields[key];
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return fallback;
}

/** Reads a boolean field, with a fallback when absent or non-boolean. */
export function serviceFieldBoolean(fields: ServiceFields, key: string, fallback = false): boolean {
  const value = fields[key];
  return typeof value === "boolean" ? value : fallback;
}

function isServiceKind(value: unknown): value is ServiceLibraryKind {
  return typeof value === "string" && (SERVICE_KINDS as readonly string[]).includes(value);
}

function normalizeFields(value: unknown): ServiceFields {
  if (!value || typeof value !== "object") return {};
  const result: ServiceFields = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") {
      result[key] = raw;
    }
  }
  return result;
}

/**
 * Validates and sanitises one parsed object into a `ServiceLibraryEntry`,
 * returning `null` when it is unusable. The `builtin` flag is intentionally
 * dropped — user/imported entries are never treated as read-only presets.
 */
function normalizeEntry(value: unknown): ServiceLibraryEntry | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (!isServiceKind(record.kind)) return null;
  const name = typeof record.name === "string" ? record.name.trim() : "";
  if (!name) return null;
  const fields = normalizeFields(record.fields);
  if (Object.keys(fields).length === 0) return null;
  const id =
    typeof record.id === "string" && record.id.trim() ? record.id.trim() : createServiceId();
  const category = typeof record.category === "string" ? record.category.trim() : "";
  return { id, name, category, kind: record.kind, fields };
}

/**
 * Validates an arbitrary parsed value into a clean entry list: drops invalid
 * items, re-ids duplicates (and any clash with a built-in id) so each id stays
 * unique, and caps the length.
 */
export function normalizeServiceEntries(value: unknown): ServiceLibraryEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: ServiceLibraryEntry[] = [];
  // Seed with built-in ids so a stored/imported entry reusing one (e.g.
  // "builtin-xyz-osm") is re-assigned rather than being shadowed by the preset
  // in listServices and becoming unreachable/non-deletable.
  const seenIds = new Set<string>(BUILTIN_SERVICES.map((entry) => entry.id));
  for (const item of value) {
    const entry = normalizeEntry(item);
    if (!entry) continue;
    if (seenIds.has(entry.id)) entry.id = createServiceId();
    seenIds.add(entry.id);
    entries.push(entry);
    if (entries.length >= MAX_SAVED_SERVICES) break;
  }
  return entries;
}

/** Reads the user's saved services from localStorage (best-effort). */
export function readUserServices(): ServiceLibraryEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const value = window.localStorage.getItem(SERVICE_LIBRARY_STORAGE_KEY);
    if (!value) return [];
    return normalizeServiceEntries(JSON.parse(value));
  } catch {
    return [];
  }
}

/** Persists the user's saved services to localStorage (best-effort). */
export function writeUserServices(entries: ServiceLibraryEntry[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      SERVICE_LIBRARY_STORAGE_KEY,
      JSON.stringify(entries.slice(0, MAX_SAVED_SERVICES)),
    );
  } catch {
    // Best-effort persistence: a quota/private-mode failure must not break the
    // Add Data dialog (mirrors readUserServices' guard).
  }
}

/**
 * Builds a fresh, unsaved entry from the current form. Callers persist the
 * result via {@link upsertServiceEntry} + {@link writeUserServices}.
 */
export function createServiceEntry(input: {
  /** Reuse an existing id to update in place; omit to mint a new entry. */
  id?: string;
  name: string;
  category: string;
  kind: ServiceLibraryKind;
  fields: ServiceFields;
}): ServiceLibraryEntry {
  return {
    id: input.id ?? createServiceId(),
    name: input.name.trim(),
    category: input.category.trim(),
    kind: input.kind,
    fields: input.fields,
  };
}

/** Inserts or replaces an entry by id, newest first, capped at the limit. */
export function upsertServiceEntry(
  entries: ServiceLibraryEntry[],
  entry: ServiceLibraryEntry,
): ServiceLibraryEntry[] {
  const without = entries.filter((existing) => existing.id !== entry.id);
  return [entry, ...without].slice(0, MAX_SAVED_SERVICES);
}

/** Removes the entry with the given id. */
export function removeServiceEntry(
  entries: ServiceLibraryEntry[],
  id: string,
): ServiceLibraryEntry[] {
  return entries.filter((entry) => entry.id !== id);
}

/** Serialises the user's services to a portable JSON document for export. */
export function serializeUserServices(entries: ServiceLibraryEntry[]): string {
  return JSON.stringify(
    {
      type: EXPORT_FORMAT,
      version: 1,
      services: entries.map(({ builtin: _builtin, ...rest }) => rest),
    },
    null,
    2,
  );
}

/**
 * Parses an exported document (or a bare entry array) into clean entries.
 * Throws on invalid JSON so the caller can surface a parse error.
 */
export function parseImportedServices(text: string): ServiceLibraryEntry[] {
  const parsed = JSON.parse(text) as unknown;
  const list = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object"
      ? (parsed as { services?: unknown }).services
      : undefined;
  return normalizeServiceEntries(list);
}

/**
 * Merges imported entries into the existing list, assigning fresh ids on
 * collision so an import never silently overwrites a saved service.
 */
export function mergeImportedServices(
  existing: ServiceLibraryEntry[],
  imported: ServiceLibraryEntry[],
): ServiceLibraryEntry[] {
  const merged = [...existing];
  // Reserve built-in ids too: an imported entry reusing one (e.g.
  // "builtin-xyz-osm") would otherwise be shadowed by the preset in
  // listServices and become unreachable/non-deletable.
  const seen = new Set([
    ...BUILTIN_SERVICES.map((entry) => entry.id),
    ...existing.map((entry) => entry.id),
  ]);
  for (const entry of imported) {
    const id = seen.has(entry.id) ? createServiceId() : entry.id;
    seen.add(id);
    merged.push({ ...entry, id });
  }
  return merged.slice(0, MAX_SAVED_SERVICES);
}

/**
 * Lists every entry for a kind — built-in presets first, then the user's saved
 * services — for the source picker.
 */
export function listServices(
  kind: ServiceLibraryKind,
  userEntries: ServiceLibraryEntry[],
): ServiceLibraryEntry[] {
  return [
    ...BUILTIN_SERVICES.filter((entry) => entry.kind === kind),
    ...userEntries.filter((entry) => entry.kind === kind),
  ];
}

/** The distinct, sorted categories present in a list of entries. */
export function serviceCategories(entries: ServiceLibraryEntry[]): string[] {
  const categories = new Set<string>();
  for (const entry of entries) {
    if (entry.category) categories.add(entry.category);
  }
  return Array.from(categories).sort((a, b) => a.localeCompare(b));
}

/**
 * Built-in starter presets so the library is useful on first run. They reuse
 * the same defaults the source forms ship with, and stay read-only.
 */
export const BUILTIN_SERVICES: readonly ServiceLibraryEntry[] = [
  {
    id: "builtin-wms-usgs-naip",
    name: "USGS NAIP Imagery",
    category: "Imagery",
    kind: "wms",
    builtin: true,
    fields: {
      endpoint: DEFAULT_WMS_ENDPOINT,
      layers: DEFAULT_WMS_LAYERS,
      styles: "",
      format: "image/png",
      transparent: true,
      tileSize: "256",
    },
  },
  {
    id: "builtin-wms-gebco",
    name: "GEBCO Ocean Bathymetry",
    category: "Imagery",
    kind: "wms",
    builtin: true,
    fields: {
      endpoint: GEBCO_WMS_ENDPOINT,
      layers: GEBCO_WMS_LAYERS,
      styles: "",
      format: "image/png",
      transparent: true,
      tileSize: "256",
      // GEBCO serves the latest grid over WMS 1.3.0; pin it so the saved
      // service does not fall back to 1.1.1's flipped-axis GetMap.
      version: "1.3.0",
    },
  },
  {
    id: "builtin-xyz-usgs-imagery",
    name: "USGS Imagery",
    category: "Imagery",
    kind: "xyz",
    builtin: true,
    fields: { url: DEFAULT_XYZ_URL, tileSize: "256", shortUrl: false },
  },
  {
    id: "builtin-xyz-osm",
    name: "OpenStreetMap",
    category: "Basemaps",
    kind: "xyz",
    builtin: true,
    fields: {
      url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
      tileSize: "256",
      shortUrl: false,
    },
  },
  {
    id: "builtin-wmts-world-imagery",
    name: "Sentinel-2 cloudless (EOX)",
    category: "Imagery",
    kind: "wmts",
    builtin: true,
    fields: { url: DEFAULT_WMTS_URL, tileSize: "256" },
  },
  {
    id: "builtin-wfs-states",
    name: "US States (GeoServer demo)",
    category: "Demo data",
    kind: "wfs",
    builtin: true,
    fields: {
      endpoint: DEFAULT_WFS_ENDPOINT,
      typeName: DEFAULT_WFS_TYPE_NAME,
      version: "2.0.0",
      outputFormat: "application/json",
      srsName: "EPSG:4326",
      maxFeatures: "1000",
    },
  },
  {
    id: "builtin-arcgis-usa-cities",
    name: "USA Major Cities",
    category: "Demo data",
    kind: "arcgis",
    builtin: true,
    fields: {
      layerType: "feature",
      sourceType: "url",
      url: DEFAULT_ARCGIS_FEATURE_URL,
      itemId: "",
      portalUrl: "",
    },
  },
];

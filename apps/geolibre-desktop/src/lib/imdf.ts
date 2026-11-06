/**
 * IMDF (Indoor Mapping Data Format) import (issue #3341).
 *
 * An IMDF archive is a zip of GeoJSON FeatureCollections, one per feature type
 * (`venue`, `building`, `footprint`, `level`, `unit`, `opening`, `amenity`,
 * `anchor`, `occupant`, `fixture`, `section`, `kiosk`, `detail`, ...) plus a
 * `manifest.json`. Features reference each other by id: a unit names its
 * `level_id`, an amenity its `unit_ids`, an occupant its `anchor_id`, whose
 * anchor names its `unit_id`.
 *
 * This module turns an archive into ready-to-draw layers. Every feature on a
 * floor gets that level's `ordinal` (and its short name) as plain properties,
 * so one units layer stacks its floors from `ordinal` and links to the floor
 * picker without the caller knowing anything about IMDF. Localized strings
 * (`{"en": "Lobby"}`) are flattened to the archive's language.
 *
 * Pure (no DOM, no store), so it is unit tested directly.
 */
import { isImdfArchiveEntries, isMacOsZipMetadata } from "@geolibre/core";
import i18next from "i18next";
import { strFromU8, unzipSync } from "fflate";

/** A GeoJSON feature as read from the archive. */
interface ImdfFeature {
  type: "Feature";
  id?: string | number;
  feature_type?: string;
  geometry: { type: string; coordinates?: unknown } | null;
  properties: Record<string, unknown> | null;
}

/** A problem inside an archive already recognized as IMDF. */
export class ImdfArchiveError extends Error {
  constructor(reason: string) {
    super(
      translate(
        "addData.imdf.error.unreadable",
        "This IMDF archive could not be read: {{reason}}",
        { reason },
      ),
    );
    this.name = "ImdfArchiveError";
  }
}

/**
 * A translated message, with the English text as the fallback so the parser
 * also works where i18next is not set up (a script, a unit test).
 */
function translate(key: string, english: string, params: Record<string, string>): string {
  if (i18next.isInitialized && i18next.exists(key))
    return i18next.t(key as never, params) as string;
  return english.replace(/\{\{(\w+)\}\}/g, (_, name: string) => params[name] ?? "");
}

/** One layer to add, in drawing order (bottom first). */
export interface ImdfLayer {
  /** The IMDF feature type: `unit`, `opening`, `amenity`, `occupant`, ... */
  featureType: string;
  /** Features with flattened properties, `ordinal` set where the type sits on a level. */
  geojson: {
    type: "FeatureCollection";
    features: Array<{
      type: "Feature";
      id?: string | number;
      geometry: unknown;
      properties: Record<string, unknown>;
    }>;
  };
  /** Whether the features carry an `ordinal` (and belong in the floor picker). */
  onLevels: boolean;
}

/** The parsed archive. */
export interface ImdfImport {
  /** The venue's name, for the layer group. */
  venueName: string | null;
  /** The manifest's language, used to flatten localized strings. */
  language: string;
  layers: ImdfLayer[];
  /** The lowest and highest level ordinals, or `null` when there are no levels. */
  ordinalRange: { min: number; max: number } | null;
}

/**
 * Feature types drawn as their own layer, bottom first. `anchor` is folded into
 * `occupant` (an occupant has no geometry of its own) and `address`,
 * `building` and `relationship` are reference records with nothing to draw.
 */
const LAYER_ORDER = [
  "venue",
  "footprint",
  "level",
  "section",
  "unit",
  "fixture",
  "detail",
  "opening",
  "kiosk",
  "geofence",
  "amenity",
  "occupant",
] as const;

/** Types folded into another layer or with no geometry worth drawing. */
const NOT_DRAWN = new Set(["anchor", "address", "building", "relationship", "manifest"]);

/** The archive entry name for a feature type, without folders or case. */
function entryType(path: string): string | null {
  const name = path.split("/").pop()?.toLowerCase() ?? "";
  const match = /^([a-z_]+)\.geojson$/.exec(name);
  return match ? match[1] : null;
}

/**
 * Flatten an IMDF localized string (`{"en": "Lobby", "fr": "Hall"}`) to one
 * language, falling back to the first entry.
 *
 * @param value - A labels object, a plain string, or anything else.
 * @param language - The preferred language tag.
 * @returns The text, or `null` when there is none.
 */
export function localizedText(value: unknown, language: string): string | null {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const labels = value as Record<string, unknown>;
  const exact = labels[language];
  if (typeof exact === "string") return exact;
  const base = language.split("-")[0];
  for (const [tag, text] of Object.entries(labels)) {
    if (typeof text === "string" && tag.split("-")[0] === base) return text;
  }
  const first = Object.values(labels).find((text) => typeof text === "string");
  return typeof first === "string" ? first : null;
}

/** Keys whose values are localized label objects in IMDF. */
const LABEL_KEYS = new Set(["name", "alt_name", "short_name"]);

/**
 * A feature's properties as flat values: localized labels become text, a
 * nested `display_point` is dropped (the map draws the geometry), and other
 * objects and arrays are kept as JSON text so every column stays readable in
 * the attribute table and in filters.
 */
function flattenProperties(
  properties: Record<string, unknown> | null,
  language: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties ?? {})) {
    if (key === "display_point") continue;
    if (LABEL_KEYS.has(key)) {
      const text = localizedText(value, language);
      if (text !== null) out[key] = text;
      continue;
    }
    if (value === null || value === undefined) continue;
    out[key] = typeof value === "object" ? JSON.stringify(value) : value;
  }
  return out;
}

/** What a level contributes to the features on it. */
interface LevelInfo {
  ordinal: number;
  name: string | null;
  outdoor: boolean;
}

/**
 * Parse an IMDF archive's files into layers.
 *
 * @param files - Archive entries by path; values are the file text.
 * @returns The layers to add, with every floor's ordinal joined in.
 * @throws Error when a feature file is not valid JSON.
 */
export function parseImdfArchive(files: ReadonlyMap<string, string>): ImdfImport {
  let language = "en";
  const collections = new Map<string, ImdfFeature[]>();
  for (const [path, text] of files) {
    const name = path.split("/").pop()?.toLowerCase() ?? "";
    if (name === "manifest.json") {
      try {
        const manifest = JSON.parse(text) as { language?: unknown };
        if (typeof manifest.language === "string" && manifest.language)
          language = manifest.language;
      } catch {
        // A malformed manifest only loses the language; the features still load.
      }
      continue;
    }
    const type = entryType(path);
    if (!type) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new ImdfArchiveError(
        translate("addData.imdf.error.invalidJson", "{{file}} is not valid JSON ({{detail}})", {
          file: name,
          detail: (error as Error).message,
        }),
      );
    }
    const features = (parsed as { features?: unknown })?.features;
    if (Array.isArray(features)) {
      collections.set(type, [...(collections.get(type) ?? []), ...(features as ImdfFeature[])]);
    }
  }

  const levels = new Map<string, LevelInfo>();
  for (const level of collections.get("level") ?? []) {
    // IMDF requires a numeric ordinal; `Number(null)` would put a level with a
    // missing one on the ground floor.
    const raw = level.properties?.ordinal;
    const ordinal = typeof raw === "number" ? raw : Number.NaN;
    if (level.id === undefined || !Number.isFinite(ordinal)) continue;
    levels.set(String(level.id), {
      ordinal,
      name:
        localizedText(level.properties?.short_name, language) ??
        localizedText(level.properties?.name, language),
      outdoor: level.properties?.outdoor === true,
    });
  }
  const unitLevel = new Map<string, LevelInfo>();
  for (const unit of collections.get("unit") ?? []) {
    const level = levels.get(String(unit.properties?.level_id ?? ""));
    if (unit.id !== undefined && level) unitLevel.set(String(unit.id), level);
  }
  const anchors = new Map<string, ImdfFeature>();
  for (const anchor of collections.get("anchor") ?? []) {
    if (anchor.id !== undefined) anchors.set(String(anchor.id), anchor);
  }

  /** The level a feature sits on, by its own `level_id` or the units it names. */
  function levelOf(feature: ImdfFeature, type: string): LevelInfo | undefined {
    const props = feature.properties ?? {};
    if (type === "level") return levels.get(String(feature.id ?? ""));
    if (props.level_id !== undefined && props.level_id !== null)
      return levels.get(String(props.level_id));
    if (props.unit_id !== undefined && props.unit_id !== null)
      return unitLevel.get(String(props.unit_id));
    if (Array.isArray(props.unit_ids)) {
      for (const id of props.unit_ids) {
        const level = unitLevel.get(String(id));
        if (level) return level;
      }
    }
    return undefined;
  }

  // Occupants have no geometry: draw each at its anchor, on the anchor's unit's floor.
  const occupants: ImdfFeature[] = [];
  for (const occupant of collections.get("occupant") ?? []) {
    const anchor = anchors.get(String(occupant.properties?.anchor_id ?? ""));
    if (!anchor?.geometry) continue;
    occupants.push({
      ...occupant,
      geometry: anchor.geometry,
      properties: { ...occupant.properties, unit_id: anchor.properties?.unit_id ?? null },
    });
  }
  if (occupants.length > 0) collections.set("occupant", occupants);

  const types = [
    ...LAYER_ORDER.filter((type) => collections.has(type)),
    ...[...collections.keys()].filter(
      (type) => !NOT_DRAWN.has(type) && !(LAYER_ORDER as readonly string[]).includes(type),
    ),
  ];
  const layers: ImdfLayer[] = [];
  for (const type of types) {
    if (NOT_DRAWN.has(type)) continue;
    let onLevels = false;
    const features = [];
    for (const feature of collections.get(type) ?? []) {
      if (!feature?.geometry) continue;
      const properties = flattenProperties(feature.properties, language);
      if (feature.id !== undefined) properties.id = feature.id;
      properties.feature_type = feature.feature_type ?? type;
      const level = levelOf(feature, type);
      if (level) {
        onLevels = true;
        properties.ordinal = level.ordinal;
        if (level.name !== null) properties.level_name = level.name;
        if (level.outdoor) properties.outdoor = true;
      }
      features.push({
        type: "Feature" as const,
        ...(feature.id !== undefined ? { id: feature.id } : {}),
        geometry: feature.geometry,
        properties,
      });
    }
    if (features.length === 0) continue;
    layers.push({ featureType: type, geojson: { type: "FeatureCollection", features }, onLevels });
  }

  const ordinals = [...levels.values()].map((level) => level.ordinal);
  const venue = collections.get("venue")?.[0];
  return {
    venueName: venue ? localizedText(venue.properties?.name, language) : null,
    language,
    layers,
    ordinalRange:
      ordinals.length > 0 ? { min: Math.min(...ordinals), max: Math.max(...ordinals) } : null,
  };
}

/** Largest uncompressed entry read from an archive (a whole airport fits well under it). */
const MAX_ENTRY_BYTES = 256 * 1024 * 1024;
/** Largest total read from one archive, so many large entries cannot exhaust memory. */
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;

/**
 * Read an IMDF zip archive in one pass.
 *
 * Only `.geojson` and `manifest.json` entries are decompressed, and macOS
 * resource-fork entries (`__MACOSX/`, `._name`) are skipped. An entry, or the
 * entries together, larger than the read limits is reported by name rather
 * than dropped, so a venue never loads with a floor silently missing. The
 * sizes come from the archive's own directory and can be understated, so the
 * filter is only a first cut. The checks after inflating bound the bytes kept,
 * not the peak memory: `unzipSync` inflates each selected entry in full first.
 * A hard memory bound would need a streaming reader.
 *
 * @param bytes - The zip file's bytes.
 * @returns The parsed archive, or `null` when the zip is not IMDF.
 * @throws ImdfArchiveError when an entry is too large or a feature file is not
 *   JSON; Error when the zip cannot be read.
 */
export function readImdfZip(bytes: Uint8Array): ImdfImport | null {
  const isEntry = (name: string) => {
    if (isMacOsZipMetadata(name)) return false;
    const lower = (name.split("/").pop() ?? "").toLowerCase();
    return lower === "manifest.json" || lower.endsWith(".geojson");
  };
  const names: string[] = [];
  const oversized: string[] = [];
  let total = 0;
  const entries = unzipSync(bytes, {
    filter: (file) => {
      names.push(file.name);
      if (!isEntry(file.name)) return false;
      if (file.originalSize > MAX_ENTRY_BYTES) {
        oversized.push(file.name);
        return false;
      }
      total += file.originalSize;
      return total <= MAX_TOTAL_BYTES;
    },
  });
  if (!isImdfArchiveEntries(names)) return null;
  if (oversized.length > 0) {
    throw new ImdfArchiveError(
      translate("addData.imdf.error.entryTooLarge", "{{file}} is larger than 256 MB", {
        file: oversized.join(", "),
      }),
    );
  }
  if (total > MAX_TOTAL_BYTES) {
    throw new ImdfArchiveError(
      translate("addData.imdf.error.tooLarge", "its GeoJSON files add up to more than 512 MB", {}),
    );
  }
  // The sizes above are the archive's own claims; check what was inflated too.
  let inflated = 0;
  for (const [name, data] of Object.entries(entries)) {
    if (data.byteLength > MAX_ENTRY_BYTES) {
      throw new ImdfArchiveError(
        translate("addData.imdf.error.entryTooLarge", "{{file}} is larger than 256 MB", {
          file: name,
        }),
      );
    }
    inflated += data.byteLength;
  }
  if (inflated > MAX_TOTAL_BYTES) {
    throw new ImdfArchiveError(
      translate("addData.imdf.error.tooLarge", "its GeoJSON files add up to more than 512 MB", {}),
    );
  }
  const files = new Map<string, string>();
  for (const name of Object.keys(entries)) files.set(name, strFromU8(entries[name]));
  return parseImdfArchive(files);
}

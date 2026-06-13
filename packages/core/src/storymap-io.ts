import { normalizeStoryMap } from "./project";
import { DEFAULT_STORY_MAP, type StoryMap } from "./types";

/**
 * Serialize a story map to pretty-printed JSON for export.
 *
 * @param storymap The story map to serialize.
 * @returns A JSON string (settings and chapters).
 */
export function serializeStoryMapJson(storymap: StoryMap): string {
  return JSON.stringify(storymap, null, 2);
}

/**
 * Parse a story map from JSON authored outside GeoLibre.
 *
 * Accepts either a bare story map object or a full `.geolibre.json` project with
 * a `storymap` field, then validates it through the same normalizer used when
 * loading projects.
 *
 * @param text JSON text to import.
 * @returns A normalized story map.
 * @throws If the JSON is invalid or contains no usable chapters.
 */
export function parseStoryMapJson(text: string): StoryMap {
  const data = JSON.parse(text) as unknown;
  const candidate =
    data && typeof data === "object" && "storymap" in (data as object)
      ? (data as { storymap: unknown }).storymap
      : data;
  const normalized = normalizeStoryMap(candidate);
  if (!normalized) {
    throw new Error("The imported story map has no chapters.");
  }
  return normalized;
}

// Flat, spreadsheet-friendly chapter columns. Layer opacity effects are stored
// as JSON in their own columns so the CSV round-trips, but hand-authors can
// simply leave them blank.
const CSV_HEADERS = [
  "id",
  "title",
  "description",
  "image",
  "alignment",
  "hidden",
  "lng",
  "lat",
  "zoom",
  "pitch",
  "bearing",
  "mapAnimation",
  "rotateAnimation",
  "onChapterEnter",
  "onChapterExit",
] as const;

/**
 * Serialize a story map's chapters to CSV (one row per chapter).
 *
 * Story-level settings are not represented in CSV; they are kept in the project
 * and preserved on CSV import.
 *
 * @param storymap The story map whose chapters to serialize.
 * @returns A CSV string with a header row.
 */
export function serializeStoryMapCsv(storymap: StoryMap): string {
  const rows = [CSV_HEADERS.join(",")];
  for (const c of storymap.chapters) {
    rows.push(
      [
        c.id,
        c.title,
        c.description,
        c.image ?? "",
        c.alignment,
        String(c.hidden),
        String(c.location.center[0]),
        String(c.location.center[1]),
        String(c.location.zoom),
        String(c.location.pitch),
        String(c.location.bearing),
        c.mapAnimation,
        String(c.rotateAnimation),
        JSON.stringify(c.onChapterEnter),
        JSON.stringify(c.onChapterExit),
      ]
        .map(csvEscape)
        .join(","),
    );
  }
  return rows.join("\n") + "\n";
}

/**
 * Parse chapters from a CSV authored outside GeoLibre.
 *
 * Columns are matched by header name (case-insensitive) so column order is
 * flexible; `lng`/`lat` set the chapter center. Story-level settings come from
 * `base` (the current story) since CSV only carries chapters; missing ids are
 * generated.
 *
 * @param text CSV text to import.
 * @param base Existing story map whose settings should be preserved.
 * @returns A normalized story map.
 * @throws If the CSV has no data rows or no valid chapters.
 */
export function parseStoryMapCsv(
  text: string,
  base?: StoryMap | null,
): StoryMap {
  const rows = parseCsvRows(text);
  if (rows.length < 2) {
    throw new Error("The CSV has no chapter rows.");
  }
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const col = (name: string) => header.indexOf(name.toLowerCase());

  const chapters = rows
    .slice(1)
    .filter((row) => row.some((cell) => cell.trim() !== ""))
    .map((row, index) => {
      const get = (name: string) => {
        const j = col(name);
        return j >= 0 ? (row[j] ?? "") : "";
      };
      const num = (name: string, fallback: number) => {
        const value = Number(get(name));
        return Number.isFinite(value) ? value : fallback;
      };
      const bool = (name: string) => /^(true|1|yes)$/i.test(get(name).trim());
      const jsonArray = (name: string) => {
        try {
          const parsed = JSON.parse(get(name) || "[]");
          return Array.isArray(parsed) ? parsed : [];
        } catch {
          return [];
        }
      };
      return {
        id: get("id").trim() || `chapter-${index + 1}`,
        title: get("title"),
        description: get("description"),
        image: get("image").trim() || undefined,
        alignment: get("alignment").trim() || "left",
        hidden: bool("hidden"),
        location: {
          center: [num("lng", 0), num("lat", 0)],
          zoom: num("zoom", 2),
          pitch: num("pitch", 0),
          bearing: num("bearing", 0),
        },
        mapAnimation: get("mapanimation").trim() || "flyTo",
        rotateAnimation: bool("rotateanimation"),
        onChapterEnter: jsonArray("onchapterenter"),
        onChapterExit: jsonArray("onchapterexit"),
      };
    });

  const normalized = normalizeStoryMap({
    ...(base ?? DEFAULT_STORY_MAP),
    chapters,
  });
  if (!normalized) {
    throw new Error("The CSV contained no valid chapters.");
  }
  return normalized;
}

/** Quote a CSV field when it contains a comma, quote, or newline. */
function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/** Parse CSV text into rows of fields, honoring quotes and escaped quotes. */
function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  // Normalize line endings so \r\n and \r behave like \n.
  const input = text.replace(/\r\n?/g, "\n");

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += ch;
    }
  }
  // Flush the final field/row unless the input ended with a trailing newline.
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

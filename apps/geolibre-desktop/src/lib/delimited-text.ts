import type { Feature, FeatureCollection, GeoJsonProperties, Geometry, Point } from "geojson";
import { isGeographicCrs } from "./crs-utils";

export interface DelimitedTextLayerResult {
  data: FeatureCollection;
  fields: string[];
  skippedRows: number;
  totalRows: number;
  /**
   * True when the layer was built as a non-spatial attribute table (both the
   * latitude and longitude fields were left blank), so every feature carries a
   * `null` geometry. Callers use this to skip fitting the map to empty bounds.
   */
  isTable: boolean;
}

/**
 * Thrown by {@link parseDelimitedTextLayer} when the chosen columns parse but no
 * row holds a valid WGS84 coordinate. Exported so callers can recognize this
 * specific failure without matching a duplicated literal string.
 */
export const NO_VALID_COORDINATES_MESSAGE =
  "No rows contained valid longitude and latitude values.";

/**
 * Thrown by {@link parseDelimitedTextLayer} when exactly one coordinate field is
 * left blank. Points need both a longitude and a latitude, and an attribute
 * table needs neither, so a half-specified pair is always a mistake. Exported so
 * callers can recognize this failure without matching a duplicated literal.
 */
export const MIXED_COORDINATE_FIELDS_MESSAGE =
  "Select both a longitude and a latitude field, or leave both as None to add an attribute table.";

export function parseDelimitedTextFields(text: string, delimiter: string): string[] {
  if (!delimiter) throw new Error("Enter a delimiter.");

  // Only the header is needed, so stop at the first non-blank row instead of
  // parsing the whole file; callers pass entire multi-hundred-MB files here.
  for (const row of iterateDelimitedRows(text, delimiter)) {
    if (!row.some((value) => value.trim())) continue;
    return uniqueFieldNames(row.map((field) => field.trim()));
  }

  throw new Error("The delimited text must include a header row.");
}

export function parseDelimitedTextLayer(
  text: string,
  options: {
    delimiter: string;
    latitudeField: string;
    longitudeField: string;
    /**
     * Source CRS of the coordinate columns as `AUTHORITY:CODE`, or blank for
     * WGS84 longitude/latitude. When a projected CRS is given, coordinates are
     * kept in their native units (skipping the lon/lat range check) so the
     * caller can reproject them to WGS84; see {@link isGeographicCrs}.
     */
    sourceCrs?: string;
  },
): DelimitedTextLayerResult {
  const delimiter = options.delimiter;
  if (!delimiter) throw new Error("Enter a delimiter.");
  // A projected source CRS carries coordinates in metres (or feet), which lie
  // far outside the WGS84 +/-180 / +/-90 range, so the geographic bounds check
  // below would reject every row. Skip it for projected CRSs and let the caller
  // reproject the raw coordinates to WGS84.
  const geographic = isGeographicCrs(options.sourceCrs);

  const body = readDelimitedTextBody(text, delimiter);
  if (!body) {
    throw new Error("The delimited text must include a header and data rows.");
  }
  const fields = body.fields;

  // When both coordinate fields are left blank the file is imported as a
  // non-spatial attribute table: every row becomes a feature with a null
  // geometry, so it can back the attribute table and be used as the join layer
  // in an attribute join without inventing coordinates.
  const wantsLatitude = options.latitudeField.trim() !== "";
  const wantsLongitude = options.longitudeField.trim() !== "";
  // A half-specified coordinate pair (one field chosen, the other left as
  // "None") can neither build points nor a table, so fail with a clear message
  // instead of falling through to a raw `field "" was not found` error.
  if (wantsLatitude !== wantsLongitude) {
    throw new Error(MIXED_COORDINATE_FIELDS_MESSAGE);
  }
  if (!wantsLatitude && !wantsLongitude) {
    const tableFeatures: Feature<Geometry | null, GeoJsonProperties>[] = [];
    for (const row of body.rows) {
      tableFeatures.push({
        type: "Feature",
        geometry: null,
        properties: buildRowProperties(fields, row),
      });
    }

    return {
      // GeoJSON Features may legally carry a null geometry; the app's layer
      // model treats these as a regular FeatureCollection (the map ignores
      // nulls), so the cast to FeatureCollection is safe here.
      data: {
        type: "FeatureCollection",
        features: tableFeatures,
      } as FeatureCollection,
      fields,
      skippedRows: 0,
      totalRows: tableFeatures.length,
      isTable: true,
    };
  }

  const latitudeIndex = findFieldIndex(fields, options.latitudeField);
  const longitudeIndex = findFieldIndex(fields, options.longitudeField);

  if (latitudeIndex < 0) {
    throw new Error(`Latitude field "${options.latitudeField}" was not found.`);
  }
  if (longitudeIndex < 0) {
    throw new Error(`Longitude field "${options.longitudeField}" was not found.`);
  }

  let skippedRows = 0;
  let totalRows = 0;
  const features: Feature<Point, GeoJsonProperties>[] = [];

  for (const row of body.rows) {
    totalRows += 1;
    // For a projected CRS, treat a bare comma as a thousands separator (large
    // easting/northing) rather than a decimal point.
    const latitude = parseCoordinate(row[latitudeIndex], { grouped: !geographic });
    const longitude = parseCoordinate(row[longitudeIndex], { grouped: !geographic });
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      skippedRows += 1;
      continue;
    }
    if (geographic && (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180)) {
      skippedRows += 1;
      continue;
    }

    features.push({
      type: "Feature",
      geometry: {
        type: "Point",
        coordinates: [longitude, latitude],
      },
      properties: buildRowProperties(fields, row),
    });
  }

  if (features.length === 0) {
    throw new Error(NO_VALID_COORDINATES_MESSAGE);
  }

  return {
    data: {
      type: "FeatureCollection",
      features,
    },
    fields,
    skippedRows,
    totalRows,
    isTable: false,
  };
}

/**
 * Parses delimited text into row objects keyed by the (de-duplicated) header
 * names. Unlike {@link parseDelimitedTextLayer}, this keeps every column as a
 * raw string and does not build GeoJSON, so callers (e.g. the Deck.gl Layer
 * builder) can map arbitrary columns to layer roles themselves.
 *
 * @param text - The delimited text, optionally starting with a BOM.
 * @param delimiter - The field delimiter, e.g. ",", "\t", or ";".
 * @returns The header names and one record per data row.
 */
export function parseDelimitedTextRows(
  text: string,
  delimiter: string,
): { fields: string[]; rows: Record<string, string>[] } {
  if (!delimiter) throw new Error("Enter a delimiter.");

  const body = readDelimitedTextBody(text, delimiter);
  if (!body) {
    throw new Error("The delimited text must include a header and data rows.");
  }

  const fields = body.fields;
  const rows: Record<string, string>[] = [];
  for (const row of body.rows) {
    const record: Record<string, string> = {};
    fields.forEach((field, index) => {
      record[field] = (row[index] ?? "").trim();
    });
    rows.push(record);
  }

  return { fields, rows };
}

/** The index the content starts at, skipping a leading BOM. */
function contentStart(text: string): number {
  return text.charCodeAt(0) === 0xfeff ? 1 : 0;
}

/**
 * Yields the rows of delimited text one at a time.
 *
 * Two properties matter for large files, and both are why this is written as a
 * generator over index arithmetic rather than the obvious string accumulation:
 *
 * - **Nothing is buffered.** Callers that build features row by row never hold
 *   the whole file as a `string[][]` alongside the features they derive from it.
 * - **Fields are slices of `text`, not characters appended one at a time.**
 *   `field += char` builds a cons-string chain roughly one node per character,
 *   so a 146 MB CSV of long free-text columns needed several GB of heap and
 *   crashed the renderer with an out-of-memory error (GeoLibre#1854). A field
 *   is only assembled from pieces when a quote actually interrupts it.
 *
 * A leading BOM is skipped by offset, so the source string is never copied.
 *
 * SYNC: `countDelimitedTextRows` re-implements this scanner's quoting,
 * escaping, and row rules without allocating. Any change to them has to land in
 * both; the differential tests in `tests/data-parsing.test.ts` are what catch
 * drift. Grep "SYNC:" to find the partner.
 *
 * @param text - The delimited text, optionally starting with a BOM.
 * @param delimiter - The field delimiter; may be more than one character.
 * @yields Each row's raw field values, in column order.
 */
function* iterateDelimitedRows(text: string, delimiter: string): Generator<string[]> {
  const start = contentStart(text);
  const delimiterHead = delimiter.charAt(0);
  const multiCharDelimiter = delimiter.length > 1;

  let row: string[] = [];
  // The field being read is `text.slice(fieldStart, index)`, unless a quote
  // interrupted it; then the earlier pieces are held in `segments` and
  // `segmentsLength` counts the characters already in them.
  let segments: string[] | null = null;
  let segmentsLength = 0;
  let fieldStart = start;
  let inQuotes = false;

  // `extra` appends a literal that is not present in `text` as-is, namely the
  // single `"` an escaped `""` pair stands for.
  const pushSegment = (end: number, extra?: string): void => {
    const parts = segments ?? (segments = []);
    parts.push(text.slice(fieldStart, end));
    segmentsLength += end - fieldStart;
    if (extra !== undefined) {
      parts.push(extra);
      segmentsLength += extra.length;
    }
  };

  const takeField = (end: number): string => {
    if (segments === null) return text.slice(fieldStart, end);
    pushSegment(end);
    const field = segments.join("");
    segments = null;
    segmentsLength = 0;
    return field;
  };

  let index = start;
  for (; index < text.length; index += 1) {
    const char = text[index];

    if (char === '"') {
      if (inQuotes && text[index + 1] === '"') {
        // An escaped quote inside a quoted field: keep one literal `"` and
        // resume the slice after the pair.
        pushSegment(index, '"');
        index += 1;
        fieldStart = index + 1;
      } else if (inQuotes || (segmentsLength === 0 && index === fieldStart)) {
        // Opens or closes a quoted field. The quote is not part of the value,
        // so the slice restarts after it. Quoting only opens while the field is
        // still empty; a quote further in is a literal character (below).
        pushSegment(index);
        fieldStart = index + 1;
        inQuotes = !inQuotes;
      }
      // A bare quote inside an unquoted field is literal, and already covered
      // by the slice in progress, so there is nothing to do.
      continue;
    }

    if (
      !inQuotes &&
      char === delimiterHead &&
      (!multiCharDelimiter || text.startsWith(delimiter, index))
    ) {
      row.push(takeField(index));
      index += delimiter.length - 1;
      fieldStart = index + 1;
      continue;
    }

    if (!inQuotes && (char === "\n" || char === "\r")) {
      row.push(takeField(index));
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      fieldStart = index + 1;
      yield row;
      row = [];
    }
  }

  // A final row with no trailing newline.
  if (segmentsLength > 0 || index > fieldStart || row.length > 0) {
    row.push(takeField(index));
    yield row;
  }
}

/**
 * A delimited file split into its header and its data rows, with blank rows
 * dropped. Returns `null` when the text has no header row or no data rows, so
 * each caller can raise its own error.
 *
 * `rows` is the live generator over the same underlying scan, not a factory that
 * restarts it: consuming it twice would split the rows between the consumers
 * rather than replay them. It is exposed as the generator itself so that
 * single-use contract is visible at every call site.
 */
interface DelimitedTextBody {
  fields: string[];
  rows: Generator<string[]>;
}

function readDelimitedTextBody(text: string, delimiter: string): DelimitedTextBody | null {
  const iterator = iterateDelimitedRows(text, delimiter)[Symbol.iterator]();
  const nextRow = (): string[] | null => {
    for (let next = iterator.next(); !next.done; next = iterator.next()) {
      if (next.value.some((value) => value.trim())) return next.value;
    }
    return null;
  };

  const headerRow = nextRow();
  const firstDataRow = headerRow ? nextRow() : null;
  if (!headerRow || !firstDataRow) return null;

  return {
    fields: uniqueFieldNames(headerRow.map((field) => field.trim())),
    rows: (function* () {
      yield firstDataRow;
      for (let row = nextRow(); row !== null; row = nextRow()) yield row;
    })(),
  };
}

/** Character codes the scanners compare against. */
const QUOTE_CODE = 34;
const LINE_FEED_CODE = 10;
const CARRIAGE_RETURN_CODE = 13;

/**
 * Whether a character is one `String.prototype.trim` would strip, which is what
 * decides whether a row counts as blank. ASCII is settled by code alone; only a
 * non-ASCII character needs the regex, whose set is exactly trim's.
 */
function isTrimmableCode(code: number, text: string, index: number): boolean {
  if (code === 32 || (code >= 9 && code <= 13)) return true;
  if (code < 127) return false;
  return /\s/.test(text[index]);
}

/**
 * Counts the data rows (header and blank rows excluded) without building any
 * features, so a caller can warn about an oversized import before paying for
 * the GeoJSON materialization. Quoting is respected, so a newline inside a
 * quoted field does not inflate the count.
 *
 * This mirrors {@link iterateDelimitedRows}' row rules, but deliberately does
 * not reuse it: it compares character codes and allocates nothing at all, where
 * the iterator allocates an array and a slice per field. That keeps the count
 * cheap enough to run on every guarded import rather than only on files past
 * some size, which is what lets the guard key on rows rather than on bytes.
 * The blank-row test stops as soon as a row is known to have content, so it
 * runs on a handful of characters per row rather than on all of them.
 *
 * SYNC: this duplicates `iterateDelimitedRows`' quoting, escaping, and row
 * rules on purpose, for the zero-allocation win. Any change to them has to land
 * in both. Grep "SYNC:" to find the partner.
 *
 * @param text - The delimited text, optionally starting with a BOM.
 * @param delimiter - The field delimiter.
 * @returns The number of data rows, or 0 when the delimiter is blank.
 */
export function countDelimitedTextRows(text: string, delimiter: string): number {
  if (!delimiter) return 0;
  const start = contentStart(text);
  const delimiterHead = delimiter.charCodeAt(0);
  const multiCharDelimiter = delimiter.length > 1;

  let rows = 0;
  let rowHasContent = false;
  // Counts the characters materialized into the current field, standing in for
  // the iterator's `field === ""` test that decides whether a quote opens.
  let fieldLength = 0;
  let inQuotes = false;

  for (let index = start; index < text.length; index += 1) {
    const code = text.charCodeAt(index);

    if (code === QUOTE_CODE) {
      if (inQuotes && text.charCodeAt(index + 1) === QUOTE_CODE) {
        fieldLength += 1;
        rowHasContent = true;
        index += 1;
      } else if (inQuotes || fieldLength === 0) {
        inQuotes = !inQuotes;
      } else {
        fieldLength += 1;
        rowHasContent = true;
      }
      continue;
    }

    if (
      !inQuotes &&
      code === delimiterHead &&
      (!multiCharDelimiter || text.startsWith(delimiter, index))
    ) {
      fieldLength = 0;
      index += delimiter.length - 1;
      continue;
    }

    if (!inQuotes && (code === LINE_FEED_CODE || code === CARRIAGE_RETURN_CODE)) {
      if (rowHasContent) rows += 1;
      rowHasContent = false;
      fieldLength = 0;
      if (code === CARRIAGE_RETURN_CODE && text.charCodeAt(index + 1) === LINE_FEED_CODE) {
        index += 1;
      }
      continue;
    }

    fieldLength += 1;
    if (!rowHasContent && !isTrimmableCode(code, text, index)) rowHasContent = true;
  }

  if (rowHasContent) rows += 1;
  // The first non-blank row is the header, not data.
  return rows > 0 ? rows - 1 : 0;
}

/**
 * Returns the header line of delimited text, skipping a leading BOM and any
 * blank lines before it. Slices rather than splitting, so reading the header of
 * a large file does not copy it.
 *
 * Leading blank lines are skipped because the row parsers drop blank rows and
 * treat the first non-blank one as the header; taking the first *physical* line
 * instead would report a file that merely starts with a newline as empty, and
 * would hand delimiter detection a blank line to guess from.
 *
 * A line ends at `\n`, `\r\n`, or a bare `\r`, the same three terminators
 * {@link iterateDelimitedRows} recognizes. A bare `\r` matters here: a file
 * written with classic-Mac endings has no `\n` at all, so looking only for that
 * would hand back the entire file as its "header".
 *
 * A newline inside a *quoted* header cell is not honored, and the header is cut
 * short at it. Honoring it is circular: whether a quote opens a quoted field
 * depends on where the field boundaries are, which depends on the delimiter,
 * which is what this line is read to detect. The consequence is contained;
 * see the note in `parseDelimitedTextFile`.
 *
 * @param text - The delimited text, optionally starting with a BOM.
 * @returns The header line without its terminator, or `""` when every line is
 *   blank.
 */
export function firstDelimitedTextLine(text: string): string {
  const bounds = headerLineBounds(text);
  return bounds ? text.slice(bounds.start, bounds.end) : "";
}

/**
 * Whether `text` holds a *complete* header line, meaning the first non-blank
 * line ends at a line break within `text` rather than running off its end.
 *
 * A caller that read only a prefix of a file uses this to tell "the header fits
 * in what I read" from "my prefix was cut mid-header". Merely testing the
 * prefix for a line break is not equivalent: leading blank lines contribute
 * line breaks of their own, so a header that overruns the prefix can still look
 * terminated.
 *
 * @param text - A prefix of a delimited file, optionally starting with a BOM.
 * @returns True when the header line's own terminator is present.
 */
export function hasCompleteHeaderLine(text: string): boolean {
  return headerLineBounds(text)?.terminated ?? false;
}

/** The first non-blank line's span, and whether its terminator was reached. */
interface HeaderLineBounds {
  start: number;
  end: number;
  terminated: boolean;
}

function headerLineBounds(text: string): HeaderLineBounds | null {
  let start = contentStart(text);
  while (start < text.length) {
    // Blankness is tracked during the same scan that finds the terminator, so
    // skipping past blank lines never slices, and neither does reaching the end
    // of a file that has no line break at all.
    let end = start;
    let hasContent = false;
    while (end < text.length) {
      const code = text.charCodeAt(end);
      if (code === LINE_FEED_CODE || code === CARRIAGE_RETURN_CODE) break;
      if (!hasContent && !isHeaderPadding(code, text, end)) hasContent = true;
      end += 1;
    }
    if (hasContent) return { start, end, terminated: end < text.length };
    if (end >= text.length) return null;
    start =
      text.charCodeAt(end) === CARRIAGE_RETURN_CODE && text.charCodeAt(end + 1) === LINE_FEED_CODE
        ? end + 2
        : end + 1;
  }
  return null;
}

/**
 * Builds a feature's properties object by pairing each (de-duplicated) header
 * name with its raw column value, defaulting to an empty string for short rows.
 * Shared by the point and attribute-table paths so their property shape cannot
 * drift apart.
 */
function buildRowProperties(fields: string[], row: string[]): GeoJsonProperties {
  const properties: GeoJsonProperties = {};
  fields.forEach((field, index) => {
    properties[field] = row[index] ?? "";
  });
  return properties;
}

function uniqueFieldNames(fields: string[]): string[] {
  const seen = new Set<string>();
  return fields.map((field, index) => {
    const baseName = field || `field_${index + 1}`;
    if (!seen.has(baseName)) {
      seen.add(baseName);
      return baseName;
    }
    let suffix = 2;
    let candidate = `${baseName}_${suffix}`;
    while (seen.has(candidate)) {
      suffix += 1;
      candidate = `${baseName}_${suffix}`;
    }
    seen.add(candidate);
    return candidate;
  });
}

function findFieldIndex(fields: string[], fieldName: string): number {
  const normalizedFieldName = fieldName.trim().toLowerCase();
  return fields.findIndex((field) => field.trim().toLowerCase() === normalizedFieldName);
}

/**
 * Parses a coordinate string to a number, accepting a comma as the decimal
 * separator in addition to a dot. Many locales (e.g. most of Europe) write
 * `4,35` for `4.35`, and JavaScript's `Number()` returns `NaN` for those, so
 * delimited files exported under such locales would otherwise drop every row.
 *
 * When both `,` and `.` appear, the right-most one is treated as the decimal
 * separator and the other as a thousands grouping separator (which is removed).
 * When only one appears, it is treated as the decimal separator (so `"1,234"`
 * parses to `1.234`); this is unambiguous for WGS84 coordinates, where a
 * thousands grouping never occurs within the valid +/-180 range.
 *
 * That last assumption breaks for **projected** coordinates: a UTM easting is
 * hundreds of thousands to millions of metres, exactly where thousands grouping
 * occurs, so `"659,319"` means `659319`, not `659.319`. Pass `grouped: true`
 * (the delimited-text importer sets it for a projected source CRS) so a bare
 * comma laid out as a thousands group (e.g. `659,319` or `1,234,567`, no decimal
 * point) is stripped rather than read as a decimal. A comma that is *not* a
 * valid thousands group (e.g. `659319,6`, a European decimal) still falls
 * through to the decimal heuristic, so both conventions round-trip correctly.
 *
 * **Known limitation:** a single-group value with <=3 integer digits, e.g.
 * `"45,123"`, is genuinely ambiguous from the string alone -- it could be the
 * thousands-grouped `45123` or the European decimal `45.123`. In `grouped` mode
 * it is read as `45123`. This is correct for the dominant projected cases
 * (UTM/State-Plane eastings/northings are 6-7 digits, well clear of this range)
 * but misreads a small-magnitude local/site grid coordinate written with a
 * decimal comma. There is no way to disambiguate without knowing the locale, so
 * the large-magnitude interpretation is chosen deliberately.
 *
 * @param value - The raw coordinate field (may include surrounding whitespace).
 * @param options - `grouped` marks the value as a projected coordinate, where a
 *   bare comma is a thousands separator rather than a decimal point.
 * @returns The parsed number, or `NaN` when the value is empty or unparsable.
 */
export function parseCoordinate(
  value: string | undefined,
  options?: { grouped?: boolean },
): number {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return Number.NaN;

  const lastComma = trimmed.lastIndexOf(",");
  const lastDot = trimmed.lastIndexOf(".");
  if (lastComma < 0 && lastDot < 0) return Number(trimmed);

  // A projected coordinate written with comma thousands separators and no
  // decimal point (`659,319`, `1,234,567`) is a whole number of metres; strip
  // the commas. Only a strict thousands layout qualifies, so a European decimal
  // like `659319,6` is left for the decimal heuristic below.
  if (options?.grouped && lastDot < 0 && /^-?\d{1,3}(,\d{3})+$/.test(trimmed)) {
    return Number(trimmed.replaceAll(",", ""));
  }

  const decimalSeparator = lastComma > lastDot ? "," : ".";
  const groupingSeparator = decimalSeparator === "," ? "." : ",";
  const normalized = trimmed.split(groupingSeparator).join("").replaceAll(decimalSeparator, ".");
  return Number(normalized);
}

/**
 * Header names that, case-insensitively, identify a longitude column when
 * auto-detecting coordinates. `"long"` is deliberately excluded here: it is a
 * common non-geographic column name (e.g. a length field), and a false match
 * would silently build wrong points. The Add Data dialog still offers it as a
 * manual option where the user confirms the column.
 */
export const LONGITUDE_FIELD_CANDIDATES = ["longitude", "lon", "lng", "x", "xcoord", "x_coord"];

/** Header names that, case-insensitively, identify a latitude column. */
export const LATITUDE_FIELD_CANDIDATES = ["latitude", "lat", "y", "ycoord", "y_coord"];

/** Delimiters tried, in order, when auto-detecting a delimited file's format. */
export const DELIMITER_CANDIDATES = [",", "\t", ";", "|"];

const DELIMITER_CANDIDATE_CODES = new Set(
  DELIMITER_CANDIDATES.map((delimiter) => delimiter.charCodeAt(0)),
);

/**
 * Whether a character can be ruled out as header *content*: whitespace, or a
 * character that could be the delimiter.
 *
 * The row parsers call a row blank when every field trims to nothing, which
 * makes a line of nothing but separators (`,,,`) a blank row. That test needs
 * the delimiter, which is not known while the header is being located, so
 * {@link headerLineBounds} instead rules out every *candidate* delimiter at
 * once: a line built only from those and whitespace has no content under any
 * delimiter this module would go on to pick, so skipping it is safe and keeps
 * the two notions of "blank" in agreement.
 */
function isHeaderPadding(code: number, text: string, index: number): boolean {
  return isTrimmableCode(code, text, index) || DELIMITER_CANDIDATE_CODES.has(code);
}

/**
 * Guesses the field delimiter of a delimited text file by parsing its header
 * row with each candidate delimiter and keeping the one that yields the most
 * columns. Quoting is respected, so a quoted field containing a delimiter does
 * not skew the guess.
 *
 * @param text - The delimited text, optionally starting with a BOM.
 * @returns The detected delimiter; defaults to a comma when none stands out.
 */
export function detectDelimitedTextDelimiter(text: string): string {
  const header = firstDelimitedTextLine(text);
  let best = ",";
  let bestCount = 0;
  for (const delimiter of DELIMITER_CANDIDATES) {
    try {
      const fields = parseDelimitedTextFields(header, delimiter).filter(
        (field) => field.trim().length > 0,
      );
      if (fields.length > bestCount) {
        bestCount = fields.length;
        best = delimiter;
      }
    } catch {
      // No usable header for this delimiter; try the next candidate.
    }
  }
  return best;
}

/**
 * Picks the longitude and latitude columns from a list of header names using
 * the well-known coordinate column names. Returns `null` when either cannot be
 * found, so callers can fall back to asking the user instead of guessing.
 *
 * @param fields - The header column names.
 * @returns The matched longitude/latitude field names, or `null`.
 */
export function detectCoordinateFields(
  fields: string[],
): { longitudeField: string; latitudeField: string } | null {
  // Match in candidate-priority order so a more specific name (e.g.
  // "longitude") wins over a generic one (e.g. "x") regardless of column order.
  const match = (candidates: string[]) => {
    for (const candidate of candidates) {
      const field = fields.find((f) => f.trim().toLowerCase() === candidate);
      if (field) return field;
    }
    return undefined;
  };
  const longitudeField = match(LONGITUDE_FIELD_CANDIDATES);
  const latitudeField = match(LATITUDE_FIELD_CANDIDATES);
  if (!longitudeField || !latitudeField) return null;
  return { longitudeField, latitudeField };
}

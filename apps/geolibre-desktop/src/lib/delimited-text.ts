import type { Feature, FeatureCollection, GeoJsonProperties, Geometry, Point } from "geojson";

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

  const rows = parseDelimitedRows(text, delimiter).filter((row) =>
    row.some((value) => value.trim()),
  );
  if (rows.length === 0) {
    throw new Error("The delimited text must include a header row.");
  }

  return uniqueFieldNames(rows[0].map((field) => field.trim()));
}

export function parseDelimitedTextLayer(
  text: string,
  options: {
    delimiter: string;
    latitudeField: string;
    longitudeField: string;
  },
): DelimitedTextLayerResult {
  const delimiter = options.delimiter;
  if (!delimiter) throw new Error("Enter a delimiter.");

  const rows = parseDelimitedRows(text, delimiter).filter((row) =>
    row.some((value) => value.trim()),
  );
  if (rows.length < 2) {
    throw new Error("The delimited text must include a header and data rows.");
  }

  const fields = uniqueFieldNames(rows[0].map((field) => field.trim()));

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
    const tableFeatures: Feature<Geometry | null, GeoJsonProperties>[] = rows
      .slice(1)
      .map((row) => ({
        type: "Feature",
        geometry: null,
        properties: buildRowProperties(fields, row),
      }));

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
      totalRows: rows.length - 1,
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
  const features: Feature<Point, GeoJsonProperties>[] = [];

  for (const row of rows.slice(1)) {
    const latitude = parseCoordinate(row[latitudeIndex]);
    const longitude = parseCoordinate(row[longitudeIndex]);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      skippedRows += 1;
      continue;
    }
    if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
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
    totalRows: rows.length - 1,
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

  const rawRows = parseDelimitedRows(text, delimiter).filter((row) =>
    row.some((value) => value.trim()),
  );
  if (rawRows.length < 2) {
    throw new Error("The delimited text must include a header and data rows.");
  }

  const fields = uniqueFieldNames(rawRows[0].map((field) => field.trim()));
  const rows = rawRows.slice(1).map((row) => {
    const record: Record<string, string> = {};
    fields.forEach((field, index) => {
      record[field] = (row[index] ?? "").trim();
    });
    return record;
  });

  return { fields, rows };
}

function parseDelimitedRows(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  const normalizedText = text.replace(/^\uFEFF/, "");

  for (let index = 0; index < normalizedText.length; index += 1) {
    const char = normalizedText[index];
    const next = normalizedText[index + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        field += '"';
        index += 1;
      } else if (inQuotes || field === "") {
        inQuotes = !inQuotes;
      } else {
        field += char;
      }
      continue;
    }

    if (!inQuotes && normalizedText.startsWith(delimiter, index)) {
      row.push(field);
      field = "";
      index += delimiter.length - 1;
      continue;
    }

    if (!inQuotes && (char === "\n" || char === "\r")) {
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
      if (char === "\r" && next === "\n") index += 1;
      continue;
    }

    field += char;
  }

  if (field || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
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
 * @param value - The raw coordinate field (may include surrounding whitespace).
 * @returns The parsed number, or `NaN` when the value is empty or unparsable.
 */
export function parseCoordinate(value: string | undefined): number {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return Number.NaN;

  const lastComma = trimmed.lastIndexOf(",");
  const lastDot = trimmed.lastIndexOf(".");
  if (lastComma < 0 && lastDot < 0) return Number(trimmed);

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
  const header = text.replace(/^\uFEFF/, "").split(/\r?\n/, 1)[0] ?? "";
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

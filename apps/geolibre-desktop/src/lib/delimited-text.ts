import type {
  Feature,
  FeatureCollection,
  GeoJsonProperties,
  Point,
} from "geojson";

export interface DelimitedTextLayerResult {
  data: FeatureCollection;
  fields: string[];
  skippedRows: number;
  totalRows: number;
}

export function parseDelimitedTextFields(
  text: string,
  delimiter: string,
): string[] {
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
  const latitudeIndex = findFieldIndex(fields, options.latitudeField);
  const longitudeIndex = findFieldIndex(fields, options.longitudeField);

  if (latitudeIndex < 0) {
    throw new Error(`Latitude field "${options.latitudeField}" was not found.`);
  }
  if (longitudeIndex < 0) {
    throw new Error(
      `Longitude field "${options.longitudeField}" was not found.`,
    );
  }

  let skippedRows = 0;
  const features: Feature<Point, GeoJsonProperties>[] = [];

  for (const row of rows.slice(1)) {
    const latitude = Number(row[latitudeIndex]);
    const longitude = Number(row[longitudeIndex]);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      skippedRows += 1;
      continue;
    }
    if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
      skippedRows += 1;
      continue;
    }

    const properties: GeoJsonProperties = {};
    fields.forEach((field, index) => {
      properties[field] = row[index] ?? "";
    });

    features.push({
      type: "Feature",
      geometry: {
        type: "Point",
        coordinates: [longitude, latitude],
      },
      properties,
    });
  }

  if (features.length === 0) {
    throw new Error("No rows contained valid longitude and latitude values.");
  }

  return {
    data: {
      type: "FeatureCollection",
      features,
    },
    fields,
    skippedRows,
    totalRows: rows.length - 1,
  };
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
  return fields.findIndex(
    (field) => field.trim().toLowerCase() === normalizedFieldName,
  );
}

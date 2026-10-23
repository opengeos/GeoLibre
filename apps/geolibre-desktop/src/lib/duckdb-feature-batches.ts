import type { Feature, FeatureCollection, Geometry } from "geojson";
import { rowsFromResult, type ArrowSchemaField } from "./arrow-decimal";
import { normalizePropertyValue } from "./duckdb-geometry";

// Turning a DuckDB result into GeoJSON features costs the main thread a
// `JSON.parse` of every row's `ST_AsGeoJSON` text plus the Arrow row decode and
// property normalization. Done as one `query()` → `toArray()` → `map()` pass it
// is a single task proportional to the whole file: ~0.7 s for 200k points,
// during which the UI cannot paint or take input (#2858).
//
// Reading the result as a stream of record batches instead splits that work
// into one task per batch: each `await` on the next batch is a round trip to the
// DuckDB worker, so the event loop runs between them. A batch that still takes
// longer than the budget below is additionally sliced, so the longest task is
// bounded by the budget rather than by whatever batch size DuckDB chose.

/** One record batch, or anything that reads like one (an Arrow table, a test double). */
export interface FeatureRowBatch {
  toArray: () => { toJSON?: () => Record<string, unknown>; [key: string]: unknown }[];
  schema?: { fields?: ReadonlyArray<ArrowSchemaField> };
}

/**
 * How long one slice of row conversion may run before yielding to the event
 * loop. Short enough to keep input responsive, long enough that the cost of
 * yielding stays a rounding error on the total.
 */
export const FEATURE_SLICE_BUDGET_MS = 12;

/** Resolve on a later task, so pending input, paint and messages can run. */
export function yieldToEventLoop(): Promise<void> {
  const scheduler = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (typeof scheduler?.yield === "function") return scheduler.yield();
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Build one GeoJSON feature from a DuckDB row that carries its geometry as
 * `ST_AsGeoJSON` text in `geometryJsonColumn`.
 *
 * The GeoJSON column, the source geometry column, and any other binary column
 * are dropped from the properties; every other value is normalized
 * (bigint → number or digit string, Date → ISO string).
 *
 * @param row A plain row object keyed by column name.
 * @param geometryJsonColumn The column holding the `ST_AsGeoJSON` text.
 * @param geometryColumn The source geometry column, excluded from properties.
 * @returns The feature, with a null geometry when the row's GeoJSON is NULL.
 */
export function rowToFeature(
  row: Record<string, unknown>,
  geometryJsonColumn: string,
  geometryColumn?: string,
): Feature<Geometry | null> {
  const rawGeometry = row[geometryJsonColumn];
  // ST_AsGeoJSON returns SQL NULL for rows with missing/NULL geometries.
  // GeoJSON Features may legally have a null geometry, so keep the row.
  const geometry = typeof rawGeometry === "string" ? (JSON.parse(rawGeometry) as Geometry) : null;
  const properties: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(row)) {
    if (key === geometryJsonColumn || key === geometryColumn || value instanceof Uint8Array) {
      continue;
    }
    properties[key] = normalizePropertyValue(value);
  }

  return { type: "Feature", geometry, properties };
}

/** Options for {@link featureCollectionFromBatches}. */
export interface FeatureBatchOptions {
  /** The column holding each row's `ST_AsGeoJSON` text. */
  geometryJsonColumn: string;
  /** The source geometry column, excluded from properties. */
  geometryColumn?: string;
  /** Per-slice time budget in ms; defaults to {@link FEATURE_SLICE_BUDGET_MS}. */
  sliceBudgetMs?: number;
  /** Clock override for tests. */
  now?: () => number;
  /** Yield override for tests. */
  yieldFn?: () => Promise<void>;
}

/**
 * Build a FeatureCollection from a stream of DuckDB record batches without
 * holding the main thread for the whole result.
 *
 * Each batch is decoded with {@link rowsFromResult} (so DECIMAL cells are
 * rescaled from that batch's schema) and converted row by row; whenever a slice
 * has run past the budget the conversion yields to the event loop before
 * continuing. The output is identical to converting the whole result in one
 * pass: same features, same order.
 *
 * @param batches The record batches, e.g. the reader from `connection.send()`.
 * @param options Which columns hold the geometry, plus test overrides.
 * @returns The assembled FeatureCollection.
 */
export async function featureCollectionFromBatches(
  batches: AsyncIterable<FeatureRowBatch> | Iterable<FeatureRowBatch>,
  options: FeatureBatchOptions,
): Promise<FeatureCollection<Geometry | null>> {
  const { geometryJsonColumn, geometryColumn } = options;
  const budget = options.sliceBudgetMs ?? FEATURE_SLICE_BUDGET_MS;
  const now = options.now ?? (() => performance.now());
  const yieldFn = options.yieldFn ?? yieldToEventLoop;
  const features: Feature<Geometry | null>[] = [];
  let sliceStart = now();

  for await (const batch of batches) {
    // Awaiting the next batch already let the event loop run.
    sliceStart = now();
    const rows = rowsFromResult(batch);
    for (const row of rows) {
      features.push(rowToFeature(row, geometryJsonColumn, geometryColumn));
      // Checked every 256 rows: a clock read per row would cost more than
      // the yields it schedules.
      if ((features.length & 0xff) === 0 && now() - sliceStart > budget) {
        await yieldFn();
        sliceStart = now();
      }
    }
  }

  return { type: "FeatureCollection", features };
}

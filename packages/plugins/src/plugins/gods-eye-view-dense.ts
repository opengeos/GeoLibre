import type { CesiumSceneHandle } from "@geolibre/map";
import type { Feature, Point } from "geojson";
import { eciToEcf, gstime, propagate, twoline2satrec, type SatRec } from "satellite.js";
import { fetchCelestrakTleText, parseTle } from "./gods-eye-view-feeds";

const DENSE_GROUP = "starlink";
const DENSE_CREATE_CHUNK = 1_500;
const DENSE_REFRESH_FRAMES = 300;

export type DenseCatalogStatus = "idle" | "loading" | "ready" | "failed";

export interface DenseCatalogSnapshot {
  status: DenseCatalogStatus;
  count: number;
  error: string | null;
}

interface DensePoint {
  position: unknown;
}

interface DensePointCollection {
  add(options: Record<string, unknown>): DensePoint;
}

interface DenseSatellite {
  satrec: SatRec;
  point: DensePoint;
}

interface DensePickRef {
  geolibreLayerId: string;
  index: number;
  primitive?: DensePoint;
}

type DenseAttributeFeature = Feature<
  Point,
  {
    name: string;
    catalogNumber: string;
    group: "starlink";
    inclinationDeg: number;
    orbitalPeriodMinutes: number;
  }
>;

/**
 * The optional 10K+ catalog from the reference app.
 *
 * These satellites deliberately bypass project layers and CZML. Serializing
 * thousands of time-sampled entities would make the project and Attribute
 * Table enormous; a single Cesium PointPrimitiveCollection is the cheap path
 * the upstream God's Eye View uses for its DENSE Starlink shell.
 */
/** Whether two catalogue-number sets hold the same satellites. */
function sameCatalog(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}

export class GodsEyeViewDenseCatalog {
  private globe: CesiumSceneHandle | null = null;
  /** The core catalogue this shell was filtered against, to spot a change. */
  private excluded: ReadonlySet<string> = new Set();
  private collection: DensePointCollection | null = null;
  private satellites: DenseSatellite[] = [];
  private features: DenseAttributeFeature[] = [];
  private descriptions: Array<{
    name: string;
    tleLine1: string;
    tleLine2: string;
    orbitalPeriodMinutes: number;
  }> = [];
  private cursor = 0;
  private removePreRender: (() => void) | null = null;
  private unregisterLayer: (() => void) | null = null;
  private request: AbortController | null = null;
  private generation = 0;
  private state: DenseCatalogSnapshot = {
    status: "idle",
    count: 0,
    error: null,
  };

  constructor(private readonly onChange: () => void = () => {}) {}

  snapshot(): DenseCatalogSnapshot {
    return { ...this.state };
  }

  /** Lightweight, one-row-per-point model consumed by the Attribute Table. */
  attributeFeatures(): DenseAttributeFeature[] {
    return [...this.features];
  }

  async enable(
    globe: CesiumSceneHandle,
    coreCatalogNumbers: ReadonlySet<string>,
    layerId = "gods-eye-view-dense-satellites",
  ): Promise<void> {
    if (
      this.globe?.viewer === globe.viewer &&
      // A refresh recomputes the core catalogue; when a satellite has entered
      // or left one of those groups the shell has to be filtered again, or it
      // doubles a core entity or drops one it should now be drawing.
      sameCatalog(this.excluded, coreCatalogNumbers) &&
      (this.state.status === "loading" || this.state.status === "ready")
    ) {
      this.globe = globe;
      return;
    }

    this.clearRuntime();
    this.globe = globe;
    this.excluded = new Set(coreCatalogNumbers);
    const generation = ++this.generation;
    const request = new AbortController();
    this.request = request;
    this.setState({ status: "loading", count: 0, error: null });

    try {
      const records = parseTle(
        await fetchCelestrakTleText(DENSE_GROUP, { signal: request.signal }),
      );
      if (generation !== this.generation || request.signal.aborted) return;

      const C = globe.Cesium;
      const collection = new C.PointPrimitiveCollection() as unknown as DensePointCollection;
      globe.scene.primitives.add(collection as never);
      this.collection = collection;
      const at = this.clockDate(globe);
      const color = C.Color.fromCssColorString("#54697f").withAlpha(0.9);

      for (let start = 0; start < records.length; start += DENSE_CREATE_CHUNK) {
        if (generation !== this.generation || request.signal.aborted) return;
        const end = Math.min(start + DENSE_CREATE_CHUNK, records.length);
        for (let index = start; index < end; index += 1) {
          const record = records[index];
          if (coreCatalogNumbers.has(record.catalogNumber)) continue;
          const satrec = twoline2satrec(record.line1, record.line2);
          if (satrec.error !== 0) continue;
          const position = this.position(globe, satrec, at);
          if (!position) continue;
          const featureIndex = this.features.length;
          const pickRef: DensePickRef = { geolibreLayerId: layerId, index: featureIndex };
          const point = collection.add({
            position,
            // Six visible pixels plus an outline are still cheap in a single
            // batch, but much easier to acquire while the clock is running.
            pixelSize: 6,
            color,
            outlineColor: C.Color.fromCssColorString("#d9e8f5").withAlpha(0.7),
            outlineWidth: 1,
            scaleByDistance: new C.NearFarScalar(1e6, 1.5, 2e7, 0.6),
            id: pickRef,
          });
          pickRef.primitive = point;
          const xyz = position as { x: number; y: number; z: number };
          const radius = Math.hypot(xyz.x, xyz.y, xyz.z);
          const orbitalPeriodMinutes = Number(
            (1_440 / record.meanMotionRevolutionsPerDay).toFixed(2),
          );
          this.features.push({
            type: "Feature",
            id: `celestrak-${record.catalogNumber}`,
            geometry: {
              type: "Point",
              coordinates: [
                (Math.atan2(xyz.y, xyz.x) * 180) / Math.PI,
                (Math.atan2(xyz.z, Math.hypot(xyz.x, xyz.y)) * 180) / Math.PI,
                Math.max(0, radius - 6_378_137),
              ],
            },
            properties: {
              name: record.name,
              catalogNumber: record.catalogNumber,
              group: "starlink",
              inclinationDeg: record.inclinationDeg,
              orbitalPeriodMinutes,
            },
          });
          this.descriptions.push({
            name: record.name,
            tleLine1: record.line1,
            tleLine2: record.line2,
            orbitalPeriodMinutes,
          });
          this.satellites.push({ satrec, point });
        }
        // Building and initially propagating 10K+ SGP4 records in one task
        // visibly freezes interaction. Upstream yields after every 1,500.
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }

      if (generation !== this.generation || request.signal.aborted) return;
      if (this.satellites.length === 0) throw new Error("feed returned no usable satellites");
      this.unregisterLayer = globe.registerMovingPointLayer(
        layerId,
        collection as never,
        this.descriptions,
      );
      this.removePreRender = globe.scene.preRender.addEventListener(() => this.updateChunk());
      this.setState({
        status: "ready",
        count: this.satellites.length,
        error: null,
      });
      globe.requestRender();
    } catch (error) {
      if (generation !== this.generation || request.signal.aborted) return;
      this.clearRuntime(false);
      const message = error instanceof Error ? error.message : "feed unavailable";
      console.warn("[God's Eye View] dense satellite catalog failed", error);
      this.setState({ status: "failed", count: 0, error: message });
    } finally {
      if (generation === this.generation) this.request = null;
    }
  }

  disable(): void {
    this.generation += 1;
    this.clearRuntime();
    this.excluded = new Set();
    this.setState({ status: "idle", count: 0, error: null });
  }

  private setState(state: DenseCatalogSnapshot): void {
    this.state = state;
    this.onChange();
  }

  private clearRuntime(abort = true): void {
    if (abort) this.request?.abort();
    this.request = null;
    this.removePreRender?.();
    this.removePreRender = null;
    this.unregisterLayer?.();
    this.unregisterLayer = null;
    if (this.collection && this.globe) {
      this.globe.scene.primitives.remove(this.collection as never);
    }
    this.collection = null;
    this.satellites = [];
    this.features = [];
    this.descriptions = [];
    this.cursor = 0;
    this.globe = null;
  }

  private clockDate(globe: CesiumSceneHandle): Date {
    try {
      return globe.Cesium.JulianDate.toDate(globe.clock.currentTime);
    } catch {
      return new Date();
    }
  }

  private position(globe: CesiumSceneHandle, satrec: SatRec, at: Date): unknown | null {
    const state = propagate(satrec, at);
    // satellite.js 6 returns null when SGP4 gives up on a decayed orbit, which
    // the falsy check catches on its own; its types still describe the older
    // `position: false` shape, so test that too rather than ever handing
    // `eciToEcf` something that is not a vector.
    if (!state?.position || typeof state.position === "boolean") return null;
    const position = eciToEcf(state.position, gstime(at));
    // satellite.js uses kilometres; Cesium fixed-frame Cartesian coordinates
    // use metres.
    return new globe.Cesium.Cartesian3(position.x * 1_000, position.y * 1_000, position.z * 1_000);
  }

  private updateChunk(): void {
    const globe = this.globe;
    if (!globe || this.satellites.length === 0) return;
    const count = Math.max(1, Math.ceil(this.satellites.length / DENSE_REFRESH_FRAMES));
    const at = this.clockDate(globe);
    for (let index = 0; index < count; index += 1) {
      if (this.cursor >= this.satellites.length) this.cursor = 0;
      const satellite = this.satellites[this.cursor++];
      const position = this.position(globe, satellite.satrec, at);
      if (position) satellite.point.position = position;
    }
  }
}

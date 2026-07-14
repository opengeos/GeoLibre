/**
 * Imagery providers for the Timelapse plugin.
 *
 * A provider supplies an ordered list of dated "frames" (one per year), each a
 * raster tile URL template the plugin turns into a pre-warmed MapLibre raster
 * layer. Providers with remote discovery (Google Earth Engine per-year
 * composites, Planetary Computer mosaic searches) can return a Promise from
 * {@link TimelapseProvider.listFrames}; the built-in EOX provider is static.
 * Register additional providers with {@link registerTimelapseProvider} — the
 * control only shows a provider picker when more than one is registered.
 */

/** One dated imagery frame (a year) a timelapse steps through. */
export interface TimelapseFrame {
  /** Stable frame id, unique within its provider (e.g. `s2cloudless-2016`). */
  id: string;
  /** Short label shown on the slider and burned into recordings (e.g. `2016`). */
  label: string;
  /** The frame's calendar year, used for ordering and project persistence. */
  year: number;
  /** Raster tile URL template with `{z}`/`{x}`/`{y}` placeholders. */
  tileUrlTemplate: string;
  /** Attribution HTML required by the imagery license. */
  attribution: string;
  minzoom?: number;
  maxzoom?: number;
  tileSize?: number;
  scheme?: "xyz" | "tms";
}

/** A source of annual imagery frames for the Timelapse plugin. */
export interface TimelapseProvider {
  id: string;
  /** Human-readable name shown in the control header (e.g. provider picker). */
  name: string;
  /**
   * One attribution string applied to every frame's map source. All frames of
   * a provider are live sources at once (the pre-warmed stack), so per-frame
   * strings would stack ten near-identical credits in MapLibre's attribution
   * control; a single shared string dedupes to one line. The per-frame
   * {@link TimelapseFrame.attribution} still carries the year-specific credit
   * for the control panel and recordings.
   */
  attribution: string;
  /** Ordered frames, oldest first. May be async for remote catalogs. */
  listFrames: () => TimelapseFrame[] | Promise<TimelapseFrame[]>;
}

export const EOX_S2CLOUDLESS_PROVIDER_ID = "eox-s2cloudless";

/**
 * The mosaic range starts at 2018: earlier EOX layers exist in the WMTS
 * capabilities but are unusable for a continuous timelapse — the unsuffixed
 * `s2cloudless_3857` layer is the 2016 mosaic, and `s2cloudless-2017_3857` is
 * published but serves blank placeholder tiles (~700 bytes) instead of
 * imagery, which would flash an empty year mid-animation.
 */
const EOX_FIRST_YEAR = 2018;
const EOX_LAST_YEAR = 2025;

/** The EOX WMTS layer identifier for a mosaic year (2017+ carry the suffix). */
function eoxLayerIdentifier(year: number): string {
  return `s2cloudless-${year}_3857`;
}

/**
 * EOX Sentinel-2 cloudless is CC BY 4.0, so every frame must credit EOX with
 * the mosaic's year. Kept per-frame (not one shared string) because the year
 * is part of the required credit. The app's Add Data sample uses the same
 * wording for its fixed 2025 layer (`EOX_S2CLOUDLESS_ATTRIBUTION` in
 * apps/geolibre-desktop/src/components/layout/add-data/constants.ts).
 */
function eoxAttribution(year: number): string {
  return (
    `Sentinel-2 cloudless ${year} by ` +
    '<a href="https://s2maps.eu" target="_blank" rel="noreferrer">EOX IT Services GmbH</a> ' +
    `(contains modified Copernicus Sentinel data ${year})`
  );
}

/**
 * EOX Sentinel-2 cloudless annual mosaics (2018–2025) — global, keyless,
 * CC BY 4.0. Sentinel-2's native 10 m resolution tops out around zoom 14, so
 * the source maxzoom is capped at 15 and MapLibre overzooms beyond it, which
 * keeps the pre-warmed 10-source stack from fetching needless deep tiles.
 */
export const eoxS2CloudlessProvider: TimelapseProvider = {
  id: EOX_S2CLOUDLESS_PROVIDER_ID,
  name: "Sentinel-2 cloudless (EOX)",
  attribution:
    `Sentinel-2 cloudless ${EOX_FIRST_YEAR}–${EOX_LAST_YEAR} by ` +
    '<a href="https://s2maps.eu" target="_blank" rel="noreferrer">EOX IT Services GmbH</a> ' +
    "(contains modified Copernicus Sentinel data)",
  listFrames: () => {
    const frames: TimelapseFrame[] = [];
    for (let year = EOX_FIRST_YEAR; year <= EOX_LAST_YEAR; year += 1) {
      frames.push({
        id: `s2cloudless-${year}`,
        label: String(year),
        year,
        tileUrlTemplate: `https://tiles.maps.eox.at/wmts/1.0.0/${eoxLayerIdentifier(year)}/default/g/{z}/{y}/{x}.jpg`,
        attribution: eoxAttribution(year),
        maxzoom: 15,
        tileSize: 256,
      });
    }
    return frames;
  },
};

const providers = new Map<string, TimelapseProvider>([
  [eoxS2CloudlessProvider.id, eoxS2CloudlessProvider],
]);

/**
 * Register (or replace) a timelapse imagery provider. The extension point for
 * Earth Engine / Planetary Computer providers.
 */
export function registerTimelapseProvider(provider: TimelapseProvider): void {
  providers.set(provider.id, provider);
}

/**
 * Look up a provider by id, falling back to the built-in EOX provider so a
 * project saved with a provider that is no longer registered still opens.
 */
export function getTimelapseProvider(id?: string): TimelapseProvider {
  return (id && providers.get(id)) || eoxS2CloudlessProvider;
}

/** All registered providers, in registration order. */
export function listTimelapseProviders(): TimelapseProvider[] {
  return [...providers.values()];
}

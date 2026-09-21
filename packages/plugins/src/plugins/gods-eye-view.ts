import { createCzmlLayer, useAppStore } from "@geolibre/core";
import type { CesiumSceneHandle } from "@geolibre/map";
import type { GeoLibreAppAPI, GeoLibrePlugin } from "../types";
import {
  czmlPacketsToAttributeGeoJson,
  CELESTRAK_CORE_SAMPLE_STEP_SECONDS,
  fetchCelestrakSatelliteCatalogCzml,
  fetchUsgsEarthquakeCzml,
  type CzmlTimeWindow,
} from "./gods-eye-view-feeds";
import {
  fetchDamsCzml,
  fetchDatacentersCzml,
  fetchOsmInfrastructureCzml,
  fetchRadioBrowserCzml,
  fetchSubmarineCablesCzml,
  type GodsEyeViewFeedPayload,
} from "./gods-eye-view-catalog-feeds";
import { GodsEyeViewDenseCatalog } from "./gods-eye-view-dense";
import { fetchBikeShareCzml, fetchSpaceMissionsCzml } from "./gods-eye-view-global-feeds";
import {
  ALPR_MAX_VIEW_SPAN_DEGREES,
  ALPR_QUERY_SNAP_DEGREES,
  fetchMappedAlprCzml,
  fetchStreetTrafficCzml,
  TRAFFIC_MAX_VIEW_SPAN_DEGREES,
  TRAFFIC_QUERY_SNAP_DEGREES,
  viewportBoundsKey,
} from "./gods-eye-view-viewport-feeds";
import { OVERPASS_REQUEST_TIMEOUT_MS } from "./osm-downloader-api";
import { fetchMilitaryFlightsCzml, fetchOpenSkyCzml } from "./gods-eye-view-aircraft-feeds";

export const GODS_EYE_VIEW_PLUGIN_ID = "gods-eye-view";
export const GODS_EYE_VIEW_EARTHQUAKES_FLAG = "godsEyeViewEarthquakes";
export const GODS_EYE_VIEW_SATELLITES_FLAG = "godsEyeViewSatellites";
export const GODS_EYE_VIEW_DENSE_SATELLITES_FLAG = "godsEyeViewDenseSatellites";
export const GODS_EYE_VIEW_RADIO_FLAG = "godsEyeViewRadio";
export const GODS_EYE_VIEW_DATACENTERS_FLAG = "godsEyeViewDatacenters";
export const GODS_EYE_VIEW_DAMS_FLAG = "godsEyeViewDams";
export const GODS_EYE_VIEW_CABLES_FLAG = "godsEyeViewCables";
export const GODS_EYE_VIEW_OSM_INFRASTRUCTURE_FLAG = "godsEyeViewOsmInfrastructure";
export const GODS_EYE_VIEW_BIKE_SHARE_FLAG = "godsEyeViewBikeShare";
export const GODS_EYE_VIEW_SPACE_MISSIONS_FLAG = "godsEyeViewSpaceMissions";
export const GODS_EYE_VIEW_STREET_TRAFFIC_FLAG = "godsEyeViewStreetTraffic";
export const GODS_EYE_VIEW_MAPPED_ALPR_FLAG = "godsEyeViewMappedAlpr";
export const GODS_EYE_VIEW_FLIGHTS_FLAG = "godsEyeViewFlights";
export const GODS_EYE_VIEW_MILITARY_FLIGHTS_FLAG = "godsEyeViewMilitaryFlights";

// The aircraft feeds refresh every 15–30 seconds. Individual descriptors still
// decide whether they are due, so this inexpensive scheduler does not increase
// the cadence of the slower catalogs.
const REFRESH_TICK_MS = 5_000;
const VIEWPORT_REFRESH_DEBOUNCE_MS = 400;
const ARC_DURATION_MS = 3 * 60 * 60_000;

const FEED_GROUPS = ["movement", "cameras", "infrastructure", "events", "utilities"] as const;
type FeedGroup = (typeof FEED_GROUPS)[number];

interface FeedFetchContext {
  signal: AbortSignal;
  window: CzmlTimeWindow;
  bounds: [number, number, number, number] | null;
}

interface FeedDescriptor {
  group: FeedGroup;
  label: readonly [key: string, fallback: string];
  attribution: string;
  refreshIntervalMs: number;
  timeoutMs: number;
  flag: string;
  defaultEnabled: boolean;
  ownsClockWindow?: boolean;
  viewportKey?: (bounds: FeedFetchContext["bounds"]) => string;
  fetch: (context: FeedFetchContext) => Promise<GodsEyeViewFeedPayload>;
}

/**
 * The complete contract for every feed.
 *
 * Keeping registration, presentation, persistence and dispatch together makes
 * adding a feed one typed object instead of edits to parallel records. In
 * particular, there is no catch-all branch that can silently send a new feed
 * through the OSM infrastructure loader.
 */
const FEED_DESCRIPTORS = {
  flights: {
    group: "movement",
    label: ["panel.godsEyeView.flights", "Live Flights"],
    attribution: "Live flights: © OpenSky Network; aircraft details: ADSBDB",
    refreshIntervalMs: 30_000,
    timeoutMs: 20_000,
    flag: GODS_EYE_VIEW_FLIGHTS_FLAG,
    defaultEnabled: false,
    fetch: ({ signal, window, bounds }) => fetchOpenSkyCzml(window, { signal, bounds }),
  },
  militaryFlights: {
    group: "movement",
    label: ["panel.godsEyeView.militaryFlights", "Military Flights"],
    attribution: "Military flights: adsb.lol, ODbL; aircraft details: ADSBDB",
    refreshIntervalMs: 15_000,
    timeoutMs: 20_000,
    flag: GODS_EYE_VIEW_MILITARY_FLIGHTS_FLAG,
    defaultEnabled: false,
    fetch: ({ signal, window, bounds }) => fetchMilitaryFlightsCzml(window, { signal, bounds }),
  },
  satellites: {
    group: "movement",
    label: ["panel.godsEyeView.satellites", "Satellites"],
    attribution: "Satellites: CelesTrak (celestrak.org), Dr. T.S. Kelso",
    // CelesTrak asks clients not to retrieve the same data more often than every
    // two hours. Six catalog requests every ten minutes would be needlessly rude.
    refreshIntervalMs: 2 * 60 * 60_000,
    timeoutMs: 20_000,
    flag: GODS_EYE_VIEW_SATELLITES_FLAG,
    defaultEnabled: true,
    ownsClockWindow: true,
    async fetch({ signal, window }) {
      const packets = await fetchCelestrakSatelliteCatalogCzml({
        ...window,
        signal,
        // Five-minute samples interpolate smoothly while keeping the core
        // CZML layer below autosave's 10 MiB snapshot limit. A selected orbit
        // still uses the full TLE with SGP4, independent of this.
        stepSeconds: CELESTRAK_CORE_SAMPLE_STEP_SECONDS,
        maxSatellites: 2_000,
      });
      return { packets, attributes: czmlPacketsToAttributeGeoJson(packets) };
    },
  },
  bikeShare: {
    group: "movement",
    label: ["panel.godsEyeView.bikeShare", "Bike Share"],
    attribution: "Bike share: GBFS feeds from participating public systems",
    refreshIntervalMs: 5 * 60_000,
    timeoutMs: 60_000,
    flag: GODS_EYE_VIEW_BIKE_SHARE_FLAG,
    defaultEnabled: false,
    fetch: ({ signal }) => fetchBikeShareCzml({ signal }),
  },
  streetTraffic: {
    group: "movement",
    label: ["panel.godsEyeView.streetTraffic", "Simulated Street Traffic"],
    attribution: "Simulated vehicle positions on © OpenStreetMap contributors, ODbL 1.0",
    refreshIntervalMs: 2 * 60 * 60_000,
    timeoutMs: OVERPASS_REQUEST_TIMEOUT_MS,
    flag: GODS_EYE_VIEW_STREET_TRAFFIC_FLAG,
    defaultEnabled: false,
    viewportKey: (bounds) =>
      viewportBoundsKey(bounds, TRAFFIC_MAX_VIEW_SPAN_DEGREES, TRAFFIC_QUERY_SNAP_DEGREES),
    fetch: ({ bounds, signal, window }) => fetchStreetTrafficCzml(bounds, window, { signal }),
  },
  osmInfrastructure: {
    group: "infrastructure",
    label: ["panel.godsEyeView.osmInfrastructure", "OSM Infrastructure"],
    attribution: "OSM infrastructure: © OpenStreetMap contributors, ODbL 1.0",
    refreshIntervalMs: 60 * 60_000,
    // Overpass gets the same longer budget as the shared OSM downloader.
    timeoutMs: OVERPASS_REQUEST_TIMEOUT_MS,
    flag: GODS_EYE_VIEW_OSM_INFRASTRUCTURE_FLAG,
    defaultEnabled: false,
    fetch: ({ bounds, signal }) => fetchOsmInfrastructureCzml(bounds, { signal }),
  },
  datacenters: {
    group: "infrastructure",
    label: ["panel.godsEyeView.datacenters", "Datacenters"],
    attribution: "Datacenters: © OpenStreetMap contributors, ODbL 1.0",
    refreshIntervalMs: 24 * 60 * 60_000,
    timeoutMs: 60_000,
    flag: GODS_EYE_VIEW_DATACENTERS_FLAG,
    defaultEnabled: false,
    fetch: ({ signal }) => fetchDatacentersCzml({ signal }),
  },
  cables: {
    group: "infrastructure",
    label: ["panel.godsEyeView.cables", "Submarine Cables"],
    attribution: "Submarine cables: © TeleGeography, submarinecablemap.com, CC BY-NC-SA 3.0",
    refreshIntervalMs: 24 * 60 * 60_000,
    timeoutMs: 60_000,
    flag: GODS_EYE_VIEW_CABLES_FLAG,
    defaultEnabled: false,
    fetch: ({ signal }) => fetchSubmarineCablesCzml({ signal }),
  },
  dams: {
    group: "infrastructure",
    label: ["panel.godsEyeView.dams", "Dams"],
    attribution: "Dams: © OpenStreetMap contributors, ODbL 1.0; Open Infrastructure Map",
    refreshIntervalMs: 24 * 60 * 60_000,
    timeoutMs: 60_000,
    flag: GODS_EYE_VIEW_DAMS_FLAG,
    defaultEnabled: false,
    fetch: ({ signal }) => fetchDamsCzml({ signal }),
  },
  earthquakes: {
    group: "events",
    label: ["panel.godsEyeView.earthquakes", "Earthquakes"],
    attribution: "Earthquakes: Data courtesy of the U.S. Geological Survey",
    refreshIntervalMs: 10 * 60_000,
    timeoutMs: 20_000,
    flag: GODS_EYE_VIEW_EARTHQUAKES_FLAG,
    defaultEnabled: true,
    ownsClockWindow: true,
    async fetch({ signal, window }) {
      const packets = await fetchUsgsEarthquakeCzml(window, { signal });
      return { packets, attributes: czmlPacketsToAttributeGeoJson(packets) };
    },
  },
  spaceMissions: {
    group: "events",
    label: ["panel.godsEyeView.spaceMissions", "Space Missions (30d)"],
    attribution: "Space missions: Launch Library 2, The Space Devs",
    refreshIntervalMs: 15 * 60_000,
    timeoutMs: 30_000,
    flag: GODS_EYE_VIEW_SPACE_MISSIONS_FLAG,
    defaultEnabled: false,
    fetch: ({ signal }) => fetchSpaceMissionsCzml({ signal }),
  },
  mappedAlpr: {
    group: "cameras",
    label: ["panel.godsEyeView.mappedAlpr", "Mapped ALPR Cameras"],
    attribution: "Mapped ALPR cameras: © OpenStreetMap contributors, ODbL 1.0",
    refreshIntervalMs: 60 * 60_000,
    timeoutMs: OVERPASS_REQUEST_TIMEOUT_MS,
    flag: GODS_EYE_VIEW_MAPPED_ALPR_FLAG,
    defaultEnabled: false,
    viewportKey: (bounds) =>
      viewportBoundsKey(bounds, ALPR_MAX_VIEW_SPAN_DEGREES, ALPR_QUERY_SNAP_DEGREES),
    fetch: ({ bounds, signal }) => fetchMappedAlprCzml(bounds, { signal }),
  },
  radio: {
    group: "utilities",
    label: ["panel.godsEyeView.radio", "Radio Stations"],
    attribution: "Radio stations: Radio Browser (radio-browser.info), public domain",
    refreshIntervalMs: 60 * 60_000,
    timeoutMs: 20_000,
    flag: GODS_EYE_VIEW_RADIO_FLAG,
    defaultEnabled: false,
    fetch: ({ signal }) => fetchRadioBrowserCzml({ signal }),
  },
} as const satisfies Record<string, FeedDescriptor>;

type FeedId = keyof typeof FEED_DESCRIPTORS;
const FEED_IDS = Object.keys(FEED_DESCRIPTORS) as FeedId[];

/**
 * Simulated seconds per real second, offered in the panel.
 *
 * The globe runs at real time by default: that is what the orbits and the
 * quake timeline actually do, and a satellite that crosses the pane in seconds
 * reads as an animation rather than as where the thing is right now. The
 * faster steps are for watching a whole orbit without waiting for one.
 */
const SPEED_OPTIONS = [1, 10, 60, 600] as const;
const DEFAULT_SPEED = 1;

/** What a project persists: the feed toggles and the clock speed. */
type GodsEyeViewProjectState = Record<FeedId, boolean> & {
  /** Add the current Starlink shell as lightweight points. */
  dense: boolean;
  /** One of {@link SPEED_OPTIONS}. */
  speed: number;
};

interface FeedState {
  enabled: boolean;
  loading: boolean;
  lastUpdated: Date | null;
  failed: boolean;
  layerId: string | null;
  request: AbortController | null;
  generation: number;
  lastViewportKey: string | null;
  requestedViewportKey: string | null;
}

const feeds = Object.fromEntries(
  FEED_IDS.map((feed) => [
    feed,
    {
      enabled: FEED_DESCRIPTORS[feed].defaultEnabled,
      loading: false,
      lastUpdated: null,
      failed: false,
      layerId: null,
      request: null,
      generation: 0,
      lastViewportKey: null,
      requestedViewportKey: null,
    },
  ]),
) as Record<FeedId, FeedState>;

/**
 * The feed toggles as the project holds them, kept separately from
 * `feeds[*].enabled` so `deactivate` (which switches every feed off to stop its
 * refresh) cannot overwrite what a later save should persist.
 */
let savedState: GodsEyeViewProjectState = {
  ...Object.fromEntries(FEED_IDS.map((feed) => [feed, FEED_DESCRIPTORS[feed].defaultEnabled])),
  dense: false,
  speed: DEFAULT_SPEED,
} as GodsEyeViewProjectState;

let appRef: GeoLibreAppAPI | null = null;
let cesiumRef: CesiumSceneHandle | null = null;
let unregisterPanel: (() => void) | null = null;
let unsubscribeLocale: (() => void) | null = null;
let refreshTimer: ReturnType<typeof setInterval> | null = null;
let viewportRefreshTimer: ReturnType<typeof setTimeout> | null = null;
let removeViewportListener: (() => void) | null = null;
let panelContainer: HTMLElement | null = null;
let savedClockAnimating: boolean | null = null;
let savedClockMultiplier: number | null = null;
const denseCatalog = new GodsEyeViewDenseCatalog(() => {
  // Match upstream: a failed load falls back to core mode, so selecting the
  // error chip means retry rather than first having to switch it off.
  if (denseCatalog.snapshot().status === "failed") {
    savedState = { ...savedState, dense: false };
    removeDenseLayer();
  } else if (denseCatalog.snapshot().status === "ready") {
    syncDenseLayerRows();
  }
  renderPanel();
});

function translate(
  key: string,
  fallback: string,
  params?: Record<string, string | number>,
): string {
  return appRef?.translate?.(key, fallback, params) ?? fallback;
}

function feedFlag(feed: FeedId): string {
  return FEED_DESCRIPTORS[feed].flag;
}

function feedName(feed: FeedId): string {
  const [key, fallback] = FEED_DESCRIPTORS[feed].label;
  return translate(key, fallback);
}

function timeWindow(): CzmlTimeWindow {
  const start = new Date();
  return {
    start,
    stop: new Date(start.getTime() + ARC_DURATION_MS),
    current: start,
    multiplier: savedState.speed,
  };
}

/**
 * Keep the globe's clock on the window the feeds just fetched.
 *
 * `electCzmlClockOwner` writes a document's clock only when the *owning layer*
 * changes, which is right for a static document but leaves a refreshing feed on
 * the first window it ever fetched: `upsertLayer` reuses the layer id, so no
 * later document is ever read. With `LOOP_STOP` the clock then rewinds to a
 * three-hour-old start and loops there, while each refresh anchors its
 * entities to the real now — at 600x that happens every eighteen seconds. The
 * refresh owns the window, so the refresh moves it.
 */
function applyFeedClockWindow(window: CzmlTimeWindow): void {
  if (!cesiumRef) return;
  const { Cesium: C, clock } = cesiumRef;
  const start = C.JulianDate.fromDate(window.start);
  const stop = C.JulianDate.fromDate(window.stop);
  clock.startTime = start;
  clock.stopTime = stop;
  // Reclaim the instant only when the old one fell outside the new window.
  // Inside it, the user or the Time Slider may have put it there on purpose.
  if (
    C.JulianDate.lessThan(clock.currentTime, start) ||
    C.JulianDate.greaterThan(clock.currentTime, stop)
  ) {
    clock.currentTime = C.JulianDate.fromDate(window.current ?? window.start);
  }
}

function ownedLayer(feed: FeedId) {
  return useAppStore.getState().layers.find((layer) => layer.metadata?.[feedFlag(feed)] === true);
}

function coreSatelliteCatalogNumbers(): Set<string> {
  const layer = ownedLayer("satellites");
  return new Set(
    (layer?.geojson?.features ?? []).flatMap((feature) => {
      const id = String(feature.id ?? "");
      return id.startsWith("celestrak-") ? [id.slice("celestrak-".length)] : [];
    }),
  );
}

function ownedDenseLayer() {
  return useAppStore
    .getState()
    .layers.find((layer) => layer.metadata?.[GODS_EYE_VIEW_DENSE_SATELLITES_FLAG] === true);
}

/** Keep the 10K+ table rows separate from the sampled core-satellite layer. */
function ensureDenseLayer() {
  const existing = ownedDenseLayer();
  if (existing) return existing;
  const layer = createCzmlLayer({
    name: translate("panel.godsEyeView.denseSatellites", "Dense Satellites (Starlink)"),
    data: [{ id: "document", version: "1.0" }],
  });
  layer.geojson = { type: "FeatureCollection", features: [] };
  layer.popup = { ...layer.popup, hover: true };
  layer.metadata = {
    ...layer.metadata,
    [GODS_EYE_VIEW_DENSE_SATELLITES_FLAG]: true,
    godsEyeViewFeed: "dense-satellites",
    // These rows are rebuilt from CelesTrak whenever the plugin starts. They
    // belong in the live table, not in every autosave snapshot.
    transientGeojson: true,
  };
  useAppStore.getState().addLayer(layer);
  return layer;
}

function syncDenseLayerRows(): void {
  const layer = ownedDenseLayer();
  if (!layer) return;
  useAppStore.getState().updateLayer(layer.id, {
    geojson: {
      type: "FeatureCollection",
      features: denseCatalog.attributeFeatures(),
    },
  });
}

function removeDenseLayer(): void {
  const layer = ownedDenseLayer();
  if (layer) useAppStore.getState().removeLayer(layer.id);
}

function disableDenseCatalog(): void {
  denseCatalog.disable();
  removeDenseLayer();
}

function syncDenseCatalog(): void {
  if (!savedState.dense || !feeds.satellites.enabled || !cesiumRef) {
    disableDenseCatalog();
    return;
  }
  // Wait for the core catalog so its entries keep their richer CZML entities
  // and are not duplicated by points from the Starlink group.
  if (!ownedLayer("satellites")) return;
  const layer = ensureDenseLayer();
  void denseCatalog.enable(cesiumRef, coreSatelliteCatalogNumbers(), layer.id);
}

function upsertLayer(feed: FeedId, payload: GodsEyeViewFeedPayload, updatedAt: Date): void {
  const store = useAppStore.getState();
  // Fall through to the flag search when the remembered id misses: a project
  // switch replaces `store.layers` wholesale while the plugin stays active, and
  // adopting the new project's own feed layer beats adding a duplicate beside it.
  const existing =
    (feeds[feed].layerId
      ? store.layers.find((layer) => layer.id === feeds[feed].layerId)
      : undefined) ?? ownedLayer(feed);
  const layer = createCzmlLayer({
    id: existing?.id,
    name: feedName(feed),
    data: payload.packets,
    attribution: FEED_DESCRIPTORS[feed].attribution,
  });
  // The renderer consumes CZML, while the existing Attribute Table consumes a
  // complete GeoJSON row model. Moving entities have no single geometry, but
  // their packet ids and properties still form a useful, queryable table.
  layer.geojson = payload.attributes;
  // Only the ISS carries a standing label, so hovering is how every other
  // satellite (and every quake) says what it is without a click.
  layer.popup = { ...layer.popup, hover: true };
  layer.metadata = {
    ...layer.metadata,
    [feedFlag(feed)]: true,
    godsEyeViewFeed: feed,
    updatedAt: updatedAt.toISOString(),
    // The rows are rebuilt from the feed on activation, as the dense shell's
    // are. Embedding a whole catalogue's worth in every autosave would persist
    // positions that are stale by the next refresh and push the snapshot
    // towards its size ceiling.
    transientGeojson: true,
    transientCzml: true,
  };
  if (existing) {
    // Patch only what the feed owns. `visible`, `opacity` and `style` belong to
    // the user once the layer exists, so a ten-minute refresh must not un-hide a
    // layer they turned off or undo a restyle — same contract as the Esri
    // Wayback plugin's store upsert.
    store.updateLayer(existing.id, {
      name: layer.name,
      source: layer.source,
      metadata: layer.metadata,
      geojson: layer.geojson,
    });
    feeds[feed].layerId = existing.id;
  } else {
    store.addLayer(layer);
    feeds[feed].layerId = layer.id;
  }
  cesiumRef?.requestRender();
}

async function refreshFeed(feed: FeedId, force = true): Promise<void> {
  const state = feeds[feed];
  if (!state.enabled || !cesiumRef) return;
  // A scheduler tick must not abort and restart a slow in-flight request. User
  // actions still call with `force=true`, so explicit refresh/toggle behavior
  // retains the existing supersession semantics.
  if (!force && state.loading) return;
  const descriptor: FeedDescriptor = FEED_DESCRIPTORS[feed];
  const bounds = appRef?.getViewBounds?.() ?? null;
  const viewportKey = descriptor.viewportKey?.(bounds) ?? null;
  if (
    !force &&
    state.lastUpdated &&
    Date.now() - state.lastUpdated.getTime() < descriptor.refreshIntervalMs &&
    // Recent data the user can no longer see is no reason to skip: a feed
    // toggled off and on has had its layer removed and must rebuild it, and a
    // project load brings the layer back without the rows, which are stripped
    // on save.
    ownedLayer(feed)?.geojson
  ) {
    return;
  }
  state.request?.abort();
  const controller = new AbortController();
  state.request = controller;
  state.requestedViewportKey = viewportKey;
  const generation = (state.generation += 1);
  state.loading = true;
  state.failed = false;
  renderPanel();
  const timeout = setTimeout(() => controller.abort(), descriptor.timeoutMs);
  try {
    const window = timeWindow();
    const payload = await descriptor.fetch({
      signal: controller.signal,
      window,
      bounds,
    });
    if (generation !== state.generation || !state.enabled) return;
    const updatedAt = new Date();
    upsertLayer(feed, payload, updatedAt);
    if (descriptor.ownsClockWindow) applyFeedClockWindow(window);
    state.lastUpdated = updatedAt;
    state.lastViewportKey = viewportKey;
    if (feed === "satellites") syncDenseCatalog();
  } catch (error) {
    // No `signal.aborted` check: the timeout watchdog aborts this very request,
    // so testing it swallowed exactly the failure worth reporting. Every
    // deliberate cancellation — a superseding refresh, `removeFeedLayer`,
    // `deactivate` — bumps the generation instead, which this already excludes.
    if (generation === state.generation) {
      state.failed = true;
      console.warn(`[God's Eye View] ${feed} refresh failed`, error);
    }
  } finally {
    clearTimeout(timeout);
    if (generation === state.generation) {
      state.loading = false;
      state.request = null;
      state.requestedViewportKey = null;
      renderPanel();
    }
  }
}

function removeFeedLayer(feed: FeedId): void {
  const state = feeds[feed];
  state.generation += 1;
  state.request?.abort();
  state.request = null;
  state.requestedViewportKey = null;
  state.lastViewportKey = null;
  state.loading = false;
  const layer = state.layerId
    ? useAppStore.getState().layers.find((candidate) => candidate.id === state.layerId)
    : ownedLayer(feed);
  if (layer) useAppStore.getState().removeLayer(layer.id);
  state.layerId = null;
  cesiumRef?.requestRender();
}

function setFeedEnabled(feed: FeedId, enabled: boolean): void {
  feeds[feed].enabled = enabled;
  feeds[feed].failed = false;
  savedState = { ...savedState, [feed]: enabled };
  if (enabled) void refreshFeed(feed);
  else {
    removeFeedLayer(feed);
    if (feed === "satellites") disableDenseCatalog();
  }
  renderPanel();
}

function refreshViewportFeeds(): void {
  const bounds = appRef?.getViewBounds?.() ?? null;
  for (const feed of FEED_IDS) {
    const descriptor: FeedDescriptor = FEED_DESCRIPTORS[feed];
    if (!feeds[feed].enabled || !descriptor.viewportKey) continue;
    const key = descriptor.viewportKey(bounds);
    const { lastViewportKey, requestedViewportKey } = feeds[feed];
    // A completed result is reusable only when no request for another viewport
    // is in flight. This makes a quick A → B → A move abort B and restore A.
    if (key === requestedViewportKey || (!requestedViewportKey && key === lastViewportKey))
      continue;
    void refreshFeed(feed);
  }
}

function bindViewportRefresh(): void {
  removeViewportListener?.();
  removeViewportListener = null;
  if (viewportRefreshTimer) clearTimeout(viewportRefreshTimer);
  viewportRefreshTimer = null;
  const moveEnd = cesiumRef?.viewer.camera?.moveEnd;
  if (!moveEnd?.addEventListener) return;
  const onMoveEnd = () => {
    if (viewportRefreshTimer) clearTimeout(viewportRefreshTimer);
    viewportRefreshTimer = setTimeout(() => {
      viewportRefreshTimer = null;
      refreshViewportFeeds();
    }, VIEWPORT_REFRESH_DEBOUNCE_MS);
  };
  removeViewportListener = moveEnd.addEventListener(onMoveEnd);
}

function setDenseEnabled(enabled: boolean): void {
  savedState = { ...savedState, dense: enabled };
  if (enabled) {
    if (ownedLayer("satellites")) syncDenseCatalog();
    else if (feeds.satellites.enabled) void refreshFeed("satellites");
  } else disableDenseCatalog();
  renderPanel();
}

/**
 * Re-time the globe.
 *
 * The viewer clock is written directly rather than by reloading the feeds: the
 * CZML documents carry the multiplier only so a fresh load starts at the right
 * speed, and `electCzmlClockOwner` leaves an unchanged owner's clock alone.
 */
function setSpeed(speed: number): void {
  savedState = { ...savedState, speed };
  if (cesiumRef) {
    cesiumRef.clock.multiplier = speed;
    cesiumRef.requestRender();
  }
  renderPanel();
}

/** Coerce an untrusted project settings blob into a full toggle record. */
function normalizeProjectState(value: unknown): GodsEyeViewProjectState {
  const record = (value ?? {}) as Record<string, unknown>;
  const toggles = Object.fromEntries(
    FEED_IDS.map((feed) => [
      feed,
      typeof record[feed] === "boolean" ? record[feed] : FEED_DESCRIPTORS[feed].defaultEnabled,
    ]),
  ) as Record<FeedId, boolean>;
  return {
    ...toggles,
    dense: typeof record.dense === "boolean" ? record.dense : false,
    // A hand-edited project can carry anything; only an offered step is honoured.
    speed: SPEED_OPTIONS.find((option) => option === record.speed) ?? DEFAULT_SPEED,
  };
}

function statusText(feed: FeedId): string {
  const state = feeds[feed];
  if (state.loading) return translate("panel.godsEyeView.loading", "Updating…");
  if (state.failed) return translate("panel.godsEyeView.updateFailed", "Update failed");
  const time = state.lastUpdated
    ? new Intl.DateTimeFormat(appRef?.getLocale?.(), {
        dateStyle: "short",
        timeStyle: "medium",
      }).format(state.lastUpdated)
    : translate("panel.godsEyeView.never", "Never");
  return translate("panel.godsEyeView.lastUpdated", "Last updated: {{time}}", {
    time,
  });
}

/** The clock-speed row: how fast the globe replays the feeds' time window. */
function speedRow(): HTMLElement {
  const row = document.createElement("div");
  row.style.cssText =
    "display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px;border:1px solid hsl(var(--border));border-radius:6px";
  const label = document.createElement("label");
  label.htmlFor = "gods-eye-view-speed";
  label.textContent = translate("panel.godsEyeView.speed", "Speed");
  label.style.cssText = "font-weight:600";
  const select = document.createElement("select");
  select.id = "gods-eye-view-speed";
  select.disabled = !cesiumRef;
  for (const option of SPEED_OPTIONS) {
    const item = document.createElement("option");
    item.value = String(option);
    item.textContent =
      option === 1
        ? translate("panel.godsEyeView.speedRealTime", "Real time (1×)")
        : translate("panel.godsEyeView.speedMultiple", "{{factor}}×", {
            factor: option,
          });
    item.selected = option === savedState.speed;
    select.append(item);
  }
  select.addEventListener("change", () => setSpeed(Number(select.value)));
  row.append(label, select);
  return row;
}

function renderPanel(): void {
  const container = panelContainer;
  if (!container) return;
  container.replaceChildren();
  const panel = document.createElement("div");
  // Tag the panel so the host themes its native select; plain plugin DOM does
  // not otherwise follow the app theme (see index.css).
  panel.className = "geolibre-gods-eye-view-panel";
  panel.style.cssText =
    "display:flex;flex-direction:column;gap:12px;padding:12px;height:100%;box-sizing:border-box;font-size:12px;color:hsl(var(--foreground))";
  const description = document.createElement("p");
  description.textContent = translate(
    "panel.godsEyeView.description",
    "Live, time-aware Earth events from public data feeds.",
  );
  description.style.cssText = "margin:0;color:hsl(var(--muted-foreground))";
  panel.append(description);

  if (!cesiumRef) {
    const note = document.createElement("p");
    note.textContent = translate(
      "panel.godsEyeView.globeOnly",
      "Live globe feeds render on the Cesium globe. Switch to the 3D globe to view them.",
    );
    note.style.cssText =
      "margin:0;padding:10px;border:1px solid hsl(var(--border));border-radius:6px;color:hsl(var(--muted-foreground))";
    panel.append(note);
  }

  for (const group of FEED_GROUPS) {
    const groupFeeds = FEED_IDS.filter((feed) => FEED_DESCRIPTORS[feed].group === group);
    if (groupFeeds.length === 0) continue;
    const section = document.createElement("section");
    section.className = "geolibre-gods-eye-view-feed-group";
    section.dataset.feedGroup = group;
    section.style.cssText = "display:flex;flex-direction:column;gap:8px";
    const heading = document.createElement("h3");
    heading.textContent = translate(
      `panel.godsEyeView.groups.${group}`,
      group[0].toUpperCase() + group.slice(1),
    );
    heading.style.cssText =
      "margin:2px 0 0;font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:hsl(var(--muted-foreground))";
    section.append(heading);

    for (const feed of groupFeeds) {
      const descriptor: FeedDescriptor = FEED_DESCRIPTORS[feed];
      const row = document.createElement("div");
      row.dataset.feedId = feed;
      row.style.cssText =
        "display:flex;flex-direction:column;gap:4px;padding:10px;border:1px solid hsl(var(--border));border-radius:6px";
      const label = document.createElement("label");
      label.style.cssText =
        "display:flex;align-items:center;gap:8px;font-weight:600;cursor:pointer";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = feeds[feed].enabled;
      checkbox.disabled = !cesiumRef;
      checkbox.addEventListener("change", () => setFeedEnabled(feed, checkbox.checked));
      const name = document.createElement("span");
      name.textContent = feedName(feed);
      label.append(checkbox, name);
      const status = document.createElement("div");
      status.textContent = statusText(feed);
      status.style.cssText = "font-size:11px;color:hsl(var(--muted-foreground))";
      row.append(label, status);
      if (feed === "satellites") {
        const dense = denseCatalog.snapshot();
        const button = document.createElement("button");
        button.type = "button";
        button.setAttribute("aria-pressed", String(savedState.dense));
        button.setAttribute(
          "aria-label",
          translate("panel.godsEyeView.denseSatellites", "Dense satellite catalog"),
        );
        button.disabled = !cesiumRef || !feeds.satellites.enabled;
        button.textContent =
          dense.status === "loading"
            ? translate("panel.godsEyeView.denseLoading", "DENSE ···")
            : dense.status === "failed"
              ? translate("panel.godsEyeView.denseFailed", "DENSE !")
              : dense.status === "ready"
                ? translate("panel.godsEyeView.denseCount", "DENSE · {{count}}", {
                    count: (coreSatelliteCatalogNumbers().size + dense.count).toLocaleString(
                      appRef?.getLocale?.(),
                    ),
                  })
                : translate("panel.godsEyeView.dense", "DENSE");
        button.title =
          dense.status === "failed"
            ? translate(
                "panel.godsEyeView.denseError",
                "Could not load the Starlink catalog: {{error}}. Select to retry.",
                { error: dense.error ?? "unknown error" },
              )
            : translate(
                "panel.godsEyeView.denseDescription",
                "Show the full Starlink shell as lightweight points (no labels or table rows).",
              );
        button.style.cssText =
          "align-self:flex-start;margin-top:4px;padding:3px 8px;border:1px solid hsl(var(--border));border-radius:999px;background:" +
          (savedState.dense
            ? "hsl(var(--primary));color:hsl(var(--primary-foreground))"
            : "transparent") +
          ";font-size:10px;font-weight:700;letter-spacing:.08em;cursor:pointer";
        button.addEventListener("click", () => setDenseEnabled(!savedState.dense));
        row.append(button);
      }
      section.append(row);
    }
    panel.append(section);
  }
  panel.append(speedRow());
  container.append(panel);
}

function resetRuntime(): void {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = null;
  if (viewportRefreshTimer) clearTimeout(viewportRefreshTimer);
  viewportRefreshTimer = null;
  removeViewportListener?.();
  removeViewportListener = null;
  unsubscribeLocale?.();
  unsubscribeLocale = null;
  unregisterPanel?.();
  unregisterPanel = null;
  panelContainer = null;
}

function activate(app: GeoLibreAppAPI): void {
  appRef = app;
  const globe = app.getCesiumScene?.() ?? null;
  cesiumRef = globe?.primary ? globe : null;
  for (const feed of FEED_IDS) {
    const restored = ownedLayer(feed);
    feeds[feed].layerId = restored?.id ?? null;
    // The project's toggles, not an unconditional `true`: activating after a
    // project load (or re-activating in the same session) used to switch a feed
    // the user had unchecked back on.
    feeds[feed].enabled = savedState[feed];
    const updatedAt = restored?.metadata?.updatedAt;
    feeds[feed].lastUpdated =
      typeof updatedAt === "string" && !Number.isNaN(Date.parse(updatedAt))
        ? new Date(updatedAt)
        : null;
  }

  if (cesiumRef) {
    savedClockAnimating = cesiumRef.clock.shouldAnimate;
    savedClockMultiplier = cesiumRef.clock.multiplier;
    cesiumRef.clock.shouldAnimate = true;
    cesiumRef.clock.multiplier = savedState.speed;
  }
  unregisterPanel =
    app.registerRightPanel?.({
      id: GODS_EYE_VIEW_PLUGIN_ID,
      title: () => translate("toolbar.plugin.gods-eye-view", "God's Eye View"),
      dock: "replace-style",
      defaultWidth: 320,
      render(container) {
        panelContainer = container;
        renderPanel();
        return () => {
          if (panelContainer === container) panelContainer = null;
        };
      },
    }) ?? null;
  unsubscribeLocale = app.onLocaleChange?.(() => renderPanel()) ?? null;
  app.openRightPanel?.(GODS_EYE_VIEW_PLUGIN_ID);

  if (cesiumRef) startRefreshing();
}

/** Load every enabled feed now and keep them refreshing on the interval. */
function startRefreshing(): void {
  for (const feed of FEED_IDS) {
    // A feed the project left off keeps no layer, including one a hand-edited
    // project carried in; `refreshFeed` itself no-ops while disabled.
    //
    // Not forced: this runs on every project load for a plugin that stays
    // active, and CelesTrak asks not to be re-read every few minutes. A feed
    // with no known `lastUpdated` still fetches at once, so a first activation
    // is unaffected — only a re-entry inside the interval is spared.
    if (feeds[feed].enabled) void refreshFeed(feed, false);
    else removeFeedLayer(feed);
  }
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(() => {
    for (const feed of FEED_IDS) void refreshFeed(feed, false);
  }, REFRESH_TICK_MS);
  bindViewportRefresh();
  syncDenseCatalog();
}

/**
 * Re-bind the panel to the current Cesium handle after a renderer swap or map
 * re-init, the way `reattachFlightSimulator` does. `activate` captures the
 * handle once, so without this the feeds keep pushing at a viewer that is gone
 * and the panel's checkboxes stay disabled. A reattach is not a state change:
 * `enabled` and the per-feed `layerId` are left exactly as they were.
 */
export function reattachGodsEyeView(app: GeoLibreAppAPI): void {
  if (!unregisterPanel) return;
  appRef = app;
  const globe = app.getCesiumScene?.() ?? null;
  const next = globe?.primary ? globe : null;
  // `getCesiumScene()` mints a fresh handle object on every call, so compare the
  // underlying viewer the way `reattachFlightSimulator` does. The host re-runs
  // this on every project load; only an actual engine swap should restart the
  // timer, re-fetch the feeds, and re-take the clock.
  if (next?.viewer === cesiumRef?.viewer) {
    cesiumRef = next;
    return;
  }
  disableDenseCatalog();
  cesiumRef = next;
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = null;
  if (viewportRefreshTimer) clearTimeout(viewportRefreshTimer);
  viewportRefreshTimer = null;
  removeViewportListener?.();
  removeViewportListener = null;
  if (cesiumRef) {
    savedClockAnimating = cesiumRef.clock.shouldAnimate;
    savedClockMultiplier = cesiumRef.clock.multiplier;
    cesiumRef.clock.shouldAnimate = true;
    cesiumRef.clock.multiplier = savedState.speed;
    startRefreshing();
  }
  renderPanel();
}

function deactivate(): void {
  resetRuntime();
  disableDenseCatalog();
  for (const feed of FEED_IDS) {
    feeds[feed].enabled = false;
    removeFeedLayer(feed);
    feeds[feed].lastUpdated = null;
    feeds[feed].failed = false;
  }
  if (cesiumRef && savedClockAnimating !== null) {
    cesiumRef.clock.shouldAnimate = savedClockAnimating;
  }
  // The speed goes back too: leaving the globe at 600x would keep every other
  // clock-driven plugin — the Sun's day/night cycle, the Time Slider — racing
  // long after this panel is gone.
  if (cesiumRef && savedClockMultiplier !== null) {
    cesiumRef.clock.multiplier = savedClockMultiplier;
  }
  savedClockAnimating = null;
  savedClockMultiplier = null;
  cesiumRef = null;
  appRef = null;
}

export const godsEyeViewPlugin: GeoLibrePlugin = {
  id: GODS_EYE_VIEW_PLUGIN_ID,
  name: "God's Eye View",
  version: "0.2.0",
  activeByDefault: false,
  // Every 2D engine, not just MapLibre: `engines` decides whether the Plugins
  // menu entry can be toggled at all, so leaving Mapbox and ArcGIS out greyed
  // the panel out on those renderers and put the "switch to the 3D globe" note
  // behind the very door it was written to open. The feeds still render only on
  // the globe — `activate` handles having no primary Cesium scene — which is
  // the same split `flight-simulator.ts` declares.
  engines: ["cesium", "maplibre", "mapbox", "arcgis"],
  activate,
  deactivate,
  // The host drops plugin settings that are not strictly JSON-compatible, so
  // round-trip the record the way the Time Slider does before persisting it.
  getProjectState: () => JSON.parse(JSON.stringify(savedState)) as GodsEyeViewProjectState,
  applyProjectState: (_app: GeoLibreAppAPI, state: unknown) => {
    savedState = normalizeProjectState(state);
    for (const feed of FEED_IDS) {
      feeds[feed].enabled = savedState[feed];
      feeds[feed].failed = false;
    }
    if (!savedState.dense) disableDenseCatalog();
    // Only a live panel acts on it now; otherwise `activate` reads `savedState`.
    if (!unregisterPanel) return true;
    // A loaded document only writes the clock when the owner changes, so a
    // project that carries a different speed has to re-time the globe itself.
    if (cesiumRef) {
      cesiumRef.clock.multiplier = savedState.speed;
      startRefreshing();
    } else for (const feed of FEED_IDS) if (!feeds[feed].enabled) removeFeedLayer(feed);
    renderPanel();
    return true;
  },
};

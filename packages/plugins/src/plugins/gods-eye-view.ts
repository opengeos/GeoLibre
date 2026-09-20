import { createCzmlLayer, useAppStore, type CzmlPacket } from "@geolibre/core";
import type { CesiumSceneHandle } from "@geolibre/map";
import type { GeoLibreAppAPI, GeoLibrePlugin } from "../types";
import {
  czmlPacketsToAttributeGeoJson,
  CELESTRAK_CORE_SAMPLE_STEP_SECONDS,
  fetchCelestrakSatelliteCatalogCzml,
  fetchUsgsEarthquakeCzml,
  type CzmlTimeWindow,
} from "./gods-eye-view-feeds";
import { GodsEyeViewDenseCatalog } from "./gods-eye-view-dense";

export const GODS_EYE_VIEW_PLUGIN_ID = "gods-eye-view";
export const GODS_EYE_VIEW_EARTHQUAKES_FLAG = "godsEyeViewEarthquakes";
export const GODS_EYE_VIEW_SATELLITES_FLAG = "godsEyeViewSatellites";
export const GODS_EYE_VIEW_DENSE_SATELLITES_FLAG = "godsEyeViewDenseSatellites";

const REFRESH_TICK_MS = 10 * 60_000;
const FEED_REFRESH_INTERVAL_MS: Record<FeedId, number> = {
  earthquakes: 10 * 60_000,
  // CelesTrak asks clients not to retrieve the same data more often than every
  // two hours. Six catalog requests every ten minutes would be needlessly rude.
  satellites: 2 * 60 * 60_000,
};
const FEED_TIMEOUT_MS = 20_000;
const ARC_DURATION_MS = 3 * 60 * 60_000;

const FEED_IDS = ["earthquakes", "satellites"] as const;

type FeedId = (typeof FEED_IDS)[number];

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
interface GodsEyeViewProjectState {
  earthquakes: boolean;
  satellites: boolean;
  /** Add the current Starlink shell as lightweight points. */
  dense: boolean;
  /** One of {@link SPEED_OPTIONS}. */
  speed: number;
}

interface FeedState {
  enabled: boolean;
  loading: boolean;
  lastUpdated: Date | null;
  failed: boolean;
  layerId: string | null;
  request: AbortController | null;
  generation: number;
}

const feeds: Record<FeedId, FeedState> = {
  earthquakes: {
    enabled: true,
    loading: false,
    lastUpdated: null,
    failed: false,
    layerId: null,
    request: null,
    generation: 0,
  },
  satellites: {
    enabled: true,
    loading: false,
    lastUpdated: null,
    failed: false,
    layerId: null,
    request: null,
    generation: 0,
  },
};

/**
 * The feed toggles as the project holds them, kept separately from
 * `feeds[*].enabled` so `deactivate` (which switches every feed off to stop its
 * refresh) cannot overwrite what a later save should persist.
 */
let savedState: GodsEyeViewProjectState = {
  earthquakes: true,
  satellites: true,
  dense: false,
  speed: DEFAULT_SPEED,
};

let appRef: GeoLibreAppAPI | null = null;
let cesiumRef: CesiumSceneHandle | null = null;
let unregisterPanel: (() => void) | null = null;
let unsubscribeLocale: (() => void) | null = null;
let refreshTimer: ReturnType<typeof setInterval> | null = null;
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
  return feed === "earthquakes" ? GODS_EYE_VIEW_EARTHQUAKES_FLAG : GODS_EYE_VIEW_SATELLITES_FLAG;
}

function feedName(feed: FeedId): string {
  return feed === "earthquakes"
    ? translate("panel.godsEyeView.earthquakes", "Earthquakes")
    : translate("panel.godsEyeView.satellites", "Satellites");
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
    geojson: { type: "FeatureCollection", features: denseCatalog.attributeFeatures() },
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

function upsertLayer(feed: FeedId, packets: CzmlPacket[], updatedAt: Date): void {
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
    data: packets,
  });
  // The renderer consumes CZML, while the existing Attribute Table consumes a
  // complete GeoJSON row model. Moving entities have no single geometry, but
  // their packet ids and properties still form a useful, queryable table.
  layer.geojson = czmlPacketsToAttributeGeoJson(packets);
  // Only the ISS carries a standing label, so hovering is how every other
  // satellite (and every quake) says what it is without a click.
  layer.popup = { ...layer.popup, hover: true };
  layer.metadata = {
    ...layer.metadata,
    [feedFlag(feed)]: true,
    godsEyeViewFeed: feed,
    updatedAt: updatedAt.toISOString(),
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
  if (
    !force &&
    state.lastUpdated &&
    Date.now() - state.lastUpdated.getTime() < FEED_REFRESH_INTERVAL_MS[feed] &&
    // Recent data the user can no longer see is no reason to skip: a feed
    // toggled off and on has had its layer removed and must rebuild it.
    ownedLayer(feed)
  ) {
    return;
  }
  state.request?.abort();
  const controller = new AbortController();
  state.request = controller;
  const generation = (state.generation += 1);
  state.loading = true;
  state.failed = false;
  renderPanel();
  const timeout = setTimeout(() => controller.abort(), FEED_TIMEOUT_MS);
  try {
    const window = timeWindow();
    const packets =
      feed === "earthquakes"
        ? await fetchUsgsEarthquakeCzml(window, { signal: controller.signal })
        : await fetchCelestrakSatelliteCatalogCzml({
            ...window,
            signal: controller.signal,
            // Five-minute samples interpolate smoothly while keeping the core
            // CZML layer below autosave's 10 MiB snapshot limit. A selected
            // orbit still uses the full TLE with SGP4, independent of this.
            stepSeconds: CELESTRAK_CORE_SAMPLE_STEP_SECONDS,
            maxSatellites: 2_000,
          });
    if (generation !== state.generation || !state.enabled) return;
    const updatedAt = new Date();
    upsertLayer(feed, packets, updatedAt);
    applyFeedClockWindow(window);
    state.lastUpdated = updatedAt;
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
      renderPanel();
    }
  }
}

function removeFeedLayer(feed: FeedId): void {
  const state = feeds[feed];
  state.generation += 1;
  state.request?.abort();
  state.request = null;
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
  return {
    earthquakes: typeof record.earthquakes === "boolean" ? record.earthquakes : true,
    satellites: typeof record.satellites === "boolean" ? record.satellites : true,
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
  return translate("panel.godsEyeView.lastUpdated", "Last updated: {{time}}", { time });
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
        : translate("panel.godsEyeView.speedMultiple", "{{factor}}×", { factor: option });
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

  for (const feed of FEED_IDS) {
    const row = document.createElement("div");
    row.style.cssText =
      "display:flex;flex-direction:column;gap:4px;padding:10px;border:1px solid hsl(var(--border));border-radius:6px";
    const label = document.createElement("label");
    label.style.cssText = "display:flex;align-items:center;gap:8px;font-weight:600;cursor:pointer";
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
    panel.append(row);
  }
  panel.append(speedRow());
  container.append(panel);
}

function resetRuntime(): void {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = null;
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
  version: "0.1.0",
  activeByDefault: false,
  engines: ["cesium", "maplibre"],
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

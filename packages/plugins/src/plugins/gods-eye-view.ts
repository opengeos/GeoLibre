import { createCzmlLayer, useAppStore, type CzmlPacket } from "@geolibre/core";
import type { CesiumSceneHandle } from "@geolibre/map";
import type { GeoLibreAppAPI, GeoLibrePlugin } from "../types";
import {
  czmlPacketsToAttributeGeoJson,
  fetchCelestrakSatelliteCatalogCzml,
  fetchUsgsEarthquakeCzml,
  type CzmlTimeWindow,
} from "./gods-eye-view-feeds";

export const GODS_EYE_VIEW_PLUGIN_ID = "gods-eye-view";
export const GODS_EYE_VIEW_EARTHQUAKES_FLAG = "godsEyeViewEarthquakes";
export const GODS_EYE_VIEW_SATELLITES_FLAG = "godsEyeViewSatellites";

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
  speed: DEFAULT_SPEED,
};

let appRef: GeoLibreAppAPI | null = null;
let cesiumRef: CesiumSceneHandle | null = null;
let unregisterPanel: (() => void) | null = null;
let unsubscribeLocale: (() => void) | null = null;
let refreshTimer: ReturnType<typeof setInterval> | null = null;
let panelContainer: HTMLElement | null = null;
let savedClockAnimating: boolean | null = null;

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

function ownedLayer(feed: FeedId) {
  return useAppStore.getState().layers.find((layer) => layer.metadata?.[feedFlag(feed)] === true);
}

function upsertLayer(feed: FeedId, packets: CzmlPacket[], updatedAt: Date): void {
  const store = useAppStore.getState();
  const existing = feeds[feed].layerId
    ? store.layers.find((layer) => layer.id === feeds[feed].layerId)
    : ownedLayer(feed);
  const layer = createCzmlLayer({
    id: existing?.id,
    name: feedName(feed),
    data: packets,
  });
  // The renderer consumes CZML, while the existing Attribute Table consumes a
  // complete GeoJSON row model. Moving entities have no single geometry, but
  // their packet ids and properties still form a useful, queryable table.
  layer.geojson = czmlPacketsToAttributeGeoJson(packets);
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
    Date.now() - state.lastUpdated.getTime() < FEED_REFRESH_INTERVAL_MS[feed]
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
            stepSeconds: 120,
            maxSatellites: 2_000,
          });
    if (generation !== state.generation || !state.enabled) return;
    const updatedAt = new Date();
    upsertLayer(feed, packets, updatedAt);
    state.lastUpdated = updatedAt;
  } catch (error) {
    if (generation === state.generation && !controller.signal.aborted) {
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
  else removeFeedLayer(feed);
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
    if (feeds[feed].enabled) void refreshFeed(feed);
    else removeFeedLayer(feed);
  }
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(() => {
    for (const feed of FEED_IDS) void refreshFeed(feed, false);
  }, REFRESH_TICK_MS);
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
  cesiumRef = next;
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = null;
  if (cesiumRef) {
    savedClockAnimating = cesiumRef.clock.shouldAnimate;
    cesiumRef.clock.shouldAnimate = true;
    cesiumRef.clock.multiplier = savedState.speed;
    startRefreshing();
  }
  renderPanel();
}

function deactivate(): void {
  resetRuntime();
  for (const feed of FEED_IDS) {
    feeds[feed].enabled = false;
    removeFeedLayer(feed);
    feeds[feed].lastUpdated = null;
    feeds[feed].failed = false;
  }
  if (cesiumRef && savedClockAnimating !== null) {
    cesiumRef.clock.shouldAnimate = savedClockAnimating;
  }
  savedClockAnimating = null;
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

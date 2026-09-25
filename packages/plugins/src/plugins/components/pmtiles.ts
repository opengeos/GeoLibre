// The standalone PMTiles layer control and its store sync.
// Split out of maplibre-components.ts (opengeos/GeoLibre#2633).

import { DEFAULT_LAYER_STYLE, type GeoLibreLayer, useAppStore } from "@geolibre/core";
import {
  createArcgisPMTilesArchiveLayers,
  createPMTilesArchiveLayers,
  pmtilesIdsForSourceLayers,
  type PMTilesStoreLayerOptions,
  readRemotePMTilesInfo,
} from "@geolibre/map/pmtiles-layer";
import type {
  PMTilesLayerControl,
  PMTilesLayerControlOptions,
  PMTilesLayerEventHandler,
  PMTilesLayerInfo,
} from "maplibre-gl-components";
import type { GeoLibreAppAPI, GeoLibreMapControlPosition } from "../../types";
import { adaptMapboxPMTilesControl } from "../mapbox-pmtiles-control";
import { addPMTilesArchive } from "../pmtiles-archive-store";
import { stringMetadata } from "../web-service-sync";
import { getComponentsConstructors, type PMTilesLayerControlConstructor } from "./constructors";
import { layerNameFromUrl } from "./shared";

const pmtilesControlPosition: GeoLibreMapControlPosition = "top-left";

const BUILDING_COUNT_H3_PMTILES_SAMPLE_URL =
  "https://data.source.coop/giswqs/opengeos/building_count_h3.pmtiles";
// Overture keeps only the newest release in this bucket, so a pinned sample
// URL goes 404 on the release after the one it names. Refresh it along with
// the `maplibre-gl-overture-maps` bump that follows a new Overture release.
const PMTILES_SAMPLE_URL =
  "https://overturemaps-extras-us-west-2.s3.us-west-2.amazonaws.com/tiles/2026-08-19.0/buildings.pmtiles";
const TILEZEN_PMTILES_SAMPLE_URL =
  "https://r2-public.protomaps.com/protomaps-sample-datasets/tilezen.pmtiles";

const PMTILES_OPTIONS = {
  backgroundColor: "hsl(var(--popover))",
  className: "geolibre-pmtiles-control",
  collapsed: false,
  defaultCircleColor: DEFAULT_LAYER_STYLE.fillColor,
  defaultFillColor: DEFAULT_LAYER_STYLE.fillColor,
  defaultLineColor: DEFAULT_LAYER_STYLE.strokeColor,
  defaultOpacity: 0.8,
  defaultPickable: false,
  sampleData: [
    { label: "Overture buildings", url: PMTILES_SAMPLE_URL },
    { label: "H3 building counts", url: BUILDING_COUNT_H3_PMTILES_SAMPLE_URL },
    { label: "Tilezen", url: TILEZEN_PMTILES_SAMPLE_URL },
  ],
  fontColor: "hsl(var(--popover-foreground))",
} satisfies PMTilesLayerControlOptions;

let pmtilesControl: PMTilesLayerControl | null = null;
let pmtilesControlMounted = false;
let pmtilesStoreUnsubscribe: (() => void) | null = null;

export function openPMTilesLayerPanel(app: GeoLibreAppAPI): void {
  void openStandalonePMTilesControl(app);
}

/**
 * PMTiles archives being added by URL rather than through the panel, counted per URL because two
 * adds of one URL can overlap.
 *
 * The control keeps one tick selection for the whole panel and `addLayer(url)` does not reset it,
 * so these adds — Add Data, Source Cooperative, Hugging Face, none of which shows a tick UI — would
 * otherwise inherit whatever was last ticked for a different archive and strand the rest of this
 * one outside the store. Marked here, they take the whole archive.
 */
const programmaticPMTilesAdds = new Map<string, number>();

/** Mark a programmatic add in flight, returning a disposer for its `finally`. */
function beginProgrammaticPMTilesAdd(url: string): () => void {
  programmaticPMTilesAdds.set(url, (programmaticPMTilesAdds.get(url) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (programmaticPMTilesAdds.get(url) ?? 1) - 1;
    if (remaining > 0) programmaticPMTilesAdds.set(url, remaining);
    else programmaticPMTilesAdds.delete(url);
  };
}

/**
 * Adds a remote PMTiles archive through the PMTiles control, without opening
 * its panel.
 *
 * The programmatic door onto the panel's own load path: the control reads the
 * archive header to tell vector from raster, discovers the vector source
 * layers, assigns per-source-layer colors, and emits `layeradd` — which the
 * store sync in {@link createPMTilesControl} turns into a Layers-panel entry
 * that persists with the project. Callers that discover a `.pmtiles` URL
 * elsewhere in the UI (the Source Cooperative browser, say) should come through
 * here rather than hand-building a MapLibre source.
 *
 * When this mounts the control it leaves it hidden, so adding a layer does not
 * surface a map button the user never asked for; a panel the user already has
 * open is left alone.
 *
 * @param app - The GeoLibre app API.
 * @param url - An http(s) URL to a `.pmtiles` archive.
 * @returns True when the archive was added.
 * @throws If the archive could not be loaded (unreachable, not PMTiles, 403).
 */
export async function addPMTilesLayerFromUrl(
  app: GeoLibreAppAPI,
  url: string,
  options: { fit?: boolean } = {},
): Promise<boolean> {
  let address: URL;
  try {
    address = new URL(url);
    if (!["https:", "http:"].includes(address.protocol)) throw new Error("Unsupported protocol");
  } catch {
    throw new Error(
      app.translate?.("addData.pmtiles.errorUrl", "Enter a valid HTTP(S) PMTiles URL") ??
        "Enter a valid HTTP(S) PMTiles URL",
    );
  }
  const normalizedUrl = address.href;
  if (app.getMapRenderer?.() === "arcgis") {
    const info = await readRemotePMTilesInfo(normalizedUrl);
    if (info.encoding === "mlt")
      throw new Error(
        app.translate?.("addData.pmtiles.errorMlt", "ArcGIS requires MVT vector tiles, not MLT") ??
          "ArcGIS requires MVT vector tiles, not MLT",
      );
    const encodedName = address.pathname.split("/").pop() || "PMTiles";
    let name = encodedName;
    try {
      name = decodeURIComponent(encodedName);
    } catch {
      // A valid URL can still contain a malformed percent escape in its path.
    }
    const layers = createArcgisPMTilesArchiveLayers({
      id: crypto.randomUUID(),
      name,
      url: normalizedUrl,
      ...info,
    });
    addPMTilesArchive(layers, name);
    if (options.fit !== false && info.bounds) app.fitBounds?.(info.bounds);
    return true;
  }
  const { PMTilesLayerControl: PMTilesLayerControlClass } = await getComponentsConstructors();

  pmtilesControl ??= createPMTilesControl(PMTilesLayerControlClass, app);

  if (!pmtilesControlMounted) {
    const added = app.addMapControl(pmtilesControl, pmtilesControlPosition);
    if (!added) {
      pmtilesControl = null;
      return false;
    }
    pmtilesControlMounted = true;
    // Mounted only to borrow its load path — keep it out of sight. A control
    // the user had already opened is untouched.
    pmtilesControl.hide();
  }

  const map = options.fit === false ? (app.getMap?.() ?? app.getMapboxMap?.()) : undefined;
  const cameraEvents = map as
    | {
        on(
          event: "movestart" | "moveend",
          handler: (event: { originalEvent?: unknown }) => void,
        ): unknown;
        off(
          event: "movestart" | "moveend",
          handler: (event: { originalEvent?: unknown }) => void,
        ): unknown;
      }
    | undefined;
  const readCamera = () =>
    map
      ? {
          center: map.getCenter(),
          zoom: map.getZoom(),
          bearing: map.getBearing(),
          pitch: map.getPitch(),
        }
      : null;
  let camera = readCamera();
  let userMoving = false;
  const onMoveStart = (event: { originalEvent?: unknown }) => {
    if (event.originalEvent) userMoving = true;
  };
  const onMoveEnd = () => {
    if (userMoving) {
      camera = readCamera();
      userMoving = false;
    }
  };
  cameraEvents?.on("movestart", onMoveStart);
  cameraEvents?.on("moveend", onMoveEnd);
  const control = pmtilesControl;
  const endAdd = beginProgrammaticPMTilesAdd(normalizedUrl);
  try {
    await control.addLayer(normalizedUrl);
  } finally {
    endAdd();
    // Preserve a host user's camera interaction that happened while the archive
    // header was loading, rather than restoring the older pre-load position.
    if (userMoving) camera = readCamera();
    cameraEvents?.off("movestart", onMoveStart);
    cameraEvents?.off("moveend", onMoveEnd);
  }
  // The upstream PMTiles control always frames a newly added archive. Restore
  // the host's camera when a programmatic caller explicitly opts out.
  if (camera) map?.jumpTo(camera);
  // A failed load does NOT reject: the control catches it, records it on
  // `state.error`, and emits "error" (same convention as CogLayerControl, which
  // addLayerWithCogRasterControl has to check the same way). Without this a
  // broken archive would resolve as success, and because the control is mounted
  // hidden its own on-panel error would never be seen either — the caller has
  // to surface it. `_addLayer` clears `error` on entry, so this reads the
  // outcome of the call above.
  const { error } = control.getState();
  if (error) throw new Error(error);
  return true;
}

async function openStandalonePMTilesControl(app: GeoLibreAppAPI): Promise<boolean> {
  const { PMTilesLayerControl: PMTilesLayerControlClass } = await getComponentsConstructors();

  pmtilesControl ??= createPMTilesControl(PMTilesLayerControlClass, app);

  if (!pmtilesControlMounted) {
    const added = app.addMapControl(pmtilesControl, pmtilesControlPosition);
    if (!added) {
      pmtilesControl = null;
      return false;
    }
    pmtilesControlMounted = true;
  }

  setTimeout(() => {
    pmtilesControl?.show();
    pmtilesControl?.expand();
  }, 0);
  return true;
}

function createPMTilesControl(
  PMTilesLayerControlClass: PMTilesLayerControlConstructor,
  app: GeoLibreAppAPI,
): PMTilesLayerControl {
  const control = new PMTilesLayerControlClass(PMTILES_OPTIONS);
  if (app.getMapRenderer?.() === "mapbox") adaptMapboxPMTilesControl(control, app);
  const removeHandler = createPMTilesLayerRemoveHandler();
  const onRemove = control.onRemove.bind(control);
  control.onRemove = () => {
    pmtilesStoreUnsubscribe?.();
    pmtilesStoreUnsubscribe = null;
    // The map is going away, not the project. Ignore the control's unload echo.
    control.off("layerremove", removeHandler);
    for (const layer of control.getState().layers) controlOwnedArchives.delete(layer.id);
    onRemove();
    if (pmtilesControl === control) {
      pmtilesControl = null;
      pmtilesControlMounted = false;
    }
  };
  control.on("collapse", () => control.hide());
  control.on("layeradd", createPMTilesLayerAddHandler());
  control.on("layerremove", removeHandler);
  pmtilesStoreUnsubscribe ??= useAppStore.subscribe((state, previous) => {
    // Every store write lands here, and the map writes pointer coordinates on each mousemove.
    // Only a layers action replaces the array, so identity settles it before any scanning.
    if (state.layers === previous.layers) return;
    for (const archiveId of pmtilesArchivesFullyRemoved(
      previous.layers,
      state.layers,
      controlOwnedArchives,
    )) {
      // Released here, not in the remove handler: a Layers-panel delete takes the archive's last
      // layer, so the control's echoed `layerremove` has nothing left to attribute it to and the
      // claim would outlive the archive, onto whatever reuses `pmtiles-source-N`.
      controlOwnedArchives.delete(archiveId);
      pmtilesControl?.removeLayer(archiveId);
    }
  });
  return control;
}

/** @internal Exported only so the control's teardown can be unit-tested. */
export function teardownPMTilesControl(app: GeoLibreAppAPI): void {
  pmtilesStoreUnsubscribe?.();
  pmtilesStoreUnsubscribe = null;
  // Claims belong to the control instance: a reopened panel holds nothing. Dropped *before* the
  // control is removed, because `onRemove` clears every layer it drew and emits a `layerremove`
  // naming no archive while its handlers are still attached — claims held that late read it as the
  // user deleting them all. Released first it means only that the map lost them, redrawn next sync.
  controlOwnedArchives.clear();
  if (pmtilesControl && pmtilesControlMounted) {
    app.removeMapControl(pmtilesControl);
  }
  pmtilesControl = null;
  pmtilesControlMounted = false;
}

/**
 * The archives this session's control added, and so may remove.
 *
 * Ownership is not `metadata.controlArchiveId`: that mark rides into the saved project and outlives
 * the control that set it. Read as ownership, the control's clear-all — which reports an empty list
 * rather than a layer id — would take archives it never added.
 */
const controlOwnedArchives = new Set<string>();

/** @internal Exported only so a test starts with no control, no claims and no add in flight. */
export function __resetPMTilesControlForTests(): void {
  controlOwnedArchives.clear();
  programmaticPMTilesAdds.clear();
  pmtilesStoreUnsubscribe?.();
  pmtilesStoreUnsubscribe = null;
  pmtilesControl = null;
  pmtilesControlMounted = false;
}

/** @internal Exported only so the URL-add path's effect on the tick filter can be unit-tested. */
export function __beginProgrammaticPMTilesAddForTests(url: string): () => void {
  return beginProgrammaticPMTilesAdd(url);
}

/** @internal Exported only so a test can drive the panel state a real control would hold. */
export function __getPMTilesControlForTests(): unknown {
  return pmtilesControl;
}

/** @internal Exported only so teardown can be unit-tested with a control mounted. */
export function __mountPMTilesControlForTests(control: unknown): void {
  pmtilesControl = control as typeof pmtilesControl;
  pmtilesControlMounted = true;
}

/** @internal Exported only so the archive's removal can be unit-tested. */
export function createPMTilesLayerRemoveHandler(): PMTilesLayerEventHandler {
  return (event) => {
    const store = useAppStore.getState();
    const removed = new Set(pmtilesLayerIdsToRemove(store.layers, event, controlOwnedArchives));
    const dropped = store.layers.filter((layer) => removed.has(layer.id));
    const groupIds = new Set(dropped.map((layer) => layer.groupId));
    // Only what this event actually took: releasing every archive missing from the snapshot would
    // hand back ownership of ones it never mentioned, and the control could then no longer clear
    // them.
    const releasing = new Set(
      dropped
        .map((layer) => layer.metadata.controlArchiveId)
        .filter((id): id is string => typeof id === "string"),
    );
    for (const id of removed) {
      store.removeLayer(id);
    }
    // The folder was this plugin's doing, so it goes with its last layer — unless the user put
    // something else in it.
    const after = useAppStore.getState();
    for (const groupId of groupIds) {
      if (!groupId) continue;
      if (after.layers.some((layer) => layer.groupId === groupId)) continue;
      after.removeLayerGroup(groupId);
    }
    // The control no longer has it, so neither does the claim.
    const stillListed = new Set(event.state.layers.map((layer) => layer.id));
    for (const archiveId of releasing) {
      if (!stillListed.has(archiveId)) controlOwnedArchives.delete(archiveId);
    }
  };
}

/** @internal Exported only so the archive's grouping can be unit-tested. */
export function createPMTilesLayerAddHandler(): PMTilesLayerEventHandler {
  return (event) => {
    if (!event.layerId) return;
    const layerInfo = event.state.layers.find((layer) => layer.id === event.layerId);
    if (!layerInfo) return;

    addPMTilesArchive(
      // The panel's tick selection, read from the state the control hands every handler rather than
      // inferred from the ids it drew, which spell the name raw where this package encodes it.
      pmtilesStoreLayers(event.layerId, layerInfo, event.state.selectedSourceLayers),
      pmtilesArchiveName(event.layerId, layerInfo),
    );
    controlOwnedArchives.add(event.layerId);
  };
}

/** @internal The layers a control-reported archive becomes. */
export function pmtilesStoreLayers(
  id: string,
  layerInfo: PMTilesLayerInfo,
  // Required, not defaulted: a caller that stopped passing it would silently go back to taking the
  // whole archive whatever the panel has ticked, which is the behaviour this argument exists to fix.
  selectedSourceLayers: readonly string[],
): GeoLibreLayer[] {
  return createPMTilesArchiveLayers(pmtilesLayerOptions(id, layerInfo, selectedSourceLayers)).map(
    (layer) => ({
      ...layer,
      // What the control knows this archive by. A STAC asset builds the same shape without one.
      metadata: { ...layer.metadata, controlArchiveId: id },
    }),
  );
}

/** What an archive is called: the control's own name, or one read off its URL. */
function pmtilesArchiveName(id: string, layerInfo: PMTilesLayerInfo): string {
  return layerInfo.name || layerNameFromUrl(layerInfo.url, id);
}

function pmtilesLayerOptions(
  id: string,
  layerInfo: PMTilesLayerInfo,
  selectedSourceLayers: readonly string[],
): PMTilesStoreLayerOptions {
  // What the control drew: the panel's ticked source layers, or the whole archive when none are
  // ticked. A stale tick can name source layers this archive does not even have.
  const controlDrew =
    selectedSourceLayers.length > 0 ? selectedSourceLayers : layerInfo.sourceLayers;
  // A selection naming anything this archive lacks belongs to a different one, and so does the
  // checkbox list beside it — the user could not tick the rest back. None of it is trusted.
  const stale = controlDrew.some((sourceLayer) => !layerInfo.sourceLayers.includes(sourceLayer));
  // Matched on the URL string exactly as the caller passed it, because the mark is claimed before
  // the add and there is no archive id yet to key on. The control stores that string verbatim, and
  // `tests/pmtiles-control-contract.test.ts` adds through a URL carrying a query string so a bump
  // that starts rewriting it fails there rather than silently reinstating a stale tick selection.
  const sourceLayers =
    stale || programmaticPMTilesAdds.has(layerInfo.url)
      ? layerInfo.sourceLayers
      : layerInfo.sourceLayers.filter((sourceLayer) => controlDrew.includes(sourceLayer));
  // The control made these layers, so its ids stand rather than derived ones, which would draw a
  // second trio over them. Only ids naming what the store holds are kept — the rest would be styled
  // and removed in place of real layers. With no `vector_layers` there is nothing to derive at all,
  // so the control's stand whatever they name or the layer renders as a placeholder.
  const named = pmtilesIdsForSourceLayers(layerInfo.layerIds, id, sourceLayers);
  // Ids left out name control-drawn layers no store layer owns; closing the panel or deleting the
  // archive clears them, the control removing them by its own full `layerIds`.
  return {
    id,
    name: pmtilesArchiveName(id, layerInfo),
    url: layerInfo.url,
    // The control also reports "unknown", which it and the map both draw as vector tiles.
    tileType: layerInfo.tileType === "raster" ? "raster" : "vector",
    sourceLayers,
    opacity: layerInfo.opacity,
    style: { fillOpacity: layerInfo.tileType === "raster" ? 0.6 : 1 },
    pickable: layerInfo.pickable,
    nativeLayerIds:
      sourceLayers.length === 0 ? layerInfo.layerIds : named.length > 0 ? named : undefined,
    ...(layerInfo.sourceLayerColors ? { sourceLayerColors: layerInfo.sourceLayerColors } : {}),
  };
}

/**
 * The archive a store layer belongs to. A split-out layer is named after its source layer, so its
 * own id is one the control has never heard of; matching on it goes wrong in both directions.
 */
function pmtilesArchiveId(layer: GeoLibreLayer): string | undefined {
  return stringMetadata(layer.metadata.controlArchiveId);
}

/**
 * @internal The store layers to drop for a `layerremove`. Matched by archive, not by layer id, so
 * removing one takes every layer split out of it and a listed archive keeps all of its own.
 */
export function pmtilesLayerIdsToRemove(
  layers: readonly GeoLibreLayer[],
  event: { layerId?: string; state: { layers: readonly { id: string }[] } },
  owned: ReadonlySet<string>,
): string[] {
  const activeArchiveIds = new Set(event.state.layers.map((layer) => layer.id));
  return layers
    .filter((layer) => {
      const archiveId = pmtilesArchiveId(layer);
      if (!archiveId || !owned.has(archiveId) || !isPMTilesControlLayer(layer)) return false;
      return event.layerId ? archiveId === event.layerId : !activeArchiveIds.has(archiveId);
    })
    .map((layer) => layer.id);
}

/**
 * @internal The archives whose last layer has just left the store. Deleting one source layer leaves
 * the rest drawing, so an archive goes only once none of its layers remain.
 */
export function pmtilesArchivesFullyRemoved(
  previous: readonly GeoLibreLayer[],
  next: readonly GeoLibreLayer[],
  owned: ReadonlySet<string>,
): string[] {
  const remaining = new Set<string | undefined>();
  const nextIds = new Set<string>();
  for (const layer of next) {
    nextIds.add(layer.id);
    if (isPMTilesControlLayer(layer)) remaining.add(pmtilesArchiveId(layer));
  }
  const gone = new Set<string>();
  for (const layer of previous) {
    if (!isPMTilesControlLayer(layer)) continue;
    if (nextIds.has(layer.id)) continue;
    const archiveId = pmtilesArchiveId(layer);
    // Ownership, not the mark — see `controlOwnedArchives`.
    if (archiveId && owned.has(archiveId) && !remaining.has(archiveId)) gone.add(archiveId);
  }
  return [...gone];
}

/**
 * Whether this layer came from the control: a STAC asset and a basemap extract share its shape.
 *
 * A project saved before archives carried `controlArchiveId` fails this, which costs it nothing:
 * every caller gates on `controlOwnedArchives` as well, and that is session state — a reloaded
 * layer is not the control's to remove whether or not it carries the mark.
 */
function isPMTilesControlLayer(layer: GeoLibreLayer): boolean {
  return (
    layer.type === "pmtiles" &&
    layer.metadata.sourceKind === "pmtiles-url" &&
    layer.metadata.externalNativeLayer === true &&
    pmtilesArchiveId(layer) !== undefined
  );
}

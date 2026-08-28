import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import * as maplibregl from "maplibre-gl";
import type { MapController } from "@geolibre/map";
import {
  currentEditorIdentity,
  editorTrackingFieldNames,
  getAttributeFormField,
  isAttributeFormFieldVisible,
  stampFeatureEditorTracking,
  useAppStore,
  validateAttributeFormValues,
  type AttributeFormConfig,
  type GeoLibreLayer,
} from "@geolibre/core";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  ScrollArea,
  Select,
  Separator,
} from "@geolibre/ui";
import {
  Check,
  ClipboardList,
  Crosshair,
  ImagePlus,
  Loader2,
  MapPin,
  Navigation,
  Pencil,
  Plus,
  Save,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import {
  appendFeature,
  buildGeometryFeature,
  buildPropertiesWithForm,
  buildSchema,
  collectionMetadata,
  type CollectionSchema,
  drawPreview,
  emptyFeatureCollection,
  type FieldType,
  getGeometryType,
  getSchema,
  type GeometryType,
  isCollectionLayer,
  MAX_PHOTO_BYTES,
  minVertices,
  parseOptions,
  PHOTO_PROPERTY,
  resolveTargetLayer,
  validateForm,
  type Vertex,
} from "../../lib/field-collection";
import { attributeFormErrorMessage } from "../../lib/attribute-form-messages";
import { getCurrentPosition } from "../../lib/geolocation";
import { fixFromPosition, formatAccuracy, type GpsFix } from "../../lib/gps-tracking";
import { releaseBodyPointerEvents } from "../../lib/radix-compat";

interface FieldCollectionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mapControllerRef: React.RefObject<MapController | null>;
  /** Bumped by the shell whenever the map controller (re)initialises. */
  mapReadyGeneration: number;
}

const FIELD_TYPES: FieldType[] = ["text", "number", "date", "choice"];
const GEOMETRY_TYPES: GeometryType[] = ["point", "line", "polygon"];

/** Transient map source/layers used to preview an in-progress line/polygon. */
const DRAW_SOURCE = "__fc_draw__";
const DRAW_COLOR = "#ef4444";

interface DraftField {
  id: number;
  label: string;
  type: FieldType;
  required: boolean;
  optionsText: string;
}

function newDraftField(id: number): DraftField {
  return { id, label: "", type: "text", required: false, optionsText: "" };
}

function formatLatLng(lng: number, lat: number): string {
  return `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
}

/** Add/update the transient drawing preview on the map. */
function syncDrawPreview(map: maplibregl.Map, geometry: GeometryType, verts: Vertex[]): void {
  const data = drawPreview(geometry, verts);
  const src = map.getSource(DRAW_SOURCE) as maplibregl.GeoJSONSource | undefined;
  if (src) {
    src.setData(data);
    return;
  }
  map.addSource(DRAW_SOURCE, { type: "geojson", data });
  map.addLayer({
    id: `${DRAW_SOURCE}-fill`,
    type: "fill",
    source: DRAW_SOURCE,
    filter: ["==", ["geometry-type"], "Polygon"],
    paint: { "fill-color": DRAW_COLOR, "fill-opacity": 0.2 },
  });
  map.addLayer({
    id: `${DRAW_SOURCE}-line`,
    type: "line",
    source: DRAW_SOURCE,
    filter: ["==", ["geometry-type"], "LineString"],
    paint: { "line-color": DRAW_COLOR, "line-width": 2, "line-dasharray": [2, 1] },
  });
  map.addLayer({
    id: `${DRAW_SOURCE}-pt`,
    type: "circle",
    source: DRAW_SOURCE,
    filter: ["==", ["geometry-type"], "Point"],
    paint: {
      "circle-radius": 4,
      "circle-color": DRAW_COLOR,
      "circle-stroke-color": "#ffffff",
      "circle-stroke-width": 1,
    },
  });
}

function removeDrawPreview(map: maplibregl.Map): void {
  for (const id of [`${DRAW_SOURCE}-fill`, `${DRAW_SOURCE}-line`, `${DRAW_SOURCE}-pt`]) {
    if (map.getLayer(id)) map.removeLayer(id);
  }
  if (map.getSource(DRAW_SOURCE)) map.removeSource(DRAW_SOURCE);
}

/**
 * Field Collection: capture point, line, or polygon observations against a
 * custom attribute form, placing geometry by GPS or by tapping the map. Captures
 * are written to a tagged `geojson` collection layer in the store, so they
 * persist in the project, show in the attribute table, export, and work offline.
 * Designed mobile-first to pair with the native Android build and tile cache.
 */
export function FieldCollectionDialog({
  open,
  onOpenChange,
  mapControllerRef,
  mapReadyGeneration,
}: FieldCollectionDialogProps) {
  const { t } = useTranslation();
  const layers = useAppStore((s) => s.layers);
  const addGeoJsonLayer = useAppStore((s) => s.addGeoJsonLayer);
  const updateLayer = useAppStore((s) => s.updateLayer);
  const projectGeneration = useAppStore((s) => s.projectGeneration);

  const collectionLayers = useMemo(() => layers.filter((l) => isCollectionLayer(l)), [layers]);

  // Field Collection runs as a *session* that is deliberately separate from
  // whether the dialog is open, and from whether collection layers exist: a
  // project can hold many collection layers long after the field work is done.
  // Opening the tool starts (or resumes) the session, dismissing the dialog (X,
  // Esc, overlay) leaves it running so the quick-open pill stays available, and
  // only Done ends it. Ending a session never touches the layers or features.
  const [sessionActive, setSessionActive] = useState(false);

  // Target layer: "" means "create a new layer" (the setup step is shown).
  const [layerId, setLayerId] = useState<string>("");
  // Ties the target-layer <Label> to its <Select>; they are siblings, so the
  // association has to be explicit.
  const targetLayerId = useId();
  const [layerName, setLayerName] = useState("");
  const [geometry, setGeometry] = useState<GeometryType>("point");
  const [drafts, setDrafts] = useState<DraftField[]>([]);

  // Capture state. `pending` holds the captured coordinate(s) awaiting attributes.
  const [pending, setPending] = useState<Vertex[] | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [photo, setPhoto] = useState<string | null>(null);
  const [picking, setPicking] = useState(false); // point: one-shot map click
  const [drawing, setDrawing] = useState(false); // line/polygon: multi-vertex
  const [vertices, setVertices] = useState<Vertex[]>([]);
  const [locating, setLocating] = useState(false);
  const [lastGpsFix, setLastGpsFix] = useState<GpsFix | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);
  // Running count of features saved this session, shown in the notice. A ref so
  // bumping it neither re-renders nor runs a side effect inside a state updater.
  const savedCountRef = useRef(0);

  const markerRef = useRef<maplibregl.Marker | null>(null);
  // "The next open must keep what is already captured." Set just before the
  // dialog reopens itself after a map capture, and on a dismissal that leaves a
  // capture in hand, so the open-reset effect doesn't wipe the geometry/form.
  const suppressResetRef = useRef(false);
  // True while the tool is in use; gates async GPS callbacks so a fix that
  // arrives after the dialog is dismissed doesn't mutate the map/state.
  const activeRef = useRef(false);
  // Guards handleCreateLayer against a double-tap creating duplicate layers.
  const creatingRef = useRef(false);
  // Per-instance monotonic id for draft-field React keys.
  const draftIdRef = useRef(0);
  const makeDraft = useCallback(() => newDraftField((draftIdRef.current += 1)), []);
  // Mirrors `vertices` so the map double-click handler can finish synchronously.
  const verticesRef = useRef<Vertex[]>([]);
  // Capture generation. Bumped on each GPS request and on anything that
  // supersedes the capture in progress, including actions *within* one capture
  // (repositioning a point, starting a drawing), so a slow GPS fix is dropped
  // rather than overwriting a newer capture.
  const gpsSeqRef = useRef(0);
  // Context generation: bumped only when the capture's *context* turns over —
  // a different target layer, a different project, the dialog being dismissed.
  // Async work that belongs to the capture rather than to one placement (the
  // photo read) pins itself to this, so repositioning a point mid-read keeps
  // the photo instead of silently discarding it.
  const contextSeqRef = useRef(0);
  // Distinguishes "this session has no target yet" from "the user deliberately
  // chose the new-layer setup step"; the dialog shows both as `layerId === ""`.
  const targetChosenRef = useRef(false);

  useEffect(() => {
    activeRef.current = open || picking || drawing;
  }, [open, picking, drawing]);

  // Opening the dialog from anywhere (Controls menu, command palette, the pill)
  // starts or resumes the session.
  useEffect(() => {
    if (open) setSessionActive(true);
  }, [open]);

  // Allow creating again after returning to the "new layer" setup step.
  useEffect(() => {
    if (!layerId) creatingRef.current = false;
  }, [layerId]);

  const activeLayer = layerId ? (layers.find((l) => l.id === layerId) ?? null) : null;
  const schema: CollectionSchema | null = activeLayer ? getSchema(activeLayer) : null;
  const activeGeometry: GeometryType = activeLayer ? getGeometryType(activeLayer) : geometry;
  // The layer's Attribute Form designer config, narrowed to the collection
  // schema's own fields: a config for a field this form does not capture must
  // not block a save (its required/constraint rules have nothing to bind to).
  // Memoized so handleSave's useCallback and CaptureStep's prop keep a stable
  // identity across unrelated re-renders.
  const attributeForm: AttributeFormConfig | undefined = useMemo(() => {
    const form = activeLayer?.attributeForm;
    if (!form || !schema) return undefined;
    const keys = new Set(schema.fields.map((field) => field.key));
    const fields = form.fields.filter((field) => keys.has(field.field));
    return fields.length > 0 ? { fields } : undefined;
  }, [activeLayer, schema]);

  const getMap = useCallback(() => mapControllerRef.current?.getMap() ?? null, [mapControllerRef]);

  const clearMarker = useCallback(() => {
    markerRef.current?.remove();
    markerRef.current = null;
  }, []);

  const clearPreview = useCallback(() => {
    clearMarker();
    const map = getMap();
    if (map) removeDrawPreview(map);
  }, [clearMarker, getMap]);

  // Portal host for the on-map controls. Resolved into state rather than read
  // at render time, because the controller lives in a plain ref: a map that
  // initialises after this component first renders would otherwise leave the
  // controls unmounted until some unrelated re-render happened to recompute it.
  // `mapReadyGeneration` is the shell's "the controller (re)initialised"
  // signal, the same dependency `useMapPanelControl` takes.
  const [portalHost, setPortalHost] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setPortalHost(getMap()?.getContainer() ?? null);
  }, [getMap, mapReadyGeneration]);

  // Supersede both the placement in progress and the capture it belongs to, so
  // no async work survives into a context it wasn't started in.
  const invalidateCapture = useCallback(() => {
    gpsSeqRef.current += 1;
    contextSeqRef.current += 1;
  }, []);

  // Everything one capture owns: the placed geometry, the form, the photo, the
  // map preview, and the async work behind them. The saved count goes too — it
  // belongs to the layer being left, so without this the first save into a new
  // target reads as the Nth. Split out from `resetCapture` so switching the
  // target layer can drop a capture without also discarding a half-composed
  // layer on the setup step.
  const clearCapture = useCallback(() => {
    invalidateCapture();
    setPending(null);
    setValues({});
    setPhoto(null);
    setPicking(false);
    setDrawing(false);
    setVertices([]);
    verticesRef.current = [];
    setLocating(false);
    setLastGpsFix(null);
    setErrors({});
    setNotice(null);
    savedCountRef.current = 0;
    clearPreview();
  }, [clearPreview, invalidateCapture]);

  // Drop the capture and point the form at `target`, taking the setup step back
  // to a blank new-layer form. A non-empty target becomes the session's own:
  // the pill names it from here on, so a later layer reorder must not move the
  // target out from under what the user is being shown.
  const resetCapture = useCallback(
    (target: string) => {
      clearCapture();
      setLayerId(target);
      if (target) targetChosenRef.current = true;
      setLayerName("");
      setGeometry("point");
      setDrafts(target ? [] : [makeDraft()]);
    },
    [clearCapture, makeDraft],
  );

  // Switching the capture target mid-session drops the in-progress capture: a
  // point picked for Culverts must not be saved into Water Sources, and the
  // invalidation makes sure a GPS fix still in flight for the old target can't
  // land on the new one either. Unlike `resetCapture` this keeps the setup
  // step's fields, so toggling to a layer and back doesn't lose a layer being
  // composed — the step just needs a row to type into.
  const handleTargetChange = useCallback(
    (nextId: string) => {
      clearCapture();
      targetChosenRef.current = true;
      setLayerId(nextId);
      if (!nextId && drafts.length === 0) setDrafts([makeDraft()]);
    },
    [clearCapture, drafts.length, makeDraft],
  );

  // Reset the capture form when the dialog opens. The capture *target* is not
  // form state: it belongs to the session, so a target chosen earlier survives
  // closing and reopening the dialog (the whole point of switching layers from
  // the pill). Fall back to the first collection layer, or to the "new layer"
  // setup step when the project has none.
  useEffect(() => {
    if (!open) return;
    // Reopened after a map capture — keep the captured state, skip the reset.
    if (suppressResetRef.current) {
      suppressResetRef.current = false;
      return;
    }
    resetCapture(
      resolveTargetLayer(
        collectionLayers.map((l) => l.id),
        targetChosenRef.current ? layerId : null,
      ),
    );
    // collectionLayers and layerId are snapshotted on open, by design.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // A session belongs to the project it was started in. Loading or creating a
  // project bumps `projectGeneration`, and this dialog is never remounted (as
  // PrintLayoutDialog is, via its key), so without this a session started in
  // the previous project would resurface its pill over the new one, and a
  // half-finished capture from the old project would still be sitting in the
  // form. Keep the session only if the dialog is open across the switch, and
  // re-resolve the target against the project that just loaded.
  useEffect(() => {
    setSessionActive(open);
    targetChosenRef.current = false;
    // A capture finishing in the same tick as the switch would otherwise have
    // its suppress flag consumed by the open-reset effect below, leaving the
    // old project's pending geometry in the new project's session.
    suppressResetRef.current = false;
    resetCapture(
      resolveTargetLayer(
        collectionLayers.map((l) => l.id),
        null,
      ),
    );
    // Everything but projectGeneration is snapshotted; only a project switch
    // should reset here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectGeneration]);

  // Keep the session's target honest while the dialog is closed: if the target
  // layer is deleted from the Layers panel, fall back to another collection
  // layer so the pill keeps naming a real destination. The capture goes with
  // the layer rather than being retargeted — including one preserved across a
  // dismissal, which was made for the layer that just disappeared.
  //
  // Only while the tool is put away, though. With the dialog open, or hidden
  // behind a placement, retargeting would swap the schema and geometry out from
  // under a capture the user is still working on; that case ends the capture on
  // the setup step instead (the effect further down).
  useEffect(() => {
    if (open || picking || drawing || !layerId) return;
    if (collectionLayers.some((l) => l.id === layerId)) return;
    const fallback = collectionLayers[0]?.id ?? "";
    // Landing on "" here is the project running out of collection layers, not
    // the user asking for the setup step, so don't record it as a choice.
    if (!fallback) targetChosenRef.current = false;
    suppressResetRef.current = false;
    resetCapture(fallback);
  }, [open, picking, drawing, layerId, collectionLayers, resetCapture]);

  // Tear down any preview when the dialog fully closes (not while drawing with
  // it intentionally hidden) and on unmount. A capture being kept across a
  // dismissal keeps its marker too: the reason to dismiss is to look at the
  // map, which is not the moment to hide where the pending point is.
  useEffect(() => {
    if (!open && !picking && !drawing && !suppressResetRef.current) clearPreview();
  }, [open, picking, drawing, clearPreview]);
  useEffect(() => () => clearPreview(), [clearPreview]);

  const showMarker = useCallback(
    (lng: number, lat: number) => {
      const map = getMap();
      if (!map) return;
      if (markerRef.current) {
        markerRef.current.setLngLat([lng, lat]);
      } else {
        markerRef.current = new maplibregl.Marker({ color: DRAW_COLOR })
          .setLngLat([lng, lat])
          .addTo(map);
      }
    },
    [getMap],
  );

  const recenter = useCallback(
    (lng: number, lat: number) => {
      mapControllerRef.current?.flyTo({
        center: [lng, lat],
        zoom: Math.max(getMap()?.getZoom() ?? 0, 15),
      });
    },
    [mapControllerRef, getMap],
  );

  // ---- Point capture (single coordinate) -------------------------------------

  const capturePoint = useCallback(
    (lng: number, lat: number, fly: boolean) => {
      setPending([[lng, lat]]);
      setErrors({});
      setNotice(null);
      if (!fly) setLastGpsFix(null);
      showMarker(lng, lat);
      if (fly) recenter(lng, lat);
    },
    [showMarker, recenter],
  );

  // Done ends the session: the dialog closes and the quick-open pill goes away,
  // while the collection layers and everything captured into them stay
  // untouched. It also cancels any in-flight GPS fix so its async callback
  // can't act on a dismissed dialog (the activeRef effect lags a render behind
  // the close).
  const handleDone = useCallback(() => {
    invalidateCapture();
    setSessionActive(false);
    onOpenChange(false);
  }, [invalidateCapture, onOpenChange]);

  // Anything a dismissal would be a shame to throw away: a placed geometry, an
  // attached photo, or a new layer being composed on the setup step. The empty
  // draft field the setup step starts with doesn't count — only one the user
  // has actually named.
  const hasWorkInProgress =
    pending !== null ||
    vertices.length > 0 ||
    photo !== null ||
    layerName.trim() !== "" ||
    drafts.some((d) => d.label.trim() !== "");

  // Radix routes the X, Escape, and an overlay click through here. Dismissing
  // the dialog keeps the session running, and a capture already in hand
  // survives with it: dismissing to check something on the map and coming back
  // through the pill is a normal move now, so the suppress flag keeps the
  // reopen from wiping a placed point, a half-filled form, or a layer being
  // composed on the setup step.
  //
  // Only the placement-scoped work is superseded, not the whole capture
  // context. A GPS fix must not resolve into a dropped marker and a camera fly
  // while the dialog is away (`activeRef` gates those callbacks for the same
  // reason), but a photo still being read belongs to the capture being kept, so
  // it is allowed to land on it — dropping it would lose the photo silently.
  // Nothing can leak into a *later* capture either way: the next open resets
  // unless the capture was preserved.
  //
  // Dismissing before any collection layer exists is the one case that ends the
  // session instead: the pill's whole job is to name the capture target, so a
  // session with nothing to capture into would be unreachable. That abandons
  // the capture, so there the whole context goes.
  const handleDialogOpenChange = useCallback(
    (next: boolean) => {
      if (!next) {
        if (collectionLayers.length === 0) {
          invalidateCapture();
          setSessionActive(false);
        } else {
          gpsSeqRef.current += 1;
          if (hasWorkInProgress) suppressResetRef.current = true;
        }
      }
      onOpenChange(next);
    },
    [collectionLayers.length, hasWorkInProgress, invalidateCapture, onOpenChange],
  );

  const handlePickOnMap = useCallback(() => {
    if (!getMap()) return;
    gpsSeqRef.current += 1; // invalidate any in-flight GPS fix
    setLocating(false); // its callback bails, so clear the spinner here
    setLastGpsFix(null);
    setPicking(true);
    onOpenChange(false);
  }, [getMap, onOpenChange]);

  // Cancel an active point-pick from the placement banner. Mirrors the Escape
  // path in the picking effect: stop picking and reopen the dialog without
  // capturing a point, suppressing the reopen reset so the in-progress form is
  // kept.
  const handleCancelPick = useCallback(() => {
    setPicking(false);
    suppressResetRef.current = true;
    onOpenChange(true);
  }, [onOpenChange]);

  useEffect(() => {
    if (!picking) return;
    const map = getMap();
    if (!map) {
      setPicking(false);
      return;
    }
    releaseBodyPointerEvents();
    const raf = requestAnimationFrame(releaseBodyPointerEvents);
    const prevCursor = map.getCanvas().style.cursor;
    map.getCanvas().style.cursor = "crosshair";
    const handler = (e: maplibregl.MapMouseEvent) => {
      capturePoint(e.lngLat.lng, e.lngLat.lat, false);
      setPicking(false);
      suppressResetRef.current = true;
      onOpenChange(true);
    };
    // Escape aborts picking and restores the dialog without capturing.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setPicking(false);
      suppressResetRef.current = true;
      onOpenChange(true);
    };
    map.once("click", handler);
    window.addEventListener("keydown", onKey);
    return () => {
      cancelAnimationFrame(raf);
      map.off("click", handler);
      window.removeEventListener("keydown", onKey);
      map.getCanvas().style.cursor = prevCursor;
    };
  }, [picking, getMap, onOpenChange, capturePoint]);

  // ---- Line / polygon drawing (multi-vertex) ---------------------------------

  const setVerticesSynced = useCallback(
    (next: Vertex[]) => {
      verticesRef.current = next;
      setVertices(next);
      const map = getMap();
      if (map) syncDrawPreview(map, activeGeometry, next);
    },
    [getMap, activeGeometry],
  );

  const pushVertex = useCallback(
    (lng: number, lat: number) => {
      setVerticesSynced([...verticesRef.current, [lng, lat]]);
    },
    [setVerticesSynced],
  );

  const handleStartDrawing = useCallback(() => {
    if (!getMap()) return;
    gpsSeqRef.current += 1; // invalidate any in-flight GPS fix
    setLocating(false); // its callback bails, so clear the spinner here
    setLastGpsFix(null);
    setVerticesSynced([]);
    setPending(null);
    setNotice(null);
    setDrawing(true);
    onOpenChange(false);
  }, [getMap, onOpenChange, setVerticesSynced]);

  // Finish the current geometry: keep the preview visible (so the user sees the
  // finished shape while filling the form) and reopen the dialog.
  const finishDrawing = useCallback(
    (verts: Vertex[]) => {
      if (verts.length < minVertices(activeGeometry)) return;
      const map = getMap();
      if (map) syncDrawPreview(map, activeGeometry, verts);
      verticesRef.current = verts;
      setVertices(verts);
      setPending(verts);
      setErrors({});
      setNotice(null);
      setDrawing(false);
      suppressResetRef.current = true;
      onOpenChange(true);
    },
    [activeGeometry, getMap, onOpenChange],
  );

  const handleCancelDrawing = useCallback(() => {
    setDrawing(false);
    setLastGpsFix(null);
    setVerticesSynced([]);
    setNotice(null);
    const map = getMap();
    if (map) removeDrawPreview(map);
    suppressResetRef.current = true;
    onOpenChange(true);
  }, [getMap, onOpenChange, setVerticesSynced]);

  // The target layer deleted out from under a live capture — the dialog open,
  // or hidden behind a placement. Either way the capture has nowhere to land,
  // and mid-placement `activeGeometry` would quietly fall back to the setup
  // step's geometry, changing the vertex threshold, the preview, and what
  // `finishDrawing` builds underneath a draw already in progress. End the
  // capture, drop to the setup step, and say why. Clearing `layerId` matters
  // for the dialog-open case on its own: the form moves to the setup step as
  // soon as `activeLayer` goes null, but the target Select would be left
  // pointing at an id with no matching option.
  //
  // The dialog-closed case is the fallback effect above instead, which keeps
  // the session pointed at a layer that still exists.
  useEffect(() => {
    if (!open && !picking && !drawing) return;
    if (!layerId || collectionLayers.some((l) => l.id === layerId)) return;
    const placing = picking || drawing;
    resetCapture("");
    targetChosenRef.current = false;
    // After resetCapture, which clears the notice.
    setNotice(t("fieldCollection.layerGone"));
    if (placing) {
      // Kept across the reopen by the suppress flag. With the dialog already
      // open there is no reopen to survive, and setting the flag would leave it
      // armed for an unrelated later open.
      suppressResetRef.current = true;
      onOpenChange(true);
    }
  }, [open, picking, drawing, layerId, collectionLayers, resetCapture, onOpenChange, t]);

  useEffect(() => {
    if (!drawing) return;
    const map = getMap();
    if (!map) {
      setDrawing(false);
      return;
    }
    releaseBodyPointerEvents();
    const raf = requestAnimationFrame(releaseBodyPointerEvents);
    const prevCursor = map.getCanvas().style.cursor;
    map.getCanvas().style.cursor = "crosshair";
    // Double-click finishes the geometry; disable the default zoom-on-dblclick
    // and drop the extra vertex the dblclick's second click added.
    map.doubleClickZoom.disable();
    const onClick = (e: maplibregl.MapMouseEvent) => {
      setLastGpsFix(null);
      pushVertex(e.lngLat.lng, e.lngLat.lat);
    };
    const onDblClick = (e: maplibregl.MapMouseEvent) => {
      e.preventDefault();
      finishDrawing(verticesRef.current.slice(0, -1));
    };
    // Escape aborts drawing (mirrors point-pick mode and the toolbar's Cancel).
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") handleCancelDrawing();
    };
    map.on("click", onClick);
    map.on("dblclick", onDblClick);
    window.addEventListener("keydown", onKey);
    return () => {
      cancelAnimationFrame(raf);
      map.off("click", onClick);
      map.off("dblclick", onDblClick);
      window.removeEventListener("keydown", onKey);
      map.doubleClickZoom.enable();
      map.getCanvas().style.cursor = prevCursor;
    };
  }, [drawing, getMap, pushVertex, finishDrawing, handleCancelDrawing]);

  const handleUndoVertex = useCallback(() => {
    setLastGpsFix(null);
    setVerticesSynced(verticesRef.current.slice(0, -1));
  }, [setVerticesSynced]);

  // ---- GPS (a point, or one vertex while drawing) ----------------------------

  const handleUseGps = useCallback(
    (asVertex: boolean) => {
      setLocating(true);
      setNotice(null);
      const seq = (gpsSeqRef.current += 1);
      // Ignore a fix that resolves after the tool was dismissed or superseded by
      // a newer capture (e.g. the user picked/drew a point while GPS was pending).
      const stale = () => !activeRef.current || seq !== gpsSeqRef.current;
      // On Tauri mobile this routes through the native geolocation plugin, which
      // requests the OS location permission first; elsewhere it wraps
      // navigator.geolocation. See lib/geolocation.ts.
      getCurrentPosition({ enableHighAccuracy: true, timeout: 15000, maximumAge: 0 })
        .then((pos) => {
          if (stale()) return;
          setLocating(false);
          setLastGpsFix(fixFromPosition(pos));
          const { longitude, latitude } = pos.coords;
          if (asVertex) {
            pushVertex(longitude, latitude);
            recenter(longitude, latitude);
          } else {
            // capturePoint(..., true) already recenters the map.
            capturePoint(longitude, latitude, true);
          }
        })
        .catch((err) => {
          if (stale()) return;
          setLocating(false);
          setNotice(
            t(
              err?.unavailable
                ? "fieldCollection.noGeolocation"
                : "fieldCollection.geolocationDenied",
            ),
          );
        });
    },
    [t, pushVertex, capturePoint, recenter],
  );

  const handlePhoto = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = "";
      if (!file) return;
      const tooLarge = () =>
        setNotice(
          t("fieldCollection.photoTooLarge", {
            max: `${Math.round(MAX_PHOTO_BYTES / (1024 * 1024))} MB`,
          }),
        );
      // Fast-reject before reading: the stored value is a base64 data URL (~4/3
      // the file size), so a file already over the cap can't fit. The exact
      // check is on the encoded length below.
      if (file.size > MAX_PHOTO_BYTES) {
        tooLarge();
        return;
      }
      // Reading a large photo takes long enough for the capture underneath to
      // change (a new target layer, a project switch, the tool being closed),
      // so the read is pinned to its capture context. Deliberately not the GPS
      // sequence: repositioning the point or adding a vertex stays inside the
      // same capture and must not throw the photo away.
      const seq = contextSeqRef.current;
      const stale = () => contextSeqRef.current !== seq;
      const reader = new FileReader();
      reader.onerror = () => {
        if (!stale()) setNotice(t("fieldCollection.photoReadError"));
      };
      reader.onload = () => {
        if (stale()) return;
        const dataUrl = typeof reader.result === "string" ? reader.result : "";
        if (!dataUrl) {
          setNotice(t("fieldCollection.photoReadError"));
          return;
        }
        if (dataUrl.length > MAX_PHOTO_BYTES) {
          tooLarge();
          return;
        }
        setPhoto(dataUrl);
        setNotice(null);
      };
      reader.readAsDataURL(file);
    },
    [t],
  );

  const handleCreateLayer = useCallback(() => {
    // Guard against a fast double-tap creating two identical layers before the
    // setLayerId re-render swaps the setup step out (reset in the layerId effect).
    if (creatingRef.current) return;
    creatingRef.current = true;
    const collectionSchema = buildSchema(
      drafts.map((d) => ({
        label: d.label,
        type: d.type,
        required: d.required,
        options: d.type === "choice" ? parseOptions(d.optionsText) : undefined,
      })),
    );
    const name = layerName.trim() || t("fieldCollection.layerNamePlaceholder");
    const id = addGeoJsonLayer(name, emptyFeatureCollection());
    updateLayer(id, { metadata: collectionMetadata(collectionSchema, geometry) });
    targetChosenRef.current = true;
    setLayerId(id);
    setNotice(null);
  }, [drafts, layerName, geometry, addGeoJsonLayer, updateLayer, t]);

  const handleSave = useCallback(() => {
    if (!activeLayer || !schema || !pending) return;
    // Fields hidden by a visibility expression never block a save, so the
    // schema's own required/type checks run against the visible subset only.
    const candidate = buildPropertiesWithForm(schema, values, attributeForm);
    const visibleSchema: CollectionSchema = {
      fields: schema.fields.filter((field) => {
        const config = getAttributeFormField(attributeForm, field.key);
        return !config || isAttributeFormFieldVisible(config, candidate);
      }),
    };
    const result = validateForm(visibleSchema, values);
    const formResult = validateAttributeFormValues(attributeForm, candidate);
    const mergedErrors: Record<string, string> = { ...result.errors };
    for (const [key, error] of Object.entries(formResult.errors)) {
      // Stored pre-localized; errorText surfaces unknown codes verbatim.
      if (!mergedErrors[key]) mergedErrors[key] = attributeFormErrorMessage(t, error);
    }
    if (Object.keys(mergedErrors).length > 0) {
      setErrors(mergedErrors);
      return;
    }
    const extra: Record<string, unknown> = {};
    if (photo) extra[PHOTO_PROPERTY] = photo;
    const props = buildPropertiesWithForm(schema, values, attributeForm, extra);
    const feature = buildGeometryFeature(activeGeometry, pending, props);

    const current = useAppStore.getState().layers.find((l) => l.id === activeLayer.id);
    if (!current) {
      // The collection layer was removed while the form was open — don't claim
      // a save that silently goes nowhere.
      setNotice(t("fieldCollection.layerGone"));
      return;
    }
    const fc = current.geojson ?? emptyFeatureCollection();
    // Read the tracking config off `current`, not the render-time layer: the
    // form can sit open across a configuration change.
    const tracked = editorTrackingFieldNames(current.editorTracking)
      ? stampFeatureEditorTracking(feature, "create", {
          config: current.editorTracking,
          userIdentity: currentEditorIdentity(),
        })
      : feature;
    updateLayer(activeLayer.id, { geojson: appendFeature(fc, tracked) });

    savedCountRef.current += 1;
    setNotice(
      t(`fieldCollection.saved.${activeGeometry}`, {
        count: savedCountRef.current,
        layer: activeLayer.name,
      }),
    );
    setPending(null);
    setLastGpsFix(null);
    setValues({});
    setPhoto(null);
    setVertices([]);
    verticesRef.current = [];
    setErrors({});
    clearPreview();
  }, [
    activeLayer,
    schema,
    attributeForm,
    pending,
    values,
    photo,
    activeGeometry,
    updateLayer,
    t,
    clearPreview,
  ]);

  const setValue = useCallback((key: string, value: string) => {
    setValues((v) => ({ ...v, [key]: value }));
  }, []);

  const errorText = useCallback(
    (code: string | undefined): string | null => {
      if (!code) return null;
      if (code === "required") return t("fieldCollection.errorRequired");
      if (code === "number") return t("fieldCollection.errorNumber");
      if (code === "choice") return t("fieldCollection.errorChoice");
      // Surface any future validation code rather than hiding it silently.
      return code;
    },
    [t],
  );

  const inSetup = !activeLayer;

  // Quick-access control on the map: while a session is running and a
  // collection layer exists, surface a floating pill so users can reopen the
  // tool without the Controls menu. Hidden while capturing (the dialog reopens
  // itself), and hidden once Done ends the session — the layers stay put.
  const showQuickOpen =
    sessionActive && !open && !picking && !drawing && collectionLayers.length > 0;

  // The on-map controls render into the MapLibre container rather than the
  // viewport, so they sit inside the map instead of over the app's bottom
  // chrome (status bar, comments bar) — which is what a viewport-anchored
  // `fixed bottom-6` did. The container carries `.maplibregl-map { position:
  // relative }`, so `absolute bottom-6` is measured from the map's own edge and
  // follows it as the shell's panels open and close.
  const overlays = (
    <>
      {/* `w-max` on the pill: a `left-1/2` absolute box otherwise shrink-to-fits
          into the half-width left over after the offset, clipping the layer
          name long before it needs to be. */}
      {showQuickOpen && (
        <button
          type="button"
          onClick={() => onOpenChange(true)}
          aria-label={
            activeLayer
              ? t("fieldCollection.reopenLayer", { layer: activeLayer.name })
              : t("fieldCollection.reopen")
          }
          className="absolute bottom-6 left-1/2 z-40 flex w-max max-w-[90%] -translate-x-1/2 items-center gap-2 rounded-full border bg-card px-4 py-2 text-sm font-medium shadow-lg transition-colors hover:bg-accent"
        >
          <ClipboardList className="h-4 w-4 shrink-0 text-primary" />
          <span className="shrink-0">{t("fieldCollection.title")}</span>
          {/* The capture target, so the pill says which layer the next
              observation lands in rather than just naming the tool. */}
          {activeLayer && (
            <span className="min-w-0 truncate text-muted-foreground">{activeLayer.name}</span>
          )}
        </button>
      )}

      {drawing && (
        <DrawToolbar
          geometry={activeGeometry}
          count={vertices.length}
          minCount={minVertices(activeGeometry)}
          locating={locating}
          gpsFix={lastGpsFix}
          onAddGps={() => handleUseGps(true)}
          onUndo={handleUndoVertex}
          onFinish={() => finishDrawing(vertices)}
          onCancel={handleCancelDrawing}
        />
      )}

      {picking && <PickBanner onCancel={handleCancelPick} />}
    </>
  );

  return (
    <>
      {portalHost ? createPortal(overlays, portalHost) : null}

      <Dialog open={open} onOpenChange={handleDialogOpenChange}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("fieldCollection.title")}</DialogTitle>
            <DialogDescription>
              {t(
                inSetup
                  ? "fieldCollection.description"
                  : pending
                    ? "fieldCollection.captureReviewDescription"
                    : "fieldCollection.captureDescription",
              )}
            </DialogDescription>
          </DialogHeader>

          {/* The capture target sits above the scroll area, not inside it: with
              a long form (or many collection layers) it would otherwise scroll
              out of view, and on a phone that is exactly when a user needs to
              see, and switch, which layer the next observation lands in.
              Switching here keeps the dialog open. */}
          <div className="space-y-1.5">
            <Label htmlFor={targetLayerId}>{t("fieldCollection.targetLayer")}</Label>
            <Select
              id={targetLayerId}
              value={layerId}
              onChange={(e) => handleTargetChange(e.target.value)}
            >
              {collectionLayers.map((l: GeoLibreLayer) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
              <option value="">{t("fieldCollection.newLayer")}</option>
            </Select>
          </div>

          <ScrollArea className="max-h-[60vh] pe-3">
            <div className="space-y-4 py-1">
              {inSetup ? (
                <SetupStep
                  layerName={layerName}
                  onLayerName={setLayerName}
                  geometry={geometry}
                  onGeometry={setGeometry}
                  drafts={drafts}
                  onDrafts={setDrafts}
                  newDraft={makeDraft}
                  onCreate={handleCreateLayer}
                />
              ) : (
                <CaptureStep
                  geometry={activeGeometry}
                  schema={schema!}
                  attributeForm={attributeForm}
                  pending={pending}
                  values={values}
                  setValue={setValue}
                  errors={errors}
                  errorText={errorText}
                  photo={photo}
                  onPhoto={handlePhoto}
                  onRemovePhoto={() => setPhoto(null)}
                  locating={locating}
                  gpsFix={lastGpsFix}
                  onUseGps={() => handleUseGps(false)}
                  onPickOnMap={handlePickOnMap}
                  onStartDrawing={handleStartDrawing}
                  onSave={handleSave}
                />
              )}

              {notice && (
                <p
                  aria-live="polite"
                  className="rounded-md bg-muted p-2 text-sm text-muted-foreground"
                >
                  {notice}
                </p>
              )}
            </div>
          </ScrollArea>

          {/* Done, not Close: the dialog's own X (and Esc) just hides the
              dialog and leaves the session running, so this button is the one
              that ends the session and retires the on-map pill. */}
          <div className="flex justify-end">
            <Button variant="outline" onClick={handleDone}>
              {t("common.done")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

interface DrawToolbarProps {
  geometry: GeometryType;
  count: number;
  minCount: number;
  locating: boolean;
  gpsFix: GpsFix | null;
  onAddGps: () => void;
  onUndo: () => void;
  onFinish: () => void;
  onCancel: () => void;
}

/** Floating control shown while drawing a line/polygon (dialog hidden). */
function DrawToolbar({
  geometry,
  count,
  minCount,
  locating,
  gpsFix,
  onAddGps,
  onUndo,
  onFinish,
  onCancel,
}: DrawToolbarProps) {
  const { t } = useTranslation();
  const ready = count >= minCount;
  return (
    <div className="absolute bottom-6 left-1/2 z-50 flex w-max max-w-[95%] -translate-x-1/2 flex-col gap-2 rounded-lg border bg-card p-3 shadow-xl">
      <div className="flex items-center gap-2 text-sm">
        <Pencil className="h-4 w-4 text-primary" />
        <span className="font-medium">{t(`fieldCollection.geom.${geometry}`)}</span>
        <span className="text-muted-foreground">
          {ready
            ? t("fieldCollection.vertices", { count })
            : t("fieldCollection.needMore", { min: minCount })}
        </span>
      </div>
      <p className="text-xs text-muted-foreground">{t("fieldCollection.dblClickHint")}</p>
      {gpsFix && <GpsMetadataReadout fix={gpsFix} />}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onClick={onAddGps} disabled={locating}>
          {locating ? (
            <Loader2 className="me-1 h-3.5 w-3.5 animate-spin" />
          ) : (
            <Navigation className="me-1 h-3.5 w-3.5" />
          )}
          {t("fieldCollection.addGpsVertex")}
        </Button>
        <Button variant="outline" size="sm" onClick={onUndo} disabled={count === 0}>
          <Undo2 className="me-1 h-3.5 w-3.5" />
          {t("fieldCollection.undo")}
        </Button>
        <Button size="sm" onClick={onFinish} disabled={!ready}>
          <Check className="me-1 h-3.5 w-3.5" />
          {t("fieldCollection.finish")}
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
      </div>
    </div>
  );
}

/**
 * Floating banner shown while waiting for a point pick (the dialog is hidden so
 * the map is clear). Without it the only cue is the crosshair cursor, leaving
 * the app looking like ordinary navigation mode (#711).
 */
function PickBanner({ onCancel }: { onCancel: () => void }) {
  const { t } = useTranslation();
  // Instance-scoped so the aria-describedby link holds even if more than one
  // banner is ever mounted at once (#720 review).
  const hintId = useId();
  return (
    <div className="absolute bottom-6 left-1/2 z-50 flex w-max max-w-[95%] -translate-x-1/2 flex-col gap-2 rounded-lg border bg-card p-3 shadow-xl">
      {/* Only the non-interactive status text is the live region, with the
          Cancel button as a sibling, so screen readers don't re-read the button
          on region mutations (ARIA APG). The button also takes focus on mount
          (the dialog that held focus just closed) and is described by the hint,
          so the placement instructions reach keyboard/SR users reliably even
          where a region injected on mount is missed (#720 review). */}
      <div role="status" className="flex flex-col gap-2">
        <div className="flex items-center gap-2 text-sm">
          <Crosshair className="h-4 w-4 text-primary" />
          <span className="font-medium">{t("fieldCollection.pickBannerTitle")}</span>
        </div>
        <p id={hintId} className="text-xs text-muted-foreground">
          {t("fieldCollection.pickBannerHint")}
        </p>
      </div>
      <div className="flex justify-end">
        <Button variant="ghost" size="sm" onClick={onCancel} autoFocus aria-describedby={hintId}>
          {t("common.cancel")}
        </Button>
      </div>
    </div>
  );
}

interface SetupStepProps {
  layerName: string;
  onLayerName: (v: string) => void;
  geometry: GeometryType;
  onGeometry: (g: GeometryType) => void;
  drafts: DraftField[];
  onDrafts: (next: DraftField[]) => void;
  newDraft: () => DraftField;
  onCreate: () => void;
}

function SetupStep({
  layerName,
  onLayerName,
  geometry,
  onGeometry,
  drafts,
  onDrafts,
  newDraft,
  onCreate,
}: SetupStepProps) {
  const { t } = useTranslation();
  const update = (id: number, patch: Partial<DraftField>) =>
    onDrafts(drafts.map((d) => (d.id === id ? { ...d, ...patch } : d)));

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="fc-layer-name">{t("fieldCollection.layerName")}</Label>
        <Input
          id="fc-layer-name"
          value={layerName}
          placeholder={t("fieldCollection.layerNamePlaceholder")}
          onChange={(e) => onLayerName(e.target.value)}
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="fc-geometry">{t("fieldCollection.geometry")}</Label>
        <Select
          id="fc-geometry"
          value={geometry}
          onChange={(e) => onGeometry(e.target.value as GeometryType)}
        >
          {GEOMETRY_TYPES.map((g) => (
            <option key={g} value={g}>
              {t(`fieldCollection.geom.${g}`)}
            </option>
          ))}
        </Select>
      </div>

      <Separator />

      <div className="flex items-center justify-between">
        <Label>{t("fieldCollection.fields")}</Label>
        <Button variant="ghost" size="sm" onClick={() => onDrafts([...drafts, newDraft()])}>
          <Plus className="me-1 h-3.5 w-3.5" />
          {t("fieldCollection.addField")}
        </Button>
      </div>

      {drafts.length === 0 && (
        <p className="text-sm text-muted-foreground">{t("fieldCollection.noFields")}</p>
      )}

      <div className="space-y-3">
        {drafts.map((d) => (
          <div key={d.id} className="space-y-2 rounded-md border p-2">
            <div className="flex items-center gap-2">
              <Input
                aria-label={t("fieldCollection.fieldLabel")}
                value={d.label}
                placeholder={t("fieldCollection.fieldLabel")}
                onChange={(e) => update(d.id, { label: e.target.value })}
              />
              <Select
                aria-label={t("fieldCollection.fieldType")}
                className="w-28 shrink-0"
                value={d.type}
                onChange={(e) => update(d.id, { type: e.target.value as FieldType })}
              >
                {FIELD_TYPES.map((ft) => (
                  <option key={ft} value={ft}>
                    {t(`fieldCollection.type.${ft}`)}
                  </option>
                ))}
              </Select>
              <Button
                variant="ghost"
                size="icon"
                aria-label={t("common.remove")}
                onClick={() => onDrafts(drafts.filter((x) => x.id !== d.id))}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
            {d.type === "choice" && (
              <Input
                aria-label={t("fieldCollection.options")}
                value={d.optionsText}
                placeholder={t("fieldCollection.options")}
                onChange={(e) => update(d.id, { optionsText: e.target.value })}
              />
            )}
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              <input
                type="checkbox"
                checked={d.required}
                onChange={(e) => update(d.id, { required: e.target.checked })}
              />
              {t("fieldCollection.required")}
            </label>
          </div>
        ))}
      </div>

      <Button className="w-full" onClick={onCreate}>
        <MapPin className="me-2 h-4 w-4" />
        {t("fieldCollection.createLayer")}
      </Button>
    </div>
  );
}

interface CaptureStepProps {
  geometry: GeometryType;
  schema: CollectionSchema;
  /** Attribute Form designer config narrowed to this schema's fields. */
  attributeForm?: AttributeFormConfig;
  pending: Vertex[] | null;
  values: Record<string, string>;
  setValue: (key: string, value: string) => void;
  errors: Record<string, string>;
  errorText: (code: string | undefined) => string | null;
  photo: string | null;
  onPhoto: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onRemovePhoto: () => void;
  locating: boolean;
  gpsFix: GpsFix | null;
  onUseGps: () => void;
  onPickOnMap: () => void;
  onStartDrawing: () => void;
  onSave: () => void;
}

function CaptureStep({
  geometry,
  schema,
  attributeForm,
  pending,
  values,
  setValue,
  errors,
  errorText,
  photo,
  onPhoto,
  onRemovePhoto,
  locating,
  gpsFix,
  onUseGps,
  onPickOnMap,
  onStartDrawing,
  onSave,
}: CaptureStepProps) {
  const { t } = useTranslation();
  const isPoint = geometry === "point";
  // Hidden behind a custom trigger button so the photo control shows one
  // localized label rather than the browser's native file-input text (#711).
  const photoInputRef = useRef<HTMLInputElement>(null);
  // Candidate properties for visibility expressions, computed once per render
  // instead of per field (visibility updates live as the user types).
  const candidateProps = useMemo(
    () => (attributeForm ? buildPropertiesWithForm(schema, values, attributeForm) : null),
    [schema, values, attributeForm],
  );

  return (
    <div className="space-y-3">
      {isPoint ? (
        pending ? (
          // A point is already captured, so GPS would silently discard the
          // current selection; offer only an explicit reposition (#711).
          <Button variant="outline" className="w-full" onClick={onPickOnMap}>
            <Crosshair className="me-2 h-4 w-4" />
            {t("fieldCollection.reposition")}
          </Button>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            <Button variant="outline" onClick={onUseGps} disabled={locating}>
              {locating ? (
                <Loader2 className="me-2 h-4 w-4 animate-spin" />
              ) : (
                <Navigation className="me-2 h-4 w-4" />
              )}
              {locating ? t("fieldCollection.locating") : t("fieldCollection.useGps")}
            </Button>
            <Button variant="outline" onClick={onPickOnMap}>
              <Crosshair className="me-2 h-4 w-4" />
              {t("fieldCollection.pickOnMap")}
            </Button>
          </div>
        )
      ) : (
        <Button variant="outline" className="w-full" onClick={onStartDrawing}>
          <Pencil className="me-2 h-4 w-4" />
          {t("fieldCollection.drawOnMap")}
        </Button>
      )}

      {gpsFix && <GpsMetadataReadout fix={gpsFix} />}

      {!pending ? (
        <p className="text-sm text-muted-foreground">
          {isPoint ? t("fieldCollection.captureHint") : t("fieldCollection.drawHint")}
        </p>
      ) : (
        <>
          <div className="flex items-center gap-2 rounded-md bg-muted p-2 text-sm">
            <MapPin className="h-4 w-4 shrink-0 text-primary" />
            <span className="tabular-nums">
              {isPoint
                ? formatLatLng(pending[0][0], pending[0][1])
                : t("fieldCollection.vertices", { count: pending.length })}
            </span>
          </div>

          {schema.fields.map((field) => {
            const config = getAttributeFormField(attributeForm, field.key);
            // Conditional visibility: a hidden field disappears from the form
            // (and its validation is skipped by handleSave). Evaluated against
            // the current candidate values so it updates as the user types.
            if (config && candidateProps && !isAttributeFormFieldVisible(config, candidateProps)) {
              return null;
            }
            const err = errorText(errors[field.key]);
            return (
              <div key={field.key} className="space-y-1.5">
                <Label htmlFor={`fc-${field.key}`}>
                  {config?.alias?.trim() || field.label}
                  {(field.required || config?.required) && (
                    <span className="ms-0.5 text-destructive">*</span>
                  )}
                </Label>
                {config?.widget === "valueMap" && config.valueMap?.length ? (
                  <Select
                    id={`fc-${field.key}`}
                    value={values[field.key] ?? ""}
                    onChange={(e) => setValue(field.key, e.target.value)}
                  >
                    <option value="">—</option>
                    {config.valueMap.map((entry) => (
                      <option key={entry.value} value={entry.value}>
                        {entry.label ?? entry.value}
                      </option>
                    ))}
                  </Select>
                ) : config?.widget === "checkbox" ? (
                  <div className="flex h-9 items-center">
                    <input
                      id={`fc-${field.key}`}
                      type="checkbox"
                      className="h-4 w-4"
                      checked={values[field.key] === "true"}
                      onChange={(e) => setValue(field.key, e.target.checked ? "true" : "false")}
                    />
                  </div>
                ) : config ? (
                  <Input
                    id={`fc-${field.key}`}
                    type={
                      config.widget === "number" || config.widget === "range"
                        ? "number"
                        : config.widget === "date"
                          ? "date"
                          : "text"
                    }
                    min={config.min}
                    max={config.max}
                    step={config.step}
                    value={values[field.key] ?? ""}
                    onChange={(e) => setValue(field.key, e.target.value)}
                  />
                ) : field.type === "choice" && field.options?.length ? (
                  <Select
                    id={`fc-${field.key}`}
                    value={values[field.key] ?? ""}
                    onChange={(e) => setValue(field.key, e.target.value)}
                  >
                    <option value="">—</option>
                    {field.options.map((opt) => (
                      <option key={opt} value={opt}>
                        {opt}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <Input
                    id={`fc-${field.key}`}
                    type={
                      field.type === "number" ? "number" : field.type === "date" ? "date" : "text"
                    }
                    value={values[field.key] ?? ""}
                    onChange={(e) => setValue(field.key, e.target.value)}
                  />
                )}
                {err && <p className="text-xs text-destructive">{err}</p>}
              </div>
            );
          })}

          {/* Save sits above the optional photo so the primary action is
              reachable without scrolling past the upload, and the photo reads
              as the optional extra it is (#711). */}
          <Button className="w-full" onClick={onSave}>
            <Save className="me-2 h-4 w-4" />
            {t(`fieldCollection.save.${geometry}`)}
          </Button>

          <div className="space-y-1.5">
            <Label htmlFor="fc-photo">{t("fieldCollection.photoOptional")}</Label>
            {photo ? (
              <div className="flex items-center gap-2">
                <img
                  src={photo}
                  alt={t("fieldCollection.photo")}
                  className="h-16 w-16 rounded-md object-cover"
                />
                <Button variant="ghost" size="sm" onClick={onRemovePhoto}>
                  <X className="me-1 h-3.5 w-3.5" />
                  {t("fieldCollection.removePhoto")}
                </Button>
              </div>
            ) : (
              <>
                {/* No `capture` attribute: let the user pick an existing photo
                    or take a new one (capture="environment" forces the camera
                    on iOS). Hidden; the button below is the visible trigger. */}
                <input
                  ref={photoInputRef}
                  id="fc-photo"
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={onPhoto}
                />
                <Button
                  type="button"
                  variant="outline"
                  className="w-full"
                  onClick={() => photoInputRef.current?.click()}
                >
                  <ImagePlus className="me-2 h-4 w-4" />
                  {t("fieldCollection.choosePhoto")}
                </Button>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function GpsMetadataReadout({ fix }: { fix: GpsFix }) {
  const { t } = useTranslation();
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md bg-muted px-3 py-2 text-sm tabular-nums text-muted-foreground"
    >
      <span>±{formatAccuracy(fix.accuracy, t("gps.notAvailable"))}</span>
      <span>{t("gps.satellitesValue", { value: fix.satellites ?? t("gps.notAvailable") })}</span>
    </div>
  );
}

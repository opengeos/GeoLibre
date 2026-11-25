import { readControlPreference, writeControlPreference } from "../lib/control-preferences";
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import type { MapEngine } from "@geolibre/map";
import {
  currentEditorIdentity,
  editorTrackingFieldNames,
  getAttributeFormField,
  isAttributeFormFieldVisible,
  stampFeatureEditorTracking,
  useAppStore,
  useLayer,
  useLayerSlices,
  useLayersWhen,
  validateAttributeFormValues,
  type AttributeFormConfig,
} from "@geolibre/core";
import {
  appendFeature,
  buildGeometryFeature,
  buildPropertiesWithForm,
  buildPhotoProperties,
  type CollectionPhoto,
  buildSchema,
  collectionMetadata,
  type CollectionSchema,
  detachFromSourceFile,
  emptyFeatureCollection,
  type FieldType,
  getGeometryType,
  getSchema,
  type GeometryType,
  createCollectionLayerSelector,
  isFileBackedCollectionLayer,
  MAX_PHOTO_BYTES,
  minVertices,
  parseOptions,
  type SavedParent,
  resolveTargetLayer,
  validateForm,
  type Vertex,
} from "../lib/field-collection";
import {
  createFieldCollectionMarker,
  createFieldCollectionPreview,
  listenForFieldCollectionClicks,
  type FieldCollectionMarker,
  type FieldCollectionPreview,
} from "../lib/field-collection-map";

import { useCaptureDefaults } from "./useCaptureDefaults";
import { useResolvedAttributeForm } from "./useResolvedAttributeForm";
import { attributeFormErrorMessage } from "../lib/attribute-form-messages";
import { getCurrentPosition } from "../lib/geolocation";
import { fixFromPosition, type GpsFix } from "../lib/gps-tracking";
import { releaseBodyPointerEvents } from "../lib/radix-compat";

export interface FieldCollectionControllerOptions {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mapControllerRef: RefObject<MapEngine | null>;
  mapReadyGeneration: number;
}

const DRAW_COLOR = "#ef4444";
/** A second save of a table record this soon after the last is a double-click. */
const DOUBLE_SAVE_MS = 600;

export interface DraftField {
  id: number;
  label: string;
  type: FieldType;
  required: boolean;
  optionsText: string;
}

function newDraftField(id: number): DraftField {
  return { id, label: "", type: "text", required: false, optionsText: "" };
}

/** Own capture targets, placement, asynchronous inputs, and saving for a field session. */
export function useFieldCollectionController({
  open,
  onOpenChange,
  mapControllerRef,
  mapReadyGeneration,
}: FieldCollectionControllerOptions) {
  const { t } = useTranslation();
  const addGeoJsonLayer = useAppStore((s) => s.addGeoJsonLayer);
  const updateLayer = useAppStore((s) => s.updateLayer);
  const projectGeneration = useAppStore((s) => s.projectGeneration);

  const collectionLayers = useLayerSlices(useMemo(createCollectionLayerSelector, []));

  // Field Collection runs as a *session* that is deliberately separate from
  // whether the dialog is open, and from whether collection layers exist: a
  // project can hold many collection layers long after the field work is done.
  // Opening the tool starts (or resumes) the session, dismissing the dialog (X,
  // Esc, overlay) leaves it running so the quick-open pill stays available, and
  // only Done ends it. Ending a session never touches the layers or features.
  const [sessionActive, setSessionActive] = useState(() =>
    readControlPreference("field-collection", false),
  );

  // Target layer: "" means "create a new layer" (the setup step is shown).
  const [layerId, setLayerId] = useState<string>("");
  const [layerName, setLayerName] = useState("");
  const [geometry, setGeometry] = useState<GeometryType>("point");
  const [drafts, setDrafts] = useState<DraftField[]>([]);

  // Capture state. `pending` holds the captured coordinate(s) awaiting attributes.
  const [pending, setPending] = useState<Vertex[] | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [photos, setPhotos] = useState<CollectionPhoto[]>([]);
  // Count batches: separate file selections can read concurrently.
  const [photoReads, setPhotoReads] = useState(0);
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

  const markerRef = useRef<FieldCollectionMarker | null>(null);
  const previewRef = useRef<FieldCollectionPreview | null>(null);
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
  // The renderer-reinitialization effect needs the capture as it exists at the
  // instant a new surface arrives without re-running for every form edit.
  const pendingRef = useRef<Vertex[] | null>(null);
  // Capture generation. Bumped on each GPS request and on anything that
  // supersedes the capture in progress, including actions *within* one capture
  // (repositioning a point, starting a drawing), so a slow GPS fix is dropped
  // rather than overwriting a newer capture.
  const gpsSeqRef = useRef(0);
  // Context generation: bumped only when the capture's *context* turns over,
  // a different target layer/project, a saved capture, or an ended session.
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
    if (open) {
      setSessionActive(true);
      writeControlPreference("field-collection", true);
    }
  }, [open]);

  // Allow creating again after returning to the "new layer" setup step.
  useEffect(() => {
    if (!layerId) creatingRef.current = false;
  }, [layerId]);

  const activeLayer = useLayer(layerId) ?? null;
  // The related-record links read every layer's form, and show only inside the
  // open dialog.
  const openLayers = useLayersWhen(open);
  const schema: CollectionSchema | null = activeLayer ? getSchema(activeLayer) : null;
  const activeGeometry: GeometryType = activeLayer ? getGeometryType(activeLayer) : geometry;
  const activeGeometryRef = useRef(activeGeometry);
  activeGeometryRef.current = activeGeometry;
  pendingRef.current = pending;
  // The layer's Attribute Form designer config, narrowed to the collection
  // schema's own fields: a config for a field this form does not capture must
  // not block a save (its required/constraint rules have nothing to bind to).
  // Memoized so handleSave's useCallback and CaptureStep's prop keep a stable
  // identity across unrelated re-renders.
  // Relation dropdowns list the referenced layer's current rows, so a point
  // captured a moment ago can be picked as a review's or photo's parent.
  const resolvedForm = useResolvedAttributeForm(activeLayer?.attributeForm);
  const attributeForm: AttributeFormConfig | undefined = useMemo(() => {
    const form = resolvedForm;
    if (!form || !schema) return undefined;
    const keys = new Set(schema.fields.map((field) => field.key));
    const fields = form.fields.filter((field) => keys.has(field.field));
    return fields.length > 0 ? { ...form, fields } : undefined;
  }, [resolvedForm, schema]);
  // A table's records have no location: the form is the whole capture. A new
  // array per record marks where one capture ends and the next begins.
  const [recordSeq, setRecordSeq] = useState(0);
  const noLocationRef = useRef<{ key: string; vertices: Vertex[] }>({ key: "", vertices: [] });
  const recordKey = `${layerId}:${recordSeq}`;
  if (noLocationRef.current.key !== recordKey) {
    noLocationRef.current = { key: recordKey, vertices: [] };
  }
  const capturePending = activeGeometry === "none" ? noLocationRef.current.vertices : pending;
  const recordKeyRef = useRef(recordKey);
  recordKeyRef.current = recordKey;
  // Values a child record starts with (its link to the parent just saved),
  // and the record whose children can be added next.
  const prefillRef = useRef<Record<string, string>>({});
  const [savedParent, setSavedParent] = useState<SavedParent | null>(null);
  // Whether the user has typed into the current record, and when the last one
  // was saved: a table's form is ready again the instant a record is saved,
  // so nothing else stands between a double-click and a duplicate record.
  const [recordEdited, setRecordEdited] = useState(false);
  const lastSavedAtRef = useRef(0);

  useCaptureDefaults({
    pending: capturePending,
    // Layer and record: switching between two tables is a new capture too.
    captureKey: recordKey,
    gpsFix: lastGpsFix,
    schema,
    attributeForm,
    geometry: activeGeometry,
    layerName: activeLayer?.name,
    values,
    setValues,
  });

  const getEngine = useCallback(() => mapControllerRef.current, [mapControllerRef]);

  const clearMarker = useCallback(() => {
    markerRef.current?.remove();
    markerRef.current = null;
  }, []);

  const clearPreview = useCallback(() => {
    clearMarker();
    previewRef.current?.remove();
    previewRef.current = null;
  }, [clearMarker]);

  // Portal host for the on-map controls. Resolved into state rather than read
  // at render time, because the controller lives in a plain ref: a map that
  // initialises after this component first renders would otherwise leave the
  // controls unmounted until some unrelated re-render happened to recompute it.
  // `mapReadyGeneration` is the shell's "the controller (re)initialised"
  // signal, the same dependency `useMapPanelControl` takes.
  const [portalHost, setPortalHost] = useState<HTMLElement | null>(null);
  useEffect(() => {
    const engine = getEngine();
    setPortalHost(engine?.getRenderSurface()?.getContainer() ?? null);
    markerRef.current?.remove();
    markerRef.current = null;
    previewRef.current?.remove();
    previewRef.current = null;
    if (!engine) return;
    const captured = pendingRef.current;
    const captureGeometry = activeGeometryRef.current;
    if (captureGeometry === "point" && captured?.[0]) {
      markerRef.current = createFieldCollectionMarker(engine, DRAW_COLOR);
      markerRef.current?.setLngLat(captured[0]);
      return;
    }
    const previewVertices = captured ?? verticesRef.current;
    if (captureGeometry !== "point" && previewVertices.length > 0) {
      previewRef.current = createFieldCollectionPreview(engine, DRAW_COLOR);
      previewRef.current?.setGeometry(captureGeometry, previewVertices);
    }
  }, [getEngine, mapReadyGeneration]);

  // Supersede both the placement in progress and the capture it belongs to, so
  // no async work survives into a context it wasn't started in.
  const invalidateCapture = useCallback(() => {
    gpsSeqRef.current += 1;
    contextSeqRef.current += 1;
    setPhotoReads(0);
  }, []);

  // Everything one capture owns: the placed geometry, the form, the photo, the
  // map preview, and the async work behind them. The saved count goes too, it
  // belongs to the layer being left, so without this the first save into a new
  // target reads as the Nth. Split out from `resetCapture` so switching the
  // target layer can drop a capture without also discarding a half-composed
  // layer on the setup step.
  const clearCapture = useCallback(() => {
    invalidateCapture();
    setPending(null);
    setValues({});
    setPhotos([]);
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
  // composed, the step just needs a row to type into.
  const handleTargetChange = useCallback(
    (nextId: string) => {
      clearCapture();
      prefillRef.current = {};
      setSavedParent(null);
      setRecordEdited(false);
      // The double-click guard is about one layer's form; a save into the
      // layer just switched to is a different record, however soon it comes.
      lastSavedAtRef.current = 0;
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
    // Reopened after a map capture, keep the captured state, skip the reset.
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

  // Project changes discard capture drafts and re-resolve the target. Only the
  // device-local shortcut preference survives: it never restores an unfinished
  // capture or starts a GPS request. Projects without collection layers still
  // hide the shortcut.
  useEffect(() => {
    setSessionActive(open || readControlPreference("field-collection", false));
    targetChosenRef.current = false;
    // A capture finishing in the same tick as the switch would otherwise have
    // its suppress flag consumed by the open-reset effect below, leaving the
    // old project's pending geometry in the new project's session.
    suppressResetRef.current = false;
    // The saved parent and its pre-filled link name layers of the project
    // being left; another project can reuse the same layer ids.
    prefillRef.current = {};
    setSavedParent(null);
    setRecordEdited(false);
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
  // the layer rather than being retargeted, including one preserved across a
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
  useEffect(
    () => () => {
      // Invalidate both lifecycles before removing their map output, so a late
      // GPS result cannot recreate a marker or move the map after unmount.
      activeRef.current = false;
      gpsSeqRef.current += 1;
      contextSeqRef.current += 1;
      clearPreview();
    },
    [clearPreview],
  );

  const showMarker = useCallback(
    (lng: number, lat: number) => {
      const engine = getEngine();
      if (!engine) return;
      markerRef.current ??= createFieldCollectionMarker(engine, DRAW_COLOR);
      markerRef.current?.setLngLat([lng, lat]);
    },
    [getEngine],
  );

  const recenter = useCallback(
    (lng: number, lat: number) => {
      const engine = mapControllerRef.current;
      if (!engine) return;
      engine.flyTo({
        center: [lng, lat],
        zoom: Math.max(engine.readView().zoom, 15),
      });
    },
    [mapControllerRef],
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
    writeControlPreference("field-collection", false);
    onOpenChange(false);
  }, [invalidateCapture, onOpenChange]);

  // Anything a dismissal would be a shame to throw away: a placed geometry, an
  // attached photo, or a new layer being composed on the setup step. The empty
  // draft field the setup step starts with doesn't count, only one the user
  // has actually named.
  const hasWorkInProgress =
    pending !== null ||
    vertices.length > 0 ||
    photos.length > 0 ||
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
  // it is allowed to land on it, dropping it would lose the photo silently.
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
          writeControlPreference("field-collection", false);
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
    if (!getEngine()?.getRenderSurface()) return;
    gpsSeqRef.current += 1; // invalidate any in-flight GPS fix
    setLocating(false); // its callback bails, so clear the spinner here
    setLastGpsFix(null);
    setPicking(true);
    onOpenChange(false);
  }, [getEngine, onOpenChange]);

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
    const engine = getEngine();
    if (!engine?.getRenderSurface()) {
      setPicking(false);
      return;
    }
    releaseBodyPointerEvents();
    const raf = requestAnimationFrame(releaseBodyPointerEvents);
    let captured = false;
    const stopListening = listenForFieldCollectionClicks(engine, {
      onClick: ([lng, lat]) => {
        if (captured) return;
        captured = true;
        capturePoint(lng, lat, false);
        setPicking(false);
        suppressResetRef.current = true;
        onOpenChange(true);
      },
    });
    // Escape aborts picking and restores the dialog without capturing.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setPicking(false);
      suppressResetRef.current = true;
      onOpenChange(true);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      cancelAnimationFrame(raf);
      stopListening();
      window.removeEventListener("keydown", onKey);
    };
  }, [picking, getEngine, mapReadyGeneration, onOpenChange, capturePoint]);

  // ---- Line / polygon drawing (multi-vertex) ---------------------------------

  const setVerticesSynced = useCallback(
    (next: Vertex[]) => {
      verticesRef.current = next;
      setVertices(next);
      const engine = getEngine();
      if (!engine) return;
      previewRef.current ??= createFieldCollectionPreview(engine, DRAW_COLOR);
      previewRef.current?.setGeometry(activeGeometry, next);
    },
    [getEngine, activeGeometry],
  );

  const pushVertex = useCallback(
    (lng: number, lat: number) => {
      setVerticesSynced([...verticesRef.current, [lng, lat]]);
    },
    [setVerticesSynced],
  );

  const handleStartDrawing = useCallback(() => {
    if (!getEngine()?.getRenderSurface()) return;
    gpsSeqRef.current += 1; // invalidate any in-flight GPS fix
    setLocating(false); // its callback bails, so clear the spinner here
    setLastGpsFix(null);
    setVerticesSynced([]);
    setPending(null);
    setNotice(null);
    setDrawing(true);
    onOpenChange(false);
  }, [getEngine, onOpenChange, setVerticesSynced]);

  // Finish the current geometry: keep the preview visible (so the user sees the
  // finished shape while filling the form) and reopen the dialog.
  const finishDrawing = useCallback(
    (verts: Vertex[]) => {
      if (verts.length < minVertices(activeGeometry)) return;
      const engine = getEngine();
      if (engine) {
        previewRef.current ??= createFieldCollectionPreview(engine, DRAW_COLOR);
        previewRef.current?.setGeometry(activeGeometry, verts);
      }
      verticesRef.current = verts;
      setVertices(verts);
      setPending(verts);
      setErrors({});
      setNotice(null);
      setDrawing(false);
      suppressResetRef.current = true;
      onOpenChange(true);
    },
    [activeGeometry, getEngine, onOpenChange],
  );

  const handleCancelDrawing = useCallback(() => {
    setDrawing(false);
    setLastGpsFix(null);
    setVerticesSynced([]);
    setNotice(null);
    previewRef.current?.remove();
    previewRef.current = null;
    suppressResetRef.current = true;
    onOpenChange(true);
  }, [onOpenChange, setVerticesSynced]);

  // The target layer deleted out from under a live capture, the dialog open,
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
    const engine = getEngine();
    if (!engine?.getRenderSurface()) {
      setDrawing(false);
      return;
    }
    releaseBodyPointerEvents();
    const raf = requestAnimationFrame(releaseBodyPointerEvents);
    const stopListening = listenForFieldCollectionClicks(engine, {
      onClick: ([lng, lat]) => {
        setLastGpsFix(null);
        pushVertex(lng, lat);
      },
      // The browser emits the double-click's second click first, so drop that
      // extra vertex just as the previous MapLibre event path did.
      onDoubleClick: () => {
        const withoutExtraClick = verticesRef.current.slice(0, -1);
        setVerticesSynced(withoutExtraClick);
        finishDrawing(withoutExtraClick);
      },
    });
    // Escape aborts drawing (mirrors point-pick mode and the toolbar's Cancel).
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") handleCancelDrawing();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      cancelAnimationFrame(raf);
      stopListening();
      window.removeEventListener("keydown", onKey);
    };
  }, [
    drawing,
    getEngine,
    mapReadyGeneration,
    pushVertex,
    setVerticesSynced,
    finishDrawing,
    handleCancelDrawing,
  ]);

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

  const handlePhotos = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files ?? []);
      e.target.value = "";
      if (files.length === 0) return;
      const tooLarge = () =>
        setNotice(
          t("fieldCollection.photoTooLarge", {
            max: `${Math.round(MAX_PHOTO_BYTES / (1024 * 1024))} MB`,
          }),
        );
      // Fast-reject before reading: the stored value is a base64 data URL (~4/3
      // the file size), so a file already over the cap can't fit. The exact
      // check is on the encoded length below.
      if (files.some((file) => file.size > MAX_PHOTO_BYTES)) {
        tooLarge();
        return;
      }
      // Reading a large photo takes long enough for the capture underneath to
      // change (a new target layer, a project switch, the tool being closed),
      // so the read is pinned to its capture context. Deliberately not the GPS
      // sequence: repositioning the point or adding a vertex stays inside the
      // same capture and must not throw the photo away.
      const seq = contextSeqRef.current;
      setPhotoReads((count) => count + 1);
      Promise.all(
        files.map(
          (file) =>
            new Promise<CollectionPhoto>((resolve, reject) => {
              const reader = new FileReader();
              reader.onerror = reject;
              reader.onload = () => {
                const src = typeof reader.result === "string" ? reader.result : "";
                if (!src) reject(new Error("empty photo"));
                else if (src.length > MAX_PHOTO_BYTES) reject(new RangeError());
                else resolve({ src, name: file.name });
              };
              reader.readAsDataURL(file);
            }),
        ),
      )
        .then((next) => {
          if (contextSeqRef.current !== seq) return;
          setPhotos((current) => [...current, ...next]);
          setNotice(null);
        })
        .catch((error) => {
          if (contextSeqRef.current !== seq) return;
          if (error instanceof RangeError) tooLarge();
          else setNotice(t("fieldCollection.photoReadError"));
        })
        .finally(() => {
          if (contextSeqRef.current === seq) setPhotoReads((count) => count - 1);
        });
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
    const pending = capturePending;
    if (!activeLayer || !schema || !pending || photoReads > 0) return;
    if (activeGeometry === "none" && Date.now() - lastSavedAtRef.current < DOUBLE_SAVE_MS) return;
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
    const props = buildPropertiesWithForm(
      schema,
      values,
      attributeForm,
      buildPhotoProperties(photos),
    );
    const feature = buildGeometryFeature(activeGeometry, pending, props);

    const current = useAppStore.getState().layers.find((l) => l.id === activeLayer.id);
    if (!current) {
      // The collection layer was removed while the form was open, don't claim
      // a save that silently goes nowhere.
      setNotice(t("fieldCollection.layerGone"));
      return;
    }
    // A file-backed layer (an imported QGIS/QField layer) whose features have
    // not been read yet: appending now would save the capture over the rows
    // still on their way in.
    if (!current.geojson && isFileBackedCollectionLayer(current)) {
      setNotice(t("fieldCollection.layerLoading"));
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
    updateLayer(activeLayer.id, {
      geojson: appendFeature(fc, tracked),
      ...detachFromSourceFile(current),
    });
    invalidateCapture();

    savedCountRef.current += 1;
    setNotice(
      t(`fieldCollection.saved.${activeGeometry}`, {
        count: savedCountRef.current,
        layer: activeLayer.name,
      }),
    );
    setPending(null);
    setLocating(false);
    setLastGpsFix(null);
    setValues(prefillRef.current);
    setRecordSeq((seq) => seq + 1);
    setRecordEdited(false);
    lastSavedAtRef.current = Date.now();
    setSavedParent({ layerId: activeLayer.id, properties: props });
    setPhotos([]);
    setVertices([]);
    verticesRef.current = [];
    setErrors({});
    clearPreview();
  }, [
    capturePending,
    activeLayer,
    schema,
    attributeForm,
    values,
    photos,
    photoReads,
    invalidateCapture,
    activeGeometry,
    updateLayer,
    t,
    clearPreview,
  ]);

  const setValue = useCallback((key: string, value: string) => {
    setRecordEdited(true);
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
  // itself), and hidden once Done ends the session, the layers stay put.
  const showQuickOpen =
    sessionActive && !open && !picking && !drawing && collectionLayers.length > 0;

  return {
    inSetup,
    description: t(
      inSetup
        ? "fieldCollection.description"
        : activeGeometry === "none"
          ? "fieldCollection.captureRecordDescription"
          : pending
            ? "fieldCollection.captureReviewDescription"
            : "fieldCollection.captureDescription",
    ),
    portalHost,
    quickOpen: showQuickOpen,
    reopenLabel: activeLayer
      ? t("fieldCollection.reopenLayer", { layer: activeLayer.name })
      : t("fieldCollection.reopen"),
    activeLayerName: activeLayer?.name ?? null,
    onReopen: () => onOpenChange(true),
    onDialogOpenChange: handleDialogOpenChange,
    onDone: handleDone,
    notice,
    target: { selected: layerId, layers: collectionLayers, onChange: handleTargetChange },
    setup: {
      layerName,
      onLayerName: setLayerName,
      geometry,
      onGeometry: setGeometry,
      drafts,
      onDrafts: setDrafts,
      newDraft: makeDraft,
      onCreate: handleCreateLayer,
    },
    draw: drawing
      ? {
          geometry: activeGeometry,
          count: vertices.length,
          minCount: minVertices(activeGeometry),
          locating,
          gpsFix: lastGpsFix,
          onAddGps: () => handleUseGps(true),
          onUndo: handleUndoVertex,
          onFinish: () => finishDrawing(vertices),
          onCancel: handleCancelDrawing,
        }
      : null,
    pick: picking ? { onCancel: handleCancelPick } : null,
    capture: {
      geometry: activeGeometry,
      schema: schema!,
      attributeForm,
      pending: capturePending,
      captureKey: recordKey,
      onAttachmentReading: (delta: number, key: string) => {
        if (key === recordKeyRef.current) setPhotoReads((count) => Math.max(0, count + delta));
      },
      values,
      setValue,
      errors,
      errorText,
      photos,
      readingPhotos: photoReads > 0,
      onPhotos: handlePhotos,
      onRemovePhoto: (index: number) =>
        setPhotos((current) => current.filter((_, i) => i !== index)),
      locating,
      gpsFix: lastGpsFix,
      onUseGps: () => handleUseGps(false),
      onPickOnMap: handlePickOnMap,
      onStartDrawing: handleStartDrawing,
      onSave: handleSave,
    },
    related:
      savedParent && (activeGeometry === "none" ? !recordEdited : !pending)
        ? {
            parent: savedParent,
            layers: openLayers,
            onAdd: (childId: string, prefill: Record<string, string>) => {
              handleTargetChange(childId);
              prefillRef.current = prefill;
              setValues(prefill);
            },
          }
        : null,
  };
}

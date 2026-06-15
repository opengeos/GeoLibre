import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import maplibregl from "maplibre-gl";
import type { MapController } from "@geolibre/map";
import { type GeoLibreLayer, useAppStore } from "@geolibre/core";
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
  buildProperties,
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
  validateForm,
  type Vertex,
} from "../../lib/field-collection";

interface FieldCollectionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mapControllerRef: React.RefObject<MapController | null>;
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
function syncDrawPreview(
  map: maplibregl.Map,
  geometry: GeometryType,
  verts: Vertex[],
): void {
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
  for (const id of [
    `${DRAW_SOURCE}-fill`,
    `${DRAW_SOURCE}-line`,
    `${DRAW_SOURCE}-pt`,
  ]) {
    if (map.getLayer(id)) map.removeLayer(id);
  }
  if (map.getSource(DRAW_SOURCE)) map.removeSource(DRAW_SOURCE);
}

/**
 * Radix locks `document.body { pointer-events: none }` while a modal dialog is
 * open and can leave it set after a programmatic close, which would stop the map
 * from receiving the capture click. Clear it whenever we hide the dialog to draw.
 */
function releaseBodyPointerEvents(): void {
  if (document.body.style.pointerEvents === "none") {
    document.body.style.pointerEvents = "";
  }
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
}: FieldCollectionDialogProps) {
  const { t } = useTranslation();
  const layers = useAppStore((s) => s.layers);
  const addGeoJsonLayer = useAppStore((s) => s.addGeoJsonLayer);
  const updateLayer = useAppStore((s) => s.updateLayer);

  const collectionLayers = useMemo(
    () => layers.filter((l) => isCollectionLayer(l)),
    [layers],
  );

  // Target layer: "" means "create a new layer" (the setup step is shown).
  const [layerId, setLayerId] = useState<string>("");
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
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);
  // Running count of features saved this session, shown in the notice. A ref so
  // bumping it neither re-renders nor runs a side effect inside a state updater.
  const savedCountRef = useRef(0);

  const markerRef = useRef<maplibregl.Marker | null>(null);
  // Set just before we reopen the dialog after a map capture, so the open-reset
  // effect below doesn't wipe the freshly captured geometry/form.
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
  // Bumped on each GPS request and on any other capture, so a slow GPS fix that
  // resolves after a newer capture is ignored instead of overwriting it.
  const gpsSeqRef = useRef(0);

  useEffect(() => {
    activeRef.current = open || picking || drawing;
  }, [open, picking, drawing]);

  // Allow creating again after returning to the "new layer" setup step.
  useEffect(() => {
    if (!layerId) creatingRef.current = false;
  }, [layerId]);

  const activeLayer = layerId
    ? (layers.find((l) => l.id === layerId) ?? null)
    : null;
  const schema: CollectionSchema | null = activeLayer
    ? getSchema(activeLayer)
    : null;
  const activeGeometry: GeometryType = activeLayer
    ? getGeometryType(activeLayer)
    : geometry;

  const getMap = useCallback(
    () => mapControllerRef.current?.getMap() ?? null,
    [mapControllerRef],
  );

  const clearMarker = useCallback(() => {
    markerRef.current?.remove();
    markerRef.current = null;
  }, []);

  const clearPreview = useCallback(() => {
    clearMarker();
    const map = getMap();
    if (map) removeDrawPreview(map);
  }, [clearMarker, getMap]);

  // Reset everything when the dialog opens; default to the first existing
  // collection layer if there is one, otherwise the "new layer" setup step.
  useEffect(() => {
    if (!open) return;
    // Reopened after a map capture — keep the captured state, skip the reset.
    if (suppressResetRef.current) {
      suppressResetRef.current = false;
      return;
    }
    const first = collectionLayers[0]?.id ?? "";
    setLayerId(first);
    setLayerName("");
    setGeometry("point");
    setDrafts(first ? [] : [makeDraft()]);
    setPending(null);
    setValues({});
    setPhoto(null);
    setVertices([]);
    verticesRef.current = [];
    setLocating(false);
    setErrors({});
    setNotice(null);
    savedCountRef.current = 0;
    // collectionLayers is derived from layers; intentionally snapshot on open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Tear down any preview when the dialog fully closes (not while drawing with
  // it intentionally hidden) and on unmount.
  useEffect(() => {
    if (!open && !picking && !drawing) clearPreview();
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
      showMarker(lng, lat);
      if (fly) recenter(lng, lat);
    },
    [showMarker, recenter],
  );

  // Closing cancels any in-flight GPS fix so its async callback can't act on a
  // dismissed dialog (the activeRef effect lags a render behind the close).
  const handleClose = useCallback(() => {
    gpsSeqRef.current += 1;
    onOpenChange(false);
  }, [onOpenChange]);

  const handlePickOnMap = useCallback(() => {
    if (!getMap()) return;
    gpsSeqRef.current += 1; // invalidate any in-flight GPS fix
    setLocating(false); // its callback bails, so clear the spinner here
    setPicking(true);
    onOpenChange(false);
  }, [getMap, onOpenChange]);

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
    setVerticesSynced([]);
    setNotice(null);
    const map = getMap();
    if (map) removeDrawPreview(map);
    suppressResetRef.current = true;
    onOpenChange(true);
  }, [getMap, onOpenChange, setVerticesSynced]);

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
    setVerticesSynced(verticesRef.current.slice(0, -1));
  }, [setVerticesSynced]);

  // ---- GPS (a point, or one vertex while drawing) ----------------------------

  const handleUseGps = useCallback(
    (asVertex: boolean) => {
      if (!("geolocation" in navigator)) {
        setNotice(t("fieldCollection.noGeolocation"));
        return;
      }
      setLocating(true);
      setNotice(null);
      const seq = (gpsSeqRef.current += 1);
      // Ignore a fix that resolves after the tool was dismissed or superseded by
      // a newer capture (e.g. the user picked/drew a point while GPS was pending).
      const stale = () => !activeRef.current || seq !== gpsSeqRef.current;
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          if (stale()) return;
          setLocating(false);
          const { longitude, latitude } = pos.coords;
          if (asVertex) {
            pushVertex(longitude, latitude);
            recenter(longitude, latitude);
          } else {
            // capturePoint(..., true) already recenters the map.
            capturePoint(longitude, latitude, true);
          }
        },
        () => {
          if (stale()) return;
          setLocating(false);
          setNotice(t("fieldCollection.geolocationDenied"));
        },
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 },
      );
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
      const reader = new FileReader();
      reader.onerror = () => setNotice(t("fieldCollection.photoReadError"));
      reader.onload = () => {
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
    setLayerId(id);
    setNotice(null);
  }, [drafts, layerName, geometry, addGeoJsonLayer, updateLayer, t]);

  const handleSave = useCallback(() => {
    if (!activeLayer || !schema || !pending) return;
    const result = validateForm(schema, values);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    const extra: Record<string, unknown> = {};
    if (photo) extra[PHOTO_PROPERTY] = photo;
    const props = buildProperties(schema, values, extra);
    const feature = buildGeometryFeature(activeGeometry, pending, props);

    const current = useAppStore
      .getState()
      .layers.find((l) => l.id === activeLayer.id);
    if (!current) {
      // The collection layer was removed while the form was open — don't claim
      // a save that silently goes nowhere.
      setNotice(t("fieldCollection.layerGone"));
      return;
    }
    const fc = current.geojson ?? emptyFeatureCollection();
    updateLayer(activeLayer.id, { geojson: appendFeature(fc, feature) });

    savedCountRef.current += 1;
    setNotice(
      t(`fieldCollection.saved.${activeGeometry}`, {
        count: savedCountRef.current,
        layer: activeLayer.name,
      }),
    );
    setPending(null);
    setValues({});
    setPhoto(null);
    setVertices([]);
    verticesRef.current = [];
    setErrors({});
    clearPreview();
  }, [
    activeLayer,
    schema,
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

  // Quick-access control on the map: once a collection layer exists, surface a
  // floating button so users can reopen the tool without the Controls menu
  // during a collection session. Hidden while capturing (dialog reopens itself).
  const showQuickOpen =
    !open && !picking && !drawing && collectionLayers.length > 0;

  return (
    <>
      {showQuickOpen && (
        <button
          type="button"
          onClick={() => onOpenChange(true)}
          aria-label={t("fieldCollection.reopen")}
          className="fixed bottom-6 left-1/2 z-40 flex -translate-x-1/2 items-center gap-2 rounded-full border bg-card px-4 py-2 text-sm font-medium shadow-lg transition-colors hover:bg-accent"
        >
          <ClipboardList className="h-4 w-4 text-primary" />
          {t("fieldCollection.title")}
        </button>
      )}

      {drawing && (
        <DrawToolbar
          geometry={activeGeometry}
          count={vertices.length}
          minCount={minVertices(activeGeometry)}
          locating={locating}
          onAddGps={() => handleUseGps(true)}
          onUndo={handleUndoVertex}
          onFinish={() => finishDrawing(vertices)}
          onCancel={handleCancelDrawing}
        />
      )}

      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("fieldCollection.title")}</DialogTitle>
            <DialogDescription>
              {t("fieldCollection.description")}
            </DialogDescription>
          </DialogHeader>

          <ScrollArea className="max-h-[60vh] pr-3">
            <div className="space-y-4 py-1">
              <div className="space-y-1.5">
                <Label>{t("fieldCollection.targetLayer")}</Label>
                <Select
                  value={layerId}
                  onChange={(e) => {
                    setLayerId(e.target.value);
                    setPending(null);
                    setValues({});
                    setPhoto(null);
                    setVertices([]);
                    verticesRef.current = [];
                    clearPreview();
                    setErrors({});
                    setNotice(null);
                    if (!e.target.value && drafts.length === 0) {
                      setDrafts([makeDraft()]);
                    }
                  }}
                >
                  {collectionLayers.map((l: GeoLibreLayer) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                  <option value="">{t("fieldCollection.newLayer")}</option>
                </Select>
              </div>

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
                  pending={pending}
                  values={values}
                  setValue={setValue}
                  errors={errors}
                  errorText={errorText}
                  photo={photo}
                  onPhoto={handlePhoto}
                  onRemovePhoto={() => setPhoto(null)}
                  locating={locating}
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

          <div className="flex justify-end">
            <Button variant="outline" onClick={handleClose}>
              {t("common.close")}
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
  onAddGps,
  onUndo,
  onFinish,
  onCancel,
}: DrawToolbarProps) {
  const { t } = useTranslation();
  const ready = count >= minCount;
  return (
    <div className="fixed bottom-6 left-1/2 z-50 flex max-w-[95vw] -translate-x-1/2 flex-col gap-2 rounded-lg border bg-card p-3 shadow-xl">
      <div className="flex items-center gap-2 text-sm">
        <Pencil className="h-4 w-4 text-primary" />
        <span className="font-medium">{t(`fieldCollection.geom.${geometry}`)}</span>
        <span className="text-muted-foreground">
          {ready
            ? t("fieldCollection.vertices", { count })
            : t("fieldCollection.needMore", { min: minCount })}
        </span>
      </div>
      <p className="text-xs text-muted-foreground">
        {t("fieldCollection.dblClickHint")}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onClick={onAddGps} disabled={locating}>
          {locating ? (
            <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
          ) : (
            <Navigation className="mr-1 h-3.5 w-3.5" />
          )}
          {t("fieldCollection.addGpsVertex")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={onUndo}
          disabled={count === 0}
        >
          <Undo2 className="mr-1 h-3.5 w-3.5" />
          {t("fieldCollection.undo")}
        </Button>
        <Button size="sm" onClick={onFinish} disabled={!ready}>
          <Check className="mr-1 h-3.5 w-3.5" />
          {t("fieldCollection.finish")}
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>
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
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onDrafts([...drafts, newDraft()])}
        >
          <Plus className="mr-1 h-3.5 w-3.5" />
          {t("fieldCollection.addField")}
        </Button>
      </div>

      {drafts.length === 0 && (
        <p className="text-sm text-muted-foreground">
          {t("fieldCollection.noFields")}
        </p>
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
                onChange={(e) =>
                  update(d.id, { type: e.target.value as FieldType })
                }
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
        <MapPin className="mr-2 h-4 w-4" />
        {t("fieldCollection.createLayer")}
      </Button>
    </div>
  );
}

interface CaptureStepProps {
  geometry: GeometryType;
  schema: CollectionSchema;
  pending: Vertex[] | null;
  values: Record<string, string>;
  setValue: (key: string, value: string) => void;
  errors: Record<string, string>;
  errorText: (code: string | undefined) => string | null;
  photo: string | null;
  onPhoto: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onRemovePhoto: () => void;
  locating: boolean;
  onUseGps: () => void;
  onPickOnMap: () => void;
  onStartDrawing: () => void;
  onSave: () => void;
}

function CaptureStep({
  geometry,
  schema,
  pending,
  values,
  setValue,
  errors,
  errorText,
  photo,
  onPhoto,
  onRemovePhoto,
  locating,
  onUseGps,
  onPickOnMap,
  onStartDrawing,
  onSave,
}: CaptureStepProps) {
  const { t } = useTranslation();
  const isPoint = geometry === "point";

  return (
    <div className="space-y-3">
      {isPoint ? (
        <div className="grid grid-cols-2 gap-2">
          <Button variant="outline" onClick={onUseGps} disabled={locating}>
            {locating ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Navigation className="mr-2 h-4 w-4" />
            )}
            {locating ? t("fieldCollection.locating") : t("fieldCollection.useGps")}
          </Button>
          <Button variant="outline" onClick={onPickOnMap}>
            <Crosshair className="mr-2 h-4 w-4" />
            {t("fieldCollection.pickOnMap")}
          </Button>
        </div>
      ) : (
        <Button variant="outline" className="w-full" onClick={onStartDrawing}>
          <Pencil className="mr-2 h-4 w-4" />
          {t("fieldCollection.drawOnMap")}
        </Button>
      )}

      {!pending ? (
        <p className="text-sm text-muted-foreground">
          {isPoint
            ? t("fieldCollection.captureHint")
            : t("fieldCollection.drawHint")}
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
            const err = errorText(errors[field.key]);
            return (
              <div key={field.key} className="space-y-1.5">
                <Label htmlFor={`fc-${field.key}`}>
                  {field.label}
                  {field.required && (
                    <span className="ml-0.5 text-destructive">*</span>
                  )}
                </Label>
                {field.type === "choice" && field.options?.length ? (
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
                      field.type === "number"
                        ? "number"
                        : field.type === "date"
                          ? "date"
                          : "text"
                    }
                    value={values[field.key] ?? ""}
                    onChange={(e) => setValue(field.key, e.target.value)}
                  />
                )}
                {err && <p className="text-xs text-destructive">{err}</p>}
              </div>
            );
          })}

          <div className="space-y-1.5">
            <Label htmlFor="fc-photo">{t("fieldCollection.photo")}</Label>
            {photo ? (
              <div className="flex items-center gap-2">
                <img
                  src={photo}
                  alt={t("fieldCollection.photo")}
                  className="h-16 w-16 rounded-md object-cover"
                />
                <Button variant="ghost" size="sm" onClick={onRemovePhoto}>
                  <X className="mr-1 h-3.5 w-3.5" />
                  {t("fieldCollection.removePhoto")}
                </Button>
              </div>
            ) : (
              // No `capture` attribute: let the user pick an existing photo or
              // take a new one (capture="environment" forces the camera on iOS).
              <Input
                id="fc-photo"
                type="file"
                accept="image/*"
                onChange={onPhoto}
              />
            )}
          </div>

          <Button className="w-full" onClick={onSave}>
            <Save className="mr-2 h-4 w-4" />
            {t(`fieldCollection.save.${geometry}`)}
          </Button>
        </>
      )}
    </div>
  );
}

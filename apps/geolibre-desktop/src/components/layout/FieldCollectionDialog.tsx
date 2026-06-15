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
  Crosshair,
  Loader2,
  MapPin,
  Navigation,
  Plus,
  Save,
  Trash2,
  X,
} from "lucide-react";
import {
  appendFeature,
  buildProperties,
  buildSchema,
  collectionMetadata,
  type CollectionSchema,
  dataUrlByteLength,
  emptyFeatureCollection,
  type FieldType,
  getSchema,
  isCollectionLayer,
  makePointFeature,
  MAX_PHOTO_BYTES,
  parseOptions,
  PHOTO_PROPERTY,
  validateForm,
} from "../../lib/field-collection";

interface FieldCollectionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mapControllerRef: React.RefObject<MapController | null>;
}

const FIELD_TYPES: FieldType[] = ["text", "number", "date", "choice"];

interface DraftField {
  id: number;
  label: string;
  type: FieldType;
  required: boolean;
  optionsText: string;
}

let draftCounter = 0;
function newDraftField(): DraftField {
  draftCounter += 1;
  return { id: draftCounter, label: "", type: "text", required: false, optionsText: "" };
}

function formatLatLng(lng: number, lat: number): string {
  return `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
}

/**
 * Field Collection: capture point observations against a custom attribute form,
 * placing each by GPS or by tapping the map. Points are written to a tagged
 * `geojson` collection layer in the store, so they persist in the project, show
 * in the attribute table, export, and work offline. Designed mobile-first to pair
 * with the native Android build and the offline tile cache.
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
  const [drafts, setDrafts] = useState<DraftField[]>([]);

  // Capture state.
  const [pending, setPending] = useState<{ lng: number; lat: number } | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [photo, setPhoto] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [locating, setLocating] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [savedCount, setSavedCount] = useState(0);

  const markerRef = useRef<maplibregl.Marker | null>(null);

  const activeLayer = layerId
    ? (layers.find((l) => l.id === layerId) ?? null)
    : null;
  const schema: CollectionSchema | null = activeLayer
    ? getSchema(activeLayer)
    : null;

  // Reset everything when the dialog opens; default to the first existing
  // collection layer if there is one, otherwise the "new layer" setup step.
  useEffect(() => {
    if (!open) return;
    const first = collectionLayers[0]?.id ?? "";
    setLayerId(first);
    setLayerName("");
    setDrafts(first ? [] : [newDraftField()]);
    setPending(null);
    setValues({});
    setPhoto(null);
    setPicking(false);
    setLocating(false);
    setErrors({});
    setNotice(null);
    setSavedCount(0);
    // collectionLayers is derived from layers; intentionally snapshot on open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Clean up the preview marker when the dialog closes or unmounts.
  const clearMarker = useCallback(() => {
    markerRef.current?.remove();
    markerRef.current = null;
  }, []);
  useEffect(() => {
    if (!open) clearMarker();
  }, [open, clearMarker]);
  useEffect(() => () => clearMarker(), [clearMarker]);

  // Show / move a transient marker at the pending capture location.
  const showMarker = useCallback(
    (lng: number, lat: number) => {
      const map = mapControllerRef.current?.getMap();
      if (!map) return;
      if (markerRef.current) {
        markerRef.current.setLngLat([lng, lat]);
      } else {
        markerRef.current = new maplibregl.Marker({ color: "#ef4444" })
          .setLngLat([lng, lat])
          .addTo(map);
      }
    },
    [mapControllerRef],
  );

  const captureAt = useCallback(
    (lng: number, lat: number, recenter: boolean) => {
      setPending({ lng, lat });
      setErrors({});
      setNotice(null);
      showMarker(lng, lat);
      if (recenter) {
        mapControllerRef.current?.flyTo({
          center: [lng, lat],
          zoom: Math.max(mapControllerRef.current?.getMap()?.getZoom() ?? 0, 15),
        });
      }
    },
    [mapControllerRef, showMarker],
  );

  // Pick-on-map: hide the modal so the map is clickable, arm a one-shot click.
  const handlePickOnMap = useCallback(() => {
    if (!mapControllerRef.current?.getMap()) return;
    setPicking(true);
    onOpenChange(false);
  }, [mapControllerRef, onOpenChange]);

  useEffect(() => {
    if (!picking) return;
    const map = mapControllerRef.current?.getMap();
    if (!map) {
      setPicking(false);
      return;
    }
    const prevCursor = map.getCanvas().style.cursor;
    map.getCanvas().style.cursor = "crosshair";
    const handler = (e: maplibregl.MapMouseEvent) => {
      captureAt(e.lngLat.lng, e.lngLat.lat, false);
      setPicking(false);
      onOpenChange(true);
    };
    map.once("click", handler);
    return () => {
      map.off("click", handler);
      map.getCanvas().style.cursor = prevCursor;
    };
  }, [picking, mapControllerRef, onOpenChange, captureAt]);

  const handleUseGps = useCallback(() => {
    if (!("geolocation" in navigator)) {
      setNotice(t("fieldCollection.noGeolocation"));
      return;
    }
    setLocating(true);
    setNotice(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        captureAt(pos.coords.longitude, pos.coords.latitude, true);
      },
      () => {
        setLocating(false);
        setNotice(t("fieldCollection.geolocationDenied"));
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 },
    );
  }, [t, captureAt]);

  const handlePhoto = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = ""; // allow re-selecting the same file
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = typeof reader.result === "string" ? reader.result : "";
        if (dataUrlByteLength(dataUrl) > MAX_PHOTO_BYTES) {
          setNotice(
            t("fieldCollection.photoTooLarge", {
              max: `${Math.round(MAX_PHOTO_BYTES / (1024 * 1024))} MB`,
            }),
          );
          return;
        }
        setPhoto(dataUrl);
        setNotice(null);
      };
      reader.readAsDataURL(file);
    },
    [t],
  );

  // Create the collection layer from the draft schema and switch into capture mode.
  const handleCreateLayer = useCallback(() => {
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
    updateLayer(id, { metadata: collectionMetadata(collectionSchema) });
    setLayerId(id);
    setNotice(null);
  }, [drafts, layerName, addGeoJsonLayer, updateLayer, t]);

  const handleSavePoint = useCallback(() => {
    if (!activeLayer || !schema || !pending) return;
    const result = validateForm(schema, values);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    const extra: Record<string, unknown> = {};
    if (photo) extra[PHOTO_PROPERTY] = photo;
    const props = buildProperties(schema, values, extra);
    const feature = makePointFeature(pending.lng, pending.lat, props);

    // Read the layer fresh from the store so we append to the latest features.
    const current = useAppStore
      .getState()
      .layers.find((l) => l.id === activeLayer.id);
    const fc = current?.geojson ?? emptyFeatureCollection();
    updateLayer(activeLayer.id, { geojson: appendFeature(fc, feature) });

    setSavedCount((n) => n + 1);
    setNotice(
      t("fieldCollection.saved", {
        count: savedCount + 1,
        layer: activeLayer.name,
      }),
    );
    // Clear the form for the next capture but keep the chosen layer.
    setPending(null);
    setValues({});
    setPhoto(null);
    setErrors({});
    clearMarker();
  }, [
    activeLayer,
    schema,
    pending,
    values,
    photo,
    updateLayer,
    savedCount,
    t,
    clearMarker,
  ]);

  const setValue = (key: string, value: string) =>
    setValues((v) => ({ ...v, [key]: value }));

  const errorText = (code: string | undefined): string | null => {
    if (!code) return null;
    if (code === "required") return t("fieldCollection.errorRequired");
    if (code === "number") return t("fieldCollection.errorNumber");
    if (code === "choice") return t("fieldCollection.errorChoice");
    return null;
  };

  const inSetup = !activeLayer;

  return (
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
            {/* Target layer selector */}
            <div className="space-y-1.5">
              <Label>{t("fieldCollection.targetLayer")}</Label>
              <Select
                value={layerId}
                onChange={(e) => {
                  setLayerId(e.target.value);
                  setPending(null);
                  setValues({});
                  setPhoto(null);
                  setErrors({});
                  setNotice(null);
                  if (!e.target.value && drafts.length === 0) {
                    setDrafts([newDraftField()]);
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
                drafts={drafts}
                onDrafts={setDrafts}
                onCreate={handleCreateLayer}
              />
            ) : (
              <CaptureStep
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
                onUseGps={handleUseGps}
                onPickOnMap={handlePickOnMap}
                onSave={handleSavePoint}
              />
            )}

            {notice && (
              <p className="rounded-md bg-muted p-2 text-sm text-muted-foreground">
                {notice}
              </p>
            )}
          </div>
        </ScrollArea>

        <div className="flex justify-end">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.close")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

interface SetupStepProps {
  layerName: string;
  onLayerName: (v: string) => void;
  drafts: DraftField[];
  onDrafts: (next: DraftField[]) => void;
  onCreate: () => void;
}

function SetupStep({
  layerName,
  onLayerName,
  drafts,
  onDrafts,
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

      <Separator />

      <div className="flex items-center justify-between">
        <Label>{t("fieldCollection.fields")}</Label>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onDrafts([...drafts, newDraftField()])}
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
  schema: CollectionSchema;
  pending: { lng: number; lat: number } | null;
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
  onSave: () => void;
}

function CaptureStep({
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
  onSave,
}: CaptureStepProps) {
  const { t } = useTranslation();
  return (
    <div className="space-y-3">
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

      {!pending ? (
        <p className="text-sm text-muted-foreground">
          {t("fieldCollection.captureHint")}
        </p>
      ) : (
        <>
          <div className="flex items-center gap-2 rounded-md bg-muted p-2 text-sm">
            <MapPin className="h-4 w-4 shrink-0 text-primary" />
            <span className="tabular-nums">
              {formatLatLng(pending.lng, pending.lat)}
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
            <Label>{t("fieldCollection.photo")}</Label>
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
              <Input
                type="file"
                accept="image/*"
                capture="environment"
                onChange={onPhoto}
              />
            )}
          </div>

          <Button className="w-full" onClick={onSave}>
            <Save className="mr-2 h-4 w-4" />
            {t("fieldCollection.savePoint")}
          </Button>
        </>
      )}
    </div>
  );
}

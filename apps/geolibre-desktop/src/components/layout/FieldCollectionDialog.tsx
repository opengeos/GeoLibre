import { useId, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { AttributeFormConfig } from "@geolibre/core";
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
  buildPropertiesWithForm,
  type CollectionPhoto,
  type CollectionSchema,
  type FieldType,
  type GeometryType,
  type Vertex,
} from "../../lib/field-collection";
import {
  useFieldCollectionController,
  type DraftField,
  type FieldCollectionControllerOptions,
} from "../../hooks/useFieldCollectionController";
import { FieldCollectionFormFields } from "./FieldCollectionFormFields";
import { FieldCollectionRelated } from "./FieldCollectionRelated";
import { formatAccuracy, type GpsFix } from "../../lib/gps-tracking";

const FIELD_TYPES: FieldType[] = ["text", "number", "date", "choice"];
const GEOMETRY_TYPES: GeometryType[] = ["point", "line", "polygon"];

function formatLatLng(lng: number, lat: number): string {
  return `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
}

/**
 * Render point, line, and polygon capture against a custom attribute form.
 * Tagged GeoJSON collection layers persist observations in the project for
 * attribute tables, export, and offline use.
 */
export function FieldCollectionDialog({ open, ...options }: FieldCollectionControllerOptions) {
  const { t } = useTranslation();
  const model = useFieldCollectionController({ open, ...options });
  const targetLayerId = useId();
  // Use the map surface's portal so these controls follow the visible map
  // center as shell panels open and close.
  const overlays = (
    <>
      {/* w-max avoids shrinking the pill into the half-width after left-1/2,
          which otherwise clips its layer name too early. */}
      {model.quickOpen && (
        <button
          type="button"
          onClick={model.onReopen}
          aria-label={model.reopenLabel}
          className="absolute bottom-6 left-1/2 z-40 flex w-max max-w-[90%] -translate-x-1/2 items-center gap-2 rounded-full border bg-card px-4 py-2 text-sm font-medium shadow-lg transition-colors hover:bg-accent"
        >
          <ClipboardList className="h-4 w-4 shrink-0 text-primary" />
          <span className="shrink-0">{t("fieldCollection.title")}</span>
          {model.activeLayerName && (
            <span className="min-w-0 truncate text-muted-foreground">{model.activeLayerName}</span>
          )}
        </button>
      )}
      {model.draw && <DrawToolbar {...model.draw} />}
      {model.pick && <PickBanner {...model.pick} />}
    </>
  );
  return (
    <>
      {model.portalHost ? createPortal(overlays, model.portalHost) : null}
      <Dialog open={open} onOpenChange={model.onDialogOpenChange}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("fieldCollection.title")}</DialogTitle>
            <DialogDescription>{model.description}</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor={targetLayerId}>{t("fieldCollection.targetLayer")}</Label>
            <Select
              id={targetLayerId}
              value={model.target.selected}
              onChange={(event) => model.target.onChange(event.target.value)}
            >
              {model.target.layers.map((layer) => (
                <option key={layer.id} value={layer.id}>
                  {layer.name}
                </option>
              ))}
              <option value="">{t("fieldCollection.newLayer")}</option>
            </Select>
          </div>
          <ScrollArea className="max-h-[60vh] pe-3">
            <div className="space-y-4 py-1">
              {model.capture ? <CaptureStep {...model.capture} /> : <SetupStep {...model.setup} />}
              {model.related && <FieldCollectionRelated {...model.related} />}
              {model.notice && (
                <p
                  aria-live="polite"
                  className="rounded-md bg-muted p-2 text-sm text-muted-foreground"
                >
                  {model.notice}
                </p>
              )}
            </div>
          </ScrollArea>
          <div className="flex justify-end">
            {/* Done ends the session; dismissing the dialog preserves it. */}
            <Button variant="outline" onClick={model.onDone}>
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
  /** Identifies the record being filled in; changes on save and on a new target. */
  captureKey: string;
  /**
   * A photo field started (+1) or finished (-1) reading a picture; Save waits
   * for it. A completion can report an error after the input unmounts.
   */
  onAttachmentReading: (delta: 1 | -1, readId: number, error?: string) => void;
  values: Record<string, string>;
  setValue: (key: string, value: string) => void;
  errors: Record<string, string>;
  errorText: (code: string | undefined) => string | null;
  photos: CollectionPhoto[];
  readingPhotos: boolean;
  onPhotos: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onRemovePhoto: (index: number) => void;
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
  captureKey,
  onAttachmentReading,
  values,
  setValue,
  errors,
  errorText,
  photos,
  readingPhotos,
  onPhotos,
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
      {geometry === "none" ? null : isPoint ? (
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
          {geometry !== "none" && (
            <div className="flex items-center gap-2 rounded-md bg-muted p-2 text-sm">
              <MapPin className="h-4 w-4 shrink-0 text-primary" />
              <span className="tabular-nums">
                {isPoint
                  ? formatLatLng(pending[0][0], pending[0][1])
                  : t("fieldCollection.vertices", { count: pending.length })}
              </span>
            </div>
          )}

          <FieldCollectionFormFields
            schema={schema}
            attributeForm={attributeForm}
            candidateProps={candidateProps}
            values={values}
            setValue={setValue}
            errors={errors}
            errorText={errorText}
            captureKey={captureKey}
            onReadingChange={onAttachmentReading}
          />

          {/* Save sits above the optional photo so the primary action is
              reachable without scrolling past the upload, and the photo reads
              as the optional extra it is (#711). */}
          <Button className="w-full" onClick={onSave} disabled={readingPhotos}>
            <Save className="me-2 h-4 w-4" />
            {t(`fieldCollection.save.${geometry}`)}
          </Button>

          <div className="space-y-1.5">
            <Label htmlFor="fc-optional-photo">{t("fieldCollection.photoOptional")}</Label>
            {photos.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {photos.map((photo, index) => (
                  <div key={`${photo.src}-${index}`} className="relative">
                    <img
                      src={photo.src}
                      alt={photo.name || t("fieldCollection.photo")}
                      className="h-16 w-16 rounded-md object-cover"
                    />
                    <Button
                      type="button"
                      variant="secondary"
                      size="icon"
                      className="absolute end-0 top-0 h-6 w-6"
                      aria-label={`${t("fieldCollection.removePhoto")} (${index + 1}${photo.name ? `: ${photo.name}` : ""})`}
                      onClick={() => onRemovePhoto(index)}
                    >
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
            {/* No `capture` attribute: let the user pick existing photos or take
                a new one (capture="environment" forces the camera on iOS). */}
            <input
              ref={photoInputRef}
              id="fc-optional-photo"
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={onPhotos}
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

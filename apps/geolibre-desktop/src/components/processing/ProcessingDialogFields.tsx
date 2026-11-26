// Parameter inputs for the Whitebox toolbox dialog: the per-parameter field, extent group, distance and number inputs, and layer/path pickers.

import type { GeoLibreLayer } from "@geolibre/core";
import { normalizeVectorOutputFormat, type WhiteboxToolParameter } from "@geolibre/processing";
import { Button, Input, Label, Select } from "@geolibre/ui";
import { ChevronDown, ChevronUp, FolderOpen, Save, Scan, SquareDashed } from "lucide-react";
import { type ChangeEvent, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  isTauri,
  openLocalDataFileWithFallback,
  openLocalDataFilesWithFallback,
  pickLocalPathWithFallback,
  pickLocalPathsWithFallback,
  pickSavePathWithFallback,
} from "../../lib/tauri-io";
import { layersForSubsetUrl } from "../../lib/subset-tool-url";
import {
  DISTANCE_UNITS,
  parseDistanceInput,
  type DistanceUnit,
} from "../../lib/whitebox-distance-params";
import {
  isDirectoryParameter,
  isMultipleDatasetParameter,
  parameterKind,
} from "../../lib/whitebox-param-kind";
import { canUseLayerForParameter } from "../../lib/whitebox-layer-inputs";
import { CrsPickerInput } from "./CrsPickerInput";
import {
  whiteboxParameterLabel,
  humanizeParameterName,
  translateWhiteboxParameterDescription,
} from "../../lib/processing-tool-i18n";
import {
  LAYER_TOKEN_PREFIX,
  acceptForParameter,
  defaultOutputName,
  isCrsParameter,
  isDataInputParameter,
  isOutputParameter,
  isPathParameter,
  pathFiltersForParameter,
  type ParameterValues,
} from "../../lib/processing-params";
import {
  distanceDraftForUnit,
  distanceDraftToStored,
  extentKindLabel,
  latitudeLabelKey,
  stepNumberValue,
} from "../../lib/processing-dialog-model";

const EXTENT_GROUP_LABEL_ID = "whitebox-extent-label";

// Short label per boundary field. The parameter descriptions ("West boundary
// longitude (EPSG:4326).") are too long to sit over a half-width box, and they
// repeat the CRS four times; the full text stays as the field's tooltip.
const EXTENT_LABEL_KEYS = {
  north: "processing.whitebox.extentNorth",
  south: "processing.whitebox.extentSouth",
  west: "processing.whitebox.extentWest",
  east: "processing.whitebox.extentEast",
} as const;

interface ExtentParameterGroupProps {
  /** The tool whose boundary parameters are rendered; used for i18n keys. */
  toolId: string;
  /** The tool's four boundary parameters, in reading order. */
  params: WhiteboxToolParameter[];
  values: ParameterValues;
  onChange: (name: string, value: unknown) => void;
  /** Fills all four fields (and the extent CRS) from the current map view. */
  onUseMapExtent: () => void;
  /** Fills them by rubber-banding a box on the map. */
  onDrawMapExtent: () => void;
  /** Whether a draw is in progress (toggles the button's label/state). */
  drawingMapExtent: boolean;
}

/**
 * Area-of-interest control for a tool that takes its extent as four separate
 * boundary numbers (`download_osm_vector`). The four fields sit in one block
 * under a shared label, with the map shortcuts above them, so the box can be
 * picked from the map instead of typed a coordinate at a time (GeoLibre#1541).
 * Laid out like the Extract subset panel's bounding box, so the app's two extent
 * controls read the same.
 *
 * @param props - The boundary parameters, their current values, and the change /
 *   map-shortcut callbacks.
 */
export function ExtentParameterGroup({
  toolId,
  params,
  values,
  onChange,
  onUseMapExtent,
  onDrawMapExtent,
  drawingMapExtent,
}: ExtentParameterGroupProps) {
  const { t, i18n } = useTranslation();
  if (params.length === 0) return null;
  // One badge stands for all four fields, so it names every kind present rather
  // than the first field's: a tool that mixed an int boundary with double ones
  // would otherwise have three of them labelled by the wrong kind. (Each field
  // still takes its own stepper behavior from its own kind, below.)
  const kindLabel = extentKindLabel(params);

  return (
    // A labelled group rather than one field's label: the four boxes each carry
    // their own, so pointing this one at the first of them would leave that box
    // named "Area of interest North".
    <div className="grid gap-1.5" role="group" aria-labelledby={EXTENT_GROUP_LABEL_ID}>
      <div className="flex items-center justify-between gap-3">
        <span id={EXTENT_GROUP_LABEL_ID} className="text-sm font-medium leading-none">
          {t("processing.whitebox.extentLabel")}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">
          {kindLabel}
          {params.some((param) => param.required) ? t("processing.whitebox.requiredSuffix") : ""}
        </span>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onUseMapExtent}>
          <Scan className="h-3.5 w-3.5" aria-hidden="true" />
          {t("processing.whitebox.useMapExtent")}
        </Button>
        <Button
          type="button"
          variant={drawingMapExtent ? "secondary" : "outline"}
          size="sm"
          aria-pressed={drawingMapExtent}
          onClick={onDrawMapExtent}
        >
          <SquareDashed className="h-3.5 w-3.5" aria-hidden="true" />
          {drawingMapExtent
            ? t("processing.whitebox.drawingBbox")
            : t("processing.whitebox.drawBbox")}
        </Button>
      </div>
      {drawingMapExtent ? (
        <p className="text-xs text-muted-foreground">{t("processing.whitebox.drawBboxHint")}</p>
      ) : null}

      <div className="grid grid-cols-2 gap-2">
        {params.map((param) => {
          // EXTENT_LABEL_KEYS covers every name cornerExtentParameters can
          // return, so the humanized fallback is only a guard for a manifest
          // that renames a boundary: such a field keeps a readable label instead
          // of an empty one.
          const labelKey = EXTENT_LABEL_KEYS[param.name as keyof typeof EXTENT_LABEL_KEYS];
          const value = values[param.name];
          const description = translateWhiteboxParameterDescription(
            t,
            i18n.language,
            toolId,
            param,
          );
          return (
            <div key={param.name} className="grid gap-1">
              <Label
                htmlFor={`whitebox-${param.name}`}
                className="text-xs text-muted-foreground"
                title={description || undefined}
              >
                {labelKey ? t(labelKey) : humanizeParameterName(param.name)}
              </Label>
              <NumberStepperInput
                id={`whitebox-${param.name}`}
                integer={parameterKind(param) === "int"}
                value={value === undefined || value === null ? "" : String(value)}
                onChange={(next) => onChange(param.name, next)}
              />
            </div>
          );
        })}
      </div>
      <p className="text-xs text-muted-foreground">{t("processing.whitebox.extentHint")}</p>
    </div>
  );
}

interface ParameterFieldProps {
  param: WhiteboxToolParameter;
  layers: GeoLibreLayer[];
  /** Attribute names to offer for a `*_field` parameter; empty keeps it free text. */
  fieldOptions?: string[];
  /**
   * Reference latitude for a distance parameter whose input is a WGS84 map
   * layer, which turns the number box into a value + unit pair. Undefined
   * leaves it a plain number field.
   */
  degreeLatitude?: number;
  onChange: (value: unknown) => void;
  onPickFile?: (fileName: string, bytes: Uint8Array) => void;
  onPickFiles?: (files: Array<{ fileName: string; bytes: Uint8Array }>) => void;
  /** When set, renders a "Use map extent" button that fills this bbox field
   * (and its companion CRS) from the current map view. */
  onUseMapExtent?: () => void;
  /** When set, renders a "Draw on map" button that fills this bbox field by
   * rubber-banding a box on the map. */
  onDrawMapExtent?: () => void;
  /** Whether a draw is currently in progress (toggles the button's label/state). */
  drawingMapExtent?: boolean;
  /** When set, renders a "From layer" picker on this (`url`) field that fills it
   * (and any companion fields) from a compatible loaded raster layer. */
  onPopulateFromLayer?: (layer: GeoLibreLayer) => void;
  toolId: string;
  runLocal: boolean;
  value: unknown;
}

export function ParameterField({
  param,
  layers,
  fieldOptions,
  degreeLatitude,
  onChange,
  onPickFile,
  onPickFiles,
  onUseMapExtent,
  onDrawMapExtent,
  drawingMapExtent,
  onPopulateFromLayer,
  toolId,
  runLocal,
  value,
}: ParameterFieldProps) {
  const { t, i18n } = useTranslation();
  const kind = parameterKind(param);
  const availableLayers = layers.filter((layer) => canUseLayerForParameter(layer, param));
  // Loaded layers that can fill this subset `url` field, only computed for the
  // url param the dialog wired `onPopulateFromLayer` to.
  const subsetUrlLayers = onPopulateFromLayer ? layersForSubsetUrl(toolId, layers) : [];
  // Display text resolves through i18n, while the original manifest parameter
  // continues to feed the control-selection heuristics below.
  const label = whiteboxParameterLabel(t, i18n.language, toolId, param);
  const valueText = value === undefined || value === null ? "" : String(value);

  return (
    <div className="grid gap-1.5">
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor={`whitebox-${param.name}`}>{label}</Label>
        <span className="shrink-0 text-xs text-muted-foreground">
          {kind}
          {param.required && !isOutputParameter(param)
            ? t("processing.whitebox.requiredSuffix")
            : ""}
        </span>
      </div>

      {kind === "bool" ? (
        <label className="flex h-9 items-center gap-2 rounded-md border px-3 text-sm">
          <input
            id={`whitebox-${param.name}`}
            type="checkbox"
            checked={Boolean(value)}
            onChange={(event) => onChange(event.target.checked)}
          />
          {t("processing.whitebox.enabled")}
        </label>
      ) : param.options?.length ? (
        <Select
          id={`whitebox-${param.name}`}
          value={valueText}
          onChange={(event) => onChange(event.target.value)}
        >
          {!param.required && <option value="">{t("processing.whitebox.optionDefault")}</option>}
          {param.options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </Select>
      ) : isCrsParameter(param) ? (
        // Checked before the path and number branches (like the map-extent one
        // below): an EPSG code is a number, but a bare stepper walks to
        // unrelated systems, so this field gets the searchable CRS list instead
        // (GeoLibre#1538). Placed ahead of isPathParameter so an epsg
        // description that happens to mention a file can't shadow the picker.
        <CrsPickerInput id={`whitebox-${param.name}`} value={valueText} onChange={onChange} />
      ) : onUseMapExtent ? (
        // Checked before the path/data-input branches: once isMapExtentParameter
        // has identified this bbox field, the "Use map extent" affordance should
        // always win, even if the param's description happens to contain a word
        // (path/file/…) that isPathParameter's heuristic would otherwise match.
        <div className="grid gap-1.5">
          <Input
            id={`whitebox-${param.name}`}
            type="text"
            value={valueText}
            placeholder={t("processing.whitebox.mapExtentPlaceholder")}
            onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value)}
          />
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" size="sm" onClick={onUseMapExtent}>
              <Scan className="h-3.5 w-3.5" aria-hidden="true" />
              {t("processing.whitebox.useMapExtent")}
            </Button>
            {onDrawMapExtent ? (
              <Button
                type="button"
                variant={drawingMapExtent ? "secondary" : "outline"}
                size="sm"
                aria-pressed={drawingMapExtent}
                onClick={onDrawMapExtent}
              >
                <SquareDashed className="h-3.5 w-3.5" aria-hidden="true" />
                {drawingMapExtent
                  ? t("processing.whitebox.drawingBbox")
                  : t("processing.whitebox.drawBbox")}
              </Button>
            ) : null}
          </div>
          {drawingMapExtent ? (
            <p className="text-xs text-muted-foreground">{t("processing.whitebox.drawBboxHint")}</p>
          ) : null}
        </div>
      ) : onPopulateFromLayer && subsetUrlLayers.length > 0 ? (
        // A subset extractor's `url`, with loaded layers that can supply it: a
        // "From layer" picker fills the url (and companion fields) from a
        // COG/WMS/XYZ layer, while the field stays freely typeable. Placed
        // before the path/data-input branches (like the "Use map extent" one
        // above) so a `url` description that happens to contain a word
        // isPathParameter matches (path/file/…) can't shadow this picker into a
        // local file-browse control.
        <div className="grid grid-cols-[minmax(0,1fr)] gap-2 @sm/params:grid-cols-[minmax(150px,200px)_minmax(0,1fr)]">
          <Select
            aria-label={t("processing.whitebox.fromLayer")}
            value=""
            onChange={(event) => {
              const layer = subsetUrlLayers.find((item) => item.id === event.target.value);
              if (layer) onPopulateFromLayer(layer);
            }}
          >
            <option value="">{t("processing.whitebox.fromLayer")}</option>
            {subsetUrlLayers.map((layer) => (
              <option key={layer.id} value={layer.id}>
                {layer.name}
              </option>
            ))}
          </Select>
          <Input
            id={`whitebox-${param.name}`}
            type="text"
            value={valueText}
            onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value)}
          />
        </div>
      ) : isDataInputParameter(param) && isMultipleDatasetParameter(param) ? (
        <MultiLayerOrPathInput
          id={`whitebox-${param.name}`}
          label={label}
          layers={availableLayers}
          param={param}
          value={value}
          onChange={onChange}
          onPickFiles={onPickFiles}
        />
      ) : isDataInputParameter(param) && availableLayers.length > 0 ? (
        <LayerOrPathInput
          id={`whitebox-${param.name}`}
          label={label}
          layers={availableLayers}
          param={param}
          value={valueText}
          onChange={onChange}
          onPickFile={onPickFile}
        />
      ) : kind === "vector_out" && runLocal ? (
        // In WASM mode a vector output is either a WGS84 map layer (GeoJSON) or a
        // downloaded file in a CRS-preserving format that keeps a reprojection's
        // target CRS (which the map, being EPSG:4326, cannot show). Normalize the
        // value so a stale sidecar-mode output path doesn't leak into the Select.
        <div className="grid gap-1.5">
          <Select
            id={`whitebox-${param.name}`}
            value={normalizeVectorOutputFormat(valueText)}
            onChange={(event) => onChange(event.target.value)}
          >
            <option value="geojson">{t("processing.whitebox.output.geojson")}</option>
            <option value="geoparquet">{t("processing.whitebox.output.geoparquet")}</option>
            <option value="flatgeobuf">{t("processing.whitebox.output.flatgeobuf")}</option>
            <option value="shapefile">{t("processing.whitebox.output.shapefile")}</option>
          </Select>
          {normalizeVectorOutputFormat(valueText) !== "geojson" && (
            <p className="text-xs text-muted-foreground">
              {t("processing.whitebox.output.projectedHint")}
            </p>
          )}
        </div>
      ) : fieldOptions?.length ? (
        // A `*_field` parameter with a layer chosen for its vector input: offer
        // that layer's attribute names so the column need not be typed from
        // memory (GeoLibre#1459). The text box stays editable alongside the
        // picker, so a column the property sample missed can still be typed.
        <div className="grid grid-cols-[minmax(0,1fr)] gap-2 @sm/params:grid-cols-[minmax(150px,200px)_minmax(0,1fr)]">
          <Select
            aria-label={t("processing.whitebox.selectField")}
            value={fieldOptions.includes(valueText) ? valueText : ""}
            onChange={(event) => onChange(event.target.value)}
          >
            <option value="">{t("processing.whitebox.selectField")}</option>
            {fieldOptions.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </Select>
          <Input
            id={`whitebox-${param.name}`}
            type="text"
            value={valueText}
            placeholder={t("processing.whitebox.fieldName")}
            onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value)}
          />
        </div>
      ) : kind === "double" && degreeLatitude !== undefined ? (
        // A ground distance whose input is a WGS84 map layer: the tool measures
        // it in degrees, so pair the number box with a unit picker that converts
        // metres/km/feet/miles for the user (GeoLibre#1540). Placed ahead of
        // isPathParameter like the CRS and map-extent pickers above: that
        // fallback matches path/file/folder anywhere in a parameter's name or
        // description, so a distance whose wording mentions one would otherwise
        // render as a file browser.
        <DistanceInput
          id={`whitebox-${param.name}`}
          latitude={degreeLatitude}
          value={valueText}
          onChange={onChange}
        />
      ) : isPathParameter(param) ? (
        <PathPickerInput
          id={`whitebox-${param.name}`}
          param={param}
          toolId={toolId}
          value={valueText}
          onChange={onChange}
          onPickFile={onPickFile}
        />
      ) : kind === "int" || kind === "double" ? (
        <NumberStepperInput
          id={`whitebox-${param.name}`}
          integer={kind === "int"}
          value={valueText}
          onChange={onChange}
        />
      ) : (
        <Input
          id={`whitebox-${param.name}`}
          type="text"
          value={valueText}
          placeholder={isOutputParameter(param) ? t("processing.whitebox.auto") : undefined}
          onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value)}
        />
      )}

      {param.type && <p className="text-xs text-muted-foreground">{param.type}</p>}
    </div>
  );
}

interface NumberStepperInputProps {
  id: string;
  integer: boolean;
  onChange: (value: unknown) => void;
  value: string;
}

function NumberStepperInput({ id, integer, onChange, value }: NumberStepperInputProps) {
  const { t } = useTranslation();
  const updateByStep = (direction: 1 | -1) => onChange(stepNumberValue(value, integer, direction));

  return (
    <div className="grid grid-cols-[minmax(0,1fr)_2.25rem] overflow-hidden rounded-md border border-input bg-background shadow-xs focus-within:border-2 focus-within:border-ring">
      <input
        id={id}
        inputMode={integer ? "numeric" : "decimal"}
        className="h-9 min-w-0 border-0 bg-transparent px-3 py-1 text-sm outline-none disabled:cursor-not-allowed disabled:opacity-50"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      <div className="grid h-9 border-s">
        <button
          type="button"
          aria-label={t("processing.increaseValue")}
          className="flex h-[18px] items-center justify-center text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={() => updateByStep(1)}
        >
          <ChevronUp className="h-4 w-4" />
        </button>
        <button
          type="button"
          aria-label={t("processing.decreaseValue")}
          className="flex h-[18px] items-center justify-center border-t text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={() => updateByStep(-1)}
        >
          <ChevronDown className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

interface DistanceInputProps {
  id: string;
  /** Latitude the metric conversion is anchored at (the input layer's centre). */
  latitude: number;
  onChange: (value: unknown) => void;
  /** The stored parameter value, always in degrees. */
  value: string;
}

/**
 * A distance field with a unit picker, for a tool whose coordinates come from a
 * WGS84 map layer (GeoLibre#1540).
 *
 * The parameter itself is always stored in degrees, because that is what the
 * tool will read. Choosing metres (or km/ft/mi) keeps a local draft of what the
 * user typed and pushes the converted degrees up on every keystroke, so the
 * round trip through the conversion cannot rewrite the digits being typed. The
 * conversion varies with latitude and direction, so the field states the degree
 * value it produced and points at reprojection for exact work.
 */
function DistanceInput({ id, latitude, onChange, value }: DistanceInputProps) {
  const { t } = useTranslation();
  const [unit, setUnit] = useState<DistanceUnit>("degrees");
  // What the user typed, in `unit`. Only used while `unit` is not degrees; kept
  // out of the parameter so the stored value stays in the tool's own unit.
  const [draft, setDraft] = useState("");

  // What the metric box currently holds: a number to convert, or null when it is
  // empty or not a complete number (so nothing was converted).
  const draftValue = parseDistanceInput(draft);

  // The last value this field pushed up, so a `value` that changed for some
  // other reason (a re-run pre-filled from Processing History, say) can be told
  // apart from the field's own edits.
  const lastPushed = useRef(value);
  const push = (next: string) => {
    lastPushed.current = next;
    onChange(next);
  };

  const changeUnit = (next: DistanceUnit) => {
    setUnit(next);
    if (next === "degrees") {
      setDraft("");
      return;
    }
    // Carry the current distance over to the new unit rather than clearing it.
    // A stored value that is no number at all (malformed text a previous edit
    // pushed through verbatim) has no conversion to carry, so it moves across
    // as-is: blanking the box instead would leave the field looking empty while
    // Run still submitted the old text. Formatted to the same digits the stored
    // degrees were written with, so a precisely typed value survives a trip
    // through Degrees and back rather than coming back rounded.
    setDraft(distanceDraftForUnit(value, next, latitude));
  };

  const changeDraft = (text: string) => {
    setDraft(text);
    // Text that is not a complete number is stored verbatim rather than
    // converted, so a half-typed or malformed value fails at the tool instead of
    // being silently reinterpreted as a different distance.
    push(distanceDraftToStored(text, unit, latitude));
  };

  // Reconcile the field against changes it did not make itself. Both cases live
  // in one effect so their precedence is stated rather than left to the order
  // two effects happen to flush in: a Processing History re-run rewrites the
  // stored value *and* can rebind the input layer in a single `setValues`, and
  // as separate effects the latitude branch would still see the pre-reset `unit`
  // and `draft` from this render's closure and push a reconversion of the old
  // draft over the value the reset was restoring.
  const lastLatitude = useRef(latitude);
  useEffect(() => {
    const latitudeChanged = lastLatitude.current !== latitude;
    lastLatitude.current = latitude;
    if (value !== lastPushed.current) {
      // Someone else rewrote the parameter, so the typed draft and its unit
      // describe a distance that is no longer stored: show the degrees that are,
      // and let that win over any re-conversion.
      lastPushed.current = value;
      setUnit("degrees");
      setDraft("");
      return;
    }
    // The input layer moved under a metric entry: switching a tool's vector
    // input from a layer at 44°N to one at 10°N leaves the typed distance on
    // screen while the stored degrees still come from the old latitude, so the
    // note would show the new latitude beside a value converted at the old one
    // and Run would send the stale degrees.
    if (!latitudeChanged || unit === "degrees") return;
    if (parseDistanceInput(draft) === null) return;
    const next = distanceDraftToStored(draft, unit, latitude);
    lastPushed.current = next;
    onChange(next);
  }, [draft, latitude, onChange, unit, value]);

  // A hemisphere suffix only means something away from the equator, and a
  // worldwide layer's combined extent lands on 0.0 often enough for "0.0°N" to
  // read as a mistake.
  const latitudeKey = latitudeLabelKey(latitude);
  const latitudeLabel = t(latitudeKey.key, { latitude: latitudeKey.latitude });

  // Only claim a conversion when one actually happened. Text the field could not
  // read went through untouched, so saying it was "converted at 44.0°N" would
  // describe something the tool is about to reject.
  const conversionNote =
    draft.trim() === ""
      ? t("processing.distance.convertedEmpty", { latitude: latitudeLabel })
      : draftValue === null
        ? t("processing.distance.notANumber")
        : t("processing.distance.converted", {
            degrees: value,
            latitude: latitudeLabel,
          });

  return (
    <div className="grid gap-1.5">
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(120px,160px)] gap-2">
        {unit === "degrees" ? (
          // Routed through `push` like the metric box, so an edit made in
          // degrees keeps `lastPushed` accurate and does not read as an
          // outside rewrite to the reconcile effect below.
          <NumberStepperInput
            id={id}
            integer={false}
            value={value}
            onChange={(next) => push(String(next ?? ""))}
          />
        ) : (
          <Input
            id={id}
            inputMode="decimal"
            value={draft}
            onChange={(event: ChangeEvent<HTMLInputElement>) => changeDraft(event.target.value)}
          />
        )}
        <Select
          aria-label={t("processing.distance.unitLabel")}
          value={unit}
          onChange={(event) => changeUnit(event.target.value as DistanceUnit)}
        >
          {DISTANCE_UNITS.map((option) => (
            <option key={option} value={option}>
              {t(`processing.distance.units.${option}`)}
            </option>
          ))}
        </Select>
      </div>
      {unit !== "degrees" && <p className="text-xs text-muted-foreground">{conversionNote}</p>}
    </div>
  );
}

interface LayerOrPathInputProps {
  id: string;
  /** The parameter's visible label, which also names the layer picker. */
  label: string;
  layers: GeoLibreLayer[];
  onChange: (value: unknown) => void;
  onPickFile?: (fileName: string, bytes: Uint8Array) => void;
  param: WhiteboxToolParameter;
  value: string;
}

interface MultiLayerOrPathInputProps {
  id: string;
  label: string;
  layers: GeoLibreLayer[];
  onChange: (value: unknown) => void;
  onPickFiles?: (files: Array<{ fileName: string; bytes: Uint8Array }>) => void;
  param: WhiteboxToolParameter;
  value: unknown;
}

/** Dataset-list picker used by merge, overlay, statistics, and stack tools. */
function MultiLayerOrPathInput({
  id,
  label,
  layers,
  onChange,
  onPickFiles,
  param,
  value,
}: MultiLayerOrPathInputProps) {
  const { t } = useTranslation();
  const selected = Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
  const usingLayers = Array.isArray(value);
  return (
    <div className="grid gap-2">
      {layers.length > 0 ? (
        <div
          role="group"
          aria-label={label}
          className="grid max-h-40 gap-1 overflow-y-auto rounded-md border p-2"
        >
          {layers.map((layer) => {
            const token = `${LAYER_TOKEN_PREFIX}${layer.id}`;
            return (
              <label key={layer.id} className="flex items-center gap-2 rounded px-1 py-1 text-sm">
                <input
                  type="checkbox"
                  checked={selected.includes(token)}
                  onChange={(event) =>
                    onChange(
                      event.target.checked
                        ? [...selected, token]
                        : selected.filter((item) => item !== token),
                    )
                  }
                />
                <span className="truncate">{layer.name}</span>
              </label>
            );
          })}
        </div>
      ) : null}
      <div className="grid grid-cols-[minmax(0,1fr)_2.25rem] gap-2">
        <Input
          id={id}
          value={usingLayers ? "" : String(value ?? "")}
          placeholder={
            usingLayers ? t("processing.whitebox.selectedLayer") : t("processing.whitebox.filePath")
          }
          disabled={usingLayers && selected.length > 0}
          onChange={(event) => onChange(event.target.value)}
        />
        <PathBrowseButton
          disabled={usingLayers && selected.length > 0}
          mode="open"
          multiple
          param={param}
          onPick={(paths) => onChange(paths)}
          onPickFiles={onPickFiles}
        />
      </div>
    </div>
  );
}

function LayerOrPathInput({
  id,
  label,
  layers,
  onChange,
  onPickFile,
  param,
  value,
}: LayerOrPathInputProps) {
  const { t } = useTranslation();
  const usingLayer = value.startsWith(LAYER_TOKEN_PREFIX);
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_2.25rem] gap-2 @sm/params:grid-cols-[minmax(150px,200px)_minmax(0,1fr)_2.25rem]">
      {/* Three children, but the narrow template has only two columns, so the
          picker has to claim the whole first row explicitly. Left to
          auto-placement it lands in column 1, the path Input gets squeezed into
          the 2.25rem browse-button track, and the button wraps to a row of its
          own. The other two converted rows stack to a single column, where any
          child count is fine; this is the one that needs saying. */}
      <Select
        className="col-span-2 @sm/params:col-span-1"
        aria-label={t("processing.whitebox.layerFor", { name: label })}
        value={usingLayer ? value : ""}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">{t("processing.whitebox.optionPath")}</option>
        {layers.map((layer) => (
          <option key={layer.id} value={`${LAYER_TOKEN_PREFIX}${layer.id}`}>
            {layer.name}
          </option>
        ))}
      </Select>
      <Input
        id={id}
        value={usingLayer ? "" : value}
        placeholder={
          usingLayer ? t("processing.whitebox.selectedLayer") : t("processing.whitebox.filePath")
        }
        disabled={usingLayer}
        onChange={(event) => onChange(event.target.value)}
      />
      <PathBrowseButton
        disabled={usingLayer}
        mode="open"
        param={param}
        onPick={(path) => onChange(path)}
        onPickFile={onPickFile}
      />
    </div>
  );
}

interface PathPickerInputProps {
  id: string;
  onChange: (value: unknown) => void;
  onPickFile?: (fileName: string, bytes: Uint8Array) => void;
  param: WhiteboxToolParameter;
  toolId: string;
  value: string;
}

function PathPickerInput({ id, onChange, onPickFile, param, toolId, value }: PathPickerInputProps) {
  const { t } = useTranslation();
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_2.25rem] gap-2">
      <Input
        id={id}
        value={value}
        placeholder={
          isOutputParameter(param)
            ? t("processing.whitebox.auto")
            : t("processing.whitebox.filePath")
        }
        onChange={(event) => onChange(event.target.value)}
      />
      <PathBrowseButton
        mode={isOutputParameter(param) ? "save" : "open"}
        param={param}
        toolId={toolId}
        onPick={(path) => onChange(path)}
        onPickFile={onPickFile}
      />
    </div>
  );
}

interface PathBrowseButtonProps {
  disabled?: boolean;
  mode: "open" | "save";
  multiple?: boolean;
  onPick: (path: string) => void;
  onPickFile?: (fileName: string, bytes: Uint8Array) => void;
  onPickFiles?: (files: Array<{ fileName: string; bytes: Uint8Array }>) => void;
  param: WhiteboxToolParameter;
  toolId?: string;
}

function PathBrowseButton({
  disabled = false,
  mode,
  multiple = false,
  onPick,
  onPickFile,
  onPickFiles,
  param,
  toolId = "whitebox",
}: PathBrowseButtonProps) {
  const { t } = useTranslation();
  const pickPath = async () => {
    const filters = pathFiltersForParameter(param);
    if (mode === "save") {
      const path = await pickSavePathWithFallback({
        defaultName: defaultOutputName(toolId, param),
        filters,
      });
      if (path) onPick(path);
      return;
    }

    if (multiple) {
      const paths = await pickLocalPathsWithFallback({
        accept: acceptForParameter(param),
        filters,
      });
      if (paths.length > 0) {
        onPick(paths.join(","));
        return;
      }
      if (!isTauri() && onPickFiles) {
        const picked = await openLocalDataFilesWithFallback({
          accept: acceptForParameter(param),
          filters,
          readBinary: true,
        });
        if (picked.length > 0) {
          onPickFiles(
            picked.map((file) => ({
              fileName: file.path,
              bytes: new Uint8Array(file.data),
            })),
          );
        }
      }
      return;
    }

    const path = await pickLocalPathWithFallback({
      accept: acceptForParameter(param),
      directory: isDirectoryParameter(param),
      filters,
    });
    if (path) {
      onPick(path);
      return;
    }

    // The browser cannot expose a real filesystem path, so pickLocalPath returns
    // null there. Fall back to reading the chosen file's bytes for the in-browser
    // WASM runner. (Skipped under Tauri, where null just means the user
    // cancelled the native dialog, and for directory parameters.)
    if (!isTauri() && onPickFile && !isDirectoryParameter(param)) {
      const picked = await openLocalDataFileWithFallback({
        accept: acceptForParameter(param),
        filters,
        readBinary: true,
      });
      if (picked?.data) {
        onPickFile(picked.path, new Uint8Array(picked.data));
      }
    }
  };

  return (
    <Button
      type="button"
      variant="outline"
      size="icon"
      disabled={disabled}
      title={
        mode === "save"
          ? t("processing.whitebox.chooseOutputPath")
          : t("processing.whitebox.chooseInputPath")
      }
      onClick={() => void pickPath()}
    >
      {mode === "save" ? <Save className="h-4 w-4" /> : <FolderOpen className="h-4 w-4" />}
    </Button>
  );
}

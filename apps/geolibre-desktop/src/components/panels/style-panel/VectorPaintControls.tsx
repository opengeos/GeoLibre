import {
  DEFAULT_LAYER_STYLE,
  STROKE_DASH_PRESETS,
  VECTOR_COLOR_RAMPS,
  controlRendersLayer,
  isStrokeDashPattern,
  strokeBlurValue,
  strokeDashPresetName,
  strokeOpacityValue,
  styleValue,
  useAppStore,
  type GeoLibreLayer,
  type PointRenderer,
  type StrokeDashPreset,
  type StrokeWidthUnit,
  type VectorStyleMode,
} from "@geolibre/core";
import { ColorField, ColorRampSelect, Input, Label, Select, Separator } from "@geolibre/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { isControlPaintedVectorLayer } from "./layer-capabilities";
import { NumericFieldSelect, NumericStyleInput } from "./style-inputs";

interface VectorPaintControlsProps {
  layer: GeoLibreLayer;
  supportsPointRenderer: boolean;
  pointRenderer: PointRenderer;
  draftVectorStyleMode: VectorStyleMode;
  strokeWidthUnit: StrokeWidthUnit;
  strokeWidthInMeters: boolean;
  isSketchLayer: boolean;
  hasTextMarkerControls: boolean;
  numericPropertyOptions: string[];
}

/**
 * The 2D vector paint controls: the point renderer (single / heatmap /
 * cluster) and the fill, outline, width, opacity, radius and text-marker
 * settings.
 *
 * @param props - The layer and the renderer flags that gate each control.
 * @returns The 2D paint controls.
 */
export function VectorPaintControls({
  layer,
  supportsPointRenderer,
  pointRenderer,
  draftVectorStyleMode,
  strokeWidthUnit,
  strokeWidthInMeters,
  isSketchLayer,
  hasTextMarkerControls,
  numericPropertyOptions,
}: VectorPaintControlsProps) {
  const { t } = useTranslation();
  const setLayerStyle = useAppStore((s) => s.setLayerStyle);
  const { style } = layer;
  return (
    <>
      {supportsPointRenderer ? (
        <>
          <div className="space-y-2">
            <Label htmlFor="pointRenderer">{t("style.symbology.pointRenderer")}</Label>
            <Select
              id="pointRenderer"
              value={pointRenderer}
              onChange={(event) =>
                setLayerStyle(layer.id, {
                  pointRenderer: event.target.value as PointRenderer,
                })
              }
            >
              <option value="single">{t("style.symbology.pointRendererSingle")}</option>
              <option value="heatmap">{t("style.symbology.pointRendererHeatmap")}</option>
              <option value="cluster">{t("style.symbology.pointRendererClustered")}</option>
            </Select>
          </div>
          {pointRenderer === "heatmap" ? (
            <>
              {!controlRendersLayer(layer) ? (
                <>
                  <div className="space-y-2">
                    <Label htmlFor="heatmapColorRamp">{t("style.symbology.colormap")}</Label>
                    <ColorRampSelect
                      id="heatmapColorRamp"
                      aria-label={t("style.symbology.colormap")}
                      value={styleValue(style, "heatmapColorRamp")}
                      onValueChange={(heatmapColorRamp) =>
                        setLayerStyle(layer.id, { heatmapColorRamp })
                      }
                      ramps={VECTOR_COLOR_RAMPS}
                    />
                  </div>
                  <NumericFieldSelect
                    id="heatmapWeightProperty"
                    label={t("style.symbology.heatmapWeightField")}
                    value={styleValue(style, "heatmapWeightProperty")}
                    onSelect={(heatmapWeightProperty) =>
                      setLayerStyle(layer.id, { heatmapWeightProperty })
                    }
                    emptyLabel={t("style.symbology.heatmapEqualWeight")}
                    numericPropertyOptions={numericPropertyOptions}
                  />
                </>
              ) : null}
              <NumericStyleInput
                id="heatmapRadius"
                label={t("style.symbology.heatmapRadius")}
                min={1}
                max={100}
                step={1}
                value={styleValue(style, "heatmapRadius")}
                onChange={(heatmapRadius) => setLayerStyle(layer.id, { heatmapRadius })}
              />
              <NumericStyleInput
                id="heatmapIntensity"
                label={t("style.symbology.heatmapIntensity")}
                min={0.1}
                max={5}
                step={0.1}
                value={styleValue(style, "heatmapIntensity")}
                onChange={(heatmapIntensity) => setLayerStyle(layer.id, { heatmapIntensity })}
              />
            </>
          ) : null}
          {pointRenderer === "cluster" ? (
            <>
              <NumericStyleInput
                id="clusterRadius"
                label={t("style.symbology.clusterRadius")}
                min={10}
                max={200}
                step={5}
                value={styleValue(style, "clusterRadius")}
                onChange={(clusterRadius) => setLayerStyle(layer.id, { clusterRadius })}
              />
              <NumericStyleInput
                id="clusterMaxZoom"
                label={t("style.symbology.clusterMaxZoom")}
                min={0}
                max={24}
                step={1}
                value={styleValue(style, "clusterMaxZoom")}
                onChange={(clusterMaxZoom) => setLayerStyle(layer.id, { clusterMaxZoom })}
              />
            </>
          ) : null}
          <Separator />
        </>
      ) : null}
      {/* The heatmap renderer ignores fill/stroke/circle/data-driven styling, so
          hide those controls when it is selected. */}
      {pointRenderer === "heatmap" ? null : (
        <>
          {draftVectorStyleMode === "single" ? (
            <div className="space-y-2">
              <Label htmlFor="fillColor">{t("style.elevation3d.fillColor")}</Label>
              <ColorField
                id="fillColor"
                value={style.fillColor}
                onChange={(fillColor) => setLayerStyle(layer.id, { fillColor })}
                allowTransparent
                fallbackColor={DEFAULT_LAYER_STYLE.fillColor}
                transparentLabel={t("style.symbology.transparent")}
                transparentSwatchLabel={t("style.symbology.transparentSwatch")}
              />
            </div>
          ) : null}
          <div className="space-y-2">
            <Label htmlFor="strokeColor">{t("style.elevation3d.outlineColor")}</Label>
            <ColorField
              id="strokeColor"
              value={style.strokeColor}
              onChange={(strokeColor) => setLayerStyle(layer.id, { strokeColor })}
              allowTransparent
              fallbackColor={DEFAULT_LAYER_STYLE.strokeColor}
              transparentLabel={t("style.symbology.transparent")}
              transparentSwatchLabel={t("style.symbology.transparentSwatch")}
            />
          </div>
          <NumericStyleInput
            id="strokeWidth"
            label={
              strokeWidthInMeters
                ? t("style.elevation3d.strokeWidthMeters")
                : t("style.elevation3d.strokeWidth")
            }
            min={0}
            max={strokeWidthInMeters ? 100000 : 20}
            step={strokeWidthInMeters ? 1 : 0.5}
            value={style.strokeWidth}
            onChange={(strokeWidth) => setLayerStyle(layer.id, { strokeWidth })}
          />
          {/* The vector control draws widths in pixels only. */}
          {supportsPointRenderer || isControlPaintedVectorLayer(layer) ? null : (
            <div className="space-y-2">
              <Label htmlFor="strokeWidthUnit">{t("style.symbology.strokeWidthUnit")}</Label>
              <Select
                id="strokeWidthUnit"
                value={strokeWidthUnit}
                onChange={(event) => {
                  const nextUnit = event.target.value as StrokeWidthUnit;
                  // Meters and pixels are not freely convertible (pixel size
                  // depends on zoom), so a large meters width would render as a
                  // map-filling pixel width when switched back. Reset to the pixel
                  // default when leaving meters with an out-of-range value.
                  setLayerStyle(layer.id, {
                    strokeWidthUnit: nextUnit,
                    ...(nextUnit === "pixels" && style.strokeWidth > 20
                      ? { strokeWidth: DEFAULT_LAYER_STYLE.strokeWidth }
                      : {}),
                  });
                }}
              >
                <option value="pixels">{t("style.symbology.strokeWidthUnitPixels")}</option>
                <option value="meters">{t("style.symbology.strokeWidthUnitMeters")}</option>
              </Select>
            </div>
          )}
          {/* The vector control paints its own lines and takes none of these. */}
          {isControlPaintedVectorLayer(layer) ? null : (
            <NumericStyleInput
              id="strokeOpacity"
              label={t("style.symbology.strokeOpacity")}
              min={0}
              max={1}
              step={0.05}
              value={strokeOpacityValue(style)}
              onChange={(strokeOpacity) => setLayerStyle(layer.id, { strokeOpacity })}
            />
          )}
          {/* Point outlines are circles, which take no dash or blur. */}
          {supportsPointRenderer || isControlPaintedVectorLayer(layer) ? null : (
            <LineStyleControls key={layer.id} layer={layer} />
          )}
          <NumericStyleInput
            id="fillOpacity"
            label={t("style.elevation3d.fillOpacity")}
            min={0}
            max={1}
            step={0.05}
            value={style.fillOpacity}
            onChange={(fillOpacity) => setLayerStyle(layer.id, { fillOpacity })}
          />
          {isSketchLayer ? null : (
            <NumericStyleInput
              id="circleRadius"
              label={t("style.elevation3d.circleRadius")}
              min={1}
              max={50}
              step={1}
              value={style.circleRadius}
              onChange={(circleRadius) => setLayerStyle(layer.id, { circleRadius })}
            />
          )}
          {hasTextMarkerControls ? (
            <>
              <Separator />
              <div className="space-y-2">
                <Label htmlFor="textColor">{t("style.labels.textColor")}</Label>
                <ColorField
                  id="textColor"
                  value={styleValue(style, "textColor")}
                  onChange={(textColor) => setLayerStyle(layer.id, { textColor })}
                />
              </div>
              <NumericStyleInput
                id="textSize"
                label={t("style.labels.textSize")}
                min={6}
                max={96}
                step={1}
                value={styleValue(style, "textSize")}
                onChange={(textSize) => setLayerStyle(layer.id, { textSize })}
              />
              <div className="space-y-2">
                <Label htmlFor="textHaloColor">{t("style.symbology.textHaloColor")}</Label>
                <ColorField
                  id="textHaloColor"
                  value={styleValue(style, "textHaloColor")}
                  onChange={(textHaloColor) => setLayerStyle(layer.id, { textHaloColor })}
                />
              </div>
              <NumericStyleInput
                id="textHaloWidth"
                label={t("style.symbology.textHaloWidth")}
                min={0}
                max={8}
                step={0.5}
                value={styleValue(style, "textHaloWidth")}
                onChange={(textHaloWidth) => setLayerStyle(layer.id, { textHaloWidth })}
              />
            </>
          ) : null}
        </>
      )}
    </>
  );
}

/** The {@link STROKE_DASH_PRESETS} names with their catalog keys, in menu order. */
const LINE_STYLE_OPTIONS = [
  ["solid", "style.symbology.lineStyleSolid"],
  ["dashed", "style.symbology.lineStyleDashed"],
  ["dotted", "style.symbology.lineStyleDotted"],
  ["dash-dot", "style.symbology.lineStyleDashDot"],
  ["long-dash", "style.symbology.lineStyleLongDash"],
] as const satisfies readonly (readonly [StrokeDashPreset, string])[];

/** Parse a typed dash pattern ("4 2", "4, 2"), or `null` when it is not drawable. */
function parseDashPattern(text: string): number[] | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  // A leading or trailing separator leaves an empty token, which is not a 0.
  const lengths = trimmed
    .split(/[\s,]+/)
    .filter(Boolean)
    .map(Number);
  return isStrokeDashPattern(lengths) ? lengths : null;
}

/**
 * The line style (a dash preset, or a custom pattern typed as lengths) and the
 * line blur, for layers drawn with MapLibre line layers.
 *
 * @param props - The layer being styled.
 * @returns The line style controls.
 */
function LineStyleControls({ layer }: { layer: GeoLibreLayer }) {
  const { t } = useTranslation();
  const setLayerStyle = useAppStore((s) => s.setLayerStyle);
  const dash = styleValue(layer.style, "strokeDash");
  const presetName = strokeDashPresetName(dash);
  const patternText = isStrokeDashPattern(dash) ? dash.join(" ") : "";
  // The pattern the custom field was opened for. Picking "Custom" keeps the
  // field open even while the typed pattern happens to equal a preset; keying
  // it to the pattern (not a flag) closes it when a preset is applied from
  // elsewhere, such as the Style Manager, rather than leaving "Custom" selected.
  const [customFor, setCustomFor] = useState<string | null>(null);
  const showCustom = presetName === "custom" || customFor === patternText;
  const [draft, setDraft] = useState<string | null>(null);
  const draftValid = draft === null || parseDashPattern(draft) !== null;
  const commitDraft = () => {
    if (draft === null) return;
    const parsed = parseDashPattern(draft);
    // An invalid draft stays in the field, flagged, until it is fixed or
    // Escape drops it, so a rejected edit is not silently replaced.
    if (!parsed) return;
    setLayerStyle(layer.id, { strokeDash: parsed });
    setCustomFor(parsed.join(" "));
    setDraft(null);
  };
  return (
    <>
      <div className="space-y-2">
        <Label htmlFor="strokeDash">{t("style.symbology.lineStyle")}</Label>
        <Select
          id="strokeDash"
          value={showCustom ? "custom" : presetName}
          onChange={(event) => {
            const next = event.target.value;
            setDraft(null);
            if (next === "custom") {
              // Start from the current pattern, or a plain dash from a solid line.
              const start = isStrokeDashPattern(dash) ? dash : STROKE_DASH_PRESETS.dashed;
              setCustomFor(start.join(" "));
              if (!isStrokeDashPattern(dash)) {
                setLayerStyle(layer.id, { strokeDash: [...start] });
              }
              return;
            }
            setCustomFor(null);
            setLayerStyle(layer.id, {
              strokeDash: [...STROKE_DASH_PRESETS[next as StrokeDashPreset]],
            });
          }}
        >
          {LINE_STYLE_OPTIONS.map(([name, key]) => (
            <option key={name} value={name}>
              {t(key)}
            </option>
          ))}
          <option value="custom">{t("style.symbology.lineStyleCustom")}</option>
        </Select>
      </div>
      {showCustom ? (
        <div className="space-y-2">
          <Label htmlFor="strokeDashPattern">{t("style.symbology.lineDashPattern")}</Label>
          <Input
            id="strokeDashPattern"
            value={draft ?? patternText}
            aria-invalid={!draftValid}
            aria-describedby="strokeDashPatternHint"
            className={draftValid ? undefined : "border-destructive"}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commitDraft}
            onKeyDown={(event) => {
              // Enter that confirms an input-method candidate is not a commit.
              if (event.nativeEvent.isComposing) return;
              if (event.key === "Enter") commitDraft();
              if (event.key === "Escape") setDraft(null);
            }}
          />
          <p id="strokeDashPatternHint" className="text-xs text-muted-foreground">
            {t("style.symbology.lineDashPatternHint")}
          </p>
        </div>
      ) : null}
      <NumericStyleInput
        id="strokeBlur"
        label={t("style.symbology.lineBlur")}
        min={0}
        max={20}
        step={0.5}
        value={strokeBlurValue(layer.style)}
        onChange={(strokeBlur) => setLayerStyle(layer.id, { strokeBlur })}
      />
    </>
  );
}

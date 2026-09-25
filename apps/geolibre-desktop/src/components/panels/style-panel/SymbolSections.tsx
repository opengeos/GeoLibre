import {
  styleValue,
  useAppStore,
  type FillPattern,
  type GeoLibreLayer,
  type LineDecoration,
  type MarkerShape,
} from "@geolibre/core";
import { ColorField, Label, Select } from "@geolibre/ui";
import type { ParseKeys } from "i18next";
import { useTranslation } from "react-i18next";
import { NumericStyleInput } from "./style-inputs";

const MARKER_SHAPE_OPTIONS: ReadonlyArray<{
  value: MarkerShape;
  labelKey: ParseKeys;
}> = [
  { value: "circle", labelKey: "style.symbology.markerShapes.circle" },
  { value: "square", labelKey: "style.symbology.markerShapes.square" },
  { value: "triangle", labelKey: "style.symbology.markerShapes.triangle" },
  { value: "diamond", labelKey: "style.symbology.markerShapes.diamond" },
  { value: "star", labelKey: "style.symbology.markerShapes.star" },
  { value: "cross", labelKey: "style.symbology.markerShapes.cross" },
  { value: "pin", labelKey: "style.symbology.markerShapes.pin" },
  { value: "custom", labelKey: "style.symbology.markerShapes.custom" },
];

// Glyphs for the marker gallery preview only; they render in the chosen marker
// color (currentColor). The map renders the precise canvas-drawn shapes.
const MARKER_GLYPHS: Record<MarkerShape, string> = {
  circle: "●",
  square: "■",
  triangle: "▲",
  diamond: "◆",
  star: "★",
  cross: "✚",
  pin: "⦿",
  custom: "⬢",
};

const FILL_PATTERN_OPTIONS: ReadonlyArray<{
  value: FillPattern;
  labelKey: ParseKeys;
}> = [
  { value: "none", labelKey: "style.symbology.fillPatterns.none" },
  { value: "hatch", labelKey: "style.symbology.fillPatterns.hatch" },
  { value: "cross-hatch", labelKey: "style.symbology.fillPatterns.crossHatch" },
  { value: "horizontal", labelKey: "style.symbology.fillPatterns.horizontal" },
  { value: "vertical", labelKey: "style.symbology.fillPatterns.vertical" },
  { value: "dots", labelKey: "style.symbology.fillPatterns.dots" },
  { value: "svg", labelKey: "style.symbology.fillPatterns.svg" },
];

interface FillPatternSectionProps {
  layer: GeoLibreLayer;
  supportsDerivedGeometry: boolean;
}

/**
 * Polygon fill pattern controls, plus the inverted-mask toggle where the core
 * GeoJSON render path draws derived geometry.
 *
 * @param props - The layer and whether it supports derived geometry.
 * @returns The fill pattern section.
 */
export function FillPatternSection({ layer, supportsDerivedGeometry }: FillPatternSectionProps) {
  const { t } = useTranslation();
  const setLayerStyle = useAppStore((s) => s.setLayerStyle);
  const { style } = layer;
  const fillPattern = styleValue(style, "fillPattern");
  return (
    <div className="space-y-3">
      {supportsDerivedGeometry && (
        <div className="flex items-center justify-between gap-2">
          <Label htmlFor="invertedFillEnabled">{t("style.symbology.invertedFill")}</Label>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input
              id="invertedFillEnabled"
              type="checkbox"
              checked={styleValue(style, "invertedFillEnabled")}
              onChange={(event) =>
                setLayerStyle(layer.id, {
                  invertedFillEnabled: event.target.checked,
                })
              }
            />
            {t("style.symbology.invertedFillHint")}
          </label>
        </div>
      )}
      <div className="space-y-2">
        <Label htmlFor="fillPattern">{t("style.symbology.fillPattern")}</Label>
        <Select
          id="fillPattern"
          value={fillPattern}
          onChange={(event) =>
            setLayerStyle(layer.id, {
              fillPattern: event.target.value as FillPattern,
            })
          }
        >
          {FILL_PATTERN_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {t(option.labelKey)}
            </option>
          ))}
        </Select>
      </div>
      {fillPattern !== "none" && fillPattern !== "svg" ? (
        <div className="space-y-2">
          <Label htmlFor="fillPatternColor">{t("style.symbology.patternColor")}</Label>
          <ColorField
            id="fillPatternColor"
            value={styleValue(style, "fillPatternColor")}
            onChange={(fillPatternColor) => setLayerStyle(layer.id, { fillPatternColor })}
          />
        </div>
      ) : null}
      {fillPattern === "svg" ? (
        <div className="space-y-2">
          <Label htmlFor="fillPatternSvg">{t("style.symbology.patternSvg")}</Label>
          <textarea
            id="fillPatternSvg"
            className="min-h-20 w-full rounded-md border border-input bg-background px-2 py-1.5 font-mono text-xs placeholder:text-muted-foreground focus-visible:border-2 focus-visible:border-ring focus-visible:outline-none focus-visible:ring-0"
            placeholder={t("style.symbology.svgPlaceholder")}
            value={styleValue(style, "fillPatternSvg")}
            onChange={(event) => setLayerStyle(layer.id, { fillPatternSvg: event.target.value })}
          />
        </div>
      ) : null}
    </div>
  );
}

/**
 * Point marker icon controls: shape gallery, color, size and custom SVG.
 *
 * @param props - The layer being styled.
 * @returns The marker section.
 */
export function MarkerSection({ layer }: { layer: GeoLibreLayer }) {
  const { t } = useTranslation();
  const setLayerStyle = useAppStore((s) => s.setLayerStyle);
  const { style } = layer;
  const markerEnabled = styleValue(style, "markerEnabled");
  const markerShape = styleValue(style, "markerShape");
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor="markerEnabled">{t("style.symbology.marker")}</Label>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <input
            id="markerEnabled"
            type="checkbox"
            checked={markerEnabled}
            onChange={(event) => setLayerStyle(layer.id, { markerEnabled: event.target.checked })}
          />
          {t("style.symbology.useMarkerIcon")}
        </label>
      </div>
      {markerEnabled && (
        <>
          <div className="space-y-2">
            <Label>{t("style.symbology.markerShape")}</Label>
            <div className="grid grid-cols-4 gap-2">
              {MARKER_SHAPE_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  title={t(option.labelKey)}
                  aria-label={t(option.labelKey)}
                  aria-pressed={markerShape === option.value}
                  onClick={() => setLayerStyle(layer.id, { markerShape: option.value })}
                  className={`flex h-12 flex-col items-center justify-center gap-0.5 rounded-md border text-[9px] ${
                    markerShape === option.value
                      ? "border-primary ring-1 ring-primary"
                      : "border-input hover:border-primary/50"
                  }`}
                >
                  <span
                    aria-hidden="true"
                    className="text-base leading-none"
                    style={{
                      color:
                        option.value === "custom" ? undefined : styleValue(style, "markerColor"),
                    }}
                  >
                    {MARKER_GLYPHS[option.value]}
                  </span>
                  <span className="truncate">{t(option.labelKey)}</span>
                </button>
              ))}
            </div>
          </div>
          {markerShape !== "custom" ? (
            <div className="space-y-2">
              <Label htmlFor="markerColor">{t("style.symbology.markerColor")}</Label>
              <ColorField
                id="markerColor"
                value={styleValue(style, "markerColor")}
                onChange={(markerColor) => setLayerStyle(layer.id, { markerColor })}
              />
            </div>
          ) : null}
          <NumericStyleInput
            id="markerSize"
            label={t("style.symbology.markerSize")}
            min={6}
            max={96}
            step={1}
            value={styleValue(style, "markerSize")}
            onChange={(markerSize) => setLayerStyle(layer.id, { markerSize })}
          />
          {markerShape === "custom" ? (
            <div className="space-y-2">
              <Label htmlFor="markerSvg">{t("style.symbology.markerSvg")}</Label>
              <textarea
                id="markerSvg"
                className="min-h-20 w-full rounded-md border border-input bg-background px-2 py-1.5 font-mono text-xs placeholder:text-muted-foreground focus-visible:border-2 focus-visible:border-ring focus-visible:outline-none focus-visible:ring-0"
                placeholder={t("style.symbology.svgPlaceholder")}
                value={styleValue(style, "markerSvg")}
                onChange={(event) => setLayerStyle(layer.id, { markerSvg: event.target.value })}
              />
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

/**
 * Line decoration controls (repeated arrow/marker symbols along lines).
 *
 * @param props - The layer being styled.
 * @returns The line decoration section.
 */
export function LineDecorationSection({ layer }: { layer: GeoLibreLayer }) {
  const { t } = useTranslation();
  const setLayerStyle = useAppStore((s) => s.setLayerStyle);
  const { style } = layer;
  // --- Line decorations (repeated arrow/marker symbols along lines) ---
  const lineDecoration = styleValue(style, "lineDecoration");
  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <Label htmlFor="lineDecoration">{t("style.decorations.heading")}</Label>
        <Select
          id="lineDecoration"
          value={lineDecoration}
          onChange={(event) =>
            setLayerStyle(layer.id, {
              lineDecoration: event.target.value as LineDecoration,
            })
          }
        >
          <option value="none">{t("style.decorations.typeNone")}</option>
          <option value="arrow">{t("style.decorations.typeArrow")}</option>
          <option value="triangle">{t("style.decorations.typeTriangle")}</option>
          <option value="circle">{t("style.decorations.typeCircle")}</option>
          <option value="square">{t("style.decorations.typeSquare")}</option>
        </Select>
      </div>
      {lineDecoration !== "none" && (
        <>
          <div className="space-y-2">
            <Label htmlFor="lineDecorationColor">{t("style.decorations.color")}</Label>
            <ColorField
              id="lineDecorationColor"
              value={styleValue(style, "lineDecorationColor") || styleValue(style, "strokeColor")}
              onChange={(lineDecorationColor) => setLayerStyle(layer.id, { lineDecorationColor })}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <NumericStyleInput
              id="lineDecorationSize"
              label={t("style.decorations.size")}
              min={4}
              max={64}
              step={1}
              value={styleValue(style, "lineDecorationSize")}
              onChange={(lineDecorationSize) => setLayerStyle(layer.id, { lineDecorationSize })}
            />
            <NumericStyleInput
              id="lineDecorationSpacing"
              label={t("style.decorations.spacing")}
              min={10}
              max={500}
              step={5}
              value={styleValue(style, "lineDecorationSpacing")}
              onChange={(lineDecorationSpacing) =>
                setLayerStyle(layer.id, { lineDecorationSpacing })
              }
            />
          </div>
        </>
      )}
    </div>
  );
}

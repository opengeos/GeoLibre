import { DEFAULT_LAYER_STYLE, styleValue, useAppStore, type GeoLibreLayer } from "@geolibre/core";
import { Label, Select } from "@geolibre/ui";
import { useTranslation } from "react-i18next";
import { proportionalSizeBounds } from "../../../lib/vector-style-classification";
import { NumericStyleInput } from "./style-inputs";
import type { StylePanelDrafts } from "./useStylePanelDrafts";

interface ProportionalSizeSectionProps {
  layer: GeoLibreLayer;
  drafts: StylePanelDrafts;
  vectorStylePropertyOptions: string[];
  matchingPropertyValues: (property: string) => unknown[] | undefined;
}

/**
 * Size-by-value controls: the size field, its value and size ranges, and a
 * graduated-size legend.
 *
 * @param props - The layer, its draft state and attribute options.
 * @returns The proportional size section.
 */
export function ProportionalSizeSection({
  layer,
  drafts,
  vectorStylePropertyOptions,
  matchingPropertyValues,
}: ProportionalSizeSectionProps) {
  const { t } = useTranslation();
  const setLayerStyle = useAppStore((s) => s.setLayerStyle);
  const { style } = layer;
  const {
    proportionalSizeError,
    setProportionalSizeError,
    seededProportionalBoundsRef,
    vectorPropertyValuesLoading,
    vectorPropertyValuesUnavailable,
  } = drafts;
  const proportionalEnabled = styleValue(style, "proportionalSizeEnabled");
  const proportionalProperty = styleValue(style, "proportionalSizeProperty");
  const proportionalMinValue = styleValue(style, "proportionalSizeMinValue");
  const proportionalMaxValue = styleValue(style, "proportionalSizeMaxValue");
  const proportionalMinRadius = styleValue(style, "proportionalSizeMinRadius");
  const proportionalMaxRadius = styleValue(style, "proportionalSizeMaxRadius");
  // A small graduated-size legend: evenly spaced sample values mapped onto the
  // interpolated radius range, mirroring what the map renders.
  const proportionalLegend =
    proportionalEnabled &&
    proportionalMaxValue > proportionalMinValue &&
    proportionalMinRadius <= proportionalMaxRadius
      ? Array.from({ length: 5 }, (_, index) => {
          const ratio = index / 4;
          return {
            value: proportionalMinValue + ratio * (proportionalMaxValue - proportionalMinValue),
            radius: proportionalMinRadius + ratio * (proportionalMaxRadius - proportionalMinRadius),
          };
        })
      : [];

  /** True when a sample can prove the field lacks a usable numeric range (non-empty). */
  const hasDecisivePropertySample = (property: string): boolean => {
    if (layer.geojson?.features?.length) return true;
    const sample = matchingPropertyValues(property);
    // Empty tile samples are inconclusive — sparse/null viewport values must not
    // disable a field that is numeric elsewhere in the dataset.
    return Array.isArray(sample) && sample.length > 0;
  };

  const proportionalBoundsPatch = (property: string) => {
    const bounds = proportionalSizeBounds(layer, property, matchingPropertyValues(property));
    return bounds
      ? { proportionalSizeMinValue: bounds.min, proportionalSizeMaxValue: bounds.max }
      : null;
  };

  const rememberProportionalSeed = (property: string, min: number, max: number) => {
    seededProportionalBoundsRef.current = { key: `${layer.id}:${property}`, min, max };
  };

  const clearProportionalSizeField = (disable: boolean, error: string | null = null) => {
    seededProportionalBoundsRef.current = null;
    setProportionalSizeError(error);
    setLayerStyle(layer.id, {
      ...(disable ? { proportionalSizeEnabled: false } : {}),
      proportionalSizeProperty: "",
      proportionalSizeMinValue: DEFAULT_LAYER_STYLE.proportionalSizeMinValue,
      proportionalSizeMaxValue: DEFAULT_LAYER_STYLE.proportionalSizeMaxValue,
    });
  };
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor="proportionalSizeEnabled">{t("style.symbology.proportionalSize")}</Label>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <input
            id="proportionalSizeEnabled"
            type="checkbox"
            checked={proportionalEnabled}
            onChange={(event) => {
              const enabled = event.target.checked;
              if (!enabled) {
                setProportionalSizeError(null);
                setLayerStyle(layer.id, { proportionalSizeEnabled: false });
                return;
              }
              if (!proportionalProperty) {
                setProportionalSizeError(null);
                setLayerStyle(layer.id, { proportionalSizeEnabled: true });
                return;
              }
              const boundsPatch = proportionalBoundsPatch(proportionalProperty);
              if (boundsPatch) {
                setProportionalSizeError(null);
                rememberProportionalSeed(
                  proportionalProperty,
                  boundsPatch.proportionalSizeMinValue,
                  boundsPatch.proportionalSizeMaxValue,
                );
                setLayerStyle(layer.id, {
                  proportionalSizeEnabled: true,
                  ...boundsPatch,
                });
                return;
              }
              // Non-empty sample proves the field is unusable — do not enable with a stale range.
              if (hasDecisivePropertySample(proportionalProperty)) {
                clearProportionalSizeField(true, t("style.symbology.errorProportionalSizeField"));
                return;
              }
              // Tiled / unloaded / empty sample: enable and keep the field; the loader seeds bounds.
              setProportionalSizeError(null);
              setLayerStyle(layer.id, { proportionalSizeEnabled: true });
            }}
          />
          {t("style.symbology.sizeByValue")}
        </label>
      </div>
      {/* Outside the `proportionalEnabled` guard on purpose: rejecting a field
          from the checkbox leaves proportional sizing off, so a message nested
          inside that branch would unmount in the same render that set it. */}
      {proportionalSizeError && <p className="text-xs text-destructive">{proportionalSizeError}</p>}
      {proportionalEnabled && (
        <>
          <div className="space-y-2">
            <Label htmlFor="proportionalSizeProperty">{t("style.symbology.sizeField")}</Label>
            <Select
              id="proportionalSizeProperty"
              value={proportionalProperty}
              onChange={(event) => {
                const property = event.target.value;
                if (!property) {
                  clearProportionalSizeField(false);
                  return;
                }
                const boundsPatch = proportionalBoundsPatch(property);
                if (boundsPatch) {
                  setProportionalSizeError(null);
                  rememberProportionalSeed(
                    property,
                    boundsPatch.proportionalSizeMinValue,
                    boundsPatch.proportionalSizeMaxValue,
                  );
                  setLayerStyle(layer.id, {
                    proportionalSizeProperty: property,
                    ...boundsPatch,
                  });
                  return;
                }
                // Non-empty sample proves nonnumeric / constant — reject and clear stale range.
                // Stay enabled: the user is mid-edit here, so keep the field select
                // mounted next to the message instead of collapsing the section.
                if (hasDecisivePropertySample(property)) {
                  clearProportionalSizeField(
                    false,
                    t("style.symbology.errorProportionalSizeField"),
                  );
                  return;
                }
                // No decisive sample yet (tiled/empty): commit the field; defaults until load.
                seededProportionalBoundsRef.current = null;
                setProportionalSizeError(null);
                setLayerStyle(layer.id, {
                  proportionalSizeProperty: property,
                  proportionalSizeMinValue: DEFAULT_LAYER_STYLE.proportionalSizeMinValue,
                  proportionalSizeMaxValue: DEFAULT_LAYER_STYLE.proportionalSizeMaxValue,
                });
              }}
              disabled={vectorStylePropertyOptions.length === 0}
            >
              {vectorStylePropertyOptions.length === 0 ? (
                <option value="">{t("style.labels.noAttributes")}</option>
              ) : (
                <>
                  <option value="">{t("style.symbology.chooseField")}</option>
                  {vectorStylePropertyOptions.map((property) => (
                    <option key={property} value={property}>
                      {property}
                    </option>
                  ))}
                </>
              )}
            </Select>
            {vectorPropertyValuesLoading && (
              <p className="text-xs text-muted-foreground">
                {t("attributeTable.loadingAttributes")}
              </p>
            )}
            {vectorPropertyValuesUnavailable && (
              <p className="text-xs text-destructive">
                {t("style.symbology.errorAttributesUnavailable")}
              </p>
            )}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <NumericStyleInput
              id="proportionalSizeMinValue"
              label={t("style.symbology.minValue")}
              min={-1_000_000_000}
              max={1_000_000_000}
              step={1}
              value={proportionalMinValue}
              onChange={(proportionalSizeMinValue) =>
                setLayerStyle(layer.id, { proportionalSizeMinValue })
              }
            />
            <NumericStyleInput
              id="proportionalSizeMaxValue"
              label={t("style.symbology.maxValue")}
              min={-1_000_000_000}
              max={1_000_000_000}
              step={1}
              value={proportionalMaxValue}
              onChange={(proportionalSizeMaxValue) =>
                setLayerStyle(layer.id, { proportionalSizeMaxValue })
              }
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <NumericStyleInput
              id="proportionalSizeMinRadius"
              label={t("style.symbology.minSize")}
              min={0}
              max={100}
              step={1}
              value={proportionalMinRadius}
              onChange={(proportionalSizeMinRadius) =>
                setLayerStyle(layer.id, { proportionalSizeMinRadius })
              }
            />
            <NumericStyleInput
              id="proportionalSizeMaxRadius"
              label={t("style.symbology.maxSize")}
              min={0}
              max={100}
              step={1}
              value={proportionalMaxRadius}
              onChange={(proportionalSizeMaxRadius) =>
                setLayerStyle(layer.id, { proportionalSizeMaxRadius })
              }
            />
          </div>
          {proportionalLegend.length > 0 && proportionalProperty ? (
            <div className="space-y-1">
              <Label>{t("style.symbology.sizeLegend")}</Label>
              <div className="flex items-end justify-between gap-2 rounded-md border border-input p-3">
                {proportionalLegend.map((entry, index) => (
                  <div key={index} className="flex flex-col items-center gap-1">
                    <span
                      aria-hidden="true"
                      className="rounded-full bg-primary/70"
                      style={{
                        width: entry.radius * 2,
                        height: entry.radius * 2,
                      }}
                    />
                    <span className="text-[10px] text-muted-foreground">
                      {entry.value.toLocaleString(undefined, {
                        maximumFractionDigits: 1,
                      })}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

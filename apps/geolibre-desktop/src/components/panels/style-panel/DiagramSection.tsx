import {
  styleValue,
  useAppStore,
  type DiagramField,
  type DiagramSizeMode,
  type DiagramType,
  type GeoLibreLayer,
} from "@geolibre/core";
import { Button, ColorField, Label, Select } from "@geolibre/ui";
import { Plus, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { nextStopColor } from "./classification-helpers";
import { NumericStyleInput } from "./style-inputs";

interface DiagramSectionProps {
  layer: GeoLibreLayer;
  numericPropertyOptions: string[];
  diagramTruncated: boolean;
  diagramDrawnCount: number;
  diagramAtlasDropped: number;
}

/**
 * Diagram symbology controls (per-feature pie/bar charts).
 *
 * @param props - The layer, its numeric attribute candidates and the
 *   diagram-loss notices.
 * @returns The diagram section.
 */
export function DiagramSection({
  layer,
  numericPropertyOptions,
  diagramTruncated,
  diagramDrawnCount,
  diagramAtlasDropped,
}: DiagramSectionProps) {
  const { t } = useTranslation();
  const setLayerStyle = useAppStore((s) => s.setLayerStyle);
  const { style } = layer;
  // --- Diagram symbology (per-feature pie/bar charts, immediate writes) ---
  // The numeric-attribute candidates (numericPropertyOptions) are memoized
  // above the early returns.
  const diagramType = styleValue(style, "diagramType");
  const diagramFields = styleValue(style, "diagramFields");
  const diagramSizeMode = styleValue(style, "diagramSizeMode");
  const setDiagramFields = (fields: DiagramField[]) =>
    setLayerStyle(layer.id, { diagramFields: fields });
  const addDiagramField = () => {
    const used = new Set(diagramFields.map((field) => field.property));
    const property = numericPropertyOptions.find((candidate) => !used.has(candidate)) ?? "";
    setDiagramFields([...diagramFields, { property, color: nextStopColor(diagramFields.length) }]);
  };
  const updateDiagramField = (index: number, patch: Partial<DiagramField>) =>
    setDiagramFields(
      diagramFields.map((field, i) => (i === index ? { ...field, ...patch } : field)),
    );
  const removeDiagramField = (index: number) =>
    setDiagramFields(diagramFields.filter((_, i) => i !== index));
  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <Label htmlFor="diagramType">{t("style.diagrams.chartType")}</Label>
        <Select
          id="diagramType"
          value={diagramType}
          onChange={(event) => {
            const nextType = event.target.value as DiagramType;
            // Seed the field list on first enable so a chart appears without
            // hunting for the add button.
            setLayerStyle(layer.id, { diagramType: nextType });
            if (
              nextType !== "none" &&
              diagramFields.length === 0 &&
              numericPropertyOptions.length > 0
            ) {
              setDiagramFields(
                numericPropertyOptions.slice(0, 2).map((property, index) => ({
                  property,
                  color: nextStopColor(index),
                })),
              );
            }
          }}
        >
          <option value="none">{t("style.diagrams.typeNone")}</option>
          <option value="pie">{t("style.diagrams.typePie")}</option>
          <option value="donut">{t("style.diagrams.typeDonut")}</option>
          <option value="bar">{t("style.diagrams.typeBar")}</option>
          <option value="stacked-bar">{t("style.diagrams.typeStackedBar")}</option>
        </Select>
      </div>
      {diagramType !== "none" && (
        <>
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <Label>{t("style.diagrams.fields")}</Label>
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="h-7 w-7"
                title={t("style.diagrams.addField")}
                aria-label={t("style.diagrams.addField")}
                onClick={addDiagramField}
              >
                <Plus className="h-3.5 w-3.5" />
              </Button>
            </div>
            {diagramFields.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t("style.diagrams.noFields")}</p>
            ) : (
              <div className="space-y-2">
                {diagramFields.map((field, index) => (
                  <div key={index} className="grid grid-cols-[auto_1fr_2rem] items-center gap-2">
                    <ColorField
                      fill={false}
                      aria-label={t("style.symbology.classColor", {
                        index: index + 1,
                      })}
                      eyedropperLabel={t("style.symbology.classColorPick", {
                        index: index + 1,
                      })}
                      className="h-9 w-9 p-1"
                      buttonClassName="h-9 w-9"
                      value={field.color}
                      onChange={(color) => updateDiagramField(index, { color })}
                    />
                    <Select
                      aria-label={t("style.diagrams.fieldAttribute", {
                        index: index + 1,
                      })}
                      value={field.property}
                      onChange={(event) =>
                        updateDiagramField(index, {
                          property: event.target.value,
                        })
                      }
                    >
                      <option value="">{t("style.symbology.chooseField")}</option>
                      {numericPropertyOptions.map((property) => (
                        <option key={property} value={property}>
                          {property}
                        </option>
                      ))}
                      {field.property !== "" && !numericPropertyOptions.includes(field.property) ? (
                        <option value={field.property}>{field.property}</option>
                      ) : null}
                    </Select>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      title={t("style.diagrams.removeField")}
                      aria-label={t("style.diagrams.removeField")}
                      onClick={() => removeDiagramField(index)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="diagramSizeMode">{t("style.diagrams.sizeMode")}</Label>
            <Select
              id="diagramSizeMode"
              value={diagramSizeMode}
              onChange={(event) =>
                setLayerStyle(layer.id, {
                  diagramSizeMode: event.target.value as DiagramSizeMode,
                })
              }
            >
              <option value="fixed">{t("style.diagrams.sizeFixed")}</option>
              <option value="sum">{t("style.diagrams.sizeSum")}</option>
              <option value="attribute">{t("style.diagrams.sizeAttribute")}</option>
            </Select>
          </div>
          {diagramSizeMode === "attribute" && (
            <div className="space-y-2">
              <Label htmlFor="diagramSizeProperty">{t("style.diagrams.sizeField")}</Label>
              <Select
                id="diagramSizeProperty"
                value={styleValue(style, "diagramSizeProperty")}
                onChange={(event) =>
                  setLayerStyle(layer.id, {
                    diagramSizeProperty: event.target.value,
                  })
                }
              >
                <option value="">{t("style.symbology.chooseField")}</option>
                {numericPropertyOptions.map((property) => (
                  <option key={property} value={property}>
                    {property}
                  </option>
                ))}
                {styleValue(style, "diagramSizeProperty") !== "" &&
                !numericPropertyOptions.includes(styleValue(style, "diagramSizeProperty")) ? (
                  <option value={styleValue(style, "diagramSizeProperty")}>
                    {styleValue(style, "diagramSizeProperty")}
                  </option>
                ) : null}
              </Select>
            </div>
          )}
          <NumericStyleInput
            id="diagramSize"
            label={t("style.diagrams.size")}
            min={8}
            max={120}
            step={1}
            value={styleValue(style, "diagramSize")}
            onChange={(diagramSize) => setLayerStyle(layer.id, { diagramSize })}
          />
          {diagramTruncated && (
            <p className="text-xs text-muted-foreground">
              {t("style.diagrams.truncated", { count: diagramDrawnCount })}
            </p>
          )}
          {diagramAtlasDropped > 0 && (
            <p className="text-xs text-muted-foreground">
              {t("style.diagrams.atlasFull", { count: diagramAtlasDropped })}
            </p>
          )}
          <NumericStyleInput
            id="diagramMinZoom"
            label={t("style.diagrams.minZoom")}
            min={0}
            max={24}
            step={1}
            value={styleValue(style, "diagramMinZoom")}
            onChange={(diagramMinZoom) => setLayerStyle(layer.id, { diagramMinZoom })}
          />
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={styleValue(style, "diagramDeclutter")}
              onChange={(event) =>
                setLayerStyle(layer.id, {
                  diagramDeclutter: event.target.checked,
                })
              }
            />
            {t("style.diagrams.declutter")}
          </label>
        </>
      )}
    </div>
  );
}

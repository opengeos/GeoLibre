import {
  popupFieldLabel,
  useAppStore,
  validateMapExpression,
  visiblePopupFields,
  type GeoLibreLayer,
  type LayerPopupConfig,
  type PopupDateFormat,
  type PopupFieldConfig,
  type PopupFieldKind,
} from "@geolibre/core";
import { Button, Input, Label, Select } from "@geolibre/ui";
import { ChevronDown, ChevronUp, GripVertical, Plus, SquareFunction, Trash2 } from "lucide-react";
import { useMemo, useState, type DragEvent as ReactDragEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  getAttributePropertyNames,
  standardExpressionVariables,
} from "../../lib/expression-inputs";
import { ExpressionBuilderDialog } from "../expressions/ExpressionBuilderDialog";

interface PopupSectionProps {
  layer: GeoLibreLayer;
}

const KINDS: PopupFieldKind[] = ["auto", "text", "number", "date", "link", "image"];
const DATE_FORMATS: PopupDateFormat[] = ["date", "datetime", "time", "iso", "year"];

/** Which expression slot the modal builder is editing, if any. */
type BuilderTarget = "title" | "body";

/**
 * The Popup section of the layer style panel (issue #2113): design what a
 * viewer sees when they click or hover a feature — which fields appear, in
 * what order, under what labels and value formatting, with an optional title
 * field or expression, an optional sentence-style body expression, and a
 * hover tooltip built from a short subset of the same fields.
 *
 * The configuration is applied by `MapCanvas`'s Identify popup and hover
 * tooltip and persists with the project, so it travels to shared projects,
 * `layout=viewer` embeds and story-map chapters.
 *
 * A layer with nothing configured keeps the historical behavior (the layer
 * name over every property), which is why "Use every field" is the empty
 * state rather than a mode the author has to pick.
 */
export function PopupSection({ layer }: PopupSectionProps) {
  const { t } = useTranslation();
  const projectName = useAppStore((s) => s.projectName);
  const setLayerPopup = useAppStore((s) => s.setLayerPopup);

  const popup = layer.popup;
  const configs = useMemo(() => popup?.fields ?? [], [popup]);
  const [builderTarget, setBuilderTarget] = useState<BuilderTarget | null>(null);
  const [draggedField, setDraggedField] = useState<string | null>(null);

  const { metadata: layerMetadata, geojson: layerGeojson } = layer;
  const features = useMemo(() => layerGeojson?.features ?? [], [layerGeojson]);

  // The fields an author may put in a popup: the layer's own attribute columns
  // minus anything fieldVisibility hides or excludes. Sampling the first
  // feature keeps the internal-column filter (`__geolibre_*`, the photo twin)
  // in one place — `visiblePopupFields` — rather than restated here.
  const fieldNames = useMemo(() => {
    const names = getAttributePropertyNames({
      metadata: layerMetadata,
      geojson: layerGeojson,
    });
    const asProperties = Object.fromEntries(names.map((name) => [name, null]));
    return visiblePopupFields(asProperties, layer.fieldVisibility);
  }, [layerMetadata, layerGeojson, layer.fieldVisibility]);

  // Camera snapshot for the modal Expression Builder, taken per render of the
  // (rarely-open) section rather than via a mapView subscription — see the
  // equivalent comment in SelectByExpressionDialog.
  const { zoom, variables } = useMemo(() => {
    const { zoom: mapZoom, center } = useAppStore.getState().mapView;
    return {
      zoom: mapZoom,
      variables: standardExpressionVariables({
        projectName,
        layerName: layer.name,
        featureCount: features.length,
        zoom: mapZoom,
        centerLat: center[1],
      }),
    };
  }, [projectName, layer.name, features]);

  // Validated WITHOUT the `@` variable set, for the same reason as the
  // Attribute Form designer: the popup evaluates these at render time with no
  // variables, so a hand-typed `@token` must fail here rather than at runtime.
  const titleValidation = useMemo(
    () => (popup?.titleExpression ? validateMapExpression(popup.titleExpression) : null),
    [popup?.titleExpression],
  );
  const bodyValidation = useMemo(
    () => (popup?.bodyExpression ? validateMapExpression(popup.bodyExpression) : null),
    [popup?.bodyExpression],
  );

  const fieldsInUse = useMemo(() => new Set(configs.map((entry) => entry.field)), [configs]);
  const availableFields = useMemo(
    () => fieldNames.filter((name) => !fieldsInUse.has(name)),
    [fieldNames, fieldsInUse],
  );

  /**
   * Write a patch onto the layer's popup block, dropping the block entirely
   * when nothing is left — so turning every option back off restores the
   * default rendering instead of persisting an empty object.
   */
  const patchPopup = (patch: Partial<LayerPopupConfig>) => {
    const next: LayerPopupConfig = { ...popup, ...patch };
    for (const key of Object.keys(next) as (keyof LayerPopupConfig)[]) {
      const value = next[key];
      if (value === undefined || value === "" || (Array.isArray(value) && value.length === 0)) {
        delete next[key];
      }
    }
    setLayerPopup(layer.id, Object.keys(next).length > 0 ? next : undefined);
  };

  const patchField = (field: string, patch: Partial<PopupFieldConfig>) => {
    patchPopup({
      fields: configs.map((entry) => {
        if (entry.field !== field) return entry;
        const merged: PopupFieldConfig = { ...entry, ...patch };
        // Drop the format block once it holds nothing, so a config that was
        // fiddled with and reset does not persist an empty object.
        if (merged.format && Object.values(merged.format).every((value) => value === undefined)) {
          delete merged.format;
        }
        return merged;
      }),
    });
  };

  const patchFormat = (config: PopupFieldConfig, patch: Partial<PopupFieldConfig["format"]>) => {
    const format = { ...config.format, ...patch };
    for (const key of Object.keys(format) as (keyof typeof format)[]) {
      if (format[key] === undefined || format[key] === "") delete format[key];
    }
    patchField(config.field, {
      format: Object.keys(format).length ? format : undefined,
    });
  };

  const addField = (field: string) => {
    if (!field || fieldsInUse.has(field)) return;
    patchPopup({ fields: [...configs, { field }] });
  };

  const removeField = (field: string) => {
    patchPopup({ fields: configs.filter((entry) => entry.field !== field) });
  };

  /** Move a field to a new index, clamped to the list. */
  const moveField = (field: string, to: number) => {
    const from = configs.findIndex((entry) => entry.field === field);
    const target = Math.max(0, Math.min(configs.length - 1, to));
    if (from < 0 || from === target) return;
    const next = [...configs];
    const [moved] = next.splice(from, 1);
    next.splice(target, 0, moved);
    patchPopup({ fields: next });
  };

  const handleDrop = (event: ReactDragEvent<HTMLDivElement>, field: string) => {
    event.preventDefault();
    if (!draggedField || draggedField === field) return;
    moveField(
      draggedField,
      configs.findIndex((entry) => entry.field === field),
    );
    setDraggedField(null);
  };

  const titleSource = popup?.titleExpression ?? "";

  return (
    <div className="space-y-3" data-testid="popup-section">
      <p className="text-sm font-semibold">{t("style.popup.heading")}</p>

      <label className="flex items-center gap-2 text-xs">
        <input
          type="checkbox"
          checked={popup?.click !== false}
          onChange={(event) => patchPopup({ click: event.target.checked ? undefined : false })}
        />
        <span>{t("style.popup.showOnClick")}</span>
      </label>
      <label className="flex items-center gap-2 text-xs">
        <input
          type="checkbox"
          data-testid="popup-hover-toggle"
          checked={popup?.hover === true}
          onChange={(event) => patchPopup({ hover: event.target.checked ? true : undefined })}
        />
        <span>{t("style.popup.showOnHover")}</span>
      </label>
      {popup?.hover === true && (
        <p className="text-xs text-muted-foreground">{t("style.popup.hoverHint")}</p>
      )}

      <div className="space-y-1">
        <Label htmlFor={`popup-title-field-${layer.id}`}>{t("style.popup.titleField")}</Label>
        <Select
          id={`popup-title-field-${layer.id}`}
          value={popup?.titleField ?? ""}
          onChange={(event) => patchPopup({ titleField: event.target.value || undefined })}
        >
          <option value="">{t("style.popup.titleFieldDefault")}</option>
          {fieldNames.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </Select>
      </div>

      <div className="space-y-1">
        <div className="flex items-center justify-between gap-2">
          <Label htmlFor={`popup-title-expr-${layer.id}`}>{t("style.popup.titleExpression")}</Label>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 shrink-0"
            title={t("style.popup.openBuilder")}
            aria-label={t("style.popup.openBuilder")}
            onClick={() => setBuilderTarget("title")}
          >
            <SquareFunction className="h-3.5 w-3.5" />
          </Button>
        </div>
        <Input
          id={`popup-title-expr-${layer.id}`}
          className="font-mono text-xs"
          value={titleSource}
          placeholder={t("style.popup.titleExpressionPlaceholder")}
          onChange={(event) => patchPopup({ titleExpression: event.target.value || undefined })}
        />
        {titleValidation && !titleValidation.ok && (
          <p className="text-xs text-destructive">
            {titleValidation.errors[0] ?? t("style.popup.invalidExpression")}
          </p>
        )}
      </div>

      <div className="space-y-1">
        <div className="flex items-center justify-between gap-2">
          <Label htmlFor={`popup-body-expr-${layer.id}`}>{t("style.popup.bodyExpression")}</Label>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 shrink-0"
            title={t("style.popup.openBuilder")}
            aria-label={t("style.popup.openBuilder")}
            onClick={() => setBuilderTarget("body")}
          >
            <SquareFunction className="h-3.5 w-3.5" />
          </Button>
        </div>
        <Input
          id={`popup-body-expr-${layer.id}`}
          className="font-mono text-xs"
          value={popup?.bodyExpression ?? ""}
          placeholder={t("style.popup.bodyExpressionPlaceholder")}
          onChange={(event) => patchPopup({ bodyExpression: event.target.value || undefined })}
        />
        <p className="text-xs text-muted-foreground">{t("style.popup.bodyExpressionHint")}</p>
        {bodyValidation && !bodyValidation.ok && (
          <p className="text-xs text-destructive">
            {bodyValidation.errors[0] ?? t("style.popup.invalidExpression")}
          </p>
        )}
      </div>

      <label className="flex items-center gap-2 text-xs">
        <input
          type="checkbox"
          checked={popup?.showFeatureId !== false}
          onChange={(event) =>
            patchPopup({
              showFeatureId: event.target.checked ? undefined : false,
            })
          }
        />
        <span>{t("style.popup.showFeatureId")}</span>
      </label>

      <div className="space-y-2">
        <Label>{t("style.popup.fields")}</Label>
        {configs.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("style.popup.allFields")}</p>
        ) : (
          configs.map((config, index) => (
            <div
              key={config.field}
              data-testid="popup-field-item"
              className="space-y-2 rounded-md border border-input p-2"
              onDragOver={(event) => {
                if (draggedField && draggedField !== config.field) event.preventDefault();
              }}
              onDrop={(event) => handleDrop(event, config.field)}
            >
              <div className="flex items-center gap-1">
                <span
                  draggable
                  title={t("style.popup.dragToReorder")}
                  aria-label={t("style.popup.dragNamedToReorder", {
                    name: config.field,
                  })}
                  className="cursor-grab rounded p-0.5 text-muted-foreground active:cursor-grabbing"
                  onDragStart={(event) => {
                    event.dataTransfer.effectAllowed = "move";
                    setDraggedField(config.field);
                  }}
                  onDragEnd={() => setDraggedField(null)}
                >
                  <GripVertical className="h-3.5 w-3.5" />
                </span>
                <span className="min-w-0 flex-1 truncate text-sm" title={config.field}>
                  {popupFieldLabel(config)}
                </span>
                {/* Keyboard-reachable equivalents of the drag handle: pointer
                    drag alone would leave the order unreachable without a
                    mouse. */}
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 shrink-0"
                  title={t("style.popup.moveUp")}
                  aria-label={t("style.popup.moveUp")}
                  disabled={index === 0}
                  onClick={() => moveField(config.field, index - 1)}
                >
                  <ChevronUp className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 shrink-0"
                  title={t("style.popup.moveDown")}
                  aria-label={t("style.popup.moveDown")}
                  disabled={index === configs.length - 1}
                  onClick={() => moveField(config.field, index + 1)}
                >
                  <ChevronDown className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 shrink-0"
                  title={t("style.popup.removeField")}
                  aria-label={t("style.popup.removeField")}
                  onClick={() => removeField(config.field)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <Label htmlFor={`popup-label-${layer.id}-${config.field}`}>
                    {t("style.popup.label")}
                  </Label>
                  <Input
                    id={`popup-label-${layer.id}-${config.field}`}
                    value={config.label ?? ""}
                    placeholder={config.field}
                    onChange={(event) =>
                      patchField(config.field, {
                        label: event.target.value || undefined,
                      })
                    }
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor={`popup-kind-${layer.id}-${config.field}`}>
                    {t("style.popup.kind")}
                  </Label>
                  <Select
                    id={`popup-kind-${layer.id}-${config.field}`}
                    value={config.kind ?? "auto"}
                    onChange={(event) =>
                      patchField(config.field, {
                        kind:
                          event.target.value === "auto"
                            ? undefined
                            : (event.target.value as PopupFieldKind),
                      })
                    }
                  >
                    {KINDS.map((kind) => (
                      <option key={kind} value={kind}>
                        {t(`style.popup.kinds.${kind}`)}
                      </option>
                    ))}
                  </Select>
                </div>
              </div>

              {config.kind === "number" && (
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1">
                    <Label htmlFor={`popup-decimals-${layer.id}-${config.field}`}>
                      {t("style.popup.decimals")}
                    </Label>
                    <Input
                      id={`popup-decimals-${layer.id}-${config.field}`}
                      type="number"
                      min={0}
                      max={20}
                      value={config.format?.decimals ?? ""}
                      onChange={(event) => {
                        const parsed = Number(event.target.value);
                        patchFormat(config, {
                          decimals:
                            event.target.value.trim() === "" || !Number.isFinite(parsed)
                              ? undefined
                              : parsed,
                        });
                      }}
                    />
                  </div>
                  <label className="flex items-end gap-2 pb-2 text-xs">
                    <input
                      type="checkbox"
                      checked={config.format?.thousands === true}
                      onChange={(event) =>
                        patchFormat(config, {
                          thousands: event.target.checked ? true : undefined,
                        })
                      }
                    />
                    <span>{t("style.popup.thousands")}</span>
                  </label>
                </div>
              )}

              {config.kind === "date" && (
                <div className="space-y-1">
                  <Label htmlFor={`popup-dateformat-${layer.id}-${config.field}`}>
                    {t("style.popup.dateFormat")}
                  </Label>
                  <Select
                    id={`popup-dateformat-${layer.id}-${config.field}`}
                    value={config.format?.dateFormat ?? "date"}
                    onChange={(event) =>
                      patchFormat(config, {
                        dateFormat: event.target.value as PopupDateFormat,
                      })
                    }
                  >
                    {DATE_FORMATS.map((format) => (
                      <option key={format} value={format}>
                        {t(`style.popup.dateFormats.${format}`)}
                      </option>
                    ))}
                  </Select>
                </div>
              )}

              {config.kind === "link" && (
                <div className="space-y-1">
                  <Label htmlFor={`popup-linklabel-${layer.id}-${config.field}`}>
                    {t("style.popup.linkLabel")}
                  </Label>
                  <Input
                    id={`popup-linklabel-${layer.id}-${config.field}`}
                    value={config.format?.linkLabel ?? ""}
                    placeholder={t("style.popup.linkLabelPlaceholder")}
                    onChange={(event) =>
                      patchFormat(config, {
                        linkLabel: event.target.value || undefined,
                      })
                    }
                  />
                </div>
              )}

              {config.kind !== "image" && config.kind !== "link" && (
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1">
                    <Label htmlFor={`popup-prefix-${layer.id}-${config.field}`}>
                      {t("style.popup.prefix")}
                    </Label>
                    <Input
                      id={`popup-prefix-${layer.id}-${config.field}`}
                      value={config.format?.prefix ?? ""}
                      onChange={(event) =>
                        patchFormat(config, {
                          prefix: event.target.value || undefined,
                        })
                      }
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor={`popup-suffix-${layer.id}-${config.field}`}>
                      {t("style.popup.suffix")}
                    </Label>
                    <Input
                      id={`popup-suffix-${layer.id}-${config.field}`}
                      value={config.format?.suffix ?? ""}
                      onChange={(event) =>
                        patchFormat(config, {
                          suffix: event.target.value || undefined,
                        })
                      }
                    />
                  </div>
                </div>
              )}

              <label className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={config.hover === true}
                  onChange={(event) =>
                    patchField(config.field, {
                      hover: event.target.checked ? true : undefined,
                    })
                  }
                />
                <span>{t("style.popup.inHover")}</span>
              </label>
            </div>
          ))
        )}

        <div className="flex items-center gap-2">
          <Select
            aria-label={t("style.popup.addField")}
            value=""
            disabled={availableFields.length === 0}
            onChange={(event) => addField(event.target.value)}
          >
            <option value="">
              {availableFields.length === 0
                ? t("style.popup.noFieldsLeft")
                : t("style.popup.addField")}
            </option>
            {availableFields.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </Select>
          {configs.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="shrink-0"
              onClick={() => patchPopup({ fields: undefined })}
            >
              {t("style.popup.resetFields")}
            </Button>
          )}
        </div>
        {configs.length === 0 && fieldNames.length > 0 && (
          <Button variant="outline" size="sm" onClick={() => addField(fieldNames[0])}>
            <Plus className="me-1 h-3.5 w-3.5" />
            {t("style.popup.chooseFields")}
          </Button>
        )}
      </div>

      {builderTarget && (
        <ExpressionBuilderDialog
          open
          onOpenChange={(next) => {
            if (!next) setBuilderTarget(null);
          }}
          targetLabel={t(
            builderTarget === "title"
              ? "style.popup.titleExpression"
              : "style.popup.bodyExpression",
          )}
          context="value"
          initialExpression={
            builderTarget === "title" ? titleSource : (popup?.bodyExpression ?? "")
          }
          features={features}
          fieldNames={fieldNames}
          zoom={zoom}
          variables={variables}
          onApply={(expression) =>
            patchPopup(
              builderTarget === "title"
                ? { titleExpression: expression || undefined }
                : { bodyExpression: expression || undefined },
            )
          }
        />
      )}
    </div>
  );
}

import {
  attributeFormFieldLabel,
  parseValueMapText,
  useAppStore,
  validateMapExpression,
  valueMapToText,
  type AttributeFormFieldConfig,
  type AttributeFormWidget,
  type GeoLibreLayer,
} from "@geolibre/core";
import { Button, Input, Label, Select, Textarea } from "@geolibre/ui";
import { Pencil, Plus, SquareFunction, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  getAttributePropertyNames,
  standardExpressionVariables,
} from "../../lib/expression-inputs";
import { getSchema } from "../../lib/field-collection";
import { ExpressionBuilderDialog } from "../expressions/ExpressionBuilderDialog";

interface AttributeFormSectionProps {
  layer: GeoLibreLayer;
}

const WIDGETS: AttributeFormWidget[] = ["text", "number", "range", "checkbox", "date", "valueMap"];

/** Blank designer draft; `field` empty means "no field picked yet". */
interface FieldDraft {
  field: string;
  widget: AttributeFormWidget;
  alias: string;
  required: boolean;
  valueMapText: string;
  min: string;
  max: string;
  step: string;
  constraintExpression: string;
  constraintDescription: string;
  visibilityExpression: string;
}

function emptyDraft(): FieldDraft {
  return {
    field: "",
    widget: "text",
    alias: "",
    required: false,
    valueMapText: "",
    min: "",
    max: "",
    step: "",
    constraintExpression: "",
    constraintDescription: "",
    visibilityExpression: "",
  };
}

function draftFromConfig(config: AttributeFormFieldConfig): FieldDraft {
  return {
    field: config.field,
    widget: config.widget,
    alias: config.alias ?? "",
    required: config.required === true,
    valueMapText: valueMapToText(config.valueMap),
    min: config.min != null ? String(config.min) : "",
    max: config.max != null ? String(config.max) : "",
    step: config.step != null ? String(config.step) : "",
    constraintExpression: config.constraintExpression ?? "",
    constraintDescription: config.constraintDescription ?? "",
    visibilityExpression: config.visibilityExpression ?? "",
  };
}

/** Parse a bound/step input; blank or unparsable means "unset". */
function numberOrUndefined(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * The Attributes Form section of the layer style panel (QGIS Layer
 * Properties → Attributes Form): assign an edit widget per attribute field —
 * value map dropdown, range, checkbox, date picker, text — plus an optional
 * expression constraint and conditional visibility. The configuration is
 * enforced by the attribute table's inline editor and the Field Collection
 * capture form, and persists with the project.
 */
export function AttributeFormSection({ layer }: AttributeFormSectionProps) {
  const { t } = useTranslation();
  const projectName = useAppStore((s) => s.projectName);
  const setLayerAttributeForm = useAppStore((s) => s.setLayerAttributeForm);

  const configs = useMemo(() => layer.attributeForm?.fields ?? [], [layer.attributeForm]);
  // Feature properties plus any Field Collection schema keys, so a freshly
  // created (still empty) collection layer can be configured before its first
  // capture. Keyed on the data/schema pieces only, so unrelated style edits
  // to the layer do not repeat the O(features) property scan.
  const { type: layerType, metadata: layerMetadata, geojson: layerGeojson } = layer;
  const fieldNames = useMemo(() => {
    const source = {
      type: layerType,
      metadata: layerMetadata,
      geojson: layerGeojson,
    };
    const names = new Set(getAttributePropertyNames(source));
    for (const field of getSchema(source).fields) names.add(field.key);
    return [...names].sort((a, b) =>
      a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }),
    );
  }, [layerType, layerMetadata, layerGeojson]);
  const features = useMemo(() => layer.geojson?.features ?? [], [layer.geojson]);

  const [draft, setDraft] = useState<FieldDraft | null>(null);
  // Field name the open form is editing, or null when adding a new one.
  const [editingField, setEditingField] = useState<string | null>(null);
  const [builderTarget, setBuilderTarget] = useState<"constraint" | "visibility" | null>(null);

  // Camera snapshot for the modal Expression Builder, taken per render of the
  // (rarely-open) form rather than via a mapView subscription — see the
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

  // Fields still available to the add form (each field holds one config).
  const availableFields = useMemo(
    () =>
      fieldNames.filter(
        (name) => name === editingField || !configs.some((config) => config.field === name),
      ),
    [fieldNames, configs, editingField],
  );

  // Validated WITHOUT the `@` variable set on purpose: runtime evaluation
  // (attribute table and Field Collection saves) has no variables either, so
  // a hand-typed `@token` must fail here instead of validating at design time
  // and then rejecting every save. Tokens are still usable via the Expression
  // Builder, which bakes them into literal values on Apply.
  const constraintValidation = useMemo(
    () =>
      draft
        ? validateMapExpression(draft.constraintExpression, {
            expectedType: "boolean",
          })
        : null,
    [draft],
  );
  const visibilityValidation = useMemo(
    () =>
      draft
        ? validateMapExpression(draft.visibilityExpression, {
            expectedType: "boolean",
          })
        : null,
    [draft],
  );

  // A min above max would make validateAttributeFormField reject every value
  // with no hint that the configuration itself is broken, so refuse to save it.
  const draftMin = draft ? numberOrUndefined(draft.min) : undefined;
  const draftMax = draft ? numberOrUndefined(draft.max) : undefined;
  const minMaxInvalid =
    draft !== null &&
    (draft.widget === "number" || draft.widget === "range") &&
    draftMin !== undefined &&
    draftMax !== undefined &&
    draftMin > draftMax;

  const canSave =
    draft !== null &&
    draft.field !== "" &&
    !minMaxInvalid &&
    constraintValidation?.ok !== false &&
    visibilityValidation?.ok !== false &&
    (draft.widget !== "valueMap" || parseValueMapText(draft.valueMapText).length > 0);

  const closeForm = () => {
    setDraft(null);
    setEditingField(null);
    setBuilderTarget(null);
  };

  const saveDraft = () => {
    if (!draft || !canSave) return;
    const config: AttributeFormFieldConfig = {
      field: draft.field,
      widget: draft.widget,
      ...(draft.alias.trim() ? { alias: draft.alias.trim() } : {}),
      ...(draft.required ? { required: true } : {}),
      ...(draft.widget === "valueMap" ? { valueMap: parseValueMapText(draft.valueMapText) } : {}),
      ...(draft.widget === "number" || draft.widget === "range"
        ? {
            ...(numberOrUndefined(draft.min) !== undefined
              ? { min: numberOrUndefined(draft.min) }
              : {}),
            ...(numberOrUndefined(draft.max) !== undefined
              ? { max: numberOrUndefined(draft.max) }
              : {}),
          }
        : {}),
      ...(draft.widget === "range" && numberOrUndefined(draft.step) !== undefined
        ? { step: numberOrUndefined(draft.step) }
        : {}),
      ...(draft.constraintExpression.trim()
        ? { constraintExpression: draft.constraintExpression.trim() }
        : {}),
      ...(draft.constraintExpression.trim() && draft.constraintDescription.trim()
        ? { constraintDescription: draft.constraintDescription.trim() }
        : {}),
      ...(draft.visibilityExpression.trim()
        ? { visibilityExpression: draft.visibilityExpression.trim() }
        : {}),
    };
    const others = configs.filter((entry) => entry.field !== (editingField ?? draft.field));
    setLayerAttributeForm(layer.id, { fields: [...others, config] });
    closeForm();
  };

  const removeConfig = (field: string) => {
    const remaining = configs.filter((entry) => entry.field !== field);
    setLayerAttributeForm(layer.id, remaining.length ? { fields: remaining } : undefined);
  };

  const update = (patch: Partial<FieldDraft>) => {
    setDraft((current) => (current ? { ...current, ...patch } : current));
  };

  const expressionRow = (
    target: "constraint" | "visibility",
    value: string,
    validation: { ok: boolean; errors: string[] } | null,
  ) => (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor={`af-${target}-${layer.id}`}>
          {t(`style.attributeForm.${target}Expression`)}
        </Label>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 shrink-0"
          title={t("style.attributeForm.openBuilder")}
          aria-label={t("style.attributeForm.openBuilder")}
          onClick={() => setBuilderTarget(target)}
        >
          <SquareFunction className="h-3.5 w-3.5" />
        </Button>
      </div>
      <Textarea
        id={`af-${target}-${layer.id}`}
        rows={2}
        className="font-mono text-xs"
        value={value}
        placeholder={t(`style.attributeForm.${target}Placeholder`)}
        onChange={(event) =>
          update(
            target === "constraint"
              ? { constraintExpression: event.target.value }
              : { visibilityExpression: event.target.value },
          )
        }
      />
      {validation && !validation.ok && (
        <p className="text-xs text-destructive">
          {validation.errors[0] ?? t("style.attributeForm.invalidExpression")}
        </p>
      )}
    </div>
  );

  return (
    <div className="space-y-3" data-testid="attribute-form-section">
      <p className="text-sm font-semibold">{t("style.attributeForm.heading")}</p>
      {configs.length === 0 && !draft && (
        <p className="text-xs text-muted-foreground">{t("style.attributeForm.empty")}</p>
      )}
      {configs.map((config) => (
        <div
          key={config.field}
          className="space-y-1 rounded-md border border-input p-2"
          data-testid="attribute-form-item"
        >
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-sm">
              {attributeFormFieldLabel(config)}
            </span>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 shrink-0"
              title={t("style.attributeForm.edit")}
              aria-label={t("style.attributeForm.edit")}
              onClick={() => {
                setDraft(draftFromConfig(config));
                setEditingField(config.field);
              }}
            >
              <Pencil className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 shrink-0"
              title={t("style.attributeForm.remove")}
              aria-label={t("style.attributeForm.remove")}
              onClick={() => removeConfig(config.field)}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
          <p className="truncate text-xs text-muted-foreground">
            {config.field} · {t(`style.attributeForm.widget.${config.widget}`)}
            {config.required ? ` · ${t("style.attributeForm.requiredTag")}` : ""}
            {config.constraintExpression ? ` · ${t("style.attributeForm.constraintTag")}` : ""}
            {config.visibilityExpression ? ` · ${t("style.attributeForm.visibilityTag")}` : ""}
          </p>
        </div>
      ))}
      {draft ? (
        <div className="space-y-2 rounded-md border border-input p-2">
          <div className="space-y-1">
            <Label htmlFor={`af-field-${layer.id}`}>{t("style.attributeForm.field")}</Label>
            <Select
              id={`af-field-${layer.id}`}
              value={draft.field}
              onChange={(event) => update({ field: event.target.value })}
              disabled={editingField !== null}
            >
              <option value="">{t("style.attributeForm.selectField")}</option>
              {availableFields.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor={`af-widget-${layer.id}`}>{t("style.attributeForm.widgetLabel")}</Label>
            <Select
              id={`af-widget-${layer.id}`}
              value={draft.widget}
              onChange={(event) => update({ widget: event.target.value as AttributeFormWidget })}
            >
              {WIDGETS.map((widget) => (
                <option key={widget} value={widget}>
                  {t(`style.attributeForm.widget.${widget}`)}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor={`af-alias-${layer.id}`}>{t("style.attributeForm.alias")}</Label>
            <Input
              id={`af-alias-${layer.id}`}
              value={draft.alias}
              placeholder={draft.field || undefined}
              onChange={(event) => update({ alias: event.target.value })}
            />
          </div>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={draft.required}
              onChange={(event) => update({ required: event.target.checked })}
            />
            <span>{t("style.attributeForm.required")}</span>
          </label>
          {draft.widget === "valueMap" && (
            <div className="space-y-1">
              <Label htmlFor={`af-valuemap-${layer.id}`}>{t("style.attributeForm.valueMap")}</Label>
              <Textarea
                id={`af-valuemap-${layer.id}`}
                rows={3}
                className="font-mono text-xs"
                value={draft.valueMapText}
                placeholder={t("style.attributeForm.valueMapPlaceholder")}
                onChange={(event) => update({ valueMapText: event.target.value })}
              />
              <p className="text-xs text-muted-foreground">
                {t("style.attributeForm.valueMapHint")}
              </p>
            </div>
          )}
          {(draft.widget === "number" || draft.widget === "range") && (
            <div className="grid grid-cols-3 gap-2">
              <div className="space-y-1">
                <Label htmlFor={`af-min-${layer.id}`}>{t("style.attributeForm.min")}</Label>
                <Input
                  id={`af-min-${layer.id}`}
                  type="number"
                  value={draft.min}
                  onChange={(event) => update({ min: event.target.value })}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor={`af-max-${layer.id}`}>{t("style.attributeForm.max")}</Label>
                <Input
                  id={`af-max-${layer.id}`}
                  type="number"
                  value={draft.max}
                  onChange={(event) => update({ max: event.target.value })}
                />
              </div>
              {draft.widget === "range" && (
                <div className="space-y-1">
                  <Label htmlFor={`af-step-${layer.id}`}>{t("style.attributeForm.step")}</Label>
                  <Input
                    id={`af-step-${layer.id}`}
                    type="number"
                    value={draft.step}
                    onChange={(event) => update({ step: event.target.value })}
                  />
                </div>
              )}
            </div>
          )}
          {minMaxInvalid && (
            <p className="text-xs text-destructive">{t("style.attributeForm.minMaxInvalid")}</p>
          )}
          {expressionRow("constraint", draft.constraintExpression, constraintValidation)}
          {draft.constraintExpression.trim() !== "" && (
            <div className="space-y-1">
              <Label htmlFor={`af-constraint-desc-${layer.id}`}>
                {t("style.attributeForm.constraintDescription")}
              </Label>
              <Input
                id={`af-constraint-desc-${layer.id}`}
                value={draft.constraintDescription}
                placeholder={t("style.attributeForm.constraintDescriptionPlaceholder")}
                onChange={(event) => update({ constraintDescription: event.target.value })}
              />
            </div>
          )}
          {expressionRow("visibility", draft.visibilityExpression, visibilityValidation)}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={closeForm}>
              {t("style.attributeForm.cancel")}
            </Button>
            <Button size="sm" disabled={!canSave} onClick={saveDraft}>
              {t("style.attributeForm.save")}
            </Button>
          </div>
        </div>
      ) : (
        <Button
          variant="outline"
          size="sm"
          onClick={() => setDraft(emptyDraft())}
          disabled={availableFields.length === 0}
          title={availableFields.length === 0 ? t("style.attributeForm.noFields") : undefined}
        >
          <Plus className="me-1 h-3.5 w-3.5" />
          {t("style.attributeForm.configureField")}
        </Button>
      )}
      {builderTarget && draft && (
        <ExpressionBuilderDialog
          open
          onOpenChange={(next) => {
            if (!next) setBuilderTarget(null);
          }}
          targetLabel={t(`style.attributeForm.${builderTarget}Expression`)}
          context="filter"
          initialExpression={
            builderTarget === "constraint" ? draft.constraintExpression : draft.visibilityExpression
          }
          features={features}
          fieldNames={fieldNames}
          zoom={zoom}
          variables={variables}
          onApply={(expression) =>
            update(
              builderTarget === "constraint"
                ? { constraintExpression: expression }
                : { visibilityExpression: expression },
            )
          }
        />
      )}
    </div>
  );
}

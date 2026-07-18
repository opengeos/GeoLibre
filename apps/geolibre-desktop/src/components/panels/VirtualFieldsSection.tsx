import {
  type GeoLibreLayer,
  type LayerVirtualField,
  stripVirtualFieldColumns,
  useAppStore,
  validateMapExpression,
} from "@geolibre/core";
import { Button, Input, Label, Textarea } from "@geolibre/ui";
import { AlertTriangle, Pencil, Plus, SquareFunction, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { getAttributePropertyNames } from "../../lib/expression-inputs";
import { ExpressionBuilderDialog } from "../expressions/ExpressionBuilderDialog";

interface VirtualFieldsSectionProps {
  layer: GeoLibreLayer;
}

function newFieldId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `vfield-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

/**
 * The Virtual Fields section of the layer style panel (issue #1321, QGIS
 * Field Calculator → "Create virtual field"): lists the layer's
 * expression-backed columns with their status and an add/edit form. Virtual
 * fields recompute whenever the layer's data changes, appear everywhere
 * fields do (attribute table, styling, labels, selection), and persist with
 * the project. Expressions are MapLibre expressions, authored inline or via
 * the shared Expression Builder.
 *
 * Note the deliberate contrast with the attribute table's Field Calculator:
 * that dialog's JavaScript expressions run once and write static values (and
 * are never persisted); a virtual field's declarative expression is persisted
 * and re-evaluated live, which is safe because it compiles through the
 * MapLibre style spec rather than executing code.
 */
export function VirtualFieldsSection({ layer }: VirtualFieldsSectionProps) {
  const { t } = useTranslation();
  const setLayerVirtualFields = useAppStore((s) => s.setLayerVirtualFields);

  const fields = useMemo(() => layer.virtualFields ?? [], [layer.virtualFields]);

  const [formOpen, setFormOpen] = useState(false);
  // null while adding; the edited field's id while editing.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const [draftExpression, setDraftExpression] = useState("");
  const [builderOpen, setBuilderOpen] = useState(false);

  // Stable identities for the Expression Builder's memoization (see the
  // equivalent comment in SelectByExpressionDialog).
  const features = useMemo(() => layer.geojson?.features ?? [], [layer.geojson]);
  const fieldNames = useMemo(() => getAttributePropertyNames(layer), [layer]);

  // The engine evaluates a field against only the columns materialized by
  // *earlier* fields (its own and later columns are stripped first), so the
  // builder's preview context must match: when editing, hide the edited
  // field's column and every later field's column, or a self-reference would
  // preview successfully and then evaluate to null. A new field appends last
  // and legitimately sees every existing column.
  const editedAndLaterFields = useMemo(() => {
    if (!editingId) return [];
    const index = fields.findIndex((field) => field.id === editingId);
    return index < 0 ? [] : fields.slice(index);
  }, [fields, editingId]);
  const builderFeatures = useMemo(
    () => stripVirtualFieldColumns(features, editedAndLaterFields),
    [features, editedAndLaterFields],
  );
  const builderFieldNames = useMemo(() => {
    const hidden = new Set(
      editedAndLaterFields.flatMap((field) => (field.addedField ? [field.addedField] : [])),
    );
    return hidden.size === 0 ? fieldNames : fieldNames.filter((name) => !hidden.has(name));
  }, [fieldNames, editedAndLaterFields]);

  // Names the draft may not use: every existing column plus the other virtual
  // field definitions (which may be currently skipped and so not materialized).
  // The edited field's own materialized column is fair game — keeping the
  // name while changing the expression must not read as a conflict.
  const takenNames = useMemo(() => {
    const names = new Set(fieldNames);
    for (const field of fields) {
      if (field.id !== editingId) names.add(field.name.trim());
    }
    if (editingId) {
      const editing = fields.find((field) => field.id === editingId);
      if (editing?.addedField) names.delete(editing.addedField);
    }
    return names;
  }, [fieldNames, fields, editingId]);

  const trimmedName = draftName.trim();
  const nameConflict = trimmedName.length > 0 && takenNames.has(trimmedName);
  const validation = useMemo(() => validateMapExpression(draftExpression), [draftExpression]);
  const canSubmit =
    trimmedName.length > 0 && !nameConflict && draftExpression.trim().length > 0 && validation.ok;

  const resetForm = () => {
    setEditingId(null);
    setDraftName("");
    setDraftExpression("");
  };

  const openAddForm = () => {
    resetForm();
    setFormOpen(true);
  };

  const openEditForm = (field: LayerVirtualField) => {
    setEditingId(field.id);
    setDraftName(field.name);
    setDraftExpression(field.expression);
    setFormOpen(true);
  };

  const submitField = () => {
    if (!canSubmit) return;
    if (editingId) {
      setLayerVirtualFields(
        layer.id,
        fields.map((field) =>
          field.id === editingId
            ? { ...field, name: trimmedName, expression: draftExpression }
            : field,
        ),
      );
    } else {
      setLayerVirtualFields(layer.id, [
        ...fields,
        { id: newFieldId(), name: trimmedName, expression: draftExpression },
      ]);
    }
    resetForm();
    setFormOpen(false);
  };

  const toggleField = (id: string, enabled: boolean) => {
    setLayerVirtualFields(
      layer.id,
      fields.map((field) => (field.id === id ? { ...field, enabled } : field)),
    );
  };

  const removeField = (id: string) => {
    setLayerVirtualFields(
      layer.id,
      fields.filter((field) => field.id !== id),
    );
    if (editingId === id) {
      resetForm();
      setFormOpen(false);
    }
  };

  return (
    <div className="space-y-3" data-testid="virtual-fields-section">
      <p className="text-sm font-semibold">{t("style.virtualFields.heading")}</p>
      {fields.length === 0 && !formOpen && (
        <p className="text-xs text-muted-foreground">{t("style.virtualFields.empty")}</p>
      )}
      {fields.map((field) => {
        const enabled = field.enabled !== false;
        // Enabled but not materialized and not a compile error means the name
        // collided with an existing column and the field was skipped.
        const conflict = enabled && !field.addedField && !field.error;
        return (
          <div
            key={field.id}
            className="space-y-1 rounded-md border border-input p-2"
            data-testid="virtual-field-item"
          >
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(event) => toggleField(field.id, event.target.checked)}
                title={t("style.virtualFields.enabledTitle")}
                aria-label={t("style.virtualFields.enabledTitle")}
              />
              <SquareFunction className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-sm italic">{field.name}</span>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 shrink-0"
                title={t("style.virtualFields.edit")}
                aria-label={t("style.virtualFields.edit")}
                onClick={() => openEditForm(field)}
              >
                <Pencil className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 shrink-0"
                title={t("style.virtualFields.remove")}
                aria-label={t("style.virtualFields.remove")}
                onClick={() => removeField(field.id)}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
            <p className="truncate font-mono text-xs text-muted-foreground">{field.expression}</p>
            {field.error && (
              <p className="flex items-center gap-1 text-xs text-destructive">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{field.error}</span>
              </p>
            )}
            {conflict && (
              <p className="flex items-center gap-1 text-xs text-destructive">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                {t("style.virtualFields.nameConflict")}
              </p>
            )}
            {enabled && (field.errorCount ?? 0) > 0 && (
              <p className="text-xs text-muted-foreground">
                {t("style.virtualFields.evaluationErrors", {
                  count: field.errorCount,
                })}
              </p>
            )}
          </div>
        );
      })}
      {formOpen ? (
        <div className="space-y-2 rounded-md border border-input p-2">
          <div className="space-y-1">
            <Label htmlFor={`virtual-field-name-${layer.id}`}>
              {t("style.virtualFields.name")}
            </Label>
            <Input
              id={`virtual-field-name-${layer.id}`}
              value={draftName}
              onChange={(event) => setDraftName(event.target.value)}
              placeholder={t("style.virtualFields.namePlaceholder")}
            />
            {nameConflict && (
              <p className="text-xs text-destructive">{t("style.virtualFields.nameTaken")}</p>
            )}
          </div>
          <div className="space-y-1">
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor={`virtual-field-expression-${layer.id}`}>
                {t("style.virtualFields.expression")}
              </Label>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setBuilderOpen(true)}
              >
                <SquareFunction className="me-2 h-3.5 w-3.5" />
                {t("style.virtualFields.openBuilder")}
              </Button>
            </div>
            <Textarea
              id={`virtual-field-expression-${layer.id}`}
              value={draftExpression}
              onChange={(event) => setDraftExpression(event.target.value)}
              placeholder={t("style.virtualFields.expressionPlaceholder")}
              spellCheck={false}
              className="min-h-16 font-mono text-xs"
            />
            {draftExpression.trim().length > 0 && !validation.ok && (
              <p className="text-xs text-destructive">
                {validation.errors[0] ?? t("style.virtualFields.invalidExpression")}
              </p>
            )}
          </div>
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                resetForm();
                setFormOpen(false);
              }}
            >
              {t("style.virtualFields.cancel")}
            </Button>
            <Button size="sm" disabled={!canSubmit} onClick={submitField}>
              {editingId ? t("style.virtualFields.save") : t("style.virtualFields.add")}
            </Button>
          </div>
        </div>
      ) : (
        <Button variant="outline" size="sm" onClick={openAddForm}>
          <Plus className="me-1 h-3.5 w-3.5" />
          {t("style.virtualFields.addField")}
        </Button>
      )}
      {builderOpen && (
        <ExpressionBuilderDialog
          open
          onOpenChange={(next) => setBuilderOpen(next)}
          targetLabel={t("style.virtualFields.expressionTarget")}
          context="value"
          initialExpression={draftExpression}
          features={builderFeatures}
          fieldNames={builderFieldNames}
          // Virtual fields evaluate at zoom 0 with no `@` variables (they are
          // a property of the data, not the view) — mirror that in the
          // builder's preview so what it shows is what materializes.
          zoom={0}
          variables={[]}
          onApply={(expression) => setDraftExpression(expression)}
        />
      )}
    </div>
  );
}

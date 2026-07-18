import {
  collectTransitiveJoinSourceIds,
  type GeoLibreLayer,
  type LayerJoin,
  useAppStore,
} from "@geolibre/core";
import { Button, Input, Label, Select } from "@geolibre/ui";
import { AlertTriangle, Plus, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { getAttributePropertyNames } from "../../lib/expression-inputs";

interface LayerJoinsSectionProps {
  layer: GeoLibreLayer;
}

function newJoinId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `join-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

/**
 * The Joins section of the layer style panel (QGIS Layer Properties → Joins):
 * lists the layer's persistent attribute joins with their match statistics and
 * an add form. Joins attach columns from another layer — typically a
 * geometry-less table added via Delimited Text with no coordinate fields — by
 * matching key fields, live: the columns re-derive when either side's data
 * changes and the definitions persist with the project.
 */
export function LayerJoinsSection({ layer }: LayerJoinsSectionProps) {
  const { t } = useTranslation();
  const layers = useAppStore((s) => s.layers);
  const setLayerJoins = useAppStore((s) => s.setLayerJoins);

  const joins = useMemo(() => layer.joins ?? [], [layer.joins]);

  // Any other layer with attribute rows can serve as the join table; its
  // geometry (if any) is ignored. A layer whose own joins already consume this
  // one (however indirectly) is excluded so a circular join cannot be authored.
  const candidateLayers = useMemo(
    () =>
      layers.filter(
        (candidate) =>
          candidate.id !== layer.id &&
          (candidate.geojson?.features?.length ?? 0) > 0 &&
          !collectTransitiveJoinSourceIds(layers, candidate.id).has(layer.id),
      ),
    [layers, layer.id],
  );

  const [formOpen, setFormOpen] = useState(false);
  const [draftJoinLayerId, setDraftJoinLayerId] = useState("");
  const [draftTargetField, setDraftTargetField] = useState("");
  const [draftJoinField, setDraftJoinField] = useState("");
  const [draftPrefix, setDraftPrefix] = useState("");
  // null means "all fields" (the checkbox list untouched); a Set is the subset.
  const [draftFields, setDraftFields] = useState<Set<string> | null>(null);

  const targetFieldNames = useMemo(() => getAttributePropertyNames(layer), [layer]);
  const draftJoinLayer = candidateLayers.find((candidate) => candidate.id === draftJoinLayerId);
  const joinFieldNames = useMemo(
    () => (draftJoinLayer ? getAttributePropertyNames(draftJoinLayer) : []),
    [draftJoinLayer],
  );
  // The checklist offers only non-key fields, matching the engine's default of
  // "every field except the key" — so an untouched list and a fully-checked
  // list mean the same thing.
  const subsetFieldNames = useMemo(
    () => joinFieldNames.filter((name) => name !== draftJoinField),
    [joinFieldNames, draftJoinField],
  );

  const resetForm = () => {
    setDraftJoinLayerId("");
    setDraftTargetField("");
    setDraftJoinField("");
    setDraftPrefix("");
    setDraftFields(null);
  };

  // A selected-but-empty subset would join no columns; require at least one.
  const subsetEmpty =
    draftFields !== null &&
    subsetFieldNames.length > 0 &&
    subsetFieldNames.every((name) => !draftFields.has(name));

  const addJoin = () => {
    if (!draftJoinLayerId || !draftTargetField || !draftJoinField || subsetEmpty) return;
    const subset =
      draftFields === null ? undefined : subsetFieldNames.filter((name) => draftFields.has(name));
    const join: LayerJoin = {
      id: newJoinId(),
      joinLayerId: draftJoinLayerId,
      targetField: draftTargetField,
      joinField: draftJoinField,
      ...(subset && subset.length < subsetFieldNames.length ? { fields: subset } : {}),
      ...(draftPrefix.trim() ? { prefix: draftPrefix.trim() } : {}),
    };
    setLayerJoins(layer.id, [...joins, join]);
    resetForm();
    setFormOpen(false);
  };

  const toggleJoin = (id: string, enabled: boolean) => {
    setLayerJoins(
      layer.id,
      joins.map((join) => (join.id === id ? { ...join, enabled } : join)),
    );
  };

  const removeJoin = (id: string) => {
    setLayerJoins(
      layer.id,
      joins.filter((join) => join.id !== id),
    );
  };

  const toggleDraftField = (name: string, checked: boolean) => {
    setDraftFields((previous) => {
      const next = new Set(previous ?? subsetFieldNames);
      if (checked) next.add(name);
      else next.delete(name);
      return next;
    });
  };

  return (
    <div className="space-y-3" data-testid="layer-joins-section">
      <p className="text-sm font-semibold">{t("style.joins.heading")}</p>
      {joins.length === 0 && !formOpen && (
        <p className="text-xs text-muted-foreground">{t("style.joins.empty")}</p>
      )}
      {joins.map((join) => {
        const joinLayer = layers.find((candidate) => candidate.id === join.joinLayerId);
        const stats = join.stats;
        const total = stats ? stats.matchedCount + stats.unmatchedTargetCount : 0;
        return (
          <div
            key={join.id}
            className="space-y-1 rounded-md border border-input p-2"
            data-testid="layer-join-item"
          >
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={join.enabled !== false}
                onChange={(event) => toggleJoin(join.id, event.target.checked)}
                title={t("style.joins.enabledTitle")}
                aria-label={t("style.joins.enabledTitle")}
              />
              <span className="min-w-0 flex-1 truncate text-sm">
                {joinLayer ? (
                  joinLayer.name
                ) : (
                  <span className="inline-flex items-center gap-1 text-destructive">
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                    {t("style.joins.missingLayer")}
                  </span>
                )}
              </span>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 shrink-0"
                title={t("style.joins.remove")}
                aria-label={t("style.joins.remove")}
                onClick={() => removeJoin(join.id)}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
            <p className="truncate text-xs text-muted-foreground">
              {join.targetField} = {join.joinField}
              {join.prefix ? ` · ${join.prefix}*` : ""}
              {join.fields
                ? ` · ${t("style.joins.fieldCount", { count: join.fields.length })}`
                : ""}
            </p>
            {join.enabled !== false && stats && (
              <p className="text-xs text-muted-foreground">
                {t("style.joins.statsMatched", {
                  matched: stats.matchedCount,
                  total,
                })}
                {stats.unmatchedJoinCount > 0
                  ? ` · ${t("style.joins.statsUnmatchedJoin", {
                      count: stats.unmatchedJoinCount,
                    })}`
                  : ""}
              </p>
            )}
          </div>
        );
      })}
      {formOpen ? (
        <div className="space-y-2 rounded-md border border-input p-2">
          <div className="space-y-1">
            <Label htmlFor={`join-layer-${layer.id}`}>{t("style.joins.joinLayer")}</Label>
            <Select
              id={`join-layer-${layer.id}`}
              value={draftJoinLayerId}
              onChange={(event) => {
                setDraftJoinLayerId(event.target.value);
                setDraftJoinField("");
                setDraftFields(null);
              }}
            >
              <option value="">{t("style.joins.selectLayer")}</option>
              {candidateLayers.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.name}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor={`join-field-${layer.id}`}>{t("style.joins.joinField")}</Label>
            <Select
              id={`join-field-${layer.id}`}
              value={draftJoinField}
              onChange={(event) => {
                setDraftJoinField(event.target.value);
                // The checklist's field pool excludes the key, so a key change
                // invalidates any subset picked against the old pool.
                setDraftFields(null);
              }}
              disabled={!draftJoinLayer}
            >
              <option value="">{t("style.joins.selectField")}</option>
              {joinFieldNames.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor={`target-field-${layer.id}`}>{t("style.joins.targetField")}</Label>
            <Select
              id={`target-field-${layer.id}`}
              value={draftTargetField}
              onChange={(event) => setDraftTargetField(event.target.value)}
            >
              <option value="">{t("style.joins.selectField")}</option>
              {targetFieldNames.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </Select>
          </div>
          {subsetFieldNames.length > 0 && (
            <div className="space-y-1">
              <Label>{t("style.joins.fields")}</Label>
              <div className="max-h-32 space-y-1 overflow-y-auto rounded-md border border-input p-2">
                {subsetFieldNames.map((name) => (
                  <label key={name} className="flex items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={draftFields === null || draftFields.has(name)}
                      onChange={(event) => toggleDraftField(name, event.target.checked)}
                    />
                    <span className="truncate">{name}</span>
                  </label>
                ))}
              </div>
            </div>
          )}
          <div className="space-y-1">
            <Label htmlFor={`join-prefix-${layer.id}`}>{t("style.joins.prefix")}</Label>
            <Input
              id={`join-prefix-${layer.id}`}
              value={draftPrefix}
              onChange={(event) => setDraftPrefix(event.target.value)}
              placeholder={t("style.joins.prefixPlaceholder")}
            />
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
              {t("style.joins.cancel")}
            </Button>
            <Button
              size="sm"
              disabled={!draftJoinLayerId || !draftTargetField || !draftJoinField || subsetEmpty}
              onClick={addJoin}
            >
              {t("style.joins.add")}
            </Button>
          </div>
        </div>
      ) : (
        <Button
          variant="outline"
          size="sm"
          onClick={() => setFormOpen(true)}
          disabled={candidateLayers.length === 0}
          title={candidateLayers.length === 0 ? t("style.joins.noCandidates") : undefined}
        >
          <Plus className="me-1 h-3.5 w-3.5" />
          {t("style.joins.addJoin")}
        </Button>
      )}
    </div>
  );
}

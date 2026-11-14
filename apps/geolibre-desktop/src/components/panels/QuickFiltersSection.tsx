import {
  compileQuickFilters,
  useAppStore,
  type GeoLibreLayer,
  type LayerQuickFilter,
} from "@geolibre/core";
import type { MapEngine } from "@geolibre/map";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@geolibre/ui";
import { ChevronDown, Filter, Info } from "lucide-react";
import { useMemo, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { useQuickFilterProfiles } from "../../hooks/useQuickFilterProfiles";
import type { QuickFilterFieldProfile } from "../../lib/quick-filter-profile";
import { QuickFilterControl } from "./QuickFilterControl";

interface QuickFiltersSectionProps {
  layer: GeoLibreLayer;
  mapControllerRef: RefObject<MapEngine | null>;
  /** Bumped when the map (re)initializes; see {@link useQuickFilterProfiles}. */
  mapReadyGeneration?: number;
}

function newFilterId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `quick-filter-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

/**
 * Build the control a field's profile calls for, pre-filled with nothing so a
 * newly added filter shows every feature until it is answered.
 *
 * A field with no profile (its values could not be read, say because a
 * tile-backed layer's loaded tiles changed between listing the field and
 * picking it) still gets a text match, the one control that needs no profile,
 * rather than the pick being dropped.
 */
function filterForField(
  field: string,
  profile: QuickFilterFieldProfile | undefined,
): LayerQuickFilter {
  return {
    id: newFilterId(),
    field,
    kind: profile?.kind ?? "text",
    ...(profile?.dateKind ? { dateKind: profile.dateKind } : {}),
  };
}

/**
 * The Quick Filters section of the layer style panel (issue #2114): per-field
 * filter controls derived from the data — checkboxes with counts for a
 * categorical field, a range for a numeric one, a date range for a timestamp,
 * a text match otherwise.
 *
 * What is stored is the control state, not the compiled expression, so a saved
 * filter can always be reopened and changed. `@geolibre/map` compiles it at
 * sync time and combines it with the Time Slider's window, the embed API's
 * `setFilter`, and the rule-based renderer's own filter under one `all`, so
 * these controls narrow the layer alongside those rather than replacing them.
 *
 * A filter hides features; it does not select them. Use Select by Expression
 * (or the selection tools) when the goal is to act on features rather than to
 * take them off the map.
 */
export function QuickFiltersSection({
  layer,
  mapControllerRef,
  mapReadyGeneration,
}: QuickFiltersSectionProps) {
  const { t, i18n } = useTranslation();
  const setLayerQuickFilters = useAppStore((s) => s.setLayerQuickFilters);
  const {
    fields,
    fieldsLoading,
    byField,
    loadingFields,
    profileField,
    sampledFromViewport,
    partialSample,
    empty,
  } = useQuickFilterProfiles(layer, mapControllerRef, mapReadyGeneration, { listFields: true });
  // The field being profiled between its pick from the menu and its filter
  // being added. Only a large layer holds it long enough to notice.
  const [addingField, setAddingField] = useState<string | null>(null);

  const filters = useMemo(() => layer.quickFilters ?? [], [layer.quickFilters]);
  const used = useMemo(() => new Set(filters.map((filter) => filter.field)), [filters]);
  const addable = useMemo(() => fields.filter((field) => !used.has(field)), [fields, used]);
  const activeCount = useMemo(
    () => filters.filter((filter) => compileQuickFilters([filter]) !== null).length,
    [filters],
  );

  const update = (next: LayerQuickFilter[]): void => setLayerQuickFilters(layer.id, next);

  // A field's profile decides which control it gets, and is computed only now
  // that the field has been picked (issue #3426), so adding a filter waits for
  // it. The section is keyed by layer, so the filter lands on the layer it was
  // picked on, profiled from that layer's records. The layer's filters are
  // re-read afterwards: they may have changed in the meantime.
  const layerId = layer.id;
  const addField = async (field: string): Promise<void> => {
    setAddingField(field);
    let profile: QuickFilterFieldProfile | undefined;
    try {
      profile = await profileField(field);
    } finally {
      setAddingField(null);
    }
    const current =
      useAppStore.getState().layers.find((candidate) => candidate.id === layerId)?.quickFilters ??
      [];
    if (current.some((filter) => filter.field === field)) return;
    setLayerQuickFilters(layerId, [...current, filterForField(field, profile)]);
  };

  return (
    <div className="space-y-2" data-testid="quick-filters-section">
      <div className="flex items-center gap-2">
        <p className="flex-1 text-sm font-semibold">{t("quickFilters.heading")}</p>
        {activeCount > 0 && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={() => update([])}
            data-testid="quick-filters-clear-all"
          >
            {t("quickFilters.removeAll")}
          </Button>
        )}
      </div>

      {filters.length === 0 && (
        <p className="text-xs text-muted-foreground">{t("quickFilters.empty")}</p>
      )}

      {filters.map((filter) => (
        <QuickFilterControl
          key={filter.id}
          filter={filter}
          profile={byField.get(filter.field)}
          loading={loadingFields.has(filter.field)}
          idPrefix={`style-${layer.id}`}
          onChange={(next) =>
            update(filters.map((current) => (current.id === filter.id ? next : current)))
          }
          onRemove={() => update(filters.filter((current) => current.id !== filter.id))}
        />
      ))}

      {empty ? (
        <p className="text-xs text-muted-foreground">
          {sampledFromViewport ? t("quickFilters.noTileFeatures") : t("quickFilters.noFields")}
        </p>
      ) : (
        <div className="flex items-center gap-2">
          <Filter className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          {/* A menu rather than a `<select>`: this is a command ("add a filter
              on this field"), not a value, and a controlled `<select value="">`
              is re-asserted on every commit — which closes the native popup
              whenever the section re-renders underneath it (a tile-backed layer
              re-samples on every map `idle` while its tiles settle). The menu
              owns its own open state and portals its content, so a re-render
              cannot dismiss it. It also scrolls, which a long attribute table
              needs. */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="h-9 flex-1 justify-between font-normal"
                disabled={addable.length === 0 || addingField !== null}
                aria-busy={fieldsLoading || addingField !== null}
              >
                {addingField !== null
                  ? t("quickFilters.loadingValues")
                  : addable.length === 0 && !fieldsLoading
                    ? t("quickFilters.allFieldsUsed")
                    : t("quickFilters.addFilter")}
                <ChevronDown className="h-4 w-4 shrink-0 opacity-50" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="max-h-64 overflow-y-auto">
              {addable.map((field) => (
                <DropdownMenuItem key={field} onSelect={() => void addField(field)}>
                  {field}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}

      {sampledFromViewport && !empty && (
        <p className="flex items-start gap-1 text-xs text-muted-foreground">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {t("quickFilters.viewportSampleHint")}
        </p>
      )}

      {partialSample && !empty && (
        <p className="flex items-start gap-1 text-xs text-muted-foreground">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {t("quickFilters.partialSampleHint", {
            inspected: partialSample.inspected.toLocaleString(i18n.language),
            total: partialSample.total.toLocaleString(i18n.language),
          })}
        </p>
      )}
    </div>
  );
}

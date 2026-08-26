import {
  compileQuickFilters,
  useAppStore,
  type GeoLibreLayer,
  type LayerQuickFilter,
} from "@geolibre/core";
import type { MapController } from "@geolibre/map";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@geolibre/ui";
import { ChevronDown, Filter, Info } from "lucide-react";
import { useMemo, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { useQuickFilterProfiles } from "../../hooks/useQuickFilterProfiles";
import type { QuickFilterFieldProfile } from "../../lib/quick-filter-profile";
import { QuickFilterControl } from "./QuickFilterControl";

interface QuickFiltersSectionProps {
  layer: GeoLibreLayer;
  mapControllerRef: RefObject<MapController | null>;
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
 */
function filterForProfile(profile: QuickFilterFieldProfile): LayerQuickFilter {
  return {
    id: newFilterId(),
    field: profile.field,
    kind: profile.kind,
    ...(profile.dateKind ? { dateKind: profile.dateKind } : {}),
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
  const { t } = useTranslation();
  const setLayerQuickFilters = useAppStore((s) => s.setLayerQuickFilters);
  const { profiles, byField, sampledFromViewport, empty } = useQuickFilterProfiles(
    layer,
    mapControllerRef,
    mapReadyGeneration,
  );

  const filters = useMemo(() => layer.quickFilters ?? [], [layer.quickFilters]);
  const used = useMemo(() => new Set(filters.map((filter) => filter.field)), [filters]);
  const addable = useMemo(
    () => profiles.filter((profile) => !used.has(profile.field)),
    [profiles, used],
  );
  const activeCount = useMemo(
    () => filters.filter((filter) => compileQuickFilters([filter]) !== null).length,
    [filters],
  );

  const update = (next: LayerQuickFilter[]): void => setLayerQuickFilters(layer.id, next);

  const addField = (field: string): void => {
    const profile = byField.get(field);
    if (!profile) return;
    update([...filters, filterForProfile(profile)]);
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
                disabled={addable.length === 0}
              >
                {addable.length === 0
                  ? t("quickFilters.allFieldsUsed")
                  : t("quickFilters.addFilter")}
                <ChevronDown className="h-4 w-4 shrink-0 opacity-50" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="max-h-64 overflow-y-auto">
              {addable.map((profile) => (
                <DropdownMenuItem key={profile.field} onSelect={() => addField(profile.field)}>
                  {profile.field}
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
    </div>
  );
}

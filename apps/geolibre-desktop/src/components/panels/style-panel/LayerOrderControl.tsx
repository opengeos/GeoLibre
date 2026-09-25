import { useAppStore, type GeoLibreLayer, type LayerSummary } from "@geolibre/core";
import { Label, Select } from "@geolibre/ui";
import type { MapEngine } from "@geolibre/map";
import type { RefObject } from "react";
import { useTranslation } from "react-i18next";

interface LayerOrderControlProps {
  layer: GeoLibreLayer;
  layerSummaries: LayerSummary[];
  draftBeforeId: string;
  setDraftBeforeId: (value: string) => void;
  showBasemapStyleLayers: boolean;
  setShowBasemapStyleLayers: (value: boolean) => void;
  elevation3dActive: boolean;
  mapControllerRef: RefObject<MapEngine | null>;
}

/**
 * The "Insert below" select: reorders among the user's layers or pins the
 * layer below a basemap style layer.
 *
 * @param props - The layer, the other layers, the draft selection and the map.
 * @returns The labelled select plus the basemap-layers toggle.
 */
export function LayerOrderControl({
  layer,
  layerSummaries,
  draftBeforeId,
  setDraftBeforeId,
  showBasemapStyleLayers,
  setShowBasemapStyleLayers,
  elevation3dActive,
  mapControllerRef,
}: LayerOrderControlProps) {
  const { t } = useTranslation();
  const updateLayer = useAppStore((s) => s.updateLayer);
  const moveLayer = useAppStore((s) => s.moveLayer);
  const applyBeforeId = (value: string) => {
    // Picking another user layer is a one-shot reorder in the layer list;
    // beforeId metadata only works for raw MapLibre (basemap) layer ids.
    const otherLayers = layerSummaries.filter((l) => l.id !== layer.id);
    const targetIndex = otherLayers.findIndex((l) => l.id === value);
    if (targetIndex >= 0) {
      setDraftBeforeId("");
      // Move first so the sync triggered by each store update already sees
      // the correct array position.
      moveLayer(layer.id, targetIndex);
      if (layer.beforeId) updateLayer(layer.id, { beforeId: undefined });
      return;
    }
    setDraftBeforeId(value);
    const nextBeforeId = value.trim() || undefined;
    if (nextBeforeId !== layer.beforeId) {
      updateLayer(layer.id, { beforeId: nextBeforeId });
    }
  };
  // NOTE: not reactive to basemap switches — the ref does not trigger a
  // re-render, so the list refreshes on the next store-driven render.
  const basemapStyleLayerIds = mapControllerRef.current?.getBasemapStyleLayerIds() ?? [];
  const otherLayers = layerSummaries.filter((l) => l.id !== layer.id);
  // While 3D (Z values) is active the basemap group below is hidden, so a
  // saved basemap target surfaces under "Saved (unavailable)" instead of
  // leaving the select pointing at a missing option.
  const beforeIdHiddenByElevation3d =
    elevation3dActive && basemapStyleLayerIds.includes(draftBeforeId);
  const orphanedBeforeId =
    draftBeforeId &&
    (beforeIdHiddenByElevation3d ||
      (!basemapStyleLayerIds.includes(draftBeforeId) &&
        !otherLayers.some((l) => l.id === draftBeforeId)))
      ? draftBeforeId
      : null;
  // The basemap style exposes dozens of internal layer ids that overwhelm the
  // dropdown for standard users (issue #834). Keep them behind an opt-in
  // "advanced" toggle so the default list only shows the user's own layers —
  // but reveal them automatically if the current value is one of them.
  const valueIsBasemapStyleLayer = basemapStyleLayerIds.includes(draftBeforeId);
  const basemapStyleLayersVisible = showBasemapStyleLayers || valueIsBasemapStyleLayer;
  return (
    <div className="space-y-2">
      <Label htmlFor="beforeId">{t("addData.shared.insertBelow")}</Label>
      <Select
        id="beforeId"
        value={draftBeforeId}
        onChange={(event) => applyBeforeId(event.target.value)}
      >
        <option value="">{t("style.layerOrderDefault")}</option>
        {orphanedBeforeId && (
          <optgroup label={t("style.beforeIdSavedUnavailable")}>
            <option value={orphanedBeforeId}>{orphanedBeforeId}</option>
          </optgroup>
        )}
        {otherLayers.length > 0 && (
          <optgroup label={t("addData.shared.layersGroup")}>
            {[...otherLayers].reverse().map((otherLayer) => (
              <option key={otherLayer.id} value={otherLayer.id}>
                {otherLayer.name}
              </option>
            ))}
          </optgroup>
        )}
        {/* The 3D Z-value render (deck.gl overlay) honors store order for
            user layers but has no MapLibre layer to insert below a basemap
            style layer, so hide that group rather than offer a silently
            ignored setting. */}
        {basemapStyleLayerIds.length > 0 && basemapStyleLayersVisible && !elevation3dActive && (
          <optgroup label={t("addData.shared.basemapLayersGroup")}>
            {basemapStyleLayerIds.map((styleLayerId) => (
              <option key={styleLayerId} value={styleLayerId}>
                {styleLayerId}
              </option>
            ))}
          </optgroup>
        )}
      </Select>
      {basemapStyleLayerIds.length > 0 && !valueIsBasemapStyleLayer && !elevation3dActive && (
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            aria-controls="beforeId"
            checked={showBasemapStyleLayers}
            onChange={(event) => setShowBasemapStyleLayers(event.target.checked)}
          />
          {t("addData.shared.showBasemapLayers")}
        </label>
      )}
    </div>
  );
}

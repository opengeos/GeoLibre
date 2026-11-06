import { useAppStore, type GeoLibreLayer } from "@geolibre/core";
import {
  setI3sBuildingNodeVisible,
  visibleI3sBuildingSublayers,
  type I3sBuildingNode,
  type I3sBuildingState,
} from "@geolibre/plugins";
import { useTranslation } from "react-i18next";

/**
 * The Style panel's Building section for an ArcGIS I3S Building Scene Layer
 * (issue #3341): draw the Overview (the building shell) or the full BIM model,
 * and choose which disciplines and categories of it are drawn. The choice is
 * saved on the layer as `metadata.i3sBuilding`.
 */
export function I3sBuildingSection({ layer }: { layer: GeoLibreLayer }) {
  const { t } = useTranslation();
  const updateLayer = useAppStore((state) => state.updateLayer);
  const state = layer.metadata.i3sBuilding as I3sBuildingState | undefined;
  if (!state) return null;

  const save = (next: I3sBuildingState) =>
    updateLayer(layer.id, { metadata: { ...layer.metadata, i3sBuilding: next } });
  const drawn = visibleI3sBuildingSublayers(state).length;

  const node = (item: I3sBuildingNode, depth: number) => (
    <li key={item.id}>
      <label className="flex items-center gap-2 text-sm" style={{ paddingInlineStart: depth * 16 }}>
        <input
          type="checkbox"
          checked={item.visible}
          onChange={(event) =>
            save(setI3sBuildingNodeVisible(state, item.id, event.target.checked))
          }
          data-testid={`i3s-building-node-${item.id}`}
        />
        <span className={item.children ? "font-medium" : undefined}>{item.name}</span>
      </label>
      {item.children && item.visible ? (
        <ul className="mt-1 space-y-1">{item.children.map((child) => node(child, depth + 1))}</ul>
      ) : null}
    </li>
  );

  return (
    <div className="space-y-2" data-testid="i3s-building-section">
      <p className="text-sm font-semibold">{t("style.i3sBuilding.heading")}</p>
      <div
        className="flex gap-4 text-sm"
        role="radiogroup"
        aria-label={t("style.i3sBuilding.heading")}
      >
        <label className="flex items-center gap-2">
          <input
            type="radio"
            name={`i3s-building-mode-${layer.id}`}
            checked={state.mode === "overview"}
            disabled={state.overviewId === null}
            onChange={() => save({ ...state, mode: "overview" })}
            data-testid="i3s-building-overview"
          />
          {t("style.i3sBuilding.overview")}
        </label>
        <label className="flex items-center gap-2">
          <input
            type="radio"
            name={`i3s-building-mode-${layer.id}`}
            checked={state.mode === "full"}
            onChange={() => save({ ...state, mode: "full" })}
            data-testid="i3s-building-full"
          />
          {t("style.i3sBuilding.fullModel")}
        </label>
      </div>
      {state.mode === "full" ? (
        <>
          <p className="text-xs text-muted-foreground">{t("style.i3sBuilding.disciplinesHint")}</p>
          <ul className="space-y-1">{state.disciplines.map((item) => node(item, 0))}</ul>
        </>
      ) : null}
      <p className="text-xs text-muted-foreground">
        {t("style.i3sBuilding.drawnCount", { count: drawn })}
      </p>
    </div>
  );
}

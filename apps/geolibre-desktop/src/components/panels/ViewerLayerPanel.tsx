import { useAppStore } from "@geolibre/core";
import { Eye, EyeOff, Layers } from "lucide-react";
import { useTranslation } from "react-i18next";

/** Read-only layer legend used by the viewer embed preset. */
export function ViewerLayerPanel() {
  const { t } = useTranslation();
  const layers = useAppStore((state) => state.layers);
  const setLayerVisibility = useAppStore((state) => state.setLayerVisibility);

  return (
    <aside className="w-72 shrink-0 overflow-y-auto border-e bg-card p-3">
      <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
        <Layers className="h-4 w-4" />
        {t("sharedRail.layers")}
      </h2>
      <div className="space-y-1">
        {layers.map((layer) => (
          <label
            key={layer.id}
            className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted focus-within:outline-none focus-within:ring-2 focus-within:ring-ring"
          >
            <input
              type="checkbox"
              className="sr-only"
              checked={layer.visible}
              onChange={(event) => setLayerVisibility(layer.id, event.target.checked)}
            />
            {layer.visible ? (
              <Eye className="h-4 w-4 text-primary" />
            ) : (
              <EyeOff className="h-4 w-4 text-muted-foreground" />
            )}
            <span className="truncate">{layer.name}</span>
          </label>
        ))}
      </div>
    </aside>
  );
}

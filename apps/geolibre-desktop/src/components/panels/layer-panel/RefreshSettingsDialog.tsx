import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { GeoLibreLayer } from "@geolibre/core";
import {
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  Input,
  Label,
  Select,
} from "@geolibre/ui";
import { getLayerRefreshConfig, supportsRefreshFailurePolicy } from "../../../lib/layer-refresh";
import {
  CUSTOM_REFRESH_INTERVAL_VALUE,
  REFRESH_INTERVAL_OPTIONS,
  customRefreshIntervalSeconds,
  parseCustomRefreshIntervalMs,
  refreshIntervalOptionValue,
} from "./layer-panel-utils";

/**
 * State of the auto-refresh settings dialog: which layer it is open for and the
 * interval picker's draft values, re-synced whenever the layer's configured
 * interval changes.
 *
 * @param layers - The project's layers, used to resolve (and drop) the target.
 * @returns The dialog state and its setters.
 */
export function useRefreshSettingsDialog(layers: GeoLibreLayer[]) {
  const [refreshSettingsLayerId, setRefreshSettingsLayerId] = useState<string | null>(null);
  const [refreshIntervalChoice, setRefreshIntervalChoice] = useState("0");
  const [customRefreshSeconds, setCustomRefreshSeconds] = useState("");
  const refreshSettingsLayer = refreshSettingsLayerId
    ? (layers.find((layer) => layer.id === refreshSettingsLayerId) ?? null)
    : null;
  const refreshSettingsConfig = refreshSettingsLayer
    ? getLayerRefreshConfig(refreshSettingsLayer)
    : null;
  const refreshSettingsIntervalMs = refreshSettingsConfig
    ? refreshSettingsConfig.enabled
      ? refreshSettingsConfig.intervalMs
      : 0
    : null;
  const customRefreshIntervalMs = parseCustomRefreshIntervalMs(customRefreshSeconds);

  // Close the dialog once its layer is removed.
  useEffect(() => {
    if (refreshSettingsLayerId && !layers.some((layer) => layer.id === refreshSettingsLayerId)) {
      setRefreshSettingsLayerId(null);
    }
  }, [layers, refreshSettingsLayerId]);

  useEffect(() => {
    if (refreshSettingsIntervalMs === null) {
      setRefreshIntervalChoice("0");
      setCustomRefreshSeconds("");
      return;
    }

    setRefreshIntervalChoice(refreshIntervalOptionValue(refreshSettingsIntervalMs));
    setCustomRefreshSeconds(
      refreshIntervalOptionValue(refreshSettingsIntervalMs) === CUSTOM_REFRESH_INTERVAL_VALUE
        ? customRefreshIntervalSeconds(refreshSettingsIntervalMs)
        : "",
    );
  }, [refreshSettingsLayerId, refreshSettingsIntervalMs]);

  return {
    refreshSettingsLayerId,
    setRefreshSettingsLayerId,
    refreshSettingsLayer,
    refreshIntervalChoice,
    setRefreshIntervalChoice,
    customRefreshSeconds,
    setCustomRefreshSeconds,
    customRefreshIntervalMs,
  };
}

interface RefreshSettingsDialogProps {
  /** The dialog state from useRefreshSettingsDialog. */
  settings: ReturnType<typeof useRefreshSettingsDialog>;
  setRefreshInterval: (layer: GeoLibreLayer, intervalMs: number) => void;
  setRefreshFailurePolicy: (layer: GeoLibreLayer, onFailure: "keep-last" | "clear") => void;
}

/** The per-layer auto-refresh dialog: interval presets, a custom interval and the failure policy. */
export function RefreshSettingsDialog({
  settings,
  setRefreshInterval,
  setRefreshFailurePolicy,
}: RefreshSettingsDialogProps) {
  const { t } = useTranslation();
  const {
    refreshSettingsLayerId,
    setRefreshSettingsLayerId,
    refreshSettingsLayer,
    refreshIntervalChoice,
    setRefreshIntervalChoice,
    customRefreshSeconds,
    setCustomRefreshSeconds,
    customRefreshIntervalMs,
  } = settings;
  return (
    <Dialog
      open={!!refreshSettingsLayerId}
      onOpenChange={(open: boolean) => {
        if (!open) setRefreshSettingsLayerId(null);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {t("layers.autoRefreshDialogTitle", {
              name: refreshSettingsLayer?.name ?? t("layers.layerFallback"),
            })}
          </DialogTitle>
          <DialogDescription>{t("layers.autoRefreshDialogDescription")}</DialogDescription>
        </DialogHeader>
        {refreshSettingsLayer && (
          <div className="space-y-3">
            <Label htmlFor="layer-refresh-interval">{t("layers.interval")}</Label>
            <Select
              id="layer-refresh-interval"
              value={refreshIntervalChoice}
              onChange={(event) => {
                const value = event.target.value;
                setRefreshIntervalChoice(value);
                if (value === CUSTOM_REFRESH_INTERVAL_VALUE) {
                  const current = getLayerRefreshConfig(refreshSettingsLayer);
                  setCustomRefreshSeconds(customRefreshIntervalSeconds(current.intervalMs));
                  return;
                }
                setCustomRefreshSeconds("");
                setRefreshInterval(refreshSettingsLayer, Number(value));
              }}
            >
              {REFRESH_INTERVAL_OPTIONS.map((option) => (
                <option key={option.intervalMs} value={option.intervalMs}>
                  {t(option.labelKey)}
                </option>
              ))}
              <option value={CUSTOM_REFRESH_INTERVAL_VALUE}>{t("layers.custom")}</option>
            </Select>
            {refreshIntervalChoice === CUSTOM_REFRESH_INTERVAL_VALUE && (
              <div className="space-y-2">
                <Label htmlFor="layer-refresh-custom-seconds">
                  {t("layers.customIntervalSeconds")}
                </Label>
                <div className="flex gap-2">
                  <Input
                    id="layer-refresh-custom-seconds"
                    type="number"
                    min="1"
                    step="1"
                    value={customRefreshSeconds}
                    onChange={(event) => setCustomRefreshSeconds(event.target.value)}
                    onKeyDown={(event) => {
                      if (
                        event.key !== "Enter" ||
                        !refreshSettingsLayer ||
                        !customRefreshIntervalMs
                      ) {
                        return;
                      }
                      setRefreshInterval(refreshSettingsLayer, customRefreshIntervalMs);
                    }}
                  />
                  <Button
                    type="button"
                    disabled={!customRefreshIntervalMs}
                    onClick={() => {
                      if (!customRefreshIntervalMs) return;
                      setRefreshInterval(refreshSettingsLayer, customRefreshIntervalMs);
                    }}
                  >
                    {t("layers.apply")}
                  </Button>
                </div>
                {!customRefreshIntervalMs && customRefreshSeconds.trim() && (
                  <p className="text-xs text-destructive">{t("layers.enterPositiveSeconds")}</p>
                )}
              </div>
            )}
            {/* Vector-control layers keep their features in the external
                control, so "clear the layer" cannot be honored for them and
                the whole policy picker is hidden rather than offering a
                setting that silently does nothing. */}
            {supportsRefreshFailurePolicy(refreshSettingsLayer) && (
              <>
                <Label htmlFor="layer-refresh-failure-policy">
                  {t("layers.refreshFailurePolicy")}
                </Label>
                <Select
                  id="layer-refresh-failure-policy"
                  value={refreshSettingsLayer.connection?.onFailure ?? "keep-last"}
                  onChange={(event) =>
                    setRefreshFailurePolicy(
                      refreshSettingsLayer,
                      event.target.value === "clear" ? "clear" : "keep-last",
                    )
                  }
                >
                  <option value="keep-last">{t("layers.refreshFailureKeepLast")}</option>
                  <option value="clear">{t("layers.refreshFailureClear")}</option>
                </Select>
              </>
            )}
          </div>
        )}
        <div className="flex justify-end">
          <Button type="button" variant="ghost" onClick={() => setRefreshSettingsLayerId(null)}>
            {t("common.close")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

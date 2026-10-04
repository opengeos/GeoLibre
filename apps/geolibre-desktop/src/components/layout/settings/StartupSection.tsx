import type { MapEngine } from "@geolibre/map";
import { Button, Input, Label } from "@geolibre/ui";
import { Crosshair, FolderOpen } from "lucide-react";
import type { RefObject } from "react";
import { useTranslation } from "react-i18next";
import type { StartupSettings } from "../../../hooks/useDesktopSettings";
import { isTauri } from "../../../lib/is-tauri";
import { pickLayerStylesFile } from "../../../lib/layer-style-files";
import { openProjectFile } from "../../../lib/tauri-io";
import { roundCoordinate } from "./settings-draft";
import { useSettingsDraft } from "./SettingsDraftContext";

interface StartupSectionProps {
  mapControllerRef: RefObject<MapEngine | null>;
}

/**
 * The Startup section: which project opens at launch, the default view, and a
 * startup layer-styles file.
 *
 * Args:
 *   props: The section props.
 *
 * Returns:
 *   The section content.
 */
export function StartupSection({ mapControllerRef }: StartupSectionProps) {
  const { t } = useTranslation();
  const { draftDesktopSettings, setDraftDesktopSettings, setError } = useSettingsDraft();

  const updateDraftStartupSettings = (patch: Partial<StartupSettings>) => {
    setDraftDesktopSettings((current) => ({
      ...current,
      startup: { ...current.startup, ...patch },
    }));
    setError(null);
  };

  // Ignore a cleared field (valueAsNumber is NaN) so it does not silently fall
  // back to the hardcoded default on save; the last valid value is kept.
  const updateStartupCenterValue = (index: 0 | 1, value: number) => {
    if (!Number.isFinite(value)) return;
    setDraftDesktopSettings((current) => {
      const center: StartupSettings["center"] = [...current.startup.center];
      center[index] = value;
      return { ...current, startup: { ...current.startup, center } };
    });
    setError(null);
  };

  const updateStartupZoom = (value: number) => {
    if (!Number.isFinite(value)) return;
    updateDraftStartupSettings({ zoom: value });
  };

  const chooseStartupProject = async () => {
    try {
      const result = await openProjectFile();
      if (!result) return;
      updateDraftStartupSettings({
        mode: "specific",
        projectPath: result.path,
        projectName: result.project.name,
      });
    } catch (error) {
      console.error("Could not select a startup project.", error);
      setError(t("settings.startup.selectError"));
    }
  };

  const chooseStartupLayerStyles = async () => {
    try {
      const picked = await pickLayerStylesFile();
      if (!picked) return;
      updateDraftStartupSettings({
        layerStyles: { fileName: picked.name, path: picked.path, entries: picked.entries },
      });
    } catch (error) {
      console.error("Could not select a layer styles file.", error);
      setError(
        t("settings.startup.layerStylesSelectError", {
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  };

  const applyCurrentStartupView = () => {
    const view = mapControllerRef.current?.readView();
    if (!view) {
      setError(t("settings.startup.viewUnavailable"));
      return;
    }
    updateDraftStartupSettings({
      center: [roundCoordinate(view.center[0]), roundCoordinate(view.center[1])],
      zoom: Number(view.zoom.toFixed(2)),
    });
  };

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-sm font-semibold">{t("settings.startup.title")}</h3>
        <p className="text-xs text-muted-foreground">{t("settings.startup.description")}</p>
      </div>
      <div className={isTauri() ? "space-y-2" : "hidden"}>
        {(["default", "last"] as const).map((mode) => (
          <label key={mode} className="flex items-start gap-3 rounded-md border p-3 text-sm">
            <input
              className="mt-0.5 h-4 w-4"
              type="radio"
              name="startup-project-mode"
              checked={draftDesktopSettings.startup.mode === mode}
              onChange={() => updateDraftStartupSettings({ mode })}
            />
            <span className="space-y-1">
              <span className="block">{t(`settings.startup.mode.${mode}`)}</span>
              <span className="block text-xs text-muted-foreground">
                {t(`settings.startup.modeHint.${mode}`)}
              </span>
            </span>
          </label>
        ))}
        <label className="flex items-start gap-3 rounded-md border p-3 text-sm">
          <input
            className="mt-0.5 h-4 w-4"
            type="radio"
            name="startup-project-mode"
            checked={draftDesktopSettings.startup.mode === "specific"}
            disabled={!draftDesktopSettings.startup.projectPath}
            onChange={() => updateDraftStartupSettings({ mode: "specific" })}
          />
          <span className="min-w-0 flex-1 space-y-1">
            <span className="block">{t("settings.startup.mode.specific")}</span>
            <span className="block truncate text-xs text-muted-foreground">
              {draftDesktopSettings.startup.projectName ?? t("settings.startup.noProjectSelected")}
            </span>
          </span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void chooseStartupProject()}
          >
            <FolderOpen className="h-3.5 w-3.5" />
            {t("settings.startup.chooseProject")}
          </Button>
        </label>
      </div>
      <label className="flex items-start gap-3 rounded-md border p-3 text-sm">
        <input
          className="mt-0.5 h-4 w-4"
          type="checkbox"
          checked={draftDesktopSettings.startup.globeByDefault}
          onChange={(event) => updateDraftStartupSettings({ globeByDefault: event.target.checked })}
        />
        <span className="space-y-1">
          <span className="block">{t("settings.startup.globeByDefault")}</span>
          <span className="block text-xs text-muted-foreground">
            {t("settings.startup.globeByDefaultHint")}
          </span>
        </span>
      </label>
      <div className="space-y-3 rounded-md border p-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <p className="text-sm">{t("settings.startup.defaultView")}</p>
            <p className="text-xs text-muted-foreground">{t("settings.startup.defaultViewHint")}</p>
          </div>
          <Button type="button" size="sm" variant="outline" onClick={applyCurrentStartupView}>
            <Crosshair className="h-3.5 w-3.5" />
            {t("settings.startup.useCurrentView")}
          </Button>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-1.5">
            <Label htmlFor="settings-startup-longitude">{t("settings.startup.longitude")}</Label>
            <Input
              id="settings-startup-longitude"
              type="number"
              min={-180}
              max={180}
              step="0.000001"
              value={draftDesktopSettings.startup.center[0]}
              onChange={(event) => updateStartupCenterValue(0, event.target.valueAsNumber)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="settings-startup-latitude">{t("settings.startup.latitude")}</Label>
            <Input
              id="settings-startup-latitude"
              type="number"
              min={-90}
              max={90}
              step="0.000001"
              value={draftDesktopSettings.startup.center[1]}
              onChange={(event) => updateStartupCenterValue(1, event.target.valueAsNumber)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="settings-startup-zoom">{t("settings.startup.zoom")}</Label>
            <Input
              id="settings-startup-zoom"
              type="number"
              min={0}
              max={24}
              step={0.25}
              value={draftDesktopSettings.startup.zoom}
              onChange={(event) => updateStartupZoom(event.target.valueAsNumber)}
            />
          </div>
        </div>
      </div>
      <div className="space-y-3 rounded-md border p-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <p className="text-sm">{t("settings.startup.layerStyles")}</p>
            <p className="text-xs text-muted-foreground">{t("settings.startup.layerStylesHint")}</p>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void chooseStartupLayerStyles()}
            >
              <FolderOpen className="h-3.5 w-3.5" />
              {t("settings.startup.chooseLayerStyles")}
            </Button>
            {draftDesktopSettings.startup.layerStyles ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => updateDraftStartupSettings({ layerStyles: null })}
              >
                {t("settings.startup.clearLayerStyles")}
              </Button>
            ) : null}
          </div>
        </div>
        <p
          className="truncate text-xs text-muted-foreground"
          title={draftDesktopSettings.startup.layerStyles?.path}
          data-testid="settings-startup-layer-styles-file"
        >
          {draftDesktopSettings.startup.layerStyles
            ? t("settings.startup.layerStylesSelected", {
                file: draftDesktopSettings.startup.layerStyles.fileName,
                count: draftDesktopSettings.startup.layerStyles.entries.length,
              })
            : t("settings.startup.noLayerStylesSelected")}
        </p>
      </div>
    </div>
  );
}

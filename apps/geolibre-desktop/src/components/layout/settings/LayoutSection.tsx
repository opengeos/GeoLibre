import { Button } from "@geolibre/ui";
import {
  FolderCog,
  FolderTree,
  ListCollapse,
  MessageSquare,
  PanelLeft,
  PanelRight,
  RotateCcw,
  Type,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  DEFAULT_DESKTOP_LAYOUT_SETTINGS,
  useDesktopSettingsStore,
  type DesktopLayoutSettings,
} from "../../../hooks/useDesktopSettings";
import { showsAdvancedNotices } from "../../../lib/ui-profile";
import { useSettingsDraft } from "./SettingsDraftContext";

/**
 * The Layout section: toolbar and panel visibility (draft, applied on Save).
 *
 * Returns:
 *   The section content.
 */
export function LayoutSection() {
  const { t } = useTranslation();
  const { draftDesktopSettings, setDraftDesktopSettings, setError } = useSettingsDraft();
  const desktopSettings = useDesktopSettingsStore((s) => s.desktopSettings);

  const updateDraftLayoutSettings = (patch: Partial<DesktopLayoutSettings>) => {
    setDraftDesktopSettings((current) => ({
      ...current,
      layout: { ...current.layout, ...patch },
    }));
    setError(null);
  };

  const resetLayoutSettings = () => {
    updateDraftLayoutSettings(DEFAULT_DESKTOP_LAYOUT_SETTINGS);
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">{t("settings.layout.title")}</h3>
          <p className="text-xs text-muted-foreground">{t("settings.layout.description")}</p>
        </div>
        <Button type="button" size="sm" variant="outline" onClick={resetLayoutSettings}>
          <RotateCcw className="h-3.5 w-3.5" />
          {t("common.reset")}
        </Button>
      </div>
      <div className="space-y-3">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t("settings.layout.toolbar")}
        </h4>
        <label className="flex items-center gap-3 rounded-md border p-3 text-sm">
          <input
            className="h-4 w-4"
            type="checkbox"
            checked={draftDesktopSettings.layout.toolbarLabels}
            onChange={(event) =>
              updateDraftLayoutSettings({
                toolbarLabels: event.target.checked,
              })
            }
          />
          <Type className="h-4 w-4 text-muted-foreground" />
          <span>{t("settings.layout.showToolbarLabels")}</span>
        </label>
        <label className="flex items-center gap-3 rounded-md border p-3 text-sm">
          <input
            className="h-4 w-4"
            type="checkbox"
            checked={draftDesktopSettings.layout.showProjectInfo}
            onChange={(event) =>
              updateDraftLayoutSettings({
                showProjectInfo: event.target.checked,
              })
            }
          />
          <FolderCog className="h-4 w-4 text-muted-foreground" />
          <span>{t("settings.layout.showProjectInfoToolbar")}</span>
        </label>
      </div>
      <div className="space-y-3">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t("settings.layout.panels")}
        </h4>
        <label className="flex items-center gap-3 rounded-md border p-3 text-sm">
          <input
            className="h-4 w-4"
            type="checkbox"
            checked={draftDesktopSettings.layout.layerPanelVisible}
            onChange={(event) =>
              updateDraftLayoutSettings({
                layerPanelVisible: event.target.checked,
              })
            }
          />
          <PanelLeft className="h-4 w-4 text-muted-foreground" />
          <span>{t("settings.layout.showLayersPanel")}</span>
        </label>
        <label className="flex items-center gap-3 rounded-md border p-3 text-sm">
          <input
            className="h-4 w-4"
            type="checkbox"
            checked={draftDesktopSettings.layout.stylePanelVisible}
            onChange={(event) =>
              updateDraftLayoutSettings({
                stylePanelVisible: event.target.checked,
              })
            }
          />
          <PanelRight className="h-4 w-4 text-muted-foreground" />
          <span>{t("settings.layout.showStylePanel")}</span>
        </label>
        <label className="flex items-center gap-3 rounded-md border p-3 text-sm">
          <input
            className="h-4 w-4"
            type="checkbox"
            checked={draftDesktopSettings.layout.browserPanelVisible}
            onChange={(event) =>
              updateDraftLayoutSettings({
                browserPanelVisible: event.target.checked,
              })
            }
          />
          <FolderTree className="h-4 w-4 text-muted-foreground" />
          <span>{t("settings.layout.showBrowserPanel")}</span>
        </label>
        <label className="flex items-center gap-3 rounded-md border p-3 text-sm">
          <input
            className="h-4 w-4"
            type="checkbox"
            checked={draftDesktopSettings.layout.commentsPanelVisible}
            onChange={(event) =>
              updateDraftLayoutSettings({
                commentsPanelVisible: event.target.checked,
              })
            }
          />
          <MessageSquare className="h-4 w-4 text-muted-foreground" />
          <span>{t("settings.layout.showCommentsPanel")}</span>
        </label>
        <label className="flex items-center gap-3 rounded-md border p-3 text-sm">
          <input
            className="h-4 w-4"
            type="checkbox"
            checked={draftDesktopSettings.layout.compactLayerList}
            onChange={(event) =>
              updateDraftLayoutSettings({
                compactLayerList: event.target.checked,
              })
            }
          />
          <ListCollapse className="h-4 w-4 text-muted-foreground" />
          <span>{t("settings.layout.compactLayerList")}</span>
        </label>
      </div>
      {showsAdvancedNotices(desktopSettings.uiProfile) ? (
        <div className="rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
          {t("settings.layout.urlParamsNote")}
        </div>
      ) : null}
    </div>
  );
}

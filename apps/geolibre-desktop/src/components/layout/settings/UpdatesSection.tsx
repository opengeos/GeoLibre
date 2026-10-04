import { Button, Label, Select } from "@geolibre/ui";
import { RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  DEFAULT_UPDATE_SETTINGS,
  UPDATE_NOTIFICATION_LEVELS,
  type UpdateSettings,
} from "../../../hooks/useDesktopSettings";
import type { UpdateNotificationLevel } from "../../../lib/updates";
import { useSettingsDraft } from "./SettingsDraftContext";

/**
 * The Updates section: automatic update checks and the notification level
 * (desktop builds only).
 *
 * Returns:
 *   The section content.
 */
export function UpdatesSection() {
  const { t } = useTranslation();
  const { draftDesktopSettings, setDraftDesktopSettings, setError } = useSettingsDraft();

  const updateDraftUpdateSettings = (patch: Partial<UpdateSettings>) => {
    setDraftDesktopSettings((current) => ({
      ...current,
      updates: { ...current.updates, ...patch },
    }));
    setError(null);
  };

  const resetUpdateSettings = () => {
    updateDraftUpdateSettings(DEFAULT_UPDATE_SETTINGS);
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">{t("settings.updates.title")}</h3>
          <p className="text-xs text-muted-foreground">{t("settings.updates.description")}</p>
        </div>
        <Button type="button" size="sm" variant="outline" onClick={resetUpdateSettings}>
          <RotateCcw className="h-3.5 w-3.5" />
          {t("common.reset")}
        </Button>
      </div>
      <label className="flex items-start gap-3 rounded-md border p-3 text-sm">
        <input
          className="mt-0.5 h-4 w-4"
          type="checkbox"
          checked={draftDesktopSettings.updates.checkOnStartup}
          onChange={(event) =>
            updateDraftUpdateSettings({
              checkOnStartup: event.target.checked,
            })
          }
        />
        <span className="space-y-1">
          <span className="block">{t("settings.updates.checkOnStartup")}</span>
          <span className="block text-xs text-muted-foreground">
            {t("settings.updates.checkOnStartupHint")}
          </span>
        </span>
      </label>
      <div className="space-y-1.5">
        <Label htmlFor="settings-update-level">{t("settings.updates.notificationLevel")}</Label>
        <Select
          id="settings-update-level"
          value={draftDesktopSettings.updates.notificationLevel}
          disabled={!draftDesktopSettings.updates.checkOnStartup}
          onChange={(event) =>
            updateDraftUpdateSettings({
              // The options are generated from
              // UPDATE_NOTIFICATION_LEVELS, but guard the cast so an
              // unexpected value can't slip through if they drift.
              notificationLevel: UPDATE_NOTIFICATION_LEVELS.includes(
                event.target.value as UpdateNotificationLevel,
              )
                ? (event.target.value as UpdateNotificationLevel)
                : DEFAULT_UPDATE_SETTINGS.notificationLevel,
            })
          }
        >
          {UPDATE_NOTIFICATION_LEVELS.map((level) => (
            <option key={level} value={level}>
              {t(`settings.updates.level.${level}`)}
            </option>
          ))}
        </Select>
        <p className="text-xs text-muted-foreground">
          {t("settings.updates.notificationLevelHint")}
        </p>
      </div>
    </div>
  );
}

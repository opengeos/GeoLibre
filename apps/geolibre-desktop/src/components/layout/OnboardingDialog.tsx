import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@geolibre/ui";
import { useTranslation } from "react-i18next";
import {
  EXPERIENCE_LEVELS,
  useDesktopSettingsStore,
  type ExperienceLevel,
} from "../../hooks/useDesktopSettings";
import { usePluginRegistry } from "../../hooks/usePlugins";
import { presetHiddenSets, toggleablePluginIds } from "../../lib/ui-profile";

interface OnboardingDialogProps {
  open: boolean;
  onClose: () => void;
}

/**
 * First-launch wizard (issue #500) that lets the user pick an experience level,
 * seeding the UI profile so beginners start with a decluttered interface. Shown
 * only when no admin file is present and onboarding has not been completed.
 */
export function OnboardingDialog({ open, onClose }: OnboardingDialogProps) {
  const { t } = useTranslation();
  const { plugins } = usePluginRegistry();
  const setDesktopSettings = useDesktopSettingsStore((state) => state.setDesktopSettings);

  // Apply a level preset (or "show everything" when level is null) and mark
  // onboarding complete so the wizard does not reappear.
  const choose = (level: ExperienceLevel | null) => {
    const current = useDesktopSettingsStore.getState().desktopSettings;
    const sets =
      level !== null
        ? presetHiddenSets(level, toggleablePluginIds(plugins))
        : {
            hiddenDataSources: [],
            hiddenPlugins: [],
            hiddenMenus: [],
            hiddenMenuItems: [],
          };
    setDesktopSettings({
      ...current,
      uiProfile: {
        ...current.uiProfile,
        enabled: level !== null,
        level,
        onboarded: true,
        ...sets,
      },
    });
    onClose();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next: boolean) => {
        // Dismissing without a choice keeps the full interface but records that
        // onboarding was seen so it is not shown again.
        if (!next) choose(null);
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("onboarding.title")}</DialogTitle>
          <DialogDescription>{t("onboarding.description")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          {EXPERIENCE_LEVELS.map((level) => (
            <button
              key={level}
              type="button"
              className="w-full rounded-md border p-3 text-start transition hover:bg-accent"
              onClick={() => choose(level)}
            >
              <span className="block text-sm font-semibold">
                {t(`onboarding.level.${level}.title`)}
              </span>
              <span className="block text-xs text-muted-foreground">
                {t(`onboarding.level.${level}.description`)}
              </span>
            </button>
          ))}
        </div>
        <button
          type="button"
          className="text-xs text-muted-foreground underline-offset-2 hover:underline"
          onClick={() => choose(null)}
        >
          {t("onboarding.showEverything")}
        </button>
      </DialogContent>
    </Dialog>
  );
}

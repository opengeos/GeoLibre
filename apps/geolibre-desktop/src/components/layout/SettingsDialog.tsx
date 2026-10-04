import {
  overlayStoredPreferenceCredentials,
  changedPreferenceCredentials,
  useAppStore,
  type MapProjection,
  type ProjectPreferences,
} from "@geolibre/core";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@geolibre/ui";
import type { MapEngine } from "@geolibre/map";
import {
  Bot,
  Braces,
  Cloud,
  DownloadCloud,
  FolderOpen,
  Languages,
  Locate,
  MapPinned,
  LayoutPanelTop,
  PackageCheck,
  Palette,
  Puzzle,
  Settings,
  SlidersHorizontal,
} from "lucide-react";
import { useEffect, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import {
  EXPERIENCE_LEVELS,
  useDesktopSettingsStore,
  type DesktopLayoutSettings,
  type ExperienceLevel,
  type UiProfileSettings,
} from "../../hooks/useDesktopSettings";
import { useLanguage } from "../../hooks/useLanguage";
import { BROWSER_PANEL_ID } from "../../hooks/useRegisterBrowserPanel";
import { COMMENTS_PANEL_ID } from "../../hooks/useRegisterCommentsPanel";
import { useRightPanelState } from "../../hooks/useRightPanels";
import type { ThemeMode } from "../../hooks/useThemeMode";
import { isTauri } from "../../lib/is-tauri";
import { applyRightPanelVisibility } from "../../lib/persisted-right-panel";
import { THEME_SCHEMES, type ThemeScheme } from "../../lib/theme-schemes";
import { IS_MAS_BUILD } from "../../lib/build-flags";
import { IS_STORE_BUILD } from "../../lib/updates";
import { ensureStartupProjectSnapshot } from "../../lib/tauri-io";
import {
  INTERFACE_PROFILES,
  activeInterfaceProfile,
  isMenuItemVisible,
  presetHiddenSets,
} from "../../lib/ui-profile";
import type { RuntimeEnv } from "../../lib/assistant/provider";
import { loadOsEnvVars, readOsEnv } from "../../lib/assistant/os-env";
import { normalizeS3DefaultLocation } from "../../lib/s3-connections";
import {
  projectCredentialsInKeychain,
  rememberProjectCredentials,
} from "../../lib/project-credentials";
import { AiSection } from "./settings/AiSection";
import { AppearanceSection, updateSavedThemeScheme } from "./settings/AppearanceSection";
import { CloudStorageSettingsSection } from "./settings/CloudStorageSettingsSection";
import { EnvironmentSection } from "./settings/EnvironmentSection";
import { GeocodingSection } from "./settings/GeocodingSection";
import { InterfaceSection } from "./settings/InterfaceSection";
import { LanguageSection } from "./settings/LanguageSection";
import { LayoutSection } from "./settings/LayoutSection";
import { MapSection } from "./settings/MapSection";
import { StartupSection } from "./settings/StartupSection";
import { UpdatesSection } from "./settings/UpdatesSection";
import {
  clonePreferences,
  cloneDesktopSettings,
  normalizePreferences,
  validateEnvironmentVariables,
  type DraftDesktopSettings,
  type DraftPreferences,
  type ProfilePlugin,
} from "./settings/settings-draft";
import {
  SettingsDraftProvider,
  type SettingsDraftContextValue,
} from "./settings/SettingsDraftContext";
import { useLanguagePack } from "./settings/useLanguagePack";

export type SettingsSection =
  | "language"
  | "map"
  | "layout"
  | "appearance"
  | "interface"
  | "geocoding"
  | "ai"
  | "environment"
  | "cloudStorage"
  | "updates"
  | "startup";

/** A field a deep-link can ask Settings to focus once the section renders. */
export type SettingsFocusTarget =
  | "shareToken"
  | "cesiumToken"
  | "mapboxToken"
  | "arcgisKey"
  | "accentColor";

/** Window event letting any panel open Settings at a given section (no prop-drilling). */
export const OPEN_SETTINGS_EVENT = "geolibre:open-settings";

/**
 * Open the Settings dialog at `section` from anywhere in the app, optionally
 * focusing a specific field once that section renders (e.g. the Share dialog
 * deep-links into Environment Variables and focuses the share token input).
 */
export function openSettingsSection(
  section: SettingsSection,
  options?: { focus?: SettingsFocusTarget },
): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent(OPEN_SETTINGS_EVENT, {
      detail: { section, focus: options?.focus },
    }),
  );
}

/** A plugin offered as a visibility toggle in the Interface section. */
export type { ProfilePlugin };

interface SettingsDialogProps {
  buttonClassName?: string;
  buttonSize?: "default" | "sm" | "lg" | "icon" | null;
  iconClassName?: string;
  mapControllerRef: RefObject<MapEngine | null>;
  showLabels?: boolean;
  onOpenManagePlugins: () => void;
  /** Toggleable plugins for the Interface (UI profile) section (issue #500). */
  profilePlugins: ProfilePlugin[];
  /** Current light/dark mode, surfaced as toggles in Appearance (issue #716). */
  themeMode: ThemeMode;
  /** Flip the light/dark mode; the Appearance cards drive the same toggle. */
  onToggleThemeMode: () => void;
}

const SECTION_ITEMS: Array<{
  id: SettingsSection;
  labelKey: `settings.section.${SettingsSection}`;
  icon: typeof MapPinned;
}> = [
  { id: "language", labelKey: "settings.section.language", icon: Languages },
  { id: "map", labelKey: "settings.section.map", icon: MapPinned },
  { id: "layout", labelKey: "settings.section.layout", icon: LayoutPanelTop },
  {
    id: "appearance",
    labelKey: "settings.section.appearance",
    icon: Palette,
  },
  {
    id: "interface",
    labelKey: "settings.section.interface",
    icon: SlidersHorizontal,
  },
  { id: "geocoding", labelKey: "settings.section.geocoding", icon: Locate },
  { id: "ai", labelKey: "settings.section.ai", icon: Bot },
  {
    id: "environment",
    labelKey: "settings.section.environment",
    icon: Braces,
  },
  { id: "cloudStorage", labelKey: "settings.section.cloudStorage", icon: Cloud },
  {
    id: "updates",
    labelKey: "settings.section.updates",
    icon: DownloadCloud,
  },
  { id: "startup", labelKey: "settings.section.startup", icon: FolderOpen },
];

// The menu-item id that gates each Settings section, mirroring the dropdown.
// Sections without an entry (Layout, Interface) always show so the profile UI
// stays reachable.
const SECTION_GATE: Partial<Record<SettingsSection, string>> = {
  map: "settings.mapPreferences",
  geocoding: "settings.geocoding",
  environment: "settings.environment",
  cloudStorage: "settings.cloudStorage",
};

export function SettingsDialog({
  buttonClassName,
  buttonSize = "sm",
  iconClassName,
  mapControllerRef,
  showLabels = true,
  onOpenManagePlugins,
  profilePlugins,
  themeMode,
  onToggleThemeMode,
}: SettingsDialogProps) {
  const { t } = useTranslation();
  const { language, options: languageOptions, setLanguage } = useLanguage();
  const preferences = useAppStore((s) => s.preferences);
  const setPreferences = useAppStore((s) => s.setPreferences);
  const desktopSettings = useDesktopSettingsStore((s) => s.desktopSettings);
  const setDesktopSettings = useDesktopSettingsStore((s) => s.setDesktopSettings);
  // Visibility of the Settings dropdown items under the active UI profile. The
  // Language/Layout/Interface entries are always shown so the profile UI stays
  // reachable.
  const showSettingsItem = (id: string) => isMenuItemVisible(desktopSettings.uiProfile, id);
  const [open, setOpen] = useState(false);
  const [section, setSection] = useState<SettingsSection>("map");
  const languagePack = useLanguagePack(open, language);
  // Browser and Comments are dockable right panels: the registry owns whether
  // they are on screen and `registerPersistedRightPanel` mirrors that into
  // `layout.browserPanelVisible` / `layout.commentsPanelVisible`, so the toggle
  // no longer resets on every launch (#1935). Because the mirror is the single
  // writer, moving the panel is all these controls have to do: the setting
  // follows, so the two can never disagree about what the checkbox should say.
  const rightPanelState = useRightPanelState();
  const browserPanelOpen = rightPanelState.visibleIds.includes(BROWSER_PANEL_ID);
  const commentsPanelOpen = rightPanelState.visibleIds.includes(COMMENTS_PANEL_ID);
  const toggleBrowserPanel = (show: boolean) => applyRightPanelVisibility(BROWSER_PANEL_ID, show);
  const toggleCommentsPanel = (show: boolean) => applyRightPanelVisibility(COMMENTS_PANEL_ID, show);
  // A field a deep-link asked us to focus once its section renders; cleared
  // after the focus lands so a later open without a focus request stays put.
  const [pendingFocus, setPendingFocus] = useState<SettingsFocusTarget | null>(null);
  const shareTokenInputRef = useRef<HTMLInputElement>(null);
  const cesiumTokenInputRef = useRef<HTMLInputElement>(null);
  const mapboxTokenInputRef = useRef<HTMLInputElement>(null);
  const arcgisKeyInputRef = useRef<HTMLInputElement>(null);
  // The native color input in the Appearance pane. The accent-color dropdown's
  // "Custom" entry deep-links here so picking a custom color is reachable
  // without a third-level menu (#718).
  const customColorInputRef = useRef<HTMLInputElement>(null);
  // The nav button for the active section. Focus follows the active section so
  // the focus ring never strands on a different item than the visible pane
  // (Safari keeps focus on the previously focused button after a mouse click,
  // so the ring would otherwise stay on the first item, see #713).
  const activeSectionButtonRef = useRef<HTMLButtonElement>(null);
  // After the deep-link effect focuses its target field and clears
  // `pendingFocus`, the nav-focus effect re-runs (pendingFocus is in its deps)
  // and would steal focus back. This guards exactly that one re-run so the
  // deep-linked field keeps focus (#720 review).
  const skipNextNavFocusRef = useRef(false);
  // A gated section is dropped from the nav, but `section` can still point at one
  // (its initial value is "map"), so render the first visible section instead to
  // never expose gated content to a restricted profile.
  const isSectionVisible = (id: SettingsSection) => {
    // Automated update checks run in the desktop build only, so the section is
    // hidden on the web where its controls would be inert.
    if (id === "updates" && !isTauri()) return false;
    // The Microsoft Store build has no in-app update flow to configure (policy
    // 10.2.5), so its settings section is dropped entirely.
    if (id === "updates" && IS_STORE_BUILD) return false;
    const gate = SECTION_GATE[id];
    return gate ? showSettingsItem(gate) : true;
  };
  const effectiveSection: SettingsSection = isSectionVisible(section)
    ? section
    : // "interface" has no gate, so it is always a valid, visible fallback.
      (SECTION_ITEMS.find((item) => isSectionVisible(item.id))?.id ?? "interface");
  // The preferences (with stored credentials filled in) the draft is seeded
  // from, so saving writes only the credentials the user actually changed.
  const [initialCredentialPreferences] = useState(() =>
    overlayStoredPreferenceCredentials(preferences),
  );
  const [draftPreferences, setDraftPreferences] = useState<DraftPreferences>(() =>
    clonePreferences(initialCredentialPreferences),
  );
  const [draftDesktopSettings, setDraftDesktopSettings] = useState<DraftDesktopSettings>(() =>
    cloneDesktopSettings(desktopSettings, initialCredentialPreferences),
  );
  const seededCredentialPreferencesRef = useRef<ProjectPreferences>(initialCredentialPreferences);
  const [error, setError] = useState<string | null>(null);
  // Live map projection, captured when the dialog opens. The Globe projection
  // lets the map drift slightly past restricted bounds, so we warn users to
  // switch to Mercator before capturing the current view (see #505).
  const [liveProjection, setLiveProjection] = useState<MapProjection | null>(null);
  // Ids of variables whose value is temporarily revealed; values are masked
  // by default so secrets are not shown on screen.
  const [revealedValueIds, setRevealedValueIds] = useState<Set<string>>(() => new Set());
  // The AI profile being edited in the AI section. Null when no profile is
  // selected (the user sees the profile list). Seeded to the first existing
  // profile when the dialog opens.
  const [editingProfileId, setEditingProfileId] = useState<string | null>(null);
  // Whether the user is creating a new profile (transient — no id yet).
  const [isCreatingProfile, setIsCreatingProfile] = useState(false);
  // Read OS keys here because the dialog mounts before the app-root cache is
  // populated; state keeps the field badges current after the async read.
  const [osEnv, setOsEnv] = useState<RuntimeEnv>(() => readOsEnv());
  useEffect(() => {
    let cancelled = false;
    loadOsEnvVars().then((env) => {
      if (!cancelled) setOsEnv(env);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Seed the draft from the store only when the dialog opens. Depending on
  // preferences would reset in-progress edits if the store changed while the
  // dialog is open (e.g. a slow ?url= project finishes loading).
  useEffect(() => {
    if (!open) {
      // Clear so the stale projection can't flash the Globe hint for a frame
      // on the next open before this effect re-reads it.
      setLiveProjection(null);
      // Drop any pending focus request too: if the dialog closes before the
      // focus RAF fires, a leftover target would otherwise fire on a later
      // open that never asked for it.
      setPendingFocus(null);
      return;
    }
    const storePreferences = overlayStoredPreferenceCredentials(useAppStore.getState().preferences);
    seededCredentialPreferencesRef.current = storePreferences;
    setDraftPreferences(clonePreferences(storePreferences));
    setDraftDesktopSettings(
      cloneDesktopSettings(useDesktopSettingsStore.getState().desktopSettings, storePreferences),
    );
    // Show the profile list by default (do not auto-select a profile for editing).
    setEditingProfileId(null);
    setIsCreatingProfile(false);
    setRevealedValueIds(new Set());
    setError(null);
    setLiveProjection(mapControllerRef.current?.readProjection() ?? null);
  }, [open, mapControllerRef]);

  // Let other panels deep-link into a specific Settings section (e.g. the AI
  // Assistant onboarding card opens the AI Providers section to add credentials).
  useEffect(() => {
    const onOpenSettings = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          section?: SettingsSection;
          focus?: SettingsFocusTarget;
        }>
      ).detail;
      // setSection before setOpen so the section is already in state when React
      // renders the open dialog (effectiveSection derives from it at render
      // time). Only honor the request when the active UI profile actually shows
      // that section; otherwise effectiveSection would silently fall back to
      // another tab. The profile is read fresh (not via the effect's closure) so
      // a profile change after mount is respected.
      const requested = detail?.section;
      // Stays false unless a requested section is actually navigated to, so a
      // focus request without a (shown) section can't strand on whatever tab
      // happens to be active.
      let sectionShown = false;
      if (requested) {
        const gate = SECTION_GATE[requested];
        const profile = useDesktopSettingsStore.getState().desktopSettings.uiProfile;
        sectionShown = !gate || isMenuItemVisible(profile, gate);
        if (sectionShown) setSection(requested);
      }
      // Only queue the focus when its target section is actually shown, so the
      // request can't strand on a tab the profile hid.
      setPendingFocus(detail?.focus && sectionShown ? detail.focus : null);
      setOpen(true);
    };
    window.addEventListener(OPEN_SETTINGS_EVENT, onOpenSettings);
    return () => window.removeEventListener(OPEN_SETTINGS_EVENT, onOpenSettings);
  }, []);

  // Focus a deep-linked field once its section has rendered. The token input
  // only mounts when the Environment section is active, so this waits for the
  // section to settle rather than focusing on open.
  useEffect(() => {
    const input =
      pendingFocus === "shareToken"
        ? shareTokenInputRef
        : pendingFocus === "cesiumToken"
          ? cesiumTokenInputRef
          : pendingFocus === "mapboxToken"
            ? mapboxTokenInputRef
            : pendingFocus === "arcgisKey"
              ? arcgisKeyInputRef
              : null;
    if (!open || !input) return;
    if (effectiveSection !== "environment") return;
    const id = window.requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.select();
      // Set the guard BEFORE clearing pendingFocus: the clear re-runs the
      // nav-focus effect, and because this write is synchronous and lexically
      // first, the ref is already true when that run reads it, so it skips and
      // leaves focus on the field we just focused.
      skipNextNavFocusRef.current = true;
      setPendingFocus(null);
    });
    return () => window.cancelAnimationFrame(id);
  }, [open, pendingFocus, effectiveSection]);

  // Focus (and try to open) the custom-color picker when the accent-color
  // dropdown deep-links into the Appearance pane. The input only mounts while
  // the custom scheme is active, so wait for the section to settle first (#718).
  useEffect(() => {
    if (!open || pendingFocus !== "accentColor") return;
    if (effectiveSection !== "appearance") return;
    const id = window.requestAnimationFrame(() => {
      const input = customColorInputRef.current;
      input?.focus();
      // Pop the native picker straight away when the browser allows it; if the
      // user gesture has lapsed it throws, leaving the focused input as the
      // fallback rather than a dead end.
      try {
        input?.showPicker();
      } catch {
        // No transient user activation; the focused input is enough.
      }
      skipNextNavFocusRef.current = true;
      setPendingFocus(null);
    });
    return () => window.cancelAnimationFrame(id);
  }, [open, pendingFocus, effectiveSection]);

  // Keep the focus ring on the active section's nav button. Without this the
  // ring strands on whichever button was focused when the dialog opened (the
  // first one, or where a click left it on Safari) while the highlight and pane
  // move to the selected section (#713). Skipped while a deep-link focus is
  // pending so it does not steal focus from the field that request targets.
  useEffect(() => {
    if (!open || pendingFocus) return;
    if (skipNextNavFocusRef.current) {
      skipNextNavFocusRef.current = false;
      return;
    }
    const id = window.requestAnimationFrame(() => {
      activeSectionButtonRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(id);
  }, [open, pendingFocus, effectiveSection]);

  const toggleValueVisibility = (id: string) => {
    setRevealedValueIds((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const updateSavedLayoutSettings = (patch: Partial<DesktopLayoutSettings>) => {
    // Read the latest state synchronously so rapid successive toggles do not
    // overwrite each other with a stale render-closure snapshot.
    const current = useDesktopSettingsStore.getState().desktopSettings;
    setDesktopSettings({
      ...current,
      layout: { ...current.layout, ...patch },
    });
  };

  // Live updates from the Settings dropdown's Interface submenu (not the draft,
  // which only the dialog commits on Save). Reads the latest state so rapid
  // toggles do not clobber each other.
  const updateSavedUiProfile = (patch: Partial<UiProfileSettings>) => {
    const current = useDesktopSettingsStore.getState().desktopSettings;
    setDesktopSettings({
      ...current,
      uiProfile: { ...current.uiProfile, ...patch },
    });
  };

  const applySavedExperiencePreset = (level: ExperienceLevel) => {
    const sets = presetHiddenSets(
      level,
      profilePlugins.map((plugin) => plugin.id),
    );
    updateSavedUiProfile({ enabled: true, level, ...sets });
  };

  // "Custom" counterpart for the Settings dropdown: opt into custom mode while
  // preserving the existing hidden lists (issue #592).
  const applySavedCustomProfile = () => {
    updateSavedUiProfile({ enabled: true, level: null });
  };

  const saveSettings = () => {
    const normalized = normalizePreferences(draftPreferences);
    const validationError = validateEnvironmentVariables(normalized.environmentVariables);
    if (validationError) {
      setError(
        validationError.kind === "duplicate"
          ? t("settings.env.errorDuplicate", { name: validationError.name })
          : t("settings.env.errorNamePattern"),
      );
      setSection("environment");
      return;
    }

    if (projectCredentialsInKeychain()) {
      // Before setPreferences: the cache update is synchronous, so a cleared
      // value is gone before the runtime env re-projects. The store keeps the
      // plaintext until a project save moves it out, so a failed keychain
      // write never loses the value: that save falls back to the prompt.
      void rememberProjectCredentials(
        changedPreferenceCredentials(seededCredentialPreferencesRef.current, normalized),
      );
    }
    setPreferences(normalized);
    // When a level preset is still active, recompute its hidden lists from the
    // current plugin registry at save time. The draft was snapshotted when the
    // dialog opened, so this picks up any external plugins that loaded since
    // (and keeps the result identical to applying the preset). A custom profile
    // (level === null) carries the user's explicit toggles through unchanged.
    const draftProfile = draftDesktopSettings.uiProfile;
    const committedUiProfile =
      draftProfile.level !== null
        ? {
            ...draftProfile,
            ...presetHiddenSets(
              draftProfile.level,
              profilePlugins.map((plugin) => plugin.id),
            ),
          }
        : draftProfile;
    // Plugin sources are managed live in the Manage Plugins dialog; preserve the
    // current store values and only update the layout from this dialog.
    setDesktopSettings({
      ...useDesktopSettingsStore.getState().desktopSettings,
      layout: draftDesktopSettings.layout,
      shareToken: draftDesktopSettings.shareToken,
      cesiumIonToken: draftDesktopSettings.cesiumIonToken,
      mapboxAccessToken: draftDesktopSettings.mapboxAccessToken,
      arcgisApiKey: draftDesktopSettings.arcgisApiKey,
      aiProfiles: draftDesktopSettings.aiProfiles,
      defaultAiProfileId: draftDesktopSettings.defaultAiProfileId,
      s3Connections: draftDesktopSettings.s3Connections,
      s3DefaultLocation: normalizeS3DefaultLocation(draftDesktopSettings.s3DefaultLocation),
      uiProfile: committedUiProfile,
      updates: draftDesktopSettings.updates,
      startup: draftDesktopSettings.startup,
    });
    // On Android the project behind the preference just saved is reachable only
    // until this process ends, so keep a copy the next launch can open
    // (GeoLibre#1948). A no-op on every other platform.
    void ensureStartupProjectSnapshot(
      draftDesktopSettings.startup,
      useAppStore.getState().recentProjects,
    );
    // The dockable panels are the one layout row nothing renders from the store:
    // the registry owns what is on screen, so move it to match what was just
    // saved (a no-op for a panel already there, so an untouched Save cannot
    // collapse one the user had expanded).
    applyRightPanelVisibility(BROWSER_PANEL_ID, draftDesktopSettings.layout.browserPanelVisible);
    applyRightPanelVisibility(COMMENTS_PANEL_ID, draftDesktopSettings.layout.commentsPanelVisible);
    setOpen(false);
  };

  const draftContext: SettingsDraftContextValue = {
    draftPreferences,
    setDraftPreferences,
    draftDesktopSettings,
    setDraftDesktopSettings,
    setError,
    revealedValueIds,
    toggleValueVisibility,
  };

  const renderSectionButton = (item: (typeof SECTION_ITEMS)[number]) => {
    const Icon = item.icon;
    return (
      <Button
        key={item.id}
        ref={effectiveSection === item.id ? activeSectionButtonRef : undefined}
        className="justify-start"
        size="sm"
        type="button"
        variant={effectiveSection === item.id ? "secondary" : "ghost"}
        onClick={() => {
          setSection(item.id);
          setError(null);
        }}
      >
        <Icon className="h-4 w-4" />
        {t(item.labelKey)}
      </Button>
    );
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            className={buttonClassName}
            variant="ghost"
            size={buttonSize}
            aria-label={t("settings.title")}
          >
            <Settings className={iconClassName} />
            {showLabels ? <span className="hidden sm:inline">{t("settings.title")}</span> : null}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56">
          <DropdownMenuLabel>{t("settings.title")}</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <Languages className="h-3.5 w-3.5" />
              {t("language.label")}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-44">
              <DropdownMenuRadioGroup value={language} onValueChange={setLanguage}>
                {languageOptions.map((option) => (
                  <DropdownMenuRadioItem key={option.code} value={option.code}>
                    {option.nativeName === option.englishName
                      ? option.nativeName
                      : `${option.nativeName} (${option.englishName})`}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={() => {
                  setSection("language");
                  setOpen(true);
                }}
              >
                <PackageCheck className="me-2 h-3.5 w-3.5" />
                {t("settings.languagePack.manage")}
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSeparator />
          {showSettingsItem("settings.mapPreferences") && (
            <DropdownMenuItem
              onSelect={() => {
                setSection("map");
                setOpen(true);
              }}
            >
              <MapPinned className="me-2 h-3.5 w-3.5" />
              {t("settings.menu.mapPreferences")}
            </DropdownMenuItem>
          )}
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <LayoutPanelTop className="h-3.5 w-3.5" />
              {t("settings.section.layout")}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="geolibre-layout-submenu w-40 sm:w-72">
              <DropdownMenuCheckboxItem
                checked={desktopSettings.layout.toolbarLabels}
                onCheckedChange={(checked: boolean) =>
                  updateSavedLayoutSettings({ toolbarLabels: checked === true })
                }
                onSelect={(event: Event) => event.preventDefault()}
              >
                {t("settings.layout.showToolbarLabels")}
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem
                checked={desktopSettings.layout.showProjectInfo}
                onCheckedChange={(checked: boolean) =>
                  updateSavedLayoutSettings({
                    showProjectInfo: checked === true,
                  })
                }
                onSelect={(event: Event) => event.preventDefault()}
              >
                {t("settings.layout.showProjectInfo")}
              </DropdownMenuCheckboxItem>
              <DropdownMenuSeparator />
              <DropdownMenuCheckboxItem
                checked={desktopSettings.layout.layerPanelVisible}
                onCheckedChange={(checked: boolean) =>
                  updateSavedLayoutSettings({
                    layerPanelVisible: checked === true,
                  })
                }
                onSelect={(event: Event) => event.preventDefault()}
              >
                {t("settings.layout.showLayersPanel")}
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem
                checked={desktopSettings.layout.stylePanelVisible}
                onCheckedChange={(checked: boolean) =>
                  updateSavedLayoutSettings({
                    stylePanelVisible: checked === true,
                  })
                }
                onSelect={(event: Event) => event.preventDefault()}
              >
                {t("settings.layout.showStylePanel")}
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem
                checked={browserPanelOpen}
                onCheckedChange={(checked: boolean) => toggleBrowserPanel(checked === true)}
                onSelect={(event: Event) => event.preventDefault()}
              >
                {t("settings.layout.showBrowserPanel")}
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem
                checked={commentsPanelOpen}
                onCheckedChange={(checked: boolean) => toggleCommentsPanel(checked === true)}
                onSelect={(event: Event) => event.preventDefault()}
              >
                {t("settings.layout.showCommentsPanel")}
              </DropdownMenuCheckboxItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={() => {
                  setSection("layout");
                  setOpen(true);
                }}
              >
                {t("settings.menu.layoutSettings")}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="px-2 py-1 text-xs font-normal text-muted-foreground">
                {t("settings.menu.urlOverrideNote")}
              </DropdownMenuLabel>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <Palette className="h-3.5 w-3.5" />
              {t("settings.section.appearance")}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-56">
              <DropdownMenuLabel className="px-2 py-1 text-xs font-normal text-muted-foreground">
                {t("settings.appearance.accentColor")}
              </DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={desktopSettings.theme.scheme}
                onValueChange={(value: string) => updateSavedThemeScheme(value as ThemeScheme)}
              >
                {THEME_SCHEMES.map((scheme) => (
                  <DropdownMenuRadioItem
                    key={scheme.id}
                    value={scheme.id}
                    onSelect={(event: Event) => event.preventDefault()}
                  >
                    <span
                      aria-hidden
                      className="me-2 h-3.5 w-3.5 shrink-0 rounded-full border"
                      style={{ backgroundColor: scheme.swatch }}
                    />
                    {t(scheme.labelKey)}
                  </DropdownMenuRadioItem>
                ))}
                <DropdownMenuRadioItem
                  value="custom"
                  onSelect={() => {
                    // Selecting "Custom" from the menu would otherwise be a dead
                    // end, so open the Appearance pane and jump to its color
                    // picker instead of nesting a third-level menu (#718).
                    updateSavedThemeScheme("custom");
                    setSection("appearance");
                    setOpen(true);
                    setPendingFocus("accentColor");
                  }}
                >
                  <span
                    aria-hidden
                    className="me-2 h-3.5 w-3.5 shrink-0 rounded-full border"
                    style={{ backgroundColor: desktopSettings.theme.customColor }}
                  />
                  {t("settings.appearance.custom")}
                </DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={() => {
                  setSection("appearance");
                  setOpen(true);
                }}
              >
                {t("settings.menu.appearanceSettings")}
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <SlidersHorizontal className="h-3.5 w-3.5" />
              {t("settings.section.interface")}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-56">
              <DropdownMenuLabel className="px-2 py-1 text-xs font-normal text-muted-foreground">
                {t("settings.interface.presets")}
              </DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={activeInterfaceProfile(desktopSettings.uiProfile)}
                onValueChange={(value: string) => {
                  // The three presets recompute hidden lists; "custom" opts into
                  // custom mode while keeping the current lists. EXPERIENCE_LEVELS
                  // excludes "custom", so this guard keeps any stray value from
                  // reaching presetHiddenSets. Keep EXPERIENCE_LEVELS in sync with
                  // the selectable preset entries of INTERFACE_PROFILES.
                  if ((EXPERIENCE_LEVELS as readonly string[]).includes(value)) {
                    applySavedExperiencePreset(value as ExperienceLevel);
                  } else if (value === "custom") {
                    applySavedCustomProfile();
                  }
                }}
              >
                {INTERFACE_PROFILES.map((option) => (
                  <DropdownMenuRadioItem
                    key={option}
                    value={option}
                    // "custom" lights up automatically when the user hand-edits
                    // an item, and is also directly selectable to keep the current
                    // configuration while switching into custom mode.
                    disabled={desktopSettings.uiProfile.locked}
                    onSelect={(event: Event) => event.preventDefault()}
                  >
                    {t(`settings.interface.level.${option}`)}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={() => {
                  setSection("interface");
                  setOpen(true);
                }}
              >
                {t("settings.menu.interfaceSettings")}
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          {showSettingsItem("settings.geocoding") && (
            <DropdownMenuItem
              onSelect={() => {
                setSection("geocoding");
                setOpen(true);
              }}
            >
              <Locate className="me-2 h-3.5 w-3.5" />
              {t("settings.menu.geocoding")}
            </DropdownMenuItem>
          )}
          {showSettingsItem("settings.ai") && (
            <DropdownMenuItem
              onSelect={() => {
                setSection("ai");
                setOpen(true);
              }}
            >
              <Bot className="me-2 h-3.5 w-3.5" />
              {t("settings.menu.ai")}
            </DropdownMenuItem>
          )}
          {showSettingsItem("settings.environment") && (
            <DropdownMenuItem
              onSelect={() => {
                setSection("environment");
                setOpen(true);
              }}
            >
              <Braces className="me-2 h-3.5 w-3.5" />
              {t("settings.menu.environmentVariables")}
            </DropdownMenuItem>
          )}
          {showSettingsItem("settings.cloudStorage") && (
            <DropdownMenuItem
              onSelect={() => {
                setSection("cloudStorage");
                setOpen(true);
              }}
            >
              <Cloud className="me-2 h-3.5 w-3.5" />
              {t("settings.menu.cloudStorage")}
            </DropdownMenuItem>
          )}
          {/* Share the same gate as the in-dialog nav/pane so the Store build
              (and the web build) hide this shortcut too — otherwise it would
              open the dialog on a fallback section. */}
          {isSectionVisible("updates") && (
            <DropdownMenuItem
              onSelect={() => {
                setSection("updates");
                setOpen(true);
              }}
            >
              <DownloadCloud className="me-2 h-3.5 w-3.5" />
              {t("settings.menu.updates")}
            </DropdownMenuItem>
          )}
          {isSectionVisible("startup") && (
            <DropdownMenuItem
              onSelect={() => {
                setSection("startup");
                setOpen(true);
              }}
            >
              <FolderOpen className="me-2 h-3.5 w-3.5" />
              {t("settings.menu.startupSettings")}
            </DropdownMenuItem>
          )}
          {/* The Mac App Store build has no plugin marketplace (external
              plugin installs are not allowed there), so its entry point is
              dropped; composed with the profile gate like the Store build's
              updates check. */}
          {!IS_MAS_BUILD && showSettingsItem("settings.managePlugins") && (
            <DropdownMenuItem onSelect={() => onOpenManagePlugins()}>
              <Puzzle className="me-2 h-3.5 w-3.5" />
              {t("settings.menu.managePlugins")}
            </DropdownMenuItem>
          )}
          {showSettingsItem("settings.styleManager") && (
            <DropdownMenuItem onSelect={() => useAppStore.getState().setStyleManagerOpen(true)}>
              <Palette className="me-2 h-3.5 w-3.5" />
              {t("settings.menu.styleManager")}
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          className="max-h-[min(88vh,760px)] max-w-3xl"
          bodyClassName="overflow-hidden p-0"
        >
          <DialogHeader className="border-b px-6 pb-4 pt-6">
            <DialogTitle>{t("settings.title")}</DialogTitle>
            <DialogDescription>{t("settings.description")}</DialogDescription>
          </DialogHeader>
          <div className="grid min-h-0 min-w-0 grid-cols-1 md:grid-cols-[12rem_1fr]">
            <nav className="flex min-w-0 gap-1 overflow-x-auto border-b p-3 md:flex-col md:overflow-x-visible md:border-b-0 md:border-e">
              {SECTION_ITEMS.filter((item) => isSectionVisible(item.id)).map(renderSectionButton)}
            </nav>
            <div className="min-h-0 min-w-0 overflow-y-auto p-6">
              <SettingsDraftProvider value={draftContext}>
                {effectiveSection === "language" ? (
                  <LanguageSection languagePack={languagePack} />
                ) : null}
                {effectiveSection === "map" ? (
                  <MapSection mapControllerRef={mapControllerRef} liveProjection={liveProjection} />
                ) : null}
                {effectiveSection === "layout" ? <LayoutSection /> : null}
                {effectiveSection === "appearance" ? (
                  <AppearanceSection
                    themeMode={themeMode}
                    onToggleThemeMode={onToggleThemeMode}
                    customColorInputRef={customColorInputRef}
                  />
                ) : null}
                {effectiveSection === "interface" ? (
                  <InterfaceSection profilePlugins={profilePlugins} />
                ) : null}
                {effectiveSection === "geocoding" ? <GeocodingSection /> : null}
                {effectiveSection === "ai" ? (
                  <AiSection
                    osEnv={osEnv}
                    editingProfileId={editingProfileId}
                    setEditingProfileId={setEditingProfileId}
                    isCreatingProfile={isCreatingProfile}
                    setIsCreatingProfile={setIsCreatingProfile}
                  />
                ) : null}
                {effectiveSection === "cloudStorage" ? <CloudStorageSettingsSection /> : null}
                {effectiveSection === "environment" ? (
                  <EnvironmentSection
                    shareTokenInputRef={shareTokenInputRef}
                    cesiumTokenInputRef={cesiumTokenInputRef}
                    mapboxTokenInputRef={mapboxTokenInputRef}
                    arcgisKeyInputRef={arcgisKeyInputRef}
                  />
                ) : null}
                {effectiveSection === "startup" ? (
                  <StartupSection mapControllerRef={mapControllerRef} />
                ) : null}
                {effectiveSection === "updates" ? <UpdatesSection /> : null}
              </SettingsDraftProvider>
            </div>
          </div>
          {error ? (
            <div className="border-t px-6 py-2 text-sm text-destructive">{error}</div>
          ) : null}
          {effectiveSection === "language" ? (
            <div className="flex justify-end border-t px-6 py-4">
              <Button type="button" onClick={() => setOpen(false)}>
                {t("common.close")}
              </Button>
            </div>
          ) : effectiveSection === "ai" && (editingProfileId || isCreatingProfile) ? (
            <div className="border-t px-6 py-4 text-center text-xs text-muted-foreground">
              {t("settings.ai.profileEditSaveHint")}
            </div>
          ) : (
            <div className="flex justify-end gap-2 border-t px-6 py-4">
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                {t("common.cancel")}
              </Button>
              <Button type="button" onClick={saveSettings}>
                {t("settings.saveButton")}
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

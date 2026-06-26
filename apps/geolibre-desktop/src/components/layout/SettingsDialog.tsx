import {
  DEFAULT_PROJECT_PREFERENCES,
  GEOCODING_PROVIDERS,
  getGeocodingProvider,
  normalizeGeocodingProviderId,
  useAppStore,
  type MapPreferences,
  type MapProjection,
  type ProjectPreferences,
  type RuntimeEnvironmentVariable,
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
  Input,
  Label,
  Select,
  cn,
} from "@geolibre/ui";
import type { MapController } from "@geolibre/map";
import {
  Bot,
  Braces,
  Check,
  Crosshair,
  DownloadCloud,
  ExternalLink,
  Eye,
  EyeOff,
  FolderCog,
  Languages,
  Locate,
  MapPinned,
  LayoutPanelTop,
  Moon,
  Palette,
  PanelLeft,
  PanelRight,
  Plus,
  RotateCcw,
  Settings,
  SlidersHorizontal,
  Sun,
  Type,
  Trash2,
  TriangleAlert,
  Puzzle,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Trans, useTranslation } from "react-i18next";
import {
  DEFAULT_DESKTOP_LAYOUT_SETTINGS,
  DEFAULT_UI_PROFILE_SETTINGS,
  DEFAULT_UPDATE_SETTINGS,
  EXPERIENCE_LEVELS,
  UPDATE_NOTIFICATION_LEVELS,
  useDesktopSettingsStore,
  type DesktopSettings,
  type DesktopLayoutSettings,
  type ExperienceLevel,
  type UiProfileSettings,
  type UpdateSettings,
} from "../../hooks/useDesktopSettings";
import { useLanguage } from "../../hooks/useLanguage";
import type { ThemeMode } from "../../hooks/useThemeMode";
import { isTauri } from "../../lib/is-tauri";
import {
  THEME_SCHEMES,
  normalizeHexColor,
  type ThemeScheme,
} from "../../lib/theme-schemes";
import type { UpdateNotificationLevel } from "../../lib/updates";
import {
  DATA_SOURCE_CATALOG,
  DATA_SOURCE_SECTION_LABEL_KEYS,
  DATA_SOURCE_SECTION_ORDER,
  INTERFACE_PROFILES,
  MENU_ITEM_CATALOG,
  MENU_ITEM_GROUPS,
  TOP_LEVEL_MENUS,
  activeInterfaceProfile,
  isMenuItemVisible,
  presetHiddenSets,
  showsAdvancedNotices,
} from "../../lib/ui-profile";
import {
  ASSISTANT_PROVIDER_IDS,
  PROVIDER_LABELS,
  availableProviders,
  type AssistantProviderId,
} from "../../lib/assistant/provider";
import {
  PROVIDER_DOCS_URL,
  PROVIDER_FIELDS,
  type ProviderField,
} from "../../lib/assistant/provider-fields";

export type SettingsSection =
  | "map"
  | "layout"
  | "appearance"
  | "interface"
  | "geocoding"
  | "ai"
  | "environment"
  | "updates";

/** A field a deep-link can ask Settings to focus once the section renders. */
export type SettingsFocusTarget = "shareToken" | "accentColor";

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
export interface ProfilePlugin {
  id: string;
  name: string;
}

interface SettingsDialogProps {
  buttonClassName?: string;
  buttonSize?: "default" | "sm" | "lg" | "icon" | null;
  iconClassName?: string;
  mapControllerRef: RefObject<MapController | null>;
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
  {
    id: "updates",
    labelKey: "settings.section.updates",
    icon: DownloadCloud,
  },
];

// The menu-item id that gates each Settings section, mirroring the dropdown.
// Sections without an entry (Layout, Interface) always show so the profile UI
// stays reachable.
const SECTION_GATE: Partial<Record<SettingsSection, string>> = {
  map: "settings.mapPreferences",
  geocoding: "settings.geocoding",
  environment: "settings.environment",
};

const VARIABLE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Draft env vars carry a stable client-side id so React can key the rows by
// identity. Keying by array index reuses input DOM state (focus, cursor)
// across the wrong item after a mid-list delete.
interface DraftEnvironmentVariable extends RuntimeEnvironmentVariable {
  id: string;
}

interface DraftPreferences {
  map: MapPreferences;
  environmentVariables: DraftEnvironmentVariable[];
  geocoding: ProjectPreferences["geocoding"];
}

interface DraftDesktopSettings {
  layout: DesktopLayoutSettings;
  shareToken: string;
  uiProfile: UiProfileSettings;
  updates: UpdateSettings;
}

function createDraftId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function clonePreferences(preferences: ProjectPreferences): DraftPreferences {
  return {
    map: { ...preferences.map },
    environmentVariables: preferences.environmentVariables.map((variable) => ({
      ...variable,
      id: createDraftId(),
    })),
    geocoding: {
      ...preferences.geocoding,
      apiKeys: { ...preferences.geocoding.apiKeys },
    },
  };
}

function cloneDesktopSettings(settings: DesktopSettings): DraftDesktopSettings {
  return {
    layout: { ...settings.layout },
    shareToken: settings.shareToken,
    uiProfile: {
      ...settings.uiProfile,
      hiddenDataSources: [...settings.uiProfile.hiddenDataSources],
      hiddenPlugins: [...settings.uiProfile.hiddenPlugins],
      hiddenMenus: [...settings.uiProfile.hiddenMenus],
      hiddenMenuItems: [...settings.uiProfile.hiddenMenuItems],
    },
    updates: { ...settings.updates },
  };
}

function normalizeBounds(
  bounds: MapPreferences["bounds"],
): MapPreferences["bounds"] {
  const west = clamp(bounds[0], -180, 180);
  const south = clamp(bounds[1], -85, 85);
  const east = clamp(bounds[2], -180, 180);
  const north = clamp(bounds[3], -85, 85);
  if (west >= east || south >= north) {
    return DEFAULT_PROJECT_PREFERENCES.map.bounds;
  }

  return [west, south, east, north];
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function roundCoordinate(value: number): number {
  return Number(value.toFixed(6));
}

function normalizePreferences(
  preferences: ProjectPreferences,
): ProjectPreferences {
  const minZoom = clamp(preferences.map.minZoom, 0, 24);
  const maxZoom = Math.max(minZoom, clamp(preferences.map.maxZoom, 0, 24));
  return {
    map: {
      ...preferences.map,
      bounds: normalizeBounds(preferences.map.bounds),
      minZoom,
      maxZoom,
      maxPitch: clamp(preferences.map.maxPitch, 0, 85),
    },
    environmentVariables: preferences.environmentVariables
      .map((variable) => ({
        key: variable.key.trim(),
        value: variable.value,
        enabled: variable.enabled,
      }))
      .filter((variable) => variable.key.length > 0),
    geocoding: normalizeGeocodingPreferences(preferences.geocoding),
  };
}

function normalizeGeocodingPreferences(
  geocoding: ProjectPreferences["geocoding"],
): ProjectPreferences["geocoding"] {
  const providerId = normalizeGeocodingProviderId(geocoding.providerId);
  // Keep only non-empty keys so the saved project does not carry blank entries.
  const apiKeys: Record<string, string> = {};
  for (const [id, key] of Object.entries(geocoding.apiKeys)) {
    if (key.trim()) apiKeys[id] = key.trim();
  }
  return {
    providerId,
    apiKeys,
    forwardEndpoint: geocoding.forwardEndpoint?.trim() || undefined,
    reverseEndpoint: geocoding.reverseEndpoint?.trim() || undefined,
    email: geocoding.email?.trim() || undefined,
  };
}

// Returned as a code (not a message) so the user-facing string is resolved
// through i18n at the call site, where `t` is in scope.
type EnvironmentValidationError =
  | { kind: "pattern" }
  | { kind: "duplicate"; name: string };

function validateEnvironmentVariables(
  variables: RuntimeEnvironmentVariable[],
): EnvironmentValidationError | null {
  const keys = new Set<string>();

  for (const variable of variables) {
    const key = variable.key.trim();
    if (!key) continue;
    if (!VARIABLE_NAME_PATTERN.test(key)) {
      return { kind: "pattern" };
    }
    if (keys.has(key)) {
      return { kind: "duplicate", name: key };
    }
    keys.add(key);
  }

  return null;
}

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
  const {
    language,
    options: languageOptions,
    setLanguage,
  } = useLanguage();
  const preferences = useAppStore((s) => s.preferences);
  const setPreferences = useAppStore((s) => s.setPreferences);
  const desktopSettings = useDesktopSettingsStore((s) => s.desktopSettings);
  const setDesktopSettings = useDesktopSettingsStore(
    (s) => s.setDesktopSettings,
  );
  // Visibility of the Settings dropdown items under the active UI profile. The
  // Language/Layout/Interface entries are always shown so the profile UI stays
  // reachable.
  const showSettingsItem = (id: string) =>
    isMenuItemVisible(desktopSettings.uiProfile, id);
  const [open, setOpen] = useState(false);
  const [section, setSection] = useState<SettingsSection>("map");
  // A field a deep-link asked us to focus once its section renders; cleared
  // after the focus lands so a later open without a focus request stays put.
  const [pendingFocus, setPendingFocus] = useState<SettingsFocusTarget | null>(
    null,
  );
  const shareTokenInputRef = useRef<HTMLInputElement>(null);
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
    const gate = SECTION_GATE[id];
    return gate ? showSettingsItem(gate) : true;
  };
  const effectiveSection: SettingsSection = isSectionVisible(section)
    ? section
    : // "interface" has no gate, so it is always a valid, visible fallback.
      (SECTION_ITEMS.find((item) => isSectionVisible(item.id))?.id ?? "interface");
  const [draftPreferences, setDraftPreferences] = useState<DraftPreferences>(
    () => clonePreferences(preferences),
  );
  const [draftDesktopSettings, setDraftDesktopSettings] =
    useState<DraftDesktopSettings>(() => cloneDesktopSettings(desktopSettings));
  const [error, setError] = useState<string | null>(null);
  // Live map projection, captured when the dialog opens. The Globe projection
  // lets the map drift slightly past restricted bounds, so we warn users to
  // switch to Mercator before capturing the current view (see #505).
  const [liveProjection, setLiveProjection] = useState<MapProjection | null>(
    null,
  );
  // Ids of variables whose value is temporarily revealed; values are masked
  // by default so secrets are not shown on screen.
  const [revealedValueIds, setRevealedValueIds] = useState<Set<string>>(
    () => new Set(),
  );
  const enabledVariableCount = useMemo(
    () =>
      draftPreferences.environmentVariables.filter(
        (variable) => variable.enabled && variable.key.trim(),
      ).length,
    [draftPreferences.environmentVariables],
  );
  // The AI provider whose credential template is shown in the AI section. Seeded
  // to the first already-configured provider when the dialog opens (below), so a
  // returning user lands on the provider they set up.
  const [aiProvider, setAiProvider] = useState<AssistantProviderId>("google");
  // The draft env vars as a plain name→value map (enabled, named only), matching
  // what the live runtime env will hold after Save. Drives the per-provider
  // "configured" status without re-implementing provider.ts resolution.
  const draftEnv = useMemo(() => {
    const env: Record<string, string> = {};
    for (const variable of draftPreferences.environmentVariables) {
      const key = variable.key.trim();
      if (variable.enabled && key) env[key] = variable.value;
    }
    return env;
  }, [draftPreferences.environmentVariables]);
  const configuredProviders = useMemo(
    () => new Set(availableProviders(draftEnv)),
    [draftEnv],
  );

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
      // Discard any uncommitted hex text so a half-typed/invalid value never
      // resurfaces on the next open (the swatch already shows the saved color),
      // and clear the Escape skip flag so a leftover true can't swallow the
      // first edit of the next session.
      skipCustomColorCommitRef.current = false;
      setCustomColorDraft(null);
      return;
    }
    const seededPreferences = clonePreferences(
      useAppStore.getState().preferences,
    );
    setDraftPreferences(seededPreferences);
    setDraftDesktopSettings(
      cloneDesktopSettings(useDesktopSettingsStore.getState().desktopSettings),
    );
    // Land the AI section on a provider the user already configured, so editing
    // existing credentials needs no extra click.
    const seededEnv: Record<string, string> = {};
    for (const variable of seededPreferences.environmentVariables) {
      const key = variable.key.trim();
      if (variable.enabled && key) seededEnv[key] = variable.value;
    }
    setAiProvider(availableProviders(seededEnv)[0] ?? "google");
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
        const profile =
          useDesktopSettingsStore.getState().desktopSettings.uiProfile;
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
    if (!open || pendingFocus !== "shareToken") return;
    if (effectiveSection !== "environment") return;
    const id = window.requestAnimationFrame(() => {
      shareTokenInputRef.current?.focus();
      shareTokenInputRef.current?.select();
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

  // Every env var name a field is backed by: its canonical key plus any aliases
  // provider.ts also accepts (e.g. GOOGLE_API_KEY for the Gemini field).
  const fieldEnvKeys = (field: ProviderField): readonly string[] => [
    field.envKey,
    ...(field.aliases ?? []),
  ];

  // The value of an env-var-backed AI provider field, or "" when unset. Only an
  // enabled row counts: a var disabled in the Environment section must read as
  // empty so the field matches the (also enabled-only) status banner. An aliased
  // value (e.g. an existing GOOGLE_API_KEY) is surfaced rather than hidden.
  const getProviderField = (field: ProviderField): string => {
    for (const key of fieldEnvKeys(field)) {
      const row = draftPreferences.environmentVariables.find(
        (variable) => variable.key === key && variable.enabled,
      );
      if (row) return row.value;
    }
    return "";
  };

  // Write an AI provider field through to its backing env var. Edits the enabled
  // row the user already has (canonical or alias) so re-entering a credential
  // never creates a duplicate key; otherwise drops any same-named disabled rows
  // (so a deliberately disabled var is not silently re-enabled with its old
  // value) and appends a fresh enabled row under the canonical name. Clearing
  // removes the row so the Environment list never accrues empty entries.
  const setProviderField = (field: ProviderField, value: string) => {
    const keys = fieldEnvKeys(field);
    setDraftPreferences((current) => {
      const enabledIndex = current.environmentVariables.findIndex(
        (variable) => keys.includes(variable.key) && variable.enabled,
      );
      if (enabledIndex !== -1) {
        const next = current.environmentVariables.slice();
        if (value === "") {
          next.splice(enabledIndex, 1);
        } else {
          next[enabledIndex] = { ...next[enabledIndex], value };
        }
        return { ...current, environmentVariables: next };
      }
      if (value === "") return current;
      const kept = current.environmentVariables.filter(
        (variable) => !keys.includes(variable.key),
      );
      return {
        ...current,
        environmentVariables: [
          ...kept,
          { id: createDraftId(), key: field.envKey, value, enabled: true },
        ],
      };
    });
    setError(null);
  };

  const updateMapPreferences = (patch: Partial<MapPreferences>) => {
    setDraftPreferences((current) => ({
      ...current,
      map: { ...current.map, ...patch },
    }));
    setError(null);
  };

  const updateBoundsValue = (index: number, value: number) => {
    // Ignore a cleared field (valueAsNumber is NaN) so it does not silently
    // become an edge-of-range value on save; the last valid value is kept.
    if (!Number.isFinite(value)) return;
    setDraftPreferences((current) => {
      const bounds: MapPreferences["bounds"] = [...current.map.bounds];
      bounds[index] = value;
      return {
        ...current,
        map: { ...current.map, bounds },
      };
    });
    setError(null);
  };

  const updateEnvironmentVariable = (
    index: number,
    patch: Partial<RuntimeEnvironmentVariable>,
  ) => {
    setDraftPreferences((current) => ({
      ...current,
      environmentVariables: current.environmentVariables.map((variable, i) =>
        i === index ? { ...variable, ...patch } : variable,
      ),
    }));
    setError(null);
  };

  const addEnvironmentVariable = () => {
    setDraftPreferences((current) => ({
      ...current,
      environmentVariables: [
        ...current.environmentVariables,
        { id: createDraftId(), key: "", value: "", enabled: true },
      ],
    }));
    setSection("environment");
    setError(null);
  };

  const removeEnvironmentVariable = (index: number) => {
    setDraftPreferences((current) => ({
      ...current,
      environmentVariables: current.environmentVariables.filter(
        (_, i) => i !== index,
      ),
    }));
    setError(null);
  };

  const applyCurrentViewBounds = () => {
    const bounds = mapControllerRef.current?.readView().bbox;
    if (!bounds) {
      setError(t("settings.map.errorBoundsUnavailable"));
      return;
    }
    updateMapPreferences({
      restrictBounds: true,
      bounds: [
        roundCoordinate(bounds[0]),
        roundCoordinate(bounds[1]),
        roundCoordinate(bounds[2]),
        roundCoordinate(bounds[3]),
      ],
    });
  };

  const resetMapPreferences = () => {
    updateMapPreferences(DEFAULT_PROJECT_PREFERENCES.map);
  };

  const updateGeocoding = (
    patch: Partial<ProjectPreferences["geocoding"]>,
  ) => {
    setDraftPreferences((current) => ({
      ...current,
      geocoding: { ...current.geocoding, ...patch },
    }));
    setError(null);
  };

  const updateGeocodingApiKey = (providerId: string, value: string) => {
    setDraftPreferences((current) => ({
      ...current,
      geocoding: {
        ...current.geocoding,
        apiKeys: { ...current.geocoding.apiKeys, [providerId]: value },
      },
    }));
    setError(null);
  };

  const updateDraftLayoutSettings = (patch: Partial<DesktopLayoutSettings>) => {
    setDraftDesktopSettings((current) => ({
      ...current,
      layout: { ...current.layout, ...patch },
    }));
    setError(null);
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

  const resetLayoutSettings = () => {
    updateDraftLayoutSettings(DEFAULT_DESKTOP_LAYOUT_SETTINGS);
  };

  // The accent scheme applies live (instant preview) rather than waiting for
  // Save, mirroring the Interface profile toggles. Reads the latest state so a
  // rapid click after another live change does not clobber it with a stale
  // render-closure snapshot.
  const updateSavedThemeScheme = (scheme: ThemeScheme) => {
    const current = useDesktopSettingsStore.getState().desktopSettings;
    setDesktopSettings({ ...current, theme: { ...current.theme, scheme } });
  };

  // Picking a custom color both stores the color and activates the custom scheme,
  // so editing the swatch immediately previews it.
  const updateSavedThemeCustomColor = (customColor: string) => {
    const current = useDesktopSettingsStore.getState().desktopSettings;
    setDesktopSettings({
      ...current,
      theme: { ...current.theme, scheme: "custom", customColor },
    });
  };

  // In-progress text for the inline hex field next to the swatch. While the user
  // is typing or pasting a code it holds the raw string; `null` means the field
  // mirrors the saved color. On commit a valid 3- or 6-digit hex applies and an
  // invalid one is discarded, so the field reverts to the last valid color (#911).
  const [customColorDraft, setCustomColorDraft] = useState<string | null>(null);
  // Set just before the Escape-triggered blur so the imminent blur discards the
  // draft instead of committing it: the dialog still closes (its own Escape
  // handler), but the typed value is cancelled rather than applied on the way out.
  const skipCustomColorCommitRef = useRef(false);

  const commitCustomColorDraft = () => {
    if (skipCustomColorCommitRef.current) {
      skipCustomColorCommitRef.current = false;
      setCustomColorDraft(null);
      return;
    }
    if (customColorDraft === null) return;
    const normalized = normalizeHexColor(customColorDraft);
    if (normalized) updateSavedThemeCustomColor(normalized);
    setCustomColorDraft(null);
  };

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

  const updateShareToken = (value: string) => {
    // Kept in the draft and only committed on Save, so editing the token and
    // then closing the dialog without saving discards the change (a secret
    // field should not persist on every keystroke).
    setDraftDesktopSettings((current) => ({ ...current, shareToken: value }));
  };

  const updateUiProfile = (patch: Partial<UiProfileSettings>) => {
    setDraftDesktopSettings((current) => ({
      ...current,
      uiProfile: { ...current.uiProfile, ...patch },
    }));
    setError(null);
  };

  // Applying an experience-level preset overwrites the hidden lists from tiers
  // and turns the profile on. Plugin tiers consider the toggleable plugin ids.
  const applyExperiencePreset = (level: ExperienceLevel) => {
    const sets = presetHiddenSets(
      level,
      profilePlugins.map((plugin) => plugin.id),
    );
    updateUiProfile({ enabled: true, level, ...sets });
  };

  // Selecting "Custom" enables filtering and clears the preset level without
  // touching the hidden lists, so the current checkbox configuration is carried
  // through verbatim (issue #592). From the legacy "show everything" state this
  // simply opts into custom mode with everything still visible.
  const applyCustomProfile = () => {
    updateUiProfile({ enabled: true, level: null });
  };

  // Toggling a single item switches the profile to "custom" (level = null) and
  // enables filtering so the edit takes effect even when starting from the
  // legacy "show everything" state.
  const toggleDataSourceHidden = (id: string, visible: boolean) => {
    setDraftDesktopSettings((current) => {
      const hidden = new Set(current.uiProfile.hiddenDataSources);
      if (visible) hidden.delete(id);
      else hidden.add(id);
      return {
        ...current,
        uiProfile: {
          ...current.uiProfile,
          enabled: true,
          level: null,
          hiddenDataSources: [...hidden],
        },
      };
    });
    setError(null);
  };

  const togglePluginHidden = (id: string, visible: boolean) => {
    setDraftDesktopSettings((current) => {
      const hidden = new Set(current.uiProfile.hiddenPlugins);
      if (visible) hidden.delete(id);
      else hidden.add(id);
      return {
        ...current,
        uiProfile: {
          ...current.uiProfile,
          enabled: true,
          level: null,
          hiddenPlugins: [...hidden],
        },
      };
    });
    setError(null);
  };

  const toggleMenuHidden = (id: string, visible: boolean) => {
    setDraftDesktopSettings((current) => {
      const hidden = new Set(current.uiProfile.hiddenMenus);
      if (visible) hidden.delete(id);
      else hidden.add(id);
      return {
        ...current,
        uiProfile: {
          ...current.uiProfile,
          enabled: true,
          level: null,
          hiddenMenus: [...hidden],
        },
      };
    });
    setError(null);
  };

  const toggleMenuItemHidden = (id: string, visible: boolean) => {
    setDraftDesktopSettings((current) => {
      const hidden = new Set(current.uiProfile.hiddenMenuItems);
      if (visible) hidden.delete(id);
      else hidden.add(id);
      return {
        ...current,
        uiProfile: {
          ...current.uiProfile,
          enabled: true,
          level: null,
          hiddenMenuItems: [...hidden],
        },
      };
    });
    setError(null);
  };

  // Reset clears the profile to "show everything" but preserves the admin lock
  // and the onboarding flag.
  const resetUiProfile = () => {
    updateUiProfile({
      enabled: DEFAULT_UI_PROFILE_SETTINGS.enabled,
      level: DEFAULT_UI_PROFILE_SETTINGS.level,
      hiddenDataSources: [],
      hiddenPlugins: [],
      hiddenMenus: [],
      hiddenMenuItems: [],
    });
  };

  const saveSettings = () => {
    const normalized = normalizePreferences(draftPreferences);
    const validationError = validateEnvironmentVariables(
      normalized.environmentVariables,
    );
    if (validationError) {
      setError(
        validationError.kind === "duplicate"
          ? t("settings.env.errorDuplicate", { name: validationError.name })
          : t("settings.env.errorNamePattern"),
      );
      setSection("environment");
      return;
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
      uiProfile: committedUiProfile,
      updates: draftDesktopSettings.updates,
    });
    setOpen(false);
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
            {showLabels ? (
              <span className="hidden sm:inline">{t("settings.title")}</span>
            ) : null}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56">
          <DropdownMenuLabel>{t("settings.title")}</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <Languages className="mr-2 h-3.5 w-3.5" />
              {t("language.label")}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-44">
              <DropdownMenuRadioGroup
                value={language}
                onValueChange={setLanguage}
              >
                {languageOptions.map((option) => (
                  <DropdownMenuRadioItem
                    key={option.code}
                    value={option.code}
                  >
                    {option.nativeName === option.englishName
                      ? option.nativeName
                      : `${option.nativeName} (${option.englishName})`}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
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
              <MapPinned className="mr-2 h-3.5 w-3.5" />
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
                onValueChange={(value: string) =>
                  updateSavedThemeScheme(value as ThemeScheme)
                }
              >
                {THEME_SCHEMES.map((scheme) => (
                  <DropdownMenuRadioItem
                    key={scheme.id}
                    value={scheme.id}
                    onSelect={(event: Event) => event.preventDefault()}
                  >
                    <span
                      aria-hidden
                      className="mr-2 h-3.5 w-3.5 shrink-0 rounded-full border"
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
                    className="mr-2 h-3.5 w-3.5 shrink-0 rounded-full border"
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
              <Locate className="mr-2 h-3.5 w-3.5" />
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
              <Bot className="mr-2 h-3.5 w-3.5" />
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
              <Braces className="mr-2 h-3.5 w-3.5" />
              {t("settings.menu.environmentVariables")}
            </DropdownMenuItem>
          )}
          {isTauri() && (
            <DropdownMenuItem
              onSelect={() => {
                setSection("updates");
                setOpen(true);
              }}
            >
              <DownloadCloud className="mr-2 h-3.5 w-3.5" />
              {t("settings.menu.updates")}
            </DropdownMenuItem>
          )}
          {showSettingsItem("settings.managePlugins") && (
            <DropdownMenuItem onSelect={() => onOpenManagePlugins()}>
              <Puzzle className="mr-2 h-3.5 w-3.5" />
              {t("settings.menu.managePlugins")}
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
          <div className="grid min-h-0 grid-cols-1 md:grid-cols-[12rem_1fr]">
            <nav className="flex gap-1 border-b p-3 md:flex-col md:border-b-0 md:border-r">
              {SECTION_ITEMS.filter((item) => isSectionVisible(item.id)).map(
                renderSectionButton,
              )}
            </nav>
            <div className="min-h-0 overflow-y-auto p-6">
              {effectiveSection === "map" ? (
                <div className="space-y-5">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <h3 className="text-sm font-semibold">
                        {t("settings.map.constraintsTitle")}
                      </h3>
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={resetMapPreferences}
                    >
                      <RotateCcw className="h-3.5 w-3.5" />
                      {t("common.reset")}
                    </Button>
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        className="h-4 w-4"
                        type="checkbox"
                        checked={draftPreferences.map.restrictBounds}
                        onChange={(event) =>
                          updateMapPreferences({
                            restrictBounds: event.target.checked,
                          })
                        }
                      />
                      {t("settings.map.restrictBounds")}
                    </label>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      title={t("settings.map.useCurrentViewHint")}
                      onClick={applyCurrentViewBounds}
                    >
                      <Crosshair className="h-3.5 w-3.5" />
                      {t("settings.map.useCurrentView")}
                    </Button>
                  </div>
                  <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                    {(
                      [
                        ["settings.map.west", 0, -180, 180],
                        ["settings.map.south", 1, -85, 85],
                        ["settings.map.east", 2, -180, 180],
                        ["settings.map.north", 3, -85, 85],
                      ] as const
                    ).map(([labelKey, index, min, max]) => (
                      <div key={labelKey} className="space-y-1.5">
                        <Label
                          htmlFor={`settings-bounds-${index}`}
                          className={
                            draftPreferences.map.restrictBounds
                              ? undefined
                              : "cursor-not-allowed opacity-50"
                          }
                        >
                          {t(labelKey)}
                        </Label>
                        <Input
                          id={`settings-bounds-${index}`}
                          type="number"
                          min={min}
                          max={max}
                          step="0.000001"
                          disabled={!draftPreferences.map.restrictBounds}
                          value={draftPreferences.map.bounds[index as number]}
                          onChange={(event) =>
                            updateBoundsValue(
                              index as number,
                              event.target.valueAsNumber,
                            )
                          }
                        />
                      </div>
                    ))}
                  </div>
                  {liveProjection === "globe" ? (
                    <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
                      <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
                      <span>{t("settings.map.useCurrentViewGlobeHint")}</span>
                    </p>
                  ) : null}
                  <div className="grid gap-3 sm:grid-cols-3">
                    <div className="space-y-1.5">
                      <Label htmlFor="settings-min-zoom">
                        {t("settings.map.minZoom")}
                      </Label>
                      <Input
                        id="settings-min-zoom"
                        type="number"
                        min={0}
                        max={24}
                        step={0.25}
                        value={draftPreferences.map.minZoom}
                        onChange={(event) =>
                          updateMapPreferences({
                            minZoom: event.target.valueAsNumber,
                          })
                        }
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="settings-max-zoom">
                        {t("settings.map.maxZoom")}
                      </Label>
                      <Input
                        id="settings-max-zoom"
                        type="number"
                        min={0}
                        max={24}
                        step={0.25}
                        value={draftPreferences.map.maxZoom}
                        onChange={(event) =>
                          updateMapPreferences({
                            maxZoom: event.target.valueAsNumber,
                          })
                        }
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="settings-max-pitch">
                        {t("settings.map.maxPitch")}
                      </Label>
                      <Input
                        id="settings-max-pitch"
                        type="number"
                        min={0}
                        max={85}
                        step={1}
                        value={draftPreferences.map.maxPitch}
                        onChange={(event) =>
                          updateMapPreferences({
                            maxPitch: event.target.valueAsNumber,
                          })
                        }
                      />
                    </div>
                  </div>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      className="h-4 w-4"
                      type="checkbox"
                      checked={draftPreferences.map.renderWorldCopies}
                      onChange={(event) =>
                        updateMapPreferences({
                          renderWorldCopies: event.target.checked,
                        })
                      }
                    />
                    {t("settings.map.renderWorldCopies")}
                  </label>
                </div>
              ) : null}
              {effectiveSection === "layout" ? (
                <div className="space-y-5">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <h3 className="text-sm font-semibold">
                        {t("settings.layout.title")}
                      </h3>
                      <p className="text-xs text-muted-foreground">
                        {t("settings.layout.description")}
                      </p>
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={resetLayoutSettings}
                    >
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
                  </div>
                  {showsAdvancedNotices(desktopSettings.uiProfile) ? (
                    <div className="rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
                      {t("settings.layout.urlParamsNote")}
                    </div>
                  ) : null}
                </div>
              ) : null}
              {effectiveSection === "appearance" ? (
                <div className="space-y-5">
                  <div>
                    <h3 className="text-sm font-semibold">
                      {t("settings.appearance.title")}
                    </h3>
                    <p className="text-xs text-muted-foreground">
                      {t("settings.appearance.description")}
                    </p>
                  </div>
                  <div className="space-y-3">
                    <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      {t("settings.appearance.themeMode")}
                    </h4>
                    {/* Light/dark cards so the mode lives beside the accent
                        color instead of only on the toolbar (#716). The mode is
                        a two-state toggle, so a non-active card just flips it. */}
                    <div className="grid grid-cols-2 gap-3">
                      {(["light", "dark"] as const).map((mode) => {
                        const active = themeMode === mode;
                        const ModeIcon = mode === "light" ? Sun : Moon;
                        return (
                          <button
                            key={mode}
                            type="button"
                            aria-pressed={active}
                            onClick={() => {
                              if (!active) onToggleThemeMode();
                            }}
                            className={cn(
                              "flex items-center gap-2.5 rounded-md border p-3 text-sm transition-colors",
                              active
                                ? "border-primary ring-2 ring-ring"
                                : "hover:bg-accent",
                            )}
                          >
                            <ModeIcon className="h-5 w-5 shrink-0" />
                            <span>{t(`settings.appearance.mode.${mode}`)}</span>
                            {active ? (
                              <Check className="ml-auto h-4 w-4 text-primary" />
                            ) : null}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                  <div className="space-y-3">
                    <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      {t("settings.appearance.accentColor")}
                    </h4>
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                      {THEME_SCHEMES.map((scheme) => {
                        const active =
                          desktopSettings.theme.scheme === scheme.id;
                        return (
                          <button
                            key={scheme.id}
                            type="button"
                            aria-pressed={active}
                            onClick={() => updateSavedThemeScheme(scheme.id)}
                            className={cn(
                              "flex items-center gap-2.5 rounded-md border p-3 text-sm transition-colors",
                              active
                                ? "border-primary ring-2 ring-ring"
                                : "hover:bg-accent",
                            )}
                          >
                            <span
                              aria-hidden
                              className="h-5 w-5 shrink-0 rounded-full border"
                              style={{ backgroundColor: scheme.swatch }}
                            />
                            <span>{t(scheme.labelKey)}</span>
                            {active ? (
                              <Check className="ml-auto h-4 w-4 text-primary" />
                            ) : null}
                          </button>
                        );
                      })}
                      <button
                        type="button"
                        aria-pressed={
                          desktopSettings.theme.scheme === "custom"
                        }
                        onClick={() => updateSavedThemeScheme("custom")}
                        className={cn(
                          "flex items-center gap-2.5 rounded-md border p-3 text-sm transition-colors",
                          desktopSettings.theme.scheme === "custom"
                            ? "border-primary ring-2 ring-ring"
                            : "hover:bg-accent",
                        )}
                      >
                        <span
                          aria-hidden
                          className="h-5 w-5 shrink-0 rounded-full border"
                          style={{
                            backgroundColor: desktopSettings.theme.customColor,
                          }}
                        />
                        <span>{t("settings.appearance.custom")}</span>
                        {desktopSettings.theme.scheme === "custom" ? (
                          <Check className="ml-auto h-4 w-4 text-primary" />
                        ) : null}
                      </button>
                    </div>
                    {desktopSettings.theme.scheme === "custom" ? (
                      <label className="flex items-center gap-3 rounded-md border p-3 text-sm">
                        <input
                          ref={customColorInputRef}
                          type="color"
                          className="h-8 w-12 shrink-0 cursor-pointer rounded border bg-transparent p-0.5"
                          value={desktopSettings.theme.customColor}
                          onChange={(event) =>
                            updateSavedThemeCustomColor(event.target.value)
                          }
                          aria-label={t("settings.appearance.customColor")}
                        />
                        <span>{t("settings.appearance.customColor")}</span>
                        {/* Inline hex entry so power users can type or paste an
                            exact code instead of only dragging the native picker.
                            The text input is interactive content, so a click lands
                            here and focuses it rather than reopening the picker the
                            wrapping label drives (#911). */}
                        <input
                          type="text"
                          spellCheck={false}
                          autoComplete="off"
                          className="ml-auto w-24 rounded border bg-transparent px-2 py-1 text-right font-mono text-xs uppercase text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-[invalid=true]:border-destructive aria-[invalid=true]:text-destructive"
                          value={
                            customColorDraft ??
                            desktopSettings.theme.customColor
                          }
                          // The field already holds a full `#rrggbb`, so select
                          // all on focus to let the user type a replacement.
                          onFocus={(event) => event.target.select()}
                          // Drop whitespace and cap to the longest valid form
                          // (`#rrggbb`) as the draft is stored, so a padded or
                          // oversized paste is sanitized in place instead of
                          // sitting clobbered; this also bounds a runaway paste
                          // without a brittle maxLength that has to guess how
                          // much surrounding whitespace to allow.
                          onChange={(event) =>
                            setCustomColorDraft(
                              event.target.value.replace(/\s/g, "").slice(0, 7),
                            )
                          }
                          onBlur={commitCustomColorDraft}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              // Blur is the single commit path; the resulting
                              // onBlur applies/reverts the draft, so don't also
                              // commit here and double-write the same value.
                              event.preventDefault();
                              event.currentTarget.blur();
                            } else if (event.key === "Escape") {
                              // Cancel the edit: flag the commit to skip, then
                              // blur so the value is dropped, not applied. The
                              // dialog's own Escape handling still closes it.
                              skipCustomColorCommitRef.current = true;
                              event.currentTarget.blur();
                            }
                          }}
                          aria-label={t("settings.appearance.customColorHex")}
                          // `|| undefined` omits the attribute entirely when
                          // valid; a literal aria-invalid="false" makes some
                          // screen readers announce "invalid: false" on focus.
                          aria-invalid={
                            (customColorDraft !== null &&
                              customColorDraft.trim() !== "" &&
                              normalizeHexColor(customColorDraft) === null) ||
                            undefined
                          }
                        />
                      </label>
                    ) : null}
                  </div>
                </div>
              ) : null}
              {effectiveSection === "interface" ? (
                <div className="space-y-5">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <h3 className="text-sm font-semibold">
                        {t("settings.interface.title")}
                      </h3>
                      <p className="text-xs text-muted-foreground">
                        {t("settings.interface.description")}
                      </p>
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={draftDesktopSettings.uiProfile.locked}
                      onClick={resetUiProfile}
                    >
                      <RotateCcw className="h-3.5 w-3.5" />
                      {t("common.reset")}
                    </Button>
                  </div>
                  {draftDesktopSettings.uiProfile.locked ? (
                    <div className="rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
                      {t("settings.interface.lockedNote")}
                    </div>
                  ) : null}
                  <div className="space-y-2">
                    <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      {t("settings.interface.presets")}
                    </h4>
                    <div className="flex flex-wrap gap-2">
                      {INTERFACE_PROFILES.map((option) => {
                        const active =
                          activeInterfaceProfile(
                            draftDesktopSettings.uiProfile,
                          ) === option;
                        return (
                          <Button
                            key={option}
                            type="button"
                            size="sm"
                            // The active profile gets the solid primary fill so it
                            // reads clearly as the running state, including
                            // "custom" (issue #592). Inactive choices stay
                            // outlined.
                            variant={active ? "default" : "outline"}
                            // "custom" activates automatically when an item is
                            // toggled below, but it is also directly clickable so
                            // the user can opt into custom mode while keeping the
                            // current configuration intact.
                            disabled={draftDesktopSettings.uiProfile.locked}
                            aria-current={active ? true : undefined}
                            onClick={
                              option === "custom"
                                ? applyCustomProfile
                                : () => applyExperiencePreset(option)
                            }
                          >
                            {t(`settings.interface.level.${option}`)}
                          </Button>
                        );
                      })}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {t("settings.interface.presetsHint")}
                    </p>
                  </div>
                  <div className="space-y-3">
                    <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      {t("settings.interface.dataSources")}
                    </h4>
                    {DATA_SOURCE_SECTION_ORDER.map((sectionId) => (
                      <div key={sectionId} className="space-y-1.5">
                        <h5 className="text-xs font-medium text-muted-foreground">
                          {t(DATA_SOURCE_SECTION_LABEL_KEYS[sectionId])}
                        </h5>
                        <div className="grid gap-1.5 sm:grid-cols-2">
                          {DATA_SOURCE_CATALOG.filter(
                            (entry) => entry.section === sectionId,
                          ).map((entry) => (
                            <label
                              key={entry.id}
                              className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm"
                            >
                              <input
                                className="h-4 w-4"
                                type="checkbox"
                                checked={
                                  !draftDesktopSettings.uiProfile.hiddenDataSources.includes(
                                    entry.id,
                                  )
                                }
                                disabled={
                                  draftDesktopSettings.uiProfile.locked
                                }
                                onChange={(event) =>
                                  toggleDataSourceHidden(
                                    entry.id,
                                    event.target.checked,
                                  )
                                }
                              />
                              <span>{t(entry.labelKey)}</span>
                            </label>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                  {profilePlugins.length > 0 ? (
                    <div className="space-y-1.5">
                      <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        {t("settings.interface.plugins")}
                      </h4>
                      <div className="grid gap-1.5 sm:grid-cols-2">
                        {profilePlugins.map((plugin) => (
                          <label
                            key={plugin.id}
                            className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm"
                          >
                            <input
                              className="h-4 w-4"
                              type="checkbox"
                              checked={
                                !draftDesktopSettings.uiProfile.hiddenPlugins.includes(
                                  plugin.id,
                                )
                              }
                              disabled={
                                draftDesktopSettings.uiProfile.locked
                              }
                              onChange={(event) =>
                                togglePluginHidden(plugin.id, event.target.checked)
                              }
                            />
                            <span>{plugin.name}</span>
                          </label>
                        ))}
                      </div>
                    </div>
                  ) : null}
                  <div className="space-y-3">
                    <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      {t("settings.interface.menus")}
                    </h4>
                    <div className="grid gap-1.5 sm:grid-cols-2">
                      {TOP_LEVEL_MENUS.map((menu) => (
                        <label
                          key={menu.id}
                          className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm"
                        >
                          <input
                            className="h-4 w-4"
                            type="checkbox"
                            checked={
                              !draftDesktopSettings.uiProfile.hiddenMenus.includes(
                                menu.id,
                              )
                            }
                            disabled={
                              draftDesktopSettings.uiProfile.locked
                            }
                            onChange={(event) =>
                              toggleMenuHidden(menu.id, event.target.checked)
                            }
                          />
                          <span>{t(menu.labelKey)}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                  {MENU_ITEM_GROUPS.map((group) => (
                    <div key={group.menuId} className="space-y-1.5">
                      <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        {t(group.labelKey)}
                      </h4>
                      <div className="grid gap-1.5 sm:grid-cols-2">
                        {MENU_ITEM_CATALOG.filter(
                          (entry) => entry.menuId === group.menuId,
                        ).map((entry) => (
                          <label
                            key={entry.id}
                            className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm"
                          >
                            <input
                              className="h-4 w-4"
                              type="checkbox"
                              checked={
                                !draftDesktopSettings.uiProfile.hiddenMenuItems.includes(
                                  entry.id,
                                )
                              }
                              disabled={
                                draftDesktopSettings.uiProfile.locked
                              }
                              onChange={(event) =>
                                toggleMenuItemHidden(entry.id, event.target.checked)
                              }
                            />
                            <span>{t(entry.labelKey)}</span>
                          </label>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}
              {effectiveSection === "geocoding" ? (
                <div className="space-y-5">
                  <div className="space-y-1">
                    <h3 className="text-sm font-semibold">
                      {t("settings.geocoding.title")}
                    </h3>
                    <p className="text-xs text-muted-foreground">
                      {t("settings.geocoding.description")}
                    </p>
                  </div>
                  {(() => {
                    const provider = getGeocodingProvider(
                      draftPreferences.geocoding.providerId,
                    );
                    const apiKeyId = `geocoding-api-key-${provider.id}`;
                    const apiKeyRevealed = revealedValueIds.has(apiKeyId);
                    return (
                      <div className="space-y-4">
                        <div className="space-y-1.5">
                          <Label className="text-xs">
                            {t("settings.geocoding.provider")}
                          </Label>
                          <Select
                            value={provider.id}
                            onChange={(event) =>
                              updateGeocoding({
                                providerId: event.target.value,
                              })
                            }
                          >
                            {GEOCODING_PROVIDERS.map((p) => (
                              <option key={p.id} value={p.id}>
                                {p.label}
                              </option>
                            ))}
                          </Select>
                          <p className="text-xs text-muted-foreground">
                            {provider.requiresApiKey
                              ? t("settings.geocoding.requiresKey")
                              : provider.acceptsApiKey
                                ? t("settings.geocoding.optionalKey")
                                : t("settings.geocoding.noKey")}
                          </p>
                          {provider.browserCorsRestricted ? (
                            <p className="text-xs text-amber-600 dark:text-amber-500">
                              {t("settings.geocoding.corsNote")}
                            </p>
                          ) : null}
                        </div>

                        {provider.acceptsApiKey ? (
                          <div className="space-y-1.5">
                            <Label className="text-xs" htmlFor="geocoding-key">
                              {t("settings.geocoding.apiKey")}
                            </Label>
                            <div className="flex items-center gap-2">
                              <Input
                                id="geocoding-key"
                                type={apiKeyRevealed ? "text" : "password"}
                                autoComplete="off"
                                spellCheck={false}
                                value={
                                  draftPreferences.geocoding.apiKeys[
                                    provider.id
                                  ] ?? ""
                                }
                                onChange={(event) =>
                                  updateGeocodingApiKey(
                                    provider.id,
                                    event.target.value,
                                  )
                                }
                                placeholder={t(
                                  "settings.geocoding.apiKeyPlaceholder",
                                )}
                              />
                              <Button
                                type="button"
                                size="icon"
                                variant="ghost"
                                onClick={() => toggleValueVisibility(apiKeyId)}
                                aria-label={t("settings.geocoding.toggleApiKey")}
                              >
                                {apiKeyRevealed ? (
                                  <EyeOff className="h-3.5 w-3.5" />
                                ) : (
                                  <Eye className="h-3.5 w-3.5" />
                                )}
                              </Button>
                            </div>
                            <p className="text-xs text-amber-600 dark:text-amber-500">
                              {t("settings.geocoding.secretsWarning")}
                            </p>
                          </div>
                        ) : null}

                        <div className="space-y-1.5">
                          <Label
                            className="text-xs"
                            htmlFor="geocoding-forward"
                          >
                            {t("settings.geocoding.forwardEndpoint")}
                          </Label>
                          <Input
                            id="geocoding-forward"
                            value={
                              draftPreferences.geocoding.forwardEndpoint ?? ""
                            }
                            onChange={(event) =>
                              updateGeocoding({
                                forwardEndpoint: event.target.value,
                              })
                            }
                            placeholder={provider.defaultForwardEndpoint}
                          />
                        </div>

                        <div className="space-y-1.5">
                          <Label
                            className="text-xs"
                            htmlFor="geocoding-reverse"
                          >
                            {t("settings.geocoding.reverseEndpoint")}
                          </Label>
                          <Input
                            id="geocoding-reverse"
                            value={
                              draftPreferences.geocoding.reverseEndpoint ?? ""
                            }
                            onChange={(event) =>
                              updateGeocoding({
                                reverseEndpoint: event.target.value,
                              })
                            }
                            placeholder={provider.defaultReverseEndpoint}
                          />
                        </div>

                        <div className="space-y-1.5">
                          <Label className="text-xs" htmlFor="geocoding-email">
                            {t("settings.geocoding.email")}
                          </Label>
                          <Input
                            id="geocoding-email"
                            type="email"
                            value={draftPreferences.geocoding.email ?? ""}
                            onChange={(event) =>
                              updateGeocoding({ email: event.target.value })
                            }
                            placeholder={t(
                              "settings.geocoding.emailPlaceholder",
                            )}
                          />
                          <p className="text-xs text-muted-foreground">
                            {t("settings.geocoding.emailHint")}
                          </p>
                        </div>
                      </div>
                    );
                  })()}
                </div>
              ) : null}
              {effectiveSection === "ai" ? (
                <div className="space-y-5">
                  <div className="space-y-1">
                    <h3 className="text-sm font-semibold">
                      {t("settings.ai.title")}
                    </h3>
                    <p className="text-xs text-muted-foreground">
                      {t("settings.ai.description")}
                    </p>
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs" htmlFor="settings-ai-provider">
                      {t("settings.ai.providerLabel")}
                    </Label>
                    <Select
                      id="settings-ai-provider"
                      value={aiProvider}
                      onChange={(event) =>
                        setAiProvider(
                          event.target.value as AssistantProviderId,
                        )
                      }
                    >
                      {ASSISTANT_PROVIDER_IDS.map((id) => (
                        <option key={id} value={id}>
                          {configuredProviders.has(id)
                            ? `${PROVIDER_LABELS[id]} ${t("settings.ai.configuredMark")}`
                            : PROVIDER_LABELS[id]}
                        </option>
                      ))}
                    </Select>
                    <p className="text-xs text-muted-foreground">
                      {t("settings.ai.providerHint")}
                    </p>
                  </div>
                  {configuredProviders.has(aiProvider) ? (
                    <div className="flex items-center gap-1.5 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-300">
                      <Check className="h-3.5 w-3.5 shrink-0" />
                      <span>
                        {t("settings.ai.statusReady", {
                          provider: PROVIDER_LABELS[aiProvider],
                        })}
                      </span>
                    </div>
                  ) : (
                    <div className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
                      {t("settings.ai.statusIncomplete", {
                        provider: PROVIDER_LABELS[aiProvider],
                      })}
                    </div>
                  )}
                  <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300">
                    <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>{t("settings.env.secretsWarning")}</span>
                  </div>
                  <div className="space-y-4">
                    {PROVIDER_FIELDS[aiProvider].map((field) => {
                      const revealed = revealedValueIds.has(field.envKey);
                      return (
                        <div key={field.envKey} className="space-y-1.5">
                          <div className="flex items-center justify-between gap-2">
                            <Label
                              className="text-xs"
                              htmlFor={`settings-ai-${field.envKey}`}
                            >
                              {t(field.labelKey)}
                              {field.required ? null : (
                                <span className="ml-1 font-normal text-muted-foreground">
                                  {t("settings.ai.optionalMark")}
                                </span>
                              )}
                            </Label>
                            <code className="font-mono text-[11px] text-muted-foreground">
                              {field.envKey}
                            </code>
                          </div>
                          <div className="flex items-center gap-2">
                            <Input
                              id={`settings-ai-${field.envKey}`}
                              type={
                                field.secret && !revealed ? "password" : "text"
                              }
                              autoComplete="off"
                              spellCheck={false}
                              value={getProviderField(field)}
                              onChange={(event) =>
                                setProviderField(field, event.target.value)
                              }
                              placeholder={t(field.placeholderKey)}
                            />
                            {field.secret ? (
                              <Button
                                type="button"
                                size="icon"
                                variant="ghost"
                                onClick={() =>
                                  toggleValueVisibility(field.envKey)
                                }
                                aria-label={
                                  revealed
                                    ? t("settings.ai.hideValue", {
                                        name: t(field.labelKey),
                                      })
                                    : t("settings.ai.showValue", {
                                        name: t(field.labelKey),
                                      })
                                }
                              >
                                {revealed ? (
                                  <EyeOff className="h-3.5 w-3.5" />
                                ) : (
                                  <Eye className="h-3.5 w-3.5" />
                                )}
                              </Button>
                            ) : null}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  {PROVIDER_DOCS_URL[aiProvider] ? (
                    <a
                      className="inline-flex items-center gap-1 text-xs text-primary underline"
                      href={PROVIDER_DOCS_URL[aiProvider]}
                      target="_blank"
                      rel="noreferrer noopener"
                    >
                      <ExternalLink className="h-3 w-3" />
                      {t("settings.ai.getCredentials", {
                        provider: PROVIDER_LABELS[aiProvider],
                      })}
                    </a>
                  ) : null}
                </div>
              ) : null}
              {effectiveSection === "environment" ? (
                <div className="space-y-5">
                  <div className="space-y-2">
                    <h3 className="text-sm font-semibold">
                      {t("settings.env.tokenTitle")}
                    </h3>
                    <p className="text-xs text-muted-foreground">
                      <Trans
                        i18nKey="settings.env.tokenDescription"
                        components={{
                          tokenLink: (
                            <a
                              className="underline"
                              href="https://share.geolibre.app/settings"
                              target="_blank"
                              rel="noreferrer noopener"
                            />
                          ),
                        }}
                      />
                    </p>
                    <Input
                      ref={shareTokenInputRef}
                      aria-label={t("settings.env.tokenTitle")}
                      type="password"
                      autoComplete="new-password"
                      placeholder={t("settings.env.tokenPlaceholder")}
                      value={draftDesktopSettings.shareToken}
                      onChange={(event) => updateShareToken(event.target.value)}
                    />
                    <p className="text-xs text-muted-foreground">
                      {t("settings.env.tokenStorageNote")}
                    </p>
                  </div>
                  <div className="flex items-center justify-between gap-3 border-t pt-5">
                    <div>
                      <h3 className="text-sm font-semibold">
                        {t("settings.env.variablesTitle")}
                      </h3>
                      <p className="text-xs text-muted-foreground">
                        {t("settings.env.variablesCount", {
                          count: enabledVariableCount,
                        })}
                      </p>
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={addEnvironmentVariable}
                    >
                      <Plus className="h-3.5 w-3.5" />
                      {t("common.add")}
                    </Button>
                  </div>
                  <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300">
                    <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>{t("settings.env.secretsWarning")}</span>
                  </div>
                  {draftPreferences.environmentVariables.length === 0 ? (
                    <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
                      {t("settings.env.empty")}
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {draftPreferences.environmentVariables.map(
                        (variable, index) => {
                          const variableName =
                            variable.key ||
                            t("settings.env.variableFallback");
                          return (
                          <div
                            key={variable.id}
                            className="grid grid-cols-[1.25rem_minmax(7rem,1fr)_minmax(7rem,1fr)_2rem_2rem] items-center gap-2"
                          >
                            <input
                              aria-label={t("settings.env.enableAria", {
                                name: variableName,
                              })}
                              className="h-4 w-4"
                              type="checkbox"
                              checked={variable.enabled}
                              onChange={(event) =>
                                updateEnvironmentVariable(index, {
                                  enabled: event.target.checked,
                                })
                              }
                            />
                            <Input
                              aria-label={t("settings.env.nameAria")}
                              placeholder={t("settings.env.namePlaceholder")}
                              value={variable.key}
                              onChange={(event) =>
                                updateEnvironmentVariable(index, {
                                  key: event.target.value,
                                })
                              }
                            />
                            <Input
                              aria-label={t("settings.env.valueAria")}
                              placeholder={t("settings.env.valuePlaceholder")}
                              type={
                                revealedValueIds.has(variable.id)
                                  ? "text"
                                  : "password"
                              }
                              autoComplete="off"
                              value={variable.value}
                              onChange={(event) =>
                                updateEnvironmentVariable(index, {
                                  value: event.target.value,
                                })
                              }
                            />
                            <Button
                              aria-label={
                                revealedValueIds.has(variable.id)
                                  ? t("settings.env.hideValueAria", {
                                      name: variableName,
                                    })
                                  : t("settings.env.showValueAria", {
                                      name: variableName,
                                    })
                              }
                              className="h-8 w-8"
                              type="button"
                              size="icon"
                              variant="ghost"
                              onClick={() => toggleValueVisibility(variable.id)}
                            >
                              {revealedValueIds.has(variable.id) ? (
                                <EyeOff className="h-3.5 w-3.5" />
                              ) : (
                                <Eye className="h-3.5 w-3.5" />
                              )}
                            </Button>
                            <Button
                              aria-label={t("settings.env.removeAria", {
                                name: variableName,
                              })}
                              className="h-8 w-8"
                              type="button"
                              size="icon"
                              variant="ghost"
                              onClick={() => removeEnvironmentVariable(index)}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                          );
                        },
                      )}
                    </div>
                  )}
                </div>
              ) : null}
              {effectiveSection === "updates" ? (
                <div className="space-y-5">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <h3 className="text-sm font-semibold">
                        {t("settings.updates.title")}
                      </h3>
                      <p className="text-xs text-muted-foreground">
                        {t("settings.updates.description")}
                      </p>
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={resetUpdateSettings}
                    >
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
                      <span className="block">
                        {t("settings.updates.checkOnStartup")}
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        {t("settings.updates.checkOnStartupHint")}
                      </span>
                    </span>
                  </label>
                  <div className="space-y-1.5">
                    <Label htmlFor="settings-update-level">
                      {t("settings.updates.notificationLevel")}
                    </Label>
                    <Select
                      id="settings-update-level"
                      value={draftDesktopSettings.updates.notificationLevel}
                      disabled={
                        !draftDesktopSettings.updates.checkOnStartup
                      }
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
              ) : null}
            </div>
          </div>
          {error ? (
            <div className="border-t px-6 py-2 text-sm text-destructive">
              {error}
            </div>
          ) : null}
          <div className="flex justify-end gap-2 border-t px-6 py-4">
            <Button
              type="button"
              variant="outline"
              onClick={() => setOpen(false)}
            >
              {t("common.cancel")}
            </Button>
            <Button type="button" onClick={saveSettings}>
              {t("settings.saveButton")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

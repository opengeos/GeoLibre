import {
  DEFAULT_PROJECT_PREFERENCES,
  PROJECT_VERSION,
  useAppStore,
  type MapPreferences,
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
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  Input,
  Label,
} from "@geolibre/ui";
import type { MapController } from "@geolibre/map";
import {
  Braces,
  Crosshair,
  Eye,
  EyeOff,
  FolderCog,
  MapPinned,
  LayoutPanelTop,
  PanelLeft,
  PanelRight,
  Plus,
  RotateCcw,
  Settings,
  TableProperties,
  Type,
  Trash2,
  TriangleAlert,
  Puzzle,
} from "lucide-react";
import { useEffect, useMemo, useState, type RefObject } from "react";
import {
  DEFAULT_DESKTOP_LAYOUT_SETTINGS,
  useDesktopSettingsStore,
  type DesktopSettings,
  type DesktopLayoutSettings,
} from "../../hooks/useDesktopSettings";

type SettingsSection = "map" | "layout" | "environment" | "project";

interface SettingsDialogProps {
  buttonClassName?: string;
  buttonSize?: "default" | "sm" | "lg" | "icon" | null;
  iconClassName?: string;
  mapControllerRef: RefObject<MapController | null>;
  showLabels?: boolean;
  onOpenManagePlugins: () => void;
}

const SECTION_ITEMS: Array<{
  id: SettingsSection;
  label: string;
  icon: typeof MapPinned;
}> = [
  { id: "map", label: "Map", icon: MapPinned },
  { id: "layout", label: "Layout", icon: LayoutPanelTop },
  { id: "environment", label: "Environment", icon: Braces },
  { id: "project", label: "Project", icon: FolderCog },
];

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
}

interface DraftDesktopSettings {
  layout: DesktopLayoutSettings;
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
  };
}

function cloneDesktopSettings(settings: DesktopSettings): DraftDesktopSettings {
  return {
    layout: { ...settings.layout },
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
  };
}

function validateEnvironmentVariables(
  variables: RuntimeEnvironmentVariable[],
): string | null {
  const keys = new Set<string>();

  for (const variable of variables) {
    if (!variable.key.trim()) continue;
    if (!VARIABLE_NAME_PATTERN.test(variable.key.trim())) {
      return "Environment variable names must start with a letter or underscore and contain only letters, numbers, and underscores.";
    }
    if (keys.has(variable.key.trim())) {
      return `Environment variable "${variable.key.trim()}" is duplicated.`;
    }
    keys.add(variable.key.trim());
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
}: SettingsDialogProps) {
  const preferences = useAppStore((s) => s.preferences);
  const setPreferences = useAppStore((s) => s.setPreferences);
  const desktopSettings = useDesktopSettingsStore((s) => s.desktopSettings);
  const setDesktopSettings = useDesktopSettingsStore(
    (s) => s.setDesktopSettings,
  );
  const projectName = useAppStore((s) => s.projectName);
  const projectPath = useAppStore((s) => s.projectPath);
  const setProjectName = useAppStore((s) => s.setProjectName);
  const [open, setOpen] = useState(false);
  const [section, setSection] = useState<SettingsSection>("map");
  const [draftPreferences, setDraftPreferences] = useState<DraftPreferences>(
    () => clonePreferences(preferences),
  );
  const [draftDesktopSettings, setDraftDesktopSettings] =
    useState<DraftDesktopSettings>(() => cloneDesktopSettings(desktopSettings));
  const [draftProjectName, setDraftProjectName] = useState(projectName);
  const [error, setError] = useState<string | null>(null);
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

  // Seed the draft from the store only when the dialog opens. Depending on
  // preferences/projectName would reset in-progress edits if the store changed
  // while the dialog is open (e.g. a slow ?url= project finishes loading).
  useEffect(() => {
    if (!open) return;
    setDraftPreferences(clonePreferences(useAppStore.getState().preferences));
    setDraftDesktopSettings(
      cloneDesktopSettings(useDesktopSettingsStore.getState().desktopSettings),
    );
    setDraftProjectName(useAppStore.getState().projectName);
    setRevealedValueIds(new Set());
    setError(null);
  }, [open]);

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
      setError("The map bounds are not available yet.");
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

  const updateShareToken = (value: string) => {
    // Persist live, like the layout toggles: saveSettings re-reads the latest
    // store state, so an in-progress edit here is never clobbered on Save.
    const current = useDesktopSettingsStore.getState().desktopSettings;
    setDesktopSettings({ ...current, shareToken: value });
  };

  const saveSettings = () => {
    const normalized = normalizePreferences(draftPreferences);
    const validationError = validateEnvironmentVariables(
      normalized.environmentVariables,
    );
    if (validationError) {
      setError(validationError);
      setSection("environment");
      return;
    }

    const nextProjectName = draftProjectName.trim() || "Untitled Project";
    if (nextProjectName !== projectName) setProjectName(nextProjectName);
    setPreferences(normalized);
    // Plugin sources are managed live in the Manage Plugins dialog; preserve the
    // current store values and only update the layout from this dialog.
    setDesktopSettings({
      ...useDesktopSettingsStore.getState().desktopSettings,
      layout: draftDesktopSettings.layout,
    });
    setOpen(false);
  };

  const renderSectionButton = (item: (typeof SECTION_ITEMS)[number]) => {
    const Icon = item.icon;
    return (
      <Button
        key={item.id}
        className="justify-start"
        size="sm"
        type="button"
        variant={section === item.id ? "secondary" : "ghost"}
        onClick={() => {
          setSection(item.id);
          setError(null);
        }}
      >
        <Icon className="h-4 w-4" />
        {item.label}
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
            aria-label="Settings"
          >
            <Settings className={iconClassName} />
            {showLabels ? (
              <span className="hidden sm:inline">Settings</span>
            ) : null}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56">
          <DropdownMenuLabel>Settings</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={() => {
              setSection("map");
              setOpen(true);
            }}
          >
            <MapPinned className="mr-2 h-3.5 w-3.5" />
            Map Preferences
          </DropdownMenuItem>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <LayoutPanelTop className="mr-2 h-3.5 w-3.5" />
              Layout
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="geolibre-layout-submenu w-40 sm:w-72">
              <DropdownMenuCheckboxItem
                checked={desktopSettings.layout.toolbarLabels}
                onCheckedChange={(checked) =>
                  updateSavedLayoutSettings({ toolbarLabels: checked === true })
                }
                onSelect={(event) => event.preventDefault()}
              >
                Show toolbar labels
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem
                checked={desktopSettings.layout.showProjectInfo}
                onCheckedChange={(checked) =>
                  updateSavedLayoutSettings({
                    showProjectInfo: checked === true,
                  })
                }
                onSelect={(event) => event.preventDefault()}
              >
                Show project info
              </DropdownMenuCheckboxItem>
              <DropdownMenuSeparator />
              <DropdownMenuCheckboxItem
                checked={desktopSettings.layout.layerPanelVisible}
                onCheckedChange={(checked) =>
                  updateSavedLayoutSettings({
                    layerPanelVisible: checked === true,
                  })
                }
                onSelect={(event) => event.preventDefault()}
              >
                Show Layers panel
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem
                checked={desktopSettings.layout.stylePanelVisible}
                onCheckedChange={(checked) =>
                  updateSavedLayoutSettings({
                    stylePanelVisible: checked === true,
                  })
                }
                onSelect={(event) => event.preventDefault()}
              >
                Show Style panel
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem
                checked={desktopSettings.layout.attributePanelVisible}
                onCheckedChange={(checked) =>
                  updateSavedLayoutSettings({
                    attributePanelVisible: checked === true,
                  })
                }
                onSelect={(event) => event.preventDefault()}
              >
                Show Attribute panel
              </DropdownMenuCheckboxItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={() => {
                  setSection("layout");
                  setOpen(true);
                }}
              >
                Layout Settings
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="px-2 py-1 text-xs font-normal text-muted-foreground">
                URL layout parameters override saved settings.
              </DropdownMenuLabel>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuItem
            onSelect={() => {
              setSection("environment");
              setOpen(true);
            }}
          >
            <Braces className="mr-2 h-3.5 w-3.5" />
            Environment Variables
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => {
              setSection("project");
              setOpen(true);
            }}
          >
            <FolderCog className="mr-2 h-3.5 w-3.5" />
            Project Settings
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onOpenManagePlugins()}>
            <Puzzle className="mr-2 h-3.5 w-3.5" />
            Manage Plugins
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          className="max-h-[min(88vh,760px)] max-w-3xl"
          bodyClassName="overflow-hidden p-0"
        >
          <DialogHeader className="border-b px-6 pb-4 pt-6">
            <DialogTitle>Settings</DialogTitle>
            <DialogDescription>
              Configure project preferences and runtime settings.
            </DialogDescription>
          </DialogHeader>
          <div className="grid min-h-0 grid-cols-1 md:grid-cols-[12rem_1fr]">
            <nav className="flex gap-1 border-b p-3 md:flex-col md:border-b-0 md:border-r">
              {SECTION_ITEMS.map(renderSectionButton)}
            </nav>
            <div className="min-h-0 overflow-y-auto p-6">
              {section === "map" ? (
                <div className="space-y-5">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <h3 className="text-sm font-semibold">Map constraints</h3>
                      <p className="text-xs text-muted-foreground">
                        Limits apply while the project is open.
                      </p>
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={resetMapPreferences}
                    >
                      <RotateCcw className="h-3.5 w-3.5" />
                      Reset
                    </Button>
                  </div>
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
                    Restrict map bounds
                  </label>
                  <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                    {[
                      ["West", 0, -180, 180],
                      ["South", 1, -85, 85],
                      ["East", 2, -180, 180],
                      ["North", 3, -85, 85],
                    ].map(([label, index, min, max]) => (
                      <div key={label} className="space-y-1.5">
                        <Label htmlFor={`settings-bounds-${index}`}>
                          {label}
                        </Label>
                        <Input
                          id={`settings-bounds-${index}`}
                          type="number"
                          min={min}
                          max={max}
                          step="0.000001"
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
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={applyCurrentViewBounds}
                  >
                    <Crosshair className="h-3.5 w-3.5" />
                    Use Current View
                  </Button>
                  <div className="grid gap-3 sm:grid-cols-3">
                    <div className="space-y-1.5">
                      <Label htmlFor="settings-min-zoom">Min zoom</Label>
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
                      <Label htmlFor="settings-max-zoom">Max zoom</Label>
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
                      <Label htmlFor="settings-max-pitch">Max pitch</Label>
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
                    Render world copies
                  </label>
                </div>
              ) : null}
              {section === "layout" ? (
                <div className="space-y-5">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <h3 className="text-sm font-semibold">Layout</h3>
                      <p className="text-xs text-muted-foreground">
                        Workspace visibility and toolbar presentation.
                      </p>
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={resetLayoutSettings}
                    >
                      <RotateCcw className="h-3.5 w-3.5" />
                      Reset
                    </Button>
                  </div>
                  <div className="space-y-3">
                    <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      Toolbar
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
                      <span>Show toolbar labels</span>
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
                      <span>Show project info in the toolbar</span>
                    </label>
                  </div>
                  <div className="space-y-3">
                    <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      Panels
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
                      <span>Show Layers panel</span>
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
                      <span>Show Style panel</span>
                    </label>
                    <label className="flex items-center gap-3 rounded-md border p-3 text-sm">
                      <input
                        className="h-4 w-4"
                        type="checkbox"
                        checked={
                          draftDesktopSettings.layout.attributePanelVisible
                        }
                        onChange={(event) =>
                          updateDraftLayoutSettings({
                            attributePanelVisible: event.target.checked,
                          })
                        }
                      />
                      <TableProperties className="h-4 w-4 text-muted-foreground" />
                      <span>Show Attribute panel</span>
                    </label>
                  </div>
                  <div className="rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
                    URL layout parameters still apply when present in shared
                    viewer links.
                  </div>
                </div>
              ) : null}
              {section === "environment" ? (
                <div className="space-y-5">
                  <div className="space-y-2">
                    <h3 className="text-sm font-semibold">
                      Share.GeoLibre API token
                    </h3>
                    <p className="text-xs text-muted-foreground">
                      Used by Project &gt; Share to upload projects to
                      share.geolibre.app. Create one under Settings &gt; API
                      tokens at{" "}
                      <a
                        className="underline"
                        href="https://share.geolibre.app/settings"
                        target="_blank"
                        rel="noreferrer noopener"
                      >
                        share.geolibre.app/settings
                      </a>
                      .
                    </p>
                    <Input
                      aria-label="Share.GeoLibre API token"
                      type="password"
                      autoComplete="off"
                      placeholder="glb_…"
                      value={desktopSettings.shareToken}
                      onChange={(event) => updateShareToken(event.target.value)}
                    />
                  </div>
                  <div className="flex items-center justify-between gap-3 border-t pt-5">
                    <div>
                      <h3 className="text-sm font-semibold">
                        Environment variables
                      </h3>
                      <p className="text-xs text-muted-foreground">
                        {enabledVariableCount} enabled runtime variable
                        {enabledVariableCount === 1 ? "" : "s"}.
                      </p>
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={addEnvironmentVariable}
                    >
                      <Plus className="h-3.5 w-3.5" />
                      Add
                    </Button>
                  </div>
                  <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300">
                    <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>
                      Values are stored in plain text in the project file and
                      may be exposed when the project is shared. Avoid putting
                      secrets here unless the project file stays private.
                    </span>
                  </div>
                  {draftPreferences.environmentVariables.length === 0 ? (
                    <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
                      No environment variables configured.
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {draftPreferences.environmentVariables.map(
                        (variable, index) => (
                          <div
                            key={variable.id}
                            className="grid grid-cols-[1.25rem_minmax(7rem,1fr)_minmax(7rem,1fr)_2rem_2rem] items-center gap-2"
                          >
                            <input
                              aria-label={`Enable ${variable.key || "variable"}`}
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
                              aria-label="Variable name"
                              placeholder="VITE_EXAMPLE_KEY"
                              value={variable.key}
                              onChange={(event) =>
                                updateEnvironmentVariable(index, {
                                  key: event.target.value,
                                })
                              }
                            />
                            <Input
                              aria-label="Variable value"
                              placeholder="Value"
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
                                  ? `Hide value for ${variable.key || "variable"}`
                                  : `Show value for ${variable.key || "variable"}`
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
                              aria-label={`Remove ${variable.key || "variable"}`}
                              className="h-8 w-8"
                              type="button"
                              size="icon"
                              variant="ghost"
                              onClick={() => removeEnvironmentVariable(index)}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        ),
                      )}
                    </div>
                  )}
                </div>
              ) : null}
              {section === "project" ? (
                <div className="space-y-5">
                  <div>
                    <h3 className="text-sm font-semibold">Project</h3>
                    <p className="text-xs text-muted-foreground">
                      Settings are saved with the `.geolibre.json` project.
                    </p>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="settings-project-name">Name</Label>
                    <Input
                      id="settings-project-name"
                      value={draftProjectName}
                      onChange={(event) =>
                        setDraftProjectName(event.target.value)
                      }
                    />
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label>Project file</Label>
                      <div className="min-h-9 truncate rounded-md border bg-muted px-3 py-2 text-sm text-muted-foreground">
                        {projectPath ?? "Not saved"}
                      </div>
                    </div>
                    <div className="space-y-1.5">
                      <Label>Project format</Label>
                      <div className="min-h-9 rounded-md border bg-muted px-3 py-2 text-sm text-muted-foreground">
                        {PROJECT_VERSION}
                      </div>
                    </div>
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
              Cancel
            </Button>
            <Button type="button" onClick={saveSettings}>
              Save Settings
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

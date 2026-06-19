import {
  DEFAULT_BASEMAP,
  DEFAULT_LAYER_STYLE,
  DEFAULT_LEGEND_CONFIG,
  DEFAULT_PROJECT_PREFERENCES,
  DEFAULT_DASHBOARD_COLUMNS,
  DEFAULT_STORY_MAP,
  MAX_DASHBOARD_COLUMNS,
  MIN_DASHBOARD_COLUMNS,
  PROJECT_VERSION,
  type DashboardWidget,
  type DashboardWidgetAggregation,
  type DashboardWidgetType,
  type GeoLibreLayer,
  type GeoLibreProject,
  type LayerGroup,
  type LayerStyle,
  type LegendConfig,
  type LegendItemOverride,
  type MapViewState,
  type ProcessingModel,
  type ProcessingModelStep,
  type ProjectPluginControlPosition,
  type ProjectPluginState,
  type ProjectPreferences,
  type RuntimeEnvironmentVariable,
  type StoryChapter,
  type StoryChapterAlignment,
  type StoryChapterAnimation,
  type StoryInsetPosition,
  type StoryLayerOpacityChange,
  type StoryMap,
} from "./types";
import {
  DEFAULT_LAYER_GROUP_OPACITY,
  normalizeGroupContiguity,
} from "./layer-groups";

/** Placeholder name a project carries before the user names it. */
export const DEFAULT_PROJECT_NAME = "Untitled Project";

export interface CreateProjectOptions {
  basemapStyleUrl?: string;
  mapView?: MapViewState;
}

export function createDefaultMapView(): MapViewState {
  return {
    center: [-100, 40],
    zoom: 2,
    bearing: 0,
    pitch: 0,
  };
}

export function createEmptyProject(
  name = DEFAULT_PROJECT_NAME,
  options: CreateProjectOptions = {},
): GeoLibreProject {
  return {
    version: PROJECT_VERSION,
    name,
    mapView: options.mapView ?? createDefaultMapView(),
    basemapStyleUrl: options.basemapStyleUrl ?? DEFAULT_BASEMAP,
    basemapVisible: true,
    basemapOpacity: 1,
    layers: [],
    layerGroups: [],
    styles: {},
    preferences: DEFAULT_PROJECT_PREFERENCES,
    legend: { ...DEFAULT_LEGEND_CONFIG },
    metadata: {},
  };
}

export function serializeProject(project: GeoLibreProject): string {
  return JSON.stringify(project, null, 2);
}

export function parseProject(json: string): GeoLibreProject {
  const data = JSON.parse(json) as Partial<GeoLibreProject>;
  if (!data.version || !data.name || !data.mapView) {
    throw new Error("Invalid GeoLibre project: missing required fields");
  }
  const layerGroups = normalizeLayerGroups(data.layerGroups);
  const validGroupIds = new Set(layerGroups.map((g) => g.id));
  const layers = (data.layers ?? [])
    .map(normalizeLayer)
    .map((layer) =>
      layer.groupId && !validGroupIds.has(layer.groupId)
        ? { ...layer, groupId: undefined }
        : layer,
    );
  return {
    version: data.version,
    name: data.name,
    mapView: data.mapView,
    basemapStyleUrl: data.basemapStyleUrl ?? DEFAULT_BASEMAP,
    basemapVisible: data.basemapVisible ?? true,
    basemapOpacity: data.basemapOpacity ?? 1,
    layers,
    ...(layerGroups.length > 0 ? { layerGroups } : {}),
    styles: data.styles ?? {},
    preferences: normalizeProjectPreferences(data.preferences),
    plugins: normalizeProjectPlugins(data.plugins) ?? undefined,
    legend: normalizeLegendConfig(data.legend),
    storymap: normalizeStoryMap(data.storymap) ?? undefined,
    models: normalizeModels(data.models) ?? undefined,
    widgets: normalizeWidgets(data.widgets) ?? undefined,
    ...(data.dashboardColumns === undefined
      ? {}
      : { dashboardColumns: normalizeDashboardColumns(data.dashboardColumns) }),
    metadata: data.metadata ?? {},
  };
}

/**
 * Coerce an untrusted (possibly hand-edited) `layerGroups` array into valid
 * {@link LayerGroup} records, dropping entries without a usable id and
 * de-duplicating by id. Always returns an array (empty when absent).
 *
 * @param value Raw `layerGroups` value from the project JSON.
 * @returns Normalized, de-duplicated group definitions.
 */
function normalizeLayerGroups(value: unknown): LayerGroup[] {
  if (!Array.isArray(value)) return [];
  const groups: LayerGroup[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const candidate = entry as Partial<LayerGroup>;
    const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const opacity =
      typeof candidate.opacity === "number" && Number.isFinite(candidate.opacity)
        ? Math.min(Math.max(candidate.opacity, 0), 1)
        : DEFAULT_LAYER_GROUP_OPACITY;
    groups.push({
      id,
      name: typeof candidate.name === "string" ? candidate.name : id,
      collapsed: candidate.collapsed === true,
      visible: candidate.visible !== false,
      opacity,
    });
  }
  return groups;
}

/**
 * Coerce an untrusted (possibly hand-edited) legend config into a valid
 * {@link LegendConfig}, dropping malformed entries. Returns undefined when no
 * usable config is present so the default is applied downstream.
 */
function normalizeLegendConfig(legend: unknown): LegendConfig | undefined {
  if (!legend || typeof legend !== "object") return undefined;
  const candidate = legend as Partial<LegendConfig>;

  const order = Array.isArray(candidate.order)
    ? uniqueStrings(candidate.order)
    : [];

  const overrides: Record<string, LegendItemOverride> = {};
  if (candidate.overrides && typeof candidate.overrides === "object") {
    for (const [key, value] of Object.entries(candidate.overrides)) {
      if (!key.trim() || !value || typeof value !== "object") continue;
      const override = value as Partial<LegendItemOverride>;
      const normalized: LegendItemOverride = {};
      // Mirror setLegendItemLabel / renderedLabel: a blank or whitespace-only
      // label is treated as "no override", so don't persist it.
      if (typeof override.label === "string" && override.label.trim() !== "") {
        normalized.label = override.label;
      }
      // Only the truthy hidden flag is meaningful; `hidden: false` is the
      // default, so dropping it keeps round-tripped projects from accumulating
      // no-op overrides (matches what the UI mutations store).
      if (override.hidden === true) normalized.hidden = true;
      if (normalized.label !== undefined || normalized.hidden !== undefined) {
        overrides[key.trim()] = normalized;
      }
    }
  }

  return {
    title:
      typeof candidate.title === "string"
        ? candidate.title
        : DEFAULT_LEGEND_CONFIG.title,
    groupByLayer: normalizeBoolean(
      candidate.groupByLayer,
      DEFAULT_LEGEND_CONFIG.groupByLayer,
    ),
    order,
    overrides,
  };
}

/**
 * Validate and coerce a story map loaded from an untrusted project file.
 *
 * Returns null when the value carries no chapters so empty story maps stay out
 * of the saved project, mirroring how plugins are only persisted when present.
 *
 * @param storymap Raw value read from the project JSON.
 * @returns A normalized story map, or null when there is nothing to keep.
 */
export function normalizeStoryMap(storymap: unknown): StoryMap | null {
  if (!storymap || typeof storymap !== "object") return null;

  const candidate = storymap as Partial<StoryMap>;
  // Drop duplicate chapter ids so updates/removals stay unambiguous and keyed
  // rendering stays stable.
  const seenChapterIds = new Set<string>();
  const chapters = Array.isArray(candidate.chapters)
    ? candidate.chapters
        .map(normalizeStoryChapter)
        .filter((chapter): chapter is StoryChapter => {
          if (!chapter || seenChapterIds.has(chapter.id)) return false;
          seenChapterIds.add(chapter.id);
          return true;
        })
    : [];

  const normalized: StoryMap = {
    title: normalizeString(candidate.title),
    subtitle: normalizeString(candidate.subtitle),
    byline: normalizeString(candidate.byline),
    footer: normalizeString(candidate.footer),
    theme: candidate.theme === "light" ? "light" : "dark",
    showMarkers: normalizeBoolean(candidate.showMarkers, false),
    markerColor:
      normalizeString(candidate.markerColor) || DEFAULT_STORY_MAP.markerColor,
    inset: normalizeBoolean(candidate.inset, false),
    insetPosition: STORY_INSET_POSITIONS.has(
      candidate.insetPosition as StoryInsetPosition,
    )
      ? (candidate.insetPosition as StoryInsetPosition)
      : DEFAULT_STORY_MAP.insetPosition,
    chapters,
  };

  // Keep the story if it has chapters or any author-entered settings; only a
  // wholly-default, chapter-less story is dropped (so blank stories stay out of
  // saved projects without discarding settings entered before the first chapter).
  return storyMapHasContent(normalized) ? normalized : null;
}

/** Whether a story map carries chapters or any non-default setting. */
function storyMapHasContent(story: StoryMap): boolean {
  if (story.chapters.length > 0) return true;
  return (
    story.title.trim() !== "" ||
    story.subtitle.trim() !== "" ||
    story.byline.trim() !== "" ||
    story.footer.trim() !== "" ||
    story.theme !== DEFAULT_STORY_MAP.theme ||
    story.showMarkers !== DEFAULT_STORY_MAP.showMarkers ||
    story.markerColor !== DEFAULT_STORY_MAP.markerColor ||
    story.inset !== DEFAULT_STORY_MAP.inset ||
    story.insetPosition !== DEFAULT_STORY_MAP.insetPosition
  );
}

const STORY_ALIGNMENTS = new Set<StoryChapterAlignment>([
  "left",
  "center",
  "right",
  "full",
]);

const STORY_ANIMATIONS = new Set<StoryChapterAnimation>([
  "flyTo",
  "easeTo",
  "jumpTo",
]);

const STORY_INSET_POSITIONS = new Set<StoryInsetPosition>([
  "top-left",
  "top-right",
  "bottom-left",
  "bottom-right",
]);

function normalizeStoryChapter(chapter: unknown): StoryChapter | null {
  if (!chapter || typeof chapter !== "object") return null;

  const candidate = chapter as Partial<StoryChapter>;
  const id = normalizeString(candidate.id);
  if (!id) return null;

  const location = candidate.location;
  const center = location?.center;
  if (
    !Array.isArray(center) ||
    center.length !== 2 ||
    !center.every((value) => Number.isFinite(value))
  ) {
    return null;
  }

  return {
    id,
    title: normalizeString(candidate.title),
    description: normalizeString(candidate.description),
    image: normalizeString(candidate.image) || undefined,
    alignment: STORY_ALIGNMENTS.has(candidate.alignment as StoryChapterAlignment)
      ? (candidate.alignment as StoryChapterAlignment)
      : "left",
    hidden: normalizeBoolean(candidate.hidden, false),
    location: {
      // Clamp to valid lng/lat so a hand-edited file can't make flyTo throw.
      center: [
        clampCoordinate(Number(center[0]), -180, 180),
        clampCoordinate(Number(center[1]), -90, 90),
      ],
      // Clamp to MapLibre's valid ranges so a stored value matches the camera
      // that actually lands (bearing wraps to 0-360).
      zoom: clamp(normalizeNumber(location?.zoom, 2), 0, 24),
      pitch: clamp(normalizeNumber(location?.pitch, 0), 0, 85),
      bearing: ((normalizeNumber(location?.bearing, 0) % 360) + 360) % 360,
    },
    mapAnimation: STORY_ANIMATIONS.has(
      candidate.mapAnimation as StoryChapterAnimation,
    )
      ? (candidate.mapAnimation as StoryChapterAnimation)
      : "flyTo",
    rotateAnimation: normalizeBoolean(candidate.rotateAnimation, false),
    onChapterEnter: normalizeOpacityChanges(candidate.onChapterEnter),
    onChapterExit: normalizeOpacityChanges(candidate.onChapterExit),
  };
}

function normalizeOpacityChanges(value: unknown): StoryLayerOpacityChange[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry): StoryLayerOpacityChange | null => {
      if (!entry || typeof entry !== "object") return null;
      const candidate = entry as Partial<StoryLayerOpacityChange>;
      const layerId = normalizeString(candidate.layerId);
      if (!layerId) return null;
      const id = normalizeString(candidate.id);
      return {
        ...(id ? { id } : {}),
        layerId,
        opacity: clamp(normalizeNumber(candidate.opacity, 1), 0, 1),
        ...(Number.isFinite(candidate.duration)
          ? { duration: Math.max(0, Number(candidate.duration)) }
          : {}),
      };
    })
    .filter((entry): entry is StoryLayerOpacityChange => Boolean(entry));
}

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Coerce an untrusted (possibly hand-edited) `models` array into valid
 * {@link ProcessingModel} records. Drops models and steps without a usable id or
 * tool id, de-duplicates models by id, and keeps step `parameters` as a plain
 * object (the runner validates parameter values per tool at run time). Returns
 * `null` when there is nothing worth persisting, so a model-less project stays
 * free of the key.
 *
 * @param value Raw `models` value from the project JSON.
 * @returns Normalized models, or `null` when none survive.
 */
export function normalizeModels(value: unknown): ProcessingModel[] | null {
  if (!Array.isArray(value)) return null;
  const models: ProcessingModel[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const candidate = entry as Partial<ProcessingModel>;
    const id = normalizeString(candidate.id).trim();
    if (!id || seen.has(id)) continue;
    const steps: ProcessingModelStep[] = [];
    const rawSteps = Array.isArray(candidate.steps) ? candidate.steps : [];
    const seenStepIds = new Set<string>();
    for (const rawStep of rawSteps) {
      if (!rawStep || typeof rawStep !== "object") continue;
      const step = rawStep as Partial<ProcessingModelStep>;
      const stepId = normalizeString(step.id).trim();
      const toolId = normalizeString(step.toolId).trim();
      if (!stepId || !toolId || seenStepIds.has(stepId)) continue;
      seenStepIds.add(stepId);
      const inputParam = normalizeString(step.inputParam).trim();
      steps.push({
        id: stepId,
        toolId,
        parameters:
          step.parameters && typeof step.parameters === "object"
            ? (step.parameters as Record<string, unknown>)
            : {},
        ...(inputParam ? { inputParam } : {}),
      });
    }
    seen.add(id);
    models.push({ id, name: normalizeString(candidate.name), steps });
  }
  return models.length > 0 ? models : null;
}

/** A 3- or 6-digit hex color, the only widget color format we persist. */
const HEX_COLOR = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/** Upper bound for a persisted histogram bin count, mirroring the chart
 * renderer's clamp (`MAX_HISTOGRAM_BINS` in the desktop app's chart helpers). */
const MAX_PERSISTED_BINS = 50;

const DASHBOARD_WIDGET_TYPES: readonly DashboardWidgetType[] = [
  "histogram",
  "scatter",
  "bar",
  "line",
  "box",
  "pie",
];
const DASHBOARD_WIDGET_AGGREGATIONS: readonly DashboardWidgetAggregation[] = [
  "count",
  "sum",
  "mean",
];

/**
 * Coerce an untrusted (possibly hand-edited) `widgets` array into valid
 * {@link DashboardWidget} records. Drops widgets without a usable id, layer id,
 * or recognized chart type, de-duplicates by id, and keeps only the optional
 * keys that are present and well-typed (the Dashboard panel falls back to
 * sensible defaults for anything missing). Returns `null` when there is nothing
 * worth persisting, so a widget-less project stays free of the key.
 *
 * @param value Raw `widgets` value from the project JSON.
 * @returns Normalized widgets, or `null` when none survive.
 */
export function normalizeWidgets(value: unknown): DashboardWidget[] | null {
  if (!Array.isArray(value)) return null;
  const widgets: DashboardWidget[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const candidate = entry as Partial<DashboardWidget>;
    const id = normalizeString(candidate.id).trim();
    const layerId = normalizeString(candidate.layerId).trim();
    if (!id || !layerId || seen.has(id)) continue;
    const type = candidate.type;
    if (!type || !DASHBOARD_WIDGET_TYPES.includes(type)) continue;
    seen.add(id);
    const widget: DashboardWidget = { id, layerId, type };
    const title = normalizeString(candidate.title).trim();
    if (title) widget.title = title;
    const color = normalizeString(candidate.color).trim();
    if (HEX_COLOR.test(color)) widget.color = color;
    const field = normalizeString(candidate.field).trim();
    if (field) widget.field = field;
    const xField = normalizeString(candidate.xField).trim();
    if (xField) widget.xField = xField;
    const yField = normalizeString(candidate.yField).trim();
    if (yField) widget.yField = yField;
    if (typeof candidate.bins === "number" && Number.isFinite(candidate.bins)) {
      // Persist only a sane positive bin count; the histogram renderer clamps to
      // [1, 50], so mirror that here rather than round-tripping 0 or huge values.
      const bins = Math.trunc(candidate.bins);
      if (bins >= 1) widget.bins = Math.min(MAX_PERSISTED_BINS, bins);
    }
    const category = normalizeString(candidate.category).trim();
    if (category) widget.category = category;
    if (
      candidate.aggregation &&
      DASHBOARD_WIDGET_AGGREGATIONS.includes(candidate.aggregation) &&
      // A pie has no "average"; the renderer would silently treat mean as sum,
      // so drop it here and let the default (count) stand for hand-edited files.
      !(type === "pie" && candidate.aggregation === "mean")
    ) {
      widget.aggregation = candidate.aggregation;
    }
    const valueField = normalizeString(candidate.valueField).trim();
    if (valueField) widget.valueField = valueField;
    widgets.push(widget);
  }
  return widgets.length > 0 ? widgets : null;
}

/**
 * Clamp an untrusted dashboard column count into the supported range, falling
 * back to the default for a missing or non-finite value.
 *
 * @param value Raw `dashboardColumns` value from the project JSON.
 * @returns An integer column count within [MIN, MAX].
 */
export function normalizeDashboardColumns(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_DASHBOARD_COLUMNS;
  }
  return Math.max(
    MIN_DASHBOARD_COLUMNS,
    Math.min(MAX_DASHBOARD_COLUMNS, Math.trunc(value)),
  );
}

function normalizeProjectPreferences(preferences: unknown): ProjectPreferences {
  if (!preferences || typeof preferences !== "object") {
    return DEFAULT_PROJECT_PREFERENCES;
  }

  const candidate = preferences as Partial<ProjectPreferences>;
  const map = candidate.map ?? {};
  // Every MapPreferences field is normalized explicitly below, so the map
  // object is not spread in: that would forward unknown keys from a
  // hand-edited project file straight into app state.
  return {
    map: {
      ...DEFAULT_PROJECT_PREFERENCES.map,
      bounds: normalizeBounds(
        (map as Partial<ProjectPreferences["map"]>).bounds,
      ),
      minZoom: normalizeNumber(
        (map as Partial<ProjectPreferences["map"]>).minZoom,
        DEFAULT_PROJECT_PREFERENCES.map.minZoom,
      ),
      maxZoom: normalizeNumber(
        (map as Partial<ProjectPreferences["map"]>).maxZoom,
        DEFAULT_PROJECT_PREFERENCES.map.maxZoom,
      ),
      maxPitch: normalizeNumber(
        (map as Partial<ProjectPreferences["map"]>).maxPitch,
        DEFAULT_PROJECT_PREFERENCES.map.maxPitch,
      ),
      restrictBounds: Boolean(
        (map as Partial<ProjectPreferences["map"]>).restrictBounds,
      ),
      renderWorldCopies: normalizeBoolean(
        (map as Partial<ProjectPreferences["map"]>).renderWorldCopies,
        true,
      ),
      projection:
        (map as Partial<ProjectPreferences["map"]>).projection === "mercator"
          ? "mercator"
          : "globe",
    },
    environmentVariables: Array.isArray(candidate.environmentVariables)
      ? candidate.environmentVariables
          .map(normalizeEnvironmentVariable)
          .filter((variable): variable is RuntimeEnvironmentVariable =>
            Boolean(variable),
          )
      : [],
    geocoding: normalizeGeocodingPreferences(candidate.geocoding),
  };
}

function normalizeGeocodingPreferences(
  geocoding: unknown,
): ProjectPreferences["geocoding"] {
  if (!geocoding || typeof geocoding !== "object") {
    return { ...DEFAULT_PROJECT_PREFERENCES.geocoding, apiKeys: {} };
  }
  const candidate = geocoding as Partial<ProjectPreferences["geocoding"]>;
  const apiKeys: Record<string, string> = {};
  if (candidate.apiKeys && typeof candidate.apiKeys === "object") {
    for (const [key, value] of Object.entries(candidate.apiKeys)) {
      const normalizedKey = key.trim();
      if (normalizedKey && typeof value === "string") {
        apiKeys[normalizedKey] = value;
      }
    }
  }
  return {
    providerId:
      typeof candidate.providerId === "string" && candidate.providerId.trim()
        ? candidate.providerId.trim()
        : DEFAULT_PROJECT_PREFERENCES.geocoding.providerId,
    apiKeys,
    forwardEndpoint:
      typeof candidate.forwardEndpoint === "string" &&
      candidate.forwardEndpoint.trim()
        ? candidate.forwardEndpoint.trim()
        : undefined,
    reverseEndpoint:
      typeof candidate.reverseEndpoint === "string" &&
      candidate.reverseEndpoint.trim()
        ? candidate.reverseEndpoint.trim()
        : undefined,
    email:
      typeof candidate.email === "string" && candidate.email.trim()
        ? candidate.email.trim()
        : undefined,
  };
}

function normalizeBounds(bounds: unknown): ProjectPreferences["map"]["bounds"] {
  if (
    Array.isArray(bounds) &&
    bounds.length === 4 &&
    bounds.every((value) => Number.isFinite(value))
  ) {
    // Clamp to valid lng/lat ranges so the stored bounds match what the map
    // controller applies, then keep the ordering check so an empty or
    // inverted region falls back to the default instead of being persisted.
    const west = clampCoordinate(Number(bounds[0]), -180, 180);
    const south = clampCoordinate(Number(bounds[1]), -85, 85);
    const east = clampCoordinate(Number(bounds[2]), -180, 180);
    const north = clampCoordinate(Number(bounds[3]), -85, 85);
    if (west < east && south < north) {
      return [west, south, east, north];
    }
  }

  return DEFAULT_PROJECT_PREFERENCES.map.bounds;
}

function normalizeNumber(value: unknown, fallback: number): number {
  return Number.isFinite(value) ? Number(value) : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clampCoordinate(value: number, min: number, max: number): number {
  return clamp(value, min, max);
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

const ENVIRONMENT_VARIABLE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

function normalizeEnvironmentVariable(
  variable: unknown,
): RuntimeEnvironmentVariable | null {
  if (!variable || typeof variable !== "object") return null;
  const candidate = variable as Partial<RuntimeEnvironmentVariable>;
  const key = typeof candidate.key === "string" ? candidate.key.trim() : "";
  if (!key || !ENVIRONMENT_VARIABLE_NAME_PATTERN.test(key)) return null;

  return {
    key,
    value: typeof candidate.value === "string" ? candidate.value : "",
    enabled: normalizeBoolean(candidate.enabled, true),
  };
}

const PROJECT_PLUGIN_CONTROL_POSITIONS = new Set<ProjectPluginControlPosition>([
  "top-left",
  "top-right",
  "bottom-left",
  "bottom-right",
]);

function normalizeProjectPlugins(plugins: unknown): ProjectPluginState | null {
  if (!plugins || typeof plugins !== "object") return null;

  const candidate = plugins as Partial<ProjectPluginState>;
  const manifestUrls = Array.isArray(candidate.manifestUrls)
    ? uniqueStrings(candidate.manifestUrls).filter(isAllowedPluginManifestUrl)
    : [];
  const activePluginIds = Array.isArray(candidate.activePluginIds)
    ? uniqueStrings(candidate.activePluginIds)
    : [];
  const mapControlPositions: Record<string, ProjectPluginControlPosition> = {};
  const settings: Record<string, unknown> = {};

  if (
    candidate.mapControlPositions &&
    typeof candidate.mapControlPositions === "object"
  ) {
    for (const [pluginId, position] of Object.entries(
      candidate.mapControlPositions,
    )) {
      if (
        typeof pluginId === "string" &&
        pluginId.trim() &&
        PROJECT_PLUGIN_CONTROL_POSITIONS.has(
          position as ProjectPluginControlPosition,
        )
      ) {
        mapControlPositions[pluginId.trim()] =
          position as ProjectPluginControlPosition;
      }
    }
  }

  if (candidate.settings && typeof candidate.settings === "object") {
    for (const [pluginId, value] of Object.entries(candidate.settings)) {
      if (
        typeof pluginId === "string" &&
        pluginId.trim() &&
        isJsonCompatible(value)
      ) {
        settings[pluginId.trim()] = value;
      }
    }
  }

  return {
    manifestUrls,
    activePluginIds,
    mapControlPositions,
    settings,
  };
}

// Plugin manifest URLs lead to fetched and executed code, so both the
// Settings dialog and project-file loading enforce the same scheme rule:
// HTTPS, or HTTP on a loopback host for local development.
export function isAllowedPluginManifestUrl(url: string): boolean {
  try {
    const { protocol, hostname } = new URL(url);
    return (
      protocol === "https:" ||
      (protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(hostname))
    );
  } catch {
    return false;
  }
}

function uniqueStrings(values: unknown[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const value of values) {
    if (typeof value !== "string") continue;
    const id = value.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    normalized.push(id);
  }

  return normalized;
}

function isJsonCompatible(value: unknown): boolean {
  if (value === null) return true;

  switch (typeof value) {
    case "string":
    case "boolean":
      return true;
    case "number":
      return Number.isFinite(value);
    case "object":
      if (Array.isArray(value)) return value.every(isJsonCompatible);
      if (!isPlainObject(value)) return false;
      return Object.values(value).every(isJsonCompatible);
    default:
      return false;
  }
}

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizeLayer(layer: GeoLibreLayer): GeoLibreLayer {
  return {
    ...layer,
    style: { ...DEFAULT_LAYER_STYLE, ...layer.style },
    visible: layer.visible ?? true,
    opacity: layer.opacity ?? 1,
    metadata: layer.metadata ?? {},
    source: layer.source ?? {},
  };
}

export function projectFromStore(state: {
  projectName: string;
  mapView: MapViewState;
  basemapStyleUrl: string;
  basemapVisible: boolean;
  basemapOpacity: number;
  layers: GeoLibreLayer[];
  layerGroups?: LayerGroup[];
  preferences: ProjectPreferences;
  plugins?: ProjectPluginState | null;
  legend?: LegendConfig | null;
  storymap?: StoryMap | null;
  models?: ProcessingModel[] | null;
  widgets?: DashboardWidget[] | null;
  dashboardColumns?: number;
  metadata: Record<string, unknown>;
}): GeoLibreProject {
  const styles: Record<string, LayerStyle> = {};
  for (const layer of state.layers) {
    styles[layer.id] = layer.style;
  }
  const plugins = normalizeProjectPlugins(state.plugins);
  const legend = normalizeLegendConfig(state.legend);
  const storymap = normalizeStoryMap(state.storymap);
  const models = normalizeModels(state.models);
  const widgets = normalizeWidgets(state.widgets);
  // Persist a non-default column count only; a default-layout dashboard (or a
  // widget-less project) stays free of the key for legacy readers.
  const dashboardColumns =
    state.dashboardColumns === undefined
      ? DEFAULT_DASHBOARD_COLUMNS
      : normalizeDashboardColumns(state.dashboardColumns);
  // Persist every group (including empty folders, which the UI supports). The
  // key is spread only when non-empty so legacy readers that don't recognise it
  // are unaffected; normalizeLayerGroups round-trips them back on load.
  const layerGroups = state.layerGroups ?? [];
  return {
    version: PROJECT_VERSION,
    name: state.projectName,
    mapView: state.mapView,
    basemapStyleUrl: state.basemapStyleUrl,
    basemapVisible: state.basemapVisible,
    basemapOpacity: state.basemapOpacity,
    layers: state.layers.map(prepareLayerForSave),
    ...(layerGroups.length > 0 ? { layerGroups } : {}),
    styles,
    preferences: state.preferences,
    ...(plugins ? { plugins } : {}),
    ...(legend ? { legend } : {}),
    ...(storymap ? { storymap } : {}),
    ...(models ? { models } : {}),
    ...(widgets ? { widgets } : {}),
    ...(dashboardColumns !== DEFAULT_DASHBOARD_COLUMNS ? { dashboardColumns } : {}),
    metadata: state.metadata,
  };
}

// An external native layer can drop its persisted `geojson` only if its
// features can be reconstructed on reopen, i.e. it has a fetchable source URL
// (the Add Vector Layer / WFS / geojson-url cases). Layers loaded from local
// files or built in-memory (e.g. by a plugin's drawing/annotation control)
// have no such URL, so the persisted `geojson` is their ONLY copy and must be
// kept.
function hasRestorableSourceUrl(layer: GeoLibreLayer): boolean {
  const sourceUrl = layer.source.url;
  const originalUrl = layer.metadata.originalUrl;
  return (
    (typeof sourceUrl === "string" && sourceUrl.trim() !== "") ||
    (typeof originalUrl === "string" && originalUrl.trim() !== "")
  );
}

function prepareLayerForSave(layer: GeoLibreLayer): GeoLibreLayer {
  // The live time filter is derived from the Time Slider's current date, so it
  // is transient: strip it before saving so a reopened project never starts
  // with a stale time-window filter hiding most of a layer's features. The
  // binding config in `metadata.timeBinding` persists, and the Time Slider
  // re-applies the filter the next time it activates.
  if (layer.timeFilter !== undefined) {
    const { timeFilter: _timeFilter, ...rest } = layer;
    layer = rest;
  }

  // External native layers that restore their features from a source URL keep
  // a `geojson` copy on the map only for the attribute table; it is redundant
  // in a saved project and would only bloat it, so strip it. Layers without a
  // restorable URL (local-file or in-memory) keep their `geojson` because it is
  // the sole copy GeoLibre's restore path (`ensureExternalGeoJsonNativeLayer`)
  // re-renders from.
  if (
    layer.metadata.externalNativeLayer === true &&
    layer.geojson &&
    hasRestorableSourceUrl(layer)
  ) {
    const { geojson: _geojson, ...rest } = layer;
    layer = rest;
  }

  if (layer.type !== "xyz") return layer;

  const originalUrl =
    typeof layer.metadata.originalUrl === "string" &&
    layer.metadata.originalUrl.trim()
      ? layer.metadata.originalUrl
      : typeof layer.source.url === "string" && layer.source.url.trim()
        ? layer.source.url
        : null;
  if (!originalUrl) return layer;

  const metadata = { ...layer.metadata };
  delete metadata.resolvedUrl;

  return {
    ...layer,
    source: {
      ...layer.source,
      tiles: [originalUrl],
      url: originalUrl,
    },
    metadata,
  };
}

export function applyProjectToStore(project: GeoLibreProject): {
  projectName: string;
  mapView: MapViewState;
  basemapStyleUrl: string;
  basemapVisible: boolean;
  basemapOpacity: number;
  layers: GeoLibreLayer[];
  layerGroups: LayerGroup[];
  preferences: ProjectPreferences;
  projectPlugins: ProjectPluginState | null;
  legend: LegendConfig;
  storymap: StoryMap | null;
  models: ProcessingModel[];
  widgets: DashboardWidget[];
  dashboardColumns: number;
  metadata: Record<string, unknown>;
} {
  const layers = project.layers.map((layer) => ({
    ...layer,
    style: project.styles[layer.id]
      ? { ...DEFAULT_LAYER_STYLE, ...project.styles[layer.id] }
      : { ...DEFAULT_LAYER_STYLE, ...layer.style },
  }));
  // Re-normalize here (even though `parseProject` already did) because
  // `applyProjectToStore` is a public entry point also reached directly by
  // programmatic/newProject loads that never passed through `parseProject`, so
  // this stays a hardening boundary for untrusted group data. The call is
  // idempotent on already-normalized input.
  const layerGroups = normalizeLayerGroups(project.layerGroups);
  const validGroupIds = new Set(layerGroups.map((g) => g.id));
  // Drop dangling groupIds, then restore the contiguity invariant the layer
  // panel relies on, in case the project was hand-edited or produced externally
  // with a group's members interleaved among unrelated layers.
  const normalizedLayers = normalizeGroupContiguity(
    layers.map((layer) =>
      layer.groupId && !validGroupIds.has(layer.groupId)
        ? { ...layer, groupId: undefined }
        : layer,
    ),
  );
  return {
    projectName: project.name,
    mapView: project.mapView,
    basemapStyleUrl: project.basemapStyleUrl,
    basemapVisible: project.basemapVisible ?? true,
    basemapOpacity: project.basemapOpacity ?? 1,
    layers: normalizedLayers,
    layerGroups,
    preferences: normalizeProjectPreferences(project.preferences),
    projectPlugins: normalizeProjectPlugins(project.plugins),
    legend: normalizeLegendConfig(project.legend) ?? { ...DEFAULT_LEGEND_CONFIG },
    storymap: normalizeStoryMap(project.storymap),
    models: normalizeModels(project.models) ?? [],
    widgets: normalizeWidgets(project.widgets) ?? [],
    dashboardColumns: normalizeDashboardColumns(project.dashboardColumns),
    metadata: project.metadata,
  };
}

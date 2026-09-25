// The lazily loaded maplibre-gl-components / maplibre-gl-splat control
// constructors every sub-control of the Components plugin builds from.
// Split out of maplibre-components.ts (opengeos/GeoLibre#2633).

type ControlGridConstructor = (typeof import("maplibre-gl-components"))["ControlGrid"];
export type AddVectorControlConstructor =
  (typeof import("maplibre-gl-components"))["AddVectorControl"];
export type BookmarkControlConstructor =
  (typeof import("maplibre-gl-components"))["BookmarkControl"];
export type MeasureControlConstructor = (typeof import("maplibre-gl-components"))["MeasureControl"];
export type MinimapControlConstructor = (typeof import("maplibre-gl-components"))["MinimapControl"];
export type ViewStateControlConstructor =
  (typeof import("maplibre-gl-components"))["ViewStateControl"];
export type CogLayerControlConstructor =
  (typeof import("maplibre-gl-components"))["CogLayerControl"];
export type ColorbarGuiControlConstructor =
  (typeof import("maplibre-gl-components"))["ColorbarGuiControl"];
export type PMTilesLayerControlConstructor =
  (typeof import("maplibre-gl-components"))["PMTilesLayerControl"];
export type PrintControlConstructor = (typeof import("maplibre-gl-components"))["PrintControl"];
export type SearchControlConstructor = (typeof import("maplibre-gl-components"))["SearchControl"];
export type SpinGlobeControlConstructor =
  (typeof import("maplibre-gl-components"))["SpinGlobeControl"];
export type StacSearchControlConstructor =
  (typeof import("maplibre-gl-components"))["StacSearchControl"];
export type ZarrLayerControlConstructor =
  (typeof import("maplibre-gl-components"))["ZarrLayerControl"];
export type HtmlGuiControlConstructor = (typeof import("maplibre-gl-components"))["HtmlGuiControl"];
export type LegendGuiControlConstructor =
  (typeof import("maplibre-gl-components"))["LegendGuiControl"];
export type LidarControlConstructor = (typeof import("maplibre-gl-components"))["LidarControl"];
export type LidarLayerAdapterConstructor =
  (typeof import("maplibre-gl-components"))["LidarLayerAdapter"];
export type GaussianSplatControlConstructor =
  (typeof import("maplibre-gl-splat"))["GaussianSplatControl"];
export type GaussianSplatLayerAdapterConstructor =
  (typeof import("maplibre-gl-splat"))["GaussianSplatLayerAdapter"];

interface ComponentsConstructors {
  AddVectorControl: AddVectorControlConstructor;
  BookmarkControl: BookmarkControlConstructor;
  CogLayerControl: CogLayerControlConstructor;
  ColorbarGuiControl: ColorbarGuiControlConstructor;
  ControlGrid: ControlGridConstructor;
  GaussianSplatControl: GaussianSplatControlConstructor;
  GaussianSplatLayerAdapter: GaussianSplatLayerAdapterConstructor;
  HtmlGuiControl: HtmlGuiControlConstructor;
  LegendGuiControl: LegendGuiControlConstructor;
  LidarControl: LidarControlConstructor;
  LidarLayerAdapter: LidarLayerAdapterConstructor;
  MeasureControl: MeasureControlConstructor;
  MinimapControl: MinimapControlConstructor;
  PMTilesLayerControl: PMTilesLayerControlConstructor;
  PrintControl: PrintControlConstructor;
  SearchControl: SearchControlConstructor;
  SpinGlobeControl: SpinGlobeControlConstructor;
  StacSearchControl: StacSearchControlConstructor;
  ViewStateControl: ViewStateControlConstructor;
  ZarrLayerControl: ZarrLayerControlConstructor;
}

let componentsConstructorsPromise: Promise<ComponentsConstructors> | null = null;

type ComponentsModule = typeof import("maplibre-gl-components");
type SplatModule = typeof import("maplibre-gl-splat");
// Both elements can be `undefined` at runtime, not just rejected: a
// `vite:preloadError` handler that calls preventDefault() makes a failed dynamic
// import RESOLVE to `undefined` (see getComponentsConstructors). An `undefined`
// splat is handled the same as a rejected one (null) - both fall back to the
// bundled GaussianSplatControl via optional chaining - so only `components`
// being absent is fatal.
/** @internal The dynamic-import pair {@link getComponentsConstructors} builds from. */
export type ComponentsModules = [ComponentsModule | undefined, SplatModule | null | undefined];

// The pair of dynamic imports getComponentsConstructors builds from. Split out
// as an injectable seam so a test can simulate the vite:preloadError +
// preventDefault() case (see getComponentsConstructors), where a failed import
// RESOLVES to `undefined` instead of rejecting.
//
// Load the splatting control from maplibre-gl-splat directly: the copy
// re-exported (and bundled) by maplibre-gl-components lags behind, so its
// sample-data dropdown would be missing if taken from there. Do not let a
// failure here take down every other component control. Promise.all rejects the
// whole shared promise if any input rejects, so a single failed splat import (a
// code-split chunk network hiccup, a missing dev-checkout package) would have
// broken BookmarkControl, MeasureControl, etc. for the life of the page. On
// failure, fall back to the (older) GaussianSplatControl bundled in
// maplibre-gl-components so the rest of the controls still load.
const defaultLoadComponentsModules = (): Promise<ComponentsModules> =>
  Promise.all([
    import("maplibre-gl-components"),
    import("maplibre-gl-splat").catch((error: unknown) => {
      console.warn(
        "maplibre-gl-splat failed to load; falling back to the splat control bundled in maplibre-gl-components",
        error,
      );
      return null;
    }),
  ]);

let loadComponentsModules = defaultLoadComponentsModules;

/**
 * Test-only seam: swap the component-module loader and reset the memoized
 * singleton. Passing `null` restores the real dynamic imports.
 *
 * @internal
 */
export function __setComponentsModuleLoaderForTests(
  loader: (() => Promise<ComponentsModules>) | null,
): void {
  loadComponentsModules = loader ?? defaultLoadComponentsModules;
  componentsConstructorsPromise = null;
}

/** @internal Exported so the lazy component-control loader can be unit-tested. */
export const getComponentsConstructors = (): Promise<ComponentsConstructors> => {
  componentsConstructorsPromise ??= loadComponentsModules()
    .then(([components, splat]) => {
      // A `vite:preloadError` handler that calls preventDefault() makes the
      // failed dynamic import RESOLVE to `undefined` instead of rejecting. The
      // stale-chunk reload guard (installStaleChunkReload) does exactly this when
      // it defers a reload to protect unsaved work: a chunk orphaned by a
      // redeploy then fails, but the reload is withheld. Destructuring that
      // `undefined` module throws the cryptic "Cannot destructure property
      // 'AddVectorControl' of 'undefined'"; turn it into a clear, actionable
      // error (the .catch below keeps it from poisoning the shared singleton).
      if (!components) {
        throw new Error(
          "The map controls could not be loaded, most likely because the app was updated in the background. Reload the page to finish loading them.",
        );
      }
      const {
        AddVectorControl: AddVectorControlClass,
        BookmarkControl: BookmarkControlClass,
        CogLayerControl: CogLayerControlClass,
        ColorbarGuiControl: ColorbarGuiControlClass,
        ControlGrid: ControlGridClass,
        HtmlGuiControl: HtmlGuiControlClass,
        LegendGuiControl: LegendGuiControlClass,
        LidarControl: LidarControlClass,
        LidarLayerAdapter: LidarLayerAdapterClass,
        MeasureControl: MeasureControlClass,
        MinimapControl: MinimapControlClass,
        PMTilesLayerControl: PMTilesLayerControlClass,
        PrintControl: PrintControlClass,
        SearchControl: SearchControlClass,
        SpinGlobeControl: SpinGlobeControlClass,
        StacSearchControl: StacSearchControlClass,
        ViewStateControl: ViewStateControlClass,
        ZarrLayerControl: ZarrLayerControlClass,
      } = components;
      // Prefer the dedicated maplibre-gl-splat exports; fall back to the copy
      // bundled in (and re-exported by) maplibre-gl-components only if the
      // dedicated import failed. No throw here: this runs inside the memoized
      // `componentsConstructorsPromise`, so throwing would reject the cached
      // singleton and break every other component control too. maplibre-gl-components
      // re-exports GaussianSplatControl, so the fallback is always defined.
      const GaussianSplatControlClass = (splat?.GaussianSplatControl ??
        components.GaussianSplatControl) as GaussianSplatControlConstructor;
      const GaussianSplatLayerAdapterClass = (splat?.GaussianSplatLayerAdapter ??
        components.GaussianSplatLayerAdapter) as GaussianSplatLayerAdapterConstructor;
      return {
        AddVectorControl: AddVectorControlClass,
        BookmarkControl: BookmarkControlClass,
        CogLayerControl: CogLayerControlClass,
        ColorbarGuiControl: ColorbarGuiControlClass,
        ControlGrid: ControlGridClass,
        GaussianSplatControl: GaussianSplatControlClass,
        GaussianSplatLayerAdapter: GaussianSplatLayerAdapterClass,
        HtmlGuiControl: HtmlGuiControlClass,
        LegendGuiControl: LegendGuiControlClass,
        LidarControl: LidarControlClass,
        LidarLayerAdapter: LidarLayerAdapterClass,
        MeasureControl: MeasureControlClass,
        MinimapControl: MinimapControlClass,
        PMTilesLayerControl: PMTilesLayerControlClass,
        PrintControl: PrintControlClass,
        SearchControl: SearchControlClass,
        SpinGlobeControl: SpinGlobeControlClass,
        StacSearchControl: StacSearchControlClass,
        ViewStateControl: ViewStateControlClass,
        ZarrLayerControl: ZarrLayerControlClass,
      };
    })
    .catch((error: unknown) => {
      // Never memoize a failure. This shared singleton backs every component
      // control (COG, FlatGeobuf, PMTiles, Zarr, Bookmark, Measure, Minimap,
      // Search, Print, ...), so a cached rejection would break all of them for
      // the life of the page. Clearing it lets the next action retry the import
      // once the cause clears (a transient chunk-load hiccup, or a reload after a
      // redeploy).
      componentsConstructorsPromise = null;
      throw error;
    });
  return componentsConstructorsPromise;
};

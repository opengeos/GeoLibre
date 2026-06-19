// USGS LiDAR control theming.
//
// `maplibre-gl-usgs-lidar` ships its own stylesheet and themes the panel from
// the OS `prefers-color-scheme` by default (its `theme` option defaults to
// `auto`). That means the panel renders light while the GeoLibre app is in dark
// mode on a light OS. GeoLibre keeps its in-app light/dark toggle independent of
// the OS, so we force the upstream theme to follow the app: the package exposes
// explicit `usgs-lidar-theme-dark` / `usgs-lidar-theme-light` classes that win
// over the `prefers-color-scheme` media query, so we toggle those on every USGS
// control/panel element to match the document's `dark` class. This covers both
// the standalone USGS LiDAR plugin and the Components grid's usgsLidar control.
import "maplibre-gl-usgs-lidar/style.css";

const USGS_THEMED_SELECTOR = ".usgs-lidar-control, .usgs-lidar-control-panel";

function applyUsgsLidarTheme(): void {
  const dark = document.documentElement.classList.contains("dark");
  document
    .querySelectorAll<HTMLElement>(USGS_THEMED_SELECTOR)
    .forEach((element) => {
      element.classList.toggle("usgs-lidar-theme-dark", dark);
      element.classList.toggle("usgs-lidar-theme-light", !dark);
    });
}

if (typeof document !== "undefined") {
  // Re-theme when the app toggles light/dark (the desktop shell flips the `dark`
  // class on <html>).
  new MutationObserver(applyUsgsLidarTheme).observe(document.documentElement, {
    attributeFilter: ["class"],
  });

  // Re-theme when a USGS panel mounts or re-renders, since the control creates
  // its DOM lazily and may rebuild parts of the panel on interaction.
  new MutationObserver(applyUsgsLidarTheme).observe(document.body, {
    childList: true,
    subtree: true,
  });

  applyUsgsLidarTheme();
}

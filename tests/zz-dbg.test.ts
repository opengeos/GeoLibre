import { CHINA_BASEMAPS, createEmptyProject, DEFAULT_BASEMAP, useAppStore } from "@geolibre/core";
const AMAP = CHINA_BASEMAPS.find((b) => b.id === "amap-street")!;
useAppStore.getState().newProject();
useAppStore.getState().setRegionalBasemapPolicy("prompt");
useAppStore.getState().loadProject(createEmptyProject("R", { basemapStyleUrl: AMAP.styleUrl }));
const stale = useAppStore.getState().regionalBasemapHold!;
console.log("after A", useAppStore.getState().basemapStyleUrl, stale);
useAppStore.getState().loadProject(createEmptyProject("R", { basemapStyleUrl: DEFAULT_BASEMAP }));
console.log(
  "after B",
  useAppStore.getState().basemapStyleUrl,
  useAppStore.getState().regionalBasemapHold,
);

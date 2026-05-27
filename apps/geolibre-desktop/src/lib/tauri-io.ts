import { parseProject, type GeoLibreProject } from "@geolibre/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import type { FeatureCollection } from "geojson";

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function openGeoJsonFile(): Promise<{
  data: FeatureCollection;
  path: string;
} | null> {
  if (!isTauri()) {
    console.warn("File dialog requires Tauri runtime");
    return null;
  }
  const selected = await open({
    multiple: false,
    filters: [{ name: "GeoJSON", extensions: ["geojson", "json"] }],
  });
  if (!selected || typeof selected !== "string") return null;
  const text = await readTextFile(selected);
  const data = JSON.parse(text) as FeatureCollection;
  return { data, path: selected };
}

export async function openProjectFile(): Promise<{
  project: GeoLibreProject;
  path: string;
} | null> {
  if (!isTauri()) return null;
  const selected = await open({
    multiple: false,
    filters: [{ name: "GeoLibre Project", extensions: ["geolibre", "json"] }],
  });
  if (!selected || typeof selected !== "string") return null;
  const text = await readTextFile(selected);
  const project = parseProject(text);
  return { project, path: selected };
}

export async function saveProjectFile(
  content: string,
  defaultName?: string,
): Promise<string | null> {
  if (!isTauri()) return null;
  const path = await save({
    filters: [{ name: "GeoLibre Project", extensions: ["geolibre", "json"] }],
    defaultPath: defaultName ?? "project.geolibre.json",
  });
  if (!path) return null;
  await writeTextFile(path, content);
  return path;
}

/** Browser fallback: pick a local GeoJSON file when not running in Tauri */
export function openGeoJsonFileBrowser(): Promise<{
  data: FeatureCollection;
  path: string;
} | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".geojson,.json";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) {
        resolve(null);
        return;
      }
      const text = await file.text();
      resolve({
        data: JSON.parse(text) as FeatureCollection,
        path: file.name,
      });
    };
    input.click();
  });
}

export async function openGeoJsonFileWithFallback(): Promise<{
  data: FeatureCollection;
  path: string;
} | null> {
  if (isTauri()) return openGeoJsonFile();
  return openGeoJsonFileBrowser();
}

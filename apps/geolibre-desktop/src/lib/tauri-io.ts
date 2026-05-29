import { parseProject, type GeoLibreProject } from "@geolibre/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import type { FeatureCollection } from "geojson";

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function browserSafeFileName(path: string): string {
  return path.split(/[/\\]/).pop() || "project.geolibre.json";
}

interface FileDialogFilter {
  name: string;
  extensions: string[];
}

interface LocalDataFileOptions {
  filters: FileDialogFilter[];
  accept: string;
  readText?: boolean;
}

interface BrowserFilePickerType {
  description: string;
  accept: Record<string, string[]>;
}

interface BrowserOpenFileHandle {
  name: string;
  getFile: () => Promise<File>;
}

interface BrowserWritableFileStream {
  write: (data: string | Blob) => Promise<void>;
  close: () => Promise<void>;
}

interface BrowserSaveFileHandle {
  name: string;
  createWritable: () => Promise<BrowserWritableFileStream>;
}

interface BrowserFilePickerWindow extends Window {
  showOpenFilePicker?: (options: {
    multiple?: boolean;
    types?: BrowserFilePickerType[];
    excludeAcceptAllOption?: boolean;
  }) => Promise<BrowserOpenFileHandle[]>;
  showSaveFilePicker?: (options: {
    suggestedName?: string;
    types?: BrowserFilePickerType[];
    excludeAcceptAllOption?: boolean;
  }) => Promise<BrowserSaveFileHandle>;
}

const GEOLIBRE_PROJECT_FILE_TYPES: BrowserFilePickerType[] = [
  {
    description: "GeoLibre Project",
    accept: {
      "application/json": [".geolibre", ".json"],
    },
  },
];

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

async function openProjectFileBrowser(): Promise<{
  project: GeoLibreProject;
  path: string;
} | null> {
  const pickerWindow = window as BrowserFilePickerWindow;
  if (pickerWindow.showOpenFilePicker) {
    try {
      const [handle] = await pickerWindow.showOpenFilePicker({
        multiple: false,
        types: GEOLIBRE_PROJECT_FILE_TYPES,
        excludeAcceptAllOption: false,
      });
      if (!handle) return null;
      const file = await handle.getFile();
      return {
        project: parseProject(await file.text()),
        path: handle.name || file.name,
      };
    } catch (error) {
      if (isAbortError(error)) return null;
      console.warn("Browser project file picker failed", error);
    }
  }

  const result = await openLocalDataFileWithFallback({
    filters: [{ name: "GeoLibre Project", extensions: ["geolibre", "json"] }],
    accept: ".geolibre,.json,.geolibre.json",
    readText: true,
  });
  if (!result?.text) return null;
  return {
    project: parseProject(result.text),
    path: result.path,
  };
}

async function saveProjectFileBrowser(
  content: string,
  defaultName?: string,
): Promise<string | null> {
  const fileName = browserSafeFileName(defaultName ?? "project.geolibre.json");
  const pickerWindow = window as BrowserFilePickerWindow;

  if (pickerWindow.showSaveFilePicker) {
    try {
      const handle = await pickerWindow.showSaveFilePicker({
        suggestedName: fileName,
        types: GEOLIBRE_PROJECT_FILE_TYPES,
        excludeAcceptAllOption: false,
      });
      const writable = await handle.createWritable();
      await writable.write(content);
      await writable.close();
      return handle.name || fileName;
    } catch (error) {
      if (isAbortError(error)) return null;
      console.warn("Browser project save picker failed", error);
    }
  }

  const blob = new Blob([content], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  return fileName;
}

export async function openLocalDataFileWithFallback(
  options: LocalDataFileOptions,
): Promise<{
  path: string;
  text?: string;
} | null> {
  if (isTauri()) {
    const selected = await open({
      multiple: false,
      filters: options.filters,
    });
    if (!selected || typeof selected !== "string") return null;
    const text = options.readText ? await readTextFile(selected) : undefined;
    return { path: selected, text };
  }

  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = options.accept;
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) {
        resolve(null);
        return;
      }
      const text = options.readText ? await file.text() : undefined;
      resolve({ path: file.name, text });
    };
    input.click();
  });
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
  if (!isTauri()) {
    return openProjectFileBrowser();
  }

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
  if (!isTauri()) {
    return saveProjectFileBrowser(content, defaultName);
  }

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

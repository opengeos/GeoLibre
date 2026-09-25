/**
 * The Style Manager, Layer Library and Template Library. The app-level lists
 * live outside the project lifecycle (persisted by the desktop app); only the
 * project-scoped style list is saved with the project.
 */
import { MAX_LAYER_LIBRARY_ENTRIES } from "../layer-library";
import type { LayerLibraryEntry, ProjectTemplateEntry, StyleLibraryEntry } from "../types";
import type { SliceCreator } from "./types";

export interface LibrariesSlice {
  /**
   * App-level Style Manager library (issue #1294). Lives outside the project
   * lifecycle: never serialized into the project file, untouched by
   * newProject/loadProject, and persisted by the desktop app (IndexedDB).
   */
  styleLibrary: StyleLibraryEntry[];
  /**
   * App-level Layer Library (issue #1520) — the Browser panel's My Data
   * section. Like {@link styleLibrary} it lives outside the project lifecycle:
   * never serialized into the project file, untouched by newProject/loadProject,
   * and persisted by the desktop app (IndexedDB). Most recently saved first.
   */
  layerLibrary: LayerLibraryEntry[];
  /**
   * App-level Template Library. Persisted by the desktop app (IndexedDB).
   */
  templateLibrary: ProjectTemplateEntry[];
  /**
   * Project-scoped Style Manager entries (issue #1294), serialized into the
   * `.geolibre.json` `styleLibrary` array and replaced on project load.
   */
  projectStyleLibrary: StyleLibraryEntry[];

  /**
   * Replace the app-level style library wholesale. Used by the persistence
   * layer on startup and by bundle imports.
   */
  setStyleLibrary: (entries: StyleLibraryEntry[]) => void;
  /**
   * Insert or replace (matching by `id`) a Style Manager entry in the given
   * scope. Scope-local, like {@link deleteStyleLibraryEntry}: the other
   * scope's list is never touched, since a same id there can belong to an
   * unrelated entry after loading a project authored elsewhere. Project-scope
   * saves mark the project dirty.
   */
  saveStyleLibraryEntry: (entry: StyleLibraryEntry, scope?: "app" | "project") => void;
  /**
   * Remove a Style Manager entry by id. When `scope` is given only that list
   * is touched — the two scopes can legitimately hold the same id after
   * loading a project authored elsewhere, and deleting a project entry must
   * not erase a local app-library style (or vice versa). Omitting `scope`
   * removes the id from both lists.
   */
  deleteStyleLibraryEntry: (id: string, scope?: "app" | "project") => void;

  /**
   * Replace the app-level Layer Library wholesale. Used by the persistence
   * layer on startup and by bundle imports.
   */
  setLayerLibrary: (entries: LayerLibraryEntry[]) => void;
  /**
   * Insert or replace (matching by `id`) a Layer Library entry. New entries go
   * to the front so the most recently saved layer leads the My Data section.
   */
  saveLayerLibraryEntry: (entry: LayerLibraryEntry) => void;
  /** Rename a Layer Library entry; a blank name is ignored. */
  renameLayerLibraryEntry: (id: string, name: string) => void;
  /** Remove a Layer Library entry by id. */
  deleteLayerLibraryEntry: (id: string) => void;

  /** Replace the app-level template library wholesale. */
  setTemplateLibrary: (templates: ProjectTemplateEntry[]) => void;
  /** Insert or replace a template in the Template Library. */
  saveTemplateEntry: (entry: ProjectTemplateEntry) => void;
  /** Remove a template entry by id from the Template Library. */
  deleteTemplateEntry: (id: string) => void;
}

export const createLibrariesSlice: SliceCreator<LibrariesSlice> = (set) => ({
  styleLibrary: [],
  layerLibrary: [],
  templateLibrary: [],
  projectStyleLibrary: [],

  setStyleLibrary: (entries) => set({ styleLibrary: entries }),
  saveStyleLibraryEntry: (entry, scope = "app") =>
    set((s) => {
      const upsert = (list: StyleLibraryEntry[]) =>
        list.some((e) => e.id === entry.id)
          ? list.map((e) => (e.id === entry.id ? entry : e))
          : [...list, entry];
      if (scope === "project") {
        return {
          projectStyleLibrary: upsert(s.projectStyleLibrary),
          isDirty: true,
        };
      }
      // App-level saves don't touch the project file, so no dirty flag.
      return { styleLibrary: upsert(s.styleLibrary) };
    }),
  deleteStyleLibraryEntry: (id, scope) =>
    set((s) => {
      const inProject = scope !== "app" && s.projectStyleLibrary.some((e) => e.id === id);
      const inLibrary = scope !== "project" && s.styleLibrary.some((e) => e.id === id);
      // Keep untouched scopes reference-stable so the IndexedDB
      // persistence (which watches the styleLibrary reference) does not
      // rewrite an unchanged library.
      return {
        styleLibrary: inLibrary ? s.styleLibrary.filter((e) => e.id !== id) : s.styleLibrary,
        projectStyleLibrary: inProject
          ? s.projectStyleLibrary.filter((e) => e.id !== id)
          : s.projectStyleLibrary,
        isDirty: s.isDirty || inProject,
      };
    }),

  // The entry cap is applied on every write, not just when reading
  // untrusted input, so ordinary use (repeated saves, importing several
  // bundles over time) cannot grow the library past it. Mirrors
  // `writeBrowserFavorites`, which slices to MAX_FAVORITES on each write.
  setLayerLibrary: (entries) => set({ layerLibrary: entries.slice(0, MAX_LAYER_LIBRARY_ENTRIES) }),
  saveLayerLibraryEntry: (entry) =>
    set((s) => ({
      // App-level saves don't touch the project file, so no dirty flag
      // (mirrors saveStyleLibraryEntry's "app" scope). A new entry goes to
      // the front, so at the cap the oldest falls off the end.
      layerLibrary: s.layerLibrary.some((e) => e.id === entry.id)
        ? s.layerLibrary.map((e) => (e.id === entry.id ? entry : e))
        : [entry, ...s.layerLibrary].slice(0, MAX_LAYER_LIBRARY_ENTRIES),
    })),
  renameLayerLibraryEntry: (id, name) =>
    set((s) => {
      const trimmed = name.trim();
      // Keep the array reference stable for a no-op rename so the
      // IndexedDB persistence (which watches the reference) skips a write.
      if (!trimmed || !s.layerLibrary.some((e) => e.id === id && e.name !== trimmed)) {
        return {};
      }
      return {
        layerLibrary: s.layerLibrary.map((e) => (e.id === id ? { ...e, name: trimmed } : e)),
      };
    }),
  deleteLayerLibraryEntry: (id) =>
    set((s) =>
      s.layerLibrary.some((e) => e.id === id)
        ? { layerLibrary: s.layerLibrary.filter((e) => e.id !== id) }
        : {},
    ),

  setTemplateLibrary: (templates) => set({ templateLibrary: templates }),
  saveTemplateEntry: (entry) =>
    set((s) => ({
      templateLibrary: s.templateLibrary.some((t) => t.id === entry.id)
        ? s.templateLibrary.map((t) => (t.id === entry.id ? entry : t))
        : [...s.templateLibrary, entry],
    })),
  deleteTemplateEntry: (id) =>
    set((s) => ({
      templateLibrary: s.templateLibrary.filter((t) => t.id !== id),
    })),
});

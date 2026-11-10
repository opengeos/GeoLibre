import { invoke } from "@tauri-apps/api/core";
import type { TFunction } from "i18next";

/**
 * Dropped paths split into the ones the app can read and the ones a Flatpak
 * sandbox hides from it.
 */
export interface SandboxDropSplit {
  /** Paths to hand to the normal drop pipeline. */
  readable: string[];
  /** Host paths that do not exist inside the sandbox. */
  hidden: string[];
}

/**
 * Split a native drop into readable paths and paths the Flatpak sandbox
 * cannot see (issue #3393). A host file manager that does not route drags
 * through the document portal hands the sandboxed app raw host paths, which
 * fail later with an opaque fetch error. Outside Flatpak nothing is hidden.
 *
 * @param paths - The paths reported by the native drop event.
 * @param findHidden - Resolves the hidden subset; defaults to the
 *   `sandbox_hidden_drop_paths` Tauri command.
 * @returns The readable and hidden paths, each in drop order.
 */
export async function splitSandboxHiddenDropPaths(
  paths: string[],
  findHidden: (paths: string[]) => Promise<string[]> = (dropped) =>
    invoke<string[]>("sandbox_hidden_drop_paths", { paths: dropped }),
): Promise<SandboxDropSplit> {
  let hiddenList: string[];
  try {
    hiddenList = await findHidden(paths);
  } catch (error) {
    // An older backend without the command must not block every drop.
    console.warn("[GeoLibre] Could not check dropped paths against the sandbox", error);
    return { readable: paths, hidden: [] };
  }
  const hidden = new Set(hiddenList);
  return {
    readable: paths.filter((path) => !hidden.has(path)),
    hidden: paths.filter((path) => hidden.has(path)),
  };
}

/**
 * The file names of dropped paths, joined for an error message.
 *
 * @param paths - Absolute dropped paths.
 * @returns The base names separated by commas.
 */
export function droppedFileNames(paths: string[]): string {
  return paths.map((path) => path.split(/[/\\]/).pop() || path).join(", ");
}

/**
 * Drop the paths a Flatpak sandbox hides and report them, so a native drop
 * explains the sandbox instead of failing on each file (issue #3393).
 *
 * @param paths - The paths reported by the native drop event.
 * @param setError - Receives the error naming the hidden files, if any.
 * @param t - The i18n translate function.
 * @param findHidden - Resolves the hidden subset; see
 *   {@link splitSandboxHiddenDropPaths}.
 * @returns The paths the normal drop pipeline can read.
 */
export async function readableDropPaths(
  paths: string[],
  setError: (message: string) => void,
  t: TFunction,
  findHidden?: (paths: string[]) => Promise<string[]>,
): Promise<string[]> {
  const { readable, hidden } = await splitSandboxHiddenDropPaths(paths, findHidden);
  if (hidden.length > 0) {
    setError(
      t("toolbar.error.sandboxHiddenDrop", {
        count: hidden.length,
        names: droppedFileNames(hidden),
      }),
    );
  }
  return readable;
}

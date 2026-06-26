import { create } from "zustand";
import { browserSaveFallsBackToDownload } from "../lib/tauri-io";

/**
 * Options describing a single file-name prompt request.
 */
export interface FileNamePromptRequest {
  /** Suggested file name, pre-filled in the input. */
  defaultName: string;
}

interface FileNamePromptState {
  /** The in-flight request, or null when no prompt is open. */
  request: FileNamePromptRequest | null;
  /** Current value of the name input. */
  value: string;
  setValue: (value: string) => void;
  /**
   * Open the prompt and resolve with the chosen name, or null if cancelled.
   * A prompt already in flight is cancelled (resolves null) before the new one
   * opens, so overlapping callers cannot leak a pending promise.
   */
  prompt: (request: FileNamePromptRequest) => Promise<string | null>;
  submit: () => void;
  cancel: () => void;
}

// Resolver for the active prompt promise. Kept in a module-scoped closure rather
// than in the store state: it is an implementation detail of the promise/dialog
// handshake, not part of the public store contract the dialog consumes. Being a
// module singleton, tests that exercise prompt() without reaching submit/cancel
// should reset it (or the store) in beforeEach so a leftover resolver from one
// test cannot resolve the next test's promise.
let activeResolve: ((name: string | null) => void) | null = null;

/**
 * App-wide store backing a single reusable "choose a file name" dialog. Used by
 * the plugin host's text-file export when the browser cannot show a native save
 * picker (Firefox, Safari), so the user can still name the downloaded file.
 */
export const useFileNamePrompt = create<FileNamePromptState>((set, get) => ({
  request: null,
  value: "",
  setValue: (value) => set({ value }),
  prompt: (request) => {
    activeResolve?.(null);
    return new Promise<string | null>((resolve) => {
      activeResolve = resolve;
      set({ request, value: request.defaultName });
    });
  },
  // Clear store state before invoking the resolver so a handler that
  // synchronously re-enters the store (e.g. opens another prompt) sees a clean
  // slate and cannot trigger a double-resolve.
  submit: () => {
    const trimmed = get().value.trim();
    if (!trimmed) return;
    const resolve = activeResolve;
    activeResolve = null;
    set({ request: null, value: "" });
    resolve?.(trimmed);
  },
  cancel: () => {
    const resolve = activeResolve;
    activeResolve = null;
    set({ request: null, value: "" });
    resolve?.(null);
  },
}));

/**
 * Append the first allowed extension to a user-entered file name when it lacks
 * one, so a name like "my-story" becomes "my-story.html".
 */
export function ensureFileExtension(
  name: string,
  extensions: string[],
): string {
  const ext = extensions[0];
  if (!ext) return name;
  const lower = name.toLowerCase();
  const present = extensions.find((e) => lower.endsWith(`.${e.toLowerCase()}`));
  if (present) {
    // Already ends in an allowed extension; keep it, but guard a base-less name
    // like ".html" (a hidden dotfile) by giving it a "download" stem.
    const base = name.slice(0, -(present.length + 1)).replace(/\.+$/, "");
    return base ? name : `download${name.slice(-(present.length + 1))}`;
  }
  // Strip any trailing dots first so "my-story." doesn't become a double dot;
  // fall back to "download" when the name was only dots (e.g. "." / "..") so we
  // never produce a hidden, extension-only file like ".html".
  return `${name.replace(/\.+$/, "") || "download"}.${ext}`;
}

/**
 * Prompt for a download file name when the browser would otherwise save under a
 * fixed default. Tauri and Chromium offer a name in their native save dialog,
 * so this returns {@link defaultName} unchanged there; only Firefox/Safari
 * (which auto-download) open the name prompt. The pre-filled value is the base
 * name without its extension, which is re-applied (and path-illegal characters
 * are stripped) once the user confirms.
 *
 * @param defaultName Suggested file name, including its extension.
 * @param extensions Allowed extensions; the first is appended when missing.
 * @returns The name to pass as `defaultName`, or null if the user cancelled.
 */
export async function promptDownloadNameIfNeeded(
  defaultName: string,
  extensions: string[],
): Promise<string | null> {
  if (!browserSaveFallsBackToDownload()) return defaultName;
  const base = defaultName.replace(/\.[^./\\]+$/, "");
  const chosen = await useFileNamePrompt.getState().prompt({ defaultName: base });
  if (chosen === null) return null;
  // `chosen` is already trimmed by the prompt's submit handler.
  const sanitized = chosen
    // Replace characters illegal in common filesystems (path separators and the
    // C0 control range plus DEL, incl. the null byte) so a pasted name cannot
    // smuggle in a path or control character.
    // eslint-disable-next-line no-control-regex
    .replace(/[/\\:*?"<>|\x00-\x1f\x7f]/g, "_");
  return ensureFileExtension(sanitized, extensions);
}

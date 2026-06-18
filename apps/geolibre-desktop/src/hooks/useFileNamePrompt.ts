import { create } from "zustand";

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

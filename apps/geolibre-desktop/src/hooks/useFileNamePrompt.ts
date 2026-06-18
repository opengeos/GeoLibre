import { create } from "zustand";

/**
 * Options describing a single file-name prompt request.
 */
export interface FileNamePromptRequest {
  /** Suggested file name, pre-filled in the input. */
  defaultName: string;
  /**
   * Human-readable file-type label (e.g. "Bookmarks"), interpolated into the
   * dialog title. Optional.
   */
  typeLabel?: string;
}

interface FileNamePromptState {
  /** The in-flight request, or null when no prompt is open. */
  request: FileNamePromptRequest | null;
  /** Current value of the name input. */
  value: string;
  /** Resolver for the active prompt promise. */
  resolve: ((name: string | null) => void) | null;
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

/**
 * App-wide store backing a single reusable "choose a file name" dialog. Used by
 * the plugin host's text-file export when the browser cannot show a native save
 * picker (Firefox, Safari), so the user can still name the downloaded file.
 */
export const useFileNamePrompt = create<FileNamePromptState>((set, get) => ({
  request: null,
  value: "",
  resolve: null,
  setValue: (value) => set({ value }),
  prompt: (request) => {
    get().resolve?.(null);
    return new Promise<string | null>((resolve) => {
      set({ request, value: request.defaultName, resolve });
    });
  },
  submit: () => {
    const { resolve, value } = get();
    const trimmed = value.trim();
    if (!trimmed) return;
    resolve?.(trimmed);
    set({ request: null, value: "", resolve: null });
  },
  cancel: () => {
    get().resolve?.(null);
    set({ request: null, value: "", resolve: null });
  },
}));

import { createContext, useContext, type Dispatch, type SetStateAction } from "react";
import type { DraftDesktopSettings, DraftPreferences } from "./settings-draft";

/**
 * The draft state every Settings section edits. The dialog shell owns it (it
 * seeds the draft on open and commits it on Save); sections read and update it
 * through this context so their props stay limited to what is section-specific.
 */
export interface SettingsDraftContextValue {
  draftPreferences: DraftPreferences;
  setDraftPreferences: Dispatch<SetStateAction<DraftPreferences>>;
  draftDesktopSettings: DraftDesktopSettings;
  setDraftDesktopSettings: Dispatch<SetStateAction<DraftDesktopSettings>>;
  /** Show (or clear, with null) the error line above the dialog footer. */
  setError: (error: string | null) => void;
  /** Ids of secret values currently revealed (env var rows, geocoding keys). */
  revealedValueIds: Set<string>;
  /** Reveal or re-mask the value with `id`. */
  toggleValueVisibility: (id: string) => void;
}

const SettingsDraftContext = createContext<SettingsDraftContextValue | null>(null);

export const SettingsDraftProvider = SettingsDraftContext.Provider;

/**
 * Read the Settings dialog's draft state.
 *
 * Returns:
 *   The draft context value.
 *
 * Raises:
 *   Error: When called outside the Settings dialog.
 */
export function useSettingsDraft(): SettingsDraftContextValue {
  const value = useContext(SettingsDraftContext);
  if (!value) {
    throw new Error("useSettingsDraft must be used inside the Settings dialog");
  }
  return value;
}

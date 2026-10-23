import type { ParseKeys } from "i18next";
import { create } from "zustand";
import type { CvdMode } from "./cvd-simulation";

interface CvdPreviewState {
  /** The simulated deficiency, or null when the preview is off. */
  mode: CvdMode | null;
  setMode: (mode: CvdMode | null) => void;
}

/**
 * Session-only state for View → Color vision preview. Deliberately not part of
 * the project or desktop settings: it is a checking aid, and a map that
 * silently reopened grey or red-green-shifted would read as broken.
 *
 * Lives outside `CvdPreview.tsx` so the command registry, which must stay
 * importable outside the browser, can switch modes without loading UI code.
 */
export const useCvdPreviewStore = create<CvdPreviewState>((set) => ({
  mode: null,
  setMode: (mode) => set({ mode }),
}));

/** Catalog keys for each mode's display name. */
export const CVD_MODE_LABEL_KEYS: Readonly<Record<CvdMode, ParseKeys>> = {
  protanopia: "toolbar.item.cvdProtanopia",
  deuteranopia: "toolbar.item.cvdDeuteranopia",
  tritanopia: "toolbar.item.cvdTritanopia",
  achromatopsia: "toolbar.item.cvdAchromatopsia",
};

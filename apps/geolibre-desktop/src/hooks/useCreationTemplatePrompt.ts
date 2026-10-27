import type { ArcGISCreationTemplate, ArcGISCreationTemplateSelection } from "@geolibre/plugins";
import { create } from "zustand";

/** One creation-template prompt: the layer and the templates it offers. */
export interface CreationTemplatePromptRequest {
  layerName: string;
  templates: ArcGISCreationTemplate[];
}

/**
 * What the user chose: a template, or `{}` to start with the layer's defaults
 * only. A cancelled prompt resolves to `null` instead.
 */
export interface CreationTemplateChoice {
  template?: ArcGISCreationTemplateSelection;
}

interface CreationTemplatePromptState {
  /** The open request, or null when no prompt is shown. */
  request: CreationTemplatePromptRequest | null;
  /**
   * Open the prompt and resolve with the choice, or null if cancelled. A
   * prompt already open is cancelled first, so no caller is left waiting.
   */
  prompt: (request: CreationTemplatePromptRequest) => Promise<CreationTemplateChoice | null>;
  choose: (choice: CreationTemplateChoice) => void;
  cancel: () => void;
}

// The open prompt's resolver, kept out of the store state (see useFileNamePrompt).
let activeResolve: ((choice: CreationTemplateChoice | null) => void) | null = null;

/**
 * App-wide store backing the "choose a feature template" dialog shown before a
 * geometry-edit session on an ArcGIS layer that publishes several templates
 * (#3179).
 */
export const useCreationTemplatePrompt = create<CreationTemplatePromptState>((set) => ({
  request: null,
  prompt: (request) => {
    activeResolve?.(null);
    return new Promise((resolve) => {
      activeResolve = resolve;
      set({ request });
    });
  },
  choose: (choice) => {
    const resolve = activeResolve;
    activeResolve = null;
    set({ request: null });
    resolve?.(choice);
  },
  cancel: () => {
    const resolve = activeResolve;
    activeResolve = null;
    set({ request: null });
    resolve?.(null);
  },
}));

/** How a template is labelled in the picker. */
export interface CreationTemplateLabel {
  /** The published name, or null when it has none. */
  name: string | null;
  /** 1-based occurrence among templates sharing the name, when the name is not unique. */
  occurrence?: number;
  /** The type the template creates: its type's name, else its type code. */
  type?: string;
}

/**
 * Labels for the picker that keep every template distinguishable: published
 * names are not unique, so a repeated name gets its occurrence number.
 *
 * @param templates - The templates in metadata order.
 * @returns One label per template, in the same order.
 */
export function creationTemplateLabels(
  templates: readonly ArcGISCreationTemplate[],
): CreationTemplateLabel[] {
  const counts = new Map<string, number>();
  for (const template of templates) counts.set(template.name, (counts.get(template.name) ?? 0) + 1);
  const seen = new Map<string, number>();
  return templates.map((template) => {
    const occurrence = (seen.get(template.name) ?? 0) + 1;
    seen.set(template.name, occurrence);
    const type =
      template.typeName ?? (template.typeValue != null ? String(template.typeValue) : undefined);
    return {
      name: template.name || null,
      ...((counts.get(template.name) ?? 0) > 1 ? { occurrence } : {}),
      ...(type ? { type } : {}),
    };
  });
}

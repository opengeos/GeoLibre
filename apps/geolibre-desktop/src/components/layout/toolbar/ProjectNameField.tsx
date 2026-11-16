import { DEFAULT_PROJECT_NAME, useAppStore } from "@geolibre/core";
import { Input } from "@geolibre/ui";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";

interface ProjectNameFieldProps {
  /** Read-only viewer layout: the name is shown but cannot be edited. */
  viewer: boolean;
}

/**
 * The toolbar's editable project name.
 *
 * The store keeps the canonical English default name so saved files do not
 * vary by UI language; this field shows that default as a translated
 * placeholder instead (issue #3474).
 *
 * @param props - Component props.
 * @param props.viewer - Whether the read-only viewer layout is active.
 * @returns The project-name input.
 */
export function ProjectNameField({ viewer }: ProjectNameFieldProps) {
  const { t } = useTranslation();
  const projectName = useAppStore((s) => s.projectName);
  const setProjectName = useAppStore((s) => s.setProjectName);
  // Tracks an active IME composition so pressing Enter to confirm a CJK
  // candidate doesn't blur the project-name field mid-composition.
  const composingRef = useRef(false);
  // Whether the user has typed in the field since focusing it. The store stays
  // the field's source of truth; a default name renders as the placeholder
  // only until the user types, so a typed "Untitled Project" does not vanish
  // on its last keystroke.
  const [typed, setTyped] = useState(false);

  return (
    <Input
      aria-label={t("toolbar.item.projectName")}
      className="hidden h-7 w-44 border-transparent px-2 text-xs shadow-none focus-visible:border-input md:block"
      value={projectName === DEFAULT_PROJECT_NAME && !typed ? "" : projectName}
      placeholder={t("toolbar.item.untitledProject")}
      readOnly={viewer}
      onChange={(event) => {
        if (viewer) return;
        setTyped(true);
        setProjectName(event.target.value);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" && !composingRef.current && !event.nativeEvent.isComposing) {
          event.currentTarget.blur();
        }
      }}
      onCompositionStart={() => {
        composingRef.current = true;
      }}
      onCompositionEnd={() => {
        composingRef.current = false;
      }}
      onBlur={() => {
        setTyped(false);
        if (viewer) return;
        // Read the store, not the field, so a project loaded while the field
        // had focus is never overwritten by stale text. A blank name falls back
        // to the canonical, locale-independent default; a translated string
        // would otherwise be written into the saved project file.
        if (!useAppStore.getState().projectName.trim()) setProjectName(DEFAULT_PROJECT_NAME);
      }}
    />
  );
}

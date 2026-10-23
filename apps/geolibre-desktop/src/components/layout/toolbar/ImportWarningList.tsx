import { useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { groupImportWarnings, type ImportWarningLike } from "../../../lib/import-warning-groups";

interface ImportWarningListProps<T extends ImportWarningLike> {
  warnings: T[];
  /** Renders a warning's localized message. */
  describe: (warning: T) => string;
}

/**
 * The list of layers a project importer could not load, grouped by message.
 *
 * Shared by the QGIS and ArcGIS Pro import dialogs. Groups of more than one
 * layer collapse to a count plus their shared message, with the layer names
 * behind a toggle, so a project where hundreds of layers fail the same way
 * reads as one line instead of hundreds (GeoLibre#1904).
 */
export function ImportWarningList<T extends ImportWarningLike>({
  warnings,
  describe,
}: ImportWarningListProps<T>) {
  const { t } = useTranslation();
  const listId = useId();
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const groups = useMemo(() => groupImportWarnings(warnings, describe), [warnings, describe]);

  return (
    <ul className="max-h-64 space-y-2 overflow-y-auto text-sm">
      {groups.map((group, index) => {
        const isExpanded = expanded.has(group.message);
        // Indexed rather than keyed on the message, which is free text.
        const namesId = `${listId}-names-${index}`;
        return (
          <li key={group.message}>
            <strong>
              {group.layerNames.length === 1
                ? `${group.layerNames[0]}:`
                : `${t("toolbar.item.importWarningLayerCount", {
                    count: group.layerNames.length,
                  })}:`}
            </strong>{" "}
            {group.message}
            {group.layerNames.length > 1 ? (
              <div className="mt-0.5">
                <button
                  type="button"
                  aria-expanded={isExpanded}
                  aria-controls={namesId}
                  className="text-xs text-primary underline underline-offset-2"
                  onClick={() =>
                    setExpanded((current) => {
                      const next = new Set(current);
                      if (!next.delete(group.message)) next.add(group.message);
                      return next;
                    })
                  }
                >
                  {isExpanded ? t("toolbar.item.hideLayerNames") : t("toolbar.item.showLayerNames")}
                </button>
                {/* Rendered even when collapsed, and hidden with `hidden`, so
                    the button's aria-controls always resolves to a real
                    element. `hidden` keeps it out of the accessibility tree. */}
                <p
                  id={namesId}
                  hidden={!isExpanded}
                  className="mt-1 break-words text-xs text-muted-foreground"
                >
                  {group.layerNames.join(", ")}
                </p>
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

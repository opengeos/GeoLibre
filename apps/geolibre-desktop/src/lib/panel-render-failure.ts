import i18next from "i18next";
import { notify } from "./notify";

/**
 * Reports a plugin panel whose `render()` threw. The panel then opens empty,
 * which reads as a hang unless something says it failed.
 *
 * @param id - The panel's registration id, which keys the toast.
 * @param title - The panel's resolved title; the id stands in when it is blank.
 * @param error - What `render()` threw, kept in Diagnostics for the report.
 */
export function notifyPanelRenderFailed(id: string, title: unknown, error: unknown): void {
  const name = typeof title === "string" && title.trim() ? title : id;
  notify.error(i18next.t("notifications.panelRenderFailed", { name }), {
    dedupeKey: `panel-render:${id}`,
    error,
  });
}

/**
 * Opens a pre-filled GitHub bug report for a diagnostics record (the "Report
 * issue" action on error toasts and in the Diagnostics dialog). The URL itself
 * is built and scrubbed by {@link buildIssueReportUrl}.
 */
import { useAppStore } from "@geolibre/core";
import type { DiagnosticRecord } from "./diagnostics";
import { isTauri } from "./is-tauri";
import { buildIssueReportUrl } from "./issue-report";
import { openExternalLink } from "./open-external";
import { APP_VERSION } from "./updates";

/**
 * Opens the GitHub new-issue form for `record` in the system browser.
 *
 * @param record - The diagnostics entry to attach, or `null` for none.
 */
export function reportIssue(record: DiagnosticRecord | null): void {
  const url = buildIssueReportUrl(record, {
    appVersion: APP_VERSION,
    runtime: isTauri() ? "Desktop app" : "Web",
    platform: typeof navigator === "undefined" ? "unknown" : navigator.userAgent,
    renderer: useAppStore.getState().primaryRenderer ?? "unknown",
  });
  void openExternalLink(url);
}

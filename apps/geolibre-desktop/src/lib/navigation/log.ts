import { appendDiagnostic, formatUnknown } from "../diagnostics";

/**
 * Record a navigation failure in the diagnostics log. The panel only shows a
 * short translated message, so the underlying error would otherwise be lost.
 *
 * @param message - What failed, in English.
 * @param error - The caught error.
 */
export function logNavigation(message: string, error: unknown): void {
  appendDiagnostic({
    category: "runtime",
    level: "warning",
    message,
    detail: formatUnknown(error),
    source: "navigation",
  });
}

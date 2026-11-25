import { appendDiagnostic, formatUnknown, type DiagnosticLevel } from "./diagnostics";

/**
 * Records a GPS failure in the diagnostics log. The dialog only shows the user
 * a short translated message, so the underlying error would otherwise be lost.
 *
 * @param message What failed, in English, for the diagnostics panel.
 * @param error The caught error.
 * @param level Severity; defaults to "error".
 */
export function logGpsFailure(
  message: string,
  error: unknown,
  level: DiagnosticLevel = "error",
): void {
  appendDiagnostic({
    category: "runtime",
    level,
    message,
    detail: formatUnknown(error),
    source: "gps-tracking",
  });
}

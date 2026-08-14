import { Button, ErrorBoundary, type ErrorBoundaryFallbackProps } from "@geolibre/ui";
import { AlertTriangle, RefreshCw, X } from "lucide-react";
import type { ErrorInfo, ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { appendDiagnostic } from "../../lib/diagnostics";

/**
 * Records a boundary-caught error in the diagnostics panel so it is visible to
 * the user (and copyable for bug reports) instead of only landing in the
 * console.
 *
 * Note: in development React re-throws boundary-caught errors as a synthetic
 * `window.error` event, which `installDiagnosticsCapture` also records — so
 * each error shows up twice in the Diagnostics panel in dev mode. Production
 * builds (where React does not re-throw) record it once.
 */
function reportBoundaryError(label: string, error: Error, info?: ErrorInfo): void {
  appendDiagnostic({
    category: "runtime",
    level: "error",
    message: `${label} crashed: ${error.message}`,
    detail: [error.stack, info?.componentStack]
      .filter((part): part is string => Boolean(part))
      .join("\n\n"),
    source: label,
  });
}

export { reportBoundaryError };

/**
 * Top-level boundary. A render error anywhere not caught by a more specific
 * boundary lands here and shows a full-screen recovery panel rather than a
 * blank page. Reloading is the surest recovery for an error this high in the
 * tree, so the primary action reloads the app; "Try again" attempts an in-place
 * recovery without losing unsaved work.
 */
export function AppErrorBoundary({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  return (
    <ErrorBoundary
      onError={(error, info) => reportBoundaryError("Application", error, info)}
      fallback={({ error, reset }) => (
        <div
          role="alert"
          className="flex h-full w-full flex-col items-center justify-center gap-4 bg-background p-8 text-center"
        >
          <AlertTriangle className="h-10 w-10 text-destructive" />
          <div className="space-y-1">
            <h1 className="text-lg font-semibold">{t("errorBoundary.title")}</h1>
            <p className="max-w-md text-sm text-muted-foreground">
              {t("errorBoundary.description")}
            </p>
            <p className="max-w-md break-words font-mono text-xs text-muted-foreground/80">
              {/* Non-Error throws (common from plugin code) have no .message. */}
              {error.message || String(error)}
            </p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={reset}>
              <RefreshCw className="h-4 w-4" />
              {t("errorBoundary.tryAgain")}
            </Button>
            <Button onClick={() => window.location.reload()}>{t("errorBoundary.reload")}</Button>
          </div>
        </div>
      )}
    >
      {children}
    </ErrorBoundary>
  );
}

/**
 * Boundary for an individual region of the shell (a panel, the toolbar, the map
 * surface, etc.). A crash in one region shows a compact inline notice and a
 * retry button while the rest of the app keeps working. `resetKeys` lets the
 * region recover automatically when its driving inputs change.
 */
export function SectionErrorBoundary({
  label,
  displayName,
  children,
  fallbackClassName,
  resetKeys,
  onClose,
}: {
  /**
   * Stable English identifier for the section. It lands in diagnostics records
   * (and therefore in bug reports), so it is deliberately not translated.
   */
  label: string;
  /**
   * Translated section name for the user-facing fallback. Falls back to `label`
   * when a call site has no translation for it.
   */
  displayName?: string;
  children: ReactNode;
  /**
   * Class applied to the error fallback container. It has no effect during
   * normal rendering — the boundary injects no wrapper around its children.
   */
  fallbackClassName?: string;
  resetKeys?: readonly unknown[];
  /**
   * When the crashed section owns its own close control (a dockable panel whose
   * header is replaced by this fallback), pass a closer so the user is not
   * stranded when Retry keeps re-throwing — the fallback then offers a "Close"
   * action that dismisses the section entirely.
   */
  onClose?: () => void;
}) {
  return (
    <ErrorBoundary
      resetKeys={resetKeys}
      onError={(error, info) => reportBoundaryError(label, error, info)}
      fallback={({ reset }) => (
        <SectionErrorFallback
          label={displayName ?? label}
          reset={reset}
          className={fallbackClassName}
          onClose={onClose}
        />
      )}
    >
      {children}
    </ErrorBoundary>
  );
}

/**
 * Boundary for a non-essential overlay (e.g. a badge floating over the map): on
 * error it renders nothing rather than a visible fallback, but still reports to
 * diagnostics. Use it so a faulty overlay can never take down the surrounding
 * UI it shares a subtree with.
 */
export function SilentErrorBoundary({ label, children }: { label: string; children: ReactNode }) {
  return (
    <ErrorBoundary
      onError={(error, info) => reportBoundaryError(label, error, info)}
      fallback={() => null}
    >
      {children}
    </ErrorBoundary>
  );
}

function SectionErrorFallback({
  label,
  reset,
  className,
  onClose,
}: Pick<ErrorBoundaryFallbackProps, "reset"> & {
  label: string;
  className?: string;
  onClose?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      role="alert"
      className={`flex flex-col items-center justify-center gap-3 p-4 text-center ${
        className ?? ""
      }`}
    >
      <AlertTriangle className="h-6 w-6 text-destructive" />
      <p className="text-sm text-muted-foreground">{t("errorBoundary.sectionFailed", { label })}</p>
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={reset}>
          <RefreshCw className="h-4 w-4" />
          {t("common.retry")}
        </Button>
        {onClose ? (
          <Button variant="ghost" size="sm" onClick={onClose}>
            <X className="h-4 w-4" />
            {t("common.close")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

import {
  Button,
  ErrorBoundary,
  type ErrorBoundaryFallbackProps,
} from "@geolibre/ui";
import { AlertTriangle, RefreshCw } from "lucide-react";
import type { ErrorInfo, ReactNode } from "react";

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
function reportBoundaryError(
  label: string,
  error: Error,
  info?: ErrorInfo,
): void {
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
            <h1 className="text-lg font-semibold">Something went wrong</h1>
            <p className="max-w-md text-sm text-muted-foreground">
              GeoLibre hit an unexpected error and could not continue. Your work
              may be unsaved — try recovering before reloading.
            </p>
            <p className="max-w-md break-words font-mono text-xs text-muted-foreground/80">
              {/* Non-Error throws (common from plugin code) have no .message. */}
              {error.message || String(error)}
            </p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={reset}>
              <RefreshCw className="h-4 w-4" />
              Try again
            </Button>
            <Button onClick={() => window.location.reload()}>Reload app</Button>
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
  children,
  fallbackClassName,
  resetKeys,
}: {
  label: string;
  children: ReactNode;
  /**
   * Class applied to the error fallback container. It has no effect during
   * normal rendering — the boundary injects no wrapper around its children.
   */
  fallbackClassName?: string;
  resetKeys?: readonly unknown[];
}) {
  return (
    <ErrorBoundary
      resetKeys={resetKeys}
      onError={(error, info) => reportBoundaryError(label, error, info)}
      fallback={({ reset }) => (
        <SectionErrorFallback
          label={label}
          reset={reset}
          className={fallbackClassName}
        />
      )}
    >
      {children}
    </ErrorBoundary>
  );
}

function SectionErrorFallback({
  label,
  reset,
  className,
}: Pick<ErrorBoundaryFallbackProps, "reset"> & {
  label: string;
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={`flex flex-col items-center justify-center gap-3 p-4 text-center ${
        className ?? ""
      }`}
    >
      <AlertTriangle className="h-6 w-6 text-destructive" />
      <p className="text-sm text-muted-foreground">
        {label} failed to render. The rest of GeoLibre is still available.
      </p>
      <Button variant="outline" size="sm" onClick={reset}>
        <RefreshCw className="h-4 w-4" />
        Retry
      </Button>
    </div>
  );
}

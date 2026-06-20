import { Button } from "@geolibre/ui";
import { AlertTriangle, ChevronDown, ChevronRight, Zap } from "lucide-react";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";

// The local loopback address the Python sidecar listens on. Kept out of the
// translatable strings (injected via interpolation) so translators can't garble
// it and a future change to the address only touches one place. The port is
// derived from the URL so the two can never drift apart.
const SIDECAR_URL = "http://127.0.0.1:8765";
const SIDECAR_PORT = new URL(SIDECAR_URL).port;

interface SidecarHelpBannerProps {
  /**
   * Whether the app runs under Tauri (the desktop build). The processing
   * server can only be launched from the desktop app, so the troubleshooting
   * steps differ between desktop and the browser.
   */
  isDesktop: boolean;
  /**
   * The most recent action error (e.g. a failed "Start server"), surfaced as
   * extra context above the troubleshooting steps. Optional.
   */
  error?: string | null;
  /**
   * Switch the dialog to the in-browser WebAssembly runner, which needs no
   * processing server. Provided only when a WASM fallback exists for the tool
   * set (Whitebox), in which case the banner offers a one-click switch.
   */
  onRunLocally?: () => void;
}

/**
 * Interactive help banner shown when a processing tool needs the optional
 * Python sidecar but it is unavailable. Instead of a single static error line,
 * it explains in plain language what the sidecar is and expands to a
 * step-by-step resolution path, including a one-click switch to the WebAssembly
 * runner that needs no sidecar at all.
 */
export function SidecarHelpBanner({
  isDesktop,
  error,
  onRunLocally,
}: SidecarHelpBannerProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  // A unique id keeps the aria-controls association valid even if two banners
  // are ever rendered on the same page (a hardcoded id would collide).
  const helpId = useId();

  return (
    <div className="rounded-md border border-amber-500/40 bg-amber-500/10 text-sm">
      <button
        type="button"
        className="flex w-full items-start gap-2 px-3 py-2 text-left"
        aria-expanded={expanded}
        // Only reference the panel while it is in the DOM; the collapsed banner
        // doesn't render it, and aria-controls must point at an existing node.
        aria-controls={expanded ? helpId : undefined}
        onClick={() => setExpanded((value) => !value)}
      >
        <AlertTriangle
          aria-hidden="true"
          className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400"
        />
        <span className="min-w-0 flex-1">
          <span className="block font-medium text-foreground">
            {t("processing.sidecar.unavailableTitle")}
          </span>
          {error && (
            <span className="mt-0.5 block break-words text-xs text-destructive">
              {error}
            </span>
          )}
          <span className="mt-0.5 block text-xs text-muted-foreground">
            {expanded
              ? t("processing.sidecar.hideHelp")
              : t("processing.sidecar.showHelp")}
          </span>
        </span>
        {expanded ? (
          <ChevronDown
            aria-hidden="true"
            className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground"
          />
        ) : (
          <ChevronRight
            aria-hidden="true"
            className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground"
          />
        )}
      </button>

      {expanded && (
        <div
          id={helpId}
          className="grid gap-3 border-t border-amber-500/30 px-3 py-3"
        >
          <p className="text-xs leading-relaxed text-muted-foreground">
            {t("processing.sidecar.intro", { sidecarUrl: SIDECAR_URL })}
          </p>

          {onRunLocally && (
            <div className="grid gap-2 rounded-md border border-border bg-background/60 p-2.5">
              <p className="flex items-center gap-1.5 text-xs font-medium text-foreground">
                <Zap
                  aria-hidden="true"
                  className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400"
                />
                {t("processing.sidecar.wasmTipTitle")}
              </p>
              <p className="text-xs text-muted-foreground">
                {t("processing.sidecar.wasmTip")}
              </p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="justify-self-start"
                onClick={onRunLocally}
              >
                <Zap aria-hidden="true" className="h-3.5 w-3.5" />
                {t("processing.sidecar.runLocallyButton")}
              </Button>
            </div>
          )}

          <div className="grid gap-1.5">
            <p className="text-xs font-medium text-foreground">
              {t("processing.sidecar.troubleshootingTitle")}
            </p>
            <ol className="grid list-decimal gap-1 pl-5 text-xs text-muted-foreground">
              <li>
                {isDesktop
                  ? t("processing.sidecar.stepStartServerDesktop")
                  : t("processing.sidecar.stepStartServerBrowser")}
              </li>
              <li>{t("processing.sidecar.stepCheckPort", { port: SIDECAR_PORT })}</li>
              <li>{t("processing.sidecar.stepRestart")}</li>
            </ol>
          </div>
        </div>
      )}
    </div>
  );
}

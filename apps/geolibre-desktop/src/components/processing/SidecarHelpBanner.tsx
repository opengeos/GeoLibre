import { Button } from "@geolibre/ui";
import { AlertTriangle, ChevronDown, ChevronRight, Zap } from "lucide-react";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";

// The local loopback address the Python sidecar listens on. Kept out of the
// translatable strings (injected via interpolation) so translators can't garble
// it and a future change to the address only touches one place. The port is
// derived from the URL so the two can never drift apart. Exported so callers
// that supply their own intro/steps copy can interpolate the same values
// instead of duplicating the address.
export const SIDECAR_URL = "http://127.0.0.1:8765";
export const SIDECAR_PORT = new URL(SIDECAR_URL).port;

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
  /**
   * Override the banner title. Defaults to the generic "processing server isn't
   * available" line. Tools whose server failure is more specific (e.g. AI
   * segmentation) can supply their own.
   */
  title?: string;
  /**
   * Override the descriptive intro paragraph. Defaults to the Whitebox-flavored
   * copy that mentions the WebAssembly fallback. Tools without a WASM runner
   * should pass their own so the banner doesn't promise a fallback that doesn't
   * exist. Interpolate {@link SIDECAR_URL} as needed.
   */
  intro?: string;
  /**
   * Override the ordered troubleshooting steps. Defaults to the generic
   * start-server / check-port / restart sequence. Interpolate
   * {@link SIDECAR_PORT} as needed.
   */
  steps?: string[];
  /**
   * Override the heading above the troubleshooting steps. Defaults to "Still
   * want to use the server?", which fits tools that have a WASM fallback. Tools
   * where the server is mandatory (e.g. AI segmentation) should pass copy that
   * doesn't imply the server is optional.
   */
  troubleshootingTitle?: string;
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
  title,
  intro,
  steps,
  troubleshootingTitle,
}: SidecarHelpBannerProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  // A unique id keeps the aria-controls association valid even if two banners
  // are ever rendered on the same page (a hardcoded id would collide).
  const helpId = useId();

  const resolvedTitle = title ?? t("processing.sidecar.unavailableTitle");
  const resolvedIntro = intro ?? t("processing.sidecar.intro", { sidecarUrl: SIDECAR_URL });
  // Default to the generic start-server / check-port / restart sequence. The
  // first step branches on desktop vs. browser because only the desktop build
  // can launch the server.
  const resolvedSteps = steps ?? [
    isDesktop
      ? t("processing.sidecar.stepStartServerDesktop")
      : t("processing.sidecar.stepStartServerBrowser"),
    t("processing.sidecar.stepCheckPort", { port: SIDECAR_PORT }),
    t("processing.sidecar.stepRestart"),
  ];
  const resolvedTroubleshootingTitle =
    troubleshootingTitle ?? t("processing.sidecar.troubleshootingTitle");

  return (
    <div className="rounded-md border border-amber-500/40 bg-amber-500/10 text-sm">
      <button
        type="button"
        className="flex w-full items-start gap-2 px-3 py-2 text-start"
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
          <span className="block font-medium text-foreground">{resolvedTitle}</span>
          {error && (
            <span className="mt-0.5 block break-words text-xs text-destructive">{error}</span>
          )}
          <span className="mt-0.5 block text-xs text-muted-foreground">
            {expanded ? t("processing.sidecar.hideHelp") : t("processing.sidecar.showHelp")}
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
            className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground rtl:rotate-180"
          />
        )}
      </button>

      {expanded && (
        <div id={helpId} className="grid gap-3 border-t border-amber-500/30 px-3 py-3">
          <p className="text-xs leading-relaxed text-muted-foreground">{resolvedIntro}</p>

          {onRunLocally && (
            <div className="grid gap-2 rounded-md border border-border bg-background/60 p-2.5">
              <p className="flex items-center gap-1.5 text-xs font-medium text-foreground">
                <Zap
                  aria-hidden="true"
                  className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400"
                />
                {t("processing.sidecar.wasmTipTitle")}
              </p>
              <p className="text-xs text-muted-foreground">{t("processing.sidecar.wasmTip")}</p>
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
            <p className="text-xs font-medium text-foreground">{resolvedTroubleshootingTitle}</p>
            <ol className="grid list-decimal gap-1 ps-5 text-xs text-muted-foreground">
              {resolvedSteps.map((step, index) => (
                // index is a safe key: caller-authored fixed list, never reordered
                <li key={index}>{step}</li>
              ))}
            </ol>
          </div>
        </div>
      )}
    </div>
  );
}

import { useEffect, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { dismissNotification, notify } from "../../lib/notify";
import { trackWebglContextLoss } from "../../lib/webgl-context-loss";

/**
 * Shows a warning with a Reload action when a map canvas under `containerRef`
 * loses its WebGL context, and withdraws it if the engine restores the context
 * on its own. Without it the map just freezes or goes blank.
 *
 * @param containerRef - The element that holds every map pane.
 */
export function useWebglContextLossNotice(containerRef: RefObject<HTMLElement | null>): void {
  const { t } = useTranslation();
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let noticeId: string | null = null;
    const stop = trackWebglContextLoss(container, {
      onLost: () => {
        console.warn("[geolibre] A map canvas lost its WebGL context.");
        noticeId = notify.warning(t("shell.webglContextLost.message"), {
          description: t("shell.webglContextLost.description"),
          action: {
            label: t("shell.webglContextLost.reload"),
            onClick: () => window.location.reload(),
          },
          durationMs: null,
          dedupeKey: "webgl-context-lost",
        });
      },
      onRestored: () => {
        if (noticeId) dismissNotification(noticeId);
        noticeId = null;
      },
    });
    return () => {
      stop();
      if (noticeId) dismissNotification(noticeId);
    };
  }, [containerRef, t]);
}

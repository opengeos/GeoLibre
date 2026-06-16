import { type RefObject, useEffect } from "react";
import type { ThemeMode } from "./useThemeMode";

// Keep the embedded notebook's JupyterLab theme in sync with the app's
// light/dark mode. JupyterLab can't be themed via URL param or from the outside
// by default, but with `exposeAppInBrowser` it puts its application object on
// `window.jupyterapp`, so for the SAME-ORIGIN web build (JupyterLite served from
// the app origin) we reach into the iframe and run the built-in
// `apputils:change-theme` command — no reload, so the kernel/notebook state is
// preserved. On the desktop build the notebook server is a different origin, so
// the cross-origin property access throws and we no-op (theme sync is web-only).

const THEME_NAME: Record<ThemeMode, string> = {
  light: "JupyterLab Light",
  dark: "JupyterLab Dark",
};

interface JupyterAppLike {
  commands?: {
    hasCommand?: (id: string) => boolean;
    execute?: (id: string, args?: unknown) => unknown;
  };
}

/**
 * Mirror the app's theme into the embedded notebook (web build only).
 *
 * @param iframeRef - Ref to the notebook `<iframe>`.
 * @param themeMode - The app's current resolved theme ("light" | "dark").
 * @param loaded - Whether the iframe has finished loading (the JupyterLab app
 *   object appears shortly after, so we start trying once this is true).
 */
export function useNotebookThemeSync(
  iframeRef: RefObject<HTMLIFrameElement | null>,
  themeMode: ThemeMode,
  loaded: boolean,
): void {
  useEffect(() => {
    if (!loaded) return;
    let cancelled = false;
    let attempts = 0;
    let timer: number | undefined;

    const apply = () => {
      if (cancelled) return;
      try {
        const win = iframeRef.current?.contentWindow as
          | (Window & { jupyterapp?: JupyterAppLike })
          | null
          | undefined;
        const app = win?.jupyterapp;
        if (app?.commands?.hasCommand?.("apputils:change-theme")) {
          app.commands.execute?.("apputils:change-theme", {
            theme: THEME_NAME[themeMode],
          });
          return;
        }
      } catch {
        // Cross-origin (desktop JupyterLab server): the app object is not
        // reachable from here, so there is nothing to do.
        return;
      }
      // `jupyterapp` is created asynchronously after load; retry briefly (≈10s).
      if (attempts++ < 40) {
        timer = window.setTimeout(apply, 250);
      }
    };

    apply();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [iframeRef, themeMode, loaded]);
}

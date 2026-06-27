import { useTranslation } from "react-i18next";
import { ExternalLink, WifiOff } from "lucide-react";
import { openExternalLink } from "../../lib/open-external";

/**
 * The hosted GeoLibre web app, where the offline-caching service worker is
 * active. Offered as the remediation link when the current build (desktop, or
 * the dev server) has no controlling service worker so downloads can't persist.
 */
const OFFLINE_WEB_APP_URL = "https://web.geolibre.app";

interface NoServiceWorkerBannerProps {
  /** The build-specific warning text shown above the web-app link. */
  message: string;
}

/**
 * Amber warning shown in the offline dialogs when no service worker controls
 * the page (the desktop build and the dev server), so downloaded basemap tiles
 * can't be retained. Pairs the build-specific warning with a link to the hosted
 * web app where offline caching works. See #608.
 */
export function NoServiceWorkerBanner({ message }: NoServiceWorkerBannerProps) {
  const { t } = useTranslation();
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-md bg-amber-500/10 p-2 text-sm text-amber-700 dark:text-amber-400"
    >
      <WifiOff className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="space-y-1">
        <p>{message}</p>
        {/* A real anchor so assistive tech announces a link (not a button) and
            the browser offers open-in-new-tab; the onClick routes through
            openExternalLink because the Tauri webview ignores target="_blank"
            and needs the opener plugin. */}
        <a
          href={OFFLINE_WEB_APP_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 rounded font-medium underline underline-offset-2 hover:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          onClick={(event) => {
            event.preventDefault();
            void openExternalLink(OFFLINE_WEB_APP_URL);
          }}
        >
          {t("common.openWebApp")}
          <ExternalLink className="h-3.5 w-3.5" />
        </a>
      </div>
    </div>
  );
}

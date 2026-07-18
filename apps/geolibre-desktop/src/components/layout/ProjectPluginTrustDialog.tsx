import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@geolibre/ui";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { ProjectPluginTrustState } from "../../hooks/usePlugins";

interface ProjectPluginTrustDialogProps {
  trust: ProjectPluginTrustState;
}

/**
 * Prompts the user before an opened project's plugin manifest URLs are fetched
 * and executed (#1062). A `.geolibre.json` is opened as data and can carry
 * `plugins.manifestUrls` that would otherwise run third-party code in the
 * privileged app context. This dialog lists the untrusted URLs (with their
 * origin highlighted) and requires an explicit decision: trust and load, or
 * dismiss without loading. It is a no-op when the project references only
 * already-installed or bundled plugins.
 */
export function ProjectPluginTrustDialog({ trust }: ProjectPluginTrustDialogProps) {
  const { t } = useTranslation();

  // Trusting/dismissing empties pendingUrls synchronously, before the dialog's
  // exit animation finishes. Keep the last non-empty list so the URLs stay
  // rendered through the close transition instead of flashing blank. Recorded in
  // an effect rather than the render body so we never write a ref while
  // rendering.
  const lastPendingUrls = useRef<string[]>([]);
  useEffect(() => {
    if (trust.pendingUrls.length > 0) {
      lastPendingUrls.current = trust.pendingUrls;
    }
  }, [trust.pendingUrls]);
  const urls = trust.pendingUrls.length > 0 ? trust.pendingUrls : lastPendingUrls.current;

  return (
    <Dialog
      open={trust.pendingUrls.length > 0}
      onOpenChange={(open: boolean) => {
        // Closing via Escape / overlay click is treated as "don't load".
        if (!open) trust.dismiss();
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("managePlugins.trust.title")}</DialogTitle>
          <DialogDescription>
            {t("managePlugins.trust.description", { count: urls.length })}
          </DialogDescription>
        </DialogHeader>
        <ul className="max-h-48 space-y-2 overflow-y-auto rounded-md border border-border bg-muted/40 p-3">
          {urls.map((url) => (
            <li key={url} className="text-sm break-all">
              <span className="font-medium">{originOf(url)}</span>
              <span className="block text-xs text-muted-foreground">{url}</span>
            </li>
          ))}
        </ul>
        <p className="text-xs text-destructive">{t("managePlugins.trust.warning")}</p>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => trust.dismiss()}>
            {t("managePlugins.trust.dismissButton")}
          </Button>
          <Button onClick={() => trust.trust()}>{t("managePlugins.trust.trustButton")}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The scheme + host of a plugin URL, shown as the prominent origin line. Falls
 * back to the raw string for anything `URL` cannot parse (the loader would
 * reject it anyway).
 */
function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

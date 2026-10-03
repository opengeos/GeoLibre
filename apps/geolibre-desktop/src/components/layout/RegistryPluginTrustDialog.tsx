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
import type { RegistryPluginDeepLinkState } from "../../hooks/desktop-shell/usePluginDeepLink";
import type { PluginRegistryEntry } from "../../lib/plugin-registry";

interface RegistryPluginTrustDialogProps {
  link: RegistryPluginDeepLinkState;
}

/**
 * Prompts before a `?plugin=<registry id>` link installs a plugin from the
 * official registry. The link only names the plugin, so the dialog shows what
 * the registry knows about it (name, author, description, homepage) and where
 * its code is fetched from, and requires an explicit decision. Dismissing
 * installs nothing.
 */
export function RegistryPluginTrustDialog({ link }: RegistryPluginTrustDialogProps) {
  const { t } = useTranslation();

  // Trusting/dismissing empties `pending` before the exit animation finishes;
  // keep the last non-empty list rendered through the close transition.
  const lastPending = useRef<PluginRegistryEntry[]>([]);
  useEffect(() => {
    if (link.pending.length > 0) lastPending.current = link.pending;
  }, [link.pending]);
  const entries = link.pending.length > 0 ? link.pending : lastPending.current;

  return (
    <Dialog
      open={link.pending.length > 0}
      onOpenChange={(open: boolean) => {
        if (!open) link.dismiss();
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {t("managePlugins.registryTrust.title", { count: entries.length })}
          </DialogTitle>
          <DialogDescription>
            {t("managePlugins.registryTrust.description", { count: entries.length })}
          </DialogDescription>
        </DialogHeader>
        <ul className="max-h-64 space-y-2 overflow-y-auto rounded-md border border-border bg-muted/40 p-3">
          {entries.map((entry) => (
            <li key={entry.id} className="text-sm">
              <span className="font-medium">{entry.name}</span>
              <span className="ms-2 text-xs text-muted-foreground">v{entry.version}</span>
              {entry.author ? (
                <span className="block text-xs text-muted-foreground">
                  {t("managePlugins.registryTrust.by", { author: entry.author })}
                </span>
              ) : null}
              {entry.description ? <p className="mt-1">{entry.description}</p> : null}
              {entry.homepage ? (
                <a
                  className="mt-1 block text-xs break-all text-primary underline"
                  href={entry.homepage}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  {entry.homepage}
                </a>
              ) : null}
              <span className="mt-1 block text-xs break-all text-muted-foreground">
                {entry.manifestUrl}
              </span>
            </li>
          ))}
        </ul>
        <p className="text-xs text-destructive">{t("managePlugins.trust.warning")}</p>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => link.dismiss()}>
            {t("managePlugins.trust.dismissButton")}
          </Button>
          <Button onClick={() => link.trust()}>{t("managePlugins.trust.trustButton")}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

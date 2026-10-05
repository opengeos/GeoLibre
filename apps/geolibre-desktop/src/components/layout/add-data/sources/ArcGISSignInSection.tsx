import { Button, Input, Label } from "@geolibre/ui";
import { Loader2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  arcgisAuthErrorKey,
  loadArcGISClientId,
  normalizeArcGISPortalUrl,
  signInToArcGIS,
  signOutOfArcGIS,
  useArcGISAuthStore,
} from "../../../../lib/arcgis-oauth";

/**
 * The "Sign in with ArcGIS" controls of the ArcGIS source: the OAuth client ID,
 * the sign-in button, and, once signed in, who is signed in with a sign-out button.
 *
 * @param props - `portalUrl` is the portal field's value (blank means ArcGIS Online).
 */
export function ArcGISSignInSection({ portalUrl }: { portalUrl: string }) {
  const { t } = useTranslation();
  const portal = normalizeArcGISPortalUrl(portalUrl);
  const [clientId, setClientId] = useState(() => (portal ? loadArcGISClientId(portal) : ""));
  const [error, setError] = useState<string | null>(null);
  const pending = useArcGISAuthStore((state) => state.pending);
  const connection = useArcGISAuthStore((state) =>
    portal ? state.connections[portal] : undefined,
  );

  const handleSignIn = async () => {
    setError(null);
    try {
      await signInToArcGIS({ portalUrl, clientId });
    } catch (caught) {
      setError(t(arcgisAuthErrorKey(caught) ?? "addData.arcgis.signInError"));
    }
  };

  return (
    <div className="space-y-2">
      {connection ? (
        <div className="flex items-center justify-between gap-2 text-sm">
          <span>
            {t("addData.arcgis.signedInAs", {
              user: connection.username || connection.portal,
              portal: connection.portal,
            })}
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void signOutOfArcGIS(portalUrl)}
          >
            {t("addData.arcgis.signOut")}
          </Button>
        </div>
      ) : (
        <>
          <div className="space-y-1.5">
            <Label htmlFor="arcgis-client-id">{t("addData.arcgis.clientId")}</Label>
            <Input
              id="arcgis-client-id"
              autoComplete="off"
              placeholder={t("addData.arcgis.clientIdPlaceholder")}
              value={clientId}
              onChange={(event) => setClientId(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">{t("addData.arcgis.clientIdHint")}</p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={() => void handleSignIn()}
          >
            {pending ? <Loader2 className="me-2 h-4 w-4 animate-spin" /> : null}
            {t("addData.arcgis.signIn")}
          </Button>
        </>
      )}
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </div>
  );
}

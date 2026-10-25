import {
  arcgisLocatorInputField,
  fetchArcGISLocatorInfo,
  GeocoderServiceError,
  GeocoderUnsupportedError,
  normalizeArcGISLocatorUrl,
  type GeocodingLocator,
} from "@geolibre/core";
import { Button, Input, Label, Select } from "@geolibre/ui";
import { Plus, RefreshCw, Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { tryGetArcGISAccessToken } from "../../../lib/arcgis-oauth";
import {
  listLocatorPortalApprovals,
  locatorAcceptsPortalToken,
  revokeLocatorPortalApproval,
  stageLocatorPortalApproval,
} from "../../../lib/geocoding-auth";
import { useSettingsDraft } from "./SettingsDraftContext";

/** The outcome of the last "Check service" per locator id. */
type CheckStatus =
  | { kind: "checking" }
  | { kind: "ok" }
  | { kind: "error"; key: CheckErrorKey; detail?: string };

type CheckErrorKey =
  | "settings.geocoding.locators.errorUrl"
  | "settings.geocoding.locators.errorAuth"
  | "settings.geocoding.locators.errorPortal"
  | "settings.geocoding.locators.errorUnsupported"
  | "settings.geocoding.locators.errorService"
  | "settings.geocoding.locators.errorNetwork";

/** The capability fields a URL edit makes stale. */
const CAPABILITY_FIELDS = [
  "singleLineField",
  "addressFields",
  "reverse",
  "suggest",
  "searchField",
] as const;

/**
 * Map a failed check to the message shown under the locator.
 *
 * Args:
 *   error: What the check threw.
 *
 * Returns:
 *   The status to show.
 */
function checkError(error: unknown): CheckStatus {
  if (error instanceof GeocoderUnsupportedError) {
    return { kind: "error", key: "settings.geocoding.locators.errorUnsupported" };
  }
  if (error instanceof GeocoderServiceError) {
    return error.isAuthError
      ? { kind: "error", key: "settings.geocoding.locators.errorAuth" }
      : { kind: "error", key: "settings.geocoding.locators.errorService", detail: error.message };
  }
  // fetch rejects with a TypeError for an unreachable host or a CORS refusal;
  // the browser does not say which.
  return { kind: "error", key: "settings.geocoding.locators.errorNetwork" };
}

/**
 * The named ArcGIS GeocodeServer locators of the `arcgis-locator` provider:
 * which one is active, and each one's name, URL, optional portal, and the
 * capabilities read from its metadata.
 *
 * Returns:
 *   The editor.
 */
export function GeocodingLocatorsEditor() {
  const { t } = useTranslation();
  const { draftPreferences, setDraftPreferences, setError } = useSettingsDraft();
  const [statuses, setStatuses] = useState<Record<string, CheckStatus>>({});
  // Device-local, so revoking takes effect at once rather than on save.
  const [approvals, setApprovals] = useState(listLocatorPortalApprovals);
  // The check in flight per locator id. An edit to the URL or portal forgets it,
  // so a check that finishes afterwards does not overwrite the newer values.
  const pendingChecks = useRef(new Map<string, object>());
  const locators = draftPreferences.geocoding.locators ?? [];
  const activeId = locators.some((locator) => locator.id === draftPreferences.geocoding.locatorId)
    ? draftPreferences.geocoding.locatorId
    : locators[0]?.id;

  const setLocators = (
    update: (current: GeocodingLocator[]) => GeocodingLocator[],
    locatorId?: string,
  ) => {
    setDraftPreferences((current) => ({
      ...current,
      geocoding: {
        ...current.geocoding,
        locators: update(current.geocoding.locators ?? []),
        ...(locatorId !== undefined ? { locatorId } : {}),
      },
    }));
    setError(null);
  };

  const clearStatus = (id: string) =>
    setStatuses((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });

  const patchLocator = (id: string, patch: Partial<GeocodingLocator>) =>
    setLocators((current) =>
      current.map((locator) => (locator.id === id ? { ...locator, ...patch } : locator)),
    );

  const editLocator = (id: string, patch: Partial<GeocodingLocator>) => {
    if (!("url" in patch) && !("portalUrl" in patch)) {
      patchLocator(id, patch);
      return;
    }
    // A different service or portal makes the checked capabilities stale.
    setLocators((current) =>
      current.map((locator) => {
        if (locator.id !== id) return locator;
        const next: GeocodingLocator = { ...locator, ...patch };
        for (const field of CAPABILITY_FIELDS) delete next[field];
        return next;
      }),
    );
    pendingChecks.current.delete(id);
    clearStatus(id);
  };

  const addLocator = () => {
    const id = crypto.randomUUID();
    setLocators(
      (current) => [
        ...current,
        {
          id,
          name: t("settings.geocoding.locators.defaultName", { n: current.length + 1 }),
          url: "",
        },
      ],
      locators.length ? undefined : id,
    );
  };

  const removeLocator = (id: string) => {
    pendingChecks.current.delete(id);
    setLocators((current) => current.filter((locator) => locator.id !== id));
    clearStatus(id);
  };

  const checkLocator = async (locator: GeocodingLocator) => {
    const url = normalizeArcGISLocatorUrl(locator.url);
    if (!url) {
      setStatuses((s) => ({
        ...s,
        [locator.id]: { kind: "error", key: "settings.geocoding.locators.errorUrl" },
      }));
      return;
    }
    const ticket = {};
    pendingChecks.current.set(locator.id, ticket);
    const current = () => pendingChecks.current.get(locator.id) === ticket;
    setStatuses((s) => ({ ...s, [locator.id]: { kind: "checking" } }));
    try {
      let token: string | undefined;
      if (locator.portalUrl?.trim()) {
        if (!(await locatorAcceptsPortalToken(url, locator.portalUrl))) {
          if (current()) {
            setStatuses((s) => ({
              ...s,
              [locator.id]: { kind: "error", key: "settings.geocoding.locators.errorPortal" },
            }));
          }
          return;
        }
        if (!current()) return;
        token = await tryGetArcGISAccessToken(locator.portalUrl);
      }
      const capabilities = await fetchArcGISLocatorInfo(url, { token });
      if (!current()) return;
      // A successful check with a portal while signed in is the user's consent
      // to send its sign-in to this server from this device, granted when
      // Settings saves (see geocoding-auth.ts).
      if (token) stageLocatorPortalApproval(url, locator.portalUrl);
      patchLocator(locator.id, { url, ...capabilities });
      setStatuses((s) => ({ ...s, [locator.id]: { kind: "ok" } }));
    } catch (error) {
      if (current()) setStatuses((s) => ({ ...s, [locator.id]: checkError(error) }));
    } finally {
      if (current()) pendingChecks.current.delete(locator.id);
    }
  };

  const yesNo = (value: boolean) =>
    value ? t("settings.geocoding.locators.yes") : t("settings.geocoding.locators.no");

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h4 className="text-xs font-semibold">{t("settings.geocoding.locators.title")}</h4>
          <p className="text-xs text-muted-foreground">
            {t("settings.geocoding.locators.description")}
          </p>
        </div>
        <Button type="button" size="sm" variant="outline" onClick={addLocator}>
          <Plus className="h-3.5 w-3.5" />
          {t("common.add")}
        </Button>
      </div>

      {locators.length > 1 ? (
        <div className="space-y-1.5">
          <Label className="text-xs" htmlFor="geocoding-active-locator">
            {t("settings.geocoding.locators.active")}
          </Label>
          <Select
            id="geocoding-active-locator"
            value={activeId ?? ""}
            onChange={(event) => setLocators((current) => current, event.target.value)}
          >
            {locators.map((locator) => (
              <option key={locator.id} value={locator.id}>
                {locator.name || locator.url}
              </option>
            ))}
          </Select>
        </div>
      ) : null}

      {locators.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("settings.geocoding.locators.empty")}</p>
      ) : null}

      {locators.map((locator) => {
        const status = statuses[locator.id];
        const checked = locator.reverse !== undefined;
        const urlValid = !locator.url.trim() || normalizeArcGISLocatorUrl(locator.url) !== null;
        // The published inputs a search string can go to, plus the one in use
        // when it is not among them (ArcGIS's conventional SingleLine), so the
        // selector always shows what requests send.
        const searchFields = [
          ...new Set(
            [
              arcgisLocatorInputField(locator),
              locator.singleLineField,
              ...(locator.addressFields ?? []),
            ].filter((field): field is string => !!field),
          ),
        ];
        return (
          <div key={locator.id} className="space-y-2 rounded-md border p-3">
            <div className="flex items-end gap-2">
              <div className="flex-1 space-y-1.5">
                <Label className="text-xs" htmlFor={`geocoding-locator-name-${locator.id}`}>
                  {t("settings.geocoding.locators.name")}
                </Label>
                <Input
                  id={`geocoding-locator-name-${locator.id}`}
                  value={locator.name}
                  onChange={(event) => patchLocator(locator.id, { name: event.target.value })}
                />
              </div>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="h-8 w-8"
                aria-label={t("settings.geocoding.locators.remove", { name: locator.name })}
                onClick={() => removeLocator(locator.id)}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs" htmlFor={`geocoding-locator-url-${locator.id}`}>
                {t("settings.geocoding.locators.url")}
              </Label>
              <Input
                id={`geocoding-locator-url-${locator.id}`}
                value={locator.url}
                spellCheck={false}
                placeholder="https://gis.example.org/server/rest/services/Locators/Parcels/GeocodeServer"
                onChange={(event) => editLocator(locator.id, { url: event.target.value })}
              />
              {!urlValid ? (
                <p className="text-xs text-destructive">
                  {t("settings.geocoding.locators.errorUrl")}
                </p>
              ) : null}
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs" htmlFor={`geocoding-locator-portal-${locator.id}`}>
                {t("settings.geocoding.locators.portal")}
              </Label>
              <Input
                id={`geocoding-locator-portal-${locator.id}`}
                value={locator.portalUrl ?? ""}
                spellCheck={false}
                placeholder="https://gis.example.org/portal"
                onChange={(event) =>
                  editLocator(locator.id, { portalUrl: event.target.value || undefined })
                }
              />
              <p className="text-xs text-muted-foreground">
                {t("settings.geocoding.locators.portalHint")}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={status?.kind === "checking" || !locator.url.trim()}
                onClick={() => void checkLocator(locator)}
              >
                <RefreshCw
                  className={`h-3.5 w-3.5 ${status?.kind === "checking" ? "animate-spin" : ""}`}
                />
                {t("settings.geocoding.locators.check")}
              </Button>
              {checked ? (
                <p className="text-xs text-muted-foreground">
                  {t("settings.geocoding.locators.capabilities", {
                    field: locator.singleLineField ?? locator.addressFields?.join(", ") ?? "",
                    reverse: yesNo(locator.reverse === true),
                    suggest: yesNo(locator.suggest === true),
                  })}
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  {t("settings.geocoding.locators.unchecked")}
                </p>
              )}
            </div>
            {status?.kind === "error" ? (
              <p className="text-xs text-destructive" role="alert">
                {t(status.key, { detail: status.detail ?? "" })}
              </p>
            ) : null}
            {checked && locator.reverse === false ? (
              <p className="text-xs text-amber-600 dark:text-amber-500">
                {t("settings.geocoding.locators.noReverse")}
              </p>
            ) : null}
            {searchFields.length > 1 ? (
              <div className="space-y-1.5">
                <Label className="text-xs" htmlFor={`geocoding-locator-field-${locator.id}`}>
                  {t("settings.geocoding.locators.searchField")}
                </Label>
                <Select
                  id={`geocoding-locator-field-${locator.id}`}
                  value={arcgisLocatorInputField(locator)}
                  onChange={(event) =>
                    patchLocator(locator.id, {
                      // The default needs no setting, so a later check keeps it current.
                      searchField:
                        event.target.value ===
                        arcgisLocatorInputField({ ...locator, searchField: undefined })
                          ? undefined
                          : event.target.value,
                    })
                  }
                >
                  {searchFields.map((field) => (
                    <option key={field} value={field}>
                      {field}
                    </option>
                  ))}
                </Select>
                <p className="text-xs text-muted-foreground">
                  {t("settings.geocoding.locators.searchFieldHint")}
                </p>
              </div>
            ) : null}
          </div>
        );
      })}

      {approvals.length ? (
        <div className="space-y-2 rounded-md border p-3">
          <div>
            <h4 className="text-xs font-semibold">
              {t("settings.geocoding.locators.approvalsTitle")}
            </h4>
            <p className="text-xs text-muted-foreground">
              {t("settings.geocoding.locators.approvalsDescription")}
            </p>
          </div>
          <ul className="space-y-1">
            {approvals.map((approval) => (
              <li
                key={`${approval.portalHost} ${approval.locatorHost}`}
                className="flex items-center justify-between gap-2 text-xs"
              >
                <span className="min-w-0 break-all">
                  {t("settings.geocoding.locators.approvalEntry", { ...approval })}
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    revokeLocatorPortalApproval(approval);
                    setApprovals(listLocatorPortalApprovals());
                  }}
                >
                  {t("settings.geocoding.locators.revoke")}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

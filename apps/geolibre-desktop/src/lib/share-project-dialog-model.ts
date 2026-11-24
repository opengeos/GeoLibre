/**
 * Pure view-model logic for the Share Project dialog
 * (`components/layout/ShareProjectDialog.tsx`).
 *
 * Everything here is a plain function of its arguments: no React, no store, no
 * i18n runtime (the translation function is passed in). It stays a leaf so the
 * unit test that loads it does not drag the dialog's component tree into the
 * coverage denominator (see docs/maintenance.md, "Coverage floors"). The only
 * runtime imports are sibling lib modules that existing tests already load.
 */

import type { GeoLibreLayer } from "@geolibre/core";
import type { ParseKeys, TFunction } from "i18next";
import { isSerializationTooLargeError } from "./project-serialization-limits";
import {
  canOwnOrganizationProjects,
  isPublicSharingBlocked,
  publicSharingRestriction,
  type PublicSharingRestriction,
  type ShareOrganization,
} from "./share-gallery";
import {
  resolveShareBaseUrl,
  ShareUploadError,
  type ShareExpiry,
  type ShareLinkSetting,
  type ShareRole,
  type ShareUploadErrorCode,
  type ShareUploadOptions,
  type ShareVisibility,
} from "./share-geolibre";
import {
  isMissingForRecipients,
  type ShareReadinessInput,
  type ShareReadinessItem,
  type ShareReadinessReport,
} from "./share-readiness";

/** The user guide section on what a shared project can and cannot carry. */
export const SHARING_LOCAL_DATA_DOCS_URL =
  "https://geolibre.app/user-guide/projects/#sharing-local-data";

/**
 * Maps an error to its translated OAuth guidance key, or null when the error
 * is not an OAuth error. Injected so this module does not import the OAuth
 * session store.
 */
export type OAuthErrorKeyResolver = (err: unknown) => ParseKeys | null;

/**
 * The share host's account settings page, where the user both creates API
 * tokens and sets the username required for sharing.
 *
 * Derived from the resolved host rather than hardcoded, so a self-hosted
 * deployment sends its users to its own settings page.
 *
 * Args:
 *   base: The share host base URL. Defaults to the resolved deployment host.
 *
 * Returns:
 *   The settings URL, or null when no share host is configured, in which case
 *   the dialog does not render the link.
 */
export function accountSettingsUrl(base: string | null = resolveShareBaseUrl()): string | null {
  return base ? `${base}/settings` : null;
}

/** The slice of the app store the readiness checks read. */
export interface ShareReadinessState {
  layers: readonly GeoLibreLayer[];
  basemapVisible: boolean;
  basemapStyleUrl: string;
  projectPlugins: { manifestUrls?: readonly string[] } | null;
}

/**
 * What the readiness checks look at: the live layers plus the project-level
 * URLs. The dialog reads the store once per open rather than subscribing: it
 * is modal, so the snapshot it opens on is the project that will be uploaded.
 *
 * Args:
 *   state: The app store snapshot.
 *   isEmbeddable: The predicate the publish path uses to embed a layer's
 *     features. Those layers' local origin costs the recipient nothing, and
 *     taking the same predicate keeps the two from drifting.
 *
 * Returns:
 *   The readiness check input.
 */
export function readinessInputFromState(
  state: ShareReadinessState,
  isEmbeddable: (layer: GeoLibreLayer) => boolean,
): ShareReadinessInput {
  return {
    layers: state.layers,
    basemapStyleUrl: state.basemapVisible ? state.basemapStyleUrl : null,
    pluginManifestUrls: state.projectPlugins?.manifestUrls ?? [],
    embeddedLayerIds: new Set(state.layers.filter(isEmbeddable).map((layer) => layer.id)),
  };
}

/**
 * The row's heading: a layer's own name, or a translated label for the two
 * project-level references (the basemap style and a plugin manifest), which
 * the check reports without a name of their own so it never has to be handed
 * the translation function.
 *
 * Args:
 *   item: The readiness verdict to label.
 *   t: The translation function.
 *
 * Returns:
 *   The row heading.
 */
export function readinessLabel(item: ShareReadinessItem, t: TFunction): string {
  if (item.label) return item.label;
  return item.field === "basemapStyleUrl"
    ? t("share.readinessBasemapLabel")
    : t("share.readinessPluginLabel");
}

/**
 * The plain-language reason shown for a verdict, and what the author can do
 * about it. Keyed off the reason rather than the status so an unreachable host
 * and a stripped credential read differently even though both are fatal for a
 * recipient. An `unchecked` verdict short-circuits: whatever reason it carries,
 * the honest thing to say is that the check did not settle it.
 *
 * Args:
 *   item: The readiness verdict to describe.
 *
 * Returns:
 *   The translation keys for the reason and the optional advice.
 */
export function readinessCopyKeys(item: Pick<ShareReadinessItem, "status" | "reason">) {
  if (item.status === "unchecked") {
    return { reason: "share.readinessReasonUnchecked", advice: null } as const;
  }
  switch (item.reason) {
    case "credential-stripped":
      return {
        reason: "share.readinessReasonCredentialStripped",
        advice: "share.readinessAdviceCredential",
      } as const;
    case "auth-required":
      return {
        reason: "share.readinessReasonAuthRequired",
        advice: "share.readinessAdviceCredential",
      } as const;
    case "cors":
      return {
        reason: "share.readinessReasonCors",
        advice: "share.readinessAdviceCors",
      } as const;
    case "not-found":
      return {
        reason: "share.readinessReasonNotFound",
        advice: "share.readinessAdviceNotFound",
      } as const;
    case "local-file":
      return {
        reason: "share.readinessReasonLocalFile",
        advice: "share.readinessAdviceLocal",
      } as const;
    case "private-host":
      return {
        reason: "share.readinessReasonPrivateHost",
        advice: "share.readinessAdviceLocal",
      } as const;
    case "no-source":
      return {
        reason: "share.readinessReasonNoSource",
        advice: "share.readinessAdviceLocal",
      } as const;
    default:
      return {
        reason: "share.readinessReasonUnchecked",
        advice: null,
      } as const;
  }
}

/**
 * The React list key for a readiness row.
 *
 * Args:
 *   item: The readiness verdict.
 *
 * Returns:
 *   A key unique within one report.
 */
export function readinessReactKey(item: Pick<ShareReadinessItem, "layerId" | "field" | "url">) {
  return `${item.layerId ?? item.field}:${item.url}`;
}

/**
 * Identity of a readiness row, keyed the way summarizeShareSources keys its
 * rows: the layer id, or field plus URL for a project-level reference.
 *
 * Args:
 *   item: The readiness verdict.
 *
 * Returns:
 *   The row identity.
 */
export function readinessIdentity(item: Pick<ShareReadinessItem, "layerId" | "field" | "url">) {
  return item.layerId ?? `${item.field}:${item.url}`;
}

/** The probe report rows that are not already in the local-data warning. */
export interface RemoteReadiness {
  /** Rows to list under the probe report heading. */
  remoteProblems: ShareReadinessItem[];
  /** All remote rows, problem or not, for the "all reachable" summary. */
  remoteItemCount: number;
}

/**
 * Split the probe report from the local-data warning. The verdicts that are
 * missing for everyone have their own block above the form, so the probe
 * report lists the rest: what the network settled, plus a private-network
 * host, which may still load for the intended recipients. A row already in
 * that block is not repeated here, whatever verdict the probe summary kept.
 *
 * Args:
 *   readiness: The probe report, or null while it is pending or failed.
 *   localProblems: The rows shown in the local-data warning.
 *
 * Returns:
 *   The remote problem rows and the remote row count.
 */
export function remoteReadiness(
  readiness: ShareReadinessReport | null,
  localProblems: readonly ShareReadinessItem[],
): RemoteReadiness {
  const missingKeys = new Set(localProblems.map(readinessIdentity));
  const isRemoteRow = (item: ShareReadinessItem) =>
    !isMissingForRecipients(item) && !missingKeys.has(readinessIdentity(item));
  return {
    remoteProblems: readiness?.problems.filter(isRemoteRow) ?? [],
    remoteItemCount: readiness?.items.filter(isRemoteRow).length ?? 0,
  };
}

// Short labels for the Active Shares metadata row, where the create tab's fully
// spelled-out options ("Unlisted (anyone with the link)") would not fit. Keyed
// through `t()` rather than rendered from the raw enum with `capitalize`, which
// would leave these strings in English in every locale. `as const` keeps the
// values literal so they still typecheck against the `en.json` key union.
export const VISIBILITY_LABEL_KEYS = {
  unlisted: "share.visibilityUnlistedShort",
  public: "share.visibilityPublicShort",
  private: "share.visibilityPrivateShort",
  organization: "share.visibilityOrganizationShort",
} as const satisfies Record<ShareVisibility, string>;

export const ROLE_LABEL_KEYS = {
  view: "share.roleViewShort",
  comment: "share.roleCommentShort",
  edit: "share.roleEditShort",
} as const satisfies Record<ShareRole, string>;

// Names for the link settings a server may have ignored (see
// ShareUploadResult.unconfirmedSettings), reusing the create form's labels.
export const UNCONFIRMED_SETTING_LABEL_KEYS = {
  role: "share.role",
  expiry: "share.expiry",
  password: "share.passwordSetting",
} as const satisfies Record<ShareLinkSetting, string>;

/**
 * The comma-separated, translated names of link settings the server ignored.
 *
 * Args:
 *   settings: The unconfirmed settings from the upload result.
 *   t: The translation function.
 *
 * Returns:
 *   The joined labels.
 */
export function unconfirmedSettingsLabel(
  settings: readonly ShareLinkSetting[],
  t: TFunction,
): string {
  return settings.map((setting) => t(UNCONFIRMED_SETTING_LABEL_KEYS[setting])).join(", ");
}

/** The create form's state as it is reset each time the dialog opens. */
export interface ShareFormDefaults {
  visibility: ShareVisibility;
  role: ShareRole;
  expiresIn: ShareExpiry;
  password: string;
}

export const SHARE_FORM_DEFAULTS: Readonly<ShareFormDefaults> = {
  visibility: "public",
  role: "edit",
  expiresIn: "never",
  password: "",
};

/**
 * The title field's seed when the dialog opens: the current project name, but
 * blank when the project still has its default placeholder name so the field
 * reads as a prompt.
 *
 * Args:
 *   currentTitle: The current project name.
 *   isShareableTitle: The title predicate from share-geolibre.
 *
 * Returns:
 *   The initial title.
 */
export function initialShareTitle(
  currentTitle: string,
  isShareableTitle: (title: string) => boolean,
): string {
  return isShareableTitle(currentTitle) ? currentTitle.trim() : "";
}

/** The owner picker's derived state. */
export interface ShareOwnerState {
  /** Memberships that may own organization projects (viewers cannot). */
  ownerOrganizations: ShareOrganization[];
  selectedOrganization: ShareOrganization | null;
  publicRestriction: PublicSharingRestriction;
  /** Public visibility is selected but the organization's policy forbids it. */
  publicBlocked: boolean;
  /** Organization visibility is selected with no owning organization. */
  organizationRequired: boolean;
  /** Whether to render the owner picker at all. */
  showOwnerPicker: boolean;
  /** The caller belongs only to organizations it cannot publish into. */
  viewerOnly: boolean;
}

/**
 * Derive the owner picker state. Viewers cannot own organization projects (the
 * server answers 403), so the picker offers only memberships that can.
 *
 * Args:
 *   organizations: Every membership the server returned.
 *   selectedOrgId: The picked organization id, or null for the personal account.
 *   visibility: The selected visibility.
 *   orgLoading: Whether memberships are still loading.
 *
 * Returns:
 *   The derived owner state.
 */
export function deriveShareOwnerState(
  organizations: readonly ShareOrganization[],
  selectedOrgId: string | null,
  visibility: ShareVisibility,
  orgLoading: boolean,
): ShareOwnerState {
  const ownerOrganizations = organizations.filter(canOwnOrganizationProjects);
  const selectedOrganization =
    ownerOrganizations.find((organization) => organization.id === selectedOrgId) ?? null;
  return {
    ownerOrganizations,
    selectedOrganization,
    publicRestriction: publicSharingRestriction(selectedOrganization),
    publicBlocked: isPublicSharingBlocked(visibility, selectedOrganization),
    organizationRequired: visibility === "organization" && !selectedOrganization,
    showOwnerPicker: ownerOrganizations.length > 0 || orgLoading,
    viewerOnly: !orgLoading && organizations.length > 0 && ownerOrganizations.length === 0,
  };
}

/**
 * The translation key explaining why public visibility is unavailable.
 *
 * Args:
 *   restriction: A non-null public sharing restriction.
 *
 * Returns:
 *   The message key.
 */
export function publicRestrictionMessageKey(restriction: Exclude<PublicSharingRestriction, null>) {
  return restriction === "publisher-required"
    ? "share.publicPublisherRequired"
    : "share.publicDisabledByOrgPolicy";
}

/**
 * The visibility after the owner picker changes: an organization's default,
 * or, back on the personal account, anything but "organization".
 *
 * Args:
 *   organization: The newly picked organization, or null for the personal account.
 *   visibility: The current visibility.
 *
 * Returns:
 *   The visibility to select.
 */
export function visibilityAfterOwnerChange(
  organization: ShareOrganization | null,
  visibility: ShareVisibility,
): ShareVisibility {
  if (organization) return organization.defaultVisibility;
  return visibility === "organization" ? "unlisted" : visibility;
}

/** The create form's values that feed the upload request. */
export interface ShareUploadFormValues {
  visibility: ShareVisibility;
  selectedOrganization: ShareOrganization | null;
  selectedGroupIds: readonly string[];
  role: ShareRole;
  expiresIn: ShareExpiry;
  password: string;
}

/**
 * Build the upload request from the form, omitting the optional settings the
 * user left at their defaults so the server applies its own.
 *
 * Args:
 *   form: The create form's values.
 *   project: The serialized project and the bearer token.
 *   signal: Aborts the upload.
 *
 * Returns:
 *   The options for uploadProjectToShare.
 */
export function buildShareUploadOptions(
  form: ShareUploadFormValues,
  project: { token: string; filename: string; content: string },
  signal?: AbortSignal,
): ShareUploadOptions {
  return {
    token: project.token,
    filename: project.filename,
    content: project.content,
    visibility: form.visibility,
    organizationId: form.selectedOrganization?.id,
    groupIds: form.selectedGroupIds.length > 0 ? [...form.selectedGroupIds] : undefined,
    role: form.role,
    expiresIn: form.expiresIn !== "never" ? form.expiresIn : undefined,
    password: form.password.trim() || undefined,
    signal,
  };
}

/**
 * Whether the Share button is disabled.
 *
 * Args:
 *   state: The upload status and form validity flags.
 *
 * Returns:
 *   True when the button must not start an upload.
 */
export function isShareButtonDisabled(state: {
  uploading: boolean;
  titleValid: boolean;
  organizationRequired: boolean;
  publicBlocked: boolean;
}): boolean {
  return state.uploading || !state.titleValid || state.organizationRequired || state.publicBlocked;
}

/**
 * The Share button's label: a plain "Share", or "Share anyway" once the
 * local-data warning has listed layers that will be empty for recipients.
 *
 * Args:
 *   localProblemCount: Rows in the local-data warning.
 *
 * Returns:
 *   The label key.
 */
export function shareButtonLabelKey(localProblemCount: number) {
  return localProblemCount > 0 ? "share.shareAnyway" : "share.shareButton";
}

/** How the dialog surfaces a failed upload. */
export type ShareUploadFailure =
  | { kind: "code"; code: ShareUploadErrorCode }
  | { kind: "message"; message: string };

/**
 * Map a failed upload to what the dialog shows. A missing account username or
 * a rejected credential gets dedicated, actionable UI rather than the raw
 * server string; everything else becomes a message.
 *
 * Args:
 *   err: The thrown value (not an AbortError; the caller drops those).
 *   t: The translation function.
 *   oauthErrorKey: Resolves an OAuth error to its guidance key.
 *
 * Returns:
 *   The failure to render.
 */
export function classifyShareUploadError(
  err: unknown,
  t: TFunction,
  oauthErrorKey: OAuthErrorKeyResolver,
): ShareUploadFailure {
  if (
    err instanceof ShareUploadError &&
    (err.code === "username-required" || err.code === "unauthorized")
  ) {
    return { kind: "code", code: err.code };
  }
  const oauthKey = oauthErrorKey(err);
  if (oauthKey) return { kind: "message", message: t(oauthKey) };
  // Embedding a large local vector layer can push the project past the
  // engine's string cap; the raw "Invalid string length" told the user
  // nothing (GeoLibre#3025).
  if (isSerializationTooLargeError(err)) {
    return { kind: "message", message: t("share.errorProjectTooLarge") };
  }
  return {
    kind: "message",
    message: err instanceof Error ? err.message : t("share.errorFallback"),
  };
}

/**
 * The Manage tab's error when listing shares fails. An empty list and a
 * failed fetch are not the same thing: swallowing the error would render an
 * expired token or a dropped connection as the "no active share links" state.
 *
 * Args:
 *   err: The thrown value.
 *   t: The translation function.
 *   oauthErrorKey: Resolves an OAuth error to its guidance key.
 *
 * Returns:
 *   The message to show.
 */
export function sharesListErrorMessage(
  err: unknown,
  t: TFunction,
  oauthErrorKey: OAuthErrorKeyResolver,
): string {
  const oauthKey = oauthErrorKey(err);
  if (oauthKey) return t(oauthKey);
  return err instanceof Error ? err.message : t("share.sharesErrorFallback");
}

/**
 * The message for a failed revocation.
 *
 * Args:
 *   err: The thrown value.
 *   t: The translation function.
 *
 * Returns:
 *   The message to show.
 */
export function revokeErrorMessage(err: unknown, t: TFunction): string {
  return err instanceof Error ? err.message : t("share.revokeErrorFallback");
}

/**
 * Whether a thrown value is a fetch abort, which the dialog drops silently.
 *
 * Args:
 *   err: The thrown value.
 *
 * Returns:
 *   True for an AbortError DOMException.
 */
export function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

/**
 * Class names for a Create / Manage tab button.
 *
 * Args:
 *   active: Whether the tab is selected.
 *
 * Returns:
 *   The class string.
 */
export function shareTabClassName(active: boolean): string {
  return `px-3 py-1.5 text-sm font-medium border-b-2 ${
    active
      ? "border-primary text-foreground"
      : "border-transparent text-muted-foreground hover:text-foreground"
  }`;
}

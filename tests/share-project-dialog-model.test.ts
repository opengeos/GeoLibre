import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GeoLibreLayer } from "@geolibre/core";
import type { ParseKeys, TFunction } from "i18next";
import type { ShareOrganization } from "../apps/geolibre-desktop/src/lib/share-gallery";
import { ShareUploadError } from "../apps/geolibre-desktop/src/lib/share-geolibre";
import type {
  ShareReadinessItem,
  ShareReadinessReport,
} from "../apps/geolibre-desktop/src/lib/share-readiness";
import {
  accountSettingsUrl,
  buildShareUploadOptions,
  classifyShareUploadError,
  deriveShareOwnerState,
  initialShareTitle,
  isAbortError,
  isShareButtonDisabled,
  publicRestrictionMessageKey,
  readinessCopyKeys,
  readinessInputFromState,
  readinessLabel,
  readinessListKey,
  readinessRowKey,
  remoteReadiness,
  revokeErrorMessage,
  ROLE_LABEL_KEYS,
  SHARE_FORM_DEFAULTS,
  shareButtonLabelKey,
  sharesListErrorMessage,
  shareTabClassName,
  unconfirmedSettingsLabel,
  visibilityAfterOwnerChange,
  VISIBILITY_LABEL_KEYS,
  type OAuthErrorKeyResolver,
} from "../apps/geolibre-desktop/src/lib/share-project-dialog-model";

const fakeT = ((key: string) => `t:${key}`) as unknown as TFunction;

class FakeOAuthError extends Error {}
const oauthKey: OAuthErrorKeyResolver = (err) =>
  err instanceof FakeOAuthError ? ("share.oauthCancelled" as ParseKeys) : null;

function item(overrides: Partial<ShareReadinessItem> = {}): ShareReadinessItem {
  return {
    layerId: "layer-1",
    label: "Roads",
    field: "sourceUrl",
    status: "blocked",
    reason: "cors",
    url: "https://example.com/roads.pmtiles",
    ...overrides,
  };
}

function org(overrides: Partial<ShareOrganization> = {}): ShareOrganization {
  return {
    id: "org-1",
    slug: "acme",
    name: "Acme",
    publicSharingPolicy: "yes",
    defaultVisibility: "organization",
    categories: [],
    role: "member",
    ...overrides,
  };
}

describe("accountSettingsUrl", () => {
  it("appends /settings to the share host", () => {
    assert.equal(
      accountSettingsUrl("https://share.example.org"),
      "https://share.example.org/settings",
    );
  });

  it("is null when no share host is configured", () => {
    assert.equal(accountSettingsUrl(null), null);
    assert.equal(accountSettingsUrl(""), null);
  });
});

describe("readinessInputFromState", () => {
  const layers = [{ id: "a" }, { id: "b" }, { id: "c" }] as unknown as GeoLibreLayer[];

  it("collects the basemap, plugin manifests, and embeddable layer ids", () => {
    const input = readinessInputFromState(
      {
        layers,
        basemapVisible: true,
        basemapStyleUrl: "https://tiles.example.com/style.json",
        projectPlugins: { manifestUrls: ["https://example.com/plugin.json"] },
      },
      (layer) => layer.id !== "b",
    );
    assert.equal(input.layers, layers);
    assert.equal(input.basemapStyleUrl, "https://tiles.example.com/style.json");
    assert.deepEqual(input.pluginManifestUrls, ["https://example.com/plugin.json"]);
    assert.deepEqual([...(input.embeddedLayerIds ?? [])], ["a", "c"]);
  });

  it("skips a hidden basemap and defaults missing plugin state", () => {
    const input = readinessInputFromState(
      {
        layers,
        basemapVisible: false,
        basemapStyleUrl: "https://x/style.json",
        projectPlugins: null,
      },
      () => false,
    );
    assert.equal(input.basemapStyleUrl, null);
    assert.deepEqual(input.pluginManifestUrls, []);
    assert.equal(input.embeddedLayerIds?.size, 0);
  });
});

describe("readinessLabel", () => {
  it("uses the layer's own label when present", () => {
    assert.equal(readinessLabel(item({ label: "Parcels" }), fakeT), "Parcels");
  });

  it("labels project-level references by field", () => {
    assert.equal(
      readinessLabel(item({ label: "", field: "basemapStyleUrl" }), fakeT),
      "t:share.readinessBasemapLabel",
    );
    assert.equal(
      readinessLabel(item({ label: "", field: "pluginManifestUrls" }), fakeT),
      "t:share.readinessPluginLabel",
    );
  });
});

describe("readinessCopyKeys", () => {
  it("short-circuits an unchecked verdict whatever its reason", () => {
    assert.deepEqual(readinessCopyKeys(item({ status: "unchecked", reason: "cors" })), {
      reason: "share.readinessReasonUnchecked",
      advice: null,
    });
  });

  it("maps each reason to its reason and advice keys", () => {
    const cases: Array<[string, string, string]> = [
      [
        "credential-stripped",
        "share.readinessReasonCredentialStripped",
        "share.readinessAdviceCredential",
      ],
      ["auth-required", "share.readinessReasonAuthRequired", "share.readinessAdviceCredential"],
      ["cors", "share.readinessReasonCors", "share.readinessAdviceCors"],
      ["not-found", "share.readinessReasonNotFound", "share.readinessAdviceNotFound"],
      ["local-file", "share.readinessReasonLocalFile", "share.readinessAdviceLocal"],
      ["private-host", "share.readinessReasonPrivateHost", "share.readinessAdviceLocal"],
      ["no-source", "share.readinessReasonNoSource", "share.readinessAdviceLocal"],
    ];
    for (const [reason, reasonKey, adviceKey] of cases) {
      assert.deepEqual(
        readinessCopyKeys(item({ reason: reason as ShareReadinessItem["reason"] })),
        { reason: reasonKey, advice: adviceKey },
        reason,
      );
    }
  });

  it("falls back to the unchecked copy for an unknown reason", () => {
    assert.deepEqual(
      readinessCopyKeys(item({ reason: "something-new" as ShareReadinessItem["reason"] })),
      { reason: "share.readinessReasonUnchecked", advice: null },
    );
  });
});

describe("readiness row keys", () => {
  it("keys a layer row by layer id and a project row by field plus URL", () => {
    assert.equal(readinessRowKey(item()), "layer-1");
    assert.equal(
      readinessRowKey(item({ layerId: null, field: "basemapStyleUrl", url: "https://s" })),
      "basemapStyleUrl:https://s",
    );
  });

  it("builds list keys that include the URL for layer rows too", () => {
    assert.equal(readinessListKey(item()), "layer-1:https://example.com/roads.pmtiles");
    assert.equal(
      readinessListKey(item({ layerId: null, field: "basemapStyleUrl", url: "https://s" })),
      "basemapStyleUrl:https://s",
    );
  });
});

describe("remoteReadiness", () => {
  it("is empty without a report", () => {
    assert.deepEqual(remoteReadiness(null, []), {
      remoteProblems: [],
      remoteItemCount: 0,
    });
  });

  it("drops rows missing for everyone and rows already in the local warning", () => {
    const reachable = item({ layerId: "ok", status: "reachable" });
    const cors = item({ layerId: "cors" });
    const localFile = item({
      layerId: "local",
      status: "local",
      reason: "local-file",
    });
    const privateHost = item({
      layerId: "intranet",
      status: "local",
      reason: "private-host",
    });
    const alreadyWarned = item({ layerId: "warned" });
    const report: ShareReadinessReport = {
      items: [reachable, cors, localFile, privateHost, alreadyWarned],
      problems: [cors, localFile, privateHost, alreadyWarned],
      probeCount: 3,
      truncated: false,
    };
    const result = remoteReadiness(report, [item({ layerId: "warned", status: "local" })]);
    assert.deepEqual(
      result.remoteProblems.map((row) => row.layerId),
      ["cors", "intranet"],
    );
    assert.equal(result.remoteItemCount, 3);
  });
});

describe("label maps", () => {
  it("covers every visibility and role", () => {
    assert.deepEqual(Object.keys(VISIBILITY_LABEL_KEYS).sort(), [
      "organization",
      "private",
      "public",
      "unlisted",
    ]);
    assert.deepEqual(Object.keys(ROLE_LABEL_KEYS).sort(), ["comment", "edit", "view"]);
  });

  it("joins translated unconfirmed setting names", () => {
    assert.equal(
      unconfirmedSettingsLabel(["role", "expiry", "password"], fakeT),
      "t:share.role, t:share.expiry, t:share.passwordSetting",
    );
    assert.equal(unconfirmedSettingsLabel([], fakeT), "");
  });
});

describe("form defaults", () => {
  it("defaults to a public, editable, non-expiring link without a password", () => {
    assert.deepEqual(SHARE_FORM_DEFAULTS, {
      visibility: "public",
      role: "edit",
      expiresIn: "never",
      password: "",
    });
  });

  it("seeds the title only from a shareable project name", () => {
    const shareable = (title: string) => title.trim() !== "" && title.trim() !== "Untitled";
    assert.equal(initialShareTitle("  My Map  ", shareable), "My Map");
    assert.equal(initialShareTitle("Untitled", shareable), "");
  });
});

describe("deriveShareOwnerState", () => {
  it("offers only organizations the caller can own projects in", () => {
    const state = deriveShareOwnerState(
      [org({ id: "a" }), org({ id: "b", role: "viewer" })],
      "b",
      "unlisted",
      false,
    );
    assert.deepEqual(
      state.ownerOrganizations.map((o) => o.id),
      ["a"],
    );
    // A viewer membership cannot be selected as owner.
    assert.equal(state.selectedOrganization, null);
    assert.equal(state.showOwnerPicker, true);
    assert.equal(state.viewerOnly, false);
  });

  it("requires an organization for organization visibility", () => {
    assert.equal(deriveShareOwnerState([], null, "organization", false).organizationRequired, true);
    assert.equal(
      deriveShareOwnerState([org()], "org-1", "organization", false).organizationRequired,
      false,
    );
  });

  it("blocks public visibility under a restrictive organization policy", () => {
    const state = deriveShareOwnerState(
      [org({ publicSharingPolicy: "no" })],
      "org-1",
      "public",
      false,
    );
    assert.equal(state.publicRestriction, "organization-disabled");
    assert.equal(state.publicBlocked, true);
    assert.equal(
      deriveShareOwnerState([org({ publicSharingPolicy: "no" })], "org-1", "unlisted", false)
        .publicBlocked,
      false,
    );
  });

  it("flags viewer-only memberships once loading finishes", () => {
    const viewer = [org({ role: "viewer" })];
    assert.equal(deriveShareOwnerState(viewer, null, "public", false).viewerOnly, true);
    assert.equal(deriveShareOwnerState(viewer, null, "public", false).showOwnerPicker, false);
    const loading = deriveShareOwnerState(viewer, null, "public", true);
    assert.equal(loading.viewerOnly, false);
    assert.equal(loading.showOwnerPicker, true);
  });
});

describe("publicRestrictionMessageKey", () => {
  it("names the restriction", () => {
    assert.equal(
      publicRestrictionMessageKey("publisher-required"),
      "share.publicPublisherRequired",
    );
    assert.equal(
      publicRestrictionMessageKey("organization-disabled"),
      "share.publicDisabledByOrgPolicy",
    );
  });
});

describe("visibilityAfterOwnerChange", () => {
  it("adopts the organization's default visibility", () => {
    assert.equal(
      visibilityAfterOwnerChange(org({ defaultVisibility: "private" }), "public"),
      "private",
    );
  });

  it("leaves organization visibility when switching back to the personal account", () => {
    assert.equal(visibilityAfterOwnerChange(null, "organization"), "unlisted");
    assert.equal(visibilityAfterOwnerChange(null, "private"), "private");
  });
});

describe("buildShareUploadOptions", () => {
  const project = {
    token: "tok",
    filename: "map.geolibre.json",
    content: "{}",
  };

  it("omits settings left at their defaults", () => {
    const options = buildShareUploadOptions(
      {
        visibility: "public",
        selectedOrganization: null,
        selectedGroupIds: [],
        role: "edit",
        expiresIn: "never",
        password: "   ",
      },
      project,
    );
    assert.deepEqual(options, {
      token: "tok",
      filename: "map.geolibre.json",
      content: "{}",
      visibility: "public",
      organizationId: undefined,
      groupIds: undefined,
      role: "edit",
      expiresIn: undefined,
      password: undefined,
      signal: undefined,
    });
  });

  it("passes the chosen owner, groups, expiry, trimmed password, and signal", () => {
    const controller = new AbortController();
    const options = buildShareUploadOptions(
      {
        visibility: "organization",
        selectedOrganization: org({ id: "org-9" }),
        selectedGroupIds: ["g1", "g2"],
        role: "view",
        expiresIn: "7d",
        password: " secret ",
      },
      project,
      controller.signal,
    );
    assert.equal(options.organizationId, "org-9");
    assert.deepEqual(options.groupIds, ["g1", "g2"]);
    assert.equal(options.role, "view");
    assert.equal(options.expiresIn, "7d");
    assert.equal(options.password, "secret");
    assert.equal(options.signal, controller.signal);
  });
});

describe("share button", () => {
  const ready = {
    uploading: false,
    titleValid: true,
    organizationRequired: false,
    publicBlocked: false,
  };

  it("is enabled only when nothing blocks the upload", () => {
    assert.equal(isShareButtonDisabled(ready), false);
    assert.equal(isShareButtonDisabled({ ...ready, uploading: true }), true);
    assert.equal(isShareButtonDisabled({ ...ready, titleValid: false }), true);
    assert.equal(isShareButtonDisabled({ ...ready, organizationRequired: true }), true);
    assert.equal(isShareButtonDisabled({ ...ready, publicBlocked: true }), true);
  });

  it("reads 'Share anyway' once local-only layers are listed", () => {
    assert.equal(shareButtonLabelKey(0), "share.shareButton");
    assert.equal(shareButtonLabelKey(2), "share.shareAnyway");
  });
});

describe("classifyShareUploadError", () => {
  it("routes username and credential failures to dedicated UI", () => {
    assert.deepEqual(
      classifyShareUploadError(
        new ShareUploadError("no user", "username-required"),
        fakeT,
        oauthKey,
      ),
      { kind: "code", code: "username-required" },
    );
    assert.deepEqual(
      classifyShareUploadError(new ShareUploadError("401", "unauthorized"), fakeT, oauthKey),
      { kind: "code", code: "unauthorized" },
    );
  });

  it("translates OAuth errors and oversized projects", () => {
    assert.deepEqual(classifyShareUploadError(new FakeOAuthError("x"), fakeT, oauthKey), {
      kind: "message",
      message: "t:share.oauthCancelled",
    });
    assert.deepEqual(
      classifyShareUploadError(new RangeError("Invalid string length"), fakeT, oauthKey),
      { kind: "message", message: "t:share.errorProjectTooLarge" },
    );
  });

  it("falls back to the raw message, then a generic one", () => {
    assert.deepEqual(
      classifyShareUploadError(new ShareUploadError("Server said no"), fakeT, oauthKey),
      { kind: "message", message: "Server said no" },
    );
    assert.deepEqual(classifyShareUploadError("boom", fakeT, oauthKey), {
      kind: "message",
      message: "t:share.errorFallback",
    });
  });
});

describe("list and revoke error messages", () => {
  it("maps a list failure", () => {
    assert.equal(
      sharesListErrorMessage(new FakeOAuthError(), fakeT, oauthKey),
      "t:share.oauthCancelled",
    );
    assert.equal(sharesListErrorMessage(new Error("offline"), fakeT, oauthKey), "offline");
    assert.equal(sharesListErrorMessage(42, fakeT, oauthKey), "t:share.sharesErrorFallback");
  });

  it("maps a revoke failure", () => {
    assert.equal(revokeErrorMessage(new Error("gone"), fakeT), "gone");
    assert.equal(revokeErrorMessage(null, fakeT), "t:share.revokeErrorFallback");
  });
});

describe("isAbortError", () => {
  it("recognizes only an AbortError DOMException", () => {
    assert.equal(isAbortError(new DOMException("aborted", "AbortError")), true);
    assert.equal(isAbortError(new DOMException("nope", "NetworkError")), false);
    assert.equal(isAbortError(new Error("AbortError")), false);
  });
});

describe("shareTabClassName", () => {
  it("highlights the active tab only", () => {
    assert.match(shareTabClassName(true), /border-primary text-foreground/);
    assert.match(shareTabClassName(false), /border-transparent text-muted-foreground/);
  });
});

import { Button, Input, Label, Select } from "@geolibre/ui";
import { Check, Cloud, ExternalLink, Loader2, LogIn, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { credentialStorageLocation } from "../../lib/credential-store";
import { isTauri } from "../../lib/is-tauri";
import { openExternalLink } from "../../lib/open-external";
import {
  createS3Connection,
  DESKTOP_ONLY_S3_SOURCES,
  needsDesktopResolution,
  normalizeS3DefaultLocation,
  parseBucketPatterns,
  S3_CREDENTIAL_SOURCES,
  type S3Connection,
  type S3CredentialSource,
} from "../../lib/s3-connections";
import {
  listAwsProfiles,
  signInWithAwsSso,
  testS3Connection,
  type AwsProfileSummary,
} from "../../lib/s3-signer";

interface CloudStorageSectionProps {
  connections: S3Connection[];
  onChange: (connections: S3Connection[]) => void;
  /** Where the S3 Browser opens (`s3://bucket/prefix/`), or "". */
  defaultLocation: string;
  onDefaultLocationChange: (location: string) => void;
}

type TestState =
  | { status: "idle" }
  | { status: "running" }
  | { status: "ok"; message: string }
  | { status: "error"; message: string };

function newConnectionId(): string {
  return `s3-${crypto.randomUUID().slice(0, 8)}`;
}

/**
 * Settings → Cloud Storage: the S3 connections that sign reads of private
 * buckets, matched to buckets by name pattern.
 */
export function CloudStorageSection({
  connections,
  onChange,
  defaultLocation,
  onDefaultLocationChange,
}: CloudStorageSectionProps) {
  const { t } = useTranslation();
  const desktop = isTauri();
  const keychain = credentialStorageLocation() === "keychain";
  const [expandedId, setExpandedId] = useState<string | null>(connections[0]?.id ?? null);
  const [profiles, setProfiles] = useState<AwsProfileSummary[]>([]);
  const [profilesError, setProfilesError] = useState<string | null>(null);
  const [tests, setTests] = useState<Record<string, TestState>>({});
  const [ssoCode, setSsoCode] = useState<{ id: string; uri: string; code: string } | null>(null);

  const refreshProfiles = () => {
    if (!desktop) return;
    setProfilesError(null);
    listAwsProfiles().then(setProfiles, (error: unknown) =>
      setProfilesError(error instanceof Error ? error.message : String(error)),
    );
  };
  useEffect(refreshProfiles, [desktop]);

  const update = (id: string, patch: Partial<S3Connection>) => {
    onChange(
      connections.map((connection) =>
        connection.id === id ? { ...connection, ...patch } : connection,
      ),
    );
    setTests((current) => ({ ...current, [id]: { status: "idle" } }));
  };

  const add = () => {
    const connection = createS3Connection(
      newConnectionId(),
      t("settings.cloudStorage.defaultName", { count: connections.length + 1 }),
    );
    if (desktop && profiles.length > 0) connection.source = "profile";
    onChange([...connections, connection]);
    setExpandedId(connection.id);
  };

  const remove = (id: string) => {
    onChange(connections.filter((connection) => connection.id !== id));
    if (expandedId === id) setExpandedId(null);
  };

  const runTest = async (connection: S3Connection) => {
    setTests((current) => ({ ...current, [connection.id]: { status: "running" } }));
    try {
      const result = await testS3Connection(connection);
      const message =
        result.kind === "listed"
          ? t("settings.cloudStorage.testListed", { bucket: result.bucket })
          : result.accessKeyHint
            ? t("settings.cloudStorage.testCredentials", { hint: result.accessKeyHint })
            : t("settings.cloudStorage.testAnonymous");
      setTests((current) => ({ ...current, [connection.id]: { status: "ok", message } }));
    } catch (error) {
      setTests((current) => ({
        ...current,
        [connection.id]: {
          status: "error",
          message: error instanceof Error ? error.message : String(error),
        },
      }));
    }
  };

  const signIn = async (connection: S3Connection) => {
    setTests((current) => ({ ...current, [connection.id]: { status: "running" } }));
    try {
      await signInWithAwsSso(connection.profile || "default", (uri, code) => {
        setSsoCode({ id: connection.id, uri, code });
        void openExternalLink(uri);
      });
      setSsoCode(null);
      await runTest(connection);
    } catch (error) {
      setSsoCode(null);
      setTests((current) => ({
        ...current,
        [connection.id]: {
          status: "error",
          message: error instanceof Error ? error.message : String(error),
        },
      }));
    }
  };

  const sourceLabel = (source: S3CredentialSource) => t(`settings.cloudStorage.source.${source}`);

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <h3 className="text-sm font-semibold">{t("settings.cloudStorage.title")}</h3>
        <p className="text-xs text-muted-foreground">{t("settings.cloudStorage.description")}</p>
        {!desktop ? (
          <p className="text-xs text-muted-foreground">{t("settings.cloudStorage.corsNote")}</p>
        ) : null}
      </div>

      {connections.length === 0 ? (
        <p className="rounded-md border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">
          {t("settings.cloudStorage.empty")}
        </p>
      ) : null}

      {connections.map((connection) => {
        const expanded = expandedId === connection.id;
        const test = tests[connection.id] ?? { status: "idle" };
        const profile = profiles.find((item) => item.name === (connection.profile || "default"));
        const unavailable = !desktop && needsDesktopResolution(connection);
        const fieldId = (name: string) => `s3-${connection.id}-${name}`;
        return (
          <div key={connection.id} className="rounded-md border" data-testid="s3-connection">
            <button
              type="button"
              className="flex w-full items-center gap-2 px-3 py-2 text-start"
              aria-expanded={expanded}
              onClick={() => setExpandedId(expanded ? null : connection.id)}
            >
              <Cloud className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-sm font-medium">{connection.name}</span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {sourceLabel(connection.source)} ·{" "}
                {connection.buckets.length > 0
                  ? connection.buckets.join(", ")
                  : t("settings.cloudStorage.allBuckets")}
              </span>
            </button>
            {expanded ? (
              <div className="space-y-3 border-t px-3 py-3">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor={fieldId("name")}>{t("settings.cloudStorage.name")}</Label>
                    <Input
                      id={fieldId("name")}
                      value={connection.name}
                      onChange={(event) => update(connection.id, { name: event.target.value })}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor={fieldId("source")}>
                      {t("settings.cloudStorage.sourceLabel")}
                    </Label>
                    <Select
                      id={fieldId("source")}
                      value={connection.source}
                      onChange={(event) =>
                        update(connection.id, { source: event.target.value as S3CredentialSource })
                      }
                    >
                      {S3_CREDENTIAL_SOURCES.map((source) => (
                        <option
                          key={source}
                          value={source}
                          disabled={!desktop && DESKTOP_ONLY_S3_SOURCES.has(source)}
                        >
                          {sourceLabel(source)}
                        </option>
                      ))}
                    </Select>
                  </div>
                </div>

                {unavailable ? (
                  <p className="text-xs text-destructive">
                    {t("settings.cloudStorage.desktopOnly")}
                  </p>
                ) : null}

                {connection.source === "profile" ? (
                  <div className="space-y-1.5">
                    <Label htmlFor={fieldId("profile")}>{t("settings.cloudStorage.profile")}</Label>
                    <div className="flex gap-2">
                      <Input
                        id={fieldId("profile")}
                        list={fieldId("profiles")}
                        value={connection.profile}
                        placeholder={t("settings.cloudStorage.profilePlaceholder")}
                        onChange={(event) => update(connection.id, { profile: event.target.value })}
                      />
                      <datalist id={fieldId("profiles")}>
                        {profiles.map((item) => (
                          <option key={item.name} value={item.name}>
                            {item.name} ({t(`settings.cloudStorage.profileKind.${item.kind}`)})
                          </option>
                        ))}
                      </datalist>
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        onClick={refreshProfiles}
                        title={t("settings.cloudStorage.refreshProfiles")}
                        aria-label={t("settings.cloudStorage.refreshProfiles")}
                      >
                        <RefreshCw className="h-4 w-4" />
                      </Button>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {profile
                        ? t("settings.cloudStorage.profileFound", {
                            kind: t(`settings.cloudStorage.profileKind.${profile.kind}`),
                          })
                        : t("settings.cloudStorage.profileHelp")}
                    </p>
                    {profilesError ? (
                      <p className="text-xs text-destructive">{profilesError}</p>
                    ) : null}
                  </div>
                ) : null}

                {connection.source === "environment" ? (
                  <p className="text-xs text-muted-foreground">
                    {t("settings.cloudStorage.environmentHelp")}
                  </p>
                ) : null}

                {connection.source === "keys" ? (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label htmlFor={fieldId("key")}>
                        {t("settings.cloudStorage.accessKeyId")}
                      </Label>
                      <Input
                        id={fieldId("key")}
                        value={connection.accessKeyId}
                        autoComplete="off"
                        spellCheck={false}
                        onChange={(event) =>
                          update(connection.id, { accessKeyId: event.target.value.trim() })
                        }
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor={fieldId("secret")}>
                        {t("settings.cloudStorage.secretAccessKey")}
                      </Label>
                      <Input
                        id={fieldId("secret")}
                        type="password"
                        autoComplete="new-password"
                        value={connection.secretAccessKey}
                        onChange={(event) =>
                          update(connection.id, { secretAccessKey: event.target.value.trim() })
                        }
                      />
                    </div>
                    <div className="space-y-1.5 sm:col-span-2">
                      <Label htmlFor={fieldId("token")}>
                        {t("settings.cloudStorage.sessionToken")}
                      </Label>
                      <Input
                        id={fieldId("token")}
                        type="password"
                        autoComplete="new-password"
                        value={connection.sessionToken}
                        placeholder={t("addData.common.optional")}
                        onChange={(event) =>
                          update(connection.id, { sessionToken: event.target.value.trim() })
                        }
                      />
                      <p className="text-xs text-muted-foreground">
                        {keychain
                          ? t("settings.cloudStorage.storageNoteKeychain")
                          : t("settings.cloudStorage.storageNote")}
                      </p>
                    </div>
                  </div>
                ) : null}

                {connection.source === "instance" ? (
                  <p className="text-xs text-muted-foreground">
                    {t("settings.cloudStorage.instanceHelp")}
                  </p>
                ) : null}

                {connection.source !== "anonymous" ? (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label htmlFor={fieldId("role")}>{t("settings.cloudStorage.roleArn")}</Label>
                      <Input
                        id={fieldId("role")}
                        value={connection.roleArn}
                        spellCheck={false}
                        placeholder="arn:aws:iam::123456789012:role/Reader"
                        onChange={(event) =>
                          update(connection.id, { roleArn: event.target.value.trim() })
                        }
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor={fieldId("external")}>
                        {t("settings.cloudStorage.externalId")}
                      </Label>
                      <Input
                        id={fieldId("external")}
                        value={connection.externalId}
                        spellCheck={false}
                        placeholder={t("addData.common.optional")}
                        disabled={!connection.roleArn}
                        onChange={(event) =>
                          update(connection.id, { externalId: event.target.value.trim() })
                        }
                      />
                    </div>
                    <p className="text-xs text-muted-foreground sm:col-span-2">
                      {t("settings.cloudStorage.roleHelp")}
                    </p>
                  </div>
                ) : null}

                <div className="space-y-1.5">
                  <Label htmlFor={fieldId("buckets")}>{t("settings.cloudStorage.buckets")}</Label>
                  <Input
                    id={fieldId("buckets")}
                    // Uncontrolled so typing is not re-parsed per keystroke;
                    // keyed so a re-seeded draft replaces stale text.
                    key={connection.buckets.join(",")}
                    defaultValue={connection.buckets.join(", ")}
                    placeholder={t("settings.cloudStorage.bucketsPlaceholder")}
                    onBlur={(event) =>
                      update(connection.id, { buckets: parseBucketPatterns(event.target.value) })
                    }
                  />
                  <p className="text-xs text-muted-foreground">
                    {t("settings.cloudStorage.bucketsHelp")}
                  </p>
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor={fieldId("region")}>{t("settings.cloudStorage.region")}</Label>
                    <Input
                      id={fieldId("region")}
                      value={connection.region}
                      placeholder={t("settings.cloudStorage.regionPlaceholder")}
                      onChange={(event) =>
                        update(connection.id, { region: event.target.value.trim().toLowerCase() })
                      }
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor={fieldId("endpoint")}>
                      {t("settings.cloudStorage.endpoint")}
                    </Label>
                    <Input
                      id={fieldId("endpoint")}
                      value={connection.endpoint}
                      placeholder={t("settings.cloudStorage.endpointPlaceholder")}
                      onChange={(event) =>
                        update(connection.id, { endpoint: event.target.value.trim() })
                      }
                    />
                  </div>
                </div>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={connection.pathStyle}
                    onChange={(event) => update(connection.id, { pathStyle: event.target.checked })}
                  />
                  {t("settings.cloudStorage.pathStyle")}
                </label>

                {ssoCode?.id === connection.id ? (
                  <div className="rounded-md bg-muted px-3 py-2 text-xs">
                    <p>{t("settings.cloudStorage.ssoCode", { code: ssoCode.code })}</p>
                    <button
                      type="button"
                      className="mt-1 inline-flex items-center gap-1 underline"
                      onClick={() => void openExternalLink(ssoCode.uri)}
                    >
                      {t("settings.cloudStorage.ssoOpen")}
                      <ExternalLink className="h-3 w-3" />
                    </button>
                  </div>
                ) : null}

                {test.status === "ok" ? (
                  <p className="flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
                    <Check className="h-3.5 w-3.5" />
                    {test.message}
                  </p>
                ) : test.status === "error" ? (
                  <p className="break-words text-xs text-destructive" role="alert">
                    {test.message}
                  </p>
                ) : null}

                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={test.status === "running" || unavailable}
                    onClick={() => void runTest(connection)}
                  >
                    {test.status === "running" ? (
                      <Loader2 className="me-1 h-4 w-4 animate-spin" />
                    ) : null}
                    {t("settings.cloudStorage.test")}
                  </Button>
                  {desktop && connection.source === "profile" && profile?.kind === "sso" ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={test.status === "running"}
                      onClick={() => void signIn(connection)}
                    >
                      <LogIn className="me-1 h-4 w-4" />
                      {t("settings.cloudStorage.ssoSignIn")}
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="ms-auto text-destructive"
                    onClick={() => remove(connection.id)}
                  >
                    <Trash2 className="me-1 h-4 w-4" />
                    {t("settings.cloudStorage.remove")}
                  </Button>
                </div>
              </div>
            ) : null}
          </div>
        );
      })}

      <Button type="button" variant="outline" size="sm" onClick={add}>
        <Plus className="me-1 h-4 w-4" />
        {t("settings.cloudStorage.add")}
      </Button>

      <div className="space-y-1.5 border-t pt-4">
        <Label htmlFor="s3-default-location">{t("settings.cloudStorage.defaultLocation")}</Label>
        <Input
          id="s3-default-location"
          value={defaultLocation}
          spellCheck={false}
          placeholder="s3://bucket/prefix/"
          onChange={(event) => onDefaultLocationChange(event.target.value)}
          onBlur={(event) =>
            onDefaultLocationChange(normalizeS3DefaultLocation(event.target.value))
          }
        />
        <p className="text-xs text-muted-foreground">
          {t("settings.cloudStorage.defaultLocationHelp")}
        </p>
      </div>
    </div>
  );
}

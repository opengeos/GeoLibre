import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { registerS3UrlSigner } from "../packages/core/src/s3";
import {
  createS3Connection,
  isS3ConnectionComplete,
  matchS3Connection,
  needsDesktopResolution,
  normalizeS3Connections,
  normalizeS3DefaultLocation,
  parseBucketPatterns,
  type S3Connection,
} from "../apps/geolibre-desktop/src/lib/s3-connections";
import {
  desktopSettingsSecretAccounts,
  mergeDesktopSettingsSecrets,
  splitDesktopSettingsSecrets,
} from "../apps/geolibre-desktop/src/lib/desktop-settings-secrets";
import { normalizeDesktopSettings } from "../apps/geolibre-desktop/src/hooks/useDesktopSettings";
import { resolveCloudUrls } from "../apps/geolibre-desktop/src/lib/sql-cloud-urls";

function connection(id: string, patch: Partial<S3Connection> = {}): S3Connection {
  return { ...createS3Connection(id, id), ...patch };
}

describe("S3 connections", () => {
  it("parses bucket lists in any separator and s3:// form", () => {
    assert.deepEqual(parseBucketPatterns("a, s3://b/prefix  c-*\nbad/name a"), [
      "a",
      "b",
      "c-*",
      "bad",
    ]);
  });

  it("normalizes stored connections, dropping invalid and duplicate ids", () => {
    const normalized = normalizeS3Connections([
      { id: "one", name: " One ", source: "profile", buckets: ["x"], region: "US-WEST-2" },
      { id: "one", name: "dup" },
      { id: "bad id!" },
      { id: "two", source: "nonsense", roleArn: " arn:aws:iam::123456789012:role/R " },
      "junk",
    ]);
    assert.equal(normalized.length, 2);
    assert.equal(normalized[0].name, "One");
    assert.equal(normalized[0].region, "us-west-2");
    assert.equal(normalized[1].source, "keys");
    assert.equal(normalized[1].roleArn, "arn:aws:iam::123456789012:role/R");
  });

  it("prefers exact bucket names, then wildcards, then the catch-all", () => {
    const connections = [
      connection("all"),
      connection("wild", { buckets: ["data-*"] }),
      connection("exact", { buckets: ["data-prod"] }),
    ];
    assert.equal(matchS3Connection(connections, "data-prod")?.id, "exact");
    assert.equal(matchS3Connection(connections, "DATA-dev")?.id, "wild");
    assert.equal(matchS3Connection(connections, "other")?.id, "all");
    assert.equal(matchS3Connection([connection("x", { buckets: ["y"] })], "z"), null);
  });

  it("knows which connections need the desktop app", () => {
    assert.equal(needsDesktopResolution(connection("k")), false);
    assert.equal(needsDesktopResolution(connection("p", { source: "profile" })), true);
    assert.equal(needsDesktopResolution(connection("i", { source: "instance" })), true);
    assert.equal(
      needsDesktopResolution(connection("r", { roleArn: "arn:aws:iam::123456789012:role/R" })),
      true,
    );
    assert.equal(
      needsDesktopResolution(connection("a", { source: "anonymous", roleArn: "arn:x" })),
      false,
    );
  });

  it("checks keys and role ARNs before resolving", () => {
    assert.equal(isS3ConnectionComplete(connection("k")), false);
    const keys = connection("k", { accessKeyId: "A", secretAccessKey: "S" });
    assert.equal(isS3ConnectionComplete(keys), true);
    assert.equal(isS3ConnectionComplete({ ...keys, roleArn: "not-an-arn" }), false);
    assert.equal(
      isS3ConnectionComplete({ ...keys, roleArn: "arn:aws:iam::123456789012:role/path/R" }),
      true,
    );
  });

  it("normalizes the default browser location to a folder URI", () => {
    assert.equal(normalizeS3DefaultLocation("my-bucket/data"), "s3://my-bucket/data/");
    assert.equal(normalizeS3DefaultLocation(" s3://my-bucket "), "s3://my-bucket/");
    assert.equal(normalizeS3DefaultLocation("s3://bkt/x/"), "s3://bkt/x/");
    assert.equal(normalizeS3DefaultLocation("!!"), "");
    assert.equal(normalizeS3DefaultLocation(42), "");
  });
});

describe("S3 connection secrets", () => {
  it("keeps secret keys and session tokens out of the stored settings blob", () => {
    const settings = normalizeDesktopSettings({
      s3Connections: [
        {
          id: "s3-a",
          name: "A",
          accessKeyId: "AKIA",
          secretAccessKey: "secret",
          sessionToken: "token",
          roleArn: "arn:aws:iam::123456789012:role/R",
        },
      ],
      s3DefaultLocation: "bucket/prefix",
    });
    assert.equal(settings.s3DefaultLocation, "s3://bucket/prefix/");
    const { publicSettings, secrets } = splitDesktopSettingsSecrets(settings);
    assert.equal(publicSettings.s3Connections[0].secretAccessKey, "");
    assert.equal(publicSettings.s3Connections[0].sessionToken, "");
    assert.equal(publicSettings.s3Connections[0].accessKeyId, "AKIA");
    assert.equal(publicSettings.s3Connections[0].roleArn, "arn:aws:iam::123456789012:role/R");
    assert.deepEqual(secrets, {
      "s3.s3-a.secretAccessKey": "secret",
      "s3.s3-a.sessionToken": "token",
    });
    assert.ok(desktopSettingsSecretAccounts(settings).includes("s3.s3-a.secretAccessKey"));
    const merged = mergeDesktopSettingsSecrets(publicSettings, secrets);
    assert.equal(merged.s3Connections[0].secretAccessKey, "secret");
    assert.equal(merged.s3Connections[0].sessionToken, "token");
  });
});

describe("SQL cloud URLs", () => {
  it("leaves cloud URLs in quoted identifiers and comments alone", async () => {
    const sql = `SELECT 1 AS "s3://not-a-source/key" -- s3://nor/this`;
    assert.equal(await resolveCloudUrls(sql), sql);
  });

  afterEach(() => registerS3UrlSigner(null));

  it("signs covered buckets and rewrites the rest to public HTTPS", async () => {
    registerS3UrlSigner({
      covers: (bucket) => bucket === "private",
      connections: () => [],
      presign: async ({ key }) => ({
        href: `https://private.s3.amazonaws.com/${key}?X-Amz-Signature=sig`,
        expiresAt: Date.now() + 60_000,
      }),
    });
    const sql = await resolveCloudUrls(
      "SELECT * FROM read_parquet('s3://private/a.parquet') JOIN read_parquet('s3://pub/b.parquet') USING (id) -- s3://private/c",
    );
    assert.equal(
      sql,
      "SELECT * FROM read_parquet('https://private.s3.amazonaws.com/a.parquet?X-Amz-Signature=sig') JOIN read_parquet('https://pub.s3.amazonaws.com/b.parquet') USING (id) -- s3://private/c",
    );
  });
});

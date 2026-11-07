import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  PROJECT_STORAGE_ENV,
  resolveProjectStorage,
} from "../apps/geolibre-desktop/src/lib/project-storage";
import {
  DEFAULT_SHARE_BASE_URL,
  SHARE_URL_ENV,
} from "../apps/geolibre-desktop/src/lib/share-geolibre";

describe("resolveProjectStorage", () => {
  it("defaults to 'local' when unset or blank", () => {
    assert.equal(resolveProjectStorage(undefined, {}), "local");
    assert.equal(resolveProjectStorage("", {}), "local");
    assert.equal(resolveProjectStorage("   ", {}), "local");
  });

  it("returns 'local' when explicitly set to 'local'", () => {
    assert.equal(resolveProjectStorage("local", {}), "local");
    assert.equal(resolveProjectStorage("Local", {}), "local");
    assert.equal(resolveProjectStorage("LOCAL", {}), "local");
  });

  it("returns 'local' for unknown or invalid values", () => {
    assert.equal(resolveProjectStorage("cloud", {}), "local");
    assert.equal(resolveProjectStorage("remote", {}), "local");
    assert.equal(resolveProjectStorage("true", {}), "local");
    assert.equal(resolveProjectStorage("1", {}), "local");
  });

  it("returns 'local' when set to 'server' but no share URL is configured (prevent public host upload)", () => {
    assert.equal(resolveProjectStorage("server", {}), "local");
    assert.equal(resolveProjectStorage("Server", {}), "local");
    assert.equal(resolveProjectStorage("SERVER", {}), "local");
    assert.equal(resolveProjectStorage("  server  ", {}), "local");
  });

  it("returns 'server' when set to 'server' and custom share host is configured", () => {
    const customEnv = { [SHARE_URL_ENV]: "https://projects.example.internal" };
    assert.equal(resolveProjectStorage("server", customEnv), "server");
    assert.equal(resolveProjectStorage("Server", customEnv), "server");
    assert.equal(resolveProjectStorage("SERVER", customEnv), "server");
    assert.equal(resolveProjectStorage("  server  ", customEnv), "server");
    assert.equal(
      resolveProjectStorage("server", {}, "https://projects.example.internal"),
      "server",
    );
  });

  it("honors the hosted share URL only when it is named explicitly", () => {
    // Unset falls back to the hosted default for sharing, never for storage.
    assert.equal(resolveProjectStorage("server", {}), "local");
    assert.equal(
      resolveProjectStorage("server", { [SHARE_URL_ENV]: DEFAULT_SHARE_BASE_URL }),
      "server",
    );
  });

  it("returns 'local' when set to 'server' but share server is disabled (off)", () => {
    assert.equal(resolveProjectStorage("server", { [SHARE_URL_ENV]: "off" }), "local");
    assert.equal(resolveProjectStorage("server", {}, "off"), "local");
  });

  it("returns 'local' when set to 'server' but share server is invalid", () => {
    assert.equal(
      resolveProjectStorage("server", { [SHARE_URL_ENV]: "http://insecure.example.com" }),
      "local",
    );
    assert.equal(resolveProjectStorage("server", {}, "http://insecure.example.com"), "local");
  });

  it("returns 'server' with a valid self-hosted share URL", () => {
    assert.equal(
      resolveProjectStorage("server", { [SHARE_URL_ENV]: "https://projects.example.internal" }),
      "server",
    );
    assert.equal(
      resolveProjectStorage("server", {}, "https://projects.example.internal"),
      "server",
    );
  });

  it("reads from deploymentEnv record when configured arg is omitted", () => {
    assert.equal(
      resolveProjectStorage(undefined, {
        [PROJECT_STORAGE_ENV]: "server",
        [SHARE_URL_ENV]: "https://projects.example.internal",
      }),
      "server",
    );
    assert.equal(
      resolveProjectStorage(undefined, {
        [PROJECT_STORAGE_ENV]: "server",
      }),
      "local",
    );
    assert.equal(
      resolveProjectStorage(undefined, {
        [PROJECT_STORAGE_ENV]: "server",
        [SHARE_URL_ENV]: "off",
      }),
      "local",
    );
  });
});

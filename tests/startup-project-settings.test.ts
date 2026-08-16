import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_STARTUP_SETTINGS,
  normalizeDesktopSettings,
} from "../apps/geolibre-desktop/src/hooks/useDesktopSettings";
import {
  startupProjectPath,
  startupSettingsAfterForcedSaveAs,
} from "../apps/geolibre-desktop/src/lib/startup-project";

describe("startup project settings", () => {
  it("defaults to the normal untitled workspace", () => {
    assert.deepEqual(normalizeDesktopSettings({}).startup, {
      mode: "default",
      projectPath: null,
      projectName: null,
    });
  });

  it("normalizes a selected startup project", () => {
    assert.deepEqual(
      normalizeDesktopSettings({
        startup: {
          mode: "specific",
          projectPath: " /tmp/field.geolibre.json ",
          projectName: " Field ",
        },
      }).startup,
      {
        mode: "specific",
        projectPath: "/tmp/field.geolibre.json",
        projectName: "Field",
      },
    );
  });

  it("rejects a specific mode without a path and unknown modes", () => {
    assert.equal(
      normalizeDesktopSettings({ startup: { mode: "specific" } }).startup.mode,
      "default",
    );
    assert.equal(
      normalizeDesktopSettings({ startup: { mode: "tampered" } }).startup.mode,
      "default",
    );
  });
});

describe("startupProjectPath", () => {
  const recent = (...paths: string[]) =>
    paths.map((path) => ({ path, name: path, openedAt: "2026-01-01T00:00:00.000Z" }));

  it("restores nothing in default mode", () => {
    assert.equal(
      startupProjectPath(DEFAULT_STARTUP_SETTINGS, recent("/tmp/a.geolibre.json")),
      null,
    );
  });

  it("uses the configured path in specific mode, ignoring recent projects", () => {
    assert.equal(
      startupProjectPath(
        { mode: "specific", projectPath: "/tmp/pinned.geolibre.json", projectName: "Pinned" },
        recent("/tmp/other.geolibre.json"),
      ),
      "/tmp/pinned.geolibre.json",
    );
  });

  it("reopens the most recent project in last mode", () => {
    assert.equal(
      startupProjectPath(
        { mode: "last", projectPath: null, projectName: null },
        recent("/tmp/newest.geolibre.json", "/tmp/older.geolibre.json"),
      ),
      "/tmp/newest.geolibre.json",
    );
  });

  it("skips remote share links so last mode stays a local, offline reopen", () => {
    // Opening a share link records it in `recentProjects` by its URL. Replaying
    // that on every launch would hit a third-party host at startup, which the
    // setting's own copy ("most recently used local project") does not promise.
    assert.equal(
      startupProjectPath(
        { mode: "last", projectPath: null, projectName: null },
        recent("https://share.geolibre.app/p/abc", "/tmp/local.geolibre.json"),
      ),
      "/tmp/local.geolibre.json",
    );
  });

  it("treats an Android content URI as a local project", () => {
    // The Android document picker identifies a project on the device by a
    // `content://` URI, not a path. It is not a remote host, so last mode must
    // still restore it -- `openRecentProjectFile` reads it through the copy kept
    // for exactly that case (GeoLibre#1948).
    const uri =
      "content://com.android.externalstorage.documents/document/primary%3ADocuments%2Fjson%2FGeneral_Project.geolibre.json";
    assert.equal(
      startupProjectPath({ mode: "last", projectPath: null, projectName: null }, recent(uri)),
      uri,
    );
  });

  it("restores nothing when every recent project is remote", () => {
    assert.equal(
      startupProjectPath(
        { mode: "last", projectPath: null, projectName: null },
        recent("https://share.geolibre.app/p/abc"),
      ),
      null,
    );
  });

  it("restores nothing in last mode with no history", () => {
    assert.equal(
      startupProjectPath({ mode: "last", projectPath: null, projectName: null }, []),
      null,
    );
  });
});

describe("startupSettingsAfterForcedSaveAs", () => {
  // Saving a project opened through the Android document picker is refused in
  // place and falls back to the save dialog, which creates a new document: on
  // the emulator, saving over General_Project.geolibre.json lands on a URI
  // ending "General_Project.geolibre.json (1)".
  const PICKED =
    "content://com.android.externalstorage.documents/document/primary%3AGeneral.geolibre.json";
  const CREATED = `${PICKED}%20(1)`;

  it("follows a pinned project to the document the save actually created", () => {
    assert.deepEqual(
      startupSettingsAfterForcedSaveAs(
        { mode: "specific", projectPath: PICKED, projectName: "General" },
        PICKED,
        CREATED,
      ),
      { mode: "specific", projectPath: CREATED, projectName: "General" },
    );
  });

  it("leaves a preference pinned to some other project alone", () => {
    assert.equal(
      startupSettingsAfterForcedSaveAs(
        { mode: "specific", projectPath: "/tmp/pinned.geolibre.json", projectName: "Pinned" },
        PICKED,
        CREATED,
      ),
      null,
    );
  });

  it("does nothing for the modes that resolve a path of their own", () => {
    assert.equal(
      startupSettingsAfterForcedSaveAs(
        { mode: "last", projectPath: null, projectName: null },
        PICKED,
        CREATED,
      ),
      null,
    );
    assert.equal(startupSettingsAfterForcedSaveAs(DEFAULT_STARTUP_SETTINGS, PICKED, CREATED), null);
  });

  it("does nothing when the save stayed where it was, or had nowhere to start", () => {
    // The desktop case: a plain Save writes the file it opened, every time.
    assert.equal(
      startupSettingsAfterForcedSaveAs(
        { mode: "specific", projectPath: PICKED, projectName: "General" },
        PICKED,
        PICKED,
      ),
      null,
    );
    assert.equal(
      startupSettingsAfterForcedSaveAs(
        { mode: "specific", projectPath: PICKED, projectName: "General" },
        null,
        CREATED,
      ),
      null,
    );
  });
});

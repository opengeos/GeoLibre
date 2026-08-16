import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_STARTUP_SETTINGS,
  normalizeDesktopSettings,
} from "../apps/geolibre-desktop/src/hooks/useDesktopSettings";
import {
  planStartup,
  startupDefaultProjection,
  startupProjectPath,
  startupSettingsAfterForcedSaveAs,
} from "../apps/geolibre-desktop/src/lib/startup-project";

describe("startup project settings", () => {
  it("defaults to the normal untitled workspace", () => {
    assert.deepEqual(normalizeDesktopSettings({}).startup, {
      mode: "default",
      projectPath: null,
      projectName: null,
      globeByDefault: true,
    });
  });

  it("normalizes a selected startup project", () => {
    assert.deepEqual(
      normalizeDesktopSettings({
        startup: {
          mode: "specific",
          projectPath: " /tmp/field.geolibre.json ",
          projectName: " Field ",
          globeByDefault: false,
        },
      }).startup,
      {
        mode: "specific",
        projectPath: "/tmp/field.geolibre.json",
        projectName: "Field",
        globeByDefault: false,
      },
    );
  });

  it("defaults invalid or missing empty-workspace projection settings to globe", () => {
    assert.equal(normalizeDesktopSettings({ startup: {} }).startup.globeByDefault, true);
    assert.equal(
      normalizeDesktopSettings({ startup: { globeByDefault: "no" } }).startup.globeByDefault,
      true,
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

describe("startupDefaultProjection", () => {
  it("uses the empty-workspace globe preference", () => {
    assert.equal(startupDefaultProjection(DEFAULT_STARTUP_SETTINGS), "globe");
    assert.equal(
      startupDefaultProjection({ ...DEFAULT_STARTUP_SETTINGS, globeByDefault: false }),
      "mercator",
    );
  });
});

describe("planStartup", () => {
  const recent = (...paths: string[]) =>
    paths.map((path) => ({ path, name: path, openedAt: "2026-01-01T00:00:00.000Z" }));
  const PINNED = "/tmp/pinned.geolibre.json";
  const pinned = { ...DEFAULT_STARTUP_SETTINGS, mode: "specific" as const, projectPath: PINNED };

  it("yields to an explicit project or data URL without touching preferences", () => {
    // The URL loaders bring a projection of their own, so a plan that also
    // seeded one would race them. Even a configured startup project stands down.
    assert.deepEqual(
      planStartup({
        explicitPayload: true,
        desktop: true,
        settings: pinned,
        recentProjects: recent(PINNED),
      }),
      { kind: "payload" },
    );
  });

  it("restores a configured project on the desktop", () => {
    assert.deepEqual(
      planStartup({
        explicitPayload: false,
        desktop: true,
        settings: pinned,
        recentProjects: [],
      }),
      { kind: "restore", path: PINNED },
    );
  });

  it("never restores off the desktop, but still honors the projection there", () => {
    // The browser build and the Jupyter embed have no persistent local file to
    // reopen, so the same pinned preference must not gate their shell -- but the
    // empty-workspace projection setting is offered to them and has to apply.
    for (const globeByDefault of [true, false]) {
      assert.deepEqual(
        planStartup({
          explicitPayload: false,
          desktop: false,
          settings: { ...pinned, globeByDefault },
          recentProjects: recent(PINNED),
        }),
        { kind: "default", projection: globeByDefault ? "globe" : "mercator" },
      );
    }
  });

  it("falls back to the empty workspace when no project resolves", () => {
    // "Reopen the last project" with an empty history, and the default mode.
    assert.deepEqual(
      planStartup({
        explicitPayload: false,
        desktop: true,
        settings: { ...DEFAULT_STARTUP_SETTINGS, mode: "last" },
        recentProjects: [],
      }),
      { kind: "default", projection: "globe" },
    );
    assert.deepEqual(
      planStartup({
        explicitPayload: false,
        desktop: true,
        settings: { ...DEFAULT_STARTUP_SETTINGS, globeByDefault: false },
        recentProjects: recent(PINNED),
      }),
      { kind: "default", projection: "mercator" },
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
        {
          mode: "specific",
          projectPath: "/tmp/pinned.geolibre.json",
          projectName: "Pinned",
          globeByDefault: true,
        },
        recent("/tmp/other.geolibre.json"),
      ),
      "/tmp/pinned.geolibre.json",
    );
  });

  it("reopens the most recent project in last mode", () => {
    assert.equal(
      startupProjectPath(
        { mode: "last", projectPath: null, projectName: null, globeByDefault: true },
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
        { mode: "last", projectPath: null, projectName: null, globeByDefault: true },
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
      startupProjectPath(
        { mode: "last", projectPath: null, projectName: null, globeByDefault: true },
        recent(uri),
      ),
      uri,
    );
  });

  it("restores nothing when every recent project is remote", () => {
    assert.equal(
      startupProjectPath(
        { mode: "last", projectPath: null, projectName: null, globeByDefault: true },
        recent("https://share.geolibre.app/p/abc"),
      ),
      null,
    );
  });

  it("restores nothing in last mode with no history", () => {
    assert.equal(
      startupProjectPath(
        { mode: "last", projectPath: null, projectName: null, globeByDefault: true },
        [],
      ),
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
        { mode: "specific", projectPath: PICKED, projectName: "General", globeByDefault: true },
        PICKED,
        CREATED,
      ),
      { mode: "specific", projectPath: CREATED, projectName: "General", globeByDefault: true },
    );
  });

  it("leaves a preference pinned to some other project alone", () => {
    assert.equal(
      startupSettingsAfterForcedSaveAs(
        {
          mode: "specific",
          projectPath: "/tmp/pinned.geolibre.json",
          projectName: "Pinned",
          globeByDefault: true,
        },
        PICKED,
        CREATED,
      ),
      null,
    );
  });

  it("does nothing for the modes that resolve a path of their own", () => {
    assert.equal(
      startupSettingsAfterForcedSaveAs(
        { mode: "last", projectPath: null, projectName: null, globeByDefault: true },
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
        { mode: "specific", projectPath: PICKED, projectName: "General", globeByDefault: true },
        PICKED,
        PICKED,
      ),
      null,
    );
    assert.equal(
      startupSettingsAfterForcedSaveAs(
        { mode: "specific", projectPath: PICKED, projectName: "General", globeByDefault: true },
        null,
        CREATED,
      ),
      null,
    );
  });
});

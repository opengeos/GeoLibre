import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { createEmptyProject, useAppStore } from "@geolibre/core";
import { startProjectImportSession } from "../apps/geolibre-desktop/src/lib/project-import-session";

const load = (name: string) =>
  useAppStore.getState().loadProject({ ...createEmptyProject(), name }, null);

describe("startProjectImportSession", () => {
  beforeEach(() => useAppStore.getState().newProject({ name: "start" }));

  it("is superseded, and aborts its signal at once, when another project opens", () => {
    const session = startProjectImportSession();
    assert.equal(session.superseded(), false);
    load("Opened elsewhere");
    assert.equal(session.signal.aborted, true);
    assert.equal(session.superseded(), true);
    assert.throws(() => session.signal.throwIfAborted(), { name: "AbortError" });
    session.dispose();
  });

  it("counts a new project as a replacement too", () => {
    const session = startProjectImportSession();
    useAppStore.getState().newProject({ name: "New" });
    assert.equal(session.superseded(), true);
    session.dispose();
  });

  it("does not count its own project load as a replacement", () => {
    const session = startProjectImportSession();
    assert.equal(
      session.replaceProject(() => load("Imported")),
      true,
    );
    assert.equal(session.superseded(), false);
    assert.equal(session.signal.aborted, false);
    // A later replacement still supersedes it.
    load("Opened after");
    assert.equal(session.superseded(), true);
    session.dispose();
  });

  it("refuses to load once superseded", () => {
    const session = startProjectImportSession();
    load("Opened elsewhere");
    let loaded = false;
    assert.equal(
      session.replaceProject(() => {
        loaded = true;
      }),
      false,
    );
    assert.equal(loaded, false);
    session.dispose();
  });

  it("is not superseded by a collaboration refresh of the open project", () => {
    const session = startProjectImportSession();
    session.replaceProject(() => load("Imported"));
    // useCollaboration's in-place snapshot: new layers, then a generation bump.
    useAppStore.setState((state) => ({ projectGeneration: state.projectGeneration + 1 }));
    assert.equal(session.superseded(), false);
    assert.equal(session.signal.aborted, false);
    session.dispose();
  });

  it("stops watching once disposed", () => {
    const session = startProjectImportSession();
    session.dispose();
    session.dispose();
    load("Opened after");
    // The signal is no longer driven, but the check itself still holds.
    assert.equal(session.signal.aborted, false);
    assert.equal(session.superseded(), true);
  });
});

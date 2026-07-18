import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  type Command,
  type Shortcut,
  filterCommands,
  formatShortcut,
  matchesShortcut,
} from "../apps/geolibre-desktop/src/lib/commands";

interface KeyEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

function keyEvent(key: string, mods: Partial<KeyEvent> = {}): KeyEvent {
  return {
    key,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...mods,
  };
}

function command(patch: Partial<Command> & Pick<Command, "id" | "title">): Command {
  return {
    group: "Group",
    run: () => {},
    ...patch,
  };
}

describe("matchesShortcut", () => {
  const save: Shortcut = { key: "s", mod: true, shift: false };

  it("matches the platform command modifier (Ctrl on non-mac, ⌘ on mac)", () => {
    assert.equal(matchesShortcut(keyEvent("s", { ctrlKey: true }), save, false), true);
    assert.equal(matchesShortcut(keyEvent("s", { metaKey: true }), save, true), true);
  });

  it("does not match when the non-platform modifier is used", () => {
    assert.equal(matchesShortcut(keyEvent("s", { metaKey: true }), save, false), false);
    assert.equal(matchesShortcut(keyEvent("s", { ctrlKey: true }), save, true), false);
  });

  it("rejects the other command modifier even when the platform one is held", () => {
    assert.equal(
      matchesShortcut(keyEvent("s", { ctrlKey: true, metaKey: true }), save, false),
      false,
    );
  });

  it("distinguishes Shift (Save vs Save As)", () => {
    const saveAs: Shortcut = { key: "s", mod: true, shift: true };
    assert.equal(matchesShortcut(keyEvent("s", { ctrlKey: true }), saveAs, false), false);
    assert.equal(
      matchesShortcut(keyEvent("s", { ctrlKey: true, shiftKey: true }), saveAs, false),
      true,
    );
    // Save explicitly forbids Shift.
    assert.equal(
      matchesShortcut(keyEvent("s", { ctrlKey: true, shiftKey: true }), save, false),
      false,
    );
  });

  it("ignores Shift when the shortcut leaves it unspecified", () => {
    const help: Shortcut = { key: "?" };
    assert.equal(matchesShortcut(keyEvent("?", { shiftKey: true }), help, false), true);
    assert.equal(matchesShortcut(keyEvent("?"), help, false), true);
  });

  it("matches letters case-insensitively", () => {
    assert.equal(matchesShortcut(keyEvent("S", { ctrlKey: true }), save, false), true);
  });

  it("requires Alt only when specified", () => {
    assert.equal(
      matchesShortcut(keyEvent("s", { ctrlKey: true, altKey: true }), save, false),
      false,
    );
    const altShortcut: Shortcut = { key: "s", mod: true, shift: false, alt: true };
    assert.equal(
      matchesShortcut(keyEvent("s", { ctrlKey: true, altKey: true }), altShortcut, false),
      true,
    );
  });
});

describe("formatShortcut", () => {
  it("renders mac glyphs", () => {
    assert.equal(formatShortcut({ key: "k", mod: true }, true), "⌘K");
    assert.equal(formatShortcut({ key: "s", mod: true, shift: true }, true), "⇧⌘S");
    assert.equal(formatShortcut({ key: "?" }, true), "?");
  });

  it("renders Ctrl-style on other platforms", () => {
    assert.equal(formatShortcut({ key: "k", mod: true }, false), "Ctrl+K");
    assert.equal(formatShortcut({ key: "s", mod: true, shift: true }, false), "Ctrl+Shift+S");
  });
});

describe("filterCommands", () => {
  const commands: Command[] = [
    command({ id: "a", title: "Save Project", group: "Project" }),
    command({ id: "b", title: "Add Vector Layer", group: "Add Data", keywords: "geojson" }),
    command({ id: "c", title: "Add Raster Layer", group: "Add Data" }),
  ];

  it("returns everything for an empty query", () => {
    assert.equal(filterCommands(commands, "  ").length, 3);
  });

  it("matches across title, group, and keywords", () => {
    assert.deepEqual(
      filterCommands(commands, "geojson").map((c) => c.id),
      ["b"],
    );
    assert.deepEqual(
      filterCommands(commands, "add")
        .map((c) => c.id)
        .sort(),
      ["b", "c"],
    );
  });

  it("requires every token to match", () => {
    assert.deepEqual(
      filterCommands(commands, "add raster").map((c) => c.id),
      ["c"],
    );
  });

  it("ranks title-prefix matches first", () => {
    const list: Command[] = [
      command({ id: "x", title: "Resave Layer", group: "G" }),
      command({ id: "y", title: "Save Layer", group: "G" }),
    ];
    assert.deepEqual(
      filterCommands(list, "save").map((c) => c.id),
      ["y", "x"],
    );
  });
});

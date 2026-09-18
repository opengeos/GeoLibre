import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  nativeFileDialogFilters,
  type FileDialogFilter,
} from "../apps/geolibre-desktop/src/lib/file-dialog-filters";

const styleFilters: FileDialogFilter[] = [
  {
    name: "Style",
    extensions: ["json", "sld", "qml", "xml"],
  },
];

describe("nativeFileDialogFilters", () => {
  it("uses the Android override even when it intentionally has no filters", () => {
    assert.deepEqual(
      nativeFileDialogFilters(styleFilters, [], "Mozilla/5.0 (Linux; Android 16; Mobile)"),
      [],
    );
  });

  it("keeps extension filters on desktop and iOS", () => {
    assert.equal(
      nativeFileDialogFilters(styleFilters, [], "Mozilla/5.0 (X11; Linux x86_64)"),
      styleFilters,
    );
    assert.equal(
      nativeFileDialogFilters(styleFilters, [], "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)"),
      styleFilters,
    );
  });

  it("keeps the default filters on Android when no override is supplied", () => {
    assert.equal(
      nativeFileDialogFilters(styleFilters, undefined, "Mozilla/5.0 (Linux; Android 16)"),
      styleFilters,
    );
  });
});

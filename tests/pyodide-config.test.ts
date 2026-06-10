import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  PYODIDE_VERSION,
  getPyodideIndexUrl,
} from "../apps/geolibre-desktop/src/lib/pyodide/pyodide-config";

describe("getPyodideIndexUrl", () => {
  it("defaults to the pinned jsDelivr CDN for the pinned version", () => {
    const url = getPyodideIndexUrl({});
    assert.equal(
      url,
      `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`,
    );
    // The loader and the CDN assets must share one version; guard the pin.
    assert.ok(url.includes(`/v${PYODIDE_VERSION}/`));
    assert.ok(url.endsWith("/"));
  });

  it("uses VITE_PYODIDE_INDEX_URL when set (for self-hosting/offline)", () => {
    assert.equal(
      getPyodideIndexUrl({ VITE_PYODIDE_INDEX_URL: "https://mirror.test/pyodide/" }),
      "https://mirror.test/pyodide/",
    );
  });

  it("appends a trailing slash when the override omits it", () => {
    assert.equal(
      getPyodideIndexUrl({ VITE_PYODIDE_INDEX_URL: "https://mirror.test/pyodide" }),
      "https://mirror.test/pyodide/",
    );
  });

  it("trims whitespace and falls back to the default when empty", () => {
    assert.equal(
      getPyodideIndexUrl({ VITE_PYODIDE_INDEX_URL: "  https://mirror.test/p/  " }),
      "https://mirror.test/p/",
    );
    assert.equal(
      getPyodideIndexUrl({ VITE_PYODIDE_INDEX_URL: "   " }),
      `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`,
    );
  });
});

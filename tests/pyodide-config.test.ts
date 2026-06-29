import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  PYODIDE_VERSION,
  getPyodideIndexUrl,
  isDefaultPyodideIndexUrl,
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

describe("isDefaultPyodideIndexUrl", () => {
  // This branch decides whether the Python Console pre-injects pyodide.asm.js to
  // dodge the CSP-blocked dynamic import (only needed for a non-whitelisted
  // mirror); the default CDN keeps Pyodide's own import.
  it("returns true for the resolved default CDN URL", () => {
    assert.equal(isDefaultPyodideIndexUrl(getPyodideIndexUrl({})), true);
  });

  it("returns false for a custom mirror URL", () => {
    assert.equal(
      isDefaultPyodideIndexUrl(
        getPyodideIndexUrl({ VITE_PYODIDE_INDEX_URL: "https://mirror.test/pyodide/" }),
      ),
      false,
    );
  });

  it("returns false for the default CDN URL without a trailing slash", () => {
    // Guard the exact-match contract: callers must pass a resolved (normalized)
    // indexURL, as getPyodideIndexUrl always appends the trailing slash.
    assert.equal(
      isDefaultPyodideIndexUrl(
        `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full`,
      ),
      false,
    );
  });
});

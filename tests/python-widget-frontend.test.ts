import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { rewriteColabLocalFileUrls } from "../python/src/geolibre/_frontend.js";

describe("rewriteColabLocalFileUrls", () => {
  it("routes registered raster files through the Colab proxy without mutating the project", () => {
    const localUrl = "http://127.0.0.1:41123/_geolibre_local/token/geolibre-xarray.tif?download=1";
    const project = {
      layers: [
        {
          id: "raster",
          source: { type: "raster", url: localUrl },
          sourcePath: localUrl,
        },
      ],
    };

    const rewritten = rewriteColabLocalFileUrls(
      project,
      "https://session-41123-colab.googleusercontent.com/",
      41123,
    );

    assert.notEqual(rewritten, project);
    assert.equal(project.layers[0].source.url, localUrl);
    assert.equal(
      rewritten.layers[0].source.url,
      "https://session-41123-colab.googleusercontent.com/_geolibre_local/token/" +
        "geolibre-xarray.tif?download=1",
    );
    assert.equal(rewritten.layers[0].sourcePath, rewritten.layers[0].source.url);
  });

  it("does not rewrite unrelated, wrong-port, or already-remote URLs", () => {
    const project = {
      layers: [
        { source: { url: "http://127.0.0.1:41123/user-data.tif" } },
        { source: { url: "http://127.0.0.1:9999/_geolibre_local/token/a.tif" } },
        { source: { url: "https://example.com/a.tif" } },
      ],
    };

    assert.equal(
      rewriteColabLocalFileUrls(project, "https://session-colab.example/", 41123),
      project,
    );
  });
});

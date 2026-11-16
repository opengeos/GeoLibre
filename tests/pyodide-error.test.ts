import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pythonErrorMessage } from "../apps/geolibre-desktop/src/lib/pyodide/pyodide-error";

// GeoLibre#3469: a Pyodide run showed the whole Python traceback instead of the
// error message the sidecar shows for the same failure.

const TRACEBACK = [
  "Traceback (most recent call last):",
  '  File "/lib/python313.zip/_pyodide/_base.py", line 597, in eval_code_async',
  "    await CodeRunner(",
  '  File "<exec>", line 1390, in run_vector_tool_json',
  '  File "<exec>", line 132, in _estimate_metric_crs',
  "ValueError: Input layer crosses the antimeridian (longitude span > 180°, got 359.9°).",
  "",
].join("\n");

describe("pythonErrorMessage", () => {
  it("keeps only a ValueError's message, as the sidecar shows it", () => {
    assert.equal(
      pythonErrorMessage(TRACEBACK),
      "Input layer crosses the antimeridian (longitude span > 180°, got 359.9°).",
    );
  });

  it("keeps the type of any other exception", () => {
    const message = TRACEBACK.replace("ValueError: Input", "KeyError: Input");
    assert.match(pythonErrorMessage(message), /^KeyError: Input layer/);
  });

  it("reads the last traceback of a chained exception", () => {
    const chained = [
      "Traceback (most recent call last):",
      '  File "<exec>", line 1, in f',
      "KeyError: 'x'",
      "",
      "During handling of the above exception, another exception occurred:",
      "",
      TRACEBACK,
    ].join("\n");
    assert.match(pythonErrorMessage(chained), /^Input layer crosses the antimeridian/);
  });

  it("returns anything that is not a traceback unchanged", () => {
    assert.equal(
      pythonErrorMessage("Failed to load Python runtime"),
      "Failed to load Python runtime",
    );
  });
});

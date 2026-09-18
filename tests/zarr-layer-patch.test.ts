import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

// The patch in patches/@carbonplan+zarr-layer+0.9.0.patch (upstream:
// carbonplan/zarr-layer#91) makes the renderer tolerate GPU drivers that
// eliminate shift_x, shift_y and u_worldXOffset from the flat source-projected
// shader. Mesa (Intel, AMD, llvmpipe) reports them inactive because they only
// feed a varying the fragment shader never reads, and the unpatched
// mustGetUniformLocation lookup threw on every frame once MapLibre left the
// globe transition, so a Zarr layer vanished at zoom 12 and above (#2357).
// The bundle keeps createShaderProgram private, so this pins the installed
// source instead of exercising it.
const bundle = readFileSync(fileURLToPath(import.meta.resolve("@carbonplan/zarr-layer")), "utf8");

describe("@carbonplan/zarr-layer dependency patch", () => {
  it("looks up the mercator-only uniforms without throwing", () => {
    for (const name of ["shift_x", "shift_y", "u_worldXOffset"]) {
      assert.ok(
        bundle.includes(`gl.getUniformLocation(program, "${name}")`),
        `${name} should use the non-throwing lookup`,
      );
      assert.ok(
        !bundle.includes(`mustGetUniformLocation(gl, program, "${name}")`),
        `${name} must not go through mustGetUniformLocation`,
      );
    }
  });

  it("still requires the uniforms every shader variant samples", () => {
    assert.ok(bundle.includes('mustGetUniformLocation(gl, program, "opacity")'));
  });
});

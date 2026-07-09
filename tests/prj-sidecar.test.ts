import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { prjSidecarCrs } from "../apps/geolibre-desktop/src/lib/prj-sidecar.ts";

function sibling(name: string, extension: string, text: string) {
  return { name, extension, data: new TextEncoder().encode(text) };
}

describe("prjSidecarCrs", () => {
  it("returns the trimmed WKT of a `.prj` sibling", () => {
    const wkt = 'PROJCS["British_National_Grid",GEOGCS["GCS_OSGB_1936"]]';
    const crs = prjSidecarCrs({
      siblingFiles: [
        sibling("hotspots.dbf", "dbf", "..."),
        sibling("hotspots.prj", "prj", `  ${wkt}\n`),
      ],
    });
    assert.equal(crs, wkt);
  });

  it("returns null when there is no `.prj` sibling", () => {
    assert.equal(
      prjSidecarCrs({
        siblingFiles: [sibling("hotspots.shx", "shx", "binary")],
      }),
      null,
    );
    assert.equal(prjSidecarCrs({}), null);
    assert.equal(prjSidecarCrs({ siblingFiles: [] }), null);
  });

  it("returns null when the `.prj` is empty or whitespace only", () => {
    assert.equal(
      prjSidecarCrs({ siblingFiles: [sibling("x.prj", "prj", "")] }),
      null,
    );
    assert.equal(
      prjSidecarCrs({ siblingFiles: [sibling("x.prj", "prj", "  \n\t ")] }),
      null,
    );
  });
});

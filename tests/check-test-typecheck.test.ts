import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  PROJECTS,
  checkProjectSplit,
  isTestFile,
  judge,
  parseDiagnostics,
} from "../scripts/check-test-typecheck.mjs";

// `scripts/check-test-typecheck.mjs` is the ratchet behind `npm run
// typecheck:tests`. These pin how it reads tsc's output and what it counts, so
// the gate can neither over-count (failing a clean PR) nor under-count (letting
// new errors through).

describe("check-test-typecheck parseDiagnostics", () => {
  it("parses one diagnostic per error line and skips elaboration lines", () => {
    const output = [
      "tests/a.test.ts(12,5): error TS2322: Type 'null' is not assignable to type 'Geometry'.",
      "  Types of property 'body' are incompatible.",
      "    Type 'X' is not assignable to type 'Y'.",
      "packages/core/src/s3.ts(629,45): error TS2304: Cannot find name 'window'.",
      "",
    ].join("\n");
    assert.deepEqual(parseDiagnostics(output), [
      {
        file: "tests/a.test.ts",
        line: 12,
        column: 5,
        code: "TS2322",
        message: "Type 'null' is not assignable to type 'Geometry'.",
      },
      {
        file: "packages/core/src/s3.ts",
        line: 629,
        column: 45,
        code: "TS2304",
        message: "Cannot find name 'window'.",
      },
    ]);
  });

  it("normalizes Windows path separators and CRLF line endings", () => {
    const [diagnostic] = parseDiagnostics("tests\\a.test.ts(1,2): error TS2339: Nope.\r\n");
    assert.equal(diagnostic.file, "tests/a.test.ts");
    assert.equal(isTestFile(diagnostic.file), true);
  });

  it("counts only files under tests/", () => {
    assert.equal(isTestFile("tests/helpers/dom.ts"), true);
    assert.equal(isTestFile("packages/core/src/s3.ts"), false);
    assert.equal(isTestFile("apps/geolibre-desktop/vite-proxy-guard.ts"), false);
  });
});

describe("check-test-typecheck judge", () => {
  it("fails above the limit", () => {
    assert.equal(judge(11, 10).ok, false);
  });

  it("passes at the limit", () => {
    assert.equal(judge(10, 10).ok, true);
  });

  it("passes under the limit and says what to lower it to", () => {
    const result = judge(7, 10);
    assert.equal(result.ok, true);
    assert.match(result.message, /Lower --max-errors .* to 7/);
  });
});

describe("check-test-typecheck project split", () => {
  it("flags an excluded test that no worker project checks", () => {
    assert.deepEqual(
      checkProjectSplit({ exclude: ["fixtures", "a.test.ts", "b-*.test.ts", "c.test.ts"] }, [
        { files: ["a.test.ts"] },
        { include: ["b-*.test.ts"] },
      ]),
      ["c.test.ts"],
    );
  });

  it("holds for the committed tsconfigs", () => {
    const [main, ...workerProjects] = PROJECTS.map((project) =>
      JSON.parse(readFileSync(project, "utf8")),
    );
    assert.deepEqual(checkProjectSplit(main, workerProjects), []);
  });
});

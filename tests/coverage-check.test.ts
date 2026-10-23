import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { classify } from "../scripts/coverage-check.mjs";

// `scripts/coverage-check.mjs` re-measures the suite when line coverage alone
// comes up short, because that metric is nondeterministic on CI (#1889). The
// risk in a retry is that it also swallows a real regression, so these pin
// exactly which failures earn a second run and which fail on the spot.

const summary = (fail: number) =>
  ["# tests 5935", "# suites 1297", "# pass 5934", `# fail ${fail}`, "# skipped 1"].join("\n");

const shortfall = (actual: number, metric: string, floor: number) =>
  `Error: ${actual}% ${metric} coverage does not meet threshold of ${floor}%.`;

describe("coverage-check classify", () => {
  it("treats a clean run as passing with nothing to retry", () => {
    const result = classify({
      status: 0,
      output: `${summary(0)}\n# all files | 82.81 | 84.46 | 72.94 |`,
    });
    assert.equal(result.ok, true);
    assert.equal(result.lineOnly, false);
    assert.deepEqual(result.thresholds, []);
  });

  it("re-measures when lines alone are short and every test passed", () => {
    // The exact shape of the run that reddened PR #1887.
    const result = classify({
      status: 1,
      output: `${summary(0)}\n${shortfall(76.47, "line", 78)}`,
    });
    assert.equal(result.ok, false);
    assert.equal(result.lineOnly, true);
    assert.deepEqual(result.thresholds, [{ actual: 76.47, metric: "line", floor: 78 }]);
  });

  it("does not retry a function-coverage shortfall", () => {
    // The real regression from #1784: deterministic, so a retry would only
    // waste a run and, if it ever flapped, hide it.
    const result = classify({
      status: 1,
      output: `${summary(0)}\n${shortfall(60.36, "function", 63)}`,
    });
    assert.equal(result.lineOnly, false);
  });

  it("does not retry a branch-coverage shortfall", () => {
    const result = classify({
      status: 1,
      output: `${summary(0)}\n${shortfall(70.1, "branch", 78)}`,
    });
    assert.equal(result.lineOnly, false);
  });

  it("does not retry when lines are short alongside another metric", () => {
    const result = classify({
      status: 1,
      output: `${summary(0)}\n${shortfall(76.47, "line", 78)}\n${shortfall(60.36, "function", 63)}`,
    });
    assert.equal(result.lineOnly, false);
    assert.equal(result.thresholds.length, 2);
  });

  it("does not retry when a test failed, even if lines are also short", () => {
    // A failing test can itself drag line coverage down, so the failure is the
    // thing to report rather than something to re-roll.
    const result = classify({
      status: 1,
      output: `${summary(3)}\n${shortfall(76.47, "line", 78)}`,
    });
    assert.equal(result.failedTests, 3);
    assert.equal(result.lineOnly, false);
  });

  it("reads the spec reporter's summary as well as the tap one", () => {
    // Node prefixes with `ℹ` on a TTY and `#` otherwise; CI sees `#`, a
    // developer running it locally sees `ℹ`.
    const result = classify({
      status: 1,
      output: `ℹ fail 2\n${shortfall(76.47, "line", 78)}`,
    });
    assert.equal(result.failedTests, 2);
    assert.equal(result.lineOnly, false);
  });

  it("never calls process.exit, which would truncate the streamed output", () => {
    // `process.stdout` is async when it is a pipe, which is what CI gives it.
    // An earlier version buffered the whole run and then called process.exit,
    // which dropped ~42,000 lines and the entire coverage summary from the CI
    // log, mid-line, while still exiting 0. The gate looked green and reported
    // nothing. Only `process.exitCode` is safe here, and the failure is
    // invisible when stdout is a file (as it is when a developer redirects it),
    // so pin it at the source rather than hope someone notices.
    const source = readFileSync(new URL("../scripts/coverage-check.mjs", import.meta.url), "utf8");
    assert.equal(
      /(?<!\.)\bprocess\.exit\s*\(/.test(source),
      false,
      "coverage-check.mjs must set process.exitCode instead of calling process.exit()",
    );
    assert.ok(source.includes("process.exitCode"));
  });

  it("does not retry a non-zero exit that reported no threshold at all", () => {
    // A crash, an unresolved import, an out-of-memory kill: nothing here says
    // the measurement was unlucky, so re-running is not justified.
    const result = classify({ status: 1, output: "SyntaxError: Unexpected token" });
    assert.equal(result.lineOnly, false);
    assert.deepEqual(result.thresholds, []);
  });
});

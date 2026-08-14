// CI frontend coverage gate: the `node --test` coverage floors, with one retry
// reserved for the line metric.
// Run with: node scripts/coverage-check.mjs  (or `npm run test:frontend:coverage`)
//
// Node enforces all three floors itself; this wrapper only decides whether a
// failure is worth a second opinion. Line coverage is the one metric observed
// to be nondeterministic on CI: two runs over byte-identical sources reported
// 81.82% and 76.47%, with 114 of 444 files differing on lines while *zero*
// differed on branches or functions, and the same 5935 tests passing in both.
// The low run failed a floor that the identical tree cleared minutes earlier.
// See https://github.com/opengeos/GeoLibre/issues/1889.
//
// So: a line-only shortfall is re-measured once, and only a second shortfall
// fails the build. Branch and function shortfalls fail immediately, as does any
// actual test failure. That keeps every floor at full strength against a real
// regression (which reproduces on the re-run) while not reddening a PR over an
// accounting artifact nobody can act on.
//
// If the retry ever starts firing regularly, that is the signal to stop
// mitigating and fix the measurement: the retry logs both numbers precisely so
// #1889 can accumulate evidence.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Kept in sync with the floors documented in CLAUDE.md. Raise them when
// coverage rises comfortably above, which is what makes this a ratchet.
const LINES = 78;
const BRANCHES = 78;
const FUNCTIONS = 63;

// Expanded here rather than left to a shell glob, so the gate behaves the same
// under zsh, bash, and cmd.exe.
const testFiles = readdirSync("tests")
  .filter((name) => name.endsWith(".test.ts"))
  .sort()
  .map((name) => path.posix.join("tests", name));

if (testFiles.length === 0) {
  console.error("coverage-check: no tests/*.test.ts files found.");
  process.exit(1);
}

const args = [
  "--import",
  "tsx",
  "--test",
  "--experimental-test-coverage",
  `--test-coverage-lines=${LINES}`,
  `--test-coverage-branches=${BRANCHES}`,
  `--test-coverage-functions=${FUNCTIONS}`,
  "--test-coverage-exclude=tests/**",
  "--test-coverage-exclude=e2e/**",
  "--test-coverage-exclude=**/*.config.*",
  ...testFiles,
];

/**
 * Run the suite once, echoing output as it is captured so the CI log reads
 * exactly as it did before this wrapper existed.
 */
function runSuite() {
  const result = spawnSync(process.execPath, args, {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["inherit", "pipe", "pipe"],
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  return { status: result.status ?? 1, output: `${stdout}\n${stderr}` };
}

/**
 * Classify a run. The reporter prefixes summary lines with `#` (tap) or `ℹ`
 * (spec) depending on whether stdout is a TTY, so both are accepted.
 *
 * Exported for `tests/coverage-check.test.ts`: deciding when to re-measure is
 * the part of this gate that can silently swallow a real regression, so it is
 * pinned by tests rather than trusted.
 */
export function classify({ status, output }) {
  const failedTests = Number(/(?:^|[#ℹ]\s*)fail\s+(\d+)/m.exec(output)?.[1] ?? 0);
  const thresholds = [
    ...output.matchAll(
      /([\d.]+)% (line|branch|function) coverage does not meet threshold of ([\d.]+)%/g,
    ),
  ].map((match) => ({ actual: Number(match[1]), metric: match[2], floor: Number(match[3]) }));
  return {
    ok: status === 0,
    failedTests,
    thresholds,
    // The one case worth a second measurement: the suite passed, and lines are
    // the only floor that came up short.
    lineOnly:
      status !== 0 &&
      failedTests === 0 &&
      thresholds.length > 0 &&
      thresholds.every((entry) => entry.metric === "line"),
  };
}

function main() {
  const first = classify(runSuite());
  if (first.ok) process.exit(0);

  if (!first.lineOnly) {
    if (first.failedTests > 0) {
      console.error(`\ncoverage-check: ${first.failedTests} test(s) failed. Not retrying.`);
    } else if (first.thresholds.length > 0) {
      const stable = first.thresholds
        .filter((entry) => entry.metric !== "line")
        .map((entry) => `${entry.metric} ${entry.actual}% < ${entry.floor}%`)
        .join(", ");
      console.error(
        `\ncoverage-check: ${stable || "coverage"} below floor. Branch and function coverage are ` +
          "reproducible run to run, so this is a real regression and is not retried.",
      );
    }
    process.exit(1);
  }

  const firstLine = first.thresholds[0];
  console.error(
    `\ncoverage-check: line coverage came in at ${firstLine.actual}%, under the ${firstLine.floor}% floor, ` +
      "with every test passing and branch and function coverage fine.\n" +
      "coverage-check: that is the signature of the nondeterministic line accounting in " +
      "https://github.com/opengeos/GeoLibre/issues/1889, so re-measuring once before failing.\n",
  );

  const second = classify(runSuite());
  if (second.ok) {
    console.error(
      `\ncoverage-check: the re-run cleared the floor, so the ${firstLine.actual}% reading was a ` +
        "measurement artifact rather than a coverage regression.\n" +
        `coverage-check: please add the pair (${firstLine.actual}% then passing) to issue #1889. ` +
        "If this is happening often, the gate needs fixing rather than retrying.",
    );
    process.exit(0);
  }

  const secondLine = second.thresholds.find((entry) => entry.metric === "line");
  console.error(
    `\ncoverage-check: line coverage was short twice in a row (${firstLine.actual}% then ` +
      `${secondLine ? `${secondLine.actual}%` : "short again"}, floor ${firstLine.floor}%). ` +
      "A real regression reproduces; this is one. Add tests or, if the drop is a module newly " +
      "pulled into the report rather than code getting less tested, see the coverage notes in CLAUDE.md.",
  );
  process.exit(1);
}

// Only run the gate when invoked directly, so the test file can import
// `classify` without spawning the whole suite.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

// CI dependency gate: `npm audit --omit=dev` with a documented allowlist.
// Run with: node scripts/audit-check.mjs  (or `npm run audit:ci`)
//
// Plain `npm audit --audit-level=high` has no way to accept a single advisory,
// so one unpatchable transitive finding reddens every PR until upstream ships a
// fix — which, for an unmaintained leaf package, may be never. This keeps the
// gate blocking on high/critical, but lets ALLOWLIST carry the advisories that
// have no fix to upgrade to *and* no reachable GeoLibre code path.
//
// Rules for adding an entry: there must be no patched version available, the
// vulnerable code must not reach a GeoLibre runtime path, and the reason has to
// say why on both counts. Anything upgradeable gets upgraded instead.
import { spawnSync } from "node:child_process";

// Severities that fail the build. Moderate/low are left to Dependabot PRs.
const BLOCKING = new Set(["high", "critical"]);

const ALLOWLIST = new Map([
  [
    "GHSA-w3rx-r6r6-pgpr",
    "image-size DoS (ICNS parser infinite loop). No patched version exists — " +
      "the advisory covers <=2.0.2 and 2.0.2 is the latest release. It reaches " +
      "us only as a dependency of texture-compressor, which @loaders.gl/textures " +
      "spawns via `npx` from encodeImageURLToCompressedTextureURL (a Node-only " +
      "encoder). GeoLibre never calls that encoder and it cannot bundle into the " +
      "browser build, so no attacker-supplied image is ever parsed by it.",
  ],
  [
    "GHSA-5p2g-fcmc-qvqq",
    "image-size DoS (JXL/HEIF parser infinite loops). Same package, same lack of " +
      "a patched version, and the same unreachable texture-compressor path as " +
      "GHSA-w3rx-r6r6-pgpr above.",
  ],
]);

const audit = spawnSync("npm", ["audit", "--omit=dev", "--json"], {
  encoding: "utf8",
  maxBuffer: 32 * 1024 * 1024,
  // npm is npm.cmd on Windows, which Node will not resolve without a shell.
  shell: process.platform === "win32",
});

// The gate must fail closed: anything short of a report we can actually read is
// an error, never an implicit "clean". npm's exit code can't carry that, since
// it also goes non-zero merely because vulnerabilities exist — so the report
// itself is the signal.
function unusable(why, detail) {
  console.error(`npm audit did not return a usable report: ${why}`);
  if (detail) console.error(detail);
  process.exit(1);
}

if (audit.error) unusable("npm could not be run.", audit.error.message);
if (audit.signal) unusable(`npm was killed by ${audit.signal}.`, audit.stderr);

let report;
try {
  report = JSON.parse(audit.stdout);
} catch {
  unusable("stdout was not JSON.", audit.stdout || audit.stderr);
}

// A registry outage, an auth failure or an npm internal error still prints valid
// JSON — but an `{error, message}` envelope with no `vulnerabilities` key rather
// than a report. Left unchecked, `report.vulnerabilities ?? {}` would read that
// as zero advisories and pass the gate exactly when the audit did not run.
if (report === null || typeof report !== "object" || Array.isArray(report)) {
  unusable("stdout was JSON but not an object.", audit.stdout);
}
if (report.error) {
  // A registry outage fills the top-level `message` and leaves `error.summary`
  // and `error.detail` empty strings; other npm errors do the reverse. Try all
  // three so the failure output carries whichever one npm populated.
  unusable(
    "npm reported an error.",
    report.error.detail || report.error.summary || report.message || audit.stderr,
  );
}
// Arrays are typeof "object" too, and an array would yield zero entries below
// rather than an error — so a malformed report would read as clean.
if (
  typeof report.vulnerabilities !== "object" ||
  report.vulnerabilities === null ||
  Array.isArray(report.vulnerabilities)
) {
  unusable("the report has no `vulnerabilities` section.", audit.stdout);
}

// Flatten the report to one entry per advisory. `via` holds advisory objects for
// the package that actually carries the flaw, and plain package-name strings for
// the dependents that only inherit it — so collecting the objects covers every
// affected package without counting the same advisory once per dependent.
const advisories = new Map();
for (const vuln of Object.values(report.vulnerabilities)) {
  for (const via of vuln.via ?? []) {
    if (typeof via !== "object") continue;
    // Fail closed on an advisory we cannot name: fall back to a key built from
    // whatever npm did give us. It can never match an ALLOWLIST entry (those are
    // GHSA ids), so a high/critical one still blocks instead of being dropped.
    const id =
      /(GHSA-[\w-]+)/.exec(via.url ?? "")?.[1] ??
      `unidentified advisory (${via.url ?? via.source ?? via.name})`;
    const entry = advisories.get(id) ?? {
      title: via.title,
      severity: via.severity,
      url: via.url,
      packages: new Set(),
    };
    entry.packages.add(via.name);
    advisories.set(id, entry);
  }
}

const blocking = [...advisories].filter(
  ([id, a]) => BLOCKING.has(a.severity) && !ALLOWLIST.has(id),
);
const allowed = [...advisories].filter(([id]) => ALLOWLIST.has(id));

for (const [id, a] of allowed) {
  console.log(`allowed  ${a.severity.padEnd(8)} ${id}  ${[...a.packages].join(", ")}`);
  console.log(`         ${ALLOWLIST.get(id)}`);
}

// Stale entries are a warning, not a failure: the advisory database is a live
// service, so a transient omission must not redden an unrelated PR. The warning
// is still worth acting on — delete the entry once upstream has a fix.
for (const id of ALLOWLIST.keys()) {
  if (!advisories.has(id)) {
    console.warn(`warning: ${id} is allowlisted but no longer reported — drop it.`);
  }
}

if (blocking.length === 0) {
  console.log(`\nNo unallowed high/critical advisories (${allowed.length} allowlisted).`);
  process.exit(0);
}

console.error(
  `\n${blocking.length} unallowed high/critical advisor${blocking.length === 1 ? "y" : "ies"}:`,
);
for (const [id, a] of blocking) {
  console.error(`  ${a.severity.padEnd(8)} ${id}  ${[...a.packages].join(", ")}`);
  console.error(`           ${a.title}`);
  if (a.url) console.error(`           ${a.url}`);
}
console.error("\nUpgrade the dependency, or add an entry to ALLOWLIST in scripts/audit-check.mjs.");
process.exit(1);

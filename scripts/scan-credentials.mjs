// Scan a built asset directory for credentials that must not be redistributed.
//
// Why this exists: an artifact we redistribute must carry no credential of
// ours. `vite.config.ts` enforces that on the way in (BUILD_ENV_KEYS /
// CREDENTIAL_ENV_KEYS), but two things can defeat a config-level rule -- a build
// run by hand with an unexpected environment, and a third-party asset dropped
// into the tree with a key already inside it. Neither is visible from the
// config, so check the OUTPUT instead.
//
// Patterns live in scripts/credential-patterns.json because python/hatch_build.py
// runs the same scan without Node -- see that file before editing either reader.
//
// Usage:
//   node scripts/scan-credentials.mjs <dir>      # exits 1 on any finding
//   import { scanForCredentials } from "./scan-credentials.mjs"

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(resolve(scriptDir, "credential-patterns.json"), "utf8"));

const SCANNABLE = new Set(config.scannableExtensions);
const ALLOWED_VALUE_HASHES = new Set(Object.keys(config.allowedValueHashes ?? {}));

/**
 * Whether a matched value is a known public vendor token rather than ours.
 *
 * @param {string} value - The matched value.
 * @returns {boolean} True when the value is allowlisted.
 */
function isAllowed(value) {
  return ALLOWED_VALUE_HASHES.has(createHash("sha256").update(value).digest("hex"));
}

// `VITE_FOO:"value"` or `VITE_FOO="value"` with a non-empty value. Vite emits
// the former inside an inlined env object literal -- the exact shape that
// a whole-object read is inlined. An empty string is what a correctly stripped
// build produces, so it must not trip this.
const assignedNameRe = new RegExp(
  `\\b(${config.credentialEnvNames.join("|")})\\b\\s*[:=]\\s*["'\`]([^"'\`]+)["'\`]`,
  "g",
);

/**
 * Masks a secret so CI logs can point at it without republishing it.
 *
 * @param {string} value - The matched secret.
 * @returns {string} A redacted, identifiable form.
 */
function mask(value) {
  if (value.length <= 12) return `${value.slice(0, 2)}***`;
  return `${value.slice(0, 6)}...${value.slice(-4)} (${value.length} chars)`;
}

/**
 * Recursively lists every file under a directory.
 *
 * @param {string} dir - Directory to walk.
 * @returns {string[]} Absolute paths of every file found.
 */
function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

/**
 * Scans a directory of built assets for redistributable credentials.
 *
 * @param {string} dir - The built asset directory (e.g. dist-embed).
 * @returns {string[]} Sorted, unique findings; empty when the build is clean.
 */
export function scanForCredentials(dir) {
  const findings = [];
  for (const file of walk(dir)) {
    if (!SCANNABLE.has(extname(file))) continue;
    const text = readFileSync(file, "utf8");
    const rel = file.slice(dir.length + 1);
    for (const { name, regex } of config.patterns) {
      for (const m of text.matchAll(new RegExp(regex, "g"))) {
        if (isAllowed(m[0])) continue;
        findings.push(`${rel}: ${name} ${mask(m[0])}`);
      }
    }
    for (const m of text.matchAll(assignedNameRe)) {
      if (isAllowed(m[2])) continue;
      findings.push(`${rel}: ${m[1]} = ${mask(m[2])}`);
    }
  }
  return [...new Set(findings)].sort();
}

/** Guidance printed alongside any finding, shared with hatch_build.py. */
export const REMEDIATION =
  "This artifact is redistributed, so it must not carry your keys.\n" +
  "Most likely your shell exports GOOGLE_MAPS_API_KEY / MAPBOX_TOKEN / CESIUM_TOKEN\n" +
  "(vite.config.ts bridges bare names into their VITE_ forms) and the credential\n" +
  "strip did not apply. Check that GEOLIBRE_EMBED=1 reached the build, and see\n" +
  "CREDENTIAL_ENV_KEYS in apps/geolibre-desktop/vite.config.ts. Wheel users supply\n" +
  "their own tokens at runtime via Settings → Environment variables.\n\n" +
  "If this appeared right after a dependency bump, decode the value first: an\n" +
  "upstream library may ship its own public token (CesiumJS does). Confirm the\n" +
  "payload names the vendor, then update allowedValueHashes in\n" +
  "scripts/credential-patterns.json -- see docs/maintenance.md.";

// CLI entry point.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const target = process.argv[2];
  if (!target) {
    console.error("usage: node scripts/scan-credentials.mjs <dir>");
    process.exit(2);
  }
  const findings = scanForCredentials(resolve(target));
  if (findings.length > 0) {
    console.error(
      `[scan-credentials] ${findings.length} credential(s) found in ${target}:\n` +
        findings.map((f) => `  - ${f}`).join("\n") +
        `\n\n${REMEDIATION}`,
    );
    process.exit(1);
  }
  console.log(`[scan-credentials] Clean (${config.patterns.length} patterns) in ${target}`);
}

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { scanForCredentials } from "../scripts/scan-credentials.mjs";

// The guard that keeps a redistributed artifact from carrying a credential of
// ours. These tests use synthetic values shaped like the real thing -- never a
// live credential.

/** Writes files into a throwaway directory and scans it. */
function scan(files: Record<string, string>): string[] {
  const dir = mkdtempSync(join(tmpdir(), "geolibre-credscan-"));
  try {
    for (const [name, content] of Object.entries(files)) {
      const full = join(dir, name);
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, content);
    }
    return scanForCredentials(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("credential scan", () => {
  it("passes a bundle with no credentials", () => {
    assert.deepEqual(scan({ "assets/app.js": "const a=1;export{a};" }), []);
  });

  it("catches an inlined env object carrying credentials", () => {
    // The exact shape Vite emits for a whole-object `import.meta.env` read.
    const bundle =
      '{BASE_URL:"./",PROD:!0,VITE_GOOGLE_MAPS_API_KEY:"AIza' +
      "B".repeat(35) +
      '",VITE_PROTOMAPS_API_KEY:"52c129d45874742d"}';
    const findings = scan({ "assets/ClerkGate-abc.js": bundle });
    assert.ok(
      findings.some((f) => f.includes("VITE_GOOGLE_MAPS_API_KEY")),
      `expected a Google key finding, got ${JSON.stringify(findings)}`,
    );
    assert.ok(
      findings.some((f) => f.includes("VITE_PROTOMAPS_API_KEY")),
      "a key whose value matches no token shape must still be caught by name",
    );
  });

  it("catches a Google key ending in a dash", () => {
    // `\b` would fail here: `-` is not a word character, so no boundary exists
    // between it and the closing quote. The pattern uses a lookahead instead.
    const key = "AIza" + "A".repeat(34) + "-";
    assert.equal(scan({ "a.js": `k="${key}"` }).length, 1);
  });

  it("does not match a run longer than a Google key", () => {
    assert.deepEqual(scan({ "a.js": `k="AIza${"A".repeat(40)}"` }), []);
  });

  it("masks matched values so build logs never republish them", () => {
    const secret = "AIza" + "C".repeat(35);
    const findings = scan({ "a.js": `k="${secret}"` });
    assert.equal(findings.length, 1);
    assert.ok(!findings[0].includes(secret), "the full secret must not appear");
    assert.ok(findings[0].includes("(39 chars)"), "the mask should report length");
  });

  it("does not fire on an empty value, which is what a stripped build emits", () => {
    assert.deepEqual(
      scan({ "a.js": 'const e={VITE_CESIUM_TOKEN:"",VITE_MAPBOX_ACCESS_TOKEN:""}' }),
      [],
    );
  });

  it("ignores non-scannable files such as content-hashed wasm", () => {
    assert.deepEqual(scan({ "assets/x.wasm": "AIza" + "D".repeat(35) }), []);
  });

  it("allowlists CesiumJS's own public token, which ships in every build", () => {
    // CesiumJS hardcodes a default Ion token in its bundle. It matches the JWT
    // pattern and is present in every build, so without the allowlist the guard
    // would fire on every release and get disabled -- which is how guards die.
    // Read the real value from the installed package rather than pasting it, so
    // a Cesium upgrade surfaces here (the hash in credential-patterns.json must
    // then be refreshed; see docs/maintenance.md).
    const cesiumBundle = "../node_modules/cesium/Build/Cesium/Cesium.js";
    const path = new URL(cesiumBundle, import.meta.url).pathname;
    if (!existsSync(path)) return; // cesium not installed; nothing to assert
    const match = readFileSync(path, "utf8").match(/\beyJhbGciOi[A-Za-z0-9._-]{30,}/);
    assert.ok(match, "expected CesiumJS to still ship a default Ion token");
    assert.deepEqual(
      scan({ "assets/cesium-abc.js": `var JW="${match[0]}"` }),
      [],
      "CesiumJS's own default token must not be reported",
    );
  });

  it("still reports a JWT that is not the allowlisted vendor one", () => {
    const header = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9";
    const forged = `${header}.${"E".repeat(80)}.${"F".repeat(43)}`;
    const findings = scan({ "assets/cesium-abc.js": `var t="${forged}"` });
    assert.equal(findings.length, 1, `expected one finding, got ${JSON.stringify(findings)}`);
    assert.ok(findings[0].includes("JWT"));
  });
});

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// scripts/build-jupyterlite.mjs decides, from the environment alone, whether a
// build needs the self-hosted JupyterLite site. Getting that decision wrong is
// invisible at build time and only shows up in the shipped app: the Notebook
// panel points at `jupyterlite/lab/index.html`, and Tauri answers a missing
// asset with index.html, so a desktop build that skipped the site renders a
// second copy of GeoLibre inside the notebook iframe instead of a notebook
// (GeoLibre#1656 follow-up). The Mac App Store build is the case that matters:
// it has no JupyterLab server to fall back to.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(repoRoot, "scripts", "build-jupyterlite.mjs");

interface Run {
  status: number;
  output: string;
}

/**
 * Run the script with `jupyter` unreachable (empty PATH), so it always stops at
 * the CLI probe instead of spending a minute building the real site. What is
 * under test is the decision it makes before that point.
 *
 * Both build-flavor variables are cleared first so a caller that already has
 * them set (running the suite from inside a Tauri build, say) cannot flip a
 * case onto the wrong branch; each test opts back in through `env`.
 */
function run(env: Record<string, string>): Run {
  // The script reports on both streams (console.log for the skip, console.warn
  // / console.error for the missing CLI), so read them together.
  const result = spawnSync(process.execPath, [script], {
    cwd: repoRoot,
    env: { ...process.env, PATH: "", TAURI_ENV_PLATFORM: "", GEOLIBRE_MAS_BUILD: "", ...env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { status: result.status ?? 1, output: `${result.stdout}${result.stderr}` };
}

describe("build-jupyterlite.mjs", () => {
  it("skips the site for a regular desktop build, which ships a JupyterLab server", () => {
    const { status, output } = run({ TAURI_ENV_PLATFORM: "macos" });
    assert.equal(status, 0);
    assert.match(output, /skipping JupyterLite/);
  });

  it("does not skip the site for the Mac App Store build", () => {
    // The regression: this build is also a Tauri build, but its Jupyter server
    // is compiled out, so skipping the site leaves the Notebook panel with
    // nothing to load.
    const { output } = run({ TAURI_ENV_PLATFORM: "macos", GEOLIBRE_MAS_BUILD: "1" });
    assert.doesNotMatch(output, /skipping JupyterLite/);
  });

  it("fails the Mac App Store build when the JupyterLite CLI is missing", () => {
    // Best-effort would ship the broken Notebook panel; this build must stop.
    const { status, output } = run({ TAURI_ENV_PLATFORM: "macos", GEOLIBRE_MAS_BUILD: "1" });
    assert.equal(status, 1);
    assert.match(output, /Mac App Store build embeds the JupyterLite site/);
    assert.match(output, /jupyterlite\/requirements\.txt/);
  });

  it("stays best-effort for the web build when the CLI is missing", () => {
    const { status, output } = run({});
    assert.equal(status, 0);
    assert.match(output, /is not available/);
  });
});

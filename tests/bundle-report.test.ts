import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// scripts/bundle-report.mjs runs in CI after the web build. Drive it against a
// tiny fake build so the boot-set parsing and the report shape are checked
// without a real (multi-minute) build.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(repoRoot, "scripts", "bundle-report.mjs");

interface Report {
  budget: { rawBytes: number; gzipBytes: number };
  boot: {
    js: { raw: number; gzip: number; files: Array<{ file: string; raw: number }> };
    css: { raw: number; files: Array<{ file: string }> };
  };
  totals: { js: { raw: number }; wasm: { raw: number } };
  assets: Array<{ file: string; kind: string; raw: number; gzip: number; boot: boolean }>;
}

const work = mkdtempSync(path.join(tmpdir(), "bundle-report-"));
after(() => rmSync(work, { recursive: true, force: true }));

/**
 * Write a fake build under a base path and run the report against it.
 *
 * @param base - The deployment base the fake index.html uses in its URLs.
 * @returns The parsed JSON report and the Markdown.
 */
function runReport(base: string): { report: Report; markdown: string } {
  const dist = mkdtempSync(path.join(work, "dist-"));
  const out = path.join(dist, "..", `${path.basename(dist)}-out`);
  mkdirSync(path.join(dist, "assets"));
  writeFileSync(path.join(dist, "assets", "main-a.js"), "export const a = 1;\n".repeat(50));
  writeFileSync(path.join(dist, "assets", "vendor-b.js"), "export const b = 2;\n".repeat(20));
  writeFileSync(path.join(dist, "assets", "lazy-c.js"), "export const c = 3;\n".repeat(200));
  writeFileSync(path.join(dist, "assets", "engine-d.wasm"), Buffer.alloc(4096, 7));
  writeFileSync(path.join(dist, "assets", "main-e.css"), "body{color:red}\n");
  writeFileSync(
    path.join(dist, "index.html"),
    [
      "<!doctype html><html><head>",
      `<script type="module" crossorigin src="${base}assets/main-a.js"></script>`,
      `<link rel="modulepreload" crossorigin href="${base}assets/vendor-b.js">`,
      `<link rel="stylesheet" crossorigin href="${base}assets/main-e.css">`,
      `<link rel="icon" href="${base}favicon.ico">`,
      '<script src="https://example.com/remote.js"></script>',
      "</head><body></body></html>",
    ].join("\n"),
  );
  execFileSync(process.execPath, [script, "--dist", dist, "--out", out], { encoding: "utf8" });
  return {
    report: JSON.parse(readFileSync(path.join(out, "bundle-report.json"), "utf8")) as Report,
    markdown: readFileSync(path.join(out, "bundle-report.md"), "utf8"),
  };
}

describe("bundle-report.mjs", () => {
  for (const base of ["/", "./", "/geolibre/"]) {
    it(`reads the boot set from index.html with base ${JSON.stringify(base)}`, () => {
      const { report } = runReport(base);
      assert.deepEqual(
        report.boot.js.files.map((f) => f.file),
        ["assets/main-a.js", "assets/vendor-b.js"],
      );
      assert.deepEqual(
        report.boot.css.files.map((f) => f.file),
        ["assets/main-e.css"],
      );
      assert.equal(report.boot.js.raw, 20 * 50 + 20 * 20);
    });
  }

  it("lists every JS and WASM asset with raw and gzip sizes", () => {
    const { report, markdown } = runReport("/");
    assert.deepEqual(
      report.assets.map((a) => [a.file, a.kind, a.boot]),
      [
        ["assets/engine-d.wasm", "wasm", false],
        ["assets/lazy-c.js", "js", false],
        ["assets/main-a.js", "js", true],
        ["assets/vendor-b.js", "js", true],
      ],
    );
    for (const asset of report.assets) {
      assert.ok(asset.gzip > 0 && asset.gzip < asset.raw, `${asset.file} gzip size`);
    }
    assert.equal(report.totals.wasm.raw, 4096);
    assert.equal(report.totals.js.raw, 20 * (50 + 20 + 200));
    assert.ok(report.budget.rawBytes > 0 && report.budget.gzipBytes > 0);
    assert.match(markdown, /## Bundle report/);
    assert.match(markdown, /`assets\/lazy-c\.js`/);
  });
});

// Bundle size report for the production web build.
// Run after `npm run build`: node scripts/bundle-report.mjs  (or `npm run bundle:report`)
//
// Lists every JS and WASM file under dist/assets with its raw and gzip size,
// totals the boot set (what index.html loads and modulepreloads before the
// shell can mount), and writes the result as Markdown and JSON so CI can attach
// it to a run and a reviewer can diff two builds.
//
// The boot set is read from the built index.html rather than recomputed from
// the module graph, so it is exactly what a browser fetches. The build itself
// enforces the boot budgets (bootBundleBudgetPlugin in
// apps/geolibre-desktop/vite.config.ts); this report only shows them next to
// the measured numbers. Both read apps/geolibre-desktop/boot-budget.json.
//
// Options:
//   --dist <dir>  build output to read (default apps/geolibre-desktop/dist)
//   --out <dir>   where to write bundle-report.{md,json} (default bundle-report)
//   --top <n>     rows in the Markdown asset table (default 40; JSON has all)
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP_DIR = path.join(ROOT, "apps", "geolibre-desktop");

/**
 * Parse `--name value` options.
 *
 * @param {string[]} argv - Arguments after the script path.
 * @returns {{dist: string, out: string, top: number}} The resolved options.
 */
function parseArgs(argv) {
  const options = {
    dist: path.join(APP_DIR, "dist"),
    out: path.join(ROOT, "bundle-report"),
    top: 40,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`${flag} needs a value`);
    if (flag === "--dist") options.dist = path.resolve(value);
    else if (flag === "--out") options.out = path.resolve(value);
    else if (flag === "--top") options.top = Number.parseInt(value, 10);
    else throw new Error(`Unknown option ${flag}`);
    i += 1;
  }
  return options;
}

/**
 * Raw and gzip byte counts of a file.
 *
 * @param {string} file - Absolute path.
 * @returns {{raw: number, gzip: number}} Sizes in bytes; gzip at level 9.
 */
function measure(file) {
  const bytes = readFileSync(file);
  return { raw: bytes.length, gzip: gzipSync(bytes, { level: 9 }).length };
}

/**
 * Total size of every file under a directory.
 *
 * @param {string} dir - Absolute directory path.
 * @returns {number} Bytes.
 */
function directoryBytes(dir) {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += directoryBytes(full);
    else if (entry.isFile()) total += statSync(full).size;
  }
  return total;
}

/**
 * Map a URL from index.html to a file in the build output.
 *
 * The URL carries the deployment base (`/`, `./`, `/geolibre/`, …), which the
 * report does not know, so leading path segments are dropped until the rest
 * names a file in dist.
 *
 * @param {string} dist - Build output directory.
 * @param {string} url - A `src`/`href` attribute value.
 * @returns {string | null} The relative path inside dist, or null if not found.
 */
function resolveBuiltUrl(dist, url) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith("//")) return null;
  const segments = url
    .split(/[?#]/)[0]
    .split("/")
    .filter((s) => s && s !== ".");
  for (let start = 0; start < segments.length; start += 1) {
    const relative = segments.slice(start).join("/");
    if (existsSync(path.join(dist, relative))) return relative;
  }
  return null;
}

/**
 * The files index.html fetches before the app mounts.
 *
 * @param {string} dist - Build output directory.
 * @returns {{js: string[], css: string[]}} Paths relative to dist, in order.
 */
function bootSet(dist) {
  const html = readFileSync(path.join(dist, "index.html"), "utf8");
  const js = [];
  const css = [];
  for (const [tag] of html.matchAll(/<(?:script|link)\b[^>]*>/g)) {
    const attr = (name) => tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];
    let target = null;
    if (tag.startsWith("<script") && attr("type") === "module") target = js;
    else if (attr("rel") === "modulepreload") target = js;
    else if (attr("rel") === "stylesheet") target = css;
    const url = attr("src") ?? attr("href");
    if (!target || !url) continue;
    const file = resolveBuiltUrl(dist, url);
    if (file && !target.includes(file)) target.push(file);
  }
  return { js, css };
}

/**
 * Format a byte count for the Markdown table.
 *
 * @param {number} bytes - Byte count.
 * @returns {string} e.g. `1.23 MB` or `456.7 kB`.
 */
function human(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  return `${(bytes / 1024).toFixed(1)} kB`;
}

/**
 * Sum the raw and gzip sizes of a list of measured files.
 *
 * @param {{raw: number, gzip: number}[]} files - Measured files.
 * @returns {{raw: number, gzip: number}} The totals.
 */
function sum(files) {
  return files.reduce((t, f) => ({ raw: t.raw + f.raw, gzip: t.gzip + f.gzip }), {
    raw: 0,
    gzip: 0,
  });
}

/**
 * Build the report data.
 *
 * @param {string} dist - Build output directory.
 * @returns {object} The JSON report.
 */
function buildReport(dist) {
  if (!existsSync(path.join(dist, "index.html"))) {
    throw new Error(`No index.html in ${dist}. Run \`npm run build\` first.`);
  }
  const budget = JSON.parse(readFileSync(path.join(APP_DIR, "boot-budget.json"), "utf8"));
  const assetsDir = path.join(dist, "assets");
  const assets = readdirSync(assetsDir)
    .filter((name) => /\.(?:m?js|wasm)$/.test(name))
    .map((name) => ({
      file: `assets/${name}`,
      kind: name.endsWith(".wasm") ? "wasm" : "js",
      ...measure(path.join(assetsDir, name)),
    }))
    .sort((a, b) => b.raw - a.raw || a.file.localeCompare(b.file));

  const boot = bootSet(dist);
  const byFile = new Map(assets.map((a) => [a.file, a]));
  const bootJs = boot.js.map(
    (file) => byFile.get(file) ?? { file, ...measure(path.join(dist, file)) },
  );
  const bootCss = boot.css.map((file) => ({ file, ...measure(path.join(dist, file)) }));
  for (const asset of assets) asset.boot = boot.js.includes(asset.file);

  const topLevel = readdirSync(dist, { withFileTypes: true })
    .map((entry) => {
      const full = path.join(dist, entry.name);
      return {
        path: entry.name,
        bytes: entry.isDirectory() ? directoryBytes(full) : statSync(full).size,
      };
    })
    .sort((a, b) => b.bytes - a.bytes);

  return {
    generatedAt: new Date().toISOString(),
    dist: path.relative(ROOT, dist) || ".",
    budget,
    boot: {
      js: { ...sum(bootJs), files: bootJs.map(({ file, raw, gzip }) => ({ file, raw, gzip })) },
      css: { ...sum(bootCss), files: bootCss },
    },
    totals: {
      dist: topLevel.reduce((t, e) => t + e.bytes, 0),
      js: sum(assets.filter((a) => a.kind === "js")),
      wasm: sum(assets.filter((a) => a.kind === "wasm")),
    },
    topLevel,
    assets,
  };
}

/**
 * Render the report as Markdown (fits a GitHub step summary).
 *
 * @param {object} report - The JSON report.
 * @param {number} top - How many of the largest assets to list.
 * @returns {string} Markdown.
 */
function toMarkdown(report, top) {
  const { boot, budget, totals } = report;
  const pct = (value, limit) => `${((value / limit) * 100).toFixed(0)}%`;
  const lines = [
    "## Bundle report",
    "",
    `Build output \`${report.dist}\`: ${human(totals.dist)} on disk. ` +
      `JS in assets/: ${human(totals.js.raw)} raw, ${human(totals.js.gzip)} gzip. ` +
      `WASM in assets/: ${human(totals.wasm.raw)} raw, ${human(totals.wasm.gzip)} gzip.`,
    "",
    "### Boot set",
    "",
    "What index.html loads and modulepreloads before the shell mounts.",
    "",
    "| | Files | Raw | Gzip | Budget (raw / gzip) |",
    "| --- | ---: | ---: | ---: | --- |",
    `| JS | ${boot.js.files.length} | ${human(boot.js.raw)} | ${human(boot.js.gzip)} | ` +
      `${human(budget.rawBytes)} (${pct(boot.js.raw, budget.rawBytes)}) / ` +
      `${human(budget.gzipBytes)} (${pct(boot.js.gzip, budget.gzipBytes)}) |`,
    `| CSS | ${boot.css.files.length} | ${human(boot.css.raw)} | ${human(boot.css.gzip)} | |`,
    "",
    "<details><summary>Boot JS files</summary>",
    "",
    "| File | Raw | Gzip |",
    "| --- | ---: | ---: |",
    ...[...boot.js.files]
      .sort((a, b) => b.raw - a.raw)
      .map((f) => `| \`${f.file}\` | ${human(f.raw)} | ${human(f.gzip)} |`),
    "",
    "</details>",
    "",
    `### Largest JS/WASM assets (${Math.min(top, report.assets.length)} of ${report.assets.length})`,
    "",
    "| File | Raw | Gzip | Boot |",
    "| --- | ---: | ---: | :---: |",
    ...report.assets
      .slice(0, top)
      .map(
        (a) => `| \`${a.file}\` | ${human(a.raw)} | ${human(a.gzip)} | ${a.boot ? "yes" : ""} |`,
      ),
    "",
    "### Build output by top-level entry",
    "",
    "| Path | Size |",
    "| --- | ---: |",
    ...report.topLevel.slice(0, 15).map((e) => `| \`${e.path}\` | ${human(e.bytes)} |`),
    "",
  ];
  return lines.join("\n");
}

const options = parseArgs(process.argv.slice(2));
const report = buildReport(options.dist);
mkdirSync(options.out, { recursive: true });
writeFileSync(path.join(options.out, "bundle-report.json"), `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(path.join(options.out, "bundle-report.md"), toMarkdown(report, options.top));
console.log(
  `Boot JS: ${human(report.boot.js.raw)} raw, ${human(report.boot.js.gzip)} gzip ` +
    `(${report.boot.js.files.length} files). Assets: ${report.assets.length} JS/WASM files. ` +
    `Report written to ${path.relative(ROOT, options.out) || "."}/bundle-report.{md,json}.`,
);

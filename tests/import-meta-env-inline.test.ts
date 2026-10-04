import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SOURCE_ROOTS = ["apps/geolibre-desktop/src", "packages"];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === "node_modules" || name === "dist") return [];
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

// Vite rewrites only the literal `import.meta.env` expression. Binding
// `import.meta` to a variable first (`const meta = import.meta; meta.env`)
// ships `import.meta.env` to the browser unreplaced, where it is undefined, so
// BASE_URL silently became "/" and subpath deployments fetched deployment.json
// from the site root. Read `(import.meta as ...).env` inline instead.
test("import.meta is never bound to a variable in app sources", () => {
  const offenders: string[] = [];
  const alias = /=\s*import\.meta(?:\s+as\s[^;\n]*)?\s*;/;
  for (const root of SOURCE_ROOTS) {
    for (const file of sourceFiles(join(ROOT, root))) {
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, index) => {
          if (alias.test(line)) offenders.push(`${relative(ROOT, file)}:${index + 1}`);
        });
    }
  }
  assert.deepEqual(offenders, []);
});

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const E2E_DIR = fileURLToPath(new URL("../e2e/", import.meta.url));

/**
 * An import from `@playwright/test` that can bind a value: named, aliased or
 * namespace. Only an `import type { ... }` declaration passes; an inline
 * `import { type X }` is rejected too, and is written as `import type` instead.
 */
const DIRECT_IMPORT = /^\s*import\s+(?!type\b)[^;]*?\bfrom\s*["']@playwright\/test["']/m;

// `e2e/test.ts` blanks a passing test's pages before Playwright disposes its
// browser context. Disposing a context that still holds a live SwiftShader map
// wedges the browser and stalls the next test's context setup by up to a
// minute (#2879). A spec that takes `test` from `@playwright/test` directly,
// under any name, skips that teardown and quietly brings the stall back for its
// neighbours. `e2e/test.ts` re-exports the whole package, so a spec never needs
// a value import from it. Nested suites (enterprise-sso/, preview/) count too.
test("every e2e spec takes `test` from e2e/test.ts", () => {
  const offenders = readdirSync(E2E_DIR, { recursive: true, encoding: "utf8" })
    .filter((path) => path.endsWith(".spec.ts"))
    .filter((path) => DIRECT_IMPORT.test(readFileSync(`${E2E_DIR}${path}`, "utf8")))
    .sort();
  assert.deepEqual(offenders, [], 'import from "./test" (or "../test") instead');
});

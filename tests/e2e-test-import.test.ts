import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const E2E_DIR = fileURLToPath(new URL("../e2e/", import.meta.url));

// `e2e/test.ts` blanks a passing test's pages before Playwright disposes its
// browser context. Disposing a context that still holds a live SwiftShader map
// wedges the browser and stalls the next test's context setup by up to a
// minute (#2879). A spec that takes `test` from `@playwright/test` directly
// skips that teardown and quietly brings the stall back for its neighbours.
test("every e2e spec takes `test` from e2e/test.ts", () => {
  const offenders = readdirSync(E2E_DIR)
    .filter((name) => name.endsWith(".spec.ts"))
    .filter((name) => {
      const source = readFileSync(`${E2E_DIR}${name}`, "utf8");
      return /\btest\b[^}]*\}\s*from\s*["']@playwright\/test["']/.test(source);
    });
  assert.deepEqual(offenders, [], 'import { test } from "./test" instead');
});

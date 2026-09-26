import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { waitForMap } from "./helpers";

const PLUGINS_DOC = join(__dirname, "..", "docs", "user-guide", "plugins.md");

/**
 * The link names in the "Open a plugin from a link" table of the Plugins page,
 * one backticked name in the second column of each row.
 */
function documentedLinkNames(): string[] {
  const doc = readFileSync(PLUGINS_DOC, "utf8");
  const start = doc.indexOf("## Open a plugin from a link");
  expect(start, "plugins.md lost its 'Open a plugin from a link' section").toBeGreaterThan(-1);
  const section = doc.slice(start, doc.indexOf("\n## ", start + 1));
  return [...section.matchAll(/^\|[^|\n]+\|\s*`([^`]+)`\s*\|$/gm)].map((match) => match[1]).sort();
}

test("?plugin= activates a built-in plugin", async ({ page }) => {
  await waitForMap(page, "/?plugin=swipe");
  await expect(page.locator(".swipe-control")).toBeVisible({ timeout: 30_000 });
});

/**
 * The app is the only place the full list of deep-linkable plugins exists (the
 * plugins can't be imported into a node test), so this reads it from the
 * warning an unknown name prints and holds the docs table to it. A new built-in
 * plugin fails here until the Plugins page lists its link name.
 */
test("the Plugins page lists every ?plugin= link name", async ({ page }) => {
  const warning = page.waitForEvent("console", {
    predicate: (message) => message.text().includes("in the ?plugin= link"),
    timeout: 60_000,
  });
  await waitForMap(page, "/?plugin=not-a-real-plugin");
  const text = (await warning).text();
  const match = /Valid names: (.+)$/.exec(text);
  expect(match, `unexpected warning: ${text}`).not.toBeNull();
  const valid = match![1].split(", ").sort();

  expect(documentedLinkNames()).toEqual(valid);
});

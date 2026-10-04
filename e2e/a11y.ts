import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, type TestInfo } from "@playwright/test";

/**
 * A serious axe finding the suite tolerates, scoped to specific nodes rather
 * than to the rule as a whole: a violation passes only when *every* node it
 * reports matches `html`, so the same rule failing anywhere else still fails.
 *
 * Only DOM the app does not render may be allowlisted — an upstream control's
 * own markup (a `maplibre-gl-*` package), say. Name the package in `reason`.
 * Findings in the app's own components are fixed, not listed here.
 */
export interface AllowedViolation {
  /** The axe rule id, e.g. `color-contrast`. */
  rule: string;
  /** Matched against each reported node's (truncated) outer HTML. */
  html: RegExp;
  /** Why it cannot be fixed in this repository, naming the owning package. */
  reason: string;
}

interface AxeViolation {
  id: string;
  impact?: string | null;
  nodes: Array<{ html: string }>;
}

function isAllowed(violation: AxeViolation, allow: readonly AllowedViolation[]): boolean {
  if (violation.nodes.length === 0) return false;
  return allow.some(
    (entry) =>
      entry.rule === violation.id && violation.nodes.every((node) => entry.html.test(node.html)),
  );
}

/**
 * Runs axe against the current screen and fails on any critical violation, or
 * any serious one not covered by `allow`. Moderate and minor findings are
 * attached for review but do not fail. Every screen's full violation list is
 * attached as a test artifact, named after `label`.
 *
 * @param page - The page to scan, already showing the screen under test.
 * @param label - Names the screen in the failure message and the attachment.
 * @param testInfo - The running test's info, for the attachment.
 * @param allow - Upstream findings this screen may report (see {@link AllowedViolation}).
 */
export async function expectAccessible(
  page: Page,
  label: string,
  testInfo: TestInfo,
  allow: readonly AllowedViolation[] = [],
): Promise<void> {
  // Let enter animations and colour transitions finish first: axe samples
  // colours as they are mid-fade, and a half-faded button reads as a contrast
  // failure that no user ever sees. Looping animations (spinners) never
  // finish, so they are not waited on.
  await page.waitForFunction(() =>
    document
      .getAnimations()
      .every(
        (animation) =>
          animation.playState !== "running" ||
          animation.effect?.getComputedTiming().iterations === Infinity,
      ),
  );
  const { violations } = await new AxeBuilder({ page }).analyze();
  await testInfo.attach(`axe-${label}`, {
    body: JSON.stringify(violations, null, 2),
    contentType: "application/json",
  });
  const blocking = violations.filter(
    (v) => v.impact === "critical" || (v.impact === "serious" && !isAllowed(v, allow)),
  );
  expect(
    blocking,
    `${label} — blocking a11y violations: ${
      blocking
        .map((v) => `${v.impact}/${v.id} at ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)
        .join("; ") || "none"
    }`,
  ).toEqual([]);
}

import { render, screen, waitFor } from "./helpers/dom";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";

// Loaded after the harness so its CSS imports and Vite globals are handled.
const { NewProjectDialog } =
  await import("../apps/geolibre-desktop/src/components/layout/NewProjectDialog");
const { STARTER_PROJECTS } = await import("../apps/geolibre-desktop/src/lib/starter-projects");

function renderDialog(showExamples: boolean) {
  return render(
    createElement(NewProjectDialog, {
      open: true,
      onOpenChange: () => {},
      onSaveCurrentProject: async () => true,
      onOpenExample: async () => {},
      showExamples,
    }),
  );
}

const cardCount = () => document.querySelectorAll("[data-starter-project]").length;

describe("NewProjectDialog starter examples", () => {
  it("keeps the Examples section collapsed by default", async () => {
    renderDialog(false);
    await screen.findByText("Examples");
    assert.equal(cardCount(), 0);
  });

  it("opens with the Examples expanded and the first example focused", async (t) => {
    if (STARTER_PROJECTS.length === 0) {
      t.skip("this build bundles no starter projects");
      return;
    }
    renderDialog(true);
    await screen.findByText("Examples");
    assert.equal(cardCount(), STARTER_PROJECTS.length);
    await waitFor(() => {
      assert.equal(
        document.activeElement?.getAttribute("data-testid"),
        `starter-project-${STARTER_PROJECTS[0].id}`,
      );
    });
  });
});

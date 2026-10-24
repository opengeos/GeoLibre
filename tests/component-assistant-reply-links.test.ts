import { fireEvent, render, screen } from "./helpers/dom";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";

// Loaded after the harness so its CSS imports and Vite globals are handled.
const { AssistantPanel } =
  await import("../apps/geolibre-desktop/src/components/panels/AssistantPanel");

/** A mouse event as the browser dispatches it on a link, cancelable. */
const mouse = (type: string, button = 0) =>
  new MouseEvent(type, { bubbles: true, cancelable: true, button });

describe("AssistantPanel reply links", () => {
  it("opens transcript links outside the app, middle-click too, until unmounted", async () => {
    const opened: string[] = [];
    const windowOpen = window.open;
    window.open = ((url?: string | URL) => {
      opened.push(String(url));
      return null;
    }) as typeof window.open;
    try {
      const { unmount } = render(
        createElement(AssistantPanel, { mapControllerRef: { current: null } }),
      );
      // With no provider the transcript holds the setup card; a reply's links
      // are rendered into the same container.
      const card = await screen.findByText("Set up the AI Assistant");
      const transcript = card.closest(".overflow-auto");
      assert.ok(transcript, "transcript container");
      const link = document.createElement("a");
      link.setAttribute("href", "https://www.ingv.it/");
      transcript.append(link);

      // fireEvent returns false when the handler cancelled the default action.
      assert.equal(fireEvent(link, mouse("click")), false);
      assert.equal(fireEvent(link, mouse("auxclick", 1)), false);
      // The right button keeps its default (the context menu).
      assert.equal(fireEvent(link, mouse("auxclick", 2)), true);
      assert.deepEqual(opened, ["https://www.ingv.it/", "https://www.ingv.it/"]);

      unmount();
      fireEvent(link, mouse("click"));
      assert.equal(opened.length, 2, "listeners removed on unmount");
    } finally {
      window.open = windowOpen;
    }
  });
});

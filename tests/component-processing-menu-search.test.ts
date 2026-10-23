import { fireEvent, render, screen } from "./helpers/dom";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement, useState } from "react";
import type { Command } from "../apps/geolibre-desktop/src/lib/commands";

const { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } = await import("@geolibre/ui");
const { ProcessingMenuSearch } =
  await import("../apps/geolibre-desktop/src/components/layout/toolbar/ProcessingMenuSearch");

function command(id: string, title: string, group: string, run: () => void): Command {
  return { id, title, group, run };
}

function renderSearch(commands: Command[], events: string[]) {
  function Harness() {
    const [open, setOpen] = useState(true);
    const [query, setQuery] = useState("");
    return createElement(
      DropdownMenu,
      { open, onOpenChange: setOpen },
      createElement(DropdownMenuTrigger, null, "Processing"),
      createElement(
        DropdownMenuContent,
        null,
        createElement(ProcessingMenuSearch, {
          commands,
          open,
          query,
          onQueryChange: setQuery,
          onRun: (item) => {
            events.push(item.id);
            item.run();
          },
          onDismiss: () => {
            events.push("dismiss");
            setOpen(false);
          },
        }),
      ),
    );
  }
  render(createElement(Harness));
  return screen.getByRole("combobox", { name: "Search processing tools" });
}

describe("ProcessingMenuSearch", () => {
  it("filters commands and runs the keyboard-selected result", () => {
    const events: string[] = [];
    const input = renderSearch(
      [
        command("proc.buffer", "Buffer", "Processing", () => events.push("ran-buffer")),
        command("proc.buffer-raster", "Buffer Raster", "Whitebox", () => events.push("ran-raster")),
        command("proc.clip", "Clip", "Processing", () => events.push("ran-clip")),
      ],
      events,
    );

    assert.equal(input.getAttribute("aria-expanded"), "false");
    assert.equal(input.getAttribute("aria-controls"), null);
    fireEvent.change(input, { target: { value: "  buffer  " } });
    assert.equal(input.getAttribute("aria-expanded"), "true");
    assert.equal(input.getAttribute("aria-controls"), "processing-menu-search-results");
    assert.deepEqual(
      screen.getAllByRole("option").map((option) => option.textContent),
      ["BufferProcessing", "Buffer RasterWhitebox"],
    );

    input.focus();
    let scrolledIntoView = false;
    Object.defineProperty(screen.getAllByRole("option")[1], "scrollIntoView", {
      value: (options: ScrollIntoViewOptions) => {
        scrolledIntoView = options.block === "nearest";
      },
    });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    const options = screen.getAllByRole("option");
    assert.equal(scrolledIntoView, true);
    assert.equal(options[1].getAttribute("aria-selected"), "true");
    assert.equal(fireEvent.pointerMove(options[0], { pointerType: "mouse" }), false);
    assert.equal(options[0].getAttribute("aria-selected"), "true");
    assert.equal(document.activeElement, input);

    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    assert.deepEqual(events, []);
    fireEvent.keyDown(input, { key: "Enter" });
    assert.deepEqual(events, ["proc.buffer-raster", "ran-raster"]);
  });

  it("shows an empty state and dismisses on Escape", () => {
    const events: string[] = [];
    const input = renderSearch(
      [command("proc.buffer", "Buffer", "Processing", () => events.push("ran"))],
      events,
    );

    fireEvent.change(input, { target: { value: "missing" } });
    assert.equal(
      screen.getByText("No matching processing tools").textContent,
      "No matching processing tools",
    );
    fireEvent.keyDown(input, { key: "Escape" });
    assert.deepEqual(events, ["dismiss"]);
  });

  it("announces when matching results are capped", () => {
    const input = renderSearch(
      Array.from({ length: 101 }, (_, index) =>
        command(`proc.tool-${index}`, `Tool ${index}`, "Processing", () => {}),
      ),
      [],
    );

    fireEvent.change(input, { target: { value: "tool" } });
    assert.equal(screen.getAllByRole("option").length, 100);
    assert.equal(screen.getByRole("status").textContent, "Showing the first 100 matching tools");
  });
});

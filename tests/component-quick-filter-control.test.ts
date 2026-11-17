import { fireEvent, render, screen } from "./helpers/dom";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement, useState } from "react";
import type { LayerQuickFilter } from "@geolibre/core";
import type { QuickFilterFieldProfile } from "../apps/geolibre-desktop/src/lib/quick-filter-profile";

const { QuickFilterControl } =
  await import("../apps/geolibre-desktop/src/components/panels/QuickFilterControl");

const EIGHT_VALUES = ["A", "B", "C", "D", "E", "F", "G", "H"];

function profileOf(values: string[], blankCount: number): QuickFilterFieldProfile {
  const present = values.length * 2;
  return {
    field: "kind",
    kind: "categorical",
    availableKinds: ["categorical", "text"],
    values: values.map((value) => ({ value, count: 2 })),
    valuesTruncated: false,
    blankCount,
    sampled: present + blankCount,
    present,
  };
}

/**
 * Render the control the way the Style panel does: it owns the filter and
 * passes each edit back in, so the control sees its own changes.
 */
function renderControl(initial: LayerQuickFilter, profile: QuickFilterFieldProfile) {
  const edits: LayerQuickFilter[] = [];
  function Harness() {
    const [filter, setFilter] = useState(initial);
    return createElement(QuickFilterControl, {
      filter,
      profile,
      idPrefix: "test",
      onChange: (next: LayerQuickFilter) => {
        edits.push(next);
        setFilter(next);
      },
    });
  }
  render(createElement(Harness));
  return { lastEdit: () => edits.at(-1) };
}

function valueLabels(): string[] {
  return Array.from(
    screen.getByTestId("quick-filter-values").querySelectorAll("label"),
    (label) => label.querySelector("span")?.textContent ?? "",
  );
}

function blankCheckbox(): HTMLInputElement {
  return screen.getByRole("checkbox", { name: /\(blank\)/ }) as HTMLInputElement;
}

describe("QuickFilterControl (blank) option (issue #3455)", () => {
  it("lists (blank) last with its count, and checking it saves includeBlank", () => {
    const { lastEdit } = renderControl(
      { id: "q1", field: "kind", kind: "categorical", values: [] },
      profileOf(["Park", "School"], 12),
    );
    assert.deepEqual(valueLabels(), ["Park", "School", "(blank)"]);
    assert.match(blankCheckbox().closest("label")?.textContent ?? "", /12/);

    fireEvent.click(blankCheckbox());
    assert.equal(lastEdit()?.includeBlank, true);
    assert.deepEqual(lastEdit()?.values, []);
    assert.equal(blankCheckbox().checked, true);
    assert.match(screen.getByTestId("quick-filter").textContent ?? "", /1 selected/);
  });

  it("hides (blank) when the field has none and it is not chosen", () => {
    renderControl(
      { id: "q1", field: "kind", kind: "categorical", values: [] },
      profileOf(["Park", "School"], 0),
    );
    assert.deepEqual(valueLabels(), ["Park", "School"]);
  });

  it("keeps the search box while it holds text, even below the threshold", () => {
    // Eight values plus a saved (blank) the data no longer has: nine options,
    // one over the threshold, so the search box shows.
    renderControl(
      {
        id: "q1",
        field: "kind",
        kind: "categorical",
        values: [],
        includeBlank: true,
      },
      profileOf(EIGHT_VALUES, 0),
    );
    const search = screen.getByRole("textbox", { name: "Search values" });
    fireEvent.change(search, { target: { value: "blank" } });
    assert.deepEqual(valueLabels(), ["(blank)"]);

    // Unchecking it drops the list to eight options. The box must stay, or the
    // search would keep hiding every value with no way to clear it.
    fireEvent.click(blankCheckbox());
    assert.notEqual(screen.queryByRole("textbox", { name: "Search values" }), null);
    assert.deepEqual(valueLabels(), []);
    assert.match(
      screen.getByTestId("quick-filter-values").textContent ?? "",
      /No values match your search/,
    );

    fireEvent.change(screen.getByRole("textbox", { name: "Search values" }), {
      target: { value: "" },
    });
    assert.deepEqual(valueLabels(), EIGHT_VALUES);
    assert.equal(screen.queryByRole("textbox", { name: "Search values" }), null);
  });

  it("Select all with no search also ticks (blank)", () => {
    const { lastEdit } = renderControl(
      { id: "q1", field: "kind", kind: "categorical", values: [] },
      profileOf(["Park", "School"], 3),
    );
    fireEvent.click(screen.getByRole("button", { name: "Select all" }));
    assert.deepEqual(lastEdit()?.values, ["Park", "School"]);
    assert.equal(lastEdit()?.includeBlank, true);

    fireEvent.click(screen.getByRole("button", { name: "Select none" }));
    assert.deepEqual(lastEdit()?.values, []);
    assert.equal(lastEdit()?.includeBlank, undefined);
  });

  it("the clear button resets (blank) too", () => {
    const { lastEdit } = renderControl(
      {
        id: "q1",
        field: "kind",
        kind: "categorical",
        values: [],
        includeBlank: true,
      },
      profileOf(["Park"], 2),
    );
    fireEvent.click(screen.getByRole("button", { name: /Clear/ }));
    assert.equal(lastEdit()?.includeBlank, undefined);
    assert.equal(blankCheckbox().checked, false);
  });
});

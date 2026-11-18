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
  return { edits, lastEdit: () => edits.at(-1) };
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

/** A field where a few outliers stretch the extent far past the typical values. */
const OUTLIER_PROFILE: QuickFilterFieldProfile = {
  field: "area_sq_m",
  kind: "range",
  availableKinds: ["range", "categorical"],
  values: [],
  valuesTruncated: true,
  blankCount: 0,
  min: -42.5,
  max: 1e12,
  typical: { min: 0.3, max: 4680, below: 13, above: 13 },
  sampled: 1284,
  present: 1284,
};

/** The same field without outliers: the slider spans its exact extent. */
const PLAIN_PROFILE: QuickFilterFieldProfile = {
  ...OUTLIER_PROFILE,
  field: "rating",
  min: 0,
  max: 5,
  typical: undefined,
};

function renderRange(filter: Partial<LayerQuickFilter>, profile: QuickFilterFieldProfile) {
  return renderControl(
    { id: "qf", field: profile.field, kind: "range", min: null, max: null, ...filter },
    profile,
  ).edits;
}

/** Press a key on a slider thumb, focusing it first as Radix expects. */
function pressOnThumb(name: "Minimum" | "Maximum", key: string): void {
  const thumb = screen.getByRole("slider", { name });
  fireEvent.focus(thumb);
  fireEvent.keyDown(thumb, { key });
}

const thumbValue = (name: "Minimum" | "Maximum"): string | null =>
  screen.getByRole("slider", { name }).getAttribute("aria-valuenow");

describe("QuickFilterControl range with outliers (#3455)", () => {
  it("scales the slider to the typical range and says what lies beyond it", () => {
    renderRange({}, OUTLIER_PROFILE);
    assert.equal(thumbValue("Minimum"), "0.3");
    assert.equal(thumbValue("Maximum"), "4680");
    const hint = screen.getByTestId("quick-filter-outliers").textContent ?? "";
    assert.match(hint, /13 values below 0\.3/);
    assert.match(hint, /13 values above 4,680/);
  });

  it("moving one handle inward sets that bound and leaves the other side open", () => {
    const changes = renderRange({}, OUTLIER_PROFILE);
    pressOnThumb("Maximum", "ArrowLeft");
    assert.equal(changes.length, 1);
    assert.equal(changes[0].min, null);
    assert.ok(typeof changes[0].max === "number" && changes[0].max < 4680);
  });

  it("a handle moved back to its end saves no bound, so outliers stay included", () => {
    const changes = renderRange({ min: 1000, max: 2000 }, OUTLIER_PROFILE);
    pressOnThumb("Maximum", "End");
    assert.deepEqual(
      changes.map(({ min, max }) => ({ min, max })),
      [{ min: 1000, max: null }],
    );
    pressOnThumb("Minimum", "Home");
    assert.equal(changes.at(-1)?.min, null);
  });

  it("keeps a saved bound beyond the slider while pinning its handle to the end", () => {
    const changes = renderRange({ min: -100, max: 9e9 }, OUTLIER_PROFILE);
    assert.equal(thumbValue("Minimum"), "0.3");
    assert.equal(thumbValue("Maximum"), "4680");
    // The typed boxes show the saved values, not the clamped handles.
    assert.equal(
      (screen.getByRole("spinbutton", { name: "Minimum" }) as HTMLInputElement).value,
      "-100",
    );
    pressOnThumb("Maximum", "ArrowLeft");
    assert.equal(changes[0].min, -100);
  });

  it("accepts a typed bound beyond the slider's domain", () => {
    const changes = renderRange({}, OUTLIER_PROFILE);
    fireEvent.change(screen.getByRole("spinbutton", { name: "Maximum" }), {
      target: { value: "500000000000" },
    });
    assert.equal(changes.at(-1)?.max, 5e11);
  });
});

describe("QuickFilterControl range without outliers", () => {
  it("spans the exact extent with no outlier hint", () => {
    renderRange({}, PLAIN_PROFILE);
    assert.equal(thumbValue("Minimum"), "0");
    assert.equal(thumbValue("Maximum"), "5");
    assert.equal(screen.queryByTestId("quick-filter-outliers"), null);
  });

  it("clears a bound when its handle returns to the end", () => {
    const changes = renderRange({ min: 1, max: 4 }, PLAIN_PROFILE);
    pressOnThumb("Minimum", "Home");
    assert.deepEqual(
      changes.map(({ min, max }) => ({ min, max })),
      [{ min: null, max: 4 }],
    );
  });
});

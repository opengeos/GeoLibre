import { fireEvent, render, screen } from "./helpers/dom";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement, useState } from "react";

// Loaded after the harness so its CSS imports and Vite globals are handled.
const { NumericStyleInput } =
  await import("../apps/geolibre-desktop/src/components/panels/style-panel/style-inputs");
const { Input } = await import("@geolibre/ui");

// Feeds each committed value back into `value`, as the Style panel's store does.
function StatefulField({ onChange }: { onChange: (value: number) => void }) {
  const [value, setValue] = useState(50);
  return createElement(NumericStyleInput, {
    id: "opacity",
    label: "Opacity",
    value,
    min: 10,
    max: 100,
    step: 1,
    onChange: (next: number) => {
      onChange(next);
      setValue(next);
    },
  });
}

function renderField(onChange: (value: number) => void) {
  return render(createElement(StatefulField, { onChange }));
}

describe("NumericStyleInput", () => {
  it("does not commit 0 while the field is cleared, and restores the stored value on blur", () => {
    const committed: number[] = [];
    renderField((value) => committed.push(value));
    const input = screen.getByLabelText("Opacity") as HTMLInputElement;

    fireEvent.change(input, { target: { value: "" } });
    assert.deepEqual(committed, []);

    fireEvent.blur(input);
    assert.equal(input.value, "50");
    assert.deepEqual(committed, []);
  });

  it("commits in-range values while typing and clamps an out-of-range value on blur", () => {
    const committed: number[] = [];
    renderField((value) => committed.push(value));
    const input = screen.getByLabelText("Opacity") as HTMLInputElement;

    // "1" is below min on the way to "15": it must not commit 10 and move the layer.
    fireEvent.change(input, { target: { value: "1" } });
    assert.deepEqual(committed, []);

    fireEvent.change(input, { target: { value: "15" } });
    assert.deepEqual(committed, [15]);

    fireEvent.change(input, { target: { value: "1000" } });
    assert.deepEqual(committed, [15]);

    fireEvent.blur(input);
    assert.deepEqual(committed, [15, 100]);
    assert.equal(input.value, "100");
  });
});

describe("NumericStyleInput wheel blur", () => {
  it("drops an out-of-range partial entry instead of clamping it when the wheel blurs the field", () => {
    const committed: number[] = [];
    renderField((value) => committed.push(value));
    const input = screen.getByLabelText("Opacity") as HTMLInputElement;
    input.focus();

    fireEvent.change(input, { target: { value: "1" } });
    fireEvent.wheel(input);

    assert.equal(document.activeElement === input, false, "the wheel should blur the input");
    assert.deepEqual(committed, []);
    assert.equal(input.value, "50");
  });
});

describe("Input wheel handling", () => {
  it("runs the caller's onWheel and blurs a focused number input", () => {
    let wheels = 0;
    render(
      createElement(Input, {
        type: "number",
        "aria-label": "Width",
        onWheel: () => {
          wheels += 1;
        },
      }),
    );
    const input = screen.getByLabelText("Width") as HTMLInputElement;
    input.focus();
    assert.equal(document.activeElement === input, true, "the input should be focused first");

    fireEvent.wheel(input);

    assert.equal(wheels, 1);
    assert.equal(document.activeElement === input, false, "the wheel should blur the input");
  });
});

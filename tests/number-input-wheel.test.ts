import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { releaseNumberInputOnWheel } from "../packages/ui/src/components/input";

function fakeInput(type: string) {
  const input = {
    type,
    blurred: 0,
    blur() {
      input.blurred += 1;
    },
  };
  return input;
}

describe("releaseNumberInputOnWheel", () => {
  it("blurs a focused number input so the wheel cannot step its value", () => {
    const input = fakeInput("number");
    const released = releaseNumberInputOnWheel(input, input);
    assert.equal(released, true);
    assert.equal(input.blurred, 1);
  });

  it("leaves an unfocused number input alone", () => {
    const input = fakeInput("number");
    const other = fakeInput("text");
    assert.equal(releaseNumberInputOnWheel(input, other), false);
    assert.equal(releaseNumberInputOnWheel(input, null), false);
    assert.equal(input.blurred, 0);
  });

  it("leaves a focused text input alone", () => {
    const input = fakeInput("text");
    assert.equal(releaseNumberInputOnWheel(input, input), false);
    assert.equal(input.blurred, 0);
  });
});

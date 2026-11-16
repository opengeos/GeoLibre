import { fireEvent, render, screen } from "./helpers/dom";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";

const { LayerOpacitySlider } =
  await import("../apps/geolibre-desktop/src/components/panels/layer-panel/LayerOpacitySlider");

describe("LayerOpacitySlider disabled (#3477)", () => {
  it("drops an exact-value edit in progress when the layer becomes read-only", () => {
    const changes: number[] = [];
    const props = {
      label: "Opacity",
      ariaLabel: "Opacity for Historic sites",
      value: 1,
      onChange: (value: number) => changes.push(value),
    };
    const { rerender } = render(createElement(LayerOpacitySlider, props));
    fireEvent.doubleClick(screen.getByRole("button", { name: /edit Opacity for Historic sites/ }));
    const input = screen.getByRole("spinbutton");
    fireEvent.change(input, { target: { value: "0.2" } });

    rerender(createElement(LayerOpacitySlider, { ...props, disabled: true }));
    assert.equal(screen.queryByRole("spinbutton"), null);
    fireEvent.blur(input);
    assert.deepEqual(changes, []);
    const valueButton = screen.getByRole("button", { name: /edit Opacity for Historic sites/ });
    assert.equal((valueButton as HTMLButtonElement).disabled, true);
  });
});

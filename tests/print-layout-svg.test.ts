import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseHTML } from "linkedom";

import { stripUndefinedSvgAttributes } from "../apps/geolibre-desktop/src/lib/print-layout-svg";

describe("stripUndefinedSvgAttributes", () => {
  it("drops svgcanvas's text-decoration=undefined and keeps real attributes", () => {
    const { document } = parseHTML(
      '<svg xmlns="http://www.w3.org/2000/svg"><g><text font-size="12px" text-decoration="undefined" x="4">A</text>' +
        '<text text-decoration="underline">B</text></g></svg>',
    );
    const svg = document.querySelector("svg") as unknown as Element;
    stripUndefinedSvgAttributes(svg);
    const [first, second] = Array.from(svg.querySelectorAll("text"));
    assert.equal(first.hasAttribute("text-decoration"), false);
    assert.equal(first.getAttribute("font-size"), "12px");
    assert.equal(first.getAttribute("x"), "4");
    assert.equal(second.getAttribute("text-decoration"), "underline");
    assert.doesNotMatch(svg.outerHTML, /="undefined"/);
  });
});

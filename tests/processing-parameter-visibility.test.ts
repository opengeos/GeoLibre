import assert from "node:assert/strict";
import { it } from "node:test";
import type { AlgorithmParameter } from "@geolibre/processing";
import { isProcessingParameterVisible } from "../apps/geolibre-desktop/src/lib/processing-parameter-visibility";

it("applies inclusion, exclusion, missing values, and declared defaults consistently", () => {
  const parameter: AlgorithmParameter = { id: "cost", label: "Cost", type: "field" };
  assert.equal(isProcessingParameterVisible(parameter, {}), true);
  parameter.visibleWhen = { param: "mode", in: ["field"] };
  assert.equal(isProcessingParameterVisible(parameter, {}), false);
  assert.equal(isProcessingParameterVisible(parameter, { mode: "field" }), true);
  assert.equal(isProcessingParameterVisible(parameter, { mode: "length" }), false);
  const defaults: AlgorithmParameter[] = [
    { id: "mode", label: "Mode", type: "select", default: "field" },
  ];
  assert.equal(isProcessingParameterVisible(parameter, {}, defaults), true);
  assert.equal(isProcessingParameterVisible(parameter, { mode: "length" }, defaults), false);
  parameter.visibleWhen = { param: "mode", notIn: ["length"] };
  assert.equal(isProcessingParameterVisible(parameter, {}), true);
  assert.equal(isProcessingParameterVisible(parameter, { mode: "length" }), false);
  assert.equal(isProcessingParameterVisible(parameter, { mode: "field" }), true);
});

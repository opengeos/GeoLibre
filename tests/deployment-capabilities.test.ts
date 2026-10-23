import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ALL_DEPLOYMENT_CAPABILITIES,
  DEPLOYMENT_CAPABILITIES,
  isDeploymentCapability,
  parseDeploymentCapabilities,
} from "../packages/core/src/deployment-capabilities";
import { useAppStore } from "../packages/core/src/store";

describe("parseDeploymentCapabilities", () => {
  it("parses a comma-separated list, trimming whitespace", () => {
    assert.deepEqual(
      [...parseDeploymentCapabilities("data:add, export:data")],
      ["data:add", "export:data"],
    );
  });

  it("drops unknown names rather than throwing", () => {
    assert.deepEqual([...parseDeploymentCapabilities("data:add,not:a:capability")], ["data:add"]);
  });

  it("de-duplicates repeated names", () => {
    assert.deepEqual([...parseDeploymentCapabilities("data:add,data:add")], ["data:add"]);
  });

  it("fails closed: a list that names nothing we know grants nothing", () => {
    assert.equal(parseDeploymentCapabilities("nonsense").size, 0);
    assert.equal(parseDeploymentCapabilities(",,").size, 0);
  });

  it('grants nothing for the reserved "none" token', () => {
    assert.equal(parseDeploymentCapabilities("none").size, 0);
    assert.equal(parseDeploymentCapabilities("  NONE  ").size, 0);
  });

  it("accepts every capability it advertises", () => {
    assert.deepEqual(
      [...parseDeploymentCapabilities(DEPLOYMENT_CAPABILITIES.join(","))],
      [...DEPLOYMENT_CAPABILITIES],
    );
  });
});

describe("isDeploymentCapability", () => {
  it("recognizes only the documented vocabulary", () => {
    assert.equal(isDeploymentCapability("plugins:install"), true);
    assert.equal(isDeploymentCapability("plugins"), false);
    assert.equal(isDeploymentCapability(""), false);
  });
});

describe("store deploymentCapabilities", () => {
  it("grants everything by default, so an unconfigured build is unchanged", () => {
    assert.deepEqual(
      [...useAppStore.getState().deploymentCapabilities],
      [...ALL_DEPLOYMENT_CAPABILITIES],
    );
  });

  it("narrows to exactly what the setter was given", () => {
    const restore = useAppStore.getState().deploymentCapabilities;
    try {
      useAppStore.getState().setDeploymentCapabilities(parseDeploymentCapabilities("data:add"));
      const state = useAppStore.getState();
      assert.equal(state.deploymentCapabilities.has("data:add"), true);
      assert.equal(state.deploymentCapabilities.has("processing:run"), false);
    } finally {
      useAppStore.getState().setDeploymentCapabilities(restore);
    }
  });
});

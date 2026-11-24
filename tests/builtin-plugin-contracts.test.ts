import "./helpers/dom";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { BuiltInPluginMetadata } from "../packages/plugins/src/builtin-plugin-metadata";

const { BUILT_IN_PLUGINS } = await import("../packages/plugins/src/builtin-plugins");

describe("built-in catalog implementation contracts", () => {
  for (const registration of BUILT_IN_PLUGINS) {
    const metadata: BuiltInPluginMetadata = registration.metadata;
    const { load } = registration;
    it(`matches ${metadata.id}'s actual hooks, default position, and metadata`, async () => {
      const plugin = await load();
      for (const key of [
        "id",
        "name",
        "version",
        "engines",
        "activeByDefault",
        "exclusiveGroup",
        "assistant",
        "urlParameterNames",
        "restoresPanelCollapseState",
        "clearsStateOnProjectLoad",
        "sessionScoped",
      ] as const) {
        assert.deepEqual(plugin[key], metadata[key], `${metadata.id}.${key}`);
      }
      const hooks = [
        "handleUrlParameters",
        "getMapControlPosition",
        "setMapControlPosition",
        "getProjectState",
        "applyProjectState",
      ] as const;
      assert.deepEqual(
        hooks.filter((hook) => typeof plugin[hook] === "function"),
        hooks.filter((hook) => metadata.hooks.some((declared) => declared === hook)),
        `${metadata.id}'s declared hooks`,
      );
      assert.equal(plugin.getMapControlPosition?.(), metadata.defaultMapControlPosition);
    });
  }
});

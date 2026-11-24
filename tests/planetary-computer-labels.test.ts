import assert from "node:assert/strict";
import { it } from "node:test";
import { setPlanetaryComputerLabels } from "../packages/plugins/src/planetary-computer-labels";
import type { GeoLibreAppAPI } from "../packages/plugins/src/types";

it("retains labels configured before helper loading and refreshes existing action getters", async () => {
  try {
    setPlanetaryComputerLabels({ stacBrowser: "Parcourir STAC" });
    const { createPlanetaryComputerCustomActions } =
      await import("../packages/plugins/src/plugins/planetary-computer-actions");
    const actions = createPlanetaryComputerCustomActions({} as GeoLibreAppAPI);
    assert.equal(actions.search?.[0].label, "Parcourir STAC");
    setPlanetaryComputerLabels({ stacBrowser: "Browse STAC" });
    assert.equal(actions.search?.[0].label, "Browse STAC");
  } finally {
    setPlanetaryComputerLabels({});
  }
});

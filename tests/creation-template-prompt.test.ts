import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import type { ArcGISCreationTemplate } from "../packages/plugins/src/plugins/arcgis-defaults";
import {
  creationTemplateLabels,
  useCreationTemplatePrompt,
} from "../apps/geolibre-desktop/src/hooks/useCreationTemplatePrompt";

const template = (
  index: number,
  name: string,
  extra: Partial<ArcGISCreationTemplate> = {},
): ArcGISCreationTemplate => ({
  selection: { index, fingerprint: `t${index}` },
  name,
  ...extra,
});

describe("creationTemplateLabels", () => {
  it("numbers repeated names and keeps unique ones plain", () => {
    assert.deepEqual(
      creationTemplateLabels([
        template(0, "Standard", { typeName: "Hydrant", typeValue: 1 }),
        template(1, "Temporary", { typeValue: 2 }),
        template(2, "Standard", { typeName: "Valve", typeValue: 3 }),
        template(3, ""),
      ]),
      [
        { name: "Standard", occurrence: 1, type: "Hydrant" },
        { name: "Temporary", type: "2" },
        { name: "Standard", occurrence: 2, type: "Valve" },
        { name: null },
      ],
    );
  });

  it("keeps a zero type code", () => {
    assert.deepEqual(creationTemplateLabels([template(0, "A", { typeValue: 0 })]), [
      { name: "A", type: "0" },
    ]);
  });
});

describe("useCreationTemplatePrompt", () => {
  beforeEach(() => useCreationTemplatePrompt.getState().cancel());

  it("resolves with the chosen template, or {} for defaults only", async () => {
    const templates = [template(0, "A"), template(1, "B")];
    const picked = useCreationTemplatePrompt.getState().prompt({ layerName: "L", templates });
    assert.equal(useCreationTemplatePrompt.getState().request?.layerName, "L");
    useCreationTemplatePrompt.getState().choose({ template: templates[1].selection });
    assert.deepEqual(await picked, { template: templates[1].selection });
    assert.equal(useCreationTemplatePrompt.getState().request, null);

    const defaults = useCreationTemplatePrompt.getState().prompt({ layerName: "L", templates });
    useCreationTemplatePrompt.getState().choose({});
    assert.deepEqual(await defaults, {});
  });

  it("resolves null on cancel, and cancels a prompt replaced by another", async () => {
    const templates = [template(0, "A"), template(1, "B")];
    const first = useCreationTemplatePrompt.getState().prompt({ layerName: "1", templates });
    const second = useCreationTemplatePrompt.getState().prompt({ layerName: "2", templates });
    assert.equal(await first, null);
    useCreationTemplatePrompt.getState().cancel();
    assert.equal(await second, null);
  });
});

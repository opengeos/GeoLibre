import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  rememberProjectSaveChoices,
  reusableVectorDataChoice,
  saveChoicesForProject,
} from "../apps/geolibre-desktop/src/lib/project-save-choices";

describe("project save choices", () => {
  it("remembers credential and vector-data choices for the current project", () => {
    const credentials = rememberProjectSaveChoices(null, 4, { credentials: "strip" });
    const complete = rememberProjectSaveChoices(credentials, 4, { vectorData: "embed" });

    assert.deepEqual(saveChoicesForProject(complete, 4), {
      projectGeneration: 4,
      credentials: "strip",
      vectorData: "embed",
    });
  });

  it("clears remembered choices when the project generation changes", () => {
    const remembered = rememberProjectSaveChoices(null, 4, {
      credentials: "keep",
      vectorData: "noembed",
      largeEmbedWarningAcknowledged: true,
    });

    assert.deepEqual(saveChoicesForProject(remembered, 5), { projectGeneration: 5 });
  });

  it("does not restore choices from a previously loaded project", () => {
    const firstProject = rememberProjectSaveChoices(null, 4, { credentials: "strip" });
    const secondProject = saveChoicesForProject(firstProject, 5);

    assert.deepEqual(saveChoicesForProject(secondProject, 4), { projectGeneration: 4 });
  });

  it("retains a large-embed warning acknowledgement with the project choices", () => {
    const vectorChoice = rememberProjectSaveChoices(null, 4, { vectorData: "embed" });
    assert.equal(reusableVectorDataChoice(vectorChoice, false), "embed");
    assert.equal(reusableVectorDataChoice(vectorChoice, true), undefined);

    const acknowledged = rememberProjectSaveChoices(vectorChoice, 4, {
      largeEmbedWarningAcknowledged: true,
    });

    assert.deepEqual(acknowledged, {
      projectGeneration: 4,
      vectorData: "embed",
      largeEmbedWarningAcknowledged: true,
    });
    assert.equal(reusableVectorDataChoice(acknowledged, true), "embed");
  });
});

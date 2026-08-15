import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  rememberProjectSaveChoices,
  reusableCredentialChoice,
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
      acknowledgedEmbedBytes: 60_000_000,
    });

    assert.deepEqual(saveChoicesForProject(remembered, 5), { projectGeneration: 5 });
  });

  it("does not restore choices from a previously loaded project", () => {
    const firstProject = rememberProjectSaveChoices(null, 4, { credentials: "strip" });
    const secondProject = saveChoicesForProject(firstProject, 5);

    assert.deepEqual(saveChoicesForProject(secondProject, 4), { projectGeneration: 4 });
  });

  it("retains a large-embed warning acknowledgement with the project choices", () => {
    const warning = 50_000_000;
    const vectorChoice = rememberProjectSaveChoices(null, 4, { vectorData: "embed" });
    assert.equal(reusableVectorDataChoice(vectorChoice, 1_000, warning), "embed");
    assert.equal(reusableVectorDataChoice(vectorChoice, warning, warning), undefined);

    const acknowledged = rememberProjectSaveChoices(vectorChoice, 4, {
      acknowledgedEmbedBytes: warning,
    });

    assert.deepEqual(acknowledged, {
      projectGeneration: 4,
      vectorData: "embed",
      acknowledgedEmbedBytes: warning,
    });
    assert.equal(reusableVectorDataChoice(acknowledged, warning, warning), "embed");
  });

  it("re-warns when embedded data outgrows the acknowledged size", () => {
    const warning = 50_000_000;
    const acknowledged = rememberProjectSaveChoices(null, 4, {
      vectorData: "embed",
      acknowledgedEmbedBytes: 51_000_000,
    });

    // Ordinary growth within the acknowledged scale stays silent.
    assert.equal(reusableVectorDataChoice(acknowledged, 80_000_000, warning), "embed");
    assert.equal(reusableVectorDataChoice(acknowledged, 102_000_000, warning), "embed");
    // An order-of-magnitude larger write is confirmed again.
    assert.equal(reusableVectorDataChoice(acknowledged, 500_000_000, warning), undefined);

    // "noembed" writes no data, so its size never matters.
    const noembed = rememberProjectSaveChoices(null, 4, { vectorData: "noembed" });
    assert.equal(reusableVectorDataChoice(noembed, 900_000_000, warning), "noembed");
  });

  it("reconfirms Keep when the project would write a credential the user has not seen", () => {
    const keep = rememberProjectSaveChoices(null, 4, {
      credentials: "keep",
      keptCredentialFingerprints: ["layers[0].source.token=a1", "layers[1].source.token=b2"],
    });
    assert.equal(reusableCredentialChoice(keep, ["layers[0].source.token=a1"]), "keep");
    assert.equal(
      reusableCredentialChoice(keep, ["layers[0].source.token=a1", "layers[1].source.token=b2"]),
      "keep",
    );
    // A third credential was never acknowledged.
    assert.equal(
      reusableCredentialChoice(keep, [
        "layers[0].source.token=a1",
        "layers[1].source.token=b2",
        "layers[2].source.token=c3",
      ]),
      undefined,
    );
    // Swapping one credentialed layer for another leaves the count unchanged,
    // but puts a secret on disk that the user never approved.
    assert.equal(
      reusableCredentialChoice(keep, ["layers[0].source.token=b2", "layers[1].source.token=c3"]),
      undefined,
    );
    // A rotated token at an acknowledged path is confirmed again too.
    assert.equal(reusableCredentialChoice(keep, ["layers[0].source.token=z9"]), undefined);

    // Keep without a recorded acknowledgement cannot cover anything.
    const bare = rememberProjectSaveChoices(null, 4, { credentials: "keep" });
    assert.equal(reusableCredentialChoice(bare, []), undefined);

    const strip = rememberProjectSaveChoices(null, 4, { credentials: "strip" });
    assert.equal(reusableCredentialChoice(strip, ["basemapStyleUrl=q7"]), "strip");
  });
});

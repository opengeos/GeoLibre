import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  canSaveVectorFileReferences,
  durableVectorDataChoice,
  rememberProjectSaveChoices,
  reusableCredentialChoice,
  reusableVectorDataChoice,
  saveChoicesForProject,
} from "../apps/geolibre-desktop/src/lib/project-save-choices";

describe("Mac App Store vector saves", () => {
  it("disables path-only projects in the sandboxed build", () => {
    assert.equal(canSaveVectorFileReferences(true, true), false);
    assert.equal(canSaveVectorFileReferences(true, false), true);
    assert.equal(canSaveVectorFileReferences(false, false), false);
  });

  it("turns stale reference choices into durable embedded saves", () => {
    assert.equal(durableVectorDataChoice("noembed", true), "embed");
    assert.equal(durableVectorDataChoice("noembed", false), "noembed");
    assert.equal(durableVectorDataChoice("cancel", true), "cancel");
  });
});

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
    const risk = (embedBytes: number) => ({
      embedBytes,
      warningBytes: warning,
      discardedLayerIds: [],
    });
    const vectorChoice = rememberProjectSaveChoices(null, 4, { vectorData: "embed" });
    assert.equal(reusableVectorDataChoice(vectorChoice, risk(1_000)), "embed");
    assert.equal(reusableVectorDataChoice(vectorChoice, risk(warning)), undefined);

    const acknowledged = rememberProjectSaveChoices(vectorChoice, 4, {
      acknowledgedEmbedBytes: warning,
    });

    assert.deepEqual(acknowledged, {
      projectGeneration: 4,
      vectorData: "embed",
      acknowledgedEmbedBytes: warning,
    });
    assert.equal(reusableVectorDataChoice(acknowledged, risk(warning)), "embed");
  });

  it("re-warns when embedded data outgrows the acknowledged size", () => {
    const risk = (embedBytes: number) => ({
      embedBytes,
      warningBytes: 50_000_000,
      discardedLayerIds: [],
    });
    const acknowledged = rememberProjectSaveChoices(null, 4, {
      vectorData: "embed",
      acknowledgedEmbedBytes: 51_000_000,
    });

    // Ordinary growth within the acknowledged scale stays silent.
    assert.equal(reusableVectorDataChoice(acknowledged, risk(80_000_000)), "embed");
    assert.equal(reusableVectorDataChoice(acknowledged, risk(102_000_000)), "embed");
    // An order-of-magnitude larger write is confirmed again.
    assert.equal(reusableVectorDataChoice(acknowledged, risk(500_000_000)), undefined);
  });

  it("reconfirms Save without data for a layer the user has not agreed to lose", () => {
    const risk = (discardedLayerIds: string[]) => ({
      embedBytes: 900_000_000,
      warningBytes: 50_000_000,
      discardedLayerIds,
    });
    const noembed = rememberProjectSaveChoices(null, 4, {
      vectorData: "noembed",
      discardedVectorLayerIds: ["scratch"],
    });

    // The size of data that is never written does not matter.
    assert.equal(reusableVectorDataChoice(noembed, risk(["scratch"])), "noembed");
    assert.equal(reusableVectorDataChoice(noembed, risk([])), "noembed");
    // A layer added after the choice would be discarded without ever being
    // mentioned, so the prompt comes back.
    assert.equal(reusableVectorDataChoice(noembed, risk(["scratch", "survey"])), undefined);
    assert.equal(reusableVectorDataChoice(noembed, risk(["survey"])), undefined);

    // Desktop discards nothing (it writes file references), so it stays silent.
    const bare = rememberProjectSaveChoices(null, 4, { vectorData: "noembed" });
    assert.equal(reusableVectorDataChoice(bare, risk([])), "noembed");
    assert.equal(reusableVectorDataChoice(bare, risk(["survey"])), undefined);
  });

  it("reconfirms Keep when the project would write a credential the user has not seen", () => {
    const risk = (fingerprints: string[]) => ({ fingerprints, hasUnfingerprintable: false });
    const keep = rememberProjectSaveChoices(null, 4, {
      credentials: "keep",
      keptCredentialFingerprints: ["layers[0].source.token=a1", "layers[1].source.token=b2"],
    });
    assert.equal(reusableCredentialChoice(keep, risk(["layers[0].source.token=a1"])), "keep");
    assert.equal(
      reusableCredentialChoice(
        keep,
        risk(["layers[0].source.token=a1", "layers[1].source.token=b2"]),
      ),
      "keep",
    );
    // A third credential was never acknowledged.
    assert.equal(
      reusableCredentialChoice(
        keep,
        risk([
          "layers[0].source.token=a1",
          "layers[1].source.token=b2",
          "layers[2].source.token=c3",
        ]),
      ),
      undefined,
    );
    // Swapping one credentialed layer for another leaves the count unchanged,
    // but puts a secret on disk that the user never approved.
    assert.equal(
      reusableCredentialChoice(
        keep,
        risk(["layers[0].source.token=b2", "layers[1].source.token=c3"]),
      ),
      undefined,
    );
    // A rotated token at an acknowledged path is confirmed again too.
    assert.equal(reusableCredentialChoice(keep, risk(["layers[0].source.token=z9"])), undefined);
    // So is a credential that could not be fingerprinted at all.
    assert.equal(
      reusableCredentialChoice(keep, {
        fingerprints: ["layers[0].source.token=a1"],
        hasUnfingerprintable: true,
      }),
      undefined,
    );

    // Keep without a recorded acknowledgement cannot cover anything.
    const bare = rememberProjectSaveChoices(null, 4, { credentials: "keep" });
    assert.equal(reusableCredentialChoice(bare, risk([])), undefined);

    const strip = rememberProjectSaveChoices(null, 4, { credentials: "strip" });
    assert.equal(reusableCredentialChoice(strip, risk(["basemapStyleUrl=q7"])), "strip");
  });
});

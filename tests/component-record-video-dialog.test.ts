import { fireEvent, render, screen, waitFor } from "./helpers/dom";
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createElement } from "react";
import type { MapEngine } from "@geolibre/map";

const { RecordVideoDialog } =
  await import("../apps/geolibre-desktop/src/components/layout/RecordVideoDialog");
type Recorder =
  import("../apps/geolibre-desktop/src/components/layout/RecordVideoDialog").MapVideoRecorder;
type RecordOptions = Parameters<Recorder["record"]>[0];

const mapContainers: HTMLElement[] = [];
afterEach(() => {
  for (const container of mapContainers.splice(0)) container.remove();
});

/** A map surface whose container may hold an on-map legend. */
function fakeEngine(withLegend = false): MapEngine {
  const container = document.createElement("div");
  mapContainers.push(container);
  if (withLegend) {
    const legend = document.createElement("div");
    legend.className = "maplibre-gl-legend";
    container.appendChild(legend);
  }
  document.body.appendChild(container);
  const surface = {
    getContainer: () => container,
    getCanvas: () => document.createElement("canvas"),
  };
  return { getRenderSurface: () => surface, getMap: () => null } as unknown as MapEngine;
}

/** A recorder that resolves with a canned clip and records every call. */
function fakeRecorder(
  options: { supported?: boolean; blob?: Blob; fail?: Error; saveAs?: string | null } = {},
) {
  const records: RecordOptions[] = [];
  const saves: Array<{ defaultName: string }> = [];
  const recorder: Recorder = {
    supported: options.supported ?? true,
    record: async (params) => {
      records.push(params);
      params.onStarted?.();
      if (options.fail) throw options.fail;
      return {
        blob: options.blob ?? new Blob([new Uint8Array(64)], { type: "video/webm" }),
        mimeType: "video/webm;codecs=vp9",
        extension: "webm",
      };
    },
    save: (async (_bytes: unknown, saveOptions: { defaultName: string }) => {
      saves.push(saveOptions);
      return options.saveAs === undefined ? `/videos/${saveOptions.defaultName}` : options.saveAs;
    }) as Recorder["save"],
  };
  return { recorder, records, saves };
}

function renderDialog(recorder: Recorder, engine = fakeEngine()) {
  let open = true;
  render(
    createElement(RecordVideoDialog, {
      open: true,
      onOpenChange: (next: boolean) => (open = next),
      mapControllerRef: { current: engine },
      recorder,
    }),
  );
  return () => open;
}

const text = () => document.body.textContent ?? "";
const record = () => fireEvent.click(screen.getByRole("button", { name: "Record" }));

describe("RecordVideoDialog", () => {
  it("records the whole map with a caption, then saves under the chosen name", async () => {
    const { recorder, records, saves } = fakeRecorder();
    renderDialog(recorder);
    fireEvent.change(screen.getByLabelText("Caption (burned into video)"), {
      target: { value: "Flood extent" },
    });
    fireEvent.change(screen.getByLabelText("Frames per second"), { target: { value: "24" } });
    record();
    await waitFor(() => assert.ok(text().includes("Recording ready.")));
    assert.equal(records[0]!.region, null);
    assert.equal(records[0]!.fps, 24);
    assert.equal(records[0]!.caption?.title, "Flood extent");

    // A typed extension is dropped in favour of the recorded container's.
    fireEvent.change(screen.getByLabelText("File name"), { target: { value: "flood.mp4" } });
    fireEvent.click(screen.getByRole("button", { name: "Save video…" }));
    await waitFor(() => assert.ok(text().includes("Saved /videos/flood.webm")));
    assert.equal(saves[0]!.defaultName, "flood.webm");
  });

  it("keeps a take after a cancelled save, and drops it on Discard", async () => {
    const { recorder } = fakeRecorder({ saveAs: null });
    renderDialog(recorder);
    record();
    await waitFor(() => assert.ok(text().includes("Recording ready.")));
    // Close is blocked while a take is held.
    assert.equal(screen.getByRole("button", { name: "Close" }).hasAttribute("disabled"), true);
    fireEvent.click(screen.getByRole("button", { name: "Save video…" }));
    await waitFor(() => assert.ok(text().includes("Save cancelled.")));
    assert.ok(screen.getByRole("button", { name: "Save video…" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    assert.ok(screen.getByRole("button", { name: "Record" }));
    assert.equal(screen.getByRole("button", { name: "Close" }).hasAttribute("disabled"), false);
  });

  it("treats an empty clip as cancelled", async () => {
    renderDialog(fakeRecorder({ blob: new Blob([]) }).recorder);
    record();
    await waitFor(() => assert.ok(text().includes("Save cancelled.")));
    assert.ok(screen.getByRole("button", { name: "Record" }));
  });

  it("reports a recording failure", async () => {
    renderDialog(fakeRecorder({ fail: new Error("encoder crashed") }).recorder);
    record();
    await waitFor(() =>
      assert.ok(text().includes("Could not record the video. Please try again.")),
    );
  });

  it("needs an area before recording a region", () => {
    const { recorder } = fakeRecorder();
    renderDialog(recorder);
    const recordButton = () => screen.getByRole("button", { name: "Record" });
    assert.equal(recordButton().hasAttribute("disabled"), false);
    fireEvent.click(screen.getByRole("button", { name: "Select area…" }));
    assert.ok(text().includes("Drag a rectangle on the map"));
    // No area yet: recording a region is blocked until one is drawn.
    assert.equal(recordButton().hasAttribute("disabled"), true);
    fireEvent.click(screen.getByRole("button", { name: "Whole map" }));
    assert.equal(recordButton().hasAttribute("disabled"), false);
  });

  it("disables recording where the canvas cannot be recorded", () => {
    renderDialog(fakeRecorder({ supported: false }).recorder);
    assert.ok(text().includes("This browser cannot record the map canvas."));
    assert.equal(screen.getByRole("button", { name: "Record" }).hasAttribute("disabled"), true);
  });

  it("offers on-map panels only when the map shows one, and clamps the frame rate", async () => {
    const { recorder, records } = fakeRecorder();
    renderDialog(recorder, fakeEngine(true));
    const panels = screen.getByRole("checkbox", { name: /Include map panels/ }) as HTMLInputElement;
    assert.equal(panels.disabled, false);
    fireEvent.click(panels);
    const fps = screen.getByLabelText("Frames per second") as HTMLInputElement;
    fireEvent.change(fps, { target: { value: "500" } });
    fireEvent.blur(fps);
    assert.equal(fps.value, "60");
    record();
    await waitFor(() => assert.equal(records.length, 1));
    assert.equal(records[0]!.domOverlays?.length, 1);
    assert.equal(records[0]!.fps, 60);
  });
});

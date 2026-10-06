import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { trackWebglContextLoss } from "../apps/geolibre-desktop/src/lib/webgl-context-loss";

type ContextEvent = "webglcontextlost" | "webglcontextrestored";

// A container whose capture listeners can be handed events from any canvas,
// standing in for a DOM subtree (Node's EventTarget has no tree).
function fakeContainer() {
  const listeners = new Map<string, { handler: (event: Event) => void; capture: boolean }>();
  const container = {
    addEventListener: (type: string, handler: (event: Event) => void, capture: boolean) =>
      listeners.set(type, { handler, capture }),
    removeEventListener: (type: string) => listeners.delete(type),
    dispatchEvent: () => true,
  } as unknown as EventTarget;
  const fire = (type: ContextEvent, canvas: object) =>
    listeners.get(type)?.handler({ type, target: canvas } as unknown as Event);
  return { container, listeners, fire };
}

describe("trackWebglContextLoss", () => {
  it("listens in the capture phase, since context events do not bubble", () => {
    const { container, listeners } = fakeContainer();
    trackWebglContextLoss(container, { onLost: () => {}, onRestored: () => {} });
    assert.equal(listeners.get("webglcontextlost")?.capture, true);
    assert.equal(listeners.get("webglcontextrestored")?.capture, true);
  });

  it("reports the first loss once and the restore once every canvas is back", () => {
    const { container, fire } = fakeContainer();
    const events: string[] = [];
    trackWebglContextLoss(container, {
      onLost: () => events.push("lost"),
      onRestored: () => events.push("restored"),
    });
    const map = {};
    const overlay = {};

    fire("webglcontextlost", map);
    fire("webglcontextlost", overlay);
    assert.deepEqual(events, ["lost"]);

    // One canvas back is not enough: the overlay is still lost.
    fire("webglcontextrestored", map);
    assert.deepEqual(events, ["lost"]);
    fire("webglcontextrestored", overlay);
    assert.deepEqual(events, ["lost", "restored"]);

    // A restore for a canvas that was never lost is ignored.
    fire("webglcontextrestored", {});
    assert.deepEqual(events, ["lost", "restored"]);

    // A later loss is reported again.
    fire("webglcontextlost", map);
    assert.deepEqual(events, ["lost", "restored", "lost"]);
  });

  it("stops listening after cleanup", () => {
    const { container, listeners } = fakeContainer();
    const stop = trackWebglContextLoss(container, { onLost: () => {}, onRestored: () => {} });
    stop();
    assert.equal(listeners.size, 0);
  });
});

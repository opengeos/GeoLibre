import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { EMBED_API_SOURCE, EMBED_API_VERSION, connect } from "../packages/embed/src/index";

const originalWindow = (globalThis as { window?: unknown }).window;

class HostWindow extends EventTarget {
  setTimeout = setTimeout;
  clearTimeout = clearTimeout;
}

function harness() {
  const host = new HostWindow();
  const sent: Array<{ message: Record<string, unknown>; origin: string }> = [];
  const frameWindow = {
    postMessage(message: Record<string, unknown>, origin: string) {
      sent.push({ message, origin });
    },
  };
  (globalThis as { window?: unknown }).window = host;
  const iframe = { contentWindow: frameWindow } as unknown as HTMLIFrameElement;
  const receive = (
    type: string,
    payload: Record<string, unknown>,
    origin = "https://app.test",
    source: unknown = frameWindow,
    protocolSource = EMBED_API_SOURCE,
  ) => {
    const event = new Event("message");
    Object.defineProperties(event, {
      data: {
        value: { v: EMBED_API_VERSION, source: protocolSource, type, payload },
      },
      origin: { value: origin },
      source: { value: source },
    });
    host.dispatchEvent(event);
  };
  return { host, iframe, receive, sent };
}

afterEach(() => {
  if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
  else (globalThis as { window?: unknown }).window = originalWindow;
});

describe("@geolibre/embed client", () => {
  it("filters ready events by source, frame, and exact origin", async () => {
    const { iframe, receive } = harness();
    const pending = connect(iframe, { origin: "https://app.test", timeoutMs: 100 });
    receive("ready", {}, "https://other.test");
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(settled, false);
    receive("ready", {}, "https://app.test", {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(settled, false);
    receive("ready", {}, "https://app.test", undefined, "another-app");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(settled, false);
    receive("ready", {});
    const client = await pending;
    client.disconnect();
  });

  it("correlates acknowledgements and returns result payloads", async () => {
    const { iframe, receive, sent } = harness();
    const pending = connect(iframe, { origin: "https://app.test" });
    receive("ready", {});
    const client = await pending;
    const layersPromise = client.listLayers();
    const request = sent.at(-1)!.message;
    receive("ack", {
      requestId: request.requestId,
      ok: true,
      result: [{ id: "roads", name: "Roads", type: "geojson", visible: true, opacity: 1 }],
    });
    assert.equal((await layersPromise)[0]?.id, "roads");
    client.disconnect();
  });

  it("rejects pending requests on disconnect", async () => {
    const { iframe, receive } = harness();
    const pending = connect(iframe, { origin: "https://app.test" });
    receive("ready", {});
    const client = await pending;
    const viewport = client.getViewport();
    client.disconnect();
    await assert.rejects(viewport, /disconnected/i);
  });

  it("rejects a bad origin instead of throwing out of the call", async () => {
    // `connect` is typed to return a Promise, so `connect(...).catch(...)` has
    // to see an origin failure — a synchronous throw would escape it entirely.
    const { iframe } = harness();
    for (const origin of ["not-a-url", "mailto:a@b.com"]) {
      let thrown: unknown = null;
      let pending: Promise<unknown> | null = null;
      try {
        pending = connect(iframe, { origin, timeoutMs: 5 });
      } catch (error) {
        thrown = error;
      }
      assert.equal(thrown, null, `connect threw synchronously for "${origin}"`);
      await assert.rejects(pending as Promise<unknown>, /origin|Invalid URL/i);
    }
  });

  it("rejects an iframe that has no contentWindow", async () => {
    const iframe = { contentWindow: null } as unknown as HTMLIFrameElement;
    await assert.rejects(
      connect(iframe, { origin: "https://app.test", timeoutMs: 5 }),
      /contentWindow/,
    );
  });

  it("times out when the frame never becomes ready", async () => {
    const { iframe } = harness();
    await assert.rejects(
      connect(iframe, { origin: "https://app.test", timeoutMs: 5 }),
      /timed out/i,
    );
  });

  it("times out a command that receives no acknowledgement", async () => {
    const { iframe, receive } = harness();
    const pending = connect(iframe, {
      origin: "https://app.test",
      requestTimeoutMs: 5,
    });
    receive("ready", {});
    const client = await pending;
    await assert.rejects(client.listLayers(), /response to "listLayers"/i);
    client.disconnect();
  });
});

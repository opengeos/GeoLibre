import assert from "node:assert/strict";
import { before, beforeEach, describe, it } from "node:test";

// The module reads `window` for the Tauri check and the same-origin guard, so
// the stub has to exist before it is imported; hence the dynamic import below.
const win = ((globalThis as { window?: Record<string, unknown> }).window ??= {});
win.location = { origin: "http://tauri.localhost" };

type Module = typeof import("../apps/geolibre-desktop/src/lib/external-link-interceptor");
let installExternalLinkInterceptor: Module["installExternalLinkInterceptor"];

before(async () => {
  ({ installExternalLinkInterceptor } =
    await import("../apps/geolibre-desktop/src/lib/external-link-interceptor"));
});

interface FakeEvent {
  type: string;
  button: number;
  defaultPrevented: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  target: {
    closest: (selector: string) => { getAttribute: (name: string) => string | null } | null;
  };
  preventDefault: () => void;
}

function anchorEvent(href: string | null, overrides: Partial<FakeEvent> = {}): FakeEvent {
  const event: FakeEvent = {
    type: "click",
    button: 0,
    defaultPrevented: false,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    target: {
      closest: () => (href === null ? null : { getAttribute: () => href }),
    },
    preventDefault: () => {
      event.defaultPrevented = true;
    },
    ...overrides,
  };
  return event;
}

describe("installExternalLinkInterceptor", () => {
  let handler: ((event: unknown) => void) | null = null;
  const target = {
    addEventListener: (_type: string, listener: unknown) => {
      handler = listener as (event: unknown) => void;
    },
  };

  beforeEach(() => {
    handler = null;
    delete win.__TAURI_INTERNALS__;
  });

  it("stays out of the way on the web build", () => {
    installExternalLinkInterceptor(target as never);
    assert.equal(handler, null);
  });

  describe("under Tauri", () => {
    beforeEach(() => {
      // Stub `invoke` too: the interceptor hands the URL to the opener plugin,
      // which would otherwise log a failure against the bare marker object.
      win.__TAURI_INTERNALS__ = { invoke: () => Promise.resolve() };
      installExternalLinkInterceptor(target as never);
      assert.notEqual(handler, null);
    });

    it("takes over an outbound http(s) link", () => {
      const event = anchorEvent("https://www.bbc.co.uk/");
      handler?.(event);
      assert.equal(event.defaultPrevented, true);
    });

    it("leaves a same-origin link to the app itself", () => {
      const event = anchorEvent("http://tauri.localhost/index.html");
      handler?.(event);
      assert.equal(event.defaultPrevented, false);
    });

    it("leaves non-http(s) schemes to the webview", () => {
      for (const href of ["mailto:someone@example.com", "blob:abc", "#section", "/relative"]) {
        const event = anchorEvent(href);
        handler?.(event);
        assert.equal(event.defaultPrevented, false, href);
      }
    });

    it("ignores a click that did not land on a link", () => {
      const event = anchorEvent(null);
      handler?.(event);
      assert.equal(event.defaultPrevented, false);
    });

    it("leaves modified and non-left clicks alone", () => {
      const variants: Partial<FakeEvent>[] = [
        { metaKey: true },
        { ctrlKey: true },
        { shiftKey: true },
        { altKey: true },
        { button: 1 },
      ];
      for (const overrides of variants) {
        const event = anchorEvent("https://www.bbc.co.uk/", overrides);
        handler?.(event);
        assert.equal(event.defaultPrevented, false, JSON.stringify(overrides));
      }
    });

    it("defers to a handler that already claimed the click", () => {
      const event = anchorEvent("https://www.bbc.co.uk/", { defaultPrevented: true });
      let prevented = false;
      event.preventDefault = () => {
        prevented = true;
      };
      handler?.(event);
      assert.equal(prevented, false);
    });
  });
});

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { observeGalleryEnd } from "../apps/geolibre-desktop/src/lib/gallery-auto-load";

describe("project gallery auto-load observer", () => {
  const originalObserver = globalThis.IntersectionObserver;

  afterEach(() => {
    Object.assign(globalThis, { IntersectionObserver: originalObserver });
  });

  it("unobserves the sentinel before loading the next page", () => {
    let fire: (entries: IntersectionObserverEntry[]) => void = () => {};
    const events: string[] = [];
    class FakeIntersectionObserver {
      constructor(callback: (entries: IntersectionObserverEntry[]) => void) {
        fire = callback;
      }
      observe() {}
      unobserve(target: Element) {
        events.push(target === sentinel ? "unobserve" : "wrong target");
      }
      disconnect() {}
    }
    Object.assign(globalThis, { IntersectionObserver: FakeIntersectionObserver });

    const sentinel = {} as Element;
    observeGalleryEnd({
      root: {} as Element,
      sentinel,
      generation: 1,
      currentGeneration: () => 1,
      isLoading: () => false,
      onLoad: () => events.push("load"),
    });

    fire([{ isIntersecting: true, target: sentinel } as IntersectionObserverEntry]);
    assert.deepEqual(events, ["unobserve", "load"]);
  });

  it("ignores a callback from before a scope reload", () => {
    let fire: (entries: IntersectionObserverEntry[]) => void = () => {};
    class FakeIntersectionObserver {
      constructor(callback: (entries: IntersectionObserverEntry[]) => void) {
        fire = callback;
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    Object.assign(globalThis, { IntersectionObserver: FakeIntersectionObserver });

    const sentinel = {} as Element;
    let generation = 1;
    let loads = 0;
    observeGalleryEnd({
      root: {} as Element,
      sentinel,
      generation,
      currentGeneration: () => generation,
      isLoading: () => false,
      onLoad: () => {
        loads += 1;
      },
    });

    generation += 1;
    fire([{ isIntersecting: true, target: sentinel } as IntersectionObserverEntry]);
    assert.equal(loads, 0, "the stale observer loaded a page from the previous scope");
  });

  it("does not load while the page-zero reload is active", () => {
    let fire: (entries: IntersectionObserverEntry[]) => void = () => {};
    class FakeIntersectionObserver {
      constructor(callback: (entries: IntersectionObserverEntry[]) => void) {
        fire = callback;
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    Object.assign(globalThis, { IntersectionObserver: FakeIntersectionObserver });

    const sentinel = {} as Element;
    let loads = 0;
    observeGalleryEnd({
      root: {} as Element,
      sentinel,
      generation: 1,
      currentGeneration: () => 1,
      isLoading: () => true,
      onLoad: () => {
        loads += 1;
      },
    });

    fire([{ isIntersecting: true, target: sentinel } as IntersectionObserverEntry]);
    assert.equal(loads, 0, "pagination interrupted the initial reload");
  });
});

import { act, fireEvent, render, screen, useAppStore } from "./helpers/dom";
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createElement } from "react";
import { createSampleStoryMap, type StoryChapterLocation } from "@geolibre/core";
import type { MapEngine } from "@geolibre/map";

const { StoryMapPresenter } =
  await import("../apps/geolibre-desktop/src/components/storymap/StoryMapPresenter");

const containers: HTMLElement[] = [];
afterEach(() => {
  for (const container of containers.splice(0)) container.remove();
});

/** A live portal target, without a WebGL renderer or network requests. */
function fakeEngine() {
  const container = document.createElement("div");
  const canvas = document.createElement("canvas");
  container.append(canvas);
  document.body.append(container);
  containers.push(container);
  const calls = {
    cameras: [] as StoryChapterLocation[],
    stops: 0,
    restores: 0,
  };
  const engine = {
    getRenderSurface: () => ({
      getContainer: () => container,
      getCanvas: () => canvas,
      project: ([lng, lat]: [number, number]) => ({ x: lng, y: lat }),
      unproject: ([lng, lat]: [number, number]) => ({ lng, lat }),
    }),
    onCameraMove: () => () => {},
    onCameraIdle: () => () => {},
    applyStoryChapterCamera: (
      location: StoryChapterLocation,
      _animation: unknown,
      _rotate: unknown,
      arrived?: () => void,
    ) => {
      calls.cameras.push(location);
      arrived?.();
    },
    stopStoryCamera: () => {
      calls.stops++;
    },
    restoreLayerStyles: () => {
      calls.restores++;
    },
    setStoryLayerOpacity: () => {},
    readView: () => ({ zoom: 10 }),
  } as unknown as MapEngine;
  return { engine, calls, container, canvas };
}

function startStory() {
  const story = createSampleStoryMap();
  story.startSlide = "none";
  story.endSlide = "none";
  story.inset = false;
  story.showMarkers = false;
  story.hideChapterNav = false;
  story.chapters = story.chapters.slice(0, 3).map((chapter, index) => ({
    ...chapter,
    id: `chapter-${index + 1}`,
    title: ["Alpha", "Beta", "Gamma"][index],
    description: "<p>Long explanation: scrolling this card must not change chapters.</p>",
    durationSeconds: 60,
    onChapterEnter: [],
    onChapterExit: [],
    location: {
      ...chapter.location,
      center: [117 + index / 10, 39] as [number, number],
    },
  }));
  useAppStore.setState({ storymap: story });
  useAppStore.getState().setStorymapPresenting(true);
  return story;
}

function status() {
  return screen.getByTestId("story-playback-status").textContent ?? "";
}

describe("StoryMapPresenter lifecycle and input", () => {
  it("waits for an engine during replacement instead of passing null to the tools", () => {
    startStory();
    const fake = fakeEngine();
    const mapControllerRef: { current: MapEngine | null } = { current: fake.engine };
    const view = render(
      createElement(StoryMapPresenter, { mapControllerRef, mapReadyGeneration: 1 }),
    );
    assert.ok(screen.queryByTestId("story-presentation"));
    mapControllerRef.current = null;
    view.rerender(createElement(StoryMapPresenter, { mapControllerRef, mapReadyGeneration: 2 }));
    mapControllerRef.current = fake.engine;
    view.rerender(createElement(StoryMapPresenter, { mapControllerRef, mapReadyGeneration: 3 }));
    assert.ok(screen.queryByRole("button", { name: "Presentation tools" }));
  });

  it("preserves unfinished drawing and navigation guards across engines, then clears the session on exit", () => {
    startStory();
    const first = fakeEngine();
    const second = fakeEngine();
    const mapControllerRef = { current: first.engine };
    const view = render(
      createElement(StoryMapPresenter, {
        mapControllerRef,
        mapReadyGeneration: 1,
      }),
    );
    const place = (clientX: number, clientY: number) => {
      const surface = screen.getByTestId("storymap-drawing-surface");
      fireEvent.pointerDown(surface, {
        clientX,
        clientY,
        pointerId: 1,
        button: 0,
      });
      fireEvent.pointerUp(surface, {
        clientX,
        clientY,
        pointerId: 1,
        button: 0,
      });
    };
    fireEvent.click(screen.getByRole("button", { name: "Presentation tools" }));
    fireEvent.click(screen.getByRole("button", { name: "Place a marker" }));
    place(117, 39);
    fireEvent.click(screen.getByRole("button", { name: "Draw a line" }));
    place(117.1, 39);
    fireEvent.change(screen.getByRole("textbox", { name: "Annotation text (optional)" }), {
      target: { value: "Explain this route" },
    });
    mapControllerRef.current = second.engine;
    view.rerender(
      createElement(StoryMapPresenter, {
        mapControllerRef,
        mapReadyGeneration: 2,
      }),
    );
    assert.equal(screen.getByTestId("storymap-annotations").querySelectorAll("circle").length, 2);
    assert.equal(
      (
        screen.getByRole("button", {
          name: "Next chapter",
        }) as HTMLButtonElement
      ).disabled,
      true,
    );
    assert.equal(
      (
        screen.getByRole("button", {
          name: "Exit",
        }) as HTMLButtonElement
      ).disabled,
      true,
    );
    assert.equal(
      (
        screen.getByRole("textbox", {
          name: "Annotation text (optional)",
        }) as HTMLInputElement
      ).value,
      "Explain this route",
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel drawing" }));
    fireEvent.click(screen.getByRole("button", { name: "Exit" }));
    assert.equal(useAppStore.getState().ui.storymapPresenting, false);
    act(() => {
      useAppStore.getState().setStorymapPresenting(true);
    });
    assert.equal(screen.getByTestId("storymap-annotations").querySelectorAll("circle").length, 0);
    assert.equal(screen.queryByTestId("storymap-drawing-surface"), null);
    assert.match(status(), /Chapter 1 \/ 3/);
  });

  it("does not restart the chapter or stop playback when a style generation changes on the same engine", () => {
    startStory();
    const fake = fakeEngine();
    const mapControllerRef = { current: fake.engine };
    const view = render(
      createElement(StoryMapPresenter, {
        mapControllerRef,
        mapReadyGeneration: 1,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Next chapter" }));
    fireEvent.click(screen.getByRole("button", { name: "Autoplay next chapter" }));
    assert.match(status(), /Chapter 3 \/ 3.*Next in/);
    const callsBefore = fake.calls.cameras.length;
    const stopsBefore = fake.calls.stops;
    view.rerender(
      createElement(StoryMapPresenter, {
        mapControllerRef,
        mapReadyGeneration: 2,
      }),
    );
    assert.equal(fake.calls.cameras.length, callsBefore);
    assert.equal(fake.calls.stops, stopsBefore);
    assert.equal(fake.calls.restores, 0);
    assert.match(status(), /Chapter 3 \/ 3.*Next in/);
  });

  it("keeps the current chapter but pauses when the rendering engine changes", () => {
    const story = startStory();
    const first = fakeEngine();
    const second = fakeEngine();
    const mapControllerRef = { current: first.engine };
    const view = render(
      createElement(StoryMapPresenter, {
        mapControllerRef,
        mapReadyGeneration: 1,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Next chapter" }));
    fireEvent.click(screen.getByRole("button", { name: "Autoplay next chapter" }));
    assert.match(status(), /Chapter 3 \/ 3.*Next in/);
    mapControllerRef.current = second.engine;
    view.rerender(
      createElement(StoryMapPresenter, {
        mapControllerRef,
        mapReadyGeneration: 2,
      }),
    );
    assert.deepEqual(second.calls.cameras.at(-1)?.center, story.chapters[2].location.center);
    assert.equal(first.calls.restores, 1);
    assert.match(status(), /Chapter 3 \/ 3.*Paused for discussion/);
    assert.equal(first.container.querySelector('[data-testid="story-presentation"]'), null);
    assert.ok(second.container.querySelector('[data-testid="story-presentation"]'));
  });

  it("blocks buttons, navigation keys and exit until an armed drawing is cancelled", () => {
    startStory();
    const fake = fakeEngine();
    render(
      createElement(StoryMapPresenter, {
        mapControllerRef: { current: fake.engine },
        mapReadyGeneration: 1,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Presentation tools" }));
    fireEvent.click(screen.getByRole("button", { name: "Draw a line" }));
    for (const name of ["Next chapter", "Previous chapter", "Return to chapter view", "Exit"]) {
      assert.equal(
        (screen.getByRole("button", { name }) as HTMLButtonElement).disabled,
        true,
        `${name} must be disabled`,
      );
    }
    const calls = fake.calls.cameras.length;
    fireEvent.keyDown(document.body, { key: "PageDown" });
    fireEvent.keyDown(document.body, { key: "Escape" });
    fireEvent.keyDown(document.body, { key: " ", code: "Space" });
    fireEvent.click(screen.getByRole("button", { name: "Next chapter" }));
    assert.equal(fake.calls.cameras.length, calls);
    assert.equal(useAppStore.getState().ui.storymapPresenting, true);
    assert.match(status(), /Chapter 1 \/ 3/);
    fireEvent.click(screen.getByRole("button", { name: "Cancel drawing" }));
    fireEvent.click(screen.getByRole("button", { name: "Next chapter" }));
    assert.match(status(), /Chapter 2 \/ 3.*Paused for discussion/);
    fireEvent.click(screen.getByRole("button", { name: "Exit" }));
    assert.equal(useAppStore.getState().ui.storymapPresenting, false);
  });

  it("lets text scroll without taking over but pauses before map pointer and wheel input", () => {
    startStory();
    const fake = fakeEngine();
    render(
      createElement(StoryMapPresenter, {
        mapControllerRef: { current: fake.engine },
        mapReadyGeneration: 1,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Play automatically" }));
    assert.match(status(), /Chapter 1 \/ 3.*Next in/);
    const card = fake.container.querySelector(".glsm-active .glsm-card-body")!;
    const before = fake.calls.stops;
    fireEvent.wheel(card, { deltaY: 400 });
    assert.equal(fake.calls.stops, before);
    assert.match(status(), /Chapter 1 \/ 3.*Next in/);
    fireEvent.pointerDown(fake.canvas, { button: 0, pointerId: 1 });
    assert.ok(fake.calls.stops > before);
    assert.match(status(), /Chapter 1 \/ 3.*Paused for discussion/);
    fireEvent.click(screen.getByRole("button", { name: "Autoplay next chapter" }));
    assert.match(status(), /Chapter 2 \/ 3.*Next in/);
    fireEvent.wheel(fake.canvas, { deltaY: 200 });
    assert.match(status(), /Chapter 2 \/ 3.*Paused for discussion/);
  });

  it("pauses for keyboard focus in an external search field and pointer input on an external toolbar", () => {
    startStory();
    const fake = fakeEngine();
    render(
      createElement(StoryMapPresenter, {
        mapControllerRef: { current: fake.engine },
        mapReadyGeneration: 1,
      }),
    );
    const external = document.createElement("div");
    const search = document.createElement("input");
    const button = document.createElement("button");
    external.append(search, button);
    document.body.append(external);
    containers.push(external);
    fireEvent.click(screen.getByRole("button", { name: "Play automatically" }));
    assert.match(status(), /Chapter 1 \/ 3.*Next in/);
    fireEvent.focusIn(search);
    assert.match(status(), /Chapter 1 \/ 3.*Paused for discussion/);
    fireEvent.click(screen.getByRole("button", { name: "Autoplay next chapter" }));
    assert.match(status(), /Chapter 2 \/ 3.*Next in/);
    fireEvent.pointerDown(button, { button: 0, pointerId: 1 });
    assert.match(status(), /Chapter 2 \/ 3.*Paused for discussion/);
  });

  it("shows the story title block on the start view but not on the closing slide", () => {
    const story = startStory();
    useAppStore.setState({
      storymap: {
        ...story,
        title: "Nevada Counties",
        subtitle: "A tour",
        byline: "By the workshop",
        startSlide: "global",
        endSlide: "black",
      },
    });
    const fake = fakeEngine();
    render(
      createElement(StoryMapPresenter, {
        mapControllerRef: { current: fake.engine },
        mapReadyGeneration: 1,
      }),
    );
    const titleBlock = () => screen.getByTestId("story-title-block");
    // The opening "Global view" carries the title block (#998 start view).
    assert.match(titleBlock().textContent ?? "", /Nevada Counties.*A tour.*By the workshop/);
    assert.notEqual(titleBlock().style.visibility, "hidden");

    fireEvent.click(screen.getByRole("button", { name: "Next chapter" }));
    assert.match(status(), /Chapter 1 \/ 3/);
    assert.notEqual(titleBlock().style.visibility, "hidden");

    for (let step = 0; step < 3; step++) {
      fireEvent.click(screen.getByRole("button", { name: "Next chapter" }));
    }
    // The closing slide stays free of the story text.
    assert.equal(titleBlock().style.visibility, "hidden");
  });
});

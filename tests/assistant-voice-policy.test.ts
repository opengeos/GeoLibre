import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MICROPHONE_VISUALIZER_GATE,
  PUSH_TO_TALK_HOLD_DELAY_MS,
  gateVoiceVisualizerLevel,
  isEditingSpaceTarget,
  isInteractiveSpaceTarget,
  isPushToTalkKey,
  isPushToTalkSurface,
  shouldHandlePushToTalkKeyDown,
  shouldIgnoreVoiceButtonClick,
  visualizerBarLevel,
} from "../apps/geolibre-desktop/src/lib/assistant/voice-policy";

/**
 * A stand-in for an element, matching the duck-typed surface the policy reads.
 *
 * @param options.tagName - Upper- or lower-case tag name.
 * @param options.matches - Selectors this element (or an ancestor) answers to.
 * @param options.inputType - `type` for a synthetic `<input>` ancestor.
 */
function element({
  tagName = "DIV",
  matches = [] as string[],
  isContentEditable = false,
  inputType,
}: {
  tagName?: string;
  matches?: string[];
  isContentEditable?: boolean;
  inputType?: string;
} = {}) {
  const self = {
    tagName,
    isContentEditable,
    closest(selector: string) {
      // The real `closest` takes a selector list; the policy passes both single
      // selectors and comma-joined lists, so match on any listed part.
      const parts = selector.split(",").map((part) => part.trim());
      const hit = parts.some((part) => matches.includes(part));
      if (!hit) return null;
      return parts.includes("input") && inputType ? { type: inputType } : self;
    },
  };
  return self;
}

describe("voice push-to-talk key identity", () => {
  it("recognizes Space by code and by key", () => {
    assert.equal(isPushToTalkKey({ code: "Space" }), true);
    assert.equal(isPushToTalkKey({ key: " " }), true);
    assert.equal(isPushToTalkKey({ key: "a", code: "KeyA" }), false);
    assert.equal(isPushToTalkKey(null), false);
  });

  it("holds the gesture for half a second before claiming the key", () => {
    // The delay is the whole contract: shorter and a tap on a button would
    // start the microphone, longer and holding to talk feels broken.
    assert.equal(PUSH_TO_TALK_HOLD_DELAY_MS, 500);
  });
});

describe("voice push-to-talk arbitration", () => {
  it("accepts a bare Space on inert page chrome", () => {
    assert.equal(shouldHandlePushToTalkKeyDown({ code: "Space", target: element() }), true);
  });

  it("never claims Space inside text entry", () => {
    // Typing a space in the assistant's own composer must stay a space.
    const textarea = element({ tagName: "TEXTAREA", matches: ["textarea"] });
    assert.equal(shouldHandlePushToTalkKeyDown({ code: "Space", target: textarea }), false);
    const search = element({ matches: ["input"], inputType: "search" });
    assert.equal(shouldHandlePushToTalkKeyDown({ code: "Space", target: search }), false);
    const rich = element({ isContentEditable: true });
    assert.equal(shouldHandlePushToTalkKeyDown({ code: "Space", target: rich }), false);
  });

  it("leaves a checkbox input to its own Space, which is not text entry", () => {
    const checkbox = element({ matches: ["input"], inputType: "checkbox" });
    assert.equal(isEditingSpaceTarget(checkbox), false);
    // It is still an interactive owner, so the hold preserves its native tap.
    assert.equal(isInteractiveSpaceTarget(checkbox), true);
  });

  it("yields modified Space to whatever bound the shortcut", () => {
    for (const modifier of ["altKey", "ctrlKey", "metaKey", "shiftKey"] as const) {
      assert.equal(
        shouldHandlePushToTalkKeyDown({ code: "Space", target: element(), [modifier]: true }),
        false,
        `${modifier}+Space should not be arbitrated`,
      );
    }
  });

  it("yields a press another handler already consumed", () => {
    assert.equal(
      shouldHandlePushToTalkKeyDown({ code: "Space", target: element(), defaultPrevented: true }),
      false,
    );
  });
});

describe("voice Space ownership", () => {
  it("treats focusable controls and widget roles as owners of Space", () => {
    assert.equal(isInteractiveSpaceTarget(element({ matches: ["button"] })), true);
    assert.equal(isInteractiveSpaceTarget(element({ matches: ['[role="switch"]'] })), true);
    assert.equal(isInteractiveSpaceTarget(element({ matches: ["[tabindex]"] })), true);
    assert.equal(isInteractiveSpaceTarget(element()), false);
    assert.equal(isInteractiveSpaceTarget(null), false);
  });

  it("reserves the map canvas for voice despite its tabindex", () => {
    // Both map engines give the canvas a tabindex for keyboard camera control,
    // which would otherwise make a click on the map read as a focused button.
    const canvas = element({
      tagName: "canvas",
      matches: ["[tabindex]", ".maplibregl-canvas-container", ".maplibregl-map", ".cesium-viewer"],
    });
    assert.equal(isPushToTalkSurface(canvas), true);
    assert.equal(isInteractiveSpaceTarget(canvas), false);
  });

  it("does not mistake an unrelated canvas for the map", () => {
    const chart = element({ tagName: "CANVAS", matches: ["[tabindex]"] });
    assert.equal(isPushToTalkSurface(chart), false);
    assert.equal(isInteractiveSpaceTarget(chart), true);
  });
});

describe("voice button click guard", () => {
  it("ignores the click Space itself would synthesize on the focused button", () => {
    assert.equal(shouldIgnoreVoiceButtonClick(true), true);
    assert.equal(shouldIgnoreVoiceButtonClick(false), false);
  });
});

describe("voice meter shaping", () => {
  it("silences everything at or below the noise floor", () => {
    assert.equal(gateVoiceVisualizerLevel(0, 0.12), 0);
    assert.equal(gateVoiceVisualizerLevel(0.12, 0.12), 0);
    assert.equal(gateVoiceVisualizerLevel(0.05, 0.12), 0);
  });

  it("re-normalizes audible energy across the remaining range", () => {
    // Half-way between the floor and full scale reads as half, not as 0.56.
    assert.equal(gateVoiceVisualizerLevel(0.5, 0), 0.5);
    assert.equal(gateVoiceVisualizerLevel(1, 0.12), 1);
    assert.ok(Math.abs(gateVoiceVisualizerLevel(0.56, 0.12) - 0.5) < 1e-9);
  });

  it("clamps hostile input instead of producing NaN bar heights", () => {
    assert.equal(gateVoiceVisualizerLevel(Number.NaN, 0.12), 0);
    assert.equal(gateVoiceVisualizerLevel(5, 0.12), 1);
    assert.equal(gateVoiceVisualizerLevel(-3, 0.12), 0);
    assert.equal(gateVoiceVisualizerLevel(0.5, Number.NaN), 0.5);
  });

  it("keeps room tone off the meter but lifts real speech into view", () => {
    // A quiet band under the gate stays flat; a loud one nearly fills the bar.
    assert.equal(visualizerBarLevel(MICROPHONE_VISUALIZER_GATE * 190 * 2 - 1, 2), 0);
    assert.ok(visualizerBarLevel(190 * 4, 4) > 0.99);
    const speech = visualizerBarLevel(120 * 4, 4);
    assert.ok(speech > 0.5 && speech < 1);
  });

  it("returns a flat bar for a band with no bins", () => {
    assert.equal(visualizerBarLevel(100, 0), 0);
    assert.equal(visualizerBarLevel(Number.NaN, 4), 0);
  });
});

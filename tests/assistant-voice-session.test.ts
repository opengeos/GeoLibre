import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import type {
  SpeechRecognitionResultEvent,
  SpeechRecognizer,
} from "../apps/geolibre-desktop/src/lib/assistant/speech";
import {
  VoiceSession,
  type VoiceEvent,
} from "../apps/geolibre-desktop/src/lib/assistant/voice-session";

/** A recognizer that records what the session did to it and can be driven. */
class FakeRecognizer implements SpeechRecognizer {
  lang = "";
  continuous = false;
  interimResults = false;
  maxAlternatives = 0;
  onresult: ((event: SpeechRecognitionResultEvent) => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  onstart: (() => void) | null = null;
  onaudiostart: (() => void) | null = null;

  started = false;
  stopCalls = 0;
  abortCalls = 0;
  /** Throw from start(), as a browser does when one is already running. */
  failOnStart = false;

  start(): void {
    if (this.failOnStart) throw new Error("already started");
    this.started = true;
    this.onstart?.();
  }

  /** Ends the recognizer the way `stop()` does: the turn is finalized. */
  stop(): void {
    this.stopCalls += 1;
    this.end();
  }

  abort(): void {
    this.abortCalls += 1;
    this.end();
  }

  /** Fires `end` once, as a real recognizer does. */
  end(): void {
    if (!this.started) return;
    this.started = false;
    this.onend?.();
  }

  /** Delivers one phrase. */
  say(transcript: string, isFinal = true): void {
    this.onresult?.({
      resultIndex: 0,
      results: Object.assign({ length: 1 }, [
        { length: 1, isFinal, 0: { transcript, confidence: 0.9 } },
      ]),
    } as unknown as SpeechRecognitionResultEvent);
  }
}

/** A synthesizer that hands back the utterances it was asked to speak. */
class FakeSynthesis {
  spoken: Array<{ text: string; onend: (() => void) | null }> = [];
  cancelCalls = 0;

  speak(utterance: { text: string; onend: (() => void) | null }): void {
    this.spoken.push(utterance);
  }

  cancel(): void {
    this.cancelCalls += 1;
  }

  /** Ends the most recent utterance, as the browser does when it finishes. */
  finish(): void {
    this.spoken.at(-1)?.onend?.();
  }
}

/** Builds a session over fakes, exposing what the test needs to drive it. */
function harness(options: { synthesis?: boolean } = {}) {
  const recognizers: FakeRecognizer[] = [];
  const events: VoiceEvent[] = [];
  const synthesis = options.synthesis ? new FakeSynthesis() : null;
  const session = new VoiceSession({
    createRecognizer: () => {
      const recognizer = new FakeRecognizer();
      recognizers.push(recognizer);
      return recognizer;
    },
    synthesis: synthesis as unknown as SpeechSynthesis | null,
    createUtterance: synthesis
      ? (text) => ({ text, lang: "", onend: null, onerror: null }) as SpeechSynthesisUtterance
      : undefined,
    language: () => "en-US",
    onEvent: (event) => events.push(event),
  });
  return {
    session,
    recognizers,
    events,
    synthesis,
    /** The recognizer currently driving the session. */
    get current() {
      return recognizers.at(-1)!;
    },
    /** Every transcript the session published. */
    transcripts: () =>
      events.filter((e) => e.type === "transcript").map((e) => (e as { text: string }).text),
    /** Every status the session passed through. */
    statuses: () =>
      events.filter((e) => e.type === "state").map((e) => (e as { status: string }).status),
  };
}

describe("voice session start", () => {
  it("configures an open-mic recognizer to keep listening", () => {
    const h = harness();
    h.session.start("open-mic");
    assert.equal(h.current.continuous, true);
    assert.equal(h.current.interimResults, true);
    assert.equal(h.current.lang, "en-US");
    assert.equal(h.session.getStatus(), "listening");
    assert.equal(h.session.getMode(), "open-mic");
  });

  it("configures a push-to-talk recognizer for a single turn", () => {
    const h = harness();
    h.session.start("push-to-talk");
    assert.equal(h.current.continuous, false);
    assert.equal(h.session.getMode(), "push-to-talk");
  });

  it("ignores a second start in the same mode instead of stacking microphones", () => {
    const { session, recognizers } = harness();
    session.start("open-mic");
    session.start("open-mic");
    assert.equal(recognizers.length, 1);
  });

  it("replaces the session when the other mode starts", () => {
    const { session, recognizers } = harness();
    session.start("open-mic");
    session.start("push-to-talk");
    assert.equal(recognizers.length, 2);
    assert.equal(recognizers[0].abortCalls, 1);
    assert.equal(session.getMode(), "push-to-talk");
  });

  it("reports a recognizer that refuses to start, with nothing left running", () => {
    const events: VoiceEvent[] = [];
    const recognizer = new FakeRecognizer();
    recognizer.failOnStart = true;
    const session = new VoiceSession({
      createRecognizer: () => recognizer,
      language: () => "en-US",
      onEvent: (event) => events.push(event),
    });
    session.start("open-mic");
    assert.equal(session.getStatus(), "error");
    assert.equal(session.isActive(), false);
    assert.deepEqual(
      events.filter((e) => e.type === "error"),
      [{ type: "error", messageKey: "assistant.voice.errorGeneric" }],
    );
  });
});

describe("voice session transcripts", () => {
  it("previews an interim phrase and publishes only the final one", () => {
    const h = harness();
    h.session.start("open-mic");
    h.current.say("show me riv", false);
    h.current.say("show me rivers", true);
    assert.deepEqual(h.transcripts(), ["show me rivers"]);
    const interims = h.events.filter((e) => e.type === "interim");
    assert.deepEqual(
      interims.map((e) => (e as { text: string }).text),
      ["show me riv", ""],
    );
  });

  it("drops a phrase from a recognizer the session already replaced", () => {
    // The hazard this guards: a stopped recognizer delivering its last result
    // into the session that replaced it, sending a phrase nobody is speaking.
    const h = harness();
    h.session.start("open-mic");
    const stale = h.current;
    h.session.stop();
    stale.onresult?.({
      resultIndex: 0,
      results: Object.assign({ length: 1 }, [
        { length: 1, isFinal: true, 0: { transcript: "ghost", confidence: 1 } },
      ]),
    } as unknown as SpeechRecognitionResultEvent);
    assert.deepEqual(h.transcripts(), []);
  });
});

describe("voice session push-to-talk", () => {
  it("finalizes the turn on release rather than discarding it", () => {
    const h = harness();
    h.session.start("push-to-talk");
    const recognizer = h.current;
    h.session.releasePushToTalk();
    // stop(), not abort(): the phrase in progress must still be delivered.
    assert.equal(recognizer.stopCalls, 1);
    assert.equal(recognizer.abortCalls, 0);
    assert.equal(h.session.getStatus(), "idle");
  });

  it("does not let Space close an open-mic session started by the button", () => {
    const h = harness();
    h.session.start("open-mic");
    h.session.releasePushToTalk();
    assert.equal(h.session.getStatus(), "listening");
    assert.equal(h.current.stopCalls, 0);
  });

  it("stays alive while the run it triggered is still working", () => {
    const h = harness();
    h.session.start("push-to-talk");
    h.current.say("add a basemap");
    h.session.notifyRunStart();
    h.session.releasePushToTalk();
    // The microphone is closed, but the session keeps reporting the run.
    assert.equal(h.session.getStatus(), "executing");
    h.session.notifyRunEnd();
    assert.equal(h.session.getStatus(), "idle");
  });
});

describe("voice session open-mic restarts", () => {
  it("restarts the recognizer that ended on a silence", () => {
    // Chrome ends recognition at every pause; without this an open mic would
    // go deaf after the first sentence.
    const h = harness();
    h.session.start("open-mic");
    h.current.end();
    assert.equal(h.recognizers.length, 2);
    assert.equal(h.session.getStatus(), "listening");
    h.current.say("second phrase");
    assert.deepEqual(h.transcripts(), ["second phrase"]);
  });

  it("gives up on a recognizer that ends the moment it starts", () => {
    // A restart loop would otherwise spin for as long as the panel is open.
    const h = harness();
    h.session.start("open-mic");
    for (let i = 0; i < 6 && h.session.isActive(); i++) h.current.end();
    assert.equal(h.session.getStatus(), "error");
    assert.ok(h.recognizers.length <= 6, `stopped restarting after ${h.recognizers.length}`);
  });

  it("keeps reporting a run in flight across a restart", () => {
    const h = harness();
    h.session.start("open-mic");
    h.current.say("zoom to Kenya");
    h.session.notifyRunStart();
    h.current.end();
    assert.equal(h.session.getStatus(), "executing");
    h.session.notifyRunEnd();
    assert.equal(h.session.getStatus(), "listening");
  });
});

describe("voice session errors", () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => {
    h = harness();
    h.session.start("open-mic");
  });

  it("releases the microphone before reporting a refusal", () => {
    const recognizer = h.current;
    recognizer.onerror?.({ error: "not-allowed" });
    // Teardown precedes the error state: no hot microphone behind it.
    assert.equal(recognizer.abortCalls, 1);
    assert.equal(h.session.getStatus(), "error");
    assert.equal(h.session.isActive(), false);
    assert.deepEqual(
      h.events.filter((e) => e.type === "error"),
      [{ type: "error", messageKey: "assistant.voice.errorDenied" }],
    );
  });

  it("keeps listening through a turn that heard nothing", () => {
    h.current.onerror?.({ error: "no-speech" });
    assert.equal(h.session.getStatus(), "listening");
    assert.deepEqual(
      h.events.filter((e) => e.type === "error"),
      [],
    );
  });

  it("does not restart the recognizer after a fatal error", () => {
    h.current.onerror?.({ error: "audio-capture" });
    const afterError = h.recognizers.length;
    h.recognizers[afterError - 1].end();
    assert.equal(h.recognizers.length, afterError);
  });
});

describe("voice session spoken replies", () => {
  it("suspends the open microphone while speaking, then resumes it", () => {
    // Without this the recognizer transcribes the speakers and the assistant
    // answers itself.
    const h = harness({ synthesis: true });
    h.session.start("open-mic");
    const listening = h.current;
    h.session.speak("Twelve rivers are in view.");
    assert.equal(listening.abortCalls, 1);
    assert.equal(h.session.getStatus(), "speaking");
    assert.equal(h.synthesis!.spoken.at(-1)?.text, "Twelve rivers are in view.");
    h.synthesis!.finish();
    assert.equal(h.session.getStatus(), "listening");
    assert.equal(h.recognizers.length, 2);
  });

  it("ends a push-to-talk session once the reply has been read", () => {
    const h = harness({ synthesis: true });
    h.session.start("push-to-talk");
    h.current.say("how many rivers");
    h.session.notifyRunStart();
    h.session.releasePushToTalk();
    h.session.speak("Twelve.");
    h.session.notifyRunEnd();
    assert.equal(h.session.getStatus(), "speaking");
    h.synthesis!.finish();
    assert.equal(h.session.getStatus(), "idle");
  });

  it("lets a new turn cut off a reply in progress", () => {
    // New intent supersedes old. The microphone is closed while the reply is
    // read out, so talking over it means starting a turn — holding Space here —
    // rather than simply speaking at a recognizer that is not listening.
    const h = harness({ synthesis: true });
    h.session.start("open-mic");
    h.session.speak("A long answer nobody wants to sit through.");
    h.synthesis!.cancelCalls = 0;
    h.session.start("push-to-talk");
    assert.equal(h.synthesis!.cancelCalls, 1);
    assert.equal(h.session.getStatus(), "listening");
  });

  it("silences a reply when the session stops", () => {
    const h = harness({ synthesis: true });
    h.session.start("open-mic");
    h.session.speak("Still talking.");
    h.synthesis!.cancelCalls = 0;
    h.session.stop();
    assert.equal(h.synthesis!.cancelCalls, 1);
    assert.equal(h.session.getStatus(), "idle");
  });

  it("says nothing when there is no synthesizer or nothing to say", () => {
    const h = harness();
    h.session.start("open-mic");
    h.session.speak("anything");
    assert.equal(h.session.getStatus(), "listening");
    const withVoice = harness({ synthesis: true });
    withVoice.session.start("open-mic");
    withVoice.session.speak("   ");
    assert.equal(withVoice.synthesis!.spoken.length, 0);
  });
});

describe("voice session disposal", () => {
  it("releases the microphone and refuses to start again", () => {
    const h = harness();
    h.session.start("open-mic");
    const recognizer = h.current;
    h.session.dispose();
    assert.equal(recognizer.abortCalls, 1);
    assert.equal(h.session.isActive(), false);
    h.session.start("open-mic");
    assert.equal(h.recognizers.length, 1);
  });

  it("is safe to dispose twice", () => {
    const h = harness();
    h.session.start("open-mic");
    h.session.dispose();
    h.session.dispose();
    assert.equal(h.session.getStatus(), "idle");
  });
});

/**
 * The assistant's voice command session: microphone lifetime, spoken replies,
 * and the state machine the panel renders.
 *
 * The behavioral contract is adopted from the voice control in `gods-eye-view`
 * (`src/voice/session.js` and `realtimeController.js`), translated from its
 * OpenAI Realtime transport to the browser's own Web Speech API so it works
 * with every AI provider GeoLibre supports:
 *
 * - A click-started session stays **open-mic**; a Space-hold session is
 *   **push-to-talk** and ends when the key is released.
 * - New intent supersedes old: starting a turn cancels a reply still being
 *   read aloud. Unlike the speech-to-speech original, the microphone is closed
 *   *while* a reply is spoken — a recognizer left open would transcribe the
 *   speakers and the assistant would answer itself — so talking over the answer
 *   means starting a new turn (Space, or the button), not simply speaking.
 * - Teardown precedes error reporting, so the session never sits in an error
 *   state with a live microphone behind it.
 * - Every start and stop bumps a generation, so a late callback from a torn-down
 *   recognizer cannot enter its replacement.
 *
 * Nothing here touches React or the DOM: the recognizer and the synthesizer are
 * injected, which is what lets the whole lifetime be unit-tested.
 */

import {
  isFatalSpeechError,
  readSpeechResults,
  speechErrorKey,
  type SpeechRecognizer,
  type SpeechRecognizerFactory,
  type VoiceMessageKey,
} from "./speech";

/** How the session was started, which decides how it ends. */
export type VoiceMode = "open-mic" | "push-to-talk";

/** What the panel renders. */
export type VoiceStatus = "idle" | "listening" | "executing" | "speaking" | "error";

/** Everything the session tells its owner. */
export type VoiceEvent =
  /** The status changed. `detailKey` is a catalog key, never English. */
  | { type: "state"; status: VoiceStatus; mode: VoiceMode | null; detailKey?: string }
  /** A phrase still being revised — preview only, never sent. */
  | { type: "interim"; text: string }
  /** A finished phrase, ready to send to the assistant. */
  | { type: "transcript"; text: string }
  /** The microphone is unusable. `messageKey` is a catalog key. */
  | { type: "error"; messageKey: VoiceMessageKey }
  /** The live microphone stream, for the meter. Null once released. */
  | { type: "stream"; stream: MediaStream | null };

/** Collaborators the session needs, injected so tests can supply fakes. */
export interface VoiceSessionOptions {
  /** Builds a recognizer. See `getSpeechRecognizerFactory`. */
  createRecognizer: SpeechRecognizerFactory;
  /** The synthesizer for spoken replies, or null to stay silent. */
  synthesis?: SpeechSynthesis | null;
  /** Builds an utterance. Injected because the constructor is a global. */
  createUtterance?: (text: string) => SpeechSynthesisUtterance;
  /** Acquires the microphone for the meter. Optional; failure is not fatal. */
  requestStream?: () => Promise<MediaStream>;
  /** The BCP-47 tag to listen and speak in, read at each start. */
  language: () => string;
  /** Receives every event. Must not throw. */
  onEvent: (event: VoiceEvent) => void;
}

/**
 * Consecutive immediate restarts tolerated in open-mic mode before the session
 * gives up. Chrome ends recognition on every silence, so restarting is normal;
 * a recognizer that ends the moment it starts is not, and left alone it would
 * spin a restart loop for as long as the panel is open.
 */
const MAX_IMMEDIATE_RESTARTS = 5;

/** A restart sooner than this after a start counts as "immediate". */
const IMMEDIATE_RESTART_MS = 350;

/** Owns the microphone, the recognizer and the spoken reply for one panel. */
export class VoiceSession {
  private readonly options: VoiceSessionOptions;

  private recognizer: SpeechRecognizer | null = null;

  private stream: MediaStream | null = null;

  private status: VoiceStatus = "idle";

  private mode: VoiceMode | null = null;

  /**
   * Bumped by every start, stop and disposal. Callbacks capture the value they
   * were armed under and bail when it has moved on, so a recognizer torn down
   * mid-flight cannot deliver a transcript into its replacement.
   */
  private generation = 0;

  /** True between `speak()` and the utterance ending or being cancelled. */
  private speaking = false;

  /** Set while the recognizer is stopped only so it cannot hear the reply. */
  private suspendedForPlayback = false;

  private disposed = false;

  private restartCount = 0;

  private lastStartedAt = 0;

  /** True once the agent run this session triggered is in flight. */
  private running = false;

  constructor(options: VoiceSessionOptions) {
    this.options = options;
  }

  /** The current status, for owners that render from a snapshot. */
  getStatus(): VoiceStatus {
    return this.status;
  }

  /** How the live session was started, or null when idle. */
  getMode(): VoiceMode | null {
    return this.mode;
  }

  /** Whether a session is live (listening, working, or speaking). */
  isActive(): boolean {
    return !this.disposed && this.status !== "idle" && this.status !== "error";
  }

  /**
   * Starts listening.
   *
   * Starting while a session of the same mode is already live is a no-op, so a
   * key repeat or a double click cannot stack two recognizers on one
   * microphone. A different mode replaces the session.
   *
   * @param mode - Open-mic (click) or push-to-talk (Space hold).
   */
  start(mode: VoiceMode): void {
    if (this.disposed) return;
    if (this.isActive() && this.mode === mode) return;
    // Tear the previous session down first; its callbacks are already fenced
    // off by the generation this bumps.
    this.teardown();
    this.mode = mode;
    this.restartCount = 0;
    this.cancelSpeech();
    const generation = ++this.generation;
    let recognizer: SpeechRecognizer;
    try {
      recognizer = this.options.createRecognizer();
    } catch {
      this.fail("assistant.voice.errorGeneric");
      return;
    }
    this.recognizer = recognizer;
    recognizer.lang = this.options.language();
    recognizer.continuous = mode === "open-mic";
    recognizer.interimResults = true;
    recognizer.maxAlternatives = 1;
    recognizer.onstart = () => {
      if (generation !== this.generation) return;
      this.lastStartedAt = Date.now();
    };
    recognizer.onresult = (event) => {
      if (generation !== this.generation) return;
      const { final, interim } = readSpeechResults(event);
      // Speech is intent: it supersedes a reply still being read out.
      if (final || interim) this.cancelSpeech();
      if (interim) this.emit({ type: "interim", text: interim });
      if (final) {
        this.restartCount = 0;
        this.emit({ type: "interim", text: "" });
        this.emit({ type: "transcript", text: final });
      }
    };
    recognizer.onerror = (event) => {
      if (generation !== this.generation) return;
      const code = String(event?.error || "");
      if (!isFatalSpeechError(code)) return;
      // Stop before reporting, so the error state never hides a live mic.
      this.fail(speechErrorKey(code));
    };
    recognizer.onend = () => {
      if (generation !== this.generation) return;
      this.handleRecognizerEnd(generation);
    };
    try {
      recognizer.start();
    } catch {
      this.fail("assistant.voice.errorGeneric");
      return;
    }
    this.setStatus("listening");
    void this.acquireStream(generation);
  }

  /**
   * Ends a push-to-talk turn: the recognizer finalizes what it has heard and
   * the session goes idle once that arrives. Ignored for an open-mic session,
   * whose microphone belongs to the button, not to the key.
   */
  releasePushToTalk(): void {
    if (this.disposed || this.mode !== "push-to-talk" || !this.recognizer) return;
    try {
      // stop() (not abort()) so the phrase in progress is still delivered.
      this.recognizer.stop();
    } catch {
      this.stop();
    }
  }

  /**
   * Stops the session and releases the microphone.
   *
   * @param options.preserveStatus - Leave the status alone, for callers that
   *   set their own terminal status (the error path).
   */
  stop(options: { preserveStatus?: boolean } = {}): void {
    this.teardown();
    this.cancelSpeech();
    this.mode = null;
    this.emit({ type: "interim", text: "" });
    if (!options.preserveStatus) this.setStatus("idle");
  }

  /** Tells the session an agent run started, so the panel reads "working". */
  notifyRunStart(): void {
    if (this.disposed || !this.isActive()) return;
    this.running = true;
    this.setStatus("executing");
  }

  /**
   * Tells the session the agent run finished.
   *
   * A push-to-talk turn whose recognizer has already ended is over once its run
   * is — unless a reply is being read aloud, which the session stays alive for.
   * Callers that speak the reply must do so before calling this.
   */
  notifyRunEnd(): void {
    this.running = false;
    if (this.disposed || !this.isActive()) return;
    if (!this.recognizer && !this.speaking) {
      this.stop();
      return;
    }
    if (this.status === "executing") this.setStatus(this.recognizer ? "listening" : "speaking");
  }

  /**
   * Reads a reply aloud.
   *
   * In open-mic mode the microphone is suspended for the duration and resumed
   * afterwards: the recognizer hears the speakers, and without this the
   * assistant would transcribe its own reply and answer itself.
   *
   * @param text - Speakable plain text (see `spokenTextFromMarkdown`).
   */
  speak(text: string): void {
    const synthesis = this.options.synthesis;
    const createUtterance = this.options.createUtterance;
    if (this.disposed || !synthesis || !createUtterance || !text.trim()) return;
    this.cancelSpeech();
    const generation = this.generation;
    let utterance: SpeechSynthesisUtterance;
    try {
      utterance = createUtterance(text);
    } catch {
      return;
    }
    utterance.lang = this.options.language();
    const finish = () => {
      if (generation !== this.generation || !this.speaking) return;
      this.speaking = false;
      this.resumeAfterPlayback(generation);
    };
    utterance.onend = finish;
    utterance.onerror = finish;
    this.speaking = true;
    if (this.mode === "open-mic" && this.recognizer) {
      this.suspendedForPlayback = true;
      this.abortRecognizer();
    }
    if (this.isActive()) this.setStatus("speaking");
    try {
      synthesis.speak(utterance);
    } catch {
      this.speaking = false;
      this.resumeAfterPlayback(generation);
    }
  }

  /** Silences a reply in progress. Safe to call when nothing is speaking. */
  cancelSpeech(): void {
    if (!this.speaking) return;
    this.speaking = false;
    try {
      this.options.synthesis?.cancel();
    } catch {
      // A synthesizer that refuses to cancel must not break the session.
    }
  }

  /** Permanently releases everything. The session cannot be restarted. */
  dispose(): void {
    if (this.disposed) return;
    this.stop();
    this.disposed = true;
    this.generation++;
  }

  /**
   * Handles the recognizer ending.
   *
   * Chrome ends recognition on every pause, so an open-mic session restarts it
   * until the user stops the session — unless it is ending immediately and
   * repeatedly, which is a broken recognizer rather than a silence.
   */
  private handleRecognizerEnd(generation: number): void {
    const wasSuspended = this.suspendedForPlayback;
    this.recognizer = null;
    if (wasSuspended) return; // speak() will resume it.
    if (this.mode !== "open-mic") {
      // Push-to-talk: the turn is over. Keep the session alive while its agent
      // run or spoken reply is still in flight so the panel keeps reporting it.
      this.releaseStream();
      if (this.running || this.speaking) return;
      this.stop();
      return;
    }
    if (Date.now() - this.lastStartedAt < IMMEDIATE_RESTART_MS) {
      this.restartCount += 1;
      if (this.restartCount >= MAX_IMMEDIATE_RESTARTS) {
        this.fail("assistant.voice.errorGeneric");
        return;
      }
    } else {
      this.restartCount = 0;
    }
    this.restartListening(generation);
  }

  /** Re-arms the recognizer for an open-mic session under the same identity. */
  private restartListening(generation: number): void {
    if (generation !== this.generation || this.disposed || this.mode !== "open-mic") return;
    const mode = this.mode;
    // Both are carried across the restart, because `start()` tears the session
    // down and clears them — and both describe the session, not the recognizer:
    // the count exists to notice one that keeps ending the moment it starts,
    // and the run is still in flight regardless of which recognizer is live.
    const restarts = this.restartCount;
    const running = this.running;
    // start() no-ops on an unchanged mode while active, so the status is
    // dropped to idle first — the session identity (generation) still moves,
    // which is what fences the recognizer being replaced.
    this.status = "idle";
    this.mode = null;
    this.start(mode);
    this.restartCount = restarts;
    this.running = running;
    // A restart is not a new turn; keep reporting the run that is still going.
    if (running) this.setStatus("executing");
  }

  /** Restarts listening after a spoken reply, if the session is still open. */
  private resumeAfterPlayback(generation: number): void {
    if (generation !== this.generation || this.disposed) return;
    if (!this.suspendedForPlayback) {
      if (this.status === "speaking") {
        this.setStatus(this.recognizer ? "listening" : "idle");
        if (!this.recognizer) this.stop();
      }
      return;
    }
    this.suspendedForPlayback = false;
    this.restartListening(generation);
  }

  /**
   * Acquires the microphone stream for the meter.
   *
   * Purely cosmetic: the recognizer opens its own capture, so a browser that
   * refuses this (or has no `getUserMedia`) still transcribes fine and simply
   * shows no meter.
   */
  private async acquireStream(generation: number): Promise<void> {
    const request = this.options.requestStream;
    if (!request) return;
    try {
      const stream = await request();
      if (generation !== this.generation || this.disposed) {
        // The session this stream was acquired for is gone — release it here
        // rather than promoting it onto a session that did not ask for it.
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      this.stream = stream;
      this.emit({ type: "stream", stream });
    } catch {
      // No meter; the session is unaffected.
    }
  }

  /** Drops the recognizer without letting its callbacks run. */
  private abortRecognizer(): void {
    const recognizer = this.recognizer;
    this.recognizer = null;
    if (!recognizer) return;
    recognizer.onresult = null;
    recognizer.onerror = null;
    recognizer.onstart = null;
    try {
      recognizer.abort();
    } catch {
      // Already dead.
    }
  }

  /** Stops the microphone meter's stream. */
  private releaseStream(): void {
    const stream = this.stream;
    this.stream = null;
    if (!stream) return;
    for (const track of stream.getTracks()) track.stop();
    this.emit({ type: "stream", stream: null });
  }

  /** Releases the recognizer, the microphone and the session identity. */
  private teardown(): void {
    this.generation++;
    this.running = false;
    this.suspendedForPlayback = false;
    this.restartCount = 0;
    const recognizer = this.recognizer;
    this.abortRecognizer();
    if (recognizer) recognizer.onend = null;
    this.releaseStream();
  }

  /** Tears the session down, then reports the failure. */
  private fail(messageKey: VoiceMessageKey): void {
    this.stop({ preserveStatus: true });
    this.setStatus("error");
    this.emit({ type: "error", messageKey });
  }

  private setStatus(status: VoiceStatus): void {
    this.status = status;
    if (status === "idle" || status === "error") this.mode = null;
    this.emit({ type: "state", status, mode: this.mode });
  }

  private emit(event: VoiceEvent): void {
    try {
      this.options.onEvent(event);
    } catch {
      // An observer cannot break the session.
    }
  }
}

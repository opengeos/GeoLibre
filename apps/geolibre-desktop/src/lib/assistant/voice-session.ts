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
  /** The status changed. */
  | { type: "state"; status: VoiceStatus; mode: VoiceMode | null }
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
  /** Open-mic end-of-phrase silence, in ms. Overridden by tests. */
  endpointMs?: number;
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

/**
 * How long an open mic waits after the last word before it forces the phrase
 * to be finalized.
 *
 * Recognizers decide on their own when a phrase has ended, and Chrome is
 * deliberately patient about it — well over a second of silence — which shows
 * up as dead air between finishing a sentence and the map moving. Stopping the
 * recognizer ourselves ends the phrase immediately; the open-mic session then
 * re-arms as it does after any other silence, so nothing is lost. Push-to-talk
 * needs none of this: releasing the key is the endpoint.
 */
const OPEN_MIC_ENDPOINT_MS = 900;

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

  /**
   * Set while a same-mode restart is in flight, so the teardown it goes through
   * keeps the microphone stream instead of releasing and re-acquiring one.
   */
  private retainStream = false;

  /** Pending end-of-phrase timer for an open mic. */
  private endpointTimer: ReturnType<typeof setTimeout> | null = null;

  /** True while the push-to-talk key is physically down. */
  private pushToTalkHeld = false;

  /**
   * Final fragments heard during the current push-to-talk hold, joined into one
   * request when the key is released. A hold is one request however many
   * phrases the engine decides it contains.
   */
  private heldPhrases: string[] = [];

  /**
   * Identifies the turn, as opposed to the recognizer. Unlike `generation` it
   * survives the restarts a session makes on its own, so a reply can be matched
   * to the turn that asked for it.
   */
  private turnId = 0;

  /** The turn that started the agent run now in flight. */
  private runTurn: number | null = null;

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
    // Only a *live recognizer* makes this a no-op: the guard exists to stop two
    // recognizers stacking on one microphone. A session still working or
    // speaking has no recognizer, and starting there is the user superseding it.
    if (this.isActive() && this.mode === mode && this.recognizer) return;
    // Tear the previous session down first; its callbacks are already fenced
    // off by the generation this bumps.
    this.teardown();
    this.mode = mode;
    this.restartCount = 0;
    this.turnId += 1;
    this.heldPhrases = [];
    this.pushToTalkHeld = mode === "push-to-talk";
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
    // Continuous in both modes. With `continuous = false` the engine returns at
    // most one final result and then stops itself at the first pause it hears —
    // which would end a push-to-talk turn mid-sentence, while the key is still
    // held, and silently drop the rest. The endpoint is ours to decide: the key
    // release for push-to-talk, the silence timer for an open mic.
    recognizer.continuous = true;
    recognizer.interimResults = true;
    recognizer.maxAlternatives = 1;
    recognizer.onresult = (event) => {
      if (generation !== this.generation) return;
      const { final, interim } = readSpeechResults(event);
      // Speech is intent: it supersedes a reply still being read out.
      if (final || interim) this.cancelSpeech();
      if (interim) {
        this.emit({ type: "interim", text: interim });
        this.armEndpoint(generation);
      }
      if (final) {
        this.clearEndpoint();
        this.restartCount = 0;
        this.emit({ type: "interim", text: "" });
        // A hold is one request. The engine may split it into several phrases,
        // so they are kept until the key is released and sent together.
        if (this.mode === "push-to-talk") this.heldPhrases.push(final);
        else this.emit({ type: "transcript", text: final });
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
      // Recorded here rather than from `onstart`: a recognizer broken enough to
      // end without ever starting would otherwise leave this stale, the elapsed
      // check would read every restart as unhurried, and the brake below would
      // never engage.
      this.lastStartedAt = Date.now();
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
    if (this.disposed || this.mode !== "push-to-talk") return;
    // Cleared first: the recognizer ending is what finishes the turn, and
    // `handleRecognizerEnd` re-arms instead while the key is still down.
    this.pushToTalkHeld = false;
    if (!this.recognizer) {
      // Defensive: nothing is listening, so the turn is whatever was heard.
      this.flushHeldPhrases();
      return;
    }
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
    // Ending the session always releases the microphone, even mid-restart:
    // `restartListening` holds the stream across the teardown that `start()`
    // does, and a failure there arrives here (via `fail()`) with the flag still
    // set — which would leave a live track behind an idle or error state.
    // `start()` tears down directly, so retention is unaffected.
    this.retainStream = false;
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
    this.runTurn = this.turnId;
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
    // A stopped session has nowhere to report the playback — the status strip
    // is hidden once voice mode is off — and the turn fence below cannot catch
    // it, because stopping does not begin a new turn. Enforced here rather than
    // left to every caller to remember.
    if (!this.isActive()) return;
    // An answer belongs to the turn that asked for it. If the session has moved
    // on to another turn since — the user held Space again rather than waiting —
    // reading the old answer would talk over the question they are asking now,
    // into a live microphone that would then transcribe it. New intent
    // supersedes old, so this one is dropped; the transcript still has it.
    // Keyed on the turn rather than on a live recognizer, so an answer that
    // beats the engine's own `end` event for its *own* turn is still read out.
    if (this.runTurn !== null && this.runTurn !== this.turnId) return;
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
    this.clearEndpoint();
    if (this.mode === "open-mic" && this.recognizer) {
      this.suspendedForPlayback = true;
      this.abortRecognizer();
    }
    // The meter holds its own capture stream. Nothing is listening while the
    // reply plays, so holding the microphone open would light the browser's
    // recording indicator — and animate the meter off the speakers — through a
    // turn the user is not part of.
    this.releaseStream();
    this.setStatus("speaking");
    try {
      synthesis.speak(utterance);
    } catch {
      this.speaking = false;
      this.resumeAfterPlayback(generation);
    }
  }

  /**
   * Silences a reply in progress and settles the session it belonged to.
   *
   * This is the one callers outside the session should use. `cancelSpeech()`
   * only stops the audio: on its own it would strand an open mic that had been
   * suspended for the playback, leaving it deaf with the status stuck on
   * "speaking", because the utterance's `end` event bails once `speaking` is
   * already false. Going through the same resume path playback normally ends on
   * brings the microphone back, or finishes a push-to-talk turn that is over.
   */
  stopSpeaking(): void {
    if (!this.speaking) return;
    const generation = this.generation;
    this.cancelSpeech();
    this.resumeAfterPlayback(generation);
  }

  /**
   * Silences a reply in progress without settling the session.
   *
   * Internal: it is what `start()` and `stop()` use, where the caller goes on to
   * rebuild or tear down the session itself. Everything else wants
   * {@link stopSpeaking}.
   */
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
      // A recognizer that ends while the key is still down is the engine's idea
      // of a pause, not the end of the turn. Re-arm and keep listening — the
      // release is the endpoint, and the phrases heard so far are kept.
      if (this.pushToTalkHeld) {
        if (!this.allowRestart()) return;
        this.restartListening(generation);
        return;
      }
      // The turn is over. Keep the session alive while its agent run or spoken
      // reply is still in flight so the panel keeps reporting it.
      this.flushHeldPhrases();
      this.releaseStream();
      if (this.running || this.speaking) return;
      this.stop();
      return;
    }
    if (!this.allowRestart()) return;
    this.restartListening(generation);
  }

  /**
   * Whether the recognizer that just ended may be restarted.
   *
   * Ending the moment it started is not a silence, it is a recognizer that
   * cannot run. Both modes re-arm themselves — an open mic at every pause, a
   * held key whenever the engine stops early — so both need the same brake, or
   * a broken engine spins a restart loop for as long as the panel is open.
   */
  private allowRestart(): boolean {
    if (Date.now() - this.lastStartedAt >= IMMEDIATE_RESTART_MS) {
      this.restartCount = 0;
      return true;
    }
    this.restartCount += 1;
    if (this.restartCount < MAX_IMMEDIATE_RESTARTS) return true;
    this.fail("assistant.voice.errorGeneric");
    return false;
  }

  /**
   * Re-arms the recognizer under the same turn.
   *
   * Both modes need this: an open mic re-arms after every pause, and a
   * push-to-talk hold re-arms whenever the engine ends the recognizer while the
   * key is still down.
   */
  private restartListening(generation: number): void {
    const mode = this.mode;
    if (generation !== this.generation || this.disposed || !mode) return;
    // Both are carried across the restart, because `start()` tears the session
    // down and clears them — and both describe the session, not the recognizer:
    // the count exists to notice one that keeps ending the moment it starts,
    // and the run is still in flight regardless of which recognizer is live.
    const restarts = this.restartCount;
    const running = this.running;
    // The turn outlives the recognizer: a restart is the same request, with the
    // same phrases behind it and the same key still held.
    const turn = this.turnId;
    const held = this.pushToTalkHeld;
    const phrases = this.heldPhrases;
    // start() no-ops on an unchanged mode while active, so the status is
    // dropped to idle first — the session identity (generation) still moves,
    // which is what fences the recognizer being replaced.
    this.status = "idle";
    this.mode = null;
    // The microphone survives the restart. Re-acquiring one per pause costs a
    // fresh getUserMedia and AudioContext on every sentence, and drops the
    // meter to its baseline between utterances.
    this.retainStream = true;
    try {
      this.start(mode);
    } finally {
      this.retainStream = false;
    }
    // A restart that could not open a recognizer has already reported the
    // failure; restoring the run over it would paint the session as working
    // with nothing listening behind it. Read through the accessor: the compiler
    // narrows `this.status` at the assignment above and does not track the
    // `start()` call reassigning it.
    if (this.getStatus() === "error") return;
    this.restartCount = restarts;
    this.running = running;
    this.turnId = turn;
    this.pushToTalkHeld = held;
    this.heldPhrases = phrases;
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
    // A retained stream from the session this one restarted is already live.
    if (!request || this.stream) return;
    try {
      const stream = await request();
      // `speaking` joins the identity checks: a stream that lands mid-reply
      // belongs to a turn during which nothing should be holding the mic.
      if (generation !== this.generation || this.disposed || this.speaking) {
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
    this.pushToTalkHeld = false;
    this.heldPhrases = [];
    this.clearEndpoint();
    const recognizer = this.recognizer;
    this.abortRecognizer();
    if (recognizer) recognizer.onend = null;
    if (!this.retainStream) this.releaseStream();
  }

  /**
   * (Re)starts the end-of-phrase timer for an open mic.
   *
   * Stopping the recognizer is what ends the phrase: it delivers the final
   * result at once instead of after the engine's own, much longer, silence
   * window, and `onend` then re-arms the session.
   */
  private armEndpoint(generation: number): void {
    if (this.mode !== "open-mic") return;
    this.clearEndpoint();
    const endpointMs = this.options.endpointMs ?? OPEN_MIC_ENDPOINT_MS;
    this.endpointTimer = setTimeout(() => {
      this.endpointTimer = null;
      if (generation !== this.generation || this.disposed) return;
      try {
        this.recognizer?.stop();
      } catch {
        // A recognizer that refuses to stop will end on its own.
      }
    }, endpointMs);
  }

  /**
   * Publishes everything heard during a push-to-talk hold as one request.
   *
   * The engine may have split the hold into several phrases — a pause for
   * thought is enough — but the user made one request, so they are joined.
   */
  private flushHeldPhrases(): void {
    const phrases = this.heldPhrases;
    this.heldPhrases = [];
    const text = phrases.join(" ").replace(/\s+/g, " ").trim();
    if (!text) return;
    this.emit({ type: "interim", text: "" });
    this.emit({ type: "transcript", text });
  }

  /** Cancels a pending end-of-phrase timer. */
  private clearEndpoint(): void {
    if (this.endpointTimer === null) return;
    clearTimeout(this.endpointTimer);
    this.endpointTimer = null;
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

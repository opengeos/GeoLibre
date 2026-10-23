/**
 * Voice command mode for the AI Assistant.
 *
 * Owns the `VoiceSession`, the hold-Space push-to-talk gesture, and the
 * microphone meter. The gesture arbitration is ported from the voice control in
 * `gods-eye-view` (`src/voice/realtimeInput.js`): Space is reserved on keydown
 * only when no focused control claims it, and voice takes the key over only
 * after a 500 ms hold, so short taps still activate buttons and typing a space
 * in the composer is never swallowed.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  getSpeechRecognizerFactory,
  isVoiceOutputSupported,
  speechLanguageFor,
  spokenTextFromMarkdown,
  type VoiceMessageKey,
} from "../lib/assistant/speech";
import {
  PUSH_TO_TALK_HOLD_DELAY_MS,
  SPACE_INTERACTIVE_SELECTOR,
  isInteractiveSpaceTarget,
  isPushToTalkKey,
  shouldHandlePushToTalkKeyDown,
  shouldIgnoreVoiceButtonClick,
  visualizerBarLevel,
} from "../lib/assistant/voice-policy";
import { VoiceSession, type VoiceMode, type VoiceStatus } from "../lib/assistant/voice-session";

/** Where the "speak replies" preference is remembered. */
const SPEAK_STORAGE_KEY = "geolibre.assistant.speakReplies";

/** What the panel needs to render and drive voice mode. */
export interface VoiceCommands {
  /** Whether this browser can transcribe at all. False hides the control. */
  supported: boolean;
  /** Whether this browser can read replies aloud. */
  canSpeak: boolean;
  status: VoiceStatus;
  mode: VoiceMode | null;
  /** True while Space is physically down, whether or not voice claimed it. */
  spaceHeld: boolean;
  /** Catalog key for the current failure, or null. */
  errorKey: VoiceMessageKey | null;
  speakReplies: boolean;
  setSpeakReplies: (next: boolean) => void;
  /** Toggles an open-mic session, as the microphone button does. */
  toggle: () => void;
  stop: () => void;
  /** Attach to the meter element; its `span` children are driven per frame. */
  visualizerRef: (node: HTMLElement | null) => void;
  /** Reads an assistant reply aloud, if replies are spoken and voice is live. */
  speakReply: (markdown: string) => void;
  /** Silences a reply being read aloud, leaving the session otherwise alone. */
  silence: () => void;
  notifyRunStart: () => void;
  notifyRunEnd: () => void;
}

/** Options for {@link useVoiceCommands}. */
export interface UseVoiceCommandsOptions {
  /** False while the panel cannot send (no provider configured). */
  enabled: boolean;
  /** Receives a finished phrase, to be sent to the assistant. */
  onTranscript: (text: string) => void;
  /** Receives the phrase being revised, for the composer preview. */
  onInterim: (text: string) => void;
}

/** Reads the persisted "speak replies" preference. */
function loadSpeakReplies(): boolean {
  if (typeof window === "undefined") return true;
  try {
    return window.localStorage.getItem(SPEAK_STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
}

/**
 * Wires voice commands into the assistant panel.
 *
 * @param options - Enablement and the transcript callbacks.
 * @returns The state and controls the panel renders.
 */
export function useVoiceCommands({
  enabled,
  onTranscript,
  onInterim,
}: UseVoiceCommandsOptions): VoiceCommands {
  const { i18n } = useTranslation();
  const [status, setStatus] = useState<VoiceStatus>("idle");
  const [mode, setMode] = useState<VoiceMode | null>(null);
  const [errorKey, setErrorKey] = useState<VoiceMessageKey | null>(null);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [speakReplies, setSpeakRepliesState] = useState(loadSpeakReplies);

  // Capability is fixed for the page's lifetime, so resolve it once. A browser
  // without a recognizer gets no microphone button rather than a dead one.
  const recognizerFactory = useMemo(() => getSpeechRecognizerFactory(), []);
  const canSpeak = useMemo(() => isVoiceOutputSupported(), []);

  // Callbacks are read through refs so the session is built once and is not
  // torn down (dropping a live microphone) whenever the panel re-renders.
  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;
  const onInterimRef = useRef(onInterim);
  onInterimRef.current = onInterim;
  const languageRef = useRef(i18n.language);
  languageRef.current = i18n.language;
  const speakRepliesRef = useRef(speakReplies);
  speakRepliesRef.current = speakReplies;

  const visualizerNodeRef = useRef<HTMLElement | null>(null);
  const meterRef = useRef<{
    context: AudioContext;
    analyser: AnalyserNode;
    source: MediaStreamAudioSourceNode;
    data: Uint8Array;
    frame: number | null;
  } | null>(null);

  /** Restores the CSS-owned standby baseline on every bar. */
  const resetBars = useCallback(() => {
    const bars = visualizerNodeRef.current?.querySelectorAll<HTMLElement>("span");
    if (!bars) return;
    for (const bar of bars) bar.style.removeProperty("--voice-level");
  }, []);

  /** Releases the Web Audio graph driving the meter. */
  const stopMeter = useCallback(() => {
    const meter = meterRef.current;
    meterRef.current = null;
    if (meter) {
      if (meter.frame !== null) cancelAnimationFrame(meter.frame);
      try {
        meter.source.disconnect();
      } catch {
        // Already disconnected.
      }
      void meter.context.close().catch(() => {});
    }
    resetBars();
  }, [resetBars]);

  /**
   * Drives the meter bars straight from the analyser on each frame. Deliberately
   * not React state: a 60 Hz `setState` would re-render the whole panel — and
   * its transcript — for a decoration.
   */
  const startMeter = useCallback(
    (stream: MediaStream) => {
      stopMeter();
      const AudioContextClass =
        typeof window === "undefined"
          ? undefined
          : (window.AudioContext ??
            (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext);
      if (!AudioContextClass) return;
      // Held outside the try so the catch can close a context that was created
      // but never published to meterRef — stopMeter() can only release one that
      // got that far, and a native audio context leaks for the page's life.
      let context: AudioContext | null = null;
      try {
        context = new AudioContextClass();
        void context.resume().catch(() => {});
        const analyser = context.createAnalyser();
        analyser.fftSize = 64;
        analyser.smoothingTimeConstant = 0.72;
        const source = context.createMediaStreamSource(stream);
        source.connect(analyser);
        const meter = {
          context,
          analyser,
          source,
          data: new Uint8Array(analyser.frequencyBinCount),
          frame: null as number | null,
        };
        meterRef.current = meter;
        const render = () => {
          if (meterRef.current !== meter) return;
          const bars = visualizerNodeRef.current?.querySelectorAll<HTMLElement>("span");
          if (bars?.length) {
            analyser.getByteFrequencyData(meter.data);
            const bins = meter.data.length;
            bars.forEach((bar, index) => {
              const start = Math.floor((index / bars.length) * bins);
              const end = Math.max(start + 1, Math.floor(((index + 1) / bars.length) * bins));
              let energy = 0;
              for (let bin = start; bin < end; bin++) energy += meter.data[bin];
              bar.style.setProperty(
                "--voice-level",
                visualizerBarLevel(energy, end - start).toFixed(3),
              );
            });
          }
          meter.frame = requestAnimationFrame(render);
        };
        render();
      } catch {
        stopMeter();
        // A no-op when stopMeter() already closed this one: closing twice only
        // rejects, and that rejection is swallowed here.
        void context?.close().catch(() => {});
      }
    },
    [stopMeter],
  );

  /**
   * The live session, owned by the effect below rather than by a `useMemo`.
   *
   * A memo outlives the mount that created it, so under React's development
   * double-invoke the cleanup would dispose a session the remounted panel then
   * keeps using — leaving a microphone button that does nothing. Creating it in
   * the effect ties its lifetime to the mount exactly.
   */
  const sessionRef = useRef<VoiceSession | null>(null);

  useEffect(() => {
    if (!recognizerFactory) return;
    const session = new VoiceSession({
      createRecognizer: recognizerFactory,
      synthesis: typeof window === "undefined" ? null : (window.speechSynthesis ?? null),
      createUtterance: (text) => new SpeechSynthesisUtterance(text),
      requestStream: () =>
        navigator.mediaDevices.getUserMedia({
          // The meter only needs energy, so ask for the cleanest stream the
          // browser will give: room tone would otherwise animate it constantly.
          audio: { echoCancellation: true, noiseSuppression: true },
        }),
      language: () =>
        speechLanguageFor(
          languageRef.current,
          typeof navigator === "undefined" ? [] : (navigator.languages ?? []),
        ),
      onEvent: (event) => {
        switch (event.type) {
          case "state":
            setStatus(event.status);
            setMode(event.mode);
            if (event.status !== "error") setErrorKey(null);
            break;
          case "interim":
            onInterimRef.current(event.text);
            break;
          case "transcript":
            onTranscriptRef.current(event.text);
            break;
          case "error":
            setErrorKey(event.messageKey);
            break;
          case "stream":
            if (event.stream) startMeter(event.stream);
            else stopMeter();
            break;
        }
      },
    });
    sessionRef.current = session;
    // Releases the microphone and silences any reply when the panel unmounts.
    return () => {
      session.dispose();
      sessionRef.current = null;
      stopMeter();
    };
  }, [recognizerFactory, startMeter, stopMeter]);

  // Losing the provider mid-session would leave a live microphone feeding a
  // panel that can no longer send, so end the session with it.
  useEffect(() => {
    if (!enabled) sessionRef.current?.stop();
  }, [enabled]);

  const toggle = useCallback(() => {
    const session = sessionRef.current;
    if (!session) return;
    setErrorKey(null);
    if (session.isActive()) session.stop();
    else session.start("open-mic");
  }, []);

  const stop = useCallback(() => sessionRef.current?.stop(), []);

  /*
   * Hold-Space push-to-talk.
   *
   * Bound in the capture phase so the same physical hold can cross the 500 ms
   * threshold even when a focused control calls `preventDefault` for its own
   * Space behavior — and so a short tap still reaches that control untouched.
   * Scoped to the assistant panel being open (`enabled`), because Space belongs
   * to the rest of the app the rest of the time.
   */
  useEffect(() => {
    if (!recognizerFactory || !enabled || typeof document === "undefined") return;
    let spaceDown = false;
    let claimed = false;
    let holdTimer: ReturnType<typeof setTimeout> | null = null;
    let holdFocusOwner: Element | null = null;
    let holdControl: HTMLElement | null = null;
    // True when a focused control owns this Space press: its native keydown and
    // release are left intact unless the hold is claimed.
    let preservesNative = false;

    const cancelHold = () => {
      if (holdTimer !== null) clearTimeout(holdTimer);
      holdTimer = null;
    };

    const resetGesture = () => {
      holdFocusOwner = null;
      holdControl = null;
      preservesNative = false;
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (!shouldHandlePushToTalkKeyDown(event)) return;
      if (event.repeat) {
        // Keep suppressing page scroll for a hold we already reserved.
        if ((spaceDown && !preservesNative) || claimed) event.preventDefault();
        return;
      }
      spaceDown = true;
      setSpaceHeld(true);
      holdFocusOwner = document.activeElement;
      const active = document.activeElement;
      holdControl = isInteractiveSpaceTarget(active)
        ? (active as HTMLElement)
        : isInteractiveSpaceTarget(event.target)
          ? ((event.target as Element).closest?.(SPACE_INTERACTIVE_SELECTOR) ??
            (event.target as HTMLElement))
          : null;
      preservesNative = Boolean(holdControl);
      // Background Space is reserved at once so the page cannot scroll under
      // the gesture; a focused control keeps its own behavior for now.
      if (!preservesNative) event.preventDefault();
      // A click-started session is intentionally open-mic, and Space leaves it
      // alone: releasing the key must never surprise the user by cutting off a
      // conversation they started with the button. Every other state — idle, or
      // a push-to-talk turn still working or speaking — is fair game, so a hold
      // can interrupt an answer with a new one.
      if (sessionRef.current?.getMode() === "open-mic") return;
      cancelHold();
      holdTimer = setTimeout(() => {
        holdTimer = null;
        if (!spaceDown || claimed) return;
        // A pointer or Tab focus change during the hold belongs to that new
        // owner, not to voice.
        if (document.activeElement !== holdFocusOwner) return;
        if (document.visibilityState === "hidden" || !document.hasFocus()) return;
        if (sessionRef.current?.getMode() === "open-mic") return;
        // Blur before listening starts, so the eventual Space release cannot
        // also activate the control that was focused when the hold began.
        if (holdControl && document.activeElement === holdControl) holdControl.blur?.();
        claimed = true;
        setErrorKey(null);
        sessionRef.current?.start("push-to-talk");
      }, PUSH_TO_TALK_HOLD_DELAY_MS);
    };

    const onKeyUp = (event: KeyboardEvent) => {
      if (!isPushToTalkKey(event)) return;
      const wasDown = spaceDown;
      const keptNative = preservesNative;
      spaceDown = false;
      setSpaceHeld(false);
      cancelHold();
      if (!claimed) {
        if (wasDown && !keptNative) event.preventDefault();
        resetGesture();
        return;
      }
      event.preventDefault();
      claimed = false;
      sessionRef.current?.releasePushToTalk();
      resetGesture();
    };

    // A hold interrupted by losing the window ends the turn: the key-up will
    // never arrive, and a microphone left open behind an unfocused tab is worse
    // than a truncated phrase.
    const onBlur = () => {
      spaceDown = false;
      setSpaceHeld(false);
      cancelHold();
      if (claimed) {
        claimed = false;
        sessionRef.current?.releasePushToTalk();
      }
      resetGesture();
    };

    const onVisibility = () => {
      if (document.visibilityState === "hidden") onBlur();
    };

    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelHold();
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onVisibility);
      setSpaceHeld(false);
    };
  }, [enabled, recognizerFactory]);

  const setSpeakReplies = useCallback((next: boolean) => {
    setSpeakRepliesState(next);
    if (!next) sessionRef.current?.stopSpeaking();
    try {
      window.localStorage.setItem(SPEAK_STORAGE_KEY, String(next));
    } catch {
      // Best-effort persistence only.
    }
  }, []);

  const speakReply = useCallback((markdown: string) => {
    // Only a voice turn gets a spoken answer: a typed question while the
    // microphone happens to be open was asked in writing, and a panel that
    // starts talking over a silent workflow is worse than one that stays mute.
    const session = sessionRef.current;
    if (!session || !speakRepliesRef.current || !session.isActive()) return;
    session.speak(spokenTextFromMarkdown(markdown));
  }, []);

  const silence = useCallback(() => sessionRef.current?.stopSpeaking(), []);

  const notifyRunStart = useCallback(() => sessionRef.current?.notifyRunStart(), []);
  const notifyRunEnd = useCallback(() => sessionRef.current?.notifyRunEnd(), []);

  const visualizerRef = useCallback((node: HTMLElement | null) => {
    visualizerNodeRef.current = node;
  }, []);

  return {
    supported: recognizerFactory !== null,
    canSpeak,
    status,
    mode,
    spaceHeld,
    errorKey,
    speakReplies,
    setSpeakReplies,
    toggle,
    stop,
    visualizerRef,
    speakReply,
    silence,
    notifyRunStart,
    notifyRunEnd,
  };
}

/** Re-exported so the panel can guard the microphone button's click. */
export { shouldIgnoreVoiceButtonClick };

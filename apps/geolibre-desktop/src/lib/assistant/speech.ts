/**
 * Browser speech plumbing for the assistant's voice command mode: capability
 * detection, the locale the microphone listens in, and turning the assistant's
 * markdown reply into something worth reading aloud.
 *
 * The Web Speech API is not in `lib.dom` for the TypeScript version this repo
 * builds with, and it is still vendor-prefixed in Chrome, so the small surface
 * the voice session uses is declared here rather than pulled in as a dependency.
 */

/** One hypothesis for a recognized phrase. */
export interface SpeechAlternative {
  transcript: string;
  confidence: number;
}

/** One recognized phrase, final or still being revised. */
export interface SpeechResult {
  readonly length: number;
  readonly isFinal: boolean;
  [index: number]: SpeechAlternative;
}

/** A `result` event: results from `resultIndex` onward are the new ones. */
export interface SpeechRecognitionResultEvent {
  resultIndex: number;
  results: { readonly length: number; [index: number]: SpeechResult };
}

/** An `error` event. `error` carries the machine-readable cause. */
export interface SpeechRecognitionErrorEvent {
  error: string;
  message?: string;
}

/** The recognizer surface the voice session drives. */
export interface SpeechRecognizer {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechRecognitionResultEvent) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
  onaudiostart: (() => void) | null;
}

/** Constructs a recognizer. */
export type SpeechRecognizerFactory = () => SpeechRecognizer;

interface SpeechWindow {
  SpeechRecognition?: new () => SpeechRecognizer;
  webkitSpeechRecognition?: new () => SpeechRecognizer;
  speechSynthesis?: SpeechSynthesis;
}

/**
 * The platform's recognizer constructor, or `null` where there is none.
 *
 * Chrome, Edge and Safari ship it (Chrome's is prefixed); Firefox does not, and
 * neither do the Tauri webviews, which is why the panel hides the microphone
 * instead of offering a control that can only fail.
 */
export function getSpeechRecognizerFactory(): SpeechRecognizerFactory | null {
  if (typeof window === "undefined") return null;
  const scope = window as unknown as SpeechWindow;
  const Ctor = scope.SpeechRecognition ?? scope.webkitSpeechRecognition;
  return Ctor ? () => new Ctor() : null;
}

/** Whether this browser can speak the assistant's replies. */
export function isVoiceOutputSupported(): boolean {
  if (typeof window === "undefined") return false;
  const synthesis = (window as unknown as SpeechWindow).speechSynthesis;
  return Boolean(synthesis && typeof synthesis.speak === "function");
}

/**
 * The BCP-47 tag the microphone should listen in.
 *
 * The app language is a base subtag (`en`, `pt`), but recognition accuracy and
 * synthesis voice choice both improve with a region (`en-GB`, `pt-BR`). When
 * the browser's own locale is a region variant of the same language, prefer it;
 * otherwise fall back to the bare app language, which every engine accepts.
 *
 * @param appLanguage - The active i18next language, e.g. `"pt"` or `"pt-BR"`.
 * @param browserLanguages - `navigator.languages`, most-preferred first.
 * @returns A BCP-47 language tag.
 */
export function speechLanguageFor(
  appLanguage: string | null | undefined,
  browserLanguages: readonly string[] = [],
): string {
  const app = String(appLanguage || "").trim();
  if (!app) return browserLanguages[0] || "en-US";
  if (app.includes("-")) return app;
  const base = app.toLowerCase();
  const regional = browserLanguages.find(
    (tag) => typeof tag === "string" && tag.toLowerCase().split("-")[0] === base,
  );
  return regional || app;
}

/**
 * Whether a recognition error means the microphone is unusable, as opposed to
 * a turn that simply produced nothing.
 *
 * `no-speech` and `aborted` are ordinary outcomes of a push-to-talk hold the
 * user released without saying anything, or of a session they toggled off —
 * surfacing either as an error would make the control feel broken.
 */
export function isFatalSpeechError(code: string): boolean {
  return code !== "no-speech" && code !== "aborted";
}

/**
 * A message catalog key the voice session can report.
 *
 * Typed as a union rather than a bare string so `t()` still checks it against
 * the English catalog: a key renamed in `en.json` and not here is a build
 * error, not a literal `assistant.voice.errorDenied` shown to the user.
 */
export type VoiceMessageKey =
  | "assistant.voice.errorDenied"
  | "assistant.voice.errorNoMicrophone"
  | "assistant.voice.errorNetwork"
  | "assistant.voice.errorLanguage"
  | "assistant.voice.errorGeneric";

/**
 * The catalog key describing a recognition error.
 *
 * @param code - The `error` field of a recognition error event.
 */
export function speechErrorKey(code: string): VoiceMessageKey {
  switch (code) {
    case "not-allowed":
    case "service-not-allowed":
      return "assistant.voice.errorDenied";
    case "audio-capture":
      return "assistant.voice.errorNoMicrophone";
    case "network":
      return "assistant.voice.errorNetwork";
    case "language-not-supported":
      return "assistant.voice.errorLanguage";
    default:
      return "assistant.voice.errorGeneric";
  }
}

/** Longest reply read aloud before it is truncated at a sentence boundary. */
export const MAX_SPOKEN_CHARS = 700;

/**
 * Turns an assistant reply into plain text worth reading aloud.
 *
 * The assistant answers in markdown, and a synthesizer handed it raw says
 * "asterisk asterisk" and spells out URLs. Fenced code blocks are dropped
 * outright rather than narrated — the transcript already shows them, and the
 * SQL the assistant runs is long, punctuated, and meaningless spoken.
 *
 * @param markdown - The assistant's reply text.
 * @returns Speakable plain text, possibly empty when the reply was only code.
 */
export function spokenTextFromMarkdown(markdown: string): string {
  if (!markdown) return "";
  const text = stripTableSeparators(markdown)
    // Fenced code, including one the stream has not closed yet.
    .replace(/```[\s\S]*?(```|$)/g, " ")
    // Images first: their alt text is decorative, unlike a link's label.
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    // List markers, which otherwise read as punctuation.
    .replace(/^\s*([-*+]|\d+\.)\s+/gm, "")
    // Tables: drop the separator row, then read each remaining row as its cells.
    // Blanking whole rows would swallow the answer entirely — "top N" questions
    // are usually answered in a table, and an empty string leaves `speak()` with
    // nothing to say and the user with no idea why.
    .replace(/^[ \t]*\|[ \t]*/gm, "")
    .replace(/[ \t]*\|[ \t]*$/gm, ".")
    .replace(/[ \t]*\|[ \t]*/g, ", ")
    .replace(/(\*\*|__|\*|_|~~)/g, "")
    .replace(/^\s*([-*_]\s*){3,}$/gm, " ")
    .replace(/\bhttps?:\/\/\S+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return truncateSpoken(text, MAX_SPOKEN_CHARS);
}

/**
 * Drops the separator row of each markdown table, which carries no words.
 *
 * Position decides this, not content: `| - | - |` is a valid separator *and* a
 * valid row of placeholder cells, so only the row directly under a header — and
 * only the first such row in a table — is dropped. Matching on shape alone
 * would silently swallow a row of the answer, which is the failure this whole
 * path exists to avoid.
 *
 * @param markdown - The reply text.
 */
function stripTableSeparators(markdown: string): string {
  let afterRow = false;
  let separatorTaken = false;
  return markdown
    .split("\n")
    .map((line) => {
      if (!/^[ \t]*\|.*\|[ \t]*$/.test(line)) {
        // Anything that is not a table row ends the table.
        afterRow = false;
        separatorTaken = false;
        return line;
      }
      const isSeparator = /^[ \t|:-]+$/.test(line);
      const drop = isSeparator && afterRow && !separatorTaken;
      if (drop) separatorTaken = true;
      afterRow = true;
      return drop ? " " : line;
    })
    .join("\n");
}

/**
 * Cuts speakable text to a length, preferring the last sentence end before the
 * limit so the voice stops on a full stop rather than mid-word.
 *
 * @param text - Plain text to shorten.
 * @param limit - Maximum characters to keep.
 */
export function truncateSpoken(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const head = text.slice(0, limit);
  const lastSentence = Math.max(
    head.lastIndexOf(". "),
    head.lastIndexOf("! "),
    head.lastIndexOf("? "),
  );
  // Only honor a sentence break in the back half; an early one would drop most
  // of the reply on the floor.
  if (lastSentence > limit * 0.5) return head.slice(0, lastSentence + 1);
  const lastSpace = head.lastIndexOf(" ");
  return `${(lastSpace > 0 ? head.slice(0, lastSpace) : head).trimEnd()}…`;
}

/**
 * Joins the alternatives of the results a `result` event delivered.
 *
 * Interim and final results arrive in the same list, so they are separated
 * here: the final text is committed and sent, while the interim text is only
 * previewed in the composer and replaced by the next event.
 *
 * @param event - The recognition `result` event.
 */
export function readSpeechResults(event: SpeechRecognitionResultEvent): {
  final: string;
  interim: string;
} {
  let final = "";
  let interim = "";
  const results = event.results;
  for (let index = event.resultIndex; index < results.length; index++) {
    const result = results[index];
    const transcript = result?.[0]?.transcript ?? "";
    if (!transcript) continue;
    if (result.isFinal) final += transcript;
    else interim += transcript;
  }
  return { final: final.trim(), interim: interim.trim() };
}

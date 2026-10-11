/**
 * Spoken guidance through the Web Speech API. Valhalla writes each
 * announcement in the route's language, so the utterance is tagged with that
 * language and given a matching installed voice when there is one; without a
 * speech engine the drive simply stays silent.
 */

/**
 * Whether the platform can speak.
 *
 * @returns True when `speechSynthesis` is available.
 */
export function speechSupported(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

/**
 * The installed voice that best matches a language tag: an exact match, then
 * one with the same base language.
 *
 * @param lang - A BCP 47 tag such as `de-DE` or `en`.
 * @returns The voice, or undefined to leave the choice to the engine.
 */
function voiceFor(lang: string): SpeechSynthesisVoice | undefined {
  const voices = window.speechSynthesis.getVoices();
  const wanted = lang.toLowerCase();
  const base = wanted.split("-")[0];
  return (
    voices.find((v) => v.lang.toLowerCase() === wanted) ??
    voices.find((v) => v.lang.toLowerCase().split(/[-_]/)[0] === base)
  );
}

/**
 * Speak a line, cutting off whatever is still being said: a newer prompt is
 * always the more relevant one while driving.
 *
 * @param text - What to say.
 * @param lang - The language it is written in.
 */
export function speak(text: string, lang: string): void {
  if (!speechSupported() || !text) return;
  try {
    const synth = window.speechSynthesis;
    synth.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = lang;
    const voice = voiceFor(lang);
    if (voice) utterance.voice = voice;
    synth.speak(utterance);
  } catch {
    // A speech engine that throws (no voices installed) leaves the drive silent.
  }
}

/** Stop speaking at once (muting, ending the drive). */
export function stopSpeaking(): void {
  if (!speechSupported()) return;
  try {
    window.speechSynthesis.cancel();
  } catch {
    // Nothing to stop.
  }
}

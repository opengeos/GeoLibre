import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MAX_SPOKEN_CHARS,
  isFatalSpeechError,
  readSpeechResults,
  speechErrorKey,
  speechLanguageFor,
  spokenTextFromMarkdown,
  truncateSpoken,
  type SpeechRecognitionResultEvent,
} from "../apps/geolibre-desktop/src/lib/assistant/speech";

/** Builds a `result` event the way a recognizer delivers one. */
function resultEvent(
  phrases: ReadonlyArray<{ transcript: string; isFinal: boolean }>,
  resultIndex = 0,
): SpeechRecognitionResultEvent {
  const results = phrases.map((phrase) => ({
    length: 1,
    isFinal: phrase.isFinal,
    0: { transcript: phrase.transcript, confidence: 0.9 },
  }));
  return {
    resultIndex,
    results: Object.assign({ length: results.length }, results),
  } as unknown as SpeechRecognitionResultEvent;
}

describe("speech recognition language", () => {
  it("prefers the browser's regional variant of the app language", () => {
    // "pt" with a pt-BR browser listens as pt-BR: the accent models differ.
    assert.equal(speechLanguageFor("pt", ["pt-BR", "en-US"]), "pt-BR");
    assert.equal(speechLanguageFor("en", ["en-GB"]), "en-GB");
  });

  it("keeps an explicit regional app language as-is", () => {
    assert.equal(speechLanguageFor("pt-BR", ["en-US"]), "pt-BR");
  });

  it("falls back to the bare app language when the browser is elsewhere", () => {
    assert.equal(speechLanguageFor("ja", ["en-US", "fr-FR"]), "ja");
    assert.equal(speechLanguageFor("de", []), "de");
  });

  it("falls back to the browser, then to en-US, with no app language", () => {
    assert.equal(speechLanguageFor("", ["fr-FR"]), "fr-FR");
    assert.equal(speechLanguageFor(null, []), "en-US");
  });
});

describe("speech error classification", () => {
  it("treats a silent turn and a cancelled session as ordinary", () => {
    // Releasing Space without speaking, or toggling the session off, must not
    // paint the control red.
    assert.equal(isFatalSpeechError("no-speech"), false);
    assert.equal(isFatalSpeechError("aborted"), false);
  });

  it("treats a refused or missing microphone as fatal", () => {
    assert.equal(isFatalSpeechError("not-allowed"), true);
    assert.equal(isFatalSpeechError("audio-capture"), true);
  });

  it("maps each cause to its own catalog key", () => {
    assert.equal(speechErrorKey("not-allowed"), "assistant.voice.errorDenied");
    assert.equal(speechErrorKey("service-not-allowed"), "assistant.voice.errorDenied");
    assert.equal(speechErrorKey("audio-capture"), "assistant.voice.errorNoMicrophone");
    assert.equal(speechErrorKey("network"), "assistant.voice.errorNetwork");
    assert.equal(speechErrorKey("language-not-supported"), "assistant.voice.errorLanguage");
    assert.equal(speechErrorKey("something-new"), "assistant.voice.errorGeneric");
  });
});

describe("reading recognition results", () => {
  it("separates the finished phrase from the one still being revised", () => {
    const { final, interim } = readSpeechResults(
      resultEvent([
        { transcript: "show me rivers", isFinal: true },
        { transcript: " in Kenya", isFinal: false },
      ]),
    );
    assert.equal(final, "show me rivers");
    assert.equal(interim, "in Kenya");
  });

  it("reads only the results the event says are new", () => {
    // Chrome keeps every result of the session in `results`; re-reading the
    // earlier ones would send the same phrase again on each event.
    const { final } = readSpeechResults(
      resultEvent(
        [
          { transcript: "already sent", isFinal: true },
          { transcript: "the new one", isFinal: true },
        ],
        1,
      ),
    );
    assert.equal(final, "the new one");
  });

  it("returns empty strings for an event with nothing in it", () => {
    assert.deepEqual(readSpeechResults(resultEvent([])), { final: "", interim: "" });
  });
});

describe("turning a reply into speech", () => {
  it("drops fenced code rather than narrating it", () => {
    const spoken = spokenTextFromMarkdown(
      "Here is the query:\n\n```sql\nSELECT * FROM t WHERE x > 1;\n```\n\nIt found 12 rows.",
    );
    assert.equal(spoken, "Here is the query: It found 12 rows.");
  });

  it("drops a code fence the stream has not closed yet", () => {
    assert.equal(spokenTextFromMarkdown("Running:\n```sql\nSELECT 1"), "Running:");
  });

  it("reads a link's label but not its URL", () => {
    assert.equal(
      spokenTextFromMarkdown("See the [layer docs](https://example.com/a/b) for more."),
      "See the layer docs for more.",
    );
    assert.equal(spokenTextFromMarkdown("Open https://example.com/x now"), "Open now");
  });

  it("strips headings, emphasis, list markers and table pipes", () => {
    assert.equal(
      spokenTextFromMarkdown("## Result\n\n- **Nairobi**: 4.4M\n- _Mombasa_: 1.2M"),
      "Result Nairobi: 4.4M Mombasa: 1.2M",
    );
    assert.equal(spokenTextFromMarkdown("| a | b |\n| - | - |\n| 1 | 2 |"), "");
  });

  it("keeps inline code as the word it is", () => {
    assert.equal(
      spokenTextFromMarkdown("The `population` column is empty."),
      "The population column is empty.",
    );
  });

  it("says nothing for an empty or code-only reply", () => {
    assert.equal(spokenTextFromMarkdown(""), "");
    assert.equal(spokenTextFromMarkdown("```\nSELECT 1\n```"), "");
  });
});

describe("truncating spoken text", () => {
  it("leaves a short reply alone", () => {
    assert.equal(truncateSpoken("All done.", 50), "All done.");
  });

  it("stops on the last full stop in the back half", () => {
    const text = `${"a".repeat(30)}. ${"b".repeat(30)}. ${"c".repeat(40)}`;
    const spoken = truncateSpoken(text, 70);
    assert.ok(spoken.endsWith("."));
    assert.ok(spoken.length <= 70);
  });

  it("falls back to a word boundary with an ellipsis when no sentence ends late", () => {
    // An early full stop would throw most of the reply away, so it is ignored.
    const spoken = truncateSpoken(`Short. ${"word ".repeat(40)}`, 60);
    assert.ok(spoken.endsWith("…"));
    assert.ok(!spoken.endsWith(" …"));
  });

  it("caps a long reply at the spoken limit", () => {
    const spoken = spokenTextFromMarkdown("sentence here. ".repeat(200));
    assert.ok(spoken.length <= MAX_SPOKEN_CHARS);
  });
});

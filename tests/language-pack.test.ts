import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  fetchLanguagePack,
  LANGUAGE_PACK_MAX_BYTES,
  LanguagePackError,
  languagePackUrl,
  parseLanguagePack,
} from "../apps/geolibre-desktop/src/lib/language-pack";

function pack(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: "geolibre-language-pack",
    formatVersion: 1,
    scope: "whitebox",
    locale: "zh",
    name: "简体中文 Whitebox 语言包",
    updatedAt: "2026-08-22T00:00:00.000Z",
    translations: {
      processing: {
        toolMeta: {
          whitebox: {
            buffer: {
              name: "缓冲区",
              params: { input: { label: "输入" } },
            },
          },
        },
        whitebox: {
          categories: { terrain: "地形" },
          menuTool: { buffer: "缓冲区" },
          menuSubcategory: { vector_tools: "矢量工具" },
        },
      },
    },
    ...overrides,
  };
}

function errorCode(action: () => unknown): string | undefined {
  try {
    action();
  } catch (error) {
    return error instanceof LanguagePackError ? error.code : undefined;
  }
  return undefined;
}

describe("GeoLibre language packs", () => {
  it("parses a scoped Whitebox translation pack", () => {
    const parsed = parseLanguagePack(JSON.stringify(pack()));
    assert.equal(parsed.locale, "zh");
    assert.deepEqual(parsed.translations.processing.toolMeta?.whitebox.buffer, {
      name: "缓冲区",
      params: { input: { label: "输入" } },
    });
  });

  it("rejects malformed JSON and unsupported versions", () => {
    assert.equal(
      errorCode(() => parseLanguagePack("{")),
      "invalid-json",
    );
    assert.equal(
      errorCode(() => parseLanguagePack(JSON.stringify(pack({ formatVersion: 2 })))),
      "unsupported-version",
    );
  });

  it("rejects translations outside the Whitebox scope", () => {
    const translations = { processing: { toolMeta: { vector: { buffer: "缓冲区" } } } };
    assert.equal(
      errorCode(() => parseLanguagePack(JSON.stringify(pack({ translations })))),
      "invalid-translations",
    );
  });

  it("rejects unsafe keys and non-string leaves", () => {
    const unsafe = JSON.stringify(pack()).replace('"buffer"', '"__proto__"');
    assert.equal(
      errorCode(() => parseLanguagePack(unsafe)),
      "invalid-translations",
    );

    const translations = {
      processing: { toolMeta: { whitebox: { buffer: { name: 42 } } } },
    };
    assert.equal(
      errorCode(() => parseLanguagePack(JSON.stringify(pack({ translations })))),
      "invalid-translations",
    );
  });

  it("caps imported files before parsing them", () => {
    assert.equal(
      errorCode(() => parseLanguagePack(" ".repeat(LANGUAGE_PACK_MAX_BYTES + 1))),
      "too-large",
    );
  });

  it("builds the stable custom-domain URL", () => {
    assert.equal(
      languagePackUrl("zh", "https://languages.geolibre.app/"),
      "https://languages.geolibre.app/v1/whitebox/zh.json",
    );
  });

  it("reports a missing official pack distinctly", async () => {
    const fetchImpl: typeof fetch = async () => new Response("missing", { status: 404 });
    await assert.rejects(
      () => fetchLanguagePack("fr", fetchImpl, "https://languages.geolibre.app"),
      (error: unknown) => error instanceof LanguagePackError && error.code === "not-found",
    );
  });

  it("validates downloaded content before returning it", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify(pack()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const downloaded = await fetchLanguagePack("zh", fetchImpl, "https://languages.geolibre.app");
    assert.equal(downloaded.pack.locale, "zh");
    assert.equal(downloaded.sourceUrl, "https://languages.geolibre.app/v1/whitebox/zh.json");
  });

  it("passes an abort signal so a hung host cannot wedge the Settings buttons", async () => {
    let signal: AbortSignal | null | undefined;
    const fetchImpl: typeof fetch = async (_input, init) => {
      signal = init?.signal;
      return new Response(JSON.stringify(pack()), { status: 200 });
    };
    await fetchLanguagePack("zh", fetchImpl, "https://languages.geolibre.app");
    assert.ok(signal instanceof AbortSignal);
  });

  it("aborts a host that accepts the connection and never answers", async () => {
    // Nothing resolves this request; only the timeout's own abort ends it, so
    // the assertion below proves the timeout fired rather than some other
    // rejection reaching the same error code.
    const fetchImpl: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    await assert.rejects(
      () => fetchLanguagePack("zh", fetchImpl, "https://languages.geolibre.app", 5),
      (error: unknown) =>
        error instanceof LanguagePackError &&
        error.code === "download-failed" &&
        error.message === "The language-pack download timed out.",
    );
  });

  it("does not read a missing content-length as a zero-byte body", async () => {
    // `Number(null)` is 0, which passes a `Number.isFinite` check as if the
    // chunked body were empty; only a declared length may short-circuit.
    const fetchImpl: typeof fetch = async () => {
      const response = new Response(JSON.stringify(pack()), { status: 200 });
      response.headers.delete("content-length");
      return response;
    };
    const downloaded = await fetchLanguagePack("zh", fetchImpl, "https://languages.geolibre.app");
    assert.equal(downloaded.pack.locale, "zh");
  });

  it("rejects a pack whose declared length exceeds the limit before reading it", async () => {
    let bodyRead = false;
    // A hand-rolled response, not a real one: the point is to observe that the
    // body is never read once the declared length is over the limit.
    const fetchImpl: typeof fetch = async () =>
      ({
        status: 200,
        ok: true,
        headers: new Headers({ "content-length": String(LANGUAGE_PACK_MAX_BYTES + 1) }),
        text: async () => {
          bodyRead = true;
          return "";
        },
      }) as unknown as Response;
    await assert.rejects(
      () => fetchLanguagePack("zh", fetchImpl, "https://languages.geolibre.app"),
      (error: unknown) => error instanceof LanguagePackError && error.code === "too-large",
    );
    assert.equal(bodyRead, false);
  });
});

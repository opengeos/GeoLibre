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
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

// The Linux desktop entry is hand-written because tauri-bundler's own template
// renders `Exec=` with no field code, which drops both the project path and the
// OAuth callback URL (#2671, #2667). A custom template only receives
// `categories`, `comment`, `exec`, `icon` and `name`, so `MimeType=` has to be
// spelled out here rather than derived from the config. These assertions are
// what keeps that copy honest.

const TEMPLATE = "apps/geolibre-desktop/src-tauri/main.desktop";
const CONFIG = "apps/geolibre-desktop/src-tauri/tauri.conf.json";
const MIME_XML = "packaging/linux/org.geolibre.project.xml";

type Config = {
  bundle?: {
    fileAssociations?: { ext?: string[]; mimeType?: string }[];
    linux?: Record<string, { desktopTemplate?: string; files?: Record<string, string> }>;
  };
  plugins?: { "deep-link"?: { desktop?: { schemes?: string[] } } };
};

const config = JSON.parse(readFileSync(CONFIG, "utf8")) as Config;
const template = readFileSync(TEMPLATE, "utf8");
const mimeXml = readFileSync(MIME_XML, "utf8");

const line = (key: string): string => {
  const found = template.split("\n").find((entry) => entry.startsWith(`${key}=`));
  assert.ok(found, `${TEMPLATE} has no ${key}= line`);
  return found.slice(key.length + 1);
};

const declaredTypes = (): string[] =>
  line("MimeType")
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean);

describe("linux desktop entry", () => {
  it("passes the launch argument through to the app", () => {
    // Only %u carries both a file and a URL, and the spec passes neither
    // without a field code. See launch_argument_path in src-tauri/src/lib.rs.
    assert.match(line("Exec"), /\s%u$/);
  });

  it("declares every associated media type", () => {
    const types = declaredTypes();
    for (const association of config.bundle?.fileAssociations ?? []) {
      assert.ok(
        association.mimeType && types.includes(association.mimeType),
        `${TEMPLATE} does not declare ${association.mimeType}`,
      );
    }
  });

  it("declares every registered URL scheme", () => {
    const types = declaredTypes();
    for (const scheme of config.plugins?.["deep-link"]?.desktop?.schemes ?? []) {
      assert.ok(
        types.includes(`x-scheme-handler/${scheme}`),
        `${TEMPLATE} does not declare x-scheme-handler/${scheme}`,
      );
    }
  });

  it("defines the media type it claims, with a glob per extension", () => {
    // Without this the MimeType= line never matches: a project file sniffs as
    // text/plain, because nothing else defines the type.
    for (const association of config.bundle?.fileAssociations ?? []) {
      assert.ok(
        mimeXml.includes(`<mime-type type="${association.mimeType}">`),
        `${MIME_XML} does not define ${association.mimeType}`,
      );
      for (const ext of association.ext ?? []) {
        assert.ok(
          mimeXml.includes(`<glob pattern="*.${ext}"/>`),
          `${MIME_XML} has no glob for *.${ext}`,
        );
      }
    }
  });

  it("ships the template and the media type to both package formats", () => {
    for (const format of ["deb", "rpm"]) {
      const bundle = config.bundle?.linux?.[format];
      assert.equal(bundle?.desktopTemplate, "main.desktop", `${format} uses the default template`);
      assert.ok(
        Object.values(bundle?.files ?? {}).some((source) =>
          source.endsWith("/org.geolibre.project.xml"),
        ),
        `${format} does not install ${MIME_XML}`,
      );
    }
  });
});

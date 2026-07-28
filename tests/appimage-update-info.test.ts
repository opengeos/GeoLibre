import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// scripts/embed-appimage-update-info.sh derives the AppImage "update
// information" string that the release workflow writes into the AppImage's
// `.upd_info` ELF section. The zsync file name inside it is a glob built from
// the bundle's own name, so a rename of the Tauri bundle would otherwise
// produce update information that matches nothing and only fails on a user's
// machine, months later, with "none of the artifacts matched the pattern".
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(repoRoot, "scripts", "embed-appimage-update-info.sh");

function print(name: string, env: Record<string, string> = {}): string {
  return execFileSync("bash", [script, "--print", name], {
    env: { ...process.env, REPO: "opengeos/GeoLibre", TAG: "v2.3.0", ...env },
    encoding: "utf8",
    // Capture stderr instead of letting the failure cases print through to the
    // test runner's own output.
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function printError(name: string, env: Record<string, string> = {}): string {
  try {
    print(name, env);
  } catch (error) {
    return String((error as { stderr?: Buffer }).stderr ?? "");
  }
  throw new Error(`expected embed-appimage-update-info.sh to fail for "${name}"`);
}

describe("embed-appimage-update-info.sh", () => {
  it("derives gh-releases-zsync update information with the version globbed", () => {
    assert.equal(
      print("GeoLibre.Desktop_2.3.0_amd64.AppImage"),
      "gh-releases-zsync|opengeos|GeoLibre|latest|GeoLibre.Desktop_*_amd64.AppImage.zsync",
    );
  });

  it("takes the owner and repository from REPO", () => {
    assert.equal(
      print("GeoLibre.Desktop_2.3.0_amd64.AppImage", { REPO: "giswqs/Fork" }),
      "gh-releases-zsync|giswqs|Fork|latest|GeoLibre.Desktop_*_amd64.AppImage.zsync",
    );
  });

  it("accepts a full path, using only the file name in the pattern", () => {
    assert.equal(
      print("target/release/bundle/appimage/GeoLibre.Desktop_2.3.0_amd64.AppImage"),
      "gh-releases-zsync|opengeos|GeoLibre|latest|GeoLibre.Desktop_*_amd64.AppImage.zsync",
    );
  });

  it("fits in the 1 KiB .upd_info section", () => {
    assert.ok(print("GeoLibre.Desktop_2.3.0_amd64.AppImage").length < 1024);
  });

  it("fails when the AppImage name does not carry the tag's version", () => {
    assert.match(printError("GeoLibre.Desktop_amd64.AppImage"), /does not contain _2\.3\.0_/);
  });

  it("fails when REPO is not an owner/name pair", () => {
    assert.match(
      printError("GeoLibre.Desktop_2.3.0_amd64.AppImage", { REPO: "GeoLibre" }),
      /not an owner\/name pair/,
    );
  });
});

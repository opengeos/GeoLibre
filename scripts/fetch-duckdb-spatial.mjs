// Downloads and gunzips the DuckDB spatial extension (v1.5.4) for every target
// platform into the Tauri resources tree. Run before `tauri:build`.
//
// Security: the extension is native code that gets loaded into the desktop app
// and bundled into release installers, so it must be fetched over HTTPS and
// verified against a checked-in SHA-256 manifest (scripts/duckdb-spatial-checksums.json).
// The download is gunzipped to a temp file, hashed, and only moved into the
// resources tree when the hash matches the pinned value. A mismatch fails the
// build (and never leaves a partial or untrusted file in place). On first run
// for a new version, run with GEOLIBRE_WRITE_CHECKSUMS=1 to record the pinned
// hashes, then review and commit the manifest.
import { createWriteStream } from "node:fs";
import { mkdir, rm, readFile, writeFile, rename } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createGunzip } from "node:zlib";
import { pipeline } from "node:stream/promises";

const DUCKDB_VERSION = "v1.5.4";
const PLATFORMS = ["osx_arm64", "osx_amd64", "windows_amd64", "linux_amd64", "linux_arm64"];
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outBase = join(root, "apps/geolibre-desktop/src-tauri/resources/duckdb");
const manifestPath = join(root, "scripts/duckdb-spatial-checksums.json");
const writeChecksums = process.env.GEOLIBRE_WRITE_CHECKSUMS === "1";

async function sha256File(path) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

async function loadManifest() {
  try {
    const raw = await readFile(manifestPath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed.version === DUCKDB_VERSION ? parsed.sha256 ?? {} : {};
  } catch {
    return {};
  }
}

const expected = await loadManifest();
const recorded = {};

for (const platform of PLATFORMS) {
  const url = `https://extensions.duckdb.org/${DUCKDB_VERSION}/${platform}/spatial.duckdb_extension.gz`;
  const outDir = join(outBase, platform);
  const outFile = join(outDir, "spatial.duckdb_extension");
  const tmpFile = `${outFile}.tmp`;
  await mkdir(outDir, { recursive: true });
  process.stdout.write(`Fetching ${platform} ... `);
  const res = await fetch(url);
  if (!res.ok) {
    await rm(tmpFile, { force: true });
    throw new Error(`Failed ${platform}: HTTP ${res.status} from ${url}`);
  }
  await pipeline(res.body, createGunzip(), createWriteStream(tmpFile));

  const digest = await sha256File(tmpFile);
  const pinned = expected[platform];
  if (pinned && pinned !== digest) {
    await rm(tmpFile, { force: true });
    throw new Error(
      `Checksum mismatch for ${platform}.\n  expected ${pinned}\n  got      ${digest}\n` +
        `Refusing to bundle an unverified native extension. If the upstream artifact ` +
        `legitimately changed, re-pin with GEOLIBRE_WRITE_CHECKSUMS=1 and review the diff.`,
    );
  }
  if (!pinned && !writeChecksums) {
    await rm(tmpFile, { force: true });
    throw new Error(
      `No pinned checksum for ${platform} (DuckDB ${DUCKDB_VERSION}). ` +
        `Re-run with GEOLIBRE_WRITE_CHECKSUMS=1 to record it, then commit ` +
        `scripts/duckdb-spatial-checksums.json.`,
    );
  }
  recorded[platform] = digest;
  await rename(tmpFile, outFile);
  console.log(pinned ? "done (verified)" : `done (recorded ${digest.slice(0, 12)}...)`);
}

if (writeChecksums) {
  const manifest = { version: DUCKDB_VERSION, sha256: recorded };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Wrote ${manifestPath}. Review and commit it.`);
}
console.log("All spatial extensions fetched.");

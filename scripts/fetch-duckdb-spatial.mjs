// Downloads and gunzips the DuckDB spatial extension (v1.5.4) into the Tauri
// resources tree. Run before `tauri:build`.
//
// By default this fetches only the artifact for the active build target (the
// host platform, or a Rust target triple passed via `--target`/`CARGO_BUILD_TARGET`/
// `GEOLIBRE_DUCKDB_TARGET`), since `bundled_spatial_extension_subpath()` in
// src/lib.rs loads exactly one per-platform file at runtime. Sibling platform
// directories are pruned so `resources/duckdb/**/*` cannot leak other targets'
// binaries into an installer. Pass GEOLIBRE_WRITE_CHECKSUMS=1 to fetch every
// platform and re-pin the manifest (see below).
//
// Security: the extension is native code that gets loaded into the desktop app
// and bundled into release installers, so it must be fetched over HTTPS and
// verified against a checked-in SHA-256 manifest (scripts/duckdb-spatial-checksums.json).
// The download is gunzipped to a temp file, hashed, and only moved into the
// resources tree when the hash matches the pinned value. A mismatch fails the
// build (and never leaves a partial or untrusted file in place). On first run
// for a new version, run with GEOLIBRE_WRITE_CHECKSUMS=1 to record the pinned
// hashes for every platform, then review and commit the manifest.
import { createWriteStream } from "node:fs";
import { mkdir, rm, readFile, writeFile, rename } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createGunzip } from "node:zlib";
import { pipeline } from "node:stream/promises";

const DUCKDB_VERSION = "v1.5.4";
const PLATFORMS = [
  "osx_arm64",
  "osx_amd64",
  "windows_amd64",
  "linux_amd64",
  "linux_arm64",
];
// Fail fast if the CDN stalls so the build never hangs indefinitely.
const DOWNLOAD_TIMEOUT_MS = 60_000;
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outBase = join(root, "apps/geolibre-desktop/src-tauri/resources/duckdb");
const manifestPath = join(root, "scripts/duckdb-spatial-checksums.json");
const writeChecksums = process.env.GEOLIBRE_WRITE_CHECKSUMS === "1";

// Maps the Rust target triples we build for to DuckDB's platform identifiers.
const TRIPLE_TO_PLATFORM = {
  "aarch64-apple-darwin": "osx_arm64",
  "x86_64-apple-darwin": "osx_amd64",
  "x86_64-pc-windows-msvc": "windows_amd64",
  "x86_64-pc-windows-gnu": "windows_amd64",
  "x86_64-unknown-linux-gnu": "linux_amd64",
  "x86_64-unknown-linux-musl": "linux_amd64",
  "aarch64-unknown-linux-gnu": "linux_arm64",
  "aarch64-unknown-linux-musl": "linux_arm64",
};

// Falls back to the host when no explicit target triple is supplied.
const HOST_TO_PLATFORM = {
  "darwin:arm64": "osx_arm64",
  "darwin:x64": "osx_amd64",
  "win32:x64": "windows_amd64",
  "linux:x64": "linux_amd64",
  "linux:arm64": "linux_arm64",
};

function parseTargetTriple(argv) {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if ((arg === "--target" || arg === "-t") && argv[i + 1]) return argv[i + 1];
    if (arg.startsWith("--target=")) return arg.slice("--target=".length);
    if (arg.startsWith("-t=")) return arg.slice("-t=".length);
  }
  return (
    process.env.GEOLIBRE_DUCKDB_TARGET || process.env.CARGO_BUILD_TARGET || ""
  );
}

function resolveActivePlatforms() {
  const triple = parseTargetTriple(process.argv.slice(2)).trim();
  if (triple) {
    // A universal macOS binary carries both arch slices, each resolving its own
    // per-arch subpath at runtime, so it needs both DuckDB artifacts.
    if (triple === "universal-apple-darwin") {
      return ["osx_arm64", "osx_amd64"];
    }
    const platform = TRIPLE_TO_PLATFORM[triple];
    if (!platform) {
      throw new Error(
        `Unsupported DuckDB target triple "${triple}". Known triples: ` +
          `${Object.keys(TRIPLE_TO_PLATFORM).join(
            ", "
          )}, universal-apple-darwin.`
      );
    }
    return [platform];
  }
  const hostKey = `${process.platform}:${process.arch}`;
  const platform = HOST_TO_PLATFORM[hostKey];
  if (!platform) {
    throw new Error(
      `Unsupported host platform "${hostKey}" for the DuckDB spatial extension. ` +
        `Pass --target <rust-triple> to select one of: ${PLATFORMS.join(", ")}.`
    );
  }
  return [platform];
}

async function sha256File(path) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

async function loadManifest() {
  let raw;
  try {
    raw = await readFile(manifestPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {};
    }
    // Surface I/O failures instead of silently treating them as "no manifest"
    // and re-pinning an unverified extension from the network.
    throw error;
  }
  const parsed = JSON.parse(raw);
  return parsed.version === DUCKDB_VERSION ? parsed.sha256 ?? {} : {};
}

async function fetchPlatform(platform, expected, recorded) {
  const url = `https://extensions.duckdb.org/${DUCKDB_VERSION}/${platform}/spatial.duckdb_extension.gz`;
  const outDir = join(outBase, platform);
  const outFile = join(outDir, "spatial.duckdb_extension");
  const tmpFile = `${outFile}.tmp`;
  await mkdir(outDir, { recursive: true });
  process.stdout.write(`Fetching ${platform} ... `);
  let res;
  try {
    res = await fetch(url, {
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
  } catch (error) {
    await rm(tmpFile, { force: true });
    if (error?.name === "TimeoutError") {
      throw new Error(
        `Timed out after ${DOWNLOAD_TIMEOUT_MS}ms fetching ${url}`
      );
    }
    throw error;
  }
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
        `legitimately changed, re-pin with GEOLIBRE_WRITE_CHECKSUMS=1 and review the diff.`
    );
  }
  if (!pinned && !writeChecksums) {
    await rm(tmpFile, { force: true });
    throw new Error(
      `No pinned checksum for ${platform} (DuckDB ${DUCKDB_VERSION}). ` +
        `Re-run with GEOLIBRE_WRITE_CHECKSUMS=1 to record it, then commit ` +
        `scripts/duckdb-spatial-checksums.json.`
    );
  }
  recorded[platform] = digest;
  await rename(tmpFile, outFile);
  console.log(
    pinned ? "done (verified)" : `done (recorded ${digest.slice(0, 12)}...)`
  );
}

// Removes platform directories we are not bundling so `resources/duckdb/**/*`
// never carries another target's native binary into an installer.
async function pruneOtherPlatforms(keep) {
  await Promise.all(
    PLATFORMS.filter((platform) => !keep.includes(platform)).map((platform) =>
      rm(join(outBase, platform), { recursive: true, force: true })
    )
  );
}

const expected = await loadManifest();
const recorded = {};

// Re-pinning records the full manifest, so it needs every platform. A normal
// build only ships the active target, so fetch (and keep) just that one.
const platforms = writeChecksums ? PLATFORMS : resolveActivePlatforms();

for (const platform of platforms) {
  await fetchPlatform(platform, expected, recorded);
}

if (!writeChecksums) {
  await pruneOtherPlatforms(platforms);
}

if (writeChecksums) {
  const manifest = { version: DUCKDB_VERSION, sha256: recorded };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Wrote ${manifestPath}. Review and commit it.`);
}
console.log(
  writeChecksums
    ? "All spatial extensions fetched."
    : `Spatial extension fetched for ${platforms.join(", ")}.`
);

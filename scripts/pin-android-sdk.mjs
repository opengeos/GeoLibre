// Keep generated Tauri templates on the Android platform installed by this build.
import { readFileSync, writeFileSync } from "node:fs";

const value =
  process.argv[2] ?? process.env.ANDROID_PLATFORM?.match(/^platforms;android-(\d+)$/)?.[1];
const api = Number(value);
if (!/^\d+$/.test(value ?? "") || !Number.isSafeInteger(api) || api < 24) {
  throw new Error("Supply an Android API level or set ANDROID_PLATFORM=platforms;android-N.");
}
const file = new URL(
  "../apps/geolibre-desktop/src-tauri/gen/android/app/build.gradle.kts",
  import.meta.url,
);
const source = readFileSync(file, "utf8");
const pattern = /^([ \t]*)(compileSdk|targetSdk)[ \t]*=[ \t]*\d+[ \t]*$/gm;
const matches = [...source.matchAll(pattern)];
if (matches.length !== 2 || new Set(matches.map((match) => match[2])).size !== 2) {
  throw new Error("The generated Android template must contain one compileSdk and one targetSdk.");
}
writeFileSync(
  file,
  source.replace(pattern, (_match, indent, name) => `${indent}${name} = ${api}`),
);
console.log(`Generated Android compileSdk and targetSdk pinned to ${api}.`);

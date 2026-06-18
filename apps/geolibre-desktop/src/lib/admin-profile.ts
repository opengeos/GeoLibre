// Admin UI-profile config file (issue #500).
//
// Administrators can pre-configure (and optionally lock) the UI profile for a
// deployment by providing an `admin-profile.json` file:
//   - Web / embed: served from the app root (e.g. nginx docroot). 404 ⇒ ignored.
//   - Desktop: read from `<app_config_dir>/admin-profile.json` via the Tauri
//     `read_admin_profile` command, which takes precedence over the bundled file.
// See `docs/ui-profiles.md`.

import { invoke } from "@tauri-apps/api/core";
import type {
  ExperienceLevel,
  UiProfileSettings,
} from "../hooks/useDesktopSettings";
import { isTauri } from "./is-tauri";
import { normalizeStringList } from "./string-lists";
import { presetHiddenSets } from "./ui-profile";

const EXPERIENCE_LEVELS: readonly ExperienceLevel[] = [
  "beginner",
  "intermediate",
  "advanced",
];

/** The raw shape an admin may author in `admin-profile.json`. */
interface AdminProfileFile {
  /** Whether profile filtering is active. Defaults to true for an admin file. */
  enabled?: boolean;
  /** An experience-level preset to seed the hidden lists from. */
  level?: ExperienceLevel;
  /** Explicit hidden ids (override the preset when present). */
  hiddenDataSources?: string[];
  hiddenPlugins?: string[];
  /** When true, the user cannot change the profile from Settings. */
  lock?: boolean;
}

/**
 * Resolve the admin profile into the parts of {@link UiProfileSettings} it
 * controls, or null when no (valid) admin file is present.
 *
 * @param pluginIds - Registered plugin ids, used to expand a `level` preset.
 * @returns A patch to merge into the stored UI profile, or null.
 */
export async function loadAdminProfile(
  pluginIds: readonly string[],
): Promise<Partial<UiProfileSettings> | null> {
  const file = await readAdminProfileFile();
  if (!file) return null;
  return resolveAdminProfile(file, pluginIds);
}

async function readAdminProfileFile(): Promise<AdminProfileFile | null> {
  // On desktop the OS config-dir file is authoritative; fall back to the bundled
  // file only if the command yields nothing.
  if (isTauri()) {
    try {
      const contents = await invoke<string | null>("read_admin_profile");
      const parsed = parseAdminProfile(contents);
      if (parsed) return parsed;
    } catch {
      // Ignore and try the bundled file below.
    }
  }

  try {
    const response = await fetch(`${import.meta.env.BASE_URL}admin-profile.json`);
    if (!response.ok) return null;
    return parseAdminProfile(await response.text());
  } catch {
    return null;
  }
}

function parseAdminProfile(contents: string | null): AdminProfileFile | null {
  if (!contents) return null;
  try {
    const parsed = JSON.parse(contents) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as AdminProfileFile;
  } catch {
    return null;
  }
}

/** Validate and normalize a raw admin file into a UI-profile patch. */
export function resolveAdminProfile(
  file: AdminProfileFile,
  pluginIds: readonly string[],
): Partial<UiProfileSettings> {
  const level =
    typeof file.level === "string" &&
    EXPERIENCE_LEVELS.includes(file.level as ExperienceLevel)
      ? (file.level as ExperienceLevel)
      : null;

  // A level seeds the hidden lists; explicit lists override per dimension.
  const preset = level ? presetHiddenSets(level, pluginIds) : null;
  const hiddenDataSources = Array.isArray(file.hiddenDataSources)
    ? normalizeStringList(file.hiddenDataSources)
    : (preset?.hiddenDataSources ?? []);
  const hiddenPlugins = Array.isArray(file.hiddenPlugins)
    ? normalizeStringList(file.hiddenPlugins)
    : (preset?.hiddenPlugins ?? []);

  return {
    // An admin file enables filtering unless it explicitly opts out.
    enabled: typeof file.enabled === "boolean" ? file.enabled : true,
    level,
    locked: file.lock === true,
    // An admin-managed profile should not also prompt the onboarding wizard.
    onboarded: true,
    hiddenDataSources,
    hiddenPlugins,
  };
}

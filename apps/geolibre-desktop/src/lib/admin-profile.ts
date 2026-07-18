// Admin UI-profile config file (issue #500).
//
// Administrators can pre-configure (and optionally lock) the UI profile for a
// deployment by providing an `admin-profile.json` file:
//   - Web / embed: served from the app root (e.g. nginx docroot). 404 ⇒ ignored.
//   - Desktop: read from `<app_config_dir>/admin-profile.json` via the Tauri
//     `read_admin_profile` command, which takes precedence over the bundled file.
// See `docs/ui-profiles.md`.

import { invoke } from "@tauri-apps/api/core";
import {
  EXPERIENCE_LEVELS,
  type ExperienceLevel,
  type UiProfileSettings,
} from "../hooks/useDesktopSettings";
import { OPTIONAL_RESOURCE_HEADER } from "./diagnostics";
import { isTauri } from "./is-tauri";
import { normalizeStringList } from "./string-lists";
import { presetHiddenSets } from "./ui-profile";

/** The raw shape an admin may author in `admin-profile.json`. */
interface AdminProfileFile {
  /** Whether profile filtering is active. Defaults to true for an admin file. */
  enabled?: boolean;
  /** An experience-level preset to seed the hidden lists from. */
  level?: ExperienceLevel;
  /** Explicit hidden ids (override the preset when present). */
  hiddenDataSources?: string[];
  hiddenPlugins?: string[];
  hiddenMenus?: string[];
  hiddenMenuItems?: string[];
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
  // On desktop the OS config-dir file is authoritative; only fall back to the
  // bundled web file when that file is absent (or the command itself fails).
  if (isTauri()) {
    try {
      const contents = await invoke<string | null>("read_admin_profile");
      // A non-null result means the desktop file exists, so use its parse result
      // (even if it is null because the file is malformed) rather than silently
      // letting the web file override an admin-managed deployment. A null result
      // means no desktop file, so fall through to the web file below.
      if (contents !== null) {
        const parsed = parseAdminProfile(contents);
        // The desktop file is expected to be valid JSON; surface a parse failure
        // in development so an admin can spot a malformed file. (The web fetch
        // below legitimately returns non-JSON when no file exists, so parse
        // warnings live here rather than inside parseAdminProfile.)
        if (parsed === null && import.meta.env.DEV) {
          console.warn("[admin-profile] desktop admin-profile.json is not valid JSON; ignoring.");
        }
        return parsed;
      }
    } catch (error) {
      // The command failed (not registered, permission denied, …). Fall back to
      // the bundled web file, but surface the error in development so a
      // misconfiguration is not invisible.
      if (import.meta.env.DEV) {
        console.warn("[admin-profile] read_admin_profile failed:", error);
      }
    }
  }

  try {
    // The admin file is optional; a 404 here is the normal "no admin profile"
    // case, so flag the request benign to keep it out of the error diagnostics.
    const response = await fetch(`${import.meta.env.BASE_URL}admin-profile.json`, {
      headers: { [OPTIONAL_RESOURCE_HEADER]: "1" },
    });
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
    typeof file.level === "string" && EXPERIENCE_LEVELS.includes(file.level as ExperienceLevel)
      ? (file.level as ExperienceLevel)
      : null;

  // A level seeds the hidden lists; explicit lists override per dimension.
  const preset = level ? presetHiddenSets(level, pluginIds) : null;
  const resolveList = (
    explicit: string[] | undefined,
    fromPreset: string[] | undefined,
  ): string[] => (Array.isArray(explicit) ? normalizeStringList(explicit) : (fromPreset ?? []));

  return {
    // An admin file enables filtering unless it explicitly opts out.
    enabled: typeof file.enabled === "boolean" ? file.enabled : true,
    level,
    locked: file.lock === true,
    // An admin-managed profile should not also prompt the onboarding wizard.
    onboarded: true,
    hiddenDataSources: resolveList(file.hiddenDataSources, preset?.hiddenDataSources),
    hiddenPlugins: resolveList(file.hiddenPlugins, preset?.hiddenPlugins),
    hiddenMenus: resolveList(file.hiddenMenus, preset?.hiddenMenus),
    hiddenMenuItems: resolveList(file.hiddenMenuItems, preset?.hiddenMenuItems),
  };
}

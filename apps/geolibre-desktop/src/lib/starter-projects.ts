// Built-in starter projects shown under New Project → Examples. The list is a
// small static manifest (`starter-projects.json`) of demo projects hosted in
// opengeos/geolibre-assets, so it ships with the app and needs no request to
// render; only opening an example (and its thumbnail) touches the network.
import manifest from "./starter-projects.json";

/** One curated example project. */
export interface StarterProject {
  /** Stable id (the demo's slug). */
  id: string;
  /** Display title. Demo titles are proper content, shown untranslated. */
  title: string;
  /** One-line description of what the map shows. */
  description: string;
  /** Absolute https URL of a preview image. */
  thumbnailUrl: string;
  /** Absolute https URL of the raw `.geolibre.json` project. */
  projectUrl: string;
}

const REQUIRED_FIELDS = ["id", "title", "description", "thumbnailUrl", "projectUrl"] as const;
const URL_FIELDS = ["thumbnailUrl", "projectUrl"] as const;

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Validate a raw starter-project manifest, returning the problems found. An
 * empty array means every entry is usable.
 *
 * @param raw The parsed manifest JSON (`{ examples: [...] }`).
 *
 * @returns Human-readable problems, one per offending field or entry.
 */
export function validateStarterManifest(raw: unknown): string[] {
  const examples = (raw as { examples?: unknown } | null)?.examples;
  if (!Array.isArray(examples)) return ["manifest has no `examples` array"];
  const problems: string[] = [];
  const seen = new Set<string>();
  examples.forEach((entry: unknown, index) => {
    if (!entry || typeof entry !== "object") {
      problems.push(`examples[${index}] is not an object`);
      return;
    }
    const record = entry as Record<string, unknown>;
    for (const field of REQUIRED_FIELDS) {
      const value = record[field];
      if (typeof value !== "string" || value.trim() === "") {
        problems.push(`examples[${index}].${field} is missing or empty`);
      }
    }
    for (const field of URL_FIELDS) {
      const value = record[field];
      if (typeof value === "string" && value.trim() !== "" && !isHttpsUrl(value)) {
        problems.push(`examples[${index}].${field} is not an https URL`);
      }
    }
    if (typeof record.projectUrl === "string" && !record.projectUrl.endsWith(".geolibre.json")) {
      problems.push(`examples[${index}].projectUrl is not a .geolibre.json file`);
    }
    if (typeof record.id === "string") {
      if (seen.has(record.id)) problems.push(`examples[${index}].id "${record.id}" is duplicated`);
      seen.add(record.id);
    }
  });
  return problems;
}

/**
 * Parse a raw manifest into its usable entries, silently dropping any that
 * fail validation so one bad row can never break the New Project dialog.
 *
 * @param raw The parsed manifest JSON.
 *
 * @returns The valid starter projects, in manifest order.
 */
export function parseStarterManifest(raw: unknown): StarterProject[] {
  const examples = (raw as { examples?: unknown } | null)?.examples;
  if (!Array.isArray(examples)) return [];
  return examples.filter(
    (entry: unknown): entry is StarterProject =>
      validateStarterManifest({ examples: [entry] }).length === 0,
  );
}

/** The bundled starter projects. */
export const STARTER_PROJECTS: readonly StarterProject[] = parseStarterManifest(manifest);

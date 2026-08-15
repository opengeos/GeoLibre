/** How credentials should be handled when the current project is saved. */
export type CredentialSaveChoice = "strip" | "keep";

/** How local vector data should be handled when the current project is saved. */
export type VectorDataSaveChoice = "embed" | "noembed";

/**
 * How far embedded data may grow past an acknowledged size before the
 * large-embed warning is shown again. A project gains features between saves,
 * so re-prompting on any growth would defeat the point of remembering the
 * choice; doubling is a change of scale the user has not actually agreed to.
 */
export const EMBED_REACKNOWLEDGE_GROWTH_FACTOR = 2;

/** Save choices remembered for one loaded project during the current session. */
export interface ProjectSaveChoices {
  projectGeneration: number;
  credentials?: CredentialSaveChoice;
  /** Credential fingerprints covered by the last explicit Keep choice. */
  keptCredentialFingerprints?: readonly string[];
  vectorData?: VectorDataSaveChoice;
  /** Embedded size, in bytes, the user accepted after seeing the large-data warning. */
  acknowledgedEmbedBytes?: number;
}

/**
 * Returns remembered choices only when they belong to the current project.
 *
 * The store increments `projectGeneration` for every new or loaded project, so
 * this keeps potentially sensitive save decisions from leaking into another
 * project while allowing repeated saves of the same project to stay silent.
 *
 * @param remembered - Choices retained by the project-file hook, if any.
 * @param projectGeneration - Generation of the currently loaded project.
 * @returns Existing choices for this project, or an empty choice set.
 */
export function saveChoicesForProject(
  remembered: ProjectSaveChoices | null,
  projectGeneration: number,
): ProjectSaveChoices {
  return remembered?.projectGeneration === projectGeneration ? remembered : { projectGeneration };
}

/**
 * Remembers one or more save choices for the current project.
 *
 * @param remembered - Choices retained by the project-file hook, if any.
 * @param projectGeneration - Generation of the currently loaded project.
 * @param choices - New choices to retain.
 * @returns Updated choices scoped to the supplied project generation.
 */
export function rememberProjectSaveChoices(
  remembered: ProjectSaveChoices | null,
  projectGeneration: number,
  choices: Partial<Omit<ProjectSaveChoices, "projectGeneration">>,
): ProjectSaveChoices {
  return {
    ...saveChoicesForProject(remembered, projectGeneration),
    ...choices,
  };
}

/**
 * Returns a remembered vector-data choice when no new size warning is needed.
 *
 * An acknowledgement covers the size the user actually saw, plus the ordinary
 * growth of a project being edited. Data that balloons past
 * {@link EMBED_REACKNOWLEDGE_GROWTH_FACTOR} times that size is a materially
 * different write and is confirmed again.
 *
 * @param remembered - Choices scoped to the current project.
 * @param embedBytes - Estimated size of the data this save would embed.
 * @param warningBytes - Threshold at which the large-embed warning applies.
 * @returns The reusable choice, or undefined when the user must confirm a large embed.
 */
export function reusableVectorDataChoice(
  remembered: ProjectSaveChoices,
  embedBytes: number,
  warningBytes: number,
): VectorDataSaveChoice | undefined {
  if (remembered.vectorData !== "embed" || embedBytes < warningBytes) return remembered.vectorData;
  const acknowledged = remembered.acknowledgedEmbedBytes;
  return acknowledged != null && embedBytes <= acknowledged * EMBED_REACKNOWLEDGE_GROWTH_FACTOR
    ? remembered.vectorData
    : undefined;
}

/**
 * Returns a remembered credential choice when it covers the current risk.
 *
 * Stripping remains safe however the project changes. Keeping credentials is
 * reused only while every credential this save would write is one the user
 * explicitly accepted. Fingerprints rather than a count, because swapping one
 * credentialed layer for another leaves the count unchanged while putting a
 * secret the user never saw on disk.
 *
 * @param remembered - Choices scoped to the current project.
 * @param credentialFingerprints - Fingerprints of the credentials this save would keep.
 * @returns The reusable choice, or undefined when Keep must be confirmed again.
 */
export function reusableCredentialChoice(
  remembered: ProjectSaveChoices,
  credentialFingerprints: readonly string[],
): CredentialSaveChoice | undefined {
  if (remembered.credentials !== "keep") return remembered.credentials;
  const acknowledged = remembered.keptCredentialFingerprints;
  if (acknowledged == null) return undefined;
  const covered = new Set(acknowledged);
  return credentialFingerprints.every((fingerprint) => covered.has(fingerprint))
    ? remembered.credentials
    : undefined;
}

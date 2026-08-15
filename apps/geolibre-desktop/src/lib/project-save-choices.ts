/** How credentials should be handled when the current project is saved. */
export type CredentialSaveChoice = "strip" | "keep";

/** How local vector data should be handled when the current project is saved. */
export type VectorDataSaveChoice = "embed" | "noembed";

/** Save choices remembered for one loaded project during the current session. */
export interface ProjectSaveChoices {
  projectGeneration: number;
  credentials?: CredentialSaveChoice;
  vectorData?: VectorDataSaveChoice;
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

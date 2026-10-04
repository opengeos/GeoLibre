import {
  normalizeLayerDescriptiveMetadata,
  parseMetadataKeywords,
  validateLayerDescriptiveMetadata,
  type LayerDescriptiveMetadata,
  type LayerMetadataIssue,
} from "@geolibre/core";

/** One editable link row of the Metadata dialog's form. */
export interface LayerMetadataLinkDraft {
  href: string;
  rel: string;
  title: string;
}

/**
 * The Metadata dialog's form state: every field as the raw text the user is
 * typing, so trimming and keyword splitting happen once, on save, rather than
 * fighting the cursor on every keystroke.
 */
export interface LayerMetadataDraft {
  title: string;
  abstract: string;
  /** Comma-separated keywords. */
  keywords: string;
  license: string;
  attribution: string;
  contactName: string;
  contactEmail: string;
  contactOrganization: string;
  lineage: string;
  temporalStart: string;
  temporalEnd: string;
  links: LayerMetadataLinkDraft[];
}

/**
 * Seed the form from a layer's stored metadata.
 *
 * @param metadata - The layer's descriptive metadata, if any.
 * @returns The form state (blank fields for anything unset).
 */
export function metadataToDraft(
  metadata: LayerDescriptiveMetadata | undefined,
): LayerMetadataDraft {
  return {
    title: metadata?.title ?? "",
    abstract: metadata?.abstract ?? "",
    keywords: (metadata?.keywords ?? []).join(", "),
    license: metadata?.license ?? "",
    attribution: metadata?.attribution ?? "",
    contactName: metadata?.contact?.name ?? "",
    contactEmail: metadata?.contact?.email ?? "",
    contactOrganization: metadata?.contact?.organization ?? "",
    lineage: metadata?.lineage ?? "",
    temporalStart: metadata?.temporalExtent?.start ?? "",
    temporalEnd: metadata?.temporalExtent?.end ?? "",
    links: (metadata?.links ?? []).map((link) => ({
      href: link.href,
      rel: link.rel ?? "",
      title: link.title ?? "",
    })),
  };
}

/**
 * Build the record to store from the form.
 *
 * @param draft - The form state.
 * @returns The normalized metadata, or `undefined` when every field is blank.
 */
export function draftToMetadata(draft: LayerMetadataDraft): LayerDescriptiveMetadata | undefined {
  return normalizeLayerDescriptiveMetadata({
    title: draft.title,
    abstract: draft.abstract,
    keywords: parseMetadataKeywords(draft.keywords),
    license: draft.license,
    attribution: draft.attribution,
    contact: {
      name: draft.contactName,
      email: draft.contactEmail,
      organization: draft.contactOrganization,
    },
    lineage: draft.lineage,
    temporalExtent: { start: draft.temporalStart, end: draft.temporalEnd },
    links: draft.links,
  });
}

/**
 * Validation failures of the form, addressed by the field paths of
 * {@link validateLayerDescriptiveMetadata}. Link indexes refer to the draft's
 * rows (a blank row is skipped, not reported), so an error lands on the row the
 * user typed it in.
 *
 * @param draft - The form state.
 * @returns Every failure found.
 */
export function draftIssues(draft: LayerMetadataDraft): LayerMetadataIssue[] {
  return validateLayerDescriptiveMetadata({
    contact: { email: draft.contactEmail },
    temporalExtent: { start: draft.temporalStart, end: draft.temporalEnd },
    links: draft.links.map((link) => ({ href: link.href })),
  });
}

/**
 * Whether saving the form would change the stored metadata.
 *
 * @param draft - The form state.
 * @param stored - The layer's current metadata.
 * @returns `true` when the normalized form differs from what is stored.
 */
export function draftChangesMetadata(
  draft: LayerMetadataDraft,
  stored: LayerDescriptiveMetadata | undefined,
): boolean {
  return (
    JSON.stringify(draftToMetadata(draft) ?? null) !==
    JSON.stringify(normalizeLayerDescriptiveMetadata(stored) ?? null)
  );
}

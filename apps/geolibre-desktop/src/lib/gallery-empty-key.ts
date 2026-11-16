// The Project Gallery's empty-state message key, kept pure so it is testable
// without rendering the dialog.

/**
 * The i18n key for the Project Gallery's empty state.
 *
 * @param scope - The active gallery scope.
 * @param showingCollections - True while the "Collections" scope lists
 *   collections rather than one collection's projects.
 * @param filtered - True when the filter box holds a query.
 * @returns The `gallery.*` key to translate.
 */
export function galleryEmptyKey(scope: string, showingCollections: boolean, filtered: boolean) {
  if (filtered) return showingCollections ? "gallery.noCollectionMatches" : "gallery.noMatches";
  if (showingCollections) return "gallery.emptyCollections";
  switch (scope) {
    case "collections":
      return "gallery.emptyCollection";
    case "mine":
      return "gallery.emptyMine";
    case "organizations":
      return "gallery.emptyOrganizations";
    case "groups":
      return "gallery.emptyGroups";
    case "featured":
      return "gallery.emptyFeatured";
    default:
      return "gallery.empty";
  }
}

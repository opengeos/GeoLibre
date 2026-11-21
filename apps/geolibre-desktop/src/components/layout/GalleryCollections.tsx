import { Button } from "@geolibre/ui";
import { ArrowLeft, ExternalLink, Library } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { openExternalLink } from "../../lib/open-external";
import { collectionPageUrl, type SharedCollection } from "../../lib/share-gallery";

/**
 * The card grid of the Project Gallery's "Collections" scope. Selecting a card
 * lists that collection's projects.
 */
export function CollectionGrid({
  collections,
  onSelect,
}: {
  collections: SharedCollection[];
  onSelect: (collection: SharedCollection) => void;
}) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {collections.map((collection) => (
        <CollectionCard
          key={collection.id}
          collection={collection}
          onSelect={() => onSelect(collection)}
        />
      ))}
    </div>
  );
}

/**
 * The row above an open collection's projects: back to the collection list,
 * the collection's title and owner, and a link to its page on the share host.
 */
export function CollectionHeader({
  collection,
  onBack,
}: {
  collection: SharedCollection;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  const pageUrl = collectionPageUrl(collection);
  return (
    <div className="flex min-w-0 items-center gap-2">
      <Button type="button" variant="ghost" size="sm" className="shrink-0 gap-1.5" onClick={onBack}>
        <ArrowLeft className="h-3.5 w-3.5 rtl:rotate-180" />
        {t("gallery.backToCollections")}
      </Button>
      <span className="min-w-0 truncate text-sm font-medium" title={collection.title}>
        {collection.title || t("gallery.untitledCollection")}
      </span>
      <span className="shrink-0 text-xs text-muted-foreground">
        {t("gallery.byAuthor", { author: collection.username })}
      </span>
      {pageUrl ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="ms-auto shrink-0"
          aria-label={t("gallery.openCollectionOnWeb")}
          title={t("gallery.openCollectionOnWeb")}
          onClick={() => void openExternalLink(pageUrl)}
        >
          <ExternalLink className="h-4 w-4" />
        </Button>
      ) : null}
    </div>
  );
}

/**
 * One collection card. Collection covers are public, so the thumbnail loads
 * straight from its URL.
 */
function CollectionCard({
  collection,
  onSelect,
}: {
  collection: SharedCollection;
  onSelect: () => void;
}) {
  const { t } = useTranslation();
  const [thumbBroken, setThumbBroken] = useState(false);
  const title = collection.title || t("gallery.untitledCollection");

  return (
    <button
      type="button"
      onClick={onSelect}
      className="group flex flex-col overflow-hidden rounded-lg border bg-card text-start transition-shadow hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      title={t("gallery.openCollection")}
    >
      <span className="relative block aspect-video w-full overflow-hidden bg-muted">
        {collection.thumbnailUrl && !thumbBroken ? (
          <img
            src={collection.thumbnailUrl}
            alt=""
            loading="lazy"
            className="h-full w-full object-cover transition-transform group-hover:scale-105"
            onError={() => setThumbBroken(true)}
          />
        ) : (
          <span className="flex h-full w-full flex-col items-center justify-center gap-1 text-muted-foreground">
            <Library className="h-6 w-6" />
            <span className="text-xs">{t("gallery.noThumbnail")}</span>
          </span>
        )}
      </span>
      <span className="flex flex-1 flex-col gap-1 p-3">
        <span className="truncate text-sm font-medium" title={title}>
          {title}
        </span>
        {collection.description ? (
          <span className="line-clamp-2 text-xs text-muted-foreground">
            {collection.description}
          </span>
        ) : null}
        <span className="mt-auto flex items-center gap-2 pt-1 text-xs text-muted-foreground">
          <span className="truncate">{t("gallery.byAuthor", { author: collection.username })}</span>
          <span className="ms-auto shrink-0">
            {t("gallery.collectionProjects", { count: collection.projectCount })}
          </span>
        </span>
      </span>
    </button>
  );
}

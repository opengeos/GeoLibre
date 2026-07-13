/**
 * Persistence for the Browser panel's Favorites — nodes the user has pinned to a
 * quick-access section at the top of the tree (services, database connections,
 * folders, files). A localStorage-backed, most-recently-added-first list, global
 * (not per-project), mirroring `browser-folders.ts`. UI-free so it unit-tests in
 * isolation.
 *
 * A favorite stores enough to rebuild and activate its node without looking up
 * the live original (which may have been deleted), keyed by the node's stable
 * id so add/remove/lookup are by id.
 */

import type { ServiceLibraryKind } from "../components/layout/add-data/service-library";

export const FAVORITES_STORAGE_KEY = "geolibre.browser.favorites";
export const MAX_FAVORITES = 100;

/** Fired on `window` after the favorites list is written (same-tab refresh). */
export const FAVORITES_CHANGED_EVENT = "geolibre:favorites-changed";

/** The kinds of node that can be favorited. */
export type FavoriteKind = "service" | "connection" | "folder" | "file";

/** A pinned Browser-tree node, with enough to rebuild + activate it. */
export interface BrowserFavorite {
  /** The favorited node's stable id (e.g. `service:x`, `connection:y`, `folder:/p`). */
  id: string;
  kind: FavoriteKind;
  label: string;
  /** Service identity (kind `service`). */
  serviceId?: string;
  serviceKind?: ServiceLibraryKind;
  /** Connection string (kind `connection`). */
  connectionString?: string;
  /** Absolute path (kind `folder`/`file`). */
  path?: string;
}

/** Whether a node kind can be favorited. */
export function isFavoritableKind(kind: string): kind is FavoriteKind {
  return (
    kind === "service" ||
    kind === "connection" ||
    kind === "folder" ||
    kind === "file"
  );
}

function isValidFavorite(value: unknown): value is BrowserFavorite {
  if (!value || typeof value !== "object") return false;
  const fav = value as Record<string, unknown>;
  return (
    typeof fav.id === "string" &&
    typeof fav.label === "string" &&
    typeof fav.kind === "string" &&
    isFavoritableKind(fav.kind)
  );
}

/** Dedupe favorites by id, keeping the first occurrence (most-recent). */
function uniqueById(favorites: BrowserFavorite[]): BrowserFavorite[] {
  const seen = new Set<string>();
  const out: BrowserFavorite[] = [];
  for (const fav of favorites) {
    if (seen.has(fav.id)) continue;
    seen.add(fav.id);
    out.push(fav);
  }
  return out;
}

export function readBrowserFavorites(): BrowserFavorite[] {
  if (typeof window === "undefined") return [];
  try {
    const value = window.localStorage.getItem(FAVORITES_STORAGE_KEY);
    if (!value) return [];
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? uniqueById(parsed.filter(isValidFavorite))
      : [];
  } catch {
    return [];
  }
}

function writeBrowserFavorites(favorites: BrowserFavorite[]): BrowserFavorite[] {
  const next = uniqueById(favorites).slice(0, MAX_FAVORITES);
  if (typeof window === "undefined") return next;
  try {
    window.localStorage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify(next));
    window.dispatchEvent(new Event(FAVORITES_CHANGED_EVENT));
  } catch {
    // Best-effort persistence (mirrors readBrowserFavorites' guard).
  }
  return next;
}

/** Whether a node id is currently favorited. */
export function isFavorite(id: string): boolean {
  return readBrowserFavorites().some((fav) => fav.id === id);
}

/** Add a favorite to the front of the list (deduped by id, capped). */
export function addFavorite(favorite: BrowserFavorite): BrowserFavorite[] {
  if (!favorite.id) return readBrowserFavorites();
  return writeBrowserFavorites([
    favorite,
    ...readBrowserFavorites().filter((fav) => fav.id !== favorite.id),
  ]);
}

/** Remove a favorite by node id. */
export function removeFavorite(id: string): BrowserFavorite[] {
  return writeBrowserFavorites(
    readBrowserFavorites().filter((fav) => fav.id !== id),
  );
}

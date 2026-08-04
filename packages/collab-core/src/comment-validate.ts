// Pure validators for comment-mutation payloads. These mirror the
// `ProjectComment` / `CommentReply` shapes from `@geolibre/core` but operate on
// untrusted `unknown` input, returning a sanitized object or `null`.

/** Body length cap — matches the chat limit so comments can't store unbounded text. */
export const MAX_COMMENT_BODY_LENGTH = 2000;

/** Author name length cap — generous for display names but bounded. */
export const MAX_COMMENT_AUTHOR_LENGTH = 120;

/** Identifier length cap for comment/reply ids, layerId, and string featureId. */
export const MAX_ID_LENGTH = 200;

/** Minimum gap between a socket's comment-mutation frames (ms). */
export const MIN_COMMENT_INTERVAL_MS = 250;

/** Maximum number of replies stored per comment. */
export const MAX_REPLIES_PER_COMMENT = 100;

/** Maximum number of comments stored per session. Bounds the snapshot growth a
 *  sustained stream of "add" mutations can cause, the way `CHAT_HISTORY_LIMIT`
 *  bounds the chat log. */
export const MAX_COMMENTS_PER_SESSION = 500;

/** True when `value` is a non-empty string within {@link MAX_ID_LENGTH}. */
export function isBoundedId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_ID_LENGTH;
}

/** Carry the stored `comments` list into an incoming full-project snapshot that
 *  doesn't supply one of its own.
 *
 *  The relay writes comments straight into the stored snapshot (see
 *  `handleCommentMutation`), but `serializeProject` omits the key entirely when
 *  a peer holds none — so a peer that hasn't merged those broadcasts yet (a race
 *  with its debounced snapshot, or a client that joined before them) would
 *  otherwise replace the persisted comments with nothing. A project that carries
 *  its own `comments` still wins, so a delete is never resurrected.
 *
 *  `stored` is the already-parsed stored snapshot, or `null` when absent/corrupt.
 */
export function preserveStoredComments(project: unknown, stored: unknown): unknown {
  if (!project || typeof project !== "object" || Array.isArray(project)) return project;
  if ("comments" in project) return project;
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return project;
  const comments = (stored as Record<string, unknown>).comments;
  if (!Array.isArray(comments) || comments.length === 0) return project;
  return { ...(project as Record<string, unknown>), comments };
}

const HEX_COLOR_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

function finite(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

// -- anchor -------------------------------------------------------------------

interface PointAnchor {
  type: "point";
  lngLat: [number, number];
}

interface FeatureAnchor {
  type: "feature";
  layerId: string;
  featureId: string | number;
  lngLat?: [number, number];
}

export type ValidatedAnchor = PointAnchor | FeatureAnchor;

export function validateAnchor(raw: unknown): ValidatedAnchor | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;

  if (o.type === "point") {
    if (!Array.isArray(o.lngLat) || o.lngLat.length !== 2) return null;
    const [lng, lat] = o.lngLat;
    if (!finite(lng) || !finite(lat)) return null;
    return { type: "point", lngLat: [lng, lat] };
  }

  if (o.type === "feature") {
    if (!isBoundedId(o.layerId)) return null;
    if (typeof o.featureId !== "string" && typeof o.featureId !== "number") return null;
    if (typeof o.featureId === "string" && !isBoundedId(o.featureId)) return null;
    if (typeof o.featureId === "number" && !finite(o.featureId)) return null;
    const anchor: FeatureAnchor = {
      type: "feature",
      layerId: o.layerId,
      featureId: o.featureId,
    };
    if (Array.isArray(o.lngLat) && o.lngLat.length === 2) {
      const [lng, lat] = o.lngLat;
      if (finite(lng) && finite(lat)) {
        anchor.lngLat = [lng, lat];
      }
    }
    return anchor;
  }

  return null;
}

// -- author -------------------------------------------------------------------

export interface ValidatedAuthor {
  name: string;
  color: string;
}

export function validateAuthor(raw: unknown): ValidatedAuthor | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.name !== "string") return null;
  const name = o.name.trim().slice(0, MAX_COMMENT_AUTHOR_LENGTH);
  if (!name) return null;
  if (typeof o.color !== "string" || !HEX_COLOR_RE.test(o.color)) return null;
  return { name, color: o.color };
}

// -- comment ------------------------------------------------------------------

export interface ValidatedComment {
  id: string;
  anchor: ValidatedAnchor;
  author: ValidatedAuthor;
  body: string;
  createdAt: string;
  resolved: boolean;
  replies: ValidatedReply[];
}

export function validateComment(raw: unknown): ValidatedComment | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;

  if (!isBoundedId(o.id)) return null;

  const anchor = validateAnchor(o.anchor);
  if (!anchor) return null;

  const author = validateAuthor(o.author);
  if (!author) return null;

  if (typeof o.body !== "string") return null;
  const body = o.body.slice(0, MAX_COMMENT_BODY_LENGTH);
  if (!body.trim()) return null;

  const createdAt =
    typeof o.createdAt === "string" && !Number.isNaN(Date.parse(o.createdAt))
      ? o.createdAt
      : new Date().toISOString();

  const replies: ValidatedReply[] = [];
  if (Array.isArray(o.replies)) {
    for (const r of o.replies.slice(0, MAX_REPLIES_PER_COMMENT)) {
      const validated = validateReply(r);
      if (validated) replies.push(validated);
    }
  }

  return {
    id: o.id,
    anchor,
    author,
    body,
    createdAt,
    resolved: Boolean(o.resolved),
    replies,
  };
}

// -- reply --------------------------------------------------------------------

export interface ValidatedReply {
  id: string;
  author: ValidatedAuthor;
  body: string;
  createdAt: string;
}

export function validateReply(raw: unknown): ValidatedReply | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;

  if (!isBoundedId(o.id)) return null;

  const author = validateAuthor(o.author);
  if (!author) return null;

  if (typeof o.body !== "string") return null;
  const body = o.body.slice(0, MAX_COMMENT_BODY_LENGTH);
  if (!body.trim()) return null;

  const createdAt =
    typeof o.createdAt === "string" && !Number.isNaN(Date.parse(o.createdAt))
      ? o.createdAt
      : new Date().toISOString();

  return { id: o.id, author, body, createdAt };
}

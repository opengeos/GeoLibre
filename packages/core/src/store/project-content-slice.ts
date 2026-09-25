/**
 * Project content that sits beside the layers: review comments (issue #1518),
 * Dashboard widgets (issue #401) and the story map. All of it is saved with the
 * project; `comments` and `storymap` are also tracked by undo history.
 */
import {
  DEFAULT_DASHBOARD_COLUMNS,
  DEFAULT_STORY_MAP,
  MAX_DASHBOARD_COLUMNS,
  MIN_DASHBOARD_COLUMNS,
  type CommentReply,
  type DashboardWidget,
  type ProjectComment,
  type StoryChapter,
  type StoryMap,
} from "../types";
import type { SliceCreator } from "./types";

export interface ProjectContentSlice {
  storymap: StoryMap | null;
  /** Saved Dashboard panel chart widgets (issue #401). */
  widgets: DashboardWidget[];
  /** Number of columns in the Dashboard widget grid. */
  dashboardColumns: number;
  /** Anchored review comments on map points or features (issue #1518). */
  comments: ProjectComment[];

  /** Append a new dashboard widget. */
  addWidget: (widget: DashboardWidget) => void;
  /** Patch an existing dashboard widget by id (no-op if absent). Merges, so an
   * omitted key keeps its current value; use replaceWidget to clear one. */
  updateWidget: (id: string, patch: Partial<Omit<DashboardWidget, "id">>) => void;
  /** Swap an existing dashboard widget for a complete new record, keeping its
   * id and position (no-op if absent). Unlike updateWidget this does not merge,
   * so fields the caller omits are cleared — what the widget editor needs to
   * persist an emptied title, color, prefix, or suffix. */
  replaceWidget: (id: string, widget: Omit<DashboardWidget, "id">) => void;
  /** Remove a dashboard widget by id. */
  removeWidget: (id: string) => void;
  /** Move a widget to a new index, clamped into range, preserving the rest. */
  moveWidget: (id: string, toIndex: number) => void;
  /** Set the Dashboard widget-grid column count (clamped into range). */
  setDashboardColumns: (columns: number) => void;

  setStorymap: (storymap: StoryMap | null) => void;
  updateStorymapSettings: (patch: Partial<Omit<StoryMap, "chapters">>) => void;
  addStoryChapter: (chapter: StoryChapter, atIndex?: number) => void;
  updateStoryChapter: (id: string, patch: Partial<StoryChapter>) => void;
  removeStoryChapter: (id: string) => void;
  moveStoryChapter: (id: string, targetIndex: number) => void;
  addComment: (comment: ProjectComment) => void;
  replyToComment: (commentId: string, reply: CommentReply) => void;
  toggleResolveComment: (commentId: string, resolved?: boolean) => void;
  deleteComment: (commentId: string) => void;
  setComments: (comments: ProjectComment[]) => void;
}

export const createProjectContentSlice: SliceCreator<ProjectContentSlice> = (set) => ({
  storymap: null,
  widgets: [],
  dashboardColumns: DEFAULT_DASHBOARD_COLUMNS,
  comments: [],

  addComment: (comment) =>
    set((s) => {
      // Ignore a duplicate id: the WebSocket relay echoes our own
      // comment-mutation back to the sender, and a reconnect can replay
      // recent history, so de-dupe defensively (mirrors addCollaborationChat).
      if (s.comments.some((c) => c.id === comment.id)) return s;
      return { comments: [...s.comments, comment], isDirty: true };
    }),
  replyToComment: (commentId, reply) =>
    set((s) => {
      let appended = false;
      const nextComments = s.comments.map((c) => {
        if (c.id !== commentId) return c;
        if (c.replies.some((r) => r.id === reply.id)) return c;
        appended = true;
        return { ...c, replies: [...c.replies, reply] };
      });
      if (!appended) return s;
      return { comments: nextComments, isDirty: true };
    }),
  toggleResolveComment: (commentId, resolved) =>
    set((s) => ({
      comments: s.comments.map((c) =>
        c.id === commentId
          ? { ...c, resolved: resolved !== undefined ? resolved : !c.resolved }
          : c,
      ),
      isDirty: true,
    })),
  deleteComment: (commentId) =>
    set((s) => ({
      comments: s.comments.filter((c) => c.id !== commentId),
      isDirty: true,
    })),
  setComments: (comments) => set({ comments, isDirty: true }),

  addWidget: (widget) =>
    set((s) => {
      // Ignore a duplicate id so updateWidget/removeWidget stay unambiguous
      // and a later entry isn't silently dropped when normalized on save.
      if (s.widgets.some((w) => w.id === widget.id)) return s;
      return { widgets: [...s.widgets, widget], isDirty: true };
    }),
  updateWidget: (id, patch) =>
    set((s) => {
      const exists = s.widgets.some((w) => w.id === id);
      if (!exists) return s;
      return {
        widgets: s.widgets.map((w) => (w.id === id ? { ...w, ...patch, id: w.id } : w)),
        isDirty: true,
      };
    }),
  replaceWidget: (id, widget) =>
    set((s) => {
      if (!s.widgets.some((w) => w.id === id)) return s;
      return {
        widgets: s.widgets.map((w) => (w.id === id ? { ...widget, id } : w)),
        isDirty: true,
      };
    }),
  removeWidget: (id) =>
    set((s) => ({
      widgets: s.widgets.filter((w) => w.id !== id),
      isDirty: true,
    })),
  moveWidget: (id, toIndex) =>
    set((s) => {
      const from = s.widgets.findIndex((w) => w.id === id);
      if (from < 0) return s;
      const target = Math.max(0, Math.min(s.widgets.length - 1, toIndex));
      if (target === from) return s;
      const widgets = [...s.widgets];
      const [moved] = widgets.splice(from, 1);
      widgets.splice(target, 0, moved);
      return { widgets, isDirty: true };
    }),
  setDashboardColumns: (columns) =>
    set((s) => {
      // Guard non-finite input so the clamp can't yield NaN columns.
      if (!Number.isFinite(columns)) return s;
      return {
        dashboardColumns: Math.max(
          MIN_DASHBOARD_COLUMNS,
          Math.min(MAX_DASHBOARD_COLUMNS, Math.trunc(columns)),
        ),
        isDirty: true,
      };
    }),

  setStorymap: (storymap) => set({ storymap, isDirty: true }),
  updateStorymapSettings: (patch) =>
    set((s) => ({
      storymap: { ...(s.storymap ?? DEFAULT_STORY_MAP), ...patch },
      isDirty: true,
    })),
  addStoryChapter: (chapter, atIndex) =>
    set((s) => {
      const base = s.storymap ?? DEFAULT_STORY_MAP;
      const chapters = [...base.chapters];
      const index =
        atIndex === undefined ? chapters.length : Math.min(Math.max(atIndex, 0), chapters.length);
      chapters.splice(index, 0, chapter);
      return { storymap: { ...base, chapters }, isDirty: true };
    }),
  updateStoryChapter: (id, patch) =>
    set((s) => {
      if (!s.storymap) return s;
      return {
        storymap: {
          ...s.storymap,
          chapters: s.storymap.chapters.map((chapter) =>
            chapter.id === id ? { ...chapter, ...patch } : chapter,
          ),
        },
        isDirty: true,
      };
    }),
  removeStoryChapter: (id) =>
    set((s) => {
      if (!s.storymap) return s;
      return {
        storymap: {
          ...s.storymap,
          chapters: s.storymap.chapters.filter((chapter) => chapter.id !== id),
        },
        isDirty: true,
      };
    }),
  moveStoryChapter: (id, targetIndex) =>
    set((s) => {
      if (!s.storymap) return s;
      const current = s.storymap.chapters.findIndex((chapter) => chapter.id === id);
      if (current < 0) return s;
      const chapters = [...s.storymap.chapters];
      const [chapter] = chapters.splice(current, 1);
      if (!chapter) return s;
      const next = Math.min(Math.max(targetIndex, 0), chapters.length);
      chapters.splice(next, 0, chapter);
      if (chapters.every((item, i) => item.id === s.storymap?.chapters[i]?.id)) {
        return s;
      }
      return { storymap: { ...s.storymap, chapters }, isDirty: true };
    }),
});

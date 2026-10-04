/**
 * The app's one notification channel (issue #2858). Handled failures and
 * confirmations go through `notify.success/info/warning/error`, which queue a
 * toast in {@link useNotificationStore}; `NotificationRegion` renders the queue
 * once at the app root.
 *
 * Error notifications are also recorded in the Diagnostics log, so the panel
 * stays the full history after the toast is dismissed, and the toast's
 * "Report issue" action can attach that record to a pre-filled GitHub issue.
 */
import { create } from "zustand";
import { appendDiagnostic, formatUnknown, type DiagnosticRecord } from "./diagnostics";

export type NotificationKind = "success" | "info" | "warning" | "error";

/** A single button rendered on a toast next to Dismiss. */
export interface NotificationAction {
  /** Visible button label (already translated). */
  label: string;
  /** Runs on click; the toast is dismissed afterwards. */
  onClick: () => void;
}

export interface NotifyOptions {
  /** Secondary text under the message (already translated). */
  description?: string;
  /** An optional button, e.g. "Retry" or "Open settings". */
  action?: NotificationAction;
  /**
   * Auto-dismiss delay. Defaults per kind (see {@link DEFAULT_DURATIONS_MS});
   * `null` keeps the toast until it is dismissed. Errors persist by default.
   */
  durationMs?: number | null;
  /**
   * Toasts that share a key collapse into one with a repeat counter instead of
   * stacking. Defaults to the kind, message, and description.
   */
  dedupeKey?: string;
  /**
   * The underlying error, recorded in Diagnostics with an error notification
   * (its stack never appears in the toast itself).
   */
  error?: unknown;
  /**
   * An existing Diagnostics record that already describes this failure (e.g.
   * the map engine's own entry). An error notification then links to it
   * instead of writing a second record.
   */
  diagnostic?: DiagnosticRecord;
}

export interface AppNotification {
  id: string;
  kind: NotificationKind;
  message: string;
  description?: string;
  action?: NotificationAction;
  /** Resolved auto-dismiss delay; `null` persists until dismissed. */
  durationMs: number | null;
  dedupeKey: string;
  /** How many times this notification fired while visible (1 = once). */
  count: number;
  /** Bumped on every repeat so the region can re-announce and restart timers. */
  revision: number;
  /** The Diagnostics record an error notification wrote, for "Report issue". */
  diagnostic?: DiagnosticRecord;
}

/** Default auto-dismiss delays; errors persist until the user dismisses them. */
export const DEFAULT_DURATIONS_MS: Readonly<Record<NotificationKind, number | null>> = {
  success: 4000,
  info: 5000,
  warning: 8000,
  error: null,
};

/** The most toasts on screen at once; older non-errors are evicted first. */
export const MAX_VISIBLE_NOTIFICATIONS = 4;

interface NotificationState {
  notifications: AppNotification[];
}

/** The live notification queue, oldest first. Read it through the hook. */
export const useNotificationStore = create<NotificationState>(() => ({ notifications: [] }));

const timers = new Map<string, ReturnType<typeof setTimeout>>();
// While the pointer or keyboard focus is inside the region, timers stand still
// so a toast never vanishes mid-read (WCAG 2.2.2 Pause, Stop, Hide).
let paused = false;
let sequence = 0;

function clearTimer(id: string): void {
  const handle = timers.get(id);
  if (handle !== undefined) {
    clearTimeout(handle);
    timers.delete(id);
  }
}

function scheduleTimer(notification: AppNotification): void {
  clearTimer(notification.id);
  if (paused || notification.durationMs === null) return;
  timers.set(
    notification.id,
    setTimeout(() => dismissNotification(notification.id), notification.durationMs),
  );
}

/**
 * Drops the oldest notifications past {@link MAX_VISIBLE_NOTIFICATIONS},
 * preferring to drop non-errors so a burst of infos cannot push an unread error
 * off screen.
 */
function capVisible(list: AppNotification[]): AppNotification[] {
  const next = [...list];
  while (next.length > MAX_VISIBLE_NOTIFICATIONS) {
    const index = next.findIndex((item) => item.kind !== "error");
    const evicted = next.splice(index === -1 ? 0 : index, 1)[0];
    clearTimer(evicted.id);
  }
  return next;
}

function push(kind: NotificationKind, message: string, options: NotifyOptions = {}): string {
  const dedupeKey =
    options.dedupeKey ?? `${kind}\u0000${message}\u0000${options.description ?? ""}`;
  const durationMs =
    options.durationMs === undefined ? DEFAULT_DURATIONS_MS[kind] : options.durationMs;
  // Every error lands in Diagnostics, repeats included: the log is the full
  // history, the toast only the latest occurrence.
  let diagnostic: DiagnosticRecord | undefined;
  if (kind === "error") {
    diagnostic =
      options.diagnostic ??
      appendDiagnostic({
        category: "app",
        level: "error",
        message,
        detail:
          [
            options.description,
            options.error === undefined ? undefined : formatUnknown(options.error),
          ]
            .filter(Boolean)
            .join("\n\n") || undefined,
      }) ??
      undefined;
  }

  const { notifications } = useNotificationStore.getState();
  const existing = notifications.find((item) => item.dedupeKey === dedupeKey);
  let updated: AppNotification;
  if (existing) {
    updated = {
      ...existing,
      // A repeat can escalate (warning -> error); render it as the latest kind.
      kind,
      message,
      description: options.description,
      action: options.action ?? existing.action,
      durationMs,
      count: existing.count + 1,
      revision: existing.revision + 1,
      // Only an error carries a report; a de-escalated repeat drops it.
      diagnostic: kind === "error" ? (diagnostic ?? existing.diagnostic) : undefined,
    };
    // Move the repeat to the newest slot so it is the one the eye lands on.
    useNotificationStore.setState({
      notifications: [...notifications.filter((item) => item.id !== existing.id), updated],
    });
  } else {
    updated = {
      id: `notification-${Date.now()}-${sequence++}`,
      kind,
      message,
      description: options.description,
      action: options.action,
      durationMs,
      dedupeKey,
      count: 1,
      revision: 0,
      diagnostic,
    };
    useNotificationStore.setState({ notifications: capVisible([...notifications, updated]) });
  }
  scheduleTimer(updated);
  return updated.id;
}

/**
 * Removes a notification (no-op when it is already gone).
 *
 * @param id - The id `notify.*` returned.
 */
export function dismissNotification(id: string): void {
  clearTimer(id);
  const { notifications } = useNotificationStore.getState();
  if (!notifications.some((item) => item.id === id)) return;
  useNotificationStore.setState({ notifications: notifications.filter((item) => item.id !== id) });
}

/** Removes every notification and cancels their timers. */
export function clearNotifications(): void {
  for (const id of [...timers.keys()]) clearTimer(id);
  useNotificationStore.setState({ notifications: [] });
}

/**
 * Freezes or resumes every auto-dismiss timer. Resuming restarts each toast's
 * full duration, so a toast the user just looked away from is not gone at once.
 *
 * @param next - `true` while the user is reading the region (hover or focus).
 */
export function setNotificationsPaused(next: boolean): void {
  if (paused === next) return;
  paused = next;
  for (const notification of useNotificationStore.getState().notifications) {
    if (paused) clearTimer(notification.id);
    else scheduleTimer(notification);
  }
}

/**
 * Shows a toast. Messages must already be translated (`t()` at the call site).
 * Each method returns the notification id, for {@link dismissNotification}.
 */
export const notify = {
  success: (message: string, options?: NotifyOptions) => push("success", message, options),
  info: (message: string, options?: NotifyOptions) => push("info", message, options),
  warning: (message: string, options?: NotifyOptions) => push("warning", message, options),
  error: (message: string, options?: NotifyOptions) => push("error", message, options),
};

import { cn } from "@geolibre/ui";
import { Bug, CircleAlert, CircleCheck, Info, TriangleAlert, X } from "lucide-react";
import { useEffect, useRef, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  dismissNotification,
  setNotificationsPaused,
  useNotificationStore,
  type AppNotification,
  type NotificationKind,
} from "../../lib/notify";
import { reportIssue } from "../../lib/report-issue";

const KIND_ICON: Record<NotificationKind, typeof Info> = {
  success: CircleCheck,
  info: Info,
  warning: TriangleAlert,
  error: CircleAlert,
};

const KIND_ACCENT: Record<NotificationKind, string> = {
  success: "border-s-emerald-500",
  info: "border-s-primary",
  warning: "border-s-amber-500",
  error: "border-s-destructive",
};

const KIND_ICON_CLASS: Record<NotificationKind, string> = {
  success: "text-emerald-600 dark:text-emerald-400",
  info: "text-primary",
  warning: "text-amber-600 dark:text-amber-400",
  error: "text-destructive dark:text-red-400",
};

function NotificationToast({ notification }: { notification: AppNotification }) {
  const { t } = useTranslation();
  const Icon = KIND_ICON[notification.kind];
  const close = () => dismissNotification(notification.id);
  return (
    <div
      data-testid="notification"
      data-kind={notification.kind}
      data-notification-id={notification.id}
      className={cn(
        "pointer-events-auto flex w-full items-start gap-3 rounded-md border border-s-4 bg-background px-3 py-2.5 text-sm text-foreground shadow-lg",
        "motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-2",
        KIND_ACCENT[notification.kind],
      )}
    >
      <Icon
        aria-hidden="true"
        className={cn("mt-0.5 h-4 w-4 shrink-0", KIND_ICON_CLASS[notification.kind])}
      />
      <div className="min-w-0 flex-1">
        <p className="break-words font-medium">
          {notification.message}
          {notification.count > 1 ? (
            <span className="ms-1.5 rounded bg-muted px-1 py-0.5 text-xs font-normal text-muted-foreground">
              {t("notifications.repeated", { count: notification.count })}
            </span>
          ) : null}
        </p>
        {notification.description ? (
          <p className="mt-0.5 break-words text-xs text-muted-foreground">
            {notification.description}
          </p>
        ) : null}
        {notification.action || notification.diagnostic ? (
          <div className="mt-2 flex flex-wrap gap-2">
            {notification.action ? (
              <button
                type="button"
                className="rounded border px-2 py-0.5 text-xs font-medium hover:bg-accent hover:text-accent-foreground"
                onClick={() => {
                  notification.action?.onClick();
                  close();
                }}
              >
                {notification.action.label}
              </button>
            ) : null}
            {notification.diagnostic ? (
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded border px-2 py-0.5 text-xs hover:bg-accent hover:text-accent-foreground"
                onClick={() => reportIssue(notification.diagnostic ?? null)}
              >
                <Bug aria-hidden="true" className="h-3 w-3" />
                {t("notifications.reportIssue")}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
      <button
        type="button"
        aria-label={t("notifications.dismiss")}
        title={t("notifications.dismiss")}
        className="-me-1 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
        onClick={close}
      >
        <X aria-hidden="true" className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

/**
 * The app's toast region, mounted once at the root. Errors render in an
 * assertive live region and stay until dismissed; everything else is polite and
 * auto-dismisses. Both regions are always in the DOM, because a live region
 * inserted together with its first message is often not announced.
 */
export function NotificationRegion() {
  const { t } = useTranslation();
  const notifications = useNotificationStore((state) => state.notifications);
  const regionRef = useRef<HTMLElement>(null);
  const hoveredRef = useRef(false);
  const errors = notifications.filter((item) => item.kind === "error");
  const others = notifications.filter((item) => item.kind !== "error");

  // Timers pause while the pointer is over the region or focus is inside it.
  // Re-derived after every change too: a dismissed toast that held focus is
  // removed without a reliable blur, which must not leave timers frozen.
  const syncPaused = () => {
    const region = regionRef.current;
    const focusInside =
      region !== null && typeof document !== "undefined" && region.contains(document.activeElement);
    setNotificationsPaused(hoveredRef.current || focusInside);
  };
  useEffect(() => {
    if (notifications.length === 0) hoveredRef.current = false;
    syncPaused();
  });
  useEffect(() => () => setNotificationsPaused(false), []);

  return (
    <section
      ref={regionRef}
      aria-label={t("notifications.regionLabel")}
      data-testid="notification-region"
      className="pointer-events-none fixed bottom-10 end-4 z-[60] flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2"
      onMouseEnter={() => {
        hoveredRef.current = true;
        syncPaused();
      }}
      onMouseLeave={() => {
        hoveredRef.current = false;
        syncPaused();
      }}
      onFocus={syncPaused}
      // Escape dismisses the toast that holds keyboard focus.
      onKeyDown={(event: KeyboardEvent<HTMLElement>) => {
        if (event.key !== "Escape" || !(event.target instanceof Element)) return;
        const id = event.target
          .closest<HTMLElement>("[data-notification-id]")
          ?.getAttribute("data-notification-id");
        if (!id) return;
        event.stopPropagation();
        dismissNotification(id);
      }}
      onBlur={(event) => {
        const next = event.relatedTarget as Node | null;
        setNotificationsPaused(hoveredRef.current || event.currentTarget.contains(next));
      }}
    >
      <div role="alert" aria-live="assertive" className="flex flex-col gap-2 empty:hidden">
        {errors.map((notification) => (
          // Keyed on the revision so a repeat remounts and is announced again.
          <NotificationToast
            key={`${notification.id}:${notification.revision}`}
            notification={notification}
          />
        ))}
      </div>
      <div role="status" aria-live="polite" className="flex flex-col gap-2 empty:hidden">
        {others.map((notification) => (
          <NotificationToast
            key={`${notification.id}:${notification.revision}`}
            notification={notification}
          />
        ))}
      </div>
    </section>
  );
}

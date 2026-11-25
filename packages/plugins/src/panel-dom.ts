/**
 * DOM and file-saving helpers for plugin panels, which are built by hand: this
 * package is framework-agnostic and cannot render with React.
 */
import type { GeoLibreAppAPI, GeoLibreFileDialogOptions } from "./types";

/** Creates an element, optionally with its text content set. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * Toggles a button's disabled state *and* its appearance.
 *
 * Panels style their buttons with inline `background`/`color`/`cursor:pointer`,
 * which overrides the browser's own disabled rendering, so setting `.disabled`
 * alone leaves the control looking exactly like an enabled one (GeoLibre#1970: a
 * STAC item whose only asset is GeoParquet has Add disabled, and it was
 * indistinguishable from the Zoom and Download buttons beside it). Dimming it
 * and dropping the pointer cursor makes an unusable control read as unusable
 * before it is clicked.
 *
 * Call this *after* any `style.cssText` assignment on the same element: cssText
 * replaces the whole inline declaration and would wipe these two properties.
 *
 * @param button Button to update.
 * @param disabled Whether the button should be disabled.
 */
export function setDisabled(button: HTMLButtonElement, disabled: boolean): void {
  button.disabled = disabled;
  button.style.opacity = disabled ? "0.5" : "1";
  button.style.cursor = disabled ? "not-allowed" : "pointer";
}

/** Class that gives a plugin panel's native `<select>` the app's own chevron (see `index.css`). */
export const SELECT_CHEVRON_CLASS = "geolibre-native-select";

/**
 * Swaps a native `<select>`'s disclosure arrow for the chevron the app's React
 * `Select` draws, and returns the select.
 *
 * The browser's own arrow has different insets and looks in Chromium and in
 * WebKit (the desktop webview on macOS), so plain-DOM panel selects never
 * matched the rest of the app. The rule behind the class sets `appearance`,
 * the chevron and the end padding with `!important`, so it holds even when
 * the panel styles the select inline (`style.cssText`, `background: …`). It
 * is a class rather than inline styles so the chevron can follow dark mode
 * and right-to-left layouts. Not for `multiple` or `size` list boxes, which
 * have no arrow.
 *
 * @param select Select to update.
 */
export function withSelectChevron<T extends HTMLSelectElement>(select: T): T {
  select.classList.add(SELECT_CHEVRON_CLASS);
  return select;
}

/**
 * Trigger a browser download for a `Blob` or `Uint8Array` via a temporary
 * object URL, revoking it asynchronously after the click dispatches.
 */
export function downloadBlobFallback(
  filename: string,
  data: Blob | Uint8Array,
  mimeType = "application/octet-stream",
): void {
  const blob = data instanceof Blob ? data : new Blob([data as BlobPart], { type: mimeType });
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

/**
 * Save binary data via `app.saveBinaryFile` when the host provides it, falling
 * back to a plain browser anchor download otherwise. Returns `false` when the
 * user cancels the host's save dialog.
 */
export async function saveBinaryFileWithHost(
  app: Pick<GeoLibreAppAPI, "saveBinaryFile"> | null | undefined,
  filename: string,
  data: Blob | Uint8Array,
  options?: GeoLibreFileDialogOptions,
): Promise<boolean> {
  if (app?.saveBinaryFile) {
    return (await app.saveBinaryFile(filename, data, options)) !== null;
  }
  downloadBlobFallback(filename, data, options?.mimeType);
  return true;
}

export interface PluginButtonOptions {
  variant?: "primary" | "secondary" | "ghost";
  title?: string;
  disabled?: boolean;
  onClick?: (event: MouseEvent) => void;
}

/** Create a consistently themed button for plain-DOM plugin panels and modals. */
export function createButton(label: string, options: PluginButtonOptions = {}): HTMLButtonElement {
  const button = el("button", label);
  button.type = "button";
  const variant = options.variant ?? "secondary";
  const palette =
    variant === "primary"
      ? "background:hsl(var(--primary));color:hsl(var(--primary-foreground));border:1px solid transparent;"
      : variant === "ghost"
        ? "background:transparent;color:hsl(var(--foreground));border:1px solid transparent;"
        : "background:hsl(var(--secondary));color:hsl(var(--secondary-foreground));border:1px solid hsl(var(--border));";
  button.style.cssText = `${palette}border-radius:6px;padding:6px 10px;font-size:12px;font-weight:500;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:6px;`;
  if (options.title) button.title = options.title;
  if (options.disabled) setDisabled(button, true);
  if (options.onClick) button.addEventListener("click", options.onClick);
  return button;
}

export interface SelectFieldOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectFieldConfig {
  label: string;
  options: readonly SelectFieldOption[];
  value?: string;
  onChange?: (value: string) => void;
}

/** Create a labeled `<select>` picker styled with the app's native chevron. */
export function createSelectField(config: SelectFieldConfig): {
  wrapper: HTMLLabelElement;
  select: HTMLSelectElement;
} {
  const wrapper = el("label");
  wrapper.style.cssText = "display:flex;flex-direction:column;gap:4px;font-size:12px;";
  const title = el("span", config.label);
  title.style.cssText = "font-weight:500;color:hsl(var(--muted-foreground));";
  const select = withSelectChevron(el("select"));
  select.style.cssText =
    "width:100%;height:30px;padding-block:0;padding-inline-start:8px;padding-inline-end:26px;border-radius:6px;border:1px solid hsl(var(--border));background:hsl(var(--background));color:hsl(var(--foreground));font-size:12px;";
  for (const item of config.options) {
    const opt = el("option", item.label);
    opt.value = item.value;
    if (item.disabled) opt.disabled = true;
    select.appendChild(opt);
  }
  if (config.value !== undefined) select.value = config.value;
  if (config.onChange) {
    select.addEventListener("change", () => config.onChange?.(select.value));
  }
  wrapper.append(title, select);
  return { wrapper, select };
}

/** Create a horizontal action row for plugin buttons. */
export function createActionRow(
  items: readonly HTMLElement[],
  align: "start" | "end" | "between" = "end",
): HTMLDivElement {
  const row = el("div");
  const justify =
    align === "between" ? "space-between" : align === "start" ? "flex-start" : "flex-end";
  row.style.cssText = `display:flex;align-items:center;justify-content:${justify};gap:8px;flex-wrap:wrap;`;
  for (const item of items) row.appendChild(item);
  return row;
}

export interface PluginModalOptions {
  title: string;
  body: HTMLElement | string;
  actions?: readonly HTMLElement[];
  maxWidthPx?: number;
  /** Localized accessible label for the close button (must be translated by the caller). */
  closeLabel: string;
  onClose?: () => void;
}

let nextModalId = 0;

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  const selector =
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  return Array.from(container.querySelectorAll<HTMLElement>(selector)).filter(
    (node) =>
      !node.matches(":disabled") && (node.offsetParent !== null || node === document.activeElement),
  );
}

/**
 * Create and mount a lightweight accessible modal dialog for plain-DOM plugins.
 * Moves focus into the dialog, traps Tab navigation while open, restores focus
 * on close, and closes on backdrop click, Escape key, or calling `close()`.
 */
export function createModalDialog(options: PluginModalOptions): {
  overlay: HTMLDivElement;
  dialog: HTMLDivElement;
  close: () => void;
} {
  const previouslyFocused =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;

  const overlay = el("div");
  overlay.style.cssText =
    "position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;padding:16px;";

  const dialog = el("div");
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.tabIndex = -1;
  const headingId = `geolibre-plugin-modal-title-${++nextModalId}`;
  dialog.setAttribute("aria-labelledby", headingId);
  const maxWidth = options.maxWidthPx ?? 420;
  dialog.style.cssText = `width:100%;max-width:${maxWidth}px;background:hsl(var(--popover));color:hsl(var(--popover-foreground));border:1px solid hsl(var(--border));border-radius:10px;padding:16px;box-shadow:0 12px 32px rgba(0,0,0,0.3);display:flex;flex-direction:column;gap:12px;font-family:inherit;font-size:13px;`;

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    window.removeEventListener("keydown", onKeyDown);
    overlay.remove();
    if (previouslyFocused && previouslyFocused.isConnected) {
      previouslyFocused.focus();
    }
    options.onClose?.();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      close();
      return;
    }
    if (event.key === "Tab") {
      const focusable = getFocusableElements(dialog);
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      const outside = !dialog.contains(active) || active === dialog;
      if (event.shiftKey) {
        if (active === first || outside) {
          event.preventDefault();
          last.focus();
        }
      } else if (active === last || outside) {
        event.preventDefault();
        first.focus();
      }
    }
  };
  // Close only when the press also started on the backdrop, so dragging a text
  // selection from inside the dialog and releasing outside does not dismiss it.
  let pressStartedOnOverlay = false;
  overlay.addEventListener("pointerdown", (event) => {
    pressStartedOnOverlay = event.target === overlay;
  });
  overlay.addEventListener("click", (event) => {
    if (pressStartedOnOverlay && event.target === overlay) close();
    pressStartedOnOverlay = false;
  });
  window.addEventListener("keydown", onKeyDown);

  const header = el("div");
  header.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:8px;";
  const heading = el("h3", options.title);
  heading.id = headingId;
  heading.style.cssText = "margin:0;font-size:14px;font-weight:600;";
  const closeButton = createButton("×", {
    variant: "ghost",
    title: options.closeLabel,
    onClick: close,
  });
  closeButton.setAttribute("aria-label", options.closeLabel);
  header.append(heading, closeButton);

  const content = typeof options.body === "string" ? el("p", options.body) : options.body;
  dialog.append(header, content);

  if (options.actions && options.actions.length > 0) {
    dialog.appendChild(createActionRow(options.actions, "end"));
  }

  overlay.appendChild(dialog);
  document.body.appendChild(overlay);
  const initialFocus = getFocusableElements(dialog)[0] ?? dialog;
  initialFocus.focus();
  return { overlay, dialog, close };
}

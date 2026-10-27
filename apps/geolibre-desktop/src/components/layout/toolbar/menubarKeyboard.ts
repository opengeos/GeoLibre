import type { KeyboardEvent as ReactKeyboardEvent } from "react";

// The top-level toolbar entries: every menu trigger, Settings included (it is a
// dropdown too). The project-name field and theme toggle open nothing and stay out.
const TRIGGER_SELECTOR = '[aria-haspopup="menu"]';

const NAV_KEYS = new Set(["ArrowLeft", "ArrowRight", "Home", "End"]);

// Set while one menu is closing and the next is about to open, so a repeated
// Left/Right in that window doesn't step on from the closed menu's trigger.
let switching = false;

function toolbarTriggers(toolbar: HTMLElement): HTMLElement[] {
  return Array.from(toolbar.querySelectorAll<HTMLElement>(TRIGGER_SELECTOR)).filter(
    // Skip triggers nested in menu content and any that are hidden or disabled.
    (el) =>
      !el.closest('[role="menu"]') &&
      el.offsetParent !== null &&
      !el.hasAttribute("disabled") &&
      el.getAttribute("aria-disabled") !== "true",
  );
}

function openMenuFrom(trigger: HTMLElement) {
  trigger.focus();
  // Radix opens a dropdown from its trigger on ArrowDown and focuses the first item.
  trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
}

/**
 * Desktop menu-bar arrow keys for the top toolbar (#3232). Each menu is its own
 * Radix DropdownMenu, so this sits on the toolbar and works from the DOM:
 * Left/Right (mirrored in RTL) move between the top-level entries, Home/End
 * jump to the ends, and with a menu open Left/Right close it and open the
 * neighbouring menu. Keys a submenu already handled arrive with
 * `defaultPrevented` set and are left alone. Menu content is portalled, but
 * React still bubbles its key events up to this handler.
 *
 * @param event The keydown event from the toolbar or a menu it owns.
 */
export function handleMenubarKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
  if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
  const key = event.key;
  if (!NAV_KEYS.has(key)) return;
  const target = event.target as HTMLElement;
  // Arrow keys move the caret in a text field (e.g. the Processing menu search).
  if (target.closest("input, textarea, select, [contenteditable='true']")) return;
  if (switching) {
    event.preventDefault();
    return;
  }

  const toolbar = event.currentTarget;
  const rtl = getComputedStyle(toolbar).direction === "rtl";
  const nextKey = rtl ? "ArrowLeft" : "ArrowRight";
  const triggers = toolbarTriggers(toolbar);
  if (triggers.length === 0) return;

  const menu = target.closest<HTMLElement>('[role="menu"]');
  if (menu) {
    // Inside an open menu: only the top-level menus switch, and only on Left/Right.
    if (key === "Home" || key === "End") return;
    const owner = document.getElementById(menu.getAttribute("aria-labelledby") ?? "");
    const index = owner ? triggers.indexOf(owner) : -1;
    if (index === -1) return;
    event.preventDefault();
    const step = key === nextKey ? 1 : -1;
    const current = triggers[index];
    const next = triggers[(index + step + triggers.length) % triggers.length];
    // Escape closes the current menu, and Radix (react-dismissable-layer 1.1,
    // react-dropdown-menu 2.1) then hands focus back to its trigger from a
    // timer after the content unmounts. Open the next menu only once that
    // restore has landed, so it cannot pull focus back to the old trigger.
    // The fallback timer covers a close that restores nothing.
    switching = true;
    let opened = false;
    const open = () => {
      if (opened) return;
      opened = true;
      switching = false;
      current.removeEventListener("focus", onRestore);
      window.clearTimeout(fallback);
      openMenuFrom(next);
    };
    const onRestore = () => window.setTimeout(open, 0);
    current.addEventListener("focus", onRestore, { once: true });
    const fallback = window.setTimeout(open, 100);
    // Radix listens for Escape on `document` in the capture phase, so a
    // non-bubbling event on the menu reaches it without reaching the app's
    // bubble-phase window Escape handlers (region select, line of sight, …).
    // Capture-phase listeners such as useFileDrop's still see it.
    menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    return;
  }

  const index = triggers.indexOf(target);
  if (index === -1) return;
  event.preventDefault();
  let nextIndex: number;
  if (key === "Home") nextIndex = 0;
  else if (key === "End") nextIndex = triggers.length - 1;
  else nextIndex = (index + (key === nextKey ? 1 : -1) + triggers.length) % triggers.length;
  triggers[nextIndex].focus();
}

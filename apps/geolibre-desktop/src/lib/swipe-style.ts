const SWIPE_STYLE_ID = "maplibre-gl-swipe-style-fixes";
const SWIPE_SELECT_PROXY_CLASS = "swipe-select-proxy";
const SWIPE_SELECT_MENU_CLASS = "swipe-select-menu";

interface GeoLibreLayerLabelWindow extends Window {
  __GEOLIBRE_LAYER_LABELS__?: Record<string, string>;
}

const SWIPE_SELECT_FIXES = `
.swipe-control-panel .swipe-control-select {
  color: #111827;
  color-scheme: light;
}

.swipe-control-panel .swipe-control-select option {
  background-color: #fff;
  color: #111827;
  color-scheme: light;
}

.swipe-control-panel .swipe-control-select.is-proxied {
  display: none;
}

.swipe-control-panel .swipe-select-proxy {
  align-items: center;
  background-color: #fff;
  background-image: url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12' fill='none'%3E%3Cpath d='M3 4.5 6 7.5 9 4.5' stroke='%231f2933' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
  background-position: right 8px center;
  background-repeat: no-repeat;
  background-size: 12px 12px;
  border: 1px solid #ddd;
  border-radius: 4px;
  box-sizing: border-box;
  color: #111827;
  cursor: pointer;
  display: inline-flex;
  font-size: 12px;
  height: 28px;
  justify-content: flex-start;
  line-height: 26px;
  min-height: 0;
  overflow: hidden;
  padding: 0 28px 0 8px;
  text-align: left;
  white-space: nowrap;
  width: 100%;
}

.swipe-control-panel .swipe-select-proxy:focus-visible,
.swipe-control-panel .swipe-select-proxy.is-open {
  border-color: #4a90d9;
  box-shadow: 0 0 0 2px rgba(74, 144, 217, 0.15);
  outline: none;
}

.swipe-select-menu {
  background: #fff;
  border: 1px solid #d1d5db;
  border-radius: 0;
  box-shadow: 0 8px 18px rgba(15, 23, 42, 0.18);
  box-sizing: border-box;
  color: #111827;
  font-family: Arial, Helvetica, sans-serif;
  font-size: 12px;
  margin: 0;
  max-height: 180px;
  overflow-y: auto;
  padding: 0;
  position: fixed;
  z-index: 10000;
}

.swipe-select-menu button {
  background: #fff;
  border: 0;
  box-sizing: border-box;
  color: #111827;
  cursor: pointer;
  display: block;
  font: inherit;
  height: 24px;
  line-height: 24px;
  padding: 0 8px;
  text-align: left;
  width: 100%;
}

.swipe-select-menu button:hover,
.swipe-select-menu button.is-active {
  background: #f3f4f6;
}

.swipe-select-menu button.is-selected {
  background: #4a90d9;
  color: #fff;
}

.swipe-control-panel .swipe-layer-item input[type="checkbox"] {
  appearance: none;
  -webkit-appearance: none;
  align-items: center;
  background: #fff;
  border: 1px solid #cbd5e1;
  border-radius: 2px;
  box-sizing: border-box;
  display: inline-flex;
  flex: 0 0 auto;
  height: 14px;
  justify-content: center;
  margin: 0;
  width: 14px;
}

.swipe-control-panel .swipe-layer-item input[type="checkbox"]:hover {
  border-color: #4a90d9;
}

.swipe-control-panel .swipe-layer-item input[type="checkbox"]:focus-visible {
  box-shadow: 0 0 0 2px rgba(74, 144, 217, 0.18);
  outline: none;
}

.swipe-control-panel .swipe-layer-item input[type="checkbox"]:checked {
  background-color: #4a90d9;
  border-color: #4a90d9;
  background-image: url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 10 10' fill='none'%3E%3Cpath d='M2 5 4 7 8 3' stroke='%23fff' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
  background-position: center;
  background-repeat: no-repeat;
  background-size: 10px 10px;
}
`;

if (typeof document !== "undefined" && !document.getElementById(SWIPE_STYLE_ID)) {
  const style = document.createElement("style");
  style.id = SWIPE_STYLE_ID;
  style.textContent = SWIPE_SELECT_FIXES;
  document.head.appendChild(style);
}

const closeSwipeSelectMenu = () => {
  document.querySelector(`.${SWIPE_SELECT_MENU_CLASS}`)?.remove();
  document
    .querySelectorAll<HTMLButtonElement>(`.${SWIPE_SELECT_PROXY_CLASS}.is-open`)
    .forEach((button) => {
      button.classList.remove("is-open");
      button.setAttribute("aria-expanded", "false");
    });
};

const syncSwipeSelectProxy = (select: HTMLSelectElement, button: HTMLButtonElement) => {
  button.textContent = select.options[select.selectedIndex]?.text ?? "";
};

const openSwipeSelectMenu = (select: HTMLSelectElement, button: HTMLButtonElement) => {
  closeSwipeSelectMenu();
  syncSwipeSelectProxy(select, button);

  const rect = button.getBoundingClientRect();
  const menu = document.createElement("div");
  menu.className = SWIPE_SELECT_MENU_CLASS;
  menu.style.left = `${rect.left}px`;
  menu.style.top = `${rect.bottom}px`;
  menu.style.width = `${rect.width}px`;
  menu.setAttribute("role", "listbox");

  Array.from(select.options).forEach((option) => {
    const item = document.createElement("button");
    item.type = "button";
    item.textContent = option.text;
    item.dataset.value = option.value;
    item.setAttribute("role", "option");
    if (option.value === select.value) {
      item.classList.add("is-selected", "is-active");
      item.setAttribute("aria-selected", "true");
    }
    item.addEventListener("click", () => {
      select.value = option.value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
      syncSwipeSelectProxy(select, button);
      closeSwipeSelectMenu();
      button.focus();
    });
    menu.appendChild(item);
  });

  const items = Array.from(menu.querySelectorAll<HTMLButtonElement>("button"));
  menu.addEventListener("keydown", (event) => {
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "ArrowDown") {
      event.preventDefault();
      items[Math.min(current + 1, items.length - 1)]?.focus();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      items[Math.max(current - 1, 0)]?.focus();
    } else if (event.key === "Home") {
      event.preventDefault();
      items[0]?.focus();
    } else if (event.key === "End") {
      event.preventDefault();
      items[items.length - 1]?.focus();
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeSwipeSelectMenu();
      button.focus();
    }
  });

  button.classList.add("is-open");
  button.setAttribute("aria-expanded", "true");
  document.body.appendChild(menu);
  (menu.querySelector<HTMLButtonElement>("button.is-selected") ?? items[0])?.focus();
};

const enhanceSwipeSelect = (select: HTMLSelectElement) => {
  if (select.classList.contains("is-proxied")) return;

  const button = document.createElement("button");
  button.type = "button";
  button.className = SWIPE_SELECT_PROXY_CLASS;
  button.setAttribute("aria-haspopup", "listbox");
  button.setAttribute("aria-expanded", "false");
  syncSwipeSelectProxy(select, button);

  button.addEventListener("click", (event) => {
    event.stopPropagation();
    if (button.classList.contains("is-open")) closeSwipeSelectMenu();
    else openSwipeSelectMenu(select, button);
  });

  button.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openSwipeSelectMenu(select, button);
    }
    if (event.key === "Escape") closeSwipeSelectMenu();
  });

  select.addEventListener("change", () => syncSwipeSelectProxy(select, button));
  select.classList.add("is-proxied");
  select.insertAdjacentElement("afterend", button);
};

const enhanceSwipeSelects = () => {
  document
    .querySelectorAll<HTMLSelectElement>(".swipe-control-panel .swipe-control-select")
    .forEach(enhanceSwipeSelect);
};

let swipeEnhanceFrame: number | null = null;

// English fallback for the grouped base layer, used until the controller
// publishes the translated label through the layer-label bridge.
const SWIPE_BASEMAP_LABEL = "Background";

const getSwipeLayerLabel = (layerId: string): string => {
  const labels = (window as GeoLibreLayerLabelWindow).__GEOLIBRE_LAYER_LABELS__;
  if (layerId === "__basemap__") return labels?.[layerId] ?? SWIPE_BASEMAP_LABEL;
  return labels?.[layerId] ?? layerId;
};

const syncSwipeLayerLabels = () => {
  document
    .querySelectorAll<HTMLInputElement>(
      '.swipe-control-panel .swipe-layer-item input[type="checkbox"][data-layer-id]',
    )
    .forEach((checkbox) => {
      const layerId = checkbox.dataset.layerId;
      if (!layerId) return;

      const label = checkbox.parentElement?.querySelector<HTMLLabelElement>(
        `label[for="${CSS.escape(checkbox.id)}"]`,
      );
      if (!label) return;

      const displayName = getSwipeLayerLabel(layerId);
      const title = layerId === "__basemap__" ? displayName : `${displayName} (${layerId})`;
      if (label.textContent !== displayName) {
        label.textContent = displayName;
      }
      if (label.title !== title) {
        label.title = title;
      }
    });
};

const enhanceSwipePanel = () => {
  enhanceSwipeSelects();
  syncSwipeLayerLabels();
};

const scheduleEnhanceSwipePanel = () => {
  if (swipeEnhanceFrame !== null) return;
  swipeEnhanceFrame = window.requestAnimationFrame(() => {
    swipeEnhanceFrame = null;
    enhanceSwipePanel();
  });
};

if (typeof document !== "undefined") {
  document.addEventListener("click", closeSwipeSelectMenu);
  window.addEventListener("resize", closeSwipeSelectMenu);
  window.addEventListener("geolibre-layer-labels-change", scheduleEnhanceSwipePanel);
  window.addEventListener(
    "scroll",
    (event) => {
      const menu = document.querySelector(`.${SWIPE_SELECT_MENU_CLASS}`);
      if (menu && event.target instanceof Node && menu.contains(event.target)) {
        return;
      }
      closeSwipeSelectMenu();
    },
    true,
  );

  const observer = new MutationObserver(scheduleEnhanceSwipePanel);
  observer.observe(document.body, { childList: true, subtree: true });
  scheduleEnhanceSwipePanel();
}

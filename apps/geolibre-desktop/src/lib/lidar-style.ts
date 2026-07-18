import lidarStyle from "maplibre-gl-lidar/style.css?inline";

const LIDAR_STYLE_ID = "maplibre-gl-lidar-style";
const LIDAR_SELECT_PROXY_CLASS = "lidar-select-proxy";
const LIDAR_SELECT_MENU_CLASS = "lidar-select-menu";
const LIDAR_PREFLIGHT_RESET = `
.lidar-control-panel,
.lidar-control-panel * {
  all: revert;
  box-sizing: border-box;
}

.lidar-control-panel input[type="checkbox"],
.lidar-control-panel input[type="radio"] {
  box-sizing: revert;
}
`;
const LIDAR_PANEL_LAYOUT_FIX = `
.lidar-control-panel {
  overflow: hidden;
}

/* The default drop zone is quite tall; trim its padding (and the icon) so the
   upload box does not dominate the top of the panel. */
.lidar-control-panel .lidar-file-input-label {
  padding: 10px 12px;
  min-height: 0;
  gap: 4px;
}

.lidar-control-panel .lidar-file-input-label svg {
  width: 20px;
  height: 20px;
}

.lidar-control-panel .lidar-control-content {
  max-height: inherit;
  padding-bottom: 16px;
  padding-right: 10px;
  scroll-padding-bottom: 16px;
  scrollbar-gutter: stable;
}

.lidar-control-panel .lidar-share-section {
  position: static;
}

.lidar-control-panel .lidar-control-select,
.lidar-control-panel .lidar-colormap-select {
  appearance: none;
  -webkit-appearance: none;
  box-sizing: border-box;
  height: 30px;
  min-height: 0;
  padding: 0 28px 0 8px;
  line-height: 28px;
  background-color: #fff;
  background-image: url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12' fill='none'%3E%3Cpath d='M3 4.5 6 7.5 9 4.5' stroke='%231f2933' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
  background-position: right 8px center;
  background-repeat: no-repeat;
  background-size: 12px 12px;
  color: #111827;
  color-scheme: light;
}

.lidar-control-panel .lidar-control-select option,
.lidar-control-panel .lidar-colormap-select option {
  background-color: #fff;
  color: #111827;
  color-scheme: light;
}

.lidar-control-panel .lidar-control-select.is-proxied,
.lidar-control-panel .lidar-colormap-select.is-proxied {
  display: none;
}

.lidar-control-panel .lidar-select-proxy {
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
  height: 30px;
  justify-content: flex-start;
  line-height: 28px;
  min-height: 0;
  overflow: hidden;
  padding: 0 28px 0 8px;
  text-align: left;
  white-space: nowrap;
}

.lidar-control-panel .lidar-control-select.is-proxied + .lidar-select-proxy {
  width: 100%;
}

.lidar-control-panel .lidar-colormap-select.is-proxied + .lidar-select-proxy {
  min-width: 104px;
}

.lidar-control-panel .lidar-select-proxy:focus-visible,
.lidar-control-panel .lidar-select-proxy.is-open {
  border-color: #159895;
  box-shadow: 0 0 0 2px rgba(21, 152, 149, 0.15);
  outline: none;
}

.lidar-select-menu {
  background: #fff;
  border: 1px solid #d1d5db;
  border-radius: 0;
  box-shadow: 0 8px 18px rgba(15, 23, 42, 0.18);
  box-sizing: border-box;
  color: #111827;
  font-family: Arial, Helvetica, sans-serif;
  font-size: 12px;
  list-style: none;
  margin: 0;
  max-height: 220px;
  overflow-y: auto;
  padding: 0;
  position: fixed;
  z-index: 10000;
}

.lidar-select-menu button {
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

.lidar-select-menu button:hover,
.lidar-select-menu button.is-active {
  background: #f3f4f6;
}

.lidar-select-menu button.is-selected {
  background: #159895;
  color: #fff;
}

.lidar-control-panel input[type="checkbox"] {
  appearance: none;
  -webkit-appearance: none;
  display: inline-grid;
  place-content: center;
  width: 13px;
  height: 13px;
  min-width: 13px;
  min-height: 13px;
  margin: 0 6px 0 0;
  flex: 0 0 13px;
  border: 1px solid #c9d2df;
  border-radius: 2px;
  background: #fff;
  cursor: pointer;
  vertical-align: middle;
}

.lidar-control-panel input[type="checkbox"]::before {
  width: 7px;
  height: 5px;
  content: "";
  transform: scale(0);
  transform-origin: center;
  background: #fff;
  clip-path: polygon(14% 44%, 0 58%, 39% 100%, 100% 15%, 86% 0, 37% 67%);
}

.lidar-control-panel input[type="checkbox"]:checked {
  border-color: #159895;
  background: #159895;
}

.lidar-control-panel input[type="checkbox"]:checked::before {
  transform: scale(1);
}

.lidar-control-panel input[type="checkbox"]:focus-visible {
  outline: 2px solid rgba(21, 152, 149, 0.35);
  outline-offset: 1px;
}

.lidar-control-panel .lidar-classification-legend-item input[type="checkbox"] {
  margin: 0;
}
`;

if (typeof document !== "undefined" && !document.getElementById(LIDAR_STYLE_ID)) {
  const style = document.createElement("style");
  style.id = LIDAR_STYLE_ID;
  style.textContent = `${LIDAR_PREFLIGHT_RESET}\n${lidarStyle}\n${LIDAR_PANEL_LAYOUT_FIX}`;
  document.head.appendChild(style);
}

const closeLidarSelectMenu = () => {
  document.querySelector(`.${LIDAR_SELECT_MENU_CLASS}`)?.remove();
  document
    .querySelectorAll<HTMLButtonElement>(`.${LIDAR_SELECT_PROXY_CLASS}.is-open`)
    .forEach((button) => {
      button.classList.remove("is-open");
      button.setAttribute("aria-expanded", "false");
    });
};

const syncLidarSelectProxy = (select: HTMLSelectElement, button: HTMLButtonElement) => {
  button.textContent = select.options[select.selectedIndex]?.text ?? "";
};

const openLidarSelectMenu = (select: HTMLSelectElement, button: HTMLButtonElement) => {
  closeLidarSelectMenu();

  const rect = button.getBoundingClientRect();
  const menu = document.createElement("div");
  menu.className = LIDAR_SELECT_MENU_CLASS;
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
    item.addEventListener("click", (event) => {
      event.stopPropagation();
      select.value = option.value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
      syncLidarSelectProxy(select, button);
      closeLidarSelectMenu();
      button.focus();
    });
    menu.appendChild(item);
  });

  const items = Array.from(menu.querySelectorAll<HTMLButtonElement>("button"));
  menu.addEventListener("click", (event) => event.stopPropagation());
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
      closeLidarSelectMenu();
      button.focus();
    }
  });

  button.classList.add("is-open");
  button.setAttribute("aria-expanded", "true");
  document.body.appendChild(menu);
  (menu.querySelector<HTMLButtonElement>("button.is-selected") ?? items[0])?.focus();
};

const enhanceLidarSelect = (select: HTMLSelectElement) => {
  if (select.classList.contains("is-proxied")) return;

  const button = document.createElement("button");
  button.type = "button";
  button.className = LIDAR_SELECT_PROXY_CLASS;
  button.setAttribute("aria-haspopup", "listbox");
  button.setAttribute("aria-expanded", "false");
  syncLidarSelectProxy(select, button);

  button.addEventListener("click", (event) => {
    event.stopPropagation();
    const isOpen = button.classList.contains("is-open");
    if (isOpen) closeLidarSelectMenu();
    else openLidarSelectMenu(select, button);
  });

  button.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openLidarSelectMenu(select, button);
    }
    if (event.key === "Escape") closeLidarSelectMenu();
  });

  select.addEventListener("change", () => syncLidarSelectProxy(select, button));
  select.classList.add("is-proxied");
  select.insertAdjacentElement("afterend", button);
};

const enhanceLidarSelects = () => {
  document
    .querySelectorAll<HTMLSelectElement>(
      ".lidar-control-panel .lidar-control-select, .lidar-control-panel .lidar-colormap-select",
    )
    .forEach(enhanceLidarSelect);
};

if (typeof document !== "undefined") {
  document.addEventListener("click", closeLidarSelectMenu);
  window.addEventListener("resize", closeLidarSelectMenu);
  window.addEventListener(
    "scroll",
    (event) => {
      const menu = document.querySelector(`.${LIDAR_SELECT_MENU_CLASS}`);
      if (menu && event.target instanceof Node && menu.contains(event.target)) {
        return;
      }
      closeLidarSelectMenu();
    },
    true,
  );

  const observer = new MutationObserver(enhanceLidarSelects);
  observer.observe(document.body, { childList: true, subtree: true });
  enhanceLidarSelects();
}

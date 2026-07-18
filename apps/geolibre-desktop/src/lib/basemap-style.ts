const BASEMAP_STYLE_ID = "maplibre-gl-basemap-style-fixes";
const BASEMAP_SELECT_PROXY_CLASS = "basemap-select-proxy";
const BASEMAP_SELECT_MENU_CLASS = "basemap-select-menu";

const BASEMAP_SELECT_FIXES = `
.basemap-control-panel .basemap-control-select {
  color: #111827;
  color-scheme: light;
}

.basemap-control-panel .basemap-control-select option {
  background-color: #fff;
  color: #111827;
  color-scheme: light;
}

.basemap-control-panel .basemap-control-select.is-proxied {
  display: none;
}

.basemap-control-panel .basemap-select-proxy {
  align-items: center;
  background-color: #fff;
  background-image: url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12' fill='none'%3E%3Cpath d='M3 4.5 6 7.5 9 4.5' stroke='%23111827' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
  background-position: right 8px center;
  background-repeat: no-repeat;
  background-size: 12px 12px;
  border: 1px solid #d1d5db;
  border-radius: 4px;
  box-sizing: border-box;
  color: #111827;
  cursor: pointer;
  display: inline-flex;
  font: inherit;
  height: 30px;
  justify-content: flex-start;
  line-height: 28px;
  min-width: 0;
  overflow: hidden;
  padding: 4px 28px 4px 6px;
  text-align: left;
  white-space: nowrap;
  width: 100%;
}

.basemap-control-panel .basemap-select-proxy:focus-visible,
.basemap-control-panel .basemap-select-proxy.is-open {
  border-color: #2563eb;
  box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.14);
  outline: none;
}

.basemap-select-menu {
  background: #fff;
  border: 1px solid #d1d5db;
  border-radius: 0;
  box-shadow: 0 8px 18px rgba(15, 23, 42, 0.18);
  box-sizing: border-box;
  color: #111827;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  font-size: 12px;
  margin: 0;
  max-height: 220px;
  overflow-y: auto;
  padding: 0;
  position: fixed;
  z-index: 10000;
}

.basemap-select-menu button {
  background: #fff;
  border: 0;
  box-sizing: border-box;
  color: #111827;
  cursor: pointer;
  display: block;
  font: inherit;
  height: 26px;
  line-height: 26px;
  overflow: hidden;
  padding: 0 8px;
  text-align: left;
  text-overflow: ellipsis;
  white-space: nowrap;
  width: 100%;
}

.basemap-select-menu button:hover {
  background: #f3f4f6;
}

.basemap-select-menu button.is-selected {
  background: #2563eb;
  color: #fff;
}
`;

if (typeof document !== "undefined" && !document.getElementById(BASEMAP_STYLE_ID)) {
  const style = document.createElement("style");
  style.id = BASEMAP_STYLE_ID;
  style.textContent = BASEMAP_SELECT_FIXES;
  document.head.appendChild(style);
}

// Tracks the currently-open menu so global listeners can bail without a DOM
// query when nothing is open.
let openMenu: HTMLDivElement | null = null;

const closeBasemapSelectMenu = () => {
  openMenu?.remove();
  openMenu = null;
  document
    .querySelectorAll<HTMLButtonElement>(`.${BASEMAP_SELECT_PROXY_CLASS}.is-open`)
    .forEach((button) => {
      button.classList.remove("is-open");
      button.setAttribute("aria-expanded", "false");
    });
};

const syncBasemapSelectProxy = (select: HTMLSelectElement, button: HTMLButtonElement) => {
  button.textContent = select.options[select.selectedIndex]?.text ?? "";
};

const openBasemapSelectMenu = (select: HTMLSelectElement, button: HTMLButtonElement) => {
  closeBasemapSelectMenu();
  syncBasemapSelectProxy(select, button);

  const rect = button.getBoundingClientRect();
  const menu = document.createElement("div");
  menu.className = BASEMAP_SELECT_MENU_CLASS;
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
      item.classList.add("is-selected");
      item.setAttribute("aria-selected", "true");
    }
    item.addEventListener("click", (event) => {
      event.stopPropagation();
      select.value = option.value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
      syncBasemapSelectProxy(select, button);
      closeBasemapSelectMenu();
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
      closeBasemapSelectMenu();
      button.focus();
    } else if (event.key === "Tab") {
      // Let focus advance naturally, but dismiss the menu so it does not linger
      // open after the user tabs away.
      closeBasemapSelectMenu();
    }
  });

  button.classList.add("is-open");
  button.setAttribute("aria-expanded", "true");
  document.body.appendChild(menu);
  openMenu = menu;
  (menu.querySelector<HTMLButtonElement>("button.is-selected") ?? items[0])?.focus();
};

const enhanceBasemapSelect = (select: HTMLSelectElement) => {
  if (select.classList.contains("is-proxied")) return;

  const button = document.createElement("button");
  button.type = "button";
  button.className = BASEMAP_SELECT_PROXY_CLASS;
  button.setAttribute("aria-haspopup", "listbox");
  button.setAttribute("aria-expanded", "false");
  syncBasemapSelectProxy(select, button);

  button.addEventListener("click", (event) => {
    event.stopPropagation();
    if (button.classList.contains("is-open")) closeBasemapSelectMenu();
    else openBasemapSelectMenu(select, button);
  });

  button.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (button.classList.contains("is-open")) closeBasemapSelectMenu();
      else openBasemapSelectMenu(select, button);
    }
    if (event.key === "Escape") closeBasemapSelectMenu();
  });

  select.addEventListener("change", () => syncBasemapSelectProxy(select, button));
  select.classList.add("is-proxied");
  select.insertAdjacentElement("afterend", button);
};

const enhanceBasemapSelects = () => {
  document
    .querySelectorAll<HTMLSelectElement>(".basemap-control-panel .basemap-control-select")
    .forEach(enhanceBasemapSelect);
};

if (typeof document !== "undefined") {
  document.addEventListener("click", closeBasemapSelectMenu);
  window.addEventListener("resize", closeBasemapSelectMenu);
  window.addEventListener(
    "scroll",
    (event) => {
      if (!openMenu) return;
      if (event.target instanceof Node && openMenu.contains(event.target)) {
        return;
      }
      closeBasemapSelectMenu();
    },
    true,
  );

  // Coalesce frequent body mutations (canvas renders, popups, etc.) into one
  // enhancement pass per animation frame instead of running a DOM query on
  // every child-list change.
  let enhancePending = false;
  const observer = new MutationObserver(() => {
    if (enhancePending) return;
    enhancePending = true;
    requestAnimationFrame(() => {
      enhancePending = false;
      enhanceBasemapSelects();
    });
  });
  observer.observe(document.body, { childList: true, subtree: true });
  enhanceBasemapSelects();
}

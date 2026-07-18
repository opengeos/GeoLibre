const GEOAGENT_STYLE_ID = "maplibre-gl-geoagent-style-fixes";
const GEOAGENT_SELECT_PROXY_CLASS = "geoagent-select-proxy";
const GEOAGENT_SELECT_MENU_CLASS = "geoagent-select-menu";

const GEOAGENT_SELECT_FIXES = `
.geoagent-panel select {
  color: #17202a;
  color-scheme: light;
}

.geoagent-panel select option {
  background-color: #fff;
  color: #17202a;
  color-scheme: light;
}

.geoagent-panel select.is-proxied {
  display: none;
}

.geoagent-panel .geoagent-select-proxy {
  align-items: center;
  background-color: #fff;
  background-image: url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12' fill='none'%3E%3Cpath d='M3 4.5 6 7.5 9 4.5' stroke='%2317202a' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
  background-position: right 10px center;
  background-repeat: no-repeat;
  background-size: 12px 12px;
  border: 1px solid #d7dde5;
  border-radius: 6px;
  box-sizing: border-box;
  color: #17202a;
  cursor: pointer;
  display: inline-flex;
  font: inherit;
  height: 36px;
  justify-content: flex-start;
  line-height: 34px;
  min-height: 0;
  overflow: hidden;
  padding: 0 30px 0 10px;
  text-align: left;
  white-space: nowrap;
  width: 100%;
}

.geoagent-panel .geoagent-select-proxy:focus-visible,
.geoagent-panel .geoagent-select-proxy.is-open {
  border-color: #2f8f85;
  box-shadow: inset 0 0 0 1px #2f8f85;
  outline: none;
}

.geoagent-select-menu {
  background: #fff;
  border: 1px solid #d7dde5;
  border-radius: 0;
  box-shadow: 0 8px 18px rgba(15, 23, 42, 0.18);
  box-sizing: border-box;
  color: #17202a;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-size: 13px;
  margin: 0;
  max-height: 220px;
  overflow-y: auto;
  padding: 0;
  position: fixed;
  z-index: 10000;
}

.geoagent-select-menu button {
  background: #fff;
  border: 0;
  box-sizing: border-box;
  color: #17202a;
  cursor: pointer;
  display: block;
  font: inherit;
  height: 28px;
  line-height: 28px;
  padding: 0 10px;
  text-align: left;
  width: 100%;
}

.geoagent-select-menu button:hover,
.geoagent-select-menu button.is-active {
  background: #f1f5f9;
}

.geoagent-select-menu button.is-selected {
  background: #2f8f85;
  color: #fff;
}
`;

if (typeof document !== "undefined" && !document.getElementById(GEOAGENT_STYLE_ID)) {
  const style = document.createElement("style");
  style.id = GEOAGENT_STYLE_ID;
  style.textContent = GEOAGENT_SELECT_FIXES;
  document.head.appendChild(style);
}

const closeGeoAgentSelectMenu = () => {
  document.querySelector(`.${GEOAGENT_SELECT_MENU_CLASS}`)?.remove();
  document
    .querySelectorAll<HTMLButtonElement>(`.${GEOAGENT_SELECT_PROXY_CLASS}.is-open`)
    .forEach((button) => {
      button.classList.remove("is-open");
      button.setAttribute("aria-expanded", "false");
    });
};

const syncGeoAgentSelectProxy = (select: HTMLSelectElement, button: HTMLButtonElement) => {
  button.textContent = select.options[select.selectedIndex]?.text ?? "";
};

const openGeoAgentSelectMenu = (select: HTMLSelectElement, button: HTMLButtonElement) => {
  closeGeoAgentSelectMenu();
  syncGeoAgentSelectProxy(select, button);

  const rect = button.getBoundingClientRect();
  const menu = document.createElement("div");
  menu.className = GEOAGENT_SELECT_MENU_CLASS;
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
      // The menu lives on document.body, outside the GeoAgent panel, so let the
      // click reach neither the document-level menu closer nor the upstream
      // control's click-outside handler (which would collapse the panel).
      event.stopPropagation();
      select.value = option.value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
      syncGeoAgentSelectProxy(select, button);
      closeGeoAgentSelectMenu();
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
      closeGeoAgentSelectMenu();
      button.focus();
    }
  });

  button.classList.add("is-open");
  button.setAttribute("aria-expanded", "true");
  document.body.appendChild(menu);
  (menu.querySelector<HTMLButtonElement>("button.is-selected") ?? items[0])?.focus();
};

const enhanceGeoAgentSelect = (select: HTMLSelectElement) => {
  if (select.classList.contains("is-proxied")) return;

  const button = document.createElement("button");
  button.type = "button";
  button.className = GEOAGENT_SELECT_PROXY_CLASS;
  button.setAttribute("aria-haspopup", "listbox");
  button.setAttribute("aria-expanded", "false");
  syncGeoAgentSelectProxy(select, button);

  button.addEventListener("click", (event) => {
    event.stopPropagation();
    if (button.classList.contains("is-open")) closeGeoAgentSelectMenu();
    else openGeoAgentSelectMenu(select, button);
  });

  button.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openGeoAgentSelectMenu(select, button);
    }
    if (event.key === "Escape") closeGeoAgentSelectMenu();
  });

  select.addEventListener("change", () => syncGeoAgentSelectProxy(select, button));
  select.classList.add("is-proxied");
  select.insertAdjacentElement("afterend", button);
};

const enhanceGeoAgentSelects = () => {
  document
    .querySelectorAll<HTMLSelectElement>(".geoagent-panel select")
    .forEach(enhanceGeoAgentSelect);
};

if (typeof document !== "undefined") {
  document.addEventListener("click", closeGeoAgentSelectMenu);
  window.addEventListener("resize", closeGeoAgentSelectMenu);
  window.addEventListener(
    "scroll",
    (event) => {
      const menu = document.querySelector(`.${GEOAGENT_SELECT_MENU_CLASS}`);
      if (menu && event.target instanceof Node && menu.contains(event.target)) {
        return;
      }
      closeGeoAgentSelectMenu();
    },
    true,
  );

  const observer = new MutationObserver(enhanceGeoAgentSelects);
  observer.observe(document.body, { childList: true, subtree: true });
  enhanceGeoAgentSelects();
}

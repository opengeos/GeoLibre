const SWIPE_STYLE_ID = "maplibre-gl-swipe-style-fixes";
const SWIPE_SELECT_PROXY_CLASS = "swipe-select-proxy";
const SWIPE_SELECT_MENU_CLASS = "swipe-select-menu";

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
    .forEach((button) => button.classList.remove("is-open"));
};

const syncSwipeSelectProxy = (
  select: HTMLSelectElement,
  button: HTMLButtonElement,
) => {
  button.textContent = select.options[select.selectedIndex]?.text ?? "";
};

const openSwipeSelectMenu = (
  select: HTMLSelectElement,
  button: HTMLButtonElement,
) => {
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

  button.classList.add("is-open");
  document.body.appendChild(menu);
};

const enhanceSwipeSelect = (select: HTMLSelectElement) => {
  if (select.classList.contains("is-proxied")) return;

  const button = document.createElement("button");
  button.type = "button";
  button.className = SWIPE_SELECT_PROXY_CLASS;
  button.setAttribute("aria-haspopup", "listbox");
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
    .querySelectorAll<HTMLSelectElement>(
      ".swipe-control-panel .swipe-control-select",
    )
    .forEach(enhanceSwipeSelect);
};

if (typeof document !== "undefined") {
  document.addEventListener("click", closeSwipeSelectMenu);
  window.addEventListener("resize", closeSwipeSelectMenu);
  window.addEventListener("scroll", closeSwipeSelectMenu, true);

  const observer = new MutationObserver(enhanceSwipeSelects);
  observer.observe(document.body, { childList: true, subtree: true });
  enhanceSwipeSelects();
}

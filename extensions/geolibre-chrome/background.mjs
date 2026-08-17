import {
  classifyServiceRequest,
  classifyStyleRequest,
  createPageScope,
  createTabTaskQueue,
} from "./service-scanner.mjs";

const MAX_REQUESTS_PER_TAB = 100;
const enqueue = createTabTaskQueue();
const scope = createPageScope();
/** Style documents seen per tab, keyed by the origin that served them. */
const stylesByTab = new Map();

function rememberStyle(tabId, style) {
  let origins = stylesByTab.get(tabId);
  if (!origins) {
    origins = new Map();
    stylesByTab.set(tabId, origins);
  }
  origins.set(style.origin, style.url);
}

function runForTab(tabId, task) {
  void enqueue(tabId, task).catch((error) =>
    console.warn("GeoLibre could not update detected services.", error),
  );
}

chrome.webRequest.onCompleted.addListener(
  ({ tabId, url, type, documentId }) => {
    if (tabId < 0) return;
    if (type === "main_frame") {
      scope.startPage(tabId);
      stylesByTab.delete(tabId);
      runForTab(tabId, () => chrome.storage.session.remove(`services:${tabId}`));
    }
    if (!scope.accepts(tabId, documentId)) return;
    const style = classifyStyleRequest(url);
    if (style) rememberStyle(tabId, style);
    const service = classifyServiceRequest(url);
    if (!service) return;
    // A vector tileset is only addable with the source layers its style names.
    if (service.format === "Vector tiles") {
      service.styleUrl = stylesByTab.get(tabId)?.get(new URL(service.url).origin) ?? null;
    }
    const generation = scope.generation(tabId);
    runForTab(tabId, async () => {
      // The tab may have navigated while this write waited its turn.
      if (scope.generation(tabId) !== generation) return;
      const key = `services:${tabId}`;
      const stored = await chrome.storage.session.get(key);
      const existing = Array.isArray(stored[key]) ? stored[key] : [];
      // One service can serve several layers, so an entry is a duplicate only
      // when it repeats the layer too — and a repeat that has since picked up a
      // style still replaces the entry that lacked one.
      const same = (entry) =>
        Boolean(entry) && entry.url === service.url && (entry.layer ?? null) === service.layer;
      if (same(existing[0]) && (existing[0].styleUrl ?? null) === service.styleUrl) return;
      const next = [service, ...existing.filter((entry) => !same(entry))].slice(
        0,
        MAX_REQUESTS_PER_TAB,
      );
      await chrome.storage.session.set({ [key]: next });
    });
  },
  { urls: ["http://*/*", "https://*/*"] },
);

chrome.tabs.onRemoved.addListener((tabId) => {
  scope.forget(tabId);
  stylesByTab.delete(tabId);
  runForTab(tabId, () => chrome.storage.session.remove(`services:${tabId}`));
});

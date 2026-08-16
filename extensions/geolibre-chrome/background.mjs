import { classifyServiceRequest, createTabTaskQueue } from "./service-scanner.mjs";

const MAX_REQUESTS_PER_TAB = 100;
const enqueue = createTabTaskQueue();
const removedTabs = new Set();

chrome.webRequest.onCompleted.addListener(
  ({ tabId, url, type }) => {
    if (type === "main_frame" && tabId >= 0) {
      removedTabs.delete(tabId);
      void enqueue(tabId, () => chrome.storage.session.remove(`services:${tabId}`));
    }
    if (tabId < 0 || removedTabs.has(tabId)) return;
    const service = classifyServiceRequest(url);
    if (!service) return;
    void enqueue(tabId, async () => {
      if (removedTabs.has(tabId)) return;
      const key = `services:${tabId}`;
      const stored = await chrome.storage.session.get(key);
      const existing = Array.isArray(stored[key]) ? stored[key] : [];
      const next = [service, ...existing.filter((entry) => entry.url !== service.url)].slice(
        0,
        MAX_REQUESTS_PER_TAB,
      );
      await chrome.storage.session.set({ [key]: next });
    });
  },
  { urls: ["http://*/*", "https://*/*"] },
);

chrome.tabs.onRemoved.addListener((tabId) => {
  removedTabs.add(tabId);
  void enqueue(tabId, () => chrome.storage.session.remove(`services:${tabId}`));
});

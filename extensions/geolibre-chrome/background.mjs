import { classifyServiceRequest } from "./service-scanner.mjs";

const MAX_REQUESTS_PER_TAB = 100;

chrome.webRequest.onCompleted.addListener(
  async ({ tabId, url }) => {
    if (tabId < 0) return;
    const service = classifyServiceRequest(url);
    if (!service) return;
    const key = `services:${tabId}`;
    const stored = await chrome.storage.session.get(key);
    const existing = Array.isArray(stored[key]) ? stored[key] : [];
    const next = [service, ...existing.filter((entry) => entry.url !== service.url)].slice(
      0,
      MAX_REQUESTS_PER_TAB,
    );
    await chrome.storage.session.set({ [key]: next });
  },
  { urls: ["http://*/*", "https://*/*"] },
);

chrome.tabs.onRemoved.addListener((tabId) => {
  void chrome.storage.session.remove(`services:${tabId}`);
});

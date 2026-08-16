import {
  classifyServiceRequest,
  createTabTaskQueue,
  requestBelongsToPage,
} from "./service-scanner.mjs";

const MAX_REQUESTS_PER_TAB = 100;
const enqueue = createTabTaskQueue();
const activeDocuments = new Map();

function runForTab(tabId, task) {
  void enqueue(tabId, task).catch((error) =>
    console.warn("GeoLibre could not update detected services.", error),
  );
}

chrome.webRequest.onCompleted.addListener(
  ({ tabId, url, type, documentId, parentDocumentId }) => {
    if (type === "main_frame" && tabId >= 0) {
      activeDocuments.set(tabId, new Set(documentId ? [documentId] : []));
      runForTab(tabId, () => chrome.storage.session.remove(`services:${tabId}`));
    }
    const documents = activeDocuments.get(tabId);
    if (
      type === "sub_frame" &&
      documentId &&
      parentDocumentId &&
      documents?.has(parentDocumentId)
    ) {
      documents.add(documentId);
    }
    if (tabId < 0 || !requestBelongsToPage(documents, documentId)) return;
    const service = classifyServiceRequest(url);
    if (!service) return;
    runForTab(tabId, async () => {
      if (!requestBelongsToPage(activeDocuments.get(tabId), documentId)) return;
      const key = `services:${tabId}`;
      const stored = await chrome.storage.session.get(key);
      const existing = Array.isArray(stored[key]) ? stored[key] : [];
      if (existing[0]?.url === service.url) return;
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
  activeDocuments.delete(tabId);
  runForTab(tabId, () => chrome.storage.session.remove(`services:${tabId}`));
});

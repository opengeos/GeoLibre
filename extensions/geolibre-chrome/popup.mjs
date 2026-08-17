import { scanDocumentForDatasets } from "./scanner.mjs";
import { mergeServiceCandidates } from "./service-scanner.mjs";
import { buildGeoLibreUrl } from "./url-builder.mjs";

const elements = {
  loading: document.querySelector("#loading"),
  empty: document.querySelector("#empty"),
  error: document.querySelector("#error"),
  errorMessage: document.querySelector("#error-message"),
  results: document.querySelector("#results"),
  pageHost: document.querySelector("#page-host"),
  list: document.querySelector("#dataset-list"),
  selectedCount: document.querySelector("#selected-count"),
  totalLabel: document.querySelector("#total-label"),
  buttonCount: document.querySelector("#button-count"),
  openButton: document.querySelector("#open-button"),
  openError: document.querySelector("#open-error"),
  selectAll: document.querySelector("#select-all"),
  selectNone: document.querySelector("#select-none"),
  filterTabs: [...document.querySelectorAll(".filter-tab")],
  filterEmpty: document.querySelector("#filter-empty"),
  allCount: document.querySelector("#all-count"),
  vectorCount: document.querySelector("#vector-count"),
  rasterCount: document.querySelector("#raster-count"),
};

let datasets = [];
let activeFilter = "all";

function selectedDatasets() {
  const selected = new Set(
    [...elements.list.querySelectorAll('input[type="checkbox"]:checked')].map((input) =>
      Number(input.value),
    ),
  );
  return datasets.filter((_dataset, index) => selected.has(index));
}

function updateSelection() {
  const count = selectedDatasets().length;
  elements.selectedCount.textContent = String(count);
  elements.totalLabel.textContent = `of ${datasets.length} selected`;
  elements.buttonCount.textContent = String(count);
  elements.openButton.disabled = count === 0;
  elements.openButton.setAttribute(
    "aria-label",
    count ? `Open ${count} dataset${count === 1 ? "" : "s"} in GeoLibre` : "Select a dataset",
  );
}

function updateFilter() {
  let visible = 0;
  for (const [index, option] of [...elements.list.children].entries()) {
    const show = activeFilter === "all" || datasets[index]?.kind === activeFilter;
    option.hidden = !show;
    if (show) visible += 1;
  }
  for (const tab of elements.filterTabs) {
    const active = tab.dataset.filter === activeFilter;
    tab.classList.toggle("is-active", active);
    tab.setAttribute("aria-pressed", String(active));
  }
  elements.filterEmpty.hidden = visible !== 0;
}

function renderDatasets(found) {
  datasets = found;
  elements.list.replaceChildren();
  for (const [index, dataset] of datasets.entries()) {
    const label = document.createElement("label");
    label.className = "dataset-option";
    label.dataset.kind = dataset.kind;
    label.title = dataset.url;

    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = String(index);
    input.checked = false;
    input.addEventListener("change", updateSelection);

    const copy = document.createElement("span");
    copy.className = "dataset-copy";
    const name = document.createElement("span");
    name.className = "dataset-name";
    // Naming the layer keeps several layers of one service apart, which their
    // shared endpoint URL cannot do.
    name.textContent = dataset.layer ? `${dataset.name}: ${dataset.layer}` : dataset.name;
    const host = document.createElement("span");
    host.className = "dataset-host";
    host.textContent = new URL(dataset.url).hostname;
    copy.append(name, host);

    const format = document.createElement("span");
    format.className = "format-badge";
    format.textContent = dataset.format;
    if (dataset.styleUrl) {
      const styleDot = document.createElement("span");
      styleDot.className = "style-dot";
      styleDot.textContent = " + style";
      format.append(styleDot);
      format.title = `Style: ${dataset.styleUrl}`;
    }
    label.append(input, copy, format);
    elements.list.append(label);
  }
  elements.loading.hidden = true;
  elements.empty.hidden = datasets.length !== 0;
  elements.results.hidden = datasets.length === 0;
  elements.allCount.textContent = String(datasets.length);
  elements.vectorCount.textContent = String(
    datasets.filter((dataset) => dataset.kind === "vector").length,
  );
  elements.rasterCount.textContent = String(
    datasets.filter((dataset) => dataset.kind === "raster").length,
  );
  updateFilter();
  updateSelection();
}

function showError(error) {
  elements.loading.hidden = true;
  elements.results.hidden = true;
  elements.empty.hidden = true;
  elements.error.hidden = false;
  elements.errorMessage.textContent =
    error instanceof Error && error.message
      ? error.message
      : "Chrome protects browser and extension pages from scanning.";
}

async function inspectPage() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url) throw new Error("No active webpage is available.");
  const pageUrl = new URL(tab.url);
  elements.pageHost.textContent = pageUrl.hostname || pageUrl.protocol;
  elements.pageHost.title = tab.url;
  let documentDatasets = [];
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: scanDocumentForDatasets,
    });
    documentDatasets = results[0]?.result ?? [];
  } catch (error) {
    console.debug("GeoLibre could not scan the current document.", error);
  }
  const key = `services:${tab.id}`;
  const stored = await chrome.storage.session.get(key);
  renderDatasets(mergeServiceCandidates(documentDatasets, stored[key] ?? []));
}

elements.selectAll.addEventListener("click", () => {
  for (const option of elements.list.querySelectorAll(".dataset-option:not([hidden])")) {
    option.querySelector('input[type="checkbox"]').checked = true;
  }
  updateSelection();
});

elements.selectNone.addEventListener("click", () => {
  for (const option of elements.list.querySelectorAll(".dataset-option:not([hidden])")) {
    option.querySelector('input[type="checkbox"]').checked = false;
  }
  updateSelection();
});

for (const tab of elements.filterTabs) {
  tab.addEventListener("click", () => {
    activeFilter = tab.dataset.filter;
    updateFilter();
  });
}

elements.openButton.addEventListener("click", async () => {
  elements.openError.hidden = true;
  try {
    const url = buildGeoLibreUrl(selectedDatasets());
    await chrome.tabs.create({ url });
    window.close();
  } catch (error) {
    elements.openError.textContent =
      error instanceof Error && error.message
        ? error.message
        : "GeoLibre could not be opened. Please try again.";
    elements.openError.hidden = false;
  }
});

void inspectPage().catch(showError);

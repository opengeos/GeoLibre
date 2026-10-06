import { loadBaseUrl, resetBaseUrl, saveBaseUrl } from "./base-url-settings.mjs";
import { GEOLIBRE_WEB_URL } from "./url-builder.mjs";

const elements = {
  form: document.querySelector("#settings-form"),
  baseUrl: document.querySelector("#base-url"),
  resetButton: document.querySelector("#reset-button"),
  status: document.querySelector("#status"),
};

function showStatus(message, tone) {
  elements.status.textContent = message;
  elements.status.dataset.tone = tone;
}

async function loadForm() {
  elements.baseUrl.value = await loadBaseUrl();
}

elements.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const href = await saveBaseUrl(elements.baseUrl.value);
    elements.baseUrl.value = href;
    showStatus("Saved.", "success");
  } catch (error) {
    showStatus(error instanceof Error ? error.message : "Could not save this URL.", "error");
  }
});

elements.resetButton.addEventListener("click", async () => {
  await resetBaseUrl();
  elements.baseUrl.value = GEOLIBRE_WEB_URL;
  showStatus("Reset to default.", "success");
});

void loadForm();

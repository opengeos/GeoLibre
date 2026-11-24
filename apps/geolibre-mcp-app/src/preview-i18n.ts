import { createInstance } from "i18next";
import { mcpPreview } from "../../geolibre-desktop/src/i18n/locales/en.json";

/** Preview messages share the desktop's English fallback catalog. */
export const previewI18n = createInstance();
void previewI18n.init({
  lng: "en",
  fallbackLng: "en",
  initAsync: false,
  resources: { en: { translation: { mcpPreview } } },
  interpolation: { escapeValue: false },
});

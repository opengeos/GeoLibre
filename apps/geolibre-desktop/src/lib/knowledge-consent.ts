/**
 * Shared consent gate for the Knowledge Cards (Wikipedia place info) tool.
 *
 * Opening a knowledge card sends the clicked/searched coordinate (and, when you
 * open a nearby article, its title) to Wikipedia's public API, so the user
 * acknowledges a one-time privacy notice before the first lookup. The
 * acknowledgment is a persisted per-device flag, mirroring the reverse-geocode
 * consent so every activation path is gated on it.
 */
export const KNOWLEDGE_CARD_CONSENT_KEY = "geolibre:knowledge-card-wikipedia-notice";

/** Whether the user has acknowledged the knowledge-card privacy notice. */
export function hasKnowledgeCardConsent(): boolean {
  try {
    return localStorage.getItem(KNOWLEDGE_CARD_CONSENT_KEY) === "1";
  } catch {
    // localStorage unavailable (private mode): treat as not acknowledged so the
    // notice is shown rather than silently sending coordinates.
    return false;
  }
}

/** Record that the user acknowledged the knowledge-card privacy notice. */
export function recordKnowledgeCardConsent(): void {
  try {
    localStorage.setItem(KNOWLEDGE_CARD_CONSENT_KEY, "1");
  } catch {
    // Ignore: the notice will simply show again next time.
  }
}

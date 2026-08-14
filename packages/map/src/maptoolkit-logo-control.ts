import type maplibregl from "maplibre-gl";

/** Where the logo links, and the brand name used for the tooltip/aria label. */
const MAPTOOLKIT_URL = "https://www.maptoolkit.org/";
const MAPTOOLKIT_LABEL = "Maptoolkit";

// The official Maptoolkit attribution mark (their hosted copy at
// maptoolkit.org/assets/maptoolkit-attribution.png), vendored as a static
// asset served from the app's own origin — apps/geolibre-desktop/public/ —
// rather than linked live, so the control keeps working offline and under
// the Tauri CSP without adding maptoolkit.org to its allowlist. Resolved from
// the app's base path (not a hardcoded `/`), matching CesiumCanvas's
// APP_BASE_URL, so it also resolves under a sub-path deploy (GEOLIBRE_APP_BASE,
// e.g. "/gis/") or a relative one ("./"). 227×72 source; Maptoolkit's
// attribution terms require the mark be shown at a minimum height of 24px,
// which the CSS pins.
const APP_BASE_URL =
  (import.meta as ImportMeta & { env?: { BASE_URL?: string } }).env?.BASE_URL ?? "/";
const MAPTOOLKIT_LOGO_URL = `${APP_BASE_URL}maptoolkit-attribution.png`;

/**
 * A MapLibre control that shows the Maptoolkit logo as a link back to
 * maptoolkit.org, mirroring MapLibre's own {@link maplibregl.LogoControl}.
 *
 * It is the branding/attribution companion to Maptoolkit basemaps added through
 * the basemap control: Maptoolkit's terms require their mark to be displayed on
 * maps that use their tiles/styles, so the Controls → Logos menu lets a user
 * turn it on once a Maptoolkit basemap is in use.
 */
export class MaptoolkitLogoControl implements maplibregl.IControl {
  private container: HTMLDivElement | null = null;
  private link: HTMLAnchorElement | null = null;
  private label = MAPTOOLKIT_LABEL;

  constructor(options: { label?: string } = {}) {
    if (options.label !== undefined) this.label = options.label;
  }

  onAdd(_map: maplibregl.Map): HTMLElement {
    const container = document.createElement("div");
    // Reuse maplibregl-ctrl so the logo inherits MapLibre's control margins and
    // sits in the chosen corner like the built-in logo does.
    container.className = "maplibregl-ctrl geolibre-maptoolkit-logo-ctrl";

    const link = document.createElement("a");
    link.className = "geolibre-maptoolkit-logo";
    link.href = MAPTOOLKIT_URL;
    link.target = "_blank";
    // noopener/nofollow match MapLibre's own logo link hygiene for an external,
    // user-agnostic branding link.
    link.rel = "noopener nofollow";

    const img = document.createElement("img");
    img.src = MAPTOOLKIT_LOGO_URL;
    img.width = 227;
    img.height = 72;
    // Decorative; the link itself carries the accessible name via title/aria-label.
    img.alt = "";
    link.appendChild(img);

    container.appendChild(link);
    this.container = container;
    this.link = link;
    this.applyLabel();

    return container;
  }

  onRemove(): void {
    this.container?.remove();
    this.container = null;
    this.link = null;
  }

  /** Update the tooltip/aria label, e.g. after a UI language change. */
  setLabel(label: string): void {
    this.label = label;
    this.applyLabel();
  }

  private applyLabel(): void {
    if (!this.link) return;
    this.link.title = this.label;
    this.link.setAttribute("aria-label", this.label);
  }
}

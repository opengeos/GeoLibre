/**
 * Surface colors for the on-map outputs (legend, colorbar, HTML) that the
 * Components GUI controls create, as live theme tokens so they follow the app
 * theme. The GUI controls' own `backgroundColor`/`fontColor` options style
 * only the editor panel.
 */
export const GEOLIBRE_GUI_OUTPUT_STYLE = {
  backgroundColor: "var(--geolibre-bg)",
  fontColor: "var(--geolibre-fg)",
} as const;

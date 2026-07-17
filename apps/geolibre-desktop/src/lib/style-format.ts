// Shared content sniffing for imported style files, so the LayerPanel's
// per-layer style import and the Style Manager's library import cannot drift
// on the detection heuristic.

/**
 * Whether an XML style document is a QGIS QML (as opposed to an OGC SLD): a
 * QML has a `<qgis>` or `<renderer-v2>` root element.
 *
 * @param text - The file content (already known to be XML).
 * @returns True for QGIS QML, false for other XML dialects (e.g. SLD).
 */
export function isQmlStyleXml(text: string): boolean {
  return /<qgis[\s>]|<renderer-v2[\s>]/.test(text);
}

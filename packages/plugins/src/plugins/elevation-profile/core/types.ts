import type { Feature, Geometry } from "geojson";

import type { LngLat } from "../elevation/geometry";
import type { UnitSystem } from "../elevation/format";
import type { NativeProfileMap } from "./native";

/** Corner of the map the control can dock to. */
export type ControlPosition = "top-left" | "top-right" | "bottom-left" | "bottom-right";

/** File-type hints for a host save dialog / browser download. */
export interface ExportFileOptions {
  /** Human-readable file-type label, e.g. "CSV". */
  description?: string;
  /** Allowed extensions without the leading dot, e.g. ["csv"]. */
  extensions?: string[];
  /** MIME type used for the browser download blob. */
  mimeType?: string;
  /**
   * Ask the user for a file name first on browsers without a native save
   * picker (Firefox/Safari), where the export would otherwise download under a
   * fixed name and silently overwrite/duplicate. No effect under Tauri or where
   * the File System Access picker already prompts for the name.
   */
  promptName?: boolean;
}

/**
 * Host text-file save callback. GeoLibre's `exportTextFile` implements this and
 * picks the right mechanism per runtime (a native save dialog under Tauri, a
 * browser download on the web).
 */
export type ExportTextFile = (
  filename: string,
  content: string,
  options?: ExportFileOptions,
) => void;

/** Options for configuring the {@link ElevationProfileControl}. */
export interface ElevationProfileControlOptions {
  /** Optional native renderer for profile geometry and terrain sampling. */
  nativeMap?: NativeProfileMap;
  /**
   * Hand the panel to a host dock instead of floating it over the map: the
   * panel is built but never appended to the map container (read it with
   * `getPanel()`), the toolbar button is hidden, and the floating header,
   * click-outside collapse and anchoring are skipped. @default false
   */
  docked?: boolean;
  /** Start collapsed (toggle button only). @default true */
  collapsed?: boolean;
  /** Title shown in the panel header. @default 'Elevation Profile' */
  title?: string;
  /** Panel width in pixels. @default 320 */
  panelWidth?: number;
  /** Initial unit system. @default 'metric' */
  unitSystem?: UnitSystem;
  /** Extra CSS class for the control container. */
  className?: string;
  /**
   * Maximum number of points sampled per elevation request. Capped at the
   * provider limit (100) internally. @default 100
   */
  maxSamples?: number;
  /**
   * Host text-file save (e.g. GeoLibre's `exportTextFile`). Used for the CSV and
   * SVG exports so they work under Tauri's native save dialog as well as in the
   * browser. Falls back to a browser download when not provided.
   */
  exportTextFile?: ExportTextFile;
  /** Read the features currently selected in the host application. */
  getSelectedFeatures?: () => Feature<Geometry | null>[];
  /** Subscribe to host selection changes. Returns a function that unsubscribes. */
  onSelectionChange?: (callback: () => void) => () => void;
  /**
   * Resolve the panel's text in the host language. Receives a key relative to
   * the control's namespace, the English text and any `{{placeholder}}`
   * values; English is used when omitted. Call
   * {@link ElevationProfileControl.refreshLabels} after a language change.
   */
  translate?: ElevationProfileTranslate;
}

/** Translation callback for the control's own UI text. */
export type ElevationProfileTranslate = (
  key: string,
  fallback: string,
  params?: Record<string, string | number>,
) => string;

/** Serializable state persisted with a GeoLibre project. */
export interface ElevationProfileState {
  /** Whether the panel is collapsed. */
  collapsed: boolean;
  /** Active unit system. */
  unitSystem: UnitSystem;
  /** The profiled line as `[lng, lat]` vertices, or `null` when none is drawn. */
  line: LngLat[] | null;
  /** Embedded elevations aligned with {@link line}, or null for sampled terrain. */
  elevations: number[] | null;
}

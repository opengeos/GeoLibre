import type { LngLat } from "../elevation/geometry";
import type { UnitSystem } from "../elevation/format";

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
}

/** Serializable state persisted with a GeoLibre project. */
export interface ElevationProfileState {
  /** Whether the panel is collapsed. */
  collapsed: boolean;
  /** Active unit system. */
  unitSystem: UnitSystem;
  /** The profiled line as `[lng, lat]` vertices, or `null` when none is drawn. */
  line: LngLat[] | null;
}

/** Structured renderer failure forwarded to the application's Diagnostics panel. */
export interface MapDiagnosticEvent {
  message: string;
  detail?: string;
  source?: string;
  status?: number;
  url?: string;
}

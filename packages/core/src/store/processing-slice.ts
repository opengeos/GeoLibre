/**
 * Saved processing models (issue #344) and the Processing History log
 * (issue #1292). Both are saved with the project.
 */
import { MAX_PROCESSING_HISTORY, type ProcessingModel, type ProcessingRun } from "../types";
import type { SliceCreator } from "./types";

export interface ProcessingSlice {
  /** Saved processing pipelines (batch/model chaining; issue #344). */
  models: ProcessingModel[];
  /** Recorded processing tool runs, oldest first (Processing History; #1292). */
  processingHistory: ProcessingRun[];

  /** Insert a new model or replace an existing one matching by `id`. */
  saveModel: (model: ProcessingModel) => void;
  /** Remove a saved model by id. */
  deleteModel: (id: string) => void;

  /** Append a processing run to the history (bounded, de-duped by id; #1292). */
  addProcessingRun: (run: ProcessingRun) => void;
  /** Patch a recorded run by id (no-op if absent), e.g. to add output layers. */
  updateProcessingRun: (id: string, patch: Partial<Omit<ProcessingRun, "id">>) => void;
  /** Drop all recorded processing runs. */
  clearProcessingHistory: () => void;
}

export const createProcessingSlice: SliceCreator<ProcessingSlice> = (set) => ({
  models: [],
  processingHistory: [],

  saveModel: (model) =>
    set((s) => {
      const exists = s.models.some((m) => m.id === model.id);
      const models = exists
        ? s.models.map((m) => (m.id === model.id ? model : m))
        : [...s.models, model];
      return { models, isDirty: true };
    }),
  deleteModel: (id) =>
    set((s) => ({
      models: s.models.filter((m) => m.id !== id),
      isDirty: true,
    })),

  addProcessingRun: (run) =>
    set((s) => {
      // Ignore a duplicate id so updateProcessingRun stays unambiguous.
      if (s.processingHistory.some((r) => r.id === run.id)) return s;
      const processingHistory = [...s.processingHistory, run].slice(-MAX_PROCESSING_HISTORY);
      return { processingHistory, isDirty: true };
    }),
  updateProcessingRun: (id, patch) =>
    set((s) => {
      if (!s.processingHistory.some((r) => r.id === id)) return s;
      return {
        processingHistory: s.processingHistory.map((r) =>
          r.id === id ? { ...r, ...patch, id: r.id } : r,
        ),
        isDirty: true,
      };
    }),
  clearProcessingHistory: () =>
    set((s) => (s.processingHistory.length === 0 ? s : { processingHistory: [], isDirty: true })),
});

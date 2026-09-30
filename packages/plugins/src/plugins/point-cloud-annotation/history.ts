// Undo/redo for per-point class edits. The app's store history snapshots layer
// records, which cannot hold millions of per-point codes, so the annotator
// keeps its own stack of deltas: the changed indices and their prior codes.

/** One class assignment, reversible. */
interface LabelEdit {
  cloudId: string;
  indices: Uint32Array;
  previous: Uint8Array;
  /** One code for every point, or one per point (a pre-label run). */
  next: number | Uint8Array;
}

/** The points an undo or redo changed. */
export interface LabelChange {
  cloudId: string;
  indices: Uint32Array;
}

/** Resolves a cloud id to its live classification array. */
export type ClassificationResolver = (cloudId: string) => Uint8Array | undefined;

/** A bounded undo/redo stack of class assignments. */
export class LabelHistory {
  private readonly undoStack: LabelEdit[] = [];
  private readonly redoStack: LabelEdit[] = [];

  /**
   * @param limit - Maximum number of edits kept for undo.
   */
  constructor(private readonly limit = 100) {}

  /**
   * Assigns `code` to `indices` and records the change for undo.
   *
   * @param cloudId - The point cloud being edited.
   * @param classifications - Its live classification array (mutated).
   * @param indices - Points to relabel.
   * @param code - The class code to assign.
   * @returns How many points actually changed class.
   */
  assign(cloudId: string, classifications: Uint8Array, indices: Uint32Array, code: number): number {
    const changed: number[] = [];
    const previous: number[] = [];
    for (const index of indices) {
      if (index >= classifications.length) continue;
      const before = classifications[index];
      if (before === code) continue;
      changed.push(index);
      previous.push(before);
      classifications[index] = code;
    }
    if (changed.length === 0) return 0;
    this.undoStack.push({
      cloudId,
      indices: Uint32Array.from(changed),
      previous: Uint8Array.from(previous),
      next: code,
    });
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack.length = 0;
    return changed.length;
  }

  /**
   * Assigns a different code to each point as one undoable edit (e.g. the
   * result of a pre-labelling tool).
   *
   * @param cloudId - The point cloud being edited.
   * @param classifications - Its live classification array (mutated).
   * @param indices - Points to relabel.
   * @param codes - The new code for each point, parallel to `indices`.
   * @returns How many points actually changed class.
   */
  assignEach(
    cloudId: string,
    classifications: Uint8Array,
    indices: Uint32Array,
    codes: Uint8Array,
  ): number {
    const changed: number[] = [];
    const previous: number[] = [];
    const next: number[] = [];
    indices.forEach((index, k) => {
      if (index >= classifications.length || classifications[index] === codes[k]) return;
      changed.push(index);
      previous.push(classifications[index]);
      next.push(codes[k]);
      classifications[index] = codes[k];
    });
    if (changed.length === 0) return 0;
    this.undoStack.push({
      cloudId,
      indices: Uint32Array.from(changed),
      previous: Uint8Array.from(previous),
      next: Uint8Array.from(next),
    });
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack.length = 0;
    return changed.length;
  }

  /**
   * Reverts the most recent edit.
   *
   * @param resolve - Looks up the live array for the edit's cloud.
   * @returns The cloud and points that changed, or null when nothing was undone.
   */
  undo(resolve: ClassificationResolver): LabelChange | null {
    const edit = this.undoStack.pop();
    if (!edit) return null;
    const classifications = resolve(edit.cloudId);
    if (classifications) {
      edit.indices.forEach((index, k) => {
        if (index < classifications.length) classifications[index] = edit.previous[k];
      });
    }
    this.redoStack.push(edit);
    return { cloudId: edit.cloudId, indices: edit.indices };
  }

  /**
   * Re-applies the most recently undone edit.
   *
   * @param resolve - Looks up the live array for the edit's cloud.
   * @returns The cloud and points that changed, or null when nothing was redone.
   */
  redo(resolve: ClassificationResolver): LabelChange | null {
    const edit = this.redoStack.pop();
    if (!edit) return null;
    const classifications = resolve(edit.cloudId);
    if (classifications) {
      const { next } = edit;
      edit.indices.forEach((index, k) => {
        if (index < classifications.length) {
          classifications[index] = typeof next === "number" ? next : next[k];
        }
      });
    }
    this.undoStack.push(edit);
    return { cloudId: edit.cloudId, indices: edit.indices };
  }

  /** Whether there is an edit to undo. */
  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  /** Whether there is an edit to redo. */
  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }
}

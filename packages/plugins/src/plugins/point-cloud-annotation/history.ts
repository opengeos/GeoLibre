// Undo/redo for per-point class edits. The app's store history snapshots layer
// records, which cannot hold millions of per-point codes, so the annotator
// keeps its own stack of deltas: the changed indices and their prior codes.

/** One class assignment, reversible. */
interface LabelEdit {
  cloudId: string;
  indices: Uint32Array;
  previous: Uint8Array;
  next: number;
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
   * Reverts the most recent edit.
   *
   * @param resolve - Looks up the live array for the edit's cloud.
   * @returns The id of the cloud that changed, or null when nothing was undone.
   */
  undo(resolve: ClassificationResolver): string | null {
    const edit = this.undoStack.pop();
    if (!edit) return null;
    const classifications = resolve(edit.cloudId);
    if (classifications) {
      edit.indices.forEach((index, k) => {
        if (index < classifications.length) classifications[index] = edit.previous[k];
      });
    }
    this.redoStack.push(edit);
    return edit.cloudId;
  }

  /**
   * Re-applies the most recently undone edit.
   *
   * @param resolve - Looks up the live array for the edit's cloud.
   * @returns The id of the cloud that changed, or null when nothing was redone.
   */
  redo(resolve: ClassificationResolver): string | null {
    const edit = this.redoStack.pop();
    if (!edit) return null;
    const classifications = resolve(edit.cloudId);
    if (classifications) {
      for (const index of edit.indices) {
        if (index < classifications.length) classifications[index] = edit.next;
      }
    }
    this.undoStack.push(edit);
    return edit.cloudId;
  }

  /** Whether there is an edit to undo. */
  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  /** Whether there is an edit to redo. */
  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** Number of points changed by all edits still on the undo stack. */
  get editedPointCount(): number {
    return this.undoStack.reduce((sum, edit) => sum + edit.indices.length, 0);
  }

  /** Drops every recorded edit. */
  clear(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
  }
}

// Undo/redo for per-point class and object edits. The app's store history
// snapshots layer records, which cannot hold millions of per-point codes, so
// the annotator keeps its own stack of deltas: the changed indices and their
// prior values.

/** One reversible edit of classes, object ids, or both. */
interface LabelEdit {
  cloudId: string;
  indices: Uint32Array;
  classes?: {
    previous: Uint8Array;
    /** One code for every point, or one per point (a pre-label run). */
    next: number | Uint8Array;
  };
  instances?: {
    previous: Uint32Array;
    /** One id for every point, or one per point. */
    next: number | Uint32Array;
  };
}

/** The points an undo or redo changed. */
export interface LabelChange {
  cloudId: string;
  indices: Uint32Array;
  /** Whether the edit changed object ids (not just classes). */
  instances: boolean;
}

/** Resolves a cloud id to its live classification array. */
export type ClassificationResolver = (cloudId: string) => Uint8Array | undefined;

/** Resolves a cloud id to its per-point object ids. */
export type InstanceResolver = (cloudId: string) => Uint32Array | undefined;

/** Object ids to set alongside a class assignment. */
export interface InstanceAssignment {
  /** The cloud's per-point object ids (mutated). */
  ids: Uint32Array;
  /** The object id to give every point (0 for none). */
  id: number;
}

/** A bounded undo/redo stack of class and object assignments. */
export class LabelHistory {
  private readonly undoStack: LabelEdit[] = [];
  private readonly redoStack: LabelEdit[] = [];

  /**
   * @param limit - Maximum number of edits kept for undo.
   */
  constructor(private readonly limit = 100) {}

  private push(edit: LabelEdit): void {
    this.undoStack.push(edit);
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  /**
   * Assigns `code` (and optionally an object id) to `indices` and records the
   * change for undo.
   *
   * @param cloudId - The point cloud being edited.
   * @param classifications - Its live classification array (mutated).
   * @param indices - Points to relabel.
   * @param code - The class code to assign.
   * @param instance - Object id to give the points as part of the same edit.
   * @returns How many points actually changed class or object.
   */
  assign(
    cloudId: string,
    classifications: Uint8Array,
    indices: Uint32Array,
    code: number,
    instance?: InstanceAssignment,
  ): number {
    const changed: number[] = [];
    const previous: number[] = [];
    const previousIds: number[] = [];
    for (const index of indices) {
      if (index >= classifications.length) continue;
      const before = classifications[index];
      const idBefore = instance && index < instance.ids.length ? instance.ids[index] : 0;
      if (before === code && (!instance || idBefore === instance.id)) continue;
      changed.push(index);
      previous.push(before);
      classifications[index] = code;
      if (instance && index < instance.ids.length) {
        previousIds.push(idBefore);
        instance.ids[index] = instance.id;
      } else if (instance) {
        previousIds.push(0);
      }
    }
    if (changed.length === 0) return 0;
    this.push({
      cloudId,
      indices: Uint32Array.from(changed),
      classes: { previous: Uint8Array.from(previous), next: code },
      ...(instance
        ? { instances: { previous: Uint32Array.from(previousIds), next: instance.id } }
        : {}),
    });
    return changed.length;
  }

  /**
   * Assigns one class to several groups of points and gives each group its
   * own new object id, as one undoable edit (e.g. one instance per SAM mask).
   *
   * @param cloudId - The point cloud being edited.
   * @param classifications - Its live classification array (mutated).
   * @param ids - Its per-point object ids (mutated).
   * @param groups - Point indices per new object; a point in several groups
   *   keeps the first.
   * @param code - The class code to assign.
   * @param firstId - Object id for the first non-empty group; later groups
   *   count up from it.
   * @returns How many points changed and how many objects were created.
   */
  assignGroups(
    cloudId: string,
    classifications: Uint8Array,
    ids: Uint32Array,
    groups: readonly Uint32Array[],
    code: number,
    firstId: number,
  ): { points: number; objects: number } {
    const changed: number[] = [];
    const previous: number[] = [];
    const previousIds: number[] = [];
    const nextIds: number[] = [];
    const seen = new Set<number>();
    let id = firstId;
    let objects = 0;
    for (const group of groups) {
      let used = false;
      for (const index of group) {
        if (index >= classifications.length || index >= ids.length || seen.has(index)) continue;
        seen.add(index);
        used = true;
        if (classifications[index] === code && ids[index] === id) continue;
        changed.push(index);
        previous.push(classifications[index]);
        previousIds.push(ids[index]);
        nextIds.push(id);
        classifications[index] = code;
        ids[index] = id;
      }
      if (used) {
        id++;
        objects++;
      }
    }
    if (changed.length === 0) return { points: 0, objects };
    this.push({
      cloudId,
      indices: Uint32Array.from(changed),
      classes: { previous: Uint8Array.from(previous), next: code },
      instances: { previous: Uint32Array.from(previousIds), next: Uint32Array.from(nextIds) },
    });
    return { points: changed.length, objects };
  }

  /**
   * Sets the object id of `indices` without changing their class (e.g. to
   * dissolve an object).
   *
   * @param cloudId - The point cloud being edited.
   * @param ids - Its per-point object ids (mutated).
   * @param indices - Points to change.
   * @param id - The object id to set (0 for none).
   * @returns How many points actually changed object.
   */
  setInstances(cloudId: string, ids: Uint32Array, indices: Uint32Array, id: number): number {
    const changed: number[] = [];
    const previous: number[] = [];
    for (const index of indices) {
      if (index >= ids.length || ids[index] === id) continue;
      changed.push(index);
      previous.push(ids[index]);
      ids[index] = id;
    }
    if (changed.length === 0) return 0;
    this.push({
      cloudId,
      indices: Uint32Array.from(changed),
      instances: { previous: Uint32Array.from(previous), next: id },
    });
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
    this.push({
      cloudId,
      indices: Uint32Array.from(changed),
      classes: { previous: Uint8Array.from(previous), next: Uint8Array.from(next) },
    });
    return changed.length;
  }

  /**
   * Reverts the most recent edit.
   *
   * @param resolve - Looks up the live class array for the edit's cloud.
   * @param resolveInstances - Looks up the per-point object ids.
   * @returns The cloud and points that changed, or null when nothing was undone.
   */
  undo(resolve: ClassificationResolver, resolveInstances?: InstanceResolver): LabelChange | null {
    const edit = this.undoStack.pop();
    if (!edit) return null;
    const classifications = edit.classes ? resolve(edit.cloudId) : undefined;
    const ids = edit.instances ? resolveInstances?.(edit.cloudId) : undefined;
    edit.indices.forEach((index, k) => {
      if (classifications && edit.classes && index < classifications.length) {
        classifications[index] = edit.classes.previous[k];
      }
      if (ids && edit.instances && index < ids.length) ids[index] = edit.instances.previous[k];
    });
    this.redoStack.push(edit);
    return { cloudId: edit.cloudId, indices: edit.indices, instances: Boolean(edit.instances) };
  }

  /**
   * Re-applies the most recently undone edit.
   *
   * @param resolve - Looks up the live class array for the edit's cloud.
   * @param resolveInstances - Looks up the per-point object ids.
   * @returns The cloud and points that changed, or null when nothing was redone.
   */
  redo(resolve: ClassificationResolver, resolveInstances?: InstanceResolver): LabelChange | null {
    const edit = this.redoStack.pop();
    if (!edit) return null;
    const classifications = edit.classes ? resolve(edit.cloudId) : undefined;
    const ids = edit.instances ? resolveInstances?.(edit.cloudId) : undefined;
    edit.indices.forEach((index, k) => {
      if (classifications && edit.classes && index < classifications.length) {
        const { next } = edit.classes;
        classifications[index] = typeof next === "number" ? next : next[k];
      }
      if (ids && edit.instances && index < ids.length) {
        const { next } = edit.instances;
        ids[index] = typeof next === "number" ? next : next[k];
      }
    });
    this.undoStack.push(edit);
    return { cloudId: edit.cloudId, indices: edit.indices, instances: Boolean(edit.instances) };
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

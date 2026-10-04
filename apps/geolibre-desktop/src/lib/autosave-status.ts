import type { TFunction } from "i18next";
import { MAX_SNAPSHOT_BYTES, type AddProjectSnapshotResult } from "./project-history-store";

/**
 * How one autosave tick ended. The store's own results, plus the two failures
 * the hook catches before reaching the store: a project too large to serialize
 * at all (V8's string-length cap), and any other error.
 */
export type AutosaveOutcome = AddProjectSnapshotResult | "unserializable" | "failed";

/**
 * Whether an attempt was skipped because the project is too large to keep.
 *
 * @param outcome How the attempt ended.
 * @returns True for the two size skips.
 */
export function isSizeSkip(outcome: AutosaveOutcome): boolean {
  return outcome === "too-large" || outcome === "unserializable";
}

/**
 * Whether autosave should read as paused after an attempt ends.
 *
 * Only a size skip pauses it, and only a stored (or already-stored) snapshot
 * resumes it. A generic failure (IndexedDB quota, a blocked database) is not a
 * size problem, so it leaves the indicator where it was rather than claiming
 * the project shrank or grew.
 *
 * @param previous Whether autosave was paused before this attempt.
 * @param outcome How the attempt ended.
 * @returns Whether autosave is paused after it.
 */
export function autosavePausedAfter(previous: boolean, outcome: AutosaveOutcome): boolean {
  if (isSizeSkip(outcome)) return true;
  if (outcome === "added" || outcome === "duplicate") return false;
  return previous;
}

/** Tracks the paused state across overlapping autosave attempts. */
export interface AutosaveStatusTracker {
  /**
   * Starts an attempt.
   *
   * @returns A token to pass to `settle` once the attempt ends.
   */
  begin(): number;
  /**
   * Records how an attempt ended. Ignored when a newer attempt has started or
   * `reset` ran since, so a slow write cannot overwrite a newer verdict.
   *
   * @param token The token `begin` returned for this attempt.
   * @param outcome How the attempt ended.
   * @param dirty Whether the project still has unsaved changes. A size skip
   *   that lands after a save is ignored: nothing unsaved is at risk.
   */
  settle(token: number, outcome: AutosaveOutcome, dirty?: boolean): void;
  /** Clears the paused state and drops every in-flight attempt. */
  reset(): void;
  /**
   * Reads the current state.
   *
   * @returns Whether autosave is currently paused.
   */
  paused(): boolean;
}

/**
 * Creates a tracker that reports paused-state changes through `onChange`.
 *
 * @param onChange Called with the new state whenever it changes.
 * @returns The tracker.
 */
export function createAutosaveStatusTracker(
  onChange: (paused: boolean) => void,
): AutosaveStatusTracker {
  let latest = 0;
  let paused = false;
  const set = (next: boolean) => {
    if (next === paused) return;
    paused = next;
    onChange(next);
  };
  return {
    begin() {
      latest += 1;
      return latest;
    },
    settle(token, outcome, dirty = true) {
      if (token !== latest) return;
      if (!dirty && isSizeSkip(outcome)) return;
      set(autosavePausedAfter(paused, outcome));
    },
    reset() {
      latest += 1;
      set(false);
    },
    paused: () => paused,
  };
}

/**
 * The full "autosave paused" explanation, shared by the status bar tooltip and
 * the Project History dialog so both quote the same limit.
 *
 * @param t The active translation function.
 * @param language The active language, for formatting the limit.
 * @returns The localized message.
 */
export function autosavePausedMessage(t: TFunction, language: string): string {
  return t("projectHistory.autosavePaused", {
    limit: new Intl.NumberFormat(language).format(MAX_SNAPSHOT_BYTES / (1024 * 1024)),
  });
}

/**
 * Tells the user once when autosave fails for a reason other than size (an
 * IndexedDB quota, a blocked database), and again only after a snapshot has
 * been stored since. Autosave runs a few seconds after every edit, so a toast
 * per failed attempt would repeat for as long as the cause lasts.
 *
 * @param onFirstFailure Shows the notice; called on the first failure of a run.
 * @returns A function to call with every attempt's outcome.
 */
export function createAutosaveFailureNotice(
  onFirstFailure: () => void,
): (outcome: AutosaveOutcome) => void {
  let told = false;
  return (outcome) => {
    if (outcome === "failed") {
      if (told) return;
      told = true;
      onFirstFailure();
    } else if (outcome === "added" || outcome === "duplicate") {
      told = false;
    }
  };
}

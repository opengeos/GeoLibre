/**
 * Shared title resolver + warning dedup used by the floating-panel and
 * right-panel registries.
 *
 * Both registries re-run a panel's title resolver on every read — the
 * accessors are called unmemoized in React render bodies. FloatingPanelCard
 * re-renders on every pointermove while a card is dragged or resized, and
 * PluginRightPanel mounts up to 4x for the dock slots. Without dedup, a
 * throwing or empty-returning resolver (e.g. a getter wired to an i18n key
 * that hasn't loaded yet, or one that's mistyped) would log on every read and
 * flood the console. This helper centralizes the resolve-or-fallback logic and
 * a per-id "already warned" set so the two registries stay in sync — they used
 * to duplicate this logic verbatim, which is how the dedup landed in one and
 * not the other.
 *
 * Each registry owns its own instance so a panel with the same id in two
 * registries does not share dedup state, and clears its instance on
 * register/unregister/test-reset so a fixed or replaced panel can surface a
 * later regression.
 */

/**
 * Structural constraint satisfied by both panel registration types: an id
 * plus a title that is either a literal string or a getter returning one.
 * Kept minimal so the helper does not depend on either concrete registration
 * type.
 */
interface PanelRegistrationWithTitle {
  id: string;
  title: string | (() => string);
}

export class PanelTitleResolver<T extends PanelRegistrationWithTitle> {
  // Title resolvers are kept in a side Map keyed by panel id rather than
  // stashed on the caller-supplied registration object, so the host never
  // mutates a plugin's object with an untyped hidden field. Both string
  // titles and getter functions normalize to a resolver here, captured at
  // registration time (re-register to swap a getter).
  private readonly resolvers = new Map<string, () => string>();
  // Panel ids whose title resolver already logged a throw or empty-string
  // warning. Mirrors the original loggedTitleWarnings set in
  // right-panel-registry; cleared on (re-)registration, unregister, and test
  // reset.
  private readonly warned = new Set<string>();
  private readonly label: string;

  constructor(label: string) {
    this.label = label;
  }

  /**
   * Register (or replace) a panel's title resolver. A string title is wrapped
   * in a constant function so the resolve path is uniform; a getter is stored
   * as-is. Clears any prior warning for this id so a rebuilt panel (e.g. one
   * whose title getter was fixed) can log again if its new resolver also
   * misbehaves.
   */
  set(panel: T): void {
    const resolve =
      typeof panel.title === "function"
        ? (panel.title as () => string)
        : () => panel.title as string;
    this.resolvers.set(panel.id, resolve);
    this.warned.delete(panel.id);
  }

  /** Remove a panel's resolver and clear its warning dedup (on unregister). */
  delete(id: string): void {
    this.resolvers.delete(id);
    this.warned.delete(id);
  }

  /** Clear all resolvers and warnings (test reset). */
  clear(): void {
    this.resolvers.clear();
    this.warned.clear();
  }

  /**
   * Resolve a panel's title to a string, returning a shallow clone whose
   * `.title` is always a string (never a getter) so the caller's original
   * registration object is never mutated. A throwing resolver, or one that
   * returns an empty string / non-string, degrades to the panel id and logs
   * at most once per registration — `set()` clears the dedup, so a re-registered
   * panel whose resolver still misbehaves logs again.
   */
  resolve(panel: T): T & { title: string } {
    const resolve = this.resolvers.get(panel.id);
    let resolved: string;
    try {
      // Both registries call set() before any resolve(), so the no-resolver
      // branch is unreachable from them. It guards direct use of this exported
      // class without a prior set(): a getter title must still be invoked
      // there, not stringified into its source code.
      resolved = resolve
        ? resolve()
        : typeof panel.title === "function"
          ? panel.title()
          : String(panel.title);
    } catch (error) {
      if (!this.warned.has(panel.id)) {
        this.warned.add(panel.id);
        console.error(`${this.label} "${panel.id}" title resolver threw.`, error);
      }
      resolved = panel.id;
    }
    // A resolver that returns "" (e.g. a mistyped i18n key whose value is
    // missing and the library falls back to empty) would otherwise render as a
    // blank header with no signal. Degrade to the panel id and warn so the
    // failure is visible. This is a render-time fallback, not a
    // registration-time check: the title may legitimately be empty before i18n
    // loads, and a later re-render once the key resolves will pick up the real
    // value. A non-string return (mistyped resolver) is covered by the same
    // branch for robustness.
    if (typeof resolved !== "string" || resolved.length === 0) {
      if (!this.warned.has(panel.id)) {
        this.warned.add(panel.id);
        console.warn(
          `${this.label} "${panel.id}" title resolver returned ${
            resolved === "" ? "an empty string" : "a non-string value"
          }; falling back to the panel id.`,
        );
      }
      resolved = panel.id;
    }
    return { ...panel, title: resolved };
  }
}

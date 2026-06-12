# Undo/Redo for Layer and Style Operations — Design

Issue: #269 — Add temporal (undo/redo) state over the layer + style slice of the Zustand store.

## Goal

Give the GeoLibre store an undo/redo history so accidental layer deletes and lost styles are recoverable. Track domain state (layers + basemap); exclude all transient UI state. Wire Ctrl/Cmd-Z / Ctrl/Cmd-Shift-Z and toolbar buttons. Undo must reconcile MapLibre through the normal sync path, not by mutating the map.

## Scope

**Tracked in history** (restored on undo/redo): `layers`, `basemapStyleUrl`, `basemapVisible`, `basemapOpacity`.

**Excluded from history** (changes never create entries): everything else, including `selectedLayerId`, `selectedFeatureId`, `identifyLayerId`, `pointerCoords`, `attributeFilter`, `recentProjects`, the `ui` dialog/panel flags, `mapView` (camera pan/zoom/bearing/pitch), `projectName`, `preferences`, `metadata`, `projectPlugins`, `isDirty`, `projectPath`, `projectGeneration`.

Out of scope for v1: undoing project-name/preferences/metadata/plugin changes, camera moves, and any saved-snapshot dirty tracking (see isDirty below).

## Approach: `zundo` temporal middleware

`zundo` (v2.3.0, compatible with Zustand 5.x) wraps the store creator and maintains `pastStates`/`futureStates`. Chosen over a hand-rolled snapshot stack or a `subscribe`-based snapshotter because its `partialize` + `equality` options map directly onto the track/exclude requirement and it handles the undo-doesn't-record-itself bookkeeping.

## Architecture

### 1. Store wiring (`packages/core/src/store.ts`)

Wrap the existing creator with `temporal`:

```ts
import { temporal } from "zundo";
import { shallow } from "zustand/shallow";

export const useAppStore = create<AppState>()(
  temporal(
    (set, get) => ({ /* unchanged state + actions */ }),
    {
      partialize: (s) => ({
        layers: s.layers,
        basemapStyleUrl: s.basemapStyleUrl,
        basemapVisible: s.basemapVisible,
        basemapOpacity: s.basemapOpacity,
      }),
      equality: shallow,
      limit: 100,
      handleSet: (handleSet) => leadingDebounce(handleSet, historyCoalesceMs),
    },
  ),
);
```

- `partialize`: only the four tracked fields are snapshotted and restored.
- `equality: shallow`: a `set` that leaves the partialized object shallow-equal (e.g. only `selectedLayerId`, a `ui` flag, or `mapView` changed) creates **no** history entry. This is what enforces "exclude transient state." A change to `layers` (new array ref from add/remove/reorder/update/style) or any basemap field is not shallow-equal, so it records.
- `limit: 100`: caps stack depth.
- `handleSet`: leading-edge debounce groups bursts of rapid `set`s (a continuous opacity/style slider drag) into one history entry capturing the pre-burst state. `historyCoalesceMs` defaults to 400 (see test seam).

`useAppStore.temporal` is the temporal vanilla store: `{ pastStates, futureStates, undo(), redo(), clear(), ... }`.

### 2. History helpers (`packages/core/src/history.ts`, new)

```ts
let historyCoalesceMs = 400;
export function setHistoryCoalesceMs(ms: number): void { historyCoalesceMs = ms; }
export function getHistoryCoalesceMs(): number { return historyCoalesceMs; }

/** Leading-edge debounce: fires on the first call of a burst, suppresses the
 *  rest until `getWait()` ms of quiet. wait<=0 -> pass-through (records every
 *  call). */
export function leadingDebounce<F extends (...a: any[]) => void>(
  fn: F, getWait: () => number,
): (...a: Parameters<F>) => void { /* timer-based impl */ }
```

`store.ts` passes `() => historyCoalesceMs` to `leadingDebounce` so tests can flip the window at runtime.

Undo/redo helpers (also in `history.ts`, exported from the package index):

```ts
export function undo(): void {
  useAppStore.temporal.getState().undo();
  useAppStore.setState({ isDirty: true });
}
export function redo(): void {
  useAppStore.temporal.getState().redo();
  useAppStore.setState({ isDirty: true });
}
export function clearHistory(): void {
  useAppStore.temporal.getState().clear();
}
```

`setState({ isDirty: true })` changes only an excluded field, so (with `equality: shallow`) it creates no history entry and cannot loop. zundo flags its own undo/redo `set`s so they are not re-recorded.

### 3. isDirty

Per decision: undo/redo set `isDirty = true` (simple and safe — worst case the user re-saves an unchanged project). No saved-snapshot tracking in v1.

### 4. History reset on project lifecycle

`newProject()` and `loadProject()` call `clearHistory()` after applying their state, so an opened/created project starts with an empty undo stack. (They reference the module-level `useAppStore.temporal`, which is assigned by the time these actions run.)

### 5. Map reconciliation

No new wiring. `MapCanvas` already has `useEffect`s keyed on `layers`, `basemapVisible`, `basemapOpacity`, and `basemapStyleUrl`. An undo/redo restores those slices (new `layers` ref), so the existing effects fire `MapController.waitAndSyncLayers` / basemap setters. The map reconciles through the normal sync path; it is never mutated directly by the history layer.

### 6. Keyboard shortcuts (`apps/geolibre-desktop/src/hooks/useUndoRedoShortcuts.ts`, new)

A hook adding a `window` `keydown` listener, mounted once at the app shell:

- `Ctrl/Cmd+Z` (no Shift) → `undo()`
- `Ctrl/Cmd+Shift+Z` → `redo()`
- `Ctrl+Y` → `redo()` (Windows-style alias)
- Ignored when the event target is an `input`, `textarea`, `select`, or `contenteditable` element (so undo in a text field is the browser's).
- `preventDefault()` on handled combos.

### 7. Toolbar buttons (`TopToolbar.tsx`)

Undo and Redo buttons (lucide `Undo2` / `Redo2`) with tooltips ("Undo (Ctrl+Z)" / "Redo (Ctrl+Shift+Z)"). Enabled state from the temporal store:

```ts
const canUndo = useStore(useAppStore.temporal, (s) => s.pastStates.length > 0);
const canRedo = useStore(useAppStore.temporal, (s) => s.futureStates.length > 0);
```

Buttons call `undo()` / `redo()`; disabled when the respective stack is empty.

## Data flow

1. A layer/style/basemap action calls `set(...)`, changing a tracked field.
2. zundo's `handleSet` (leading debounce) pushes the previous partialized state onto `pastStates` (grouping bursts) and clears `futureStates`.
3. User triggers undo (key or button) → `undo()` → `temporal.undo()` restores the previous partialized slice via the store's `set`, then `isDirty=true`.
4. The restored `layers`/basemap refs change → `MapCanvas` effects → `syncLayers`/basemap setters reconcile the map and layer control.

## Error handling / edge cases

- Undo/redo with an empty stack: zundo no-ops; buttons are disabled and the key handler still calls the no-op safely.
- Rapid distinct actions within the debounce window may coalesce (acceptable tradeoff for slider grouping); deliberate clicks are far enough apart in practice.
- Loading/creating a project clears history so you cannot undo across a project boundary.

## Testing

`tests/undo-redo.test.ts` (node `--test`, `setHistoryCoalesceMs(0)` in `beforeEach` for deterministic one-entry-per-action; `newProject` to reset):

- Add two layers, remove one → `undo()` restores it with identical style and stack position; `redo()` removes it again.
- `setLayerStyle` edit → `undo()` restores prior style; `redo()` reapplies.
- `reorderLayer`/`moveLayer` → `undo()` restores original order.
- Basemap visibility/opacity/style change → undo/redo round-trips.
- Changing `selectedLayerId`, a `ui` flag, and `mapView` each leave `useAppStore.temporal.getState().pastStates.length` unchanged.
- `undo()`/`redo()` set `isDirty=true`.
- `newProject()`/`loadProject()` empties `pastStates`/`futureStates`.

`tests/history-debounce.test.ts` (or a block in the same file): unit-test `leadingDebounce` — first call of a burst invokes immediately, subsequent calls within the window are suppressed, a call after quiet invokes again, and `wait<=0` passes every call through.

## File structure

- `packages/core/package.json` — add `zundo` dependency.
- `packages/core/src/store.ts` — wrap creator in `temporal(...)`; call `clearHistory()` in `newProject`/`loadProject`.
- `packages/core/src/history.ts` (new) — `leadingDebounce`, `historyCoalesceMs` config, `undo`/`redo`/`clearHistory`.
- `packages/core/src/index.ts` — export the history helpers + `setHistoryCoalesceMs`.
- `apps/geolibre-desktop/src/hooks/useUndoRedoShortcuts.ts` (new) — keyboard hook.
- App shell (where other top-level hooks mount) — mount `useUndoRedoShortcuts()`.
- `apps/geolibre-desktop/src/components/layout/TopToolbar.tsx` — Undo/Redo buttons.
- `tests/undo-redo.test.ts`, debounce unit test — coverage.

## Dependencies

- `zundo@^2.3.0` (peer: zustand 5, already present).

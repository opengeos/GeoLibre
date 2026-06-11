# Layer Rename + Load Button Border Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add inline layer renaming to the Layers panel and stop the Add Vector Layer "Load" button focus ring from being clipped on its right edge.

**Architecture:** Pure GeoLibre frontend change. Renaming reuses the existing `updateLayer(id, patch)` store action driven by new local edit state in `LayerPanel.tsx`; the Load button fix is a scoped CSS override in `index.css`. No store, schema, or map-sync changes.

**Tech Stack:** React + TypeScript, Zustand store (`@geolibre/core`), shadcn-style `@geolibre/ui` primitives, lucide-react icons, Tailwind CSS.

**Scope:** This is GeoLibre PR #1 of the spec at `docs/superpowers/specs/2026-06-11-layer-panel-rename-and-vector-refresh-design.md`. Part 3 (Add-Vector-Layer auto refresh) is deferred to a later upstream release + second PR and is NOT in this plan.

**Testing reality:** The frontend test harness (`npm run test:frontend`, `node --test`) runs logic-level tests with no React component renderer, so these UI/CSS changes are verified by `npm run typecheck` plus manual verification in the running web app (`npm run dev`). There is no meaningful pure-logic unit to TDD beyond the already-covered `updateLayer` store action.

**Branch:** Create a feature branch before the first commit (never commit to `main`). Suggested: `feat/layer-rename-and-load-button-fix`.

---

### Task 0: Create the feature branch

- [ ] **Step 1: Branch off main**

Run:
```bash
git checkout -b feat/layer-rename-and-load-button-fix
```
Expected: `Switched to a new branch 'feat/layer-rename-and-load-button-fix'`

---

### Task 1: Add `Pencil` icon import and rename edit state

**Files:**
- Modify: `apps/geolibre-desktop/src/components/panels/LayerPanel.tsx` (imports ~line 34-52; component state ~line 162-180)

- [ ] **Step 1: Add the `Pencil` icon to the lucide-react import block**

In the `lucide-react` import (currently lines 34-52), add `Pencil` in alphabetical order between `PanelLeftOpen` and `PencilRuler`:

```tsx
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  PencilRuler,
  RefreshCw,
```

- [ ] **Step 2: Add rename edit state next to the other `useState` hooks**

Immediately after the `updateLayer` selector (line 162) and before `metadataLayer` state, add:

```tsx
  const [editingLayerId, setEditingLayerId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
```

- [ ] **Step 3: Add rename helper callbacks**

After the existing `resetDragState` definition (around line 213-216), add three helpers:

```tsx
  const beginRename = (layer: GeoLibreLayer) => {
    setEditingLayerId(layer.id);
    setEditingName(layer.name);
  };

  const commitRename = () => {
    if (!editingLayerId) return;
    const trimmed = editingName.trim();
    const current = layers.find((l) => l.id === editingLayerId);
    if (trimmed && current && trimmed !== current.name) {
      updateLayer(editingLayerId, { name: trimmed });
    }
    setEditingLayerId(null);
    setEditingName("");
  };

  const cancelRename = () => {
    setEditingLayerId(null);
    setEditingName("");
  };
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: build succeeds with no new type errors (unused `beginRename`/`commitRename`/`cancelRename` are referenced in Task 2, so if typecheck flags them as unused here, proceed to Task 2 before re-checking — or complete Tasks 1 and 2 before the first typecheck).

- [ ] **Step 5: Commit**

```bash
git add apps/geolibre-desktop/src/components/panels/LayerPanel.tsx
git commit -m "feat(layers): add rename edit state and Pencil icon to layer panel"
```

---

### Task 2: Render the name as an inline editable input + double-click trigger

**Files:**
- Modify: `apps/geolibre-desktop/src/components/panels/LayerPanel.tsx` (name span ~line 610-612)

- [ ] **Step 1: Replace the static name span with a conditional input/span**

Replace the current name span (lines 610-612):

```tsx
                  <span className="flex-1 truncate text-sm font-medium">
                    {layer.name}
                  </span>
```

with:

```tsx
                  {editingLayerId === layer.id ? (
                    <input
                      autoFocus
                      type="text"
                      className="flex-1 min-w-0 rounded border border-input bg-background px-1 py-0.5 text-sm font-medium outline-none focus:ring-1 focus:ring-ring"
                      value={editingName}
                      aria-label={`Rename ${layer.name}`}
                      onChange={(e) => setEditingName(e.target.value)}
                      onClick={(e: ReactMouseEvent) => e.stopPropagation()}
                      onFocus={(e) => e.currentTarget.select()}
                      onBlur={commitRename}
                      onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.key === "Enter") {
                          e.preventDefault();
                          commitRename();
                        } else if (e.key === "Escape") {
                          e.preventDefault();
                          cancelRename();
                        }
                      }}
                    />
                  ) : (
                    <span
                      className="flex-1 truncate text-sm font-medium"
                      title="Double-click to rename"
                      onDoubleClick={(e: ReactMouseEvent) => {
                        e.stopPropagation();
                        beginRename(layer);
                      }}
                    >
                      {layer.name}
                    </span>
                  )}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: build succeeds, no type errors. `beginRename`/`commitRename`/`cancelRename` are now all referenced.

- [ ] **Step 3: Manual verification in the running app**

Run: `npm run dev` then open http://localhost:5173. Add any layer (e.g. the sample places plugin). Then verify:
- Double-click the layer name → it becomes a text input with all text selected.
- Type a new name, press Enter → the name updates in the panel.
- Double-click again, change text, press Escape → reverts to the prior name.
- Double-click, clear the field, click elsewhere (blur) → name stays unchanged (empty no-op).
- Clicking the input does not toggle layer selection or start a drag.

- [ ] **Step 4: Commit**

```bash
git add apps/geolibre-desktop/src/components/panels/LayerPanel.tsx
git commit -m "feat(layers): rename layer by double-clicking its name"
```

---

### Task 3: Add a "Rename" item to the per-layer "..." dropdown menu

**Files:**
- Modify: `apps/geolibre-desktop/src/components/panels/LayerPanel.tsx` (dropdown content ~line 772-776)

- [ ] **Step 1: Add a Rename menu item at the top of the dropdown content**

Inside `<DropdownMenuContent align="end" ...>` (opens at line 772), insert as the FIRST child, before the `{canMaterializeDuckDB && (` block (line 776):

```tsx
                      <DropdownMenuItem
                        onSelect={(e: Event) => {
                          e.preventDefault();
                          beginRename(layer);
                        }}
                      >
                        <Pencil className="mr-2 h-3.5 w-3.5" />
                        Rename
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: build succeeds, no type errors.

- [ ] **Step 3: Manual verification**

In the running app: open a layer's `...` menu → click **Rename** → the name field becomes an editable input focused with text selected. Enter commits, Escape cancels. Confirm the dropdown closes when Rename is chosen.

- [ ] **Step 4: Commit**

```bash
git add apps/geolibre-desktop/src/components/panels/LayerPanel.tsx
git commit -m "feat(layers): add Rename action to layer actions menu"
```

---

### Task 4: Fix the clipped Load button focus ring in the Add Vector Layer panel

**Files:**
- Modify: `apps/geolibre-desktop/src/index.css` (append a scoped override near the existing `.geolibre-vector-panel` theming block, after line ~1876)

**Why:** The upstream `.vector-control-button:focus` uses `outline: 2px solid; outline-offset: 2px`. The button sits flush against the right edge of `.vector-control-content`, whose `overflow-y: auto` forces `overflow-x` to clip, cutting off the right side of the ring. The fix gives the ring horizontal room inside the clip box. Never edit `node_modules` (repo convention).

- [ ] **Step 1: Append the scoped override**

After the dark-theme vector block that ends at line 1876 (`}` closing `.dark .vector-control...`), append:

```css
/* The panel content scrolls vertically (overflow-y: auto), which forces
   overflow-x to clip and cuts off the Load button's offset focus ring on
   the right edge. Give the scroll area a little horizontal breathing room
   so the ring is not clipped. */
.vector-control-panel.geolibre-vector-panel .vector-control-content {
  padding-left: 3px;
  padding-right: 3px;
}
```

- [ ] **Step 2: Typecheck/build (CSS is bundled by Vite)**

Run: `npm run typecheck`
Expected: build succeeds.

- [ ] **Step 3: Manual verification (light and dark)**

In the running app: open Plugins → Add Vector Layer (or the vector control). Click into the URL field, then click/focus the **Load** button. Confirm the full focus ring renders on all four sides, including the right edge, with no clipping. Toggle dark mode (Settings) and re-check. Confirm the URL input and Load button are not visually cramped by the added padding.

- [ ] **Step 4: If 3px padding is insufficient or looks cramped, adjust**

If the right edge is still clipped, increase to `padding-left/right: 4px`. If the row feels cramped, instead reduce the ring offset by adding to the same override block:

```css
.vector-control-panel.geolibre-vector-panel .vector-control-url-row .vector-control-button:focus {
  outline-offset: 1px;
}
```

Re-verify per Step 3. Keep whichever single approach reads cleanest; do not ship both unless both are needed.

- [ ] **Step 5: Commit**

```bash
git add apps/geolibre-desktop/src/index.css
git commit -m "fix(vector): stop Load button focus ring from being clipped"
```

---

### Task 5: Pre-push gate and PR

**Files:** none (process)

- [ ] **Step 1: Run the scoped pre-commit hook on the changed files**

Run:
```bash
pre-commit run --files apps/geolibre-desktop/src/components/panels/LayerPanel.tsx apps/geolibre-desktop/src/index.css docs/superpowers/specs/2026-06-11-layer-panel-rename-and-vector-refresh-design.md docs/superpowers/plans/2026-06-11-layer-rename-and-load-button-fix.md
```
Expected: hooks pass (the local `npm-build` hook compiles the app). Fix any reported issues and re-run.

- [ ] **Step 2: Full typecheck once more**

Run: `npm run typecheck`
Expected: build succeeds.

- [ ] **Step 3: Push and open the PR**

Run:
```bash
git push -u origin feat/layer-rename-and-load-button-fix
```
Then open a PR as `giswqs` against `main`. PR body: summarize layer rename (double-click + Rename menu item) and the Load button focus-ring fix; note Part 3 (Add-Vector-Layer auto refresh) is tracked separately and lands after the upstream `reloadLayer()` release.

---

## Self-Review notes

- **Spec coverage:** Part 1 (rename) → Tasks 1-3. Part 2 (Load button) → Task 4. Part 3 is explicitly out of scope for this plan (deferred per the split-delivery decision).
- **Type consistency:** `beginRename(layer)`, `commitRename()`, `cancelRename()`, `editingLayerId`, `editingName` are defined in Task 1 and used in Tasks 2-3 with matching signatures.
- **No placeholders:** every code step shows the exact code; Task 4 Step 4 is a conditional adjustment with concrete alternatives, not a placeholder.

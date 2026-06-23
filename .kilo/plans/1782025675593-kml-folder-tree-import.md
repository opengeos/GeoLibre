# KML/KMZ Import with Folder Structure Dialog

## Goal
When importing KML/KMZ files, show a tree dialog displaying the Document/Folder/Placemark hierarchy. Users select which folders/geometries to import. Each selected KML folder becomes a `LayerGroup` with true hierarchical nesting in the layer panel.

## Two-Phase Structure
**Phase 1** extends the core layer-group system to support nesting. **Phase 2** builds the KML dialog on top of Phase 1. Phases are sequential — Phase 2 cannot start until Phase 1 passes `npm run test:frontend`.

---

## Phase 1 — Recursive Layer Groups

### Files to Modify

#### 1. `packages/core/src/types.ts`
- Add `parentGroupId?: string` to `LayerGroup`
- Replace `"single-level nesting; groups never contain other groups"` comment with `"Groups can nest via parentGroupId"`

#### 2. `packages/core/src/layer-groups.ts`
- **`LayerTreeItem`** type: `children` changes from `GeoLibreLayer[]` to `LayerTreeItem[]`
- **`buildLayerTree(layers, groups)`**: recursive tree construction. For each top-level group, gather its direct child layers AND direct child sub-groups recursively. Each sub-group node contains its own `LayerTreeItem[]` children. Empty sub-groups appear inside their parent's node. Returns `LayerTreeItem[]` at the root.
- **`applyGroupEffects(layers, groups)`**: walk the ancestor chain for each layer: `effective.visible = layer.visible && g1.visible && g2.visible && ...`, `effective.opacity = layer.opacity * g1.opacity * g2.opacity * ...`
- **`normalizeGroupContiguity(layers)`**: ensure that for every group, all layers belonging to it AND all layers belonging to any descendant sub-group form one contiguous top-level block. Within each block, sub-group layers are contiguous sub-blocks anchored at the first member encountered.
- **`groupMemberIndices(layers, groupId)`**: unchanged — returns direct children only. Callers needing all descendants call it recursively.

#### 3. `packages/core/src/store.ts`
- **`addLayerGroup(name?, layerIds?, parentGroupId?)`**: if `parentGroupId` given, validate it exists. Place the new group's block after the parent's last member in the flat layers array.
- **`removeLayerGroup(id, { removeChildren? })`**: default (`removeChildren: false`) ungroups direct child layers AND makes sub-groups top-level (`parentGroupId = undefined`). `removeChildren: true` cascades removal to all descendant sub-groups and layers.
- **`renameLayerGroup`, `setLayerGroupVisibility`, `setLayerGroupOpacity`, `toggleLayerGroupCollapsed`**: unchanged.
- **`moveLayerToGroup(layerId, groupId, beforeLayerId?)`**: validate `groupId` is not a descendant of the layer's current group (prevent cycles). Insert layer into target group's contiguous block.
- **`reorderLayerGroup(id, direction)`**: scope neighbors to siblings within the same `parentGroupId`. A sub-group swaps only with other sub-groups/layers at the same nesting level inside its parent.

#### 4. `packages/core/src/project.ts`
- **`normalizeLayerGroups(value)`**: validate `parentGroupId` references exist; detect cycles.
- **`parseProject`** / **`applyProjectToStore`**: round-trip `parentGroupId`.

#### 5. `apps/geolibre-desktop/src/components/panels/LayerPanel.tsx`
- Replace flat `visibleLayers.map()` loop with recursive `renderTreeItems(items: LayerTreeItem[], depth: number)`.
- Group header indentation: `ml-[depth * 16px]`. Layer card indentation: `ml-[(depth + 1) * 16px]` when inside a group.
- Collapse/expand, visibility toggle, opacity slider, rename, actions menu all remain per-group.
- Drag-drop: `handleGroupHeaderDragOver`/`handleGroupHeaderDrop` work for any group regardless of depth. `handleLayerDrop` respects group boundaries.
- "Move to group" submenu renders as a tree of groups.
- Empty groups (including empty sub-groups) rendered at their tree position.
- `groupHidden` check walks ancestor chain.

#### 6. `tests/layer-groups.test.ts`
- Add tests: `buildLayerTree` with nested groups, `applyGroupEffects` ancestor chain multiplication, `normalizeGroupContiguity` with sub-groups, `removeLayerGroup` cascade, `addLayerGroup` with parentGroupId, `reorderLayerGroup` at nesting level, serialization round-trip with parentGroupId.
- Verify all existing tests still pass.

### Phase 1 Validation
```bash
npm run test:frontend                          # all tests including layer-groups.test.ts
npm run typecheck                              # build check
```

### Phase 1 Design Decisions
| Decision | Choice |
|----------|--------|
| Nesting field | `parentGroupId?: string` on `LayerGroup` |
| Tree representation | Recursive `LayerTreeItem.children: LayerTreeItem[]` |
| `applyGroupEffects` nesting | Multiply visibility/opacity up ancestor chain |
| `removeLayerGroup` default | Sub-groups become top-level; `{ removeChildren: true }` cascades |
| `addLayerGroup` position in parent | After parent's last member in flat array |
| `reorderLayerGroup` scope | Siblings only — same `parentGroupId` |
| Backward compat | `parentGroupId` optional — existing flat groups are top-level, zero migration |

---

## Phase 2 — KML Tree Import Dialog

### Entry Points
1. **New "KML/KMZ" menu item** under Files in the Add Data dropdown — opens `KmlImportDialog` with file picker
2. **Drag-drop intercept** in DesktopShell — detects `.kml`/`.kmz` files, opens dialog with pre-loaded data

The existing "Add Vector Layer" plugin panel (`maplibre-vector`) is **not changed**.

### Files to Create/Modify

#### 7. `apps/geolibre-desktop/src/lib/kml.ts` — Tree Parser

No changes to existing `parseKmlText()`.

**New exports:**

```ts
interface KmlTreeNode {
  id: string
  type: 'Document' | 'Folder' | 'Placemark'
  name: string
  children: KmlTreeNode[]
  checked: boolean
  indeterminate: boolean
  depth: number
  featureCount: number
  geometry?: Geometry
  properties?: GeoJsonProperties
}

/** Parses KML XML and builds a Document/Folder/Placemark tree. Styles collected globally. */
function parseKmlTree(text: string): KmlTreeNode[]

/** Walks checked nodes, groups Placemarks by nearest checked ancestor container path. */
function collectSelectedFeatures(
  nodes: KmlTreeNode[]
): Array<{ containerPath: string[]; features: Feature[] }>
```

`containerPath` is the chain of container names from root to the checked container (e.g., `["Los Daun 2025-26", "Gemeinden", "Daun - 71"]`). Root-level Placemarks with no checked container ancestor get `[]`. Used to build hierarchical `LayerGroup` names and parent relationships on import.

#### 8. `apps/geolibre-desktop/src/lib/tauri-io.ts` — KMZ doc.kml Extractor

**New export:**
```ts
export async function extractDocKmlFromKmz(data: ArrayBuffer | Uint8Array): Promise<string>
```
Unzips via `fflate.unzip()`, finds `doc.kml` (case-insensitive), decodes with `TextDecoder("utf-8")`. Throws `"The KMZ archive does not contain a doc.kml file."` if missing.

#### 9. `apps/geolibre-desktop/src/components/layout/KmlImportDialog.tsx` (NEW)

**Props:**
```ts
interface KmlImportDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  mapControllerRef: RefObject<MapController | null>
  initialData?: { fileName: string; rawData: string; binaryData?: ArrayBuffer }[]
}
```

**Dialog states:**
1. **File picker** (no `initialData`): "Choose File" button → `openLocalDataFileWithFallback({ accept: ".kml,.kmz", readText: true, readBinary: true })`. Extension check: `.kmz` → `extractDocKmlFromKmz(binaryData)`.
2. **Tree display**: parsed via `parseKmlTree(text)`. Multi-file drops → each file is a synthetic root `KmlTreeNode`.
3. **Submit**: calls `collectSelectedFeatures(nodes)` → for each group creates layers + LayerGroups with parentGroupId.

**Tree UI (recursive render):**
- Indentation: `paddingLeft: depth * 20px`
- Chevron expand/collapse for containers with children; toggles `expanded` Set
- Tri-state checkbox: checked / indeterminate / unchecked; click toggles self + descendants, recalculates ancestors
- Icons: `FolderOpen`/`Folder` for containers, `MapPin` for Placemarks
- Labels: `<name>` text; fallback `"Unnamed Placemark"` for unnamed Placemarks
- **Editable names**: inline `<input>` on double-click for folder/Document nodes and the file root node (edits the in-memory tree node name, which is used as the imported layer group name)
- Badge: `(N)` for containers with N > 0
- Scroll: `max-h-[60vh] overflow-y-auto`
- Initial state: all checked, depth ≤ 1 expanded, deeper collapsed

**Header:** "Select All" / "Deselect All" buttons, file name(s) display

**Error display:** below tree, for XML parse errors, empty KML, KMZ without doc.kml

**Submit logic:**
```
collectSelectedFeatures(nodes)
  → for each { containerPath, features }:
    1. Create GeoLibreLayer per feature group with name = containerPath[last]
    2. Create LayerGroup with name = containerPath[last], direct parent layers
    3. Build hierarchy: walk containerPath to create nested LayerGroups
       with parentGroupId pointing to the parent group
    4. store.addLayerGroup(name, layerIds, parentGroupId)
  → fitBounds on combined extent
  → close dialog
```

Example for `["Los Daun 2025-26", "Gemeinden", "Daun - 71"]`:
- Layer group "Daun - 71" with parentGroupId = "Gemeinden" group's id
- "Gemeinden" group with parentGroupId = "Los Daun 2025-26" group's id
- "Los Daun 2025-26" group (top-level)
- Layers for Placemarks under "Daun - 71" assigned to that group via `groupId`

#### 10. `apps/geolibre-desktop/src/lib/ui-profile.ts`
Add to `DATA_SOURCE_CATALOG` under `files`:
```ts
{ id: "kml", section: "files", labelKey: "toolbar.layerType.kml", tier: "basic" }
```

#### 11. `apps/geolibre-desktop/src/components/layout/toolbar/constants.ts`
Add `kml: () => void` to `AddLayerHandlers` type.

#### 12. `apps/geolibre-desktop/src/components/layout/TopToolbar.tsx`
```ts
const [kmlDialogOpen, setKmlDialogOpen] = useState(false)
const [kmlInitialData, setKmlInitialData] = useState<KmlImportDialogProps['initialData']>()
```
Handler: `kml: () => { setKmlInitialData(undefined); setKmlDialogOpen(true) }`
Render `<KmlImportDialog>` near `NetcdfDialog`, passing `mapControllerRef`.

#### 13. `apps/geolibre-desktop/src/components/layout/toolbar/AddDataMenu.tsx`
Add `kml: { onSelect: addLayer.kml }` in `handlers`.

#### 14. `apps/geolibre-desktop/src/components/layout/DesktopShell.tsx` — Drag-Drop Intercept

**Browser `handleDrop`:**
- Filter `.kml`/`.kmz` from `otherFiles` before `loadDroppedVectorFiles`
- For each KML/KMZ: read text + arrayBuffer, build `initialData`
- `setKmlInitialData([...])`; `setKmlDialogOpen(true)`
- Process remaining non-KML files normally through `finishDrop`
- If ALL files were KML: skip `finishDrop`

**Tauri `onDragDropEvent`:**
- Same pattern with file paths, `readTextFile`/`readFile`

**Dialog close:** `onOpenChange(false)` clears `kmlInitialData`. Layers already added by dialog.

#### 15. `apps/geolibre-desktop/src/i18n/locales/en.json`

```json
{
  "addData": {
    "kind": {
      "kml": {
        "label": "Add KML/KMZ Layer",
        "description": "Import KML/KMZ files with folder structure. Select which folders and placemarks to import as nested layer groups."
      }
    },
    "kml": {
      "defaultName": "KML Layer",
      "chooseFile": "Choose KML/KMZ file...",
      "noFileSelected": "No file selected",
      "readError": "Could not read the KML file.",
      "notXml": "The file is not valid XML.",
      "notKml": "The file does not contain a KML document.",
      "noPlacemarks": "No readable placemarks found in this KML file.",
      "kmzNoDocKml": "The KMZ archive does not contain a doc.kml file.",
      "selectAll": "Select All",
      "deselectAll": "Deselect All",
      "unnamedPlacemark": "Unnamed Placemark",
      "features_one": "{{count}} feature",
      "features_other": "{{count}} features",
      "fileNameLabel": "File: {{name}}"
    }
  },
  "toolbar": {
    "layerType": {
      "kml": "KML/KMZ Layer"
    }
  }
}
```

### Data Flow
```
[Menu click / Drop event]
  → file(s) read (text for .kml, arrayBuffer for .kmz)
  → extractDocKmlFromKmz (if .kmz)
  → parseKmlTree(text) → KmlTreeNode[]
  → User selects/deselects + optionally renames nodes
  → User clicks "Add"
  → collectSelectedFeatures(nodes) → [{ containerPath, features }]
  → For each entry: create LayerGroup with parentGroupId linking up the path,
    create GeoJSON layer(s) assigned to the group
  → mapController.fitBounds(allCombined)
  → Dialog closes
```

### Edge Cases
| Case | Behavior |
|------|----------|
| Flat KML (no Folders) | Tree shows Document with Placemark children — user can select which |
| Empty KML | Error "No readable placemarks found" |
| Invalid XML | Error "The file is not valid XML" |
| KMZ without doc.kml | Error "KMZ does not contain doc.kml" |
| Placemark without `<name>` | Label "Unnamed Placemark" |
| 4562 Placemarks / 72 folders | Scrollable tree, depth-1 expansion |
| Multiple KML files in drag-drop | All as root nodes in single dialog |
| Only KML files dropped | Dialog opens; no `finishDrop` call |
| User cancels dialog | No layers created; drag-drop returns to idle |
| Document nested in Folder | Treated identically to Folder nesting |
| Folder with selected child, parent deselected | Child Placemarks form their own group |
| Nested selected folders | Each creates separate nested LayerGroup with parentGroupId chain |
| Duplicate folder names at different depths | Groups disambiguated by parent path; names editable by user |

### Validation
```bash
npm run test:frontend                          # Phase 1 nesting tests + existing suite
npm run typecheck                              # Full TS build
# Manual smoke tests:
# - Menu → KML/KMZ → pick BL 4510.kml (274 points, single folder) → import
# - Drop BL 4511.kml onto map → select subset → import
# - Drop Los Daun 2025-26.kmz (4562 polygons, 72 folders) → expand tree → deselect some → import
# - Verify layer panel shows nested groups with correct parentGroupId hierarchy
# - Verify group collapse/expand, visibility toggle, opacity on nested groups
# - Drop 2 KML files together → verify both appear as roots in single dialog
```

### Dependencies
No new packages. Existing: `fflate`, `@geolibre/ui` Dialog, `openLocalDataFileWithFallback`, `DOMParser`, `useAppStore`.

### Task Order
1. `packages/core/src/types.ts` — `parentGroupId` on `LayerGroup`
2. `packages/core/src/layer-groups.ts` — recursive tree, ancestor effects, nested contiguity
3. `packages/core/src/store.ts` — group actions with nesting
4. `packages/core/src/project.ts` — serialize parentGroupId, validate refs, detect cycles
5. `apps/geolibre-desktop/src/components/panels/LayerPanel.tsx` — recursive rendering
6. `tests/layer-groups.test.ts` — nesting test coverage
7. `npm run test:frontend && npm run typecheck` — **gate**
8. `apps/geolibre-desktop/src/lib/kml.ts` — `parseKmlTree`, `collectSelectedFeatures`
9. `apps/geolibre-desktop/src/lib/tauri-io.ts` — `extractDocKmlFromKmz`
10. `apps/geolibre-desktop/src/components/layout/KmlImportDialog.tsx` — dialog component (NEW)
11. `apps/geolibre-desktop/src/lib/ui-profile.ts` — catalog entry
12. `apps/geolibre-desktop/src/components/layout/toolbar/constants.ts` — type extension
13. `apps/geolibre-desktop/src/components/layout/TopToolbar.tsx` — state + handler + render
14. `apps/geolibre-desktop/src/components/layout/toolbar/AddDataMenu.tsx` — wire handler
15. `apps/geolibre-desktop/src/components/layout/DesktopShell.tsx` — drag-drop intercept
16. `apps/geolibre-desktop/src/i18n/locales/en.json` — i18n keys

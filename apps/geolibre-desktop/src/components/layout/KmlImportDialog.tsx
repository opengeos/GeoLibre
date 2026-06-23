import { useAppStore } from "@geolibre/core";
import type { MapController } from "@geolibre/map";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
} from "@geolibre/ui";
import type { Feature, FeatureCollection } from "geojson";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Folder,
  FolderOpen,
  MapPin,
  Minus,
  Pencil,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { extractDocKmlFromKmz } from "../../lib/tauri-io";
import {
  collectSelectedFeatures,
  parseKmlTree,
  type KmlTreeNode,
} from "../../lib/kml";
import {
  openLocalDataFileWithFallback,
} from "../../lib/tauri-io";

interface KmlFileData {
  fileName: string;
  rawData: string;
  isKmz: boolean;
  binaryData?: ArrayBuffer;
}

interface KmlImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mapControllerRef: React.RefObject<MapController | null>;
  initialData?: KmlFileData[];
}

interface FileTree {
  fileName: string;
  nodes: KmlTreeNode[];
}

function computeBbox(
  fcs: FeatureCollection[],
): [number, number, number, number] | null {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  let hasCoords = false;

  for (const fc of fcs) {
    for (const feature of fc.features) {
      const coords = extractCoords(feature.geometry);
      for (const [lng, lat] of coords) {
        if (Number.isFinite(lng) && Number.isFinite(lat)) {
          hasCoords = true;
          if (lng < west) west = lng;
          if (lng > east) east = lng;
          if (lat < south) south = lat;
          if (lat > north) north = lat;
        }
      }
    }
  }

  return hasCoords ? [west, south, east, north] : null;
}

function extractCoords(geom: unknown): [number, number][] {
  if (!geom || typeof geom !== "object") return [];
  const g = geom as { type?: string; coordinates?: unknown };
  if (!g.type) return [];

  switch (g.type) {
    case "Point":
      return [g.coordinates as [number, number]];
    case "MultiPoint":
    case "LineString":
      return (g.coordinates as [number, number][]) ?? [];
    case "MultiLineString":
    case "Polygon":
      return ((g.coordinates as [number, number][][]) ?? []).flat();
    case "MultiPolygon":
      return ((g.coordinates as [number, number][][][]) ?? []).flat(2);
    case "GeometryCollection": {
      const geoms = (g as { geometries?: unknown[] }).geometries ?? [];
      return geoms.flatMap((sub) => extractCoords(sub));
    }
    default:
      return [];
  }
}

function mergeBboxes(
  a: [number, number, number, number],
  b: [number, number, number, number],
): [number, number, number, number] {
  return [
    Math.min(a[0], b[0]),
    Math.min(a[1], b[1]),
    Math.max(a[2], b[2]),
    Math.max(a[3], b[3]),
  ];
}

function recalcTree(nodes: KmlTreeNode[]): KmlTreeNode[] {
  return nodes.map((node) => recalcNode(node));
}

function recalcNode(node: KmlTreeNode): KmlTreeNode {
  if (node.children.length === 0) return node;

  const children = node.children.map(recalcNode);
  const checkedCount = children.filter((c) => c.checked).length;
  const indeterminateCount = children.filter((c) => c.indeterminate).length;

  let checked: boolean;
  let indeterminate: boolean;

  if (children.length === 0) {
    checked = node.checked;
    indeterminate = false;
  } else if (checkedCount === children.length) {
    checked = true;
    indeterminate = false;
  } else if (checkedCount === 0 && indeterminateCount === 0) {
    checked = false;
    indeterminate = false;
  } else {
    checked = false;
    indeterminate = true;
  }

  return { ...node, children, checked, indeterminate };
}

function setNodeChecked(
  nodes: KmlTreeNode[],
  nodeId: string,
  value: boolean,
): KmlTreeNode[] {
  return nodes.map((node) => setOneNodeChecked(node, nodeId, value));
}

function setOneNodeChecked(
  node: KmlTreeNode,
  nodeId: string,
  value: boolean,
): KmlTreeNode {
  if (node.id === nodeId) {
    return {
      ...node,
      checked: value,
      indeterminate: false,
      children: node.children.map((c) =>
        setDescendantChecked(c, value),
      ),
    };
  }

  if (node.children.length > 0) {
    const children = node.children.map((c) =>
      setOneNodeChecked(c, nodeId, value),
    );
    return recalcNode({ ...node, children });
  }

  return node;
}

function setDescendantChecked(node: KmlTreeNode, value: boolean): KmlTreeNode {
  return {
    ...node,
    checked: value,
    indeterminate: false,
    children: node.children.map((c) => setDescendantChecked(c, value)),
  };
}

function setAllChecked(nodes: KmlTreeNode[], value: boolean): KmlTreeNode[] {
  return nodes.map((node) => ({
    ...node,
    checked: value,
    indeterminate: false,
    children: value
      ? node.children.map((c) => setDescendantChecked(c, true))
      : node.children.map((c) => setDescendantChecked(c, false)),
  }));
}

function toggleExpanded(set: Set<string>, nodeId: string): Set<string> {
  const next = new Set(set);
  if (next.has(nodeId)) {
    next.delete(nodeId);
  } else {
    next.add(nodeId);
  }
  return next;
}

function initialExpanded(nodes: KmlTreeNode[]): Set<string> {
  const set = new Set<string>();
  function walk(list: KmlTreeNode[]) {
    for (const node of list) {
      if (node.depth <= 1 && node.children.length > 0) {
        set.add(node.id);
      }
      walk(node.children);
    }
  }
  walk(nodes);
  return set;
}

function KmlTreeRow({
  node,
  expanded,
  editingId,
  editedName,
  onToggleExpand,
  onToggleChecked,
  onStartRename,
  onCommitRename,
  onCancelRename,
  onNameChange,
}: {
  node: KmlTreeNode;
  expanded: Set<string>;
  editingId: string | null;
  editedName: string;
  onToggleExpand: (id: string) => void;
  onToggleChecked: (id: string) => void;
  onStartRename: (id: string, name: string) => void;
  onCommitRename: (id: string) => void;
  onCancelRename: () => void;
  onNameChange: (name: string) => void;
}) {
  const isExpanded = expanded.has(node.id);
  const hasChildren = node.children.length > 0;
  const isContainer = node.type !== "Placemark";
  const isEditing = editingId === node.id;

  return (
    <div>
      <div
        className="flex items-center gap-1 py-0.5 hover:bg-accent/50 rounded-sm cursor-pointer select-none group"
        style={{ paddingLeft: `${node.depth * 20}px` }}
        onClick={() => onToggleChecked(node.id)}
      >
        {isContainer && hasChildren ? (
          <button
            type="button"
            className="p-0.5 shrink-0"
            onClick={(e) => {
              e.stopPropagation();
              onToggleExpand(node.id);
            }}
            aria-label={isExpanded ? "Collapse" : "Expand"}
          >
            {isExpanded ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )}
          </button>
        ) : (
          <span className="w-5 shrink-0" />
        )}

        <span className="shrink-0">
          {node.checked ? (
            <Check className="h-3.5 w-3.5 text-primary" />
          ) : node.indeterminate ? (
            <Minus className="h-3.5 w-3.5 text-muted-foreground" />
          ) : (
            <span className="block h-3.5 w-3.5 rounded-sm border" />
          )}
        </span>

        {isContainer ? (
          isExpanded ? (
            <FolderOpen className="h-3.5 w-3.5 shrink-0 text-amber-500" />
          ) : (
            <Folder className="h-3.5 w-3.5 shrink-0 text-amber-500" />
          )
        ) : (
          <MapPin className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        )}

        {isEditing ? (
          <span
            className="flex items-center gap-1 shrink-0"
            onClick={(e) => e.stopPropagation()}
          >
            <Input
              className="h-5 w-32 text-sm"
              value={editedName}
              onChange={(e) => onNameChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  onCommitRename(node.id);
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  onCancelRename();
                }
              }}
              autoFocus
            />
            <button
              type="button"
              className="p-0.5 hover:bg-accent rounded-sm"
              onClick={() => onCommitRename(node.id)}
            >
              <Check className="h-3 w-3 text-primary" />
            </button>
            <button
              type="button"
              className="p-0.5 hover:bg-accent rounded-sm"
              onClick={() => onCancelRename()}
            >
              <X className="h-3 w-3 text-muted-foreground" />
            </button>
          </span>
        ) : (
          <>
            <span className="truncate text-sm">{node.name}</span>
            {isContainer ? (
              <button
                type="button"
                className="p-0.5 opacity-0 group-hover:opacity-100 hover:bg-accent rounded-sm shrink-0 ml-auto"
                onClick={(e) => {
                  e.stopPropagation();
                  onStartRename(node.id, node.name);
                }}
                aria-label="Rename"
              >
                <Pencil className="h-3 w-3" />
              </button>
            ) : null}
          </>
        )}

        {isContainer && node.featureCount > 0 ? (
          <span className="text-xs text-muted-foreground shrink-0">
            ({node.featureCount})
          </span>
        ) : null}
      </div>

      {hasChildren && isExpanded ? (
        <div>
          {node.children.map((child) => (
            <KmlTreeRow
              key={child.id}
              node={child}
              expanded={expanded}
              editingId={editingId}
              editedName={editedName}
              onToggleExpand={onToggleExpand}
              onToggleChecked={onToggleChecked}
              onStartRename={onStartRename}
              onCommitRename={onCommitRename}
              onCancelRename={onCancelRename}
              onNameChange={onNameChange}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function KmlRootRow({
  rootNodeId,
  name,
  editing,
  editedName,
  featureCount,
  onToggleExpand,
  onStartRename,
  onCommitRename,
  onCancelRename,
  onNameChange,
  expanded,
}: {
  rootNodeId: string;
  name: string;
  editing: boolean;
  editedName: string;
  featureCount: number;
  onToggleExpand: (id: string) => void;
  onStartRename: (id: string, name: string) => void;
  onCommitRename: (id: string) => void;
  onCancelRename: () => void;
  onNameChange: (name: string) => void;
  expanded: Set<string>;
}) {
  const isExpanded = expanded.has(rootNodeId);

  if (editing) {
    return (
      <div className="flex items-center gap-1 px-3 py-1 border-b bg-muted/50">
        <Input
          className="h-6 text-xs w-48"
          value={editedName}
          onChange={(e) => onNameChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onCommitRename(rootNodeId);
            } else if (e.key === "Escape") {
              e.preventDefault();
              onCancelRename();
            }
          }}
          autoFocus
        />
        <button
          type="button"
          className="p-0.5 hover:bg-accent rounded-sm"
          onClick={(e) => {
            e.stopPropagation();
            onCommitRename(rootNodeId);
          }}
        >
          <Check className="h-3 w-3 text-primary" />
        </button>
        <button
          type="button"
          className="p-0.5 hover:bg-accent rounded-sm"
          onClick={(e) => {
            e.stopPropagation();
            onCancelRename();
          }}
        >
          <X className="h-3 w-3 text-muted-foreground" />
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-muted-foreground border-b bg-muted/50">
      <button
        type="button"
        className="p-0.5 shrink-0"
        onClick={(e) => {
          e.stopPropagation();
          onToggleExpand(rootNodeId);
        }}
        aria-label={isExpanded ? "Collapse" : "Expand"}
      >
        {isExpanded ? (
          <ChevronDown className="h-3 w-3" />
        ) : (
          <ChevronRight className="h-3 w-3" />
        )}
      </button>
      <span className="truncate">{name}</span>
      {featureCount > 0 ? (
        <span className="text-muted-foreground/70 shrink-0">
          ({featureCount})
        </span>
      ) : null}
      <button
        type="button"
        className="p-0.5 ml-auto hover:bg-accent rounded-sm"
        onClick={(e) => {
          e.stopPropagation();
          onStartRename(rootNodeId, name);
        }}
        aria-label="Rename"
      >
        <Pencil className="h-3 w-3" />
      </button>
    </div>
  );
}

export function KmlImportDialog({
  open,
  onOpenChange,
  mapControllerRef,
  initialData,
}: KmlImportDialogProps) {
  const { t } = useTranslation();
  const [fileTrees, setFileTrees] = useState<FileTree[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editedName, setEditedName] = useState("");
  const opGen = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const reset = useCallback(() => {
    opGen.current += 1;
    setFileTrees([]);
    setExpanded(new Set());
    setError(null);
    setLoading(false);
    setFileName(null);
    setEditingId(null);
    setEditedName("");
  }, []);

  const loadFiles = useCallback(
    async (files: KmlFileData[]) => {
      const gen = ++opGen.current;
      setError(null);
      setLoading(true);
      setFileTrees([]);

      const trees: FileTree[] = [];
      for (const file of files) {
        try {
          let text: string;
          if (file.isKmz && file.binaryData) {
            text = await extractDocKmlFromKmz(file.binaryData);
          } else {
            text = file.rawData;
          }
          const nodes = parseKmlTree(text);
          trees.push({ fileName: file.fileName, nodes });
        } catch (err) {
          if (gen !== opGen.current) return;
          setError(
            err instanceof Error
              ? err.message
              : `Could not read ${file.fileName}.`,
          );
          setLoading(false);
          return;
        }
      }

      if (gen !== opGen.current) return;
      setFileTrees(trees);
      setExpanded(
        new Set(trees.flatMap((t) => [...initialExpanded(t.nodes)])),
      );
      setLoading(false);
    },
    [],
  );

  useEffect(() => {
    if (!open) return;
    if (initialData && initialData.length > 0) {
      loadFiles(initialData);
    } else {
      setFileTrees([]);
      setExpanded(new Set());
      setError(null);
      setFileName(null);
    }
  }, [open, initialData, loadFiles]);

  const handleChooseFile = useCallback(async () => {
    const gen = ++opGen.current;
    setError(null);
    setLoading(true);

    try {
      const result = await openLocalDataFileWithFallback({
        accept: ".kml,.kmz",
        readText: true,
        readBinary: true,
        filters: [{ name: "KML/KMZ", extensions: ["kml", "kmz"] }],
      });

      if (!result) {
        setLoading(false);
        return;
      }

      const isKmz = result.path.toLowerCase().endsWith(".kmz");
      let text: string;

      if (isKmz && result.data) {
        text = await extractDocKmlFromKmz(result.data);
      } else if (result.text) {
        text = result.text;
      } else {
        setError(t("addData.kml.readError"));
        setLoading(false);
        return;
      }

      if (gen !== opGen.current) return;

      const dbName = result.path.split(/[/\\]/).pop() || result.path;
      const nodes = parseKmlTree(text);
      setFileTrees([{ fileName: dbName, nodes }]);
      setFileName(dbName);
      setExpanded(new Set(initialExpanded(nodes)));
      setLoading(false);
    } catch (err) {
      if (gen !== opGen.current) return;
      setError(
        err instanceof Error ? err.message : t("addData.kml.readError"),
      );
      setLoading(false);
    }
  }, [t]);

  const handleToggleChecked = useCallback((nodeId: string) => {
    setFileTrees((prev) =>
      prev.map((ft) => {
        const node = findNode(ft.nodes, nodeId);
        if (!node) return ft;
        return {
          ...ft,
          nodes: recalcTree(setNodeChecked(ft.nodes, nodeId, !node.checked)),
        };
      }),
    );
  }, []);

  const handleSelectAll = useCallback(() => {
    setFileTrees((prev) =>
      prev.map((ft) => ({
        ...ft,
        nodes: recalcTree(setAllChecked(ft.nodes, true)),
      })),
    );
  }, []);

  const handleDeselectAll = useCallback(() => {
    setFileTrees((prev) =>
      prev.map((ft) => ({
        ...ft,
        nodes: recalcTree(setAllChecked(ft.nodes, false)),
      })),
    );
  }, []);

  const handleStartRename = useCallback((id: string, name: string) => {
    setEditingId(id);
    setEditedName(name);
  }, []);

  const handleCommitRename = useCallback(
    (id: string) => {
      const trimmed = editedName.trim();
      if (!trimmed) {
        setEditingId(null);
        return;
      }

      // Check if this is a root node (fileTrees entry) or a folder/root node
      setFileTrees((prev) =>
        prev.map((ft) => {
          // Try root node match first
          const rootMatch = ft.nodes.find((n) => n.id === id);
          if (rootMatch) {
            return {
              ...ft,
              nodes: renameNode(ft.nodes, id, trimmed),
            };
          }
          // If the id matches a file tree root (not a kml node), rename the file name
          return ft;
        }),
      );

      // Also update fileName if this was a root rename
      setFileName((prev) => {
        if (editingId === id && initialData) {
          return trimmed;
        }
        return prev;
      });

      setEditingId(null);
    },
    [editedName, editingId, initialData],
  );

  const handleCancelRename = useCallback(() => {
    setEditingId(null);
    setEditedName("");
  }, []);

  const handleSubmit = useCallback(() => {
    const allEntries: {
      fileLabel: string;
      containerPath: string[];
      features: Feature[];
    }[] = [];

    let totalFeatures = 0;

    for (const ft of fileTrees) {
      const baseName = ft.fileName.replace(/\.[^.]+$/, "") || ft.fileName;
      const groups = collectSelectedFeatures(ft.nodes);

      for (const entry of groups) {
        allEntries.push({
          fileLabel: baseName,
          containerPath: entry.containerPath,
          features: entry.features,
        });
        totalFeatures += entry.features.length;
      }
    }

    if (totalFeatures === 0) {
      setError(t("addData.kml.noPlacemarks"));
      return;
    }

    const store = useAppStore.getState();
    let combinedBbox: [number, number, number, number] | null = null;

    // Track already-created group IDs by their full path so shared ancestors
    // are reused across entries.
    const groupIdByPath = new Map<string, string>();

    // Build a deduplicated sorted list of all container paths, ordered from
    // shallowest to deepest so parent groups are created before their children.
    const paths = [...new Set(allEntries.map((e) => e.containerPath.join("\x00")))];
    paths.sort((a, b) => a.split("\x00").length - b.split("\x00").length);

    for (const pathStr of paths) {
      const segments = pathStr.split("\x00");
      if (segments.length === 0 || !segments[0]) continue;

      // Ensure every ancestor group exists, reusing already-created ones.
      let parentGroupId: string | undefined;
      for (let i = 0; i < segments.length; i++) {
        const partialKey = segments.slice(0, i + 1).join("\x00");
        let gid = groupIdByPath.get(partialKey);
        if (!gid) {
          gid = store.addLayerGroup(segments[i], [], parentGroupId);
          groupIdByPath.set(partialKey, gid);
        }
        parentGroupId = gid;
      }

      // Collect all features for this path across all files.
      const fcs: FeatureCollection[] = [];
      for (const entry of allEntries) {
        if (entry.containerPath.join("\x00") === pathStr) {
          fcs.push({ type: "FeatureCollection", features: entry.features });
        }
      }

      // If multiple files contribute to the same path, merge their features.
      const mergedFeatures = fcs.flatMap((fc) => fc.features);
      if (mergedFeatures.length === 0) continue;

      const fc: FeatureCollection = { type: "FeatureCollection", features: mergedFeatures };

      // Use the last path segment as the layer name, prefixed by the file label
      // when there are multiple files.
      const leafName = segments[segments.length - 1];
      const layerName =
        allEntries.filter((e) => e.containerPath.join("\x00") === pathStr).length > 1
          ? leafName
          : allEntries.find((e) => e.containerPath.join("\x00") === pathStr)?.fileLabel
            ? `${allEntries.find((e) => e.containerPath.join("\x00") === pathStr)!.fileLabel} - ${leafName}`
            : leafName;

      const layerId = store.addGeoJsonLayer(layerName, fc);
      const targetGroupId =
        groupIdByPath.get(pathStr) ?? parentGroupId ?? null;
      store.moveLayerToGroup(layerId, targetGroupId);

      const bbox = computeBbox([fc]);
      if (bbox) {
        combinedBbox = combinedBbox
          ? mergeBboxes(combinedBbox, bbox)
          : bbox;
      }
    }

    // Handle features with no checked container ancestor (root-level).
    const rootEntries = allEntries.filter((e) => e.containerPath.length === 0);
    for (const entry of rootEntries) {
      if (entry.features.length === 0) continue;
      const fc: FeatureCollection = { type: "FeatureCollection", features: entry.features };
      const layerId = store.addGeoJsonLayer(entry.fileLabel, fc);

      const bbox = computeBbox([fc]);
      if (bbox) {
        combinedBbox = combinedBbox
          ? mergeBboxes(combinedBbox, bbox)
          : bbox;
      }
    }

    if (combinedBbox) {
      mapControllerRef.current?.fitBounds(combinedBbox);
    }

    onOpenChange(false);
  }, [fileTrees, mapControllerRef, onOpenChange, t]);

  const handleClose = useCallback(
    (next: boolean) => {
      if (!next) reset();
      onOpenChange(next);
    },
    [onOpenChange, reset],
  );

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {t("toolbar.layerType.kml")}
          </DialogTitle>
          <DialogDescription>
            {t("addData.kml.description")}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {!initialData || fileTrees.length === 0 ? (
            <Button
              variant="outline"
              className="w-full"
              onClick={handleChooseFile}
              disabled={loading}
            >
              {loading
                ? t("addData.common.loading")
                : initialData
                  ? t("addData.kml.readError")
                  : t("addData.kml.chooseFile")}
            </Button>
          ) : null}

          {error ? (
            <p className="text-sm text-destructive">{error}</p>
          ) : null}

          {fileTrees.length > 0 ? (
            <>
              <div className="flex items-center justify-between">
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleSelectAll}
                  >
                    {t("addData.kml.selectAll")}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleDeselectAll}
                  >
                    {t("addData.kml.deselectAll")}
                  </Button>
                </div>
              </div>

              <div className="max-h-[60vh] overflow-y-auto rounded-md border">
                {fileTrees.map((ft, ftIdx) => {
                  const rootId = `__file-${ftIdx}`;
                  const rootName = editingId === rootId
                    ? editedName
                    : (ft.fileName.replace(/\.[^.]+$/, "") || ft.fileName);
                  const rootFeatureCount = ft.nodes.reduce(
                    (sum, n) => sum + n.featureCount,
                    0,
                  );

                  return (
                    <div key={ft.fileName}>
                      <KmlRootRow
                        rootNodeId={rootId}
                        name={rootName}
                        editing={editingId === rootId}
                        editedName={editedName}
                        featureCount={rootFeatureCount}
                        onToggleExpand={(id) =>
                          setExpanded((prev) => toggleExpanded(prev, id))
                        }
                        onStartRename={handleStartRename}
                        onCommitRename={(id) => {
                          const trimmed = editedName.trim();
                          if (!trimmed) {
                            setEditingId(null);
                            return;
                          }
                          setFileTrees((prev) =>
                            prev.map((f, i) => {
                              if (i === ftIdx) {
                                return { ...f, fileName: trimmed + (f.fileName.includes(".") ? f.fileName.slice(f.fileName.lastIndexOf(".")) : "") };
                              }
                              return f;
                            }),
                          );
                          setFileName(trimmed);
                          setEditingId(null);
                        }}
                        onCancelRename={handleCancelRename}
                        onNameChange={setEditedName}
                        expanded={expanded}
                      />
                      {expanded.has(rootId) ? (
                        ft.nodes.map((node) => (
                          <KmlTreeRow
                            key={node.id}
                            node={node}
                            expanded={expanded}
                            editingId={editingId}
                            editedName={editedName}
                            onToggleExpand={(id) =>
                              setExpanded((prev) => toggleExpanded(prev, id))
                            }
                            onToggleChecked={handleToggleChecked}
                            onStartRename={handleStartRename}
                            onCommitRename={handleCommitRename}
                            onCancelRename={handleCancelRename}
                            onNameChange={setEditedName}
                          />
                        ))
                      ) : null}
                    </div>
                  );
                })}
              </div>

              <div className="flex justify-end gap-2">
                <Button
                  variant="outline"
                  onClick={() => handleClose(false)}
                >
                  {t("common.cancel")}
                </Button>
                <Button onClick={handleSubmit} disabled={loading}>
                  {t("common.add")}
                </Button>
              </div>
            </>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function findNode(
  nodes: KmlTreeNode[],
  id: string,
): KmlTreeNode | undefined {
  for (const node of nodes) {
    if (node.id === id) return node;
    const found = findNode(node.children, id);
    if (found) return found;
  }
  return undefined;
}

function renameNode(
  nodes: KmlTreeNode[],
  targetId: string,
  newName: string,
): KmlTreeNode[] {
  return nodes.map((node) => {
    if (node.id === targetId) {
      return { ...node, name: newName };
    }
    if (node.children.length > 0) {
      return { ...node, children: renameNode(node.children, targetId, newName) };
    }
    return node;
  });
}

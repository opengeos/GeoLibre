import { useEffect, useRef, useState } from "react";
import { useAppStore } from "@geolibre/core";
import type { GeoLibreLayer, LayerGroup } from "@geolibre/core";

/**
 * Inline rename of layer rows and group headers, plus creating a new group
 * with its name already open for editing.
 *
 * @param layers - The project's layers, in store order.
 * @param layerGroups - The project's layer groups.
 * @returns The editing state and the begin/commit/cancel handlers.
 */
export function useLayerRename(layers: GeoLibreLayer[], layerGroups: LayerGroup[]) {
  const updateLayer = useAppStore((s) => s.updateLayer);
  const renameLayerGroup = useAppStore((s) => s.renameLayerGroup);
  const addLayerGroup = useAppStore((s) => s.addLayerGroup);
  const [editingLayerId, setEditingLayerId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [editingGroupName, setEditingGroupName] = useState("");
  // Ending a rename (commit or cancel) clears the editing state, which
  // unmounts the focused input. React then delivers that input's onBlur (the
  // browser's native blur on the removed element) to commitRename from the
  // pre-update closure, which would re-commit the edit. This ref, read
  // synchronously by commitRename, suppresses that stray blur commit. It is
  // reset in beginRename so a flag left set by a cancel whose blur never fired
  // cannot leak into the next rename session.
  const suppressBlurCommitRef = useRef(false);
  // Same stray-blur guard as suppressBlurCommitRef, for the group rename input.
  const suppressGroupBlurCommitRef = useRef(false);

  const beginGroupRename = (group: LayerGroup) => {
    // Clear any flag left set by a prior cancel/commit whose blur never fired,
    // so it cannot swallow the first commit of this rename session.
    suppressGroupBlurCommitRef.current = false;
    setEditingGroupId(group.id);
    setEditingGroupName(group.name);
  };

  const commitGroupRename = () => {
    if (suppressGroupBlurCommitRef.current || !editingGroupId) {
      suppressGroupBlurCommitRef.current = false;
      return;
    }
    // Suppress the onBlur that fires when clearing editing state unmounts the
    // input, so the edit is not committed a second time from the stale closure.
    suppressGroupBlurCommitRef.current = true;
    const trimmed = editingGroupName.trim();
    const current = layerGroups.find((g) => g.id === editingGroupId);
    if (trimmed && current && trimmed !== current.name) {
      renameLayerGroup(editingGroupId, trimmed);
    }
    setEditingGroupId(null);
    setEditingGroupName("");
  };

  const cancelGroupRename = () => {
    suppressGroupBlurCommitRef.current = true;
    setEditingGroupId(null);
    setEditingGroupName("");
  };

  const handleCreateGroup = () => {
    const id = addLayerGroup();
    // Open the new (empty) folder's name for editing right away.
    const group = useAppStore.getState().layerGroups.find((g) => g.id === id);
    if (group) beginGroupRename(group);
  };

  const beginRename = (layer: GeoLibreLayer) => {
    // Clear any flag left set by a prior cancel/commit whose blur never fired,
    // so it cannot swallow the first commit of this rename session.
    suppressBlurCommitRef.current = false;
    setEditingLayerId(layer.id);
    setEditingName(layer.name);
  };

  const commitRename = () => {
    if (suppressBlurCommitRef.current || !editingLayerId) {
      suppressBlurCommitRef.current = false;
      return;
    }
    // Suppress the onBlur that fires when clearing editing state unmounts the
    // input, so the edit is not committed a second time from the stale closure.
    suppressBlurCommitRef.current = true;
    const trimmed = editingName.trim();
    const current = layers.find((l) => l.id === editingLayerId);
    if (trimmed && current && trimmed !== current.name) {
      updateLayer(editingLayerId, { name: trimmed });
    }
    setEditingLayerId(null);
    setEditingName("");
  };

  const cancelRename = () => {
    suppressBlurCommitRef.current = true;
    setEditingLayerId(null);
    setEditingName("");
  };

  // End the rename once the layer being renamed is removed.
  useEffect(() => {
    if (editingLayerId && !layers.some((layer) => layer.id === editingLayerId)) {
      setEditingLayerId(null);
      setEditingName("");
    }
  }, [editingLayerId, layers]);

  return {
    editingLayerId,
    editingName,
    setEditingName,
    beginRename,
    commitRename,
    cancelRename,
    editingGroupId,
    editingGroupName,
    setEditingGroupName,
    beginGroupRename,
    commitGroupRename,
    cancelGroupRename,
    handleCreateGroup,
  };
}

/** The rename state and handlers {@link useLayerRename} returns. */
export type LayerRename = ReturnType<typeof useLayerRename>;

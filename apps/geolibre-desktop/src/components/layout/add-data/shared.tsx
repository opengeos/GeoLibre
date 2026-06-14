/**
 * Shared building blocks for the Add Data dialog sources: a hook that wires the
 * common layer-name / insert-before / submit plumbing to the dialog shell, plus
 * the presentational fields and footer reused across every source.
 */

import type { GeoLibreLayer } from "@geolibre/core";
import { Button, Input, Label, Select } from "@geolibre/ui";
import { Globe2, Map as MapIcon } from "lucide-react";
import {
  type FormEvent,
  type ReactNode,
  useState,
} from "react";
import { useAddDataShell } from "./context";
import { errorMessage } from "./helpers";

/**
 * Wires a per-source component to the dialog shell. Owns the shared layer-name,
 * insert-before, and error state and exposes `addAndClose` / `runSubmit`
 * helpers built on the shell's store and map controller.
 *
 * @param defaultLayerName - The initial layer name for this source.
 */
export function useAddDataSource(defaultLayerName: string) {
  const shell = useAddDataShell();
  const [layerName, setLayerName] = useState(defaultLayerName);
  const [beforeLayerId, setBeforeLayerId] = useState("");
  const [error, setError] = useState<string | null>(null);

  const beforeLayer = beforeLayerId.trim() || null;

  const addAndClose = (
    layer: GeoLibreLayer,
    options: { fit?: boolean } = {},
  ) => {
    shell.addLayer(layer, beforeLayer);
    if (options.fit) shell.mapControllerRef.current?.fitLayer(layer);
    shell.closeDialog();
  };

  /**
   * Wraps a submit action with the shared error handling and the
   * submit-in-progress flag, returning a form `onSubmit` handler.
   */
  const runSubmit =
    (action: () => Promise<void> | void) =>
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setError(null);
      shell.setIsSubmitting(true);
      try {
        await action();
      } catch (err) {
        setError(errorMessage(err, "Could not add layer."));
      } finally {
        shell.setIsSubmitting(false);
      }
    };

  return {
    shell,
    layerName,
    setLayerName,
    beforeLayerId,
    setBeforeLayerId,
    beforeLayer,
    error,
    setError,
    addAndClose,
    runSubmit,
    isSubmitting: shell.isSubmitting,
  };
}

export function LayerNameField({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor="add-data-layer-name">Layer name</Label>
      <Input
        id="add-data-layer-name"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

export function InsertBeforeField({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const { existingLayers, mapControllerRef } = useAddDataShell();
  // Computed during render (not memoized) so the list picks up the map
  // controller once it finishes initialising; the call is a cheap filter.
  const basemapStyleLayerIds =
    mapControllerRef.current?.getBasemapStyleLayerIds() ?? [];
  return (
    <div className="space-y-1.5">
      <Label htmlFor="add-data-before-id">Insert before</Label>
      <Select
        id="add-data-before-id"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">Top of layer list (default)</option>
        {existingLayers.length > 0 && (
          <optgroup label="Layers">
            {[...existingLayers].reverse().map((existingLayer) => (
              <option key={existingLayer.id} value={existingLayer.id}>
                {existingLayer.name}
              </option>
            ))}
          </optgroup>
        )}
        {basemapStyleLayerIds.length > 0 && (
          <optgroup label="Basemap layers">
            {basemapStyleLayerIds.map((styleLayerId) => (
              <option key={styleLayerId} value={styleLayerId}>
                {styleLayerId}
              </option>
            ))}
          </optgroup>
        )}
      </Select>
    </div>
  );
}

export function AddDataFooter({
  error,
  submitDisabled,
  /** Defaults to the map-pin icon; service sources pass a globe. */
  useServiceIcon = false,
}: {
  error: string | null;
  submitDisabled: boolean;
  useServiceIcon?: boolean;
}) {
  const { isSubmitting, closeDialog } = useAddDataShell();
  return (
    <>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          onClick={closeDialog}
          disabled={isSubmitting}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={submitDisabled}>
          {!isSubmitting ? (
            useServiceIcon ? (
              <Globe2 className="mr-2 h-3.5 w-3.5" />
            ) : (
              <MapIcon className="mr-2 h-3.5 w-3.5" />
            )
          ) : null}
          {isSubmitting ? "Adding…" : "Add layer"}
        </Button>
      </div>
    </>
  );
}

/**
 * Common wrapper for a source form: the shared layer-name + insert-before
 * fields, the source-specific body, and the footer.
 */
export function AddDataSourceForm({
  layerName,
  onLayerNameChange,
  beforeLayerId,
  onBeforeLayerIdChange,
  onSubmit,
  error,
  submitDisabled,
  useServiceIcon,
  children,
}: {
  layerName: string;
  onLayerNameChange: (value: string) => void;
  beforeLayerId: string;
  onBeforeLayerIdChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  error: string | null;
  submitDisabled: boolean;
  useServiceIcon?: boolean;
  children: ReactNode;
}) {
  return (
    <form className="space-y-4" onSubmit={onSubmit}>
      <LayerNameField value={layerName} onChange={onLayerNameChange} />
      <InsertBeforeField
        value={beforeLayerId}
        onChange={onBeforeLayerIdChange}
      />
      {children}
      <AddDataFooter
        error={error}
        submitDisabled={submitDisabled}
        useServiceIcon={useServiceIcon}
      />
    </form>
  );
}

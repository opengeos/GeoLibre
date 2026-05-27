import { useAppStore } from "@geolibre/core";
import {
  Input,
  ScrollArea,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@geolibre/ui";

export function AttributeTable() {
  const selectedLayerId = useAppStore((s) => s.selectedLayerId);
  const layers = useAppStore((s) => s.layers);
  const attributeFilter = useAppStore((s) => s.attributeFilter);
  const setAttributeFilter = useAppStore((s) => s.setAttributeFilter);
  const selectedFeatureId = useAppStore((s) => s.selectedFeatureId);
  const selectFeature = useAppStore((s) => s.selectFeature);
  const attributeTableOpen = useAppStore((s) => s.ui.attributeTableOpen);
  const setAttributeTableOpen = useAppStore((s) => s.setAttributeTableOpen);

  const layer = layers.find((l) => l.id === selectedLayerId);
  const features = layer?.geojson?.features ?? [];

  const filterLower = attributeFilter.toLowerCase();
  const filtered = features.filter((f, idx) => {
    if (!filterLower) return true;
    const id = String(f.id ?? idx);
    const props = JSON.stringify(f.properties ?? {}).toLowerCase();
    return id.includes(filterLower) || props.includes(filterLower);
  });

  const propKeys = new Set<string>();
  for (const f of features) {
    if (f.properties) {
      for (const k of Object.keys(f.properties)) propKeys.add(k);
    }
  }
  const columns = Array.from(propKeys).slice(0, 8);

  if (!attributeTableOpen) {
    return (
      <button
        type="button"
        className="h-6 shrink-0 border-t bg-muted/30 text-center text-xs text-muted-foreground hover:bg-muted/50"
        onClick={() => setAttributeTableOpen(true)}
      >
        Show attribute table
      </button>
    );
  }

  return (
    <section className="flex h-48 shrink-0 flex-col border-t bg-card">
      <div className="flex items-center gap-2 border-b px-3 py-1.5">
        <span className="text-sm font-semibold">Attribute table</span>
        {layer ? (
          <span className="text-xs text-muted-foreground">— {layer.name}</span>
        ) : (
          <span className="text-xs text-muted-foreground">
            — select a GeoJSON layer
          </span>
        )}
        <Input
          className="ml-auto h-7 max-w-xs text-xs"
          placeholder="Search attributes…"
          value={attributeFilter}
          onChange={(e) => setAttributeFilter(e.target.value)}
        />
        <button
          type="button"
          className="text-xs text-muted-foreground hover:underline"
          onClick={() => setAttributeTableOpen(false)}
        >
          Hide
        </button>
      </div>
      <ScrollArea className="flex-1">
        {!layer?.geojson ? (
          <p className="p-4 text-xs text-muted-foreground">
            Attribute table requires a GeoJSON layer.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-12">#</TableHead>
                {columns.map((col) => (
                  <TableHead key={col}>{col}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((feature, idx) => {
                const fid = String(feature.id ?? idx);
                const selected = selectedFeatureId === fid;
                return (
                  <TableRow
                    key={fid}
                    data-state={selected ? "selected" : undefined}
                    className="cursor-pointer"
                    onClick={() => {
                      selectFeature(fid);
                      // TODO(v0.2): Highlight selected feature on map
                    }}
                  >
                    <TableCell>{fid}</TableCell>
                    {columns.map((col) => (
                      <TableCell key={col}>
                        {String(feature.properties?.[col] ?? "")}
                      </TableCell>
                    ))}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </ScrollArea>
    </section>
  );
}

import type { Color, DataSource, Entity, Property } from "@cesium/engine";

type CesiumNs = typeof import("@cesium/engine");

/** Fade native document graphics without replacing their time-dependent colors. */
export function bindDocumentOpacity(
  C: CesiumNs,
  source: DataSource,
  opacity: () => number,
): () => void {
  const wrapped = new WeakSet<object>();
  const wrap = (graphics: object | undefined, key: string, fallback: Color) => {
    if (!graphics) return;
    const values = graphics as Record<string, Property | undefined>;
    const original = values[key];
    if (original && wrapped.has(original)) return;
    const property = new C.CallbackProperty((time, result) => {
      const color = original?.getValue(time) ?? fallback;
      const output = C.Color.clone(color, result);
      output.alpha *= Math.max(0, Math.min(1, opacity()));
      return output;
    }, false);
    wrapped.add(property);
    values[key] = property;
  };
  const apply = (entity: Entity) => {
    for (const graphic of [entity.billboard, entity.point, entity.label, entity.model]) {
      wrap(graphic, "color", C.Color.WHITE);
    }
    for (const graphic of [
      entity.point,
      entity.label,
      entity.polygon,
      entity.polyline,
      entity.wall,
      entity.corridor,
      entity.rectangle,
      entity.ellipse,
    ]) {
      if (!graphic) continue;
      if ("outlineColor" in graphic) wrap(graphic, "outlineColor", C.Color.BLACK);
      if ("material" in graphic && graphic.material && "color" in graphic.material) {
        wrap(graphic.material, "color", C.Color.WHITE);
      }
    }
  };
  for (const entity of source.entities.values) apply(entity);
  // NetworkLink refreshes and streamed CZML packets can add or replace graphics.
  return source.entities.collectionChanged.addEventListener(
    (_collection, added, _removed, changed) => {
      for (const entity of [...added, ...changed]) apply(entity);
    },
  );
}

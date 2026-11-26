// CesiumLayerSync layer: feature identification and selection highlighting.
// The CesiumLayerSync layer chain is documented in cesium-layer-sync.ts.

import { isBatchedPointRef } from "./cesium-points";
import { eciToEcf, gstime, propagate, twoline2satrec } from "satellite.js";
import type { Cartesian3, Color } from "@cesium/core";
import type { DataSource, Entity, PointPrimitiveCollection, PointPrimitive } from "@cesium/engine";
import type { MovingPointFeatureDescription } from "./cesium-layer-entry";
import { CesiumLayerSyncBase } from "./cesium-layer-sync-base";

/** One closed selected-satellite ring, matching God's Eye View's orbit renderer. */
const SELECTED_ORBIT_STEPS = 180;

/**
 * Feature identification and selection highlighting for `CesiumLayerSync`:
 * resolving picked objects to layer features and drawing the selected-feature
 * highlight, including moving points, TLE orbits and CZML entities.
 */
export class CesiumLayerSyncSelection extends CesiumLayerSyncBase {
  protected readonly featureRefs = new WeakMap<object, { layerId: string; index: number }>();

  protected readonly imageryRefs = new WeakMap<object, string>();

  protected readonly movingPointLayers = new Map<
    string,
    {
      collection: PointPrimitiveCollection;
      primitives: WeakSet<object>;
      descriptions: readonly MovingPointFeatureDescription[];
    }
  >();

  protected selection: { layerId: string; ids: Set<string> } | null = null;

  private highlightRestorers: Array<() => void> = [];

  /** Only live, visible entities owned by this synchronizer can identify a feature. */
  resolveFeature(entity: object) {
    // A batched point primitive carries its reference on `id` rather than
    // being an Entity the WeakMap knows.
    if (isBatchedPointRef(entity)) {
      const entry = this.entries.get(entity.geolibreLayerId);
      const moving = this.movingPointLayers.get(entity.geolibreLayerId);
      const movingPoint =
        entity.primitive && moving?.primitives.has(entity.primitive as unknown as object);
      if (
        !entry ||
        entry.cancelled ||
        (entry.kind !== "points" && !movingPoint) ||
        !entry.layer.visible ||
        entry.layer.opacity <= 0
      )
        return null;
      // A primitive the filter hid is not pickable, matching hidden entities;
      // the reference carries its primitive, so this is a field read on the
      // hover path rather than a scan of the batch.
      if (entity.primitive && !entity.primitive.show) return null;
      const feature = entry.layer.geojson?.features[entity.index];
      return feature
        ? {
            layerId: entity.geolibreLayerId,
            featureId: String(feature.id ?? entity.index),
            properties: feature.properties ?? {},
            geometry: feature.geometry,
          }
        : null;
    }
    // The WeakMap first: it answers in constant time for every GeoJSON entity,
    // and this runs per hovered entity on every mouse move, not only on click.
    // Cesium builds CZML entities from the document itself, so they never pass
    // through `featureRefs` and are traced back to their data source only once
    // that has come up empty.
    const ref = this.featureRefs.get(entity);
    if (!ref) return this.resolveCzmlFeature(entity);
    const entry = this.entries.get(ref.layerId);
    if (
      !entry ||
      entry.cancelled ||
      !entry.layer.visible ||
      entry.layer.opacity <= 0 ||
      entry.kind !== "geojson" ||
      (entity as { show?: boolean }).show === false ||
      !(entry.handle as DataSource | null)?.entities.contains(entity as Entity)
    )
      return null;
    const feature = entry.layer.geojson?.features[ref.index];
    return feature
      ? {
          layerId: ref.layerId,
          featureId: String(feature.id ?? ref.index),
          properties: feature.properties ?? {},
          geometry: feature.geometry,
        }
      : null;
  }

  /**
   * Identify a picked CZML entity (issue #2504), or null when no loaded CZML
   * document owns it.
   *
   * A CZML entity's position is a time-dynamic property, not stored geometry,
   * so `geometry` is null — that is the whole answer, not a gap in it. What a
   * click can read is the packet's `name` plus whatever custom `properties` the
   * document carries, sampled at the viewer's current time (an earthquake's
   * magnitude and depth, a satellite's catalogue number). Ownership is found by
   * asking each loaded document whether it holds the entity: there are only
   * ever a handful of CZML layers, and an entity the `featureRefs` WeakMap
   * already claims never reaches this. It does run per hovered entity on a
   * mouse move, though — `identifyAtScreen` drives the hover tooltip — so the
   * scan stays a short walk over loaded documents rather than over entities.
   */
  private resolveCzmlFeature(entity: object): {
    layerId: string;
    featureId: string;
    properties: Record<string, unknown>;
    geometry: null;
  } | null {
    if ((entity as { show?: boolean }).show === false) return null;
    for (const entry of this.entries.values()) {
      if (entry.kind !== "czml" || entry.cancelled || !entry.added) continue;
      if (!entry.layer.visible || entry.layer.opacity <= 0) continue;
      const entities = (entry.handle as DataSource | null)?.entities;
      if (!entities?.contains(entity as Entity)) continue;
      const target = entity as Entity;
      const properties: Record<string, unknown> = {};
      if (target.name) properties.name = target.name;
      const custom = target.properties?.getValue(this.viewer.clock.currentTime) as
        | Record<string, unknown>
        | undefined;
      if (custom) {
        for (const [key, value] of Object.entries(custom)) {
          if (key === "tleLine1" || key === "tleLine2") continue;
          // A nested property bag has no useful flat rendering in the popup.
          if (value !== undefined && (value === null || typeof value !== "object"))
            properties[key] = value;
        }
      }
      return {
        layerId: entry.layer.id,
        featureId: String(target.id),
        properties,
        geometry: null,
      };
    }
    return null;
  }

  /**
   * Retained for future asynchronous imagery feature queries, as requested in #2274.
   * Imagery has a layer identity, but no synchronous GeoJSON feature identity.
   */
  imageryLayerId(imagery: object): string | undefined {
    return this.imageryRefs.get(imagery);
  }

  /**
   * Attach a plugin-owned moving point collection to a store layer.
   *
   * The plugin remains responsible for propagation and collection lifetime;
   * the synchronizer owns identification, selection highlighting, visibility,
   * and camera fitting. Keeping that integration behind one interface avoids
   * every moving-overlay plugin growing its own competing click handler.
   */
  registerMovingPointLayer(
    layerId: string,
    collection: PointPrimitiveCollection,
    descriptions: readonly MovingPointFeatureDescription[] = [],
  ): () => void {
    const primitives = new WeakSet<object>();
    for (let index = 0; index < collection.length; index += 1) {
      const point = collection.get(index);
      if (point) primitives.add(point as unknown as object);
    }
    this.movingPointLayers.set(layerId, { collection, primitives, descriptions });
    const entry = this.entries.get(layerId);
    if (entry) collection.show = entry.layer.visible;
    return () => {
      if (this.movingPointLayers.get(layerId)?.collection === collection)
        this.movingPointLayers.delete(layerId);
    };
  }

  /** Current world positions for selected document entities, used for camera fitting. */
  featurePositions(layerId: string, ids: readonly string[]): Cartesian3[] {
    const entry = this.entries.get(layerId);
    const moving = this.movingPointLayers.get(layerId);
    if (entry && moving) {
      const selected = new Set(ids);
      const features = entry.layer.geojson?.features ?? [];
      const positions: Cartesian3[] = [];
      for (let index = 0; index < moving.collection.length; index += 1) {
        const point = moving.collection.get(index);
        const ref = point?.id;
        if (!isBatchedPointRef(ref)) continue;
        const feature = features[ref.index];
        if (feature && selected.has(String(feature.id ?? ref.index)) && point.position)
          positions.push(point.position);
      }
      return positions;
    }
    if (!entry?.handle || (entry.kind !== "czml" && entry.kind !== "kml")) return [];
    const entities = (entry.handle as DataSource).entities;
    const time = this.viewer.clock.currentTime;
    return ids.flatMap((id) => {
      const position = entities.getById(id)?.position?.getValue(time);
      return position ? [position] : [];
    });
  }

  highlight(layerId: string | undefined, ids: string[]): void {
    this.restoreHighlight();
    this.selection = layerId && ids.length ? { layerId, ids: new Set(ids) } : null;
    this.applyHighlight();
    this.viewer.scene.requestRender();
  }

  protected restoreHighlight(): void {
    for (const restore of this.highlightRestorers.splice(0)) restore();
  }

  protected applyHighlight(): void {
    const selected = this.selection;
    const entry = selected && this.entries.get(selected.layerId);
    if (!selected || !entry) return;
    const C = this.Cesium;
    const color = C.Color.fromCssColorString("#facc15");
    const moving = this.movingPointLayers.get(selected.layerId);
    if (moving) {
      const features = entry.layer.geojson?.features ?? [];
      for (let index = 0; index < moving.collection.length; index += 1) {
        const point = moving.collection.get(index);
        const ref = point?.id;
        if (!isBatchedPointRef(ref)) continue;
        const feature = features[ref.index];
        if (!feature || !selected.ids.has(String(feature.id ?? ref.index))) continue;
        // PointPrimitive's setter clones into its existing internal Color.
        // Keeping the getter result would alias that object, so painting it
        // yellow would also overwrite the value meant to restore it later.
        const original = C.Color.clone(point.color);
        point.color = color;
        this.highlightRestorers.push(() => {
          point.color = original;
        });
        const description = moving.descriptions[ref.index];
        if (description) {
          this.describeSelectedMovingPoint(description, color);
          this.labelSelectedMovingPoint(point, description.name);
        }
      }
      this.viewer.scene.requestRender();
      return;
    }
    if (!entry.handle) return;
    if (entry.kind === "points") {
      const collection = entry.handle as PointPrimitiveCollection;
      const features = entry.layer.geojson?.features ?? [];
      for (let i = 0; i < collection.length; i++) {
        const point = collection.get(i);
        const ref = point.id;
        if (!isBatchedPointRef(ref)) continue;
        const feature = features[ref.index];
        if (!feature || !selected.ids.has(String(feature.id ?? ref.index))) continue;
        const original = C.Color.clone(point.color);
        point.color = color;
        this.highlightRestorers.push(() => {
          point.color = original;
        });
      }
      this.viewer.scene.requestRender();
      return;
    }
    if (entry.kind === "czml" || entry.kind === "kml") {
      const entities = (entry.handle as DataSource).entities;
      for (const id of selected.ids) {
        const entity = entities.getById(id);
        if (!entity?.point) continue;
        const original = entity.point;
        const highlighted = original.clone();
        highlighted.color = new C.ConstantProperty(color);
        entity.point = highlighted;
        this.highlightRestorers.push(() => {
          entity.point = original;
        });
        if (entry.kind === "czml") this.describeSelectedCzmlEntity(entity, color);
      }
      this.viewer.scene.requestRender();
      return;
    }
    if (entry.kind !== "geojson") return;
    for (const entity of (entry.handle as DataSource).entities.values) {
      const ref = this.featureRefs.get(entity);
      const feature = ref && entry.layer.geojson?.features[ref.index];
      if (!feature || !selected.ids.has(String(feature.id ?? ref?.index))) continue;
      for (const key of ["polygon", "polyline", "billboard", "point"] as const) {
        const original = entity[key];
        if (!original) continue;
        const highlighted = original.clone();
        if (key === "polygon" || key === "polyline") {
          (highlighted as NonNullable<Entity["polygon"]>).material = new C.ColorMaterialProperty(
            color,
          );
        } else {
          (highlighted as NonNullable<Entity["point"]>).color = new C.ConstantProperty(color);
        }
        // Keep the actual Property objects, including time-varying styles, intact.
        Object.assign(entity, { [key]: highlighted });
        this.highlightRestorers.push(() => Object.assign(entity, { [key]: original }));
      }
    }
    this.viewer.scene.requestRender();
  }

  /** Build the closed, inertially fixed ring shared by core and dense satellites. */
  private selectedTleOrbitPositions(
    tleLine1: string,
    tleLine2: string,
    orbitalPeriodMinutes?: number,
  ): Cartesian3[] | null {
    const C = this.Cesium;
    try {
      const satrec = twoline2satrec(tleLine1, tleLine2);
      const periodSeconds =
        typeof orbitalPeriodMinutes === "number" &&
        Number.isFinite(orbitalPeriodMinutes) &&
        orbitalPeriodMinutes > 0
          ? orbitalPeriodMinutes * 60
          : (2 * Math.PI * 60) / satrec.no;
      const referenceDate = C.JulianDate.toDate(this.viewer.clock.currentTime);
      const fixedGmst = gstime(referenceDate);
      const positions: Cartesian3[] = [];
      for (let index = 0; index < SELECTED_ORBIT_STEPS; index += 1) {
        const at = new Date(
          referenceDate.getTime() + (index * periodSeconds * 1000) / SELECTED_ORBIT_STEPS,
        );
        const propagated = propagate(satrec, at);
        const position = propagated?.position;
        if (!position || typeof position === "boolean") continue;
        // Fix GMST to the selection epoch. Advancing Earth rotation while
        // sampling leaves the final point west of the first and looks clipped.
        const ecf = eciToEcf(position, fixedGmst);
        positions.push(new C.Cartesian3(ecf.x * 1000, ecf.y * 1000, ecf.z * 1000));
      }
      if (positions.length < 3) return null;
      const first = positions[0];
      positions.push(new C.Cartesian3(first.x, first.y, first.z));
      return positions;
    } catch {
      return null;
    }
  }

  /**
   * Draw a selection-only orbit as one synchronous scene primitive.
   *
   * A polyline attached to a moving Entity can be routed through Cesium's
   * dynamic updater, where depthFailMaterial is not preserved. The explicit
   * primitive mirrors the upstream God's Eye View renderer: it stays bright in
   * front of Earth, keeps a dim behind-Earth segment, and is added after the
   * dense point cloud so the selected orbit remains legible.
   */
  private showSelectedOrbit(positions: readonly Cartesian3[], color: Color): void {
    const C = this.Cesium;
    const primitive = new C.Primitive({
      geometryInstances: new C.GeometryInstance({
        geometry: new C.PolylineGeometry({
          positions: [...positions],
          width: 2,
          vertexFormat: C.PolylineColorAppearance.VERTEX_FORMAT,
        }),
        attributes: {
          color: C.ColorGeometryInstanceAttribute.fromColor(color.withAlpha(0.6)),
          depthFailColor: C.ColorGeometryInstanceAttribute.fromColor(color.withAlpha(0.35)),
        },
      }),
      appearance: new C.PolylineColorAppearance({ translucent: true }),
      depthFailAppearance: new C.PolylineColorAppearance({ translucent: true }),
      asynchronous: false,
      allowPicking: false,
    });
    this.viewer.scene.primitives.add(primitive);
    this.highlightRestorers.push(() => {
      this.viewer.scene.primitives.remove(primitive);
    });
  }

  /** Add selection-only orbit chrome for a plugin-owned moving point. */
  private describeSelectedMovingPoint(
    description: MovingPointFeatureDescription,
    color: Color,
  ): void {
    const positions = this.selectedTleOrbitPositions(
      description.tleLine1,
      description.tleLine2,
      description.orbitalPeriodMinutes,
    );
    if (positions) this.showSelectedOrbit(positions, color);
  }

  /** Label only the selected moving point and keep the label attached as it propagates. */
  private labelSelectedMovingPoint(point: PointPrimitive, name: string): void {
    const text = name.trim();
    if (!text) return;
    const C = this.Cesium;
    const collection = new C.LabelCollection({ scene: this.viewer.scene });
    const offsetRight = new C.Cartesian2(-16, -19);
    const offsetLeft = new C.Cartesian2(16, -19);
    const screenScratch = new C.Cartesian2();
    const label = collection.add({
      position: point.position,
      text,
      font: "600 13px sans-serif",
      style: C.LabelStyle.FILL_AND_OUTLINE,
      fillColor: C.Color.WHITE,
      outlineColor: C.Color.BLACK,
      outlineWidth: 3,
      showBackground: true,
      backgroundColor: C.Color.BLACK.withAlpha(0.82),
      backgroundPadding: new C.Cartesian2(6, 4),
      horizontalOrigin: C.HorizontalOrigin.RIGHT,
      pixelOffset: offsetRight,
    });
    const followPoint = () => {
      label.position = point.position;
      const screen = C.SceneTransforms.worldToWindowCoordinates(
        this.viewer.scene,
        point.position,
        screenScratch,
      );
      // Dense popups are about 300 px wide. They flip to the left when the
      // right side is tight; keep the label on the other side of the point.
      // worldToWindowCoordinates returns canvas-local CSS pixel coordinates,
      // so compare directly against clientWidth without a per-frame layout reflow.
      const canvas = this.viewer.scene.canvas;
      const popupFitsRight = !screen || screen.x <= canvas.clientWidth / 2;
      label.horizontalOrigin = popupFitsRight ? C.HorizontalOrigin.RIGHT : C.HorizontalOrigin.LEFT;
      label.pixelOffset = popupFitsRight ? offsetRight : offsetLeft;
    };
    followPoint();
    this.viewer.scene.preRender.addEventListener(followPoint);
    this.viewer.scene.primitives.add(collection);
    this.highlightRestorers.push(() => {
      this.viewer.scene.preRender.removeEventListener(followPoint);
      this.viewer.scene.primitives.remove(collection);
    });
  }

  /**
   * Name and trace the one CZML entity the user picked.
   *
   * A time-dynamic document is a crowd: naming every entity buries the globe
   * under labels Cesium will not declutter, so the document itself labels only
   * what is worth a standing name. Selecting one is the user asking *which is
   * that* — so it gets its name and, when its position is sampled over time,
   * the arc it is flying, both taken off as part of the highlight so clearing
   * the selection leaves the document exactly as its author wrote it.
   */
  private describeSelectedCzmlEntity(entity: Entity, color: Color): void {
    const C = this.Cesium;
    if (!entity.label && entity.name) {
      entity.label = new C.LabelGraphics({
        text: entity.name,
        font: "600 13px sans-serif",
        style: C.LabelStyle.FILL_AND_OUTLINE,
        fillColor: C.Color.WHITE,
        outlineColor: C.Color.BLACK,
        outlineWidth: 3,
        showBackground: true,
        backgroundColor: C.Color.BLACK.withAlpha(0.82),
        backgroundPadding: new C.Cartesian2(6, 4),
        pixelOffset: new C.Cartesian2(0, -19),
      });
      this.highlightRestorers.push(() => {
        entity.label = undefined;
      });
    }
    if (entity.path || entity.polyline || !(entity.position instanceof C.SampledPositionProperty))
      return;
    const time = this.viewer.clock.currentTime;
    const tleLine1 = entity.properties?.tleLine1?.getValue(time) as string | undefined;
    const tleLine2 = entity.properties?.tleLine2?.getValue(time) as string | undefined;
    if (tleLine1 && tleLine2) {
      const minutes = entity.properties?.orbitalPeriodMinutes?.getValue(time) as number | undefined;
      const positions = this.selectedTleOrbitPositions(tleLine1, tleLine2, minutes);
      if (positions) {
        this.showSelectedOrbit(positions, color);
        return;
      }
    }
    // Generic CZML has no TLE from which to build a closed ring. Retain the
    // bounded temporal-path fallback for those documents.
    // The packet reports its own period where it knows one (a satellite does),
    // so the ring closes on itself instead of being cut to an arbitrary length.
    const minutes = entity.properties?.orbitalPeriodMinutes?.getValue(time) as number | undefined;
    const halfPeriodSeconds =
      typeof minutes === "number" && Number.isFinite(minutes) && minutes > 0
        ? (minutes * 60) / 2
        : 45 * 60;
    // Never ask for more arc than the document sampled. A sampled position does
    // not extrapolate, so half a period of lead on a 24-hour GEO orbit sampled
    // over three hours draws a line that stops dead rather than a ring; the
    // entity's availability is exactly the span its samples cover.
    const now = time;
    const availability = entity.availability;
    const sampledBack = availability
      ? Math.max(0, C.JulianDate.secondsDifference(now, availability.start))
      : halfPeriodSeconds;
    const sampledAhead = availability
      ? Math.max(0, C.JulianDate.secondsDifference(availability.stop, now))
      : halfPeriodSeconds;
    entity.path = new C.PathGraphics({
      show: true,
      width: 1,
      leadTime: Math.min(halfPeriodSeconds, sampledAhead),
      trailTime: Math.min(halfPeriodSeconds, sampledBack),
      material: new C.ColorMaterialProperty(color.withAlpha(0.6)),
    });
    this.highlightRestorers.push(() => {
      entity.path = undefined;
    });
  }
}

import * as turf from "@turf/turf";
import type { Feature, FeatureCollection, Polygon, MultiPolygon } from "geojson";
import type { AreaFeature, AreaGeometry, GeometryEffect } from "./types.js";

function asFeature(value: AreaFeature | AreaGeometry): AreaFeature {
  return value.type === "Feature" ? value : turf.feature(value);
}

export function normalizeArea(
  input: AreaFeature | AreaGeometry | FeatureCollection<Polygon | MultiPolygon>,
): AreaFeature {
  if (input.type === "FeatureCollection") {
    if (input.features.length === 0) throw new Error("Area contains no polygon features");
    if (input.features.length === 1) return input.features[0] as AreaFeature;
    const united = turf.union(input as FeatureCollection<Polygon | MultiPolygon>);
    if (!united) throw new Error("Area polygons could not be combined");
    return asFeature(united as AreaFeature);
  }
  return asFeature(input as AreaFeature | AreaGeometry);
}

export function intersectAreas(left: AreaFeature, right: AreaFeature): AreaFeature | null {
  const result = turf.intersect(turf.featureCollection([left, right]) as any);
  return result ? normalizeArea(result as AreaFeature) : null;
}

export function subtractArea(left: AreaFeature, right: AreaFeature): AreaFeature | null {
  const result = turf.difference(turf.featureCollection([left, right]) as any);
  return result ? normalizeArea(result as AreaFeature) : null;
}

export function applyGeometryEffect(
  area: AreaFeature | null,
  effect: GeometryEffect,
): AreaFeature | null {
  if (!area) return null;
  return effect.mode === "INTERSECT"
    ? intersectAreas(area, effect.geometry)
    : subtractArea(area, effect.geometry);
}

export function recomputePossibleArea(
  boundary: AreaFeature,
  effects: GeometryEffect[],
): AreaFeature | null {
  let current: AreaFeature | null = normalizeArea(boundary);
  for (const effect of effects) current = applyGeometryEffect(current, effect);
  return current;
}

export function radarCircle(center: [number, number], radiusMeters: number): AreaFeature {
  return normalizeArea(
    turf.circle(center, radiusMeters / 1000, { units: "kilometers", steps: 96 }) as AreaFeature,
  );
}

export function thermometerRegion(
  boundary: AreaFeature,
  start: [number, number],
  end: [number, number],
  target: "START" | "END",
): AreaFeature {
  const bounds = turf.bbox(boundary);
  const span = Math.max(bounds[2] - bounds[0], bounds[3] - bounds[1], 0.1);
  const padding = span * 4;
  const box: [number, number, number, number] = [
    Math.max(-180, bounds[0] - padding),
    Math.max(-85, bounds[1] - padding),
    Math.min(180, bounds[2] + padding),
    Math.min(85, bounds[3] + padding),
  ];
  const sites = turf.featureCollection([
    turf.point(start, { site: "START" }),
    turf.point(end, { site: "END" }),
  ]);
  const cells = turf.voronoi(sites, { bbox: box });
  const point = turf.point(target === "START" ? start : end);
  const cell = cells.features.find(
    (candidate): candidate is Feature<Polygon> =>
      Boolean(candidate) && turf.booleanPointInPolygon(point, candidate as Feature<Polygon>),
  );
  if (!cell) throw new Error("Thermometer region could not be constructed");
  return normalizeArea(cell);
}

export function findContainingArea(
  collection: FeatureCollection<Polygon | MultiPolygon>,
  point: [number, number],
): AreaFeature | null {
  const target = turf.point(point);
  return collection.features.find((feature) => turf.booleanPointInPolygon(target, feature)) ?? null;
}

export function areaSquareKilometers(area: AreaFeature | null): number {
  return area ? turf.area(area) / 1_000_000 : 0;
}

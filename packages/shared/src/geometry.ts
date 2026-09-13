import * as turf from "@turf/turf";
import type { Feature, FeatureCollection, LineString, Polygon, MultiPolygon } from "geojson";
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

const WEB_MERCATOR_RADIUS = 6_378_137;

function projectToWebMercator(point: [number, number]): [number, number] {
  const longitude = (point[0] * Math.PI) / 180;
  const latitude = (Math.max(-85, Math.min(85, point[1])) * Math.PI) / 180;
  return [
    WEB_MERCATOR_RADIUS * longitude,
    WEB_MERCATOR_RADIUS * Math.log(Math.tan(Math.PI / 4 + latitude / 2)),
  ];
}

function unprojectFromWebMercator(point: [number, number]): [number, number] {
  return [
    (point[0] / WEB_MERCATOR_RADIUS) * (180 / Math.PI),
    (2 * Math.atan(Math.exp(point[1] / WEB_MERCATOR_RADIUS)) - Math.PI / 2) * (180 / Math.PI),
  ];
}

interface ThermometerPlane {
  divider: Feature<LineString>;
  targetHalfPlane: AreaFeature;
}

function thermometerPlane(
  boundary: AreaFeature,
  start: [number, number],
  end: [number, number],
  target: "START" | "END",
): ThermometerPlane {
  const projectedStart = projectToWebMercator(start);
  const projectedEnd = projectToWebMercator(end);
  const delta: [number, number] = [
    projectedEnd[0] - projectedStart[0],
    projectedEnd[1] - projectedStart[1],
  ];
  const length = Math.hypot(delta[0], delta[1]);
  if (length === 0) throw new Error("Thermometer start and end point must differ");

  const midpoint: [number, number] = [
    (projectedStart[0] + projectedEnd[0]) / 2,
    (projectedStart[1] + projectedEnd[1]) / 2,
  ];
  const perpendicular: [number, number] = [delta[1] / length, -delta[0] / length];
  const targetDirection: [number, number] =
    target === "END"
      ? [delta[0] / length, delta[1] / length]
      : [-delta[0] / length, -delta[1] / length];

  const bounds = turf.bbox(boundary);
  const projectedSouthWest = projectToWebMercator([bounds[0], bounds[1]]);
  const projectedNorthEast = projectToWebMercator([bounds[2], bounds[3]]);
  const boundarySpan = Math.hypot(
    projectedNorthEast[0] - projectedSouthWest[0],
    projectedNorthEast[1] - projectedSouthWest[1],
  );
  const reach = Math.max(boundarySpan * 4, length * 4, 10_000);
  const offset = (origin: [number, number], vector: [number, number], amount: number) =>
    [origin[0] + vector[0] * amount, origin[1] + vector[1] * amount] as [number, number];

  const dividerStart = offset(midpoint, perpendicular, -reach);
  const dividerEnd = offset(midpoint, perpendicular, reach);
  const farStart = offset(dividerStart, targetDirection, reach * 2);
  const farEnd = offset(dividerEnd, targetDirection, reach * 2);

  return {
    divider: turf.lineString([
      unprojectFromWebMercator(dividerStart),
      unprojectFromWebMercator(dividerEnd),
    ]),
    targetHalfPlane: turf.polygon([
      [
        unprojectFromWebMercator(dividerStart),
        unprojectFromWebMercator(dividerEnd),
        unprojectFromWebMercator(farEnd),
        unprojectFromWebMercator(farStart),
        unprojectFromWebMercator(dividerStart),
      ],
    ]) as AreaFeature,
  };
}

export function thermometerDivider(
  boundary: AreaFeature,
  start: [number, number],
  end: [number, number],
): Feature<LineString> {
  return thermometerPlane(boundary, start, end, "END").divider;
}

export function thermometerRegion(
  boundary: AreaFeature,
  start: [number, number],
  end: [number, number],
  target: "START" | "END",
): AreaFeature {
  const plane = thermometerPlane(boundary, start, end, target);
  const region = intersectAreas(boundary, plane.targetHalfPlane);
  if (!region) throw new Error("Thermometer region does not overlap the game boundary");
  return region;
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

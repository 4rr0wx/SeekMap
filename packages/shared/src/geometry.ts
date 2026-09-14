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
    if (input.features.length === 1) {
      const feature = input.features[0] as AreaFeature;
      if (feature.geometry?.type !== "Polygon" && feature.geometry?.type !== "MultiPolygon") {
        throw new Error("Area feature must have Polygon or MultiPolygon geometry");
      }
      if (!feature.geometry.coordinates || feature.geometry.coordinates.length === 0) {
        throw new Error("Area polygon must contain at least one ring");
      }
      return feature;
    }
    const united = turf.union(input as FeatureCollection<Polygon | MultiPolygon>);
    if (!united) throw new Error("Area polygons could not be combined");
    return asFeature(united as AreaFeature);
  }
  const geom = input.type === "Feature" ? input.geometry : input;
  if (!geom || (geom.type !== "Polygon" && geom.type !== "MultiPolygon")) {
    throw new Error("Area feature must have Polygon or MultiPolygon geometry");
  }
  if (!geom.coordinates || geom.coordinates.length === 0) {
    throw new Error("Area polygon must contain at least one ring");
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

export interface BoundaryOperation {
  mode: "ADD" | "SUBTRACT";
  boundary: AreaFeature;
}

export function combineBoundaries(operations: BoundaryOperation[]): AreaFeature | null {
  const addOps = operations.filter((op) => op.mode === "ADD");
  if (addOps.length === 0) return null;

  let current: AreaFeature;
  try {
    const firstAdd = addOps[0];
    if (!firstAdd) return null;
    if (addOps.length === 1) {
      current = normalizeArea(firstAdd.boundary);
    } else {
      current = normalizeArea(turf.featureCollection(addOps.map((op) => op.boundary)));
    }
  } catch {
    return null;
  }

  const subtractOps = operations.filter((op) => op.mode === "SUBTRACT");
  for (const op of subtractOps) {
    try {
      const next = subtractArea(current, op.boundary);
      if (!next) return null;
      current = next;
    } catch {
      return null;
    }
  }

  return current;
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

export function projectToWebMercator(point: [number, number]): [number, number] {
  const longitude = (point[0] * Math.PI) / 180;
  const latitude = (Math.max(-85, Math.min(85, point[1])) * Math.PI) / 180;
  return [
    WEB_MERCATOR_RADIUS * longitude,
    WEB_MERCATOR_RADIUS * Math.log(Math.tan(Math.PI / 4 + latitude / 2)),
  ];
}

export function unprojectFromWebMercator(point: [number, number]): [number, number] {
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
  const boundaryCenter: [number, number] = [
    (projectedSouthWest[0] + projectedNorthEast[0]) / 2,
    (projectedSouthWest[1] + projectedNorthEast[1]) / 2,
  ];
  const boundarySpan = Math.hypot(
    projectedNorthEast[0] - projectedSouthWest[0],
    projectedNorthEast[1] - projectedSouthWest[1],
  );
  const distFromMidpoint = Math.hypot(
    midpoint[0] - boundaryCenter[0],
    midpoint[1] - boundaryCenter[1],
  );
  const reach = Math.max(boundarySpan * 2 + distFromMidpoint, length * 2, 20_000);
  const offset = (origin: [number, number], vector: [number, number], amount: number) =>
    [origin[0] + vector[0] * amount, origin[1] + vector[1] * amount] as [number, number];

  const dividerStart = offset(midpoint, perpendicular, -reach);
  const dividerEnd = offset(midpoint, perpendicular, reach);
  const farStart = offset(dividerStart, targetDirection, reach * 2);
  const farEnd = offset(dividerEnd, targetDirection, reach * 2);

  // Sample divider in Web Mercator space so that Turf's planar Euclidean clipping
  // in WGS84 coordinates accurately preserves the Mercator divider line
  // without bowing or shifting due to projection non-linearity over long distances.
  const steps = Math.max(64, Math.min(256, Math.ceil((reach * 2) / 2000) * 2));
  const dividerCoords: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const frac = i / steps;
    dividerCoords.push(
      unprojectFromWebMercator([
        dividerStart[0] + frac * (dividerEnd[0] - dividerStart[0]),
        dividerStart[1] + frac * (dividerEnd[1] - dividerStart[1]),
      ]),
    );
  }

  const targetHalfPlane = turf.rewind(
    turf.polygon([
      [
        ...dividerCoords,
        unprojectFromWebMercator(farEnd),
        unprojectFromWebMercator(farStart),
        dividerCoords[0]!,
      ],
    ]),
    { mutate: true },
  ) as AreaFeature;

  return {
    divider: turf.lineString(dividerCoords),
    targetHalfPlane,
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

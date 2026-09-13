import * as turf from "@turf/turf";
import type { Feature, Point } from "geojson";
import {
  intersectAreas,
  normalizeArea,
  radarCircle,
  subtractArea,
  thermometerRegion,
} from "./geometry.js";
import type { AreaFeature, MapFeature, UploadedDataset } from "./types.js";

export interface DatasetPlace {
  index: number;
  name: string;
  point: Feature<Point>;
}

function placeName(feature: MapFeature, index: number): string {
  const properties = feature.properties ?? {};
  for (const key of ["name", "Name", "title", "Title", "description"]) {
    const value = properties[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return `Place ${index + 1}`;
}

export function datasetPlaces(dataset: UploadedDataset, boundary: AreaFeature): DatasetPlace[] {
  const seen = new Set<string>();
  return dataset.geojson.features.flatMap((feature, index) => {
    let point: Feature<Point>;
    if (feature.geometry.type === "Point") point = feature as Feature<Point>;
    else point = turf.pointOnFeature(feature) as Feature<Point>;
    if (!turf.booleanPointInPolygon(point, boundary)) return [];
    const key = point.geometry.coordinates.map((value) => value.toFixed(7)).join(",");
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ index, name: placeName(feature, index), point }];
  });
}

export function nearestDatasetPlace(
  places: DatasetPlace[],
  position: [number, number],
): (DatasetPlace & { distanceMeters: number }) | null {
  let nearest: (DatasetPlace & { distanceMeters: number }) | null = null;
  for (const place of places) {
    const distanceMeters = turf.distance(position, place.point, { units: "meters" });
    if (!nearest || distanceMeters < nearest.distanceMeters) nearest = { ...place, distanceMeters };
  }
  return nearest;
}

export function candidateTentaclePlaces(
  places: DatasetPlace[],
  referencePoint: [number, number],
  radiusMeters: number,
  maxCandidates = 15,
): (DatasetPlace & { distanceMeters: number })[] {
  const candidates = places
    .map((place) => ({
      ...place,
      distanceMeters: turf.distance(referencePoint, place.point, { units: "meters" }),
    }))
    .filter((place) => place.distanceMeters <= radiusMeters)
    .sort((a, b) => a.distanceMeters - b.distanceMeters);

  return candidates.slice(0, maxCandidates);
}

export function tentaclePlaceRegion(
  circleInBoundary: AreaFeature,
  candidatePlaces: DatasetPlace[],
  selected: DatasetPlace,
): AreaFeature {
  let region = circleInBoundary;
  const selectedPosition = selected.point.geometry.coordinates as [number, number];
  for (const other of candidatePlaces) {
    if (other.index === selected.index) continue;
    const otherPosition = other.point.geometry.coordinates as [number, number];
    const nearerHalf = thermometerRegion(region, selectedPosition, otherPosition, "START");
    const clipped = intersectAreas(region, nearerHalf);
    if (!clipped) continue;
    region = clipped;
  }
  return region;
}

export function tentaclesVisualizationFeatures(
  dataset: UploadedDataset,
  context: { boundary: AreaFeature },
  referencePoint: [number, number],
  radiusMeters: number,
) {
  const places = datasetPlaces(dataset, context.boundary);
  if (places.length === 0) {
    throw new Error(`${dataset.name} has no usable places inside the game boundary`);
  }
  const circle = radarCircle(referencePoint, radiusMeters);
  const circleInBoundary = intersectAreas(context.boundary, circle);
  const candidatePlaces = candidateTentaclePlaces(places, referencePoint, radiusMeters);
  const common = { datasetId: dataset.id, datasetName: dataset.name };

  const circleBoundaryLine = turf.polygonToLine(circle);
  const boundaryFeatures = circleBoundaryLine
    ? circleBoundaryLine.type === "FeatureCollection"
      ? circleBoundaryLine.features.map((f) => ({
          ...f,
          properties: { ...common, artifactRole: "decision-boundary" },
        }))
      : [{ ...circleBoundaryLine, properties: { ...common, artifactRole: "decision-boundary" } }]
    : [];

  const tentacleArms = candidatePlaces.map((candidate) =>
    turf.lineString([referencePoint, candidate.point.geometry.coordinates as [number, number]], {
      ...common,
      artifactRole: "reference-line",
      placeIndex: candidate.index,
      placeName: candidate.name,
    }),
  );

  const placePoints = places.map((place) => {
    const isCandidate = candidatePlaces.some((c) => c.index === place.index);
    return {
      ...place.point,
      properties: {
        ...(place.point.properties ?? {}),
        ...common,
        artifactRole: "dataset-place",
        placeIndex: place.index,
        placeName: place.name,
        inRadius: isCandidate,
      },
    };
  });

  const centerPoint = turf.point(referencePoint, {
    ...common,
    artifactRole: "seeker-reference",
    radiusMeters,
  });

  return {
    places,
    candidatePlaces,
    circleInBoundary,
    features: [centerPoint, ...boundaryFeatures, ...tentacleArms, ...placePoints] as MapFeature[],
  };
}

export function matchingPlaceRegion(
  boundary: AreaFeature,
  places: DatasetPlace[],
  selected: DatasetPlace,
): AreaFeature {
  let region = normalizeArea(boundary);
  const selectedPosition = selected.point.geometry.coordinates as [number, number];
  for (const other of places) {
    if (other.index === selected.index) continue;
    const otherPosition = other.point.geometry.coordinates as [number, number];
    const nearerHalf = thermometerRegion(region, selectedPosition, otherPosition, "START");
    const clipped = intersectAreas(region, nearerHalf);
    if (!clipped) throw new Error("Matching region could not be constructed");
    region = clipped;
  }
  return region;
}

export function measuringPlaceRegion(
  boundary: AreaFeature,
  places: DatasetPlace[],
  referencePoint: [number, number],
  answer: "CLOSER" | "FURTHER",
): { region: AreaFeature; referenceDistanceMeters: number } {
  const nearest = nearestDatasetPlace(places, referencePoint);
  if (!nearest) throw new Error("The selected dataset has no places inside the game boundary");
  const circles = places.map((place) =>
    turf.circle(place.point, nearest.distanceMeters / 1000, {
      units: "kilometers",
      steps: 48,
    }),
  );
  const closerArea = normalizeArea(turf.featureCollection(circles));
  const clippedCloser = intersectAreas(boundary, closerArea);
  if (answer === "CLOSER") {
    if (!clippedCloser) throw new Error("No closer area remains inside the game boundary");
    return { region: clippedCloser, referenceDistanceMeters: nearest.distanceMeters };
  }
  const further = clippedCloser ? subtractArea(boundary, clippedCloser) : boundary;
  if (!further) throw new Error("No further area remains inside the game boundary");
  return { region: further, referenceDistanceMeters: nearest.distanceMeters };
}

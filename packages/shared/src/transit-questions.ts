import * as turf from "@turf/turf";
import type { Feature, FeatureCollection, LineString, MultiLineString, Point } from "geojson";
import type { DatasetPlace } from "./place-questions.js";
import type { AreaFeature, MapFeature, TransitMode } from "./types.js";

function stationName(feature: Feature<Point>, index: number): string {
  const properties = feature.properties ?? {};
  for (const key of ["name", "Name", "title", "Title", "ref", "uic_ref"]) {
    const value = properties[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return `Station ${index + 1}`;
}

/** Convert cached transit stations into in-boundary DatasetPlace points for Matching/Measuring. */
export function transitStationsAsPlaces(
  stations: FeatureCollection<Point> | null | undefined,
  boundary: AreaFeature,
): DatasetPlace[] {
  if (!stations?.features.length) return [];
  const seen = new Set<string>();
  return stations.features.flatMap((feature, index) => {
    if (feature.geometry?.type !== "Point") return [];
    const point = feature as Feature<Point>;
    if (!turf.booleanPointInPolygon(point, boundary)) return [];
    const key = point.geometry.coordinates.map((value) => value.toFixed(7)).join(",");
    if (seen.has(key)) return [];
    seen.add(key);
    return [
      {
        index,
        name: stationName(point, index),
        point: {
          ...point,
          properties: {
            ...(point.properties ?? {}),
            artifactRole: "transit-station",
          },
        },
      },
    ];
  });
}

export function requireTransitStations(
  stations: FeatureCollection<Point> | null | undefined,
  boundary: AreaFeature,
): DatasetPlace[] {
  const places = transitStationsAsPlaces(stations, boundary);
  if (places.length === 0) {
    throw new Error(
      "No transit stations are available inside the game boundary. Load transit data before asking this question.",
    );
  }
  return places;
}

export function hasTransitStations(stations: FeatureCollection<Point> | null | undefined): boolean {
  return Boolean(stations?.features.some((feature) => feature.geometry?.type === "Point"));
}

export function hasTransitLines(
  lines: FeatureCollection<LineString | MultiLineString> | null | undefined,
): boolean {
  return Boolean(
    lines?.features.some(
      (feature) =>
        feature.geometry?.type === "LineString" || feature.geometry?.type === "MultiLineString",
    ),
  );
}

export function transitStationVisualizationFeatures(
  places: DatasetPlace[],
  referencePoint: [number, number],
): MapFeature[] {
  return [
    turf.point(referencePoint, {
      artifactRole: "seeker-reference",
      label: "Seeker reference",
    }),
    ...places.map((place) => ({
      ...place.point,
      properties: {
        ...(place.point.properties ?? {}),
        artifactRole: "transit-station",
        placeIndex: place.index,
        placeName: place.name,
      },
    })),
  ] as MapFeature[];
}

export function lineLabel(feature: Feature<LineString | MultiLineString>, index: number): string {
  const properties = feature.properties ?? {};
  for (const key of ["name", "Name", "ref", "route_ref"]) {
    const value = properties[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  const mode = properties.transitMode;
  if (typeof mode === "string" && mode.trim()) return `${mode} line ${index + 1}`;
  return `Transit line ${index + 1}`;
}

export function enabledTransitModes(modes: TransitMode[] | null | undefined): TransitMode[] | null {
  return modes?.length ? modes : null;
}

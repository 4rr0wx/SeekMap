import * as turf from "@turf/turf";
import type { Feature, FeatureCollection, LineString, MultiLineString, Point } from "geojson";
import type { DatasetPlace } from "./place-questions.js";
import type { AreaFeature, MapFeature, TransitMode } from "./types.js";

const TRANSIT_MODES: readonly TransitMode[] = ["train", "light_rail", "subway", "tram"];

function isTransitMode(value: unknown): value is TransitMode {
  return typeof value === "string" && (TRANSIT_MODES as readonly string[]).includes(value);
}

function stationName(feature: Feature<Point>, index: number): string {
  const properties = feature.properties ?? {};
  for (const key of ["name", "Name", "title", "Title", "ref", "uic_ref"]) {
    const value = properties[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return `Station ${index + 1}`;
}

/** Infer which transit modes a station serves from OSM tags and stamped import metadata. */
export function inferStationTransitModes(
  properties: Record<string, unknown> | null | undefined,
  options: { includeDefaultTrain?: boolean } = {},
): TransitMode[] {
  const includeDefaultTrain = options.includeDefaultTrain ?? true;
  const props = properties ?? {};
  const modes = new Set<TransitMode>();
  const railway = typeof props.railway === "string" ? props.railway : "";

  if (railway === "tram_stop") modes.add("tram");
  if (props.subway === "yes" || props.station === "subway") modes.add("subway");
  if (props.light_rail === "yes" || props.station === "light_rail") modes.add("light_rail");
  if (props.train === "yes" || props.station === "train") modes.add("train");
  if (props.tram === "yes" || props.station === "tram") modes.add("tram");

  if (isTransitMode(props.transitMode)) modes.add(props.transitMode);
  if (Array.isArray(props.transitModes)) {
    for (const value of props.transitModes) {
      if (isTransitMode(value)) modes.add(value);
    }
  }

  // Untagged station/halt nodes are treated as mainline rail stops unless the
  // caller wants to resolve mode from nearby lines first.
  if (includeDefaultTrain && modes.size === 0 && (railway === "station" || railway === "halt")) {
    modes.add("train");
  }

  return [...modes];
}

export function stationMatchesTransitModes(
  properties: Record<string, unknown> | null | undefined,
  modes: TransitMode[] | null | undefined,
): boolean {
  if (!modes?.length) return true;
  const stationModes = inferStationTransitModes(properties);
  if (stationModes.length === 0) return false;
  return stationModes.some((mode) => modes.includes(mode));
}

/** Convert cached transit stations into in-boundary DatasetPlace points for Matching/Measuring. */
export function transitStationsAsPlaces(
  stations: FeatureCollection<Point> | null | undefined,
  boundary: AreaFeature,
  modes?: TransitMode[] | null,
): DatasetPlace[] {
  if (!stations?.features.length) return [];
  const seen = new Set<string>();
  return stations.features.flatMap((feature, index) => {
    if (feature.geometry?.type !== "Point") return [];
    const point = feature as Feature<Point>;
    if (!stationMatchesTransitModes(point.properties, modes)) return [];
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
  modes?: TransitMode[] | null,
): DatasetPlace[] {
  const places = transitStationsAsPlaces(stations, boundary, modes);
  if (places.length === 0) {
    throw new Error(
      modes?.length
        ? "No transit stations for the enabled modes are available inside the game boundary. Load transit data or enable matching modes before asking this question."
        : "No transit stations are available inside the game boundary. Load transit data before asking this question.",
    );
  }
  return places;
}

export function hasTransitStations(
  stations: FeatureCollection<Point> | null | undefined,
  modes?: TransitMode[] | null,
): boolean {
  return Boolean(
    stations?.features.some(
      (feature) =>
        feature.geometry?.type === "Point" && stationMatchesTransitModes(feature.properties, modes),
    ),
  );
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

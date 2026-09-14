import * as turf from "@turf/turf";
import type { Feature, Polygon, MultiPolygon } from "geojson";
import type { LayerSpecification } from "maplibre-gl";
import {
  intersectAreas,
  type AreaFeature,
  type MapFeature,
  type QuestionInstance,
  type TransitMode,
} from "@hideseek/shared";

export const MAP_COLORS = {
  // Game Boundary
  boundaryFill: "#13221f",
  boundaryFillOpacity: 0.14,
  boundaryLine: "#3e5c54",
  boundaryLineWidth: 2.5,

  // Possible Area (Active Hider Search Zone) - Exclusive Signature Gold/Amber
  possibleFill: "#f5b942",
  possibleFillOpacity: 0.22,
  possibleLine: "#d9921e",
  possibleLineWidth: 3,

  // Question Geometry: Active / Selected Question
  questionSelectedFill: "#f06a47",
  questionSelectedFillOpacity: 0.18,
  questionSelectedLine: "#f06a47",
  questionSelectedLineWidth: 3,

  // Question Geometry: Answer Region
  questionAnswerFill: "#ea580c",
  questionAnswerFillOpacity: 0.2,
  questionAnswerLine: "#ea580c",
  questionAnswerLineWidth: 2.5,

  // Question Geometry: Candidate Region (Drafting Radius / Places)
  questionCandidateFill: "#f06a47",
  questionCandidateFillOpacity: 0.08,
  questionCandidateLine: "#f06a47",
  questionCandidateLineWidth: 2,

  // Question Geometry: Decision Boundary (Thermometer Bisector Divider Line)
  questionDividerLine: "#f06a47",
  questionDividerLineWidth: 3,
  questionDividerDash: [4, 3],

  // Question Geometry: Reference Lines (Between Points or Candidates)
  questionReferenceLine: "#f06a47",
  questionReferenceLineWidth: 2,
  questionReferenceDash: [2, 2],

  // Question Geometry: Inactive / Other Questions
  questionDefaultFill: "#6366f1",
  questionDefaultFillOpacity: 0.12,
  questionDefaultLine: "#4f46e5",
  questionDefaultLineWidth: 2,

  // Interaction Points: Point A (Start / Colder / Seeker Reference)
  pointStartA: "#38bdf8",
  pointStartAStroke: "#ffffff",

  // Interaction Points: Point B (End / Hotter / Target)
  pointEndB: "#f06a47",
  pointEndBStroke: "#ffffff",

  // Interaction Points Sizing
  pointRadius: 8.5,
  pointStrokeWidth: 2.5,

  // Transit Lines & Stations
  transitLine: "#0284c7",
  transitTrainLine: "#0284c7",
  transitSubwayLine: "#7c3aed",
  transitTramLine: "#dc2626",
  transitLightRailLine: "#0891b2",
  transitLineWidth: 2.5,
  transitLineOpacity: 0.85,
  stationFill: "#ffffff",
  stationStroke: "#0284c7",
  stationRadius: 4.5,
  stationStrokeWidth: 2,

  // Administrative Boundaries (Districts / Municipalities)
  adminLine: "#64748b",
  adminLineWidth: 1.5,
  adminLineDash: [3, 3],

  // Imported Datasets (Custom KML/KMZ Features) - Distinct Emerald
  datasetFill: "#10b981",
  datasetFillOpacity: 0.18,
  datasetLine: "#059669",
  datasetLineWidth: 2,
  datasetPoint: "#10b981",
  datasetPointStroke: "#ffffff",
  datasetPointRadius: 5,
  datasetPointStrokeWidth: 1.5,

  // Seeker Markers (Strategic Pins) - Distinct Rose Red
  seekerMarkerFill: "#f43f5e",
  seekerMarkerStroke: "#ffffff",
  seekerMarkerRadius: 7.5,
  seekerMarkerStrokeWidth: 2.5,

  // Measurement Tool
  measurementLine: "#fb923c",
  measurementLineWidth: 3.5,
  measurementLineDash: [3, 2],

  // Local GPS User Position
  localGpsFill: "#2563eb",
  localGpsStroke: "#ffffff",
  localGpsRadius: 8,
  localGpsStrokeWidth: 3,
} as const;

export type MapColorToken = keyof typeof MAP_COLORS;

export const TRANSIT_COLORS: Record<TransitMode, string> = {
  train: MAP_COLORS.transitTrainLine,
  light_rail: MAP_COLORS.transitLightRailLine,
  subway: MAP_COLORS.transitSubwayLine,
  tram: MAP_COLORS.transitTramLine,
};

export function getTransitLineColor(properties?: Record<string, unknown> | null): string {
  if (!properties) return MAP_COLORS.transitLine;
  const mode = properties.transitMode ?? properties.railway;
  if (mode === "tram") return MAP_COLORS.transitTramLine;
  if (mode === "subway") return MAP_COLORS.transitSubwayLine;
  if (mode === "light_rail") return MAP_COLORS.transitLightRailLine;
  if (mode === "train" || mode === "rail") return MAP_COLORS.transitTrainLine;
  return MAP_COLORS.transitLine;
}

export function createTransitLineColorExpression(): unknown {
  return [
    "case",
    ["any", ["==", ["get", "transitMode"], "tram"], ["==", ["get", "railway"], "tram"]],
    MAP_COLORS.transitTramLine,
    ["any", ["==", ["get", "transitMode"], "subway"], ["==", ["get", "railway"], "subway"]],
    MAP_COLORS.transitSubwayLine,
    ["any", ["==", ["get", "transitMode"], "light_rail"], ["==", ["get", "railway"], "light_rail"]],
    MAP_COLORS.transitLightRailLine,
    [
      "any",
      ["==", ["get", "transitMode"], "train"],
      ["==", ["get", "railway"], "rail"],
      ["==", ["get", "railway"], "train"],
    ],
    MAP_COLORS.transitTrainLine,
    MAP_COLORS.transitLine,
  ];
}

export interface LegendItem {
  id: string;
  label: string;
  description: string;
  type: "area" | "line" | "point";
  swatch: {
    fill?: string;
    stroke?: string;
    strokeWidth?: number;
    dashed?: boolean;
    pointFill?: string;
    pointStroke?: string;
    glow?: boolean;
  };
}

export function createGameAreaLayers(): LayerSpecification[] {
  return [
    {
      id: "boundary-fill",
      type: "fill",
      source: "boundary",
      paint: {
        "fill-color": MAP_COLORS.boundaryFill,
        "fill-opacity": MAP_COLORS.boundaryFillOpacity,
      },
    },
    {
      id: "possible-fill",
      type: "fill",
      source: "possible",
      paint: {
        "fill-color": MAP_COLORS.possibleFill,
        "fill-opacity": MAP_COLORS.possibleFillOpacity,
      },
    },
    {
      id: "possible-line",
      type: "line",
      source: "possible",
      paint: {
        "line-color": MAP_COLORS.possibleLine,
        "line-width": MAP_COLORS.possibleLineWidth,
      },
    },
    {
      // Keep the fixed game boundary above the changing Possible Area. These geometries are
      // identical at the beginning of a game, so drawing this line earlier hides it completely.
      id: "boundary-line",
      type: "line",
      source: "boundary",
      paint: {
        "line-color": MAP_COLORS.boundaryLine,
        "line-width": MAP_COLORS.boundaryLineWidth,
      },
    },
  ];
}

export interface LegendSection {
  id: string;
  title: string;
  items: LegendItem[];
}

export const MAP_LEGEND_SECTIONS: LegendSection[] = [
  {
    id: "boundaries",
    title: "Boundaries & Search Area",
    items: [
      {
        id: "possible-area",
        label: "Possible Area",
        description:
          "Active zone where the Hider can currently be located. Automatically narrows as questions are answered.",
        type: "area",
        swatch: {
          fill: "rgba(245, 185, 66, 0.28)",
          stroke: MAP_COLORS.possibleLine,
          strokeWidth: 2.5,
        },
      },
      {
        id: "game-boundary",
        label: "Game Boundary",
        description: "The outer perimeter of the playable game area chosen during game setup.",
        type: "area",
        swatch: {
          fill: "rgba(19, 34, 31, 0.22)",
          stroke: MAP_COLORS.boundaryLine,
          strokeWidth: 2,
        },
      },
      {
        id: "administrative",
        label: "Administrative Boundaries",
        description:
          "First division borders (districts or municipalities) queried by First Division questions.",
        type: "line",
        swatch: {
          stroke: MAP_COLORS.adminLine,
          strokeWidth: 2,
          dashed: true,
        },
      },
    ],
  },
  {
    id: "questions",
    title: "Question Geometry",
    items: [
      {
        id: "active-question",
        label: "Active Question Area",
        description:
          "The geographic area tested or kept by an answered question (clipped to the active search area so only remaining possible territory is shaded).",
        type: "area",
        swatch: {
          fill: "rgba(240, 106, 71, 0.22)",
          stroke: MAP_COLORS.questionSelectedLine,
          strokeWidth: 2,
        },
      },
      {
        id: "decision-boundary",
        label: "Decision Boundary",
        description:
          "Divider separating hotter and colder zones (Thermometer) or candidate cutoff radius.",
        type: "line",
        swatch: {
          stroke: MAP_COLORS.questionDividerLine,
          strokeWidth: 2.5,
          dashed: true,
        },
      },
      {
        id: "question-scope",
        label: "Question Geometric Scope",
        description:
          "Dashed outline showing the overall reach of the question tool across the map without misleading fill.",
        type: "line",
        swatch: {
          stroke: MAP_COLORS.questionSelectedLine,
          strokeWidth: 1.5,
          dashed: true,
        },
      },
      {
        id: "point-a",
        label: "Point A (Start / Colder / Reference)",
        description:
          "Thermometer start point ('Colder'), Seeker reference position, or center point.",
        type: "point",
        swatch: {
          pointFill: MAP_COLORS.pointStartA,
          pointStroke: MAP_COLORS.pointStartAStroke,
        },
      },
      {
        id: "point-b",
        label: "Point B (End / Hotter)",
        description: "Thermometer end point ('Hotter') or secondary target point.",
        type: "point",
        swatch: {
          pointFill: MAP_COLORS.pointEndB,
          pointStroke: MAP_COLORS.pointEndBStroke,
        },
      },
      {
        id: "candidate-radius",
        label: "Candidate Area / Radius",
        description: "Preview zone while planning a question (such as tentacle search radius).",
        type: "area",
        swatch: {
          fill: "rgba(240, 106, 71, 0.08)",
          stroke: MAP_COLORS.questionCandidateLine,
          strokeWidth: 1.5,
          dashed: true,
        },
      },
      {
        id: "other-questions",
        label: "Other Question Geometry",
        description: "Geometry from unselected, inactive, or previously applied questions.",
        type: "area",
        swatch: {
          fill: "rgba(99, 102, 241, 0.16)",
          stroke: MAP_COLORS.questionDefaultLine,
          strokeWidth: 1.5,
        },
      },
    ],
  },
  {
    id: "transit-datasets",
    title: "Transit & Datasets",
    items: [
      {
        id: "transit-train",
        label: "Train Lines",
        description: "Heavy rail and passenger train routes loaded from OpenStreetMap.",
        type: "line",
        swatch: {
          stroke: MAP_COLORS.transitTrainLine,
          strokeWidth: 2.5,
        },
      },
      {
        id: "transit-subway",
        label: "Subway Lines",
        description: "Underground and metro transit lines loaded from OpenStreetMap.",
        type: "line",
        swatch: {
          stroke: MAP_COLORS.transitSubwayLine,
          strokeWidth: 2.5,
        },
      },
      {
        id: "transit-tram",
        label: "Tram Lines",
        description: "Streetcar and tram lines loaded from OpenStreetMap.",
        type: "line",
        swatch: {
          stroke: MAP_COLORS.transitTramLine,
          strokeWidth: 2.5,
        },
      },
      {
        id: "transit-light-rail",
        label: "Light Rail Lines",
        description: "S-Bahn and light rail lines loaded from OpenStreetMap.",
        type: "line",
        swatch: {
          stroke: MAP_COLORS.transitLightRailLine,
          strokeWidth: 2.5,
        },
      },
      {
        id: "transit-lines",
        label: "Transit Lines (General)",
        description: "Railway, tram, and subway lines loaded from OpenStreetMap.",
        type: "line",
        swatch: {
          stroke: MAP_COLORS.transitLine,
          strokeWidth: 2.5,
        },
      },
      {
        id: "transit-stations",
        label: "Transit Stations",
        description: "Railway and transit stations located within the current Possible Area.",
        type: "point",
        swatch: {
          pointFill: MAP_COLORS.stationFill,
          pointStroke: MAP_COLORS.stationStroke,
        },
      },
      {
        id: "datasets",
        label: "Imported Datasets",
        description: "Custom landmarks, parks, and features uploaded via KML/KMZ files.",
        type: "area",
        swatch: {
          fill: "rgba(16, 185, 129, 0.22)",
          stroke: MAP_COLORS.datasetLine,
          strokeWidth: 2,
        },
      },
    ],
  },
  {
    id: "markers-navigation",
    title: "Markers & Tools",
    items: [
      {
        id: "seeker-markers",
        label: "Seeker Pins",
        description: "Strategic notes and suspect locations pinned by the Seeker team.",
        type: "point",
        swatch: {
          pointFill: MAP_COLORS.seekerMarkerFill,
          pointStroke: MAP_COLORS.seekerMarkerStroke,
        },
      },
      {
        id: "measurement",
        label: "Distance Measurement",
        description: "Straight-line distance between two points measured with the ruler tool.",
        type: "line",
        swatch: {
          stroke: MAP_COLORS.measurementLine,
          strokeWidth: 3,
          dashed: true,
        },
      },
      {
        id: "my-location",
        label: "My Location (GPS)",
        description:
          "Your current GPS position. Kept strictly local to your browser and never sent to the server.",
        type: "point",
        swatch: {
          pointFill: MAP_COLORS.localGpsFill,
          pointStroke: MAP_COLORS.localGpsStroke,
          glow: true,
        },
      },
    ],
  },
];

export function processQuestionFeatures(
  features: MapFeature[],
  searchArea: AreaFeature | null,
): MapFeature[] {
  const result: MapFeature[] = [];

  for (const feature of features) {
    const isPolygon =
      feature.geometry.type === "Polygon" || feature.geometry.type === "MultiPolygon";

    if (isPolygon) {
      // 1. Generate an unclipped boundary line (scope) so players can see the full
      // question tool's geometric boundary across the map without misleading fill.
      try {
        const line = turf.polygonToLine(feature as Feature<Polygon | MultiPolygon>);
        if (line) {
          if (line.type === "FeatureCollection") {
            for (const f of line.features) {
              result.push({
                ...f,
                properties: {
                  ...(feature.properties ?? {}),
                  artifactRole: "question-scope",
                },
              } as MapFeature);
            }
          } else {
            result.push({
              ...line,
              properties: {
                ...(feature.properties ?? {}),
                artifactRole: "question-scope",
              },
            } as MapFeature);
          }
        }
      } catch {
        // Ignore scope line generation failure
      }

      // 2. Clip the polygon to the active search area (Possible Area) so
      // areas that have already been excluded by previous questions are never filled.
      if (searchArea) {
        try {
          const clipped = intersectAreas(feature as AreaFeature, searchArea);
          if (clipped) {
            result.push({
              ...clipped,
              properties: {
                ...(feature.properties ?? {}),
              },
            } as MapFeature);

            try {
              const clippedLine = turf.polygonToLine(clipped as Feature<Polygon | MultiPolygon>);
              if (clippedLine) {
                if (clippedLine.type === "FeatureCollection") {
                  for (const f of clippedLine.features) {
                    result.push({
                      ...f,
                      properties: {
                        ...(feature.properties ?? {}),
                      },
                    } as MapFeature);
                  }
                } else {
                  result.push({
                    ...clippedLine,
                    properties: {
                      ...(feature.properties ?? {}),
                    },
                  } as MapFeature);
                }
              }
            } catch {
              // Ignore clipped line generation failure
            }
          }
        } catch {
          result.push(feature);
        }
      } else {
        result.push(feature);
      }
    } else {
      result.push(feature);
    }
  }

  return result;
}

export function filterVisibleQuestions(
  questions: QuestionInstance[],
  selectedQuestionId: string | null,
): QuestionInstance[] {
  return questions.filter(
    (question) =>
      question.enabled &&
      question.visualization &&
      (!selectedQuestionId ? question.status !== "APPLIED" : question.id === selectedQuestionId),
  );
}

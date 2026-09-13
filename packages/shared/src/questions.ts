import * as turf from "@turf/turf";
import type { FeatureCollection, Geometry, MultiPolygon, Polygon } from "geojson";
import type { z } from "zod";
import {
  datasetQuestionParametersSchema,
  firstDivisionParametersSchema,
  placeQuestionParametersSchema,
  radarParametersSchema,
  thermometerParametersSchema,
} from "./schemas.js";
import {
  findContainingArea,
  radarCircle,
  subtractArea,
  thermometerDivider,
  thermometerRegion,
} from "./geometry.js";
import {
  datasetPlaces,
  matchingPlaceRegion,
  measuringPlaceRegion,
  nearestDatasetPlace,
} from "./place-questions.js";
import type {
  AreaFeature,
  DatasetCategory,
  GeometryEffect,
  MapFeature,
  MapFeatureCollection,
  QuestionCategory,
  QuestionConfig,
  RepeatCostRule,
  UploadedDataset,
} from "./types.js";

export interface AnswerOption {
  value: string;
  label: string;
}

export interface QuestionContext {
  boundary: AreaFeature;
  subdivisions: FeatureCollection<Polygon | MultiPolygon> | null;
  datasets: UploadedDataset[];
}

export interface QuestionArtifacts {
  visualization: MapFeatureCollection | MapFeature | null;
  effect: GeometryEffect | null;
}

export interface QuestionDefinition<T extends Record<string, unknown> = Record<string, unknown>> {
  id: string;
  category: QuestionCategory;
  name: string;
  description: string;
  parameterKind: "RADAR" | "THERMOMETER" | "POINT" | "DATASET";
  parametersSchema: z.ZodType<T>;
  answers: readonly AnswerOption[];
  baseCost: number;
  repeatRule: RepeatCostRule;
  requiredDatasetCategory?: DatasetCategory;
  exactRulePending?: boolean;
  buildArtifacts(parameters: T, answer: string | null, context: QuestionContext): QuestionArtifacts;
}

function pointVisualization(point: [number, number] | undefined): MapFeature | null {
  return point ? (turf.point(point) as MapFeature) : null;
}

function datasetFor(datasetId: string, context: QuestionContext): UploadedDataset {
  const dataset = context.datasets.find((item) => item.id === datasetId);
  if (!dataset) throw new Error("The selected place dataset is no longer available");
  return dataset;
}

function datasetVisualizationFeatures(
  dataset: UploadedDataset,
  context: QuestionContext,
  referencePoint: [number, number],
) {
  const places = datasetPlaces(dataset, context.boundary);
  if (places.length === 0)
    throw new Error(`${dataset.name} has no usable places inside the game boundary`);
  const common = { datasetId: dataset.id, datasetName: dataset.name };
  return {
    places,
    features: [
      turf.point(referencePoint, { ...common, artifactRole: "seeker-reference" }),
      ...places.map((place) => ({
        ...place.point,
        properties: {
          ...(place.point.properties ?? {}),
          ...common,
          artifactRole: "dataset-place",
          placeIndex: place.index,
          placeName: place.name,
        },
      })),
    ] as MapFeature[],
  };
}

const radar: QuestionDefinition<z.infer<typeof radarParametersSchema>> = {
  id: "radar.standard",
  category: "RADAR",
  name: "Radar",
  description: "Is the Hider inside or outside a radius around the selected point?",
  parameterKind: "RADAR",
  parametersSchema: radarParametersSchema,
  answers: [
    { value: "INSIDE", label: "Inside" },
    { value: "OUTSIDE", label: "Outside" },
  ],
  baseCost: 1,
  repeatRule: { type: "LINEAR", increment: 1 },
  buildArtifacts(parameters, answer) {
    const circle = radarCircle(parameters.center, parameters.radiusMeters);
    return {
      visualization: circle,
      effect: answer
        ? { mode: answer === "INSIDE" ? "INTERSECT" : "SUBTRACT", geometry: circle }
        : null,
    };
  },
};

const thermometer: QuestionDefinition<z.infer<typeof thermometerParametersSchema>> = {
  id: "thermometer.standard",
  category: "THERMOMETER",
  name: "Thermometer",
  description: "Is the Hider closer to the end point (hotter) or the start point (colder)?",
  parameterKind: "THERMOMETER",
  parametersSchema: thermometerParametersSchema,
  answers: [
    { value: "HOTTER", label: "Hotter" },
    { value: "COLDER", label: "Colder" },
  ],
  baseCost: 1,
  repeatRule: { type: "LINEAR", increment: 1 },
  buildArtifacts(parameters, answer, context) {
    const target = answer === "HOTTER" ? "END" : "START";
    const divider = thermometerDivider(context.boundary, parameters.start, parameters.end);
    const referenceLine = turf.lineString([parameters.start, parameters.end], {
      artifactRole: "reference-line",
    });
    const startPoint = turf.point(parameters.start, {
      artifactRole: "thermometer-start",
      label: "Start / colder",
    });
    const endPoint = turf.point(parameters.end, {
      artifactRole: "thermometer-end",
      label: "End / hotter",
    });
    divider.properties = { artifactRole: "decision-boundary" };
    if (!answer) {
      return {
        visualization: turf.featureCollection([
          referenceLine,
          divider,
          startPoint,
          endPoint,
        ] as MapFeature[]) as MapFeatureCollection,
        effect: null,
      };
    }
    const region = thermometerRegion(context.boundary, parameters.start, parameters.end, target);
    const answerRegion = {
      ...region,
      properties: { ...(region.properties ?? {}), artifactRole: "answer-region", answer },
    } as MapFeature;
    return {
      visualization: turf.featureCollection([
        answerRegion,
        referenceLine,
        divider,
        startPoint,
        endPoint,
      ] as MapFeature[]) as MapFeatureCollection,
      effect: { mode: "INTERSECT", geometry: region },
    };
  },
};

const firstDivision: QuestionDefinition<z.infer<typeof firstDivisionParametersSchema>> = {
  id: "matching.first-division",
  category: "MATCHING",
  name: "First Division",
  description: "Are the Seeker reference point and the Hider in the same configured subdivision?",
  parameterKind: "POINT",
  parametersSchema: firstDivisionParametersSchema,
  answers: [
    { value: "SAME", label: "Same" },
    { value: "DIFFERENT", label: "Different" },
  ],
  baseCost: 1,
  repeatRule: { type: "LINEAR", increment: 1 },
  buildArtifacts(parameters, answer, context) {
    if (!context.subdivisions) {
      return { visualization: pointVisualization(parameters.referencePoint), effect: null };
    }
    const division = findContainingArea(context.subdivisions, parameters.referencePoint);
    if (!division)
      return { visualization: pointVisualization(parameters.referencePoint), effect: null };
    return {
      visualization: division,
      effect: answer
        ? { mode: answer === "SAME" ? "INTERSECT" : "SUBTRACT", geometry: division }
        : null,
    };
  },
};

const matchingPlaces: QuestionDefinition<z.infer<typeof placeQuestionParametersSchema>> = {
  id: "matching.dataset",
  category: "MATCHING",
  name: "Matching: Places",
  description: "Is the Hider's nearest place in the selected dataset the same as the Seeker's?",
  parameterKind: "DATASET",
  parametersSchema: placeQuestionParametersSchema,
  answers: [
    { value: "SAME", label: "Same" },
    { value: "DIFFERENT", label: "Different" },
  ],
  baseCost: 1,
  repeatRule: { type: "LINEAR", increment: 1 },
  requiredDatasetCategory: "MATCHING",
  buildArtifacts(parameters, answer, context) {
    const dataset = datasetFor(parameters.datasetId, context);
    const { places, features } = datasetVisualizationFeatures(
      dataset,
      context,
      parameters.referencePoint,
    );
    const selected = nearestDatasetPlace(places, parameters.referencePoint);
    if (!selected) throw new Error(`${dataset.name} has no usable places inside the game boundary`);
    const sameRegion = matchingPlaceRegion(context.boundary, places, selected);
    const differentRegion = subtractArea(context.boundary, sameRegion);
    const region = answer === "DIFFERENT" ? differentRegion : sameRegion;
    if (answer && !region) throw new Error(`The ${answer.toLowerCase()} answer leaves no area`);
    const area = {
      ...(region ?? sameRegion),
      properties: {
        ...((region ?? sameRegion).properties ?? {}),
        artifactRole: answer ? "answer-region" : "candidate-region",
        answer,
        datasetId: dataset.id,
        datasetName: dataset.name,
        seekerPlaceIndex: selected.index,
        seekerPlaceName: selected.name,
      },
    } as MapFeature;
    return {
      visualization: turf.featureCollection([area, ...features]) as MapFeatureCollection,
      effect: answer
        ? {
            mode: answer === "SAME" ? "INTERSECT" : "SUBTRACT",
            geometry: sameRegion,
          }
        : null,
    };
  },
};

const measuringPlaces: QuestionDefinition<z.infer<typeof placeQuestionParametersSchema>> = {
  id: "measuring.dataset",
  category: "MEASURING",
  name: "Measuring: Places",
  description:
    "Compared with the Seeker, is the Hider closer to or further from the nearest selected place?",
  parameterKind: "DATASET",
  parametersSchema: placeQuestionParametersSchema,
  answers: [
    { value: "CLOSER", label: "Closer" },
    { value: "FURTHER", label: "Further" },
  ],
  baseCost: 1,
  repeatRule: { type: "LINEAR", increment: 1 },
  requiredDatasetCategory: "MEASURING",
  buildArtifacts(parameters, answer, context) {
    const dataset = datasetFor(parameters.datasetId, context);
    const { places, features } = datasetVisualizationFeatures(
      dataset,
      context,
      parameters.referencePoint,
    );
    const closer = measuringPlaceRegion(
      context.boundary,
      places,
      parameters.referencePoint,
      "CLOSER",
    );
    const selected = nearestDatasetPlace(places, parameters.referencePoint)!;
    const answerRegion =
      answer === "FURTHER"
        ? measuringPlaceRegion(context.boundary, places, parameters.referencePoint, "FURTHER")
            .region
        : closer.region;
    const area = {
      ...answerRegion,
      properties: {
        ...(answerRegion.properties ?? {}),
        artifactRole: answer ? "answer-region" : "candidate-region",
        answer,
        datasetId: dataset.id,
        datasetName: dataset.name,
        seekerPlaceIndex: selected.index,
        seekerPlaceName: selected.name,
        referenceDistanceMeters: closer.referenceDistanceMeters,
      },
    } as MapFeature;
    return {
      visualization: turf.featureCollection([area, ...features]) as MapFeatureCollection,
      effect: answer
        ? {
            mode: answer === "CLOSER" ? "INTERSECT" : "SUBTRACT",
            geometry: closer.region,
          }
        : null,
    };
  },
};

function placeholderDefinition(
  id: string,
  category: QuestionCategory,
  name: string,
  description: string,
  requiredDatasetCategory: DatasetCategory,
): QuestionDefinition<z.infer<typeof datasetQuestionParametersSchema>> {
  return {
    id,
    category,
    name,
    description,
    parameterKind: "DATASET",
    parametersSchema: datasetQuestionParametersSchema,
    answers: [
      { value: "YES", label: "Yes / matching" },
      { value: "NO", label: "No / different" },
    ],
    baseCost: 1,
    repeatRule: { type: "LINEAR", increment: 1 },
    requiredDatasetCategory,
    exactRulePending: true,
    buildArtifacts(parameters) {
      return { visualization: pointVisualization(parameters.referencePoint), effect: null };
    },
  };
}

export const QUESTION_DEFINITIONS: readonly QuestionDefinition[] = [
  radar as QuestionDefinition,
  thermometer as QuestionDefinition,
  firstDivision as QuestionDefinition,
  placeholderDefinition(
    "tentacles.dataset",
    "TENTACLES",
    "Tentacles",
    "Use a selected place dataset for a Tentacles question.",
    "TENTACLES",
  ),
  matchingPlaces as QuestionDefinition,
  measuringPlaces as QuestionDefinition,
];

export interface LocalQuestionEvaluation {
  answer: string;
  summary: string;
  details: string[];
}

function formatMeters(distance: number): string {
  return distance < 1_000 ? `${Math.round(distance)} m` : `${(distance / 1_000).toFixed(2)} km`;
}

export function evaluateQuestionAtPosition(
  definitionId: string,
  rawParameters: Record<string, unknown>,
  position: [number, number],
  context: QuestionContext,
): LocalQuestionEvaluation | null {
  const definition = getQuestionDefinition(definitionId);
  const parameters = definition.parametersSchema.parse(rawParameters) as Record<string, unknown>;
  if (definitionId === "radar.standard") {
    const center = parameters.center as [number, number];
    const distance = turf.distance(position, center, { units: "meters" });
    const inside = distance <= Number(parameters.radiusMeters);
    return {
      answer: inside ? "INSIDE" : "OUTSIDE",
      summary: inside ? "You are inside the radius." : "You are outside the radius.",
      details: [`Your distance: ${formatMeters(distance)}`],
    };
  }
  if (definitionId === "thermometer.standard") {
    const start = parameters.start as [number, number];
    const end = parameters.end as [number, number];
    const startDistance = turf.distance(position, start, { units: "meters" });
    const endDistance = turf.distance(position, end, { units: "meters" });
    const hotter = endDistance <= startDistance;
    return {
      answer: hotter ? "HOTTER" : "COLDER",
      summary: hotter
        ? "You are closer to the end point (hotter)."
        : "You are closer to the start point (colder).",
      details: [`Start: ${formatMeters(startDistance)}`, `End: ${formatMeters(endDistance)}`],
    };
  }
  if (definitionId === "matching.first-division") {
    if (!context.subdivisions) return null;
    const reference = findContainingArea(
      context.subdivisions,
      parameters.referencePoint as [number, number],
    );
    const local = findContainingArea(context.subdivisions, position);
    if (!reference || !local) return null;
    const same =
      reference === local || JSON.stringify(reference.geometry) === JSON.stringify(local.geometry);
    return {
      answer: same ? "SAME" : "DIFFERENT",
      summary: same
        ? "You are in the same division as the Seeker."
        : "You are in a different division from the Seeker.",
      details: [],
    };
  }
  if (definitionId === "matching.dataset" || definitionId === "measuring.dataset") {
    const dataset = datasetFor(String(parameters.datasetId), context);
    const places = datasetPlaces(dataset, context.boundary);
    const seeker = nearestDatasetPlace(places, parameters.referencePoint as [number, number]);
    const hider = nearestDatasetPlace(places, position);
    if (!seeker || !hider) return null;
    if (definitionId === "matching.dataset") {
      const same = seeker.index === hider.index;
      return {
        answer: same ? "SAME" : "DIFFERENT",
        summary: same
          ? `Your nearest ${dataset.name} place is the same as the Seeker's.`
          : `Your nearest ${dataset.name} place is different from the Seeker's.`,
        details: [
          `Seeker: ${seeker.name}`,
          `You: ${hider.name} (${formatMeters(hider.distanceMeters)})`,
        ],
      };
    }
    const closer = hider.distanceMeters <= seeker.distanceMeters;
    return {
      answer: closer ? "CLOSER" : "FURTHER",
      summary: closer
        ? `You are closer to the nearest ${dataset.name} place than the Seeker.`
        : `You are further from the nearest ${dataset.name} place than the Seeker.`,
      details: [
        `Seeker: ${seeker.name} · ${formatMeters(seeker.distanceMeters)}`,
        `You: ${hider.name} · ${formatMeters(hider.distanceMeters)}`,
      ],
    };
  }
  return null;
}

export function getQuestionDefinition(id: string): QuestionDefinition {
  const definition = QUESTION_DEFINITIONS.find((item) => item.id === id);
  if (!definition) throw new Error(`Unknown question definition: ${id}`);
  return definition;
}

export function defaultQuestionConfigs(): QuestionConfig[] {
  return QUESTION_DEFINITIONS.map((definition) => ({
    definitionId: definition.id,
    enabled: true,
    baseCost: definition.baseCost,
    repeatRule: definition.repeatRule,
  }));
}

export function buildQuestionArtifacts(
  definitionId: string,
  rawParameters: Record<string, unknown>,
  answer: string | null,
  context: QuestionContext,
): { parameters: Record<string, unknown>; artifacts: QuestionArtifacts } {
  const definition = getQuestionDefinition(definitionId);
  const parameters = definition.parametersSchema.parse(rawParameters) as Record<string, unknown>;
  if (answer && !definition.answers.some((option) => option.value === answer)) {
    throw new Error(`Invalid answer for ${definition.name}`);
  }
  return {
    parameters,
    artifacts: definition.buildArtifacts(parameters, answer, context),
  };
}

export function geometryToFeature(geometry: Geometry): MapFeature {
  return turf.feature(geometry) as MapFeature;
}

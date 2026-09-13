import * as turf from "@turf/turf";
import type { FeatureCollection, Geometry, MultiPolygon, Polygon } from "geojson";
import type { z } from "zod";
import {
  firstDivisionParametersSchema,
  placeQuestionParametersSchema,
  radarParametersSchema,
  tentacleQuestionParametersSchema,
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
  candidateTentaclePlaces,
  datasetPlaces,
  matchingPlaceRegion,
  measuringPlaceRegion,
  nearestDatasetPlace,
  tentaclePlaceRegion,
  tentaclesVisualizationFeatures,
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

export interface QuestionDefinition<T = any> {
  id: string;
  category: QuestionCategory;
  name: string;
  description: string;
  parameterKind: "RADAR" | "THERMOMETER" | "POINT" | "DATASET";
  parametersSchema: z.ZodType<T>;
  answers:
    | readonly AnswerOption[]
    | ((parameters: T, context: QuestionContext) => readonly AnswerOption[]);
  baseCost: number;
  repeatRule: RepeatCostRule;
  requiredDatasetCategory?: DatasetCategory;
  exactRulePending?: boolean;
  buildArtifacts(parameters: T, answer: string | null, context: QuestionContext): QuestionArtifacts;
}

export function getQuestionAnswers(
  definition: QuestionDefinition,
  parameters?: Record<string, unknown>,
  context?: QuestionContext,
): readonly AnswerOption[] {
  if (typeof definition.answers === "function") {
    if (!parameters || !context) return [];
    try {
      const parsed = definition.parametersSchema.parse(parameters);
      return (
        definition.answers as (
          p: Record<string, unknown>,
          c: QuestionContext,
        ) => readonly AnswerOption[]
      )(parsed, context);
    } catch {
      return [];
    }
  }
  return definition.answers;
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
    const centerPoint = turf.point(parameters.center, {
      artifactRole: "seeker-reference",
      label: "Radar centre",
    });
    circle.properties = {
      ...(circle.properties ?? {}),
      artifactRole: answer ? "answer-region" : "candidate-region",
      ...(answer ? { answer } : {}),
    };
    return {
      visualization: turf.featureCollection([
        circle,
        centerPoint,
      ] as MapFeature[]) as MapFeatureCollection,
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

const tentaclesPlaces: QuestionDefinition<z.infer<typeof tentacleQuestionParametersSchema>> = {
  id: "tentacles.dataset",
  category: "TENTACLES",
  name: "Tentacles: Places",
  description:
    "Which nearby place in the selected dataset is the Hider closest to, or are they outside the radius?",
  parameterKind: "DATASET",
  parametersSchema: tentacleQuestionParametersSchema,
  answers(parameters, context) {
    try {
      const dataset = datasetFor(parameters.datasetId, context);
      const places = datasetPlaces(dataset, context.boundary);
      const candidates = candidateTentaclePlaces(
        places,
        parameters.referencePoint,
        parameters.radiusMeters,
      );
      const placeOptions = candidates.map((place) => ({
        value: `place:${place.index}`,
        label: `${place.name} (${formatMeters(place.distanceMeters)})`,
      }));
      return [...placeOptions, { value: "OUTSIDE", label: "Outside radius" }];
    } catch {
      return [{ value: "OUTSIDE", label: "Outside radius" }];
    }
  },
  baseCost: 1,
  repeatRule: { type: "LINEAR", increment: 1 },
  requiredDatasetCategory: "TENTACLES",
  buildArtifacts(parameters, answer, context) {
    const dataset = datasetFor(parameters.datasetId, context);
    const { candidatePlaces, circleInBoundary, features } = tentaclesVisualizationFeatures(
      dataset,
      context,
      parameters.referencePoint,
      parameters.radiusMeters,
    );
    if (!circleInBoundary) {
      throw new Error("Tentacle radius is completely outside the game boundary");
    }
    if (answer === "OUTSIDE") {
      const outsideRegion = subtractArea(context.boundary, circleInBoundary);
      if (!outsideRegion)
        throw new Error("Answering outside leaves no possible area inside boundary");
      const area = {
        ...outsideRegion,
        properties: {
          ...(outsideRegion.properties ?? {}),
          artifactRole: "answer-region",
          answer: "OUTSIDE",
          datasetId: dataset.id,
          datasetName: dataset.name,
        },
      } as MapFeature;
      return {
        visualization: turf.featureCollection([area, ...features]) as MapFeatureCollection,
        effect: {
          mode: "SUBTRACT",
          geometry: circleInBoundary,
        },
      };
    }
    if (answer && answer.startsWith("place:")) {
      const placeIndex = Number(answer.replace("place:", ""));
      const selected = candidatePlaces.find((p) => p.index === placeIndex);
      if (!selected) {
        throw new Error(`Selected place #${placeIndex} is not an active tentacle within radius`);
      }
      const tentacleRegion =
        candidatePlaces.length === 1
          ? circleInBoundary
          : tentaclePlaceRegion(circleInBoundary, candidatePlaces, selected);
      const area = {
        ...tentacleRegion,
        properties: {
          ...(tentacleRegion.properties ?? {}),
          artifactRole: "answer-region",
          answer,
          datasetId: dataset.id,
          datasetName: dataset.name,
          placeIndex: selected.index,
          placeName: selected.name,
        },
      } as MapFeature;
      return {
        visualization: turf.featureCollection([area, ...features]) as MapFeatureCollection,
        effect: {
          mode: "INTERSECT",
          geometry: tentacleRegion,
        },
      };
    }
    const area = {
      ...circleInBoundary,
      properties: {
        ...(circleInBoundary.properties ?? {}),
        artifactRole: "candidate-region",
        datasetId: dataset.id,
        datasetName: dataset.name,
      },
    } as MapFeature;
    return {
      visualization: turf.featureCollection([area, ...features]) as MapFeatureCollection,
      effect: null,
    };
  },
};

export const QUESTION_DEFINITIONS: readonly QuestionDefinition[] = [
  radar,
  thermometer,
  firstDivision,
  tentaclesPlaces,
  matchingPlaces,
  measuringPlaces,
];

export interface LocalQuestionEvaluation {
  answer: string | null;
  summary: string;
  details: string[];
}

export interface QuestionReferenceInfo {
  placeName?: string;
  divisionName?: string;
  distanceMeters?: number;
}

function formatMeters(distance: number): string {
  return distance < 1_000 ? `${Math.round(distance)} m` : `${(distance / 1_000).toFixed(2)} km`;
}

export function getQuestionReferenceInfo(
  definitionId: string,
  rawParameters: Record<string, unknown>,
  context: QuestionContext,
): QuestionReferenceInfo | null {
  try {
    const definition = getQuestionDefinition(definitionId);
    const parameters = definition.parametersSchema.parse(rawParameters) as Record<string, unknown>;
    if (definitionId === "matching.dataset" || definitionId === "measuring.dataset") {
      const dataset = datasetFor(String(parameters.datasetId), context);
      const places = datasetPlaces(dataset, context.boundary);
      const seeker = nearestDatasetPlace(places, parameters.referencePoint as [number, number]);
      if (!seeker) return null;
      return {
        placeName: seeker.name,
        distanceMeters: seeker.distanceMeters,
      };
    }
    if (definitionId === "matching.first-division") {
      if (!context.subdivisions) return null;
      const reference = findContainingArea(
        context.subdivisions,
        parameters.referencePoint as [number, number],
      );
      if (!reference) return null;
      const divisionName =
        (reference.properties?.name as string) ??
        (reference.properties?.["name:en"] as string) ??
        undefined;
      return { divisionName };
    }
    return null;
  } catch {
    return null;
  }
}

export function evaluateQuestionAtPosition(
  definitionId: string,
  rawParameters: Record<string, unknown>,
  position: [number, number] | null,
  context: QuestionContext,
): LocalQuestionEvaluation | null {
  const definition = getQuestionDefinition(definitionId);
  const parameters = definition.parametersSchema.parse(rawParameters) as Record<string, unknown>;
  if (definitionId === "radar.standard") {
    const center = parameters.center as [number, number];
    const radiusMeters = Number(parameters.radiusMeters ?? 1000);
    if (!position) {
      return {
        answer: null,
        summary: "Location needed to check this answer.",
        details: [`Radius: ${formatMeters(radiusMeters)}`],
      };
    }
    const distance = turf.distance(position, center, { units: "meters" });
    const inside = distance <= radiusMeters;
    return {
      answer: inside ? "INSIDE" : "OUTSIDE",
      summary: inside ? "You are inside the radius." : "You are outside the radius.",
      details: [`Your distance: ${formatMeters(distance)}`],
    };
  }
  if (definitionId === "thermometer.standard") {
    if (!position) {
      return {
        answer: null,
        summary: "Location needed to check this answer.",
        details: [],
      };
    }
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
    if (!reference) return null;
    const refName =
      (reference.properties?.name as string) ??
      (reference.properties?.["name:en"] as string) ??
      null;
    if (!position) {
      return {
        answer: null,
        summary: "Location needed to check this answer.",
        details: refName ? [`Seeker: ${refName}`] : [],
      };
    }
    const local = findContainingArea(context.subdivisions, position);
    if (!local) return null;
    const localName =
      (local.properties?.name as string) ?? (local.properties?.["name:en"] as string) ?? null;
    const same =
      reference === local || JSON.stringify(reference.geometry) === JSON.stringify(local.geometry);
    return {
      answer: same ? "SAME" : "DIFFERENT",
      summary: same
        ? "You are in the same division as the Seeker."
        : "You are in a different division from the Seeker.",
      details: [
        ...(refName ? [`Seeker: ${refName}`] : []),
        ...(localName ? [`You: ${localName}`] : []),
      ],
    };
  }
  if (definitionId === "matching.dataset" || definitionId === "measuring.dataset") {
    const dataset = datasetFor(String(parameters.datasetId), context);
    const places = datasetPlaces(dataset, context.boundary);
    const seeker = nearestDatasetPlace(places, parameters.referencePoint as [number, number]);
    if (!seeker) return null;
    if (!position) {
      if (definitionId === "matching.dataset") {
        return {
          answer: null,
          summary: "Location needed to check this answer.",
          details: [`Seeker: ${seeker.name}`],
        };
      }
      return {
        answer: null,
        summary: "Location needed to check this answer.",
        details: [`Seeker: ${seeker.name} · ${formatMeters(seeker.distanceMeters)}`],
      };
    }
    const hider = nearestDatasetPlace(places, position);
    if (!hider) return null;
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
  if (definitionId === "tentacles.dataset") {
    const dataset = datasetFor(String(parameters.datasetId), context);
    const places = datasetPlaces(dataset, context.boundary);
    const center = parameters.referencePoint as [number, number];
    const radiusMeters = Number(parameters.radiusMeters ?? 10_000);
    const candidates = candidateTentaclePlaces(places, center, radiusMeters);
    if (!position) {
      return {
        answer: null,
        summary: "Location needed to check this answer.",
        details: [
          `Radius: ${formatMeters(radiusMeters)}`,
          `${candidates.length} candidate place${candidates.length === 1 ? "" : "s"} within radius`,
        ],
      };
    }
    const distanceToCenter = turf.distance(position, center, { units: "meters" });
    if (distanceToCenter > radiusMeters) {
      return {
        answer: "OUTSIDE",
        summary: "You are outside the tentacle radius.",
        details: [
          `Distance to centre: ${formatMeters(distanceToCenter)}`,
          `Radius: ${formatMeters(radiusMeters)}`,
        ],
      };
    }
    if (candidates.length === 0) {
      return {
        answer: "OUTSIDE",
        summary: "No tentacle places found within radius.",
        details: [`Distance to centre: ${formatMeters(distanceToCenter)}`],
      };
    }
    const nearest = nearestDatasetPlace(candidates, position)!;
    return {
      answer: `place:${nearest.index}`,
      summary: `You are in the tentacle zone of ${nearest.name}.`,
      details: [
        `Nearest tentacle: ${nearest.name} (${formatMeters(nearest.distanceMeters)})`,
        `Distance to centre: ${formatMeters(distanceToCenter)}`,
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
  const allowedAnswers = getQuestionAnswers(definition, parameters, context);
  if (
    answer &&
    allowedAnswers.length > 0 &&
    !allowedAnswers.some((option) => option.value === answer)
  ) {
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

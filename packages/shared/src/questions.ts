import * as turf from "@turf/turf";
import type { FeatureCollection, Geometry, MultiPolygon, Polygon } from "geojson";
import type { z } from "zod";
import {
  datasetQuestionParametersSchema,
  firstDivisionParametersSchema,
  radarParametersSchema,
  thermometerParametersSchema,
} from "./schemas.js";
import { findContainingArea, radarCircle, thermometerRegion } from "./geometry.js";
import type {
  AreaFeature,
  DatasetCategory,
  GeometryEffect,
  MapFeature,
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
  visualization: MapFeature | null;
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
    const line = turf.lineString([parameters.start, parameters.end]) as MapFeature;
    if (!answer) return { visualization: line, effect: null };
    const region = thermometerRegion(
      context.boundary,
      parameters.start,
      parameters.end,
      answer === "HOTTER" ? "END" : "START",
    );
    return { visualization: line, effect: { mode: "INTERSECT", geometry: region } };
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
  placeholderDefinition(
    "matching.dataset",
    "MATCHING",
    "Matching: Places",
    "Compare against a selected place dataset.",
    "MATCHING",
  ),
  placeholderDefinition(
    "measuring.dataset",
    "MEASURING",
    "Measuring: Places",
    "Compare distance to a place in a selected dataset.",
    "MEASURING",
  ),
];

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

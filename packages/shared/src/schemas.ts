import { z } from "zod";
import type { AreaFeature, AreaGeometry } from "./types.js";

export const playerRoleSchema = z.enum(["HIDER", "SEEKER"]);
export const questionStatusSchema = z.enum(["DRAFT", "PENDING", "ANSWERED", "APPLIED"]);
export const datasetCategorySchema = z.enum([
  "TENTACLES",
  "MATCHING",
  "MEASURING",
  "TRANSIT",
  "OTHER",
]);
export const transitModeSchema = z.enum(["train", "light_rail", "subway", "tram"]);

export const positionSchema = z.tuple([
  z.number().finite().min(-180).max(180),
  z.number().finite().min(-90).max(90),
]);

function validCoordinates(value: unknown): boolean {
  if (typeof value === "number") return Number.isFinite(value);
  return Array.isArray(value) && value.length > 0 && value.every(validCoordinates);
}

export const areaFeatureSchema = z.custom<AreaFeature>((value) => {
  if (!value || typeof value !== "object") return false;
  const feature = value as AreaFeature;
  return (
    feature.type === "Feature" &&
    (feature.geometry?.type === "Polygon" || feature.geometry?.type === "MultiPolygon") &&
    validCoordinates(feature.geometry.coordinates)
  );
}, "A Polygon or MultiPolygon GeoJSON Feature is required");

export const questionConfigInputSchema = z.object({
  definitionId: z.string().min(1).max(100),
  enabled: z.boolean(),
  baseCost: z.number().int().min(0).max(10_000),
});

export const createGameSchema = z.object({
  name: z.string().trim().min(1).max(100),
  hidingDurationMinutes: z
    .number()
    .int()
    .min(1)
    .max(24 * 60),
  hiderAssistance: z.boolean(),
  seekerOnly: z.boolean().default(false),
  osm: z.object({
    osmType: z.enum(["relation", "way"]),
    osmId: z.string().min(1).max(40),
    displayName: z.string().min(1).max(500),
    boundingBox: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  }),
  boundary: areaFeatureSchema,
  firstDivisionAdminLevel: z.number().int().min(2).max(12).nullable(),
  transitModes: z
    .array(transitModeSchema)
    .min(1)
    .max(4)
    .default(["train", "light_rail", "subway", "tram"]),
  questionConfigs: z.array(questionConfigInputSchema).max(100).optional(),
  datasetLibraryIds: z.array(z.string().uuid()).max(200).optional(),
});

export const joinGameSchema = z.object({
  displayName: z.string().trim().min(1).max(50),
  role: playerRoleSchema,
});

export const radarParametersSchema = z.object({
  center: positionSchema,
  radiusMeters: z.number().finite().min(10).max(1_000_000),
});

export const thermometerParametersSchema = z
  .object({
    start: positionSchema,
    end: positionSchema,
  })
  .refine((value) => value.start[0] !== value.end[0] || value.start[1] !== value.end[1], {
    message: "Start and end point must differ",
    path: ["end"],
  });

export const firstDivisionParametersSchema = z.object({
  referencePoint: positionSchema,
});

export const datasetQuestionParametersSchema = z.object({
  referencePoint: positionSchema.optional(),
  datasetId: z.string().uuid().optional(),
  note: z.string().trim().max(500).optional(),
});

export const placeQuestionParametersSchema = z.object({
  referencePoint: positionSchema,
  datasetId: z.string().uuid(),
  note: z.string().trim().max(500).optional(),
});

export const tentacleQuestionParametersSchema = z.object({
  referencePoint: positionSchema,
  radiusMeters: z.number().positive().max(1_000_000).default(10_000),
  datasetId: z.string().uuid(),
  note: z.string().trim().max(500).optional(),
});

export const createQuestionSchema = z.object({
  definitionId: z.string().min(1).max(100),
  parameters: z.record(z.string(), z.unknown()),
});

export const updateQuestionSchema = z.object({
  parameters: z.record(z.string(), z.unknown()).optional(),
  enabled: z.boolean().optional(),
});

export const answerQuestionSchema = z.object({ answer: z.string().min(1).max(60) }).strict();

export const markerInputSchema = z.object({
  position: z.object({
    type: z.literal("Feature"),
    geometry: z.object({ type: z.literal("Point"), coordinates: positionSchema }),
    properties: z.record(z.string(), z.unknown()).nullable().optional(),
  }),
  title: z.string().trim().min(1).max(80),
  note: z.string().trim().max(500).nullable().optional(),
});

export const isAreaGeometry = (geometry: unknown): geometry is AreaGeometry =>
  Boolean(
    geometry &&
    typeof geometry === "object" &&
    ((geometry as AreaGeometry).type === "Polygon" ||
      (geometry as AreaGeometry).type === "MultiPolygon"),
  );

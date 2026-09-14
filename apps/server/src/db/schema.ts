import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const games = sqliteTable("games", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  lifecycle: text("lifecycle").notNull(),
  phase: text("phase").notNull(),
  hidingDurationSeconds: integer("hiding_duration_seconds").notNull(),
  phaseStartedAt: text("phase_started_at"),
  pausedAt: text("paused_at"),
  endedAt: text("ended_at"),
  hiderAssistance: integer("hider_assistance", { mode: "boolean" }).notNull(),
  seekerOnly: integer("seeker_only", { mode: "boolean" }).notNull().default(false),
  osmType: text("osm_type").notNull(),
  osmId: text("osm_id").notNull(),
  osmDisplayName: text("osm_display_name").notNull(),
  osmBoundingBoxJson: text("osm_bounding_box_json").notNull(),
  boundaryGeojson: text("boundary_geojson").notNull(),
  possibleAreaGeojson: text("possible_area_geojson"),
  firstDivisionAdminLevel: integer("first_division_admin_level"),
  subdivisionsGeojson: text("subdivisions_geojson"),
  transitLinesGeojson: text("transit_lines_geojson"),
  transitStationsGeojson: text("transit_stations_geojson"),
  transitModesJson: text("transit_modes_json").notNull(),
  revision: integer("revision").notNull().default(1),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const players = sqliteTable("players", {
  id: text("id").primaryKey(),
  gameId: text("game_id")
    .notNull()
    .references(() => games.id, { onDelete: "cascade" }),
  displayName: text("display_name").notNull(),
  role: text("role").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  connectionCount: integer("connection_count").notNull().default(0),
  lastSeenAt: text("last_seen_at").notNull(),
  createdAt: text("created_at").notNull(),
});

export const questionConfigs = sqliteTable(
  "question_configs",
  {
    gameId: text("game_id")
      .notNull()
      .references(() => games.id, { onDelete: "cascade" }),
    definitionId: text("definition_id").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    baseCost: integer("base_cost").notNull(),
    repeatRuleJson: text("repeat_rule_json").notNull(),
    configJson: text("config_json"),
  },
  (table) => [primaryKey({ columns: [table.gameId, table.definitionId] })],
);

export const questions = sqliteTable("questions", {
  id: text("id").primaryKey(),
  gameId: text("game_id")
    .notNull()
    .references(() => games.id, { onDelete: "cascade" }),
  definitionId: text("definition_id").notNull(),
  category: text("category").notNull(),
  displayName: text("display_name").notNull(),
  status: text("status").notNull(),
  parametersJson: text("parameters_json").notNull(),
  answerJson: text("answer_json"),
  visualizationGeojson: text("visualization_geojson"),
  effectGeojson: text("effect_geojson"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  askedByPlayerId: text("asked_by_player_id").references(() => players.id, {
    onDelete: "set null",
  }),
  usageNumber: integer("usage_number").notNull().default(0),
  cost: integer("cost").notNull().default(0),
  askedAt: text("asked_at"),
  answeredAt: text("answered_at"),
  appliedAt: text("applied_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const datasetLibrary = sqliteTable("dataset_library", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  originalFilename: text("original_filename").notNull(),
  contentHash: text("content_hash").notNull(),
  geojson: text("geojson").notNull(),
  featureCount: integer("feature_count").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const datasets = sqliteTable("datasets", {
  id: text("id").primaryKey(),
  gameId: text("game_id")
    .notNull()
    .references(() => games.id, { onDelete: "cascade" }),
  sourceLibraryId: text("source_library_id").references(() => datasetLibrary.id, {
    onDelete: "set null",
  }),
  name: text("name").notNull(),
  category: text("category").notNull(),
  originalFilename: text("original_filename").notNull(),
  geojson: text("geojson").notNull(),
  featureCount: integer("feature_count").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const seekerMarkers = sqliteTable("seeker_markers", {
  id: text("id").primaryKey(),
  gameId: text("game_id")
    .notNull()
    .references(() => games.id, { onDelete: "cascade" }),
  createdByPlayerId: text("created_by_player_id")
    .notNull()
    .references(() => players.id, { onDelete: "cascade" }),
  positionGeojson: text("position_geojson").notNull(),
  title: text("title").notNull(),
  note: text("note"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const osmCache = sqliteTable("osm_cache", {
  key: text("key").primaryKey(),
  kind: text("kind").notNull(),
  responseJson: text("response_json").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

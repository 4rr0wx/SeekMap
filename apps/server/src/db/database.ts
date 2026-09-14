import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";

const migration = `
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS games (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, lifecycle TEXT NOT NULL, phase TEXT NOT NULL,
  hiding_duration_seconds INTEGER NOT NULL, phase_started_at TEXT, paused_at TEXT, ended_at TEXT,
  hider_assistance INTEGER NOT NULL, seeker_only INTEGER NOT NULL DEFAULT 0, osm_type TEXT NOT NULL, osm_id TEXT NOT NULL,
  osm_display_name TEXT NOT NULL, osm_bounding_box_json TEXT NOT NULL, boundary_geojson TEXT NOT NULL,
  possible_area_geojson TEXT, first_division_admin_level INTEGER, subdivisions_geojson TEXT,
  transit_lines_geojson TEXT, transit_stations_geojson TEXT,
  transit_modes_json TEXT NOT NULL DEFAULT '["train","light_rail","subway","tram"]',
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_game ON games(lifecycle) WHERE lifecycle = 'ACTIVE';
CREATE TABLE IF NOT EXISTS players (
  id TEXT PRIMARY KEY, game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL, role TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
  connection_count INTEGER NOT NULL DEFAULT 0, last_seen_at TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS question_configs (
  game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE, definition_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1, base_cost INTEGER NOT NULL, repeat_rule_json TEXT NOT NULL,
  config_json TEXT, PRIMARY KEY(game_id, definition_id)
);
CREATE TABLE IF NOT EXISTS questions (
  id TEXT PRIMARY KEY, game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  definition_id TEXT NOT NULL, category TEXT NOT NULL, display_name TEXT NOT NULL, status TEXT NOT NULL,
  parameters_json TEXT NOT NULL, answer_json TEXT, visualization_geojson TEXT, effect_geojson TEXT,
  enabled INTEGER NOT NULL DEFAULT 1, asked_by_player_id TEXT REFERENCES players(id) ON DELETE SET NULL,
  usage_number INTEGER NOT NULL DEFAULT 0, cost INTEGER NOT NULL DEFAULT 0,
  asked_at TEXT, answered_at TEXT, applied_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS questions_game_id ON questions(game_id);
CREATE TABLE IF NOT EXISTS dataset_library (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, original_filename TEXT NOT NULL,
  content_hash TEXT NOT NULL, geojson TEXT NOT NULL, feature_count INTEGER NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS dataset_library_content_hash ON dataset_library(content_hash);
CREATE TABLE IF NOT EXISTS datasets (
  id TEXT PRIMARY KEY, game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  source_library_id TEXT REFERENCES dataset_library(id) ON DELETE SET NULL,
  temporary INTEGER NOT NULL DEFAULT 0,
  name TEXT NOT NULL, category TEXT NOT NULL, original_filename TEXT NOT NULL, geojson TEXT NOT NULL,
  feature_count INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS seeker_markers (
  id TEXT PRIMARY KEY, game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  created_by_player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  position_geojson TEXT NOT NULL, title TEXT NOT NULL, note TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS osm_cache (
  key TEXT PRIMARY KEY, kind TEXT NOT NULL, response_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
`;

export function openDatabase(path: string) {
  mkdirSync(dirname(path), { recursive: true });
  const sqlite = new BetterSqlite3(path);
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("journal_mode = WAL");
  sqlite.exec(migration);
  const gameColumns = sqlite.pragma("table_info(games)") as Array<{ name: string }>;
  if (!gameColumns.some((column) => column.name === "transit_modes_json")) {
    sqlite.exec(
      `ALTER TABLE games ADD COLUMN transit_modes_json TEXT NOT NULL DEFAULT '["train","light_rail","subway","tram"]'`,
    );
  }
  if (!gameColumns.some((column) => column.name === "seeker_only")) {
    sqlite.exec(`ALTER TABLE games ADD COLUMN seeker_only INTEGER NOT NULL DEFAULT 0`);
  }
  const datasetColumns = sqlite.pragma("table_info(datasets)") as Array<{ name: string }>;
  if (!datasetColumns.some((column) => column.name === "source_library_id")) {
    sqlite.exec(`ALTER TABLE datasets ADD COLUMN source_library_id TEXT`);
  }
  if (!datasetColumns.some((column) => column.name === "temporary")) {
    sqlite.exec(`ALTER TABLE datasets ADD COLUMN temporary INTEGER NOT NULL DEFAULT 0`);
  }
  return { sqlite, db: drizzle(sqlite, { schema }) };
}

export type DatabaseBundle = ReturnType<typeof openDatabase>;
export type Database = DatabaseBundle["db"];

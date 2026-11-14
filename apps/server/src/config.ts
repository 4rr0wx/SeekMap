import { resolve } from "node:path";

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/$/, "");
}

function parseUrlList(value: string | undefined, fallback: string): string[] {
  const raw = (value ?? fallback)
    .split(",")
    .map((entry) => stripTrailingSlash(entry.trim()))
    .filter(Boolean);
  return [...new Set(raw.length > 0 ? raw : [stripTrailingSlash(fallback)])];
}

export interface AppConfig {
  port: number;
  host: string;
  publicUrl: string | null;
  dataDirectory: string;
  databasePath: string;
  nominatimUrl: string;
  /** Primary Overpass interpreter URL (first entry of overpassUrls). */
  overpassUrl: string;
  /** Overpass interpreter URLs tried in order on transient failures. */
  overpassUrls: string[];
  tileUrl: string;
  tileAttribution: string;
  maxUploadBytes: number;
  webRoot: string;
}

const DEFAULT_OVERPASS_URLS =
  "https://overpass-api.de/api/interpreter,https://lz4.overpass-api.de/api/interpreter";

export function loadConfig(environment = process.env): AppConfig {
  const dataDirectory = resolve(environment.DATA_DIR ?? "./data");
  const overpassSource = environment.OVERPASS_URLS?.trim() || environment.OVERPASS_URL || undefined;
  const overpassUrls = parseUrlList(overpassSource, DEFAULT_OVERPASS_URLS);
  return {
    port: positiveInt(environment.PORT, 3030),
    host: environment.HOST ?? "0.0.0.0",
    publicUrl: environment.PUBLIC_APP_URL || null,
    dataDirectory,
    databasePath: resolve(dataDirectory, "hideseek-atlas.sqlite"),
    nominatimUrl: stripTrailingSlash(
      environment.NOMINATIM_URL ?? "https://nominatim.openstreetmap.org",
    ),
    overpassUrl: overpassUrls[0]!,
    overpassUrls,
    tileUrl: environment.OSM_TILE_URL ?? "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    tileAttribution:
      environment.OSM_TILE_ATTRIBUTION ??
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxUploadBytes: positiveInt(environment.MAX_KML_BYTES, 5 * 1024 * 1024),
    webRoot: resolve(environment.WEB_ROOT ?? "./apps/web/dist"),
  };
}

import { resolve } from "node:path";

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export interface AppConfig {
  port: number;
  host: string;
  publicUrl: string | null;
  dataDirectory: string;
  databasePath: string;
  nominatimUrl: string;
  overpassUrl: string;
  tileUrl: string;
  tileAttribution: string;
  maxUploadBytes: number;
  webRoot: string;
}

export function loadConfig(environment = process.env): AppConfig {
  const dataDirectory = resolve(environment.DATA_DIR ?? "./data");
  return {
    port: positiveInt(environment.PORT, 3000),
    host: environment.HOST ?? "0.0.0.0",
    publicUrl: environment.PUBLIC_APP_URL || null,
    dataDirectory,
    databasePath: resolve(dataDirectory, "hideseek-atlas.sqlite"),
    nominatimUrl: (environment.NOMINATIM_URL ?? "https://nominatim.openstreetmap.org").replace(
      /\/$/,
      "",
    ),
    overpassUrl: (environment.OVERPASS_URL ?? "https://overpass-api.de/api/interpreter").replace(
      /\/$/,
      "",
    ),
    tileUrl: environment.OSM_TILE_URL ?? "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    tileAttribution:
      environment.OSM_TILE_ATTRIBUTION ??
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxUploadBytes: positiveInt(environment.MAX_KML_BYTES, 5 * 1024 * 1024),
    webRoot: resolve(environment.WEB_ROOT ?? "./apps/web/dist"),
  };
}

import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import * as turf from "@turf/turf";
import osmtogeojson from "osmtogeojson";
import type {
  AreaFeature,
  MapFeatureCollection,
  SearchAreaResult,
  TransitMode,
} from "@hideseek/shared";
import { areaFeatureSchema, normalizeArea } from "@hideseek/shared";
import type {
  Feature,
  FeatureCollection,
  LineString,
  MultiLineString,
  Point,
  Polygon,
  MultiPolygon,
} from "geojson";
import type { AppConfig } from "../config.js";
import type { Database } from "../db/database.js";
import { osmCache } from "../db/schema.js";

function cacheKey(kind: string, payload: string): string {
  return `${kind}:${createHash("sha256").update(payload).digest("hex")}`;
}

function jsonText<T>(value: T): string {
  return JSON.stringify(value);
}

export class OsmRequestError extends Error {
  constructor(
    message: string,
    readonly statusCode = 503,
    readonly retryable = true,
  ) {
    super(message);
  }
}

interface RequestPolicy {
  attempts: number;
  attemptTimeoutMs: number;
  totalTimeoutMs: number;
  retryDelayMs: number;
}

export class OsmService {
  private readonly pending = new Map<string, Promise<any>>();

  constructor(
    private readonly db: Database,
    private readonly config: AppConfig,
    private readonly policy: RequestPolicy = {
      attempts: 3,
      attemptTimeoutMs: 25_000,
      totalTimeoutMs: 60_000,
      retryDelayMs: 1_000,
    },
  ) {}

  private async fetchJson(
    url: string,
    init: RequestInit,
    maxBytes: number,
    outerDeadline = Infinity,
  ): Promise<any> {
    const deadline = Math.min(Date.now() + this.policy.totalTimeoutMs, outerDeadline);
    for (let attempt = 0; attempt < this.policy.attempts; attempt++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new OsmRequestError("OpenStreetMap request timed out", 504);
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        Math.min(remaining, this.policy.attemptTimeoutMs),
      );
      let retryAfter = this.policy.retryDelayMs * 2 ** attempt;
      try {
        const response = await fetch(url, {
          ...init,
          signal: controller.signal,
          headers: {
            "User-Agent": `HideSeek Atlas/0.1 (${this.config.publicUrl ?? "self-hosted"})`,
            Accept: "application/json",
            ...init.headers,
          },
        });
        if (!response.ok) {
          const header = response.headers.get("Retry-After");
          if (header) {
            const seconds = Number(header);
            const delay = Number.isFinite(seconds)
              ? seconds * 1_000
              : Date.parse(header) - Date.now();
            if (Number.isFinite(delay)) retryAfter = Math.max(retryAfter, delay);
          }
          await response.body?.cancel();
          throw new OsmRequestError(
            `OpenStreetMap service returned ${response.status}`,
            503,
            [429, 500, 502, 503, 504].includes(response.status),
          );
        }
        const reader = response.body?.getReader();
        if (!reader)
          throw new OsmRequestError("OpenStreetMap returned an empty response", 502, false);
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > maxBytes) {
              await reader.cancel();
              throw new OsmRequestError("OpenStreetMap response was too large", 502, false);
            }
            chunks.push(value);
          }
        } finally {
          reader.releaseLock();
        }
        const bytes = Buffer.concat(chunks);
        let parsed: any;
        try {
          parsed = JSON.parse(bytes.toString("utf8"));
        } catch {
          throw new OsmRequestError("OpenStreetMap returned invalid JSON", 502, false);
        }
        if (!parsed || typeof parsed !== "object") {
          throw new OsmRequestError("OpenStreetMap returned an invalid response", 502, false);
        }
        if (typeof parsed.remark === "string" && parsed.remark.trim()) {
          throw new OsmRequestError("Overpass could not complete the query. Please try again.");
        }
        return parsed;
      } catch (cause) {
        const error =
          cause instanceof OsmRequestError
            ? cause
            : new OsmRequestError(
                controller.signal.aborted
                  ? "OpenStreetMap request timed out"
                  : "OpenStreetMap service is unavailable",
                controller.signal.aborted ? 504 : 503,
              );
        if (
          !error.retryable ||
          attempt + 1 >= this.policy.attempts ||
          retryAfter >= deadline - Date.now()
        )
          throw error;
      } finally {
        clearTimeout(timeout);
      }
      await new Promise((resolve) => setTimeout(resolve, retryAfter));
    }
    throw new OsmRequestError("OpenStreetMap service is unavailable");
  }

  private async coalesce<T>(key: string, work: () => Promise<T>): Promise<T> {
    const existing = this.pending.get(key);
    if (existing) return existing;
    const request = Promise.resolve().then(work);
    this.pending.set(key, request);
    try {
      return await request;
    } finally {
      this.pending.delete(key);
    }
  }

  private getCached<T>(key: string): T | null {
    const row = this.db.select().from(osmCache).where(eq(osmCache.key, key)).get();
    return row ? (JSON.parse(row.responseJson) as T) : null;
  }

  private setCached(key: string, kind: string, response: unknown): void {
    const now = new Date().toISOString();
    this.db
      .insert(osmCache)
      .values({ key, kind, responseJson: jsonText(response), createdAt: now, updatedAt: now })
      .onConflictDoUpdate({
        target: osmCache.key,
        set: { responseJson: jsonText(response), updatedAt: now },
      })
      .run();
  }

  async searchAreas(query: string): Promise<SearchAreaResult[]> {
    const normalized = query.trim();
    if (normalized.length < 2 || normalized.length > 150)
      throw new Error("Search must contain 2 to 150 characters");
    const key = cacheKey("nominatim", normalized.toLocaleLowerCase());
    const cached = this.getCached<SearchAreaResult[]>(key);
    if (cached) return cached;

    return this.coalesce(key, async () => {
      const url = new URL(`${this.config.nominatimUrl}/search`);
      url.searchParams.set("q", normalized);
      url.searchParams.set("format", "geojson");
      url.searchParams.set("polygon_geojson", "1");
      url.searchParams.set("addressdetails", "1");
      url.searchParams.set("extratags", "1");
      url.searchParams.set("limit", "8");
      const result = await this.fetchJson(url.toString(), { method: "GET" }, 12 * 1024 * 1024);
      if (!Array.isArray(result.features))
        throw new OsmRequestError("Nominatim returned an invalid response", 502, false);
      const candidates = result.features
        .map((feature: any): SearchAreaResult | null => {
          if (!feature.geometry || !["Polygon", "MultiPolygon"].includes(feature.geometry.type))
            return null;
          const parsed = areaFeatureSchema.safeParse({
            type: "Feature",
            geometry: feature.geometry,
            properties: feature.properties ?? {},
          });
          if (!parsed.success) return null;
          const properties = feature.properties ?? {};
          const rawBox = properties.boundingbox;
          const fallback = turf.bbox(parsed.data);
          const boundingBox: [number, number, number, number] =
            Array.isArray(rawBox) && rawBox.length === 4
              ? [Number(rawBox[2]), Number(rawBox[0]), Number(rawBox[3]), Number(rawBox[1])]
              : [fallback[0], fallback[1], fallback[2], fallback[3]];
          const osmType = properties.osm_type === "way" ? "way" : "relation";
          const adminLevel = Number.parseInt(
            properties.extratags?.admin_level ?? properties.admin_level ?? "",
            10,
          );
          return {
            osm: {
              osmType,
              osmId: String(properties.osm_id),
              displayName: String(properties.display_name ?? properties.name ?? normalized),
              boundingBox,
            },
            boundary: normalizeArea(parsed.data),
            adminLevel: Number.isFinite(adminLevel) ? adminLevel : null,
          };
        })
        .filter((item: SearchAreaResult | null): item is SearchAreaResult => item !== null);
      this.setCached(key, "nominatim", candidates);
      return candidates;
    });
  }

  private async overpass(
    query: string,
    kind: string,
    cache = true,
    deadline = Infinity,
  ): Promise<any> {
    const key = cacheKey(kind, query);
    if (cache) {
      const cached = this.getCached<any>(key);
      if (cached && Array.isArray(cached.elements) && cached.elements.length > 0 && !cached.remark)
        return cached;
    }
    return this.coalesce(key, async () => {
      const response = await this.fetchJson(
        this.config.overpassUrl,
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
          body: new URLSearchParams({ data: query }).toString(),
        },
        30 * 1024 * 1024,
        deadline,
      );
      if (!Array.isArray(response.elements))
        throw new OsmRequestError("Overpass returned an invalid response", 502, false);
      if (cache && response.elements.length > 0) this.setCached(key, kind, response);
      return response;
    });
  }

  async pointsOfInterest(
    boundingBox: [number, number, number, number],
    boundary: AreaFeature,
  ): Promise<MapFeatureCollection> {
    const [west, south, east, north] = boundingBox;
    if (![west, south, east, north].every(Number.isFinite) || west >= east || south >= north) {
      throw new OsmRequestError("The game has an invalid geographic bounding box", 400, false);
    }
    const columns = Math.max(1, Math.ceil((east - west) / 0.25));
    const rows = Math.max(1, Math.ceil((north - south) / 0.15));
    if (columns * rows > 16) {
      throw new OsmRequestError(
        "The game area is too large for the OSM POI fallback; use a smaller area or a curated KML/KMZ file",
        400,
        false,
      );
    }
    const deadline = Date.now() + 120_000;
    const features: Feature<Point>[] = [];
    const seen = new Set<string>();
    // Sequential bounded cells avoid expensive region-wide queries and concurrent public-service load.
    for (let row = 0; row < rows; row++) {
      for (let column = 0; column < columns; column++) {
        const cellWest = west + ((east - west) * column) / columns;
        const cellEast = west + ((east - west) * (column + 1)) / columns;
        const cellSouth = south + ((north - south) * row) / rows;
        const cellNorth = south + ((north - south) * (row + 1)) / rows;
        const bbox = `${cellSouth},${cellWest},${cellNorth},${cellEast}`;
        const query = `[out:json][timeout:20];(nwr["name"]["amenity"](${bbox});nwr["name"]["tourism"](${bbox});nwr["name"]["leisure"](${bbox});nwr["name"]["historic"](${bbox}););out center tags;`;
        const response = await this.overpass(query, "game-pois", false, deadline);
        for (const element of response.elements) {
          const type = ["node", "way", "relation"].includes(element.type) ? element.type : "";
          const id =
            typeof element.id === "number" || typeof element.id === "string"
              ? String(element.id)
              : "";
          const key = `${type}:${id}`;
          const tags = element.tags ?? {};
          const name = typeof tags.name === "string" ? tags.name.trim() : "";
          const longitude = Number(type === "node" ? element.lon : element.center?.lon);
          const latitude = Number(type === "node" ? element.lat : element.center?.lat);
          if (
            !name ||
            !id ||
            seen.has(key) ||
            !Number.isFinite(longitude) ||
            !Number.isFinite(latitude) ||
            longitude < -180 ||
            longitude > 180 ||
            latitude < -90 ||
            latitude > 90
          ) {
            continue;
          }
          const properties = Object.fromEntries(
            Object.entries(tags)
              .filter((entry): entry is [string, string | number | boolean] =>
                ["string", "number", "boolean"].includes(typeof entry[1]),
              )
              .slice(0, 50),
          );
          const point = turf.point([longitude, latitude], {
            ...properties,
            name,
            osmType: type,
            osmId: id,
          });
          if (!turf.booleanPointInPolygon(point, boundary)) continue;
          seen.add(key);
          features.push(point);
          if (features.length > 20_000) {
            throw new OsmRequestError(
              "The game area contains too many OpenStreetMap POIs; use a smaller area or a curated KML/KMZ file",
              400,
              false,
            );
          }
        }
      }
    }

    if (features.length === 0) {
      throw new Error("OpenStreetMap returned no named points of interest inside the game area");
    }
    return turf.featureCollection(features);
  }

  async subdivisions(
    osmType: "relation" | "way",
    osmId: string,
    adminLevel: number,
  ): Promise<FeatureCollection<Polygon | MultiPolygon>> {
    if (osmType !== "relation")
      throw new Error("Automatic subdivisions require an OSM relation boundary");
    const areaId = 3_600_000_000 + Number(osmId);
    if (!Number.isSafeInteger(areaId)) throw new Error("Invalid OSM relation ID");
    const query = `[out:json][timeout:20];relation["boundary"="administrative"]["admin_level"="${adminLevel}"](area:${areaId});out geom;`;
    // Cache only successfully normalized polygons. Old empty/raw cache entries cannot poison retries.
    const key = cacheKey("subdivisions-geojson-v2", query);
    const cached = this.getCached<FeatureCollection<Polygon | MultiPolygon>>(key);
    if (cached?.features.length) return cached;
    return this.coalesce(key, async () => {
      const converted = osmtogeojson(
        await this.overpass(query, "subdivisions", false),
      ) as FeatureCollection;
      const features = converted.features.filter(
        (feature): feature is Feature<Polygon | MultiPolygon> =>
          feature.geometry?.type === "Polygon" || feature.geometry?.type === "MultiPolygon",
      );
      if (features.length === 0)
        throw new Error(`No subdivisions found at admin level ${adminLevel}`);
      const result = turf.featureCollection(features);
      this.setCached(key, "subdivisions", result);
      return result;
    });
  }

  async subdivisionLevels(
    osmType: "relation" | "way",
    osmId: string,
    parentAdminLevel: number | null,
  ): Promise<Array<{ adminLevel: number; count: number; examples: string[] }>> {
    if (osmType !== "relation") return [];
    const areaId = 3_600_000_000 + Number(osmId);
    if (!Number.isSafeInteger(areaId)) throw new Error("Invalid OSM relation ID");
    const query = `[out:json][timeout:20];relation["boundary"="administrative"]["admin_level"](area:${areaId});out tags;`;
    const response = await this.overpass(query, "subdivision-levels");
    const levels = new Map<number, { count: number; examples: Set<string> }>();
    for (const element of response.elements ?? []) {
      const level = Number.parseInt(String(element.tags?.admin_level ?? ""), 10);
      if (
        Number.isInteger(level) &&
        level >= 2 &&
        level <= 12 &&
        (parentAdminLevel === null || level > parentAdminLevel)
      ) {
        const current = levels.get(level) ?? { count: 0, examples: new Set<string>() };
        current.count += 1;
        const name = String(element.tags?.name ?? "").trim();
        if (name && current.examples.size < 4) current.examples.add(name);
        levels.set(level, current);
      }
    }
    return [...levels.entries()]
      .map(([adminLevel, value]) => ({
        adminLevel,
        count: value.count,
        examples: [...value.examples],
      }))
      .filter((item) => item.count >= 2)
      .sort((left, right) => left.adminLevel - right.adminLevel);
  }

  async transit(
    boundingBox: [number, number, number, number],
    modes: TransitMode[],
  ): Promise<{
    lines: FeatureCollection<LineString | MultiLineString>;
    stations: FeatureCollection<Point>;
  }> {
    const [west, south, east, north] = boundingBox;
    const bbox = `${south},${west},${north},${east}`;
    const railwayPattern = modes.map((mode) => (mode === "train" ? "rail" : mode)).join("|");
    const query = `[out:json][timeout:20];(way["railway"~"^(${railwayPattern})$"](${bbox});nwr["railway"~"^(station|halt|tram_stop)$"](${bbox}););out geom;`;
    const converted = osmtogeojson(await this.overpass(query, "transit")) as FeatureCollection;
    const lines: Feature<LineString | MultiLineString>[] = [];
    const stations: Feature<Point>[] = [];
    for (const feature of converted.features) {
      if (feature.geometry?.type === "LineString" || feature.geometry?.type === "MultiLineString") {
        const properties = { ...(feature.properties ?? {}) };
        const railway = properties.railway;
        const transitMode: TransitMode | undefined =
          railway === "rail" || railway === "train"
            ? "train"
            : railway === "subway" || railway === "tram" || railway === "light_rail"
              ? railway
              : undefined;
        if (transitMode) {
          properties.transitMode = transitMode;
        }
        lines.push({
          ...(feature as Feature<LineString | MultiLineString>),
          properties,
        });
      } else if (feature.geometry?.type === "Point") {
        stations.push(feature as Feature<Point>);
      }
    }
    return { lines: turf.featureCollection(lines), stations: turf.featureCollection(stations) };
  }
}

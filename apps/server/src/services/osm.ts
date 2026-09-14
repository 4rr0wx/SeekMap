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

export class OsmService {
  constructor(
    private readonly db: Database,
    private readonly config: AppConfig,
  ) {}

  private async fetchJson(url: string, init: RequestInit, maxBytes: number): Promise<any> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 65_000);
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
      if (!response.ok) throw new Error(`OpenStreetMap service returned ${response.status}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > maxBytes) throw new Error("OpenStreetMap response was too large");
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch (error) {
      if ((error as Error).name === "AbortError")
        throw new Error("OpenStreetMap request timed out");
      throw error;
    } finally {
      clearTimeout(timeout);
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

    const url = new URL(`${this.config.nominatimUrl}/search`);
    url.searchParams.set("q", normalized);
    url.searchParams.set("format", "geojson");
    url.searchParams.set("polygon_geojson", "1");
    url.searchParams.set("addressdetails", "1");
    url.searchParams.set("extratags", "1");
    url.searchParams.set("limit", "8");
    const result = await this.fetchJson(url.toString(), { method: "GET" }, 12 * 1024 * 1024);
    const candidates = (result.features ?? [])
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
  }

  private async overpass(query: string, kind: string, cache = true): Promise<any> {
    const key = cacheKey(kind, query);
    if (cache) {
      const cached = this.getCached<any>(key);
      if (cached) return cached;
    }
    const response = await this.fetchJson(
      this.config.overpassUrl,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
        body: new URLSearchParams({ data: query }).toString(),
      },
      30 * 1024 * 1024,
    );
    if (cache) this.setCached(key, kind, response);
    return response;
  }

  async pointsOfInterest(
    boundingBox: [number, number, number, number],
    boundary: AreaFeature,
  ): Promise<MapFeatureCollection> {
    const [west, south, east, north] = boundingBox;
    const bbox = `${south},${west},${north},${east}`;
    const query = `[out:json][timeout:60];(nwr["name"]["amenity"](${bbox});nwr["name"]["tourism"](${bbox});nwr["name"]["leisure"](${bbox});nwr["name"]["historic"](${bbox}););out center tags;`;
    const response = await this.overpass(query, "game-pois", false);
    const features: Feature<Point>[] = [];
    const seen = new Set<string>();

    for (const element of response.elements ?? []) {
      const type = ["node", "way", "relation"].includes(element.type) ? element.type : "";
      const id =
        typeof element.id === "number" || typeof element.id === "string" ? String(element.id) : "";
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
    }

    if (features.length === 0) {
      throw new Error("OpenStreetMap returned no named points of interest inside the game area");
    }
    if (features.length > 20_000) {
      throw new Error(
        "The game area contains too many OpenStreetMap POIs; use a smaller area or a curated KML/KMZ file",
      );
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
    const query = `[out:json][timeout:60];relation["boundary"="administrative"]["admin_level"="${adminLevel}"](area:${areaId});out geom;`;
    const converted = osmtogeojson(await this.overpass(query, "subdivisions")) as FeatureCollection;
    const features = converted.features.filter(
      (feature): feature is Feature<Polygon | MultiPolygon> =>
        feature.geometry?.type === "Polygon" || feature.geometry?.type === "MultiPolygon",
    );
    if (features.length === 0)
      throw new Error(`No subdivisions found at admin level ${adminLevel}`);
    return turf.featureCollection(features);
  }

  async subdivisionLevels(
    osmType: "relation" | "way",
    osmId: string,
    parentAdminLevel: number | null,
  ): Promise<Array<{ adminLevel: number; count: number; examples: string[] }>> {
    if (osmType !== "relation") return [];
    const areaId = 3_600_000_000 + Number(osmId);
    if (!Number.isSafeInteger(areaId)) throw new Error("Invalid OSM relation ID");
    const query = `[out:json][timeout:30];relation["boundary"="administrative"]["admin_level"](area:${areaId});out tags;`;
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
    const query = `[out:json][timeout:60];(way["railway"~"^(${railwayPattern})$"](${bbox});nwr["railway"~"^(station|halt|tram_stop)$"](${bbox}););out geom;`;
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

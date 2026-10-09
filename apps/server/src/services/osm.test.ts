import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config";
import { openDatabase } from "../db/database";
import { OsmService } from "./osm";

afterEach(() => vi.unstubAllGlobals());

describe("OSM transit normalization", () => {
  it("builds a named, in-boundary POI dataset without caching it beyond the game", async () => {
    let requestBody = "";
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      requestBody = String(init.body);
      return new Response(
        JSON.stringify({
          elements: [
            {
              type: "node",
              id: 1,
              lat: 48.2,
              lon: 16.3,
              tags: { name: "Museum", tourism: "museum" },
            },
            {
              type: "way",
              id: 2,
              center: { lat: 48.21, lon: 16.31 },
              tags: { name: "Golf Club", leisure: "golf_course" },
            },
            {
              type: "node",
              id: 3,
              lat: 49,
              lon: 17,
              tags: { name: "Outside", amenity: "cafe" },
            },
            { type: "node", id: 4, lat: 48.22, lon: 16.32, tags: { amenity: "cafe" } },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const database = openDatabase(":memory:");
    try {
      const service = new OsmService(database.db, loadConfig());
      const boundary = {
        type: "Feature" as const,
        properties: {},
        geometry: {
          type: "Polygon" as const,
          coordinates: [
            [
              [16.2, 48.1],
              [16.4, 48.1],
              [16.4, 48.3],
              [16.2, 48.3],
              [16.2, 48.1],
            ],
          ],
        },
      };

      const result = await service.pointsOfInterest([16.2, 48.1, 16.4, 48.3], boundary);

      expect(result.features.map((feature) => feature.properties?.name)).toEqual([
        "Museum",
        "Golf Club",
      ]);
      expect(result.features[1]?.geometry).toEqual({ type: "Point", coordinates: [16.31, 48.21] });
      expect(decodeURIComponent(requestBody)).toContain('nwr["name"]["amenity"]');
      expect(database.sqlite.prepare("SELECT COUNT(*) AS count FROM osm_cache").get()).toEqual({
        count: 0,
      });
    } finally {
      database.sqlite.close();
    }
  });

  it("discovers generic child administrative levels without area-specific rules", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              elements: [
                { type: "relation", id: 1, tags: { admin_level: "6", name: "North" } },
                { type: "relation", id: 2, tags: { admin_level: "6", name: "South" } },
                { type: "relation", id: 3, tags: { admin_level: "8" } },
                { type: "relation", id: 4, tags: { admin_level: "10" } },
                { type: "relation", id: 5, tags: { admin_level: "10" } },
                { type: "relation", id: 6, tags: { admin_level: "10" } },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ),
    );
    const database = openDatabase(":memory:");
    try {
      const service = new OsmService(database.db, loadConfig());
      await expect(service.subdivisionLevels("relation", "123", 4)).resolves.toEqual([
        { adminLevel: 6, count: 2, examples: ["North", "South"] },
        { adminLevel: 10, count: 3, examples: [] },
      ]);
      await expect(service.subdivisionLevels("way", "123", 4)).resolves.toEqual([]);
    } finally {
      database.sqlite.close();
    }
  });

  it("keeps rail ways as lines and tagged stops as stations", async () => {
    let requestBody = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        requestBody = String(init.body);
        return new Response(
          JSON.stringify({
            version: 0.6,
            elements: [
              {
                type: "node",
                id: 1,
                lat: 48.2,
                lon: 16.3,
                tags: { name: "Central", railway: "station" },
              },
              {
                type: "way",
                id: 2,
                nodes: [10, 11],
                geometry: [
                  { lat: 48.2, lon: 16.3 },
                  { lat: 48.21, lon: 16.31 },
                ],
                tags: { name: "Main line", railway: "rail" },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );
    const database = openDatabase(":memory:");
    try {
      const service = new OsmService(database.db, loadConfig());
      const result = await service.transit([16.2, 48.1, 16.4, 48.3], ["train"]);
      expect(result.lines.features).toHaveLength(1);
      expect(result.lines.features[0]?.geometry.type).toBe("LineString");
      expect(result.lines.features[0]?.properties?.transitMode).toBe("train");
      expect(result.stations.features).toHaveLength(1);
      expect(result.stations.features[0]?.properties?.name).toBe("Central");
      expect(decodeURIComponent(requestBody)).toContain('way["railway"~"^(rail)$"]');
      expect(requestBody).not.toContain("bus");
    } finally {
      database.sqlite.close();
    }
  });

  it("normalizes subway, tram, and light rail modes onto feature properties", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(
          JSON.stringify({
            version: 0.6,
            elements: [
              {
                type: "way",
                id: 10,
                nodes: [1, 2],
                geometry: [
                  { lat: 48.2, lon: 16.3 },
                  { lat: 48.21, lon: 16.31 },
                ],
                tags: { name: "U1", railway: "subway" },
              },
              {
                type: "way",
                id: 11,
                nodes: [3, 4],
                geometry: [
                  { lat: 48.22, lon: 16.32 },
                  { lat: 48.23, lon: 16.33 },
                ],
                tags: { name: "Line 1", railway: "tram" },
              },
              {
                type: "way",
                id: 12,
                nodes: [5, 6],
                geometry: [
                  { lat: 48.24, lon: 16.34 },
                  { lat: 48.25, lon: 16.35 },
                ],
                tags: { name: "S45", railway: "light_rail" },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );
    const database = openDatabase(":memory:");
    try {
      const service = new OsmService(database.db, loadConfig());
      const result = await service.transit(
        [16.2, 48.1, 16.4, 48.3],
        ["subway", "tram", "light_rail"],
      );
      expect(result.lines.features).toHaveLength(3);

      const subwayLine = result.lines.features.find((f) => f.properties?.name === "U1");
      expect(subwayLine?.properties?.transitMode).toBe("subway");

      const tramLine = result.lines.features.find((f) => f.properties?.name === "Line 1");
      expect(tramLine?.properties?.transitMode).toBe("tram");

      const lightRailLine = result.lines.features.find((f) => f.properties?.name === "S45");
      expect(lightRailLine?.properties?.transitMode).toBe("light_rail");
    } finally {
      database.sqlite.close();
    }
  });
});

const quickPolicy = { attempts: 3, attemptTimeoutMs: 100, totalTimeoutMs: 1_000, retryDelayMs: 0 };
const validOverpass = () =>
  new Response(
    JSON.stringify({
      elements: [
        {
          type: "node",
          id: 1,
          lat: 48.2,
          lon: 16.3,
          tags: { railway: "station", name: "Central" },
        },
      ],
    }),
  );

describe("OSM request resilience", () => {
  it("retries a 504, shares concurrent requests and caches only the success", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("Busy", { status: 504 }))
      .mockImplementation(validOverpass);
    vi.stubGlobal("fetch", fetchMock);
    const database = openDatabase(":memory:");
    try {
      const service = new OsmService(database.db, loadConfig(), quickPolicy);
      await Promise.all([
        service.transit([16, 48, 17, 49], ["train"]),
        service.transit([16, 48, 17, 49], ["train"]),
      ]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      await service.transit([16, 48, 17, 49], ["train"]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(database.sqlite.prepare("SELECT COUNT(*) AS count FROM osm_cache").get()).toEqual({
        count: 1,
      });
    } finally {
      database.sqlite.close();
    }
  });

  it("does not cache partial Overpass responses and allows a later retry", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(
        async () =>
          new Response(JSON.stringify({ elements: [], remark: "runtime error: Query timed out" })),
      );
    vi.stubGlobal("fetch", fetchMock);
    const database = openDatabase(":memory:");
    try {
      const service = new OsmService(database.db, loadConfig(), quickPolicy);
      await expect(service.transit([16, 48, 17, 49], ["train"])).rejects.toThrow(
        "could not complete",
      );
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(database.sqlite.prepare("SELECT COUNT(*) AS count FROM osm_cache").get()).toEqual({
        count: 0,
      });
      fetchMock.mockImplementation(validOverpass);
      await expect(service.transit([16, 48, 17, 49], ["train"])).resolves.toHaveProperty("lines");
    } finally {
      database.sqlite.close();
    }
  });

  it("does not retry permanent errors or cache malformed data", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("Forbidden", { status: 403 }))
      .mockResolvedValueOnce(new Response("not json"))
      .mockResolvedValueOnce(new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);
    const database = openDatabase(":memory:");
    try {
      const service = new OsmService(database.db, loadConfig(), quickPolicy);
      for (const message of ["returned 403", "invalid JSON", "invalid response"]) {
        await expect(service.transit([16, 48, 17, 49], ["train"])).rejects.toThrow(message);
      }
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(database.sqlite.prepare("SELECT COUNT(*) AS count FROM osm_cache").get()).toEqual({
        count: 0,
      });
    } finally {
      database.sqlite.close();
    }
  });

  it("does not poison subdivision retries with an empty response and caches normalized polygons", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ elements: [] })))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            elements: [
              {
                type: "way",
                id: 1,
                nodes: [1, 2, 3, 4, 1],
                tags: { boundary: "administrative", area: "yes", name: "District" },
                geometry: [
                  { lon: 16, lat: 48 },
                  { lon: 17, lat: 48 },
                  { lon: 17, lat: 49 },
                  { lon: 16, lat: 49 },
                  { lon: 16, lat: 48 },
                ],
              },
            ],
          }),
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    const database = openDatabase(":memory:");
    try {
      const service = new OsmService(database.db, loadConfig(), quickPolicy);
      await expect(service.subdivisions("relation", "123", 10)).rejects.toThrow("No subdivisions");
      expect(database.sqlite.prepare("SELECT COUNT(*) AS count FROM osm_cache").get()).toEqual({
        count: 0,
      });
      expect((await service.subdivisions("relation", "123", 10)).features).toHaveLength(1);
      await service.subdivisions("relation", "123", 10);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      database.sqlite.close();
    }
  });

  it("respects Retry-After without waiting past the total request budget", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("Busy", { status: 429, headers: { "Retry-After": "120" } }));
    vi.stubGlobal("fetch", fetchMock);
    const database = openDatabase(":memory:");
    try {
      const service = new OsmService(database.db, loadConfig(), quickPolicy);
      await expect(service.transit([16, 48, 17, 49], ["train"])).rejects.toThrow("429");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      database.sqlite.close();
    }
  });

  it("aborts timed-out attempts and stops after the bounded retry count", async () => {
    const fetchMock = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const database = openDatabase(":memory:");
    try {
      const service = new OsmService(database.db, loadConfig(), {
        ...quickPolicy,
        attemptTimeoutMs: 5,
      });
      await expect(service.transit([16, 48, 17, 49], ["train"])).rejects.toThrow("timed out");
      expect(fetchMock).toHaveBeenCalledTimes(3);
    } finally {
      database.sqlite.close();
    }
  });
});

describe("bounded POI import", () => {
  it("splits large bounds, deduplicates OSM IDs and respects polygon holes", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            elements: [
              {
                type: "node",
                id: 1,
                lat: 48.2,
                lon: 16.3,
                tags: { name: "Museum", tourism: "museum" },
              },
              {
                type: "node",
                id: 2,
                lat: 48.1,
                lon: 16.15,
                tags: { name: "Excluded", amenity: "cafe" },
              },
              { type: "node", id: 3, lat: 49, lon: 17, tags: { name: "Outside", amenity: "cafe" } },
            ],
          }),
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const database = openDatabase(":memory:");
    try {
      const service = new OsmService(database.db, loadConfig(), quickPolicy);
      const boundary = {
        type: "Feature" as const,
        properties: {},
        geometry: {
          type: "Polygon" as const,
          coordinates: [
            [
              [16, 48],
              [16.5, 48],
              [16.5, 48.25],
              [16, 48.25],
              [16, 48],
            ],
            [
              [16.1, 48.05],
              [16.1, 48.15],
              [16.2, 48.15],
              [16.2, 48.05],
              [16.1, 48.05],
            ],
          ],
        },
      };
      const result = await service.pointsOfInterest([16, 48, 16.5, 48.25], boundary);
      expect(result.features.map((item) => item.properties?.name)).toEqual(["Museum"]);
      expect(fetchMock).toHaveBeenCalledTimes(4);
      expect(
        new Set(
          fetchMock.mock.calls.map((call) =>
            String((call as unknown as [string, RequestInit])[1].body),
          ),
        ).size,
      ).toBe(4);
      expect(database.sqlite.prepare("SELECT COUNT(*) AS count FROM osm_cache").get()).toEqual({
        count: 0,
      });
    } finally {
      database.sqlite.close();
    }
  });

  it("rejects unbounded areas before making requests", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const database = openDatabase(":memory:");
    try {
      const service = new OsmService(database.db, loadConfig(), quickPolicy);
      await expect(
        service.pointsOfInterest([10, 40, 30, 60], {
          type: "Feature",
          properties: {},
          geometry: {
            type: "Polygon",
            coordinates: [
              [
                [10, 40],
                [30, 40],
                [30, 60],
                [10, 60],
                [10, 40],
              ],
            ],
          },
        }),
      ).rejects.toThrow("too large");
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      database.sqlite.close();
    }
  });
});

it("uses explicitly configured fallback endpoints within the retry budget", async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(new Response("Busy", { status: 504 }))
    .mockImplementation(validOverpass);
  vi.stubGlobal("fetch", fetchMock);
  const database = openDatabase(":memory:");
  try {
    const service = new OsmService(
      database.db,
      loadConfig({
        OVERPASS_URL: "https://primary.example/api/interpreter",
        OVERPASS_FALLBACK_URLS: "https://fallback.example/api/interpreter",
      }),
      quickPolicy,
    );
    await service.transit([16, 48, 17, 49], ["train"]);
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      "https://primary.example/api/interpreter",
      "https://fallback.example/api/interpreter",
    ]);
  } finally {
    database.sqlite.close();
  }
});

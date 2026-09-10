import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config";
import { openDatabase } from "../db/database";
import { OsmService } from "./osm";

afterEach(() => vi.unstubAllGlobals());

describe("OSM transit normalization", () => {
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
      expect(result.stations.features).toHaveLength(1);
      expect(result.stations.features[0]?.properties?.name).toBe("Central");
      expect(decodeURIComponent(requestBody)).toContain('way["railway"~"^(rail)$"]');
      expect(requestBody).not.toContain("bus");
    } finally {
      database.sqlite.close();
    }
  });
});

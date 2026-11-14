import { describe, expect, it } from "vitest";
import { loadConfig } from "./config";

describe("loadConfig Overpass endpoints", () => {
  it("defaults to the public Overpass endpoint plus the lz4 mirror", () => {
    const config = loadConfig({
      DATA_DIR: "/tmp/hideseek-config-test",
      WEB_ROOT: "/tmp/hideseek-config-test/web",
    });
    expect(config.overpassUrls).toEqual([
      "https://overpass-api.de/api/interpreter",
      "https://lz4.overpass-api.de/api/interpreter",
    ]);
    expect(config.overpassUrl).toBe("https://overpass-api.de/api/interpreter");
  });

  it("keeps a single explicit OVERPASS_URL without inventing mirrors", () => {
    const config = loadConfig({
      DATA_DIR: "/tmp/hideseek-config-test",
      WEB_ROOT: "/tmp/hideseek-config-test/web",
      OVERPASS_URL: "https://private.example/interpreter",
    });
    expect(config.overpassUrls).toEqual(["https://private.example/interpreter"]);
  });
});

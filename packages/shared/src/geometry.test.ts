import * as turf from "@turf/turf";
import type { Polygon } from "geojson";
import { describe, expect, it } from "vitest";
import {
  areaSquareKilometers,
  buildQuestionArtifacts,
  normalizeArea,
  recomputePossibleArea,
  thermometerRegion,
  type AreaFeature,
} from "./index";

const boundary = turf.polygon([
  [
    [0, 0],
    [2, 0],
    [2, 2],
    [0, 2],
    [0, 0],
  ],
]) as AreaFeature;

describe("area geometry", () => {
  it("preserves Polygon and combines MultiPolygon-compatible feature collections", () => {
    expect(normalizeArea(boundary).geometry.type).toBe("Polygon");
    const second = turf.polygon([
      [
        [3, 0],
        [4, 0],
        [4, 1],
        [3, 1],
        [3, 0],
      ],
    ]);
    expect(normalizeArea(turf.featureCollection([boundary, second])).geometry.type).toBe(
      "MultiPolygon",
    );
  });

  it("applies and removes an old Radar effect deterministically", () => {
    const context = { boundary, subdivisions: null, datasets: [] };
    const first = buildQuestionArtifacts(
      "radar.standard",
      { center: [0.5, 1], radiusMeters: 80_000 },
      "INSIDE",
      context,
    ).artifacts.effect!;
    const edited = buildQuestionArtifacts(
      "radar.standard",
      { center: [1.5, 1], radiusMeters: 40_000 },
      "INSIDE",
      context,
    ).artifacts.effect!;

    const firstArea = recomputePossibleArea(boundary, [first]);
    const editedArea = recomputePossibleArea(boundary, [edited]);
    const removedArea = recomputePossibleArea(boundary, []);
    expect(areaSquareKilometers(firstArea)).toBeGreaterThan(areaSquareKilometers(editedArea));
    expect(areaSquareKilometers(removedArea)).toBeCloseTo(areaSquareKilometers(boundary), 4);
  });

  it("supports Radar outside through subtraction", () => {
    const effect = buildQuestionArtifacts(
      "radar.standard",
      { center: [1, 1], radiusMeters: 30_000 },
      "OUTSIDE",
      { boundary, subdivisions: null, datasets: [] },
    ).artifacts.effect!;
    const result = recomputePossibleArea(boundary, [effect]);
    expect(result).not.toBeNull();
    expect(areaSquareKilometers(result)).toBeLessThan(areaSquareKilometers(boundary));
    expect(turf.booleanPointInPolygon(turf.point([1, 1]), result!)).toBe(false);
  });

  it("builds opposite Thermometer regions for hotter and colder", () => {
    const start: [number, number] = [0.25, 1];
    const end: [number, number] = [1.75, 1];
    const cold = thermometerRegion(boundary, start, end, "START");
    const hot = thermometerRegion(boundary, start, end, "END");
    expect(turf.booleanPointInPolygon(turf.point(start), cold)).toBe(true);
    expect(turf.booleanPointInPolygon(turf.point(end), hot)).toBe(true);
    expect(turf.booleanPointInPolygon(turf.point(end), cold)).toBe(false);
  });

  it("handles a MultiPolygon game boundary", () => {
    const multi = turf.multiPolygon([
      (boundary.geometry as Polygon).coordinates,
      [
        [
          [3, 0],
          [4, 0],
          [4, 1],
          [3, 1],
          [3, 0],
        ],
      ],
    ]) as AreaFeature;
    const effect = buildQuestionArtifacts(
      "radar.standard",
      { center: [0.5, 0.5], radiusMeters: 100_000 },
      "INSIDE",
      { boundary: multi, subdivisions: null, datasets: [] },
    ).artifacts.effect!;
    expect(recomputePossibleArea(multi, [effect])?.geometry.type).toMatch(/Polygon/);
  });
});

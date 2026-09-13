import * as turf from "@turf/turf";
import type { Polygon } from "geojson";
import { describe, expect, it } from "vitest";
import {
  areaSquareKilometers,
  buildQuestionArtifacts,
  evaluateQuestionAtPosition,
  getQuestionAnswers,
  getQuestionDefinition,
  normalizeArea,
  recomputePossibleArea,
  thermometerDivider,
  thermometerRegion,
  projectToWebMercator,
  unprojectFromWebMercator,
  type AreaFeature,
  type UploadedDataset,
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

  it("builds radar artifacts with candidate-region and seeker-reference for draft, and answer-region when answered", () => {
    const center: [number, number] = [1, 1];
    const draft = buildQuestionArtifacts("radar.standard", { center, radiusMeters: 50_000 }, null, {
      boundary,
      subdivisions: null,
      datasets: [],
    }).artifacts.visualization;

    expect(draft?.type).toBe("FeatureCollection");
    if (draft?.type === "FeatureCollection") {
      expect(draft.features.map((f) => f.properties?.artifactRole)).toEqual([
        "candidate-region",
        "seeker-reference",
      ]);
      expect(draft.features[0]?.geometry.type).toBe("Polygon");
      expect(draft.features[1]?.geometry.type).toBe("Point");
    }

    const answered = buildQuestionArtifacts(
      "radar.standard",
      { center, radiusMeters: 50_000 },
      "INSIDE",
      { boundary, subdivisions: null, datasets: [] },
    ).artifacts.visualization;

    expect(answered?.type).toBe("FeatureCollection");
    if (answered?.type === "FeatureCollection") {
      expect(answered.features[0]?.properties?.artifactRole).toBe("answer-region");
      expect(answered.features[0]?.properties?.answer).toBe("INSIDE");
      expect(answered.features[1]?.properties?.artifactRole).toBe("seeker-reference");
    }
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

  it("builds a Mercator-perpendicular Thermometer divider and answer preview", () => {
    const start: [number, number] = [16.1, 48.2];
    const end: [number, number] = [16.5, 48.2];
    const viennaBoundary = turf.polygon([
      [
        [15.9, 47.9],
        [16.7, 47.9],
        [16.7, 48.5],
        [15.9, 48.5],
        [15.9, 47.9],
      ],
    ]) as AreaFeature;
    const divider = thermometerDivider(viennaBoundary, start, end);
    const dividerStart = divider.geometry.coordinates[0]!;
    const dividerEnd = divider.geometry.coordinates[divider.geometry.coordinates.length - 1]!;
    expect(dividerStart[0]!).toBeCloseTo(dividerEnd[0]!, 8);
    expect(divider.geometry.coordinates.length).toBeGreaterThan(2);

    const draft = buildQuestionArtifacts("thermometer.standard", { start, end }, null, {
      boundary: viennaBoundary,
      subdivisions: null,
      datasets: [],
    }).artifacts.visualization;
    expect(draft?.type).toBe("FeatureCollection");
    if (draft?.type === "FeatureCollection") {
      expect(draft.features.map((feature) => feature.properties?.artifactRole)).toEqual([
        "reference-line",
        "decision-boundary",
        "thermometer-start",
        "thermometer-end",
      ]);
    }

    const answered = buildQuestionArtifacts("thermometer.standard", { start, end }, "HOTTER", {
      boundary: viennaBoundary,
      subdivisions: null,
      datasets: [],
    }).artifacts;
    expect(answered.effect).not.toBeNull();
    expect(answered.visualization?.type).toBe("FeatureCollection");
    if (answered.visualization?.type === "FeatureCollection") {
      expect(answered.visualization.features[0]?.properties?.artifactRole).toBe("answer-region");
    }
  });

  it("aligns Thermometer divider and region boundaries at the midpoint for tilted angles", () => {
    const viennaBoundary = turf.polygon([
      [
        [15.9, 47.9],
        [16.7, 47.9],
        [16.7, 48.5],
        [15.9, 48.5],
        [15.9, 47.9],
      ],
    ]) as AreaFeature;
    const start: [number, number] = [16.37, 48.208];
    const end: [number, number] = [16.385, 48.206];
    const divider = thermometerDivider(viennaBoundary, start, end);
    const hot = thermometerRegion(viennaBoundary, start, end, "END");
    const cold = thermometerRegion(viennaBoundary, start, end, "START");

    const projStart = projectToWebMercator(start);
    const projEnd = projectToWebMercator(end);
    const trueMidpoint = unprojectFromWebMercator([
      (projStart[0] + projEnd[0]) / 2,
      (projStart[1] + projEnd[1]) / 2,
    ]);

    // Distance from midpoint to the divider line should be sub-meter
    const distDivider = turf.pointToLineDistance(turf.point(trueMidpoint), divider, {
      units: "meters",
    });
    expect(distDivider).toBeLessThan(1);

    // Distance from midpoint to the hot/cold region boundary should also be sub-meter
    const distHot = turf.pointToLineDistance(
      turf.point(trueMidpoint),
      turf.polygonToLine(hot) as any,
      {
        units: "meters",
      },
    );
    const distCold = turf.pointToLineDistance(
      turf.point(trueMidpoint),
      turf.polygonToLine(cold) as any,
      {
        units: "meters",
      },
    );
    expect(distHot).toBeLessThan(1);
    expect(distCold).toBeLessThan(1);

    // Regions partition the boundary
    const areaTotal = turf.area(viennaBoundary);
    const areaSum = turf.area(hot) + turf.area(cold);
    expect(areaSum / areaTotal).toBeCloseTo(1, 4);
    expect(turf.booleanPointInPolygon(turf.point(start), cold)).toBe(true);
    expect(turf.booleanPointInPolygon(turf.point(end), hot)).toBe(true);
    expect(turf.booleanPointInPolygon(turf.point(start), hot)).toBe(false);
    expect(turf.booleanPointInPolygon(turf.point(end), cold)).toBe(false);
  });

  it("accurately partitions large boundaries like Lower Austria without Mercator distortion", () => {
    const lowerAustriaBoundary = turf.polygon([
      [
        [14.4, 47.4],
        [17.1, 47.4],
        [17.1, 49.0],
        [14.4, 49.0],
        [14.4, 47.4],
      ],
    ]) as AreaFeature;
    const start: [number, number] = [15.96, 47.9];
    const end: [number, number] = [15.99, 47.897];
    const divider = thermometerDivider(lowerAustriaBoundary, start, end);
    const hot = thermometerRegion(lowerAustriaBoundary, start, end, "END");
    const cold = thermometerRegion(lowerAustriaBoundary, start, end, "START");

    const projStart = projectToWebMercator(start);
    const projEnd = projectToWebMercator(end);
    const trueMidpoint = unprojectFromWebMercator([
      (projStart[0] + projEnd[0]) / 2,
      (projStart[1] + projEnd[1]) / 2,
    ]);

    const distDivider = turf.pointToLineDistance(turf.point(trueMidpoint), divider, {
      units: "meters",
    });
    expect(distDivider).toBeLessThan(1);

    const distHot = turf.pointToLineDistance(
      turf.point(trueMidpoint),
      turf.polygonToLine(hot) as any,
      { units: "meters" },
    );
    const distCold = turf.pointToLineDistance(
      turf.point(trueMidpoint),
      turf.polygonToLine(cold) as any,
      { units: "meters" },
    );
    expect(distHot).toBeLessThan(1);
    expect(distCold).toBeLessThan(1);

    const areaTotal = turf.area(lowerAustriaBoundary);
    const areaSum = turf.area(hot) + turf.area(cold);
    expect(areaSum / areaTotal).toBeCloseTo(1, 4);
  });

  it("builds reusable Matching and Measuring place effects and local Hider guidance", () => {
    const places: UploadedDataset = {
      id: "11111111-1111-4111-8111-111111111111",
      name: "Golf Courses",
      category: "MATCHING",
      originalFilename: "golf-courses.kml",
      geojson: turf.featureCollection([
        turf.point([0.4, 1], { name: "West Golf Club" }),
        turf.point([1.6, 1], { name: "East Golf Club" }),
      ]),
      featureCount: 2,
      createdAt: "2026-09-11T00:00:00.000Z",
      updatedAt: "2026-09-11T00:00:00.000Z",
    };
    const context = { boundary, subdivisions: null, datasets: [places] };
    const parameters = { referencePoint: [0.3, 1], datasetId: places.id };

    const same = buildQuestionArtifacts("matching.dataset", parameters, "SAME", context).artifacts;
    expect(same.effect).not.toBeNull();
    expect(turf.booleanPointInPolygon(turf.point([0.2, 1]), same.effect!.geometry)).toBe(true);
    expect(turf.booleanPointInPolygon(turf.point([1.8, 1]), same.effect!.geometry)).toBe(false);
    const matchEvaluation = evaluateQuestionAtPosition(
      "matching.dataset",
      parameters,
      [1.8, 1],
      context,
    );
    expect(matchEvaluation?.answer).toBe("DIFFERENT");
    expect(matchEvaluation?.details.join(" ")).toContain("East Golf Club");

    const closer = buildQuestionArtifacts(
      "measuring.dataset",
      parameters,
      "CLOSER",
      context,
    ).artifacts;
    expect(closer.effect).not.toBeNull();
    const measuringEvaluation = evaluateQuestionAtPosition(
      "measuring.dataset",
      parameters,
      [0.39, 1],
      context,
    );
    expect(measuringEvaluation?.answer).toBe("CLOSER");
    expect(measuringEvaluation?.summary).toContain("closer");
  });

  it("builds Tentacles Voronoi cells, radius exclusion, and local Hider evaluation", () => {
    const attractions: UploadedDataset = {
      id: "22222222-2222-4222-8222-222222222222",
      name: "Theme Parks",
      category: "TENTACLES",
      originalFilename: "parks.kml",
      geojson: turf.featureCollection([
        turf.point([0.9, 1], { name: "North Park" }),
        turf.point([1.1, 1], { name: "East Park" }),
        turf.point([1.9, 1.9], { name: "Faraway Park" }),
      ]),
      featureCount: 3,
      createdAt: "2026-09-11T00:00:00.000Z",
      updatedAt: "2026-09-11T00:00:00.000Z",
    };
    const context = { boundary, subdivisions: null, datasets: [attractions] };
    const referencePoint: [number, number] = [1, 1];
    const radiusMeters = 25_000;
    const parameters = { referencePoint, radiusMeters, datasetId: attractions.id };

    const definition = getQuestionDefinition("tentacles.dataset");
    const answers = getQuestionAnswers(definition, parameters, context);
    expect(answers.map((a) => a.value)).toEqual(["place:0", "place:1", "OUTSIDE"]);
    expect(answers[0]!.label).toContain("North Park");
    expect(answers[1]!.label).toContain("East Park");

    const draft = buildQuestionArtifacts("tentacles.dataset", parameters, null, context).artifacts;
    expect(draft.effect).toBeNull();
    expect(draft.visualization?.type).toBe("FeatureCollection");
    if (draft.visualization?.type === "FeatureCollection") {
      const roles = draft.visualization.features.map((f) => f.properties?.artifactRole);
      expect(roles).toContain("candidate-region");
      expect(roles).toContain("seeker-reference");
      expect(roles).toContain("decision-boundary");
      expect(roles).toContain("reference-line");
      expect(roles).toContain("dataset-place");
    }

    const answerPlace0 = buildQuestionArtifacts(
      "tentacles.dataset",
      parameters,
      "place:0",
      context,
    ).artifacts;
    expect(answerPlace0.effect?.mode).toBe("INTERSECT");
    expect(turf.booleanPointInPolygon(turf.point([0.92, 1]), answerPlace0.effect!.geometry)).toBe(
      true,
    );
    expect(turf.booleanPointInPolygon(turf.point([1.08, 1]), answerPlace0.effect!.geometry)).toBe(
      false,
    );

    const answerOutside = buildQuestionArtifacts(
      "tentacles.dataset",
      parameters,
      "OUTSIDE",
      context,
    ).artifacts;
    expect(answerOutside.effect?.mode).toBe("SUBTRACT");
    const recomputed = recomputePossibleArea(boundary, [answerOutside.effect!]);
    expect(turf.booleanPointInPolygon(turf.point([1, 1]), recomputed!)).toBe(false);
    expect(turf.booleanPointInPolygon(turf.point([0.1, 0.1]), recomputed!)).toBe(true);

    const evalNearNorth = evaluateQuestionAtPosition(
      "tentacles.dataset",
      parameters,
      [0.91, 1],
      context,
    );
    expect(evalNearNorth?.answer).toBe("place:0");
    expect(evalNearNorth?.summary).toContain("North Park");

    const evalOutside = evaluateQuestionAtPosition(
      "tentacles.dataset",
      parameters,
      [0.1, 0.1],
      context,
    );
    expect(evalOutside?.answer).toBe("OUTSIDE");
    expect(evalOutside?.summary).toContain("outside the tentacle radius");
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

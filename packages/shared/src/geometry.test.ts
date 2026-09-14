import * as turf from "@turf/turf";
import type { Polygon } from "geojson";
import { describe, expect, it } from "vitest";
import {
  areaSquareKilometers,
  buildQuestionArtifacts,
  combineBoundaries,
  evaluateQuestionAtPosition,
  getQuestionAnswers,
  getQuestionDefinition,
  getQuestionReferenceInfo,
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
      temporary: false,
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

    const matchWithoutLocation = evaluateQuestionAtPosition(
      "matching.dataset",
      parameters,
      null,
      context,
    );
    expect(matchWithoutLocation?.answer).toBeNull();
    expect(matchWithoutLocation?.summary).toBe("Location needed to check this answer.");
    expect(matchWithoutLocation?.details).toEqual(["Seeker: West Golf Club"]);

    const refInfo = getQuestionReferenceInfo("matching.dataset", parameters, context);
    expect(refInfo?.placeName).toBe("West Golf Club");

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

    const measuringWithoutLocation = evaluateQuestionAtPosition(
      "measuring.dataset",
      parameters,
      null,
      context,
    );
    expect(measuringWithoutLocation?.answer).toBeNull();
    expect(measuringWithoutLocation?.summary).toBe("Location needed to check this answer.");
    expect(measuringWithoutLocation?.details[0]).toContain("Seeker: West Golf Club");

    const measuringRefInfo = getQuestionReferenceInfo("measuring.dataset", parameters, context);
    expect(measuringRefInfo?.placeName).toBe("West Golf Club");
  });

  it("builds Tentacles Voronoi cells, radius exclusion, and local Hider evaluation", () => {
    const attractions: UploadedDataset = {
      id: "22222222-2222-4222-8222-222222222222",
      name: "Theme Parks",
      category: "TENTACLES",
      temporary: false,
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

  it("evaluates matching.first-division and radar with and without local position", () => {
    const subdivisions = turf.featureCollection([
      turf.polygon(
        [
          [
            [0, 0],
            [1, 0],
            [1, 2],
            [0, 2],
            [0, 0],
          ],
        ],
        { name: "West District" },
      ),
      turf.polygon(
        [
          [
            [1, 0],
            [2, 0],
            [2, 2],
            [1, 2],
            [1, 0],
          ],
        ],
        { name: "East District" },
      ),
    ]);
    const divContext = { boundary, subdivisions, datasets: [] };
    const divParams = { referencePoint: [0.5, 1] };

    const divWithLocation = evaluateQuestionAtPosition(
      "matching.first-division",
      divParams,
      [1.5, 1],
      divContext,
    );
    expect(divWithLocation?.answer).toBe("DIFFERENT");
    expect(divWithLocation?.details).toEqual(["Seeker: West District", "You: East District"]);

    const divWithoutLocation = evaluateQuestionAtPosition(
      "matching.first-division",
      divParams,
      null,
      divContext,
    );
    expect(divWithoutLocation?.answer).toBeNull();
    expect(divWithoutLocation?.summary).toBe("Location needed to check this answer.");
    expect(divWithoutLocation?.details).toEqual(["Seeker: West District"]);

    const divRefInfo = getQuestionReferenceInfo("matching.first-division", divParams, divContext);
    expect(divRefInfo?.divisionName).toBe("West District");

    const radarWithoutLocation = evaluateQuestionAtPosition(
      "radar.standard",
      { center: [1, 1], radiusMeters: 5000 },
      null,
      divContext,
    );
    expect(radarWithoutLocation?.answer).toBeNull();
    expect(radarWithoutLocation?.summary).toBe("Location needed to check this answer.");
    expect(radarWithoutLocation?.details).toEqual(["Radius: 5.00 km"]);
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

  describe("combineBoundaries", () => {
    const boxA = turf.polygon([
      [
        [0, 0],
        [4, 0],
        [4, 4],
        [0, 4],
        [0, 0],
      ],
    ]) as AreaFeature;

    const boxB = turf.polygon([
      [
        [3, 0],
        [6, 0],
        [6, 4],
        [3, 4],
        [3, 0],
      ],
    ]) as AreaFeature;

    const boxDisjoint = turf.polygon([
      [
        [10, 10],
        [12, 10],
        [12, 12],
        [10, 12],
        [10, 10],
      ],
    ]) as AreaFeature;

    const hole = turf.polygon([
      [
        [1, 1],
        [2, 1],
        [2, 2],
        [1, 2],
        [1, 1],
      ],
    ]) as AreaFeature;

    it("returns null when no operations are provided", () => {
      expect(combineBoundaries([])).toBeNull();
    });

    it("returns null when only subtract operations are provided", () => {
      expect(combineBoundaries([{ mode: "SUBTRACT", boundary: boxA }])).toBeNull();
    });

    it("returns the single added boundary", () => {
      const result = combineBoundaries([{ mode: "ADD", boundary: boxA }]);
      expect(result).not.toBeNull();
      expect(result?.geometry.type).toBe("Polygon");
      expect(areaSquareKilometers(result!)).toBeCloseTo(areaSquareKilometers(boxA), 2);
    });

    it("unions multiple overlapping added boundaries into a single boundary", () => {
      const result = combineBoundaries([
        { mode: "ADD", boundary: boxA },
        { mode: "ADD", boundary: boxB },
      ]);
      expect(result).not.toBeNull();
      // Combined width is 6, height is 4 -> area should be larger than A alone but less than A + B
      expect(areaSquareKilometers(result!)).toBeGreaterThan(areaSquareKilometers(boxA));
      expect(areaSquareKilometers(result!)).toBeLessThan(
        areaSquareKilometers(boxA) + areaSquareKilometers(boxB),
      );
      expect(turf.booleanPointInPolygon(turf.point([1, 1]), result!)).toBe(true);
      expect(turf.booleanPointInPolygon(turf.point([5, 2]), result!)).toBe(true);
    });

    it("unions disjoint added boundaries into a MultiPolygon", () => {
      const result = combineBoundaries([
        { mode: "ADD", boundary: boxA },
        { mode: "ADD", boundary: boxDisjoint },
      ]);
      expect(result).not.toBeNull();
      expect(result?.geometry.type).toBe("MultiPolygon");
      expect(areaSquareKilometers(result!)).toBeCloseTo(
        areaSquareKilometers(boxA) + areaSquareKilometers(boxDisjoint),
        2,
      );
    });

    it("subtracts an inner hole from an added boundary", () => {
      const result = combineBoundaries([
        { mode: "ADD", boundary: boxA },
        { mode: "SUBTRACT", boundary: hole },
      ]);
      expect(result).not.toBeNull();
      expect(areaSquareKilometers(result!)).toBeCloseTo(
        areaSquareKilometers(boxA) - areaSquareKilometers(hole),
        2,
      );
      // Point inside hole must not be inside play area
      expect(turf.booleanPointInPolygon(turf.point([1.5, 1.5]), result!)).toBe(false);
      // Point outside hole but in boxA must still be inside
      expect(turf.booleanPointInPolygon(turf.point([0.5, 0.5]), result!)).toBe(true);
    });

    it("subtracts multiple regions from the union of added boundaries", () => {
      const hole2 = turf.polygon([
        [
          [4.5, 1],
          [5.5, 1],
          [5.5, 2],
          [4.5, 2],
          [4.5, 1],
        ],
      ]) as AreaFeature;

      const result = combineBoundaries([
        { mode: "ADD", boundary: boxA },
        { mode: "ADD", boundary: boxB },
        { mode: "SUBTRACT", boundary: hole },
        { mode: "SUBTRACT", boundary: hole2 },
      ]);
      expect(result).not.toBeNull();
      expect(turf.booleanPointInPolygon(turf.point([1.5, 1.5]), result!)).toBe(false);
      expect(turf.booleanPointInPolygon(turf.point([5, 1.5]), result!)).toBe(false);
      expect(turf.booleanPointInPolygon(turf.point([0.5, 0.5]), result!)).toBe(true);
    });

    it("ignores subtract operations that do not intersect the added area", () => {
      const result = combineBoundaries([
        { mode: "ADD", boundary: boxA },
        { mode: "SUBTRACT", boundary: boxDisjoint },
      ]);
      expect(result).not.toBeNull();
      expect(areaSquareKilometers(result!)).toBeCloseTo(areaSquareKilometers(boxA), 2);
    });

    it("returns null if subtraction completely eliminates the added area", () => {
      const largeBox = turf.polygon([
        [
          [-1, -1],
          [10, -1],
          [10, 10],
          [-1, 10],
          [-1, -1],
        ],
      ]) as AreaFeature;

      const result = combineBoundaries([
        { mode: "ADD", boundary: boxA },
        { mode: "SUBTRACT", boundary: largeBox },
      ]);
      expect(result).toBeNull();
    });

    it("handles MultiPolygon with multiple outer rings and multiple inner holes", () => {
      const multiWithHoles = turf.multiPolygon([
        [
          [
            [0, 0],
            [10, 0],
            [10, 10],
            [0, 10],
            [0, 0],
          ],
          [
            [2, 2],
            [4, 2],
            [4, 4],
            [2, 4],
            [2, 2],
          ],
          [
            [6, 6],
            [8, 6],
            [8, 8],
            [6, 8],
            [6, 6],
          ],
        ],
        [
          [
            [20, 20],
            [30, 20],
            [30, 30],
            [20, 30],
            [20, 20],
          ],
          [
            [22, 22],
            [25, 22],
            [25, 25],
            [22, 25],
            [22, 22],
          ],
        ],
      ]) as AreaFeature;

      const result = combineBoundaries([{ mode: "ADD", boundary: multiWithHoles }]);
      expect(result).not.toBeNull();
      expect(result?.geometry.type).toBe("MultiPolygon");
      expect(turf.booleanPointInPolygon(turf.point([1, 1]), result!)).toBe(true);
      expect(turf.booleanPointInPolygon(turf.point([3, 3]), result!)).toBe(false);
      expect(turf.booleanPointInPolygon(turf.point([7, 7]), result!)).toBe(false);
      expect(turf.booleanPointInPolygon(turf.point([21, 21]), result!)).toBe(true);
      expect(turf.booleanPointInPolygon(turf.point([23, 23]), result!)).toBe(false);
    });

    it("subtracts a boundary that bridges across distinct components of a MultiPolygon", () => {
      const multi = turf.multiPolygon([
        [
          [
            [0, 0],
            [5, 0],
            [5, 5],
            [0, 5],
            [0, 0],
          ],
        ],
        [
          [
            [10, 0],
            [15, 0],
            [15, 5],
            [10, 5],
            [10, 0],
          ],
        ],
      ]) as AreaFeature;

      const cutter = turf.polygon([
        [
          [4, 2],
          [11, 2],
          [11, 4],
          [4, 4],
          [4, 2],
        ],
      ]) as AreaFeature;

      const result = combineBoundaries([
        { mode: "ADD", boundary: multi },
        { mode: "SUBTRACT", boundary: cutter },
      ]);
      expect(result).not.toBeNull();
      expect(result?.geometry.type).toBe("MultiPolygon");
      expect(turf.booleanPointInPolygon(turf.point([4.5, 3]), result!)).toBe(false);
      expect(turf.booleanPointInPolygon(turf.point([10.5, 3]), result!)).toBe(false);
      expect(turf.booleanPointInPolygon(turf.point([1, 1]), result!)).toBe(true);
      expect(turf.booleanPointInPolygon(turf.point([14, 1]), result!)).toBe(true);
    });

    it("subtracts a MultiPolygon boundary with multiple components", () => {
      const multiSubtract = turf.multiPolygon([
        [
          [
            [0.5, 0.5],
            [1.5, 0.5],
            [1.5, 1.5],
            [0.5, 1.5],
            [0.5, 0.5],
          ],
        ],
        [
          [
            [2.5, 2.5],
            [3.5, 2.5],
            [3.5, 3.5],
            [2.5, 3.5],
            [2.5, 2.5],
          ],
        ],
      ]) as AreaFeature;

      const result = combineBoundaries([
        { mode: "ADD", boundary: boxA },
        { mode: "SUBTRACT", boundary: multiSubtract },
      ]);
      expect(result).not.toBeNull();
      expect(turf.booleanPointInPolygon(turf.point([1, 1]), result!)).toBe(false);
      expect(turf.booleanPointInPolygon(turf.point([3, 3]), result!)).toBe(false);
      expect(turf.booleanPointInPolygon(turf.point([2, 1]), result!)).toBe(true);
    });

    it("merges two adjacent polygons sharing an identical edge into a single Polygon", () => {
      const poly1 = turf.polygon([
        [
          [0, 0],
          [2, 0],
          [2, 2],
          [0, 2],
          [0, 0],
        ],
      ]) as AreaFeature;
      const poly2 = turf.polygon([
        [
          [2, 0],
          [4, 0],
          [4, 2],
          [2, 2],
          [2, 0],
        ],
      ]) as AreaFeature;

      const result = combineBoundaries([
        { mode: "ADD", boundary: poly1 },
        { mode: "ADD", boundary: poly2 },
      ]);
      expect(result).not.toBeNull();
      expect(result?.geometry.type).toBe("Polygon");
      expect(turf.booleanPointInPolygon(turf.point([1, 1]), result!)).toBe(true);
      expect(turf.booleanPointInPolygon(turf.point([3, 1]), result!)).toBe(true);
      expect(areaSquareKilometers(result!)).toBeCloseTo(
        areaSquareKilometers(poly1) + areaSquareKilometers(poly2),
        3,
      );
    });

    it("merges two adjacent polygons sharing a partial edge (T-junction)", () => {
      const poly1 = turf.polygon([
        [
          [0, 0],
          [2, 0],
          [2, 4],
          [0, 4],
          [0, 0],
        ],
      ]) as AreaFeature;
      const poly2 = turf.polygon([
        [
          [2, 1],
          [4, 1],
          [4, 3],
          [2, 3],
          [2, 1],
        ],
      ]) as AreaFeature;

      const result = combineBoundaries([
        { mode: "ADD", boundary: poly1 },
        { mode: "ADD", boundary: poly2 },
      ]);
      expect(result).not.toBeNull();
      expect(result?.geometry.type).toBe("Polygon");
      expect(areaSquareKilometers(result!)).toBeCloseTo(
        areaSquareKilometers(poly1) + areaSquareKilometers(poly2),
        3,
      );
    });

    it("unions polygons touching at a single vertex into a MultiPolygon to prevent pinch points", () => {
      const poly1 = turf.polygon([
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 1],
          [0, 0],
        ],
      ]) as AreaFeature;
      const poly2 = turf.polygon([
        [
          [1, 1],
          [2, 1],
          [2, 2],
          [1, 2],
          [1, 1],
        ],
      ]) as AreaFeature;

      const result = combineBoundaries([
        { mode: "ADD", boundary: poly1 },
        { mode: "ADD", boundary: poly2 },
      ]);
      expect(result).not.toBeNull();
      expect(result?.geometry.type).toBe("MultiPolygon");
      expect(turf.booleanPointInPolygon(turf.point([0.5, 0.5]), result!)).toBe(true);
      expect(turf.booleanPointInPolygon(turf.point([1.5, 1.5]), result!)).toBe(true);
    });

    it("splits a single polygon into a MultiPolygon via a trench cut subtraction", () => {
      const trench = turf.polygon([
        [
          [1.8, -1],
          [2.2, -1],
          [2.2, 5],
          [1.8, 5],
          [1.8, -1],
        ],
      ]) as AreaFeature;

      const result = combineBoundaries([
        { mode: "ADD", boundary: boxA },
        { mode: "SUBTRACT", boundary: trench },
      ]);
      expect(result).not.toBeNull();
      expect(result?.geometry.type).toBe("MultiPolygon");
      expect(turf.booleanPointInPolygon(turf.point([1, 2]), result!)).toBe(true);
      expect(turf.booleanPointInPolygon(turf.point([2, 2]), result!)).toBe(false);
      expect(turf.booleanPointInPolygon(turf.point([3, 2]), result!)).toBe(true);
    });

    it("handles order independence and precedence of subtractions over additions", () => {
      const A = turf.polygon([
        [
          [0, 0],
          [10, 0],
          [10, 10],
          [0, 10],
          [0, 0],
        ],
      ]) as AreaFeature;
      const holeArea = turf.polygon([
        [
          [3, 3],
          [7, 3],
          [7, 7],
          [3, 7],
          [3, 3],
        ],
      ]) as AreaFeature;
      const island = turf.polygon([
        [
          [4, 4],
          [6, 4],
          [6, 6],
          [4, 6],
          [4, 4],
        ],
      ]) as AreaFeature;

      // Grouped model: ALL additions unioned, then ALL subtractions applied.
      // Island inside hole is subsumed by A in union, then hole is subtracted, so island is excluded.
      const result = combineBoundaries([
        { mode: "ADD", boundary: A },
        { mode: "SUBTRACT", boundary: holeArea },
        { mode: "ADD", boundary: island },
      ]);
      expect(result).not.toBeNull();
      expect(turf.booleanPointInPolygon(turf.point([5, 5]), result!)).toBe(false);
      expect(turf.booleanPointInPolygon(turf.point([1, 1]), result!)).toBe(true);

      // Order independence between ADD and SUBTRACT
      const reordered = combineBoundaries([
        { mode: "SUBTRACT", boundary: holeArea },
        { mode: "ADD", boundary: island },
        { mode: "ADD", boundary: A },
      ]);
      expect(reordered).not.toBeNull();
      expect(areaSquareKilometers(reordered!)).toBeCloseTo(areaSquareKilometers(result!), 4);
    });

    it("handles high vertex count complex polygon with 2,000 vertices", () => {
      const n = 2000;
      const center: [number, number] = [16.37, 48.2];
      const coords: [number, number][] = [];
      for (let i = 0; i < n; i++) {
        const theta = (i / n) * 2 * Math.PI;
        const r = 0.1 + 0.02 * Math.sin(theta * 25);
        coords.push([center[0] + r * Math.cos(theta), center[1] + r * Math.sin(theta)]);
      }
      coords.push(coords[0]!);

      const wavyPoly = turf.polygon([coords]) as AreaFeature;
      const cutter = turf.polygon([
        [
          [16.35, 48.15],
          [16.45, 48.15],
          [16.45, 48.25],
          [16.35, 48.25],
          [16.35, 48.15],
        ],
      ]) as AreaFeature;

      const t0 = performance.now();
      const result = combineBoundaries([
        { mode: "ADD", boundary: wavyPoly },
        { mode: "SUBTRACT", boundary: cutter },
      ]);
      const duration = performance.now() - t0;

      expect(result).not.toBeNull();
      expect(result?.geometry.type).toMatch(/Polygon/);
      expect(duration).toBeLessThan(1000);
    });

    it("safely rejects non-polygon or degenerate geometry without throwing", () => {
      const pointFeature = turf.point([0, 0]) as unknown as AreaFeature;
      expect(combineBoundaries([{ mode: "ADD", boundary: pointFeature }])).toBeNull();

      const lineFeature = turf.lineString([
        [0, 0],
        [1, 1],
      ]) as unknown as AreaFeature;
      expect(combineBoundaries([{ mode: "ADD", boundary: lineFeature }])).toBeNull();

      const emptyCoords = {
        type: "Feature",
        geometry: { type: "Polygon", coordinates: [] },
        properties: {},
      } as unknown as AreaFeature;
      expect(combineBoundaries([{ mode: "ADD", boundary: emptyCoords }])).toBeNull();

      const bowtie = turf.polygon([
        [
          [0, 0],
          [2, 2],
          [2, 0],
          [0, 2],
          [0, 0],
        ],
      ]) as AreaFeature;
      expect(() => combineBoundaries([{ mode: "ADD", boundary: bowtie }])).not.toThrow();
    });
  });
});

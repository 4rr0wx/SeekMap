import * as turf from "@turf/turf";
import type { AreaFeature, MapFeature, QuestionInstance } from "@hideseek/shared";
import { describe, expect, it } from "vitest";
import {
  createGameAreaLayers,
  filterVisibleQuestions,
  MAP_COLORS,
  MAP_LEGEND_SECTIONS,
  processQuestionFeatures,
} from "./mapTheme";

describe("MAP_COLORS", () => {
  it("defines valid hex colors for all color properties", () => {
    const hexRegex = /^#[0-9a-fA-F]{6}$/;
    const colorEntries = Object.entries(MAP_COLORS).filter(
      ([key]) =>
        key.toLowerCase().includes("fill") ||
        key.toLowerCase().includes("line") ||
        key.toLowerCase().includes("stroke") ||
        key.toLowerCase().includes("point"),
    );

    for (const [key, value] of colorEntries) {
      if (typeof value === "string") {
        expect(
          hexRegex.test(value),
          `${key} value "${value}" must be a valid 6-character hex color`,
        ).toBe(true);
      }
    }
  });

  it("ensures Possible Area has an exclusive signature color distinct from question geometry and datasets", () => {
    // Issue #6 regression check: Possible Area must not share colors with answer regions or datasets
    expect(MAP_COLORS.possibleFill).not.toBe(MAP_COLORS.questionAnswerFill);
    expect(MAP_COLORS.possibleFill).not.toBe(MAP_COLORS.questionSelectedFill);
    expect(MAP_COLORS.possibleFill).not.toBe(MAP_COLORS.datasetFill);
    expect(MAP_COLORS.possibleLine).not.toBe(MAP_COLORS.questionDividerLine);
    expect(MAP_COLORS.possibleLine).not.toBe(MAP_COLORS.transitLine);
  });

  it("ensures transit and imported datasets have distinct colors", () => {
    // Issue #6 regression check: Datasets must be distinguishable from transit lines
    expect(MAP_COLORS.datasetLine).not.toBe(MAP_COLORS.transitLine);
    expect(MAP_COLORS.datasetFill).not.toBe(MAP_COLORS.transitLine);
  });

  it("ensures interaction point A and point B are visually distinct", () => {
    expect(MAP_COLORS.pointStartA).not.toBe(MAP_COLORS.pointEndB);
  });

  it("ensures seeker markers and user GPS have distinct styling", () => {
    expect(MAP_COLORS.seekerMarkerFill).not.toBe(MAP_COLORS.localGpsFill);
    expect(MAP_COLORS.seekerMarkerFill).not.toBe(MAP_COLORS.pointStartA);
  });
});

describe("createGameAreaLayers", () => {
  it("draws the fixed game boundary above the Possible Area", () => {
    const layerIds = createGameAreaLayers().map((layer) => layer.id);

    expect(layerIds).toEqual(["boundary-fill", "possible-fill", "possible-line", "boundary-line"]);
    expect(layerIds.indexOf("boundary-line")).toBeGreaterThan(layerIds.indexOf("possible-line"));
  });
});

describe("MAP_LEGEND_SECTIONS", () => {
  it("contains all required categories and documentation", () => {
    const sectionIds = MAP_LEGEND_SECTIONS.map((s) => s.id);
    expect(sectionIds).toContain("boundaries");
    expect(sectionIds).toContain("questions");
    expect(sectionIds).toContain("transit-datasets");
    expect(sectionIds).toContain("markers-navigation");
  });

  it("every legend item has a label, description, and valid swatch configuration", () => {
    for (const section of MAP_LEGEND_SECTIONS) {
      expect(section.title.length).toBeGreaterThan(0);
      expect(section.items.length).toBeGreaterThan(0);

      for (const item of section.items) {
        expect(item.id.length).toBeGreaterThan(0);
        expect(item.label.length).toBeGreaterThan(0);
        expect(item.description.length).toBeGreaterThan(0);
        expect(["area", "line", "point"]).toContain(item.type);

        if (item.type === "area") {
          expect(item.swatch.fill).toBeDefined();
          expect(item.swatch.stroke).toBeDefined();
        } else if (item.type === "line") {
          expect(item.swatch.stroke).toBeDefined();
        } else if (item.type === "point") {
          expect(item.swatch.pointFill).toBeDefined();
          expect(item.swatch.pointStroke).toBeDefined();
        }
      }
    }
  });

  it("covers key map features including possible area, decision boundary, and GPS", () => {
    const allItemIds = MAP_LEGEND_SECTIONS.flatMap((s) => s.items.map((i) => i.id));
    expect(allItemIds).toContain("possible-area");
    expect(allItemIds).toContain("game-boundary");
    expect(allItemIds).toContain("active-question");
    expect(allItemIds).toContain("decision-boundary");
    expect(allItemIds).toContain("question-scope");
    expect(allItemIds).toContain("point-a");
    expect(allItemIds).toContain("point-b");
    expect(allItemIds).toContain("transit-lines");
    expect(allItemIds).toContain("transit-stations");
    expect(allItemIds).toContain("datasets");
    expect(allItemIds).toContain("seeker-markers");
    expect(allItemIds).toContain("measurement");
    expect(allItemIds).toContain("my-location");
  });
});

describe("processQuestionFeatures", () => {
  const searchArea: AreaFeature = turf.polygon([
    [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
      [0, 0],
    ],
  ]);

  it("clips question polygon to the active search area so eliminated territory is not filled", () => {
    // Question polygon extending from 5 to 15 (half inside, half outside search area [0..10])
    const questionPoly = turf.polygon(
      [
        [
          [5, 0],
          [15, 0],
          [15, 10],
          [5, 10],
          [5, 0],
        ],
      ],
      { artifactRole: "answer-region", selected: true },
    ) as MapFeature;

    const processed = processQuestionFeatures([questionPoly], searchArea);

    const scopeLine = processed.find((f) => f.properties?.artifactRole === "question-scope");
    expect(scopeLine).toBeDefined();

    const polygonFeatures = processed.filter(
      (f) => f.geometry.type === "Polygon" || f.geometry.type === "MultiPolygon",
    );
    expect(polygonFeatures.length).toBe(1);

    const clipped = polygonFeatures[0];
    expect(clipped).toBeDefined();
    if (!clipped) {
      throw new Error("Expected clipped polygon to be defined");
    }
    expect(clipped.properties?.artifactRole).toBe("answer-region");

    // The clipped polygon must not extend past x = 10 (the search area boundary)
    const bbox = turf.bbox(clipped);
    expect(bbox[0]).toBeCloseTo(5);
    expect(bbox[2]).toBeCloseTo(10); // clipped at 10, not extending to 15!

    // Clipped boundary line is generated for line layers to render styled perimeters
    const clippedLines = processed.filter(
      (f) =>
        (f.geometry.type === "LineString" || f.geometry.type === "MultiLineString") &&
        f.properties?.artifactRole !== "question-scope",
    );
    expect(clippedLines.length).toBeGreaterThan(0);
    expect(clippedLines[0]?.properties?.artifactRole).toBe("answer-region");
  });

  it("drops polygon fill entirely if the question does not overlap the search area", () => {
    // Question polygon completely outside search area [0..10]
    const outsidePoly = turf.polygon(
      [
        [
          [20, 20],
          [30, 20],
          [30, 30],
          [20, 30],
          [20, 20],
        ],
      ],
      { artifactRole: "candidate-region" },
    ) as MapFeature;

    const processed = processQuestionFeatures([outsidePoly], searchArea);

    // No polygon features should remain (no misleading fill)
    const polygonFeatures = processed.filter(
      (f) => f.geometry.type === "Polygon" || f.geometry.type === "MultiPolygon",
    );
    expect(polygonFeatures.length).toBe(0);

    // But the scope line is still available for geometric orientation
    const scopeLine = processed.find((f) => f.properties?.artifactRole === "question-scope");
    expect(scopeLine).toBeDefined();
  });

  it("passes non-polygon features (lines, points) through unmodified", () => {
    const point = turf.point([5, 5], { artifactRole: "point-a" }) as MapFeature;
    const line = turf.lineString(
      [
        [0, 5],
        [10, 5],
      ],
      { artifactRole: "decision-boundary" },
    ) as MapFeature;

    const processed = processQuestionFeatures([point, line], searchArea);
    expect(processed).toEqual([point, line]);
  });
});

describe("filterVisibleQuestions", () => {
  const mockVisualization = turf.polygon([
    [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
      [0, 0],
    ],
  ]) as MapFeature;

  const appliedQuestion: QuestionInstance = {
    id: "q-applied",
    definitionId: "radar.standard",
    category: "RADAR",
    displayName: "Radar 1",
    status: "APPLIED",
    parameters: {},
    answer: "OUTSIDE",
    visualization: mockVisualization,
    effect: null,
    enabled: true,
    askedByPlayerId: "p1",
    askedByName: "Seeker",
    usageNumber: 1,
    cost: 1,
    askedAt: new Date().toISOString(),
    answeredAt: new Date().toISOString(),
    appliedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const pendingQuestion: QuestionInstance = {
    id: "q-pending",
    definitionId: "thermometer.standard",
    category: "THERMOMETER",
    displayName: "Thermometer 1",
    status: "PENDING",
    parameters: {},
    answer: null,
    visualization: mockVisualization,
    effect: null,
    enabled: true,
    askedByPlayerId: "p1",
    askedByName: "Seeker",
    usageNumber: 1,
    cost: 1,
    askedAt: new Date().toISOString(),
    answeredAt: null,
    appliedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const answeredQuestion: QuestionInstance = {
    id: "q-answered",
    definitionId: "matching.first-division",
    category: "MATCHING",
    displayName: "Division 1",
    status: "ANSWERED",
    parameters: {},
    answer: "SAME",
    visualization: mockVisualization,
    effect: null,
    enabled: true,
    askedByPlayerId: "p1",
    askedByName: "Seeker",
    usageNumber: 1,
    cost: 1,
    askedAt: new Date().toISOString(),
    answeredAt: new Date().toISOString(),
    appliedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  it("excludes APPLIED questions when no question is selected, preventing stale overlays on the hiding zone", () => {
    const questions = [appliedQuestion, pendingQuestion, answeredQuestion];
    const visible = filterVisibleQuestions(questions, null);

    // Only active (PENDING or ANSWERED) questions should be in the question layer
    expect(visible.map((q) => q.id)).toEqual(["q-pending", "q-answered"]);
    expect(visible.some((q) => q.id === "q-applied")).toBe(false);
  });

  it("excludes disabled questions or questions without visualization even if active", () => {
    const disabledPending: QuestionInstance = {
      ...pendingQuestion,
      id: "q-disabled",
      enabled: false,
    };
    const noVisPending: QuestionInstance = {
      ...pendingQuestion,
      id: "q-novis",
      visualization: null,
    };

    const visible = filterVisibleQuestions([disabledPending, noVisPending], null);
    expect(visible).toEqual([]);
  });

  it("includes an APPLIED question when explicitly selected (e.g. inspected from history)", () => {
    const questions = [appliedQuestion, pendingQuestion];
    const visible = filterVisibleQuestions(questions, "q-applied");

    expect(visible.map((q) => q.id)).toEqual(["q-applied"]);
  });

  it("only includes the selected question when a specific question is selected", () => {
    const questions = [appliedQuestion, pendingQuestion, answeredQuestion];
    const visible = filterVisibleQuestions(questions, "q-pending");

    expect(visible.map((q) => q.id)).toEqual(["q-pending"]);
  });
});

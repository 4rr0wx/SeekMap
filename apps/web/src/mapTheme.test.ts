import { describe, expect, it } from "vitest";
import { MAP_COLORS, MAP_LEGEND_SECTIONS } from "./mapTheme";

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

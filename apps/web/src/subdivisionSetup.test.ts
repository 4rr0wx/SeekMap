import { describe, expect, it } from "vitest";
import { explainSubdivisionLoadFailure, subdivisionDiscoveryView } from "./subdivisionSetup";

describe("subdivisionDiscoveryView", () => {
  it("selects the first loaded admin level and allows restoring First Division", () => {
    expect(
      subdivisionDiscoveryView({
        kind: "loaded",
        levels: [
          { adminLevel: 6, count: 2, examples: ["North", "South"] },
          { adminLevel: 8, count: 4, examples: [] },
        ],
      }),
    ).toEqual({
      divisionLevel: 6,
      candidates: [
        { adminLevel: 6, count: 2, examples: ["North", "South"] },
        { adminLevel: 8, count: 4, examples: [] },
      ],
      summary: "2 areas: North, South",
      status: "2 areas: North, South",
      banner: null,
      failed: false,
      disableFirstDivision: false,
      restoreFirstDivision: true,
    });
  });

  it("disables First Division when no child areas exist so Create Game stays available", () => {
    expect(subdivisionDiscoveryView({ kind: "loaded", levels: [] })).toMatchObject({
      divisionLevel: "",
      candidates: [],
      summary: "No child areas found",
      banner: expect.stringContaining("No child areas found"),
      failed: false,
      disableFirstDivision: true,
      restoreFirstDivision: false,
    });
  });

  it("disables First Division on Overpass failures and explains the outage", () => {
    expect(
      subdivisionDiscoveryView({
        kind: "error",
        message: "OpenStreetMap service returned 504",
      }),
    ).toMatchObject({
      divisionLevel: "",
      candidates: [],
      summary: "OpenStreetMap Overpass is unavailable",
      failed: true,
      disableFirstDivision: true,
      restoreFirstDivision: false,
      status: expect.stringContaining("temporarily overloaded"),
      banner: expect.stringContaining("Overpass is temporarily unavailable"),
    });
  });
});

describe("explainSubdivisionLoadFailure", () => {
  it("maps Overpass capacity errors to an actionable banner", () => {
    expect(explainSubdivisionLoadFailure("OpenStreetMap service is unavailable")).toMatchObject({
      summary: "OpenStreetMap Overpass is unavailable",
      banner: expect.stringContaining("temporarily unavailable"),
    });
  });
});

import { describe, expect, it } from "vitest";
import { subdivisionDiscoveryView } from "./subdivisionSetup";

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
      failed: false,
      disableFirstDivision: true,
      restoreFirstDivision: false,
    });
  });

  it("disables First Division on Overpass failures and keeps the API error visible", () => {
    expect(
      subdivisionDiscoveryView({
        kind: "error",
        message: "OpenStreetMap service returned 504",
      }),
    ).toMatchObject({
      divisionLevel: "",
      candidates: [],
      summary: "OpenStreetMap service returned 504",
      failed: true,
      disableFirstDivision: true,
      restoreFirstDivision: false,
      status: expect.stringContaining("OpenStreetMap service returned 504"),
    });
  });
});

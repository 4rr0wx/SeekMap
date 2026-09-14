import { describe, expect, it } from "vitest";
import { calculateQuestionCost, createGameSchema, deriveTimer, formatDuration } from "./index";

describe("question costs", () => {
  it("tracks linear repeat cost by stable usage number", () => {
    expect(calculateQuestionCost(1, 1, { type: "LINEAR", increment: 2 })).toBe(1);
    expect(calculateQuestionCost(1, 3, { type: "LINEAR", increment: 2 })).toBe(5);
  });

  it("supports multiplier and flat repeat rules", () => {
    expect(calculateQuestionCost(2, 3, { type: "MULTIPLIER", multiplier: 2 })).toBe(8);
    expect(calculateQuestionCost(2, 9, { type: "FLAT" })).toBe(2);
  });
});

describe("server-derived timers", () => {
  it("transitions hiding to seeking using the authoritative timestamp", () => {
    const timer = deriveTimer(
      "HIDING",
      30,
      "2026-01-01T00:00:00.000Z",
      new Date("2026-01-01T00:00:42.000Z"),
    );
    expect(timer.phase).toBe("SEEKING");
    expect(timer.transitionAt).toBe("2026-01-01T00:00:30.000Z");
    expect(timer.elapsedSeekingSeconds).toBe(12);
  });

  it("formats short and long durations", () => {
    expect(formatDuration(61)).toBe("01:01");
    expect(formatDuration(3661)).toBe("01:01:01");
  });
});

describe("createGameSchema", () => {
  const basePayload = {
    name: "Test Game",
    hidingDurationMinutes: 30,
    hiderAssistance: true,
    osm: {
      osmType: "relation" as const,
      osmId: "123",
      displayName: "City",
      boundingBox: [0, 0, 1, 1] as [number, number, number, number],
    },
    boundary: {
      type: "Feature" as const,
      geometry: {
        type: "Polygon" as const,
        coordinates: [
          [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 1],
            [0, 0],
          ],
        ],
      },
      properties: {},
    },
    firstDivisionAdminLevel: null,
  };

  it("defaults seekerOnly to false", () => {
    const parsed = createGameSchema.parse(basePayload);
    expect(parsed.seekerOnly).toBe(false);
  });

  it("accepts seekerOnly: true", () => {
    const parsed = createGameSchema.parse({ ...basePayload, seekerOnly: true });
    expect(parsed.seekerOnly).toBe(true);
  });
});

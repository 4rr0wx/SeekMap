export interface SubdivisionLevelInfo {
  adminLevel: number;
  count: number;
  examples: string[];
}

export type SubdivisionDiscoveryInput =
  { kind: "loaded"; levels: SubdivisionLevelInfo[] } | { kind: "error"; message?: string };

export interface SubdivisionDiscoveryView {
  divisionLevel: number | "";
  candidates: SubdivisionLevelInfo[];
  /** Short label for the disabled First Division input when no select is shown. */
  summary: string;
  /** Longer explanation shown under the field. */
  status: string;
  failed: boolean;
  /** When true, First Division should be turned off so Create Game stays available. */
  disableFirstDivision: boolean;
  /** When true and First Division was auto-disabled earlier, turn it back on. */
  restoreFirstDivision: boolean;
}

export function describeSubdivisionLevel(level: SubdivisionLevelInfo): string {
  if (level.examples.length === 0) {
    return `${level.count} areas (OSM level ${level.adminLevel})`;
  }
  const suffix = level.count > level.examples.length ? ", …" : "";
  return `${level.count} areas: ${level.examples.join(", ")}${suffix}`;
}

/** Normalize subdivision-level lookup results for the new-game form. */
export function subdivisionDiscoveryView(
  input: SubdivisionDiscoveryInput,
): SubdivisionDiscoveryView {
  if (input.kind === "loaded" && input.levels[0]) {
    const status = describeSubdivisionLevel(input.levels[0]);
    return {
      divisionLevel: input.levels[0].adminLevel,
      candidates: input.levels,
      summary: status,
      status,
      failed: false,
      disableFirstDivision: false,
      restoreFirstDivision: true,
    };
  }

  if (input.kind === "loaded") {
    return {
      divisionLevel: "",
      candidates: [],
      summary: "No child areas found",
      status:
        "No child areas found. First Division was disabled — choose another area or continue without it.",
      failed: false,
      disableFirstDivision: true,
      restoreFirstDivision: false,
    };
  }

  const detail = input.message?.trim();
  return {
    divisionLevel: "",
    candidates: [],
    summary: detail || "Could not load child areas",
    status: detail
      ? `${detail} First Division was disabled so you can still create the game. Retry when Overpass is available.`
      : "Could not load child areas. First Division was disabled so you can still create the game. Retry when Overpass is available.",
    failed: true,
    disableFirstDivision: true,
    restoreFirstDivision: false,
  };
}

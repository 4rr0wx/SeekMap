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
  /** Prominent toast/banner copy; null when no user-facing error should be raised. */
  banner: string | null;
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

function looksLikeOverpassOutage(message: string): boolean {
  return /openstreetmap|overpass|timed out|unavailable|could not complete|returned (406|408|425|429|500|502|503|504)/i.test(
    message,
  );
}

/** Turn raw API errors into setup copy that explains why First Division was disabled. */
export function explainSubdivisionLoadFailure(message?: string): {
  summary: string;
  status: string;
  banner: string;
} {
  const detail = message?.trim();
  if (detail && looksLikeOverpassOutage(detail)) {
    return {
      summary: "OpenStreetMap Overpass is unavailable",
      status: `${detail} First Division needs Overpass to list child districts. That public service is temporarily overloaded or unreachable — not a problem with your area choice. First Division was turned off so you can still create the game. Use Retry when Overpass recovers.`,
      banner:
        "First Division could not load because OpenStreetMap Overpass is temporarily unavailable. The question was disabled so you can still create the game.",
    };
  }
  if (detail) {
    return {
      summary: "Could not load child areas",
      status: `${detail} First Division was turned off so you can still create the game. Retry or choose another area.`,
      banner: `First Division could not load (${detail}). The question was disabled so you can still create the game.`,
    };
  }
  return {
    summary: "Could not load child areas",
    status:
      "First Division could not load child areas from OpenStreetMap. The question was turned off so you can still create the game. Retry when the service recovers.",
    banner:
      "First Division could not load child areas from OpenStreetMap. The question was disabled so you can still create the game.",
  };
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
      banner: null,
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
        "No child areas found for this boundary. First Division was disabled — choose another area or continue without it.",
      banner:
        "No child areas found for this boundary. First Division was disabled so you can still create the game.",
      failed: false,
      disableFirstDivision: true,
      restoreFirstDivision: false,
    };
  }

  const explained = explainSubdivisionLoadFailure(input.message);
  return {
    divisionLevel: "",
    candidates: [],
    summary: explained.summary,
    status: explained.status,
    banner: explained.banner,
    failed: true,
    disableFirstDivision: true,
    restoreFirstDivision: false,
  };
}

import type { GameState, PublicConfig, ReusableDataset, SearchAreaResult } from "@hideseek/shared";

const IDENTITY_KEY = "hideseek-atlas.identity";

export interface Identity {
  playerId: string;
  token: string;
}

export function loadIdentity(): Identity | null {
  try {
    return JSON.parse(localStorage.getItem(IDENTITY_KEY) ?? "null") as Identity | null;
  } catch {
    return null;
  }
}

export function saveIdentity(identity: Identity | null): void {
  if (identity) localStorage.setItem(IDENTITY_KEY, JSON.stringify(identity));
  else localStorage.removeItem(IDENTITY_KEY);
}

export async function api<T>(path: string, init: RequestInit = {}, token?: string): Promise<T> {
  const headers = new Headers(init.headers);
  if (!(init.body instanceof FormData)) headers.set("Content-Type", "application/json");
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const response = await fetch(path, { ...init, headers });
  const body = (await response.json().catch(() => ({}))) as { error?: string } & T;
  if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status})`);
  return body;
}

export const currentGame = (token?: string) =>
  api<
    | GameState
    | {
        hasGame: boolean;
        game: null | {
          id: string;
          name: string;
          phase: string;
          lifecycle: string;
          hiderAssistance: boolean;
        };
      }
  >("/api/game/current", {}, token);
export const publicConfig = () => api<PublicConfig>("/api/config");
export const loadDatasetLibrary = () =>
  api<{ datasets: ReusableDataset[] }>("/api/dataset-library");
export const searchAreas = (query: string) =>
  api<{ results: SearchAreaResult[] }>("/api/osm/search", {
    method: "POST",
    body: JSON.stringify({ query }),
  });
export interface SubdivisionLevel {
  adminLevel: number;
  count: number;
  examples: string[];
}
export const discoverSubdivisionLevels = (area: SearchAreaResult) =>
  api<{ levels: SubdivisionLevel[] }>("/api/osm/subdivision-levels", {
    method: "POST",
    body: JSON.stringify({
      osmType: area.osm.osmType,
      osmId: area.osm.osmId,
      parentAdminLevel: area.adminLevel,
    }),
  });

export function post<T>(path: string, body: unknown, token?: string): Promise<T> {
  return api<T>(path, { method: "POST", body: JSON.stringify(body) }, token);
}

export function patch<T>(path: string, body: unknown, token?: string): Promise<T> {
  return api<T>(path, { method: "PATCH", body: JSON.stringify(body) }, token);
}

export function remove<T>(path: string, token?: string): Promise<T> {
  return api<T>(path, { method: "DELETE" }, token);
}

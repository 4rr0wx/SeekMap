import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as turf from "@turf/turf";
import { afterEach, describe, expect, it } from "vitest";
import { combineBoundaries, type AreaFeature, type GameState } from "@hideseek/shared";
import { buildApp, type BuiltApp } from "./app";
import { loadConfig } from "./config";
import { openDatabase, type DatabaseBundle } from "./db/database";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

async function fixture(path?: string, environment: NodeJS.ProcessEnv = {}) {
  const directory = path ?? mkdtempSync(join(tmpdir(), "hideseek-atlas-test-"));
  const config = loadConfig({
    DATA_DIR: directory,
    WEB_ROOT: join(directory, "missing-web"),
    ...environment,
  });
  const database = openDatabase(config.databasePath);
  const built = await buildApp(config, database);
  cleanups.push(async () => {
    built.stopTimer();
    built.io.close();
    await built.app.close();
    if (database.sqlite.open) database.sqlite.close();
    if (!path) rmSync(directory, { recursive: true, force: true });
  });
  return { directory, config, database, ...built };
}

const boundary = turf.polygon([
  [
    [16.2, 48.1],
    [16.6, 48.1],
    [16.6, 48.35],
    [16.2, 48.35],
    [16.2, 48.1],
  ],
]);

async function createAndJoin(app: BuiltApp["app"], assistance = true) {
  const created = await app.inject({
    method: "POST",
    url: "/api/games",
    payload: {
      name: "Vienna test",
      hidingDurationMinutes: 30,
      hiderAssistance: assistance,
      osm: {
        osmType: "relation",
        osmId: "109166",
        displayName: "Vienna",
        boundingBox: [16.2, 48.1, 16.6, 48.35],
      },
      boundary,
      firstDivisionAdminLevel: 10,
    },
  });
  expect(created.statusCode).toBe(201);
  const seeker = await app.inject({
    method: "POST",
    url: "/api/game/join",
    payload: { displayName: "Seek", role: "SEEKER" },
  });
  const hider = await app.inject({
    method: "POST",
    url: "/api/game/join",
    payload: { displayName: "Hide", role: "HIDER" },
  });
  return {
    seeker: seeker.json<{ token: string; playerId: string }>(),
    hider: hider.json<{ token: string; playerId: string }>(),
  };
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

function multipart(fields: Record<string, string>, filename: string, content: string) {
  const boundaryValue = "hideseek-test-boundary";
  const chunks = Object.entries(fields).map(
    ([name, value]) =>
      `--${boundaryValue}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
  );
  chunks.push(
    `--${boundaryValue}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/vnd.google-earth.kml+xml\r\n\r\n${content}\r\n--${boundaryValue}--\r\n`,
  );
  return {
    body: chunks.join(""),
    contentType: `multipart/form-data; boundary=${boundaryValue}`,
  };
}

const pointKml = (name: string, longitude: number) => `<?xml version="1.0"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark><name>${name}</name>
<Point><coordinates>${longitude},48.2</coordinates></Point></Placemark></Document></kml>`;

describe("server game integrity", () => {
  it("allows same-origin geolocation in the browser permissions policy", async () => {
    const { app } = await fixture();
    const response = await app.inject({ method: "GET", url: "/api/health" });
    expect(response.headers["permissions-policy"]).toBe("geolocation=(self)");
  });

  it("sets Cache-Control no-store on api routes to prevent stale client state", async () => {
    const { app } = await fixture();
    const response = await app.inject({ method: "GET", url: "/api/health" });
    expect(response.headers["cache-control"]).toContain("no-store");
  });

  it("compresses full game snapshots", async () => {
    const { app } = await fixture();
    const { seeker } = await createAndJoin(app);
    const response = await app.inject({
      method: "GET",
      url: "/api/game/current",
      headers: { ...auth(seeker.token), "accept-encoding": "gzip" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-encoding"]).toBe("gzip");
  });

  it("preserves Fastify client-error status codes", async () => {
    const { app } = await fixture();
    const response = await app.inject({
      method: "DELETE",
      url: "/api/game",
      headers: { "content-type": "application/json" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: string }>().error).toContain("Body cannot be empty");
  });

  it("lets a Seeker discard an unstarted lobby setup but not a running game", async () => {
    const first = await fixture();
    const { seeker } = await createAndJoin(first.app);
    const discarded = await first.app.inject({
      method: "DELETE",
      url: "/api/game",
      headers: auth(seeker.token),
    });
    expect(discarded.statusCode).toBe(200);
    expect((await first.app.inject({ method: "GET", url: "/api/game/current" })).json()).toEqual({
      hasGame: false,
      game: null,
    });

    const second = await fixture();
    const joined = await createAndJoin(second.app);
    await second.app.inject({
      method: "POST",
      url: "/api/game/start",
      headers: auth(joined.seeker.token),
    });
    const rejected = await second.app.inject({
      method: "DELETE",
      url: "/api/game",
      headers: auth(joined.seeker.token),
    });
    expect(rejected.statusCode).toBe(409);
  });

  it("reuses optional library datasets in a later game", async () => {
    const { app } = await fixture();
    const upload = multipart({}, "Museums.kml", pointKml("Museum", 16.3));
    const uploaded = await app.inject({
      method: "POST",
      url: "/api/dataset-library",
      headers: { "content-type": upload.contentType },
      payload: upload.body,
    });
    expect(uploaded.statusCode).toBe(201);
    const libraryId = uploaded.json<{ id: string }>().id;

    const create = () =>
      app.inject({
        method: "POST",
        url: "/api/games",
        payload: {
          name: "Dataset game",
          hidingDurationMinutes: 30,
          hiderAssistance: true,
          osm: {
            osmType: "relation",
            osmId: "109166",
            displayName: "Vienna",
            boundingBox: [16.2, 48.1, 16.6, 48.35],
          },
          boundary,
          firstDivisionAdminLevel: null,
          datasetLibraryIds: [libraryId],
        },
      });

    expect((await create()).statusCode).toBe(201);
    const firstJoin = await app.inject({
      method: "POST",
      url: "/api/game/join",
      payload: { displayName: "Seek", role: "SEEKER" },
    });
    const firstToken = firstJoin.json<{ token: string }>().token;
    const firstState = (
      await app.inject({ method: "GET", url: "/api/game/current", headers: auth(firstToken) })
    ).json<GameState>();
    expect(firstState.datasets.map((item) => item.name)).toEqual(["Museums"]);

    await app.inject({ method: "POST", url: "/api/game/end", headers: auth(firstToken) });
    expect(
      (await app.inject({ method: "DELETE", url: "/api/game", headers: auth(firstToken) }))
        .statusCode,
    ).toBe(200);
    const library = await app.inject({ method: "GET", url: "/api/dataset-library" });
    expect(library.json<{ datasets: Array<{ id: string }> }>().datasets[0]?.id).toBe(libraryId);

    expect((await create()).statusCode).toBe(201);
    const secondJoin = await app.inject({
      method: "POST",
      url: "/api/game/join",
      payload: { displayName: "Seek again", role: "SEEKER" },
    });
    const secondToken = secondJoin.json<{ token: string }>().token;
    const secondState = (
      await app.inject({ method: "GET", url: "/api/game/current", headers: auth(secondToken) })
    ).json<GameState>();
    expect(secondState.datasets[0]?.geojson.features[0]?.properties?.name).toBe("Museum");
  });

  it("rejects KML files above the configured in-memory upload limit", async () => {
    const { app } = await fixture(undefined, { MAX_KML_BYTES: "128" });
    const { seeker } = await createAndJoin(app);
    const oversized = multipart(
      { name: "Too large", category: "OTHER" },
      "large.kml",
      pointKml("x".repeat(300), 16.3),
    );
    const response = await app.inject({
      method: "POST",
      url: "/api/datasets",
      headers: { ...auth(seeker.token), "content-type": oversized.contentType },
      payload: oversized.body,
    });
    expect(response.statusCode).toBe(413);
    expect(response.json<{ error: string }>().error).toMatch(/128 byte limit/i);
  });

  it("persists per-game question availability and base costs", async () => {
    const { app } = await fixture();
    const created = await app.inject({
      method: "POST",
      url: "/api/games",
      payload: {
        name: "Configured",
        hidingDurationMinutes: 10,
        hiderAssistance: false,
        osm: {
          osmType: "relation",
          osmId: "1",
          displayName: "Test",
          boundingBox: [16.2, 48.1, 16.6, 48.35],
        },
        boundary,
        firstDivisionAdminLevel: null,
        questionConfigs: [{ definitionId: "radar.standard", enabled: false, baseCost: 7 }],
      },
    });
    expect(created.statusCode).toBe(201);
    const joined = await app.inject({
      method: "POST",
      url: "/api/game/join",
      payload: { displayName: "Seek", role: "SEEKER" },
    });
    const state = (
      await app.inject({
        method: "GET",
        url: "/api/game/current",
        headers: auth(joined.json<{ token: string }>().token),
      })
    ).json<GameState>();
    expect(state.questionConfigs.find((item) => item.definitionId === "radar.standard")).toEqual({
      definitionId: "radar.standard",
      enabled: false,
      baseCost: 7,
      repeatRule: { type: "LINEAR", increment: 1 },
    });
    expect(state.game.transitModes).toEqual(["train", "light_rail", "subway", "tram"]);
  });

  it("uploads and explicitly replaces a normalized KML dataset", async () => {
    const { app } = await fixture();
    const { seeker } = await createAndJoin(app);
    const original = multipart(
      { name: "Test places", category: "TENTACLES" },
      "places.kml",
      pointKml("West", 16.3),
    );
    const uploaded = await app.inject({
      method: "POST",
      url: "/api/datasets",
      headers: { ...auth(seeker.token), "content-type": original.contentType },
      payload: original.body,
    });
    expect(uploaded.statusCode).toBe(201);
    const id = uploaded.json<{ id: string }>().id;
    const replacement = multipart({}, "replacement.kml", pointKml("East", 16.5));
    const replaced = await app.inject({
      method: "PUT",
      url: `/api/datasets/${id}/content`,
      headers: { ...auth(seeker.token), "content-type": replacement.contentType },
      payload: replacement.body,
    });
    expect(replaced.statusCode).toBe(200);
    const state = (
      await app.inject({ method: "GET", url: "/api/game/current", headers: auth(seeker.token) })
    ).json<GameState>();
    expect(state.datasets[0]?.originalFilename).toBe("replacement.kml");
    expect(state.datasets[0]?.geojson.features[0]?.properties?.name).toBe("East");
  });

  it("runs a dataset Matching question with visible place metadata and an area effect", async () => {
    const { app } = await fixture();
    const { seeker, hider } = await createAndJoin(app);
    const golfKml = `<?xml version="1.0"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document>
<Placemark><name>West Golf Club</name><Point><coordinates>16.27,48.2</coordinates></Point></Placemark>
<Placemark><name>East Golf Club</name><Point><coordinates>16.53,48.2</coordinates></Point></Placemark>
</Document></kml>`;
    const upload = multipart(
      { name: "Golf Courses", category: "MATCHING" },
      "golf-courses.kml",
      golfKml,
    );
    const uploaded = await app.inject({
      method: "POST",
      url: "/api/datasets",
      headers: { ...auth(seeker.token), "content-type": upload.contentType },
      payload: upload.body,
    });
    expect(uploaded.statusCode).toBe(201);
    const datasetId = uploaded.json<{ id: string }>().id;
    const draft = await app.inject({
      method: "POST",
      url: "/api/questions",
      headers: auth(seeker.token),
      payload: {
        definitionId: "matching.dataset",
        parameters: { referencePoint: [16.26, 48.2], datasetId },
      },
    });
    expect(draft.statusCode).toBe(201);
    const questionId = draft.json<{ id: string }>().id;
    await app.inject({
      method: "POST",
      url: `/api/questions/${questionId}/ask`,
      headers: auth(seeker.token),
      payload: {},
    });
    const hiderState = (
      await app.inject({ method: "GET", url: "/api/game/current", headers: auth(hider.token) })
    ).json<GameState>();
    expect(hiderState.datasets.find((item) => item.id === datasetId)?.name).toBe("Golf Courses");
    expect(hiderState.questions[0]?.parameters).toEqual({
      referencePoint: [16.26, 48.2],
      datasetId,
    });
    expect(JSON.stringify(hiderState)).not.toContain("hiderLocation");

    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/questions/${questionId}/answer`,
          headers: auth(hider.token),
          payload: { answer: "SAME" },
        })
      ).statusCode,
    ).toBe(200);
    const answered = (
      await app.inject({ method: "GET", url: "/api/game/current", headers: auth(seeker.token) })
    ).json<GameState>();
    expect(answered.questions[0]?.visualization?.type).toBe("FeatureCollection");
    expect(
      answered.questions[0]?.visualization?.type === "FeatureCollection" &&
        answered.questions[0].visualization.features.some(
          (feature) => feature.properties?.artifactRole === "answer-region",
        ),
    ).toBe(true);
    const originalArea = turf.area(answered.game.possibleArea!);
    await app.inject({
      method: "POST",
      url: `/api/questions/${questionId}/apply`,
      headers: auth(seeker.token),
      payload: {},
    });
    const applied = (
      await app.inject({ method: "GET", url: "/api/game/current", headers: auth(seeker.token) })
    ).json<GameState>();
    expect(turf.area(applied.game.possibleArea!)).toBeLessThan(originalArea);
  });

  it("runs a Tentacles question with candidate places and applies an area effect", async () => {
    const { app } = await fixture();
    const { seeker, hider } = await createAndJoin(app);
    const zooKml = `<?xml version="1.0"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document>
<Placemark><name>Tiergarten Schönbrunn</name><Point><coordinates>16.30,48.18</coordinates></Point></Placemark>
<Placemark><name>Haus des Meeres</name><Point><coordinates>16.35,48.20</coordinates></Point></Placemark>
<Placemark><name>Faraway Zoo</name><Point><coordinates>16.55,48.25</coordinates></Point></Placemark>
</Document></kml>`;
    const upload = multipart(
      { name: "Zoos and Aquariums", category: "TENTACLES" },
      "zoos.kml",
      zooKml,
    );
    const uploaded = await app.inject({
      method: "POST",
      url: "/api/datasets",
      headers: { ...auth(seeker.token), "content-type": upload.contentType },
      payload: upload.body,
    });
    expect(uploaded.statusCode).toBe(201);
    const datasetId = uploaded.json<{ id: string }>().id;

    const draft = await app.inject({
      method: "POST",
      url: "/api/questions",
      headers: auth(seeker.token),
      payload: {
        definitionId: "tentacles.dataset",
        parameters: { referencePoint: [16.32, 48.19], radiusMeters: 5_000, datasetId },
      },
    });
    expect(draft.statusCode).toBe(201);
    const questionId = draft.json<{ id: string }>().id;

    await app.inject({
      method: "POST",
      url: `/api/questions/${questionId}/ask`,
      headers: auth(seeker.token),
      payload: {},
    });

    const answerRes = await app.inject({
      method: "POST",
      url: `/api/questions/${questionId}/answer`,
      headers: auth(hider.token),
      payload: { answer: "place:0" },
    });
    expect(answerRes.statusCode).toBe(200);

    const answered = (
      await app.inject({ method: "GET", url: "/api/game/current", headers: auth(seeker.token) })
    ).json<GameState>();
    expect(answered.questions[0]?.status).toBe("ANSWERED");
    expect(answered.questions[0]?.answer).toBe("place:0");

    const originalArea = turf.area(answered.game.possibleArea!);
    await app.inject({
      method: "POST",
      url: `/api/questions/${questionId}/apply`,
      headers: auth(seeker.token),
      payload: {},
    });

    const applied = (
      await app.inject({ method: "GET", url: "/api/game/current", headers: auth(seeker.token) })
    ).json<GameState>();
    expect(applied.questions[0]?.status).toBe("APPLIED");
    expect(turf.area(applied.game.possibleArea!)).toBeLessThan(originalArea);
  });

  it("hides drafts from Hiders and tracks repeat usage costs", async () => {
    const { app } = await fixture();
    const { seeker, hider } = await createAndJoin(app, true);
    const createDraft = () =>
      app.inject({
        method: "POST",
        url: "/api/questions",
        headers: auth(seeker.token),
        payload: {
          definitionId: "radar.standard",
          parameters: { center: [16.4, 48.2], radiusMeters: 1000 },
        },
      });
    const first = (await createDraft()).json<{ id: string }>();
    let hiderState = (
      await app.inject({ method: "GET", url: "/api/game/current", headers: auth(hider.token) })
    ).json<GameState>();
    expect(hiderState.questions).toHaveLength(0);
    await app.inject({
      method: "POST",
      url: `/api/questions/${first.id}/ask`,
      headers: auth(seeker.token),
      payload: {},
    });
    hiderState = (
      await app.inject({ method: "GET", url: "/api/game/current", headers: auth(hider.token) })
    ).json<GameState>();
    expect(hiderState.questions).toHaveLength(1);

    const second = (await createDraft()).json<{ id: string }>();
    await app.inject({
      method: "POST",
      url: `/api/questions/${second.id}/ask`,
      headers: auth(seeker.token),
      payload: {},
    });
    const seekerState = (
      await app.inject({ method: "GET", url: "/api/game/current", headers: auth(seeker.token) })
    ).json<GameState>();
    expect(seekerState.questions.find((question) => question.id === first.id)?.usageNumber).toBe(1);
    expect(seekerState.questions.find((question) => question.id === second.id)?.usageNumber).toBe(
      2,
    );
    expect(seekerState.questions.find((question) => question.id === second.id)?.cost).toBe(2);
  });

  it("keeps Seeker markers out of the Hider API view", async () => {
    const { app } = await fixture();
    const { seeker, hider } = await createAndJoin(app);
    const marker = await app.inject({
      method: "POST",
      url: "/api/markers",
      headers: auth(seeker.token),
      payload: { position: turf.point([16.4, 48.2]), title: "Check west", note: "Private" },
    });
    expect(marker.statusCode).toBe(201);
    const seekerState = (
      await app.inject({ method: "GET", url: "/api/game/current", headers: auth(seeker.token) })
    ).json<GameState>();
    const hiderResponse = await app.inject({
      method: "GET",
      url: "/api/game/current",
      headers: auth(hider.token),
    });
    const hiderState = hiderResponse.json<GameState>();
    expect(seekerState.seekerMarkers).toHaveLength(1);
    expect(hiderState).not.toHaveProperty("seekerMarkers");
    expect(hiderResponse.body).not.toContain("Check west");
  });

  it("rejects Hider location data and never includes a Hider location in shared state", async () => {
    const { app } = await fixture();
    const { seeker, hider } = await createAndJoin(app, true);
    const draft = await app.inject({
      method: "POST",
      url: "/api/questions",
      headers: auth(seeker.token),
      payload: {
        definitionId: "radar.standard",
        parameters: { center: [16.4, 48.2], radiusMeters: 1000 },
      },
    });
    const id = draft.json<{ id: string }>().id;
    await app.inject({
      method: "POST",
      url: `/api/questions/${id}/ask`,
      headers: auth(seeker.token),
      payload: {},
    });
    const badAnswer = await app.inject({
      method: "POST",
      url: `/api/questions/${id}/answer`,
      headers: auth(hider.token),
      payload: { answer: "INSIDE", coordinates: [16.41, 48.21] },
    });
    expect(badAnswer.statusCode).toBe(400);
    const stateResponse = await app.inject({
      method: "GET",
      url: "/api/game/current",
      headers: auth(hider.token),
    });
    const state = stateResponse.json<GameState>();
    expect(stateResponse.body.toLowerCase()).not.toContain("hiderlocation");
    expect(state.questions[0]?.answer).toBeNull();
    expect(state.questions[0]?.parameters).toEqual({ center: [16.4, 48.2], radiusMeters: 1000 });
  });

  it("runs the Radar lifecycle and reconstructs Possible Area after deletion", async () => {
    const { app } = await fixture();
    const { seeker, hider } = await createAndJoin(app, true);
    const originalArea = turf.area(boundary);
    const draft = await app.inject({
      method: "POST",
      url: "/api/questions",
      headers: auth(seeker.token),
      payload: {
        definitionId: "radar.standard",
        parameters: { center: [16.4, 48.2], radiusMeters: 5000 },
      },
    });
    const id = draft.json<{ id: string }>().id;
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/questions/${id}/ask`,
          headers: auth(seeker.token),
          payload: {},
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/questions/${id}/answer`,
          headers: auth(hider.token),
          payload: { answer: "INSIDE" },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/questions/${id}/apply`,
          headers: auth(seeker.token),
          payload: {},
        })
      ).statusCode,
    ).toBe(200);
    const applied = (
      await app.inject({ method: "GET", url: "/api/game/current", headers: auth(seeker.token) })
    ).json<GameState>();
    expect(applied.questions[0]?.status).toBe("APPLIED");
    expect(turf.area(applied.game.possibleArea!)).toBeLessThan(originalArea);
    const corrected = await app.inject({
      method: "PATCH",
      url: `/api/questions/${id}/answer`,
      headers: auth(seeker.token),
      payload: { answer: "OUTSIDE" },
    });
    expect(corrected.statusCode).toBe(200);
    const afterCorrection = (
      await app.inject({ method: "GET", url: "/api/game/current", headers: auth(seeker.token) })
    ).json<GameState>();
    expect(turf.area(afterCorrection.game.possibleArea!)).toBeGreaterThan(
      turf.area(applied.game.possibleArea!),
    );
    const edited = await app.inject({
      method: "PATCH",
      url: `/api/questions/${id}`,
      headers: auth(seeker.token),
      payload: { parameters: { center: [16.25, 48.15], radiusMeters: 1000 } },
    });
    expect(edited.statusCode).toBe(200);
    const afterEdit = (
      await app.inject({ method: "GET", url: "/api/game/current", headers: auth(seeker.token) })
    ).json<GameState>();
    expect(turf.area(afterEdit.game.possibleArea!)).not.toBeCloseTo(
      turf.area(afterCorrection.game.possibleArea!),
      2,
    );
    await app.inject({
      method: "DELETE",
      url: `/api/questions/${id}`,
      headers: auth(seeker.token),
    });
    const removed = (
      await app.inject({ method: "GET", url: "/api/game/current", headers: auth(seeker.token) })
    ).json<GameState>();
    expect(removed.questions).toHaveLength(0);
    expect(turf.area(removed.game.possibleArea!)).toBeCloseTo(originalArea, 2);
  });

  it("runs the Thermometer lifecycle and accurately aligns Possible Area with midpoint", async () => {
    const { app } = await fixture();
    const { seeker, hider } = await createAndJoin(app, true);
    const start: [number, number] = [16.37, 48.208];
    const end: [number, number] = [16.385, 48.206];
    const draft = await app.inject({
      method: "POST",
      url: "/api/questions",
      headers: auth(seeker.token),
      payload: {
        definitionId: "thermometer.standard",
        parameters: { start, end },
      },
    });
    const id = draft.json<{ id: string }>().id;
    await app.inject({
      method: "POST",
      url: `/api/questions/${id}/ask`,
      headers: auth(seeker.token),
      payload: {},
    });
    await app.inject({
      method: "POST",
      url: `/api/questions/${id}/answer`,
      headers: auth(hider.token),
      payload: { answer: "HOTTER" },
    });
    await app.inject({
      method: "POST",
      url: `/api/questions/${id}/apply`,
      headers: auth(seeker.token),
      payload: {},
    });
    const state = (
      await app.inject({ method: "GET", url: "/api/game/current", headers: auth(seeker.token) })
    ).json<GameState>();
    expect(state.questions[0]?.status).toBe("APPLIED");
    const possibleArea = state.game.possibleArea;
    expect(possibleArea).not.toBeNull();
    expect(turf.booleanPointInPolygon(turf.point(end), possibleArea!)).toBe(true);
    expect(turf.booleanPointInPolygon(turf.point(start), possibleArea!)).toBe(false);

    // Verify distance from midpoint to possibleArea boundary is sub-meter
    const mid: [number, number] = [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2];
    const boundaryLine = turf.polygonToLine(possibleArea as any);
    const dist = turf.pointToLineDistance(turf.point(mid), boundaryLine as any, {
      units: "meters",
    });
    expect(dist).toBeLessThan(1);
  });

  it("persists the active game and player session across a database restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "hideseek-atlas-persist-"));
    const first = await fixture(directory);
    const { seeker } = await createAndJoin(first.app);
    first.stopTimer();
    first.io.close();
    await first.app.close();
    first.database.sqlite.close();
    cleanups.pop();

    const config = loadConfig({ DATA_DIR: directory, WEB_ROOT: join(directory, "missing-web") });
    const database: DatabaseBundle = openDatabase(config.databasePath);
    const second = await buildApp(config, database);
    cleanups.push(async () => {
      second.stopTimer();
      second.io.close();
      await second.app.close();
      database.sqlite.close();
      rmSync(directory, { recursive: true, force: true });
    });
    const restored = await second.app.inject({
      method: "GET",
      url: "/api/game/current",
      headers: auth(seeker.token),
    });
    expect(restored.statusCode).toBe(200);
    expect(restored.json<GameState>().game.name).toBe("Vienna test");
  });

  it("transitions HIDING to SEEKING from persisted server timestamps", async () => {
    const { app, store, database } = await fixture();
    const { seeker } = await createAndJoin(app);
    await app.inject({
      method: "POST",
      url: "/api/game/start",
      headers: auth(seeker.token),
      payload: {},
    });
    database.sqlite
      .prepare("UPDATE games SET phase_started_at = ? WHERE phase = 'HIDING'")
      .run(new Date(Date.now() - 31 * 60 * 1000).toISOString());
    expect(store.transitionTimer()).toBe(true);
    const state = (
      await app.inject({ method: "GET", url: "/api/game/current", headers: auth(seeker.token) })
    ).json<GameState>();
    expect(state.game.phase).toBe("SEEKING");
  });

  it("creates a game with a composite boundary from multiple added and subtracted locations", async () => {
    const { app } = await fixture();

    const areaA = turf.polygon([
      [
        [16.2, 48.1],
        [16.4, 48.1],
        [16.4, 48.3],
        [16.2, 48.3],
        [16.2, 48.1],
      ],
    ]) as AreaFeature;

    const areaB = turf.polygon([
      [
        [16.35, 48.1],
        [16.55, 48.1],
        [16.55, 48.3],
        [16.35, 48.3],
        [16.35, 48.1],
      ],
    ]) as AreaFeature;

    const excludedArea = turf.polygon([
      [
        [16.25, 48.15],
        [16.35, 48.15],
        [16.35, 48.25],
        [16.25, 48.25],
        [16.25, 48.15],
      ],
    ]) as AreaFeature;

    const compositeBoundary = combineBoundaries([
      { mode: "ADD", boundary: areaA },
      { mode: "ADD", boundary: areaB },
      { mode: "SUBTRACT", boundary: excludedArea },
    ]);
    expect(compositeBoundary).not.toBeNull();

    const bbox = turf.bbox(compositeBoundary!);
    const created = await app.inject({
      method: "POST",
      url: "/api/games",
      payload: {
        name: "Multi-Boundary Test Game",
        hidingDurationMinutes: 45,
        hiderAssistance: true,
        osm: {
          osmType: "relation",
          osmId: "109166",
          displayName: "Vienna (+District B, -Excluded Center)",
          boundingBox: [bbox[0], bbox[1], bbox[2], bbox[3]],
        },
        boundary: compositeBoundary,
        firstDivisionAdminLevel: null,
      },
    });
    expect(created.statusCode).toBe(201);

    const joinRes = await app.inject({
      method: "POST",
      url: "/api/game/join",
      payload: { displayName: "Lead Seeker", role: "SEEKER" },
    });
    const seekerToken = joinRes.json<{ token: string }>().token;

    const stateRes = await app.inject({
      method: "GET",
      url: "/api/game/current",
      headers: auth(seekerToken),
    });
    expect(stateRes.statusCode).toBe(200);
    const state = stateRes.json<GameState>();
    expect(state.game.name).toBe("Multi-Boundary Test Game");
    expect(state.game.boundary).toEqual(compositeBoundary);
    expect(state.game.possibleArea).toEqual(compositeBoundary);

    // Point in areaA outside excluded area must be inside
    expect(turf.booleanPointInPolygon(turf.point([16.22, 48.12]), state.game.possibleArea!)).toBe(
      true,
    );
    // Point in areaB outside excluded area must be inside
    expect(turf.booleanPointInPolygon(turf.point([16.5, 48.2]), state.game.possibleArea!)).toBe(
      true,
    );
    // Point inside excluded area must NOT be inside play area
    expect(turf.booleanPointInPolygon(turf.point([16.3, 48.2]), state.game.possibleArea!)).toBe(
      false,
    );
  });
});

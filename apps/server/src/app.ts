import { existsSync } from "node:fs";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import { Server as SocketServer } from "socket.io";
import { z, ZodError } from "zod";
import {
  answerQuestionSchema,
  createGameSchema,
  createQuestionSchema,
  datasetCategorySchema,
  joinGameSchema,
  markerInputSchema,
  updateQuestionSchema,
} from "@hideseek/shared";
import type { AppConfig } from "./config.js";
import type { DatabaseBundle } from "./db/database.js";
import { parseKmlUpload } from "./services/kml.js";
import { OsmService } from "./services/osm.js";
import { DomainError, GameStore } from "./store.js";

function bearer(request: FastifyRequest): string | undefined {
  const value = request.headers.authorization;
  return value?.startsWith("Bearer ") ? value.slice(7) : undefined;
}

const idParams = z.object({ id: z.string().uuid() });
const datasetUpdateSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  category: datasetCategorySchema.optional(),
});
const markerUpdateSchema = markerInputSchema.partial();

export interface BuiltApp {
  app: FastifyInstance;
  io: SocketServer;
  store: GameStore;
  stopTimer: () => void;
}

export async function buildApp(config: AppConfig, database: DatabaseBundle): Promise<BuiltApp> {
  const app = Fastify({
    logger:
      process.env.NODE_ENV === "test"
        ? false
        : { level: process.env.LOG_LEVEL ?? "info", redact: ["req.headers.authorization"] },
    trustProxy: true,
    bodyLimit: Math.max(config.maxUploadBytes, 1_048_576),
  });
  await app.register(cors, { origin: true, credentials: false });
  await app.register(multipart, {
    limits: { files: 1, fileSize: config.maxUploadBytes, fields: 4, parts: 5 },
  });

  const store = new GameStore(database);
  const osm = new OsmService(database.db, config);
  const io = new SocketServer(app.server, {
    cors: { origin: true },
    transports: ["websocket", "polling"],
  });
  const broadcast = () => io.emit("state:changed", { at: new Date().toISOString() });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof DomainError)
      return reply.code(error.statusCode).send({ error: error.message });
    if (error instanceof ZodError)
      return reply.code(400).send({ error: "Invalid request", issues: error.issues });
    if ((error as { code?: string }).code === "FST_REQ_FILE_TOO_LARGE") {
      return reply
        .code(413)
        .send({ error: `KML/KMZ file exceeds the ${config.maxUploadBytes} byte limit` });
    }
    app.log.error(error);
    return reply.code(500).send({
      error: error instanceof Error ? error.message : "Unexpected server error",
    });
  });

  app.get("/api/health", async () => ({
    status: "ok",
    database: "ready",
    now: new Date().toISOString(),
  }));

  app.get("/api/dataset-library", async () => ({ datasets: store.listDatasetLibrary() }));
  app.post("/api/dataset-library", async (request, reply) => {
    const part = await request.file();
    if (!part) throw new DomainError("A KML or KMZ file is required");
    const originalFilename = part.filename.slice(0, 255);
    const fallbackName = originalFilename.replace(/\.(kml|kmz)$/i, "").trim();
    const name = z.string().min(1).max(100).parse(fallbackName);
    const geojson = parseKmlUpload(await part.toBuffer(), originalFilename);
    const id = store.saveDatasetLibrary({ name, originalFilename, geojson });
    return reply.code(201).send({ id, featureCount: geojson.features.length });
  });
  app.delete("/api/dataset-library/:id", async (request) => {
    const { id } = idParams.parse(request.params);
    store.deleteDatasetLibrary(id);
    return { ok: true };
  });
  app.get("/api/config", async () => ({
    tileUrl: config.tileUrl,
    tileAttribution: config.tileAttribution,
    maxUploadBytes: config.maxUploadBytes,
  }));
  app.get("/api/game/current", async (request) => {
    const token = bearer(request);
    return token ? store.getState(token) : store.currentSummary();
  });

  app.post("/api/games", async (request, reply) => {
    const input = createGameSchema.parse(request.body);
    const id = store.createGame(input);
    broadcast();
    return reply.code(201).send({ id });
  });
  app.post("/api/game/join", async (request, reply) => {
    const input = joinGameSchema.parse(request.body);
    const identity = store.join(input.displayName, input.role);
    broadcast();
    return reply.code(201).send(identity);
  });
  app.post("/api/game/start", async (request) => {
    store.startGame(bearer(request));
    broadcast();
    return { ok: true };
  });
  app.post("/api/game/end", async (request) => {
    store.endGame(bearer(request));
    broadcast();
    return { ok: true };
  });
  app.delete("/api/game", async (request) => {
    store.resetGame(bearer(request));
    broadcast();
    return { ok: true };
  });

  app.post("/api/osm/search", async (request) => {
    const input = z.object({ query: z.string() }).parse(request.body);
    return { results: await osm.searchAreas(input.query) };
  });
  app.post("/api/osm/subdivision-levels", async (request) => {
    const input = z
      .object({
        osmType: z.enum(["relation", "way"]),
        osmId: z.string().min(1).max(40),
        parentAdminLevel: z.number().int().min(2).max(12).nullable(),
      })
      .parse(request.body);
    return {
      levels: await osm.subdivisionLevels(input.osmType, input.osmId, input.parentAdminLevel),
    };
  });
  app.post("/api/game/subdivisions", async (request) => {
    const token = bearer(request);
    const player = store.requireSeeker(token);
    const input = z.object({ adminLevel: z.number().int().min(2).max(12) }).parse(request.body);
    const state = store.getState(token);
    const data = await osm.subdivisions(
      state.game.osm.osmType,
      state.game.osm.osmId,
      input.adminLevel,
    );
    store.saveSubdivisions(token, input.adminLevel, data);
    broadcast();
    return { count: data.features.length, requestedBy: player.id };
  });
  app.post("/api/game/transit", async (request) => {
    const token = bearer(request);
    store.requireSeeker(token);
    const state = store.getState(token);
    const data = await osm.transit(state.game.osm.boundingBox, state.game.transitModes);
    store.saveTransit(token, data);
    broadcast();
    return { lines: data.lines.features.length, stations: data.stations.features.length };
  });

  app.post("/api/questions", async (request, reply) => {
    const input = createQuestionSchema.parse(request.body);
    const id = store.createQuestion(bearer(request), input.definitionId, input.parameters);
    broadcast();
    return reply.code(201).send({ id });
  });
  app.patch("/api/questions/:id", async (request) => {
    const { id } = idParams.parse(request.params);
    const input = updateQuestionSchema.parse(request.body);
    store.updateQuestion(bearer(request), id, input);
    broadcast();
    return { ok: true };
  });
  app.post("/api/questions/:id/ask", async (request) => {
    const { id } = idParams.parse(request.params);
    store.askQuestion(bearer(request), id);
    broadcast();
    return { ok: true };
  });
  app.post("/api/questions/:id/answer", async (request) => {
    const { id } = idParams.parse(request.params);
    const input = answerQuestionSchema.parse(request.body);
    store.answerQuestion(bearer(request), id, input.answer);
    broadcast();
    return { ok: true };
  });
  app.patch("/api/questions/:id/answer", async (request) => {
    const { id } = idParams.parse(request.params);
    const input = answerQuestionSchema.parse(request.body);
    store.reviseQuestionAnswer(bearer(request), id, input.answer);
    broadcast();
    return { ok: true };
  });
  app.post("/api/questions/:id/apply", async (request) => {
    const { id } = idParams.parse(request.params);
    store.applyQuestion(bearer(request), id);
    broadcast();
    return { ok: true };
  });
  app.delete("/api/questions/:id", async (request) => {
    const { id } = idParams.parse(request.params);
    store.deleteQuestion(bearer(request), id);
    broadcast();
    return { ok: true };
  });

  app.post("/api/datasets", async (request, reply) => {
    const token = bearer(request);
    store.requireSeeker(token);
    let file: { filename: string; buffer: Buffer } | null = null;
    let name = "";
    let category = "OTHER";
    for await (const part of request.parts()) {
      if (part.type === "file") {
        if (file) throw new DomainError("Upload one KML or KMZ file at a time");
        const buffer = await part.toBuffer();
        file = { filename: part.filename.slice(0, 255), buffer };
      } else if (part.fieldname === "name") name = String(part.value);
      else if (part.fieldname === "category") category = String(part.value);
    }
    if (!file) throw new DomainError("A KML or KMZ file is required");
    const parsedName = z.string().trim().min(1).max(100).parse(name);
    const parsedCategory = datasetCategorySchema.parse(category);
    const geojson = parseKmlUpload(file.buffer, file.filename);
    const id = store.addDataset(token, {
      name: parsedName,
      category: parsedCategory,
      originalFilename: file.filename,
      geojson,
    });
    broadcast();
    return reply.code(201).send({ id, featureCount: geojson.features.length });
  });
  app.patch("/api/datasets/:id", async (request) => {
    const { id } = idParams.parse(request.params);
    store.updateDataset(bearer(request), id, datasetUpdateSchema.parse(request.body));
    broadcast();
    return { ok: true };
  });
  app.put("/api/datasets/:id/content", async (request) => {
    const token = bearer(request);
    const { id } = idParams.parse(request.params);
    store.requireSeeker(token);
    const part = await request.file();
    if (!part) throw new DomainError("A replacement KML or KMZ file is required");
    const buffer = await part.toBuffer();
    const geojson = parseKmlUpload(buffer, part.filename);
    store.replaceDataset(token, id, {
      originalFilename: part.filename.slice(0, 255),
      geojson,
    });
    broadcast();
    return { ok: true, featureCount: geojson.features.length };
  });
  app.delete("/api/datasets/:id", async (request) => {
    const { id } = idParams.parse(request.params);
    store.deleteDataset(bearer(request), id);
    broadcast();
    return { ok: true };
  });

  app.post("/api/markers", async (request, reply) => {
    const input = markerInputSchema.parse(request.body);
    const id = store.addMarker(bearer(request), input);
    broadcast();
    return reply.code(201).send({ id });
  });
  app.patch("/api/markers/:id", async (request) => {
    const { id } = idParams.parse(request.params);
    store.updateMarker(bearer(request), id, markerUpdateSchema.parse(request.body));
    broadcast();
    return { ok: true };
  });
  app.delete("/api/markers/:id", async (request) => {
    const { id } = idParams.parse(request.params);
    store.deleteMarker(bearer(request), id);
    broadcast();
    return { ok: true };
  });

  io.use((socket, next) => {
    try {
      const token =
        typeof socket.handshake.auth.token === "string" ? socket.handshake.auth.token : undefined;
      const player = store.authenticate(token);
      socket.data.playerId = player.id;
      socket.data.gameId = player.gameId;
      next();
    } catch {
      next(new Error("Invalid player session"));
    }
  });
  io.on("connection", (socket) => {
    store.setConnected(socket.data.playerId, true);
    socket.join(socket.data.gameId);
    broadcast();
    socket.on("disconnect", () => {
      store.setConnected(socket.data.playerId, false);
      broadcast();
    });
  });

  if (existsSync(config.webRoot)) {
    await app.register(fastifyStatic, { root: config.webRoot, wildcard: false });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/") || request.url.startsWith("/socket.io/")) {
        return reply.code(404).send({ error: "Not found" });
      }
      return reply.sendFile("index.html");
    });
  }

  const timer = setInterval(() => {
    if (store.transitionTimer()) broadcast();
  }, 1_000);
  timer.unref();

  return { app, io, store, stopTimer: () => clearInterval(timer) };
}

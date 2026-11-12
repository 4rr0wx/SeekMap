import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, asc, count, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import {
  buildQuestionArtifacts,
  calculateQuestionCost,
  defaultQuestionConfigs,
  deriveTimer,
  getQuestionDefinition,
  recomputePossibleArea,
  type AreaFeature,
  type DatasetCategory,
  type GameConfig,
  type GameState,
  type GeometryEffect,
  type MapFeatureCollection,
  type OsmLayer,
  type OsmLayerStatus,
  type OsmLoadState,
  type Player,
  type PlayerRole,
  type QuestionConfig,
  type QuestionInstance,
  type ReusableDataset,
  type SeekerMarker,
  type SeekerLocation,
  SEEKER_LOCATION_TTL_MS,
  type TransitMode,
  type UploadedDataset,
} from "@hideseek/shared";
import type {
  FeatureCollection,
  LineString,
  MultiLineString,
  Point,
  Polygon,
  MultiPolygon,
} from "geojson";
import type { DatabaseBundle } from "./db/database.js";
import {
  datasetLibrary,
  datasets,
  games,
  players,
  questionConfigs,
  questions,
  seekerMarkers,
} from "./db/schema.js";

export class DomainError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
  }
}

const now = () => new Date().toISOString();
const encode = (value: unknown) => JSON.stringify(value);
const decode = <T>(value: string | null): T | null => (value ? (JSON.parse(value) as T) : null);
const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

type GameRow = typeof games.$inferSelect;
type PlayerRow = typeof players.$inferSelect;

export class GameStore {
  private readonly db: DatabaseBundle["db"];
  private readonly seekerLocations = new Map<string, SeekerLocation & { gameId: string }>();

  constructor(private readonly bundle: DatabaseBundle) {
    this.db = bundle.db;
    this.db.update(players).set({ connectionCount: 0 }).run();
    this.adoptExistingDatasets();
    for (const game of this.db.select().from(games).all()) {
      const statuses = this.osmLoadState(game);
      for (const layer of ["subdivisions", "transit", "pois"] as const) {
        if (statuses[layer].status === "LOADING") {
          this.setOsmLayerStatus(game.id, layer, "ERROR", "Loading was interrupted. Please retry.");
        }
      }
    }
  }

  private currentRow(): GameRow | null {
    return this.db.select().from(games).orderBy(desc(games.createdAt)).limit(1).get() ?? null;
  }

  private adoptExistingDatasets(): void {
    const unlinked = this.db
      .select()
      .from(datasets)
      .where(and(isNull(datasets.sourceLibraryId), eq(datasets.temporary, false)))
      .all();
    for (const item of unlinked) {
      const libraryId = this.saveDatasetLibrary({
        name: item.name,
        originalFilename: item.originalFilename,
        geojson: JSON.parse(item.geojson) as MapFeatureCollection,
      });
      this.db
        .update(datasets)
        .set({ sourceLibraryId: libraryId })
        .where(eq(datasets.id, item.id))
        .run();
    }
  }

  listDatasetLibrary(): ReusableDataset[] {
    return this.db
      .select()
      .from(datasetLibrary)
      .orderBy(asc(datasetLibrary.name))
      .all()
      .map(({ id, name, originalFilename, featureCount, createdAt, updatedAt }) => ({
        id,
        name,
        originalFilename,
        featureCount,
        createdAt,
        updatedAt,
      }));
  }

  saveDatasetLibrary(input: {
    name: string;
    originalFilename: string;
    geojson: MapFeatureCollection;
  }): string {
    const encoded = encode(input.geojson);
    const contentHash = createHash("sha256").update(encoded).digest("hex");
    const existing = this.db
      .select()
      .from(datasetLibrary)
      .where(eq(datasetLibrary.contentHash, contentHash))
      .get();
    const timestamp = now();
    if (existing) {
      this.db
        .update(datasetLibrary)
        .set({
          name: input.name,
          originalFilename: input.originalFilename,
          updatedAt: timestamp,
        })
        .where(eq(datasetLibrary.id, existing.id))
        .run();
      return existing.id;
    }
    const id = randomUUID();
    this.db
      .insert(datasetLibrary)
      .values({
        id,
        name: input.name,
        originalFilename: input.originalFilename,
        contentHash,
        geojson: encoded,
        featureCount: input.geojson.features.length,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .run();
    return id;
  }

  deleteDatasetLibrary(id: string): void {
    this.db
      .update(datasets)
      .set({ sourceLibraryId: null })
      .where(eq(datasets.sourceLibraryId, id))
      .run();
    this.db.delete(datasetLibrary).where(eq(datasetLibrary.id, id)).run();
  }

  currentSummary() {
    const game = this.currentRow();
    return game
      ? {
          hasGame: true as const,
          game: {
            id: game.id,
            name: game.name,
            lifecycle: game.lifecycle,
            phase: game.phase,
            hiderAssistance: game.hiderAssistance,
            seekerOnly: Boolean(game.seekerOnly),
          },
        }
      : { hasGame: false as const, game: null };
  }

  createGame(input: {
    name: string;
    hidingDurationMinutes: number;
    hiderAssistance: boolean;
    seekerOnly?: boolean | undefined;
    osm: {
      osmType: "relation" | "way";
      osmId: string;
      displayName: string;
      boundingBox: [number, number, number, number];
    };
    boundary: AreaFeature;
    firstDivisionAdminLevel: number | null;
    transitModes: TransitMode[];
    questionConfigs?:
      Array<{ definitionId: string; enabled: boolean; baseCost: number }> | undefined;
    datasetLibraryIds?: string[] | undefined;
  }): string {
    if (this.currentRow())
      throw new DomainError("Clear the current game before creating a new one", 409);
    const id = randomUUID();
    const timestamp = now();
    this.db.transaction((tx) => {
      tx.insert(games)
        .values({
          id,
          name: input.name,
          lifecycle: "ACTIVE",
          phase: "LOBBY",
          hidingDurationSeconds: input.hidingDurationMinutes * 60,
          phaseStartedAt: null,
          pausedAt: null,
          endedAt: null,
          hiderAssistance: input.seekerOnly ? false : input.hiderAssistance,
          seekerOnly: input.seekerOnly ?? false,
          osmType: input.osm.osmType,
          osmId: input.osm.osmId,
          osmDisplayName: input.osm.displayName,
          osmBoundingBoxJson: encode(input.osm.boundingBox),
          boundaryGeojson: encode(input.boundary),
          possibleAreaGeojson: encode(input.boundary),
          firstDivisionAdminLevel: input.firstDivisionAdminLevel,
          subdivisionsGeojson: null,
          transitLinesGeojson: null,
          transitStationsGeojson: null,
          transitModesJson: encode(input.transitModes),
          revision: 1,
          createdAt: timestamp,
          updatedAt: timestamp,
        })
        .run();
      const configured = new Map(
        input.questionConfigs?.map((config) => [config.definitionId, config]),
      );
      tx.insert(questionConfigs)
        .values(
          defaultQuestionConfigs().map((config) => ({
            gameId: id,
            definitionId: config.definitionId,
            enabled: configured.get(config.definitionId)?.enabled ?? config.enabled,
            baseCost: configured.get(config.definitionId)?.baseCost ?? config.baseCost,
            repeatRuleJson: encode(config.repeatRule),
            configJson: null,
          })),
        )
        .run();
      const reusable = input.datasetLibraryIds?.length
        ? tx
            .select()
            .from(datasetLibrary)
            .where(inArray(datasetLibrary.id, input.datasetLibraryIds))
            .all()
        : [];
      if (reusable.length > 0) {
        tx.insert(datasets)
          .values(
            reusable.map((item) => ({
              id: randomUUID(),
              gameId: id,
              sourceLibraryId: item.id,
              temporary: false,
              name: item.name,
              category: "OTHER",
              originalFilename: item.originalFilename,
              geojson: item.geojson,
              featureCount: item.featureCount,
              createdAt: timestamp,
              updatedAt: timestamp,
            })),
          )
          .run();
      }
    });
    return id;
  }

  join(displayName: string, role: PlayerRole): { playerId: string; token: string } {
    const game = this.currentRow();
    if (!game || game.lifecycle !== "ACTIVE")
      throw new DomainError("There is no active game to join", 409);
    if (game.seekerOnly && role === "HIDER")
      throw new DomainError("This game is in Seeker-only mode", 400);
    const token = randomBytes(32).toString("base64url");
    const id = randomUUID();
    const timestamp = now();
    this.db
      .insert(players)
      .values({
        id,
        gameId: game.id,
        displayName,
        role,
        tokenHash: hashToken(token),
        connectionCount: 0,
        lastSeenAt: timestamp,
        createdAt: timestamp,
      })
      .run();
    this.bump(game.id);
    return { playerId: id, token };
  }

  authenticate(token: string | undefined): PlayerRow {
    if (!token) throw new DomainError("Join the game on this device first", 401);
    const player = this.db
      .select()
      .from(players)
      .where(eq(players.tokenHash, hashToken(token)))
      .get();
    const game = this.currentRow();
    if (!player || !game || player.gameId !== game.id)
      throw new DomainError("Player session is no longer valid", 401);
    this.db.update(players).set({ lastSeenAt: now() }).where(eq(players.id, player.id)).run();
    return player;
  }

  requireSeeker(token: string | undefined): PlayerRow {
    const player = this.authenticate(token);
    if (player.role !== "SEEKER")
      throw new DomainError("This action is available to Seekers only", 403);
    return player;
  }

  updateSeekerLocation(
    token: string | undefined,
    input: { position: [number, number]; accuracyMeters?: number | undefined },
  ): void {
    const player = this.requireSeeker(token);
    const game = this.currentRow();
    if (!game || game.phase === "ENDED")
      throw new DomainError("Location sharing is only available in an active game", 409);
    const previous = this.seekerLocations.get(player.id);
    if (previous && Date.now() - Date.parse(previous.updatedAt) < 5_000) {
      throw new DomainError("Please wait before updating your shared location again", 429);
    }
    this.seekerLocations.set(player.id, {
      gameId: player.gameId,
      playerId: player.id,
      displayName: player.displayName,
      position: input.position,
      accuracyMeters: input.accuracyMeters ?? null,
      updatedAt: now(),
    });
  }

  clearSeekerLocation(token: string | undefined): void {
    const player = this.requireSeeker(token);
    this.seekerLocations.delete(player.id);
  }

  expireSeekerLocations(): void {
    for (const [id, location] of this.seekerLocations) {
      if (Date.now() - Date.parse(location.updatedAt) >= SEEKER_LOCATION_TTL_MS)
        this.seekerLocations.delete(id);
    }
  }

  getSeekerLocations(token: string | undefined): SeekerLocation[] {
    const player = this.authenticate(token);
    const game = this.currentRow();
    if (!game || game.phase === "ENDED") return [];
    this.expireSeekerLocations();
    const result: SeekerLocation[] = [];
    for (const [id, location] of this.seekerLocations) {
      if (
        location.gameId !== player.gameId ||
        Date.now() - Date.parse(location.updatedAt) >= SEEKER_LOCATION_TTL_MS
      ) {
        this.seekerLocations.delete(id);
        continue;
      }
      result.push({
        playerId: location.playerId,
        displayName: location.displayName,
        position: location.position,
        accuracyMeters: location.accuracyMeters,
        updatedAt: location.updatedAt,
      });
    }
    return result;
  }

  private osmLoadState(row: GameRow): OsmLoadState {
    const saved = decode<Partial<OsmLoadState>>(row.osmLoadStateJson) ?? {};
    return {
      pois: saved.pois ?? { status: "IDLE", error: null },
      subdivisions: saved.subdivisions ?? {
        status: row.subdivisionsGeojson ? "LOADED" : "IDLE",
        error: null,
      },
      transit: saved.transit ?? {
        status: row.transitLinesGeojson ? "LOADED" : "IDLE",
        error: null,
      },
    };
  }

  setOsmLayerStatus(
    gameId: string,
    layer: OsmLayer,
    status: OsmLayerStatus["status"],
    error: string | null = null,
  ): boolean {
    const game = this.currentRow();
    if (!game || game.id !== gameId) return false;
    const states = this.osmLoadState(game);
    states[layer] = { status, error };
    this.db
      .update(games)
      .set({ osmLoadStateJson: encode(states), revision: game.revision + 1, updatedAt: now() })
      .where(eq(games.id, gameId))
      .run();
    return true;
  }

  private mapGame(row: GameRow): GameConfig {
    return {
      id: row.id,
      name: row.name,
      lifecycle: row.lifecycle as GameConfig["lifecycle"],
      phase: row.phase as GameConfig["phase"],
      hidingDurationSeconds: row.hidingDurationSeconds,
      phaseStartedAt: row.phaseStartedAt,
      pausedAt: row.pausedAt,
      endedAt: row.endedAt,
      hiderAssistance: row.hiderAssistance,
      seekerOnly: Boolean(row.seekerOnly),
      osm: {
        osmType: row.osmType as "relation" | "way",
        osmId: row.osmId,
        displayName: row.osmDisplayName,
        boundingBox: decode<[number, number, number, number]>(row.osmBoundingBoxJson)!,
      },
      boundary: decode<AreaFeature>(row.boundaryGeojson)!,
      possibleArea: decode<AreaFeature>(row.possibleAreaGeojson),
      firstDivisionAdminLevel: row.firstDivisionAdminLevel,
      subdivisions: decode<FeatureCollection<Polygon | MultiPolygon>>(row.subdivisionsGeojson),
      transitLines: decode<FeatureCollection<LineString | MultiLineString>>(
        row.transitLinesGeojson,
      ),
      transitStations: decode<FeatureCollection<Point>>(row.transitStationsGeojson),
      transitModes: decode<TransitMode[]>(row.transitModesJson)!,
      osmLoadState: this.osmLoadState(row),
      revision: row.revision,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private mapPlayer(row: PlayerRow): Player {
    return {
      id: row.id,
      displayName: row.displayName,
      role: row.role as PlayerRole,
      connected: row.connectionCount > 0,
      lastSeenAt: row.lastSeenAt,
    };
  }

  getState(token: string | undefined): GameState {
    const meRow = this.authenticate(token);
    const gameRow = this.currentRow();
    if (!gameRow) throw new DomainError("No current game", 404);
    const playerRows = this.db
      .select()
      .from(players)
      .where(eq(players.gameId, gameRow.id))
      .orderBy(asc(players.createdAt))
      .all();
    const playerById = new Map(playerRows.map((player) => [player.id, player]));
    const configs: QuestionConfig[] = this.db
      .select()
      .from(questionConfigs)
      .where(eq(questionConfigs.gameId, gameRow.id))
      .all()
      .map((row) => ({
        definitionId: row.definitionId,
        enabled: row.enabled,
        baseCost: row.baseCost,
        repeatRule: decode<QuestionConfig["repeatRule"]>(row.repeatRuleJson)!,
      }));
    const questionRows = this.db
      .select()
      .from(questions)
      .where(eq(questions.gameId, gameRow.id))
      .orderBy(desc(questions.createdAt))
      .all();
    const questionItems: QuestionInstance[] = questionRows.map((row) => ({
      id: row.id,
      definitionId: row.definitionId,
      category: row.category as QuestionInstance["category"],
      displayName: row.displayName,
      status: row.status as QuestionInstance["status"],
      parameters: decode<Record<string, unknown>>(row.parametersJson)!,
      answer: decode<string>(row.answerJson),
      visualization: decode<QuestionInstance["visualization"]>(row.visualizationGeojson),
      effect: decode<GeometryEffect>(row.effectGeojson),
      enabled: row.enabled,
      askedByPlayerId: row.askedByPlayerId,
      askedByName: row.askedByPlayerId
        ? (playerById.get(row.askedByPlayerId)?.displayName ?? null)
        : null,
      usageNumber: row.usageNumber,
      cost: row.cost,
      askedAt: row.askedAt,
      answeredAt: row.answeredAt,
      appliedAt: row.appliedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }));
    const datasetItems: UploadedDataset[] = this.db
      .select()
      .from(datasets)
      .where(eq(datasets.gameId, gameRow.id))
      .orderBy(asc(datasets.createdAt))
      .all()
      .map((row) => ({
        id: row.id,
        name: row.name,
        category: row.category as DatasetCategory,
        temporary: row.temporary,
        originalFilename: row.originalFilename,
        geojson: decode<MapFeatureCollection>(row.geojson)!,
        featureCount: row.featureCount,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      }));
    const visibleQuestions =
      meRow.role === "HIDER"
        ? questionItems.filter(
            (question) =>
              question.status !== "DRAFT" &&
              (gameRow.hiderAssistance || question.status !== "PENDING"),
          )
        : questionItems;
    const state: GameState = {
      game: this.mapGame(gameRow),
      me: this.mapPlayer(meRow),
      players: playerRows.map((row) => this.mapPlayer(row)),
      questionConfigs: configs,
      questions: visibleQuestions,
      datasets: datasetItems,
      serverNow: now(),
    };
    if (meRow.role === "SEEKER") {
      state.seekerMarkers = this.db
        .select()
        .from(seekerMarkers)
        .where(eq(seekerMarkers.gameId, gameRow.id))
        .orderBy(asc(seekerMarkers.createdAt))
        .all()
        .map((row) => ({
          id: row.id,
          createdByPlayerId: row.createdByPlayerId,
          position: decode<SeekerMarker["position"]>(row.positionGeojson)!,
          title: row.title,
          note: row.note,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        }));
    }
    return state;
  }

  private bump(gameId: string): void {
    const game = this.db.select().from(games).where(eq(games.id, gameId)).get();
    if (!game) return;
    this.db
      .update(games)
      .set({ revision: game.revision + 1, updatedAt: now() })
      .where(eq(games.id, gameId))
      .run();
  }

  setConnected(playerId: string, connected: boolean): void {
    const player = this.db.select().from(players).where(eq(players.id, playerId)).get();
    if (!player) return;
    const connectionCount = Math.max(0, player.connectionCount + (connected ? 1 : -1));
    this.db
      .update(players)
      .set({ connectionCount, lastSeenAt: now() })
      .where(eq(players.id, playerId))
      .run();
    this.bump(player.gameId);
  }

  startGame(
    token: string | undefined,
    temporaryDataset?: {
      name: string;
      category: DatasetCategory;
      originalFilename: string;
      geojson: MapFeatureCollection;
    },
  ): void {
    const player = this.requireSeeker(token);
    const timestamp = now();
    this.db.transaction((tx) => {
      const game = tx.select().from(games).where(eq(games.id, player.gameId)).get();
      if (!game) throw new DomainError("No active game", 404);
      if (game.phase !== "LOBBY") throw new DomainError("The game has already started", 409);
      if (temporaryDataset) {
        const existingDataset = tx
          .select({ id: datasets.id })
          .from(datasets)
          .where(eq(datasets.gameId, game.id))
          .limit(1)
          .get();
        if (existingDataset) {
          throw new DomainError(
            "OpenStreetMap POIs can only be loaded when the game has no datasets",
            409,
          );
        }
        tx.insert(datasets)
          .values({
            id: randomUUID(),
            gameId: game.id,
            sourceLibraryId: null,
            temporary: true,
            name: temporaryDataset.name,
            category: temporaryDataset.category,
            originalFilename: temporaryDataset.originalFilename,
            geojson: encode(temporaryDataset.geojson),
            featureCount: temporaryDataset.geojson.features.length,
            createdAt: timestamp,
            updatedAt: timestamp,
          })
          .run();
      }
      tx.update(games)
        .set({
          phase: "HIDING",
          phaseStartedAt: timestamp,
          updatedAt: timestamp,
          revision: game.revision + 1,
        })
        .where(eq(games.id, game.id))
        .run();
    });
  }

  transitionTimer(): boolean {
    const game = this.currentRow();
    if (!game || game.phase !== "HIDING" || !game.phaseStartedAt) return false;
    const timer = deriveTimer("HIDING", game.hidingDurationSeconds, game.phaseStartedAt);
    if (timer.phase !== "SEEKING" || !timer.transitionAt) return false;
    this.db
      .update(games)
      .set({
        phase: "SEEKING",
        phaseStartedAt: timer.transitionAt,
        updatedAt: now(),
        revision: game.revision + 1,
      })
      .where(eq(games.id, game.id))
      .run();
    return true;
  }

  endGame(token: string | undefined): void {
    const player = this.requireSeeker(token);
    const game = this.currentRow();
    if (!game || game.id !== player.gameId) throw new DomainError("No current game", 404);
    if (game.phase === "ENDED") return;
    const timestamp = now();
    this.seekerLocations.clear();
    this.db.transaction((tx) => {
      tx.delete(datasets)
        .where(and(eq(datasets.gameId, game.id), eq(datasets.temporary, true)))
        .run();
      tx.update(games)
        .set({
          phase: "ENDED",
          lifecycle: "ENDED",
          // Seeking never started — keep final seeking duration at zero.
          ...(game.phase === "HIDING" ? { phaseStartedAt: timestamp } : {}),
          endedAt: timestamp,
          updatedAt: timestamp,
          revision: game.revision + 1,
        })
        .where(eq(games.id, game.id))
        .run();
    });
  }

  private requirePlayableGame(gameId: string) {
    const game = this.currentRow();
    if (!game || game.id !== gameId) throw new DomainError("No current game", 404);
    if (game.phase === "ENDED") {
      throw new DomainError("The game has ended; clear it before changing the board", 409);
    }
    return game;
  }

  private buildArtifactsOrThrow(
    definitionId: string,
    parameters: Record<string, unknown>,
    answer: string | null,
    gameId: string,
  ) {
    try {
      return buildQuestionArtifacts(
        definitionId,
        parameters,
        answer,
        this.context(gameId, getQuestionDefinition(definitionId).parameterKind === "DATASET"),
      );
    } catch (cause) {
      throw new DomainError(
        cause instanceof Error ? cause.message : "Could not build question geometry",
        409,
      );
    }
  }

  resetGame(token: string | undefined): void {
    this.requireSeeker(token);
    const game = this.currentRow();
    if (!game || (game.lifecycle !== "ENDED" && game.phase !== "LOBBY"))
      throw new DomainError("Only a lobby setup or ended game can be cleared", 409);
    this.seekerLocations.clear();
    this.db.delete(games).where(eq(games.id, game.id)).run();
  }

  private context(gameId: string, includeDatasets: boolean, db = this.db) {
    const game = db.select().from(games).where(eq(games.id, gameId)).get();
    if (!game) throw new DomainError("No current game", 404);
    const datasetItems: UploadedDataset[] = includeDatasets
      ? db
          .select()
          .from(datasets)
          .where(eq(datasets.gameId, gameId))
          .all()
          .map((row) => ({
            id: row.id,
            name: row.name,
            category: row.category as DatasetCategory,
            temporary: row.temporary,
            originalFilename: row.originalFilename,
            geojson: decode<MapFeatureCollection>(row.geojson)!,
            featureCount: row.featureCount,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
          }))
      : [];
    return {
      boundary: decode<AreaFeature>(game.boundaryGeojson)!,
      subdivisions: decode<FeatureCollection<Polygon | MultiPolygon>>(game.subdivisionsGeojson),
      datasets: datasetItems,
      transitStations: decode<FeatureCollection<Point>>(game.transitStationsGeojson),
      transitLines: decode<FeatureCollection<LineString | MultiLineString>>(
        game.transitLinesGeojson,
      ),
      transitModes: decode<TransitMode[]>(game.transitModesJson) ?? [],
    };
  }

  createQuestion(
    token: string | undefined,
    definitionId: string,
    parameters: Record<string, unknown>,
  ): string {
    const player = this.requireSeeker(token);
    const game = this.requirePlayableGame(player.gameId);
    const config = this.db
      .select()
      .from(questionConfigs)
      .where(
        and(eq(questionConfigs.gameId, game.id), eq(questionConfigs.definitionId, definitionId)),
      )
      .get();
    if (!config?.enabled) throw new DomainError("This question is disabled", 409);
    const definition = getQuestionDefinition(definitionId);
    const built = this.buildArtifactsOrThrow(definitionId, parameters, null, game.id);
    const id = randomUUID();
    const timestamp = now();
    this.db
      .insert(questions)
      .values({
        id,
        gameId: game.id,
        definitionId,
        category: definition.category,
        displayName: definition.name,
        status: "DRAFT",
        parametersJson: encode(built.parameters),
        answerJson: null,
        visualizationGeojson: built.artifacts.visualization
          ? encode(built.artifacts.visualization)
          : null,
        effectGeojson: null,
        enabled: true,
        askedByPlayerId: player.id,
        usageNumber: 0,
        cost: 0,
        askedAt: null,
        answeredAt: null,
        appliedAt: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .run();
    this.bump(game.id);
    return id;
  }

  updateQuestion(
    token: string | undefined,
    id: string,
    update: { parameters?: Record<string, unknown> | undefined; enabled?: boolean | undefined },
  ): void {
    const player = this.requireSeeker(token);
    this.requirePlayableGame(player.gameId);
    const row = this.db
      .select()
      .from(questions)
      .where(and(eq(questions.id, id), eq(questions.gameId, player.gameId)))
      .get();
    if (!row) throw new DomainError("Question not found", 404);
    if (update.parameters !== undefined && row.status === "PENDING") {
      throw new DomainError(
        "A pending question's parameters cannot be edited while awaiting an answer",
        409,
      );
    }
    const parameters = update.parameters ?? decode<Record<string, unknown>>(row.parametersJson)!;
    const answer = decode<string>(row.answerJson);
    const built = this.buildArtifactsOrThrow(row.definitionId, parameters, answer, player.gameId);
    this.db.transaction((tx) => {
      tx.update(questions)
        .set({
          parametersJson: encode(built.parameters),
          visualizationGeojson: built.artifacts.visualization
            ? encode(built.artifacts.visualization)
            : null,
          effectGeojson: built.artifacts.effect ? encode(built.artifacts.effect) : null,
          enabled: update.enabled ?? row.enabled,
          updatedAt: now(),
        })
        .where(eq(questions.id, id))
        .run();
      this.recompute(player.gameId, tx);
    });
  }

  askQuestion(token: string | undefined, id: string): void {
    const player = this.requireSeeker(token);
    this.requirePlayableGame(player.gameId);
    const row = this.db
      .select()
      .from(questions)
      .where(and(eq(questions.id, id), eq(questions.gameId, player.gameId)))
      .get();
    if (!row) throw new DomainError("Question not found", 404);
    if (row.status !== "DRAFT") throw new DomainError("Only a draft can be asked", 409);
    const config = this.db
      .select()
      .from(questionConfigs)
      .where(
        and(
          eq(questionConfigs.gameId, player.gameId),
          eq(questionConfigs.definitionId, row.definitionId),
        ),
      )
      .get();
    if (!config) throw new DomainError("Question configuration missing", 500);
    const previousUses =
      this.db
        .select({ value: count() })
        .from(questions)
        .where(
          and(
            eq(questions.gameId, player.gameId),
            eq(questions.definitionId, row.definitionId),
            isNotNull(questions.askedAt),
          ),
        )
        .get()?.value ?? 0;
    const usageNumber = previousUses + 1;
    const cost = calculateQuestionCost(
      config.baseCost,
      usageNumber,
      decode<QuestionConfig["repeatRule"]>(config.repeatRuleJson)!,
    );
    const timestamp = now();
    this.db
      .update(questions)
      .set({
        status: "PENDING",
        askedByPlayerId: player.id,
        usageNumber,
        cost,
        askedAt: timestamp,
        updatedAt: timestamp,
      })
      .where(eq(questions.id, id))
      .run();
    this.bump(player.gameId);
  }

  answerQuestion(token: string | undefined, id: string, answer: string): void {
    const player = this.authenticate(token);
    const game = this.requirePlayableGame(player.gameId);
    const row = this.db
      .select()
      .from(questions)
      .where(and(eq(questions.id, id), eq(questions.gameId, player.gameId)))
      .get();
    if (!row) throw new DomainError("Question not found", 404);
    if (row.status !== "PENDING")
      throw new DomainError("Only a pending question can be answered", 409);
    if (game.seekerOnly) {
      if (player.role !== "SEEKER") {
        throw new DomainError("Only a Seeker can record answers in Seeker-only mode", 403);
      }
    } else if (game.hiderAssistance ? player.role !== "HIDER" : player.role !== "SEEKER") {
      throw new DomainError(
        game.hiderAssistance ? "The Hider answers this question" : "A Seeker records this answer",
        403,
      );
    }
    const built = this.buildArtifactsOrThrow(
      row.definitionId,
      decode<Record<string, unknown>>(row.parametersJson)!,
      answer,
      game.id,
    );
    if (!built.artifacts.effect) {
      throw new DomainError("This answer does not produce a usable area effect", 409);
    }
    const timestamp = now();
    this.db
      .update(questions)
      .set({
        status: "ANSWERED",
        answerJson: encode(answer),
        visualizationGeojson: built.artifacts.visualization
          ? encode(built.artifacts.visualization)
          : null,
        effectGeojson: encode(built.artifacts.effect),
        answeredAt: timestamp,
        updatedAt: timestamp,
      })
      .where(eq(questions.id, id))
      .run();
    this.bump(game.id);
  }

  reviseQuestionAnswer(token: string | undefined, id: string, answer: string): void {
    const player = this.requireSeeker(token);
    this.requirePlayableGame(player.gameId);
    const row = this.db
      .select()
      .from(questions)
      .where(and(eq(questions.id, id), eq(questions.gameId, player.gameId)))
      .get();
    if (!row) throw new DomainError("Question not found", 404);
    if (row.status !== "ANSWERED" && row.status !== "APPLIED") {
      throw new DomainError("Only a recorded answer can be corrected", 409);
    }
    const built = this.buildArtifactsOrThrow(
      row.definitionId,
      decode<Record<string, unknown>>(row.parametersJson)!,
      answer,
      player.gameId,
    );
    if (!built.artifacts.effect) {
      throw new DomainError("This answer does not produce a usable area effect", 409);
    }
    const timestamp = now();
    this.db.transaction((tx) => {
      tx.update(questions)
        .set({
          answerJson: encode(answer),
          visualizationGeojson: built.artifacts.visualization
            ? encode(built.artifacts.visualization)
            : null,
          effectGeojson: encode(built.artifacts.effect),
          answeredAt: timestamp,
          updatedAt: timestamp,
        })
        .where(eq(questions.id, id))
        .run();
      if (row.status === "APPLIED") this.recompute(player.gameId, tx);
      else {
        const game = tx.select().from(games).where(eq(games.id, player.gameId)).get();
        if (game) {
          tx.update(games)
            .set({ revision: game.revision + 1, updatedAt: now() })
            .where(eq(games.id, player.gameId))
            .run();
        }
      }
    });
  }

  applyQuestion(token: string | undefined, id: string): void {
    const player = this.requireSeeker(token);
    this.requirePlayableGame(player.gameId);
    const row = this.db
      .select()
      .from(questions)
      .where(and(eq(questions.id, id), eq(questions.gameId, player.gameId)))
      .get();
    if (!row) throw new DomainError("Question not found", 404);
    if (row.status !== "ANSWERED" && row.status !== "APPLIED")
      throw new DomainError("Answer the question before applying it", 409);
    const answer = decode<string>(row.answerJson);
    if (!answer) throw new DomainError("Answer the question before applying it", 409);
    const existingEffect = decode<GeometryEffect>(row.effectGeojson);
    // Keep the effect recorded at answer time so a later dataset replace cannot
    // reinterpret place indexes. Only rebuild when the answer never produced one
    // (e.g. First Division answered before subdivisions finished loading).
    let visualizationGeojson = row.visualizationGeojson;
    let effectGeojson = row.effectGeojson;
    if (!existingEffect) {
      const built = this.buildArtifactsOrThrow(
        row.definitionId,
        decode<Record<string, unknown>>(row.parametersJson)!,
        answer,
        player.gameId,
      );
      if (!built.artifacts.effect) {
        throw new DomainError("This answer does not produce a usable area effect", 409);
      }
      visualizationGeojson = built.artifacts.visualization
        ? encode(built.artifacts.visualization)
        : null;
      effectGeojson = encode(built.artifacts.effect);
    }
    const timestamp = now();
    this.db.transaction((tx) => {
      tx.update(questions)
        .set({
          status: "APPLIED",
          visualizationGeojson,
          effectGeojson,
          appliedAt: timestamp,
          updatedAt: timestamp,
        })
        .where(eq(questions.id, id))
        .run();
      this.recompute(player.gameId, tx);
    });
  }

  deleteQuestion(token: string | undefined, id: string): void {
    const player = this.requireSeeker(token);
    this.requirePlayableGame(player.gameId);
    this.db.transaction((tx) => {
      tx.delete(questions)
        .where(and(eq(questions.id, id), eq(questions.gameId, player.gameId)))
        .run();
      this.recompute(player.gameId, tx);
    });
  }

  private recompute(
    gameId: string,
    db: Pick<DatabaseBundle["db"], "select" | "update"> = this.db,
  ): void {
    const game = db.select().from(games).where(eq(games.id, gameId)).get();
    if (!game) return;
    const effects = db
      .select()
      .from(questions)
      .where(
        and(
          eq(questions.gameId, gameId),
          eq(questions.status, "APPLIED"),
          eq(questions.enabled, true),
        ),
      )
      .orderBy(asc(questions.createdAt))
      .all()
      .flatMap((row) => {
        const effect = decode<GeometryEffect>(row.effectGeojson);
        return effect ? [effect] : [];
      });
    const possible = recomputePossibleArea(decode<AreaFeature>(game.boundaryGeojson)!, effects);
    db.update(games)
      .set({
        possibleAreaGeojson: possible ? encode(possible) : null,
        revision: game.revision + 1,
        updatedAt: now(),
      })
      .where(eq(games.id, gameId))
      .run();
  }

  saveSubdivisionsForGame(
    gameId: string,
    adminLevel: number,
    data: FeatureCollection<Polygon | MultiPolygon>,
  ): boolean {
    const game = this.currentRow();
    if (!game || game.id !== gameId) return false;
    this.db
      .update(games)
      .set({
        firstDivisionAdminLevel: adminLevel,
        subdivisionsGeojson: encode(data),
        revision: game.revision + 1,
        updatedAt: now(),
      })
      .where(eq(games.id, gameId))
      .run();
    return true;
  }

  saveSubdivisions(
    token: string | undefined,
    adminLevel: number,
    data: FeatureCollection<Polygon | MultiPolygon>,
  ): void {
    const player = this.requireSeeker(token);
    const game = this.currentRow();
    if (!game) throw new DomainError("No current game", 404);
    this.saveSubdivisionsForGame(player.gameId, adminLevel, data);
  }

  saveTransitForGame(
    gameId: string,
    data: {
      lines: FeatureCollection<LineString | MultiLineString>;
      stations: FeatureCollection<Point>;
    },
  ): boolean {
    const game = this.currentRow();
    if (!game || game.id !== gameId) return false;
    this.db
      .update(games)
      .set({
        transitLinesGeojson: encode(data.lines),
        transitStationsGeojson: encode(data.stations),
        revision: game.revision + 1,
        updatedAt: now(),
      })
      .where(eq(games.id, gameId))
      .run();
    return true;
  }

  saveTransit(
    token: string | undefined,
    data: {
      lines: FeatureCollection<LineString | MultiLineString>;
      stations: FeatureCollection<Point>;
    },
  ): void {
    const player = this.requireSeeker(token);
    const game = this.currentRow();
    if (!game) throw new DomainError("No current game", 404);
    this.saveTransitForGame(player.gameId, data);
  }

  addDataset(
    token: string | undefined,
    input: {
      name: string;
      category: DatasetCategory;
      originalFilename: string;
      geojson: MapFeatureCollection;
    },
  ): string {
    const player = this.requireSeeker(token);
    const sourceLibraryId = this.saveDatasetLibrary(input);
    const id = randomUUID();
    const timestamp = now();
    this.db
      .insert(datasets)
      .values({
        id,
        gameId: player.gameId,
        sourceLibraryId,
        temporary: false,
        name: input.name,
        category: input.category,
        originalFilename: input.originalFilename,
        geojson: encode(input.geojson),
        featureCount: input.geojson.features.length,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .run();
    this.bump(player.gameId);
    return id;
  }

  updateDataset(
    token: string | undefined,
    id: string,
    input: { name?: string | undefined; category?: DatasetCategory | undefined },
  ): void {
    const player = this.requireSeeker(token);
    const row = this.db
      .select()
      .from(datasets)
      .where(and(eq(datasets.id, id), eq(datasets.gameId, player.gameId)))
      .get();
    if (!row) throw new DomainError("Dataset not found", 404);
    this.db
      .update(datasets)
      .set({
        name: input.name ?? row.name,
        category: input.category ?? row.category,
        updatedAt: now(),
      })
      .where(eq(datasets.id, id))
      .run();
    if (row.sourceLibraryId && input.name) {
      this.db
        .update(datasetLibrary)
        .set({ name: input.name, updatedAt: now() })
        .where(eq(datasetLibrary.id, row.sourceLibraryId))
        .run();
    }
    this.bump(player.gameId);
  }

  replaceDataset(
    token: string | undefined,
    id: string,
    input: { originalFilename: string; geojson: MapFeatureCollection },
  ): void {
    const player = this.requireSeeker(token);
    const row = this.db
      .select({
        id: datasets.id,
        name: datasets.name,
        sourceLibraryId: datasets.sourceLibraryId,
        temporary: datasets.temporary,
      })
      .from(datasets)
      .where(and(eq(datasets.id, id), eq(datasets.gameId, player.gameId)))
      .get();
    if (!row) throw new DomainError("Dataset not found", 404);
    if (row.temporary) {
      throw new DomainError("Temporary OpenStreetMap POIs cannot be replaced", 409);
    }
    const sourceLibraryId = row.sourceLibraryId
      ? row.sourceLibraryId
      : this.saveDatasetLibrary({ ...input, name: row.name });
    const encoded = encode(input.geojson);
    const contentHash = createHash("sha256").update(encoded).digest("hex");
    this.db
      .update(datasetLibrary)
      .set({
        originalFilename: input.originalFilename,
        geojson: encoded,
        contentHash,
        featureCount: input.geojson.features.length,
        updatedAt: now(),
      })
      .where(eq(datasetLibrary.id, sourceLibraryId))
      .run();
    this.db
      .update(datasets)
      .set({
        sourceLibraryId,
        originalFilename: input.originalFilename,
        geojson: encode(input.geojson),
        featureCount: input.geojson.features.length,
        updatedAt: now(),
      })
      .where(eq(datasets.id, id))
      .run();
    this.bump(player.gameId);
  }

  deleteDataset(token: string | undefined, id: string): void {
    const player = this.requireSeeker(token);
    this.db
      .delete(datasets)
      .where(and(eq(datasets.id, id), eq(datasets.gameId, player.gameId)))
      .run();
    this.bump(player.gameId);
  }

  addMarker(
    token: string | undefined,
    input: { position: unknown; title: string; note?: string | null | undefined },
  ): string {
    const player = this.requireSeeker(token);
    this.requirePlayableGame(player.gameId);
    const id = randomUUID();
    const timestamp = now();
    this.db
      .insert(seekerMarkers)
      .values({
        id,
        gameId: player.gameId,
        createdByPlayerId: player.id,
        positionGeojson: encode(input.position),
        title: input.title,
        note: input.note ?? null,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .run();
    this.bump(player.gameId);
    return id;
  }

  updateMarker(
    token: string | undefined,
    id: string,
    input: { position?: unknown; title?: string | undefined; note?: string | null | undefined },
  ): void {
    const player = this.requireSeeker(token);
    this.requirePlayableGame(player.gameId);
    const row = this.db
      .select()
      .from(seekerMarkers)
      .where(and(eq(seekerMarkers.id, id), eq(seekerMarkers.gameId, player.gameId)))
      .get();
    if (!row) throw new DomainError("Marker not found", 404);
    this.db
      .update(seekerMarkers)
      .set({
        positionGeojson: input.position ? encode(input.position) : row.positionGeojson,
        title: input.title ?? row.title,
        note: input.note === undefined ? row.note : input.note,
        updatedAt: now(),
      })
      .where(eq(seekerMarkers.id, id))
      .run();
    this.bump(player.gameId);
  }

  deleteMarker(token: string | undefined, id: string): void {
    const player = this.requireSeeker(token);
    this.requirePlayableGame(player.gameId);
    this.db
      .delete(seekerMarkers)
      .where(and(eq(seekerMarkers.id, id), eq(seekerMarkers.gameId, player.gameId)))
      .run();
    this.bump(player.gameId);
  }
}

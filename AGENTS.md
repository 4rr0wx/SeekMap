# AGENTS.md

## Project shape

HideSeek Atlas is a pnpm TypeScript workspace with one deployable process:

- `apps/web`: React/Vite/MapLibre PWA.
- `apps/server`: Fastify REST, Socket.IO, Drizzle + SQLite, OSM services, KML parsing.
- `packages/shared`: API/domain types, Zod schemas, geometry, timers, costs, Question Engine.

The production Fastify process serves `apps/web/dist`. Do not split the project into microservices or introduce Redis/PostgreSQL/auth providers without an explicit product decision.

## Domain invariants

- Zero or one current game. An ended game remains current until explicitly cleared.
- Question lifecycle is `DRAFT -> PENDING -> ANSWERED -> APPLIED`.
- DRAFT geometry is planning only and never affects Possible Area.
- Possible Area is always reconstructed from Game Boundary plus all enabled APPLIED effects. Never make incremental mutation the only source of truth.
- Stations are display aids filtered by Possible Area; stations do not define the area.
- Question usage is keyed by stable definition ID and only actually asked questions count.
- The server is authoritative. Socket.IO is an invalidation/presence channel; reconnect retrieves a full snapshot.

## Privacy and roles

Hider GPS must never reach the server. Keep it local to the Hider browser:

- no Hider coordinate REST body or query parameter;
- no location WebSocket event;
- no database field;
- no request-body logging;
- no analytics or persistence;
- no reuse of the local point in shared question parameters.

Hider answers accept a strict `{ answer }` payload only. Hider snapshots omit DRAFT questions, omit PENDING questions while Assistance is off, and omit `seekerMarkers` entirely. All marker mutation routes require a Seeker. Preserve these rules with tests whenever state projection or transport changes.

## GeoJSON conventions

- WGS84/EPSG:4326 only.
- Coordinate order is `[longitude, latitude]` everywhere.
- Game Boundary, Possible Area, and geographic effects are `Feature<Polygon | MultiPolygon>`.
- Map collections are ordinary GeoJSON FeatureCollections; KML is converted at import and never used as an internal format.
- Support both Polygon and MultiPolygon. Avoid casts that silently drop parts or holes.
- Surface geometry failures. Do not silently keep a misleading area.

## Question Engine conventions

Definitions live in `packages/shared/src/questions.ts` and own stable ID, category, labels, parameter schema, answers, base/repeat cost, visualization, and applied effect. Do not duplicate question rules in React or route handlers.

Use real geometry only for rules established confidently. An uncertain rule must set `exactRulePending`, provide a visible tracking workflow, return no effect, and be documented. Review supplied KML data before refining dataset-specific behavior.

## Persistence and API boundaries

- Schema declarations are in `apps/server/src/db/schema.ts`; startup DDL is in `database.ts`. Update both together until a migration framework is justified.
- Validate every external body with Zod.
- Uploaded data stays in memory, is size-limited, and is normalized before persistence. Never derive a filesystem path from an uploaded filename.
- OSM endpoints belong in environment configuration. Cache repeated queries and persist game-critical results.
- Never log authorization headers or request bodies.

## Completion checks

Before considering a change complete, run from the repository root:

```bash
pnpm format
pnpm lint
pnpm typecheck
pnpm test
pnpm build
docker compose config
```

For deployment-sensitive work also run `docker compose build`, start the container, check `/api/health`, restart it against the same volume, and verify the game survives. For map/UI changes, visually inspect at an iPad-sized and smartphone-sized viewport.

Tests must cover changed geometry, role visibility, Hider privacy, reconnect/state projection, timers, usage/costs, and persistence in proportion to the change.

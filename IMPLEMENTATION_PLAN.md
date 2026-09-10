# HideSeek Atlas — implementation plan

This plan is based on the supplied product goal, a clean/empty repository, and an inspection of the public JetLagHideAndSeek application and source repository on 2026-09-05.

The reference is useful for the five question families and their geographic primitives: Radar uses a geodesic circle and its complement, Thermometer uses the two Voronoi half-planes around a start and end point, Tentacles uses Voronoi cells for nearby places, Matching uses administrative polygons or nearest-feature Voronoi cells, and Measuring compares distance bands around features. HideSeek Atlas will reuse those concepts, not its UI or its link/file based state model. Rules that cannot be established confidently remain explicit non-geometric question definitions until the real rule configuration and KML files are supplied.

## Repository structure

The repository is a small pnpm workspace:

```text
apps/
  server/              Fastify API, Socket.IO, SQLite, OSM proxy/cache
  web/                 React/Vite PWA and MapLibre map-first UI
packages/
  shared/              Zod contracts, domain types, geometry and Question Engine
data/                  Runtime SQLite database (ignored; mounted in production)
Dockerfile             Multi-stage build; one production container
docker-compose.yml     One app service and one named persistent volume
IMPLEMENTATION_PLAN.md This document
README.md               Operations and user documentation
AGENTS.md               Constraints and completion checklist for later sessions
```

The shared package is the only cross-application package. There are no microservices, queues, generated API clients, or independent deployment units.

## Technology choices

- TypeScript throughout, strict mode.
- React 19 + Vite for the client; `vite-plugin-pwa` for the manifest and service worker.
- MapLibre GL JS with an OpenStreetMap-compatible raster style. Turf.js performs client visualization filtering and shared/server geometry operations.
- Fastify for HTTP, `@fastify/static` for the built client, `@fastify/multipart` for bounded in-memory KML uploads, and Socket.IO for realtime delivery/reconnect.
- SQLite through `better-sqlite3` and Drizzle ORM. The database is local, synchronous, and transaction-friendly, which is appropriate for one active game.
- Zod schemas at REST and Socket.IO boundaries. The server accepts command-shaped payloads instead of arbitrary shared-state patches.
- Vitest for domain and server integration tests; a real browser smoke run covers the primary responsive flow.

## SQLite schema

All GeoJSON is stored as validated JSON text in WGS84 longitude/latitude order.

### `games`

One row is active at most. Fields: ID, name, lifecycle (`ACTIVE`/`ENDED`), phase (`LOBBY`/`HIDING`/`SEEKING`/`ENDED`), hiding duration, phase start/pause/end timestamps, Hider Assistance flag, OSM area identity and display name, game boundary GeoJSON, current Possible Area GeoJSON, selected First Division admin level, cached subdivision GeoJSON, cached transit line/station GeoJSON, monotonic revision, and created/updated timestamps.

### `players`

ID, game ID, display name, role (`HIDER`/`SEEKER`), opaque device session token hash, connection count, last-seen timestamp, and created timestamp. The raw token stays on the joining device. It is not an account system; it allows the server to construct a role-safe view.

### `question_configs`

Game ID + stable definition ID, enabled flag, base cost, repeat rule (`FLAT`/`LINEAR`/`MULTIPLIER`), repeat increment/multiplier, and optional JSON configuration. This persists game-specific question configuration without duplicating engine logic. The game record separately stores the enabled train/light-rail/subway/tram modes used by the transit importer.

### `questions`

ID, game ID, definition ID/category/display name, lifecycle state, validated parameters JSON, answer JSON, draft/visualization geometry GeoJSON, applied-effect GeoJSON, enabled flag, asker player ID, usage number, charged cost, asked/answered/applied timestamps, and created/updated timestamps.

### `datasets`

ID, game ID, optional reusable-library source ID, name, assigned question category, original filename, normalized GeoJSON FeatureCollection, feature count, and timestamps. Raw uploaded files are never written to disk.

### `dataset_library`

ID, name, original filename, normalized GeoJSON FeatureCollection, content hash, feature count, and timestamps. These rows survive game reset. Creating a game copies only the selected library rows into `datasets`, so a running game has a stable snapshot while later games can reuse the saved imports.

### `seeker_markers`

ID, game ID, creator player ID, Point GeoJSON, title, note, and timestamps. Marker rows are only included in Seeker state and Seeker-room events.

### `osm_cache`

Stable request key, kind, response JSON, and timestamps. Game-critical imported boundary/subdivision/transit data is also copied onto the game row so play continues if Overpass is unavailable.

SQLite foreign keys and WAL mode are enabled. Mutations that change questions update the question and deterministically recompute Possible Area in one transaction.

## Realtime synchronization

REST is used for initial state and mutations; Socket.IO is the low-complexity invalidation and presence channel.

1. A device joins over REST and stores `{ playerId, token }` in local storage.
2. Socket.IO authenticates the token during connection, joins the active-game room plus a `role:SEEKER` or `role:HIDER` room, and updates presence.
3. Each successful mutation increments `games.revision` and emits a `state:changed` invalidation. Each authenticated client then fetches its role-filtered snapshot. Hiders never receive seeker markers.
4. Clients always fetch a full authoritative snapshot after connect/reconnect and ignore older revisions.
5. Timers are derived from server timestamps. A lightweight server check transitions HIDING to SEEKING once, persists the transition, and broadcasts the new state.

There is deliberately no client-originated location event. Hider answer messages contain only the question ID and a schema-constrained answer enum. Fastify does not log request bodies.

## MapLibre and GeoJSON architecture

- Canonical CRS: GeoJSON WGS84/EPSG:4326, coordinates always `[longitude, latitude]`.
- Canonical areal types: `Feature<Polygon | MultiPolygon>`; import and API boundaries normalize FeatureCollections by union where required.
- Stable map sources: Game Boundary, Possible Area, question geometry, admin boundaries, transit lines/stations, imported datasets, Seeker markers, local GPS, measurement geometry, and the locally selected draft point.
- Layer visibility is local UI state. Stations are filtered client-side with Turf `booleanPointInPolygon` against Possible Area; they never define that area.
- Draft geometry is visible but never applied. Applied effects are recomputed from Game Boundary plus every enabled APPLIED question in creation order. Edit, disable, delete, or reapply invokes the same pure recomputation.
- Geometry errors are surfaced and do not silently replace the previous authoritative Possible Area. An empty result is represented and warned about explicitly.

Radar and Thermometer ship with deterministic effects. First Division Matching can use cached subdivision polygons. Tentacles, dataset Matching, and Measuring expose parameters, dataset requirements, answer choices, and visualization extension hooks without pretending uncertain rules are final.

## OpenStreetMap integration

- Boundary search is proxied by the server to the configurable Nominatim endpoint using `format=geojson`, `polygon_geojson=1`, and a descriptive User-Agent. Only Polygon/MultiPolygon candidates can create a game.
- The selected result, including its polygon, OSM type/ID, display name, and bounding box, is persisted once.
- First Division discovery uses a cached, lightweight Overpass tag query to count available child administrative levels, proposes the shallowest level with multiple boundaries, and lets the user choose another detected or manual level. If detection fails, creation remains available with a clearly labelled fallback; Vienna is not special-cased.
- Transit loading uses an Overpass query for physical rail/light-rail/subway/tram ways plus stops/stations; buses are excluded. The selected modes are persisted, and normalized lines and points are cached with the game.
- Requests have timeouts, bounded response sizes, cache keys, and useful errors. Overpass failure does not prevent creating or continuing a game; users can retry data loading later.
- Public endpoint URLs come from environment variables and are exposed to the client only through a non-secret config endpoint when needed.

## Question Engine

`packages/shared/src/questions` contains a registry of declarative definitions:

```ts
type QuestionDefinition = {
  id: string;
  category: "RADAR" | "THERMOMETER" | "TENTACLES" | "MATCHING" | "MEASURING";
  name: string;
  description: string;
  parametersSchema: ZodType;
  answers: readonly AnswerOption[];
  baseCost: number;
  repeatRule: RepeatCostRule;
  requiredDatasetCategory?: string;
  buildVisualization(parameters, context): GeoJSON | null;
  buildEffect(parameters, answer, context): Polygon | MultiPolygon | null;
};
```

The registry owns usage/cost defaults and geographic behavior. UI components render common parameter controls by definition metadata. Coordinates are not typed: the composer temporarily yields to the MapLibre map for one or two clicks, or uses browser-local GPS. The server resolves the stable ID, validates parameters/answers, computes geometry, counts previous official uses, and calculates cost. Unknown or placeholder definitions never affect Possible Area.

Lifecycle transitions are explicitly validated: DRAFT → PENDING → ANSWERED → APPLIED, with edit/disable/delete/reapply commands. Hider Assistance determines who is allowed to answer, not the geometry logic.

## KML import

The creation screen accepts an optional multi-file selection of `.kml` and `.kmz` files. The browser uploads one file per bounded request. Fastify keeps it in memory, extracts the preferred `doc.kml` (or first KML entry) from KMZ with an uncompressed-size guard, and converts KML via `@tmcw/togeojson`. It rejects malformed archives/XML, empty datasets, unsupported output, unreasonable feature counts, invalid coordinates, and non-GeoJSON geometries. Names and safe scalar properties are preserved; only normalized GeoJSON is persisted. Existing game datasets are adopted into the reusable library on upgrade. Uploaded filenames are metadata only and never form filesystem paths.

## Docker Compose deployment

The multi-stage Dockerfile installs the pnpm workspace, runs typecheck/tests/build in CI or explicitly during verification, builds web and server artifacts, then copies only production dependencies/artifacts into a Node 24 slim image. Fastify serves `/app/public` and the API/Socket.IO endpoint from one port. Compose publishes `${PORT:-3000}`, mounts a named volume at `${DATA_DIR:-/data}`, sets a restart policy, and checks `/api/health`. The server trusts standard forwarded headers and uses relative same-origin URLs, so a normal HTTPS reverse proxy only needs WebSocket upgrade support and no path rewriting.

## Implementation milestones

1. **Workspace foundation:** configs, shared contracts, Fastify health route, React shell, Docker files, lint/typecheck/test commands.
2. **Persistence and game lifecycle:** Drizzle schema/migrations, one-game invariant, create/join/start/end/reset, server-derived timer, role-safe state projection.
3. **Realtime:** token-backed device identity, Socket.IO rooms, reconnect snapshot, presence and revision handling.
4. **Map and OSM geography:** Nominatim boundary search, Polygon/MultiPolygon map display, First Division and transit fetch/cache, layer controls and station filtering.
5. **Question Engine:** registry, lifecycle, Radar/Thermometer geometry, deterministic Possible Area recomputation, history, usage/costs, Assistance answer flow, placeholders for uncertain families.
6. **Investigation tools:** KML datasets, distance measurement, Seeker-only markers/notes.
7. **PWA and responsive UX:** installable assets/manifest/service worker, iPad-first map layout, phone Hider layout, offline shell/reconnect messaging.
8. **Hardening and documentation:** privacy/security tests, Docker persistence smoke test, E2E primary flow, README and AGENTS.md, final lint/typecheck/test/build/Compose validation.

Each milestone must leave `pnpm dev` usable, and shared/server domain tests must pass before building more UI on top.

## Testing strategy

- **Shared unit tests:** Polygon/MultiPolygon normalization, radar inside/outside, thermometer hotter/colder, First Division effect, empty/intersection failures, deterministic recomputation after edit/disable/delete, usage and repeat-cost rules, lifecycle validation, and timer calculations.
- **Server integration tests:** temporary SQLite database, restart/reopen persistence, single-active-game invariant, join/reconnect, role-filtered snapshots, KML validation/size behavior, marker privacy, and Hider answer payload rejection when it contains unexpected location data.
- **Frontend checks:** role-based controls, local-only Hider geolocation adapter, timer rendering, reconnect banner, history and pending-answer sheet are exercised through the browser smoke flow and server privacy assertions.
- **E2E smoke:** no-game → live OSM result → create → join → start → ask/answer/apply Radar → observe changed Possible Area and realtime timer/answer updates. Server integration tests cover the second role context, edit/remove/recompute, Seeker marker privacy, and database reopen deterministically.
- **Deployment verification:** `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `docker compose config`, image build, healthcheck, container restart with the same volume, and iPad/phone viewport screenshots.

Live OSM services are not required for deterministic automated tests; HTTP fixtures exercise success, malformed data, timeout, and unavailable-service paths. A final manual smoke test may use live Nominatim/Overpass if available.

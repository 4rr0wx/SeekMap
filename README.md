# HideSeek Atlas

HideSeek Atlas is a self-hosted, mobile-first investigation map for playing a real-world game inspired by Jet Lag: Hide + Seek. It synchronizes one active game between Hider and Seeker devices, keeps an authoritative Possible Area, tracks questions and costs, and supplies practical map tools. It does not solve the game or recommend strategy.

The project takes its geographic question primitives and category vocabulary from the public [JetLagHideAndSeek map generator](https://taibeled.github.io/JetLagHideAndSeek/) and [source repository](https://github.com/taibeled/JetLagHideAndSeek), but uses a separate map-first realtime workflow and original interface.

> This is an unofficial fan project. It is not affiliated with Jet Lag: The Game.

## What works

- Exactly one current game, with no accounts.
- Device-local identity with Hider and Seeker roles.
- Arbitrary administrative game areas found through Nominatim; Polygon and MultiPolygon boundaries are supported.
- MapLibre map with Game Boundary, deterministic Possible Area, question geometry, optional subdivisions, public transit, local GPS, distance measurement, and Seeker-only markers.
- Server-authoritative LOBBY → HIDING → SEEKING → ENDED timing.
- Realtime invalidation through Socket.IO and full authoritative state recovery after reconnect.
- DRAFT → PENDING → ANSWERED → APPLIED question lifecycle.
- Real geographic effects for Radar, Thermometer, and cached First Division Matching.
- Data-driven usage counts and repeat costs.
- Dataset-backed Matching and Measuring questions using the nearest in-boundary place represented by each imported feature's map point.
- Real Voronoi-partitioned Tentacles questions with configurable radius and candidate place selection.
- Optional Hider Question Assistance.
- Reusable, optional KML/KMZ library copied into each selected game and converted to stored GeoJSON.
- OSM/Overpass subdivision and train/light-rail/subway/tram layers; buses are excluded.
- Installable PWA shell and responsive iPad/phone layouts.
- SQLite persistence in one data directory.

## Quick deployment

Requirements: Docker with Docker Compose.

```bash
git clone <your-repository-url> hideseek-atlas
cd hideseek-atlas
cp .env.example .env
docker compose up -d --build
```

Open `http://localhost:3000` or the port configured in `.env`. Check status with:

```bash
docker compose ps
docker compose logs -f hideseek-atlas
```

The production setup is one application container and one named volume. The backend serves the compiled PWA, REST API, and Socket.IO connection from the same origin.

## Reverse proxy

Terminate HTTPS in a normal reverse proxy and forward the configured app port. Preserve the original `Host` and `X-Forwarded-*` headers and allow WebSocket upgrades for `/socket.io/`. No path prefix is expected. Set `PUBLIC_APP_URL` to the external HTTPS origin for descriptive outbound OSM request identification.

Authentication is deliberately outside the application; protect the entire origin with your reverse proxy if access must be restricted.

## Environment variables

| Variable               | Default                   | Purpose                                                   |
| ---------------------- | ------------------------- | --------------------------------------------------------- |
| `PORT`                 | `3000`                    | Application HTTP port.                                    |
| `HOST`                 | `0.0.0.0`                 | Listen address.                                           |
| `PUBLIC_APP_URL`       | empty                     | Public HTTPS URL, used in the OSM User-Agent description. |
| `DATA_DIR`             | `/data` in Docker         | Directory containing the SQLite database.                 |
| `NOMINATIM_URL`        | public Nominatim          | Administrative area search endpoint.                      |
| `OVERPASS_URL`         | public Overpass API       | Subdivision and transit query endpoint.                   |
| `OSM_TILE_URL`         | public OSM raster tiles   | MapLibre raster tile template.                            |
| `OSM_TILE_ATTRIBUTION` | OpenStreetMap attribution | Required map attribution.                                 |
| `MAX_KML_BYTES`        | `5242880`                 | Maximum KML/KMZ upload size.                              |
| `LOG_LEVEL`            | `info`                    | Fastify/Pino log level. Request bodies are not logged.    |

Public OSM infrastructure has usage policies and finite capacity. For regular or larger games, configure endpoints you operate or are permitted to use. Boundary, subdivision, and transit responses are cached in SQLite, and selected game geometry is copied into game state so a running game remains usable during an Overpass outage.

## Persistent data and backups

Compose stores `/data/hideseek-atlas.sqlite` in the `hideseek_data` named volume. SQLite uses WAL mode, so use one of these safe approaches:

1. Stop the app briefly and copy the SQLite database plus any `-wal`/`-shm` files from the volume.
2. Run SQLite's online backup command from a compatible maintenance container.

Do not delete the volume during routine upgrades. `docker compose down` keeps it; `docker compose down -v` permanently removes the current game and all imported data.

## Playing a game

1. With no game, search an administrative area and select a Polygon/MultiPolygon result.
2. Choose the First Division area set from the detected names, set hiding time and Hider Assistance, select or add any optional KML/KMZ datasets, and adjust transit modes or question costs as needed.
3. Each device enters a display name and chooses Hider or Seeker. The opaque session is stored in that browser's local storage.
4. A Seeker opens Players & Game and starts the timer.
5. Seekers create DRAFT questions by selecting the required reference point directly on the map (or using local GPS), then press Ask. With Assistance on, the pending question is prominent on the Hider device. With Assistance off, a Seeker records the externally obtained answer.
6. A Seeker applies an answer to include its effect in Possible Area. Editing, disabling, deleting, or reapplying reconstructs the area from Game Boundary and every enabled APPLIED question.
7. End Game preserves the final board. Starting a new game requires the explicit Clear Current Game action.

## KML imports

With no current game, the creation screen lists the persistent dataset library. KML and KMZ files can be added in one multi-file selection; every saved file is selected by default, remains optional, and can be unchecked for a game. Creating the game copies the selected normalized datasets into its authoritative state. Clearing the game removes those copies but keeps the library for the next game.

During a game, Seekers can still open Data to add, replace, categorize, or remove game datasets. New in-game uploads are also added to the reusable library. The server enforces the configured byte limit, parses uploads in memory, extracts KML from KMZ archives, accepts standard Point/MultiPoint/LineString/MultiLineString/Polygon/MultiPolygon features, preserves names and safe scalar properties, and persists normalized GeoJSON. Raw uploads and filename-derived paths are never written to disk.

Tentacles, Matching, and Measuring can each select any imported dataset. Matching compares whether the Hider and Seeker have the same nearest in-boundary place. Measuring compares each player's distance to their own nearest in-boundary place. Tentacles finds candidate places within a radius of the reference point, partitions the area using Voronoi cells, and asks which tentacle place the Hider is closest to (or outside the radius). Point features are used directly; other feature types use a representative point on the feature, matching the game's map-icon measurement convention.

## Development

Requirements: Node.js 22–24 and pnpm 11.

```bash
pnpm install
pnpm dev
```

Vite runs on `http://localhost:5173` and proxies API/WebSocket traffic to Fastify on port 3000. The local SQLite file is `./data/hideseek-atlas.sqlite` unless `DATA_DIR` is set.

Useful commands:

```bash
pnpm typecheck
pnpm test
pnpm lint
pnpm format:check
pnpm build
pnpm check
docker compose config
docker compose build
```

## Architecture

This pnpm workspace has three packages:

- `apps/web`: React/Vite PWA and MapLibre UI.
- `apps/server`: Fastify, Socket.IO, SQLite/Drizzle, OSM proxy/cache, and KML import.
- `packages/shared`: Zod contracts, GeoJSON domain types, timer/cost logic, geometry, and the data-driven Question Engine.

REST mutations persist first and increment a game revision; Socket.IO broadcasts a state-change signal. Each client then retrieves a complete role-safe snapshot. This deliberately simple pattern makes reconnect recovery identical to normal synchronization and avoids maintaining two competing state reducers.

## Privacy and game integrity

Hider GPS is local React state rendered directly into the Hider's map source. There is no REST schema, WebSocket event, database field, or logging path for that coordinate. Hider answer payloads are strict and accept only an answer value. DRAFT questions are omitted from Hider snapshots, PENDING questions are omitted when Assistance is off, and Seeker markers are never serialized into a Hider response.

This is not an application authentication system. Device tokens exist only to select the correct role-filtered view; put authentication at the reverse proxy as intended.

## Known limitations

- A game currently supports one OSM administrative area; composing adjacent areas such as Lower Austria plus Vienna is future work.
- First Division and transit completeness depends on local OpenStreetMap tagging and the selected admin level.
- Transit loading currently uses a bounding-box Overpass query and may be expensive for very large regions.
- Public OSM tile/Nominatim/Overpass services should not be treated as an SLA-backed production dependency.
- Pause, replay, statistics, QR joining, accounts, buses, automated strategy, card/curse management, and freehand GIS editing are out of scope.

The deeper design and milestone record is in [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md).

import type {
  Feature,
  FeatureCollection,
  GeoJsonProperties,
  Geometry,
  LineString,
  MultiLineString,
  MultiPoint,
  MultiPolygon,
  Point,
  Polygon,
} from "geojson";

export type PlayerRole = "HIDER" | "SEEKER";
export type GamePhase = "LOBBY" | "HIDING" | "SEEKING" | "ENDED";
export type GameLifecycle = "ACTIVE" | "ENDED";
export type QuestionStatus = "DRAFT" | "PENDING" | "ANSWERED" | "APPLIED";
export type QuestionCategory = "RADAR" | "THERMOMETER" | "TENTACLES" | "MATCHING" | "MEASURING";
export type DatasetCategory = "TENTACLES" | "MATCHING" | "MEASURING" | "TRANSIT" | "OTHER";
export type TransitMode = "train" | "light_rail" | "subway" | "tram";

export type AreaGeometry = Polygon | MultiPolygon;
export type AreaFeature = Feature<AreaGeometry>;
export type PointFeature = Feature<Point>;
export type MapGeometry = Geometry;
export type MapFeature = Feature<Geometry, GeoJsonProperties>;
export type MapFeatureCollection = FeatureCollection<Geometry, GeoJsonProperties>;

export interface Player {
  id: string;
  displayName: string;
  role: PlayerRole;
  connected: boolean;
  lastSeenAt: string;
}

export interface OSMSelection {
  osmType: "relation" | "way";
  osmId: string;
  displayName: string;
  boundingBox: [number, number, number, number];
}

export interface GameConfig {
  id: string;
  name: string;
  lifecycle: GameLifecycle;
  phase: GamePhase;
  hidingDurationSeconds: number;
  phaseStartedAt: string | null;
  pausedAt: string | null;
  endedAt: string | null;
  hiderAssistance: boolean;
  osm: OSMSelection;
  boundary: AreaFeature;
  possibleArea: AreaFeature | null;
  firstDivisionAdminLevel: number | null;
  subdivisions: FeatureCollection<AreaGeometry> | null;
  transitLines: FeatureCollection<LineString | MultiLineString> | null;
  transitStations: FeatureCollection<Point> | null;
  transitModes: TransitMode[];
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface RepeatCostRule {
  type: "FLAT" | "LINEAR" | "MULTIPLIER";
  increment?: number;
  multiplier?: number;
}

export interface QuestionConfig {
  definitionId: string;
  enabled: boolean;
  baseCost: number;
  repeatRule: RepeatCostRule;
}

export interface QuestionInstance {
  id: string;
  definitionId: string;
  category: QuestionCategory;
  displayName: string;
  status: QuestionStatus;
  parameters: Record<string, unknown>;
  answer: string | null;
  visualization: MapFeatureCollection | MapFeature | null;
  effect: GeometryEffect | null;
  enabled: boolean;
  askedByPlayerId: string | null;
  askedByName: string | null;
  usageNumber: number;
  cost: number;
  askedAt: string | null;
  answeredAt: string | null;
  appliedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface GeometryEffect {
  mode: "INTERSECT" | "SUBTRACT";
  geometry: AreaFeature;
}

export interface UploadedDataset {
  id: string;
  name: string;
  category: DatasetCategory;
  originalFilename: string;
  geojson: MapFeatureCollection;
  featureCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ReusableDataset {
  id: string;
  name: string;
  originalFilename: string;
  featureCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface SeekerMarker {
  id: string;
  createdByPlayerId: string;
  position: PointFeature;
  title: string;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface GameState {
  game: GameConfig;
  me: Player;
  players: Player[];
  questionConfigs: QuestionConfig[];
  questions: QuestionInstance[];
  datasets: UploadedDataset[];
  seekerMarkers?: SeekerMarker[];
  serverNow: string;
}

export interface PublicConfig {
  tileUrl: string;
  tileAttribution: string;
  maxUploadBytes: number;
}

export interface SearchAreaResult {
  osm: OSMSelection;
  boundary: AreaFeature;
  adminLevel: number | null;
}

export type DatasetGeometry =
  Point | MultiPoint | LineString | MultiLineString | Polygon | MultiPolygon;

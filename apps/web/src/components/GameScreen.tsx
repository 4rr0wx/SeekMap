import { useEffect, useState, type FormEvent } from "react";
import * as turf from "@turf/turf";
import {
  AlertTriangle,
  CircleHelp,
  Crosshair,
  Database,
  History,
  Layers3,
  MapPinPlus,
  Play,
  Ruler,
  Settings2,
  Square,
  Trash2,
  Users,
  WifiOff,
  X,
} from "lucide-react";
import {
  deriveTimer,
  formatDuration,
  getQuestionDefinition,
  type DatasetCategory,
  type GameState,
  type PublicConfig,
  type QuestionInstance,
  type SeekerMarker,
} from "@hideseek/shared";
import { api, patch, post, remove } from "../api";
import { GameMap, type MapLayers } from "./GameMap";
import { QuestionComposer, QuestionHistory } from "./QuestionPanel";

interface Props {
  state: GameState;
  config: PublicConfig;
  token: string;
  connected: boolean;
  refresh: () => Promise<void>;
  onIdentityCleared: () => void;
  onError: (message: string | null) => void;
}

type Panel = "history" | "layers" | "data" | "game" | null;
type Interaction = "measure" | "marker" | "question-a" | "question-b" | null;

function gameTimer(state: GameState, currentTime: Date): { label: string; value: string } {
  const game = state.game;
  if (game.phase === "ENDED") {
    const seconds =
      game.phaseStartedAt && game.endedAt
        ? Math.max(
            0,
            Math.floor(
              (new Date(game.endedAt).getTime() - new Date(game.phaseStartedAt).getTime()) / 1000,
            ),
          )
        : 0;
    return { label: "Final seeking time", value: formatDuration(seconds) };
  }
  const timer = deriveTimer(
    game.phase,
    game.hidingDurationSeconds,
    game.phaseStartedAt,
    currentTime,
  );
  return timer.phase === "HIDING" || timer.phase === "LOBBY"
    ? {
        label: game.phase === "LOBBY" ? "Hiding time" : "Hiding",
        value: formatDuration(timer.remainingSeconds),
      }
    : { label: "Seeking", value: formatDuration(timer.elapsedSeekingSeconds) };
}

export function GameScreen({
  state,
  config,
  token,
  connected,
  refresh,
  onIdentityCleared,
  onError,
}: Props) {
  const [panel, setPanel] = useState<Panel>(null);
  const [composer, setComposer] = useState<{ open: boolean; question: QuestionInstance | null }>({
    open: false,
    question: null,
  });
  const [layers, setLayers] = useState<MapLayers>({
    possibleArea: true,
    questionGeometry: true,
    administrative: false,
    transitLines: true,
    transitStations: true,
    datasets: false,
    markers: true,
  });
  const [localPosition, setLocalPosition] = useState<[number, number] | null>(null);
  const [measurement, setMeasurement] = useState<[number, number][]>([]);
  const [interaction, setInteraction] = useState<Interaction>(null);
  const [pickedQuestionPoint, setPickedQuestionPoint] = useState<{
    target: "A" | "B";
    point: [number, number];
    nonce: number;
  } | null>(null);
  const [selectedQuestionId, setSelectedQuestionId] = useState<string | null>(null);
  const [currentTime, setCurrentTime] = useState(new Date());
  const [markerDraft, setMarkerDraft] = useState<{
    point: [number, number];
    title: string;
    note: string;
    id?: string;
  } | null>(null);

  useEffect(() => {
    const timer = window.setInterval(() => setCurrentTime(new Date()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  const timer = gameTimer(state, currentTime);
  const distance =
    measurement.length === 2
      ? turf.distance(measurement[0]!, measurement[1]!, { units: "kilometers" })
      : null;
  const pendingForHider =
    state.me.role === "HIDER" && state.game.hiderAssistance
      ? state.questions.find((question) => question.status === "PENDING")
      : undefined;

  function requestGps(questionTarget?: "A" | "B") {
    if (!navigator.geolocation) return onError("Geolocation is not supported on this device.");
    navigator.geolocation.getCurrentPosition(
      (position) => {
        // Architectural privacy boundary: this coordinate remains React-local and is only passed to GameMap.
        const point: [number, number] = [position.coords.longitude, position.coords.latitude];
        setLocalPosition(point);
        if (questionTarget) {
          setPickedQuestionPoint({ target: questionTarget, point, nonce: Date.now() });
        }
        onError(null);
      },
      (error) => onError(`Local GPS unavailable: ${error.message}`),
      { enableHighAccuracy: true, maximumAge: 15_000, timeout: 15_000 },
    );
  }

  function mapClick(point: [number, number]) {
    if (interaction === "measure") {
      setMeasurement((old) => (old.length >= 2 ? [point] : [...old, point]));
    } else if (interaction === "marker" && state.me.role === "SEEKER") {
      setMarkerDraft({ point, title: "", note: "" });
      setInteraction(null);
    } else if (interaction === "question-a" || interaction === "question-b") {
      setPickedQuestionPoint({
        target: interaction === "question-a" ? "A" : "B",
        point,
        nonce: Date.now(),
      });
      setInteraction(null);
    }
  }

  async function gameAction(path: string, method: "POST" | "DELETE" = "POST") {
    try {
      if (method === "DELETE") await remove(path, token);
      else await post(path, {}, token);
      await refresh();
      onError(null);
    } catch (cause) {
      onError((cause as Error).message);
    }
  }

  async function answerPending(question: QuestionInstance, answer: string) {
    try {
      await post(`/api/questions/${question.id}/answer`, { answer }, token);
      await refresh();
    } catch (cause) {
      onError((cause as Error).message);
    }
  }

  async function saveMarker(event: FormEvent) {
    event.preventDefault();
    if (!markerDraft) return;
    const body = {
      position: turf.point(markerDraft.point),
      title: markerDraft.title,
      note: markerDraft.note || null,
    };
    try {
      if (markerDraft.id) await patch(`/api/markers/${markerDraft.id}`, body, token);
      else await post("/api/markers", body, token);
      setMarkerDraft(null);
      await refresh();
    } catch (cause) {
      onError((cause as Error).message);
    }
  }

  function editMarker(marker: SeekerMarker) {
    setMarkerDraft({
      point: marker.position.geometry.coordinates as [number, number],
      title: marker.title,
      note: marker.note ?? "",
      id: marker.id,
    });
  }

  return (
    <main className="game-shell">
      <header className="game-header">
        <div className="game-title">
          <p className="eyebrow">{state.me.role === "SEEKER" ? "Seeker board" : "Hider board"}</p>
          <h1>{state.game.name}</h1>
        </div>
        <div className="timer" aria-label={`${timer.label} ${timer.value}`}>
          <span>{timer.label}</span>
          <strong>{timer.value}</strong>
        </div>
        <button className="header-action" onClick={() => setPanel("game")}>
          <Users size={20} />
          <span>
            {state.players.filter((player) => player.connected).length}/{state.players.length}
          </span>
        </button>
        <button
          className="header-action"
          onClick={() => setPanel("layers")}
          aria-label="Map layers"
        >
          <Layers3 size={20} />
        </button>
      </header>
      {!connected && (
        <div className="connection-banner">
          <WifiOff size={16} />
          Reconnecting — displayed shared state may be out of date.
        </div>
      )}
      {!state.game.possibleArea && (
        <div className="connection-banner geometry-warning" role="alert">
          <AlertTriangle size={16} />
          No Possible Area remains. Review, correct, disable, or delete an applied answer.
        </div>
      )}
      <section className="map-stage">
        <GameMap
          state={state}
          config={config}
          layers={layers}
          localPosition={localPosition}
          measurement={measurement}
          draftQuestionPoint={pickedQuestionPoint?.point ?? null}
          selectedQuestionId={selectedQuestionId}
          interactionActive={interaction !== null}
          onMapClick={mapClick}
        />
        <div className="map-tools">
          <button
            className={interaction === "measure" ? "map-tool active" : "map-tool"}
            onClick={() => {
              setInteraction(interaction === "measure" ? null : "measure");
              setMeasurement([]);
            }}
            aria-label="Measure distance"
          >
            <Ruler />
          </button>
          {state.me.role === "SEEKER" && (
            <button
              className={interaction === "marker" ? "map-tool active" : "map-tool"}
              onClick={() => setInteraction(interaction === "marker" ? null : "marker")}
              aria-label="Place Seeker marker"
            >
              <MapPinPlus />
            </button>
          )}
          <button
            className="map-tool"
            onClick={() => requestGps()}
            aria-label="Show my location locally"
          >
            <Crosshair />
          </button>
        </div>
        {interaction && (
          <div className="interaction-hint">
            {interaction === "measure"
              ? `Tap ${measurement.length === 0 ? "point A" : measurement.length === 1 ? "point B" : "to start again"}`
              : interaction === "marker"
                ? "Tap the map to place a Seeker marker"
                : `Tap the map to choose ${interaction === "question-a" ? "the reference point" : "the end point"}`}
            <button onClick={() => setInteraction(null)} aria-label="Cancel">
              <X size={16} />
            </button>
          </div>
        )}
        {distance !== null && (
          <div className="measurement-result">
            <Ruler size={17} />
            <strong>
              {distance < 1 ? `${Math.round(distance * 1000)} m` : `${distance.toFixed(2)} km`}
            </strong>
            <button onClick={() => setMeasurement([])}>Reset</button>
          </div>
        )}
      </section>

      <nav className="bottom-bar" aria-label="Game actions">
        <button onClick={() => setPanel("history")}>
          <History />
          <span>History</span>
        </button>
        {state.me.role === "SEEKER" && (
          <button
            className="ask-button"
            onClick={() => {
              setPickedQuestionPoint(null);
              setInteraction(null);
              setComposer({ open: true, question: null });
            }}
          >
            <CircleHelp />
            <span>Ask question</span>
          </button>
        )}
        <button onClick={() => setPanel("data")}>
          <Database />
          <span>Data</span>
        </button>
      </nav>

      {pendingForHider && (
        <aside className="pending-answer">
          <p className="eyebrow">Question waiting</p>
          <h2>{pendingForHider.displayName}</h2>
          <p>{getQuestionDefinition(pendingForHider.definitionId).description}</p>
          <div className="answer-grid">
            {getQuestionDefinition(pendingForHider.definitionId).answers.map((option) => (
              <button
                key={option.value}
                className="button primary"
                onClick={() => void answerPending(pendingForHider, option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </aside>
      )}

      {panel === "history" && (
        <QuestionHistory
          state={state}
          token={token}
          refresh={refresh}
          onError={onError}
          onClose={() => setPanel(null)}
          onSelect={setSelectedQuestionId}
          onEdit={(question) => {
            setPanel(null);
            setPickedQuestionPoint(null);
            setInteraction(null);
            setComposer({ open: true, question });
          }}
        />
      )}
      {composer.open && (
        <QuestionComposer
          state={state}
          token={token}
          refresh={refresh}
          onError={onError}
          question={composer.question}
          localPosition={localPosition}
          pickedPoint={pickedQuestionPoint}
          pickingFromMap={interaction === "question-a" || interaction === "question-b"}
          onPickFromMap={(target) => setInteraction(target === "A" ? "question-a" : "question-b")}
          onRequestGps={requestGps}
          onClose={() => {
            setComposer({ open: false, question: null });
            setPickedQuestionPoint(null);
            setInteraction(null);
          }}
        />
      )}
      {panel === "layers" && (
        <LayerPanel layers={layers} setLayers={setLayers} onClose={() => setPanel(null)} />
      )}
      {panel === "data" && (
        <DataPanel
          state={state}
          token={token}
          config={config}
          refresh={refresh}
          onError={onError}
          onClose={() => setPanel(null)}
          onEditMarker={editMarker}
          onStartMarker={() => {
            setPanel(null);
            setInteraction("marker");
          }}
        />
      )}
      {panel === "game" && (
        <GamePanel
          state={state}
          onClose={() => setPanel(null)}
          onStart={() => void gameAction("/api/game/start")}
          onEnd={() => {
            if (
              window.confirm(
                "End this game? The final board remains available until it is cleared.",
              )
            )
              void gameAction("/api/game/end");
          }}
          onReset={() => {
            if (window.confirm("Permanently clear the ended game and all its shared data?"))
              void gameAction("/api/game", "DELETE");
          }}
          onLeaveDevice={() => {
            onIdentityCleared();
          }}
        />
      )}
      {markerDraft && (
        <div className="modal-backdrop">
          <form className="sheet marker-sheet" onSubmit={saveMarker}>
            <div className="sheet-header">
              <div>
                <p className="eyebrow">Seeker team only</p>
                <h2>{markerDraft.id ? "Edit marker" : "New marker"}</h2>
              </div>
              <button type="button" className="icon-button" onClick={() => setMarkerDraft(null)}>
                <X />
              </button>
            </div>
            <label>
              Title
              <input
                value={markerDraft.title}
                onChange={(event) => setMarkerDraft({ ...markerDraft, title: event.target.value })}
                maxLength={80}
                autoFocus
                required
              />
            </label>
            <label>
              Note
              <textarea
                value={markerDraft.note}
                onChange={(event) => setMarkerDraft({ ...markerDraft, note: event.target.value })}
                maxLength={500}
              />
            </label>
            <p className="field-help">
              {markerDraft.point[1].toFixed(5)}, {markerDraft.point[0].toFixed(5)}
            </p>
            <button className="button primary">Save marker</button>
          </form>
        </div>
      )}
    </main>
  );
}

function LayerPanel({
  layers,
  setLayers,
  onClose,
}: {
  layers: MapLayers;
  setLayers: (layers: MapLayers) => void;
  onClose: () => void;
}) {
  const labels: Record<keyof MapLayers, string> = {
    possibleArea: "Possible Area",
    questionGeometry: "Question Geometry",
    administrative: "Administrative Boundaries",
    transitLines: "Transit Lines",
    transitStations: "Transit Stations",
    datasets: "Imported Datasets",
    markers: "Personal / Seeker Markers",
  };
  return (
    <div className="modal-backdrop align-end">
      <section className="sheet compact-sheet">
        <div className="sheet-header">
          <h2>Map layers</h2>
          <button className="icon-button" onClick={onClose}>
            <X />
          </button>
        </div>
        {(Object.keys(layers) as Array<keyof MapLayers>).map((key) => (
          <label className="switch-row" key={key}>
            <input
              type="checkbox"
              checked={layers[key]}
              onChange={(event) => setLayers({ ...layers, [key]: event.target.checked })}
            />
            <span>
              <strong>{labels[key]}</strong>
            </span>
          </label>
        ))}
      </section>
    </div>
  );
}

interface DataPanelProps {
  state: GameState;
  token: string;
  config: PublicConfig;
  refresh: () => Promise<void>;
  onError: (message: string | null) => void;
  onClose: () => void;
  onEditMarker: (marker: SeekerMarker) => void;
  onStartMarker: () => void;
}

function DataPanel({
  state,
  token,
  config,
  refresh,
  onError,
  onClose,
  onEditMarker,
  onStartMarker,
}: DataPanelProps) {
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [category, setCategory] = useState<DatasetCategory>("OTHER");
  const [file, setFile] = useState<File | null>(null);
  const [replacementId, setReplacementId] = useState<string | null>(null);

  async function load(path: string) {
    setBusy(true);
    try {
      const body = path.endsWith("subdivisions")
        ? { adminLevel: state.game.firstDivisionAdminLevel }
        : {};
      if (path.endsWith("subdivisions") && !state.game.firstDivisionAdminLevel)
        throw new Error("Choose the First Division areas first.");
      await post(path, body, token);
      await refresh();
    } catch (cause) {
      onError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function upload(event: FormEvent) {
    event.preventDefault();
    if (!file) return;
    const form = new FormData();
    form.append("name", name);
    form.append("category", category);
    form.append("file", file);
    setBusy(true);
    try {
      await api("/api/datasets", { method: "POST", body: form }, token);
      setName("");
      setFile(null);
      await refresh();
    } catch (cause) {
      onError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function deleteDataset(id: string, datasetName: string) {
    if (!window.confirm(`Delete dataset “${datasetName}”?`)) return;
    try {
      await remove(`/api/datasets/${id}`, token);
      await refresh();
    } catch (cause) {
      onError((cause as Error).message);
    }
  }

  async function replaceDataset(id: string, replacement: File | null) {
    if (!replacement) return;
    const form = new FormData();
    form.append("file", replacement);
    setReplacementId(id);
    try {
      await api(`/api/datasets/${id}/content`, { method: "PUT", body: form }, token);
      await refresh();
    } catch (cause) {
      onError((cause as Error).message);
    } finally {
      setReplacementId(null);
    }
  }

  async function changeDatasetCategory(id: string, nextCategory: DatasetCategory) {
    try {
      await patch(`/api/datasets/${id}`, { category: nextCategory }, token);
      await refresh();
    } catch (cause) {
      onError((cause as Error).message);
    }
  }

  async function deleteMarker(id: string) {
    if (!window.confirm("Delete this Seeker marker?")) return;
    try {
      await remove(`/api/markers/${id}`, token);
      await refresh();
    } catch (cause) {
      onError((cause as Error).message);
    }
  }

  return (
    <div className="modal-backdrop align-end">
      <section className="sheet data-sheet">
        <div className="sheet-header">
          <div>
            <p className="eyebrow">Cached with this game</p>
            <h2>Map data & notes</h2>
          </div>
          <button className="icon-button" onClick={onClose}>
            <X />
          </button>
        </div>
        <div className="data-section">
          <h3>OpenStreetMap layers</h3>
          <p>Already cached data stays usable if Overpass is unavailable.</p>
          {state.me.role === "SEEKER" && (
            <div className="button-row">
              <button
                className="button secondary"
                disabled={busy}
                onClick={() => void load("/api/game/subdivisions")}
              >
                Load First Division
              </button>
              <button
                className="button secondary"
                disabled={busy}
                onClick={() => void load("/api/game/transit")}
              >
                Load transit
              </button>
            </div>
          )}
          <small>
            {state.game.subdivisions?.features.length ?? 0} divisions ·{" "}
            {state.game.transitLines?.features.length ?? 0} lines ·{" "}
            {state.game.transitStations?.features.length ?? 0} stations
          </small>
        </div>
        <div className="data-section">
          <h3>KML/KMZ datasets</h3>
          {state.datasets.map((dataset) => (
            <div className="data-row" key={dataset.id}>
              <div>
                <strong>{dataset.name}</strong>
                {state.me.role === "SEEKER" ? (
                  <select
                    className="inline-select"
                    value={dataset.category}
                    aria-label={`Category for ${dataset.name}`}
                    onChange={(event) =>
                      void changeDatasetCategory(dataset.id, event.target.value as DatasetCategory)
                    }
                  >
                    {["TENTACLES", "MATCHING", "MEASURING", "TRANSIT", "OTHER"].map((value) => (
                      <option key={value}>{value}</option>
                    ))}
                  </select>
                ) : (
                  <small>{dataset.category}</small>
                )}
                <small>{dataset.featureCount} features</small>
              </div>
              {state.me.role === "SEEKER" && (
                <div className="row-actions">
                  <label className="text-button file-button">
                    {replacementId === dataset.id ? "Replacing…" : "Replace"}
                    <input
                      type="file"
                      accept=".kml,.kmz,application/vnd.google-earth.kml+xml,application/vnd.google-earth.kmz"
                      disabled={replacementId !== null}
                      onChange={(event) =>
                        void replaceDataset(dataset.id, event.target.files?.[0] ?? null)
                      }
                    />
                  </label>
                  <button
                    className="icon-button danger small"
                    onClick={() => void deleteDataset(dataset.id, dataset.name)}
                  >
                    <Trash2 />
                  </button>
                </div>
              )}
            </div>
          ))}
          {state.datasets.length === 0 && (
            <p className="muted">No game-specific datasets uploaded.</p>
          )}
          {state.me.role === "SEEKER" && (
            <form className="form-stack compact-form" onSubmit={upload}>
              <label>
                Dataset name
                <input value={name} onChange={(event) => setName(event.target.value)} required />
              </label>
              <label>
                Question category
                <select
                  value={category}
                  onChange={(event) => setCategory(event.target.value as DatasetCategory)}
                >
                  {["TENTACLES", "MATCHING", "MEASURING", "OTHER"].map((value) => (
                    <option key={value}>{value}</option>
                  ))}
                </select>
              </label>
              <label>
                KML/KMZ file
                <input
                  type="file"
                  accept=".kml,.kmz,application/vnd.google-earth.kml+xml,application/vnd.google-earth.kmz"
                  onChange={(event) => setFile(event.target.files?.[0] ?? null)}
                  required
                />
              </label>
              <small>
                Maximum {Math.round(config.maxUploadBytes / 1024 / 1024)} MiB. Files are parsed in
                memory; only normalized GeoJSON is stored.
              </small>
              <button className="button secondary" disabled={busy}>
                Upload file
              </button>
            </form>
          )}
        </div>
        {state.me.role === "SEEKER" && (
          <div className="data-section">
            <div className="section-inline">
              <h3>Seeker markers</h3>
              <button className="text-button" onClick={onStartMarker}>
                Place on map
              </button>
            </div>
            {(state.seekerMarkers ?? []).map((marker) => (
              <div className="data-row" key={marker.id}>
                <div>
                  <strong>{marker.title}</strong>
                  <small>{marker.note || "No note"}</small>
                </div>
                <div className="row-actions">
                  <button className="text-button" onClick={() => onEditMarker(marker)}>
                    Edit
                  </button>
                  <button
                    className="icon-button danger small"
                    onClick={() => void deleteMarker(marker.id)}
                  >
                    <Trash2 />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function GamePanel({
  state,
  onClose,
  onStart,
  onEnd,
  onReset,
  onLeaveDevice,
}: {
  state: GameState;
  onClose: () => void;
  onStart: () => void;
  onEnd: () => void;
  onReset: () => void;
  onLeaveDevice: () => void;
}) {
  return (
    <div className="modal-backdrop align-end">
      <section className="sheet compact-sheet">
        <div className="sheet-header">
          <div>
            <p className="eyebrow">{state.game.phase}</p>
            <h2>Players & game</h2>
          </div>
          <button className="icon-button" onClick={onClose}>
            <X />
          </button>
        </div>
        <div className="player-list">
          {state.players.map((player) => (
            <div className="player-row" key={player.id}>
              <span className={player.connected ? "presence online" : "presence"} />
              <strong>
                {player.displayName}
                {player.id === state.me.id ? " (you)" : ""}
              </strong>
              <span>{player.role}</span>
            </div>
          ))}
        </div>
        {state.me.role === "SEEKER" && state.game.phase === "LOBBY" && (
          <button className="button primary wide" onClick={onStart}>
            <Play size={18} />
            Start game
          </button>
        )}
        {state.me.role === "SEEKER" && !["LOBBY", "ENDED"].includes(state.game.phase) && (
          <button className="button danger-button wide" onClick={onEnd}>
            <Square size={17} />
            End game
          </button>
        )}
        {state.me.role === "SEEKER" && state.game.phase === "ENDED" && (
          <button className="button danger-button wide" onClick={onReset}>
            <Trash2 size={17} />
            Clear current game
          </button>
        )}
        <button className="button subtle wide" onClick={onLeaveDevice}>
          <Settings2 size={17} />
          Forget identity on this device
        </button>
      </section>
    </div>
  );
}

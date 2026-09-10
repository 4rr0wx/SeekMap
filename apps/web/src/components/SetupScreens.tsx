import { useEffect, useState, type ChangeEvent, type FormEvent } from "react";
import { Compass, MapPinned, Search, Trash2, Upload, Users } from "lucide-react";
import {
  QUESTION_DEFINITIONS,
  type PlayerRole,
  type PublicConfig,
  type ReusableDataset,
  type SearchAreaResult,
  type TransitMode,
} from "@hideseek/shared";
import {
  discoverSubdivisionLevels,
  api,
  loadDatasetLibrary,
  post,
  remove,
  searchAreas,
  type Identity,
  type SubdivisionLevel,
} from "../api";
import type { GameSummary } from "../useGameSession";
import { AreaPreview } from "./AreaPreview";

function describeSubdivision(level: SubdivisionLevel): string {
  if (level.examples.length === 0) {
    return `${level.count} areas (OSM level ${level.adminLevel})`;
  }
  const suffix = level.count > level.examples.length ? ", …" : "";
  return `${level.count} areas: ${level.examples.join(", ")}${suffix}`;
}

function divisionOption(level: SubdivisionLevel): string {
  const examples = level.examples.slice(0, 2);
  const names =
    examples.length > 0 ? ` — ${examples.join(", ")}${level.count > 2 ? ", …" : ""}` : "";
  return `${level.count} areas${names} (OSM level ${level.adminLevel})`;
}

interface NewGameProps {
  config: PublicConfig;
  onCreated: () => Promise<void>;
  onError: (message: string | null) => void;
}

export function NewGameScreen({ config, onCreated, onError }: NewGameProps) {
  const [name, setName] = useState("HideSeek Atlas");
  const [hidingMinutes, setHidingMinutes] = useState(30);
  const [assistance, setAssistance] = useState(true);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchAreaResult[]>([]);
  const [selected, setSelected] = useState<SearchAreaResult | null>(null);
  const [divisionLevel, setDivisionLevel] = useState<number | "">("");
  const [divisionCandidates, setDivisionCandidates] = useState<SubdivisionLevel[]>([]);
  const [divisionStatus, setDivisionStatus] = useState("Choose an area to load its subdivisions.");
  const [divisionFailed, setDivisionFailed] = useState(false);
  const [transitModes, setTransitModes] = useState<TransitMode[]>([
    "train",
    "light_rail",
    "subway",
    "tram",
  ]);
  const [questionConfigs, setQuestionConfigs] = useState(() =>
    QUESTION_DEFINITIONS.map((definition) => ({
      definitionId: definition.id,
      enabled: true,
      baseCost: definition.baseCost,
    })),
  );
  const [busy, setBusy] = useState(false);
  const [libraryBusy, setLibraryBusy] = useState(false);
  const [datasetLibrary, setDatasetLibrary] = useState<ReusableDataset[]>([]);
  const [selectedDatasetIds, setSelectedDatasetIds] = useState<string[]>([]);
  const firstDivisionEnabled = questionConfigs.some(
    (item) => item.definitionId === "matching.first-division" && item.enabled,
  );

  useEffect(() => {
    void loadDatasetLibrary()
      .then(({ datasets }) => {
        setDatasetLibrary(datasets);
        setSelectedDatasetIds(datasets.map((item) => item.id));
      })
      .catch((cause: Error) => onError(cause.message));
  }, [onError]);

  async function uploadDatasets(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (files.length === 0) return;
    setLibraryBusy(true);
    try {
      const uploadedIds: string[] = [];
      for (const file of files) {
        const form = new FormData();
        form.append("file", file);
        const uploaded = await api<{ id: string }>("/api/dataset-library", {
          method: "POST",
          body: form,
        });
        uploadedIds.push(uploaded.id);
      }
      const { datasets } = await loadDatasetLibrary();
      setDatasetLibrary(datasets);
      setSelectedDatasetIds((current) => [...new Set([...current, ...uploadedIds])]);
      onError(null);
    } catch (cause) {
      onError((cause as Error).message);
    } finally {
      setLibraryBusy(false);
    }
  }

  async function deleteLibraryItem(id: string) {
    setLibraryBusy(true);
    try {
      await remove(`/api/dataset-library/${id}`);
      setDatasetLibrary((current) => current.filter((item) => item.id !== id));
      setSelectedDatasetIds((current) => current.filter((item) => item !== id));
    } catch (cause) {
      onError((cause as Error).message);
    } finally {
      setLibraryBusy(false);
    }
  }

  async function search(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const response = await searchAreas(query);
      setResults(response.results);
      if (response.results.length === 0)
        onError("No administrative Polygon or MultiPolygon was found.");
      else onError(null);
    } catch (cause) {
      onError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function choose(result: SearchAreaResult) {
    setSelected(result);
    setDivisionLevel("");
    setDivisionCandidates([]);
    setDivisionFailed(false);
    setDivisionStatus("Loading subdivision names…");
    try {
      const response = await discoverSubdivisionLevels(result);
      setDivisionCandidates(response.levels);
      if (response.levels[0]) {
        setDivisionLevel(response.levels[0].adminLevel);
        setDivisionStatus(describeSubdivision(response.levels[0]));
      } else {
        setDivisionStatus("No child areas found. Disable First Division or choose another area.");
      }
    } catch {
      setDivisionLevel("");
      setDivisionFailed(true);
      setDivisionStatus("Could not load child areas.");
    }
  }

  async function create(event: FormEvent) {
    event.preventDefault();
    if (!selected) return onError("Select a game area first.");
    setBusy(true);
    try {
      await post("/api/games", {
        name,
        hidingDurationMinutes: hidingMinutes,
        hiderAssistance: assistance,
        osm: selected.osm,
        boundary: selected.boundary,
        firstDivisionAdminLevel: divisionLevel === "" ? null : divisionLevel,
        transitModes,
        questionConfigs,
        datasetLibraryIds: selectedDatasetIds,
      });
      await onCreated();
    } catch (cause) {
      onError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="setup-page">
      <section className="setup-hero">
        <div className="brand-mark">
          <Compass size={28} />
        </div>
        <p className="eyebrow">Shared investigation map</p>
        <h1>HideSeek Atlas</h1>
        <p>
          Create one shared game board. The map keeps the evidence organized; your team still does
          the reasoning.
        </p>
      </section>
      <section className="setup-card">
        <div className="section-heading">
          <MapPinned />
          <div>
            <h2>New game</h2>
            <p>Choose any OSM administrative area.</p>
          </div>
        </div>
        <form className="form-stack" onSubmit={search}>
          <label>
            Search area
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Vienna, Lower Austria, Bregenz…"
              minLength={2}
              required
            />
          </label>
          <button className="button secondary" disabled={busy}>
            <Search size={18} />
            {busy ? "Searching…" : "Search OpenStreetMap"}
          </button>
        </form>
        {results.length > 0 && (
          <div className="result-list" aria-label="Area results">
            {results.map((result) => (
              <button
                key={`${result.osm.osmType}-${result.osm.osmId}`}
                type="button"
                className={selected?.osm.osmId === result.osm.osmId ? "result selected" : "result"}
                onClick={() => void choose(result)}
              >
                <strong>{result.osm.displayName}</strong>
                <span>Administrative boundary</span>
              </button>
            ))}
          </div>
        )}
        {selected && <AreaPreview area={selected} config={config} />}
        <form className="form-stack game-details" onSubmit={create}>
          <label>
            Game name
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={100}
              required
            />
          </label>
          <div className="form-row setup-core-fields">
            <label>
              Hiding time (minutes)
              <input
                type="number"
                value={hidingMinutes}
                onChange={(event) => setHidingMinutes(Number(event.target.value))}
                min={1}
                max={1440}
                required
              />
            </label>
            {divisionCandidates.length > 0 ? (
              <label>
                Areas used by First Division
                <select
                  value={divisionLevel}
                  onChange={(event) => {
                    const value = Number(event.target.value);
                    setDivisionLevel(value);
                    const candidate = divisionCandidates.find((item) => item.adminLevel === value);
                    if (candidate) setDivisionStatus(describeSubdivision(candidate));
                  }}
                >
                  {divisionCandidates.map((candidate) => (
                    <option value={candidate.adminLevel} key={candidate.adminLevel}>
                      {divisionOption(candidate)}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <label>
                Areas used by First Division
                <input
                  type="text"
                  value={selected ? divisionStatus : "Choose an area first"}
                  disabled
                  readOnly
                />
              </label>
            )}
          </div>
          {divisionCandidates.length > 0 && <p className="field-help">{divisionStatus}</p>}
          {divisionFailed && selected && (
            <button
              type="button"
              className="button subtle retry-button"
              onClick={() => void choose(selected)}
            >
              Retry subdivision lookup
            </button>
          )}
          <label className="switch-row">
            <input
              type="checkbox"
              checked={assistance}
              onChange={(event) => setAssistance(event.target.checked)}
            />
            <span>
              <strong>Hider Question Assistance</strong>
              <small>Pending questions appear on the Hider device.</small>
            </span>
          </label>
          <details className="question-config dataset-library" open>
            <summary>Map datasets</summary>
            <p className="field-help">
              Saved KML/KMZ files for Tentacles, Matching and Measuring. Selected files are reused
              in this game.
            </p>
            <label className="button secondary dataset-upload">
              <Upload size={18} />
              {libraryBusy ? "Processing…" : "Add KML/KMZ files"}
              <input
                type="file"
                accept=".kml,.kmz,application/vnd.google-earth.kml+xml,application/vnd.google-earth.kmz"
                multiple
                disabled={libraryBusy}
                onChange={(event) => void uploadDatasets(event)}
              />
            </label>
            {datasetLibrary.length === 0 ? (
              <p className="empty-copy">No saved files.</p>
            ) : (
              <div className="dataset-library-list">
                {datasetLibrary.map((item) => (
                  <div className="dataset-library-row" key={item.id}>
                    <label>
                      <input
                        type="checkbox"
                        checked={selectedDatasetIds.includes(item.id)}
                        onChange={(event) =>
                          setSelectedDatasetIds((current) =>
                            event.target.checked
                              ? [...current, item.id]
                              : current.filter((id) => id !== item.id),
                          )
                        }
                      />
                      <span>
                        <strong>{item.name}</strong>
                        <small>{item.featureCount.toLocaleString()} places</small>
                      </span>
                    </label>
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`Remove ${item.name} from saved files`}
                      disabled={libraryBusy}
                      onClick={() => void deleteLibraryItem(item.id)}
                    >
                      <Trash2 size={17} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </details>
          <details className="question-config">
            <summary>Public transport modes</summary>
            <div className="transit-config">
              {(
                [
                  ["train", "Train"],
                  ["light_rail", "S-Bahn / light rail"],
                  ["subway", "Subway / U-Bahn"],
                  ["tram", "Tram"],
                ] as const
              ).map(([value, label]) => (
                <label className="switch-row" key={value}>
                  <input
                    type="checkbox"
                    checked={transitModes.includes(value)}
                    onChange={(event) =>
                      setTransitModes((current) =>
                        event.target.checked
                          ? [...current, value]
                          : current.filter((mode) => mode !== value),
                      )
                    }
                  />
                  <span>
                    <strong>{label}</strong>
                  </span>
                </label>
              ))}
            </div>
            {transitModes.length === 0 && (
              <p className="field-error">Select at least one public transport mode.</p>
            )}
          </details>
          <details className="question-config">
            <summary>Question configuration</summary>
            <p className="field-help">
              Enable the available question modules and set their initial cost. Repeat rules stay
              visible and deterministic in the question history.
            </p>
            {QUESTION_DEFINITIONS.map((definition) => {
              const config = questionConfigs.find((item) => item.definitionId === definition.id)!;
              return (
                <div className="question-config-row" key={definition.id}>
                  <label className="switch-row">
                    <input
                      type="checkbox"
                      checked={config.enabled}
                      onChange={(event) =>
                        setQuestionConfigs((current) =>
                          current.map((item) =>
                            item.definitionId === definition.id
                              ? { ...item, enabled: event.target.checked }
                              : item,
                          ),
                        )
                      }
                    />
                    <span>
                      <strong>{definition.name}</strong>
                      <small>
                        {definition.exactRulePending ? "Extension point" : definition.category}
                      </small>
                    </span>
                  </label>
                  <label>
                    Cost
                    <input
                      type="number"
                      min={0}
                      max={10000}
                      value={config.baseCost}
                      onChange={(event) =>
                        setQuestionConfigs((current) =>
                          current.map((item) =>
                            item.definitionId === definition.id
                              ? { ...item, baseCost: Number(event.target.value) }
                              : item,
                          ),
                        )
                      }
                    />
                  </label>
                </div>
              );
            })}
          </details>
          <button
            className="button primary"
            disabled={
              !selected ||
              busy ||
              transitModes.length === 0 ||
              (firstDivisionEnabled && divisionLevel === "")
            }
          >
            Create game
          </button>
        </form>
      </section>
    </main>
  );
}

interface JoinProps {
  summary: GameSummary;
  onJoined: (identity: Identity) => void;
  onError: (message: string | null) => void;
}

export function JoinGameScreen({ summary, onJoined, onError }: JoinProps) {
  const [displayName, setDisplayName] = useState("");
  const [role, setRole] = useState<PlayerRole>("SEEKER");
  const [busy, setBusy] = useState(false);

  async function join(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const identity = await post<Identity>("/api/game/join", { displayName, role });
      onJoined(identity);
      onError(null);
    } catch (cause) {
      onError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="setup-page join-page">
      <section className="setup-hero compact">
        <div className="brand-mark">
          <Users size={28} />
        </div>
        <p className="eyebrow">Current game</p>
        <h1>{summary.game?.name}</h1>
        <p>Choose the identity stored only on this device.</p>
      </section>
      <section className="setup-card">
        <h2>Join current game</h2>
        <form className="form-stack" onSubmit={join}>
          <label>
            Display name
            <input
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              maxLength={50}
              autoFocus
              required
            />
          </label>
          <div className="role-grid">
            {(["SEEKER", "HIDER"] as const).map((value) => (
              <button
                type="button"
                key={value}
                className={role === value ? "role selected" : "role"}
                onClick={() => setRole(value)}
              >
                <strong>{value === "SEEKER" ? "Seeker" : "Hider"}</strong>
                <span>
                  {value === "SEEKER"
                    ? "Questions, tools and team notes"
                    : "Shared evidence and answer controls"}
                </span>
              </button>
            ))}
          </div>
          <button className="button primary" disabled={busy}>
            {busy ? "Joining…" : "Join game"}
          </button>
        </form>
      </section>
    </main>
  );
}

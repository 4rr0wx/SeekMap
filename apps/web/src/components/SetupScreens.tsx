import { useEffect, useMemo, useState, type ChangeEvent, type FormEvent } from "react";
import {
  AlertTriangle,
  Compass,
  MapPinned,
  Minus,
  Plus,
  Search,
  Trash2,
  Upload,
  Users,
} from "lucide-react";
import * as turf from "@turf/turf";
import {
  QUESTION_DEFINITIONS,
  combineBoundaries,
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
import { MAP_COLORS } from "../mapTheme";
import { AreaPreview } from "./AreaPreview";

export interface SelectedBoundary {
  id: string;
  result: SearchAreaResult;
  mode: "ADD" | "SUBTRACT";
}

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
  const [seekerOnly, setSeekerOnly] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchAreaResult[]>([]);
  const [boundaries, setBoundaries] = useState<SelectedBoundary[]>([]);
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

  const primaryLocation = boundaries.find((b) => b.mode === "ADD")?.result ?? null;

  const combinedBoundary = useMemo(() => {
    if (boundaries.length === 0) return null;
    return combineBoundaries(
      boundaries.map((b) => ({ mode: b.mode, boundary: b.result.boundary })),
    );
  }, [boundaries]);

  const excludedBoundaries = useMemo(() => {
    return boundaries.filter((b) => b.mode === "SUBTRACT").map((b) => b.result.boundary);
  }, [boundaries]);

  const combinedDisplayName = useMemo(() => {
    const added = boundaries.filter((b) => b.mode === "ADD");
    const subtracted = boundaries.filter((b) => b.mode === "SUBTRACT");
    if (added.length === 0) return "";
    const addNames = added.map((b) => b.result.osm.displayName);
    const subNames = subtracted.map((b) => b.result.osm.displayName);
    if (subNames.length === 0) {
      return addNames.join(" + ").slice(0, 500);
    }
    return `${addNames.join(" + ")} (excl. ${subNames.join(", ")})`.slice(0, 500);
  }, [boundaries]);

  useEffect(() => {
    if (!primaryLocation) {
      setDivisionLevel("");
      setDivisionCandidates([]);
      setDivisionStatus("Choose an included area to load its subdivisions.");
      setDivisionFailed(false);
      return;
    }

    let active = true;
    setDivisionLevel("");
    setDivisionCandidates([]);
    setDivisionFailed(false);
    setDivisionStatus("Loading subdivision names…");

    void discoverSubdivisionLevels(primaryLocation)
      .then((response) => {
        if (!active) return;
        setDivisionCandidates(response.levels);
        if (response.levels[0]) {
          setDivisionLevel(response.levels[0].adminLevel);
          setDivisionStatus(describeSubdivision(response.levels[0]));
        } else {
          setDivisionStatus("No child areas found. Disable First Division or choose another area.");
        }
      })
      .catch(() => {
        if (!active) return;
        setDivisionLevel("");
        setDivisionFailed(true);
        setDivisionStatus("Could not load child areas.");
      });

    return () => {
      active = false;
    };
  }, [primaryLocation?.osm.osmType, primaryLocation?.osm.osmId]);

  async function retrySubdivisionLookup() {
    if (!primaryLocation) return;
    setDivisionLevel("");
    setDivisionCandidates([]);
    setDivisionFailed(false);
    setDivisionStatus("Loading subdivision names…");
    try {
      const response = await discoverSubdivisionLevels(primaryLocation);
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

  function addBoundary(result: SearchAreaResult, mode: "ADD" | "SUBTRACT") {
    const id = `${result.osm.osmType}-${result.osm.osmId}`;
    setBoundaries((current) => {
      const existingIndex = current.findIndex((b) => b.id === id);
      if (existingIndex >= 0) {
        const existing = current[existingIndex];
        if (existing && existing.mode !== mode) {
          return current.map((b, i) => (i === existingIndex ? { ...b, mode } : b));
        }
        return current;
      }
      return [...current, { id, result, mode }];
    });
  }

  function toggleBoundaryMode(id: string) {
    setBoundaries((current) =>
      current.map((b) => (b.id === id ? { ...b, mode: b.mode === "ADD" ? "SUBTRACT" : "ADD" } : b)),
    );
  }

  function removeBoundary(id: string) {
    setBoundaries((current) => current.filter((b) => b.id !== id));
  }

  function clearAllBoundaries() {
    setBoundaries([]);
  }

  async function create(event: FormEvent) {
    event.preventDefault();
    if (!primaryLocation || !combinedBoundary) {
      return onError("Include at least one valid location to create the play area.");
    }
    setBusy(true);
    try {
      const bbox = turf.bbox(combinedBoundary);
      await post("/api/games", {
        name,
        hidingDurationMinutes: hidingMinutes,
        hiderAssistance: seekerOnly ? false : assistance,
        seekerOnly,
        osm: {
          osmType: primaryLocation.osm.osmType,
          osmId: primaryLocation.osm.osmId,
          displayName: combinedDisplayName || primaryLocation.osm.displayName,
          boundingBox: [bbox[0], bbox[1], bbox[2], bbox[3]],
        },
        boundary: combinedBoundary,
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
            {results.map((result) => {
              const id = `${result.osm.osmType}-${result.osm.osmId}`;
              const existing = boundaries.find((b) => b.id === id);
              return (
                <div
                  key={id}
                  className={existing ? `result selected ${existing.mode.toLowerCase()}` : "result"}
                >
                  <div className="result-text">
                    <strong>{result.osm.displayName}</strong>
                    <span>Administrative boundary</span>
                  </div>
                  <div className="result-actions">
                    {existing ? (
                      <>
                        <span className={`boundary-tag ${existing.mode.toLowerCase()}`}>
                          {existing.mode === "ADD" ? "+ Included" : "− Excluded"}
                        </span>
                        <button
                          type="button"
                          className="button subtle small"
                          aria-label={
                            existing.mode === "ADD"
                              ? `Switch ${result.osm.displayName} to excluded`
                              : `Switch ${result.osm.displayName} to included`
                          }
                          onClick={() => toggleBoundaryMode(id)}
                        >
                          {existing.mode === "ADD" ? "Exclude" : "Include"}
                        </button>
                        <button
                          type="button"
                          className="icon-button"
                          aria-label={`Remove ${result.osm.displayName}`}
                          onClick={() => removeBoundary(id)}
                        >
                          <Trash2 size={16} />
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="button secondary small"
                          aria-label={`Include ${result.osm.displayName}`}
                          onClick={() => addBoundary(result, "ADD")}
                        >
                          <Plus size={15} />
                          Include
                        </button>
                        <button
                          type="button"
                          className="button secondary small"
                          aria-label={`Exclude ${result.osm.displayName}`}
                          onClick={() => addBoundary(result, "SUBTRACT")}
                        >
                          <Minus size={15} />
                          Exclude
                        </button>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {boundaries.length > 0 && (
          <div className="selected-boundaries">
            <div className="selected-boundaries-header">
              <div>
                <h3>Play area boundaries ({boundaries.length})</h3>
                <p className="field-help">
                  Include or exclude administrative areas to shape your play area.
                </p>
              </div>
              <button type="button" className="button subtle small" onClick={clearAllBoundaries}>
                Clear all
              </button>
            </div>
            <div className="boundary-list">
              {boundaries.map((b) => (
                <div className={`boundary-item ${b.mode.toLowerCase()}`} key={b.id}>
                  <div className="boundary-item-info">
                    <span className={`boundary-tag ${b.mode.toLowerCase()}`}>
                      {b.mode === "ADD" ? "+ Included" : "− Excluded"}
                    </span>
                    <strong>{b.result.osm.displayName}</strong>
                  </div>
                  <div className="boundary-item-actions">
                    <button
                      type="button"
                      className="button subtle small"
                      aria-label={
                        b.mode === "ADD"
                          ? `Switch ${b.result.osm.displayName} to excluded`
                          : `Switch ${b.result.osm.displayName} to included`
                      }
                      onClick={() => toggleBoundaryMode(b.id)}
                    >
                      {b.mode === "ADD" ? "Exclude" : "Include"}
                    </button>
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`Remove ${b.result.osm.displayName} from boundaries`}
                      onClick={() => removeBoundary(b.id)}
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {boundaries.length > 0 && !primaryLocation && (
          <div className="boundary-warning">
            <AlertTriangle size={18} />
            <span>At least one location boundary must be included to define the play area.</span>
          </div>
        )}

        {boundaries.length > 0 && primaryLocation && !combinedBoundary && (
          <div className="boundary-warning">
            <AlertTriangle size={18} />
            <span>
              The excluded boundaries completely eliminate the play area. Please adjust your
              boundaries.
            </span>
          </div>
        )}

        {combinedBoundary && primaryLocation && (
          <AreaPreview
            area={{
              boundary: combinedBoundary,
              osm: { displayName: combinedDisplayName || primaryLocation.osm.displayName },
            }}
            config={config}
            excludedBoundaries={excludedBoundaries}
          />
        )}
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
                  value={primaryLocation ? divisionStatus : "Choose an area first"}
                  disabled
                  readOnly
                />
              </label>
            )}
          </div>
          {divisionCandidates.length > 0 && <p className="field-help">{divisionStatus}</p>}
          {divisionFailed && primaryLocation && (
            <button
              type="button"
              className="button subtle retry-button"
              onClick={() => void retrySubdivisionLookup()}
            >
              Retry subdivision lookup
            </button>
          )}
          <label className="switch-row">
            <input
              type="checkbox"
              checked={seekerOnly}
              onChange={(event) => setSeekerOnly(event.target.checked)}
            />
            <span>
              <strong>Seeker-only mode</strong>
              <small>
                Only Seekers join the app. Communication with the Hider happens externally.
              </small>
            </span>
          </label>
          {!seekerOnly && (
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
          )}
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
                  ["train", "Train", MAP_COLORS.transitTrainLine],
                  ["light_rail", "S-Bahn / light rail", MAP_COLORS.transitLightRailLine],
                  ["subway", "Subway / U-Bahn", MAP_COLORS.transitSubwayLine],
                  ["tram", "Tram", MAP_COLORS.transitTramLine],
                ] as const
              ).map(([value, label, color]) => (
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
                  <span style={{ display: "inline-flex", alignItems: "center", gap: "0.5rem" }}>
                    <span
                      style={{
                        display: "inline-block",
                        width: "16px",
                        height: "4px",
                        borderRadius: "2px",
                        backgroundColor: color,
                        flexShrink: 0,
                      }}
                      aria-hidden="true"
                    />
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
              !combinedBoundary ||
              !primaryLocation ||
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
  const isSeekerOnly = Boolean(summary.game?.seekerOnly);
  const [displayName, setDisplayName] = useState("");
  const [role, setRole] = useState<PlayerRole>("SEEKER");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (isSeekerOnly) {
      setRole("SEEKER");
    }
  }, [isSeekerOnly]);

  async function join(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const identity = await post<Identity>("/api/game/join", {
        displayName,
        role: isSeekerOnly ? "SEEKER" : role,
      });
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
          {isSeekerOnly && (
            <p className="field-help">
              This game is in Seeker-only mode. All players join as Seekers; communication with the
              Hider is handled externally.
            </p>
          )}
          <div className="role-grid">
            {(["SEEKER", "HIDER"] as const).map((value) => {
              const isDisabled = isSeekerOnly && value === "HIDER";
              return (
                <button
                  type="button"
                  key={value}
                  disabled={isDisabled}
                  className={role === value ? "role selected" : "role"}
                  onClick={() => !isDisabled && setRole(value)}
                >
                  <strong>{value === "SEEKER" ? "Seeker" : "Hider"}</strong>
                  <span>
                    {isDisabled
                      ? "Disabled in Seeker-only mode (external communication)"
                      : value === "SEEKER"
                        ? "Questions, tools and team notes"
                        : "Shared evidence and answer controls"}
                  </span>
                </button>
              );
            })}
          </div>
          <button className="button primary" disabled={busy}>
            {busy ? "Joining…" : "Join game"}
          </button>
        </form>
      </section>
    </main>
  );
}

import { useEffect, useState, type FormEvent } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Clock3,
  Eye,
  EyeOff,
  HelpCircle,
  Send,
  Trash2,
  X,
} from "lucide-react";
import {
  buildQuestionArtifacts,
  calculateQuestionCost,
  evaluateQuestionAtPosition,
  getQuestionAnswers,
  getQuestionDefinition,
  getQuestionReferenceInfo,
  QUESTION_DEFINITIONS,
  type GameState,
  type MapFeature,
  type MapFeatureCollection,
  type QuestionInstance,
} from "@hideseek/shared";
import { patch, post, remove } from "../api";

interface CommonProps {
  state: GameState;
  token: string;
  refresh: () => Promise<void>;
  onError: (message: string | null) => void;
}

interface ComposerProps extends CommonProps {
  question?: QuestionInstance | null;
  localPosition: [number, number] | null;
  pickedPoint: { target: "A" | "B"; point: [number, number]; nonce: number } | null;
  pickingFromMap: boolean;
  onPickFromMap: (target: "A" | "B") => void;
  onRequestGps: (target: "A" | "B") => void;
  onPreviewChange: (geometry: MapFeatureCollection | MapFeature | null) => void;
  onSelect?: (id: string) => void;
  onPointPicked?: (target: "A" | "B", point: [number, number]) => void;
  onClose: () => void;
}

function parameterPoint(
  parameters: Record<string, unknown>,
  ...keys: string[]
): [number, number] | null {
  for (const key of keys) {
    const value = parameters[key];
    if (Array.isArray(value) && value.length === 2) return [Number(value[0]), Number(value[1])];
  }
  return null;
}

function PointPicker({
  label,
  point,
  onMap,
  onGps,
}: {
  label: string;
  point: [number, number] | null;
  onMap: () => void;
  onGps: () => void;
}) {
  return (
    <div className="point-picker">
      <div>
        <strong>{label}</strong>
        <span>
          {point ? `${point[1].toFixed(5)}, ${point[0].toFixed(5)}` : "No point selected"}
        </span>
      </div>
      <div className="point-picker-actions">
        <button type="button" className="button secondary" onClick={onMap}>
          Choose on map
        </button>
        <button type="button" className="button subtle" onClick={onGps}>
          Use local GPS
        </button>
      </div>
    </div>
  );
}

export function QuestionComposer({
  state,
  token,
  refresh,
  onError,
  question,
  localPosition,
  pickedPoint,
  pickingFromMap,
  onPickFromMap,
  onRequestGps,
  onPreviewChange,
  onSelect,
  onPointPicked,
  onClose,
}: ComposerProps) {
  const [definitionId, setDefinitionId] = useState(question?.definitionId ?? "radar.standard");
  const initial = question?.parameters ?? {};
  const [pointA, setPointA] = useState<[number, number] | null>(() =>
    parameterPoint(initial, "center", "start", "referencePoint"),
  );
  const [pointB, setPointB] = useState<[number, number] | null>(() =>
    parameterPoint(initial, "end"),
  );
  const [radiusMeters, setRadiusMeters] = useState(Number(initial.radiusMeters ?? 1000));
  const [datasetId, setDatasetId] = useState(String(initial.datasetId ?? ""));
  const [note, setNote] = useState(String(initial.note ?? ""));
  const [busy, setBusy] = useState(false);
  const definition = getQuestionDefinition(definitionId);
  const allowed = QUESTION_DEFINITIONS.filter(
    (item) => state.questionConfigs.find((config) => config.definitionId === item.id)?.enabled,
  );
  const datasets = state.datasets;
  const questionConfig = state.questionConfigs.find(
    (config) => config.definitionId === definitionId,
  );
  const previousUses = state.questions.filter(
    (item) => item.definitionId === definitionId && item.askedAt,
  ).length;
  const nextCost = questionConfig
    ? calculateQuestionCost(questionConfig.baseCost, previousUses + 1, questionConfig.repeatRule)
    : null;

  const effectivePointA = pickedPoint?.target === "A" ? pickedPoint.point : pointA;
  const effectivePointB = pickedPoint?.target === "B" ? pickedPoint.point : pointB;

  function currentParameters(
    pA = effectivePointA,
    pB = effectivePointB,
  ): Record<string, unknown> | null {
    if (!pA || (definition.parameterKind === "THERMOMETER" && !pB)) return null;
    if (definition.parameterKind === "RADAR") return { center: pA, radiusMeters };
    if (definition.parameterKind === "THERMOMETER") return { start: pA, end: pB };
    if (definition.parameterKind === "POINT") return { referencePoint: pA };
    if (definition.category === "TENTACLES") {
      return {
        referencePoint: pA,
        radiusMeters,
        ...(datasetId ? { datasetId } : {}),
        ...(note ? { note } : {}),
      };
    }
    return {
      referencePoint: pA,
      ...(datasetId ? { datasetId } : {}),
      ...(note ? { note } : {}),
    };
  }

  const composerReferenceInfo =
    pointA && datasetId
      ? getQuestionReferenceInfo(
          definitionId,
          { referencePoint: pointA, datasetId },
          {
            boundary: state.game.boundary,
            subdivisions: state.game.subdivisions,
            datasets: state.datasets,
          },
        )
      : null;

  useEffect(() => {
    if (!pickedPoint) return;
    if (pickedPoint.target === "A") setPointA(pickedPoint.point);
    else setPointB(pickedPoint.point);
  }, [pickedPoint]);

  useEffect(() => {
    const parameters = currentParameters(effectivePointA, effectivePointB);
    if (!parameters || (definition.parameterKind === "DATASET" && !datasetId)) {
      onPreviewChange(null);
      return;
    }
    try {
      const preview = buildQuestionArtifacts(definitionId, parameters, null, {
        boundary: state.game.boundary,
        subdivisions: state.game.subdivisions,
        datasets: state.datasets,
      }).artifacts.visualization;
      onPreviewChange(preview);
    } catch {
      onPreviewChange(null);
    }
  }, [
    definitionId,
    effectivePointA,
    effectivePointB,
    radiusMeters,
    datasetId,
    note,
    state,
    onPreviewChange,
  ]);

  function useGps(target: "A" | "B") {
    if (!localPosition) return onRequestGps(target);
    if (target === "A") setPointA(localPosition);
    else setPointB(localPosition);
    onPointPicked?.(target, localPosition);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const currentA = effectivePointA;
    const currentB = effectivePointB;
    if (!currentA || (definition.parameterKind === "THERMOMETER" && !currentB)) {
      onError("Select the required point on the map first.");
      return;
    }
    if (definition.parameterKind === "DATASET" && !definition.exactRulePending && !datasetId) {
      onError("Choose the place dataset for this question.");
      return;
    }
    const parameters = currentParameters(currentA, currentB)!;
    setBusy(true);
    try {
      if (question) {
        await patch(`/api/questions/${question.id}`, { parameters }, token);
        onSelect?.(question.id);
      } else {
        const response = await post<{ id: string }>(
          "/api/questions",
          { definitionId, parameters },
          token,
        );
        if (response?.id) {
          onSelect?.(response.id);
        }
      }
      onError(null);
      onClose();
      void refresh();
    } catch (cause) {
      onError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <aside
      className="question-sidebar sheet composer"
      aria-labelledby="question-title"
      style={pickingFromMap ? { display: "none" } : undefined}
    >
      <div className="sheet-header">
        <div>
          <p className="eyebrow">Draft planning</p>
          <h2 id="question-title">{question ? "Edit question" : "Ask a question"}</h2>
        </div>
        <button className="icon-button" onClick={onClose} aria-label="Close">
          <X />
        </button>
      </div>
      <form className="form-stack" onSubmit={submit}>
        <label>
          Question type
          <select
            value={definitionId}
            disabled={Boolean(question)}
            onChange={(event) => {
              const nextId = event.target.value;
              setDefinitionId(nextId);
              if (nextId === "tentacles.dataset" && radiusMeters === 1000) {
                setRadiusMeters(10000);
              }
            }}
          >
            {allowed.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        <p className="definition-copy">{definition.description}</p>
        {question?.askedAt ? (
          <p className="usage-preview">
            Official use {question.usageNumber} · cost {question.cost}
          </p>
        ) : nextCost !== null ? (
          <p className="usage-preview">
            Used{" "}
            {previousUses === 0 ? "never" : `${previousUses} time${previousUses === 1 ? "" : "s"}`}
            {` · next use ${previousUses + 1} · cost ${nextCost}`}
          </p>
        ) : null}
        {definition.exactRulePending && (
          <p className="notice">
            <HelpCircle size={18} />
            Tracking only: no Possible Area effect is configured yet.
          </p>
        )}
        <PointPicker
          label={
            definition.parameterKind === "THERMOMETER"
              ? "Start point"
              : definition.parameterKind === "RADAR"
                ? "Radius centre"
                : definition.category === "TENTACLES"
                  ? "Tentacle centre"
                  : "Reference point"
          }
          point={effectivePointA}
          onMap={() => onPickFromMap("A")}
          onGps={() => useGps("A")}
        />
        {(definition.parameterKind === "RADAR" || definition.category === "TENTACLES") && (
          <label>
            Radius (metres)
            <input
              type="number"
              min={10}
              max={1000000}
              value={radiusMeters}
              onChange={(event) => setRadiusMeters(Number(event.target.value))}
              required
            />
          </label>
        )}
        {definition.parameterKind === "THERMOMETER" && (
          <>
            <PointPicker
              label="End point"
              point={effectivePointB}
              onMap={() => onPickFromMap("B")}
              onGps={() => useGps("B")}
            />
            <div className="geometry-legend" aria-label="Thermometer map legend">
              <span>
                <i className="legend-dot start" />
                Start / colder
              </span>
              <span>
                <i className="legend-dot end" />
                End / hotter
              </span>
              <span>
                <i className="legend-line" />
                Answer boundary
              </span>
            </div>
          </>
        )}
        {definition.parameterKind === "DATASET" && (
          <>
            <label>
              Dataset
              <select value={datasetId} onChange={(event) => setDatasetId(event.target.value)}>
                <option value="">Choose later</option>
                {datasets.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            {definition.category === "TENTACLES" ? (
              <p className="field-help">
                Active tentacles are places from this dataset within the chosen radius.
              </p>
            ) : !definition.exactRulePending ? (
              <p className="field-help">
                Every feature is treated as one map place. The question uses the nearest place
                inside the game boundary.
              </p>
            ) : null}
            {composerReferenceInfo?.placeName && (
              <p className="field-help">
                <strong>Nearest place:</strong> {composerReferenceInfo.placeName}
              </p>
            )}
            <label>
              Rule note (optional)
              <textarea
                value={note}
                onChange={(event) => setNote(event.target.value)}
                maxLength={500}
              />
            </label>
          </>
        )}

        <div className="sheet-actions">
          <button type="button" className="button secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            className="button primary"
            disabled={
              busy ||
              !effectivePointA ||
              (definition.parameterKind === "THERMOMETER" && !effectivePointB)
            }
          >
            {question ? "Save changes" : "Create draft"}
          </button>
        </div>
      </form>
    </aside>
  );
}

interface ActivityProps extends CommonProps {
  questions: QuestionInstance[];
  localPosition: [number, number] | null;
  onRequestGps: () => void;
  onEdit: (question: QuestionInstance) => void;
  onSelect: (id: string) => void;
}

export function QuestionActivitySidebar({
  state,
  token,
  refresh,
  onError,
  questions,
  localPosition,
  onRequestGps,
  onEdit,
  onSelect,
}: ActivityProps) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [mobileExpanded, setMobileExpanded] = useState(false);
  const primaryQuestion = questions[0]!;

  async function action(question: QuestionInstance, path: string, body: unknown = {}) {
    setBusyId(question.id);
    try {
      await post(`/api/questions/${question.id}/${path}`, body, token);
      onSelect(question.id);
      await refresh();
      onError(null);
    } catch (cause) {
      onError((cause as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <aside
      className={`question-sidebar sheet activity-sidebar ${mobileExpanded ? "is-expanded" : "is-collapsed"}`}
      aria-label="Open question"
    >
      <div className="sheet-header activity-desktop-header">
        <div>
          <p className="eyebrow">Current workflow</p>
          <h2>{questions.length === 1 ? "Open question" : `${questions.length} open questions`}</h2>
        </div>
      </div>
      <button
        type="button"
        className="activity-mobile-toggle"
        aria-expanded={mobileExpanded}
        aria-controls="active-question-content"
        onClick={() => setMobileExpanded((expanded) => !expanded)}
      >
        <span className="activity-mobile-copy">
          <span className="eyebrow">
            {questions.length === 1 ? "Current question" : `${questions.length} open questions`}
          </span>
          <span className="activity-mobile-summary">
            <span className={`status ${primaryQuestion.status.toLowerCase()}`}>
              {primaryQuestion.status}
            </span>
            <strong>{primaryQuestion.displayName}</strong>
          </span>
        </span>
        <span className="activity-mobile-chevron" aria-hidden="true">
          {mobileExpanded ? <ChevronDown /> : <ChevronUp />}
        </span>
      </button>
      <div className="activity-list" id="active-question-content">
        {questions.map((question) => {
          const definition = getQuestionDefinition(question.definitionId);
          const dataset = question.parameters?.datasetId
            ? state.datasets.find((item) => item.id === question.parameters.datasetId)
            : null;
          const canAnswer =
            question.status === "PENDING" &&
            (state.game.seekerOnly
              ? state.me.role === "SEEKER"
              : (state.game.hiderAssistance && state.me.role === "HIDER") ||
                (!state.game.hiderAssistance && state.me.role === "SEEKER"));
          const questionContext = {
            boundary: state.game.boundary,
            subdivisions: state.game.subdivisions,
            datasets: state.datasets,
          };
          const answers = getQuestionAnswers(definition, question.parameters, questionContext);
          const referenceInfo = getQuestionReferenceInfo(
            question.definitionId,
            question.parameters,
            questionContext,
          );
          let localEvaluation: ReturnType<typeof evaluateQuestionAtPosition> = null;
          if (state.me.role === "HIDER" && question.status === "PENDING") {
            try {
              localEvaluation = evaluateQuestionAtPosition(
                question.definitionId,
                question.parameters,
                localPosition,
                questionContext,
              );
            } catch {
              localEvaluation = null;
            }
          }
          return (
            <article
              className="active-question-card"
              key={question.id}
              onClick={() => onSelect(question.id)}
            >
              <div className="question-heading">
                <span className={`status ${question.status.toLowerCase()}`}>{question.status}</span>
                <span className="category">{question.category}</span>
              </div>
              <h3>{question.displayName}</h3>
              {dataset && (
                <p className="dataset-callout">
                  <strong>Selected places:</strong> {dataset.name}
                  {referenceInfo?.placeName && (
                    <>
                      <br />
                      <strong>Seeker's nearest place:</strong> {referenceInfo.placeName}
                    </>
                  )}
                </p>
              )}
              {!dataset && referenceInfo?.divisionName && (
                <p className="dataset-callout">
                  <strong>Seeker's division:</strong> {referenceInfo.divisionName}
                </p>
              )}
              <p className="question-prompt">
                {question.definitionId === "matching.dataset" && dataset
                  ? `Is your nearest ${dataset.name} place the same as the Seeker's nearest?`
                  : question.definitionId === "measuring.dataset" && dataset
                    ? `Compared with the Seeker, are you closer to or further from the nearest ${dataset.name} place?`
                    : question.definitionId === "tentacles.dataset" && dataset
                      ? `Which nearby place in ${dataset.name} within the radius is the Hider closest to, or are they outside?`
                      : definition.description}
              </p>
              {localEvaluation && (
                <div className={`local-evaluation ${!localPosition ? "missing-location" : ""}`}>
                  <strong>{localEvaluation.summary}</strong>
                  {localEvaluation.details.map((detail) => (
                    <span key={detail}>{detail}</span>
                  ))}
                  {localEvaluation.answer && (
                    <span className="suggested-answer">
                      Suggested answer:{" "}
                      {answers.find((option) => option.value === localEvaluation.answer)?.label ??
                        localEvaluation.answer}
                    </span>
                  )}
                  {!localPosition && (
                    <button className="button secondary small-button" onClick={onRequestGps}>
                      Use my location
                    </button>
                  )}
                </div>
              )}
              {!localEvaluation &&
                state.me.role === "HIDER" &&
                question.status === "PENDING" &&
                !localPosition && (
                  <div className="local-evaluation missing-location">
                    <strong>Location needed to check this answer.</strong>
                    <button className="button secondary small-button" onClick={onRequestGps}>
                      Use my location
                    </button>
                  </div>
                )}
              {question.answer && (
                <p className="answer">
                  Answer:{" "}
                  <strong>
                    {answers.find((option) => option.value === question.answer)?.label ??
                      question.answer}
                  </strong>
                </p>
              )}
              {question.status === "ANSWERED" && state.me.role === "SEEKER" && (
                <p className="apply-notice">
                  The answer area is previewed on the map. Apply it to update Possible Area.
                </p>
              )}
              {question.status === "PENDING" && !canAnswer && (
                <p className="waiting-copy">Waiting for the Hider's answer.</p>
              )}
              {question.status === "PENDING" && canAnswer && state.game.seekerOnly && (
                <p className="waiting-copy">Record the Hider's response received externally:</p>
              )}
              <div className="card-actions" onClick={(event) => event.stopPropagation()}>
                {state.me.role === "SEEKER" && question.status === "DRAFT" && (
                  <>
                    <button className="button subtle small-button" onClick={() => onEdit(question)}>
                      Edit
                    </button>
                    <button
                      className="button primary small-button"
                      disabled={busyId === question.id}
                      onClick={() => void action(question, "ask")}
                    >
                      <Send size={16} /> Ask
                    </button>
                  </>
                )}
                {canAnswer &&
                  answers.map((option) => (
                    <button
                      key={option.value}
                      className={
                        localEvaluation?.answer === option.value
                          ? "button primary small-button"
                          : "button answer-button"
                      }
                      disabled={busyId === question.id}
                      onClick={() => void action(question, "answer", { answer: option.value })}
                    >
                      {option.label}
                    </button>
                  ))}
                {state.me.role === "SEEKER" && question.status === "ANSWERED" && (
                  <button
                    className="button primary wide"
                    disabled={busyId === question.id}
                    onClick={() => void action(question, "apply")}
                  >
                    <Check size={17} /> Apply to Possible Area
                  </button>
                )}
              </div>
            </article>
          );
        })}
      </div>
    </aside>
  );
}

interface HistoryProps extends CommonProps {
  onClose: () => void;
  onSelect: (id: string) => void;
  onEdit: (question: QuestionInstance) => void;
}

export function QuestionHistory({
  state,
  token,
  refresh,
  onError,
  onClose,
  onSelect,
  onEdit,
}: HistoryProps) {
  const [busyId, setBusyId] = useState<string | null>(null);

  async function action(id: string, path: string, body: unknown = {}) {
    setBusyId(id);
    try {
      await post(`/api/questions/${id}/${path}`, body, token);
      await refresh();
      onError(null);
    } catch (cause) {
      onError((cause as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  async function toggle(question: QuestionInstance) {
    setBusyId(question.id);
    try {
      await patch(`/api/questions/${question.id}`, { enabled: !question.enabled }, token);
      await refresh();
    } catch (cause) {
      onError((cause as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  async function reviseAnswer(question: QuestionInstance, answer: string) {
    setBusyId(question.id);
    try {
      await patch(`/api/questions/${question.id}/answer`, { answer }, token);
      await refresh();
      onError(null);
    } catch (cause) {
      onError((cause as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  async function destroy(question: QuestionInstance) {
    if (!window.confirm(`Delete ${question.displayName}? The Possible Area will be recomputed.`))
      return;
    setBusyId(question.id);
    try {
      await remove(`/api/questions/${question.id}`, token);
      await refresh();
    } catch (cause) {
      onError((cause as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  const canAnswer = (question: QuestionInstance) =>
    question.status === "PENDING" &&
    (state.game.seekerOnly
      ? state.me.role === "SEEKER"
      : (state.game.hiderAssistance && state.me.role === "HIDER") ||
        (!state.game.hiderAssistance && state.me.role === "SEEKER"));

  return (
    <div className="modal-backdrop align-end" role="presentation">
      <section
        className="sheet history-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="history-title"
      >
        <div className="sheet-header">
          <div>
            <p className="eyebrow">Evidence log</p>
            <h2 id="history-title">Question history</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close">
            <X />
          </button>
        </div>
        <div className="history-list">
          {state.questions.length === 0 && (
            <div className="empty-state">
              <Clock3 />
              <p>No questions yet. Drafts are your planning mode.</p>
            </div>
          )}
          {state.questions.map((question) => {
            const definition = getQuestionDefinition(question.definitionId);
            const questionContext = {
              boundary: state.game.boundary,
              subdivisions: state.game.subdivisions,
              datasets: state.datasets,
            };
            const answers = getQuestionAnswers(definition, question.parameters, questionContext);
            const referenceInfo = getQuestionReferenceInfo(
              question.definitionId,
              question.parameters,
              questionContext,
            );
            return (
              <article
                key={question.id}
                className={`question-card ${question.enabled ? "" : "disabled"}`}
                onClick={() => onSelect(question.id)}
              >
                <div className="question-heading">
                  <span className={`status ${question.status.toLowerCase()}`}>
                    {question.status}
                  </span>
                  <span className="category">{question.category}</span>
                  {state.me.role === "SEEKER" && (
                    <button
                      className="icon-button small"
                      onClick={(event) => {
                        event.stopPropagation();
                        void toggle(question);
                      }}
                      aria-label={question.enabled ? "Disable question" : "Enable question"}
                    >
                      {question.enabled ? <Eye /> : <EyeOff />}
                    </button>
                  )}
                </div>
                <h3>{question.displayName}</h3>
                <p className="question-meta">
                  {question.askedByName ? `Asked by ${question.askedByName}` : "Not asked"}
                  {question.usageNumber > 0
                    ? ` · use ${question.usageNumber} · cost ${question.cost}`
                    : ""}
                  {question.askedAt
                    ? ` · ${new Date(question.askedAt).toLocaleString(undefined, {
                        dateStyle: "short",
                        timeStyle: "short",
                      })}`
                    : ""}
                  {referenceInfo?.placeName
                    ? ` · Seeker: ${referenceInfo.placeName}`
                    : referenceInfo?.divisionName
                      ? ` · Seeker: ${referenceInfo.divisionName}`
                      : ""}
                  {question.status === "APPLIED"
                    ? question.enabled
                      ? " · affects Possible Area"
                      : " · effect disabled"
                    : ""}
                </p>
                {question.answer && (
                  <p className="answer">
                    Answer:{" "}
                    <strong>
                      {answers.find((option) => option.value === question.answer)?.label ??
                        question.answer}
                    </strong>
                  </p>
                )}
                {definition.exactRulePending && (
                  <p className="pending-rule">Tracking only — exact geometric rule pending.</p>
                )}
                <div className="card-actions" onClick={(event) => event.stopPropagation()}>
                  {state.me.role === "SEEKER" && question.status !== "PENDING" && (
                    <button className="button subtle" onClick={() => onEdit(question)}>
                      Edit parameters
                    </button>
                  )}
                  {state.me.role === "SEEKER" && question.status === "DRAFT" && (
                    <>
                      <button
                        className="button primary small-button"
                        disabled={busyId === question.id}
                        onClick={() => void action(question.id, "ask")}
                      >
                        <Send size={16} />
                        Ask
                      </button>
                    </>
                  )}
                  {canAnswer(question) &&
                    answers.map((option) => (
                      <button
                        key={option.value}
                        className="button answer-button"
                        disabled={busyId === question.id}
                        onClick={() => void action(question.id, "answer", { answer: option.value })}
                      >
                        {option.label}
                      </button>
                    ))}
                  {state.me.role === "SEEKER" && question.status === "ANSWERED" && (
                    <button
                      className="button primary small-button"
                      disabled={busyId === question.id}
                      onClick={() => void action(question.id, "apply")}
                    >
                      <Check size={16} />
                      Apply
                    </button>
                  )}
                  {state.me.role === "SEEKER" && question.status === "APPLIED" && (
                    <button
                      className="button subtle"
                      disabled={busyId === question.id}
                      onClick={() => void action(question.id, "apply")}
                    >
                      Recompute
                    </button>
                  )}
                  {state.me.role === "SEEKER" &&
                    (question.status === "ANSWERED" || question.status === "APPLIED") &&
                    answers.map((option) => (
                      <button
                        key={`revise-${option.value}`}
                        className="text-button"
                        disabled={busyId === question.id || question.answer === option.value}
                        onClick={() => void reviseAnswer(question, option.value)}
                      >
                        Set {option.label}
                      </button>
                    ))}
                  {state.me.role === "SEEKER" && (
                    <button
                      className="icon-button danger small"
                      disabled={busyId === question.id}
                      onClick={() => void destroy(question)}
                      aria-label="Delete question"
                    >
                      <Trash2 />
                    </button>
                  )}
                </div>
              </article>
            );
          })}
        </div>
        <button className="button secondary wide" onClick={onClose}>
          Back to map <ChevronRight size={18} />
        </button>
      </section>
    </div>
  );
}

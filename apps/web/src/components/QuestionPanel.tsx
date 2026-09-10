import { useEffect, useState, type FormEvent } from "react";
import {
  Check,
  ChevronRight,
  Clock3,
  Eye,
  EyeOff,
  HelpCircle,
  Send,
  Trash2,
  X,
} from "lucide-react";
import {
  calculateQuestionCost,
  getQuestionDefinition,
  QUESTION_DEFINITIONS,
  type GameState,
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

  useEffect(() => {
    if (!pickedPoint) return;
    if (pickedPoint.target === "A") setPointA(pickedPoint.point);
    else setPointB(pickedPoint.point);
  }, [pickedPoint]);

  function useGps(target: "A" | "B") {
    if (!localPosition) return onRequestGps(target);
    if (target === "A") setPointA(localPosition);
    else setPointB(localPosition);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!pointA || (definition.parameterKind === "THERMOMETER" && !pointB)) {
      onError("Select the required point on the map first.");
      return;
    }
    let parameters: Record<string, unknown>;
    if (definition.parameterKind === "RADAR") parameters = { center: pointA, radiusMeters };
    else if (definition.parameterKind === "THERMOMETER")
      parameters = { start: pointA, end: pointB };
    else if (definition.parameterKind === "POINT") parameters = { referencePoint: pointA };
    else
      parameters = {
        referencePoint: pointA,
        ...(datasetId ? { datasetId } : {}),
        ...(note ? { note } : {}),
      };
    setBusy(true);
    try {
      if (question) await patch(`/api/questions/${question.id}`, { parameters }, token);
      else await post("/api/questions", { definitionId, parameters }, token);
      await refresh();
      onError(null);
      onClose();
    } catch (cause) {
      onError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (pickingFromMap) return null;

  return (
    <div className="modal-backdrop" role="presentation">
      <section
        className="sheet composer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="question-title"
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
              onChange={(event) => setDefinitionId(event.target.value)}
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
              {previousUses === 0
                ? "never"
                : `${previousUses} time${previousUses === 1 ? "" : "s"}`}
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
                  : "Reference point"
            }
            point={pointA}
            onMap={() => onPickFromMap("A")}
            onGps={() => useGps("A")}
          />
          {definition.parameterKind === "RADAR" && (
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
            <PointPicker
              label="End point"
              point={pointB}
              onMap={() => onPickFromMap("B")}
              onGps={() => useGps("B")}
            />
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
              disabled={busy || !pointA || (definition.parameterKind === "THERMOMETER" && !pointB)}
            >
              {question ? "Save changes" : "Create draft"}
            </button>
          </div>
        </form>
      </section>
    </div>
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
    ((state.game.hiderAssistance && state.me.role === "HIDER") ||
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
                      {definition.answers.find((option) => option.value === question.answer)
                        ?.label ?? question.answer}
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
                    definition.answers.map((option) => (
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
                    definition.answers.map((option) => (
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

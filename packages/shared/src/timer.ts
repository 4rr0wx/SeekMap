import type { GamePhase } from "./types.js";

export interface TimerState {
  phase: GamePhase;
  remainingSeconds: number;
  elapsedSeekingSeconds: number;
  transitionAt: string | null;
}

export function deriveTimer(
  phase: GamePhase,
  hidingDurationSeconds: number,
  phaseStartedAt: string | null,
  now = new Date(),
): TimerState {
  if (phase === "LOBBY" || !phaseStartedAt) {
    return {
      phase,
      remainingSeconds: hidingDurationSeconds,
      elapsedSeekingSeconds: 0,
      transitionAt: null,
    };
  }

  const startedMs = new Date(phaseStartedAt).getTime();
  const elapsed = Math.max(0, Math.floor((now.getTime() - startedMs) / 1000));

  if (phase === "HIDING") {
    const remainingSeconds = Math.max(0, hidingDurationSeconds - elapsed);
    if (remainingSeconds === 0) {
      const transitionAt = new Date(startedMs + hidingDurationSeconds * 1000).toISOString();
      const seekingElapsed = Math.max(
        0,
        Math.floor((now.getTime() - new Date(transitionAt).getTime()) / 1000),
      );
      return {
        phase: "SEEKING",
        remainingSeconds: 0,
        elapsedSeekingSeconds: seekingElapsed,
        transitionAt,
      };
    }
    return { phase, remainingSeconds, elapsedSeekingSeconds: 0, transitionAt: null };
  }

  return {
    phase,
    remainingSeconds: 0,
    elapsedSeekingSeconds: phase === "SEEKING" ? elapsed : 0,
    transitionAt: null,
  };
}

export function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return hours > 0
    ? [hours, minutes, remainder].map((part) => String(part).padStart(2, "0")).join(":")
    : [minutes, remainder].map((part) => String(part).padStart(2, "0")).join(":");
}

import { useCallback, useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import type { GameState, PublicConfig } from "@hideseek/shared";
import { currentGame, loadIdentity, publicConfig, saveIdentity, type Identity } from "./api";

export type GameSummary = {
  hasGame: boolean;
  game: null | {
    id: string;
    name: string;
    phase: string;
    lifecycle: string;
    hiderAssistance: boolean;
  };
};

export function useGameSession() {
  const [identity, setIdentityState] = useState<Identity | null>(() => loadIdentity());
  const [state, setState] = useState<GameState | null>(null);
  const [summary, setSummary] = useState<GameSummary | null>(null);
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refreshInFlight = useRef<Promise<void> | null>(null);
  const refreshQueued = useRef(false);

  const setIdentity = useCallback((value: Identity | null) => {
    saveIdentity(value);
    setIdentityState(value);
    if (!value) setState(null);
  }, []);

  const refresh = useCallback((): Promise<void> => {
    if (refreshInFlight.current) return refreshInFlight.current;

    const request = (async () => {
      try {
        const result = await currentGame(identity?.token);
        setError(null);
        if ("hasGame" in result) {
          setSummary(result as GameSummary);
          setState(null);
        } else {
          setState((current) =>
            !current ||
            current.game.id !== result.game.id ||
            result.game.revision >= current.game.revision
              ? result
              : current,
          );
          setSummary({ hasGame: true, game: result.game });
        }
      } catch (cause) {
        if (identity && (cause as Error).message.toLowerCase().includes("session")) {
          setIdentity(null);
          const result = (await currentGame()) as GameSummary;
          setSummary(result);
        } else {
          setError((cause as Error).message);
        }
      } finally {
        setLoading(false);
      }
    })();

    refreshInFlight.current = request;
    const settle = () => {
      if (refreshInFlight.current !== request) return;
      refreshInFlight.current = null;
      if (refreshQueued.current) {
        refreshQueued.current = false;
        void refresh();
      }
    };
    void request.then(settle, settle);
    return request;
  }, [identity, setIdentity]);

  useEffect(() => {
    void publicConfig()
      .then(setConfig)
      .catch((cause) => setError((cause as Error).message));
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void refresh();
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [refresh]);

  useEffect(() => {
    if (!identity || !state) return;
    const socket: Socket = io({
      auth: { token: identity.token },
      transports: ["websocket", "polling"],
    });
    socket.on("connect", () => {
      setConnected(true);
      void refresh();
    });
    socket.on("disconnect", () => setConnected(false));
    socket.on("state:changed", () => {
      if (refreshInFlight.current) refreshQueued.current = true;
      else void refresh();
    });
    socket.on("connect_error", () => setConnected(false));
    return () => {
      socket.disconnect();
    };
  }, [identity, state?.game.id, refresh]);

  return {
    identity,
    setIdentity,
    state,
    summary,
    config,
    loading,
    connected,
    error,
    setError,
    refresh,
  };
}

import { useCallback, useEffect, useState } from "react";
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

  const setIdentity = useCallback((value: Identity | null) => {
    saveIdentity(value);
    setIdentityState(value);
    if (!value) setState(null);
  }, []);

  const refresh = useCallback(async () => {
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
    socket.on("state:changed", () => void refresh());
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

import { useEffect, useState } from "react";
import {
  SEEKER_LOCATION_TTL_MS,
  type GamePhase,
  type PlayerRole,
  type SeekerLocation,
} from "@hideseek/shared";
import { api } from "./api";

export function useSeekerLocations(
  role: PlayerRole,
  gameId: string,
  phase: GamePhase,
  token: string,
  connected: boolean,
  onLocalPosition: (position: [number, number]) => void,
) {
  const ended = phase === "ENDED";
  const [sharing, setSharingState] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [locations, setLocations] = useState<Array<SeekerLocation & { expiresAt: number }>>([]);

  useEffect(() => {
    setSharingState(false);
    setLocations([]);
  }, [gameId, token]);

  useEffect(() => {
    if (ended) {
      setLocations([]);
      setSharingState(false);
      return;
    }
    let active = true;
    let fetching = false;
    const poll = async () => {
      if (fetching || document.visibilityState !== "visible") return;
      fetching = true;
      try {
        const result = await api<{ locations: SeekerLocation[]; serverNow: string }>(
          "/api/game/seeker-locations",
          { signal: AbortSignal.timeout(8_000) },
          token,
        );
        if (active)
          setLocations(
            result.locations.map((location) => ({
              ...location,
              expiresAt:
                Date.now() +
                SEEKER_LOCATION_TTL_MS -
                Math.max(0, Date.parse(result.serverNow) - Date.parse(location.updatedAt)),
            })),
          );
      } catch {
        /* Existing locations expire locally even while offline. */
      } finally {
        fetching = false;
      }
    };
    void poll();
    const polling = window.setInterval(() => void poll(), 5_000);
    const expiry = window.setInterval(
      () =>
        setLocations((current) =>
          current.every((location) => location.expiresAt > Date.now())
            ? current
            : current.filter((location) => location.expiresAt > Date.now()),
        ),
      1_000,
    );
    const visible = () => {
      if (document.visibilityState === "visible") void poll();
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      active = false;
      window.clearInterval(polling);
      window.clearInterval(expiry);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [gameId, ended, token, connected]);

  useEffect(() => {
    if (!sharing || role !== "SEEKER" || ended) return;
    if (!window.isSecureContext || !navigator.geolocation) {
      setMessage("Location sharing requires HTTPS and browser location permission.");
      setSharingState(false);
      return;
    }
    let stopped = false;
    let latest: GeolocationPosition | null = null;
    let sentAt = -Infinity;
    let sending: Promise<unknown> | null = null;
    setMessage("Waiting for your location…");
    const publish = () => {
      if (
        stopped ||
        sending ||
        !latest ||
        document.visibilityState !== "visible" ||
        Date.now() - sentAt < 10_000 ||
        Date.now() - latest.timestamp > 30_000
      )
        return;
      const position: [number, number] = [latest.coords.longitude, latest.coords.latitude];
      sentAt = Date.now();
      sending = api(
        "/api/game/seeker-location",
        {
          method: "PUT",
          signal: AbortSignal.timeout(8_000),
          body: JSON.stringify({ position, accuracyMeters: latest.coords.accuracy }),
        },
        token,
      )
        .then(() => {
          if (!stopped) setMessage("Sharing your position with all players.");
        })
        .catch(() => {
          if (!stopped)
            setMessage("Could not update your shared position. Retrying when connected.");
        })
        .finally(() => {
          sending = null;
        });
    };
    const watch = navigator.geolocation.watchPosition(
      (position) => {
        if (stopped) return;
        latest = position;
        onLocalPosition([position.coords.longitude, position.coords.latitude]);
        publish();
      },
      (error) => {
        if (stopped) return;
        setMessage(
          error.code === error.PERMISSION_DENIED
            ? "Location permission was denied. Enable it in your browser settings."
            : "GPS is unavailable. Waiting for a new position…",
        );
        if (error.code === error.PERMISSION_DENIED) setSharingState(false);
      },
      { enableHighAccuracy: true, maximumAge: 10_000, timeout: 15_000 },
    );
    const refresh = window.setInterval(publish, 10_000);
    document.addEventListener("visibilitychange", publish);
    return () => {
      stopped = true;
      navigator.geolocation.clearWatch(watch);
      window.clearInterval(refresh);
      document.removeEventListener("visibilitychange", publish);
      setStopping(true);
      // Clear only after an in-flight publish settles so disabling cannot leave a late position.
      void Promise.resolve(sending)
        .then(() =>
          api(
            "/api/game/seeker-location",
            { method: "DELETE", signal: AbortSignal.timeout(8_000) },
            token,
          ),
        )
        .catch(() =>
          setMessage("Stopped sending. The last shared position expires within 60 seconds."),
        )
        .finally(() => setStopping(false));
    };
  }, [sharing, role, gameId, ended, token, onLocalPosition]);

  return {
    locations,
    sharing: sharing && role === "SEEKER",
    stopping,
    message,
    setSharing: (enabled: boolean) => {
      setMessage(null);
      setSharingState(enabled);
    },
  };
}

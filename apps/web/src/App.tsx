import { AlertTriangle, LoaderCircle, X } from "lucide-react";
import { GameScreen } from "./components/GameScreen";
import { JoinGameScreen, NewGameScreen } from "./components/SetupScreens";
import { useGameSession } from "./useGameSession";

export function App() {
  const session = useGameSession();

  if (session.loading) {
    return (
      <main className="loading-screen">
        <LoaderCircle className="spin" />
        <p>Opening the investigation board…</p>
      </main>
    );
  }

  if (!session.config || !session.summary) {
    return (
      <main className="loading-screen error-screen">
        <AlertTriangle />
        <p>{session.error ?? "The HideSeek Atlas backend is unavailable."}</p>
        <button className="button primary" onClick={() => window.location.reload()}>
          Retry connection
        </button>
      </main>
    );
  }

  return (
    <>
      {session.error && (
        <div className="error-toast" role="alert">
          <AlertTriangle size={18} />
          <span>{session.error}</span>
          <button onClick={() => session.setError(null)} aria-label="Dismiss error">
            <X size={17} />
          </button>
        </div>
      )}
      {session.state && session.identity ? (
        <GameScreen
          state={session.state}
          config={session.config}
          token={session.identity.token}
          connected={session.connected}
          refresh={session.refresh}
          onIdentityCleared={() => session.setIdentity(null)}
          onError={session.setError}
        />
      ) : session.summary.hasGame ? (
        <JoinGameScreen
          summary={session.summary}
          onJoined={session.setIdentity}
          onError={session.setError}
        />
      ) : (
        <NewGameScreen
          config={session.config}
          onCreated={session.refresh}
          onError={session.setError}
        />
      )}
    </>
  );
}

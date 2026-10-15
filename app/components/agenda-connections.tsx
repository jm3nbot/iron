"use client";

import { useState } from "react";
import { AgendaDialog } from "./agenda-dialog";
import { QuercusSettings, type QuercusAgenda } from "./quercus-agenda";

export type GoogleConnectionState = {
  configured: boolean; connected: boolean; calendarEmail: string; loading: boolean; ready: boolean;
  error: string; needsReconnect: boolean; tasksError: string; tasksNeedReconnect: boolean; tasksApiDisabled: boolean;
};

export function AgendaConnections({ google, quercus, refreshGoogle, connectGoogle, disconnectGoogle }: {
  google: GoogleConnectionState; quercus: QuercusAgenda;
  refreshGoogle: () => Promise<void>; connectGoogle: () => Promise<void>; disconnectGoogle: () => Promise<void>;
}) {
  const [tab, setTab] = useState<"google" | "quercus" | null>(null);
  const googleError = google.error || google.tasksError || (google.needsReconnect || google.tasksNeedReconnect ? "Reconnect Google to resume syncing." : "");
  const status = (ready: boolean, connected: boolean, loading: boolean, error: string) =>
    error ? "Needs attention" : !ready ? "Checking connection" : connected ? loading ? "Connected · Refreshing" : "Connected" : "Not connected";
  return <>
    <div className="agenda-connections-bar" aria-label="Calendar connections">
      {(["google", "quercus"] as const).map((provider) => {
        const connection = provider === "google" ? google : quercus;
        const error = provider === "google" ? googleError : quercus.error;
        const name = provider === "google" ? "Google" : "Quercus";
        const label = status(connection.ready, connection.connected, connection.loading, error);
        return <button key={provider} type="button" className="connection-pill" onClick={() => setTab(provider)}
          title={`${name}: ${label}`} aria-label={`${name} connection settings`} aria-haspopup="dialog" aria-expanded={tab === provider}>
          <strong>{name}</strong>
          <i role="img" className={`connection-dot ${error ? "attention" : connection.connected ? "connected" : !connection.ready ? "checking" : ""}`} aria-label={label} />
          <svg className="connection-chevron" aria-hidden="true" width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="m3 4.5 3 3 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>;
      })}
    </div>
    {tab && <AgendaDialog title="Calendar connections" className="connections-dialog" onClose={() => setTab(null)}>
      <div className="connection-tabs" role="tablist" aria-label="Connection providers">
        {(["google", "quercus"] as const).map((provider) => <button key={provider} id={`connection-tab-${provider}`} type="button" role="tab"
          aria-selected={tab === provider} aria-controls={`connection-panel-${provider}`}
          onClick={() => setTab(provider)} onKeyDown={(event) => {
            if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
              event.preventDefault(); const next = provider === "google" ? "quercus" : "google";
              setTab(next); document.getElementById(`connection-tab-${next}`)?.focus();
            }
          }} tabIndex={tab === provider ? 0 : -1}>{provider === "google" ? "Google" : "Quercus"}</button>)}
      </div>
      <div role="tabpanel" id={`connection-panel-${tab}`} aria-labelledby={`connection-tab-${tab}`}>
        {tab === "quercus" ? <QuercusSettings agenda={quercus} /> : <div className="connection-settings">
          <div className="connection-identity"><span className="provider-mark">G</span><div><strong>Google</strong><p>{google.calendarEmail || "Calendar events and scheduled tasks"}</p></div></div>
          <p className="connection-state-label">{status(google.ready, google.connected, google.loading, googleError)}</p>
          <div className="connection-actions">
            {google.connected && <button type="button" disabled={google.loading} onClick={() => void refreshGoogle()}>{google.loading ? "Refreshing…" : "Refresh Google"}</button>}
            {(!google.connected || google.needsReconnect || google.tasksNeedReconnect) && <button type="button" disabled={google.loading || !google.ready} onClick={() => void connectGoogle()}>{google.needsReconnect || google.tasksNeedReconnect ? "Reconnect Google" : "Connect Google"}</button>}
            {google.connected && <button type="button" className="connection-disconnect" disabled={google.loading} onClick={() => void disconnectGoogle()}>Disconnect Google</button>}
          </div>
          {googleError && <p className="connection-error" role="status">{googleError}</p>}
          {google.tasksApiDisabled && <a className="connection-help" href="https://console.cloud.google.com/apis/library/tasks.googleapis.com" target="_blank" rel="noreferrer">Enable Google Tasks API ↗</a>}
          {!google.configured && <p className="connection-error">Google connection setup is required on the server.</p>}
        </div>}
      </div>
    </AgendaDialog>}
  </>;
}

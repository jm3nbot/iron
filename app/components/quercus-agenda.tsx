"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { quercusDate, quercusLink, quercusComplete, quercusStatus, type QuercusEntry } from "@/lib/quercus-agenda";

type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type State = {
  configured: boolean; connected: boolean; entries: QuercusEntry[]; canvasUserId: string;
  canvasName: string; connectionId: string; lastSynced: string; error: string; needsReconnect: boolean;
};
const empty: State = { configured: true, connected: false, entries: [], canvasUserId: "", canvasName: "", connectionId: "", lastSynced: "", error: "", needsReconnect: false };

export function useQuercusAgenda(month: Date, authenticatedFetch: Fetch, active = true) {
  const [state, setState] = useState<State>(empty);
  const [loading, setLoading] = useState(false);
  const [ready, setReady] = useState(false);
  const [showCompleted, setShowCompleted] = useState(true);
  const generation = useRef(0);
  const mutating = useRef(false);
  const refreshPending = useRef(false);
  const mounted = useRef(true);
  const year = month.getFullYear();
  const monthNumber = month.getMonth();
  const refresh = useCallback(async () => {
    if (mutating.current) { refreshPending.current = true; return; }
    const id = ++generation.current;
    setLoading(true);
    // Cover the complete six-week calendar grid, including adjacent months.
    const first = new Date(year, monthNumber, 1);
    first.setDate(first.getDate() - (first.getDay() + 6) % 7);
    const last = new Date(first); last.setDate(last.getDate() + 41);
    const localDate = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    try {
      const response = await authenticatedFetch(`/api/calendar/quercus?from=${localDate(first)}&to=${localDate(last)}`, { cache: "no-store" });
      const result = await response.json();
      if (id !== generation.current) return;
      if (!response.ok) {
        setState((current) => ({ ...current, error: result.error || "Quercus could not refresh. Loaded entries may be out of date.", needsReconnect: Boolean(result.needsReconnect) }));
        return;
      }
      setState((current) => ({ ...empty, ...result, entries: result.connected ? mergeQuercusEntries(current, result) : [] }));
    } catch {
      if (id === generation.current) setState((current) => ({ ...current, error: "Quercus could not refresh. Loaded entries may be out of date." }));
    } finally { if (id === generation.current) { setLoading(false); setReady(true); } }
  }, [authenticatedFetch, year, monthNumber]);

  const latestRefresh = useRef(refresh);
  useEffect(() => { latestRefresh.current = refresh; }, [refresh]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; generation.current += 1; };
  }, []);
  useEffect(() => {
    if (!active) return;
    const frame = requestAnimationFrame(() => { void refresh(); });
    const focus = () => { void refresh(); };
    window.addEventListener("focus", focus);
    return () => { cancelAnimationFrame(frame); window.removeEventListener("focus", focus); generation.current += 1; };
  }, [refresh, active]);

  const mutate = async (method: string, body?: object, endpoint = "/api/calendar/quercus") => {
    if (mutating.current) return false;
    mutating.current = true;
    generation.current += 1;
    setLoading(true);
    try {
      const response = await authenticatedFetch(endpoint, {
        method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined,
      });
      const result = await response.json();
      if (!mounted.current) return false;
      if (!response.ok) throw new Error(result.error || "Quercus could not save your change.");
      setState((current) => endpoint.endsWith("/completion")
        ? { ...current, error: "", entries: current.entries.map((entry) => entry.assignmentId === (body as { assignmentId: string }).assignmentId ? { ...entry, localCompleted: result.completed } : entry) }
        : { ...empty });
      return true;
    } catch (error) {
      if (mounted.current) setState((current) => ({ ...current, error: error instanceof Error ? error.message : "Quercus could not save your change." }));
      return false;
    } finally {
      mutating.current = false;
      if (mounted.current) setLoading(false);
      if (refreshPending.current && mounted.current) {
        refreshPending.current = false;
        void latestRefresh.current();
      }
    }
  };
  const connect = async (token: string) => { if (await mutate("POST", { token })) { await latestRefresh.current(); return true; } return false; };
  const disconnect = () => mutate("DELETE");
  const complete = async (entry: QuercusEntry, completed: boolean) => {
    if (mutating.current) return false;
    setState((current) => ({ ...current, entries: current.entries.map((item) => item.id === entry.id ? { ...item, localCompleted: completed } : item) }));
    const saved = await mutate("POST", {
      assignmentId: entry.assignmentId, connectionId: state.connectionId, completed,
    }, "/api/calendar/quercus/completion");
    if (!saved && mounted.current) setState((current) => ({ ...current, entries: current.entries.map((item) => item.id === entry.id ? { ...item, localCompleted: entry.localCompleted } : item) }));
    return saved;
  };
  const visible = useMemo(() => state.entries.filter((entry) => showCompleted || !quercusComplete(entry))
    .sort((a, b) => Number(quercusComplete(a)) - Number(quercusComplete(b)) || (a.start ?? "").localeCompare(b.start ?? "") || a.title.localeCompare(b.title)), [state.entries, showCompleted]);
  const byDate = useMemo(() => {
    const grouped = new Map<string, QuercusEntry[]>();
    for (const entry of visible) {
      if (!entry.start) continue;
      const date = quercusDate(entry.start);
      grouped.set(date, [...(grouped.get(date) ?? []), entry]);
    }
    return grouped;
  }, [visible]);
  return { ...state, loading, ready, refresh, connect, disconnect, complete, showCompleted, setShowCompleted, visible, byDate };
}

export function mergeQuercusEntries(current: Pick<State, "canvasUserId" | "entries">, next: { canvasUserId: string; entries: QuercusEntry[]; failedSources?: string[] }) {
  const failed = new Set(next.failedSources);
  const retained = current.canvasUserId === next.canvasUserId ? current.entries.filter((entry) => failed.has(entry.source)) : [];
  return [...new Map([...retained, ...next.entries].map((entry) => [entry.id, entry])).values()];
}

export type QuercusAgenda = ReturnType<typeof useQuercusAgenda>;
function plainDescription(html: string) {
  const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<\/?(?:p|div|br|li)\b[^>]*>/gi, "\n").replace(/<[^>]*>/g, "")
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, name: string) => entities[name]).trim();
}
export function QuercusSettings({ agenda }: { agenda: QuercusAgenda }) {
  const [editing, setEditing] = useState(false);
  const [token, setToken] = useState("");
  return <div className="connection-settings">
    <div className="connection-identity"><span className="provider-mark">Q</span><div><strong>Quercus</strong><p>{agenda.connected ? agenda.canvasName : "Your UofT courses and assignments"}</p></div></div>
    <p className="connection-state-label">{agenda.error ? "Needs attention" : !agenda.ready ? "Checking connection…" : agenda.connected ? agenda.loading ? "Connected · Refreshing" : "Connected" : "Not connected"}</p>
    <div className="connection-actions">
      {agenda.connected ? <>
        <button type="button" disabled={agenda.loading} onClick={() => void agenda.refresh()}>{agenda.loading ? "Syncing…" : "Refresh Quercus"}</button>
        <button type="button" disabled={agenda.loading} onClick={() => setEditing(!editing)}>{agenda.needsReconnect ? "Reconnect Quercus" : "Replace token"}</button>
        <button type="button" disabled={agenda.loading} onClick={() => { setEditing(false); setToken(""); void agenda.disconnect(); }}>Disconnect Quercus</button>
        <label><input type="checkbox" checked={agenda.showCompleted} onChange={(event) => agenda.setShowCompleted(event.target.checked)} /> Show completed & submitted</label>
      </> : <button type="button" disabled={agenda.loading || !agenda.ready} onClick={() => setEditing(!editing)}>Connect Quercus</button>}
      {agenda.lastSynced && <small className="connection-sync-time">Last synced {new Date(agenda.lastSynced).toLocaleString()}</small>}
    </div>
    {editing && <form className="quercus-connect-form" onSubmit={async (event) => {
      event.preventDefault();
      const value = token; setToken("");
      if (await agenda.connect(value)) setEditing(false);
    }}>
      <p>In Quercus: Account → Settings → Approved Integrations → New Access Token. This connects your personal account.</p>
      {!agenda.configured && <p role="status">Server setup is required: configure the encryption secret and your Ink &amp; Iron account ID.</p>}
      <label>Quercus access token<input type="password" autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)} required maxLength={4096} /></label>
      <button type="submit" disabled={agenda.loading || !agenda.configured || !token.trim()}>Connect securely</button>
      <button type="button" onClick={() => { setEditing(false); setToken(""); }}>Cancel</button>
    </form>}
    {agenda.error && <p className="quercus-notice" role="status">{agenda.error} {agenda.entries.length > 0 && "Loaded entries may be out of date."}</p>}
  </div>;
}

export function quercusWhen(entry: QuercusEntry) {
  if (!entry.start) return "No due date";
  if (entry.allDay) return new Date(`${quercusDate(entry.start)}T12:00:00`).toLocaleDateString("en-CA", { month: "short", day: "numeric" });
  return new Date(entry.start).toLocaleString("en-CA", { timeZone: "America/Toronto", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function QuercusEntries({ entries, onSelect, title }: { entries: QuercusEntry[]; onSelect: (id: string) => void; title: string }) {
  if (!entries.length) return null;
  return <section className="quercus-entries" aria-label={title}>
    <h3>{title}<span>{entries.length}</span></h3>
    {entries.map((entry) => <button type="button" key={entry.id} className={`quercus-entry-row ${quercusComplete(entry) ? "is-complete" : ""}`} onClick={() => onSelect(entry.id)}>
      <span className="quercus-entry-mark" aria-hidden="true">{quercusComplete(entry) ? "✓" : "Q"}</span>
      <span className="quercus-entry-copy"><strong>{entry.title}</strong><small>{entry.course}</small>
        <time dateTime={entry.start ?? undefined}>{quercusWhen(entry)}</time>
        <span className="quercus-entry-status">{quercusStatus(entry)}</span>
      </span>
      <span className="entry-open" aria-hidden="true">↗</span>
    </button>)}
  </section>;
}

export function QuercusDetails({ entry, agenda }: { entry: QuercusEntry; agenda: QuercusAgenda }) {
  return <div className="quercus-details">
    <div className="quercus-detail-course">{entry.course}</div>
    <h2 className={quercusComplete(entry) ? "is-complete" : ""}>{entry.title}</h2>
    <div className="quercus-detail-meta">
      <div><span>{entry.kind === "assignment" ? "Due" : "When"}</span><strong>{quercusWhen(entry)}{entry.start && !entry.allDay ? " · Toronto" : ""}</strong></div>
      <div><span>Quercus status</span><strong>{quercusStatus(entry)}{entry.late ? " · Late" : ""}{entry.missing ? " · Missing" : ""}</strong></div>
      {entry.submittedAt && <div><span>Submitted</span><strong>{new Date(entry.submittedAt).toLocaleString("en-CA", { timeZone: "America/Toronto" })} · Toronto</strong></div>}
    </div>
    {entry.description && <p className="quercus-description">{plainDescription(entry.description)}</p>}
    <footer>
      {entry.assignmentId && <label><input type="checkbox" disabled={agenda.loading} checked={entry.localCompleted} onChange={(event) => void agenda.complete(entry, event.target.checked)} /> Done in Ink &amp; Iron</label>}
      {quercusLink(entry.htmlLink) && <a href={quercusLink(entry.htmlLink)} target="_blank" rel="noreferrer">Open in Quercus <span aria-hidden="true">↗</span></a>}
    </footer>
    {agenda.error && <p className="connection-error" role="status">{agenda.error}</p>}
  </div>;
}

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { quercusDate, quercusLink, type QuercusEntry } from "@/lib/quercus-agenda";

type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type State = {
  configured: boolean; connected: boolean; entries: QuercusEntry[]; canvasUserId: string;
  canvasName: string; connectionId: string; lastSynced: string; error: string; needsReconnect: boolean;
};
const empty: State = { configured: true, connected: false, entries: [], canvasUserId: "", canvasName: "", connectionId: "", lastSynced: "", error: "", needsReconnect: false };

export function useQuercusAgenda(month: Date, authenticatedFetch: Fetch) {
  const [state, setState] = useState<State>(empty);
  const [loading, setLoading] = useState(false);
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
    } finally { if (id === generation.current) setLoading(false); }
  }, [authenticatedFetch, year, monthNumber]);

  const latestRefresh = useRef(refresh);
  useEffect(() => { latestRefresh.current = refresh; }, [refresh]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; generation.current += 1; };
  }, []);
  useEffect(() => {
    const frame = requestAnimationFrame(() => { void refresh(); });
    const focus = () => { void refresh(); };
    window.addEventListener("focus", focus);
    return () => { cancelAnimationFrame(frame); window.removeEventListener("focus", focus); generation.current += 1; };
  }, [refresh]);

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
  const visible = useMemo(() => state.entries.filter((entry) => showCompleted || !entry.localCompleted), [state.entries, showCompleted]);
  const byDate = useMemo(() => {
    const grouped = new Map<string, QuercusEntry[]>();
    for (const entry of visible) {
      if (!entry.start) continue;
      const date = quercusDate(entry.start);
      grouped.set(date, [...(grouped.get(date) ?? []), entry]);
    }
    return grouped;
  }, [visible]);
  return { ...state, loading, refresh, connect, disconnect, complete, showCompleted, setShowCompleted, visible, byDate };
}

export function mergeQuercusEntries(current: Pick<State, "canvasUserId" | "entries">, next: { canvasUserId: string; entries: QuercusEntry[]; failedSources?: string[] }) {
  const failed = new Set(next.failedSources);
  const retained = current.canvasUserId === next.canvasUserId ? current.entries.filter((entry) => failed.has(entry.source)) : [];
  return [...new Map([...retained, ...next.entries].map((entry) => [entry.id, entry])).values()];
}

type QuercusAgenda = ReturnType<typeof useQuercusAgenda>;
function plainDescription(html: string) {
  const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<\/?(?:p|div|br|li)\b[^>]*>/gi, "\n").replace(/<[^>]*>/g, "")
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, name: string) => entities[name]).trim();
}
export function QuercusControls({ agenda }: { agenda: QuercusAgenda }) {
  const [editing, setEditing] = useState(false);
  const [token, setToken] = useState("");
  return <div className="quercus-controls">
    <div className="quercus-toolbar">
      {agenda.connected ? <>
        <span>Quercus · {agenda.canvasName}</span>
        <button type="button" disabled={agenda.loading} onClick={() => void agenda.refresh()}>{agenda.loading ? "Syncing…" : "Refresh Quercus"}</button>
        <button type="button" disabled={agenda.loading} onClick={() => setEditing(!editing)}>{agenda.needsReconnect ? "Reconnect Quercus" : "Replace token"}</button>
        <button type="button" disabled={agenda.loading} onClick={() => { setEditing(false); setToken(""); void agenda.disconnect(); }}>Disconnect Quercus</button>
        <label><input type="checkbox" checked={agenda.showCompleted} onChange={(event) => agenda.setShowCompleted(event.target.checked)} /> Show locally completed</label>
      </> : <button type="button" disabled={agenda.loading} onClick={() => setEditing(!editing)}>Connect Quercus</button>}
      {agenda.lastSynced && <small>Last synced {new Date(agenda.lastSynced).toLocaleString()}</small>}
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

export function QuercusEntries({ entries, agenda, title }: { entries: QuercusEntry[]; agenda: QuercusAgenda; title: string }) {
  if (!entries.length) return null;
  return <section className="quercus-entries" aria-label={title}>
    <h3>{title}</h3>
    {entries.map((entry) => <details key={entry.id} className={entry.localCompleted ? "locally-completed" : ""}>
      <summary><strong>{entry.title}</strong><small>{entry.course} · {entry.kind === "assignment" ? entry.excused ? "Excused" : entry.submissionState.replaceAll("_", " ") : "Event"}</small></summary>
      {entry.start && <p>{entry.allDay ? `${quercusDate(entry.start)} · All day` : `${new Date(entry.start).toLocaleString("en-CA", { timeZone: "America/Toronto" })} (Toronto)`}</p>}
      {entry.kind === "assignment" && <p>Quercus: {entry.excused ? "Excused" : entry.submissionState.replaceAll("_", " ")}{entry.late ? " · Late" : ""}{entry.missing ? " · Missing" : ""}
        {entry.submittedAt && ` · Submitted ${new Date(entry.submittedAt).toLocaleString()}`}</p>}
      {entry.description && <p className="quercus-description">{plainDescription(entry.description)}</p>}
      {entry.assignmentId && <label><input type="checkbox" disabled={agenda.loading} checked={entry.localCompleted} onChange={(event) => void agenda.complete(entry, event.target.checked)} /> Done in Ink &amp; Iron</label>}
      {quercusLink(entry.htmlLink) && <a href={quercusLink(entry.htmlLink)} target="_blank" rel="noreferrer">Open in Quercus ↗</a>}
    </details>)}
  </section>;
}

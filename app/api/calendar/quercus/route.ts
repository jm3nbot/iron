import { authFailed, requireUser } from "@/lib/server-supabase";
import { loadQuercusAgenda, QuercusError, quercusRead } from "@/lib/quercus-agenda";
import { decryptQuercusToken, encryptQuercusToken, quercusConfig } from "@/lib/quercus-credentials";

export const dynamic = "force-dynamic";
function json(value: unknown, status = 200) {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
}
function failure(error: unknown) {
  return json({ error: error instanceof QuercusError ? error.message : "Quercus could not sync. Please try again.",
    needsReconnect: error instanceof QuercusError && error.status === 401 }, error instanceof QuercusError ? (error.status === 401 ? 422 : error.status) : 502);
}

export async function POST(request: Request) {
  const auth = await requireUser(request);
  if (authFailed(auth)) return auth.response;
  const config = quercusConfig();
  if (!config.configured) return json({ error: "Quercus needs its server encryption secret and personal account configured." }, 503);
  if (config.owner !== auth.user.id) return json({ error: "This personal connection is not enabled for your account." }, 403);
  let token: string;
  try {
    const body = await request.json();
    token = typeof body.token === "string" ? body.token.trim() : "";
    if (!token || token.length > 4096 || /\s/.test(token)) return json({ error: "Enter a valid Quercus access token." }, 400);
  } catch { return json({ error: "Enter a valid Quercus access token." }, 400); }
  try {
    const identity = await quercusRead<{ id: number; name?: string }>("/api/v1/users/self/profile", token);
    if (!identity.id) return json({ error: "Quercus could not verify your account." }, 422);
    const { error } = await auth.supabase.from("quercus_connections").upsert({
      user_id: auth.user.id, canvas_user_id: String(identity.id), canvas_name: identity.name ?? "Quercus",
      token_encrypted: await encryptQuercusToken(token, config.secret, auth.user.id),
      connection_id: crypto.randomUUID(), updated_at: new Date().toISOString(), last_synced_at: null,
    });
    if (error) return json({ error: "Your Quercus connection could not be saved. Check database setup." }, 500);
    return json({ connected: true });
  } catch (error) { return failure(error); }
}

export async function GET(request: Request) {
  const auth = await requireUser(request);
  if (authFailed(auth)) return auth.response;
  const config = quercusConfig();
  if (!config.configured || config.owner !== auth.user.id) return json({ configured: false, connected: false, entries: [] });
  const params = new URL(request.url).searchParams;
  const from = params.get("from") ?? "";
  const to = params.get("to") ?? "";
  const validDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
  if (!validDate(from) || !validDate(to) || from > to || Date.parse(to) - Date.parse(from) > 93 * 86400000) return json({ error: "Select a valid date range of up to 93 days." }, 400);
  const { data: connection, error } = await auth.supabase.from("quercus_connections")
    .select("token_encrypted, canvas_user_id, canvas_name, last_synced_at, connection_id").eq("user_id", auth.user.id).maybeSingle();
  if (error) return json({ error: "Quercus storage is unavailable. Check database setup." }, 500);
  if (!connection) return json({ configured: true, connected: false, entries: [] });
  try {
    const token = await decryptQuercusToken(connection.token_encrypted, config.secret, auth.user.id);
    const result = await loadQuercusAgenda(token, from, to, fetch, connection.canvas_user_id);
    const completed = new Set<string>();
    for (let offset = 0; ; offset += 500) {
      const { data: completions, error: completionError } = await auth.supabase.from("quercus_completions")
        .select("assignment_id").eq("user_id", auth.user.id).eq("canvas_user_id", connection.canvas_user_id)
        .order("assignment_id").range(offset, offset + 499);
      if (completionError) return json({ error: "Your Quercus completion records could not load." }, 500);
      for (const item of completions ?? []) completed.add(item.assignment_id);
      if (!completions || completions.length < 500) break;
    }
    let lastSynced = connection.last_synced_at;
    if (!result.failedSources.length) {
      lastSynced = new Date().toISOString();
      // Prevent an in-flight sync from resurrecting a deleted or replaced connection.
      const { error: syncError } = await auth.supabase.from("quercus_connections").update({ last_synced_at: lastSynced })
        .eq("user_id", auth.user.id).eq("connection_id", connection.connection_id);
      if (syncError) return json({ error: "Quercus sync time could not be saved." }, 500);
    }
    return json({ configured: true, connected: true, canvasUserId: connection.canvas_user_id,
      canvasName: connection.canvas_name, connectionId: connection.connection_id, lastSynced,
      ...result, entries: result.entries.map((entry) => ({ ...entry, localCompleted: Boolean(entry.assignmentId && completed.has(entry.assignmentId)) })),
      error: result.needsReconnect ? "Your Quercus token has expired or was revoked. Replace it to reconnect."
        : result.failedSources.length ? "Some Quercus data could not refresh. Previously loaded entries for those sources may be out of date. Try refreshing again." : "",
    });
  } catch (error) { return failure(error); }
}

export async function DELETE(request: Request) {
  const auth = await requireUser(request);
  if (authFailed(auth)) return auth.response;
  const { error } = await auth.supabase.from("quercus_connections").delete().eq("user_id", auth.user.id);
  return error ? json({ error: "Quercus could not disconnect. Try again." }, 500) : json({ connected: false });
}

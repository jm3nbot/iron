import { authFailed, requireUser } from "@/lib/server-supabase";
import { quercusConfig } from "@/lib/quercus-credentials";

export async function POST(request: Request) {
  const auth = await requireUser(request);
  if (authFailed(auth)) return auth.response;
  const config = quercusConfig();
  if (!config.configured || config.owner !== auth.user.id) return Response.json({ error: "Quercus is not enabled for this account." }, { status: 403 });
  let payload;
  try { payload = await request.json(); } catch { return Response.json({ error: "Invalid completion." }, { status: 400 }); }
  if (!payload || !/^\d+$/.test(String(payload.assignmentId)) || typeof payload.completed !== "boolean" || typeof payload.connectionId !== "string") {
    return Response.json({ error: "Invalid completion." }, { status: 400 });
  }
  const { data: connection, error } = await auth.supabase.from("quercus_connections")
    .select("canvas_user_id, connection_id").eq("user_id", auth.user.id).maybeSingle();
  if (error || !connection || connection.connection_id !== payload.connectionId) {
    return Response.json({ error: "Refresh your Quercus connection before changing completion." }, { status: 409 });
  }
  const identity = { user_id: auth.user.id, canvas_user_id: connection.canvas_user_id, assignment_id: String(payload.assignmentId) };
  const result = payload.completed
    ? await auth.supabase.from("quercus_completions").upsert(identity)
    : await auth.supabase.from("quercus_completions").delete().match(identity);
  if (result.error) return Response.json({ error: "Completion could not be saved. Try again." }, { status: 500 });
  return Response.json({ completed: payload.completed }, { headers: { "Cache-Control": "no-store" } });
}

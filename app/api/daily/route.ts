import { createClient, type SupabaseClient, type User } from "@supabase/supabase-js";
import { supabasePublishableKey, supabaseUrl } from "@/lib/supabase-config";

export const dynamic = "force-dynamic";

type DailyRow = {
  id: string;
  content: string;
  note: string;
  links: string[];
  weekday_mask: number;
  start_date: string | null;
  end_date: string | null;
  position: number;
  archived: boolean;
  created_at: string;
  updated_at: string;
};

type CompletionRow = {
  daily_id: string;
  completion_date: string;
  completed_at: string;
};

function toDailyItem(row: DailyRow) {
  return {
    id: row.id,
    content: row.content,
    note: row.note,
    links: row.links ?? [],
    weekdayMask: row.weekday_mask,
    startDate: row.start_date,
    endDate: row.end_date,
    position: row.position,
    archived: row.archived,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toCompletion(row: CompletionRow) {
  return {
    dailyId: row.daily_id,
    completionDate: row.completion_date,
    completedAt: row.completed_at,
  };
}

function cleanLinks(value: unknown) {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .filter((link): link is string => typeof link === "string")
        .map((link) => link.trim())
        .filter(Boolean),
    ),
  ];
}

function cleanDate(value: unknown) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? value
    : null;
}

async function requireUser(
  request: Request,
): Promise<
  | { supabase: SupabaseClient; user: User; response?: never }
  | { response: Response; supabase?: never; user?: never }
> {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) {
    return { response: Response.json({ error: "Sign in to continue." }, { status: 401 }) };
  }
  const supabase = createClient(supabaseUrl, supabasePublishableKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) {
    return { response: Response.json({ error: "Your session has expired." }, { status: 401 }) };
  }
  return { supabase, user };
}

export async function GET(request: Request) {
  const auth = await requireUser(request);
  if (auth.response) return auth.response;

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 370);
  const cutoffKey = cutoff.toISOString().slice(0, 10);
  const [itemsResult, completionsResult] = await Promise.all([
    auth.supabase
      .from("daily_items")
      .select("*")
      .eq("archived", false)
      .order("position")
      .order("created_at"),
    auth.supabase
      .from("daily_completions")
      .select("daily_id, completion_date, completed_at")
      .gte("completion_date", cutoffKey)
      .order("completion_date"),
  ]);

  if (itemsResult.error || completionsResult.error) {
    return Response.json(
      { error: itemsResult.error?.message ?? completionsResult.error?.message },
      { status: 500 },
    );
  }

  return Response.json({
    items: (itemsResult.data as DailyRow[]).map(toDailyItem),
    completions: (completionsResult.data as CompletionRow[]).map(toCompletion),
  });
}

export async function POST(request: Request) {
  const auth = await requireUser(request);
  if (auth.response) return auth.response;
  const payload = (await request.json()) as Record<string, unknown>;
  const action = payload.action === "complete" ? "complete" : "create";

  if (action === "complete") {
    const dailyId = typeof payload.dailyId === "string" ? payload.dailyId : "";
    const completionDate = cleanDate(payload.completionDate);
    if (!dailyId || !completionDate) {
      return Response.json({ error: "Missing daily item or date." }, { status: 400 });
    }
    const { data, error } = await auth.supabase
      .from("daily_completions")
      .insert({ daily_id: dailyId, user_id: auth.user.id, completion_date: completionDate })
      .select("daily_id, completion_date, completed_at")
      .single();
    if (error?.code === "23505") {
      const { data: existing, error: existingError } = await auth.supabase
        .from("daily_completions")
        .select("daily_id, completion_date, completed_at")
        .eq("daily_id", dailyId)
        .eq("completion_date", completionDate)
        .single();
      if (existingError) return Response.json({ error: existingError.message }, { status: 500 });
      return Response.json({ completion: toCompletion(existing as CompletionRow) }, { status: 200 });
    }
    if (error) return Response.json({ error: error.message }, { status: 500 });
    return Response.json({ completion: toCompletion(data as CompletionRow) }, { status: 201 });
  }

  const content = typeof payload.content === "string" ? payload.content.trim() : "";
  if (!content) return Response.json({ error: "Name the daily first." }, { status: 400 });
  const weekdayMask =
    typeof payload.weekdayMask === "number"
      ? Math.max(1, Math.min(127, Math.round(payload.weekdayMask)))
      : 127;
  const startDate = cleanDate(payload.startDate);
  const endDate = cleanDate(payload.endDate);
  if (startDate && endDate && endDate < startDate) {
    return Response.json({ error: "The end date must follow the start date." }, { status: 400 });
  }
  const { data: last } = await auth.supabase
    .from("daily_items")
    .select("position")
    .eq("archived", false)
    .order("position", { ascending: false })
    .limit(1)
    .maybeSingle();
  const row = {
    id: crypto.randomUUID(),
    user_id: auth.user.id,
    content,
    note: typeof payload.note === "string" ? payload.note.trim() : "",
    links: cleanLinks(payload.links),
    weekday_mask: weekdayMask,
    start_date: startDate,
    end_date: endDate,
    position: (last?.position ?? -1) + 1,
  };
  const { data, error } = await auth.supabase
    .from("daily_items")
    .insert(row)
    .select("*")
    .single();
  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ item: toDailyItem(data as DailyRow) }, { status: 201 });
}

export async function PATCH(request: Request) {
  const auth = await requireUser(request);
  if (auth.response) return auth.response;
  const payload = (await request.json()) as Record<string, unknown>;
  const id = typeof payload.id === "string" ? payload.id : "";
  if (!id) return Response.json({ error: "Missing daily item." }, { status: 400 });

  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (typeof payload.content === "string") update.content = payload.content.trim() || "Untitled";
  if (typeof payload.note === "string") update.note = payload.note.trim();
  if (Array.isArray(payload.links)) update.links = cleanLinks(payload.links);
  if (typeof payload.weekdayMask === "number") {
    update.weekday_mask = Math.max(1, Math.min(127, Math.round(payload.weekdayMask)));
  }
  if (payload.startDate === null || typeof payload.startDate === "string") {
    update.start_date = cleanDate(payload.startDate);
  }
  if (payload.endDate === null || typeof payload.endDate === "string") {
    update.end_date = cleanDate(payload.endDate);
  }
  if (typeof payload.position === "number") update.position = Math.max(0, Math.round(payload.position));
  if (typeof payload.archived === "boolean") update.archived = payload.archived;

  const { data, error } = await auth.supabase
    .from("daily_items")
    .update(update)
    .eq("id", id)
    .select("*")
    .single();
  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ item: toDailyItem(data as DailyRow) });
}

export async function DELETE(request: Request) {
  const auth = await requireUser(request);
  if (auth.response) return auth.response;
  const payload = (await request.json()) as Record<string, unknown>;
  const id = typeof payload.id === "string" ? payload.id : "";
  if (!id) return Response.json({ error: "Missing daily item." }, { status: 400 });
  const { error } = await auth.supabase.from("daily_items").delete().eq("id", id);
  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ ok: true });
}

import { authFailed, requireUser } from "@/lib/server-supabase";

export const dynamic = "force-dynamic";

type ReminderRow = {
  id: string;
  item_id: string;
  recipient_email: string;
  start_days_before: number;
  repeat_every_hours: number;
  send_time: string;
  timezone: string;
  next_send_at: string;
  last_sent_at: string | null;
  status: "active" | "paused" | "stopped";
  created_at: string;
  updated_at: string;
};

function publicReminder(row: ReminderRow) {
  return {
    id: row.id,
    itemId: row.item_id,
    recipientEmail: row.recipient_email,
    startDaysBefore: row.start_days_before,
    repeatEveryHours: row.repeat_every_hours,
    sendTime: row.send_time.slice(0, 5),
    timezone: row.timezone,
    nextSendAt: row.next_send_at,
    lastSentAt: row.last_sent_at,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function GET(request: Request) {
  const auth = await requireUser(request);
  if (authFailed(auth)) return auth.response;
  const { data, error } = await auth.supabase
    .from("task_email_reminders")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ reminders: ((data ?? []) as ReminderRow[]).map(publicReminder) });
}

export async function POST(request: Request) {
  const auth = await requireUser(request);
  if (authFailed(auth)) return auth.response;
  const payload = (await request.json()) as Record<string, unknown>;
  const itemId = typeof payload.itemId === "string" ? payload.itemId : "";
  const startDaysBefore = Number(payload.startDaysBefore);
  const repeatEveryHours = Number(payload.repeatEveryHours);
  const sendTime = typeof payload.sendTime === "string" ? payload.sendTime : "";
  const timezone = typeof payload.timezone === "string" ? payload.timezone.slice(0, 100) : "UTC";
  const requestedNext = typeof payload.nextSendAt === "string" ? new Date(payload.nextSendAt) : null;

  if (
    !itemId ||
    !Number.isInteger(startDaysBefore) ||
    startDaysBefore < 0 ||
    startDaysBefore > 365 ||
    !Number.isInteger(repeatEveryHours) ||
    repeatEveryHours < 1 ||
    repeatEveryHours > 720 ||
    !/^([01]\d|2[0-3]):[0-5]\d$/.test(sendTime) ||
    !requestedNext ||
    Number.isNaN(requestedNext.getTime())
  ) {
    return Response.json({ error: "The reminder schedule is invalid." }, { status: 400 });
  }

  const { data: item, error: itemError } = await auth.supabase
    .from("workspace_items")
    .select("id, due_date, completed, archived")
    .eq("id", itemId)
    .maybeSingle();
  if (itemError) return Response.json({ error: itemError.message }, { status: 500 });
  if (!item) return Response.json({ error: "Task not found." }, { status: 404 });
  if (!item.due_date) {
    return Response.json({ error: "Set a due date before adding an email reminder." }, { status: 400 });
  }
  if (item.completed || item.archived) {
    return Response.json({ error: "Restore this task before adding a reminder." }, { status: 400 });
  }
  if (!auth.user.email) {
    return Response.json({ error: "Your account does not have an email address." }, { status: 400 });
  }

  const dueEnd = new Date(`${item.due_date}T23:59:59.999Z`);
  if (requestedNext.getTime() > dueEnd.getTime() + 86400000) {
    return Response.json({ error: "The first reminder must be on or before the due date." }, { status: 400 });
  }
  const nextSendAt = new Date(
    Math.max(requestedNext.getTime(), Date.now() + 30_000),
  ).toISOString();
  const timestamp = new Date().toISOString();
  const { data, error } = await auth.supabase
    .from("task_email_reminders")
    .upsert(
      {
        user_id: auth.user.id,
        item_id: itemId,
        recipient_email: auth.user.email,
        start_days_before: startDaysBefore,
        repeat_every_hours: repeatEveryHours,
        send_time: sendTime,
        timezone: timezone || "UTC",
        next_send_at: nextSendAt,
        status: "active",
        updated_at: timestamp,
      },
      { onConflict: "user_id,item_id" },
    )
    .select("*")
    .single();

  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ reminder: publicReminder(data as ReminderRow) });
}

export async function PATCH(request: Request) {
  const auth = await requireUser(request);
  if (authFailed(auth)) return auth.response;
  const payload = (await request.json()) as Record<string, unknown>;
  const id = typeof payload.id === "string" ? payload.id : "";
  const status = payload.status === "active" || payload.status === "paused" || payload.status === "stopped"
    ? payload.status
    : null;
  if (!id || !status) {
    return Response.json({ error: "Choose a reminder state." }, { status: 400 });
  }
  const update: Record<string, unknown> = {
    status,
    updated_at: new Date().toISOString(),
  };
  if (status === "active") update.next_send_at = new Date(Date.now() + 60_000).toISOString();
  const { data, error } = await auth.supabase
    .from("task_email_reminders")
    .update(update)
    .eq("id", id)
    .select("*")
    .single();
  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ reminder: publicReminder(data as ReminderRow) });
}

export async function DELETE(request: Request) {
  const auth = await requireUser(request);
  if (authFailed(auth)) return auth.response;
  const payload = (await request.json()) as Record<string, unknown>;
  const id = typeof payload.id === "string" ? payload.id : "";
  if (!id) return Response.json({ error: "Missing reminder id." }, { status: 400 });
  const { error } = await auth.supabase
    .from("task_email_reminders")
    .delete()
    .eq("id", id);
  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ ok: true });
}

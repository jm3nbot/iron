import { createClient } from "@supabase/supabase-js";

type ReminderRow = {
  id: string;
  recipient_email: string;
  repeat_every_hours: number;
  next_send_at: string;
  status: "active" | "paused" | "stopped";
  workspace_items:
    | {
        content: string;
        note: string;
        links: string[];
        due_date: string | null;
        completed: boolean;
        archived: boolean;
      }
    | Array<{
        content: string;
        note: string;
        links: string[];
        due_date: string | null;
        completed: boolean;
        archived: boolean;
      }>;
};

function secretKey() {
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (legacy) return legacy;
  try {
    const keys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}") as Record<string, string>;
    return keys.default ?? "";
  } catch {
    return "";
  }
}

function escapeHtml(value: string) {
  return value.replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '"': "&quot;",
  })[character] ?? character);
}

function base64Url(bytes: ArrayBuffer) {
  const binary = String.fromCharCode(...new Uint8Array(bytes));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function signature(secret: string, id: string, action: string, expires: number) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return base64Url(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(`${id}:${action}:${expires}`),
    ),
  );
}

Deno.serve(async (request: Request) => {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const cronSecret = Deno.env.get("REMINDER_CRON_SECRET") ?? "";
  if (!cronSecret || request.headers.get("x-cron-secret") !== cronSecret) {
    return new Response("Unauthorized", { status: 401 });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = secretKey();
  const resendKey = Deno.env.get("RESEND_API_KEY") ?? "";
  const actionSecret = Deno.env.get("REMINDER_ACTION_SECRET") ?? "";
  const from = Deno.env.get("REMINDER_FROM_EMAIL") ?? "";
  const siteUrl = (Deno.env.get("SITE_URL") ?? "https://iron-rose-theta.vercel.app").replace(/\/$/, "");
  if (!supabaseUrl || !serviceKey || !resendKey || !actionSecret || !from) {
    return Response.json({ error: "Reminder delivery secrets are incomplete." }, { status: 503 });
  }

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const now = new Date();
  const { data, error } = await admin
    .from("task_email_reminders")
    .select("id, recipient_email, repeat_every_hours, next_send_at, status, workspace_items!inner(content, note, links, due_date, completed, archived)")
    .eq("status", "active")
    .lte("next_send_at", now.toISOString())
    .order("next_send_at")
    .limit(50);
  if (error) return Response.json({ error: error.message }, { status: 500 });

  let sent = 0;
  let failed = 0;
  for (const reminder of (data ?? []) as ReminderRow[]) {
    const item = Array.isArray(reminder.workspace_items)
      ? reminder.workspace_items[0]
      : reminder.workspace_items;
    if (!item?.due_date || item.completed || item.archived) {
      await admin
        .from("task_email_reminders")
        .update({ status: "stopped", updated_at: now.toISOString() })
        .eq("id", reminder.id);
      continue;
    }

    const scheduledFor = reminder.next_send_at;
    const { data: delivery, error: claimError } = await admin
      .from("task_email_deliveries")
      .insert({ reminder_id: reminder.id, scheduled_for: scheduledFor, status: "processing" })
      .select("id")
      .maybeSingle();
    if (claimError || !delivery) continue;

    try {
      const expires = Math.floor(Date.now() / 1000) + 14 * 24 * 60 * 60;
      const actionBase = `${supabaseUrl}/functions/v1/reminder-action`;
      const stopSig = await signature(actionSecret, reminder.id, "stop", expires);
      const keepSig = await signature(actionSecret, reminder.id, "keep", expires);
      const stopUrl = `${actionBase}?id=${encodeURIComponent(reminder.id)}&action=stop&exp=${expires}&sig=${stopSig}`;
      const keepUrl = `${actionBase}?id=${encodeURIComponent(reminder.id)}&action=keep&exp=${expires}&sig=${keepSig}`;
      const firstLink = item.links?.find((link) => /^https?:\/\//i.test(link));
      const dueLabel = new Date(`${item.due_date}T12:00:00Z`).toLocaleDateString("en", {
        month: "long",
        day: "numeric",
        year: "numeric",
        timeZone: "UTC",
      });
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${resendKey}`,
          "Content-Type": "application/json",
          "Idempotency-Key": `${reminder.id}-${scheduledFor}`.slice(0, 256),
        },
        body: JSON.stringify({
          from,
          to: [reminder.recipient_email],
          subject: `Ink&Iron · ${item.content}`,
          html: `
            <div style="background:#f4f1e9;padding:36px 18px;color:#24221e;font-family:Arial,sans-serif">
              <div style="max-width:560px;margin:auto;border:1px solid #cbc5b9;background:#fbfaf6;padding:28px">
                <div style="color:#a65f38;font-size:11px;letter-spacing:.18em;text-transform:uppercase">Ink&amp;Iron reminder</div>
                <h1 style="margin:14px 0 8px;font-family:Georgia,serif;font-size:25px;font-weight:500">${escapeHtml(item.content)}</h1>
                <p style="margin:0 0 18px;color:#746f66;font-size:13px">Due ${escapeHtml(dueLabel)}</p>
                ${item.note ? `<p style="white-space:pre-wrap;border-left:2px solid #a65f38;padding:10px 14px;color:#5f5a52;font-family:Georgia,serif;font-style:italic">${escapeHtml(item.note)}</p>` : ""}
                <div style="margin-top:24px">
                  <a href="${escapeHtml(stopUrl)}" style="display:inline-block;margin:0 7px 7px 0;padding:10px 13px;background:#24221e;color:#fbfaf6;text-decoration:none;font-size:12px">I’m working on it — stop</a>
                  <a href="${escapeHtml(keepUrl)}" style="display:inline-block;margin:0 7px 7px 0;padding:9px 13px;border:1px solid #a9a297;color:#49453f;text-decoration:none;font-size:12px">Keep reminding me</a>
                  <a href="${firstLink ? escapeHtml(firstLink) : `${siteUrl}/`}" style="display:inline-block;padding:9px 13px;border:1px solid #a9a297;color:#a65f38;text-decoration:none;font-size:12px">Open ${firstLink ? "link" : "Ink&Iron"}</a>
                </div>
              </div>
            </div>`,
        }),
      });
      const result = (await response.json()) as { id?: string; message?: string };
      if (!response.ok || !result.id) throw new Error(result.message ?? "Resend rejected the email.");

      const nextSend = new Date(
        new Date(scheduledFor).getTime() + reminder.repeat_every_hours * 60 * 60 * 1000,
      );
      const dueEnd = new Date(`${item.due_date}T23:59:59.999Z`);
      await Promise.all([
        admin
          .from("task_email_deliveries")
          .update({ status: "sent", provider_message_id: result.id, sent_at: new Date().toISOString() })
          .eq("id", delivery.id),
        admin
          .from("task_email_reminders")
          .update({
            last_sent_at: new Date().toISOString(),
            next_send_at: nextSend.toISOString(),
            status: nextSend > dueEnd ? "stopped" : "active",
            updated_at: new Date().toISOString(),
          })
          .eq("id", reminder.id),
      ]);
      sent += 1;
    } catch (sendError) {
      const message = sendError instanceof Error ? sendError.message : "Email delivery failed.";
      const retryAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
      await Promise.all([
        admin
          .from("task_email_deliveries")
          .update({ status: "failed", error: message.slice(0, 1000) })
          .eq("id", delivery.id),
        admin
          .from("task_email_reminders")
          .update({ next_send_at: retryAt, updated_at: new Date().toISOString() })
          .eq("id", reminder.id),
      ]);
      failed += 1;
    }
  }

  return Response.json({ processed: (data ?? []).length, sent, failed });
});

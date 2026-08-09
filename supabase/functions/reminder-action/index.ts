import { createClient } from "@supabase/supabase-js";

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
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}:${action}:${expires}`)),
  );
}

function page(title: string, copy: string, form = "") {
  return new Response(`<!doctype html><html><head><meta name="viewport" content="width=device-width"><title>${title} · Ink&amp;Iron</title></head><body style="margin:0;background:#f4f1e9;color:#24221e;font-family:Arial,sans-serif"><main style="max-width:520px;margin:12vh auto;padding:32px;border:1px solid #cbc5b9;background:#fbfaf6"><div style="color:#a65f38;font-size:11px;letter-spacing:.16em;text-transform:uppercase">Ink&amp;Iron</div><h1 style="font:500 27px Georgia,serif">${title}</h1><p style="color:#746f66;line-height:1.6">${copy}</p>${form}</main></body></html>`, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

Deno.serve(async (request: Request) => {
  const url = new URL(request.url);
  let id = url.searchParams.get("id") ?? "";
  let action = url.searchParams.get("action") ?? "";
  let expires = Number(url.searchParams.get("exp"));
  let supplied = url.searchParams.get("sig") ?? "";
  if (request.method === "POST") {
    const form = await request.formData();
    id = String(form.get("id") ?? "");
    action = String(form.get("action") ?? "");
    expires = Number(form.get("exp"));
    supplied = String(form.get("sig") ?? "");
  }

  const actionSecret = Deno.env.get("REMINDER_ACTION_SECRET") ?? "";
  if (
    !id ||
    !["stop", "keep"].includes(action) ||
    !Number.isFinite(expires) ||
    expires < Math.floor(Date.now() / 1000) ||
    !actionSecret ||
    supplied !== await signature(actionSecret, id, action, expires)
  ) {
    return page("Link expired", "This reminder link is invalid or has expired. Open Ink&Iron to update the reminder.");
  }

  if (request.method === "GET") {
    const verb = action === "stop" ? "stop future emails" : "keep this reminder active";
    return page(
      action === "stop" ? "Stop this reminder?" : "Keep reminding you?",
      `Confirm that you want to ${verb}.`,
      `<form method="post"><input type="hidden" name="id" value="${id}"><input type="hidden" name="action" value="${action}"><input type="hidden" name="exp" value="${expires}"><input type="hidden" name="sig" value="${supplied}"><button style="margin-top:14px;padding:11px 15px;border:0;background:#24221e;color:#fbfaf6;cursor:pointer">Confirm</button></form>`,
    );
  }
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const key = secretKey();
  if (!supabaseUrl || !key) return page("Not available", "The reminder service is temporarily unavailable.");
  const admin = createClient(supabaseUrl, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: reminder } = await admin
    .from("task_email_reminders")
    .select("id, repeat_every_hours, next_send_at")
    .eq("id", id)
    .maybeSingle();
  if (!reminder) return page("Reminder not found", "This reminder no longer exists.");

  const update = action === "stop"
    ? { status: "stopped", updated_at: new Date().toISOString() }
    : {
        status: "active",
        next_send_at:
          new Date(reminder.next_send_at).getTime() <= Date.now()
            ? new Date(Date.now() + reminder.repeat_every_hours * 60 * 60 * 1000).toISOString()
            : reminder.next_send_at,
        updated_at: new Date().toISOString(),
      };
  const { error } = await admin.from("task_email_reminders").update(update).eq("id", id);
  if (error) return page("Could not update", "Open Ink&Iron and change the reminder there.");
  return page(
    action === "stop" ? "Emails stopped" : "Reminder stays active",
    action === "stop"
      ? "No more emails will be sent for this task unless you turn the reminder back on."
      : "Ink&Iron will continue using the schedule you chose.",
  );
});

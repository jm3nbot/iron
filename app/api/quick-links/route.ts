import { createClient, type SupabaseClient, type User } from "@supabase/supabase-js";
import { supabasePublishableKey, supabaseUrl } from "@/lib/supabase-config";

export const dynamic = "force-dynamic";

type QuickLinkRow = {
  slot: number;
  label: string;
  url: string;
  updated_at: string;
};

function toQuickLink(row: QuickLinkRow) {
  return {
    slot: row.slot,
    label: row.label,
    url: row.url,
    updatedAt: row.updated_at,
  };
}

function cleanSlot(value: unknown) {
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  return value >= 1 && value <= 4 ? value : null;
}

function cleanUrl(value: unknown) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
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
  const { data, error } = await auth.supabase
    .from("quick_links")
    .select("slot, label, url, updated_at")
    .order("slot");
  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ links: (data as QuickLinkRow[]).map(toQuickLink) });
}

export async function PUT(request: Request) {
  const auth = await requireUser(request);
  if (auth.response) return auth.response;
  const payload = (await request.json()) as Record<string, unknown>;
  const slot = cleanSlot(payload.slot);
  const label = typeof payload.label === "string" ? payload.label.trim().slice(0, 32) : "";
  const url = cleanUrl(payload.url);
  if (!slot || !label || !url) {
    return Response.json({ error: "Add a name and a complete http:// or https:// link." }, { status: 400 });
  }
  const { data, error } = await auth.supabase
    .from("quick_links")
    .upsert(
      {
        user_id: auth.user.id,
        slot,
        label,
        url,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,slot" },
    )
    .select("slot, label, url, updated_at")
    .single();
  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ link: toQuickLink(data as QuickLinkRow) });
}

export async function DELETE(request: Request) {
  const auth = await requireUser(request);
  if (auth.response) return auth.response;
  const payload = (await request.json()) as Record<string, unknown>;
  const slot = cleanSlot(payload.slot);
  if (!slot) return Response.json({ error: "Choose a Quicklink slot." }, { status: 400 });
  const { error } = await auth.supabase.from("quick_links").delete().eq("slot", slot);
  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ ok: true });
}

import { createClient, type SupabaseClient, type User } from "@supabase/supabase-js";
import { supabasePublishableKey, supabaseUrl } from "@/lib/supabase-config";

export const dynamic = "force-dynamic";

type Section = "now" | "projects" | "library";
type Priority = "none" | "high" | "medium" | "low";

type WorkspaceRow = {
  id: string;
  user_id: string;
  content: string;
  section: Section;
  group_name: string;
  url: string | null;
  links: string[];
  note: string;
  parent_id: string | null;
  priority: Priority;
  due_date: string | null;
  completed: boolean;
  archived: boolean;
  archived_at: string | null;
  position: number;
  indent: number;
  bold: boolean;
  created_at: string;
  updated_at: string;
};

type MemberRow = {
  id: string;
  item_id: string;
  user_id: string;
  invite_status: "pending" | "accepted" | "declined";
};

function isSection(value: unknown): value is Section {
  return value === "now" || value === "projects" || value === "library";
}

function isPriority(value: unknown): value is Priority {
  return (
    value === "none" ||
    value === "high" ||
    value === "medium" ||
    value === "low"
  );
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

function toPublicItem(
  row: WorkspaceRow,
  ownerUsername = "",
  members: { id: string; userId: string; username: string }[] = [],
) {
  return {
    id: row.id,
    content: row.content,
    section: row.section,
    groupName: row.group_name,
    url: row.url,
    links: row.links ?? [],
    note: row.note,
    parentId: row.parent_id,
    priority: row.priority,
    dueDate: row.due_date,
    completed: row.completed,
    archived: row.archived,
    archivedAt: row.archived_at,
    position: row.position,
    indent: row.indent,
    bold: row.bold,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ownerId: row.user_id,
    ownerUsername,
    sharedWith: members,
  };
}

async function requireUser(
  request: Request,
): Promise<
  | { supabase: SupabaseClient; user: User; response?: never }
  | { response: Response; supabase?: never; user?: never }
> {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) {
    return {
      response: Response.json({ error: "Sign in to continue." }, { status: 401 }),
    };
  }

  const supabase = createClient(supabaseUrl, supabasePublishableKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) {
    return {
      response: Response.json({ error: "Your session has expired." }, { status: 401 }),
    };
  }

  return { supabase, user };
}

export async function GET(request: Request) {
  const auth = await requireUser(request);
  if (auth.response) return auth.response;

  const { data, error } = await auth.supabase
    .from("workspace_items")
    .select("*")
    .order("section")
    .order("group_name")
    .order("position")
    .order("created_at");

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  const rows = (data ?? []) as WorkspaceRow[];
  const { data: memberData, error: memberError } = await auth.supabase
    .from("workspace_item_members")
    .select("id, item_id, user_id, invite_status");
  if (memberError) {
    return Response.json({ error: memberError.message }, { status: 500 });
  }
  const memberships = (memberData ?? []) as MemberRow[];
  const acceptedItemIds = new Set(
    memberships
      .filter(
        (member) =>
          member.user_id === auth.user.id && member.invite_status === "accepted",
      )
      .map((member) => member.item_id),
  );
  const visibleRows = rows.filter(
    (row) => row.user_id === auth.user.id || acceptedItemIds.has(row.id),
  );
  const acceptedMembers = memberships.filter(
    (member) => member.invite_status === "accepted",
  );
  const profileIds = [
    ...new Set([
      ...visibleRows.map((row) => row.user_id),
      ...acceptedMembers.map((member) => member.user_id),
    ]),
  ];
  const { data: profiles, error: profileError } = profileIds.length
    ? await auth.supabase.from("profiles").select("id, username").in("id", profileIds)
    : { data: [], error: null };
  if (profileError) {
    return Response.json({ error: profileError.message }, { status: 500 });
  }
  const usernames = new Map(
    ((profiles ?? []) as { id: string; username: string }[]).map((profile) => [
      profile.id,
      profile.username,
    ]),
  );

  return Response.json({
    items: visibleRows.map((row) =>
      toPublicItem(
        row,
        usernames.get(row.user_id) ?? "",
        acceptedMembers
          .filter((member) => member.item_id === row.id)
          .map((member) => ({
            id: member.id,
            userId: member.user_id,
            username: usernames.get(member.user_id) ?? "Unknown",
          })),
      ),
    ),
    storageMode: "hosted",
  });
}

export async function POST(request: Request) {
  const auth = await requireUser(request);
  if (auth.response) return auth.response;

  const payload = (await request.json()) as Record<string, unknown>;
  const content = typeof payload.content === "string" ? payload.content.trim() : "";
  const section = isSection(payload.section) ? payload.section : "now";
  const groupName =
    typeof payload.groupName === "string" ? payload.groupName.trim() : "";

  if (!content) {
    return Response.json({ error: "Write something first." }, { status: 400 });
  }

  let position =
    typeof payload.position === "number"
      ? Math.max(0, Math.round(payload.position))
      : null;

  if (position === null) {
    const { data: last } = await auth.supabase
      .from("workspace_items")
      .select("position")
      .eq("user_id", auth.user.id)
      .eq("section", section)
      .eq("group_name", groupName)
      .order("position", { ascending: false })
      .limit(1)
      .maybeSingle();
    position = (last?.position ?? -1) + 1;
  }

  const row = {
    id: crypto.randomUUID(),
    user_id: auth.user.id,
    content,
    section,
    group_name: groupName,
    url: typeof payload.url === "string" ? payload.url : null,
    links: cleanLinks(payload.links),
    note: typeof payload.note === "string" ? payload.note.trim() : "",
    parent_id: typeof payload.parentId === "string" ? payload.parentId : null,
    priority: isPriority(payload.priority) ? payload.priority : "none",
    due_date:
      typeof payload.dueDate === "string" && payload.dueDate
        ? payload.dueDate
        : null,
    completed: Boolean(payload.completed),
    archived: Boolean(payload.archived),
    archived_at:
      typeof payload.archivedAt === "string" ? payload.archivedAt : null,
    position,
    indent:
      typeof payload.indent === "number"
        ? Math.max(0, Math.min(3, Math.round(payload.indent)))
        : 0,
    bold: Boolean(payload.bold),
  };

  const { data, error } = await auth.supabase
    .from("workspace_items")
    .insert(row)
    .select("*")
    .single();

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  return Response.json(
    { item: toPublicItem(data as WorkspaceRow), storageMode: "hosted" },
    { status: 201 },
  );
}

export async function PATCH(request: Request) {
  const auth = await requireUser(request);
  if (auth.response) return auth.response;

  const payload = (await request.json()) as Record<string, unknown>;
  const id = typeof payload.id === "string" ? payload.id : "";
  if (!id) {
    return Response.json({ error: "Missing item id." }, { status: 400 });
  }

  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (typeof payload.content === "string") {
    update.content = payload.content.trim() || "Untitled";
  }
  if (isSection(payload.section)) update.section = payload.section;
  if (typeof payload.groupName === "string") update.group_name = payload.groupName.trim();
  if (payload.url === null || typeof payload.url === "string") update.url = payload.url;
  if (Array.isArray(payload.links)) update.links = cleanLinks(payload.links);
  if (typeof payload.note === "string") update.note = payload.note;
  if (payload.parentId === null || typeof payload.parentId === "string") {
    update.parent_id = payload.parentId;
  }
  if (isPriority(payload.priority)) update.priority = payload.priority;
  if (payload.dueDate === null || typeof payload.dueDate === "string") {
    update.due_date = payload.dueDate || null;
  }
  if (typeof payload.completed === "boolean") update.completed = payload.completed;
  if (typeof payload.archived === "boolean") update.archived = payload.archived;
  if (payload.archivedAt === null || typeof payload.archivedAt === "string") {
    update.archived_at = payload.archivedAt;
  }
  if (typeof payload.position === "number") {
    update.position = Math.max(0, Math.round(payload.position));
  }
  if (typeof payload.indent === "number") {
    update.indent = Math.max(0, Math.min(3, Math.round(payload.indent)));
  }
  if (typeof payload.bold === "boolean") update.bold = payload.bold;

  const { data, error } = await auth.supabase
    .from("workspace_items")
    .update(update)
    .eq("id", id)
    .select("*")
    .single();

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  return Response.json({ item: toPublicItem(data as WorkspaceRow) });
}

export async function DELETE(request: Request) {
  const auth = await requireUser(request);
  if (auth.response) return auth.response;

  const payload = (await request.json()) as Record<string, unknown>;
  const id = typeof payload.id === "string" ? payload.id : "";
  if (!id) {
    return Response.json({ error: "Missing item id." }, { status: 400 });
  }

  const { error } = await auth.supabase
    .from("workspace_items")
    .delete()
    .eq("id", id);

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  return Response.json({ ok: true });
}

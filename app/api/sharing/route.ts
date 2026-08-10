import { authFailed, requireUser } from "@/lib/server-supabase";

export const dynamic = "force-dynamic";

type MemberKind = "item" | "project";
type MemberRow = {
  id: string;
  item_id: string;
  owner_id: string;
  user_id: string;
  invited_by: string;
  role: "editor";
  invite_status: "pending" | "accepted" | "declined";
  invited_at: string;
  responded_at: string | null;
};
type ProjectMemberRow = Omit<MemberRow, "item_id"> & { project_name: string };
type ProfileRow = { id: string; username: string };
type ItemRow = {
  id: string;
  user_id: string;
  content: string;
  section: "now" | "projects" | "library";
  group_name: string;
  note: string;
  priority: "none" | "high" | "medium" | "low";
  due_date: string | null;
  completed: boolean;
};

function people(member: { invited_by: string; user_id: string }, profiles: Map<string, string>) {
  return {
    senderUsername: profiles.get(member.invited_by) ?? "Unknown",
    recipientUsername: profiles.get(member.user_id) ?? "Unknown",
  };
}

function publicItemMember(member: MemberRow, items: Map<string, ItemRow>, profiles: Map<string, string>) {
  const item = items.get(member.item_id);
  return {
    id: member.id,
    kind: "item" as const,
    itemId: member.item_id,
    projectName: null,
    ownerId: member.owner_id,
    userId: member.user_id,
    invitedBy: member.invited_by,
    role: member.role,
    status: member.invite_status,
    invitedAt: member.invited_at,
    respondedAt: member.responded_at,
    ...people(member, profiles),
    item: item
      ? {
          id: item.id,
          content: item.content,
          section: item.section,
          groupName: item.group_name,
          note: item.note,
          priority: item.priority,
          dueDate: item.due_date,
          completed: item.completed,
        }
      : null,
  };
}

function publicProjectMember(member: ProjectMemberRow, profiles: Map<string, string>) {
  return {
    id: member.id,
    kind: "project" as const,
    itemId: null,
    projectName: member.project_name,
    ownerId: member.owner_id,
    userId: member.user_id,
    invitedBy: member.invited_by,
    role: member.role,
    status: member.invite_status,
    invitedAt: member.invited_at,
    respondedAt: member.responded_at,
    ...people(member, profiles),
    item: null,
  };
}

function isUsername(value: string) {
  return /^[A-Za-z0-9_]{3,24}$/.test(value);
}

export async function GET(request: Request) {
  const auth = await requireUser(request);
  if (authFailed(auth)) return auth.response;

  const url = new URL(request.url);
  const query = url.searchParams.get("query")?.trim() ?? "";
  if (query) {
    if (query.length < 2) return Response.json({ users: [] });
    const safeQuery = query.replace(/[%_,]/g, "");
    const { data, error } = await auth.supabase
      .from("profiles")
      .select("id, username")
      .ilike("username", `${safeQuery}%`)
      .neq("id", auth.user.id)
      .order("username")
      .limit(8);
    if (error) return Response.json({ error: error.message }, { status: 500 });
    return Response.json({ users: (data ?? []) as ProfileRow[] });
  }

  const [itemMembershipResult, projectMembershipResult] = await Promise.all([
    auth.supabase.from("workspace_item_members").select("*").order("invited_at", { ascending: false }),
    auth.supabase.from("workspace_project_members").select("*").order("invited_at", { ascending: false }),
  ]);
  if (itemMembershipResult.error || projectMembershipResult.error) {
    return Response.json({ error: itemMembershipResult.error?.message ?? projectMembershipResult.error?.message }, { status: 500 });
  }

  const itemMembers = (itemMembershipResult.data ?? []) as MemberRow[];
  const projectMembers = (projectMembershipResult.data ?? []) as ProjectMemberRow[];
  const itemIds = [...new Set(itemMembers.map((member) => member.item_id))];
  const profileIds = [...new Set([...itemMembers, ...projectMembers].flatMap((member) => [member.user_id, member.invited_by]))];
  const [itemResult, profileResult] = await Promise.all([
    itemIds.length
      ? auth.supabase.from("workspace_items").select("id, user_id, content, section, group_name, note, priority, due_date, completed").in("id", itemIds)
      : Promise.resolve({ data: [], error: null }),
    profileIds.length
      ? auth.supabase.from("profiles").select("id, username").in("id", profileIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (itemResult.error || profileResult.error) {
    return Response.json({ error: itemResult.error?.message ?? profileResult.error?.message }, { status: 500 });
  }

  const items = new Map(((itemResult.data ?? []) as ItemRow[]).map((item) => [item.id, item]));
  const profiles = new Map(((profileResult.data ?? []) as ProfileRow[]).map((profile) => [profile.id, profile.username]));
  const result = [
    ...itemMembers.map((member) => publicItemMember(member, items, profiles)),
    ...projectMembers.map((member) => publicProjectMember(member, profiles)),
  ];
  return Response.json({
    incoming: result.filter((member) => member.userId === auth.user.id && member.status === "pending"),
    outgoing: result.filter((member) => member.invitedBy === auth.user.id && member.status === "pending"),
    shared: result.filter((member) => member.status === "accepted"),
  });
}

export async function POST(request: Request) {
  const auth = await requireUser(request);
  if (authFailed(auth)) return auth.response;
  const payload = (await request.json()) as Record<string, unknown>;
  const kind: MemberKind = payload.kind === "project" ? "project" : "item";
  const username = typeof payload.username === "string" ? payload.username.trim() : "";
  if (!isUsername(username)) return Response.json({ error: "Choose a valid username." }, { status: 400 });

  const { data: recipient, error: profileError } = await auth.supabase
    .from("profiles").select("id, username").eq("username", username).maybeSingle();
  if (profileError) return Response.json({ error: profileError.message }, { status: 500 });
  if (!recipient || recipient.id === auth.user.id) return Response.json({ error: "That username could not be found." }, { status: 404 });

  if (kind === "project") {
    const projectName = typeof payload.projectName === "string" ? payload.projectName.trim() : "";
    if (!projectName || projectName.length > 120) return Response.json({ error: "Choose a valid project." }, { status: 400 });
    const { data: projectItem, error: projectError } = await auth.supabase
      .from("workspace_items")
      .select("id")
      .eq("user_id", auth.user.id)
      .eq("section", "projects")
      .eq("group_name", projectName)
      .limit(1)
      .maybeSingle();
    if (projectError) return Response.json({ error: projectError.message }, { status: 500 });
    if (!projectItem) return Response.json({ error: "Only the project owner can share it." }, { status: 403 });
    await auth.supabase.from("workspace_project_members").delete().eq("project_name", projectName).eq("owner_id", auth.user.id).eq("user_id", recipient.id);
    const { data, error } = await auth.supabase
      .from("workspace_project_members")
      .insert({ project_name: projectName, owner_id: auth.user.id, user_id: recipient.id, invited_by: auth.user.id, role: "editor", invite_status: "pending" })
      .select("*").single();
    if (error) return Response.json({ error: error.message }, { status: 500 });
    return Response.json({ invitation: data }, { status: 201 });
  }

  const itemId = typeof payload.itemId === "string" ? payload.itemId : "";
  if (!itemId) return Response.json({ error: "Choose a line to share." }, { status: 400 });
  const { data: item, error: itemError } = await auth.supabase.from("workspace_items").select("id, user_id").eq("id", itemId).maybeSingle();
  if (itemError) return Response.json({ error: itemError.message }, { status: 500 });
  if (!item || item.user_id !== auth.user.id) return Response.json({ error: "Only the line owner can share it." }, { status: 403 });
  await auth.supabase.from("workspace_item_members").delete().eq("item_id", itemId).eq("user_id", recipient.id);
  const { data, error } = await auth.supabase
    .from("workspace_item_members")
    .insert({ item_id: itemId, owner_id: auth.user.id, user_id: recipient.id, invited_by: auth.user.id, role: "editor", invite_status: "pending" })
    .select("*").single();
  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ invitation: data }, { status: 201 });
}

export async function PATCH(request: Request) {
  const auth = await requireUser(request);
  if (authFailed(auth)) return auth.response;
  const payload = (await request.json()) as Record<string, unknown>;
  const action = typeof payload.action === "string" ? payload.action : "";
  if (action === "rename-project") {
    const oldProjectName = typeof payload.oldProjectName === "string" ? payload.oldProjectName.trim() : "";
    const projectName = typeof payload.projectName === "string" ? payload.projectName.trim() : "";
    if (!oldProjectName || !projectName || projectName.length > 120) {
      return Response.json({ error: "Choose a valid project name." }, { status: 400 });
    }
    const { error } = await auth.supabase
      .from("workspace_project_members")
      .update({ project_name: projectName, updated_at: new Date().toISOString() })
      .eq("owner_id", auth.user.id)
      .eq("project_name", oldProjectName);
    if (error) return Response.json({ error: error.message }, { status: 500 });
    return Response.json({ ok: true });
  }
  const id = typeof payload.id === "string" ? payload.id : "";
  const kind: MemberKind = payload.kind === "project" ? "project" : "item";
  const status = payload.status === "accepted" || payload.status === "declined" ? payload.status : null;
  if (!id || !status) return Response.json({ error: "Choose an invitation response." }, { status: 400 });
  const timestamp = new Date().toISOString();
  const { data, error } = await auth.supabase
    .from(kind === "project" ? "workspace_project_members" : "workspace_item_members")
    .update({ invite_status: status, responded_at: timestamp, updated_at: timestamp })
    .eq("id", id).eq("user_id", auth.user.id).select("id").single();
  if (error || !data) return Response.json({ error: error?.message ?? "Invitation not found." }, { status: 404 });
  return Response.json({ ok: true });
}

export async function DELETE(request: Request) {
  const auth = await requireUser(request);
  if (authFailed(auth)) return auth.response;
  const payload = (await request.json()) as Record<string, unknown>;
  const action = typeof payload.action === "string" ? payload.action : "";
  if (action === "revoke-project") {
    const projectName = typeof payload.projectName === "string" ? payload.projectName.trim() : "";
    if (!projectName) return Response.json({ error: "Missing project name." }, { status: 400 });
    const { error } = await auth.supabase
      .from("workspace_project_members")
      .delete()
      .eq("owner_id", auth.user.id)
      .eq("project_name", projectName);
    if (error) return Response.json({ error: error.message }, { status: 500 });
    return Response.json({ ok: true });
  }
  const id = typeof payload.id === "string" ? payload.id : "";
  const kind: MemberKind = payload.kind === "project" ? "project" : "item";
  if (!id) return Response.json({ error: "Missing collaboration id." }, { status: 400 });
  const { error } = await auth.supabase
    .from(kind === "project" ? "workspace_project_members" : "workspace_item_members")
    .delete().eq("id", id);
  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ ok: true });
}

import { and, asc, desc, eq } from "drizzle-orm";
import { ensureWorkspaceSchema, getD1, getDb } from "@/db";
import { workspaceItems } from "@/db/schema";

export const dynamic = "force-dynamic";

type Section = "now" | "projects" | "library";
type Priority = "none" | "high" | "medium" | "low";

type SeedItem = {
  content: string;
  section: Section;
  groupName?: string;
  url?: string;
  priority?: Priority;
  bold?: boolean;
};

const seedItems: SeedItem[] = [
  { content: "INK&IRON UI", section: "now", priority: "high", bold: true },
  { content: "CODEX 100$ CREDIT", section: "now", priority: "high", bold: true },
  { content: "SETUP OPENCLAW", section: "now", priority: "high", bold: true },
  {
    content: "UOFT HUB (LOOK INTO UOFT PROMOS/AI–MAJORS/Rsrcs/ROADMAP+TARGET)",
    section: "now",
    priority: "high",
    bold: true,
  },
  { content: "REVAMP P-SITE", section: "now", priority: "medium", bold: true },
  { content: "MIT FOLLOW UP", section: "now", priority: "medium", bold: true },
  {
    content: "SET UP BROKERAGE ACCOUNT (SoFI v. Bank)",
    section: "now",
    priority: "medium",
    bold: true,
  },
  { content: "KALSHI CHANGE", section: "now", priority: "medium", bold: true },
  {
    content: "DO CREDIT-SCOTIA CARD REQ",
    section: "now",
    priority: "medium",
    bold: true,
  },
  { content: "UOFT TO-DO’s", section: "now", priority: "medium", bold: true },
  { content: "LOOKOUT DEALS CELLULAR", section: "now", bold: true },
  { content: "TCARD SITUATION", section: "now", bold: true },
  { content: "ROOMIE SIT.", section: "now", bold: true },
  { content: "Change UoFT to FZBN-mail", section: "now", bold: true },
  { content: "T", section: "now", bold: true },
  { content: "Hooked Audiobook", section: "now", bold: true },

  { content: "n8n", section: "library", groupName: "Learning & reference", bold: true },
  { content: "LINEAR ALG", section: "library", groupName: "Learning & reference", bold: true },
  { content: "LINKED-IN", section: "library", groupName: "Learning & reference", bold: true },
  { content: "ADAM K-FORMAT + WRITING", section: "library", groupName: "Learning & reference", bold: true },
  { content: "RESUME DRAFT", section: "library", groupName: "Learning & reference", bold: true },
  { content: "SCREENSHOTS", section: "library", groupName: "Learning & reference", bold: true },
  { content: "INSTAGRAM SAVED", section: "library", groupName: "Learning & reference", bold: true },
  { content: "REACHOUT YC’s", section: "library", groupName: "Learning & reference", bold: true },
  { content: "AI CERT-ONLINE", section: "library", groupName: "Learning & reference", bold: true },
  { content: "Who Am I?GPT", section: "library", groupName: "Learning & reference", bold: true },
  { content: "AI+ Map", section: "library", groupName: "Learning & reference", bold: true },
  { content: "DCF MODEL", section: "library", groupName: "Learning & reference", bold: true },
  {
    content: "AI+",
    section: "library",
    groupName: "Learning & reference",
    url: "https://docs.google.com/document/d/1hhsaoaSiBc-RZmDwTunpeJvPF2xbmo0FKOatu0Yolek/edit?usp=sharing",
    bold: true,
  },
];

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

async function seedIfEmpty() {
  const db = getDb();
  const existing = await db.select({ id: workspaceItems.id }).from(workspaceItems).limit(1);
  if (existing.length) return;

  const now = new Date().toISOString();
  const rows = seedItems.map((item, position) => ({
      id: `seed-${String(position + 1).padStart(3, "0")}`,
      content: item.content,
      section: item.section,
      groupName: item.groupName ?? "",
      url: item.url ?? null,
      priority: item.priority ?? "none",
      dueDate: null,
      completed: false,
      archived: false,
      position,
      indent: 0,
      bold: item.bold ?? false,
      createdAt: now,
      updatedAt: now,
    }));

  // Keep each statement below D1's parameter ceiling.
  for (let index = 0; index < rows.length; index += 6) {
    await db.insert(workspaceItems).values(rows.slice(index, index + 6));
  }
}

async function retireRemovedContent() {
  const d1 = getD1();
  await d1.batch([
    d1.prepare(
      "DELETE FROM workspace_items WHERE id IN ('seed-017','seed-018','seed-019','seed-020','seed-021','seed-022','seed-023','seed-024','seed-038','seed-039','seed-040','seed-041','seed-042','seed-043','seed-044','seed-045','seed-046')",
    ),
    d1.prepare(
      "UPDATE workspace_items SET section = 'library', group_name = 'Unsorted' WHERE section = 'notes'",
    ),
  ]);
}

export async function GET() {
  try {
    await ensureWorkspaceSchema();
    await retireRemovedContent();
    await seedIfEmpty();
    const items = await getDb()
      .select()
      .from(workspaceItems)
      .orderBy(
        asc(workspaceItems.section),
        asc(workspaceItems.groupName),
        asc(workspaceItems.position),
      );
    return Response.json({ items });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Could not load the workspace." },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  try {
    await ensureWorkspaceSchema();
    const payload = (await request.json()) as Record<string, unknown>;
    const content = typeof payload.content === "string" ? payload.content.trim() : "";
    const section = isSection(payload.section) ? payload.section : "now";
    const groupName =
      typeof payload.groupName === "string" ? payload.groupName.trim() : "";

    if (!content) {
      return Response.json({ error: "Write something first." }, { status: 400 });
    }

    const db = getDb();
    const [last] = await db
      .select({ position: workspaceItems.position })
      .from(workspaceItems)
      .where(
        and(
          eq(workspaceItems.section, section),
          eq(workspaceItems.groupName, groupName),
        ),
      )
      .orderBy(desc(workspaceItems.position))
      .limit(1);

    const timestamp = new Date().toISOString();
    const item = {
      id: crypto.randomUUID(),
      content,
      section,
      groupName,
      url: typeof payload.url === "string" ? payload.url : null,
      priority: isPriority(payload.priority) ? payload.priority : "none",
      dueDate: typeof payload.dueDate === "string" ? payload.dueDate : null,
      completed: false,
      archived: false,
      position: (last?.position ?? -1) + 1,
      indent: 0,
      bold: Boolean(payload.bold),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await db.insert(workspaceItems).values(item);
    return Response.json({ item }, { status: 201 });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Could not create the item." },
      { status: 500 },
    );
  }
}

export async function PATCH(request: Request) {
  try {
    await ensureWorkspaceSchema();
    const payload = (await request.json()) as Record<string, unknown>;
    const id = typeof payload.id === "string" ? payload.id : "";
    if (!id) {
      return Response.json({ error: "Item id is required." }, { status: 400 });
    }

    const changes: Record<string, string | number | boolean | null> = {
      updatedAt: new Date().toISOString(),
    };
    if (typeof payload.content === "string") changes.content = payload.content.trim() || "Untitled";
    if (isSection(payload.section)) changes.section = payload.section;
    if (typeof payload.groupName === "string") changes.groupName = payload.groupName.trim();
    if (payload.url === null || typeof payload.url === "string") changes.url = payload.url;
    if (isPriority(payload.priority)) changes.priority = payload.priority;
    if (payload.dueDate === null || typeof payload.dueDate === "string") changes.dueDate = payload.dueDate;
    if (typeof payload.completed === "boolean") changes.completed = payload.completed;
    if (typeof payload.archived === "boolean") changes.archived = payload.archived;
    if (typeof payload.position === "number") changes.position = Math.max(0, Math.round(payload.position));
    if (typeof payload.indent === "number") changes.indent = Math.max(0, Math.min(2, Math.round(payload.indent)));
    if (typeof payload.bold === "boolean") changes.bold = payload.bold;

    const [item] = await getDb()
      .update(workspaceItems)
      .set(changes)
      .where(eq(workspaceItems.id, id))
      .returning();

    if (!item) {
      return Response.json({ error: "Item not found." }, { status: 404 });
    }
    return Response.json({ item });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Could not save the change." },
      { status: 500 },
    );
  }
}

export async function DELETE(request: Request) {
  try {
    await ensureWorkspaceSchema();
    const payload = (await request.json()) as { id?: string };
    if (!payload.id) {
      return Response.json({ error: "Item id is required." }, { status: 400 });
    }
    await getDb().delete(workspaceItems).where(eq(workspaceItems.id, payload.id));
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Could not delete the item." },
      { status: 500 },
    );
  }
}

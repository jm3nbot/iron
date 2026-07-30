import {
  getWorkspaceRepository,
  type DatabaseChanges,
  type DatabaseItem,
  type WorkspaceRepository,
} from "@/db";

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

function cleanLinks(value: unknown, legacyUrl?: string | null) {
  const links = Array.isArray(value)
    ? value.filter((link): link is string => typeof link === "string")
    : typeof value === "string"
      ? (() => {
          try {
            const parsed = JSON.parse(value);
            return Array.isArray(parsed)
              ? parsed.filter((link): link is string => typeof link === "string")
              : [];
          } catch {
            return [];
          }
        })()
      : [];
  if (legacyUrl) links.push(legacyUrl);
  return [...new Set(links.map((link) => link.trim()).filter(Boolean))];
}

function toPublicItem<T extends { links: string; url: string | null }>(item: T) {
  return { ...item, links: cleanLinks(item.links, item.url) };
}

function seedRows(): DatabaseItem[] {
  const now = new Date().toISOString();
  return seedItems.map((item, position) => ({
    id: `seed-${String(position + 1).padStart(3, "0")}`,
    content: item.content,
    section: item.section,
    groupName: item.groupName ?? "",
    url: item.url ?? null,
    links: JSON.stringify(item.url ? [item.url] : []),
    note: "",
    parentId: null,
    priority: item.priority ?? "none",
    dueDate: null,
    completed: false,
    archived: false,
    archivedAt: null,
    position,
    indent: 0,
    bold: item.bold ?? false,
    createdAt: now,
    updatedAt: now,
  }));
}

async function seedIfEmpty(repository: WorkspaceRepository) {
  if ((await repository.count()) > 0) return;
  for (const item of seedRows()) await repository.insert(item);
}

async function readyRepository() {
  const repository = await getWorkspaceRepository();
  if (!repository) return null;
  await repository.retireLegacyContent();
  await seedIfEmpty(repository);
  return repository;
}

export async function GET() {
  try {
    const repository = await readyRepository();
    if (!repository) {
      return Response.json({
        items: seedRows().map(toPublicItem),
        storageMode: "browser",
      });
    }
    const rows = await repository.list();
    return Response.json({ items: rows.map(toPublicItem), storageMode: "hosted" });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Could not load the workspace." },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as Record<string, unknown>;
    const content = typeof payload.content === "string" ? payload.content.trim() : "";
    const section = isSection(payload.section) ? payload.section : "now";
    const groupName =
      typeof payload.groupName === "string" ? payload.groupName.trim() : "";

    if (!content) {
      return Response.json({ error: "Write something first." }, { status: 400 });
    }

    const repository = await getWorkspaceRepository();
    const lastPosition = repository
      ? await repository.maxPosition(section, groupName)
      : -1;

    const timestamp = new Date().toISOString();
    const legacyUrl = typeof payload.url === "string" ? payload.url : null;
    const links = cleanLinks(payload.links, legacyUrl);
    const item: DatabaseItem = {
      id: crypto.randomUUID(),
      content,
      section,
      groupName,
      url: null,
      links: JSON.stringify(links),
      note: typeof payload.note === "string" ? payload.note.trim() : "",
      parentId: typeof payload.parentId === "string" ? payload.parentId : null,
      priority: isPriority(payload.priority) ? payload.priority : "none",
      dueDate: typeof payload.dueDate === "string" ? payload.dueDate : null,
      completed: false,
      archived: false,
      archivedAt: null,
      position:
        typeof payload.position === "number"
          ? Math.max(0, Math.round(payload.position))
          : lastPosition + 1,
      indent:
        typeof payload.indent === "number"
          ? Math.max(0, Math.min(3, Math.round(payload.indent)))
          : 0,
      bold: Boolean(payload.bold),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    if (repository) await repository.insert(item);
    return Response.json(
      {
        item: toPublicItem(item),
        storageMode: repository ? "hosted" : "browser",
      },
      { status: 201 },
    );
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Could not create the item." },
      { status: 500 },
    );
  }
}

export async function PATCH(request: Request) {
  try {
    const payload = (await request.json()) as Record<string, unknown>;
    const id = typeof payload.id === "string" ? payload.id : "";
    if (!id) {
      return Response.json({ error: "Item id is required." }, { status: 400 });
    }

    const repository = await getWorkspaceRepository();
    if (!repository) {
      return Response.json({ ok: true, storageMode: "browser" });
    }

    const changes: DatabaseChanges = {};
    const touchesContent = Object.keys(payload).some(
      (key) => key !== "id" && key !== "position",
    );
    if (touchesContent) changes.updatedAt = new Date().toISOString();
    if (typeof payload.content === "string") changes.content = payload.content.trim() || "Untitled";
    if (isSection(payload.section)) changes.section = payload.section;
    if (typeof payload.groupName === "string") changes.groupName = payload.groupName.trim();
    if (payload.url === null || typeof payload.url === "string") changes.url = payload.url;
    if (Array.isArray(payload.links)) changes.links = JSON.stringify(cleanLinks(payload.links));
    if (typeof payload.note === "string") changes.note = payload.note;
    if (payload.parentId === null || typeof payload.parentId === "string") changes.parentId = payload.parentId;
    if (isPriority(payload.priority)) changes.priority = payload.priority;
    if (payload.dueDate === null || typeof payload.dueDate === "string") changes.dueDate = payload.dueDate;
    if (typeof payload.completed === "boolean") changes.completed = payload.completed;
    if (typeof payload.archived === "boolean") changes.archived = payload.archived;
    if (payload.archivedAt === null || typeof payload.archivedAt === "string") changes.archivedAt = payload.archivedAt;
    if (typeof payload.position === "number") changes.position = Math.max(0, Math.round(payload.position));
    if (typeof payload.indent === "number") changes.indent = Math.max(0, Math.min(2, Math.round(payload.indent)));
    if (typeof payload.bold === "boolean") changes.bold = payload.bold;

    const item = await repository.update(id, changes);

    if (!item) {
      return Response.json({ error: "Item not found." }, { status: 404 });
    }
    return Response.json({ item: toPublicItem(item) });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Could not save the change." },
      { status: 500 },
    );
  }
}

export async function DELETE(request: Request) {
  try {
    const payload = (await request.json()) as { id?: string };
    if (!payload.id) {
      return Response.json({ error: "Item id is required." }, { status: 400 });
    }
    const repository = await getWorkspaceRepository();
    if (repository) await repository.delete(payload.id);
    return Response.json({
      ok: true,
      storageMode: repository ? "hosted" : "browser",
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Could not delete the item." },
      { status: 500 },
    );
  }
}

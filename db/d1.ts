import { env } from "cloudflare:workers";
import type {
  DatabaseChanges,
  DatabaseItem,
  WorkspaceRepository,
} from "./types";

type D1Row = Record<string, unknown>;

const columns: Record<keyof DatabaseChanges, string> = {
  content: "content",
  section: "section",
  groupName: "group_name",
  url: "url",
  links: "links",
  note: "note",
  parentId: "parent_id",
  priority: "priority",
  dueDate: "due_date",
  completed: "completed",
  archived: "archived",
  archivedAt: "archived_at",
  position: "position",
  indent: "indent",
  bold: "bold",
  updatedAt: "updated_at",
};

function mapRow(row: D1Row): DatabaseItem {
  return {
    id: String(row.id),
    content: String(row.content),
    section: String(row.section),
    groupName: String(row.group_name ?? ""),
    url: row.url == null ? null : String(row.url),
    links: String(row.links ?? "[]"),
    note: String(row.note ?? ""),
    parentId: row.parent_id == null ? null : String(row.parent_id),
    priority: String(row.priority ?? "none"),
    dueDate: row.due_date == null ? null : String(row.due_date),
    completed: Boolean(row.completed),
    archived: Boolean(row.archived),
    archivedAt: row.archived_at == null ? null : String(row.archived_at),
    position: Number(row.position ?? 0),
    indent: Number(row.indent ?? 0),
    bold: Boolean(row.bold),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function valueForD1(value: unknown) {
  return typeof value === "boolean" ? Number(value) : value;
}

let schemaReady: Promise<void> | null = null;

export function getD1Repository(): WorkspaceRepository {
  const db = env.DB;
  if (!db) {
    throw new Error("Cloudflare D1 binding `DB` is unavailable.");
  }

  return {
    async ensure() {
      if (!schemaReady) {
        schemaReady = (async () => {
          await db.batch([
            db.prepare(`
              CREATE TABLE IF NOT EXISTS workspace_items (
                id TEXT PRIMARY KEY NOT NULL,
                content TEXT NOT NULL,
                section TEXT NOT NULL,
                group_name TEXT NOT NULL DEFAULT '',
                url TEXT,
                links TEXT NOT NULL DEFAULT '[]',
                note TEXT NOT NULL DEFAULT '',
                parent_id TEXT,
                priority TEXT NOT NULL DEFAULT 'none',
                due_date TEXT,
                completed INTEGER NOT NULL DEFAULT 0,
                archived INTEGER NOT NULL DEFAULT 0,
                archived_at TEXT,
                position INTEGER NOT NULL DEFAULT 0,
                indent INTEGER NOT NULL DEFAULT 0,
                bold INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
              )
            `),
            db.prepare(
              "CREATE INDEX IF NOT EXISTS workspace_items_section_position_idx ON workspace_items (section, group_name, position)",
            ),
          ]);

          const result = await db
            .prepare("PRAGMA table_info(workspace_items)")
            .all();
          const existing = new Set(
            (result.results as Array<{ name?: string }>).map(
              (column) => column.name,
            ),
          );
          const additions = [];
          if (!existing.has("links")) {
            additions.push(
              db.prepare(
                "ALTER TABLE workspace_items ADD COLUMN links TEXT NOT NULL DEFAULT '[]'",
              ),
            );
          }
          if (!existing.has("note")) {
            additions.push(
              db.prepare(
                "ALTER TABLE workspace_items ADD COLUMN note TEXT NOT NULL DEFAULT ''",
              ),
            );
          }
          if (!existing.has("parent_id")) {
            additions.push(
              db.prepare(
                "ALTER TABLE workspace_items ADD COLUMN parent_id TEXT",
              ),
            );
          }
          if (!existing.has("archived_at")) {
            additions.push(
              db.prepare(
                "ALTER TABLE workspace_items ADD COLUMN archived_at TEXT",
              ),
            );
          }
          if (additions.length) await db.batch(additions);
        })();
      }
      await schemaReady;
    },

    async count() {
      const row = await db
        .prepare("SELECT COUNT(*) AS count FROM workspace_items")
        .first<{ count: number }>();
      return Number(row?.count ?? 0);
    },

    async list() {
      const result = await db
        .prepare(
          "SELECT * FROM workspace_items ORDER BY section, group_name, position",
        )
        .all();
      return (result.results as D1Row[]).map(mapRow);
    },

    async maxPosition(section, groupName) {
      const row = await db
        .prepare(
          "SELECT MAX(position) AS position FROM workspace_items WHERE section = ? AND group_name = ?",
        )
        .bind(section, groupName)
        .first<{ position: number | null }>();
      return Number(row?.position ?? -1);
    },

    async insert(item) {
      await db
        .prepare(
          `INSERT INTO workspace_items (
            id, content, section, group_name, url, links, note, parent_id,
            priority, due_date, completed, archived, archived_at, position,
            indent, bold, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          item.id,
          item.content,
          item.section,
          item.groupName,
          item.url,
          item.links,
          item.note,
          item.parentId,
          item.priority,
          item.dueDate,
          Number(item.completed),
          Number(item.archived),
          item.archivedAt,
          item.position,
          item.indent,
          Number(item.bold),
          item.createdAt,
          item.updatedAt,
        )
        .run();
      return item;
    },

    async update(id, changes) {
      const entries = Object.entries(changes) as Array<
        [keyof DatabaseChanges, DatabaseChanges[keyof DatabaseChanges]]
      >;
      if (!entries.length) {
        const row = await db
          .prepare("SELECT * FROM workspace_items WHERE id = ?")
          .bind(id)
          .first<D1Row>();
        return row ? mapRow(row) : null;
      }
      const assignments = entries
        .map(([key]) => `${columns[key]} = ?`)
        .join(", ");
      const values = entries.map(([, value]) => valueForD1(value));
      await db
        .prepare(`UPDATE workspace_items SET ${assignments} WHERE id = ?`)
        .bind(...values, id)
        .run();
      const row = await db
        .prepare("SELECT * FROM workspace_items WHERE id = ?")
        .bind(id)
        .first<D1Row>();
      return row ? mapRow(row) : null;
    },

    async delete(id) {
      await db
        .prepare("DELETE FROM workspace_items WHERE id = ?")
        .bind(id)
        .run();
    },

    async retireLegacyContent() {
      await db.batch([
        db.prepare(
          "DELETE FROM workspace_items WHERE id IN ('seed-017','seed-018','seed-019','seed-020','seed-021','seed-022','seed-023','seed-024','seed-038','seed-039','seed-040','seed-041','seed-042','seed-043','seed-044','seed-045','seed-046')",
        ),
        db.prepare(
          "UPDATE workspace_items SET section = 'library', group_name = 'Unsorted' WHERE section = 'notes'",
        ),
      ]);
    },
  };
}

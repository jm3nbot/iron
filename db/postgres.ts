import { neon } from "@neondatabase/serverless";
import type {
  DatabaseChanges,
  DatabaseItem,
  WorkspaceRepository,
} from "./types";

type PostgresRow = Record<string, unknown>;

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

function mapRow(row: PostgresRow): DatabaseItem {
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

let schemaReady: Promise<void> | null = null;

export function getPostgresRepository(
  connectionString: string,
): WorkspaceRepository {
  const sql = neon(connectionString);

  return {
    async ensure() {
      if (!schemaReady) {
        schemaReady = (async () => {
          await sql.query(`
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
              completed BOOLEAN NOT NULL DEFAULT FALSE,
              archived BOOLEAN NOT NULL DEFAULT FALSE,
              archived_at TEXT,
              position INTEGER NOT NULL DEFAULT 0,
              indent INTEGER NOT NULL DEFAULT 0,
              bold BOOLEAN NOT NULL DEFAULT FALSE,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            )
          `);
          await sql.query(
            "CREATE INDEX IF NOT EXISTS workspace_items_section_position_idx ON workspace_items (section, group_name, position)",
          );
        })();
      }
      await schemaReady;
    },

    async count() {
      const rows = await sql.query(
        "SELECT COUNT(*)::int AS count FROM workspace_items",
      );
      return Number((rows[0] as PostgresRow | undefined)?.count ?? 0);
    },

    async list() {
      const rows = await sql.query(
        "SELECT * FROM workspace_items ORDER BY section, group_name, position",
      );
      return (rows as PostgresRow[]).map(mapRow);
    },

    async maxPosition(section, groupName) {
      const rows = await sql.query(
        "SELECT COALESCE(MAX(position), -1)::int AS position FROM workspace_items WHERE section = $1 AND group_name = $2",
        [section, groupName],
      );
      return Number((rows[0] as PostgresRow | undefined)?.position ?? -1);
    },

    async insert(item) {
      const rows = await sql.query(
        `INSERT INTO workspace_items (
          id, content, section, group_name, url, links, note, parent_id,
          priority, due_date, completed, archived, archived_at, position,
          indent, bold, created_at, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
          $14, $15, $16, $17, $18
        ) RETURNING *`,
        [
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
          item.completed,
          item.archived,
          item.archivedAt,
          item.position,
          item.indent,
          item.bold,
          item.createdAt,
          item.updatedAt,
        ],
      );
      return mapRow(rows[0] as PostgresRow);
    },

    async update(id, changes) {
      const entries = Object.entries(changes) as Array<
        [keyof DatabaseChanges, DatabaseChanges[keyof DatabaseChanges]]
      >;
      if (!entries.length) {
        const rows = await sql.query(
          "SELECT * FROM workspace_items WHERE id = $1",
          [id],
        );
        return rows[0] ? mapRow(rows[0] as PostgresRow) : null;
      }
      const assignments = entries
        .map(([key], index) => `${columns[key]} = $${index + 1}`)
        .join(", ");
      const values = entries.map(([, value]) => value);
      const rows = await sql.query(
        `UPDATE workspace_items SET ${assignments} WHERE id = $${
          entries.length + 1
        } RETURNING *`,
        [...values, id],
      );
      return rows[0] ? mapRow(rows[0] as PostgresRow) : null;
    },

    async delete(id) {
      await sql.query("DELETE FROM workspace_items WHERE id = $1", [id]);
    },

    async retireLegacyContent() {
      await sql.query(
        "DELETE FROM workspace_items WHERE id = ANY($1::text[])",
        [
          [
            "seed-017",
            "seed-018",
            "seed-019",
            "seed-020",
            "seed-021",
            "seed-022",
            "seed-023",
            "seed-024",
            "seed-038",
            "seed-039",
            "seed-040",
            "seed-041",
            "seed-042",
            "seed-043",
            "seed-044",
            "seed-045",
            "seed-046",
          ],
        ],
      );
      await sql.query(
        "UPDATE workspace_items SET section = 'library', group_name = 'Unsorted' WHERE section = 'notes'",
      );
    },
  };
}

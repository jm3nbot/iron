import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

export function getD1() {
  if (!env.DB) {
    throw new Error(
      "Cloudflare D1 binding `DB` is unavailable. Set the `d1` field in .openai/hosting.json to `DB`.",
    );
  }
  return env.DB;
}

export function getDb() {
  return drizzle(getD1(), { schema });
}

let schemaReady: Promise<void> | null = null;

export function ensureWorkspaceSchema() {
  if (!schemaReady) {
    const d1 = getD1();
    schemaReady = (async () => {
      await d1.batch([
        d1.prepare(`
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
            position INTEGER NOT NULL DEFAULT 0,
            indent INTEGER NOT NULL DEFAULT 0,
            bold INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          )
        `),
        d1.prepare(
          "CREATE INDEX IF NOT EXISTS workspace_items_section_position_idx ON workspace_items (section, group_name, position)",
        ),
      ]);

      const result = await d1.prepare("PRAGMA table_info(workspace_items)").all();
      const columns = new Set(
        (result.results as Array<{ name?: string }>).map((column) => column.name),
      );
      const additions = [];
      if (!columns.has("links")) {
        additions.push(
          d1.prepare("ALTER TABLE workspace_items ADD COLUMN links TEXT NOT NULL DEFAULT '[]'"),
        );
      }
      if (!columns.has("note")) {
        additions.push(
          d1.prepare("ALTER TABLE workspace_items ADD COLUMN note TEXT NOT NULL DEFAULT ''"),
        );
      }
      if (!columns.has("parent_id")) {
        additions.push(
          d1.prepare("ALTER TABLE workspace_items ADD COLUMN parent_id TEXT"),
        );
      }
      if (additions.length) await d1.batch(additions);
    })();
  }
  return schemaReady;
}

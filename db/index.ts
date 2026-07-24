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
    schemaReady = d1
      .batch([
        d1.prepare(`
          CREATE TABLE IF NOT EXISTS workspace_items (
            id TEXT PRIMARY KEY NOT NULL,
            content TEXT NOT NULL,
            section TEXT NOT NULL,
            group_name TEXT NOT NULL DEFAULT '',
            url TEXT,
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
      ])
      .then(() => undefined);
  }
  return schemaReady;
}

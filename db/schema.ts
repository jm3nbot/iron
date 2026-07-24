import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const workspaceItems = sqliteTable("workspace_items", {
  id: text("id").primaryKey(),
  content: text("content").notNull(),
  section: text("section").notNull(),
  groupName: text("group_name").notNull().default(""),
  url: text("url"),
  links: text("links").notNull().default("[]"),
  note: text("note").notNull().default(""),
  parentId: text("parent_id"),
  priority: text("priority").notNull().default("none"),
  dueDate: text("due_date"),
  completed: integer("completed", { mode: "boolean" }).notNull().default(false),
  archived: integer("archived", { mode: "boolean" }).notNull().default(false),
  archivedAt: text("archived_at"),
  position: integer("position").notNull().default(0),
  indent: integer("indent").notNull().default(0),
  bold: integer("bold", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

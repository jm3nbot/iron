import assert from "node:assert/strict";
import test from "node:test";
import { WorkspaceSync, migrateWorkspaceCache } from "../lib/workspace-sync.ts";
import { conflictingFields } from "../lib/workspace-conflicts.ts";

class MemoryStorage {
  data = new Map();
  get length() { return this.data.size; }
  key(index) { return [...this.data.keys()][index] ?? null; }
  getItem(key) { return this.data.get(key) ?? null; }
  setItem(key, value) { this.data.set(key, value); }
  removeItem(key) { this.data.delete(key); }
}
const line = (id = "line") => ({ id, content: "buy calc (pick)", completed: false, note: "Keep this note", links: ["https://example.com"] });

test("failed creation survives server refresh and browser restart with metadata intact", async () => {
  const storage = new MemoryStorage();
  const sync = new WorkspaceSync(storage, "owner");
  sync.enqueue("POST", "line", line(), line());
  await assert.rejects(sync.flush(async () => { throw new Error("offline"); }));
  assert.deepEqual(sync.merge([]), [line()]);
  const restarted = new WorkspaceSync(storage, "owner");
  assert.deepEqual(restarted.merge([]), [line()]);
  const sent = [];
  await restarted.flush(async (write) => sent.push(write));
  assert.equal(sent[0].id, "line");
  assert.equal(restarted.pending().length, 0);
  assert.ok([...storage.data.keys()].some((key) => key.includes(":history:")));
});

test("checking an unsaved line sends creation then completion against the same ID", async () => {
  const sync = new WorkspaceSync(new MemoryStorage(), "owner");
  sync.enqueue("POST", "line", line(), line());
  sync.enqueue("PATCH", "line", { completed: true }, line());
  assert.equal(sync.merge([])[0].completed, true);
  const server = new Map();
  await sync.flush(async (write) => {
    if (write.method === "POST") server.set(write.id, write.payload);
    else {
      assert.ok(server.has(write.id));
      server.set(write.id, { ...server.get(write.id), ...write.payload });
    }
  });
  assert.equal(server.size, 1);
  assert.equal(server.get("line").completed, true);
});

test("an older save finishing cannot remove an edit added while it is in flight", async () => {
  const sync = new WorkspaceSync(new MemoryStorage(), "owner");
  sync.enqueue("PATCH", "line", { content: "first" }, line());
  let release;
  const wait = new Promise((resolve) => { release = resolve; });
  const sent = [];
  const flushing = sync.flush(async (write) => {
    sent.push(write.payload.content);
    if (sent.length === 1) await wait;
  });
  sync.enqueue("PATCH", "line", { content: "latest" }, line());
  release();
  await flushing;
  assert.deepEqual(sent, ["first", "latest"]);
  assert.equal(sync.pending().length, 0);
});

test("stale snapshots are detectable before and after acknowledgment, including another tab", async () => {
  const storage = new MemoryStorage();
  const first = new WorkspaceSync(storage, "owner");
  const other = new WorkspaceSync(storage, "owner");
  const beforeEdit = first.checkpoint();
  other.enqueue("POST", "line", line(), line());
  assert.notEqual(first.checkpoint(), beforeEdit);
  const duringSave = first.checkpoint();
  await other.flush(async () => {});
  assert.notEqual(first.checkpoint(), duringSave);
});

test("a failed parent waits with its child, without blocking unrelated lines", async () => {
  const sync = new WorkspaceSync(new MemoryStorage(), "owner");
  sync.enqueue("POST", "parent", line("parent"), line("parent"));
  sync.enqueue("POST", "child", { ...line("child"), parentId: "parent" }, line("child"));
  sync.enqueue("POST", "other", line("other"), line("other"));
  const sent = [];
  await assert.rejects(sync.flush(async (write) => {
    sent.push(write.id);
    if (write.id === "parent") throw new Error("offline");
  }));
  assert.deepEqual(sent, ["parent", "other"]);
  assert.equal(sync.pending().length, 2);
});

test("two tabs retain independent writes and accounts never share an outbox", () => {
  const storage = new MemoryStorage();
  const first = new WorkspaceSync(storage, "owner");
  const second = new WorkspaceSync(storage, "owner");
  first.enqueue("PATCH", "line", { completed: true }, line());
  second.enqueue("PATCH", "line", { note: "new note" }, line());
  assert.equal(first.pending().length, 2);
  assert.equal(first.merge([line()])[0].note, "new note");
  assert.equal(first.merge([line()])[0].completed, true);
  assert.equal(new WorkspaceSync(storage, "other-user").pending().length, 0);
});

test("legacy unsent drafts and their completion state are recovered before cache replacement", () => {
  const storage = new MemoryStorage();
  const sync = new WorkspaceSync(storage, "owner");
  const draft = { ...line("draft-123-abc"), content: "Apply RCIF" };
  storage.setItem("cache", JSON.stringify([draft]));
  storage.setItem("queue", JSON.stringify({ [draft.id]: { completed: true } }));
  migrateWorkspaceCache(storage, sync, "cache", "queue", () => null);
  assert.equal(sync.merge([])[0].content, "Apply RCIF");
  assert.equal(sync.merge([])[0].completed, true);
  const backup = storage.getItem(`${sync.prefix}legacy-backup`);
  assert.ok(backup.includes("Apply RCIF"));
  migrateWorkspaceCache(storage, sync, "cache", "queue", () => null);
  assert.equal(sync.pending().length, 1);
});

test("a durable delete cannot be resurrected by an old server snapshot", () => {
  const sync = new WorkspaceSync(new MemoryStorage(), "owner");
  sync.enqueue("DELETE", "line", {}, line());
  assert.deepEqual(sync.merge([line()]), []);
});

test("a save completed entirely in another tab invalidates an earlier read", async () => {
  const storage = new MemoryStorage();
  const first = new WorkspaceSync(storage, "owner");
  const second = new WorkspaceSync(storage, "owner");
  const snapshot = first.checkpoint();
  second.enqueue("PATCH", "line", { completed: true }, line());
  await second.flush(async () => {});
  assert.notEqual(first.checkpoint(), snapshot);
});

test("independent device edits merge, but the same field cannot silently overwrite", () => {
  const base = { ...line(), archived: false };
  const remote = { ...base, note: "New note from PC", archived: true };
  assert.deepEqual(conflictingFields(remote, base, { completed: true }), []);
  assert.deepEqual(conflictingFields(remote, base, { note: "Old Mac note" }), ["note"]);
  assert.deepEqual(conflictingFields(remote, null, { archived: false }), ["archived"]);
  assert.deepEqual(conflictingFields(remote, base, { note: remote.note }), []);
});

test("a conflict preserves dependent edits for review and shows the shared version", async () => {
  const storage = new MemoryStorage();
  const sync = new WorkspaceSync(storage, "owner");
  const shared = { ...line(), note: "PC note" };
  sync.enqueue("PATCH", "line", { note: "Mac note" }, line());
  sync.enqueue("PATCH", "line", { note: "Final Mac note" }, line());
  await sync.flush(async () => ({ conflict: true, remote: shared }));
  assert.equal(sync.pending().length, 0);
  assert.equal(sync.conflicts().length, 2);
  assert.deepEqual(sync.merge([shared]), [shared]);
  const restarted = new WorkspaceSync(storage, "owner");
  assert.equal(restarted.conflicts()[1].payload.note, "Final Mac note");
  restarted.dismissConflict(restarted.conflicts()[0].key);
  assert.equal(restarted.conflicts().length, 1);
});

test("legacy optimistic patches are preserved for review, not replayed onto the cloud", () => {
  const storage = new MemoryStorage();
  storage.setItem("cache", JSON.stringify([{ ...line(), completed: true }]));
  storage.setItem("queue", JSON.stringify({ line: { completed: true } }));
  const sync = new WorkspaceSync(storage, "owner");
  migrateWorkspaceCache(storage, sync, "cache", "queue", () => null);
  assert.equal(sync.pending().length, 0);
  assert.equal(sync.conflicts()[0].payload.completed, true);
  assert.equal(sync.merge([line()])[0].completed, false);
});

test("acknowledged writes rebase the next local edit without absorbing unrelated remote edits", async () => {
  const sync = new WorkspaceSync(new MemoryStorage(), "owner");
  sync.enqueue("PATCH", "line", { completed: true }, line());
  sync.enqueue("PATCH", "line", { note: "local note" }, line());
  let count = 0;
  await sync.flush(async (write) => {
    count++;
    if (count === 1) return { item: { ...line(), completed: true, note: "remote note", updatedAt: "server-time" } };
    assert.equal(write.base.completed, true);
    assert.equal(write.base.updatedAt, "server-time");
    assert.equal(write.base.note, "Keep this note");
    assert.deepEqual(conflictingFields({ ...line(), note: "remote note" }, write.base, write.payload), ["note"]);
    return { conflict: true, remote: line() };
  });
  assert.equal(sync.conflicts().length, 1);
});

test("idempotent create retries do not absorb intervening remote changes into later edits", async () => {
  const sync = new WorkspaceSync(new MemoryStorage(), "owner");
  sync.enqueue("POST", "line", line(), line());
  sync.enqueue("PATCH", "line", { note: "local note" }, line());
  await sync.flush(async (write) => {
    if (write.method === "POST") return { item: { ...line(), note: "remote note" } };
    assert.equal(write.base.note, "Keep this note");
    return { conflict: true, remote: { ...line(), note: "remote note" } };
  });
  assert.equal(sync.conflicts().length, 1);
});

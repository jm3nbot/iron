type StorageLike = Pick<Storage, "length" | "key" | "getItem" | "setItem" | "removeItem">;
export type WorkspaceWrite<T> = {
  key: string;
  order: number;
  method: "POST" | "PATCH" | "DELETE";
  id: string;
  payload: Partial<T>;
  base?: T;
};
export type WorkspaceConflict<T> = WorkspaceWrite<T> & { remote: T | null };
type WriteResult<T> = { item?: T; conflict?: boolean; remote?: T | null } | void;

/** A write-ahead outbox. Each edit owns a key so tabs never replace each other's queue. */
export class WorkspaceSync<T extends { id: string }> {
  readonly prefix: string;
  revision = 0;
  private running: Promise<void> | null = null;
  private storage: StorageLike;

  constructor(storage: StorageLike, userId: string) {
    this.storage = storage;
    this.prefix = `ink-and-iron-sync-v2:${userId}:`;
  }

  pending(): WorkspaceWrite<T>[] {
    const writes: WorkspaceWrite<T>[] = [];
    for (let index = 0; index < this.storage.length; index += 1) {
      const key = this.storage.key(index);
      if (key?.startsWith(`${this.prefix}pending:`)) {
        const raw = this.storage.getItem(key);
        if (raw) writes.push(JSON.parse(raw) as WorkspaceWrite<T>);
      }
    }
    return writes.sort((a, b) => a.order - b.order || a.key.localeCompare(b.key));
  }

  checkpoint() {
    return `${this.revision}:${this.storage.getItem(`${this.prefix}last-ack`) ?? ""}:${this.pending().map((write) => write.key).join("|")}`;
  }

  conflicts(): WorkspaceConflict<T>[] {
    const result: WorkspaceConflict<T>[] = [];
    for (let index = 0; index < this.storage.length; index += 1) {
      const key = this.storage.key(index);
      if (key?.startsWith(`${this.prefix}conflict:`)) {
        const raw = this.storage.getItem(key);
        if (raw) result.push(JSON.parse(raw));
      }
    }
    return result.sort((a, b) => a.order - b.order);
  }

  preserveConflict(write: WorkspaceWrite<T>, remote: T | null) {
    const key = write.key.replace(":pending:", ":conflict:");
    this.storage.setItem(key, JSON.stringify({ ...write, key, remote }));
    this.storage.setItem(`${this.prefix}last-ack`, crypto.randomUUID());
    this.storage.removeItem(write.key);
    this.revision += 1;
  }

  dismissConflict(key: string) {
    if (!key.startsWith(`${this.prefix}conflict:`)) return;
    const raw = this.storage.getItem(key);
    if (raw) this.storage.setItem(key.replace(":conflict:", ":history:"), raw);
    this.storage.removeItem(key);
    this.revision += 1;
  }

  enqueue(method: WorkspaceWrite<T>["method"], id: string, payload: Partial<T>, base?: T) {
    const order = Math.max(Date.now(), ...this.pending().map((write) => write.order + 1));
    const key = `${this.prefix}pending:${order}:${crypto.randomUUID()}`;
    const write: WorkspaceWrite<T> = { key, order, method, id, payload, base };
    // Persist before acknowledging the action in the UI or starting any network request.
    this.storage.setItem(key, JSON.stringify(write));
    this.revision += 1;
    return write;
  }

  merge(remote: T[]) {
    const merged = new Map(remote.map((item) => [item.id, item]));
    for (const write of this.pending()) {
      if (write.method === "DELETE") {
        merged.delete(write.id);
      } else {
        const base = merged.get(write.id) ?? write.base;
        if (base) merged.set(write.id, { ...base, ...write.payload, id: write.id });
      }
    }
    return [...merged.values()];
  }

  /** Called under a browser-wide Web Lock by the UI; also serializes same-tab callers. */
  flush(send: (write: WorkspaceWrite<T>) => Promise<WriteResult<T>>) {
    if (this.running) return this.running;
    this.running = (async () => {
      // One failed item must not block unrelated lines; dependent writes wait behind it.
      const blocked = new Set<string>();
      let failed = false;
      for (;;) {
        const write = this.pending().find((entry) => !blocked.has(entry.id) &&
          !blocked.has(String((entry.payload as Record<string, unknown>).parentId ?? "")));
        if (!write) break;
        let result: WriteResult<T>;
        try {
          result = await send(write);
        } catch {
          blocked.add(write.id);
          failed = true;
          continue;
        }
        if (result?.conflict) {
          // Preserve the whole dependent branch for review, never keep overlaying it
          // onto the shared workspace or replay it silently against a newer version.
          for (const entry of this.pending().filter((entry) => entry.id === write.id)) {
            this.preserveConflict(entry, result.remote ?? null);
          }
          continue;
        }
        if (result?.item) {
          for (const next of this.pending().filter((entry) => entry.id === write.id && entry.key !== write.key && entry.base)) {
            const base = { ...next.base } as T;
            for (const field of [...Object.keys(write.payload), "updatedAt", "createdAt"]) {
              const confirmed = (result.item as Record<string, unknown>)[field];
              // A duplicate POST can return a row already edited on another device.
              // Never turn those intervening edits into an assumed local baseline.
              if (field in result.item && (field === "updatedAt" || field === "createdAt" ||
                JSON.stringify(confirmed) === JSON.stringify((write.payload as Record<string, unknown>)[field]))) {
                (base as Record<string, unknown>)[field] = confirmed;
              }
            }
            this.storage.setItem(next.key, JSON.stringify({ ...next, base }));
          }
        }
        // Keep recent acknowledged changes as a local recovery journal.
        // If the journal is full, the durable pending entry remains for safe retry.
        this.storage.setItem(write.key.replace(":pending:", ":history:"), JSON.stringify(write));
        this.storage.setItem(`${this.prefix}last-ack`, crypto.randomUUID());
        this.storage.removeItem(write.key);
        this.revision += 1;
        const history: string[] = [];
        for (let i = 0; i < this.storage.length; i += 1) {
          const key = this.storage.key(i);
          if (key?.startsWith(`${this.prefix}history:`)) history.push(key);
        }
        history.sort().slice(0, Math.max(0, history.length - 500)).forEach((key) => this.storage.removeItem(key));
      }
      if (failed) throw new Error("Some changes are still waiting to sync.");
    })().finally(() => { this.running = null; });
    return this.running;
  }
}

/** Legacy cache is preserved before migration; no server snapshot may overwrite it first. */
export function migrateWorkspaceCache<T extends { id: string; content: string }>(
  storage: StorageLike,
  sync: WorkspaceSync<T>,
  cacheKey: string,
  queueKey: string,
  recoverDraft: (id: string, patch: Partial<T>) => T | null,
) {
  const marker = `${sync.prefix}legacy-imported`;
  if (storage.getItem(marker)) return;
  const cache = storage.getItem(cacheKey);
  const queue = storage.getItem(queueKey);
  const backupKey = `${sync.prefix}legacy-backup`;
  if (!storage.getItem(backupKey)) storage.setItem(backupKey, JSON.stringify({ cache, queue }));
  const cached: T[] = cache ? JSON.parse(cache) : [];
  const patches: Record<string, Partial<T>> = queue ? JSON.parse(queue) : {};
  const drafts = new Map(cached.filter((item) => item.id.startsWith("draft-")).map((item) => [item.id, item]));
  for (const [id, patch] of Object.entries(patches)) {
    if (id.startsWith("draft-")) {
      const base = drafts.get(id) ?? recoverDraft(id, patch);
      if (base) drafts.set(id, { ...base, ...patch });
    }
  }
  const pending = sync.pending();
  for (const item of drafts.values()) {
    if (!pending.some((write) => write.method === "POST" && write.id === item.id)) sync.enqueue("POST", item.id, item, item);
  }
  for (const [id, patch] of Object.entries(patches)) {
    if (!id.startsWith("draft-") && !pending.some((write) => write.id === id)) {
      // The old app cached the already-edited value, not its server baseline.
      // It cannot establish whether replaying this patch would undo another device.
      const write = sync.enqueue("PATCH", id, patch, cached.find((item) => item.id === id));
      sync.preserveConflict(write, null);
    }
  }
  storage.setItem(marker, "true");
}

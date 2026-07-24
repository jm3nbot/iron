"use client";

import {
  FormEvent,
  KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

type Section = "now" | "projects" | "library";
type View = Section | "archive";
type Priority = "none" | "high" | "medium" | "low";
type SaveStatus = "saved" | "saving" | "retry";

type Item = {
  id: string;
  content: string;
  section: Section;
  groupName: string;
  url: string | null;
  priority: Priority;
  dueDate: string | null;
  completed: boolean;
  archived: boolean;
  position: number;
  indent: number;
  bold: boolean;
  createdAt: string;
  updatedAt: string;
};

type Patch = Partial<Omit<Item, "id" | "createdAt" | "updatedAt">>;

const views: { id: View; label: string; mark: string }[] = [
  { id: "now", label: "Now", mark: "01" },
  { id: "projects", label: "Projects", mark: "02" },
  { id: "library", label: "Library", mark: "03" },
  { id: "archive", label: "Archive", mark: "04" },
];

const priorityOrder: Priority[] = ["none", "high", "medium", "low"];
const CACHE_KEY = "ink-and-iron-workspace-v1";
const QUEUE_KEY = "ink-and-iron-pending-v1";

function isUrl(value: string) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function dueState(date: string | null) {
  if (!date) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const due = new Date(`${date}T00:00:00`);
  const days = Math.round((due.getTime() - today.getTime()) / 86400000);
  if (days < 0) return { label: `${Math.abs(days)}d overdue`, tone: "overdue" };
  if (days === 0) return { label: "Due today", tone: "today" };
  if (days <= 7) return { label: `Due in ${days}d`, tone: "upcoming" };
  return { label: due.toLocaleDateString(undefined, { month: "short", day: "numeric" }), tone: "quiet" };
}

function sortItems(a: Item, b: Item) {
  return a.position - b.position || a.createdAt.localeCompare(b.createdAt);
}

export default function Home() {
  const [items, setItems] = useState<Item[]>([]);
  const [activeView, setActiveView] = useState<View>("now");
  const [query, setQuery] = useState("");
  const [capture, setCapture] = useState("");
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("saving");
  const [loading, setLoading] = useState(true);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [newProject, setNewProject] = useState("");
  const [showNewProject, setShowNewProject] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  const cacheItems = useCallback((next: Item[]) => {
    localStorage.setItem(CACHE_KEY, JSON.stringify(next));
  }, []);

  const markSaved = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => setSaveStatus("saved"), 350);
  }, []);

  const sendPatch = useCallback(
    async (id: string, patch: Patch) => {
      setSaveStatus("saving");
      const body = { id, ...patch };
      try {
        const response = await fetch("/api/items", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!response.ok) throw new Error("Save failed");
        const pending = JSON.parse(localStorage.getItem(QUEUE_KEY) ?? "{}") as Record<string, Patch>;
        delete pending[id];
        localStorage.setItem(QUEUE_KEY, JSON.stringify(pending));
        markSaved();
      } catch {
        const pending = JSON.parse(localStorage.getItem(QUEUE_KEY) ?? "{}") as Record<string, Patch>;
        pending[id] = { ...(pending[id] ?? {}), ...patch };
        localStorage.setItem(QUEUE_KEY, JSON.stringify(pending));
        setSaveStatus("retry");
      }
    },
    [markSaved],
  );

  const flushPending = useCallback(async () => {
    const pending = JSON.parse(localStorage.getItem(QUEUE_KEY) ?? "{}") as Record<string, Patch>;
    const entries = Object.entries(pending);
    if (!entries.length) return;
    for (const [id, patch] of entries) await sendPatch(id, patch);
  }, [sendPatch]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const response = await fetch("/api/items", { cache: "no-store" });
        if (!response.ok) throw new Error("Load failed");
        const data = (await response.json()) as { items: Item[] };
        if (!cancelled) {
          setItems(data.items);
          cacheItems(data.items);
          setSaveStatus("saved");
          void flushPending();
        }
      } catch {
        const cached = localStorage.getItem(CACHE_KEY);
        if (cached && !cancelled) {
          setItems(JSON.parse(cached) as Item[]);
          setSaveStatus("retry");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    window.addEventListener("online", flushPending);
    return () => {
      cancelled = true;
      window.removeEventListener("online", flushPending);
    };
  }, [cacheItems, flushPending]);

  useEffect(() => {
    const focusSearch = (event: globalThis.KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, []);

  const updateItem = useCallback(
    (id: string, patch: Patch) => {
      setItems((current) => {
        const next = current.map((item) => (item.id === id ? { ...item, ...patch } : item));
        cacheItems(next);
        return next;
      });
      void sendPatch(id, patch);
    },
    [cacheItems, sendPatch],
  );

  const createItem = useCallback(
    async (content: string, section: Section, groupName = "", url: string | null = null) => {
      const clean = content.trim();
      if (!clean) return;
      const timestamp = new Date().toISOString();
      const optimistic: Item = {
        id: `draft-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        content: clean,
        section,
        groupName,
        url,
        priority: "none",
        dueDate: null,
        completed: false,
        archived: false,
        position: items.filter((item) => item.section === section && item.groupName === groupName).length,
        indent: 0,
        bold: false,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      setItems((current) => {
        const next = [...current, optimistic];
        cacheItems(next);
        return next;
      });
      setSaveStatus("saving");
      try {
        const response = await fetch("/api/items", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: clean, section, groupName, url }),
        });
        if (!response.ok) throw new Error("Create failed");
        const { item } = (await response.json()) as { item: Item };
        setItems((current) => {
          const next = current.map((entry) => (entry.id === optimistic.id ? item : entry));
          cacheItems(next);
          return next;
        });
        markSaved();
      } catch {
        setSaveStatus("retry");
      }
    },
    [cacheItems, items, markSaved],
  );

  const handleCapture = (event: FormEvent) => {
    event.preventDefault();
    const value = capture.trim();
    if (!value) return;
    void createItem(isUrl(value) ? new URL(value).hostname.replace(/^www\./, "") : value, "now", "", isUrl(value) ? value : null);
    setCapture("");
    setActiveView("now");
  };

  const deleteItem = useCallback(
    async (item: Item) => {
      if (!window.confirm(`Permanently delete “${item.content}”?`)) return;
      setItems((current) => {
        const next = current.filter((entry) => entry.id !== item.id);
        cacheItems(next);
        return next;
      });
      setSaveStatus("saving");
      try {
        const response = await fetch("/api/items", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: item.id }),
        });
        if (!response.ok) throw new Error("Delete failed");
        markSaved();
      } catch {
        setItems((current) => {
          const next = [...current, item];
          cacheItems(next);
          return next;
        });
        setSaveStatus("retry");
      }
    },
    [cacheItems, markSaved],
  );

  const activeItems = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle) {
      return items
        .filter((item) =>
          `${item.content} ${item.groupName} ${item.url ?? ""}`.toLowerCase().includes(needle),
        )
        .sort(sortItems);
    }
    if (activeView === "archive") return items.filter((item) => item.archived).sort(sortItems);
    return items
      .filter((item) => item.section === activeView && !item.archived)
      .sort(sortItems);
  }, [activeView, items, query]);

  const counts = useMemo(
    () => ({
      now: items.filter((item) => item.section === "now" && !item.archived && !item.completed).length,
      projects: new Set(items.filter((item) => item.section === "projects" && !item.archived).map((item) => item.groupName)).size,
      library: items.filter((item) => item.section === "library" && !item.archived).length,
      archive: items.filter((item) => item.archived).length,
    }),
    [items],
  );

  const groups = useMemo(() => {
    const grouped = new Map<string, Item[]>();
    for (const item of activeItems) {
      const key = item.groupName || (item.section === "now" ? "Now" : "Unsorted");
      grouped.set(key, [...(grouped.get(key) ?? []), item]);
    }
    return [...grouped.entries()];
  }, [activeItems]);

  const reorder = (targetId: string) => {
    if (!draggingId || draggingId === targetId) return;
    const dragged = items.find((item) => item.id === draggingId);
    const target = items.find((item) => item.id === targetId);
    if (!dragged || !target || dragged.section !== target.section || dragged.groupName !== target.groupName) return;
    const siblings = items
      .filter((item) => item.section === dragged.section && item.groupName === dragged.groupName && item.archived === dragged.archived)
      .sort(sortItems);
    const from = siblings.findIndex((item) => item.id === dragged.id);
    const to = siblings.findIndex((item) => item.id === target.id);
    const ordered = [...siblings];
    ordered.splice(to, 0, ordered.splice(from, 1)[0]);
    const positions = new Map(ordered.map((item, index) => [item.id, index]));
    setItems((current) => {
      const next = current.map((item) =>
        positions.has(item.id) ? { ...item, position: positions.get(item.id)! } : item,
      );
      cacheItems(next);
      return next;
    });
    for (const [id, position] of positions) void sendPatch(id, { position });
    setDraggingId(null);
  };

  const toggleGroup = (name: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const viewTitle = query
    ? "Search"
    : activeView === "now"
      ? "Now"
      : activeView === "projects"
        ? "Projects"
        : activeView === "library"
          ? "Library"
          : "Archive";

  const viewDeck = query
    ? `${activeItems.length} result${activeItems.length === 1 ? "" : "s"} across your whole workspace.`
    : activeView === "now"
      ? "Choose what deserves your attention. Everything else can wait."
      : activeView === "projects"
        ? "Active bodies of work, each with a clear next line."
        : activeView === "library"
          ? "Ideas, references, and skills worth returning to."
          : "Out of sight, never truly lost.";

  return (
    <main className="workspace">
      <aside className="rail">
        <div className="brand">
          <span className="brand-mark">I&amp;I</span>
          <div>
            <strong>Ink &amp; Iron</strong>
            <small>Personal command center</small>
          </div>
        </div>

        <nav aria-label="Workspace sections">
          {views.map((view) => (
            <button
              className={`nav-item ${activeView === view.id && !query ? "active" : ""}`}
              key={view.id}
              onClick={() => {
                setActiveView(view.id);
                setQuery("");
              }}
            >
              <span className="nav-mark">{view.mark}</span>
              <span>{view.label}</span>
              <em>{counts[view.id]}</em>
            </button>
          ))}
        </nav>

        <div className="rail-foot">
          <div className={`save-state ${saveStatus}`}>
            <span />
            {saveStatus === "saved" ? "All changes saved" : saveStatus === "saving" ? "Forging changes" : "Saved locally · retrying"}
          </div>
          <p>Make the next move smaller.</p>
        </div>
      </aside>

      <section className="canvas">
        <header className="topbar">
          <div className="mobile-brand">INK <span>&amp;</span> IRON</div>
          <label className="search">
            <span aria-hidden="true">⌕</span>
            <input
              ref={searchRef}
              aria-label="Search everything"
              placeholder="Search everything"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <kbd>⌘ K</kbd>
          </label>
        </header>

        <div className="document">
          <div className="masthead">
            <div>
              <span className="eyebrow">{query ? "Across all sections" : `Section / ${viewTitle}`}</span>
              <h1>{viewTitle}<i>.</i></h1>
              <p>{viewDeck}</p>
            </div>
            <time>{new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}</time>
          </div>

          <form className="capture" onSubmit={handleCapture}>
            <span className="capture-plus">+</span>
            <input
              aria-label="Quick capture"
              placeholder="Capture a thought, task, or paste a link…"
              value={capture}
              onChange={(event) => setCapture(event.target.value)}
            />
            <button type="submit">Add to Now <span>↵</span></button>
          </form>

          {loading ? (
            <div className="loading-lines" aria-label="Loading workspace">
              <span /><span /><span /><span />
            </div>
          ) : activeItems.length === 0 ? (
            <div className="empty-state">
              <span>∅</span>
              <h2>Clear space.</h2>
              <p>{query ? "No line matches that search." : "There is nothing here yet. Add the first line."}</p>
              {!query && activeView !== "archive" && (
                <button onClick={() => void createItem("New thought", activeView as Section)}>Add a line</button>
              )}
            </div>
          ) : query || activeView === "now" || activeView === "archive" ? (
            <div className="line-list">
              <div className="list-rule">
                <span>{query ? "Results" : activeView === "archive" ? "Archived lines" : "Current queue"}</span>
                <span>{activeItems.length} lines</span>
              </div>
              {activeItems.map((item) => (
                <ItemLine
                  key={item.id}
                  item={item}
                  updateItem={updateItem}
                  deleteItem={deleteItem}
                  onDragStart={() => setDraggingId(item.id)}
                  onDrop={() => reorder(item.id)}
                />
              ))}
              {!query && activeView === "now" && (
                <InlineAdd onAdd={(value) => void createItem(value, "now")} />
              )}
            </div>
          ) : (
            <div className="group-list">
              <div className="list-rule">
                <span>{activeView === "projects" ? "Active projects" : "Collections"}</span>
                <span>{groups.length} groups</span>
              </div>
              {groups.map(([name, groupItems], index) => (
                <section className="group" key={name}>
                  <button className="group-head" onClick={() => toggleGroup(name)}>
                    <span className="group-number">{String(index + 1).padStart(2, "0")}</span>
                    <span className="group-name">{name}</span>
                    <span className="group-count">{groupItems.length} lines</span>
                    <span className={`chevron ${collapsed.has(name) ? "closed" : ""}`}>⌄</span>
                  </button>
                  {!collapsed.has(name) && (
                    <div className="group-body">
                      {groupItems.map((item) => (
                        <ItemLine
                          key={item.id}
                          item={item}
                          updateItem={updateItem}
                          deleteItem={deleteItem}
                          onDragStart={() => setDraggingId(item.id)}
                          onDrop={() => reorder(item.id)}
                        />
                      ))}
                      <InlineAdd onAdd={(value) => void createItem(value, activeView as Section, name)} />
                    </div>
                  )}
                </section>
              ))}
              {activeView === "projects" && (
                showNewProject ? (
                  <form
                    className="new-project"
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (!newProject.trim()) return;
                      void createItem("First action", "projects", newProject.trim());
                      setNewProject("");
                      setShowNewProject(false);
                    }}
                  >
                    <input autoFocus value={newProject} onChange={(event) => setNewProject(event.target.value)} placeholder="Project name" />
                    <button type="submit">Create project</button>
                  </form>
                ) : (
                  <button className="add-project" onClick={() => setShowNewProject(true)}>+ New project</button>
                )
              )}
            </div>
          )}
        </div>
      </section>
    </main>
  );
}

function InlineAdd({ onAdd }: { onAdd: (value: string) => void }) {
  const [value, setValue] = useState("");
  return (
    <form
      className="inline-add"
      onSubmit={(event) => {
        event.preventDefault();
        if (!value.trim()) return;
        onAdd(value);
        setValue("");
      }}
    >
      <span>+</span>
      <input aria-label="Add a line" value={value} onChange={(event) => setValue(event.target.value)} placeholder="Add a line…" />
    </form>
  );
}

function ItemLine({
  item,
  updateItem,
  deleteItem,
  onDragStart,
  onDrop,
}: {
  item: Item;
  updateItem: (id: string, patch: Patch) => void;
  deleteItem: (item: Item) => void;
  onDragStart: () => void;
  onDrop: () => void;
}) {
  const [draft, setDraft] = useState(item.content);
  const state = dueState(item.dueDate);

  useEffect(() => setDraft(item.content), [item.content]);

  const commit = () => {
    const clean = draft.trim() || "Untitled";
    setDraft(clean);
    if (clean !== item.content) updateItem(item.id, { content: clean });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      event.currentTarget.blur();
    }
    if (event.key === "Escape") {
      setDraft(item.content);
      event.currentTarget.blur();
    }
  };

  const changeLink = () => {
    const value = window.prompt("Paste a link for this line", item.url ?? "");
    if (value === null) return;
    updateItem(item.id, { url: value.trim() || null });
  };

  const nextPriority =
    priorityOrder[(priorityOrder.indexOf(item.priority) + 1) % priorityOrder.length];

  return (
    <article
      className={`item-line ${item.completed ? "completed" : ""}`}
      style={{ "--indent": item.indent } as React.CSSProperties}
      draggable
      onDragStart={onDragStart}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        onDrop();
      }}
    >
      <button className="drag-handle" aria-label={`Reorder ${item.content}`}>⠿</button>
      <button
        className="check"
        aria-label={item.completed ? `Restore ${item.content}` : `Complete ${item.content}`}
        onClick={() => updateItem(item.id, { completed: !item.completed })}
      >
        {item.completed ? "✓" : ""}
      </button>
      <div className="item-main">
        <div className="item-copy">
          <input
            aria-label={`Edit ${item.content}`}
            className={item.bold ? "bold" : ""}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={onKeyDown}
          />
          {item.url && (
            <a href={item.url} target="_blank" rel="noreferrer" aria-label={`Open link for ${item.content}`}>↗</a>
          )}
        </div>
        <div className="item-meta">
          <button
            className={`priority priority-${item.priority}`}
            title={`Priority: ${item.priority}. Click for ${nextPriority}.`}
            onClick={() => updateItem(item.id, { priority: nextPriority })}
          >
            {item.priority === "none" ? "No priority" : item.priority}
          </button>
          <label className={`date-field ${state?.tone ?? ""}`}>
            <span>{state?.label ?? "Set date"}</span>
            <input
              aria-label={`Due date for ${item.content}`}
              type="date"
              value={item.dueDate ?? ""}
              onChange={(event) => updateItem(item.id, { dueDate: event.target.value || null })}
            />
          </label>
          {item.section !== "now" && <span className="group-tag">{item.groupName}</span>}
        </div>
      </div>
      <div className="line-tools">
        <button className={item.bold ? "selected" : ""} aria-label="Toggle bold" onClick={() => updateItem(item.id, { bold: !item.bold })}>B</button>
        <button aria-label="Edit link" onClick={changeLink}>↗</button>
        <button aria-label="Decrease indent" disabled={item.indent === 0} onClick={() => updateItem(item.id, { indent: item.indent - 1 })}>←</button>
        <button aria-label="Increase indent" disabled={item.indent === 2} onClick={() => updateItem(item.id, { indent: item.indent + 1 })}>→</button>
        <select
          aria-label={`Move ${item.content}`}
          value={item.section}
          onChange={(event) => updateItem(item.id, { section: event.target.value as Section, groupName: event.target.value === "now" ? "" : item.groupName || "Unsorted" })}
        >
          <option value="now">Now</option>
          <option value="projects">Projects</option>
          <option value="library">Library</option>
        </select>
        <button aria-label={item.archived ? "Restore from archive" : "Archive"} onClick={() => updateItem(item.id, { archived: !item.archived })}>
          {item.archived ? "↺" : "□"}
        </button>
        {item.archived && (
          <button className="delete-tool" aria-label="Delete permanently" onClick={() => deleteItem(item)}>×</button>
        )}
      </div>
    </article>
  );
}

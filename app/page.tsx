"use client";

import {
  FormEvent,
  KeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
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
type SortMode = "manual" | "priority" | "recent";
type SelectionRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

type Item = {
  id: string;
  content: string;
  section: Section;
  groupName: string;
  url: string | null;
  links: string[];
  note: string;
  parentId: string | null;
  priority: Priority;
  dueDate: string | null;
  completed: boolean;
  archived: boolean;
  archivedAt: string | null;
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
const capturePhrases = [
  "Capture a thought…",
  "Paste a link…",
  "What needs your attention?",
  "Start with one clear line…",
];

function isUrl(value: string) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function findUrl(value: string) {
  const match = value.match(/https?:\/\/[^\s<>"']+/i);
  return match?.[0].replace(/[),.;!?]+$/, "") ?? null;
}

function linkLabel(value: string) {
  try {
    return new URL(value).hostname.replace(/^www\./, "");
  } catch {
    return "Open link";
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
  if (days <= 2) return { label: `Due in ${days}d`, tone: "imminent" };
  if (days <= 7) return { label: `Due in ${days}d`, tone: "upcoming" };
  return { label: due.toLocaleDateString(undefined, { month: "short", day: "numeric" }), tone: "quiet" };
}

function sortItems(a: Item, b: Item) {
  return a.position - b.position || a.createdAt.localeCompare(b.createdAt);
}

function sortVisibleItems(items: Item[], mode: SortMode) {
  const copy = [...items];
  if (mode === "recent") {
    return copy.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  if (mode === "priority") {
    const weight: Record<Priority, number> = {
      high: 0,
      medium: 1,
      low: 2,
      none: 3,
    };
    return copy.sort((a, b) => weight[a.priority] - weight[b.priority] || sortItems(a, b));
  }
  return copy.sort(sortItems);
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
  const [newCollection, setNewCollection] = useState("");
  const [showNewCollection, setShowNewCollection] = useState(false);
  const [sortMode, setSortMode] = useState<SortMode>("manual");
  const [sidebarWidth, setSidebarWidth] = useState(248);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [selectionRect, setSelectionRect] = useState<SelectionRect | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [capturePhrase, setCapturePhrase] = useState(0);
  const [captureCharacters, setCaptureCharacters] = useState(0);
  const [captureDeleting, setCaptureDeleting] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const captureRef = useRef<HTMLInputElement | null>(null);
  const marqueeCleanupRef = useRef<(() => void) | null>(null);

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
    const storedWidth = Number(localStorage.getItem("ink-and-iron-sidebar-width"));
    const storedCollapsed = localStorage.getItem("ink-and-iron-sidebar-collapsed");
    if (storedWidth >= 190 && storedWidth <= 340) setSidebarWidth(storedWidth);
    setSidebarCollapsed(storedCollapsed === "true");
  }, []);

  useEffect(() => {
    const phrase = capturePhrases[capturePhrase];
    let delay = captureDeleting ? 32 : 62;
    if (!captureDeleting && captureCharacters === phrase.length) delay = 1450;
    if (captureDeleting && captureCharacters === 0) delay = 280;
    const timer = window.setTimeout(() => {
      if (!captureDeleting && captureCharacters < phrase.length) {
        setCaptureCharacters((count) => count + 1);
      } else if (!captureDeleting) {
        setCaptureDeleting(true);
      } else if (captureCharacters > 0) {
        setCaptureCharacters((count) => count - 1);
      } else {
        setCaptureDeleting(false);
        setCapturePhrase((index) => (index + 1) % capturePhrases.length);
      }
    }, delay);
    return () => window.clearTimeout(timer);
  }, [captureCharacters, captureDeleting, capturePhrase]);

  useEffect(() => {
    const focusSearch = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        marqueeCleanupRef.current?.();
        setSelectedIds(new Set());
        setSelectionRect(null);
        setSelecting(false);
        return;
      }
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
    async (
      content: string,
      section: Section,
      groupName = "",
      url: string | null = null,
      indent = 0,
      positionOverride: number | null = null,
      parentId: string | null = null,
    ) => {
      const clean = content.trim();
      if (!clean) return;
      const detectedUrl = url ?? findUrl(clean);
      const displayContent = isUrl(clean) ? linkLabel(clean) : clean;
      const timestamp = new Date().toISOString();
      const optimistic: Item = {
        id: `draft-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        content: displayContent,
        section,
        groupName,
        url: null,
        links: detectedUrl ? [detectedUrl] : [],
        note: "",
        parentId,
        priority: "none",
        dueDate: null,
        completed: false,
        archived: false,
        archivedAt: null,
        position:
          positionOverride ??
          items.filter((item) => item.section === section && item.groupName === groupName).length,
        indent,
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
          body: JSON.stringify({
            content: displayContent,
            section,
            groupName,
            links: detectedUrl ? [detectedUrl] : [],
            indent,
            position: positionOverride,
            parentId,
          }),
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

  const createSubItem = useCallback(
    (parent: Item) => {
      setSortMode("manual");
      const siblings = items
        .filter(
          (item) =>
            item.section === parent.section &&
            item.groupName === parent.groupName &&
            item.archived === parent.archived,
        )
        .sort(sortItems);
      const parentIndex = siblings.findIndex((item) => item.id === parent.id);
      if (parentIndex < 0) return;

      let insertionIndex = parentIndex + 1;
      while (
        insertionIndex < siblings.length &&
        siblings[insertionIndex].indent > parent.indent
      ) {
        insertionIndex += 1;
      }

      const positionUpdates = new Map<string, number>();
      siblings.forEach((item, index) => {
        const position = index >= insertionIndex ? index + 1 : index;
        if (item.position !== position) positionUpdates.set(item.id, position);
      });
      if (positionUpdates.size) {
        setItems((current) => {
          const next = current.map((item) =>
            positionUpdates.has(item.id)
              ? { ...item, position: positionUpdates.get(item.id)! }
              : item,
          );
          cacheItems(next);
          return next;
        });
        for (const [id, position] of positionUpdates) {
          void sendPatch(id, { position });
        }
      }

      void createItem(
        "New sub-point",
        parent.section,
        parent.groupName,
        null,
        Math.min(3, parent.indent + 1),
        insertionIndex,
        parent.id,
      );
    },
    [cacheItems, createItem, items, sendPatch],
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
      const results = items
        .filter((item) =>
          `${item.content} ${item.groupName} ${item.url ?? ""}`.toLowerCase().includes(needle),
        );
      return sortVisibleItems(results, sortMode);
    }
    if (activeView === "archive") return sortVisibleItems(items.filter((item) => item.archived), sortMode);
    return sortVisibleItems(
      items.filter((item) => item.section === activeView && !item.archived),
      sortMode,
    );
  }, [activeView, items, query, sortMode]);

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

  const selectedItems = useMemo(
    () => items.filter((item) => selectedIds.has(item.id)),
    [items, selectedIds],
  );

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

  const quickAddFor = (view: View) => {
    setActiveView(view);
    setQuery("");
    if (view === "projects") {
      setShowNewProject(true);
      return;
    }
    if (view === "library") {
      setShowNewCollection(true);
      return;
    }
    if (view === "archive") return;
    void createItem(
      view === "library" ? "New reference" : "New item",
      view,
      view === "library" ? "Unsorted" : "",
    );
  };

  const resizeSidebar = (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    if (sidebarCollapsed) setSidebarCollapsed(false);
    const startX = event.clientX;
    const startWidth = sidebarCollapsed ? 190 : sidebarWidth;
    const move = (moveEvent: PointerEvent) => {
      const width = Math.max(190, Math.min(340, startWidth + moveEvent.clientX - startX));
      setSidebarWidth(width);
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      setSidebarWidth((width) => {
        localStorage.setItem("ink-and-iron-sidebar-width", String(width));
        return width;
      });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  };

  const toggleSidebar = () => {
    setSidebarCollapsed((current) => {
      localStorage.setItem("ink-and-iron-sidebar-collapsed", String(!current));
      return !current;
    });
  };

  const startMarquee = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!event.shiftKey || event.button !== 0) return;
    const target = event.target;
    if (
      target instanceof HTMLElement &&
      target.closest("input, textarea, button, a, select, .bulk-toolbar")
    ) {
      return;
    }
    event.preventDefault();
    window.getSelection()?.removeAllRanges();
    const startX = event.clientX;
    const startY = event.clientY;
    const baseSelection = new Set(selectedIds);
    setSelecting(true);
    setSelectionRect({ left: startX, top: startY, width: 0, height: 0 });

    const move = (moveEvent: PointerEvent) => {
      moveEvent.preventDefault();
      window.getSelection()?.removeAllRanges();
      const left = Math.min(startX, moveEvent.clientX);
      const top = Math.min(startY, moveEvent.clientY);
      const right = Math.max(startX, moveEvent.clientX);
      const bottom = Math.max(startY, moveEvent.clientY);
      setSelectionRect({
        left,
        top,
        width: right - left,
        height: bottom - top,
      });

      const next = new Set(baseSelection);
      document.querySelectorAll<HTMLElement>("[data-item-id]").forEach((element) => {
        const bounds = element.getBoundingClientRect();
        const intersects =
          bounds.left < right &&
          bounds.right > left &&
          bounds.top < bottom &&
          bounds.bottom > top;
        if (intersects) {
          const id = element.dataset.itemId;
          if (id) next.add(id);
        }
      });
      setSelectedIds(next);
    };

    const cleanup = () => {
      marqueeCleanupRef.current = null;
      setSelecting(false);
      setSelectionRect(null);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
    const stop = () => cleanup();
    marqueeCleanupRef.current = cleanup;
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", stop);
  };

  const applyToSelection = (patch: Patch) => {
    for (const item of selectedItems) updateItem(item.id, patch);
  };

  const addSharedNote = () => {
    const note = window.prompt("Add this note to every selected item", "");
    if (!note?.trim()) return;
    for (const item of selectedItems) {
      updateItem(item.id, {
        note: [item.note?.trim(), note.trim()].filter(Boolean).join("\n"),
      });
    }
  };

  const deleteSelection = async () => {
    if (!selectedItems.length) return;
    if (!window.confirm(`Permanently delete ${selectedItems.length} selected items?`)) return;
    const removed = [...selectedItems];
    setItems((current) => {
      const next = current.filter((item) => !selectedIds.has(item.id));
      cacheItems(next);
      return next;
    });
    setSelectedIds(new Set());
    setSaveStatus("saving");
    try {
      const responses = await Promise.all(
        removed.map((item) =>
          fetch("/api/items", {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: item.id }),
          }),
        ),
      );
      if (responses.some((response) => !response.ok)) throw new Error("Bulk delete failed");
      markSaved();
    } catch {
      setItems((current) => {
        const ids = new Set(current.map((item) => item.id));
        const next = [...current, ...removed.filter((item) => !ids.has(item.id))];
        cacheItems(next);
        return next;
      });
      setSaveStatus("retry");
    }
  };

  return (
    <main
      className={`workspace ${sidebarCollapsed ? "sidebar-collapsed" : ""} ${selecting ? "is-selecting" : ""}`}
      style={{ "--sidebar-width": `${sidebarCollapsed ? 64 : sidebarWidth}px` } as React.CSSProperties}
    >
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
            <div className="nav-row" key={view.id}>
              <button
                className={`nav-item ${activeView === view.id && !query ? "active" : ""}`}
                onClick={() => {
                  setActiveView(view.id);
                  setQuery("");
                }}
              >
                <span className="nav-mark">{view.mark}</span>
                <span>{view.label}</span>
                <em>{counts[view.id]}</em>
              </button>
              {view.id !== "archive" && (
                <button className="nav-plus" aria-label={`Add to ${view.label}`} onClick={() => quickAddFor(view.id)}>+</button>
              )}
            </div>
          ))}
        </nav>

        <div className="rail-foot">
          <div className={`save-state ${saveStatus}`}>
            <span />
            {saveStatus === "saved" ? "All changes saved" : saveStatus === "saving" ? "Forging changes" : "Saved locally · retrying"}
          </div>
          <p>Make the next move smaller.</p>
        </div>
        <button className="sidebar-toggle" onClick={toggleSidebar} aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}>
          {sidebarCollapsed ? "›" : "‹"}
        </button>
        <button className="sidebar-resize" onPointerDown={resizeSidebar} aria-label="Resize sidebar" />
      </aside>

      <section className="canvas">
        <header className="topbar">
          <div className="topbar-title">
            <strong>Ink <span>&amp;</span> Iron</strong>
            <i>/</i>
            <em>{viewTitle}</em>
          </div>
          <div className="topbar-tools">
            <label className="sort-control">
              <span>Filter by</span>
              <select value={sortMode} onChange={(event) => setSortMode(event.target.value as SortMode)}>
                <option value="manual">Manual order</option>
                <option value="priority">Priority</option>
                <option value="recent">Recent</option>
              </select>
            </label>
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
          </div>
        </header>

        <div className="document" onPointerDown={startMarquee}>
          <form className="capture" onSubmit={handleCapture}>
            <span className="capture-plus">+</span>
            <input
              ref={captureRef}
              aria-label="Quick capture"
              placeholder=""
              value={capture}
              onChange={(event) => setCapture(event.target.value)}
            />
            {!capture && (
              <span className="capture-typewriter" aria-hidden="true">
                {capturePhrases[capturePhrase].slice(0, captureCharacters)}
                <i />
              </span>
            )}
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
              <p>{query ? "No line matches that search." : activeView === "projects" ? "Create a project, then add lines inside it." : activeView === "library" ? "Create a collection, then add references inside it." : "There is nothing here yet. Add the first line."}</p>
              {!query && activeView === "projects" ? (
                showNewProject ? (
                  <form
                    className="new-project empty-project-form"
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
                  <button onClick={() => setShowNewProject(true)}>+ New project</button>
                )
              ) : !query && activeView === "library" ? (
                showNewCollection ? (
                  <form
                    className="new-project empty-project-form"
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (!newCollection.trim()) return;
                      void createItem("First item", "library", newCollection.trim());
                      setNewCollection("");
                      setShowNewCollection(false);
                    }}
                  >
                    <input autoFocus value={newCollection} onChange={(event) => setNewCollection(event.target.value)} placeholder="Collection name" />
                    <button type="submit">Create collection</button>
                  </form>
                ) : (
                  <button onClick={() => setShowNewCollection(true)}>+ New collection</button>
                )
              ) : !query && activeView !== "archive" && (
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
                  selected={selectedIds.has(item.id)}
                  updateItem={updateItem}
                  deleteItem={deleteItem}
                  addSubItem={() => createSubItem(item)}
                  onDragStart={() => setDraggingId(item.id)}
                  onDrop={() => reorder(item.id)}
                />
              ))}
              {!query && activeView === "now" && (
                <InlineAdd onAdd={(value) => void createItem(value, activeView)} />
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
                          selected={selectedIds.has(item.id)}
                          updateItem={updateItem}
                          deleteItem={deleteItem}
                          addSubItem={() => createSubItem(item)}
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
              {activeView === "library" && (
                showNewCollection ? (
                  <form
                    className="new-project"
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (!newCollection.trim()) return;
                      void createItem("First item", "library", newCollection.trim());
                      setNewCollection("");
                      setShowNewCollection(false);
                    }}
                  >
                    <input autoFocus value={newCollection} onChange={(event) => setNewCollection(event.target.value)} placeholder="Collection name" />
                    <button type="submit">Create collection</button>
                  </form>
                ) : (
                  <button className="add-project" onClick={() => setShowNewCollection(true)}>+ New collection</button>
                )
              )}
            </div>
          )}
        </div>
        {selectionRect && (
          <div
            className="selection-marquee"
            style={{
              left: selectionRect.left,
              top: selectionRect.top,
              width: selectionRect.width,
              height: selectionRect.height,
            }}
          />
        )}
        {selectedItems.length > 0 && (
          <div className="bulk-toolbar" role="toolbar" aria-label="Selected item actions">
            <strong>{selectedItems.length} selected</strong>
            <select
              aria-label="Set priority for selected items"
              defaultValue=""
              onChange={(event) => {
                if (!event.target.value) return;
                applyToSelection({ priority: event.target.value as Priority });
                event.currentTarget.value = "";
              }}
            >
              <option value="" disabled>Priority</option>
              <option value="high">High</option>
              <option value="medium">Medium</option>
              <option value="low">Low</option>
              <option value="none">None</option>
            </select>
            <button onClick={() => applyToSelection({ bold: true })}>Bold</button>
            <button onClick={addSharedNote}>Add note</button>
            <button onClick={() => applyToSelection({ archived: true, archivedAt: new Date().toISOString() })}>Archive</button>
            <button className="danger" onClick={() => void deleteSelection()}>Delete</button>
            <button className="bulk-close" aria-label="Clear selection" onClick={() => setSelectedIds(new Set())}>×</button>
          </div>
        )}
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
  selected,
  updateItem,
  deleteItem,
  addSubItem,
  onDragStart,
  onDrop,
}: {
  item: Item;
  selected: boolean;
  updateItem: (id: string, patch: Patch) => void;
  deleteItem: (item: Item) => void;
  addSubItem: () => void;
  onDragStart: () => void;
  onDrop: () => void;
}) {
  const [draft, setDraft] = useState(item.content);
  const [noteOpen, setNoteOpen] = useState(Boolean(item.note));
  const [noteDraft, setNoteDraft] = useState(item.note ?? "");
  const [hovered, setHovered] = useState(false);
  const state = dueState(item.dueDate);

  useEffect(() => setDraft(item.content), [item.content]);
  useEffect(() => setNoteDraft(item.note ?? ""), [item.note]);

  useEffect(() => {
    if (!hovered) return;
    const shortcut = (event: globalThis.KeyboardEvent) => {
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.matches("input, textarea, select, button, a") ||
          target.isContentEditable)
      ) {
        return;
      }
      if (event.key.toLowerCase() === "n") {
        event.preventDefault();
        setNoteOpen((open) => !open);
      }
      if (event.key.toLowerCase() === "b") {
        event.preventDefault();
        updateItem(item.id, { bold: !item.bold });
      }
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, [hovered, item.bold, item.id, updateItem]);

  const commit = () => {
    const clean = draft.trim() || "Untitled";
    setDraft(clean);
    const detectedUrl = findUrl(clean);
    const patch: Patch = {};
    if (clean !== item.content) patch.content = clean;
    if (detectedUrl && !(item.links ?? []).includes(detectedUrl)) {
      patch.links = [...(item.links ?? []), detectedUrl];
    }
    if (Object.keys(patch).length) updateItem(item.id, patch);
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

  const addLink = () => {
    const value = window.prompt("Paste a link for this line", "");
    if (value === null) return;
    const link = findUrl(value.trim());
    if (!link) {
      window.alert("Please paste a complete http:// or https:// link.");
      return;
    }
    updateItem(item.id, { links: [...new Set([...(item.links ?? []), link])] });
  };

  const removeLink = (link: string) => {
    updateItem(item.id, {
      links: (item.links ?? []).filter((candidate) => candidate !== link),
      url: item.url === link ? null : item.url,
    });
  };

  const commitNote = () => {
    if (noteDraft !== (item.note ?? "")) updateItem(item.id, { note: noteDraft });
    if (!noteDraft.trim()) setNoteOpen(false);
  };

  const nextPriority =
    priorityOrder[(priorityOrder.indexOf(item.priority) + 1) % priorityOrder.length];

  const openNoteOnDoubleClick = (event: ReactMouseEvent<HTMLElement>) => {
    const target = event.target;
    if (
      target instanceof HTMLElement &&
      target.closest("input, textarea, select, button, a")
    ) {
      return;
    }
    setNoteOpen((open) => !open);
  };

  return (
    <article
      className={`item-line ${item.completed ? "completed" : ""} ${item.indent > 0 ? "sub-point" : ""} ${selected ? "selected-item" : ""}`}
      data-item-id={item.id}
      style={{ "--indent": item.indent } as React.CSSProperties}
      draggable
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onDoubleClick={openNoteOnDoubleClick}
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
        </div>
        {(item.links ?? []).length > 0 && (
          <div className="item-links">
            {(item.links ?? []).map((link) => (
              <span className="link-chip" key={link}>
                <a href={link} target="_blank" rel="noreferrer" aria-label={`Open ${linkLabel(link)}`}>
                  {linkLabel(link)} <span>↗</span>
                </a>
                <button aria-label={`Remove ${linkLabel(link)} link`} onClick={() => removeLink(link)}>×</button>
              </span>
            ))}
          </div>
        )}
        <div className="item-meta">
          <button
            className={`priority priority-${item.priority}`}
            title={`Priority: ${item.priority}. Click for ${nextPriority}.`}
            onClick={() => updateItem(item.id, { priority: nextPriority })}
          >
            {item.priority === "none" ? "No priority" : item.priority}
          </button>
          <label className={`date-field ${item.dueDate ? "has-date" : ""} ${state?.tone ?? ""}`}>
            <span>{state?.label ?? "Set date"}</span>
            <input
              aria-label={`Due date for ${item.content}`}
              type="date"
              value={item.dueDate ?? ""}
              onChange={(event) => updateItem(item.id, { dueDate: event.target.value || null })}
            />
          </label>
          {item.archivedAt && (
            <span className="archived-date">
              Archived {new Date(item.archivedAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
            </span>
          )}
          {item.section !== "now" && <span className="group-tag">{item.groupName}</span>}
          {item.note?.trim() && !noteOpen && (
            <button className="note-indicator" title="This item has a note" aria-label={`Open note for ${item.content}`} onClick={() => setNoteOpen(true)}>
              ✎
            </button>
          )}
        </div>
        {noteOpen && (
          <div className="item-note">
            <span aria-hidden="true">Note</span>
            <textarea
              autoFocus={!item.note}
              aria-label={`Note for ${item.content}`}
              placeholder="Add context, a reminder, or a thought…"
              value={noteDraft}
              onChange={(event) => setNoteDraft(event.target.value)}
              onBlur={commitNote}
            />
            <button
              aria-label="Close note"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                commitNote();
                setNoteOpen(false);
              }}
            >
              ×
            </button>
          </div>
        )}
      </div>
      <div className="line-tools">
        <button className={item.bold ? "selected" : ""} aria-label="Toggle bold" onClick={() => updateItem(item.id, { bold: !item.bold })}>B</button>
        <button aria-label="Add another link" title="Add link" onClick={addLink}>↗+</button>
        <button className={noteOpen ? "selected" : ""} aria-label="Add note" title="Add note" onClick={() => setNoteOpen((open) => !open)}>N</button>
        <button aria-label="Add sub-point" title="Add sub-point" onClick={addSubItem}>↳</button>
        <button aria-label="Decrease indent" disabled={item.indent === 0} onClick={() => updateItem(item.id, { indent: item.indent - 1 })}>←</button>
        <button aria-label="Increase indent" disabled={item.indent === 3} onClick={() => updateItem(item.id, { indent: item.indent + 1 })}>→</button>
        <select
          aria-label={`Move ${item.content}`}
          value={item.section}
          onChange={(event) => updateItem(item.id, { section: event.target.value as Section, groupName: event.target.value === "now" ? "" : item.groupName || "Unsorted" })}
        >
          <option value="now">Now</option>
          <option value="projects">Projects</option>
          <option value="library">Library</option>
        </select>
        <button
          aria-label={item.archived ? "Restore from archive" : "Archive"}
          onClick={() =>
            updateItem(item.id, {
              archived: !item.archived,
              archivedAt: item.archived ? null : new Date().toISOString(),
            })
          }
        >
          {item.archived ? "↺" : "□"}
        </button>
        {item.archived && (
          <button className="delete-tool" aria-label="Delete permanently" onClick={() => deleteItem(item)}>×</button>
        )}
      </div>
    </article>
  );
}

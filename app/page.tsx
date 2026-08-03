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
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";

type Section = "now" | "projects" | "library";
type View = Section | "archive" | "agenda";
type Priority = "none" | "high" | "medium" | "low";
type SaveStatus = "saved" | "saving" | "retry";
type SortMode = "manual" | "priority" | "recent";
type AgendaMode = "calendar" | "priority";
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
  { id: "agenda", label: "Agenda", mark: "04" },
  { id: "archive", label: "Archive", mark: "05" },
];

const priorityOrder: Priority[] = ["none", "high", "medium", "low"];
const sortModeOrder: SortMode[] = ["manual", "priority", "recent"];
const sortModeLabels: Record<SortMode, string> = {
  manual: "Manual",
  priority: "Priority",
  recent: "Recent",
};
const CACHE_KEY = "ink-and-iron-workspace-v1";
const QUEUE_KEY = "ink-and-iron-pending-v1";
const SORT_KEY = "ink-and-iron-sort-mode";
const GROUP_ORDER_KEY = "ink-and-iron-group-order";
const LIBRARY_FLAT_KEY = "ink-and-iron-library-flat";
const AGENDA_ZOOM_KEY = "ink-and-iron-agenda-zoom";
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

function dateKey(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseDateKey(value: string) {
  return new Date(`${value}T00:00:00`);
}

function fullDateLabel(value: string) {
  return parseDateKey(value).toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

function sectionLabel(item: Item) {
  if (item.section === "now") return "Now";
  return item.groupName || (item.section === "projects" ? "Projects" : "Library");
}

function priorityWeight(priority: Priority) {
  return { high: 0, medium: 1, low: 2, none: 3 }[priority];
}

function sortItems(a: Item, b: Item) {
  return a.position - b.position || a.createdAt.localeCompare(b.createdAt);
}

function compareVisibleItems(a: Item, b: Item, mode: SortMode) {
  if (mode === "recent") {
    return b.updatedAt.localeCompare(a.updatedAt) || sortItems(a, b);
  }
  if (mode === "priority") {
    const weight: Record<Priority, number> = {
      high: 0,
      medium: 1,
      low: 2,
      none: 3,
    };
    return weight[a.priority] - weight[b.priority] || sortItems(a, b);
  }
  return sortItems(a, b);
}

function sortVisibleItems(items: Item[], mode: SortMode) {
  const included = new Map(items.map((item) => [item.id, item]));
  const children = new Map<string, Item[]>();
  const roots: Item[] = [];

  for (const item of items) {
    const parent = item.parentId ? included.get(item.parentId) : null;
    const hasVisibleParent =
      parent &&
      parent.section === item.section &&
      parent.groupName === item.groupName &&
      parent.archived === item.archived;

    if (hasVisibleParent) {
      children.set(parent.id, [...(children.get(parent.id) ?? []), item]);
    } else {
      roots.push(item);
    }
  }

  const result: Item[] = [];
  const visited = new Set<string>();
  const appendBranch = (item: Item) => {
    if (visited.has(item.id)) return;
    visited.add(item.id);
    result.push(item);
    const nested = [...(children.get(item.id) ?? [])].sort((a, b) =>
      compareVisibleItems(a, b, mode),
    );
    nested.forEach(appendBranch);
  };

  roots.sort((a, b) => compareVisibleItems(a, b, mode)).forEach(appendBranch);
  items
    .filter((item) => !visited.has(item.id))
    .sort((a, b) => compareVisibleItems(a, b, mode))
    .forEach(appendBranch);
  return result;
}

export default function Home() {
  const [session, setSession] = useState<Session | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [username, setUsername] = useState("");
  const [accountOpen, setAccountOpen] = useState(false);
  const [items, setItems] = useState<Item[]>([]);
  const [activeView, setActiveView] = useState<View>("now");
  const [query, setQuery] = useState("");
  const [capture, setCapture] = useState("");
  const [, setSaveStatus] = useState<SaveStatus>("saving");
  const [loading, setLoading] = useState(true);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [newProject, setNewProject] = useState("");
  const [showNewProject, setShowNewProject] = useState(false);
  const [newCollection, setNewCollection] = useState("");
  const [showNewCollection, setShowNewCollection] = useState(false);
  const [sortMode, setSortMode] = useState<SortMode>("manual");
  const [preferencesReady, setPreferencesReady] = useState(false);
  const [libraryFlat, setLibraryFlat] = useState(false);
  const [groupOrder, setGroupOrder] = useState<Record<"projects" | "library", string[]>>({
    projects: [],
    library: [],
  });
  const [draggingGroup, setDraggingGroup] = useState<{
    section: "projects" | "library";
    name: string;
  } | null>(null);
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
  const groupToggleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  const userCacheKey = session ? `${CACHE_KEY}:${session.user.id}` : null;
  const userQueueKey = session ? `${QUEUE_KEY}:${session.user.id}` : null;

  const cacheItems = useCallback((next: Item[]) => {
    if (userCacheKey) localStorage.setItem(userCacheKey, JSON.stringify(next));
  }, [userCacheKey]);

  const authenticatedFetch = useCallback(
    async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const {
        data: { session: currentSession },
      } = await supabase.auth.getSession();
      if (!currentSession) throw new Error("Sign in to continue.");
      const headers = new Headers(init.headers);
      headers.set("Authorization", `Bearer ${currentSession.access_token}`);
      return fetch(input, { ...init, headers });
    },
    [],
  );

  const markSaved = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => setSaveStatus("saved"), 350);
  }, []);

  useEffect(() => {
    let active = true;
    void supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      setSession(data.session);
      setAuthReady(true);
    });
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      setAuthReady(true);
      if (!nextSession) {
        setItems([]);
        setUsername("");
        setAccountOpen(false);
      }
    });
    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!session) return;
    let active = true;
    void supabase
      .from("profiles")
      .select("username")
      .eq("id", session.user.id)
      .single()
      .then(({ data }) => {
        if (active) {
          setUsername(data?.username ?? session.user.email?.split("@")[0] ?? "Account");
        }
      });
    return () => {
      active = false;
    };
  }, [session]);

  const sendPatch = useCallback(
    async (id: string, patch: Patch) => {
      if (!userQueueKey) return;
      setSaveStatus("saving");
      const body = { id, ...patch };
      try {
        const response = await authenticatedFetch("/api/items", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!response.ok) throw new Error("Save failed");
        const pending = JSON.parse(localStorage.getItem(userQueueKey) ?? "{}") as Record<string, Patch>;
        delete pending[id];
        localStorage.setItem(userQueueKey, JSON.stringify(pending));
        markSaved();
      } catch {
        const pending = JSON.parse(localStorage.getItem(userQueueKey) ?? "{}") as Record<string, Patch>;
        pending[id] = { ...(pending[id] ?? {}), ...patch };
        localStorage.setItem(userQueueKey, JSON.stringify(pending));
        setSaveStatus("retry");
      }
    },
    [authenticatedFetch, markSaved, userQueueKey],
  );

  const flushPending = useCallback(async () => {
    if (!userQueueKey) return;
    const pending = JSON.parse(localStorage.getItem(userQueueKey) ?? "{}") as Record<string, Patch>;
    const entries = Object.entries(pending);
    if (!entries.length) return;
    for (const [id, patch] of entries) await sendPatch(id, patch);
  }, [sendPatch, userQueueKey]);

  useEffect(() => {
    if (!authReady || !session || !userCacheKey) {
      return;
    }
    const cacheKey = userCacheKey;
    let cancelled = false;
    async function load() {
      try {
        const response = await authenticatedFetch("/api/items", { cache: "no-store" });
        if (!response.ok) throw new Error("Load failed");
        const data = (await response.json()) as { items: Item[] };
        if (!cancelled) {
          setItems(data.items);
          cacheItems(data.items);
          setSaveStatus("saved");
          void flushPending();
        }
      } catch {
        const cached = localStorage.getItem(cacheKey);
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
  }, [
    authReady,
    authenticatedFetch,
    cacheItems,
    flushPending,
    session,
    userCacheKey,
  ]);

  useEffect(() => {
    if (!session) return;
    const channel = supabase
      .channel(`workspace:${session.user.id}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "workspace_items",
          filter: `user_id=eq.${session.user.id}`,
        },
        () => {
          void authenticatedFetch("/api/items", { cache: "no-store" })
            .then((response) => (response.ok ? response.json() : null))
            .then((data: { items: Item[] } | null) => {
              if (!data) return;
              setItems(data.items);
              cacheItems(data.items);
              setSaveStatus("saved");
            });
        },
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [authenticatedFetch, cacheItems, session]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const storedWidth = Number(
        localStorage.getItem("ink-and-iron-sidebar-width"),
      );
      const storedCollapsed = localStorage.getItem(
        "ink-and-iron-sidebar-collapsed",
      );
      if (storedWidth >= 190 && storedWidth <= 340) setSidebarWidth(storedWidth);
      setSidebarCollapsed(storedCollapsed === "true");
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      if (!session) {
        setPreferencesReady(false);
        return;
      }
      const suffix = session.user.id;
      const storedSortMode = (
        localStorage.getItem(`${SORT_KEY}:${suffix}`) ??
        localStorage.getItem(SORT_KEY)
      ) as SortMode | null;
      if (storedSortMode && sortModeOrder.includes(storedSortMode)) {
        setSortMode(storedSortMode);
      }
      setLibraryFlat(
        localStorage.getItem(`${LIBRARY_FLAT_KEY}:${suffix}`) === "true",
      );
      try {
        const storedOrder = JSON.parse(
          localStorage.getItem(`${GROUP_ORDER_KEY}:${suffix}`) ?? "{}",
        ) as Partial<Record<"projects" | "library", string[]>>;
        setGroupOrder({
          projects: Array.isArray(storedOrder.projects)
            ? storedOrder.projects
            : [],
          library: Array.isArray(storedOrder.library)
            ? storedOrder.library
            : [],
        });
      } catch {
        setGroupOrder({ projects: [], library: [] });
      }
      setPreferencesReady(true);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [session]);

  useEffect(() => {
    if (!session || !preferencesReady) return;
    const suffix = session.user.id;
    localStorage.setItem(`${SORT_KEY}:${suffix}`, sortMode);
    localStorage.setItem(`${LIBRARY_FLAT_KEY}:${suffix}`, String(libraryFlat));
    localStorage.setItem(
      `${GROUP_ORDER_KEY}:${suffix}`,
      JSON.stringify(groupOrder),
    );
  }, [groupOrder, libraryFlat, preferencesReady, session, sortMode]);

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

  useEffect(
    () => () => {
      if (groupToggleTimerRef.current) {
        window.clearTimeout(groupToggleTimerRef.current);
      }
    },
    [],
  );

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
        const response = await authenticatedFetch("/api/items", {
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
    [authenticatedFetch, cacheItems, items, markSaved],
  );

  const createSubItem = useCallback(
    (parent: Item) => {
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

  const cycleSortMode = () => {
    const next =
      sortModeOrder[(sortModeOrder.indexOf(sortMode) + 1) % sortModeOrder.length];
    setSortMode(next);
  };

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
        const response = await authenticatedFetch("/api/items", {
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
    [authenticatedFetch, cacheItems, markSaved],
  );

  const activeItems = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle) {
      const results = items
        .filter((item) =>
          `${item.content} ${item.groupName} ${item.note} ${item.url ?? ""} ${(item.links ?? []).join(" ")} ${item.dueDate ?? ""} ${item.dueDate ? fullDateLabel(item.dueDate) : ""} ${item.priority}`
            .toLowerCase()
            .includes(needle),
        );
      return sortVisibleItems(results, sortMode);
    }
    if (activeView === "archive") return sortVisibleItems(items.filter((item) => item.archived), sortMode);
    if (activeView === "agenda") return [];
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
      agenda: items.filter((item) => item.dueDate && !item.archived && !item.completed).length,
    }),
    [items],
  );

  const groups = useMemo(() => {
    const grouped = new Map<string, Item[]>();
    for (const item of activeItems) {
      const key = item.groupName || (item.section === "now" ? "Now" : "Unsorted");
      grouped.set(key, [...(grouped.get(key) ?? []), item]);
    }
    const entries = [...grouped.entries()];
    if (activeView !== "projects" && activeView !== "library") return entries;
    const preferred = groupOrder[activeView];
    const rank = new Map(preferred.map((name, index) => [name, index]));
    return entries.sort(([left], [right]) => {
      const leftRank = rank.get(left) ?? Number.MAX_SAFE_INTEGER;
      const rightRank = rank.get(right) ?? Number.MAX_SAFE_INTEGER;
      return leftRank - rightRank;
    });
  }, [activeItems, activeView, groupOrder]);

  const groupNamesBySection = useMemo(() => {
    const result: Record<"projects" | "library", string[]> = {
      projects: [],
      library: [],
    };
    for (const section of ["projects", "library"] as const) {
      const names = [
        ...new Set(
          items
            .filter((item) => item.section === section && !item.archived)
            .map((item) => item.groupName || "Unsorted"),
        ),
      ];
      const preferred = groupOrder[section].filter((name) =>
        names.includes(name),
      );
      result[section] = [
        ...preferred,
        ...names.filter((name) => !preferred.includes(name)),
      ];
    }
    return result;
  }, [groupOrder, items]);

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

  const moveItemToGroup = useCallback(
    (item: Item, groupName: string) => {
      if (
        item.section === "now" ||
        !groupName ||
        groupName === item.groupName
      ) {
        return;
      }
      const descendants = new Set<string>([item.id]);
      let found = true;
      while (found) {
        found = false;
        for (const candidate of items) {
          if (
            candidate.parentId &&
            descendants.has(candidate.parentId) &&
            !descendants.has(candidate.id)
          ) {
            descendants.add(candidate.id);
            found = true;
          }
        }
      }
      for (const candidate of items) {
        if (descendants.has(candidate.id)) {
          updateItem(candidate.id, { groupName });
        }
      }
    },
    [items, updateItem],
  );

  const renameGroup = (section: "projects" | "library", name: string) => {
    const nextName = window.prompt(
      section === "projects" ? "Rename project" : "Rename collection",
      name,
    )?.trim();
    if (!nextName || nextName === name) return;
    const duplicate = items.some(
      (item) =>
        item.section === section &&
        !item.archived &&
        item.groupName === nextName,
    );
    if (duplicate) {
      window.alert(`“${nextName}” already exists.`);
      return;
    }
    for (const item of items) {
      if (item.section === section && item.groupName === name) {
        updateItem(item.id, { groupName: nextName });
      }
    }
    setCollapsed((current) => {
      if (!current.has(name)) return current;
      const next = new Set(current);
      next.delete(name);
      next.add(nextName);
      return next;
    });
    setGroupOrder((current) => ({
      ...current,
      [section]: groupNamesBySection[section].map((entry) =>
        entry === name ? nextName : entry,
      ),
    }));
  };

  const deleteGroup = (section: "projects" | "library", name: string) => {
    if (name === "Unsorted") return;
    const label = section === "projects" ? "project" : "collection";
    if (
      !window.confirm(
        `Delete the ${label} “${name}”? Its lines will move to Unsorted.`,
      )
    ) {
      return;
    }
    for (const item of items) {
      if (item.section === section && item.groupName === name) {
        updateItem(item.id, { groupName: "Unsorted" });
      }
    }
    setCollapsed((current) => {
      const next = new Set(current);
      next.delete(name);
      return next;
    });
    setGroupOrder((current) => ({
      ...current,
      [section]: [
        ...groupNamesBySection[section].filter(
          (entry) => entry !== name && entry !== "Unsorted",
        ),
        "Unsorted",
      ],
    }));
  };

  const reorderGroup = (
    section: "projects" | "library",
    targetName: string,
  ) => {
    if (
      !draggingGroup ||
      draggingGroup.section !== section ||
      draggingGroup.name === targetName
    ) {
      return;
    }
    setGroupOrder((current) => {
      const order = [...groupNamesBySection[section]];
      const from = order.indexOf(draggingGroup.name);
      const to = order.indexOf(targetName);
      if (from < 0 || to < 0) return current;
      const [moved] = order.splice(from, 1);
      order.splice(to, 0, moved);
      return { ...current, [section]: order };
    });
    setDraggingGroup(null);
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
          : activeView === "agenda"
            ? "Agenda"
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
    if (view === "archive" || view === "agenda") return;
    void createItem("New item", view, "");
  };

  const openOriginalItem = useCallback((item: Item) => {
    setQuery("");
    setActiveView(item.section);
    if (item.section === "library") setLibraryFlat(false);
    if (item.groupName) {
      setCollapsed((current) => {
        if (!current.has(item.groupName)) return current;
        const next = new Set(current);
        next.delete(item.groupName);
        return next;
      });
    }
    window.setTimeout(() => {
      document
        .querySelector<HTMLElement>(`[data-item-id="${item.id}"]`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 80);
  }, []);

  const resizeSidebar = (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = sidebarCollapsed ? 190 : sidebarWidth;
    const startedCollapsed = sidebarCollapsed;
    let moved = false;
    const move = (moveEvent: PointerEvent) => {
      if (Math.abs(moveEvent.clientX - startX) > 4) moved = true;
      if (!moved) return;
      if (startedCollapsed) setSidebarCollapsed(false);
      const width = Math.max(190, Math.min(340, startWidth + moveEvent.clientX - startX));
      setSidebarWidth(width);
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      if (!moved) {
        const nextCollapsed = !startedCollapsed;
        setSidebarCollapsed(nextCollapsed);
        localStorage.setItem(
          "ink-and-iron-sidebar-collapsed",
          String(nextCollapsed),
        );
        return;
      }
      localStorage.setItem("ink-and-iron-sidebar-collapsed", "false");
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
          authenticatedFetch("/api/items", {
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

  if (!authReady) {
    return (
      <main className="auth-shell auth-loading" aria-label="Loading account">
        <span className="auth-forge-mark" aria-hidden="true" />
      </main>
    );
  }

  if (!session) {
    return <AuthScreen />;
  }

  return (
    <main
      className={`workspace ${sidebarCollapsed ? "sidebar-collapsed" : ""} ${selecting ? "is-selecting" : ""}`}
      style={{ "--sidebar-width": `${sidebarCollapsed ? 64 : sidebarWidth}px` } as React.CSSProperties}
    >
      <aside className="rail">
        <div className="brand">
          <span className="brand-lockup" role="img" aria-label="Ink & Iron" />
          <span className="brand-mark" aria-hidden="true" />
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
              {view.id !== "archive" && view.id !== "agenda" && (
                <button className="nav-plus" aria-label={`Add to ${view.label}`} onClick={() => quickAddFor(view.id)}>+</button>
              )}
            </div>
          ))}
        </nav>

        <button className="sidebar-toggle" onClick={toggleSidebar} aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}>
          <span aria-hidden="true" />
        </button>
        <button className="sidebar-resize" onPointerDown={resizeSidebar} aria-label="Resize sidebar" />
      </aside>

      <section className="canvas">
        <header className="topbar">
          <div className="topbar-title">
            <span aria-hidden="true">{"//"}</span>
            <strong>{viewTitle}</strong>
          </div>
          <div className="topbar-tools">
            {activeView !== "agenda" && (
              <button
                type="button"
                className={`sort-control sort-${sortMode}`}
                aria-label={`Filter by ${sortModeLabels[sortMode]}. Click to switch to ${
                  sortModeLabels[
                    sortModeOrder[
                      (sortModeOrder.indexOf(sortMode) + 1) % sortModeOrder.length
                    ]
                  ]
                }.`}
                onClick={cycleSortMode}
              >
                <span>Filter by</span>
                <strong>{sortModeLabels[sortMode]}</strong>
                <i aria-hidden="true">↻</i>
              </button>
            )}
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
            <div className="account-control">
              <button
                type="button"
                className="account-trigger"
                aria-haspopup="menu"
                aria-expanded={accountOpen}
                onClick={() => setAccountOpen((open) => !open)}
              >
                <span>{username.slice(0, 1).toUpperCase()}</span>
                <strong>{username || "Account"}</strong>
                <i aria-hidden="true">⌄</i>
              </button>
              {accountOpen && (
                <div className="account-menu" role="menu">
                  <small>{session.user.email}</small>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => void supabase.auth.signOut()}
                  >
                    Log out
                  </button>
                </div>
              )}
            </div>
          </div>
        </header>

        <div className="document" onPointerDown={startMarquee}>
          {activeView !== "agenda" && (
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
          )}

          {loading ? (
            <div className="loading-lines" aria-label="Loading workspace">
              <span /><span /><span /><span />
            </div>
          ) : !query && activeView === "agenda" ? (
            <AgendaView
              items={items}
              updateItem={updateItem}
              openOriginal={openOriginalItem}
              onCapture={(value) => void createItem(value, "now")}
              zoomPreferenceKey={`${AGENDA_ZOOM_KEY}:${session.user.id}`}
            />
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
          ) : query ||
            activeView === "now" ||
            activeView === "archive" ||
            (activeView === "library" && libraryFlat) ? (
            <div className="line-list">
              <div className="list-rule">
                <span>
                  {query
                    ? "Results"
                    : activeView === "archive"
                      ? "Archived lines"
                      : activeView === "library"
                        ? "All library lines"
                        : "Current queue"}
                </span>
                <span className="list-rule-actions">
                  {activeView === "library" && !query && (
                    <button
                      type="button"
                      className="view-mode-control active"
                      onClick={() => setLibraryFlat(false)}
                    >
                      Show collections
                    </button>
                  )}
                  <span>{activeItems.length} lines</span>
                </span>
              </div>
              {activeItems.map((item) => (
                <ItemLine
                  key={`${item.id}:${item.content}:${item.note}`}
                  item={item}
                  selected={selectedIds.has(item.id)}
                  updateItem={updateItem}
                  deleteItem={deleteItem}
                  addSubItem={() => createSubItem(item)}
                  groupNames={
                    item.section === "projects" || item.section === "library"
                      ? groupNamesBySection[item.section]
                      : []
                  }
                  moveToGroup={(groupName) => moveItemToGroup(item, groupName)}
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
                <span className="list-rule-actions">
                  {activeView === "library" && (
                    <button
                      type="button"
                      className="view-mode-control"
                      onClick={() => setLibraryFlat(true)}
                    >
                      Show all lines
                    </button>
                  )}
                  <span>{groups.length} groups</span>
                </span>
              </div>
              {groups.map(([name, groupItems], index) => (
                <section
                  className={`group ${draggingGroup?.name === name ? "dragging-group" : ""}`}
                  key={name}
                  onDragOver={(event) => {
                    if (draggingGroup) event.preventDefault();
                  }}
                  onDrop={(event) => {
                    if (!draggingGroup) return;
                    event.preventDefault();
                    reorderGroup(activeView as "projects" | "library", name);
                  }}
                >
                  <div className="group-head">
                    <button
                      type="button"
                      className="group-drag"
                      draggable
                      aria-label={`Reorder ${name}`}
                      title="Drag to reorder"
                      onDragStart={(event) => {
                        event.stopPropagation();
                        setDraggingGroup({
                          section: activeView as "projects" | "library",
                          name,
                        });
                      }}
                      onDragEnd={() => setDraggingGroup(null)}
                    >
                      ⠿
                    </button>
                    <button
                      type="button"
                      className="group-head-main"
                      aria-label={`${collapsed.has(name) ? "Expand" : "Collapse"} ${name}. Double-click its name or press F2 to rename.`}
                      onClick={() => {
                        if (groupToggleTimerRef.current) {
                          window.clearTimeout(groupToggleTimerRef.current);
                        }
                        groupToggleTimerRef.current = window.setTimeout(() => {
                          toggleGroup(name);
                          groupToggleTimerRef.current = null;
                        }, 190);
                      }}
                      onDoubleClick={(event) => {
                        if (
                          !(event.target instanceof HTMLElement) ||
                          !event.target.closest(".group-name")
                        ) {
                          return;
                        }
                        event.preventDefault();
                        if (groupToggleTimerRef.current) {
                          window.clearTimeout(groupToggleTimerRef.current);
                          groupToggleTimerRef.current = null;
                        }
                        renameGroup(
                          activeView as "projects" | "library",
                          name,
                        );
                      }}
                      onKeyDown={(event) => {
                        if (event.key !== "F2") return;
                        event.preventDefault();
                        renameGroup(
                          activeView as "projects" | "library",
                          name,
                        );
                      }}
                    >
                      <span className="group-number">{String(index + 1).padStart(2, "0")}</span>
                      <span
                        className="group-name"
                        title="Double-click to rename"
                      >
                        {name}
                      </span>
                      <span className="group-count">{groupItems.length} lines</span>
                      <span
                        className={`chevron ${collapsed.has(name) ? "closed" : ""}`}
                        aria-hidden="true"
                      />
                    </button>
                    <div className="group-tools">
                      {name !== "Unsorted" && (
                        <button
                          type="button"
                          className="danger"
                          aria-label={`Delete ${name}`}
                          title="Delete group"
                          onClick={() =>
                            deleteGroup(
                              activeView as "projects" | "library",
                              name,
                            )
                          }
                        >
                          ×
                        </button>
                      )}
                    </div>
                  </div>
                  {!collapsed.has(name) && (
                    <div className="group-body">
                      {groupItems.map((item) => (
                        <ItemLine
                          key={`${item.id}:${item.content}:${item.note}`}
                          item={item}
                          selected={selectedIds.has(item.id)}
                          updateItem={updateItem}
                          deleteItem={deleteItem}
                          addSubItem={() => createSubItem(item)}
                          groupNames={
                            activeView === "projects" ||
                            activeView === "library"
                              ? groupNamesBySection[activeView]
                              : []
                          }
                          moveToGroup={(groupName) =>
                            moveItemToGroup(item, groupName)
                          }
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

type AuthMode = "login" | "create";

function passwordStrength(password: string) {
  const score = [
    password.length >= 8,
    /[a-z]/.test(password),
    /[A-Z]/.test(password),
    /\d/.test(password),
    /[^A-Za-z0-9]/.test(password),
  ].filter(Boolean).length;
  const label =
    score <= 1 ? "Very weak" : score === 2 ? "Weak" : score === 3 ? "Fair" : score === 4 ? "Strong" : "Very strong";
  return { score, label };
}

function AuthScreen() {
  const [mode, setMode] = useState<AuthMode>("login");
  const [createStep, setCreateStep] = useState<1 | 2>(1);
  const [identifier, setIdentifier] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [username, setUsername] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const strength = passwordStrength(password);

  const switchMode = (next: AuthMode) => {
    setMode(next);
    setCreateStep(1);
    setPassword("");
    setMessage("");
    setError("");
  };

  const handleLogin = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    setMessage("");
    try {
      if (identifier.includes("@")) {
        const { error: signInError } = await supabase.auth.signInWithPassword({
          email: identifier.trim(),
          password,
        });
        if (signInError) throw signInError;
      } else {
        const { data, error: functionError } = await supabase.functions.invoke(
          "username-login",
          { body: { username: identifier.trim(), password } },
        );
        const result = data as {
          accessToken?: string;
          refreshToken?: string;
          error?: string;
        } | null;
        if (functionError || !result?.accessToken || !result.refreshToken) {
          throw new Error(result?.error ?? functionError?.message ?? "Could not sign in.");
        }
        const { error: sessionError } = await supabase.auth.setSession({
          access_token: result.accessToken,
          refresh_token: result.refreshToken,
        });
        if (sessionError) throw sessionError;
      }
    } catch (loginError) {
      setError(loginError instanceof Error ? loginError.message : "Could not sign in.");
    } finally {
      setBusy(false);
    }
  };

  const continueCreate = (event: FormEvent) => {
    event.preventDefault();
    setError("");
    if (!email.trim() || password.length < 8) {
      setError("Use a valid email and a password with at least 8 characters.");
      return;
    }
    setCreateStep(2);
  };

  const handleCreate = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    setMessage("");
    if (!/^[A-Za-z0-9_]{3,24}$/.test(username)) {
      setError("Username must be 3–24 letters, numbers, or underscores.");
      return;
    }
    setBusy(true);
    try {
      const { data, error: signUpError } = await supabase.auth.signUp({
        email: email.trim(),
        password,
        options: {
          data: { username },
          emailRedirectTo: window.location.origin,
        },
      });
      if (signUpError) throw signUpError;
      if (!data.session) {
        setMessage("Check your email to confirm the account, then return here.");
      }
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "Could not create the account.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="auth-shell">
      <header className="auth-topbar">
        <span className="auth-brand-lockup" role="img" aria-label="Ink & Iron" />
        <button
          type="button"
          onClick={() => switchMode(mode === "login" ? "create" : "login")}
        >
          {mode === "login" ? "Create account" : "Log in"}
        </button>
      </header>

      <section className="auth-stage">
        <div className="auth-identity" aria-hidden="true">
          <span className="auth-identity-mark" />
          <div className="auth-identity-meta">
            <span>{mode === "login" ? "01" : createStep === 1 ? "02" : "03"}</span>
            <i />
            <small>Private workspace</small>
          </div>
        </div>
        <div className="auth-card">
          <div className="auth-card-head">
            <div className="auth-card-kicker">
              <small>{mode === "login" ? "RETURN" : "NEW WORKSPACE"}</small>
              <span aria-hidden="true" />
            </div>
            <h1>
              {mode === "login"
                ? "Open your workspace."
                : createStep === 1
                  ? "Create your account."
                  : "Choose your name."}
            </h1>
          </div>

          {mode === "login" ? (
            <form onSubmit={handleLogin}>
              <label>
                <span>Email or username</span>
                <input
                  autoFocus
                  autoComplete="username"
                  value={identifier}
                  onChange={(event) => setIdentifier(event.target.value)}
                  placeholder="you@example.com or username"
                  required
                />
              </label>
              <label>
                <span>Password</span>
                <input
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  required
                />
              </label>
              {error && <p className="auth-error">{error}</p>}
              <button className="auth-submit" type="submit" disabled={busy}>
                {busy ? "Opening…" : "Enter workspace"}
                <span aria-hidden="true">→</span>
              </button>
            </form>
          ) : createStep === 1 ? (
            <form onSubmit={continueCreate}>
              <label>
                <span>Email</span>
                <input
                  autoFocus
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="you@example.com"
                  required
                />
              </label>
              <label>
                <span>Password</span>
                <input
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  minLength={8}
                  required
                />
              </label>
              <div className={`password-strength strength-${strength.score}`}>
                <div>
                  {[1, 2, 3, 4, 5].map((level) => (
                    <span key={level} className={strength.score >= level ? "filled" : ""} />
                  ))}
                </div>
                <small>{password ? strength.label : "At least 8 characters"}</small>
              </div>
              {error && <p className="auth-error">{error}</p>}
              <button className="auth-submit" type="submit">
                Continue
                <span aria-hidden="true">→</span>
              </button>
            </form>
          ) : (
            <form onSubmit={handleCreate}>
              <button
                type="button"
                className="auth-back"
                onClick={() => setCreateStep(1)}
              >
                ← {email}
              </button>
              <label>
                <span>Username</span>
                <input
                  autoFocus
                  autoComplete="username"
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  placeholder="3–24 letters, numbers, or _"
                  minLength={3}
                  maxLength={24}
                  pattern="[A-Za-z0-9_]+"
                  required
                />
              </label>
              <p className="auth-hint">
                This is what appears in the top-right corner. You can use it instead of
                your email when signing in.
              </p>
              {message && <p className="auth-message">{message}</p>}
              {error && <p className="auth-error">{error}</p>}
              <button className="auth-submit" type="submit" disabled={busy || Boolean(message)}>
                {busy ? "Creating…" : message ? "Email sent" : "Create workspace"}
                <span aria-hidden="true">→</span>
              </button>
            </form>
          )}

          <div className="auth-switch">
            <span>{mode === "login" ? "New here?" : "Already have an account?"}</span>
            <button
              type="button"
              onClick={() => switchMode(mode === "login" ? "create" : "login")}
            >
              {mode === "login" ? "Create account" : "Log in"}
            </button>
          </div>
        </div>
      </section>
    </main>
  );
}

function AgendaView({
  items,
  updateItem,
  openOriginal,
  onCapture,
  zoomPreferenceKey,
}: {
  items: Item[];
  updateItem: (id: string, patch: Patch) => void;
  openOriginal: (item: Item) => void;
  onCapture: (value: string) => void;
  zoomPreferenceKey: string;
}) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayKey = dateKey(today);
  const [mode, setMode] = useState<AgendaMode>("calendar");
  const [monthCursor, setMonthCursor] = useState(
    () => new Date(today.getFullYear(), today.getMonth(), 1),
  );
  const [selectedDate, setSelectedDate] = useState(todayKey);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [agendaCapture, setAgendaCapture] = useState("");
  const [agendaZoom, setAgendaZoom] = useState(1);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const stored = Number(localStorage.getItem(zoomPreferenceKey));
      if (stored >= 0.8 && stored <= 1.3) setAgendaZoom(stored);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [zoomPreferenceKey]);

  const changeAgendaZoom = (amount: number) => {
    setAgendaZoom((current) => {
      const next = Math.max(0.8, Math.min(1.3, Math.round((current + amount) * 10) / 10));
      localStorage.setItem(zoomPreferenceKey, String(next));
      return next;
    });
  };

  const resetAgendaZoom = () => {
    setAgendaZoom(1);
    localStorage.setItem(zoomPreferenceKey, "1");
  };

  const active = useMemo(
    () => items.filter((item) => !item.archived && !item.completed),
    [items],
  );
  const dueItems = useMemo(
    () =>
      active
        .filter((item) => item.dueDate)
        .sort((left, right) =>
          (left.dueDate ?? "").localeCompare(right.dueDate ?? "") ||
          priorityWeight(left.priority) - priorityWeight(right.priority) ||
          sortItems(left, right),
        ),
    [active],
  );
  const priorityItems = useMemo(
    () =>
      active
        .filter((item) => item.priority !== "none")
        .sort((left, right) =>
          priorityWeight(left.priority) - priorityWeight(right.priority) ||
          (left.dueDate ?? "9999-12-31").localeCompare(
            right.dueDate ?? "9999-12-31",
          ) ||
          sortItems(left, right),
        ),
    [active],
  );
  const undatedPriority = useMemo(
    () => priorityItems.filter((item) => !item.dueDate),
    [priorityItems],
  );
  const overdueItems = useMemo(
    () => dueItems.filter((item) => item.dueDate && item.dueDate < todayKey),
    [dueItems, todayKey],
  );
  const eventsByDate = useMemo(() => {
    const grouped = new Map<string, Item[]>();
    for (const item of dueItems) {
      if (!item.dueDate) continue;
      grouped.set(item.dueDate, [...(grouped.get(item.dueDate) ?? []), item]);
    }
    return grouped;
  }, [dueItems]);

  const calendarDays = useMemo(() => {
    const first = new Date(
      monthCursor.getFullYear(),
      monthCursor.getMonth(),
      1,
    );
    const mondayOffset = (first.getDay() + 6) % 7;
    const start = new Date(first);
    start.setDate(first.getDate() - mondayOffset);
    return Array.from({ length: 42 }, (_, index) => {
      const day = new Date(start);
      day.setDate(start.getDate() + index);
      return day;
    });
  }, [monthCursor]);

  const selectedDayItems = eventsByDate.get(selectedDate) ?? [];
  const selectedItem = selectedItemId
    ? items.find((item) => item.id === selectedItemId) ?? null
    : null;
  const overdueCount = dueItems.filter(
    (item) => item.dueDate && item.dueDate < todayKey,
  ).length;
  const todayCount = eventsByDate.get(todayKey)?.length ?? 0;
  const nextWeek = new Date(today);
  nextWeek.setDate(today.getDate() + 7);
  const nextWeekKey = dateKey(nextWeek);
  const nextWeekCount = dueItems.filter(
    (item) =>
      item.dueDate && item.dueDate > todayKey && item.dueDate <= nextWeekKey,
  ).length;

  const selectDate = (key: string) => {
    setSelectedDate(key);
    setSelectedItemId(eventsByDate.get(key)?.[0]?.id ?? null);
  };

  const moveMonth = (amount: number) => {
    const next = new Date(
      monthCursor.getFullYear(),
      monthCursor.getMonth() + amount,
      1,
    );
    setMonthCursor(next);
    setSelectedDate(dateKey(next));
    setSelectedItemId(eventsByDate.get(dateKey(next))?.[0]?.id ?? null);
  };

  const goToday = () => {
    setMonthCursor(new Date(today.getFullYear(), today.getMonth(), 1));
    selectDate(todayKey);
  };

  return (
    <section
      className="agenda-shell"
      aria-label="Agenda"
      style={{ zoom: agendaZoom } as React.CSSProperties}
    >
      <div className="agenda-heading">
        <div className="agenda-tabs" role="tablist" aria-label="Agenda views">
          <button
            type="button"
            role="tab"
            aria-selected={mode === "calendar"}
            className={mode === "calendar" ? "active" : ""}
            onClick={() => setMode("calendar")}
          >
            Calendar
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "priority"}
            className={mode === "priority" ? "active" : ""}
            onClick={() => setMode("priority")}
          >
            PriorityView
          </button>
        </div>
        <form
          className="agenda-capture"
          onSubmit={(event) => {
            event.preventDefault();
            if (!agendaCapture.trim()) return;
            onCapture(agendaCapture.trim());
            setAgendaCapture("");
          }}
        >
          <span aria-hidden="true">+</span>
          <input
            aria-label="Add a bullet point to Now"
            value={agendaCapture}
            onChange={(event) => setAgendaCapture(event.target.value)}
            placeholder="What needs your attention?"
          />
          <button type="submit" aria-label="Add bullet point">↵</button>
        </form>
        <div className="agenda-zoom" aria-label="Agenda zoom controls">
          <button
            type="button"
            aria-label="Zoom Agenda out"
            disabled={agendaZoom <= 0.8}
            onClick={() => changeAgendaZoom(-0.1)}
          >
            −
          </button>
          <button
            type="button"
            className="agenda-zoom-value"
            aria-label="Reset Agenda zoom"
            title="Reset to 100%"
            onClick={resetAgendaZoom}
          >
            {Math.round(agendaZoom * 100)}%
          </button>
          <button
            type="button"
            aria-label="Zoom Agenda in"
            disabled={agendaZoom >= 1.3}
            onClick={() => changeAgendaZoom(0.1)}
          >
            +
          </button>
        </div>
        <div className="agenda-connections" aria-label="Future calendar connections">
          <span>Calendar links</span>
          <i>Google · Apple · Outlook</i>
          <em>Soon</em>
        </div>
      </div>

      <div className="agenda-ticker" aria-label="Agenda summary">
        <span><strong>{overdueCount}</strong> overdue</span>
        <span><strong>{todayCount}</strong> due today</span>
        <span><strong>{nextWeekCount}</strong> next 7 days</span>
        <span><strong>{priorityItems.length}</strong> prioritized</span>
        <i aria-hidden="true">Ink &amp; Iron signal / {fullDateLabel(todayKey)}</i>
      </div>

      {mode === "calendar" ? (
        <div className="agenda-calendar-layout">
          <div className="agenda-calendar-panel">
            <div className="agenda-month-head">
              <div>
                <span>Deadline map</span>
                <strong>
                  {monthCursor.toLocaleDateString(undefined, {
                    month: "long",
                    year: "numeric",
                  })}
                </strong>
              </div>
              <div className="agenda-month-actions">
                <button type="button" onClick={() => moveMonth(-1)} aria-label="Previous month">←</button>
                <button type="button" onClick={goToday}>Today</button>
                <button type="button" onClick={() => moveMonth(1)} aria-label="Next month">→</button>
              </div>
            </div>
            <div className="agenda-weekdays" aria-hidden="true">
              {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((day) => <span key={day}>{day}</span>)}
            </div>
            <div className="agenda-grid" role="grid" aria-label="Deadline calendar">
              {calendarDays.map((day) => {
                const key = dateKey(day);
                const dayItems = eventsByDate.get(key) ?? [];
                const outside = day.getMonth() !== monthCursor.getMonth();
                return (
                  <div
                    className={`agenda-day ${outside ? "outside" : ""} ${key === todayKey ? "today" : ""} ${key === selectedDate ? "selected" : ""}`}
                    role="button"
                    tabIndex={0}
                    aria-label={`${fullDateLabel(key)}, ${dayItems.length} deadlines`}
                    key={key}
                    onClick={() => selectDate(key)}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter" && event.key !== " ") return;
                      event.preventDefault();
                      selectDate(key);
                    }}
                  >
                    <span className="agenda-day-number" aria-hidden="true">
                      {day.getDate()}
                    </span>
                    <div className="agenda-day-events">
                      {dayItems.slice(0, 3).map((item) => (
                        <button
                          type="button"
                          className={`agenda-event priority-${item.priority}`}
                          key={item.id}
                          title={item.content}
                          onClick={(event) => {
                            event.stopPropagation();
                            setSelectedDate(key);
                            setSelectedItemId(item.id);
                          }}
                        >
                          {item.content}
                        </button>
                      ))}
                      {dayItems.length > 3 && <span className="agenda-event-more">+{dayItems.length - 3}</span>}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <aside className="agenda-day-panel">
            <div className="agenda-day-title">
              <span>Selected day</span>
              <strong>{fullDateLabel(selectedDate)}</strong>
              <em>{selectedDayItems.length} {selectedDayItems.length === 1 ? "deadline" : "deadlines"}</em>
            </div>
            <div className="agenda-day-list">
              {selectedDayItems.length ? selectedDayItems.map((item) => (
                <button
                  type="button"
                  className={selectedItemId === item.id ? "active" : ""}
                  key={item.id}
                  onClick={() => setSelectedItemId(item.id)}
                >
                  <i className={`priority-dot priority-${item.priority}`} />
                  <span>{item.content}<small>{sectionLabel(item)}</small></span>
                  <em>›</em>
                </button>
              )) : (
                <p>Nothing scheduled for this day.</p>
              )}
            </div>
            {selectedItem ? (
              <AgendaInspector key={selectedItem.id} item={selectedItem} updateItem={updateItem} openOriginal={openOriginal} />
            ) : undatedPriority.length > 0 ? (
              <div className="agenda-undated">
                <span>Needs a date</span>
                {undatedPriority.slice(0, 4).map((item) => (
                  <button type="button" key={item.id} onClick={() => setSelectedItemId(item.id)}>
                    {item.content}<em>{item.priority}</em>
                  </button>
                ))}
              </div>
            ) : null}
          </aside>
        </div>
      ) : (
        <div className="priority-view-layout">
          <div className="priority-view-list">
            <div className="priority-view-head">
              <span>All active tabs</span>
              <div>
                <button
                  type="button"
                  className="priority-overdue-jump"
                  onClick={() =>
                    document
                      .getElementById("agenda-overdue")
                      ?.scrollIntoView({ behavior: "smooth", block: "start" })
                  }
                >
                  Overdue {overdueItems.length}
                </button>
                <strong>{priorityItems.length} priority lines</strong>
              </div>
            </div>
            {(["high", "medium", "low"] as Priority[]).map((priority) => {
              const matching = priorityItems.filter((item) => item.priority === priority);
              return (
                <section className={`priority-band priority-${priority}`} key={priority}>
                  <div className="priority-band-head">
                    <span>{priority}</span>
                    <em>{matching.length}</em>
                  </div>
                  {matching.length ? matching.map((item) => (
                    <button
                      type="button"
                      className={`priority-view-item ${selectedItemId === item.id ? "active" : ""}`}
                      key={item.id}
                      onClick={() => setSelectedItemId(item.id)}
                    >
                      <span>{item.content}<small>{sectionLabel(item)}</small></span>
                      <em>{item.dueDate ? dueState(item.dueDate)?.label : "No deadline"}</em>
                    </button>
                  )) : <p>No {priority} priority lines.</p>}
                </section>
              );
            })}
            <section className="priority-band priority-overdue" id="agenda-overdue">
              <div className="priority-band-head">
                <span>Overdue</span>
                <em>{overdueItems.length}</em>
              </div>
              {overdueItems.length ? overdueItems.map((item) => (
                <button
                  type="button"
                  className={`priority-view-item ${selectedItemId === item.id ? "active" : ""}`}
                  key={item.id}
                  onClick={() => setSelectedItemId(item.id)}
                >
                  <span>{item.content}<small>{sectionLabel(item)}</small></span>
                  <em>{dueState(item.dueDate)?.label}</em>
                </button>
              )) : <p>Nothing overdue.</p>}
            </section>
          </div>
          <aside className="priority-inspector">
            {selectedItem ? (
              <AgendaInspector key={selectedItem.id} item={selectedItem} updateItem={updateItem} openOriginal={openOriginal} />
            ) : (
              <div className="agenda-inspector-empty">
                <span>PriorityView</span>
                <p>Select a line to inspect its note, deadline, and source.</p>
              </div>
            )}
          </aside>
        </div>
      )}
    </section>
  );
}

function AgendaInspector({
  item,
  updateItem,
  openOriginal,
}: {
  item: Item;
  updateItem: (id: string, patch: Patch) => void;
  openOriginal: (item: Item) => void;
}) {
  const [noteDraft, setNoteDraft] = useState(item.note ?? "");

  const nextPriority =
    priorityOrder[(priorityOrder.indexOf(item.priority) + 1) % priorityOrder.length];
  const commitNote = () => {
    if (noteDraft !== (item.note ?? "")) {
      updateItem(item.id, { note: noteDraft });
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
    updateItem(item.id, {
      links: [...new Set([...(item.links ?? []), link])],
    });
  };
  const removeLink = (link: string) => {
    updateItem(item.id, {
      links: (item.links ?? []).filter((candidate) => candidate !== link),
      url: item.url === link ? null : item.url,
    });
  };
  return (
    <div className="agenda-inspector">
      <div className="agenda-inspector-source">
        <span>{item.section}</span>
        <em>{sectionLabel(item)}</em>
      </div>
      <h3>{item.content}</h3>
      <div className="agenda-inspector-controls">
        <button
          type="button"
          className={`priority priority-${item.priority}`}
          onClick={() => updateItem(item.id, { priority: nextPriority })}
        >
          {item.priority === "none" ? "No priority" : item.priority}
        </button>
        <label>
          <span>Deadline</span>
          <input
            type="date"
            value={item.dueDate ?? ""}
            onChange={(event) => updateItem(item.id, { dueDate: event.target.value || null })}
          />
        </label>
      </div>
      <div className="agenda-inspector-note">
        <label htmlFor={`agenda-note-${item.id}`}>Note</label>
        <textarea
          id={`agenda-note-${item.id}`}
          value={noteDraft}
          onChange={(event) => setNoteDraft(event.target.value)}
          onBlur={commitNote}
          placeholder="Add context, a reminder, or a thought…"
        />
      </div>
      <div className="agenda-inspector-links">
        {(item.links ?? []).map((link) => (
          <span key={link}>
            <a href={link} target="_blank" rel="noreferrer">{linkLabel(link)} ↗</a>
            <button type="button" aria-label={`Remove ${linkLabel(link)} link`} onClick={() => removeLink(link)}>×</button>
          </span>
        ))}
        <button type="button" className="agenda-add-link" onClick={addLink}>+ Add link</button>
      </div>
      <div className="agenda-inspector-actions">
        <button type="button" onClick={() => updateItem(item.id, { completed: true })}>Complete</button>
        <button type="button" className="primary" onClick={() => openOriginal(item)}>Open original <span>→</span></button>
      </div>
    </div>
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
  groupNames,
  moveToGroup,
  onDragStart,
  onDrop,
}: {
  item: Item;
  selected: boolean;
  updateItem: (id: string, patch: Patch) => void;
  deleteItem: (item: Item) => void;
  addSubItem: () => void;
  groupNames: string[];
  moveToGroup: (groupName: string) => void;
  onDragStart: () => void;
  onDrop: () => void;
}) {
  const [draft, setDraft] = useState(item.content);
  const [noteOpen, setNoteOpen] = useState(false);
  const [noteDraft, setNoteDraft] = useState(item.note ?? "");
  const [hovered, setHovered] = useState(false);
  const state = dueState(item.dueDate);

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
        setNoteOpen((open) => {
          if (open && noteDraft !== (item.note ?? "")) {
            updateItem(item.id, { note: noteDraft });
          }
          return !open;
        });
      }
      if (event.key.toLowerCase() === "b") {
        event.preventDefault();
        updateItem(item.id, { bold: !item.bold });
      }
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, [hovered, item.bold, item.id, item.note, noteDraft, updateItem]);

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
    setNoteOpen((open) => {
      if (open && noteDraft !== (item.note ?? "")) {
        updateItem(item.id, { note: noteDraft });
      }
      return !open;
    });
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
        event.stopPropagation();
        onDrop();
      }}
    >
      <button className="drag-handle" aria-label={`Reorder ${item.content}`}>⠿</button>
      <button
        className="check"
        aria-label={item.completed ? `Restore ${item.content}` : `Complete ${item.content}`}
        onClick={() => updateItem(item.id, { completed: !item.completed })}
      >
      </button>
      <div className="item-main">
        <div className="item-copy">
          <input
            aria-label={`Edit ${item.content}`}
            className={item.bold ? "bold" : ""}
            style={{
              width: `${Math.max(12, Math.min(88, draft.length * 2 + 4))}ch`,
            }}
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
        <button className="link-tool" aria-label="Add another link" title="Add link" onClick={addLink}>
          <span aria-hidden="true">📎</span>
        </button>
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
        {(item.section === "projects" || item.section === "library") &&
          groupNames.length > 0 && (
            <select
              className="group-move"
              aria-label={`Move ${item.content} to another ${
                item.section === "projects" ? "project" : "collection"
              }`}
              title={`Move to another ${
                item.section === "projects" ? "project" : "collection"
              }`}
              value={item.groupName || "Unsorted"}
              onChange={(event) => moveToGroup(event.target.value)}
            >
              {groupNames.map((name) => (
                <option value={name} key={name}>
                  {name}
                </option>
              ))}
            </select>
          )}
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

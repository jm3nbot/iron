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
type View = Section | "archive" | "agenda" | "daily";
type Priority = "none" | "high" | "medium" | "low";
type SaveStatus = "saved" | "saving" | "retry";
type SortMode = "manual" | "priority" | "recent";
type AgendaMode = "calendar" | "priority";
type DailyMode = "today" | "tracker";
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
  ownerId: string;
  ownerUsername: string;
  sharedWith: SharedPerson[];
};

type SharedPerson = {
  id: string;
  userId: string;
  username: string;
};

type Patch = Partial<Omit<Item, "id" | "createdAt" | "updatedAt">>;

type DailyItem = {
  id: string;
  content: string;
  note: string;
  links: string[];
  weekdayMask: number;
  weeklyTarget: number | null;
  startDate: string | null;
  endDate: string | null;
  position: number;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
};

type DailyCompletion = {
  dailyId: string;
  completionDate: string;
  completedAt: string;
};

type DailyDraft = Pick<DailyItem, "content" | "note" | "links" | "weekdayMask" | "weeklyTarget" | "startDate" | "endDate">;

type QuickLink = {
  slot: number;
  label: string;
  url: string;
  updatedAt: string;
};

type GoogleCalendarEvent = {
  id: string;
  title: string;
  description: string;
  location: string;
  htmlLink: string;
  start: string;
  end: string;
  allDay: boolean;
};

type SharedPreview = {
  id: string;
  content: string;
  section: Section;
  groupName: string;
  note: string;
  priority: Priority;
  dueDate: string | null;
  completed: boolean;
};

type Collaboration = {
  id: string;
  kind: "item" | "project";
  itemId: string | null;
  projectName: string | null;
  ownerId: string;
  userId: string;
  invitedBy: string;
  role: "editor";
  status: "pending" | "accepted" | "declined";
  invitedAt: string;
  respondedAt: string | null;
  senderUsername: string;
  recipientUsername: string;
  item: SharedPreview | null;
};

type CollaborationState = {
  incoming: Collaboration[];
  outgoing: Collaboration[];
  shared: Collaboration[];
};

const views: { id: View; label: string; mark: string }[] = [
  { id: "now", label: "Now", mark: "01" },
  { id: "projects", label: "Projects", mark: "02" },
  { id: "library", label: "Library", mark: "03" },
  { id: "agenda", label: "Agenda", mark: "04" },
  { id: "daily", label: "Daily", mark: "05" },
  { id: "archive", label: "Archive", mark: "06" },
];

const weekdayLabels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

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

function shortDateLabel(value: string) {
  return parseDateKey(value).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function dailyActiveStart(item: DailyItem) {
  const created = item.createdAt.slice(0, 10);
  if (!item.startDate) return created;
  return item.startDate > created ? item.startDate : created;
}

function isDailyScheduled(item: DailyItem, key: string) {
  if (item.archived || key < dailyActiveStart(item) || (item.endDate && key > item.endDate)) {
    return false;
  }
  const weekday = parseDateKey(key).getDay();
  return (item.weekdayMask & (1 << weekday)) !== 0;
}

function dailyScheduleLabel(item: Pick<DailyItem, "weekdayMask" | "weeklyTarget" | "startDate" | "endDate">) {
  const activeDays = weekdayLabels.filter((_, day) => (item.weekdayMask & (1 << day)) !== 0);
  const days = activeDays.length === 7 ? "Every day" : activeDays.join(" · ");
  const cadence = item.weeklyTarget ? `${item.weeklyTarget}× / week · ${days}` : days;
  if (item.startDate && item.endDate) return `${cadence} / ${item.startDate} → ${item.endDate}`;
  if (item.startDate) return `${cadence} / from ${item.startDate}`;
  if (item.endDate) return `${cadence} / through ${item.endDate}`;
  return cadence;
}

function weekBounds(key: string) {
  const date = parseDateKey(key);
  const day = date.getDay();
  const start = new Date(date);
  start.setDate(date.getDate() - ((day + 6) % 7));
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  return { start: dateKey(start), end: dateKey(end) };
}

function weeklyCompletionCount(item: DailyItem, completions: DailyCompletion[], key: string) {
  const { start, end } = weekBounds(key);
  return completions.filter(
    (completion) =>
      completion.dailyId === item.id &&
      completion.completionDate >= start &&
      completion.completionDate <= end,
  ).length;
}

function isDailyDueOn(item: DailyItem, key: string, completions: DailyCompletion[]) {
  if (!isDailyScheduled(item, key)) return false;
  if (!item.weeklyTarget) return true;
  const { start } = weekBounds(key);
  const completedBefore = completions.filter(
    (completion) =>
      completion.dailyId === item.id &&
      completion.completionDate >= start &&
      completion.completionDate < key,
  ).length;
  return completedBefore < item.weeklyTarget;
}

function dailyPerformance(
  item: DailyItem,
  completions: DailyCompletion[],
  requestedStart: string,
  requestedEnd: string,
) {
  const start = dailyActiveStart(item) > requestedStart ? dailyActiveStart(item) : requestedStart;
  const end = item.endDate && item.endDate < requestedEnd ? item.endDate : requestedEnd;
  if (start > end) return { expected: 0, checked: 0 };

  const startDate = parseDateKey(start);
  const endDate = parseDateKey(end);
  const activeDays: string[] = [];
  for (const cursor = new Date(startDate); cursor <= endDate; cursor.setDate(cursor.getDate() + 1)) {
    const key = dateKey(cursor);
    if (isDailyScheduled(item, key)) activeDays.push(key);
  }
  const completedDays = new Set(
    completions
      .filter(
        (completion) =>
          completion.dailyId === item.id &&
          completion.completionDate >= start &&
          completion.completionDate <= end,
      )
      .map((completion) => completion.completionDate),
  );

  if (!item.weeklyTarget) {
    return {
      expected: activeDays.length,
      checked: activeDays.filter((key) => completedDays.has(key)).length,
    };
  }

  const weeks = new Map<string, string[]>();
  for (const key of activeDays) {
    const week = weekBounds(key).start;
    weeks.set(week, [...(weeks.get(week) ?? []), key]);
  }
  let expected = 0;
  let checked = 0;
  for (const days of weeks.values()) {
    const weeklyExpected = Math.min(item.weeklyTarget, days.length);
    expected += weeklyExpected;
    checked += Math.min(
      weeklyExpected,
      days.filter((key) => completedDays.has(key)).length,
    );
  }
  return { expected, checked };
}

function quickLinkInitials(label: string) {
  return label
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
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
  const [dailyItems, setDailyItems] = useState<DailyItem[]>([]);
  const [dailyCompletions, setDailyCompletions] = useState<DailyCompletion[]>([]);
  const [dailyLoading, setDailyLoading] = useState(true);
  const [quickLinks, setQuickLinks] = useState<QuickLink[]>([]);
  const [quickLinkSlot, setQuickLinkSlot] = useState<number | null>(null);
  const [collaborations, setCollaborations] = useState<CollaborationState>({
    incoming: [],
    outgoing: [],
    shared: [],
  });
  const [collaborationOpen, setCollaborationOpen] = useState(false);
  const [shareTarget, setShareTarget] = useState<Item | null>(null);
  const [shareProjectTarget, setShareProjectTarget] = useState<string | null>(null);
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
  const groupToggleTimerRef = useRef<number | null>(null);

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

  const loadDaily = useCallback(async () => {
    const response = await authenticatedFetch("/api/daily", { cache: "no-store" });
    if (!response.ok) throw new Error("Daily load failed");
    const data = (await response.json()) as {
      items: DailyItem[];
      completions: DailyCompletion[];
    };
    setDailyItems(data.items);
    setDailyCompletions(data.completions);
  }, [authenticatedFetch]);

  const loadQuickLinks = useCallback(async () => {
    const response = await authenticatedFetch("/api/quick-links", { cache: "no-store" });
    if (!response.ok) throw new Error("Quicklinks load failed");
    const data = (await response.json()) as { links: QuickLink[] };
    setQuickLinks(data.links);
  }, [authenticatedFetch]);

  const loadCollaborations = useCallback(async () => {
    const response = await authenticatedFetch("/api/sharing", { cache: "no-store" });
    if (!response.ok) throw new Error("Collaborations load failed");
    const data = (await response.json()) as CollaborationState;
    setCollaborations(data);
  }, [authenticatedFetch]);

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
        setDailyItems([]);
        setDailyCompletions([]);
        setQuickLinks([]);
        setCollaborations({ incoming: [], outgoing: [], shared: [] });
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
    if (!session) return;
    let active = true;
    const frame = window.requestAnimationFrame(() => {
      void loadDaily()
        .catch(() => undefined)
        .finally(() => {
          if (active) setDailyLoading(false);
        });
    });
    const channel = supabase
      .channel(`daily:${session.user.id}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "daily_items",
          filter: `user_id=eq.${session.user.id}`,
        },
        () => { void loadDaily(); },
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "daily_completions",
          filter: `user_id=eq.${session.user.id}`,
        },
        () => { void loadDaily(); },
      )
      .subscribe();
    return () => {
      active = false;
      window.cancelAnimationFrame(frame);
      void supabase.removeChannel(channel);
    };
  }, [loadDaily, session]);

  useEffect(() => {
    if (!session) return;
    let active = true;
    const frame = window.requestAnimationFrame(() => {
      void loadQuickLinks().catch(() => undefined);
    });
    const channel = supabase
      .channel(`quick-links:${session.user.id}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "quick_links",
          filter: `user_id=eq.${session.user.id}`,
        },
        () => {
          if (active) void loadQuickLinks();
        },
      )
      .subscribe();
    return () => {
      active = false;
      window.cancelAnimationFrame(frame);
      void supabase.removeChannel(channel);
    };
  }, [loadQuickLinks, session]);

  useEffect(() => {
    if (!session) return;
    let active = true;
    const reload = () => {
      if (!active) return;
      void Promise.all([
        loadCollaborations(),
        authenticatedFetch("/api/items", { cache: "no-store" })
          .then((response) => (response.ok ? response.json() : null))
          .then((data: { items: Item[] } | null) => {
            if (!data || !active) return;
            setItems(data.items);
            cacheItems(data.items);
          }),
      ]).catch(() => undefined);
    };
    const frame = window.requestAnimationFrame(reload);
    const refreshOnFocus = () => reload();
    const refreshTimer = window.setInterval(() => {
      if (document.visibilityState === "visible") reload();
    }, 20_000);
    window.addEventListener("focus", refreshOnFocus);
    const channel = supabase
      .channel(`collaboration:${session.user.id}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "workspace_item_members",
          filter: `user_id=eq.${session.user.id}`,
        },
        reload,
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "workspace_item_members",
          filter: `invited_by=eq.${session.user.id}`,
        },
        reload,
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "workspace_project_members",
          filter: `user_id=eq.${session.user.id}`,
        },
        reload,
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "workspace_project_members",
          filter: `invited_by=eq.${session.user.id}`,
        },
        reload,
      )
      .subscribe();
    return () => {
      active = false;
      window.cancelAnimationFrame(frame);
      window.clearInterval(refreshTimer);
      window.removeEventListener("focus", refreshOnFocus);
      void supabase.removeChannel(channel);
    };
  }, [authenticatedFetch, cacheItems, loadCollaborations, session]);

  useEffect(() => {
    if (!session) return;
    const parameters = new URLSearchParams(window.location.search);
    if (!parameters.has("calendar")) return;
    const frame = window.requestAnimationFrame(() => {
      setActiveView("agenda");
      window.history.replaceState({}, "", window.location.pathname);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [session]);

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
      const target = items.find((item) => item.id === id);
      let effectivePatch = patch;
      if (target && patch.completed === true && !target.completed) {
        const siblingPositions = items
          .filter(
            (item) =>
              item.id !== id &&
              item.section === target.section &&
              item.groupName === target.groupName &&
              item.archived === target.archived &&
              item.parentId === target.parentId,
          )
          .map((item) => item.position);
        effectivePatch = {
          ...patch,
          priority: "none",
          position: Math.max(-1, ...siblingPositions) + 1,
        };
      }
      setItems((current) => {
        const next = current.map((item) =>
          item.id === id ? { ...item, ...effectivePatch } : item,
        );
        cacheItems(next);
        return next;
      });
      void sendPatch(id, effectivePatch);
    },
    [cacheItems, items, sendPatch],
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
        ownerId: session?.user.id ?? "",
        ownerUsername: username,
        sharedWith: [],
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
    [authenticatedFetch, cacheItems, items, markSaved, session?.user.id, username],
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

  const saveDailyItem = useCallback(
    async (id: string | null, draft: DailyDraft) => {
      const response = await authenticatedFetch("/api/daily", {
        method: id ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(id ? { id, ...draft } : draft),
      });
      const result = (await response.json()) as { item?: DailyItem; error?: string };
      if (!response.ok || !result.item) throw new Error(result.error ?? "Daily could not be saved.");
      setDailyItems((current) =>
        id
          ? current.map((item) => (item.id === id ? result.item! : item))
          : [...current, result.item!],
      );
      return result.item;
    },
    [authenticatedFetch],
  );

  const completeDailyItem = useCallback(
    async (dailyId: string, completionDate: string) => {
      const optimistic: DailyCompletion = {
        dailyId,
        completionDate,
        completedAt: new Date().toISOString(),
      };
      setDailyCompletions((current) => [
        ...current.filter(
          (completion) =>
            completion.dailyId !== dailyId || completion.completionDate !== completionDate,
        ),
        optimistic,
      ]);
      try {
        const response = await authenticatedFetch("/api/daily", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "complete", dailyId, completionDate }),
        });
        const result = (await response.json()) as { completion?: DailyCompletion; error?: string };
        if (!response.ok || !result.completion) throw new Error(result.error ?? "Daily could not be completed.");
        setDailyCompletions((current) => [
          ...current.filter(
            (completion) =>
              completion.dailyId !== dailyId || completion.completionDate !== completionDate,
          ),
          result.completion!,
        ]);
      } catch (error) {
        setDailyCompletions((current) =>
          current.filter(
            (completion) =>
              completion.dailyId !== dailyId || completion.completionDate !== completionDate,
          ),
        );
        throw error;
      }
    },
    [authenticatedFetch],
  );

  const deleteDailyItem = useCallback(
    async (item: DailyItem) => {
      if (!window.confirm(`Permanently delete “${item.content}” and its history?`)) return;
      setDailyItems((current) => current.filter((entry) => entry.id !== item.id));
      setDailyCompletions((current) => current.filter((entry) => entry.dailyId !== item.id));
      const response = await authenticatedFetch("/api/daily", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: item.id }),
      });
      if (!response.ok) void loadDaily();
    },
    [authenticatedFetch, loadDaily],
  );

  const saveQuickLink = useCallback(
    async (slot: number, label: string, url: string) => {
      const response = await authenticatedFetch("/api/quick-links", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slot, label, url }),
      });
      const result = (await response.json()) as { link?: QuickLink; error?: string };
      if (!response.ok || !result.link) {
        throw new Error(result.error ?? "Quicklink could not be saved.");
      }
      setQuickLinks((current) => [
        ...current.filter((link) => link.slot !== slot),
        result.link!,
      ].sort((left, right) => left.slot - right.slot));
    },
    [authenticatedFetch],
  );

  const deleteQuickLink = useCallback(
    async (slot: number) => {
      const response = await authenticatedFetch("/api/quick-links", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slot }),
      });
      const result = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "Quicklink could not be cleared.");
      setQuickLinks((current) => current.filter((link) => link.slot !== slot));
    },
    [authenticatedFetch],
  );

  const sendCollaboration = useCallback(
    async (
      target: { kind: "item"; itemId: string } | { kind: "project"; projectName: string },
      recipientUsername: string,
    ) => {
      const response = await authenticatedFetch("/api/sharing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...target, username: recipientUsername }),
      });
      const result = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "Invitation could not be sent.");
      await loadCollaborations();
    },
    [authenticatedFetch, loadCollaborations],
  );

  const respondToCollaboration = useCallback(
    async (id: string, kind: Collaboration["kind"], status: "accepted" | "declined") => {
      const response = await authenticatedFetch("/api/sharing", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, kind, status }),
      });
      const result = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "Invitation could not be updated.");
      await Promise.all([loadCollaborations(), authenticatedFetch("/api/items", { cache: "no-store" })
        .then((itemsResponse) => itemsResponse.json())
        .then((data: { items: Item[] }) => {
          setItems(data.items);
          cacheItems(data.items);
        })]);
    },
    [authenticatedFetch, cacheItems, loadCollaborations],
  );

  const removeCollaboration = useCallback(
    async (id: string, kind: Collaboration["kind"]) => {
      const response = await authenticatedFetch("/api/sharing", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, kind }),
      });
      if (!response.ok) throw new Error("Collaboration could not be removed.");
      await loadCollaborations();
    },
    [authenticatedFetch, loadCollaborations],
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
    if (activeView === "agenda" || activeView === "daily") return [];
    return sortVisibleItems(
      items.filter((item) => item.section === activeView && !item.archived),
      sortMode,
    );
  }, [activeView, items, query, sortMode]);

  const dailySearchResults = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    return dailyItems.filter((item) =>
      `${item.content} ${item.note} ${(item.links ?? []).join(" ")} ${dailyScheduleLabel(item)}`
        .toLowerCase()
        .includes(needle),
    );
  }, [dailyItems, query]);

  const counts = useMemo(
    () => {
      const today = dateKey(new Date());
      const finishedToday = new Set(
        dailyCompletions
          .filter((completion) => completion.completionDate === today)
          .map((completion) => completion.dailyId),
      );
      return {
        now: items.filter((item) => item.section === "now" && !item.archived && !item.completed).length,
        projects: new Set(items.filter((item) => item.section === "projects" && !item.archived).map((item) => item.groupName)).size,
        library: items.filter((item) => item.section === "library" && !item.archived).length,
        archive: items.filter((item) => item.archived).length,
        agenda: items.filter((item) => item.dueDate && !item.archived && !item.completed).length,
        daily: dailyItems.filter(
          (item) => isDailyScheduled(item, today) && !finishedToday.has(item.id),
        ).length,
      };
    },
    [dailyCompletions, dailyItems, items],
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
    const applyRename = () => {
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
    if (section !== "projects") {
      applyRename();
      return;
    }
    void authenticatedFetch("/api/sharing", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "rename-project", oldProjectName: name, projectName: nextName }),
    })
      .then((response) => {
        if (!response.ok) throw new Error("Project rename failed");
        applyRename();
      })
      .catch(() => window.alert("The project could not be renamed. Please try again."));
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
    const applyDelete = () => {
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
    if (section !== "projects") {
      applyDelete();
      return;
    }
    void authenticatedFetch("/api/sharing", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "revoke-project", projectName: name }),
    })
      .then((response) => {
        if (!response.ok) throw new Error("Project delete failed");
        applyDelete();
      })
      .catch(() => window.alert("The project could not be deleted. Please try again."));
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
            : activeView === "daily"
              ? "Daily"
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
    if (view === "archive" || view === "agenda" || view === "daily") return;
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
              {view.id !== "archive" && view.id !== "agenda" && view.id !== "daily" && (
                <button className="nav-plus" aria-label={`Add to ${view.label}`} onClick={() => quickAddFor(view.id)}>+</button>
              )}
            </div>
          ))}
        </nav>

        <QuickLinks
          links={quickLinks}
          onEdit={(slot) => setQuickLinkSlot(slot)}
        />

        <button className="sidebar-toggle" onClick={toggleSidebar} aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}>
          <span aria-hidden="true" />
        </button>
        <button className="sidebar-resize" onPointerDown={resizeSidebar} aria-label="Resize sidebar" />
      </aside>

      {quickLinkSlot !== null && (
        <QuickLinkEditor
          slot={quickLinkSlot}
          link={quickLinks.find((entry) => entry.slot === quickLinkSlot) ?? null}
          onClose={() => setQuickLinkSlot(null)}
          onSave={async (label, url) => {
            await saveQuickLink(quickLinkSlot, label, url);
            setQuickLinkSlot(null);
          }}
          onDelete={async () => {
            await deleteQuickLink(quickLinkSlot);
            setQuickLinkSlot(null);
          }}
        />
      )}

      {(collaborationOpen || shareTarget || shareProjectTarget) && (
        <CollaborationCenter
          currentUserId={session.user.id}
          items={items}
          initialItem={shareTarget}
          initialProject={shareProjectTarget}
          state={collaborations}
          authenticatedFetch={authenticatedFetch}
          onClose={() => {
            setCollaborationOpen(false);
            setShareTarget(null);
            setShareProjectTarget(null);
          }}
          onSend={sendCollaboration}
          onRespond={respondToCollaboration}
          onRemove={removeCollaboration}
          onOpenItem={(itemId) => {
            if (!itemId) return;
            const item = items.find((entry) => entry.id === itemId);
            if (item) openOriginalItem(item);
            setCollaborationOpen(false);
            setShareTarget(null);
            setShareProjectTarget(null);
          }}
        />
      )}

      <section className="canvas">
        <header className="topbar">
          <div className="topbar-title">
            <span aria-hidden="true">{"//"}</span>
            <strong>{viewTitle}</strong>
          </div>
          <div className="topbar-tools">
            {activeView !== "agenda" && activeView !== "daily" && (
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
                onClick={() => {
                  void loadCollaborations().catch(() => undefined);
                  setAccountOpen((open) => !open);
                }}
              >
                <span>{username.slice(0, 1).toUpperCase()}</span>
                <strong>{username || "Account"}</strong>
                {collaborations.incoming.length > 0 && (
                  <em className="account-inbox-badge" aria-label={`${collaborations.incoming.length} pending shared line${collaborations.incoming.length === 1 ? "" : "s"}`}>
                    {collaborations.incoming.length}
                  </em>
                )}
                <i aria-hidden="true">⌄</i>
              </button>
              {accountOpen && (
                <div className="account-menu" role="menu">
                  <small>{session.user.email}</small>
                  <button
                    type="button"
                    role="menuitem"
                    className="account-shared"
                    onClick={() => {
                      void loadCollaborations().catch(() => undefined);
                      setCollaborationOpen(true);
                      setAccountOpen(false);
                    }}
                  >
                    <span>People &amp; shared</span>
                    {collaborations.incoming.length > 0 && (
                      <em>{collaborations.incoming.length}</em>
                    )}
                  </button>
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
          {activeView !== "agenda" && activeView !== "daily" && (
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
              authenticatedFetch={authenticatedFetch}
            />
          ) : !query && activeView === "daily" ? (
            <DailyView
              items={dailyItems}
              completions={dailyCompletions}
              loading={dailyLoading}
              saveItem={saveDailyItem}
              completeItem={completeDailyItem}
              deleteItem={deleteDailyItem}
            />
          ) : activeItems.length === 0 && dailySearchResults.length === 0 ? (
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
                  <span>{activeItems.length + dailySearchResults.length} lines</span>
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
                  onShare={() => {
                    void loadCollaborations().catch(() => undefined);
                    setShareTarget(item);
                  }}
                  canDelete={!item.ownerId || item.ownerId === session.user.id}
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
              {query && dailySearchResults.map((item) => (
                <button
                  type="button"
                  className="daily-search-line"
                  key={`daily-${item.id}`}
                  onClick={() => {
                    setQuery("");
                    setActiveView("daily");
                  }}
                >
                  <span className="daily-search-mark">05</span>
                  <strong>{item.content}</strong>
                  <small>Daily · {dailyScheduleLabel(item)}</small>
                  <em>›</em>
                </button>
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
                        if (!groupItems.some((item) => item.ownerId === session.user.id)) {
                          return;
                        }
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
                        if (!groupItems.some((item) => item.ownerId === session.user.id)) return;
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
                      {activeView === "projects" && name !== "Unsorted" && groupItems.some((item) => item.ownerId === session.user.id) && (
                        <button
                          type="button"
                          className="share-tool"
                          aria-label={`Share ${name}`}
                          title="Share project"
                          onClick={() => {
                            void loadCollaborations().catch(() => undefined);
                            setShareProjectTarget(name);
                          }}
                        >
                          <span aria-hidden="true">📧</span>
                        </button>
                      )}
                      {name !== "Unsorted" && groupItems.some((item) => item.ownerId === session.user.id) && (
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
                          onShare={() => {
                            void loadCollaborations().catch(() => undefined);
                            setShareTarget(item);
                          }}
                          canDelete={!item.ownerId || item.ownerId === session.user.id}
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
        setMessage("If this is a new email, check your inbox to confirm it. If you already signed up, log in instead.");
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
              {message && (
                <button type="button" className="auth-inline-action" onClick={() => switchMode("login")}>
                  Log in instead →
                </button>
              )}
              <button className="auth-submit" type="submit" disabled={busy || Boolean(message)}>
                {busy ? "Creating…" : message ? "Confirmation requested" : "Create workspace"}
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

function QuickLinks({
  links,
  onEdit,
}: {
  links: QuickLink[];
  onEdit: (slot: number) => void;
}) {
  return (
    <section className="quicklinks" aria-label="Quicklinks">
      <div className="quicklinks-grid">
        {[1, 2, 3, 4].map((slot) => {
          const link = links.find((entry) => entry.slot === slot);
          return (
            <div className={`quicklink-slot ${link ? "filled" : "empty"}`} key={slot}>
              {link ? (
                <>
                  <a href={link.url} target="_blank" rel="noreferrer" aria-label={`Open ${link.label}`}>
                    <strong>{quickLinkInitials(link.label)}</strong>
                    <span>{link.label}</span>
                  </a>
                  <button
                    type="button"
                    className="quicklink-edit"
                    aria-label={`Edit ${link.label}`}
                    onClick={() => onEdit(slot)}
                  >
                    ···
                  </button>
                </>
              ) : (
                <button type="button" className="quicklink-empty" onClick={() => onEdit(slot)} aria-label={`Configure Quicklink ${slot}`}>
                  <strong>+</strong>
                  <span>{String(slot).padStart(2, "0")}</span>
                </button>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function QuickLinkEditor({
  slot,
  link,
  onClose,
  onSave,
  onDelete,
}: {
  slot: number;
  link: QuickLink | null;
  onClose: () => void;
  onSave: (label: string, url: string) => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const [label, setLabel] = useState(link?.label ?? "");
  const [url, setUrl] = useState(link?.url ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    const candidate = /^https?:\/\//i.test(url.trim()) ? url.trim() : `https://${url.trim()}`;
    if (!label.trim() || !isUrl(candidate)) {
      setError("Add a name and a complete link.");
      return;
    }
    setSaving(true);
    try {
      await onSave(label.trim(), candidate);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Quicklink could not be saved.");
      setSaving(false);
    }
  };

  return (
    <div className="quicklink-editor-backdrop" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}>
      <form className="quicklink-editor" onSubmit={submit}>
        <div className="quicklink-editor-head">
          <div><span>Quicklink {String(slot).padStart(2, "0")}</span><strong>{link ? "Edit reference." : "Pin a reference."}</strong></div>
          <button type="button" aria-label="Close Quicklink editor" onClick={onClose}>×</button>
        </div>
        <label><span>Name</span><input autoFocus maxLength={32} value={label} onChange={(event) => setLabel(event.target.value)} placeholder="UofT Hub" /></label>
        <label><span>Link</span><input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://…" /></label>
        {error && <p className="daily-error">{error}</p>}
        <div className="quicklink-editor-actions">
          {link && (
            <button
              type="button"
              className="danger"
              onClick={() => {
                setSaving(true);
                void onDelete().catch((deleteError) => {
                  setError(deleteError instanceof Error ? deleteError.message : "Quicklink could not be cleared.");
                  setSaving(false);
                });
              }}
            >
              Clear slot
            </button>
          )}
          <button type="submit" className="primary" disabled={saving || !label.trim() || !url.trim()}>
            {saving ? "Saving…" : "Save Quicklink"}<span>→</span>
          </button>
        </div>
      </form>
    </div>
  );
}

function DailyView({
  items,
  completions,
  loading,
  saveItem,
  completeItem,
  deleteItem,
}: {
  items: DailyItem[];
  completions: DailyCompletion[];
  loading: boolean;
  saveItem: (id: string | null, draft: DailyDraft) => Promise<DailyItem>;
  completeItem: (id: string, completionDate: string) => Promise<void>;
  deleteItem: (item: DailyItem) => Promise<void>;
}) {
  const [mode, setMode] = useState<DailyMode>("today");
  const [editorItem, setEditorItem] = useState<DailyItem | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [departingId, setDepartingId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const today = dateKey(new Date());
  const [selectedTrackerDate, setSelectedTrackerDate] = useState(today);
  const completedToday = useMemo(
    () =>
      new Set(
        completions
          .filter((completion) => completion.completionDate === today)
          .map((completion) => completion.dailyId),
      ),
    [completions, today],
  );
  const scheduledToday = useMemo(
    () => items.filter((item) => isDailyDueOn(item, today, completions)),
    [completions, items, today],
  );
  const remaining = scheduledToday.filter((item) => !completedToday.has(item.id));
  const finishedCount = scheduledToday.length - remaining.length;

  const trackerDays = useMemo(() => {
    const currentWeek = weekBounds(today);
    const start = parseDateKey(currentWeek.start);
    start.setDate(start.getDate() - 15 * 7);
    const end = parseDateKey(currentWeek.end);
    end.setDate(end.getDate() + 7);
    const length = Math.round((end.getTime() - start.getTime()) / 86400000) + 1;
    return Array.from({ length }, (_, index) => {
      const day = new Date(start);
      day.setDate(start.getDate() + index);
      const key = dateKey(day);
      const eligible = items.filter((item) => isDailyDueOn(item, key, completions));
      const finished = eligible.filter((item) =>
        completions.some(
          (completion) => completion.dailyId === item.id && completion.completionDate === key,
        ),
      ).length;
      return {
        key,
        eligible: eligible.length,
        finished,
        ratio: eligible.length ? finished / eligible.length : -1,
        future: key > today,
      };
    });
  }, [completions, items, today]);

  const historyDays = trackerDays.filter((day) => !day.future);
  const selectedCompletedIds = new Set(
    completions
      .filter((completion) => completion.completionDate === selectedTrackerDate)
      .map((completion) => completion.dailyId),
  );
  const selectedDayItems = items
    .filter(
      (item) =>
        selectedCompletedIds.has(item.id) ||
        isDailyDueOn(item, selectedTrackerDate, completions),
    )
    .sort((left, right) => {
      const completionDifference =
        Number(selectedCompletedIds.has(right.id)) - Number(selectedCompletedIds.has(left.id));
      return completionDifference || left.position - right.position;
    });
  const selectedCompletedCount = selectedDayItems.filter((item) =>
    selectedCompletedIds.has(item.id),
  ).length;
  const recentStartDate = parseDateKey(today);
  recentStartDate.setDate(recentStartDate.getDate() - 29);
  const recentStart = dateKey(recentStartDate);
  const recentPerformance = items.reduce(
    (total, item) => {
      const performance = dailyPerformance(item, completions, recentStart, today);
      return {
        expected: total.expected + performance.expected,
        checked: total.checked + performance.checked,
      };
    },
    { expected: 0, checked: 0 },
  );
  const totalDue = recentPerformance.expected;
  const totalFinished = recentPerformance.checked;
  const completionRate = totalDue ? Math.round((totalFinished / totalDue) * 100) : 0;
  const nextSevenDate = parseDateKey(today);
  nextSevenDate.setDate(nextSevenDate.getDate() + 7);
  const nextSeven = dateKey(nextSevenDate);
  const upcomingOpportunities = trackerDays
    .filter((day) => day.key > today && day.key <= nextSeven)
    .reduce((sum, day) => sum + day.eligible, 0);
  let streak = 0;
  for (let index = historyDays.length - 1; index >= 0; index -= 1) {
    const day = historyDays[index];
    if (!day.eligible) continue;
    if (day.ratio === 1) streak += 1;
    else if (day.key === today) continue;
    else break;
  }

  const complete = (item: DailyItem) => {
    setDepartingId(item.id);
    window.setTimeout(() => {
      void completeItem(item.id, today).catch((completionError) => {
        setError(completionError instanceof Error ? completionError.message : "Daily could not be completed.");
      });
      setDepartingId(null);
    }, 190);
  };

  return (
    <section className="daily-shell" aria-label="Daily routines">
      <div className="daily-heading">
        <div className="daily-tabs" role="tablist" aria-label="Daily views">
          <button
            type="button"
            role="tab"
            aria-selected={mode === "today"}
            className={mode === "today" ? "active" : ""}
            onClick={() => setMode("today")}
          >
            Today
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "tracker"}
            className={mode === "tracker" ? "active" : ""}
            onClick={() => setMode("tracker")}
          >
            Daily Tracker
          </button>
        </div>
        <div className="daily-date">
          <span>Daily cycle</span>
          <strong>{fullDateLabel(today)}</strong>
        </div>
        <button
          type="button"
          className="daily-add"
          onClick={() => {
            setEditorItem(null);
            setEditorOpen(true);
          }}
        >
          + New daily
        </button>
      </div>

      {error && <div className="daily-error" role="status">{error}</div>}

      {mode === "today" ? (
        <div className="daily-today-layout">
          <div className="daily-main">
            <div className="daily-signal">
              <span><strong>{remaining.length}</strong> remaining</span>
              <span><strong>{finishedCount}</strong> finished</span>
              <span><strong>{scheduledToday.length ? Math.round((finishedCount / scheduledToday.length) * 100) : 0}%</strong> today</span>
              <i>{streak} day streak</i>
            </div>
            <div className="daily-list-head">
              <span>Today&apos;s rhythm</span>
              <em>{scheduledToday.length} scheduled</em>
            </div>
            {loading ? (
              <div className="loading-lines"><span /><span /><span /></div>
            ) : remaining.length ? (
              <div className="daily-list">
                {remaining.map((item, index) => (
                  <article
                    className={`daily-row ${departingId === item.id ? "departing" : ""}`}
                    key={item.id}
                  >
                    <button
                      type="button"
                      className="daily-check"
                      aria-label={`Complete ${item.content}`}
                      onClick={() => complete(item)}
                    >
                      <span />
                    </button>
                    <span className="daily-row-index">{String(index + 1).padStart(2, "0")}</span>
                    <div className="daily-row-copy">
                      <strong>{item.content}</strong>
                      <small>{dailyScheduleLabel(item)}</small>
                    </div>
                    <div className="daily-row-signals">
                      {item.weeklyTarget && (
                        <span className="weekly-progress" title={`${weeklyCompletionCount(item, completions, today)} of ${item.weeklyTarget} completed this week`}>
                          {weeklyCompletionCount(item, completions, today)}/{item.weeklyTarget}
                        </span>
                      )}
                      {item.note && <span title={item.note}>N</span>}
                      {item.links.length > 0 && (
                        <a href={item.links[0]} target="_blank" rel="noreferrer" title="Open first link">⌁</a>
                      )}
                    </div>
                    <button
                      type="button"
                      className="daily-edit"
                      onClick={() => {
                        setEditorItem(item);
                        setEditorOpen(true);
                      }}
                    >
                      Edit
                    </button>
                  </article>
                ))}
              </div>
            ) : (
              <div className="daily-clear">
                <span aria-hidden="true">✓</span>
                <strong>{scheduledToday.length ? "Daily rhythm complete." : "Nothing scheduled today."}</strong>
                <p>{scheduledToday.length ? "Everything returns on its next scheduled day." : "Add a daily or adjust its active weekdays."}</p>
              </div>
            )}
          </div>

          <aside className="daily-manage">
            <div className="daily-manage-head">
              <span>Routine file</span>
              <em>{items.length}</em>
            </div>
            {items.map((item) => (
              <div className="daily-manage-row" key={`manage-${item.id}`}>
                <button
                  type="button"
                  onDoubleClick={() => {
                    setEditorItem(item);
                    setEditorOpen(true);
                  }}
                  onClick={() => {
                    setEditorItem(item);
                    setEditorOpen(true);
                  }}
                >
                  <strong>{item.content}</strong>
                  <small>{dailyScheduleLabel(item)}</small>
                </button>
                <button
                  type="button"
                  className="danger"
                  aria-label={`Delete ${item.content}`}
                  onClick={() => void deleteItem(item)}
                >
                  ×
                </button>
              </div>
            ))}
          </aside>
        </div>
      ) : (
        <div className="daily-tracker">
          <div className="daily-tracker-metrics">
            <div><span>Completion</span><strong>{completionRate}%</strong><em>last 30 days</em></div>
            <div><span>Current streak</span><strong>{streak}</strong><em>scheduled days</em></div>
            <div><span>Checks logged</span><strong>{totalFinished}</strong><em>of {totalDue} expected</em></div>
            <div><span>Coming up</span><strong>{upcomingOpportunities}</strong><em>next 7 days</em></div>
          </div>
          <section className="daily-heatmap-panel">
            <div className="daily-tracker-head">
              <div>
                <span>Consistency field</span>
                <strong>{shortDateLabel(trackerDays[0].key)} – {shortDateLabel(trackerDays[trackerDays.length - 1].key)}</strong>
                <small>15 weeks back · next week visible</small>
              </div>
              <div className="daily-heatmap-key"><span>Less</span><i /><i className="level-1" /><i className="level-2" /><i className="level-3" /><i className="level-4" /><span>More</span><i className="upcoming" /><span>Upcoming</span></div>
            </div>
            <div className="daily-heatmap" aria-label="Daily completion heatmap">
              {trackerDays.map((day) => {
                const level = day.future
                  ? day.eligible ? "upcoming" : "future-off"
                  : day.ratio < 0 ? "off" : day.ratio === 0 ? "level-0" : day.ratio < .4 ? "level-1" : day.ratio < .7 ? "level-2" : day.ratio < 1 ? "level-3" : "level-4";
                const title = day.future
                  ? `${fullDateLabel(day.key)} — ${day.eligible ? `${day.eligible} available` : "nothing scheduled"}`
                  : `${fullDateLabel(day.key)} — ${day.eligible ? `${day.finished}/${day.eligible} completed` : "not active"}`;
                return (
                  <button
                    type="button"
                    className={`${level} ${day.key === today ? "today" : ""} ${day.key === selectedTrackerDate ? "selected" : ""}`}
                    key={day.key}
                    title={title}
                    aria-label={title}
                    aria-pressed={day.key === selectedTrackerDate}
                    onClick={() => setSelectedTrackerDate(day.key)}
                  />
                );
              })}
            </div>
            <div className="daily-day-inspector" aria-live="polite">
              <div className="daily-day-inspector-head">
                <div>
                  <span>Day file</span>
                  <strong>{fullDateLabel(selectedTrackerDate)}</strong>
                </div>
                <em>
                  {selectedTrackerDate > today
                    ? `${selectedDayItems.length} available`
                    : `${selectedCompletedCount} of ${selectedDayItems.length} completed`}
                </em>
              </div>
              {selectedDayItems.length ? (
                <div className="daily-day-inspector-list">
                  {selectedDayItems.map((item) => {
                    const completed = selectedCompletedIds.has(item.id);
                    const future = selectedTrackerDate > today;
                    return (
                      <button
                        type="button"
                        className={completed ? "completed" : future ? "upcoming" : "missed"}
                        key={`day-${selectedTrackerDate}-${item.id}`}
                        onClick={() => {
                          setEditorItem(item);
                          setEditorOpen(true);
                        }}
                      >
                        <i aria-hidden="true">{completed ? "✓" : future ? "→" : "·"}</i>
                        <span>
                          <strong>{item.content}</strong>
                          <small>{dailyScheduleLabel(item)}</small>
                        </span>
                        <em>{completed ? "Completed" : future ? "Available" : "Missed"}</em>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <p className="daily-day-inspector-empty">
                  {selectedTrackerDate > today ? "Nothing is available on this day." : "Nothing was scheduled on this day."}
                </p>
              )}
            </div>
          </section>
          <section className="daily-performance">
            <div className="daily-list-head"><span>By daily</span><em>completion history</em></div>
            {items.map((item) => {
              const visibleStart = trackerDays[0].key;
              const performance = dailyPerformance(item, completions, visibleStart, today);
              const rate = performance.expected ? Math.round((performance.checked / performance.expected) * 100) : 0;
              const activeSince = dailyActiveStart(item) > visibleStart ? dailyActiveStart(item) : visibleStart;
              return (
                <button
                  type="button"
                  className="daily-performance-row"
                  key={`performance-${item.id}`}
                  onClick={() => {
                    setEditorItem(item);
                    setEditorOpen(true);
                  }}
                >
                  <span>
                    <strong>{item.content}</strong>
                    <small>{performance.checked} of {performance.expected} {item.weeklyTarget ? "target checks" : "scheduled days"} · since {shortDateLabel(activeSince)}</small>
                  </span>
                  <i><span style={{ width: `${rate}%` }} /></i>
                  <em>{rate}%</em>
                </button>
              );
            })}
          </section>
        </div>
      )}

      {editorOpen && (
        <DailyEditor
          item={editorItem}
          onClose={() => setEditorOpen(false)}
          onSave={async (draft) => {
            await saveItem(editorItem?.id ?? null, draft);
            setEditorOpen(false);
          }}
        />
      )}
    </section>
  );
}

function DailyEditor({
  item,
  onClose,
  onSave,
}: {
  item: DailyItem | null;
  onClose: () => void;
  onSave: (draft: DailyDraft) => Promise<void>;
}) {
  const [content, setContent] = useState(item?.content ?? "");
  const [note, setNote] = useState(item?.note ?? "");
  const [links, setLinks] = useState((item?.links ?? []).join("\n"));
  const [weekdayMask, setWeekdayMask] = useState(item?.weekdayMask ?? 127);
  const [weeklyTarget, setWeeklyTarget] = useState<number | null>(item?.weeklyTarget ?? null);
  const [startDate, setStartDate] = useState(item?.startDate ?? "");
  const [endDate, setEndDate] = useState(item?.endDate ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    if (!content.trim()) return;
    if (startDate && endDate && endDate < startDate) {
      setError("The end date must follow the start date.");
      return;
    }
    setSaving(true);
    try {
      await onSave({
        content: content.trim(),
        note: note.trim(),
        links: links.split(/\n|,/).map((link) => link.trim()).filter(Boolean),
        weekdayMask,
        weeklyTarget,
        startDate: startDate || null,
        endDate: endDate || null,
      });
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Daily could not be saved.");
      setSaving(false);
    }
  };

  return (
    <div className="daily-editor-backdrop" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}>
      <form className="daily-editor" onSubmit={submit}>
        <div className="daily-editor-head">
          <div><span>{item ? "Edit daily" : "New daily"}</span><strong>Set the rhythm.</strong></div>
          <button type="button" aria-label="Close daily editor" onClick={onClose}>×</button>
        </div>
        <label><span>Daily</span><input autoFocus value={content} onChange={(event) => setContent(event.target.value)} placeholder="Read a book" /></label>
        <fieldset>
          <legend>Days per week <em>optional</em></legend>
          <div className="daily-weekly-targets">
            <button
              type="button"
              className={weeklyTarget === null ? "active" : ""}
              aria-pressed={weeklyTarget === null}
              onClick={() => setWeeklyTarget(null)}
            >
              Fixed
            </button>
            {[1, 2, 3, 4, 5, 6, 7].map((target) => (
              <button
                type="button"
                className={weeklyTarget === target ? "active" : ""}
                aria-pressed={weeklyTarget === target}
                key={target}
                onClick={() => setWeeklyTarget(target)}
              >
                {target}
              </button>
            ))}
          </div>
          <small className="daily-target-hint">
            {weeklyTarget ? `Goal: ${weeklyTarget} check${weeklyTarget === 1 ? "" : "s"} across the active days below.` : "Fixed uses the exact active-day schedule."}
          </small>
        </fieldset>
        <fieldset>
          <legend>Active days</legend>
          <div className="daily-weekdays">
            {weekdayLabels.map((day, index) => {
              const enabled = (weekdayMask & (1 << index)) !== 0;
              return (
                <button
                  type="button"
                  className={enabled ? "active" : ""}
                  aria-pressed={enabled}
                  key={day}
                  onClick={() => {
                    const next = enabled ? weekdayMask & ~(1 << index) : weekdayMask | (1 << index);
                    if (next) setWeekdayMask(next);
                  }}
                >
                  {day.slice(0, 1)}
                </button>
              );
            })}
          </div>
        </fieldset>
        <div className="daily-date-range">
          <label><span>Starts</span><input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} /></label>
          <i aria-hidden="true">→</i>
          <label><span>Ends</span><input type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} /></label>
        </div>
        <small className="daily-date-hint">Leave dates open for a permanent daily. Add both for a temporary one.</small>
        <label><span>Note</span><textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="Optional context" /></label>
        <label><span>Links</span><textarea value={links} onChange={(event) => setLinks(event.target.value)} placeholder="One link per line" /></label>
        {error && <p className="daily-error">{error}</p>}
        <button className="daily-editor-save" type="submit" disabled={saving || !content.trim()}>{saving ? "Saving…" : item ? "Save daily" : "Create daily"}<span>→</span></button>
      </form>
    </div>
  );
}

function AgendaView({
  items,
  updateItem,
  openOriginal,
  onCapture,
  zoomPreferenceKey,
  authenticatedFetch,
}: {
  items: Item[];
  updateItem: (id: string, patch: Patch) => void;
  openOriginal: (item: Item) => void;
  onCapture: (value: string) => void;
  zoomPreferenceKey: string;
  authenticatedFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
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
  const [selectedGoogleEventId, setSelectedGoogleEventId] = useState<string | null>(null);
  const [agendaCapture, setAgendaCapture] = useState("");
  const [agendaZoom, setAgendaZoom] = useState(1);
  const [googleEvents, setGoogleEvents] = useState<GoogleCalendarEvent[]>([]);
  const [googleCalendar, setGoogleCalendar] = useState({
    configured: true,
    connected: false,
    calendarEmail: "",
    loading: true,
    error: "",
  });

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

  const googleEventsByDate = useMemo(() => {
    const grouped = new Map<string, GoogleCalendarEvent[]>();
    for (const event of googleEvents) {
      const key = event.start.slice(0, 10);
      if (!key) continue;
      grouped.set(key, [...(grouped.get(key) ?? []), event]);
    }
    return grouped;
  }, [googleEvents]);

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

  const loadGoogleCalendar = useCallback(async () => {
    const first = new Date(monthCursor.getFullYear(), monthCursor.getMonth(), 1);
    first.setDate(first.getDate() - 8);
    const last = new Date(monthCursor.getFullYear(), monthCursor.getMonth() + 1, 1);
    last.setDate(last.getDate() + 8);
    try {
      const response = await authenticatedFetch(
        `/api/calendar/google?from=${dateKey(first)}&to=${dateKey(last)}`,
        { cache: "no-store" },
      );
      const result = (await response.json()) as {
        configured?: boolean;
        connected?: boolean;
        calendarEmail?: string;
        events?: GoogleCalendarEvent[];
        error?: string;
      };
      setGoogleEvents(result.events ?? []);
      setGoogleCalendar({
        configured: result.configured !== false,
        connected: Boolean(result.connected),
        calendarEmail: result.calendarEmail ?? "",
        loading: false,
        error: result.error ?? "",
      });
    } catch {
      setGoogleCalendar((current) => ({
        ...current,
        loading: false,
        error: "Google Calendar is temporarily unavailable.",
      }));
    }
  }, [authenticatedFetch, monthCursor]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      void loadGoogleCalendar();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [loadGoogleCalendar]);

  const connectGoogleCalendar = async () => {
    setGoogleCalendar((current) => ({ ...current, loading: true, error: "" }));
    const response = await authenticatedFetch("/api/calendar/google", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "begin" }),
    });
    const result = (await response.json()) as { url?: string; error?: string };
    if (!response.ok || !result.url) {
      setGoogleCalendar((current) => ({
        ...current,
        loading: false,
        error: result.error ?? "Google Calendar could not start connecting.",
      }));
      return;
    }
    window.location.assign(result.url);
  };

  const disconnectGoogleCalendar = async () => {
    if (!window.confirm("Disconnect Google Calendar from Ink & Iron?")) return;
    const response = await authenticatedFetch("/api/calendar/google", { method: "DELETE" });
    if (!response.ok) return;
    setGoogleEvents([]);
    setSelectedGoogleEventId(null);
    setGoogleCalendar((current) => ({ ...current, connected: false, calendarEmail: "" }));
  };

  const selectedDayItems = eventsByDate.get(selectedDate) ?? [];
  const selectedDayGoogleEvents = googleEventsByDate.get(selectedDate) ?? [];
  const selectedItem = selectedItemId
    ? items.find((item) => item.id === selectedItemId) ?? null
    : null;
  const selectedGoogleEvent = selectedGoogleEventId
    ? googleEvents.find((event) => event.id === selectedGoogleEventId) ?? null
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
    setSelectedGoogleEventId(
      eventsByDate.get(key)?.length ? null : googleEventsByDate.get(key)?.[0]?.id ?? null,
    );
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
    setSelectedGoogleEventId(null);
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
        <div className={`agenda-connections ${googleCalendar.connected ? "connected" : ""}`}>
          <button
            type="button"
            className="google-calendar-connect"
            disabled={googleCalendar.loading}
            title={googleCalendar.calendarEmail || googleCalendar.error || "Connect Google Calendar"}
            onClick={() => void (googleCalendar.connected ? loadGoogleCalendar() : connectGoogleCalendar())}
          >
            <span aria-hidden="true">G</span>
            <strong>
              {googleCalendar.loading
                ? "Calendar…"
                : googleCalendar.connected
                  ? "Google synced"
                  : googleCalendar.configured
                    ? "Connect Google"
                    : "Google setup"}
            </strong>
            <i aria-hidden="true">{googleCalendar.connected ? "●" : "↗"}</i>
          </button>
          {googleCalendar.connected && (
            <button
              type="button"
              className="google-calendar-disconnect"
              aria-label="Disconnect Google Calendar"
              title="Disconnect Google Calendar"
              onClick={() => void disconnectGoogleCalendar()}
            >
              ×
            </button>
          )}
        </div>
      </div>

      {googleCalendar.error && (
        <div className="agenda-calendar-notice" role="status">
          <span>{googleCalendar.error}</span>
          {!googleCalendar.configured && <em>OAuth credentials are required once to activate it.</em>}
        </div>
      )}

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
                const dayGoogleEvents = googleEventsByDate.get(key) ?? [];
                const entryCount = dayItems.length + dayGoogleEvents.length;
                const outside = day.getMonth() !== monthCursor.getMonth();
                return (
                  <div
                    className={`agenda-day ${outside ? "outside" : ""} ${key === todayKey ? "today" : ""} ${key === selectedDate ? "selected" : ""}`}
                    role="button"
                    tabIndex={0}
                    aria-label={`${fullDateLabel(key)}, ${entryCount} calendar entries`}
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
                            setSelectedGoogleEventId(null);
                          }}
                        >
                          {item.content}
                        </button>
                      ))}
                      {dayGoogleEvents
                        .slice(0, Math.max(0, 3 - dayItems.length))
                        .map((event) => (
                          <button
                            type="button"
                            className="agenda-event google-event"
                            key={`google-${event.id}`}
                            title={event.title}
                            onClick={(clickEvent) => {
                              clickEvent.stopPropagation();
                              setSelectedDate(key);
                              setSelectedItemId(null);
                              setSelectedGoogleEventId(event.id);
                            }}
                          >
                            {event.title}
                          </button>
                        ))}
                      {entryCount > 3 && <span className="agenda-event-more">+{entryCount - 3}</span>}
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
              <em>
                {selectedDayItems.length + selectedDayGoogleEvents.length}{" "}
                {selectedDayItems.length + selectedDayGoogleEvents.length === 1 ? "entry" : "entries"}
              </em>
            </div>
            <div className="agenda-day-list">
              {selectedDayItems.length || selectedDayGoogleEvents.length ? <>
                {selectedDayItems.map((item) => (
                <button
                  type="button"
                  className={selectedItemId === item.id ? "active" : ""}
                  key={item.id}
                  onClick={() => {
                    setSelectedItemId(item.id);
                    setSelectedGoogleEventId(null);
                  }}
                >
                  <i className={`priority-dot priority-${item.priority}`} />
                  <span>{item.content}<small>{sectionLabel(item)}</small></span>
                  <em>›</em>
                </button>
                ))}
                {selectedDayGoogleEvents.map((event) => (
                  <button
                    type="button"
                    className={selectedGoogleEventId === event.id ? "active google" : "google"}
                    key={`google-list-${event.id}`}
                    onClick={() => {
                      setSelectedItemId(null);
                      setSelectedGoogleEventId(event.id);
                    }}
                  >
                    <i className="google-event-dot">G</i>
                    <span>{event.title}<small>Google Calendar</small></span>
                    <em>›</em>
                  </button>
                ))}
              </> : (
                <p>Nothing scheduled for this day.</p>
              )}
            </div>
            {selectedItem ? (
              <AgendaInspector key={selectedItem.id} item={selectedItem} updateItem={updateItem} openOriginal={openOriginal} />
            ) : selectedGoogleEvent ? (
              <GoogleCalendarInspector event={selectedGoogleEvent} />
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

function GoogleCalendarInspector({ event }: { event: GoogleCalendarEvent }) {
  const timeLabel = event.allDay
    ? "All day"
    : new Date(event.start).toLocaleTimeString(undefined, {
        hour: "numeric",
        minute: "2-digit",
      });
  return (
    <div className="agenda-inspector google-inspector">
      <div className="agenda-inspector-label">
        <span>Google Calendar</span>
        <i>Synced</i>
      </div>
      <strong className="google-inspector-title">{event.title}</strong>
      <dl>
        <div><dt>When</dt><dd>{timeLabel}</dd></div>
        {event.location && <div><dt>Where</dt><dd>{event.location}</dd></div>}
      </dl>
      {event.description && <p>{event.description}</p>}
      {event.htmlLink && (
        <a href={event.htmlLink} target="_blank" rel="noreferrer">
          Open in Google Calendar <span aria-hidden="true">↗</span>
        </a>
      )}
    </div>
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

function CollaborationCenter({
  currentUserId,
  items,
  initialItem,
  initialProject,
  state,
  authenticatedFetch,
  onClose,
  onSend,
  onRespond,
  onRemove,
  onOpenItem,
}: {
  currentUserId: string;
  items: Item[];
  initialItem: Item | null;
  initialProject: string | null;
  state: CollaborationState;
  authenticatedFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  onClose: () => void;
  onSend: (target: { kind: "item"; itemId: string } | { kind: "project"; projectName: string }, username: string) => Promise<void>;
  onRespond: (id: string, kind: Collaboration["kind"], status: "accepted" | "declined") => Promise<void>;
  onRemove: (id: string, kind: Collaboration["kind"]) => Promise<void>;
  onOpenItem: (itemId: string | null) => void;
}) {
  const ownItems = items.filter((item) => (!item.ownerId || item.ownerId === currentUserId) && !item.archived);
  const ownProjects = [...new Set(ownItems.filter((item) => item.section === "projects" && item.groupName && item.groupName !== "Unsorted").map((item) => item.groupName))];
  const [mode, setMode] = useState<"send" | "inbox" | "shared">(
    initialItem?.ownerId === currentUserId || initialProject ? "send" : state.incoming.length ? "inbox" : "shared",
  );
  const [targetKind, setTargetKind] = useState<Collaboration["kind"]>(initialProject ? "project" : "item");
  const [itemId, setItemId] = useState(initialItem?.ownerId === currentUserId ? initialItem.id : ownItems[0]?.id ?? "");
  const [projectName, setProjectName] = useState(initialProject ?? ownProjects[0] ?? "");
  const [query, setQuery] = useState("");
  const [users, setUsers] = useState<Array<{ id: string; username: string }>>([]);
  const [busyId, setBusyId] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (query.trim().length < 2) {
      return;
    }
    let active = true;
    const timer = window.setTimeout(() => {
      void authenticatedFetch(`/api/sharing?query=${encodeURIComponent(query.trim())}`, { cache: "no-store" })
        .then((response) => response.json())
        .then((data: { users?: Array<{ id: string; username: string }> }) => {
          if (active) setUsers(data.users ?? []);
        })
        .catch(() => { if (active) setUsers([]); });
    }, 180);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [authenticatedFetch, query]);

  const visibleUsers = query.trim().length >= 2 ? users : [];

  const send = async (selectedUsername: string) => {
    const target = targetKind === "project"
      ? projectName ? { kind: "project" as const, projectName } : null
      : itemId ? { kind: "item" as const, itemId } : null;
    if (!target) return;
    setBusyId(selectedUsername);
    setError("");
    setMessage("");
    try {
      await onSend(target, selectedUsername);
      setMessage(`Sent to @${selectedUsername}.`);
      setQuery("");
      setUsers([]);
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : "Invitation could not be sent.");
    } finally {
      setBusyId("");
    }
  };

  const respond = async (collaboration: Collaboration, status: "accepted" | "declined") => {
    setBusyId(collaboration.id);
    setError("");
    try {
      await onRespond(collaboration.id, collaboration.kind, status);
    } catch (responseError) {
      setError(responseError instanceof Error ? responseError.message : "Invitation could not be updated.");
    } finally {
      setBusyId("");
    }
  };

  return (
    <div className="overlay" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className="compact-dialog collaboration-dialog" role="dialog" aria-modal="true" aria-labelledby="collaboration-title">
        <header>
          <div>
            <span>People</span>
            <h2 id="collaboration-title">Shared work</h2>
          </div>
          <button type="button" aria-label="Close" onClick={onClose}>×</button>
        </header>
        <div className="collaboration-tabs" role="tablist">
          <button className={mode === "send" ? "active" : ""} onClick={() => setMode("send")}>Send</button>
          <button className={mode === "inbox" ? "active" : ""} onClick={() => setMode("inbox")}>Inbox {state.incoming.length > 0 && <em>{state.incoming.length}</em>}</button>
          <button className={mode === "shared" ? "active" : ""} onClick={() => setMode("shared")}>Shared</button>
        </div>

        {mode === "send" && (
          <div className="collaboration-send">
            <label>
              <span>Share</span>
              <select value={targetKind} onChange={(event) => setTargetKind(event.target.value as Collaboration["kind"])}>
                <option value="item">Line</option>
                <option value="project">Project</option>
              </select>
            </label>
            {targetKind === "project" ? (
              <label>
                <span>Project</span>
                <select value={projectName} onChange={(event) => setProjectName(event.target.value)}>
                  {ownProjects.map((project) => <option value={project} key={project}>{project}</option>)}
                </select>
              </label>
            ) : (
              <label>
                <span>Line</span>
                <select value={itemId} onChange={(event) => setItemId(event.target.value)}>
                  {ownItems.map((item) => <option value={item.id} key={item.id}>{item.content}</option>)}
                </select>
              </label>
            )}
            <label>
              <span>Find username</span>
              <input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Start typing a username…" />
            </label>
            <div className="people-results">
              {visibleUsers.map((user) => (
                <button type="button" key={user.id} disabled={!(targetKind === "project" ? projectName : itemId) || Boolean(busyId)} onClick={() => void send(user.username)}>
                  <span>{user.username.slice(0, 1).toUpperCase()}</span>
                  <strong>@{user.username}</strong>
                  <em>{busyId === user.username ? "Sending…" : `Send ${targetKind} →`}</em>
                </button>
              ))}
              {query.trim().length >= 2 && visibleUsers.length === 0 && <p>No matching username.</p>}
            </div>
            {state.outgoing.length > 0 && (
              <div className="outgoing-list">
                <span>Awaiting response</span>
                {state.outgoing.map((entry) => (
                  <div key={entry.id}><strong>{entry.kind === "project" ? entry.projectName : entry.item?.content ?? "Deleted line"}</strong><em>@{entry.recipientUsername}</em></div>
                ))}
              </div>
            )}
          </div>
        )}

        {mode === "inbox" && (
          <div className="collaboration-list">
            {state.incoming.length === 0 ? <p className="dialog-list-empty">No pending invitations.</p> : state.incoming.map((entry) => (
              <article key={entry.id}>
                <div><span>{entry.senderUsername.slice(0, 1).toUpperCase()}</span><small>@{entry.senderUsername} sent</small></div>
                <h3>{entry.kind === "project" ? entry.projectName : entry.item?.content ?? "Unavailable line"}</h3>
                {entry.kind === "project" && <p>This project and its lines will appear in Projects.</p>}
                {entry.item?.note && <p>{entry.item.note}</p>}
                <footer>
                  <button type="button" onClick={() => void respond(entry, "declined")} disabled={busyId === entry.id}>Decline</button>
                  <button type="button" className="primary" onClick={() => void respond(entry, "accepted")} disabled={busyId === entry.id}>{busyId === entry.id ? "Working…" : "Accept"}</button>
                </footer>
              </article>
            ))}
          </div>
        )}

        {mode === "shared" && (
          <div className="collaboration-list shared-list">
            {state.shared.length === 0 ? <p className="dialog-list-empty">No shared work yet.</p> : state.shared.map((entry) => (
              <article key={entry.id}>
                <div><span>{(entry.invitedBy === currentUserId ? entry.recipientUsername : entry.senderUsername).slice(0, 1).toUpperCase()}</span><small>With @{entry.invitedBy === currentUserId ? entry.recipientUsername : entry.senderUsername}</small></div>
                {entry.kind === "project" ? (
                  <h3>{entry.projectName}</h3>
                ) : (
                  <button type="button" className="shared-line-open" onClick={() => onOpenItem(entry.itemId)}>{entry.item?.content ?? "Unavailable line"}<em>Open →</em></button>
                )}
                <footer>
                  <button type="button" className="danger" onClick={() => void onRemove(entry.id, entry.kind)}>{entry.invitedBy === currentUserId ? "Stop sharing" : "Leave"}</button>
                </footer>
              </article>
            ))}
          </div>
        )}
        {(error || message) && <p className={error ? "dialog-error" : "dialog-message"} role="status">{error || message}</p>}
      </section>
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
  onShare,
  canDelete,
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
  onShare: () => void;
  canDelete: boolean;
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
          {((item.sharedWith ?? []).length > 0 || !canDelete) && item.ownerId && (
            <button
              type="button"
              className="shared-indicator"
              title={
                (item.sharedWith ?? []).length > 0
                  ? `Shared with ${(item.sharedWith ?? []).map((person) => person.username).join(", ")}`
                  : `Owned by ${item.ownerUsername}`
              }
              onClick={onShare}
            >
              <span>{item.ownerUsername?.slice(0, 1).toUpperCase()}</span>
              {(item.sharedWith ?? []).map((person) => (
                <span key={person.id}>{person.username.slice(0, 1).toUpperCase()}</span>
              ))}
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
        <button className={noteOpen ? "selected" : ""} aria-label="Add note" title="Add note" onClick={() => setNoteOpen((open) => !open)}>N</button>
        <button className="link-tool" aria-label="Add another link" title="Add link" onClick={addLink}>
          <span aria-hidden="true">📎</span>
        </button>
        {canDelete && (
          <button className="share-tool" aria-label="Share with another user" title="Share line" onClick={onShare}>
            <span aria-hidden="true">📧</span>
          </button>
        )}
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
        {item.archived && canDelete && (
          <button className="delete-tool" aria-label="Delete permanently" onClick={() => deleteItem(item)}>×</button>
        )}
      </div>
    </article>
  );
}

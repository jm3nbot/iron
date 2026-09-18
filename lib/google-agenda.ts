export type GoogleAgendaEntry = {
  id: string;
  kind: "event" | "task";
  title: string;
  description: string;
  location: string;
  htmlLink: string;
  start: string;
  end: string;
  allDay: boolean;
  taskList?: string;
};

type GoogleError = {
  message?: string;
  errors?: Array<{ reason?: string }>;
  details?: Array<{ reason?: string }>;
};

class GoogleReadError extends Error {
  status: number;
  reasons: string[];

  constructor(status: number, error?: GoogleError) {
    super(error?.message ?? "Google could not be loaded.");
    this.status = status;
    this.reasons = [...(error?.errors ?? []), ...(error?.details ?? [])]
      .flatMap((detail) => detail.reason ? [detail.reason] : []);
  }
}

async function readPages<T>(endpoint: URL, accessToken: string, fetcher: typeof fetch): Promise<T[]> {
  const items: T[] = [];
  const seen = new Set<string>();
  let pageToken = "";
  do {
    if (pageToken) endpoint.searchParams.set("pageToken", pageToken);
    const response = await fetcher(endpoint, {
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    const data = await response.json() as { items?: T[]; nextPageToken?: string; error?: GoogleError };
    if (!response.ok) throw new GoogleReadError(response.status, data.error);
    items.push(...(data.items ?? []));
    pageToken = data.nextPageToken ?? "";
    if (pageToken && seen.has(pageToken)) throw new Error("Google returned a repeated page. Please refresh.");
    seen.add(pageToken);
  } while (pageToken);
  return items;
}

type CalendarEvent = {
  id: string;
  summary?: string;
  description?: string;
  location?: string;
  htmlLink?: string;
  status?: string;
  start?: { date?: string; dateTime?: string };
  end?: { date?: string; dateTime?: string };
};

async function readEvents(token: string, from: string, to: string, fetcher: typeof fetch): Promise<GoogleAgendaEntry[]> {
  const endpoint = new URL("https://www.googleapis.com/calendar/v3/calendars/primary/events");
  const end = new Date(`${to}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() + 1);
  endpoint.search = new URLSearchParams({
    timeMin: `${from}T00:00:00Z`,
    timeMax: end.toISOString(),
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: "2500",
  }).toString();
  const events = await readPages<CalendarEvent>(endpoint, token, fetcher);
  return events.filter((event) => event.status !== "cancelled" && event.start).map((event) => ({
    id: `event:${event.id}`,
    kind: "event",
    title: event.summary || "Untitled event",
    description: event.description ?? "",
    location: event.location ?? "",
    htmlLink: event.htmlLink ?? "",
    start: event.start?.dateTime ?? event.start?.date ?? "",
    end: event.end?.dateTime ?? event.end?.date ?? "",
    allDay: Boolean(event.start?.date),
  }));
}

type GoogleTask = {
  id: string;
  title?: string;
  notes?: string;
  due?: string;
  status?: string;
  deleted?: boolean;
  hidden?: boolean;
  webViewLink?: string;
};

async function readTasks(token: string, from: string, to: string, fetcher: typeof fetch): Promise<GoogleAgendaEntry[]> {
  const endpoint = new URL("https://tasks.googleapis.com/tasks/v1/users/@me/lists?maxResults=1000");
  const lists = await readPages<{ id: string; title?: string }>(endpoint, token, fetcher);
  const entries: GoogleAgendaEntry[] = [];
  // Limit concurrency while still checking every list and every result page.
  for (let index = 0; index < lists.length; index += 4) {
    const batch = await Promise.all(lists.slice(index, index + 4).map(async (list) => {
      const url = new URL(`https://tasks.googleapis.com/tasks/v1/lists/${encodeURIComponent(list.id)}/tasks`);
      url.search = new URLSearchParams({
        maxResults: "100",
        showCompleted: "false",
        showDeleted: "false",
        showHidden: "false",
        showAssigned: "true",
        dueMin: `${from}T00:00:00Z`,
        dueMax: `${to}T23:59:59.999Z`,
      }).toString();
      const tasks = await readPages<GoogleTask>(url, token, fetcher);
      return tasks.flatMap((task): GoogleAgendaEntry[] => {
        // Google's `due` is a calendar date, not an instant or its separate deadline.
        const date = task.due?.slice(0, 10) ?? "";
        if (task.deleted || task.hidden || task.status === "completed" ||
            !/^\d{4}-\d{2}-\d{2}$/.test(date) || date < from || date > to) return [];
        return [{
          id: `task:${list.id}:${task.id}`,
          kind: "task",
          title: task.title || "Untitled task",
          description: task.notes ?? "",
          location: "",
          htmlLink: task.webViewLink ?? "https://tasks.google.com/",
          start: date,
          end: date,
          allDay: true,
          taskList: list.title ?? "My tasks",
        }];
      });
    }));
    entries.push(...batch.flat());
  }
  return entries;
}

export async function loadGoogleAgenda(accessToken: string, from: string, to: string, fetcher: typeof fetch = fetch) {
  const [calendar, tasks] = await Promise.allSettled([
    readEvents(accessToken, from, to, fetcher),
    readTasks(accessToken, from, to, fetcher),
  ]);
  let tasksError = "";
  let tasksNeedReconnect = false;
  let tasksApiDisabled = false;
  if (tasks.status === "rejected") {
    const failure = tasks.reason;
    if (failure instanceof GoogleReadError) {
      tasksApiDisabled = failure.reasons.some((reason) => ["SERVICE_DISABLED", "accessNotConfigured"].includes(reason));
      tasksNeedReconnect = !tasksApiDisabled && (failure.status === 401 ||
        failure.reasons.some((reason) => ["ACCESS_TOKEN_SCOPE_INSUFFICIENT", "insufficientPermissions"].includes(reason)));
    }
    tasksError = tasksApiDisabled
      ? "Google Tasks needs to be enabled in the Google Cloud project. Calendar events are still available."
      : tasksNeedReconnect
        ? "Reconnect Google to allow tasks to appear in your agenda."
        : "Google Tasks could not sync. Refresh Google to try again.";
  }
  return {
    events: [
      ...(calendar.status === "fulfilled" ? calendar.value : []),
      ...(tasks.status === "fulfilled" ? tasks.value : []),
    ].sort((a, b) => a.start.localeCompare(b.start) || a.title.localeCompare(b.title)),
    error: calendar.status === "rejected" ? "Google Calendar events could not sync. Refresh Google to try again." : "",
    needsReconnect: calendar.status === "rejected" && calendar.reason instanceof GoogleReadError && calendar.reason.status === 401,
    tasksError,
    tasksNeedReconnect,
    tasksApiDisabled,
  };
}

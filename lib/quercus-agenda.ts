export const QUERCUS_ORIGIN = "https://q.utoronto.ca";
export type QuercusEntry = {
  id: string;
  source: string;
  kind: "assignment" | "event";
  assignmentId?: string;
  courseId?: string;
  course: string;
  title: string;
  description: string;
  start: string | null;
  end: string | null;
  allDay: boolean;
  htmlLink: string;
  submissionState: string;
  submittedAt: string | null;
  late: boolean;
  missing: boolean;
  excused: boolean;
  localCompleted: boolean;
};

export function quercusSubmitted(entry: QuercusEntry) {
  return entry.kind === "assignment" && (entry.submissionState === "submitted" ||
    entry.submissionState === "pending_review" ||
    (entry.submissionState === "graded" && Boolean(entry.submittedAt)));
}

export function quercusComplete(entry: QuercusEntry) {
  return entry.localCompleted || entry.excused || quercusSubmitted(entry);
}

export function quercusStatus(entry: QuercusEntry) {
  if (entry.kind === "event") return "Event";
  if (entry.excused) return "Excused";
  if (entry.submissionState === "submitted") return "Submitted";
  if (entry.submissionState === "pending_review") return "Submitted · In review";
  if (entry.submissionState === "graded") return "Graded";
  if (entry.missing) return "Missing";
  if (entry.submissionState === "unsubmitted") return "Not submitted";
  return "Status unavailable";
}

export class QuercusError extends Error {
  status: number;
  constructor(status: number) {
    super(status === 401 ? "Your Quercus token has expired or was revoked. Replace it to reconnect."
      : status === 403 ? "Quercus denied access to this data."
      : status === 429 ? "Quercus is busy. Wait a moment before refreshing."
      : "Quercus could not sync. Try refreshing again.");
    this.status = status;
  }
}

// Only follow API URLs on the fixed institution host, including pagination links.
function apiUrl(path: string) {
  const url = new URL(path, QUERCUS_ORIGIN);
  if (url.origin !== QUERCUS_ORIGIN || !url.pathname.startsWith("/api/v1/") || url.username || url.password) {
    throw new Error("Quercus returned an invalid API link.");
  }
  return url;
}

export function quercusLink(value: string | undefined) {
  if (!value) return "";
  try {
    const url = new URL(value, QUERCUS_ORIGIN);
    return url.origin === QUERCUS_ORIGIN && !url.username && !url.password ? url.href : "";
  } catch { return ""; }
}

export async function quercusRead<T>(path: string, token: string, fetcher: typeof fetch = fetch): Promise<T> {
  const response = await fetcher(apiUrl(path), {
    headers: { Authorization: `Bearer ${token}` }, cache: "no-store", redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new QuercusError(response.status);
  return await response.json() as T;
}

export async function quercusPages<T>(path: string, token: string, fetcher: typeof fetch = fetch): Promise<T[]> {
  const result: T[] = [];
  const seen = new Set<string>();
  let next: string | undefined = path;
  while (next) {
    const url = apiUrl(next);
    if (seen.has(url.href) || seen.size >= 1000) throw new Error("Quercus pagination did not finish.");
    seen.add(url.href);
    const response = await fetcher(url, {
      headers: { Authorization: `Bearer ${token}` }, cache: "no-store", redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new QuercusError(response.status);
    const data: unknown = await response.json();
    if (!Array.isArray(data)) throw new Error("Quercus returned an invalid page.");
    result.push(...data as T[]);
    next = response.headers.get("link")?.split(",").find((link) => /rel="next"/.test(link))?.match(/<([^>]+)>/)?.[1];
  }
  return result;
}

const torontoDateFormatter = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", year: "numeric", month: "2-digit", day: "2-digit" });
export function quercusDate(value: string) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return torontoDateFormatter.format(date);
}

type Assignment = {
  id: number; name: string; description?: string; due_at: string | null; html_url?: string;
  published?: boolean; submission?: {
    workflow_state?: string; submitted_at?: string | null; late?: boolean; missing?: boolean; excused?: boolean;
  };
};
type CalendarEvent = {
  id: number; title: string; description?: string; start_at: string | null; end_at?: string | null;
  all_day?: boolean; all_day_date?: string; html_url?: string; context_code?: string;
  assignment?: { id: number }; assignment_id?: number; workflow_state?: string;
};

export async function loadQuercusAgenda(token: string, from: string, to: string, fetcher: typeof fetch = fetch, canvasUserId?: string) {
  const courses = await quercusPages<{ id: number; name: string; course_code?: string }>(
    "/api/v1/courses?enrollment_type=student&enrollment_state=active&per_page=100", token, fetcher);
  const entries: QuercusEntry[] = [];
  const failedSources: string[] = [];
  let needsReconnect = false;
  const failure = (source: string, reason: unknown) => {
    if (reason instanceof QuercusError && reason.status === 401) needsReconnect = true;
    failedSources.push(source);
  };
  // Keep requests bounded while retaining successful courses when another fails.
  for (let i = 0; i < courses.length; i += 4) {
    await Promise.all(courses.slice(i, i + 4).map(async (course) => {
      const source = `course:${course.id}`;
      try {
        const assignments = await quercusPages<Assignment>(
          `/api/v1/courses/${course.id}/assignments?include[]=submission&override_assignment_dates=true&per_page=100`, token, fetcher);
        for (const item of assignments) {
          if (item.published === false) continue;
          const date = item.due_at ? quercusDate(item.due_at) : "";
          if (item.due_at && (!date || date < from || date > to)) continue;
          entries.push({
            id: `assignment:${item.id}`, source, kind: "assignment", assignmentId: String(item.id),
            courseId: String(course.id), course: course.course_code || course.name,
            title: item.name || "Untitled assignment", description: item.description ?? "",
            start: item.due_at, end: item.due_at, allDay: false,
            htmlLink: quercusLink(item.html_url || `/courses/${course.id}/assignments/${item.id}`), submissionState: item.submission?.workflow_state ?? "unknown",
            submittedAt: item.submission?.submitted_at ?? null, late: item.submission?.late === true,
            missing: item.submission?.missing === true, excused: item.submission?.excused === true,
            localCompleted: false,
          });
        }
      } catch (error) { failure(source, error); }
    }));
  }
  // Query each calendar independently so failure in one doesn't hide the others.
  const contexts = [...(canvasUserId ? [`user_${canvasUserId}`] : []), ...courses.map((course) => `course_${course.id}`)];
  for (let i = 0; i < contexts.length; i += 4) {
    await Promise.all(contexts.slice(i, i + 4).map(async (context) => {
      const source = `calendar:${context}`;
      try {
        const params = new URLSearchParams({ type: "event", start_date: from, end_date: to, per_page: "100", "context_codes[]": context });
        const events = await quercusPages<CalendarEvent>(`/api/v1/calendar_events?${params}`, token, fetcher);
        for (const event of events) {
          if (event.assignment || event.assignment_id || event.workflow_state === "deleted") continue;
          const start = event.all_day ? event.all_day_date || event.start_at : event.start_at;
          const date = start ? quercusDate(start) : "";
          if (!date || date < from || date > to) continue;
          const course = courses.find((item) => `course_${item.id}` === event.context_code);
          entries.push({
            id: `event:${event.id}`, source, kind: "event", courseId: course ? String(course.id) : undefined,
            course: course?.course_code || course?.name || "Quercus", title: event.title || "Untitled event",
            description: event.description ?? "", start, end: event.end_at ?? start,
            allDay: event.all_day === true, htmlLink: quercusLink(event.html_url),
            submissionState: "unknown", submittedAt: null, late: false, missing: false, excused: false, localCompleted: false,
          });
        }
      } catch (error) { failure(source, error); }
    }));
  }
  return { entries: [...new Map(entries.map((entry) => [entry.id, entry])).values()], failedSources, needsReconnect };
}

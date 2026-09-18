import assert from "node:assert/strict";
import test from "node:test";
import { loadGoogleAgenda } from "../lib/google-agenda.ts";

const from = "2026-09-01";
const to = "2026-09-30";
const reply = (data, status = 200) => Response.json(data, { status });
const calendarItem = { id: "same-id", summary: "Meeting", start: { dateTime: "2026-09-18T14:00:00-04:00" } };

test("merges all task lists/pages and event pages, preserving dates, notes and unique IDs", async () => {
  const calls = [];
  const result = await loadGoogleAgenda("test-token", from, to, async (url, options) => {
    calls.push(url.toString());
    assert.equal(options.headers.Authorization, "Bearer test-token");
    assert.equal(options.cache, "no-store");
    const page = url.searchParams.get("pageToken");
    if (url.hostname === "www.googleapis.com") {
      return reply(page ? { items: [{ id: "second-event", start: { date: to } }] } : { items: [calendarItem], nextPageToken: "events-2" });
    }
    if (url.pathname.endsWith("/users/@me/lists")) {
      return reply(page ? { items: [{ id: "second-list", title: "School" }] } : { items: [{ id: "first-list", title: "Personal" }], nextPageToken: "lists-2" });
    }
    assert.equal(url.searchParams.get("showAssigned"), "true");
    assert.equal(url.searchParams.get("showCompleted"), "false");
    assert.equal(url.searchParams.get("dueMin"), `${from}T00:00:00Z`);
    assert.equal(url.searchParams.get("dueMax"), `${to}T23:59:59.999Z`);
    if (url.pathname.includes("first-list")) {
      return reply(page
        ? { items: [{ id: "last-day", due: `${to}T00:00:00.000Z` }] }
        : { items: [{ id: "same-id", title: "Assignment", notes: "Read chapter 2", due: `${from}T00:00:00.000Z`, webViewLink: "https://tasks.google.com/task/1" }], nextPageToken: "tasks-2" });
    }
    return reply({ items: [{ id: "same-id", due: "2026-09-18T00:00:00.000Z" }] });
  });
  assert.equal(result.events.length, 5);
  assert.equal(new Set(result.events.map((entry) => entry.id)).size, 5);
  const task = result.events.find((entry) => entry.title === "Assignment");
  assert.equal(task.start, from);
  assert.equal(task.allDay, true);
  assert.equal(task.description, "Read chapter 2");
  assert.equal(task.taskList, "Personal");
  assert.equal(task.htmlLink, "https://tasks.google.com/task/1");
  assert.equal(calls.length, 7);
  assert.equal(result.tasksError, "");
});

test("omits undated, completed, hidden, deleted and out-of-range tasks", async () => {
  const result = await loadGoogleAgenda("token", from, to, async (url) => {
    if (url.hostname === "www.googleapis.com") return reply({});
    if (url.pathname.endsWith("/users/@me/lists")) return reply({ items: [{ id: "list" }] });
    return reply({ items: [
      { id: "no-date" },
      { id: "completed", due: from, status: "completed" },
      { id: "hidden", due: from, hidden: true },
      { id: "deleted", due: from, deleted: true },
      { id: "before", due: "2026-08-31T00:00:00Z" },
      { id: "after", due: "2026-10-01T00:00:00Z" },
      { id: "valid", due: "2026-09-18T00:00:00Z" },
    ] });
  });
  assert.deepEqual(result.events.map((entry) => entry.id), ["task:list:valid"]);
});

for (const [reason, reconnect, apiDisabled] of [
  ["ACCESS_TOKEN_SCOPE_INSUFFICIENT", true, false],
  ["SERVICE_DISABLED", false, true],
  ["RATE_LIMIT_EXCEEDED", false, false],
]) {
  test(`preserves calendar events when Tasks fails with ${reason}`, async () => {
    const result = await loadGoogleAgenda("token", from, to, async (url) => {
      if (url.hostname === "www.googleapis.com") return reply({ items: [calendarItem] });
      return reply({ error: { details: [{ reason }] } }, 403);
    });
    assert.equal(result.events.length, 1);
    assert.equal(result.events[0].kind, "event");
    assert.equal(result.tasksNeedReconnect, reconnect);
    assert.equal(result.tasksApiDisabled, apiDisabled);
    assert.ok(result.tasksError);
  });
}

test("preserves tasks if calendar access fails and requests reconnect for expired credentials", async () => {
  const result = await loadGoogleAgenda("token", from, to, async (url) => {
    if (url.hostname === "www.googleapis.com") return reply({ error: {} }, 401);
    if (url.pathname.endsWith("/users/@me/lists")) return reply({ items: [{ id: "list" }] });
    return reply({ items: [{ id: "task", due: from }] });
  });
  assert.equal(result.events[0].kind, "task");
  assert.equal(result.needsReconnect, true);
  assert.ok(result.error);
});

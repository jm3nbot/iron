import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("renders the Ink & Iron workspace shell", async () => {
  const [layout, page] = await Promise.all([
    readFile(new URL("app/layout.tsx", root), "utf8"),
    readFile(new URL("app/page.tsx", root), "utf8"),
  ]);
  assert.match(layout, /title: "Ink&Iron"/);
  assert.match(page, /aria-label="Agenda"/);
  assert.match(page, /Capture a thought…/i);
  assert.match(page, /Paste a link…/i);
  assert.doesNotMatch(`${layout}\n${page}`, /codex-preview|react-loading-skeleton/i);
});

test("keeps the site lightweight with authenticated Supabase persistence", async () => {
  const [page, css, hosting, packageJson, vercel, vite, migration, dailyMigration, featureMigration, dailyRoute, quickLinksRoute, calendarRoute, fallback] = await Promise.all([
    readFile(new URL("app/page.tsx", root), "utf8"),
    readFile(new URL("app/globals.css", root), "utf8"),
    readFile(new URL(".openai/hosting.json", root), "utf8"),
    readFile(new URL("package.json", root), "utf8"),
    readFile(new URL("vercel.json", root), "utf8"),
    readFile(new URL("vite.config.ts", root), "utf8"),
    readFile(new URL("supabase/migrations/202607300001_auth_workspace.sql", root), "utf8"),
    readFile(new URL("supabase/migrations/20260803124401_daily_and_google_calendar.sql", root), "utf8"),
    readFile(new URL("supabase/migrations/20260806215241_weekly_daily_targets_and_quick_links.sql", root), "utf8"),
    readFile(new URL("app/api/daily/route.ts", root), "utf8"),
    readFile(new URL("app/api/quick-links/route.ts", root), "utf8"),
    readFile(new URL("app/api/calendar/google/route.ts", root), "utf8"),
    readFile(new URL("public/fallback/index.html", root), "utf8"),
  ]);
  assert.match(page, /\/api\/items/);
  assert.match(page, /Email or username/);
  assert.match(page, /supabase\.functions\.invoke/);
  assert.match(css, /--copper:/);
  assert.match(hosting, /"d1": "DB"/);
  assert.match(packageJson, /build:vercel/);
  assert.match(packageJson, /@supabase\/supabase-js/);
  assert.doesNotMatch(vercel, /outputDirectory/);
  assert.match(vite, /output: \{ dir: "\.vercel\/output" \}/);
  assert.match(migration, /enable row level security/);
  assert.match(migration, /auth\.uid\(\)/);
  assert.match(migration, /supabase_realtime/);
  assert.match(dailyMigration, /daily_completions/);
  assert.match(dailyMigration, /google_calendar_connections/);
  assert.match(dailyMigration, /enable row level security/);
  assert.match(dailyRoute, /completion_date/);
  assert.match(dailyRoute, /weekly_target/);
  assert.match(featureMigration, /weekly_target/);
  assert.match(featureMigration, /quick_links/);
  assert.match(featureMigration, /enable row level security/);
  assert.match(quickLinksRoute, /upsert/);
  assert.match(page, /Quicklinks/);
  assert.match(page, /Days per week/);
  assert.match(calendarRoute, /calendar\.events\.readonly/);
  assert.match(calendarRoute, /AES-GCM/);
  assert.match(fallback, /Ink &amp; Iron/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  assert.doesNotMatch(css, /url\(["']?https?:/);
  assert.match(css, /\/brand\/ink-and-iron-lockup-transparent\.png/);
});

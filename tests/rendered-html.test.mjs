import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("renders the Ink & Iron workspace shell", async () => {
  const [layout, page] = await Promise.all([
    readFile(new URL("app/layout.tsx", root), "utf8"),
    readFile(new URL("app/page.tsx", root), "utf8"),
  ]);
  assert.match(layout, /Ink & Iron — Personal Command Center/);
  assert.match(page, /Personal command center/i);
  assert.match(page, /Capture a thought…/i);
  assert.match(page, /Paste a link…/i);
  assert.doesNotMatch(`${layout}\n${page}`, /codex-preview|react-loading-skeleton/i);
});

test("keeps the site lightweight with authenticated Supabase persistence", async () => {
  const [page, css, hosting, packageJson, vercel, vite, migration, fallback] = await Promise.all([
    readFile(new URL("app/page.tsx", root), "utf8"),
    readFile(new URL("app/globals.css", root), "utf8"),
    readFile(new URL(".openai/hosting.json", root), "utf8"),
    readFile(new URL("package.json", root), "utf8"),
    readFile(new URL("vercel.json", root), "utf8"),
    readFile(new URL("vite.config.ts", root), "utf8"),
    readFile(new URL("supabase/migrations/202607300001_auth_workspace.sql", root), "utf8"),
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
  assert.match(fallback, /Ink &amp; Iron/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  assert.doesNotMatch(css, /url\(/);
});

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { conflictingFields } from "../lib/workspace-conflicts.ts";

// Execute the actual route handlers with an in-memory Supabase boundary. No live writes.
const compiled = ts.transpileModule(readFileSync(new URL("../app/api/items/route.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const row = (id = "line") => ({
  id, user_id: "owner", content: "Draft & Print Lin Alg", section: "now", group_name: "",
  url: null, links: [], note: "original", parent_id: null, priority: "none", due_date: null,
  completed: true, archived: false, archived_at: null, position: 0, indent: 0, bold: false,
  created_at: "2026-10-01T00:00:00+00:00", updated_at: "2026-10-01T00:00:00+00:00",
});
function fixture(initial = [row()]) {
  let rows = structuredClone(initial);
  let beforeWrite = null;
  const client = {
    auth: { getUser: async () => ({ data: { user: { id: "owner" } } }) },
    from(table) {
      let operation = "select", patch, start = 0, end = Infinity;
      const filters = [];
      const builder = {
        select() { return builder; },
        order() { return builder; },
        eq(key, value) { filters.push(record => record[key] === value); return builder; },
        in(key, values) { filters.push(record => values.includes(record[key])); return builder; },
        range(a, b) { start = a; end = b; return builder; },
        limit(n) { end = n - 1; return builder; },
        update(value) { operation = "update"; patch = value; return builder; },
        insert(value) { operation = "insert"; patch = value; return builder; },
        delete() { operation = "delete"; return builder; },
        single() { return run(true); },
        maybeSingle() { return run(true); },
        then(resolve, reject) { return run(false).then(resolve, reject); },
      };
      async function run(single) {
        if (table !== "workspace_items") {
          const data = table === "profiles" ? [{id:"owner",username:"jm3n"}] : [];
          return {data, error:null};
        }
        if (operation !== "select" && beforeWrite) { const hook = beforeWrite; beforeWrite = null; hook(rows); }
        let matches = rows.filter(record => filters.every(filter => filter(record)));
        if (operation === "insert") {
          if (rows.some(record=>record.id===patch.id)) return {data:null,error:{code:"23505"}};
          const created = {...row(patch.id),...patch}; rows.push(created); matches=[created];
        } else if (operation === "update") {
          matches.forEach(record => Object.assign(record,patch));
        } else if (operation === "delete") {
          rows = rows.filter(record => !matches.includes(record));
        }
        const result = structuredClone(matches.slice(start,end+1));
        return {data:single ? result[0] ?? null : result,error:null};
      }
      return builder;
    },
  };
  const exports = {};
  new Function("require", "exports", compiled)((name) => {
    if (name === "@supabase/supabase-js") return {createClient:()=>client};
    if (name === "@/lib/workspace-conflicts") return {conflictingFields};
    if (name === "@/lib/supabase-config") return {supabaseUrl:"http://test.invalid",supabasePublishableKey:"test"};
    throw new Error(name);
  }, exports);
  return {api:exports,rows:()=>rows,race(fn){beforeWrite=fn;}};
}
const request = (method, body) => new Request("http://test.invalid/api/items", {
  method, headers: {Authorization:"Bearer fake-test-token","Content-Type":"application/json"},
  ...(body ? {body:JSON.stringify(body)} : {}),
});
const snapshot = async f => (await (await f.api.GET(request("GET"))).json());

test("GET returns all rows beyond the Supabase page cap and canonical account identity", async () => {
  const f = fixture(Array.from({length:1005},(_,i)=>row(`line-${i}`)));
  const response = await f.api.GET(request("GET"));
  const data = await response.json();
  assert.equal(data.items.length,1005);
  assert.deepEqual(data.account,{id:"owner",username:"jm3n"});
  assert.equal(response.headers.get("Cache-Control"),"private, no-store");
});

test("PATCH preserves another device's note while saving an independent completion", async () => {
  const f=fixture();
  const base=(await snapshot(f)).items[0];
  f.rows()[0].note="PC note";
  const response=await f.api.PATCH(request("PATCH",{id:"line",completed:false,base}));
  assert.equal(response.status,200);
  assert.equal(f.rows()[0].note,"PC note");
  assert.equal(f.rows()[0].completed,false);
});

test("a simultaneous conflicting write is caught by atomic updated_at comparison", async () => {
  const f=fixture();
  const base=(await snapshot(f)).items[0];
  f.race(rows=>{rows[0].note="PC wins";rows[0].updated_at="2026-10-07T00:00:00+00:00";});
  const response=await f.api.PATCH(request("PATCH",{id:"line",note:"Mac note",base}));
  assert.equal(response.status,409);
  assert.equal((await response.json()).item.note,"PC wins");
  assert.equal(f.rows()[0].note,"PC wins");
});

test("duplicate create after lost response returns existing item without resetting it", async () => {
  const id="11111111-1111-4111-8111-111111111111";
  const f=fixture([row(id)]);
  const response=await f.api.POST(request("POST",{id,content:"old draft",completed:false}));
  assert.equal(response.status,200);
  assert.equal((await response.json()).item.completed,true);
  assert.equal(f.rows().length,1);
});

test("unversioned clients cannot silently replay old patches or delete newer rows", async () => {
  const f=fixture();
  assert.equal((await f.api.PATCH(request("PATCH",{id:"line",completed:false}))).status,428);
  assert.equal((await f.api.DELETE(request("DELETE",{id:"line"}))).status,428);
  const base=(await snapshot(f)).items[0];
  f.rows()[0].note="New important note";
  assert.equal((await f.api.DELETE(request("DELETE",{id:"line",base}))).status,409);
  assert.equal(f.rows().length,1);
});

test("deleted lines are never recreated by queued edits; duplicate deletes are safe", async () => {
  const f=fixture([]);
  assert.equal((await f.api.PATCH(request("PATCH",{id:"line",note:"old note",base:{}}))).status,409);
  assert.equal((await f.api.DELETE(request("DELETE",{id:"line",base:{}}))).status,200);
  assert.equal(f.rows().length,0);
});

test("unauthenticated workspace reads are rejected", async () => {
  const f=fixture();
  assert.equal((await f.api.GET(new Request("http://test.invalid/api/items"))).status,401);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import * as credentials from '../lib/quercus-credentials.ts';
import { QuercusError } from '../lib/quercus-agenda.ts';

const secret = 'a-test-only-secret-with-at-least-32-characters';
const item = { id: 'assignment:101', assignmentId: '101', source: 'course:1', submissionState: 'unsubmitted', localCompleted: false };
function fixture() {
  const tables = { quercus_connections: [], quercus_completions: [] };
  let signedIn = true, owner = 'owner', validToken = true;
  let canvasId = '11', failSync = false, failedSources = [], syncHook;
  const reads = [];
  const client = { from(table) {
    const filters = []; let operation = 'select', patch, start = 0, end = Infinity;
    const query = {
      select() { return query; }, order() { return query; },
      eq(k, v) { filters.push(r => r[k] === v); return query; },
      match(object) { for (const [k, v] of Object.entries(object)) query.eq(k, v); return query; },
      range(a, b) { start = a; end = b; return query; },
      upsert(value) { operation = 'upsert'; patch = value; return query; },
      update(value) { operation = 'update'; patch = value; return query; },
      delete() { operation = 'delete'; return query; },
      maybeSingle() { return run(true); },
      then(resolve, reject) { return run(false).then(resolve, reject); },
    };
    async function run(single) {
      let rows = tables[table].filter(r => filters.every(f => f(r)));
      if (operation === 'upsert') {
        const keys = table === 'quercus_connections' ? ['user_id'] : ['user_id', 'canvas_user_id', 'assignment_id'];
        const existing = tables[table].find(r => keys.every(k => r[k] === patch[k]));
        if (existing) Object.assign(existing, patch);
        else tables[table].push(structuredClone(patch));
      } else if (operation === 'update') rows.forEach(r => Object.assign(r, patch));
      else if (operation === 'delete') tables[table] = tables[table].filter(r => !rows.includes(r));
      rows = rows.slice(start, end + 1);
      return { data: structuredClone(single ? rows[0] ?? null : rows), error: null };
    }
    return query;
  } };
  const modules = {
    '@/lib/server-supabase': {
      requireUser: async () => signedIn ? { user: { id: owner }, supabase: client } : { response: Response.json({ error: 'Sign in' }, { status: 401 }) },
      authFailed: auth => 'response' in auth,
    },
    '@/lib/quercus-credentials': { ...credentials, quercusConfig: () => ({ secret, owner: 'owner', configured: true }) },
    '@/lib/quercus-agenda': {
      QuercusError,
      quercusRead: async (path, token) => {
        reads.push({ path, token });
        if (!validToken) throw new QuercusError(401);
        return { id: Number(canvasId), name: 'Student' };
      },
      loadQuercusAgenda: async (token) => {
        reads.push({ token });
        if (failSync) throw new QuercusError(429);
        if (syncHook) { const hook = syncHook; syncHook = null; hook(); }
        return { entries: [item], failedSources, needsReconnect: false };
      },
    },
  };
  function load(path) {
    const compiled = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const exports = {};
    new Function('require', 'exports', compiled)(name => {
      if (!(name in modules)) throw new Error(name);
      return modules[name];
    }, exports);
    return exports;
  }
  return { api: load('../app/api/calendar/quercus/route.ts'), completion: load('../app/api/calendar/quercus/completion/route.ts'), tables, reads,
    setSignedIn(value) { signedIn = value; }, setOwner(value) { owner = value; }, setCanvas(value) { canvasId = value; },
    setValid(value) { validToken = value; }, setFail(value) { failSync = value; }, setPartial(value) { failedSources = value; },
    duringSync(hook) { syncHook = hook; },
  };
}
const request = (method, body, query = '?from=2026-10-01&to=2026-10-31') => new Request(`https://ink.test/api/calendar/quercus${query}`, {
  method, headers: { Authorization: 'Bearer test', 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const connect = f => f.api.POST(request('POST', { token: 'private-token' }));
const get = async f => { const response = await f.api.GET(request('GET')); return { response, data: await response.json() }; };
const complete = (f, done = true, connectionId = f.tables.quercus_connections[0].connection_id) => f.completion.POST(request('POST', { assignmentId: '101', connectionId, completed: done }));

test('validates before encrypted storage, responses exclude credentials, invalid replacement retains prior token', async () => {
  const f = fixture();
  assert.equal((await connect(f)).status, 200);
  const record = structuredClone(f.tables.quercus_connections[0]);
  assert.equal(await credentials.decryptQuercusToken(record.token_encrypted, secret, 'owner'), 'private-token');
  assert.equal(f.reads[0].path, '/api/v1/users/self/profile');
  const { response, data } = await get(f);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(data.connected, true);
  assert(!JSON.stringify(data).includes('private-token'));
  assert(!JSON.stringify(data).includes('token_encrypted'));
  assert(!JSON.stringify(data).includes(record.token_encrypted));
  f.setValid(false);
  const rejected = await connect(f);
  assert.equal(rejected.status, 422);
  assert.equal((await rejected.json()).needsReconnect, true);
  assert.equal(f.tables.quercus_connections[0].token_encrypted, record.token_encrypted);
});

test('completion is independent of Canvas state, survives disconnect/reconnect, and is isolated by Canvas identity', async () => {
  const f = fixture(); await connect(f);
  assert.equal((await complete(f)).status, 200);
  let result = await get(f);
  assert.equal(result.data.entries[0].localCompleted, true);
  assert.equal(result.data.entries[0].submissionState, 'unsubmitted');
  assert.equal((await f.api.DELETE(request('DELETE'))).status, 200);
  assert.equal((await get(f)).data.connected, false);
  assert.equal(f.tables.quercus_completions.length, 1);
  await connect(f);
  assert.equal((await get(f)).data.entries[0].localCompleted, true);
  await complete(f, false);
  assert.equal((await get(f)).data.entries[0].localCompleted, false);
  await complete(f);
  f.setCanvas('22'); await connect(f);
  assert.equal((await get(f)).data.entries[0].localCompleted, false);
  assert(f.reads.every(r => !r.path || r.path === '/api/v1/users/self/profile'));
});

test('rejects unauthenticated requests and non-owner access', async () => {
  const f = fixture(); f.setSignedIn(false);
  for (const [handler, method] of [[f.api.GET, 'GET'], [f.api.POST, 'POST'], [f.api.DELETE, 'DELETE'], [f.completion.POST, 'POST']]) {
    assert.equal((await handler(request(method, method === 'POST' ? {} : undefined))).status, 401);
  }
  f.setSignedIn(true); f.setOwner('other');
  assert.equal((await connect(f)).status, 403);
  assert.equal((await get(f)).data.connected, false);
  assert.equal((await f.completion.POST(request('POST', {}))).status, 403);
  assert.equal(f.reads.length, 0);
});

test('validates dates and completion payloads and rejects completion from a replaced connection', async () => {
  const f = fixture(); await connect(f);
  for (const range of ['?from=2026-02-30&to=2026-03-01', '?from=2026-10-31&to=2026-10-01', '?from=2025-01-01&to=2026-10-31']) {
    assert.equal((await f.api.GET(request('GET', undefined, range))).status, 400);
  }
  for (const payload of [null, {}, { assignmentId: '1;DROP', completed: true, connectionId: 'bad' }]) {
    assert.equal((await f.completion.POST(request('POST', payload))).status, 400);
  }
  const old = f.tables.quercus_connections[0].connection_id;
  await connect(f);
  assert.equal((await complete(f, true, old)).status, 409);
});

test('partial or failed sync preserves last successful timestamp, and sync cannot resurrect a disconnected connection', async () => {
  const f = fixture(); await connect(f);
  const initial = (await get(f)).data.lastSynced;
  assert(initial);
  f.setPartial(['course:1']);
  assert.equal((await get(f)).data.lastSynced, initial);
  f.setFail(true);
  assert.equal((await get(f)).response.status, 429);
  assert.equal(f.tables.quercus_connections[0].last_synced_at, initial);
  f.setFail(false); f.setPartial([]);
  f.duringSync(() => { f.tables.quercus_connections.length = 0; });
  await get(f);
  assert.equal(f.tables.quercus_connections.length, 0);
});

test('loads completion records beyond the database page cap', async () => {
  const f = fixture(); await connect(f);
  for (let i = 0; i < 1100; i++) f.tables.quercus_completions.push({ user_id: 'owner', canvas_user_id: '11', assignment_id: String(10000 + i) });
  f.tables.quercus_completions.push({ user_id: 'owner', canvas_user_id: '11', assignment_id: '101' });
  assert.equal((await get(f)).data.entries[0].localCompleted, true);
});

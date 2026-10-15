import assert from 'node:assert/strict';
import test from 'node:test';
import { loadQuercusAgenda, quercusPages, quercusRead, quercusDate, quercusLink, QuercusError } from '../lib/quercus-agenda.ts';
import { encryptQuercusToken, decryptQuercusToken } from '../lib/quercus-credentials.ts';

const from = '2026-10-01', to = '2026-10-31';
const reply = (data, status = 200, headers = {}) => Response.json(data, { status, headers });
const assignment = (id, submission) => ({ id, name: `Assignment ${id}`, due_at: '2026-10-15T03:59:00Z', html_url: `/courses/1/assignments/${id}`, submission });

test('loads all course and assignment pages, respects personalized dates and retains undated work', async () => {
  const calls = [];
  const result = await loadQuercusAgenda('private-token', from, to, async (url, options) => {
    calls.push(url.href);
    assert.equal(url.origin, 'https://q.utoronto.ca');
    assert.equal(options.headers.Authorization, 'Bearer private-token');
    assert.equal(options.redirect, 'error');
    assert.equal(options.cache, 'no-store');
    if (url.pathname === '/api/v1/courses') return url.searchParams.has('page')
      ? reply([{ id: 2, name: 'Mathematics' }])
      : reply([{ id: 1, name: 'Physics', course_code: 'PHY100' }], 200, { link: '<https://q.utoronto.ca/api/v1/courses?page=2>; rel="next"' });
    if (url.pathname.includes('/courses/1/assignments')) {
      if (url.searchParams.has('page')) return reply([{ ...assignment(2), due_at: null }, { ...assignment(3), due_at: '2026-11-01T16:00:00Z' }, { ...assignment(4), published: false }]);
      assert.equal(url.searchParams.get('override_assignment_dates'), 'true');
      assert.equal(url.searchParams.get('include[]'), 'submission');
      return reply([assignment(1, { workflow_state: 'submitted', submitted_at: '2026-10-14T12:00:00Z' })], 200, { link: '<https://q.utoronto.ca/api/v1/courses/1/assignments?page=2>; rel="next"' });
    }
    if (url.pathname.includes('/courses/2/assignments')) return reply([]);
    assert.equal(url.searchParams.get('type'), 'event');
    return reply([
      { id: 100, title: 'Lecture', start_at: '2026-10-14T14:00:00Z', context_code: 'course_1' },
      { id: 101, title: 'All day', start_at: '2026-10-14T00:00:00Z', all_day: true, all_day_date: '2026-10-14' },
      { id: 102, title: 'Assignment duplicate', start_at: '2026-10-15T03:59:00Z', assignment: { id: 1 } },
      { id: 103, title: 'Deleted', start_at: '2026-10-14T14:00:00Z', workflow_state: 'deleted' },
    ]);
  }, '77');
  assert.equal(result.failedSources.length, 0);
  assert.deepEqual(result.entries.map(e => e.id).sort(), ['assignment:1', 'assignment:2', 'event:100', 'event:101']);
  assert.equal(result.entries.find(e => e.id === 'assignment:1').course, 'PHY100');
  assert.equal(quercusDate(result.entries[0].start), '2026-10-14');
  assert.equal(result.entries.find(e => e.id === 'assignment:2').submissionState, 'unknown');
  assert.equal(result.entries.find(e => e.id === 'event:101').start, '2026-10-14');
  assert(calls.some(call => call.includes('user_77')));
});

test('preserves independent submitted, graded, unsubmitted, pending, unknown, excused, late and missing fields', async () => {
  const states = ['submitted', 'graded', 'unsubmitted', 'pending_review', undefined];
  const result = await loadQuercusAgenda('token', from, to, async url => {
    if (url.pathname === '/api/v1/courses') return reply([{ id: 1, name: 'Course' }]);
    if (url.pathname.includes('assignments')) return reply(states.map((state, id) => assignment(id, state ? { workflow_state: state, late: id === 0, missing: id === 2, excused: id === 1 } : undefined)));
    return reply([]);
  });
  assert.deepEqual(result.entries.map(e => e.submissionState), ['submitted', 'graded', 'unsubmitted', 'pending_review', 'unknown']);
  assert.equal(result.entries[0].late, true);
  assert.equal(result.entries[1].excused, true);
  assert.equal(result.entries[2].missing, true);
  assert(result.entries.every(e => e.localCompleted === false));
});

for (const status of [401, 403, 429, 500]) {
  test(`course failure ${status} retains successful course data and flags the failed source`, async () => {
    const result = await loadQuercusAgenda('token', from, to, async url => {
      if (url.pathname === '/api/v1/courses') return reply([{ id: 1, name: 'One' }, { id: 2, name: 'Two' }]);
      if (url.pathname.includes('/courses/1/')) return reply({ error: 'sensitive upstream error' }, status);
      if (url.pathname.includes('/courses/2/')) return reply([assignment(10, { workflow_state: 'graded' })]);
      return reply([]);
    });
    assert.deepEqual(result.failedSources, ['course:1']);
    assert.equal(result.needsReconnect, status === 401);
    assert.equal(result.entries[0].id, 'assignment:10');
    await assert.rejects(quercusRead('/api/v1/users/self/profile', 'secret', async () => reply({}, status)), error => error instanceof QuercusError && error.status === status && !error.message.includes('secret'));
  });
}

test('blocks pagination credential exfiltration, unexpected redirects and repeated pages', async () => {
  for (const link of ['https://attacker.invalid/api/v1/courses', 'https://q.utoronto.ca/login', 'https://q.utoronto.ca/api/v1/courses']) {
    let calls = 0;
    await assert.rejects(quercusPages('/api/v1/courses', 'secret', async () => {
      calls++;
      return reply([], 200, { link: `<${link}>; rel="next"` });
    }));
    assert.equal(calls, 1);
  }
  assert.equal(quercusLink('javascript:alert(1)'), '');
  assert.equal(quercusLink('//attacker.invalid'), '');
  assert.equal(quercusLink('/courses/1'), 'https://q.utoronto.ca/courses/1');
});

test('Toronto date conversion handles midnight and DST boundaries without moving all-day dates', () => {
  for (const [input, expected] of [
    ['2026-10-15T03:59:00Z', '2026-10-14'], ['2026-10-15T04:00:00Z', '2026-10-15'],
    ['2026-11-01T04:00:00Z', '2026-11-01'], ['2026-11-02T04:59:00Z', '2026-11-01'],
    ['2026-03-08T04:59:00Z', '2026-03-07'], ['2026-03-09T04:00:00Z', '2026-03-09'],
    ['2026-10-15', '2026-10-15'], ['invalid', ''],
  ]) assert.equal(quercusDate(input), expected);
});

test('encrypts credentials with random IVs and binds them to their owner and secret', async () => {
  const secret = 'test-encryption-key-with-at-least-32-characters';
  const first = await encryptQuercusToken('my-private-token', secret, 'owner');
  const second = await encryptQuercusToken('my-private-token', secret, 'owner');
  assert.notEqual(first, second);
  assert(!first.includes('my-private-token'));
  assert.equal(await decryptQuercusToken(first, secret, 'owner'), 'my-private-token');
  await assert.rejects(decryptQuercusToken(first, secret, 'someone-else'));
  await assert.rejects(decryptQuercusToken(first, 'wrong-secret', 'owner'));
  await assert.rejects(decryptQuercusToken('corrupt', secret, 'owner'));
});

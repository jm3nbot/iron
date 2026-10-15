import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as agenda from '../lib/quercus-agenda.ts';
const require = createRequire(import.meta.url);
const exports = {};
const compiled = ts.transpileModule(readFileSync(new URL('../app/components/quercus-agenda.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
new Function('require', 'exports', compiled)(name => name === '@/lib/quercus-agenda' ? agenda : require(name), exports);
const entry = { id: 'assignment:101', source: 'course:1', assignmentId: '101', title: 'Assignment', kind: 'assignment', course: 'PHY100', submissionState: 'unknown', description: '<p>Read &amp; study.</p><script>alert(1)</script><img src=x onerror=alert(2)>', htmlLink: 'javascript:alert(3)', localCompleted: true, start: null };

test('partial sync retains only failed sources from the same Canvas identity and removes successfully deleted entries', () => {
  const current = { canvasUserId: '11', entries: [entry, { ...entry, id: 'assignment:102', source: 'course:2' }] };
  const next = { canvasUserId: '11', entries: [{ ...entry, id: 'assignment:103', source: 'course:2' }], failedSources: ['course:1'] };
  assert.deepEqual(exports.mergeQuercusEntries(current, next).map(e => e.id), ['assignment:101', 'assignment:103']);
  assert.deepEqual(exports.mergeQuercusEntries(current, { ...next, canvasUserId: '22' }).map(e => e.id), ['assignment:103']);
  assert.deepEqual(exports.mergeQuercusEntries(current, { ...next, failedSources: [] }).map(e => e.id), ['assignment:103']);
});

test('assignment details render safe plain text, unknown submission state and independent completion', () => {
  const html = renderToStaticMarkup(React.createElement(exports.QuercusEntries, { entries: [entry], agenda: { loading: false }, title: 'Quercus' }));
  assert.match(html, /Quercus: unknown/);
  assert.match(html, /Done in Ink/);
  assert.match(html, /checked/);
  assert.match(html, /Read &amp; study/);
  assert.doesNotMatch(html, /<script|<img|javascript:|alert\(/);
  const safe = renderToStaticMarkup(React.createElement(exports.QuercusEntries, { entries: [{ ...entry, htmlLink: 'https://q.utoronto.ca/courses/1/assignments/101' }], agenda: { loading: false }, title: 'Quercus' }));
  assert.match(safe, /Open in Quercus/);
});

test('connection UI offers token replacement, disconnect and completed filtering without exposing credentials', () => {
  const html = renderToStaticMarkup(React.createElement(exports.QuercusControls, { agenda: { connected: true, canvasName: 'Student', showCompleted: true, loading: false } }));
  assert.match(html, /Replace token/);
  assert.match(html, /Disconnect Quercus/);
  assert.match(html, /Show locally completed/);
  assert.doesNotMatch(html, /token_encrypted|private-token/);
});

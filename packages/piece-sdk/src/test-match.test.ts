import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchExpected, evaluateCase, summarizeResults } from './test-match.ts';
import type { TestCase } from './test-match.ts';

// ---- matchExpected: partial object subset ----

test('matchExpected: expected subset of actual matches (extra keys ignored)', () => {
  const actual = { a: 1, b: 2, c: 3 };
  const res = matchExpected(actual, { a: 1 });
  assert.equal(res.match, true);
  assert.deepEqual(res.mismatches, []);
});

test('matchExpected: missing key -> mismatch "missing" with path', () => {
  const actual = { a: 1 };
  const res = matchExpected(actual, { b: 2 });
  assert.equal(res.match, false);
  assert.deepEqual(res.mismatches, ['output.b: missing']);
});

test('matchExpected: different value -> mismatch with path', () => {
  const actual = { a: 1 };
  const res = matchExpected(actual, { a: 2 });
  assert.equal(res.match, false);
  assert.deepEqual(res.mismatches, ['output.a: expected 2, got 1']);
});

test('matchExpected: nested object recurses', () => {
  const actual = { user: { id: 5, name: 'x' }, extra: 1 };
  const res = matchExpected(actual, { user: { id: 5 } });
  assert.equal(res.match, true);
  const res2 = matchExpected(actual, { user: { id: 9 } });
  assert.equal(res2.match, false);
  assert.deepEqual(res2.mismatches, ['output.user.id: expected 9, got 5']);
});

test('matchExpected: array same length and matching elements -> match', () => {
  const actual = { items: [{ id: 1 }, { id: 2 }, { id: 3 }] };
  const res = matchExpected(actual, { items: [{ id: 1 }, { id: 2 }, { id: 3 }] });
  assert.equal(res.match, true);
});

test('matchExpected: array element differs -> mismatch with index path', () => {
  const actual = { items: [{ id: 1 }, { id: 7 }] };
  const res = matchExpected(actual, { items: [{ id: 1 }, { id: 2 }] });
  assert.equal(res.match, false);
  assert.deepEqual(res.mismatches, ['output.items[1].id: expected 2, got 7']);
});

test('matchExpected: array of different length -> mismatch', () => {
  const actual = { items: [1, 2] };
  const res = matchExpected(actual, { items: [1, 2, 3] });
  assert.equal(res.match, false);
  assert.deepEqual(res.mismatches, ['output.items: expected length 3, got 2']);
});

test('matchExpected: primitives strict equality', () => {
  assert.equal(matchExpected(1, 1).match, true);
  assert.equal(matchExpected('x', 'x').match, true);
  assert.equal(matchExpected(1, '1').match, false);
  assert.equal(matchExpected(true, 1).match, false);
  assert.deepEqual(matchExpected(1, 2).mismatches, ['output: expected 2, got 1']);
});

test('matchExpected: null/undefined handling', () => {
  assert.equal(matchExpected(null, null).match, true);
  assert.equal(matchExpected(undefined, undefined).match, true);
  assert.equal(matchExpected(null, undefined).match, false);
  assert.equal(matchExpected({ a: null }, { a: null }).match, true);
});

test('matchExpected: expected object but actual is primitive -> mismatch', () => {
  const res = matchExpected(5, { a: 1 });
  assert.equal(res.match, false);
  assert.deepEqual(res.mismatches, ['output: expected object, got 5']);
});

test('matchExpected: custom path is used', () => {
  const res = matchExpected(1, 2, 'root');
  assert.deepEqual(res.mismatches, ['root: expected 2, got 1']);
});

// ---- evaluateCase ----

test('evaluateCase: passed when SUCCEEDED and expect matches', () => {
  const tc: TestCase = { name: 't1', actionName: 'send', input: {}, expect: { ok: true } };
  const res = evaluateCase(tc, { status: 'SUCCEEDED', output: { ok: true, extra: 1 } });
  assert.equal(res.passed, true);
  assert.equal(res.status, 'SUCCEEDED');
  assert.deepEqual(res.mismatches, []);
  assert.equal(res.error, undefined);
});

test('evaluateCase: failed when status is FAILED', () => {
  const tc: TestCase = { name: 't2', actionName: 'send', input: {} };
  const res = evaluateCase(tc, { status: 'FAILED', error: 'boom' });
  assert.equal(res.passed, false);
  assert.ok(res.mismatches.includes('status: expected SUCCEEDED, got FAILED'));
  assert.equal(res.error, 'boom');
});

test('evaluateCase: failed when expect does not match', () => {
  const tc: TestCase = { name: 't3', actionName: 'send', input: {}, expect: { count: 5 } };
  const res = evaluateCase(tc, { status: 'SUCCEEDED', output: { count: 4 } });
  assert.equal(res.passed, false);
  assert.ok(res.mismatches.some((m) => m.startsWith('output.count:')));
});

test('evaluateCase: failed when expectStatus does not match', () => {
  const tc: TestCase = { name: 't4', actionName: 'send', input: {}, expectStatus: 'STOPPED' };
  const res = evaluateCase(tc, { status: 'SUCCEEDED' });
  assert.equal(res.passed, false);
  assert.ok(res.mismatches.includes('status: expected STOPPED, got SUCCEEDED'));
});

test('evaluateCase: passed with custom expectStatus and matching expect', () => {
  const tc: TestCase = { name: 't5', actionName: 'send', input: {}, expectStatus: 'STOPPED', expect: { id: 1 } };
  const res = evaluateCase(tc, { status: 'STOPPED', output: { id: 1, x: 2 } });
  assert.equal(res.passed, true);
});

test('evaluateCase: no expect -> only status matters', () => {
  const tc: TestCase = { name: 't6', actionName: 'send', input: {} };
  assert.equal(evaluateCase(tc, { status: 'SUCCEEDED', output: { anything: 1 } }).passed, true);
  assert.equal(evaluateCase(tc, { status: 'FAILED' }).passed, false);
});

// ---- summarizeResults ----

test('summarizeResults: counts passed/failed and generates lines', () => {
  const results = [
    { name: 'a', passed: true, status: 'SUCCEEDED', mismatches: [] },
    { name: 'b', passed: false, status: 'FAILED', mismatches: ['status: expected SUCCEEDED, got FAILED'], error: undefined },
    { name: 'c', passed: false, status: 'SUCCEEDED', mismatches: ['output.x: missing'], error: undefined },
  ];
  const s = summarizeResults(results);
  assert.equal(s.total, 3);
  assert.equal(s.passed, 1);
  assert.equal(s.failed, 2);
  assert.deepEqual(s.lines, [
    'PASS a',
    'FAIL b: status: expected SUCCEEDED, got FAILED',
    'FAIL c: output.x: missing',
  ]);
});

test('summarizeResults: empty input', () => {
  const s = summarizeResults([]);
  assert.equal(s.total, 0);
  assert.equal(s.passed, 0);
  assert.equal(s.failed, 0);
  assert.deepEqual(s.lines, []);
});

test('summarizeResults: error takes precedence over mismatches in line', () => {
  const results = [
    { name: 'x', passed: false, status: 'FAILED', mismatches: ['output.x: missing'], error: 'runtime crashed' },
  ];
  const s = summarizeResults(results);
  assert.deepEqual(s.lines, ['FAIL x: runtime crashed']);
});
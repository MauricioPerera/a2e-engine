// test-match — pure matcher for the testPiece phase of the piece SDK.
// Compares an action's REAL output against a PARTIAL expected value and reports
// differences as readable paths. Pure: no network, no FS, no Date.

export type MatchResult = { match: boolean; mismatches: string[] };

export type TestCase = {
  name: string;
  actionName: string;
  input: Record<string, unknown>;
  expect?: unknown;
  expectStatus?: string;
};

export type CaseResult = {
  name: string;
  passed: boolean;
  status?: string;
  mismatches: string[];
  error?: string;
};

export type Summary = { total: number; passed: number; failed: number; lines: string[] };

/** True for a plain object value: not null, not an array. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Build a child path: object key -> `parent.key`, array index -> `parent[i]`. */
function childPath(parent: string, key: string | number): string {
  return typeof key === 'number' ? `${parent}[${key}]` : `${parent}.${key}`;
}

/** Format a value for a mismatch message, keeping it short and readable. */
function fmt(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'object') return Array.isArray(value) ? 'array' : 'object';
  return String(value);
}

/** Match an array: same length and each element matches recursively by index. */
function matchArray(actual: unknown, expected: unknown[], path: string): string[] {
  const mismatches: string[] = [];
  if (!Array.isArray(actual)) {
    mismatches.push(`${path}: expected array, got ${fmt(actual)}`);
    return mismatches;
  }
  if (actual.length !== expected.length) {
    mismatches.push(`${path}: expected length ${expected.length}, got ${actual.length}`);
    return mismatches;
  }
  for (let i = 0; i < expected.length; i++) {
    const sub = matchValue(actual[i], expected[i], childPath(path, i));
    mismatches.push(...sub);
  }
  return mismatches;
}

/** Match a plain object: every key in `expected` must exist in `actual` and match recursively. */
function matchObject(actual: unknown, expected: Record<string, unknown>, path: string): string[] {
  const mismatches: string[] = [];
  if (!isPlainObject(actual)) {
    mismatches.push(`${path}: expected object, got ${fmt(actual)}`);
    return mismatches;
  }
  for (const key of Object.keys(expected)) {
    const child = childPath(path, key);
    if (!(key in actual)) {
      mismatches.push(`${child}: missing`);
      continue;
    }
    const sub = matchValue(actual[key], expected[key], child);
    mismatches.push(...sub);
  }
  return mismatches;
}

/** Match a single value: dispatch on shape, else strict equality. */
function matchValue(actual: unknown, expected: unknown, path: string): string[] {
  if (Array.isArray(expected)) return matchArray(actual, expected, path);
  if (isPlainObject(expected)) return matchObject(actual, expected, path);
  if (actual !== expected) {
    return [`${path}: expected ${fmt(expected)}, got ${fmt(actual)}`];
  }
  return [];
}

/**
 * Compare `actual` against a PARTIAL `expected`. Every key in `expected` must exist in
 * `actual` and match (recursively); extra keys in `actual` are ignored. Arrays must have
 * the same length and match element-wise. Primitives use strict equality.
 */
export function matchExpected(actual: unknown, expected: unknown, path = 'output'): MatchResult {
  const mismatches = matchValue(actual, expected, path);
  return { match: mismatches.length === 0, mismatches };
}

/** Evaluate a single test case against an execution result. */
export function evaluateCase(tc: TestCase, exec: { status?: string; output?: unknown; error?: string }): CaseResult {
  const statusOk = tc.expectStatus ? exec.status === tc.expectStatus : exec.status === 'SUCCEEDED';
  const mismatches: string[] = [];
  if (!statusOk) {
    mismatches.push(`status: expected ${tc.expectStatus ?? 'SUCCEEDED'}, got ${exec.status ?? 'undefined'}`);
  }
  const expectMatch = tc.expect === undefined ? { match: true, mismatches: [] } : matchExpected(exec.output, tc.expect);
  mismatches.push(...expectMatch.mismatches);
  return { name: tc.name, passed: statusOk && expectMatch.match, status: exec.status, mismatches, error: exec.error };
}

/** Summarize a batch of case results into counts and one line per case. */
export function summarizeResults(results: CaseResult[]): Summary {
  const lines = results.map((r) => {
    if (r.passed) return `PASS ${r.name}`;
    const detail = r.error ?? (r.mismatches.length > 0 ? r.mismatches.join('; ') : 'failed');
    return `FAIL ${r.name}: ${detail}`;
  });
  const passed = results.filter((r) => r.passed).length;
  return { total: results.length, passed, failed: results.length - passed, lines };
}
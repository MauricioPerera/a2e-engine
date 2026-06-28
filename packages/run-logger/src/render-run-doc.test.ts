import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { renderRunDoc } from './run-logger.js';
import type { FlowRun } from './run-logger.js';

const ok: FlowRun = {
  runId: 'run-001', source: 'manual', status: 'SUCCEEDED',
  startedAt: '2026-06-28T10:00:00.000Z', finishedAt: '2026-06-28T10:00:05.000Z',
  durationMs: 5000,
  steps: [{ name: 'fetch', status: 'SUCCEEDED', output: { rows: 3 } }, { name: 'save', status: 'SUCCEEDED' }],
};
const bad: FlowRun = {
  runId: 'run-002', source: 'webhook', status: 'FAILED',
  startedAt: '2026-06-28T11:00:00.000Z', finishedAt: '2026-06-28T11:00:02.000Z',
  durationMs: 2000,
  steps: [{ name: 'transform', status: 'FAILED', error: { message: 'bad input' } }],
  failedStep: 'transform',
  error: { name: 'TransformError', message: 'bad input', stack: 'at transform (x.ts:10)' },
};

test('ok', () => {
  const d = renderRunDoc(ok);
  assert.match(d, /status: SUCCEEDED/);
  assert.doesNotMatch(d, /failedStep:/);
  assert.doesNotMatch(d, /^## Error/m);
  assert.match(d, /# Run run-001 — SUCCEEDED/);
  assert.match(d, /- fetch — SUCCEEDED/);
});
test('bad', () => {
  const d = renderRunDoc(bad);
  assert.match(d, /failedStep: transform/);
  assert.match(d, /^## Error/m);
  assert.match(d, /at transform \(x\.ts:10\)/);
});
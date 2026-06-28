import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { renderDayIndex } from './run-logger.js';
import type { FlowRun } from './run-logger.js';

const ok: FlowRun = {
  runId: 'run-001', source: 'manual', status: 'SUCCEEDED',
  startedAt: '2026-06-28T10:00:00.000Z', finishedAt: '2026-06-28T10:00:05.000Z',
  durationMs: 5000, steps: [],
};
const bad: FlowRun = {
  runId: 'run-002', source: 'webhook', status: 'FAILED',
  startedAt: '2026-06-28T11:00:00.000Z', finishedAt: '2026-06-28T11:00:02.000Z',
  durationMs: 2000, steps: [], failedStep: 'transform',
};

test('index', () => {
  const i = renderDayIndex('2026-06-28', [ok, bad]);
  assert.match(i, /type: index/);
  assert.match(i, /date: 2026-06-28/);
  assert.match(i, /\| Run \| Status \| Duration \(ms\) \| Failed step \|/);
  assert.match(i, /run-001.*SUCCEEDED/);
  assert.match(i, /run-002.*FAILED/);
  assert.match(i, /\/runs\/2026-06-28\/run-run-001\.md/);
});
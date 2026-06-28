import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { runFilePath } from './run-logger.js';
import type { FlowRun } from './run-logger.js';

test('path', () => {
  const r: FlowRun = {
    runId: 'r1', source: 'manual', status: 'SUCCEEDED',
    startedAt: '2026-06-28T10:00:00.000Z', finishedAt: '2026-06-28T10:00:05.000Z',
    durationMs: 5, steps: [],
  };
  const p = runFilePath(r);
  assert.equal(p.dir, 'runs/2026-06-28');
  assert.equal(p.file, 'run-r1.md');
});
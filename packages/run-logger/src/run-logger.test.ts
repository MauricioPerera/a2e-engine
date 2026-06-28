import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  redactValue,
  runFilePath,
  renderRunDoc,
  renderDayIndex,
} from './run-logger.js';
import type { FlowRun } from './run-logger.js';

function succeededRun(): FlowRun {
  return {
    runId: 'run-001',
    source: 'manual',
    status: 'SUCCEEDED',
    startedAt: '2026-06-28T10:00:00.000Z',
    finishedAt: '2026-06-28T10:00:05.000Z',
    durationMs: 5000,
    steps: [
      { name: 'fetch', status: 'SUCCEEDED', output: { rows: 3 } },
      { name: 'save', status: 'SUCCEEDED' },
    ],
  };
}

function failedRun(): FlowRun {
  return {
    runId: 'run-002',
    source: 'webhook',
    status: 'FAILED',
    startedAt: '2026-06-28T11:00:00.000Z',
    finishedAt: '2026-06-28T11:00:02.000Z',
    durationMs: 2000,
    steps: [
      { name: 'fetch', status: 'SUCCEEDED', output: { ok: true } },
      { name: 'transform', status: 'FAILED', error: { message: 'bad input' } },
    ],
    failedStep: 'transform',
    error: { name: 'TransformError', message: 'bad input', stack: 'at transform (x.ts:10)' },
  };
}

test('renderRunDoc: SUCCEEDED -> frontmatter con status SUCCEEDED y sin error', () => {
  const doc = renderRunDoc(succeededRun());
  assert.match(doc, /^---\n/);
  assert.match(doc, /type: run/);
  assert.match(doc, /runId: run-001/);
  assert.match(doc, /status: SUCCEEDED/);
  assert.doesNotMatch(doc, /failedStep:/);
  assert.doesNotMatch(doc, /^## Error/m);
  assert.match(doc, /# Run run-001 — SUCCEEDED/);
  assert.match(doc, /## Steps/);
  assert.match(doc, /- fetch — SUCCEEDED/);
  assert.match(doc, /- save — SUCCEEDED/);
});

test('renderRunDoc: FAILED -> frontmatter incluye failedStep + error y cuerpo con seccion Error y stack', () => {
  const doc = renderRunDoc(failedRun());
  assert.match(doc, /status: FAILED/);
  assert.match(doc, /failedStep: transform/);
  assert.match(doc, /error:/);
  assert.match(doc, /^## Error/m);
  assert.match(doc, /TransformError/);
  assert.match(doc, /bad input/);
  assert.match(doc, /```/);
  assert.match(doc, /at transform \(x\.ts:10\)/);
});

test('redactValue: trunca payload > maxLen y deja el sufijo', () => {
  const big = 'x'.repeat(5000);
  const out = redactValue(big, 100);
  assert.ok(out.length < big.length, 'debe truncar');
  assert.match(out, /\.\.\. \[truncated \d+ chars\]/);
});

test('redactValue: objeto, string, undefined', () => {
  assert.equal(redactValue(undefined), 'undefined');
  assert.equal(redactValue('hola'), 'hola');
  assert.equal(redactValue({ a: 1 }), '{"a":1}');
});

test('redactValue: objeto circular sin lanzar', () => {
  const o: any = { name: 'c' };
  o.self = o;
  const out = redactValue(o);
  assert.ok(typeof out === 'string');
  assert.notEqual(out, '');
  // no lanzó => llegar aqui es exito; ademas debe marcarlo como no serializable
  assert.match(out, /unserializable|circular|\[unserializable\]/i);
});

test('runFilePath: deriva runs/<fecha>/run-<id>.md del startedAt', () => {
  const { dir, file } = runFilePath(succeededRun());
  assert.equal(dir, 'runs/2026-06-28');
  assert.equal(file, 'run-run-001.md');
});

test('renderDayIndex: lista N runs en la tabla con sus status', () => {
  const idx = renderDayIndex('2026-06-28', [succeededRun(), failedRun()]);
  assert.match(idx, /type: index/);
  assert.match(idx, /date: 2026-06-28/);
  assert.match(idx, /# Runs 2026-06-28/);
  assert.match(idx, /\| Run \| Status \| Duration \(ms\) \| Failed step \|/);
  assert.match(idx, /run-001.*SUCCEEDED/);
  assert.match(idx, /run-002.*FAILED/);
  assert.match(idx, /\(\/runs\/2026-06-28\/run-run-001\.md\)/);
});